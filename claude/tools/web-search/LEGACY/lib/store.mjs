// web-search — 상태 장부와 임대
// 계획서 2-1, 2-9, 2-12.
//
// events.jsonl 은 추가만 한다. state.json 은 빠르게 읽는 요약본이며 원자적 교체로만 바뀐다.
// 모든 상태 변경 순서: 잠금 → 버전 확인 → lease_token 발급 → 이벤트 추가 → state 원자 교체 → 잠금 해제

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { crawlPaths, ensureCrawlDirs, writeAtomic, readJson } from './paths.mjs';
import { withLock } from './lock.mjs';
import { normalizeUrl } from './url.mjs';
import { validatePolicy, checkUpdate } from './policy.mjs';
import { pageOf, seriesDryness } from './pagination.mjs';
import { publicDetailState } from './cards.mjs';
import { peek as pacePeek } from './pace.mjs';
import * as boundary from './boundary.mjs';
import { classifyKind } from './kind.mjs';

// URL 상태 어휘 — 닫힌 집합
export const URL_STATES = [
  'queued', 'leased', 'fetched', 'content_validated', 'needs_visual_review',
  'visual_validated', 'invalid', 'blocked', 'known_deferred', 'excluded',
  'needs_boundary_review', 'failed_permanent',
];

const DEFAULT_LEASE_TTL_MS = 300_000;   // 계단 최악(실제 크롬)을 감안
const DEFAULT_MAX_ATTEMPTS = 3;

// 주소가 어디서 왔는가 — 닫힌 목록이다. 이 값이 권한의 근거이고, discovered_by 는 사람이 읽는 메모다.
export const PROVENANCE = ['seed', 'robots', 'sitemap', 'internal', 'manual', 'link', 'report'];
// 부모 없이 들어와도 되는 출처. link·report 는 반드시 장부에 있는 부모를 대야 한다.
const PARENTLESS_OK = new Set(['seed', 'robots', 'sitemap', 'internal', 'manual']);

function requireText(v, what) {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s) throw new Error(`${what} 는 비워 둘 수 없습니다 — 누가 왜 바꿨는지 남아야 합니다.`);
  return s;
}

function nowMs() { return Date.now(); }

function emptyState(crawl) {
  return {
    version: 0,
    crawl,
    created_at: nowMs(),
    updated_at: nowMs(),
    events_applied: 0,         // state 에 반영된 이벤트 수(진단용). 재생은 하지 않는다 — reconcile 주석 참고
    urls: {},                  // url_id -> { url, domain, kind, state, depth, attempts, lease, discovered_by, lastmod, priority }
    domains: {},               // domain -> { url_count, shapes, combos, faceted, boundary_review }
    // 안전 상한에 걸려 "잠깐 세워 둔" 후보들. 정책을 넓히면 여기서 자동으로 큐로 돌아간다.
    // 정책상 탈락(제외 도메인·바깥 이동)은 결정이라 여기 담지 않는다.
    boundary_candidates: {},   // url_id -> { url, domain, kind, via, from_url_id, discovered_by, why, evidence, ... }
    // 정책상 영구 탈락(제외 도메인·바깥 이동 한도). 더미에는 안 들어가지만 조회는 된다 —
    // "그 사이트에 없었다"와 "우리가 막았다"를 나중에 구분하려면 남아 있어야 한다.
    excluded: {},              // url_id -> { url, domain, why, evidence, from_url_id, via, discovered_by, seen_count }
    // 이 상태가 어느 정책판까지 반영했는가. 처음부터 1판(만들 때의 정책)을 본 것이다 —
    // 0 으로 두면 첫 씨앗 추가가 "복구"로 잘못 기록된다.
    policy_seen_version: 1,
    // 훑기 회차. 카드가 처음 장부에 들어온 회차를 박아 두는 데 쓴다.
    // 같은 주소를 재시도했다고 회차가 오르지 않는다 — 회차는 보고서를 확정할 때만 넘어간다.
    current_cycle: 1,
    cards: {},                 // card_id -> 카드 기록(계획서 2-11)
    reports_seen: {},          // report_id -> ts  (멱등 판정)
    counts: {},
  };
}

function recount(state) {
  const c = {};
  for (const r of Object.values(state.urls)) c[r.state] = (c[r.state] || 0) + 1;
  state.counts = c;
  return state;
}

export function loadState(crawl) {
  const p = crawlPaths(crawl);
  return readJson(p.state, null) || emptyState(crawl);
}

function appendEvent(crawl, ev) {
  const p = crawlPaths(crawl);
  fs.appendFileSync(p.events, JSON.stringify({ ts: nowMs(), ...ev }) + '\n');
}

function readEvents(crawl) {
  const p = crawlPaths(crawl);
  let text = '';
  try { text = fs.readFileSync(p.events, 'utf8'); } catch { return []; }
  const out = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try { out.push({ lineNo: i + 1, ev: JSON.parse(line) }); }
    catch {
      // 쓰는 도중 죽으면 마지막 줄이 잘릴 수 있다. 마지막 줄만 조용히 넘기고, 중간이면 알린다.
      if (i < lines.length - 2) out.push({ lineNo: i + 1, ev: null, broken: true });
    }
  }
  return out;
}

/**
 * [중단 계약] events.jsonl 에 쓴 뒤 state.json 을 원자적으로 바꾸기 전에 죽으면
 * 이벤트만 남고 상태는 이전 버전이다. state.json 교체는 rename 이라 절대 반쪽이 안 되므로
 * **state 가 진실**이고, state.version 보다 큰 v 를 가진 이벤트는 "일어나지 않은 일"이다.
 *
 * 되살릴 수는 없다 — 이벤트는 의도 기록이지 상태 전이 전체가 아니기 때문이다.
 * 그래서 지우지 않고(append-only 유지) tombstone 한 줄을 덧붙여 무효를 표시한다.
 * 이렇게 하면 다음 변경에서 버전이 이어져도 장부를 읽는 쪽이 헷갈리지 않는다.
 * @returns {number} 무효 처리한 이벤트 수
 */
export function reconcile(crawl) {
  const state = loadState(crawl);
  const rows = readEvents(crawl);
  const orphans = rows.filter((r) => r.ev && typeof r.ev.v === 'number' && r.ev.v > state.version
    && r.ev.type !== 'orphan_events_rolled_back');
  if (!orphans.length) return 0;
  appendEvent(crawl, {
    type: 'orphan_events_rolled_back',
    v: state.version,
    state_version: state.version,
    rolled_back_versions: [...new Set(orphans.map((o) => o.ev.v))],
    lines: orphans.map((o) => o.lineNo),
    note: 'state.json 교체 전에 프로세스가 죽어 반영되지 않은 이벤트. state 가 진실이다.',
  });
  return orphans.length;
}

// 결정적 고장 주입 — 시험 전용. 정상 실행에서는 환경변수가 없으므로 아무 일도 없다.
function faultPoint(name) {
  if (process.env.NODE_ENV !== 'test') return;   // 운영 프로세스를 죽이지 않도록 이중 조건
  if (process.env.WEBSEARCH_FAULT === name) {
    process.kill(process.pid, 'SIGKILL');
  }
}

/**
 * 상태를 바꾸는 유일한 통로. 잠금 안에서 mutate 를 부르고, 반환값을 state 에 반영한다.
 * mutate(state, ctx) 는 { events: [...], result } 를 돌려준다.
 */
export function mutate(crawl, fn, { ttlMs, waitMs } = {}) {
  const p = ensureCrawlDirs(crawl);
  return withLock(p.lock, p.stale, (h) => {
    reconcile(crawl);                       // 잠금 안에서 먼저 장부를 정합시킨다
    const state = loadState(crawl);
    const baseVersion = state.version;
    const nextVersion = baseVersion + 1;

    const { events = [], result, noop = false } = fn(state) || {};

    // [진짜 아무 일도 없었을 때] 판을 올리지 않는다. 올리면 "장부가 그대로인가"를 묻는 쪽이
    // 늘 달라졌다고 보게 되어, 재시도마다 빈 회차가 하나씩 늘어난다.
    if (noop) return result;

    // 되살아난 프로세스 방어 — 쓰기 직전에 잠금이 여전히 내 것인지 확인
    if (!h.valid()) throw new Error('잠금이 다른 쪽으로 넘어갔습니다. 쓰기를 포기합니다.');
    const onDisk = loadState(crawl);
    if (onDisk.version !== baseVersion) throw new Error(`상태 버전 어긋남(${baseVersion} → ${onDisk.version}). 다시 시도하세요.`);

    // 각 이벤트에 "이 변경이 만들 버전"을 박는다 — 미반영 이벤트를 나중에 가려내는 열쇠다.
    for (const ev of events) appendEvent(crawl, { v: nextVersion, ...ev });
    faultPoint('after_events');            // ← 여기서 죽으면 이벤트만 남고 state 는 이전 버전
    state.version = nextVersion;
    state.updated_at = nowMs();
    state.events_applied = (state.events_applied || 0) + events.length;
    recount(state);
    writeAtomic(p.state, JSON.stringify(state, null, 2));
    faultPoint('after_state');
    return result;
  }, { ttlMs, waitMs });
}

// ---------- 크롤 만들기 / 씨앗 넣기 ----------

