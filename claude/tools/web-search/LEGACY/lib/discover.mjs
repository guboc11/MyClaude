// web-search — 발견(discover)
// 계획서 2-6, 2-8. 게이트 3.
//
// [원칙 1] 스스로 네트워크를 건드리지 않는다. 반드시 임대를 받아 fetchOne 을 거친다.
//   그래야 임대 검사·pace 예약·resumable·판정이라는 기존 안전장치를 그대로 다시 쓴다.
// [원칙 2] 기다리지 않는다. pace 에 막히면 남은 초를 돌려주고 진행을 파일에 남긴다.
//   같은 crawl+origin 으로 다시 부르면 끝낸 자리부터 잇는다.
//   (안에서 자면 하루 한도에 걸렸을 때 MCP 가 통째로 멈춘다 — 2026-08-11 매니저 감사.)
// [원칙 3] 완주하기 전에는 lastmod 스냅샷을 갈지도, 사라짐을 판정하지도 않는다.
//   반쪽 훑기로 "사라졌다"고 적으면 멀쩡한 주소가 사라진 것으로 남는다.
// [원칙 4] 사이트맵은 사이트가 선언한 목록일 뿐 전체가 아니다. 발견 경로를 나눠 기록한다.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { crawlPaths, ensureCrawlDirs, writeAtomic, readJson } from './paths.mjs';
import { normalizeUrl, sameHostIgnoringWww } from './url.mjs';
import { classifyKind } from './kind.mjs';
import * as store from './store.mjs';
import * as lock from './lock.mjs';
import { fetchOne } from './fetch.mjs';

const SITEMAP_GUESSES = ['/sitemap.xml', '/sitemap_index.xml', '/sitemap-index.xml'];
// 가지의 깊이만 제한한다. 형제가 몇이든 다 본다(형제 수를 깊이로 세면 조용히 잘린다).
const SITEMAP_DEPTH_MAX = 4;
// 발견 한 바퀴를 붙들고 있는 시간. 한 바퀴 안에서 계속 밀어 준다(heartbeat).
// 길게 잡아도 안전하다 — 죽은 주인은 만료가 아니라 PID 부재로 0.3초 만에 회수되고,
// 살아 있는데 느린 주인은 애초에 뺏으면 안 된다(멎었으면 repair_lock 이 사람 통로다).
const RUN_TTL_MS = 120_000;

function nowMs() { return Date.now(); }

// ---------- 아주 작은 XML 훑기 (의존성 없이) ----------
// XML 안에서는 & 를 &amp; 로 적는 것이 규칙이다. 그대로 두면 ?a=1&amp;b=2 라는 없는 주소가 되어
// 기능성 파라미터가 통째로 틀어진다(2026-08-11 매니저 4차 감사).
const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
export function decodeXmlText(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body) => {
    const b = body.toLowerCase();
    if (b.startsWith('#x')) return String.fromCodePoint(parseInt(body.slice(2), 16));
    if (b.startsWith('#')) return String.fromCodePoint(parseInt(body.slice(1), 10));
    return Object.prototype.hasOwnProperty.call(XML_ENTITIES, b) ? XML_ENTITIES[b] : whole;
  });
}

function tagValues(xml, tag) {
  const out = [];
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'gi');
  let m;
  while ((m = re.exec(xml))) out.push(decodeXmlText(m[1].trim()));
  return out;
}
/**
 * 사이트맵으로 인정하려면 뿌리 요소가 urlset 이나 sitemapindex 여야 한다.
 * 200 으로 온 오류 HTML 을 "항목 0개짜리 사이트맵" 으로 삼키면, 그 사이트의 목록이
 * 통째로 빈 것으로 스냅샷에 박힌다(2026-08-11 매니저 5차 감사).
 * @returns {'urlset'|'sitemapindex'|null}
 */
export function sitemapRoot(xml) {
  const s = String(xml || '')
    .replace(/^﻿/, '')
    .replace(/<\?[\s\S]*?\?>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!DOCTYPE[^>]*>/gi, '');
  const m = s.match(/<\s*([a-z0-9:_-]+)/i);
  if (!m) return null;
  const name = m[1].toLowerCase().split(':').pop();
  return name === 'urlset' || name === 'sitemapindex' ? name : null;
}

function urlEntries(xml) {
  const out = [];
  const re = /<url[\s>]([\s\S]*?)<\/url>/gi;
  let m;
  while ((m = re.exec(xml))) {
    const loc = (tagValues(`<x>${m[1]}</x>`, 'loc')[0] || '').trim();
    const lastmod = (tagValues(`<x>${m[1]}</x>`, 'lastmod')[0] || '').trim() || null;
    if (loc) out.push({ loc, lastmod });
  }
  return out;
}
function childSitemaps(xml) {
  const out = [];
  const re = /<sitemap[\s>]([\s\S]*?)<\/sitemap>/gi;
  let m;
  while ((m = re.exec(xml))) {
    const loc = (tagValues(`<x>${m[1]}</x>`, 'loc')[0] || '').trim();
    if (loc) out.push(loc);
  }
  return out;
}

// ---------- 종류 판정 (proposed 만 만든다) ----------
// 종류 판정은 공용 모듈에 있다 — store 도 같은 잣대를 써야 하기 때문이다.
export { classifyKind };

// ---------- 도메인 프로필: proposed → confirmed / manual_override ----------
export const PROFILE_STATES = ['proposed', 'confirmed', 'manual_override'];

function profileFile(crawl, domain) {
  return path.join(crawlPaths(crawl).profiles, `${domain.replace(/[^a-z0-9.-]/gi, '_')}.json`);
}
export function readProfile(crawl, domain) { return readJson(profileFile(crawl, domain), null); }

function requireText(v, what) {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s) throw new Error(`${what} 는 비워 둘 수 없습니다 — 누가 왜 바꿨는지 남아야 합니다.`);
  return s;
}

function pushHistory(rec, from, to, who, reason, evidence) {
  rec.history = rec.history || [];
  rec.history.push({ from, to, who, at: nowMs(), at_iso: new Date().toISOString(), reason: reason ?? null, evidence: evidence ?? null });
}

export function proposeProfile(crawl, domain, obs = {}) {
  ensureCrawlDirs(crawl);
  const file = profileFile(crawl, domain);
  const prev = readJson(file, null);
  if (prev && prev.status !== 'proposed') {
    return { file, unchanged: true, reason: `사람이 정한 상태(${prev.status})라 덮지 않습니다`, profile: prev };
  }
  const rec = {
    domain, status: 'proposed',
    listing_path_patterns: obs.listingSamples?.map(pathShape) ?? [],
    detail_path_patterns: obs.detailSamples?.map(pathShape) ?? [],
    accepted_card_signature: obs.signature ?? null,
    observed_cards: obs.cards ?? null,
    evidence: obs.evidence ?? [],
    proposed_at: nowMs(),
    history: prev?.history ?? [],
    note: '코드가 관찰해 제안한 값입니다. confirm_profile 로 사람이 확인해야 confirmed 가 됩니다.',
  };
  pushHistory(rec, prev?.status ?? 'none', 'proposed', 'code:discover', '자동 관찰', obs.evidence ?? null);
  writeAtomic(file, JSON.stringify(rec, null, 2));
  return { file, unchanged: false, profile: rec };
}

function pathShape(u) {
  try { return new URL(u).pathname.replace(/[^/]+$/, '*'); } catch { return String(u); }
}

/** 사람이 확정한다. who·reason 은 반드시 있어야 한다 — 없으면 나중에 왜 그랬는지 알 길이 없다. */
export function confirmProfile(crawl, domain, { who = null, reason = null } = {}) {
  const w = requireText(who, 'who');
  const r = requireText(reason, 'reason');
  const file = profileFile(crawl, domain);
  const rec = readJson(file, null);
  if (!rec) throw new Error(`제안된 프로필이 없습니다: ${domain}`);
  const from = rec.status;
  rec.status = 'confirmed';
  rec.confirmed_by = w;
  rec.confirmed_at = nowMs();
  pushHistory(rec, from, 'confirmed', w, r, rec.evidence ?? null);
  writeAtomic(file, JSON.stringify(rec, null, 2));
  return { file, from, profile: rec };
}

/** 사람이 선택자를 직접 적는다. selectors·who·reason 모두 필수. */
export function overrideProfile(crawl, domain, { selectors = null, who = null, reason = null } = {}) {
  const w = requireText(who, 'who');
  const r = requireText(reason, 'reason');
  if (!selectors || typeof selectors !== 'object' || !Object.keys(selectors).length) {
    throw new Error('selectors 가 비었습니다 — 직접 지정하려면 무엇을 지정하는지 적어야 합니다.');
  }
  const file = profileFile(crawl, domain);
  const rec = readJson(file, null) || { domain, status: 'proposed', history: [] };
  const from = rec.status;
  rec.status = 'manual_override';
  rec.manual_selectors = selectors;
  rec.overridden_by = w;
  rec.overridden_at = nowMs();
  pushHistory(rec, from, 'manual_override', w, r, { selectors });
  writeAtomic(file, JSON.stringify(rec, null, 2));
  return { file, from, profile: rec };
}