export function createCrawl(crawl, { seeds = [], policy = {} } = {}) {
  const p = crawlPaths(crawl);
  if (fs.existsSync(p.state)) throw new Error(`이미 있는 크롤입니다: ${crawl}`);
  // 씨앗이 곧 범위다 — allow_domains 를 안 줬으면 씨앗 도메인을 경계로 삼고 그 근거를 남긴다.
  const seedDomains = [];
  for (const s of seeds) {
    try { seedDomains.push(normalizeUrl(s).domain); }
    catch (e) { throw new Error(`씨앗 주소를 읽을 수 없습니다: ${s} (${e.message})`); }
  }
  // [순서] 폴더를 만들기 "전에" 거절한다. 만들고 나서 던지면 반쪽 크롤 폴더가 남고,
  // 다음 시도는 "이미 있는 크롤"로 막힌다.
  const pol = validatePolicy(policy, seedDomains);

  const preexisting = fs.existsSync(p.dir);
  ensureCrawlDirs(crawl);
  try {
    writeAtomic(p.policy, JSON.stringify(pol, null, 2));
    writeAtomic(p.state, JSON.stringify(emptyState(crawl), null, 2));
    fs.writeFileSync(p.events, '');
    const added = addUrls(crawl, seeds.map((u) => ({ url: u, kind: 'unknown', depth: 0, via: 'seed', discovered_by: 'seed' })));
    for (const s of seeds) fs.appendFileSync(p.seeds, JSON.stringify({ url: s, ts: nowMs() }) + '\n');
    return { crawl, policy: pol, seeds_added: added.added, duplicates: added.duplicates };
  } catch (e) {
    if (!preexisting) { try { fs.rmSync(p.dir, { recursive: true, force: true }); } catch {} }
    throw e;
  }
}

export function loadPolicy(crawl) {
  return readJson(crawlPaths(crawl).policy, {}) || {};
}

/**
 * 정책을 부분 수정한다. 경계를 넓히고 멈춘 자리에서 이어 달릴 때 쓴다.
 * 모드·허용·제외 도메인은 못 바꾼다 — 바꾸면 같은 이름의 다른 크롤이 되고,
 * "이 범위를 전부 훑었다"는 말이 조용히 뜻을 바꾼다.
 */
export function updatePolicy(crawl, patch = {}, { who = null, reason = null } = {}) {
  const w = requireText(who, 'who');
  const r = requireText(reason, 'reason');

  return mutate(crawl, (state) => {
    // [직렬] 지금 정책을 잠금 "안에서" 읽는다. 밖에서 읽으면 두 프로세스가 각자 옛 값을 기준으로
    // 방향을 검사하고 서로의 변경을 덮어써, 넓힌 줄 알았던 상한이 조용히 사라진다.
    const cur = loadPolicy(crawl);
    checkUpdate(patch, cur);
    const fromV = cur.policy_version ?? 1;
    const toV = fromV + 1;
    const changes = Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, { from: cur[k] ?? null, to: v }]));
    // [중단 대비] 근거를 정책 파일에도 박는다.
    // 파일을 쓴 직후 죽으면 이 변경의 이벤트는 무효 처리되어 who·reason 이 사라진다.
    // 파일에 남겨 두면 다음 프로세스가 그 근거로 감사 기록을 이어 붙일 수 있다.
    const next = {
      ...cur, ...patch, policy_version: toV,
      last_change: { from_version: fromV, to_version: toV, who: w, reason: r, changes, at_iso: new Date().toISOString() },
    };
    const events = [{ type: 'policy_updated', who: w, reason: r, changes, from_version: fromV, to_version: toV, at_iso: next.last_change.at_iso }];

    // 넓힌 상한으로 주차해 둔 후보를 그 자리에서 다시 잰다
    const re = reevaluateCandidates(state, next, { who: w, reason: r, changes });
    events.push(...re.events);
    state.policy_seen_version = next.policy_version;

    writeAtomic(crawlPaths(crawl).policy, JSON.stringify(next, null, 2));
    return {
      events,
      result: {
        policy: next, readmitted: re.admitted, readmitted_count: re.admitted.length,
        still_waiting: re.waiting,
        boundary_review_cleared: re.events.filter((e) => e.type === 'boundary_review_cleared').map((e) => e.domain),
      },
    };
  });
}

/** 주소를 더미에 넣는다. 정규화 후 url_id 로 중복을 거른다. */
export function addUrls(crawl, items) {
  return mutate(crawl, (state) => {
    // [직렬] 정책도 잠금 안에서 읽는다. 밖에서 읽으면 그 사이에 넓혀진 정책을 못 보고
    // 옛 판으로 입장을 판정하며, policy_seen_version 을 뒤로 되돌릴 수 있다.
    const pol = loadPolicy(crawl);
    const r = admitItems(state, pol, items);
    return { events: r.events, result: { added: r.added, duplicates: r.duplicates, rejected: r.rejected, rejects: r.rejects } };
  });
}

/**
 * 잠금 안에서 도는 입장 판정. addUrls 와 report 가 같은 길을 쓴다 —
 * report 쪽만 따로 구현하면 두 길의 잣대가 조용히 갈라진다.
 * @returns {{events:object[], added:number, duplicates:number, rejected:number, rejects:object[]}}
 */
function admitItems(state, pol, items) {
  {
    const events = [];
    let added = 0, duplicates = 0, rejected = 0;
    const rejects = [];
    const raisedDomains = new Set();

    // [자가 복구 · 단조] 정책이 넓혀졌는데 장부가 아직 그 판을 못 본 상태라면(넓힌 직후 죽었을 때 등)
    // 주차된 후보부터 다시 잰다. 안 하면 넓힌 상한이 조용히 아무것도 못 풀어 준 채 남는다.
    // 판 번호는 절대 뒤로 가지 않는다 — 뒤로 가면 이미 넓힌 기준으로 들어온 것과 앞으로의 기준이 엇갈린다.
    const seenV = state.policy_seen_version ?? 1;
    const polV = pol.policy_version ?? 1;
    if (polV > seenV) {
      const lc = pol.last_change || null;
      const re = reevaluateCandidates(state, pol, { trigger: 'policy_version_catchup' });
      events.push(...re.events);
      // 넓힌 직후 죽으면 그때의 policy_updated 이벤트는 무효 처리된다.
      // 근거는 정책 파일에 남겨 두었으므로 여기서 유효한 감사 기록으로 다시 붙인다.
      events.push({
        type: 'policy_change_recovered', from_version: seenV, to_version: polV,
        who: lc?.who ?? null, reason: lc?.reason ?? null, changes: lc?.changes ?? null,
        readmitted: re.admitted.length, still_waiting: re.waiting,
        note: '정책 파일이 앞서 있고 장부가 못 따라온 상태였습니다. 파일에 남은 근거로 이어 붙입니다.',
      });
      state.policy_seen_version = polV;
    } else if (polV < seenV) {
      // 읽은 정책이 장부보다 뒤다. 이 판으로 정규화·입장 판정을 계속하면 이미 넓힌 기준으로 들어온 것과
      // 지금 들어올 것의 잣대가 엇갈린다. 경고만 남기고 진행하지 않고, 아예 멈춘다.
      throw new Error(`정책이 장부보다 뒤입니다(정책 v${polV} < 장부 v${seenV}). `
        + '옛 정책으로 입장을 판정하지 않습니다. 정책 파일을 확인하세요.');
    }

    for (const it of items) {
      let n;
      try {
        n = normalizeUrl(it.url, {
          base: it.base,
          dropParams: pol.drop_params ?? undefined,
          keepParamsByDomain: pol.keep_params_by_domain ?? {},
          dropParamsByDomain: pol.drop_params_by_domain ?? {},
        });
      } catch (e) { rejected++; rejects.push({ url: it.url, why: 'bad_url', detail: e.message }); continue; }

      // [출처] 문자열 discovered_by 는 사람이 읽는 메모지 권한의 근거가 아니다.
      // 부모 없이 들어와도 되는 출처는 닫힌 목록으로만 정하고, link·report 는 장부에 있는
      // 부모를 대야 한다. 안 그러면 아무 외부 주소나 "새 씨앗"인 척 hop 0 으로 들어온다.
      const via = it.via;
      const deny = (why, evidence) => {
        rejected++;
        rejects.push({ url: n.url, why, evidence });
        // 이미 주차해 둔 후보가 또 들어온 것이면 이벤트를 다시 쌓지 않는다(같은 사실의 반복이다)
        if (already && CAP_WHYS.has(why)) return;
        events.push({
          type: 'boundary_rejected', url: n.url, url_id: n.id, domain: n.domain, why, evidence,
          via: via ?? null, from_url_id: it.from_url_id ?? null, discovered_by: it.discovered_by ?? null,
          parked: CAP_WHYS.has(why),
        });
      };
      const already = !!state.boundary_candidates?.[n.id];
      if (!PROVENANCE.includes(via)) { deny('bad_provenance', { via: via ?? null, allowed: PROVENANCE }); continue; }
      let parent = null;
      if (it.from_url_id) {
        parent = state.urls[it.from_url_id] || null;
        if (!parent) { deny('unknown_parent', { from_url_id: it.from_url_id, via }); continue; }
      } else if (!PARENTLESS_OK.has(via)) {
        deny('unknown_parent', { from_url_id: null, via, parentless_ok: [...PARENTLESS_OK] });
        continue;
      }

      if (state.urls[n.id]) {
        duplicates++;
        // 발견 경로는 여러 개일 수 있다 — 지우지 않고 덧붙인다
        const rec = state.urls[n.id];
        rec.discovered_by = [...new Set([].concat(rec.discovered_by || [], it.discovered_by || []))];
        // 같은 부모가 또 알려 준 것은 한 줄로 둔다. 다른 부모가 알려 준 것은 잃지 않는다 —
        // 어느 쪽에서 닿았는지가 나중에 경로를 되짚는 유일한 근거다.
        const key = `${via}|${it.from_url_id ?? null}`;
        rec.provenance = rec.provenance || [];
        if (!rec.provenance.some((p) => `${p.via}|${p.from_url_id ?? null}` === key)) {
          rec.provenance.push({ via, from_url_id: it.from_url_id ?? null });
        }
        continue;
      }

      // [경계] 통과 못 하면 더미에 안 넣는다. 대신 무엇이 왜 떨어졌는지는 남긴다 —
      // 안 남기면 "그 사이트에 없었다"와 "우리가 막았다"를 나중에 구분할 수 없다.
      const verdict = boundary.admit(pol, state, n, parent);
      if (!verdict.ok) {
        deny(verdict.why, verdict.evidence);
        // 상한에 닿은 것이면 조용히 지나가지 않고 도메인을 세워 두고, 그 후보를 주차한다.
        // 이벤트에만 적어 두면 상한을 넓혀도 그 주소들은 영영 큐로 돌아오지 않는다.
        if (PERMANENT_WHYS.has(verdict.why)) {
          // 더미에는 안 넣지만 장부에서 조회는 된다. 나중에 다른 유효한 부모로 다시 발견되면
          // 이 기록이 입장을 막지 않는다 — urls 가 아니라 따로 두는 이유다.
          exclude(state, n, it, via, verdict);
          boundary.countExcluded(state, n.domain, verdict.why, verdict.evidence);
        }
        if (CAP_WHYS.has(verdict.why)) {
          park(state, n, it, via, verdict);
          const review = boundary.raiseBoundaryReview(state, n.domain, verdict.why, verdict.evidence, nowMs());
          if (!raisedDomains.has(n.domain)) {
            raisedDomains.add(n.domain);
            events.push({ type: 'needs_boundary_review', domain: n.domain, why: verdict.why, review });
          }
        }
        continue;
      }

      // 전에 제외됐던 주소라도 이번에 제대로 된 부모로 들어왔으면 막지 않는다.
      // 옛 기록이 새 발견을 가로막으면 그 사이트는 영영 안 보이게 된다.
      const ex = state.excluded?.[n.id];
      if (ex && ex.active !== false) {
        ex.active = false;                       // 지우지 않는다 — 왜 한때 막혔는지가 근거로 남아야 한다
        ex.resolved_at = nowMs();
        ex.resolved_via = via;
        ex.resolved_from_url_id = it.from_url_id ?? null;
        (ex.history = ex.history || []).push({ at: nowMs(), action: 'readmitted', via, from_url_id: it.from_url_id ?? null });
        events.push({
          type: 'excluded_readmitted', url_id: n.id, url: n.url, was_why: ex.why,
          via, from_url_id: it.from_url_id ?? null,
        });
      }

      const k = decideKind(pol, n, it.kind);
      state.urls[n.id] = {
        url: n.url, domain: n.domain,
        kind: k.kind,
        kind_source: k.source,
        state: it.state || 'queued',
        depth: it.depth ?? 0,
        external_hops: verdict.external_hops,
        attempts: 0,
        lease: null,
        discovered_by: [].concat(it.discovered_by || 'unknown'),
        // [출처] discovered_by 는 사람이 읽는 메모다. 권한과 다리 수의 근거는 이쪽이다.
        provenance: [{ via, from_url_id: it.from_url_id ?? null }],
        lastmod: it.lastmod || null,
        priority: scoreOf({ kind: k.kind, depth: it.depth ?? 0, lastmod: it.lastmod }),
      };
      boundary.countAccepted(state, n, verdict);
      events.push({ type: 'url_added', url_id: n.id, url: n.url, kind: it.kind || 'unknown', discovered_by: it.discovered_by });
      added++;
    }
    return { events, added, duplicates, rejected, rejects };
  }
}