// ---------- 진행 저장 (discover 자체의 resume) ----------
/**
 * 저장 키가 되는 origin 은 반드시 정규형이어야 한다.
 * "http://h", "http://h/", "http://h/path" 는 실제로 같은 자리를 훑는데 날것 문자열로 키를 만들면
 * 실행권·진행·완료표지가 셋으로 갈려 같은 사이트를 세 번 두드린다(2026-08-11 매니저 4차 감사).
 */
export function canonicalOrigin(origin) {
  const u = new URL(origin);
  return u.origin;
}
function originKey(origin) { return crypto.createHash('sha256').update(canonicalOrigin(origin)).digest('hex').slice(0, 12); }
function progFile(crawl, origin) {
  return path.join(crawlPaths(crawl).dir, `discover-progress-${originKey(origin)}.json`);
}
// [격리] 스냅샷은 crawl 이 아니라 origin 마다 따로 둔다.
// 하나로 두면 같은 crawl 에서 B 사이트를 훑는 순간 A 의 주소가 전부 "사라짐" 으로 찍히고
// A 의 스냅샷이 B 것으로 덮인다.
function snapFile(crawl, origin) {
  return path.join(crawlPaths(crawl).dir, `lastmod-snapshot-${originKey(origin)}.json`);
}
function runLockDir(crawl, origin) {
  return path.join(path.dirname(crawlPaths(crawl).lock), `discover-${originKey(origin)}.lock`);
}
function loadProg(crawl, origin) { return readJson(progFile(crawl, origin), null); }
function saveProg(crawl, origin, prog) { writeAtomic(progFile(crawl, origin), JSON.stringify(prog, null, 2)); }
function clearProg(crawl, origin) { try { fs.unlinkSync(progFile(crawl, origin)); } catch {} }

// 끝낸 회차의 표지. 이게 있으면 같은 호출은 네트워크를 건드리지 않고 그 결과를 그대로 돌려준다.
// (안 그러면 물러났던 쪽이 안내대로 다시 부를 때 끝난 사이트맵을 처음부터 다시 훑는다.)
function doneFile(crawl, origin) {
  return path.join(crawlPaths(crawl).dir, `discover-done-${originKey(origin)}.json`);
}
function loadDone(crawl, origin) { return readJson(doneFile(crawl, origin), null); }
function clearDone(crawl, origin) { try { fs.unlinkSync(doneFile(crawl, origin)); } catch {} }

function emptyProg(origin) {
  return {
    origin, stage: 'robots',
    queue: [],            // [{ url, depth }] — depth 는 가지 깊이(형제 수가 아니다)
    seen: [],             // 이미 읽은 사이트맵
    next_snapshot: {},    // 완주해야 교체한다
    seeds_done: [],
    home_done: false,
    current_fetch: null,  // 내가 딴 임대. 남의 것을 읽어 쓰지 않기 위한 유일한 근거.
    out: {
      robots_sitemaps: [], sitemaps_visited: [], per_sitemap: {},
      found: 0, duplicates: 0, network_calls: 0, refused: 0, refuse_reasons: [],
      lastmod_summary: { new: 0, changed: 0, unchanged: 0 },
      revisit_ids: [], suspected_duplicates: 0, fetched: [],
      depth_exceeded: [], skipped: [], blockers: [],
    },
    started_at: nowMs(),
  };
}

// ---------- 본체 ----------
/**
 * @returns 완주하면 { done:true, ... }, 막히면 { deferred:true, wait_seconds, stage, ... }
 */
export async function discover(crawl, opts = {}) {
  // sitemapSeeds: 사이트맵 주소를 큐에 바로 넣는다. extraSeeds 로 주면 링크 수집기로 흘러
  // <loc> 을 못 읽는다(사이트맵은 <a href> 가 아니다).
  const { origin: originInput, worker = '', extraSeeds = [], sitemapSeeds = [], skipSitemaps = false, fetchSeeds = false, forceLeaseToken = null, refresh = false } = opts;
  const p = ensureCrawlDirs(crawl);
  const originUrl = new URL(originInput);
  // 아래 모든 키·저장·응답은 정규형 origin 하나로만 말한다. 입력이 달랐으면 감추지 않고 같이 적는다.
  const origin = originUrl.origin;
  const originNormalized = String(originInput) !== origin ? String(originInput) : null;
  const host = originUrl.hostname;

  // [실행권] crawl+origin 한 자리에는 한 번에 하나만 든다.
  //
  // 워커 이름은 신원이 아니다 — 같은 이름(또는 빈 이름)으로 둘이 동시에 부르면 서로를 자기라고
  // 착각해 남의 lease_token 을 읽어 쓰고, 같은 진행 파일을 엇갈려 덮어 stage·queue 를 되돌린다
  // (2026-08-11 매니저 3차 감사). 그래서 이름이 아니라 원자적 실행권으로 가른다.
  // 실행권을 쥔 쪽만 진행 파일을 읽고 쓴다. 못 쥔 쪽은 아무것도 건드리지 않고 물러난다.
  // 주인이 죽으면 owner.json 의 PID 부재를 보고 다음 호출이 회수한다(재시작 resume).
  const runLock = lock.tryAcquire(runLockDir(crawl, origin), p.stale, RUN_TTL_MS);
  if (!runLock) return notMyTurn(crawl, origin, originNormalized);

  try {
    return await run();
  } finally {
    runLock.release();
  }

  async function run() {
  // [호출 계약] 세 갈래로 갈린다.
  //  - 진행 중인 회차가 있다 → 그 자리부터 잇는다(refresh 는 무시한다. 남은 일을 버리면 안 된다).
  //  - 끝낸 회차만 있다 → 다시 훑지 않고 그 결과를 돌려준다. 네트워크 0회.
  //  - refresh 를 줬거나 아무것도 없다 → 새 회차를 연다.
  const resuming = loadProg(crawl, origin);
  if (!resuming) {
    const finished = loadDone(crawl, origin);
    if (finished && !refresh) return reuseFinished(finished, originNormalized);
    if (finished) clearDone(crawl, origin);
  }
  const prog = resuming || emptyProg(origin);
  // 경계는 정책으로 넓힐 수 있어야 한다 — 넓힌 뒤 같은 자리에서 이어 달릴 수 있게.
  const depthMax = store.loadPolicy(crawl).sitemap_depth_max ?? SITEMAP_DEPTH_MAX;
  const out = prog.out;
  out.skipped = out.skipped || [];
  out.depth_exceeded = out.depth_exceeded || [];
  out.blockers = out.blockers || [];
  out.crawl = crawl; out.origin = origin;
  // 사이트맵을 건너뛰고 돈 회차는 "사이트맵까지 확인했다"의 근거가 될 수 없다
  out.skip_sitemaps = !!skipSitemaps;
  if (originNormalized) out.origin_input = originNormalized;
  out.deleted = 0;
  let deferred = null;                 // 첫 막힘에서 즉시 멈춘다
  let lostRight = false;               // 실행권을 뺏겼으면 진행 파일에 한 글자도 쓰지 않는다

  // 실행권을 쥔 동안에만 진행을 남긴다. 뺏긴 뒤에 쓰면 새 주인의 진행을 되돌린다.
  const persist = () => { if (!lostRight) saveProg(crawl, origin, prog); };
  // 오래 걸리는 한 바퀴 동안 만료되지 않게 밀어 준다. 밀지 못하면 이미 내 것이 아니다.
  const keepRight = () => {
    if (lostRight) return false;
    if (runLock.renew(RUN_TTL_MS)) return true;
    lostRight = true;
    deferred = { wait: 2, why: 'lost_run_right' };
    return false;
  };

  // 한 주소를 가져온다 — 딱 그 주소만 임대하고, 막히면 기다리지 않고 신호를 올린다.
  //
  // [임대 계약] 내가 직접 leaseUrl 로 딴 토큰만 쓴다. 장부에 leased 로 적혀 있다고 해서
  // 그 토큰을 읽어 쓰면 남의 임대를 훔치는 것이다(2026-08-11 매니저 2차 감사).
  // 내가 딴 토큰은 딴 직후 progress.current_fetch 에 적어 두고, 다음 호출은 그것만 다시 쓴다.
  const fetchVia = async (url, kind) => {
    if (deferred) return null;
    if (!keepRight()) return null;          // 실행권부터 확인 — 뺏겼으면 임대도 걸지 않는다
    const norm = normalizeUrl(url);
    store.addUrls(crawl, [{ url: norm.url, kind, via: 'internal', discovered_by: 'internal' }]);

    // 실행권을 쥔 동안은 이 진행 파일이 내 것이다 — 여기 적힌 토큰만 이어 쓴다.
    // (장부의 leased 를 읽어 쓰지 않는다. 그건 남의 것일 수 있다.)
    let token = null;
    if (forceLeaseToken) token = forceLeaseToken;
    else if (prog.current_fetch?.url_id === norm.id) token = prog.current_fetch.lease_token;

    if (!token) {
      let lz = store.leaseUrl(crawl, norm.id, worker);        // 하나만 잡는다
      if (!lz.ok && String(lz.why).startsWith('not_queued')) {
        // 이미 끝난 주소를 다시 봐야 하면 명시적으로 되돌린다(이유가 남는다)
        store.requeue(crawl, [norm.id], 'discover_refetch');
        lz = store.leaseUrl(crawl, norm.id, worker);
      }
      if (!lz.ok) {
        // 남이 잡고 있으면 뺏지 않는다. 내 진행을 남기고 물러난다.
        if (lz.why === 'already_leased') { deferred = { wait: 5, why: `already_leased_by_${lz.worker || 'other'}` }; return null; }
        out.refused++; out.refuse_reasons.push(lz.why);
        return { skipped: true, why: lz.why };
      }
      token = lz.lease_token;
      prog.current_fetch = { url_id: norm.id, url: norm.url, lease_token: token, worker };
      persist();                          // 임대 직후 원자 저장
    }

    const r = await fetchOne(crawl, { url: norm.url, url_id: norm.id, lease_token: token, kind, maxTier: 'jina' });
    out.network_calls += r.network_calls || 0;

    if (r.refused) {
      // 임대가 만료·교체됐다면 큐 항목을 살려 둔 채 토큰만 버린다.
      // 다음 호출이 reclaim → 새 임대 경로로 같은 자리를 다시 시도한다.
      // (forceLeaseToken 은 시험이 일부러 틀린 토큰을 넣는 자리라 회복 대상이 아니다.)
      if (!forceLeaseToken && /lease_expired|stale_lease_token|not_leased/.test(String(r.why))) {
        prog.current_fetch = null;
        persist();
        deferred = { wait: 1, why: `lease_lost(${r.why})` };
        return null;
      }
      out.refused++; out.refuse_reasons.push(r.why);
      prog.current_fetch = null;
      persist();
      return { skipped: true, why: r.why };
    }
    if (r.deferred) { deferred = { wait: r.wait_seconds, why: r.why }; return null; }

    // 성공했으면 임대를 풀어 준다 — 안 그러면 robots·사이트맵이 영영 leased 로 남는다.
    const rep = store.report(crawl, [{ url_id: norm.id, lease_token: token, state: r.page_validity === 'invalid' ? 'invalid' : 'fetched' }]);
    if (rep.accepted !== 1) {
      // 반납이 거절됐다 = 이 결과는 장부가 인정하지 않는다. 진행을 끝냈다고 치면 안 된다.
      prog.current_fetch = null;
      persist();
      deferred = { wait: 1, why: `report_rejected(${rep.rejects?.[0]?.why || 'unknown'})` };
      return null;
    }
    // 그 쪽을 열며 본 링크는 이 report 안에서 이미 더미에 합쳐졌다.
    // found 는 사이트맵에서 찾은 수라는 기존 뜻을 그대로 두고, 링크로 들어온 수는 따로 센다.
    out.found += rep.links_added || 0;
    out.links_added = (out.links_added || 0) + (rep.links_added || 0);
    out.links_seen = (out.links_seen || 0) + (rep.links_seen || 0);
    prog.current_fetch = null;
    persist();
    return r;
  };

  // ---- 1단계: robots ----
  if (!skipSitemaps && prog.stage === 'robots') {
    const rb = await fetchVia(`${originUrl.origin}/robots.txt`, 'unknown');
    if (deferred) { persist(); return bail(); }
    if (rb?.body) {
      for (const line of rb.body.split('\n')) {
        const m = line.match(/^\s*sitemap:\s*(\S+)/i);
        if (m) { try { out.robots_sitemaps.push(normalizeUrl(m[1], { base: originUrl.origin }).url); } catch {} }
      }
    }
    // 어디서 온 사이트맵인지 남긴다. 사이트가 "있다"고 선언한 것(robots·인덱스·사람이 준 것)이
    // 실패하면 목록이 비는 것이므로 막아야 하고, 우리가 찍어 본 것(guess)이 404 인 건 정상이다.
    prog.queue = out.robots_sitemaps.map((u) => ({ url: u, depth: 0, src: 'robots' }));
    if (!prog.queue.length) prog.queue = SITEMAP_GUESSES.map((g) => ({ url: `${originUrl.origin}${g}`, depth: 0, src: 'guess' }));
    prog.stage = 'sitemaps';
    persist();
  } else if (prog.stage === 'robots') {
    // robots 를 건너뛰더라도 사이트맵을 직접 지정했으면 그 큐로 들어간다
    if (sitemapSeeds.length) {
      prog.queue = sitemapSeeds.map((u) => ({ url: u, depth: 0, src: 'seed' }));
      prog.stage = 'sitemaps';
    } else {
      prog.stage = 'seeds';
    }
    persist();
  }

  // ---- 2단계: 사이트맵 (깊이는 가지 깊이로만 센다) ----
  if (prog.stage === 'sitemaps') {
    const seen = new Set(prog.seen);
    // 경계를 넓혀 다시 부르면, 더 이상 넘지 않는 항목은 미결 목록에서 뺀다.
    out.depth_exceeded = out.depth_exceeded.filter((d) => d.depth > depthMax);
    while (prog.queue.length) {
      const { url: sm, depth, src = 'seed' } = prog.queue[0];
      if (seen.has(sm)) { prog.queue.shift(); continue; }
      if (depth > depthMax) {
        // 경계를 넘었다. 조용히 버리고 완주한 척하면 스냅샷이 반쪽으로 갈리고
        // 멀쩡한 주소가 "사라짐"으로 찍힌다. 여기서 멈추고 사람 판단을 기다린다.
        out.depth_exceeded.push({ url: sm, depth, depth_max: depthMax });
        prog.seen = [...seen];
        persist();
        return boundaryPause({ url: sm, depth });
      }
      const r = await fetchVia(sm, 'sitemap');
      if (deferred) { prog.seen = [...seen]; persist(); return bail(); }

      // 사이트맵인지부터 본다. 200 으로 온 오류 HTML 은 "빈 사이트맵"이 아니라 실패다.
      const root = r?.body ? sitemapRoot(r.body) : null;
      if (!root) {
        const why = r?.skipped ? r.why
          : !r?.body ? 'no_body'
          : `not_a_sitemap(${r.page_validity || 'unknown'})`;
        const evidence = {
          status: r?.status ?? null, page_validity: r?.page_validity ?? null,
          first_bytes: r?.body ? String(r.body).trim().replace(/\s+/g, ' ').slice(0, 120) : null,
        };
        if (src === 'guess') {
          // 우리가 찍어 본 주소다. 없는 게 정상이므로 막지 않고 사유만 남긴다.
          out.skipped.push({ url: sm, stage: 'sitemaps', src, why });
          prog.queue.shift(); seen.add(sm); prog.seen = [...seen]; persist(); continue;
        }
        // 사이트가 있다고 한 사이트맵이다. 반쪽 목록으로 완주하면 그 실수가 스냅샷에 박힌다.
        out.blockers = out.blockers.filter((b) => b.url !== sm);
        out.blockers.push({ url: sm, src, why, evidence });
        prog.seen = [...seen]; persist();                    // 큐에서 빼지 않는다 — 다음에 이것부터
        return blockerPause({ url: sm, why });
      }

      prog.queue.shift();
      seen.add(sm);
      out.sitemaps_visited.push(sm);
      out.blockers = out.blockers.filter((b) => b.url !== sm);   // 되살아났으면 미결에서 뺀다
      const xml = r.body;

      if (root === 'sitemapindex') {
        for (const child of childSitemaps(xml)) {
          try { prog.queue.push({ url: normalizeUrl(child, { base: sm }).url, depth: depth + 1, src: 'index' }); } catch {}
        }
        out.per_sitemap[sm] = 0;
        prog.seen = [...seen];
        persist();
        continue;
      }

      const entries = urlEntries(xml);
      out.per_sitemap[sm] = entries.length;
      const items = [];
      for (const e of entries) {
        let n;
        try { n = normalizeUrl(e.loc, { base: sm }); } catch { continue; }
        if (!sameHostIgnoringWww(n.domain, host)) continue;
        // 같은 주소가 여러 사이트맵·추적 변형으로 나와도 한 칸이다.
        // 세는 일은 완주 뒤 next_snapshot 의 고유 url_id 로 한 번만 한다.
        prog.next_snapshot[n.id] = e.lastmod || null;
        items.push({
          url: n.url, kind: classifyKind(n.url, {}).kind, lastmod: e.lastmod,
          via: 'sitemap', from_url_id: normalizeUrl(sm).id, discovered_by: `sitemap:${sm}`,
        });
      }
      const added = store.addUrls(crawl, items);
      out.found += added.added;
      out.duplicates += added.duplicates;
      prog.seen = [...seen];
      persist();
    }
    prog.stage = 'seeds';
    persist();
  }

  // ---- 3단계: 씨앗·홈 ----
  if (prog.stage === 'seeds') {
    for (const s of extraSeeds) {
      if (prog.seeds_done.includes(s)) continue;
      const k = classifyKind(s, {});
      const r = await fetchVia(s, k.kind === 'sitemap' ? 'unknown' : k.kind);
      if (deferred) { persist(); return bail(); }
      if (r?.skipped) out.skipped.push({ url: s, stage: 'seeds', why: r.why });
      else if (r) {
        out.fetched.push({ requested: r.requested, final: r.final, status: r.status, page_validity: r.page_validity, cards: r.cards, negatives: r.negatives });
        await recordContentSignature(crawl, r, host, out);
      }
      prog.seeds_done.push(s);
      persist();
    }
    if (!skipSitemaps && !prog.home_done) {
      const home = await fetchVia(originUrl.origin + '/', 'unknown');
      if (deferred) { persist(); return bail(); }
      if (home?.skipped) out.skipped.push({ url: originUrl.origin + '/', stage: 'seeds', why: home.why });
      else if (home) await recordContentSignature(crawl, home, host, out);
      prog.home_done = true;
      persist();
    }
    prog.stage = 'finish';
    persist();
  }

  // ---- 완주해야만 스냅샷 교체와 사라짐 판정 ----
  const prevSnap = readJson(snapFile(crawl, origin), {}) || {};
  const nextSnap = prog.next_snapshot;

  // 집계는 고유 url_id 한 칸씩. 같은 주소가 두 사이트맵에 있어도 두 번 세지 않는다.
  const summary = { new: 0, changed: 0, unchanged: 0 };
  const revisit = [];
  for (const [id, lm] of Object.entries(nextSnap)) {
    if (!Object.prototype.hasOwnProperty.call(prevSnap, id)) summary.new++;
    else if (prevSnap[id] !== lm) { summary.changed++; revisit.push(id); }
    else summary.unchanged++;
  }
  out.lastmod_summary = summary;
  out.revisit_ids = revisit;
  out.revisit_candidates = revisit.length;

  if (Object.keys(nextSnap).length) writeAtomic(snapFile(crawl, origin), JSON.stringify(nextSnap, null, 2));

  const gone = Object.keys(prevSnap).filter((id) => !(id in nextSnap));
  out.disappeared_marked = 0;
  out.reappeared = 0;
  if (gone.length && Object.keys(nextSnap).length) {
    out.disappeared_marked = gone.length;
    fs.appendFileSync(path.join(p.dir, 'disappeared.jsonl'),
      gone.map((id) => JSON.stringify({ ts: nowMs(), origin, url_id: id, note: '사이트맵에서 사라짐 — 삭제 아님, 확인 필요' })).join('\n') + '\n');
  }
  if (Object.keys(nextSnap).length) {
    store.mutate(crawl, (state) => {
      const events = [];
      for (const id of gone) {
        const rec = state.urls[id];
        if (!rec || rec.missing_from_latest_snapshot) continue;
        rec.missing_from_latest_snapshot = true;
        rec.missing_since = nowMs();
        events.push({ type: 'missing_from_sitemap', url_id: id, note: '삭제하지 않고 표시만 합니다.' });
      }
      // 이번 스냅샷의 lastmod 를 장부에 그대로 맞춘다 — 바뀐 것만이 아니라 전부다.
      // 이미 장부에 있던 주소(링크로 먼저 발견됐거나 중복으로 걸러진 것)는 addUrls 가
      // lastmod 를 손대지 않으므로, 여기서 맞추지 않으면 장부와 스냅샷이 영영 어긋난다.
      for (const [id, lm] of Object.entries(nextSnap)) {
        const rec = state.urls[id];
        if (!rec) continue;
        const before = rec.lastmod ?? null;
        if (before === lm) continue;
        rec.lastmod = lm;
        events.push({ type: 'lastmod_updated', url_id: id, from: before, to: lm });
      }
      // 사라졌다고 표시했던 주소가 다시 나오면 표시를 푼다.
      for (const id of Object.keys(nextSnap)) {
        const rec = state.urls[id];
        if (!rec?.missing_from_latest_snapshot) continue;
        rec.missing_from_latest_snapshot = false;
        rec.reappeared_at = nowMs();
        delete rec.missing_since;
        out.reappeared++;
        events.push({ type: 'reappeared_in_sitemap', url_id: id, note: '사라짐 표시를 해제합니다.' });
      }
      return { events, result: null };
    });
  }
  if (revisit.length) store.requeue(crawl, revisit, 'lastmod_changed');
  out.aborted = false;
  out.completion = 'complete';

  const reportFile = path.join(p.reports, `discover-${new Date().toISOString().slice(0, 10)}-${crypto.randomBytes(3).toString('hex')}.json`);
  writeAtomic(reportFile, JSON.stringify(out, null, 2));
  out.report = reportFile;
  out.done = true;
  // 끝냈다는 표지를 먼저 남기고 진행을 지운다. 순서가 반대면 그 틈에 들어온 호출이
  // "진행도 없고 표지도 없다"고 보고 처음부터 다시 훑는다.
  writeAtomic(doneFile(crawl, origin), JSON.stringify({
    finished_at: nowMs(), finished_at_iso: new Date().toISOString(), report: reportFile, out,
  }, null, 2));
  clearProg(crawl, origin);
  return out;

  function bail() {
    return {
      ...out, done: false, deferred: true, wait_seconds: deferred.wait, why: deferred.why,
      stage: prog.stage, queue_left: prog.queue.length,
      resume: { crawl, origin, stage: prog.stage },
      note: '같은 crawl·origin 으로 다시 부르면 이 자리부터 잇습니다. 스냅샷은 완주 전에는 갈지 않습니다.',
    };
  }

  // 사이트가 선언한 사이트맵이 사이트맵이 아니었다. 반쪽으로 완주하지 않는다.
  function blockerPause(offending) {
    return {
      ...out, done: false, aborted: true, completion: 'paused_incomplete',
      blockers: out.blockers, offending,
      stage: prog.stage, queue_left: prog.queue.length,
      resume: { crawl, origin, stage: prog.stage },
      note: '사이트가 선언한 사이트맵을 읽지 못했습니다. 반쪽 목록으로 끝내면 그 실수가 스냅샷에 박히므로 '
        + '스냅샷·사라짐 판정을 하지 않고 멈춥니다. 그 자리가 정상으로 돌아오면 같은 호출로 이어 부르세요.',
    };
  }

  // 경계(가지 깊이)를 넘었다. 완주가 아니므로 스냅샷도 사라짐 판정도 하지 않는다.
  function boundaryPause(offending) {
    return {
      ...out, done: false, aborted: true, completion: 'paused_incomplete',
      needs_boundary_review: out.depth_exceeded, offending,
      stage: prog.stage, queue_left: prog.queue.length,
      resume: { crawl, origin, stage: prog.stage },
      note: `가지 깊이 ${depthMax} 를 넘었습니다. policy.sitemap_depth_max 를 넓히고 같은 crawl·origin 으로 다시 부르면 이 자리부터 잇습니다. 스냅샷은 갈지 않았습니다.`,
    };
  }
  }
}