// 안전 상한에 걸린 것들 — 정책을 넓히면 되돌아올 수 있으므로 결정이 아니라 보류다
const CAP_WHYS = new Set(['domain_url_cap', 'path_shape_cap', 'query_combo_cap', 'faceted_cap']);
// 정책이 내린 결정 — 이 크롤에서는 안 본다. 다만 안 본 이유는 조회할 수 있어야 한다.
const PERMANENT_WHYS = new Set([
  'denied_domain', 'external_hop_exceeded',
  'excluded_path_pattern', 'excluded_query_key',
]);

/** 정책상 제외된 주소를 조회 가능하게 남긴다(더미에는 안 들어간다). */
function exclude(state, n, it, via, verdict) {
  state.excluded = state.excluded || {};
  const prev = state.excluded[n.id];
  if (prev) {
    prev.last_seen = nowMs();
    prev.seen_count = (prev.seen_count || 1) + 1;
    prev.discovered_by = [...new Set([].concat(prev.discovered_by || [], it.discovered_by || []))];
    prev.why = verdict.why;
    prev.evidence = verdict.evidence;
    if (prev.active === false) {                    // 풀렸다가 다시 걸렸다 — 이력을 남기고 되살린다
      prev.active = true;
      prev.resolved_at = null; prev.resolved_via = null; prev.resolved_from_url_id = null;
      (prev.history = prev.history || []).push({ at: nowMs(), action: 're_excluded', why: verdict.why, via });
    }
    return prev;
  }
  state.excluded[n.id] = {
    url_id: n.id, url: n.url, domain: n.domain,
    active: true,                                   // 지금도 제외 중인가
    why: verdict.why, evidence: verdict.evidence,
    via, from_url_id: it.from_url_id ?? null,
    discovered_by: [].concat(it.discovered_by || 'unknown'),
    first_seen: nowMs(), last_seen: nowMs(), seen_count: 1,
    resolved_at: null, resolved_via: null, resolved_from_url_id: null,
    history: [{ at: nowMs(), action: 'excluded', why: verdict.why, via }],
  };
  return state.excluded[n.id];
}

/**
 * 카드 목록을 본다. 고르기 도구가 읽는 자료다(계획서 2-11).
 *
 * 상세 상태는 저장값을 그대로 주지 않고 읽을 때마다 장부에서 다시 잰다.
 * 안 그러면 상세를 깨워 가져온 뒤에도 목록을 다시 훑기 전까지 카드가 옛 상태를 말한다.
 */
/**
 * 고른 카드의 상세를 깨워 큐에 올린다.
 *
 * 입장 판정은 addUrls 하나만 쓴다 — 여기서 따로 넣으면 경계·출처·상한 규칙이 두 벌이 되고
 * 언젠가 서로 어긋난다. 이미 큐에 있거나 가져온 것은 건드리지 않는다.
 */
export function wakeDetails(crawl, cardIds, { who = null, reason = null } = {}) {
  const w = requireText(who, 'who');
  const r = requireText(reason, 'reason');
  const before = loadState(crawl);
  const pol0 = loadPolicy(crawl);
  // 카드에 부모 id 가 안 적혀 있으면 목록 주소를 장부와 같은 잣대로 다시 정규화해 구한다.
  const parentIdOf = (c) => {
    if (c.source_url_id) return c.source_url_id;
    try {
      return normalizeUrl(c.source_url, {
        dropParams: pol0.drop_params ?? undefined,
        keepParamsByDomain: pol0.keep_params_by_domain ?? {},
        dropParamsByDomain: pol0.drop_params_by_domain ?? {},
      }).id;
    } catch { return null; }
  };
  // 카드 id 는 그림 주소로도 만들어지므로 장부 키(url_id)와 다를 수 있다.
  // 상세 주소를 장부와 같은 잣대로 정규화한 id 로 봐야 "이미 자고 있던 칸" 을 제대로 찾는다.
  const detailIdOf = (c) => {
    try {
      return normalizeUrl(c.detail_url, {
        dropParams: pol0.drop_params ?? undefined,
        keepParamsByDomain: pol0.keep_params_by_domain ?? {},
        dropParamsByDomain: pol0.drop_params_by_domain ?? {},
      }).id;
    } catch { return null; }
  };
  const wanted = [];
  const skipped = [];
  for (const id of [].concat(cardIds || [])) {
    const card = before.cards?.[id];
    if (!card) { skipped.push({ card_id: id, why: 'unknown_card' }); continue; }
    if (!card.detail_url) { skipped.push({ card_id: id, why: 'no_detail_url' }); continue; }
    const cur = before.urls?.[detailIdOf(card)];
    if (cur && cur.state !== 'known_deferred') {
      skipped.push({ card_id: id, why: `already_${publicDetailState(cur.state)}` });
      continue;
    }
    wanted.push(card);
  }

  let added = { added: 0, duplicates: 0, rejected: 0, rejects: [] };
  if (wanted.length) {
    // 경계·출처 판정은 여기를 지난다. 장부에 없던 상세는 이 길로만 들어온다.
    // 부모는 그 카드를 실어 준 목록이다 — 부모를 지우면 바깥 이동 깊이가 0 으로 되살아나
    // 경계가 실제보다 헐거워진다.
    added = addUrls(crawl, wanted.map((c) => ({
      url: c.detail_url, kind: 'detail', state: 'queued',
      via: 'link', from_url_id: parentIdOf(c),
      discovered_by: `wake:${w}`,
    })));
  }
  // 이미 known_deferred 로 자고 있던 것은 addUrls 가 중복으로 보므로 여기서 깨운다
  const queued = mutate(crawl, (state) => {
    const events = [];
    const ids = [];
    for (const c of wanted) {
      const rec = state.urls[detailIdOf(c)];
      if (!rec) continue;
      if (rec.state === 'known_deferred') { rec.state = 'queued'; rec.lease = null; }
      if (rec.state === 'queued') ids.push(detailIdOf(c));
    }
    // [회차별로 쌓는다] 하나만 남기면 지난 회차에 깨운 것이 이번 회차 보고서에 또 나오고,
    // 한 회차에서 여러 번 깨우면 마지막 것만 남아 나머지가 사라진다.
    const cyc = state.current_cycle ?? 1;
    state.wake_summary = state.wake_summary || {};
    const acc = state.wake_summary[cyc] || {
      cycle: cyc, calls: 0, requested: 0, queued: 0, skipped: 0, rejected: 0, skip_reasons: {}, last: null,
    };
    acc.calls += 1;
    acc.requested += [].concat(cardIds || []).length;
    acc.queued += ids.length;
    acc.skipped += skipped.length;
    acc.rejected += (added.rejects || []).length;
    for (const x of skipped) acc.skip_reasons[x.why] = (acc.skip_reasons[x.why] || 0) + 1;
    acc.last = { at_iso: new Date().toISOString(), who: w, reason: r, requested: [].concat(cardIds || []).length, queued: ids.length };
    state.wake_summary[cyc] = acc;
    events.push({
      type: 'details_woken', who: w, reason: r,
      card_ids: wanted.map((c) => c.card_id), queued: ids.length,
      skipped, rejected: added.rejects || [],
    });
    return { events, result: ids };
  });

  return {
    requested: [].concat(cardIds || []).length,
    queued: queued.length, queued_ids: queued,
    skipped, rejected: added.rejects || [],
  };
}

/**
 * 지금 상태를 고정판으로 떠 둔다. 고르기 도구는 살아 있는 장부가 아니라 이것만 읽는다
 * (계획서 2-11 — 먼저 발견된 것이 먼저 채택되는 치우침을 막는다).
 * 잠금 안에서 번호를 잡고 임시 폴더에 다 쓴 뒤 원자적으로 옮긴다 — 반쪽 폴더가 남지 않는다.
 */
export function snapshotNew(crawl, { who = null, reason = null, force = false } = {}) {
  const w = requireText(who, 'who');
  const r = requireText(reason, 'reason');
  return mutate(crawl, (state) => {
    // 상태 판정도 잠금 안에서 한다. 밖에서 먼저 재면 그 사이 들어온 변경 때문에
    // 고정판에 적힌 판 번호와 실제로 담은 내용이 어긋난다.
    const st = status(crawl);
    if (!force && st.completion !== 'complete') {
      throw new Error(`아직 끝나지 않아 고정판을 뜨지 않습니다: ${st.completion_reason}. `
        + '지금 상태로 굳이 떠야 하면 force 를 주세요.');
    }
    const p = crawlPaths(crawl);
    fs.mkdirSync(p.snapshots, { recursive: true });
    // 앞선 시도가 죽으며 남긴 임시 폴더를 먼저 치운다. 숫자 폴더는 원자적으로 나타나므로
    // .tmp- 로 시작하는 것은 모두 실패한 흔적이다(잠금 안이라 남이 쓰는 중일 수 없다).
    let sweptTmp = 0;
    for (const f of fs.readdirSync(p.snapshots)) {
      if (!f.startsWith('.tmp-')) continue;
      try { fs.rmSync(path.join(p.snapshots, f), { recursive: true, force: true }); sweptTmp++; } catch {}
    }
    const used = fs.readdirSync(p.snapshots).map((f) => Number(f)).filter((n) => Number.isInteger(n));
    const n = (used.length ? Math.max(...used) : 0) + 1;
    const tmp = path.join(p.snapshots, `.tmp-${n}-${crypto.randomBytes(4).toString('hex')}`);
    fs.mkdirSync(tmp, { recursive: true });

    let cards, body;
    try {
      cards = listCards(crawl);
      body = JSON.stringify(cards, null, 2);
      fs.writeFileSync(path.join(tmp, 'cards.json'), body);
    } catch (e) {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
      throw e;
    }
    const manifest = {
      snapshot: n, crawl, who: w, reason: r,
      at: nowMs(), at_iso: new Date().toISOString(),
      state_version: state.version, cycle: state.current_cycle ?? 1,
      cards: cards.length,
      cards_sha256: crypto.createHash('sha256').update(body).digest('hex'),
      captures: [...new Set(cards.map((c) => c.capture_path).filter(Boolean))],
      crops: cards.filter((c) => c.crop_path).length,
      completion: st.completion, completion_reason: st.completion_reason,
      forced: !!force,
      note: '고정판입니다. 이 뒤에 장부가 바뀌어도 이 폴더의 내용은 바뀌지 않습니다.',
    };
    try {
      fs.writeFileSync(path.join(tmp, 'manifest.json'), JSON.stringify(manifest, null, 2));
      fs.renameSync(tmp, path.join(p.snapshots, String(n)));    // 원자적으로 나타난다
    } catch (e) {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
      throw e;
    }
    return {
      events: [{ type: 'snapshot_taken', snapshot: n, who: w, reason: r, cards: cards.length, state_version: state.version, swept_tmp: sweptTmp }],
      result: { ...manifest, dir: path.join(p.snapshots, String(n)), swept_tmp: sweptTmp },
    };
  });
}

/** 뜬 고정판 목록. */
export function listSnapshots(crawl) {
  const dir = crawlPaths(crawl).snapshots;
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => /^\d+$/.test(f)).sort((a, b) => Number(a) - Number(b))
    .map((f) => readJson(path.join(dir, f, 'manifest.json'), null)).filter(Boolean);
}

/**
 * 이번 회차 보고서를 쓰고 회차를 넘긴다.
 *
 * [멱등] 장부가 그대로인데 또 부르면 새 회차를 만들지 않는다. 그러지 않으면 재시도 한 번에
 * 아무 일도 없던 빈 회차가 하나씩 늘어난다.
 */
export function writeCycleReport(crawl, { who = null, reason = null } = {}) {
  const w = requireText(who, 'who');
  const r = requireText(reason, 'reason');
  return mutate(crawl, (state) => {
    const cycle = state.current_cycle ?? 1;
    const last = state.last_cycle_report || null;
    // [멱등] 지난 보고서를 쓰면서 장부 판이 하나 올랐다. 그 뒤로 아무 변화가 없으면
    // 지금 판이 그때 남긴 판과 같다 — 그러면 새 회차를 열지 않는다.
    // (변경 "전" 판을 적어 두면 이 비교가 늘 어긋나 재시도마다 빈 회차가 하나씩 는다.)
    if (last && last.state_version === state.version) {
      return { noop: true, result: { ...last, unchanged: true, note: '장부가 그대로라 새 회차를 열지 않았습니다.' } };
    }
    // 요약도 잠금 안에서 같은 시점으로 잰다
    const st = status(crawl);
    const snaps = listSnapshots(crawl);
    const p = crawlPaths(crawl);
    fs.mkdirSync(p.reports, { recursive: true });
    const file = path.join(p.reports, `cycle-${cycle}.md`);
    const resultVersion = state.version + 1;        // 이 변경이 만들 판
    const md = renderCycleReport({ crawl, cycle, st, snaps, who: w, reason: r, version: resultVersion });
    writeAtomic(file, md);

    state.current_cycle = cycle + 1;
    state.last_cycle_report = { cycle, path: file, state_version: resultVersion, at: nowMs(), who: w, reason: r };
    return {
      events: [{ type: 'cycle_report_written', cycle, path: file, who: w, reason: r, next_cycle: cycle + 1 }],
      result: { ...state.last_cycle_report, next_cycle: cycle + 1, unchanged: false },
    };
  });
}

function renderCycleReport({ crawl, cycle, st, snaps, who, reason, version }) {
  const li = (xs, f) => (xs.length ? xs.map(f).join('\n') : '- 없음');
  return [
    `# ${crawl} — ${cycle}회차 보고`,
    '',
    `- 쓴 사람: ${who} · 사유: ${reason}`,
    `- 장부 판: v${version} · 시각: ${new Date().toISOString()}`,
    `- 완료 판정: **${st.completion}** (${st.completion_reason})`,
    `- 범위: ${st.completion_scope}${st.sampled ? ' · 표본(pilot)' : ''}`,
    '',
    '## 무엇을 훑었나',
    `- 주소 ${st.total}개 · 카드 ${st.cards_total}장 · 쪽 묶음 ${st.page_series_total}개(마름 ${st.dry_page_series})`,
    li(st.origins, (o) => `- ${o.origin}: ${o.state} · 사이트맵 ${o.sitemaps_visited}개`),
    '',
    '## 막힌 것',
    li(st.blockers.slice(0, 10), (b) => `- ${b.url} · ${b.state}`),
    st.review_required ? `- 사람 확인 대기 ${st.review_required}건` : '',
    st.boundary_candidates ? `- 상한에 세워 둔 후보 ${st.boundary_candidates}건` : '',
    '',
    '## 카드 수 대조',
    li(st.card_count_mismatch, (m) => `- ${m.url}: 표시 ${m.declared} vs 잡은 ${m.found}`),
    li(st.declared_needs_review, (m) => `- (범위 모름) ${m.url}: 표시 ${m.declared} · 이 쪽 ${m.page} · 묶음 ${m.series}`),
    '',
    '## 자주 나온 것',
    `- 도메인: ${st.top_domains.slice(0, 10).map((d) => `${d.domain}(${d.urls})`).join(', ') || '없음'}`,
    `- 낱말: ${st.top_words.slice(0, 15).map((t) => `${t.term}(${t.count})`).join(', ') || '없음'}`,
    '',
    '## 빈칸 표',
    Object.keys(st.coverage).length
      ? Object.entries(st.coverage).map(([axis, c]) => `- ${axis}: 목표 [${c.targets.join(', ')}] · 찾음 [${c.found.join(', ')}] · `
        + `빈칸 [${c.blanks.join(', ') || '없음'}] · 표 없는 도메인 ${c.unlabeled_domains.length}곳`).join('\n')
      : '- 목표를 적어 두지 않아 빈칸 표가 없습니다(coverage_targets 미지정).',
    '',
    '## 아직 남은 일',
    li(st.boundary_reviews, (b) => `- 경계 검토 ${b.domain}: ${b.why} (상한 ${b.evidence?.cap ?? '?'})`
      + ` · 늘어난 형태 ${b.top_shapes.map((s) => `${s.what} ${s.count}개`).join(', ') || '없음'}`
      + `${b.top_combos.length ? ` · 쿼리 조합 ${b.top_combos.map((s) => `${s.what || '(없음)'} ${s.count}개`).join(', ')}` : ''}`
      + `${b.top_facet_keys.length ? ` · 거르개 키 ${b.top_facet_keys.map((s) => `${s.what} ${s.count}개`).join(', ')}` : ''}`),
    li(st.open_origins, (o) => `- 못 끝낸 자리 ${o.origin}: ${o.state}`),
    li(st.sleeping_domains, (d) => `- 쉬는 중 ${d.domain}: ${d.seconds}초`),
    li(st.cards_incomplete, (c) => `- 카드 추출 미확정 ${c.url}: ${(c.why || []).join(', ')}`),
    '',
    '## 깨운 상세',
    st.wake_this_cycle
      ? `- 이 회차 ${st.wake_this_cycle.calls}번 불러 요청 ${st.wake_this_cycle.requested}건 중 ${st.wake_this_cycle.queued}건 깨움`
        + ` (건너뜀 ${st.wake_this_cycle.skipped}건 [${Object.entries(st.wake_this_cycle.skip_reasons)
          .map(([k, v]) => `${k} ${v}`).join(', ') || '없음'}], 거절 ${st.wake_this_cycle.rejected}건)`
        + `\n- 마지막: ${st.wake_this_cycle.last?.at_iso} · ${st.wake_this_cycle.last?.who}`
      : '- 이 회차에 깨운 상세가 없습니다.',
    '',
    '## 고정판',
    li(snaps.filter((s) => s.cycle === cycle), (s) => `- #${s.snapshot} · 카드 ${s.cards}장 · v${s.state_version} · ${s.at_iso}${s.forced ? ' (억지로 뜸)' : ''}`),
    snaps.some((s) => s.cycle !== cycle) ? `- (지난 회차 고정판 ${snaps.filter((s) => s.cycle !== cycle).length}개)` : '',
    '',
  ].filter((x) => x !== '').join('\n');
}