/** 이미 끝낸 회차다. 한 번도 나가지 않고 그때 남긴 결과를 그대로 돌려준다. */
function reuseFinished(finished, originInput) {
  const out = { ...finished.out };
  // origin_input 은 저장된 회차가 아니라 "이번에 어떻게 불렀는가" 다.
  if (originInput) out.origin_input = originInput; else delete out.origin_input;
  return {
    ...out,
    done: true, reused_finished_run: true,
    network_calls: 0,                       // 이번 호출은 한 번도 나가지 않았다
    run_network_calls: finished.out.network_calls,
    finished_at_iso: finished.finished_at_iso,
    report: finished.report,
    note: '이미 끝낸 회차입니다. 다시 훑으려면 refresh 를 주세요 — 그 전에는 네트워크를 건드리지 않습니다.',
  };
}

/** 실행권을 못 쥐었다. 진행 파일도 장부도 건드리지 않고 그대로 물러난다. */
function notMyTurn(crawl, origin, originInput = null) {
  return {
    crawl, origin, ...(originInput ? { origin_input: originInput } : {}),
    done: false, deferred: true, wait_seconds: 5, why: 'already_running',
    stage: 'unknown', queue_left: 0,
    found: 0, duplicates: 0, network_calls: 0, refused: 0, refuse_reasons: [], skipped: [],
    robots_sitemaps: [], sitemaps_visited: [], per_sitemap: {},
    lastmod_summary: { new: 0, changed: 0, unchanged: 0 }, revisit_candidates: 0,
    resume: { crawl, origin },
    note: '같은 crawl·origin 을 이미 다른 쪽이 돌고 있습니다. 아무것도 건드리지 않았습니다. '
      + '그쪽이 끝낸 뒤 같은 호출을 다시 하면 다시 훑지 않고 끝난 결과를 돌려줍니다.',
  };
}