export function listCards(crawl, { sourceUrl = null, detailState = null } = {}) {
  const state = loadState(crawl);
  let out = Object.values(state.cards || {}).map((c) => ({
    ...c,
    detail_state: publicDetailState(c.detail_url ? state.urls?.[c.card_id]?.state : null),
    detail_state_at_merge: c.detail_state,
  }));
  if (sourceUrl) out = out.filter((c) => c.source_url === sourceUrl);
  if (detailState) out = out.filter((c) => c.detail_state === detailState);
  return out.sort((a, b) => (a.source_url < b.source_url ? -1 : a.source_url > b.source_url ? 1 : a.position - b.position));
}

/** 내용이 같아 보이는 묶음을 본다. 아무것도 지우지 않았으므로 근거만 준다. */
export function listContentGroups(crawl, { minSize = 2 } = {}) {
  const state = loadState(crawl);
  return Object.values(state.content_groups || {})
    .filter((g) => g.url_ids.length >= minSize)
    .map((g) => ({ ...g, urls: g.url_ids.map((id) => state.urls[id]?.url).filter(Boolean) }));
}

/** 쪽 묶음별로 얼마나 말랐는지 본다. 도착 순서와 무관하게 그 자리에서 다시 센다. */
export function listPageSeries(crawl, { needed = 3 } = {}) {
  const state = loadState(crawl);
  return Object.values(state.page_series || {})
    .map((s) => ({ series: s.series, domain: s.domain, ...seriesDryness(s, needed) }));
}

/**
 * 제외 목록을 본다. 무엇을 왜 안 봤는지가 보고서의 절반이다.
 * 지금도 제외 중인 것과 나중에 제대로 된 길로 들어와 풀린 이력을 나눠서 준다.
 */
export function listExcluded(crawl) {
  const all = Object.values(loadState(crawl).excluded || {});
  return {
    active: all.filter((x) => x.active !== false),
    resolved: all.filter((x) => x.active === false),
    total: all.length,
  };
}

/** 상한에 걸린 후보를 주차한다. 같은 주소는 한 칸만 차지하고 발견 경로만 쌓인다. */
function park(state, n, it, via, verdict) {
  state.boundary_candidates = state.boundary_candidates || {};
  const prev = state.boundary_candidates[n.id];
  if (prev) {
    prev.last_seen = nowMs();
    prev.seen_count = (prev.seen_count || 1) + 1;
    prev.discovered_by = [...new Set([].concat(prev.discovered_by || [], it.discovered_by || []))];
    prev.why = verdict.why;
    prev.evidence = verdict.evidence;
    return prev;
  }
  state.boundary_candidates[n.id] = {
    url_id: n.id, url: n.url, domain: n.domain,
    kind: it.kind || 'unknown', depth: it.depth ?? 0, lastmod: it.lastmod || null,
    via, from_url_id: it.from_url_id ?? null,
    discovered_by: [].concat(it.discovered_by || 'unknown'),
    why: verdict.why, evidence: verdict.evidence,
    first_seen: nowMs(), last_seen: nowMs(), seen_count: 1,
  };
  return state.boundary_candidates[n.id];
}

/**
 * 종류를 정한다. 우선순위를 정해 두지 않으면 같은 주소가 부르는 자리마다 다른 종류가 된다.
 *  1) 부르는 쪽이 unknown 아닌 값을 줬으면 그대로 — 그쪽은 페이지를 봤다.
 *  2) 이 도메인에 고정해 둔 프로필 무늬 — 사람이 확정한 판이라 가장 구체적이다.
 *  3) 크롤 전체에 적어 둔 무늬.
 *  4) 그래도 모르면 unknown 으로 둔다. 억지로 정하지 않는다.
 */
function decideKind(pol, n, given) {
  if (given && given !== 'unknown') return { kind: given, source: 'given' };
  const pinned = pol.domain_profile_pinned?.profiles?.[n.domain];
  if (pinned) {
    const c = boundary.classifyByPolicy({
      listing_path_patterns: pinned.listing_path_patterns || [],
      detail_path_patterns: pinned.detail_path_patterns || [],
    }, n.url);
    if (c.kind) return { kind: c.kind, source: `profile:${n.domain}` };
  }
  const c2 = boundary.classifyByPolicy(pol, n.url);
  if (c2.kind) return { kind: c2.kind, source: 'policy' };
  return { kind: given || 'unknown', source: 'default' };
}

function mostCommon(list) {
  const c = {};
  for (const x of list) c[x] = (c[x] || 0) + 1;
  return Object.entries(c).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

/**
 * 주차해 둔 후보를 지금 정책으로 다시 재 본다. 들어갈 것은 큐로 옮기고, 아직 상한이면 남긴다.
 * 남은 것이 있으면 그 도메인은 다시 세운다 — "넓혔으니 끝"이 아니라 "얼마나 남았나"가 사실이다.
 */
function reevaluateCandidates(state, pol, meta = {}) {
  const events = [];
  const admitted = [];
  const cands = Object.values(state.boundary_candidates || {})
    .sort((a, b) => (a.first_seen - b.first_seen) || (a.url_id < b.url_id ? -1 : 1));

  for (const c of cands) {
    if (state.urls[c.url_id]) { delete state.boundary_candidates[c.url_id]; continue; }  // 다른 길로 이미 들어왔다
    const parent = c.from_url_id ? state.urls[c.from_url_id] : null;
    const target = { url: c.url, domain: c.domain, id: c.url_id };
    const v = boundary.admit(pol, state, target, parent);
    if (!v.ok) { c.why = v.why; c.evidence = v.evidence; continue; }
    const k = decideKind(pol, { url: c.url, domain: c.domain }, c.kind);
    state.urls[c.url_id] = {
      url: c.url, domain: c.domain, kind: k.kind, kind_source: k.source, state: 'queued',
      depth: c.depth ?? 0, external_hops: v.external_hops, attempts: 0, lease: null,
      discovered_by: c.discovered_by, lastmod: c.lastmod || null,
      priority: scoreOf({ kind: k.kind, depth: c.depth ?? 0, lastmod: c.lastmod }),
    };
    boundary.countAccepted(state, target, v);
    delete state.boundary_candidates[c.url_id];
    admitted.push(c.url_id);
    events.push({ type: 'boundary_candidate_admitted', url_id: c.url_id, url: c.url, was_why: c.why, ...meta });
  }

  // 도메인별로 남은 후보를 세어 검토 표시를 다시 계산한다
  const left = {};
  for (const c of Object.values(state.boundary_candidates || {})) (left[c.domain] = left[c.domain] || []).push(c);
  for (const [dom, rec] of Object.entries(state.domains || {})) {
    const rest = left[dom] || [];
    if (!rest.length) {
      if (rec.boundary_review) {
        rec.boundary_review = null;
        events.push({ type: 'boundary_review_cleared', domain: dom, ...meta });
      }
      continue;
    }
    const why = mostCommon(rest.map((c) => c.why));
    boundary.raiseBoundaryReview(state, dom, why, { waiting: rest.length, sample: rest[0]?.url }, nowMs());
  }
  return { admitted, events, waiting: Object.keys(state.boundary_candidates || {}).length };
}

// 우선순위: 목록 먼저, 얕은 것 먼저, lastmod 최신 먼저
function scoreOf({ kind, depth = 0, lastmod }) {
  let s = 0;
  if (kind === 'listing') s += 100;
  else if (kind === 'sitemap') s += 90;
  else if (kind === 'unknown') s += 50;
  else if (kind === 'detail') s += 10;
  s -= depth * 10;
  if (lastmod) s += 1;
  return s;
}

// ---------- 임대 ----------

/**
 * 대기 중인 것 n개를 떼어 준다. 우선순위 순으로 꺼내고, 같은 도메인이 한 워커에게 몰리도록 묶는다
 * (전역 pace 는 도메인 단위라 흩뿌리면 서로 기다리기만 한다).
 */
export function lease(crawl, n = 10, worker = '') {
  const pol = loadPolicy(crawl);
  const ttl = pol.lease_ttl_ms ?? DEFAULT_LEASE_TTL_MS;
  return mutate(crawl, (state) => {
    const events = [];
    reclaimExpired(state, pol, events);

    const queued = Object.entries(state.urls)
      .filter(([, r]) => r.state === 'queued')
      .sort((a, b) => (b[1].priority - a[1].priority) || (a[1].domain < b[1].domain ? -1 : 1));

    const picked = queued.slice(0, Math.max(0, n));
    const out = [];
    for (const [id, r] of picked) {
      const token = crypto.randomUUID();
      r.state = 'leased';
      r.lease = { token, worker, acquired_at: nowMs(), expires_at: nowMs() + ttl };
      out.push({ url_id: id, url: r.url, domain: r.domain, kind: r.kind, depth: r.depth, lease_token: token });
      events.push({ type: 'leased', url_id: id, lease_token: token, worker });
    }
    return { events, result: { leased: out, remaining_queued: queued.length - picked.length } };
  });
}

/**
 * 딱 한 주소만 임대한다.
 * lease(crawl, 50) 으로 하나를 얻으려 하면 나머지 49개도 leased 가 되어, 부르지도 않은 주소가
 * 남의 손에 묶인다(2026-08-11 매니저 감사). 목표가 하나면 하나만 잡는다.
 * @returns {{ok, lease_token?, why?}}
 */
export function leaseUrl(crawl, urlId, worker = '') {
  const pol = loadPolicy(crawl);
  const ttl = pol.lease_ttl_ms ?? DEFAULT_LEASE_TTL_MS;
  return mutate(crawl, (state) => {
    const events = [];
    reclaimExpired(state, pol, events);
    const rec = state.urls[urlId];
    if (!rec) return { events, result: { ok: false, why: 'unknown_url' } };
    if (rec.state === 'leased' && rec.lease && nowMs() <= rec.lease.expires_at) {
      // 이미 남이 잡고 있다 — 뺏지 않는다
      return { events, result: { ok: false, why: 'already_leased', worker: rec.lease.worker } };
    }
    if (!['queued', 'leased'].includes(rec.state)) {
      return { events, result: { ok: false, why: `not_queued(${rec.state})` } };
    }
    const token = crypto.randomUUID();
    rec.state = 'leased';
    rec.lease = { token, worker, acquired_at: nowMs(), expires_at: nowMs() + ttl };
    events.push({ type: 'leased_single', url_id: urlId, lease_token: token, worker });
    return { events, result: { ok: true, lease_token: token, url: rec.url, kind: rec.kind } };
  });
}

/**
 * 이미 끝낸 주소를 다시 보게 만든다. 자동으로는 일어나지 않고, 부르는 쪽이 이유를 대야 한다.
 * (사이트맵에서 lastmod 가 바뀐 것을 다시 볼 때 쓴다.)
 */
export function requeue(crawl, urlIds, reason = 'unspecified') {
  return mutate(crawl, (state) => {
    const events = [];
    let moved = 0;
    for (const id of [].concat(urlIds)) {
      const rec = state.urls[id];
      if (!rec) continue;
      if (rec.state === 'queued' || rec.state === 'leased') continue;
      const from = rec.state;
      rec.state = 'queued';
      rec.lease = null;
      rec.requeued_at = nowMs();
      rec.requeue_reason = reason;
      events.push({ type: 'requeued', url_id: id, from, reason, at_iso: new Date().toISOString() });
      moved++;
    }
    return { events, result: { moved } };
  });
}

function reclaimExpired(state, pol, events) {
  const max = pol.max_attempts ?? DEFAULT_MAX_ATTEMPTS;
  for (const [id, r] of Object.entries(state.urls)) {
    if (r.state !== 'leased' || !r.lease) continue;
    if (nowMs() <= r.lease.expires_at) continue;
    r.attempts = (r.attempts || 0) + 1;
    const oldToken = r.lease.token;
    r.lease = null;
    if (r.attempts >= max) {
      r.state = 'failed_permanent';
      events.push({ type: 'lease_expired_failed', url_id: id, lease_token: oldToken, attempts: r.attempts });
    } else {
      r.state = 'queued';
      events.push({ type: 'lease_expired_requeued', url_id: id, lease_token: oldToken, attempts: r.attempts });
    }
  }
}

/**
 * 결과 반납. 세 가지를 검사한다.
 *  - report_id 중복이면 한 번만 반영(멱등)
 *  - lease_token 이 현재 것과 다르면 거절(만료 후 재배정된 뒤 늦게 온 결과)
 *  - 상태 어휘가 닫힌 집합 안인지
 */
export function report(crawl, items, reportId = null) {
  return mutate(crawl, (state) => {
    const pol = loadPolicy(crawl);
    const words = pol.required_words || [];
    const events = [];
    const rid = reportId || crypto.randomUUID();
    if (state.reports_seen[rid]) {
      return { events: [{ type: 'report_duplicate_ignored', report_id: rid }], result: { duplicate: true, accepted: 0, rejected: 0 } };
    }

    let accepted = 0, rejected = 0;
    let linksAdded = 0, linksSeen = 0;      // 이 쪽들을 열며 본 링크 중 실제로 더미에 든 수
    const rejects = [];
    for (const it of items) {
      const r = state.urls[it.url_id];
      if (!r) { rejected++; rejects.push({ url_id: it.url_id, why: 'unknown_url' }); continue; }
      const cur = r.lease?.token || null;
      if (!it.lease_token || it.lease_token !== cur) {
        rejected++;
        rejects.push({ url_id: it.url_id, why: 'stale_lease_token' });
        events.push({ type: 'late_report_rejected', url_id: it.url_id, given: it.lease_token, current: cur });
        continue;
      }
      const next = it.state && URL_STATES.includes(it.state) ? it.state : 'fetched';
      r.state = next;
      r.lease = null;
      if (it.evidence) r.evidence = it.evidence;

      // [필수 낱말] 없다고 버리지 않는다. 이미지 위주 사이트와 다른 언어 사이트는
      // 낱말이 없어도 진짜다. 그래서 큐에서 빼지 않고 "사람이 봐야 한다"는 표시만 남긴다.
      //
      // 판정은 본문을 쥐고 있는 fetch 가 이미 해서 manifests/<url_id>/words.json 에 남겨 둔다.
      // 워커가 본문이나 낱말 목록을 들고 다니지 않는다 — 워커가 보낸 값은 근거가 아니므로 안 받는다.
      // 그 판정은 "이번 임대에서 실제로 가져온 것"일 때만 쓴다. 옛 임대의 판정은 남의 것이다.
      let hit = null;
      const w = readJson(path.join(crawlPaths(crawl).manifests, it.url_id, 'notes', 'words.json'), null);
      if (w?.checked && w.lease_token && w.lease_token === it.lease_token) hit = w.matched || [];
      if (words.length && Array.isArray(hit)) {
        if (hit.length) {
          if (r.review_required?.why === 'required_words_missing') delete r.review_required;
          r.matched_words = hit;
        } else {
          r.review_required = {
            why: 'required_words_missing', words, at: nowMs(),
            note: '낱말이 없다는 이유로 버리지 않습니다. 사람이 보고 판단하세요.',
          };
          events.push({ type: 'review_required', url_id: it.url_id, why: 'required_words_missing', words });
        }
      }

      // [나가는 링크] 이 쪽을 열며 본 링크를, 표를 받아들이는 이 원자 변경 안에서 합친다.
      // 워커가 report 뒤에 따로 넣게 하면 그 사이에 죽을 때 발견이 사라진다.
      // 넓히는 근거는 fetch 가 남긴 최종 판정이다 — 워커가 보낸 state 는 근거가 아니다.
      // 확실히 정상인 쪽(content_validated)만 따라간다. invalid 는 물론이고
      // "아직 모른다"(needs_visual_review)도 자동으로는 넓히지 않는다 —
      // 로그인으로 튕긴 쪽의 메뉴를 따라가면 그 사이트 전체가 헛물이 된다. note 는 지우지 않고 남는다.
      const lnote = readJson(path.join(crawlPaths(crawl).manifests, it.url_id, 'notes', 'links.json'), null);
      if (lnote && lnote.lease_token === it.lease_token && Array.isArray(lnote.links) && lnote.links.length) {
        // 본 것과 들인 것은 다른 수다. 따라가지 않은 쪽도 "봤다"에 들어가야
        // 나중에 "0건이었다"와 "아직 안 봤다"를 가를 수 있다.
        linksSeen += lnote.links.length;
        if (lnote.page_validity === 'content_validated') {
          // 종류는 발견 경로와 같은 잣대로 붙인다. 전부 unknown 으로 넣으면
          // 명백한 상세까지 워커가 열어 버려 목록 우선 계약이 깨진다.
          // 상세는 처음부터 재워 둔다 — 큐에 넣으면 워커가 빌렸다 도로 재우는 헛걸음만 는다.
          const merged = admitItems(state, pol, lnote.links.map((u) => {
            const k = classifyKind(u, {}).kind;
            return {
              url: u, kind: k, state: k === 'detail' ? 'known_deferred' : 'queued',
              via: 'link', from_url_id: it.url_id,
              discovered_by: `link:${lnote.source_url || r.url}`,
            };
          }));
          events.push(...merged.events);
          linksAdded += merged.added;
        } else {
          events.push({
            type: 'links_not_followed', url_id: it.url_id, page_validity: lnote.page_validity,
            links_seen: lnote.links.length, links_added: 0,
            note: '판정이 content_validated 가 아니라 따라가지 않았습니다. 링크 기록은 남아 있습니다.',
          });
        }
      }

      // [내용 지문] 워커가 뭐라 주장하든 안 받는다. 본문을 쥔 fetch 가 이 임대에 묶어 남긴 것만 쓴다.
      const cinfo = readJson(path.join(crawlPaths(crawl).manifests, it.url_id, 'notes', 'content.json'), null);
      if (cinfo && cinfo.lease_token === it.lease_token) {
        // 내용이 바뀌었거나 이제 잴 수 없게 됐으면 옛 묶음에서 실제로 뺀다.
        // 안 빼면 "지금 같아 보이는 것"을 묻는 조회에 옛 관계가 영영 남는다. 이력은 이벤트로 남긴다.
        const prevHash = r.content_hash || null;
        const nextHash = cinfo.available ? cinfo.hash : null;
        if (prevHash && prevHash !== nextHash) {
          const g0 = state.content_groups?.[prevHash];
          if (g0) {
            g0.url_ids = g0.url_ids.filter((x) => x !== it.url_id);
            g0.last_changed = nowMs();
            events.push({
              type: 'content_group_left', hash: prevHash, url_id: it.url_id,
              to: nextHash, remaining: g0.url_ids.length,
              note: '내용이 달라져 이 묶음에서 뺍니다. 묶음 기록 자체는 남깁니다.',
            });
          }
        }
        if (cinfo.available) {
          r.content_hash = cinfo.hash;
          r.content_hash_meta = { algo: cinfo.algo, normalize: cinfo.normalize, version: cinfo.version, text_len: cinfo.text_len };
          delete r.content_hash_unavailable;
          state.content_groups = state.content_groups || {};
          const g = state.content_groups[cinfo.hash] || (state.content_groups[cinfo.hash] = {
            hash: cinfo.hash, algo: cinfo.algo, normalize: cinfo.normalize, version: cinfo.version,
            url_ids: [], first_seen: nowMs(), sample: r.url,
          });
          if (!g.url_ids.includes(it.url_id)) {
            g.url_ids.push(it.url_id);
            g.last_seen = nowMs();
            // 지우지 않는다. 같아 보인다는 사실만 묶어 두고 사람이 본다.
            if (g.url_ids.length === 2) {
              events.push({ type: 'same_content_group', hash: cinfo.hash, url_ids: [...g.url_ids],
                note: '내용이 같아 보입니다. 아무것도 지우지 않고 묶기만 합니다.' });
            }
          }
        } else {
          r.content_hash_unavailable = { why: cinfo.why, text_len: cinfo.text_len, at: nowMs() };
          delete r.content_hash;
        }
      }

      // [쪽 관찰] 이 쪽이 내놓은 상세 주소 집합을 그대로 옮긴다. 새것 수는 여기서 세지 않는다.
      const pinfo = readJson(path.join(crawlPaths(crawl).manifests, it.url_id, 'notes', 'page.json'), null);
      if (pinfo && pinfo.lease_token === it.lease_token) {
        const where = pageOf(r.url, { kind: r.kind, kindSource: r.kind_source });
        if (where) {
          state.page_series = state.page_series || {};
          const s = state.page_series[where.series] || (state.page_series[where.series] = { series: where.series, domain: r.domain, pages: {} });
          s.pages[where.index] = pinfo.unknown
            ? { unknown: true, why: pinfo.why, url_id: it.url_id, at: nowMs() }
            : { unknown: false, emitted: pinfo.emitted, url_id: it.url_id, at: nowMs() };
          r.page_series = where.series;
          r.page_index = where.index;
        }
      }

      // [낱말·표시 수] 쪽마다 한 번만 세어 둔 값을 그대로 받는다. 합치기는 status 가 한다.
      const tinfo = readJson(path.join(crawlPaths(crawl).manifests, it.url_id, 'notes', 'terms.json'), null);
      if (tinfo && tinfo.lease_token === it.lease_token) {
        r.terms = tinfo.terms || {};          // 덮어쓴다 — 다시 훑어도 이 쪽은 한 번만 센다
        r.declared = tinfo.declared ?? null;
      }

      // [카드] fetch 가 이 임대에서 실제로 잘라 낸 것만 합친다. 워커가 보낸 카드 주장은 안 받는다.
      const cnote = readJson(path.join(crawlPaths(crawl).manifests, it.url_id, 'notes', 'cards.json'), null);
      if (cnote && cnote.lease_token === it.lease_token) {
        state.cards = state.cards || {};
        let added = 0, updated = 0;
        for (const c of cnote.cards || []) {
          const prev = state.cards[c.card_id];
          if (prev) {
            // 회차는 처음 들어온 그때 것을 지킨다. 다시 훑었다고 새 회차가 되면 안 된다.
            state.cards[c.card_id] = { ...prev, ...c, discovered_cycle: prev.discovered_cycle, last_seen: nowMs() };
            updated++;
          } else {
            state.cards[c.card_id] = { ...c, discovered_cycle: state.current_cycle ?? 1, first_seen: nowMs(), last_seen: nowMs() };
            added++;
          }
        }
        r.cards_extraction_status = cnote.extraction_status;
        r.cards_why = cnote.why?.length ? cnote.why : undefined;
        r.card_ids = (cnote.cards || []).map((c) => c.card_id);
        events.push({
          type: 'cards_merged', url_id: it.url_id, added, updated,
          total: (cnote.cards || []).length, cropped: (cnote.cards || []).filter((c) => c.crop_path).length,
          extraction_status: cnote.extraction_status, why: cnote.why || [],
        });
      }

      events.push({ type: 'reported', url_id: it.url_id, to_state: next, report_id: rid });
      accepted++;
    }
    state.reports_seen[rid] = nowMs();
    return { events, result: { report_id: rid, accepted, rejected, rejects, links_seen: linksSeen, links_added: linksAdded } };
  });
}

/**
 * 임대 표를 확인한다. fetch 는 이걸 통과하지 못하면 네트워크를 단 한 번도 건드리지 않는다.
 * @returns {{ok:boolean, why?:string, rec?:object, url_id?:string}}
 */
export function verifyLease(crawl, { url, url_id, lease_token }) {
  if (!lease_token) return { ok: false, why: 'no_lease_token' };
  const state = loadState(crawl);
  let id = url_id;
  if (!id && url) {
    try { id = normalizeUrl(url).id; } catch { return { ok: false, why: 'bad_url' }; }
  }
  const rec = id ? state.urls[id] : null;
  if (!rec) return { ok: false, why: 'unknown_url' };
  if (rec.state !== 'leased') return { ok: false, why: `not_leased(${rec.state})` };
  if (rec.lease?.token !== lease_token) return { ok: false, why: 'stale_lease_token' };
  if (nowMs() > (rec.lease?.expires_at ?? 0)) return { ok: false, why: 'lease_expired' };
  return { ok: true, rec, url_id: id };
}

export function status(crawl) {
  // loadState 는 없는 크롤에도 빈 상태를 준다(생성 경로에 필요). 그러니 "정말 있는가" 는
  // state.json 실재로 따로 답한다 — 없는 이름을 "다 본 빈 크롤" 로 보이게 두면 안 된다.
  const exists = fs.existsSync(crawlPaths(crawl).state);
  const state = loadState(crawl);
  const pol = loadPolicy(crawl);
  const byDomain = {};
  for (const r of Object.values(state.urls)) {
    byDomain[r.domain] = byDomain[r.domain] || {};
    byDomain[r.domain][r.state] = (byDomain[r.domain][r.state] || 0) + 1;
  }
  const blockers = Object.entries(state.urls)
    .filter(([, r]) => ['blocked', 'needs_visual_review', 'needs_boundary_review'].includes(r.state))
    .map(([id, r]) => ({ url_id: id, url: r.url, state: r.state }));
  const openWork = (state.counts.queued || 0) + (state.counts.leased || 0);
  // 상한에 걸려 세워 둔 후보가 남아 있으면 다 본 것이 아니다 —
  // 그 주소들은 "없어서 안 나온 것"이 아니라 "우리가 아직 안 본 것"이다.
  const waiting = Object.keys(state.boundary_candidates || {}).length;
  const reviewDomains = Object.entries(state.domains || {})
    .filter(([, d]) => d.boundary_review).map(([dom]) => dom);
  const exAll = Object.values(state.excluded || {});
  const exActive = exAll.filter((x) => x.active !== false);
  // 사람이 봐야 한다고 표시된 것 — 버린 게 아니라 판단을 미룬 것이다
  const reviewNeeded = Object.entries(state.urls).filter(([, r]) => r.review_required)
    .map(([id, r]) => ({ url_id: id, url: r.url, why: r.review_required.why }));
  // [발견이 끝났는가] 진행 파일이 "없다"는 것은 끝냈다는 뜻도 되고 시작조차 안 했다는 뜻도 된다.
  // 그래서 없음을 근거로 삼지 않는다. 훑기로 한 자리마다 끝냈다는 표지를 직접 확인한다.
  const dir = crawlPaths(crawl).dir;
  const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  const targetOrigins = new Set();
  try {
    for (const line of fs.readFileSync(crawlPaths(crawl).seeds, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { targetOrigins.add(new URL(JSON.parse(line).url).origin); } catch {}
    }
  } catch {}
  for (const f of files) {
    const m = f.match(/^discover-(progress|done)-(.*)\.json$/);
    if (!m) continue;
    const rec = readJson(path.join(dir, f), null);
    const o = rec?.origin || rec?.out?.origin;
    if (o) targetOrigins.add(o);
  }
  const originKeyOf = (o) => crypto.createHash('sha256').update(o).digest('hex').slice(0, 12);
  const originStatus = [];
  for (const o of targetOrigins) {
    const k = originKeyOf(o);
    const prog = files.includes(`discover-progress-${k}.json`);
    const doneRec = readJson(path.join(dir, `discover-done-${k}.json`), null);
    // 사이트맵을 건너뛰고 돈 회차는 어느 모드에서도 완주로 치지 않는다.
    // pilot 은 "표본만 본다"는 뜻이지 "사이트맵을 안 봐도 확인했다"는 뜻이 아니다.
    const skipped = doneRec?.out?.skip_sitemaps === true;
    const finished = !!doneRec && doneRec.out?.done === true && doneRec.out?.aborted !== true && !skipped;
    originStatus.push({
      origin: o,
      state: prog ? 'in_progress' : finished ? 'done' : (doneRec ? (skipped ? 'done_without_sitemaps' : 'aborted') : 'not_started'),
      sitemaps_visited: doneRec?.out?.sitemaps_visited?.length ?? 0,
      blockers: doneRec?.out?.blockers?.length ?? 0,
    });
  }
  const openOrigins = originStatus.filter((x) => x.state !== 'done');

  // [표시 수 대조] 쪽이 밝힌 수는 그 쪽만의 수일 수도, 목록 전체의 합계일 수도 있다.
  // 어느 쪽인지 모르면 어긋났다고 단정하지 않고 사람에게 넘긴다.
  const idsOf = (r) => new Set(r.card_ids || []);
  const seriesUnion = new Map();
  for (const r of Object.values(state.urls)) {
    if (!r.page_series || !r.card_ids) continue;
    if (!seriesUnion.has(r.page_series)) seriesUnion.set(r.page_series, new Set());
    for (const id of r.card_ids) seriesUnion.get(r.page_series).add(id);
  }
  const cardCheck = [];
  const declaredNeedsReview = [];
  for (const r of Object.values(state.urls)) {
    if (r.declared == null) continue;
    const pageCount = idsOf(r).size;
    if (pageCount === r.declared) continue;                       // 이 쪽만의 수로 맞는다
    const union = r.page_series ? seriesUnion.get(r.page_series)?.size ?? 0 : null;
    if (union != null && union === r.declared) continue;          // 목록 전체 합계로 맞는다
    if (r.page_series) {
      // 쪽 나눔 목록인데 둘 다 안 맞는다 — 아직 다 안 훑었을 수도 있다. 단정하지 않는다.
      declaredNeedsReview.push({ url: r.url, declared: r.declared, page: pageCount, series: union, why: 'declared_scope_unknown' });
    } else {
      cardCheck.push({ url: r.url, declared: r.declared, found: pageCount, scope: 'page' });
    }
  }
  // 추출이 확정되지 않은 쪽 — 목록인데 그 값이 아예 없는 쪽도 확정된 것이 아니다
  const PROCESSED = new Set(['fetched', 'content_validated', 'visual_validated', 'needs_visual_review']);
  const cardsIncomplete = Object.values(state.urls)
    .filter((r) => (r.cards_extraction_status && r.cards_extraction_status !== 'complete')
      || (r.kind === 'listing' && PROCESSED.has(r.state) && !r.cards_extraction_status))
    .map((r) => ({ url: r.url, why: r.cards_why || [r.cards_extraction_status ? r.cards_extraction_status : 'no_cards_record'] }));

  // 잠든 도메인 — 차단 낌새로 쉬고 있으면 아직 끝난 게 아니다
  const sleeping = [];
  for (const dom of Object.keys(byDomain)) {
    try {
      const pk = pacePeek(dom);
      if (pk.sleep_until > nowMs()) sleeping.push({ domain: dom, seconds: Math.ceil((pk.sleep_until - nowMs()) / 1000) });
    } catch {}
  }
  const blockedCount = state.counts.blocked || 0;

  const complete = openWork === 0 && blockers.length === 0 && waiting === 0 && reviewDomains.length === 0
    && openOrigins.length === 0 && cardCheck.length === 0 && cardsIncomplete.length === 0
    && declaredNeedsReview.length === 0
    && reviewNeeded.length === 0 && sleeping.length === 0 && blockedCount === 0;
  const why = [];
  if (openWork) why.push(`대기/임대 ${openWork}건`);
  if (openOrigins.length) why.push(`아직 다 못 훑은 자리 ${openOrigins.length}곳(${openOrigins.slice(0,2).map(o=>o.origin+':'+o.state).join(', ')})`);
  if (blockers.length) why.push(`막힘 ${blockers.length}건`);
  if (blockedCount) why.push(`차단된 주소 ${blockedCount}건`);
  if (sleeping.length) why.push(`쉬는 중인 도메인 ${sleeping.length}곳`);
  if (waiting) why.push(`상한에 세워 둔 후보 ${waiting}건`);
  if (reviewDomains.length) why.push(`경계 검토 대기 도메인 ${reviewDomains.length}곳(${reviewDomains.slice(0, 3).join(', ')})`);
  if (reviewNeeded.length) why.push(`사람 확인 대기 ${reviewNeeded.length}건`);
  if (cardCheck.length) why.push(`표시 수와 카드 수가 어긋난 쪽 ${cardCheck.length}곳`);
  if (cardsIncomplete.length) why.push(`카드 추출이 확정 안 된 쪽 ${cardsIncomplete.length}곳`);
  if (declaredNeedsReview.length) why.push(`표시 수의 범위를 모르는 쪽 ${declaredNeedsReview.length}곳(사람 확인)`);

  // [편향] 자주 나온 도메인은 고유 주소 수로 센다. 자주 나온 낱말은 쪽마다 한 번 센 값을 합친다.
  const domainCounts = Object.entries(byDomain)
    .map(([dom, c]) => ({ domain: dom, urls: Object.values(c).reduce((s, n) => s + n, 0) }))
    .sort((a, b) => b.urls - a.urls);
  const termTotals = new Map();
  for (const r of Object.values(state.urls)) {
    for (const [t, n] of Object.entries(r.terms || {})) termTotals.set(t, (termTotals.get(t) || 0) + n);
  }
  const topWords = [...termTotals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)
    .map(([term, count]) => ({ term, count }));

  // [빈칸 표] 짐작하지 않는다. 사람이 적어 둔 목표와 도메인 메모만 쓴다.
  const coverage = {};
  const seenDomains = new Set(Object.keys(byDomain));
  for (const [axis, targets] of Object.entries(pol.coverage_targets || {})) {
    const found = new Set();
    for (const dom of seenDomains) {
      const v = pol.domain_meta?.[dom]?.[axis];
      if (v) found.add(v);
    }
    coverage[axis] = {
      targets, found: [...found].sort(),
      blanks: targets.filter((t) => !found.has(t)),
      unlabeled_domains: [...seenDomains].filter((d) => !pol.domain_meta?.[d]?.[axis]).sort(),
    };
  }

  return {
    crawl, exists, version: state.version, mode: pol.mode, sampled: pol.sampled === true,
    counts: state.counts, total: Object.keys(state.urls).length,
    domains: byDomain,
    blockers: blockers.slice(0, 50),
    blocker_total: blockers.length,
    boundary_candidates: waiting,
    boundary_review_domains: reviewDomains,
    // 무엇이 얼마나 늘어 상한에 닿았는지 — 사람이 판단할 근거는 개수가 아니라 형태다
    boundary_reviews: Object.entries(state.domains || {})
      .filter(([, d]) => d.boundary_review)
      .map(([dom, d]) => ({
        domain: dom, why: d.boundary_review.why, evidence: d.boundary_review.evidence,
        url_count: d.boundary_review.url_count,
        top_shapes: d.boundary_review.top_shapes || [],
        top_combos: d.boundary_review.top_combos || [],
        top_facet_keys: d.boundary_review.top_facet_keys || [],
      })),
    excluded_active: exActive.length,
    excluded_resolved: exAll.length - exActive.length,
    excluded_sample: exActive.slice(0, 20).map((x) => ({ url: x.url, why: x.why, evidence: x.evidence, from_url_id: x.from_url_id })),
    // 안 들인 규칙별 빈도 — 어떤 경계가 얼마나 일했는지
    excluded_by: Object.entries(state.domains || {}).flatMap(([dom, d]) =>
      Object.entries(d.excluded_by || {}).map(([label, n]) => ({ domain: dom, rule: label, count: n })))
      .sort((a, b) => b.count - a.count).slice(0, 20),
    // 같아 보이는 묶음과 마른 쪽 묶음 — 자동으로 버리지 않고 검토 근거로만 센다
    content_groups: Object.values(state.content_groups || {}).filter((g) => g.url_ids.length >= 2).length,
    dry_page_series: Object.values(state.page_series || {})
      .filter((s) => seriesDryness(s, 3).dry).length,
    page_series_total: Object.keys(state.page_series || {}).length,
    review_required: reviewNeeded.length,
    review_required_sample: reviewNeeded.slice(0, 20),
    open_origins: openOrigins,
    sleeping_domains: sleeping,
    cards_total: Object.keys(state.cards || {}).length,
    origins: originStatus,
    card_count_mismatch: cardCheck,
    declared_needs_review: declaredNeedsReview,
    cards_incomplete: cardsIncomplete,
    top_domains: domainCounts.slice(0, 20),
    top_words: topWords,
    coverage,
    cycle: state.current_cycle ?? 1,
    wake_this_cycle: state.wake_summary?.[state.current_cycle ?? 1] || null,
    completion: complete ? 'complete' : 'paused_incomplete',
    completion_scope: `이 크롤에 고정된 경계 안(${(pol.allow_domains || []).join(', ') || '허용 목록 미지정'})`,
    completion_reason: complete
      ? '대기·임대·막힘·세워 둔 후보·사람 확인·표시 수 어긋남 없음'
      : why.join(', '),
  };
}