function contentSignature(body) {
  return crypto.createHash('sha256').update(String(body || '').replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 16);
}

// 링크를 다시 넣지 않는다 — 이 쪽을 연 fetch 가 링크 note 를 남겼고, 바로 뒤 store.report 가
// 같은 원자 변경 안에서 이미 합쳤다. 여기서 또 넣으면 중복만 늘고 개수 보고가 어긋난다.
// 이 함수에 남은 일은 "내용이 같아 보이는 묶음" 표시 하나다.
async function recordContentSignature(crawl, r, host, out) {
  if (!r.body) return;

  const sig = contentSignature(r.body);
  store.mutate(crawl, (state) => {
    const events = [];
    const rec = state.urls[r.url_id];
    if (!rec) return { events, result: null };
    rec.content_signature = sig;
    const twin = Object.entries(state.urls).find(([id, v]) => id !== r.url_id && v.content_signature === sig && !v.suspected_duplicate_of);
    if (twin) {
      rec.suspected_duplicate_of = twin[0];
      out.suspected_duplicates++;
      events.push({ type: 'suspected_duplicate', url_id: r.url_id, same_as: twin[0], signature: sig,
        note: '내용이 같아 보입니다. 자동으로 지우지 않으니 사람이 확인하세요.' });
    }
    return { events, result: null };
  });
}
