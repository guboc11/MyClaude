#!/usr/bin/env node
// 게이트 3 — 발견(discover). 계획서 4장 게이트 3의 8항목.
//
// [원칙] 합격 판정은 전부 로컬 fixture 로만 한다. 이 게이트에서 외부 사이트에는 접속하지 않는다.
// 계획서에 적힌 "deardeer 138 · 데어무드 11" 은 2026-08-11 관찰값이며, 여기서는 그 수를 가진
// 로컬 사이트맵으로 파서·개수 계약만 검증한다. 실제 사이트의 현재 수치를 재검증하는 것이 아니다.
//
// 실행: WEBSEARCH_DEPS_DIR=<레포> node tests/gate3.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.join(HERE, '..', 'lib');
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'websearch-gate3-'));
process.env.CLAUDE_PROJECT_DIR = SANDBOX;

const results = [];
function check(no, name, pass, detail = '') {
  results.push({ no, name, pass, detail });
  console.log(`${pass ? 'O' : 'X'}  ${no}. ${name}${detail ? `\n      ${detail}` : ''}`);
}

const store = await import(path.join(LIB, 'store.mjs'));
const { crawlPaths } = await import(path.join(LIB, 'paths.mjs'));
const { discover, classifyKind, proposeProfile } = await import(path.join(LIB, 'discover.mjs'));

const fx = spawn(process.execPath, [path.join(HERE, '..', 'fixtures', 'server.mjs')], { stdio: ['ignore', 'pipe', 'pipe'] });
const BASE = await new Promise((res) => fx.stdout.once('data', (d) => res(String(d).trim())));
// 두 번째 자리 — 같은 크롤에서 origin 이 섞였을 때 서로를 밀어내지 않는지 보기 위해서다
const fx2 = spawn(process.execPath, [path.join(HERE, '..', 'fixtures', 'server.mjs')], { stdio: ['ignore', 'pipe', 'pipe'] });
const BASE2 = await new Promise((res) => fx2.stdout.once('data', (d) => res(String(d).trim())));
console.log(`샌드박스: ${SANDBOX}\nfixture: ${BASE}\nfixture2: ${BASE2}\n`);
process.on('exit', () => {
  try { fx.kill(); } catch {}
  try { fx2.kill(); } catch {}
  if (process.env.KEEP_SANDBOX !== '1') { try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch {} }
});

// discover 는 pace 에 막히면 기다리지 않고 즉시 돌려준다. 그러니 한 번 부른 결과는
// "지금까지"이지 "전부"가 아니다. 그걸 최종으로 채점하면 빠른 기계에서만 우연히 맞는
// 시험이 된다(2026-08-11 매니저 재현: d1 이 small=0 인 채로 통과 판정).
// 그래서 결과를 보는 모든 자리는 반드시 이 helper 로 끝까지 몰아붙인 뒤 채점한다.
const MIN_INTERVAL = Number(process.env.GATE3_MIN_INTERVAL || 40);
const POLICY = { mode: 'pilot', min_interval_ms: MIN_INTERVAL, interval_jitter_ms: 10, daily_cap: 900, lease_ttl_ms: 300_000 };
// 사이트맵을 많이 도는 시험용 — 그래도 느린 모드에서는 같이 느려져야 계약이 검증된다
const FAST = { ...POLICY, min_interval_ms: process.env.GATE3_MIN_INTERVAL ? MIN_INTERVAL : 5, interval_jitter_ms: 0, daily_cap: 5000 };
const MAX_ROUNDS = 600;

/** done 이나 멈춤(paused_incomplete) 같은 최종 상태까지 같은 회차를 이어 부른다. */
async function settle(crawl, opts = {}, label = crawl) {
  let r = null, rounds = 0, deferrals = 0;
  for (; rounds < MAX_ROUNDS; rounds++) {
    // refresh 는 새 회차를 여는 첫 호출에만 뜻이 있다. 진행 중에 또 주면 안 된다.
    r = await discover(crawl, { ...opts, refresh: rounds === 0 ? !!opts.refresh : false });
    if (!r.deferred) return Object.assign(r, { rounds: rounds + 1, deferrals });
    deferrals++;
    await new Promise((res) => setTimeout(res, ((r.wait_seconds || 1) * 1000) + 50));
  }
  throw new Error(`${label}: ${MAX_ROUNDS}회 안에 끝나지 않았습니다 (마지막 사유 ${r?.why}, 단계 ${r?.stage})`);
}

async function runDiscover(crawl, opts = {}) {
  store.createCrawl(crawl, { seeds: [], policy: POLICY });
  return settle(crawl, { origin: BASE, worker: 'gate3', ...opts }, crawl);
}

// ---------- G1. 138 · 11 개수 계약 (로컬 fixture) ----------
let d1;
{
  d1 = await runDiscover('g3a');
  const fromA = d1.per_sitemap[`${BASE}/sitemap-a.xml`] ?? 0;
  const fromSmall = d1.per_sitemap[`${BASE}/sitemap-small.xml`] ?? 0;
  check('G1', '사이트맵 항목 수 계약 — 138개 판과 11개 판을 그대로 읽는다(로컬 fixture, 외부 재검증 아님)',
    fromA === 138 && fromSmall === 11,
    `sitemap-a=${fromA}(기대 138) · sitemap-small=${fromSmall}(기대 11) · 총 발견 ${d1.found}건`);
}

// ---------- G2. 사이트맵 인덱스 중첩·순환 ----------
{
  const visited = d1.sitemaps_visited || [];
  const loopSeen = visited.includes(`${BASE}/sitemap-loop.xml`);
  const onceEach = new Set(visited).size === visited.length;
  check('G2', '사이트맵 인덱스를 따라가되 순환에 빠지지 않는다(같은 사이트맵을 두 번 읽지 않음)',
    loopSeen && onceEach && !d1.aborted,
    `방문 ${visited.length}개: ${visited.map((v) => v.replace(BASE, '')).join(', ')} · 중복없음=${onceEach}`);
}

// ---------- G3. robots 의 Sitemap 여러 줄 ----------
{
  const declared = d1.robots_sitemaps || [];
  check('G3', 'robots.txt 에 Sitemap 이 여럿이면 전부 수집한다',
    declared.length === 2
    && declared.includes(`${BASE}/sitemap-a.xml`) && declared.includes(`${BASE}/sitemap-index.xml`),
    `robots 선언 ${declared.length}개: ${declared.map((v) => v.replace(BASE, '')).join(', ')}`);
}

// ---------- G4. 상대 주소·중복·추적 파라미터 정규화 ----------
{
  const st = store.loadState('g3a');
  const urls = Object.values(st.urls).map((u) => u.url);
  const rel = urls.filter((u) => u.endsWith('/rel/one'));
  const dup = urls.filter((u) => u.replace(/\?.*/, '').endsWith('/dup'));
  check('G4', '상대 주소가 절대로 풀리고, 추적 파라미터만 다른 주소는 하나로 합쳐진다',
    rel.length === 1 && rel[0].startsWith('http') && dup.length === 1 && !dup[0].includes('utm_source'),
    `상대→절대: ${rel[0] || '없음'} · /dup 등록 수: ${dup.length}(${dup[0] || '-'})`);
}

// ---------- G5. 사이트맵 밖 내부 링크도 별도 경로로 발견 ----------
{
  const st = store.loadState('g3a');
  const hidden = Object.values(st.urls).find((u) => u.url.endsWith('/hidden-only-linked'));
  const viaLink = hidden && (hidden.discovered_by || []).some((d) => String(d).startsWith('link'));
  const viaSitemapToo = Object.values(st.urls).find((u) => u.url.endsWith('/p/5'));
  const smTag = viaSitemapToo && (viaSitemapToo.discovered_by || []).some((d) => String(d).startsWith('sitemap'));
  check('G5', '사이트맵에 없는 내부 링크도 발견되고, 발견 경로가 구분되어 남는다',
    !!hidden && viaLink && smTag,
    `링크로만 닿는 쪽 발견=${!!hidden} discovered_by=[${hidden?.discovered_by}] · 사이트맵 항목 태그=[${viaSitemapToo?.discovered_by}]`);
}

// ---------- G6. lastmod — 실제로 changed 를 만들어 재방문 후보가 그 하나인지 본다 ----------
{
  const { normalizeUrl } = await import(path.join(LIB, 'url.mjs'));
  const first = d1.lastmod_summary;

  // 2차: 아무것도 안 바꾸면 전부 unchanged, 재방문 후보 0
  const r2 = await settle('g3a', { origin: BASE, worker: 'gate3', refresh: true });
  const s2 = r2.lastmod_summary;

  // 3차: /p/7 의 lastmod 만 바꾼다 — changed 가 정확히 하나여야 한다
  await fetch(`${BASE}/sitemap-ctl?bump=1`).then((x) => x.text());
  const r3 = await settle('g3a', { origin: BASE, worker: 'gate3', refresh: true });
  const s3 = r3.lastmod_summary;
  const target = normalizeUrl(`${BASE}/p/7`).id;
  const exactlyThatOne = r3.revisit_candidates === 1 && r3.revisit_ids?.length === 1 && r3.revisit_ids[0] === target;

  check('G6', 'lastmod 가 바뀐 한 건만 changed·재방문 후보가 되고, 나머지는 unchanged 다',
    first.new > 0
    && s2.new === 0 && s2.changed === 0 && s2.unchanged > 0 && r2.revisit_candidates === 0
    && s3.changed === 1 && s3.new === 0 && exactlyThatOne && s3.unchanged === s2.unchanged - 1,
    `1차 new=${first.new} / 2차 new=${s2.new} changed=${s2.changed} unchanged=${s2.unchanged} 후보=${r2.revisit_candidates} / `
    + `3차 changed=${s3.changed} unchanged=${s3.unchanged} 후보=${r3.revisit_candidates} 후보id=${(r3.revisit_ids || []).join(',')} (기대 ${target})`);
}

// ---------- G6b. 사이트맵에서 사라져도 지우지 않고 표시만 남긴다 ----------
{
  const { normalizeUrl } = await import(path.join(LIB, 'url.mjs'));
  const goneId = normalizeUrl(`${BASE}/p/9`).id;
  const beforeHas = !!store.loadState('g3a').urls[goneId];

  await fetch(`${BASE}/sitemap-ctl?hide=1`).then((x) => x.text());
  const r4 = await settle('g3a', { origin: BASE, worker: 'gate3', refresh: true });

  const st = store.loadState('g3a');
  const stillThere = !!st.urls[goneId];
  const marked = st.urls[goneId]?.missing_from_latest_snapshot === true;
  const logged = fs.existsSync(path.join(SANDBOX, '.claude/web-search/g3a/disappeared.jsonl'));

  check('G6b', '사이트맵에서 사라진 항목을 삭제하지 않고 missing_from_latest_snapshot 로 표시만 한다',
    beforeHas && stillThere && marked && r4.disappeared_marked >= 1 && (r4.deleted ?? 0) === 0 && logged,
    `이전 등록=${beforeHas} · 지금도 있음=${stillThere} · 표시=${marked} · 사라짐 ${r4.disappeared_marked}건 · 삭제 ${r4.deleted ?? 0}건 · 기록파일=${logged}`);
  await fetch(`${BASE}/sitemap-ctl?reset=1`).then((x) => x.text());
}

// ---------- G7. 같은 내용이 쿼리로 늘어나면 표시만, 기능성 파라미터는 안 합친다 ----------
{
  const { normalizeUrl } = await import(path.join(LIB, 'url.mjs'));
  const three = [`${BASE}/same-content`, `${BASE}/same-content?sort=new`, `${BASE}/same-content?sort=old`];
  // 먼저 확인 — sort 는 추적 파라미터가 아니므로 정규화 단계에서 합쳐지면 안 된다.
  // (합쳐지면 아래 "내용 지문" 비교가 아예 성립하지 않는다.)
  const ids = three.map((u) => normalizeUrl(u).id);
  const distinctBeforeCompare = new Set(ids).size === 3;

  const r = await runDiscover('g3b', { extraSeeds: [...three,
    `${BASE}/goods?goodsNo=100`, `${BASE}/goods?goodsNo=200`,
  ], skipSitemaps: true, fetchSeeds: true });
  const st = store.loadState('g3b');
  const same = Object.values(st.urls).filter((u) => u.url.includes('/same-content'));
  const flaggedDup = same.filter((u) => u.suspected_duplicate_of);
  const stillThere = same.length === 3;                       // 자동 폐기·합침이 없어야
  const goods = Object.values(st.urls).filter((u) => u.url.includes('/goods'));
  const goodsDistinct = goods.length === 2 && new Set(goods.map((g) => g.url)).size === 2;
  const goodsNotMerged = !goods.some((g) => g.suspected_duplicate_of);
  check('G7', 'sort 쿼리는 정규화에서 안 합쳐지고, 같은 내용은 표시만(폐기 없음), 기능성 파라미터 상품은 서로 다른 것으로 남는다',
    distinctBeforeCompare && stillThere && flaggedDup.length >= 1 && goodsDistinct && goodsNotMerged,
    `정규화 후 세 주소가 서로 다름=${distinctBeforeCompare} · same-content 등록 ${same.length}건(의심표시 ${flaggedDup.length}, 폐기 0) · `
    + `goods ${goods.length}건 서로다름=${goodsDistinct} 의심표시=${goods.filter((g) => g.suspected_duplicate_of).length}건`);
}

// ---------- G8. 302 는 최종 주소만이 아니라 실제 내용까지 봐야 통과 ----------
{
  const r = await runDiscover('g3c', { extraSeeds: [`${BASE}/redir-ok`, `${BASE}/redir-bad`], skipSitemaps: true, fetchSeeds: true });
  const ok = r.fetched?.find((x) => x.requested.endsWith('/redir-ok'));
  const bad = r.fetched?.find((x) => x.requested.endsWith('/redir-bad'));
  check('G8', '302 는 최종 주소가 아니라 최종 "내용"으로 가른다 — 정상 도착과 오류 도착이 갈린다',
    ok && bad && ok.final.endsWith('/redir-ok-final') && bad.final.endsWith('/redir-bad-final')
    && ok.page_validity !== 'invalid' && bad.page_validity === 'invalid',
    `정상: ${ok?.final?.replace(BASE, '')} → ${ok?.page_validity} (카드 ${ok?.cards}) / `
    + `오류: ${bad?.final?.replace(BASE, '')} → ${bad?.page_validity} 부정=[${bad?.negatives}]`);
}

// ---------- G9. discover 는 lease 를 거치고, stale 이면 네트워크 0회 ----------
{
  store.createCrawl('g3d', { seeds: [], policy: POLICY });
  // 실제로 가져올 대상을 줘야 임대 검사 자리에 도달한다(주지 않으면 아무것도 안 부르고 0건이 된다).
  const r = await discover('g3d', {
    origin: BASE, worker: 'g',
    extraSeeds: [`${BASE}/listing-jsonld`, `${BASE}/listing-plain`],
    forceLeaseToken: 'not-a-real-token', skipSitemaps: true, fetchSeeds: true,
  });
  // 임대 전이면 not_leased 로, 임대됐는데 토큰이 다르면 stale_lease_token 으로 막힌다.
  // 둘 다 "네트워크 0회" 계약을 지켜야 하므로 두 경우를 모두 본다.
  store.createCrawl('g3e', { seeds: [`${BASE}/listing-jsonld`], policy: POLICY });
  store.lease('g3e', 5, 'g');                       // 이번엔 실제로 임대해 둔다
  const r2 = await discover('g3e', {
    origin: BASE, worker: 'g',
    extraSeeds: [`${BASE}/listing-jsonld`],
    forceLeaseToken: 'not-a-real-token', skipSitemaps: true, fetchSeeds: true,
  });
  const reasons = [...(r.refuse_reasons || []), ...(r2.refuse_reasons || [])];
  const sawNotLeased = reasons.some((x) => String(x).startsWith('not_leased'));
  const sawStale = reasons.some((x) => x === 'stale_lease_token');

  check('G9', 'discover 도 임대를 거친다 — 임대 전이든 토큰이 틀렸든 네트워크 0회로 거절',
    r.network_calls === 0 && r2.network_calls === 0
    && (r.refused || 0) >= 2 && (r2.refused || 0) >= 1 && sawNotLeased && sawStale,
    `임대 전: 네트워크 ${r.network_calls}회 거절 ${r.refused}건 / 임대 후 틀린 토큰: 네트워크 ${r2.network_calls}회 거절 ${r2.refused}건\n`
    + `      사유 [${reasons.join(', ')}]`);
}

// ---------- G10. kind·domain-profile 은 proposed 로만, 확신 없으면 unknown ----------
{
  const k1 = classifyKind(`${BASE}/listing-jsonld`, { title: '청첩장 목록', cards: 12 });
  const k2 = classifyKind(`${BASE}/products/p3`, { title: '디자인 3', cards: 0 });
  const k3 = classifyKind(`${BASE}/notice/1`, { title: '공지', cards: 0 });
  const prof = proposeProfile('g3a', 'example.test', { listingSamples: [`${BASE}/listing-jsonld`], cards: 12, signature: 'div.grid>article.card|n=12' });
  const st = fs.existsSync(prof.file) ? JSON.parse(fs.readFileSync(prof.file, 'utf8')) : {};
  check('G10', 'kind 는 증거와 함께 proposed 로만 붙고, 애매하면 unknown/needs_review 로 남는다',
    k1.kind === 'listing' && k1.status === 'proposed' && Array.isArray(k1.evidence) && k1.evidence.length > 0
    && k2.kind === 'detail' && k3.kind === 'unknown' && k3.status === 'needs_review'
    && st.status === 'proposed',
    `목록=${k1.kind}/${k1.status} 증거=[${k1.evidence}] · 상세=${k2.kind} · 애매=${k3.kind}/${k3.status} · 프로필 status=${st.status}`);
}

// ---------- G10b. 프로필 전이는 명시 호출로만, 자동 발견이 사람의 판단을 못 덮는다 ----------
{
  const { confirmProfile, overrideProfile, readProfile } = await import(path.join(LIB, 'discover.mjs'));
  const dom = 'example.test';

  const c = confirmProfile('g3a', dom, { who: 'manager1', reason: '카드 묶음 확인함' });
  const afterConfirm = readProfile('g3a', dom);

  // [음성] 자동 발견이 다시 제안해도 confirmed 를 proposed 로 되돌리면 안 된다
  proposeProfile('g3a', dom, { listingSamples: [`${BASE}/listing-plain`], cards: 99, signature: 'other' });
  const stillConfirmed = readProfile('g3a', dom).status === 'confirmed';

  const o = overrideProfile('g3a', dom, { selectors: { card: 'div.grid > article' }, who: 'manager1', reason: '가상 스크롤이라 직접 지정' });
  const afterOverride = readProfile('g3a', dom);

  // [음성] override 도 자동이 못 덮는다
  proposeProfile('g3a', dom, { listingSamples: [`${BASE}/listing-two`], cards: 2 });
  const stillOverride = readProfile('g3a', dom).status === 'manual_override';

  const h = afterOverride.history || [];
  const hasWhoAt = h.every((x) => x.who && x.at_iso && x.from && x.to);
  const transitions = h.map((x) => `${x.from}→${x.to}`);
  const hasBoth = transitions.includes('proposed→confirmed') && transitions.includes('confirmed→manual_override');
  const reasonKept = h.some((x) => x.reason === '카드 묶음 확인함') && h.some((x) => x.reason === '가상 스크롤이라 직접 지정');

  check('G10b', '프로필 전이는 명시 호출로만 — proposed→confirmed→manual_override 가 who/at/reason 과 함께 남고, 자동 발견이 덮지 못한다',
    c.from === 'proposed' && afterConfirm.status === 'confirmed' && stillConfirmed
    && o.from === 'confirmed' && afterOverride.status === 'manual_override' && stillOverride
    && hasWhoAt && hasBoth && reasonKept && !!afterOverride.manual_selectors,
    `전이: ${transitions.join(' · ')} / 자동 재제안 뒤에도 confirmed 유지=${stillConfirmed}, override 유지=${stillOverride} / who·at 완비=${hasWhoAt} · 사유 보존=${reasonKept}`);
}

// ---------- G11. MCP 왕복 — 첫 호출은 반드시 미완, 같은 호출로 이어 부르면 완주 ----------
{
  const server = path.join(HERE, '..', 'server.mjs');
  const p = spawn(process.execPath, [server], { env: { ...process.env, CLAUDE_PROJECT_DIR: SANDBOX }, stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '';
  const waiters = new Map();
  p.stdout.on('data', (d) => {
    buf += d;
    const lines = buf.split('\n'); buf = lines.pop();
    for (const l of lines) {
      if (!l.trim()) continue;
      let m; try { m = JSON.parse(l); } catch { continue; }
      const w = waiters.get(m.id); if (w) { waiters.delete(m.id); w(m); }
    }
  });
  let seq = 0;
  const rpc = (method, params) => new Promise((res) => {
    const id = ++seq;
    waiters.set(id, res);
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const textOf = (m) => String(m?.result?.content?.[0]?.text || '');

  await rpc('initialize', {});
  const list = await rpc('tools/list');
  const names = (list?.result?.tools || []).map((t) => t.name);
  // 간격을 크게 줘서 첫 호출이 반드시 pace 에 막히게 한다(시계에 기대지 않는 결정적 조건)
  await rpc('tools/call', { name: 'crawl_new', arguments: { crawl: 'g3mcp', seeds: [], policy: { min_interval_ms: 2500, interval_jitter_ms: 0 } } });
  const first = textOf(await rpc('tools/call', { name: 'discover', arguments: { crawl: 'g3mcp', origin: BASE } }));

  let last = first, rounds = 1;
  for (let i = 0; i < 60 && last.includes('아직 안 끝났습니다'); i++) {
    const m = last.match(/—\s*(\d+)초/);
    await new Promise((res) => setTimeout(res, ((Number(m?.[1]) || 1) * 1000) + 80));
    last = textOf(await rpc('tools/call', { name: 'discover', arguments: { crawl: 'g3mcp', origin: BASE } }));
    rounds++;
  }
  try { p.stdin.end(); p.kill(); } catch {}

  const firstIsDeferred = first.includes('아직 안 끝났습니다') && first.includes('이어 부르세요');
  const firstHasNoFakeReport = !first.includes('보고서') && !first.includes('undefined');
  const finalHasReport = /발견\s*\d+/.test(last) && /보고서 \S+\.json/.test(last) && !last.includes('undefined');
  const short = last.length < 700 && !last.includes('<loc>') && !last.includes('<html');
  check('G11', 'MCP discover — 미완이면 남은 일만, 완주하면 개수와 보고서 경로만 (undefined 를 지어내지 않는다)',
    names.includes('discover') && firstIsDeferred && firstHasNoFakeReport && finalHasReport && short && rounds >= 2,
    `1차: ${first.split('\n')[0]}\n      ${rounds}회 만에 완주 · 최종 ${last.length}자 · 보고서 경로 있음=${finalHasReport} · 1차에 가짜 경로 없음=${firstHasNoFakeReport}`);
}

// ---------- G12. 형제 사이트맵 90개를 다 처리한다(형제 수를 깊이로 세지 않는다) ----------
{
  store.createCrawl('g3wide2', { seeds: [], policy: FAST });
  const w = await settle('g3wide2', { origin: BASE, worker: 'wide', sitemapSeeds: [`${BASE}/sitemap-wide.xml`], skipSitemaps: true }, 'G12');
  // "등록됐다"가 아니라 "처리했다"의 증거: 인덱스 1장 + 하위 90장을 각각 한 번씩 방문하고,
  // 그 결과인 /w/N 주소 90개가 장부에 들어와야 한다.
  const visited = w.sitemaps_visited || [];
  const indexOnce = visited.filter((u) => u.endsWith('/sitemap-wide.xml')).length === 1;
  const childHits = visited.filter((u) => /\/sitemap-w\/\d+\.xml$/.test(u));
  const childOnceEach = new Set(childHits).size === 90 && childHits.length === 90;
  const st = store.loadState('g3wide2');
  const leaves = new Set(Object.values(st.urls).filter((u) => /\/w\/\d+$/.test(u.url)).map((u) => u.url));
  check('G12', '형제 사이트맵 90장을 전부 처리한다(형제 수를 가지 깊이로 세지 않는다)',
    indexOnce && childOnceEach && leaves.size === 90 && !w.depth_exceeded?.length && w.done === true && !w.aborted,
    `인덱스 1회=${indexOnce} · 하위 사이트맵 방문 ${childHits.length}장(고유 ${new Set(childHits).size}/90) · `
    + `말단 주소 ${leaves.size}/90 · 깊이초과 ${w.depth_exceeded?.length ?? 0}건 · aborted=${w.aborted}`);
}

// ---------- G13. pace 에 막히면 기다리지 않고 돌려주고, 다시 부르면 이어간다 ----------
{
  // 간격을 크게 줘서 첫 호출이 반드시 막히게 한다
  store.createCrawl('g3resume', { seeds: [], policy: { ...POLICY, min_interval_ms: 2500, interval_jitter_ms: 0 } });
  const t0 = Date.now();
  const r1 = await discover('g3resume', { origin: BASE, worker: 'res' });
  const firstElapsed = Date.now() - t0;
  const stoppedFast = r1.deferred === true && firstElapsed < 2500;   // 안에서 자지 않았다

  const r2 = await settle('g3resume', { origin: BASE, worker: 'res' }, 'G13');
  const rounds = 1 + r2.rounds;
  // 이미 읽은 사이트맵을 다시 읽지 않아야 한다 — 방문 목록에 중복이 없어야
  const visited = r2?.sitemaps_visited || [];
  const noRepeat = new Set(visited).size === visited.length;

  check('G13', 'pace 에 막히면 안에서 자지 않고 즉시 돌려주며, 다시 부르면 끝낸 자리부터 잇는다',
    stoppedFast && r1.wait_seconds > 0 && r1.stage && r2?.done === true && noRepeat && visited.length >= 3,
    `1차 ${firstElapsed}ms 만에 deferred(${r1.why}, 남은 ${r1.wait_seconds}초, 단계 ${r1.stage}) · `
    + `${rounds}회 만에 완주 · 사이트맵 ${visited.length}개 방문(중복 없음=${noRepeat})`);
}

// ---------- G14. 처리한 주소가 leased 로 묶여 남지 않는다 ----------
{
  const st = store.loadState('g3a');
  const stuck = Object.values(st.urls).filter((u) => u.state === 'leased');
  const fetched = Object.values(st.urls).filter((u) => ['fetched', 'invalid', 'content_validated', 'needs_visual_review'].includes(u.state));
  check('G14', 'discover 가 가져온 주소는 report 로 마무리돼 leased 로 묶이지 않는다',
    stuck.length === 0 && fetched.length >= 3,
    `leased 로 남은 것 ${stuck.length}건 · 마무리된 것 ${fetched.length}건`);
}

// ---------- G15. 프로필 전이는 who·reason 없이는 거절된다 ----------
{
  const { confirmProfile, overrideProfile } = await import(path.join(LIB, 'discover.mjs'));
  proposeProfile('g3a', 'prov.test', { listingSamples: [`${BASE}/listing-jsonld`], cards: 12 });
  const tries = [];
  const t = (fn) => { try { fn(); tries.push('통과됨(잘못)'); } catch (e) { tries.push(e.message.slice(0, 24)); } };
  t(() => confirmProfile('g3a', 'prov.test', {}));                                   // who·reason 없음
  t(() => confirmProfile('g3a', 'prov.test', { who: 'a' }));                          // reason 없음
  t(() => overrideProfile('g3a', 'prov.test', { who: 'a', reason: 'b' }));            // selectors 없음
  t(() => overrideProfile('g3a', 'prov.test', { selectors: {}, who: 'a', reason: 'b' })); // 빈 selectors
  const allRejected = tries.every((x) => !x.startsWith('통과됨'));
  // 제대로 주면 통과해야 한다(과잉 차단 방지)
  let okPath = false;
  try { confirmProfile('g3a', 'prov.test', { who: 'manager1', reason: '확인함' }); okPath = true; } catch {}
  check('G15', '프로필 전이는 who·reason(override 는 selectors 까지) 없이는 거절된다',
    allRejected && okPath,
    `거절 4종: ${tries.join(' / ')} · 제대로 주면 통과=${okPath}`);
}

// ---------- G16. 가지 깊이를 넘으면 조용히 자르지 않고 멈춘다(스냅샷 불변·진행 보존·재개 가능) ----------
{
  const crypto = await import('node:crypto');
  const dirOf = (c) => path.join(SANDBOX, '.claude/web-search', c);
  const okey = crypto.createHash('sha256').update(BASE).digest('hex').slice(0, 12);
  const snapPath = path.join(dirOf('g3deep'), `lastmod-snapshot-${okey}.json`);
  const progPath = path.join(dirOf('g3deep'), `discover-progress-${okey}.json`);
  const sha = (f) => (fs.existsSync(f) ? crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex').slice(0, 12) : '없음');

  const run = (opts) => settle('g3deep',
    { origin: BASE, worker: 'deep', skipSitemaps: true, refresh: true, ...opts }, 'G16');

  store.createCrawl('g3deep', { seeds: [], policy: FAST });
  // 1) 먼저 얕은 사이트맵으로 한 번 완주해 기준 스냅샷을 만든다
  const base1 = await run({ sitemapSeeds: [`${BASE}/sitemap-small.xml`] });
  const snapBefore = sha(snapPath);

  // 2) 7단 중첩 가지 — 기본 경계(4)를 넘는다. 여기서 멈춰야 한다.
  const paused = await run({ sitemapSeeds: [`${BASE}/sitemap-deep/0.xml`] });
  const snapAfterPause = sha(snapPath);
  const progKept = fs.existsSync(progPath);
  const pausedRight = paused.done !== true && paused.aborted === true
    && paused.completion === 'paused_incomplete'
    && (paused.needs_boundary_review || []).length >= 1
    && paused.offending?.depth === 5 && paused.queue_left >= 1;

  // 3) 경계를 넓히면 멈춘 자리에서 이어 달려 완주한다
  store.updatePolicy('g3deep', { sitemap_depth_max: 12 }, { who: 'gate3', reason: '경계 확인 뒤 가지 깊이를 넓힌다' });
  const resumed = await run({ sitemapSeeds: [`${BASE}/sitemap-deep/0.xml`] });
  const st = store.loadState('g3deep');
  const deepLeaves = Object.values(st.urls).filter((u) => /\/deep\/(a|b)$/.test(u.url));

  check('G16', '가지 깊이를 넘으면 needs_boundary_review 로 멈춘다 — 스냅샷 불변·진행 보존, 경계를 넓히면 이어서 완주',
    base1.done === true && snapBefore !== '없음'
    && pausedRight && snapAfterPause === snapBefore && progKept
    && resumed.done === true && !resumed.aborted && deepLeaves.length === 2,
    `기준 완주=${base1.done} · 멈춤(aborted=${paused.aborted} completion=${paused.completion} 깊이 ${paused.offending?.depth} 남은큐 ${paused.queue_left}) · `
    + `스냅샷 ${snapBefore}→${snapAfterPause}(불변=${snapAfterPause === snapBefore}) · 진행파일 보존=${progKept} · `
    + `경계 넓힌 뒤 완주=${resumed.done} 말단 ${deepLeaves.length}/2`);
}

// ---------- G17. 남의 임대를 훔치지 않는다 — 경합해도 네트워크는 한 번 ----------
{
  const { normalizeUrl } = await import(path.join(LIB, 'url.mjs'));

  // (가) 다른 워커가 이미 잡고 있는 주소 — 건드리지 않고 물러나야 한다
  store.createCrawl('g3lease', { seeds: [], policy: FAST });
  const robotsId = normalizeUrl(`${BASE}/robots.txt`).id;
  store.addUrls('g3lease', [{ url: `${BASE}/robots.txt`, kind: 'unknown', via: 'manual', discovered_by: 'test' }]);
  const held = store.leaseUrl('g3lease', robotsId, 'other-worker');
  const r = await discover('g3lease', { origin: BASE, worker: 'me' });
  const after = store.loadState('g3lease').urls[robotsId];
  const notStolen = after.state === 'leased' && after.lease?.token === held.lease_token && after.lease?.worker === 'other-worker';
  const backedOff = r.deferred === true && String(r.why).startsWith('already_leased') && r.network_calls === 0;

  // (나) 워커 이름이 **같아도** 동시 호출은 실행권으로 갈린다 — 이름은 신원이 아니다
  const hitsOf = async () => JSON.parse(await (await fetch(`${BASE}/hits`)).text());
  const SM = '/sitemap-small.xml';
  store.createCrawl('g3race', { seeds: [], policy: FAST });
  const h0 = await hitsOf();
  const args = { origin: BASE, worker: 'same-name', sitemapSeeds: [`${BASE}${SM}`], skipSitemaps: true };
  const [a, b] = await Promise.all([discover('g3race', args), discover('g3race', args)]);
  // 실행권을 못 잡은 쪽은 정확히 하나여야 한다(pace 가 느리면 잡은 쪽도 첫 호출엔 못 끝낸다)
  const loser = [a, b].find((x) => x.deferred === true && x.why === 'already_running');
  const others = [a, b].filter((x) => x !== loser);
  const winner = others.find((x) => x.done === true) || await settle('g3race', args, 'G17');
  const h1 = await hitsOf();
  const smDelta1 = (h1[SM] || 0) - (h0[SM] || 0);
  const splitRight = !!winner && !!loser && others.length === 1 && winner.done === true;

  // (다) 물러난 쪽이 안내대로 같은 호출을 다시 해도 다시 훑지 않는다
  const again = await discover('g3race', args);
  const h2 = await hitsOf();
  const smDelta2 = (h2[SM] || 0) - (h1[SM] || 0);
  const reusedRight = again.reused_finished_run === true && again.network_calls === 0
    && again.report === winner?.report && smDelta2 === 0;

  // (라) 명시로 요청해야만 새 회차가 열린다
  const fresh = await settle('g3race', { ...args, refresh: true }, 'G17-refresh');
  const smDelta3 = ((await hitsOf())[SM] || 0) - (h2[SM] || 0);
  const refreshWorks = fresh.done === true && !fresh.reused_finished_run && smDelta3 === 1;

  check('G17', '워커 이름이 같아도 실행권이 가른다 — 네트워크 1회, 물러난 쪽이 다시 불러도 다시 훑지 않는다',
    notStolen && backedOff && smDelta1 === 1 && splitRight && reusedRight && refreshWorks,
    `(가) 남의 토큰 유지=${notStolen} · 물러남=${backedOff}(${r.why}, 네트워크 ${r.network_calls}회)\n`
    + `      (나) 같은 이름 동시 2개 → 서버가 받은 요청 ${smDelta1}회 · 실행권 못 잡은 쪽 ${loser ? 1 : 0}개(${loser?.why}) · 잡은 쪽 완주=${winner?.done}\n`
    + `      (다) 재호출: 네트워크 ${again.network_calls}회 · 서버 요청 ${smDelta2}회 · 끝난 회차 재사용=${again.reused_finished_run} · 같은 보고서=${again.report === winner?.report}\n`
    + `      (라) refresh 로만 새 회차: 서버 요청 ${smDelta3}회 · 완주=${fresh.done}`);
}

// ---------- G19. 실행권을 쥔 채 죽어도 다음 호출이 회수해 이어 달린다 ----------
{
  const hitsOf = async () => JSON.parse(await (await fetch(`${BASE}/hits`)).text());
  const SMALL = '/sitemap-small.xml', SLOW = '/sitemap-slow.xml';
  const lockDir = path.join(SANDBOX, '.claude/web-search/g3kill/locks');

  // 자식도 pace 에 막히면 즉시 돌려받으므로 한 번만 부르면 아무것도 안 하고 끝난다.
  // 죽일 순간(느린 사이트맵을 물고 있는 때)까지 가려면 자식도 이어 불러야 한다.
  const code = `
    const { discover } = await import(${JSON.stringify(path.join(LIB, 'discover.mjs'))});
    const store = await import(${JSON.stringify(path.join(LIB, 'store.mjs'))});
    const BASE = process.argv[1];
    store.createCrawl('g3kill', { seeds: [], policy: ${JSON.stringify(FAST)} });
    for (let i = 0; i < 600; i++) {
      const r = await discover('g3kill', { origin: BASE, worker: 'child', skipSitemaps: true,
        sitemapSeeds: [BASE + '${SMALL}', BASE + '${SLOW}'] });
      if (!r.deferred) break;
      await new Promise((res) => setTimeout(res, ((r.wait_seconds || 1) * 1000) + 50));
    }
  `;
  const h0 = await hitsOf();
  const child = spawn(process.execPath, ['--input-type=module', '-e', code, BASE],
    { env: { ...process.env, CLAUDE_PROJECT_DIR: SANDBOX }, stdio: ['ignore', 'pipe', 'pipe'] });
  // close 청취는 spawn 직후에 건다. 죽인 뒤에 걸면 이미 끝난 자식의 신호를 놓쳐 영영 기다린다.
  let exited = false;
  const closed = new Promise((res) => child.once('close', (c, s) => { exited = true; res(s || c); }));
  let childErr = '';
  child.stderr.on('data', (d) => { childErr += d; });

  // 느린 사이트맵을 물고 있는 순간을 노린다(빠른 것 하나는 이미 끝낸 상태)
  let armed = false, earlyExit = false;
  for (let i = 0; i < 2000; i++) {
    const h = await hitsOf();
    if ((h[SMALL] || 0) > (h0[SMALL] || 0) && (h[SLOW] || 0) > (h0[SLOW] || 0)) { armed = true; break; }
    if (exited) { earlyExit = true; break; }        // 매달리지 않고 근거를 남기고 진다
    await new Promise((res) => setTimeout(res, 50));
  }
  if (!exited) child.kill('SIGKILL');
  const sig = await closed;
  const lockLeftBehind = fs.existsSync(path.join(lockDir, 'discover-' +
    (await import('node:crypto')).createHash('sha256').update(BASE).digest('hex').slice(0, 12) + '.lock'));

  // 새 호출이 죽은 주인의 실행권을 회수하고 끝낸 자리부터 잇는다
  const rr = await settle('g3kill', { origin: BASE, worker: 'parent', skipSitemaps: true,
    sitemapSeeds: [`${BASE}${SMALL}`, `${BASE}${SLOW}`] }, 'G19');
  const h2 = await hitsOf();
  const smallHits = (h2[SMALL] || 0) - (h0[SMALL] || 0);
  const slowHits = (h2[SLOW] || 0) - (h0[SLOW] || 0);
  const st = store.loadState('g3kill');
  const stuck = Object.values(st.urls).filter((u) => u.state === 'leased');
  // 걷어 간 잠금 자체가 남아 있어야 한다(기록 파일만 있는 건 증거가 아니다)
  const staleKept = fs.existsSync(path.join(lockDir, 'stale'))
    && fs.readdirSync(path.join(lockDir, 'stale')).some((f) => f.startsWith('discover-'));

  check('G19', '실행권을 쥔 채 SIGKILL 돼도 다음 호출이 회수해 잇는다 — 끝낸 사이트맵은 다시 두드리지 않는다',
    armed && !earlyExit && String(sig) === 'SIGKILL' && lockLeftBehind
    && rr?.done === true && smallHits === 1 && slowHits === 2 && stuck.length === 0 && staleKept,
    `자식이 느린 사이트맵을 물고 있을 때 SIGKILL=${armed}(${sig})`
    + `${earlyExit ? ` · 자식이 먼저 끝남(early_exit) ${childErr.split('\n')[0] || ''}` : ''} · 죽은 잠금 남음=${lockLeftBehind}\n`
    + `      회수 후 완주=${rr?.done} · 서버가 받은 요청: 끝낸 것 ${smallHits}회(재요청 없음) · 죽던 것 ${slowHits}회(죽은 1 + 재시도 1)\n`
    + `      남은 임대 ${stuck.length}건 · 죽은 잠금 보존=${staleKept}`);
}

// ---------- G18. 같은 주소를 두 번 세지 않고, 다시 나타나면 사라짐 표시를 푼다 ----------
{
  const { normalizeUrl } = await import(path.join(LIB, 'url.mjs'));
  const dupId = normalizeUrl(`${BASE}/dup`).id;
  const bumpedId = normalizeUrl(`${BASE}/p/7`).id;
  const goneId = normalizeUrl(`${BASE}/p/9`).id;

  // G6b 에서 숨겼다 되돌려 놓은 상태다. 다시 완주하면 표시가 풀려야 한다.
  const r = await settle('g3a', { origin: BASE, worker: 'gate3', refresh: true });
  const st = store.loadState('g3a');
  const okey18 = (await import('node:crypto')).createHash('sha256').update(BASE).digest('hex').slice(0, 12);
  const snap = JSON.parse(fs.readFileSync(path.join(SANDBOX, `.claude/web-search/g3a/lastmod-snapshot-${okey18}.json`), 'utf8'));
  const lm = r.lastmod_summary;

  // (가) 집계는 고유 url_id 한 칸씩 — sitemap-a 는 /dup 을 두 줄로 적어 두었다
  const counted = lm.new + lm.changed + lm.unchanged;
  const uniques = Object.keys(snap).length;
  const rawRows = Object.values(r.per_sitemap).reduce((s, n) => s + n, 0);
  const dupInSnapOnce = Object.keys(snap).filter((id) => id === dupId).length === 1;

  // (나) 바뀐 lastmod 는 장부에도 반영된다
  const ledgerUpdated = st.urls[bumpedId]?.lastmod === snap[bumpedId];

  // (다) 다시 나타나면 표시를 풀고 이벤트를 남긴다
  const clearedFlag = !st.urls[goneId]?.missing_from_latest_snapshot;
  const events = fs.readFileSync(path.join(SANDBOX, '.claude/web-search/g3a/events.jsonl'), 'utf8');
  const hasReappear = events.split('\n').some((l) => l.includes('"reappeared_in_sitemap"') && l.includes(goneId));

  // (라) 바뀐 것만이 아니라 스냅샷 전체가 장부와 같아야 한다
  const mismatched = Object.entries(snap).filter(([id, lm]) => (st.urls[id]?.lastmod ?? null) !== lm);

  check('G18', '중복 주소를 두 번 세지 않고, 스냅샷 lastmod 가 장부와 전부 일치하며, 다시 나타나면 사라짐 표시를 푼다',
    counted === uniques && counted < rawRows && dupInSnapOnce
    && ledgerUpdated && mismatched.length === 0 && clearedFlag && hasReappear && r.reappeared >= 1,
    `집계 ${counted}칸 = 고유 ${uniques}칸 (사이트맵 줄 수 합계 ${rawRows}) · /dup 한 칸=${dupInSnapOnce} · `
    + `장부 lastmod 반영=${ledgerUpdated} · 스냅샷과 어긋난 항목 ${mismatched.length}건 · `
    + `표시 해제=${clearedFlag} · 복귀 이벤트=${hasReappear}(${r.reappeared}건)`);
}

// ---------- G20. 한 크롤에 origin 이 둘이어도 서로를 밀어내지 않는다 ----------
{
  const crypto = await import('node:crypto');
  const okey = (o) => crypto.createHash('sha256').update(o).digest('hex').slice(0, 12);
  const snapPath = (o) => path.join(SANDBOX, '.claude/web-search/g3two', `lastmod-snapshot-${okey(o)}.json`);
  const sha = (f) => (fs.existsSync(f) ? crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex').slice(0, 12) : '없음');

  const runTo = (origin, extra = {}) => settle('g3two',
    { origin, worker: 'two', skipSitemaps: true, sitemapSeeds: [`${origin}/sitemap-small.xml`], ...extra }, 'G20');
  const marksFor = (origin) => Object.values(store.loadState('g3two').urls)
    .filter((u) => u.url.startsWith(origin)).filter((u) => u.missing_from_latest_snapshot).length;

  store.createCrawl('g3two', { seeds: [], policy: FAST });
  const rA = await runTo(BASE);
  const snapA1 = sha(snapPath(BASE));
  const rB = await runTo(BASE2);
  const snapA2 = sha(snapPath(BASE));
  const rB2 = await runTo(BASE2, { refresh: true });         // B 를 다시 훑어도 A 는 그대로여야
  const snapA3 = sha(snapPath(BASE));

  const aUntouched = snapA1 !== '없음' && snapA1 === snapA2 && snapA2 === snapA3 && marksFor(BASE) === 0;
  const independent = rA.lastmod_summary.new === 11 && rB.lastmod_summary.new === 11
    && rB2.lastmod_summary.new === 0 && rB2.lastmod_summary.unchanged === 11
    && (rB.disappeared_marked || 0) === 0 && (rB2.disappeared_marked || 0) === 0;
  const separateFiles = fs.existsSync(snapPath(BASE)) && fs.existsSync(snapPath(BASE2));

  check('G20', '한 크롤에 자리가 둘이면 스냅샷·사라짐 판정도 자리마다 따로 간다',
    aUntouched && independent && separateFiles,
    `A 스냅샷 ${snapA1}→${snapA2}→${snapA3}(불변=${aUntouched}) · A 사라짐 표시 ${marksFor(BASE)}건 · `
    + `집계 A새것 ${rA.lastmod_summary.new} / B새것 ${rB.lastmod_summary.new} / B재훑기 새것 ${rB2.lastmod_summary.new} 그대로 ${rB2.lastmod_summary.unchanged} · `
    + `B 훑을 때 A 사라짐 ${rB.disappeared_marked || 0}건 · 스냅샷 파일 분리=${separateFiles}`);
}

// ---------- G21. 같은 자리를 다르게 적어도 한 자리로 본다 ----------
{
  const hitsOf = async () => JSON.parse(await (await fetch(`${BASE}/hits`)).text());
  const SM = '/sitemap-small.xml';
  store.createCrawl('g3orig', { seeds: [], policy: FAST });

  const common = { worker: 'o', skipSitemaps: true, sitemapSeeds: [`${BASE}${SM}`] };
  const h0 = await hitsOf();
  const [x, y] = await Promise.all([
    discover('g3orig', { ...common, origin: BASE }),
    discover('g3orig', { ...common, origin: `${BASE}/` }),      // 끝 빗금만 다른 같은 자리
  ]);
  const lost = [x, y].find((v) => v.deferred === true && v.why === 'already_running');
  const kept = [x, y].filter((v) => v !== lost);
  const won = kept.find((v) => v.done === true) || await settle('g3orig', { ...common, origin: BASE }, 'G21');
  const h1 = await hitsOf();
  const delta1 = (h1[SM] || 0) - (h0[SM] || 0);

  // 경로까지 붙여 불러도 같은 자리로 보고, 끝낸 회차를 그대로 돌려준다
  const z = await discover('g3orig', { ...common, origin: `${BASE}/some/path` });
  const delta2 = ((await hitsOf())[SM] || 0) - (h1[SM] || 0);

  check('G21', '끝 빗금·경로가 붙어도 같은 자리로 본다 — 실행권·진행·완료표지가 갈리지 않는다',
    delta1 === 1 && won?.done === true && kept.length === 1 && lost?.why === 'already_running'
    && z.reused_finished_run === true && z.network_calls === 0 && z.report === won.report && delta2 === 0
    && z.origin === BASE && z.origin_input === `${BASE}/some/path`,
    `빗금 두 표기 동시 호출 → 서버가 받은 요청 ${delta1}회 · 실행권 못 잡은 쪽 ${lost ? 1 : 0}개(${lost?.why}) · `
    + `경로 붙여 재호출 → 요청 ${delta2}회, 끝난 회차 재사용=${z.reused_finished_run}, 같은 보고서=${z.report === won?.report} · `
    + `정규형 ${z.origin} (입력 ${z.origin_input})`);
}

// ---------- G22. XML 의 &amp; 를 풀어 읽는다 ----------
{
  store.createCrawl('g3ent', { seeds: [], policy: FAST });
  const r = await settle('g3ent', { origin: BASE, worker: 'ent', skipSitemaps: true,
    sitemapSeeds: [`${BASE}/sitemap-entity.xml`] }, 'G22');
  const goods = Object.values(store.loadState('g3ent').urls).filter((u) => u.url.includes('/goods'));
  const one = goods.length === 1 ? goods[0] : null;
  const decoded = !!one && one.url.includes('color=red') && one.url.includes('goodsNo=300')
    && !one.url.includes('&amp;') && !one.url.includes('utm_source');
  // 먼저 박힌 줄에는 lastmod 가 없었다 — 스냅샷 값이 장부까지 와야 한다
  const lastmodLanded = one?.lastmod === '2026-08-06';

  check('G22', 'XML 의 &amp; 를 풀어 읽어 기능성 파라미터가 살아남고, 나중 줄의 lastmod 가 장부까지 온다',
    r?.done === true && goods.length === 1 && decoded && lastmodLanded,
    `/goods 등록 ${goods.length}건 · 주소 ${one?.url?.replace(BASE, '') || '없음'} · 해독=${decoded} · 장부 lastmod=${one?.lastmod}`);
}

// ---------- G23. 사이트가 선언한 사이트맵이 사이트맵이 아니면 막고 멈춘다 ----------
{
  const crypto = await import('node:crypto');
  const okey = crypto.createHash('sha256').update(BASE).digest('hex').slice(0, 12);
  const dir = path.join(SANDBOX, '.claude/web-search/g3pair');
  const snapPath = path.join(dir, `lastmod-snapshot-${okey}.json`);
  const progPath = path.join(dir, `discover-progress-${okey}.json`);
  const sha = (f) => (fs.existsSync(f) ? crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex').slice(0, 12) : '없음');
  const hitsOf = async () => JSON.parse(await (await fetch(`${BASE}/hits`)).text());
  const A = '/sitemap-pair-a.xml', B = '/sitemap-pair-b.xml';

  const run = async (extra = {}) => {
    return settle('g3pair',
      { origin: BASE, worker: 'pair', skipSitemaps: true, sitemapSeeds: [`${BASE}/sitemap-pair.xml`], ...extra }, 'G23');
  };

  store.createCrawl('g3pair', { seeds: [], policy: FAST });
  const r1 = await run();                                     // 1회차: 둘 다 정상 → 5칸
  const snap1 = sha(snapPath);

  await fetch(`${BASE}/sitemap-ctl?breakb=1`).then((x) => x.text());
  const hBefore = await hitsOf();
  const r2 = await run({ refresh: true });                    // 2회차: B 가 200 오류 HTML
  const hAfterBreak = await hitsOf();
  const snap2 = sha(snapPath);

  const blocked = r2.done !== true && r2.completion === 'paused_incomplete'
    && (r2.blockers || []).some((b) => b.url.endsWith(B) && b.src === 'index' && /not_a_sitemap|no_body/.test(b.why)
      && b.evidence?.first_bytes);
  const progKeptAtPause = fs.existsSync(progPath);        // 멈춘 그 시점의 값을 붙잡아 둔다
  const noHalfTruth = snap2 === snap1 && !r2.disappeared_marked && !r2.revisit_candidates
    && !(r2.sitemaps_visited || []).some((u) => u.endsWith(B))
    && (r2.sitemaps_visited || []).some((u) => u.endsWith(A))
    && progKeptAtPause;

  await fetch(`${BASE}/sitemap-ctl?breakb=0`).then((x) => x.text());
  const r3 = await run();                                     // 같은 회차를 잇는다(진행이 있으니 새 회차 아님)
  const hEnd = await hitsOf();
  const aHits = (hEnd[A] || 0) - (hBefore[A] || 0);
  const bHits = (hEnd[B] || 0) - (hBefore[B] || 0);
  const resumedRight = r3.done === true && (r3.blockers || []).length === 0
    && r3.lastmod_summary.unchanged === 5 && r3.lastmod_summary.new === 0
    && aHits === 1 && bHits === 2 && !fs.existsSync(progPath);

  check('G23', '선언된 사이트맵이 200 오류 HTML 이면 막고 멈춘다 — 반쪽 스냅샷을 남기지 않고, 나으면 그 자리만 잇는다',
    r1.done === true && Object.keys(JSON.parse(fs.readFileSync(snapPath, 'utf8'))).length === 5
    && blocked && noHalfTruth && resumedRight,
    `1회차 완주=${r1.done}(5칸) · 2회차 멈춤=${r2.completion} 막힌 것 ${(r2.blockers || []).length}건 [${(r2.blockers || [])[0]?.why}]\n`
    + `      스냅샷 ${snap1}→${snap2}(불변=${snap2 === snap1}) · 사라짐 ${r2.disappeared_marked || 0}건 · 재방문후보 ${r2.revisit_candidates || 0} · B 방문 안 함=${!(r2.sitemaps_visited || []).some((u) => u.endsWith(B))} · 멈춘 시점 진행 보존=${progKeptAtPause}\n`
    + `      복구 후: 완주=${r3.done} 막힌 것 ${(r3.blockers || []).length}건 · 서버 요청 A ${aHits}회(재방문 없음) B ${bHits}회(고장 1 + 복구 1)`);
}

// ---------- G24. 우리가 찍어 본 주소(guess)가 없는 건 막을 일이 아니다 ----------
{
  await fetch(`${BASE2}/sitemap-ctl?norobots=1`).then((x) => x.text());   // robots 선언을 지운다
  store.createCrawl('g3guess', { seeds: [], policy: FAST });
  const r = await settle('g3guess', { origin: BASE2, worker: 'guess' }, 'G24');
  const guessSkips = (r.skipped || []).filter((s) => s.src === 'guess');
  check('G24', 'robots 가 아무것도 선언하지 않아 찍어 본 주소들은 없어도 막지 않는다(사유만 남긴다)',
    r?.done === true && (r.blockers || []).length === 0 && guessSkips.length >= 2
    && (r.sitemaps_visited || []).length >= 1,
    `robots 선언 ${r?.robots_sitemaps?.length ?? 0}개 · 찍어 봤다 없음 ${guessSkips.length}건 [${[...new Set(guessSkips.map((s) => s.why))].join(', ')}] · `
    + `막힌 것 ${(r.blockers || []).length}건 · 실제 사이트맵 ${r?.sitemaps_visited?.length ?? 0}개 방문 · 완주=${r?.done}`);
  await fetch(`${BASE2}/sitemap-ctl?reset=1`).then((x) => x.text());
}

// ---------- G9. 바깥 링크를 발견 단계에서 조용히 버리지 않는다 ----------
// harvestLinks 가 같은 호스트가 아니라고 그냥 넘겨 버리면, 바닥글의 제휴사·소셜 링크가
// 큐에도 안 들고 안 들인 목록에도 안 남는다. 그러면 "바깥 도메인 0건" 이 관찰처럼 보이는데
// 사실은 도구가 보기 전에 버린 것이다. 두 다리 규칙은 store 가 판단해야 한다.
// (2026-08-11 실전 1회차 감사에서 발견)
{
  const crawl = 'g3-external-links';
  // 실전과 같은 모양으로 둔다 — 씨앗 도메인이 hop 0 기준이어야 바깥이 한 다리로 세어진다
  store.createCrawl(crawl, {
    seeds: [`${BASE}/`],
    policy: { ...FAST, allow_domains: [new URL(BASE).hostname], external_hop_max: 2 },
  });
  const r = await settle(crawl, { origin: BASE, worker: 'gate3' }, crawl);
  const st = store.loadState(crawl);

  // fixture 의 page() 바닥글에는 x.example/1~3 이 모든 쪽에 붙어 있다
  const ext = Object.entries(st.urls).filter(([, u]) => u.domain === 'x.example');
  const hops1 = ext.filter(([, u]) => u.external_hops === 1);
  const queued = ext.filter(([, u]) => u.state === 'queued');
  // 레코드에는 via 대신 discovered_by 에 출처가 남는다
  const withProvenance = ext.filter(([, u]) => [].concat(u.discovered_by || []).some((d) => /^link:/.test(d)));
  const uniq = new Set(ext.map(([, u]) => u.url));      // 여러 쪽에서 같은 링크가 나와도 한 칸
  const mdir = crawlPaths(crawl).manifests;
  const visited = ext.filter(([id]) => fs.existsSync(path.join(mdir, id)));   // 발견 단계는 안 연다
  // "발견하되 열지 않았다" 는 시도 0회·표 없음까지 봐야 증명된다
  const untouched = ext.filter(([, u]) => u.attempts === 0 && u.lease === null);

  // 보고한 "링크로 들인 수" 가 실제 장부 이벤트와 맞아야 한다.
  // 두 길로 넣으면 이벤트가 더 많고, 보고를 빠뜨리면 이벤트가 더 적다.
  const evLines = fs.readFileSync(crawlPaths(crawl).events, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
  const addedByLink = evLines.filter((e) => e.type === 'url_added'
    && [].concat(e.discovered_by || []).some((d) => /^link:/.test(String(d)))).length;

  check('G25', '바닥글의 바깥 링크는 버리지 않고 바깥 한 다리로 큐에 들며, 링크로 들인 수가 장부 이벤트와 맞는다',
    ext.length === 3 && hops1.length === 3 && queued.length === 3
    && withProvenance.length === 3 && uniq.size === 3 && visited.length === 0 && untouched.length === 3
    && (r.links_added || 0) === addedByLink,
    `x.example ${ext.length}칸(고유 ${uniq.size}) · 바깥 한 다리 ${hops1.length} · 대기 ${queued.length} · `
    + `출처 남음 ${withProvenance.length} · 시도 0·표 없음 ${untouched.length} · 발견 중 연 것 ${visited.length}건 · `
    + `보고한 링크 추가 ${r.links_added ?? 0} vs 장부 url_added(link) ${addedByLink} · 이번 발견 네트워크 ${r.network_calls}회`);
}

// ---------- G10. 두 다리까지 들이고 세 다리째만 안 들인다 ----------
{
  const crawl = 'g3-hop-cap';
  store.createCrawl(crawl, {
    seeds: [`${BASE}/`],
    policy: { ...FAST, allow_domains: [new URL(BASE).hostname], external_hop_max: 2 },
  });
  const seedId = Object.keys(store.loadState(crawl).urls)[0];
  const a = store.addUrls(crawl, [
    { url: 'https://x.example/a', via: 'link', from_url_id: seedId, kind: 'unknown' },
    { url: 'https://x.example/a', via: 'link', from_url_id: seedId, kind: 'unknown' },   // 같은 주소 두 번
  ]);
  const hop1 = Object.entries(store.loadState(crawl).urls).find(([, u]) => u.url === 'https://x.example/a');
  store.addUrls(crawl, [{ url: 'https://y.example/b', via: 'link', from_url_id: hop1[0], kind: 'unknown' }]);
  const hop2 = Object.entries(store.loadState(crawl).urls).find(([, u]) => u.url === 'https://y.example/b');
  const c = store.addUrls(crawl, [{ url: 'https://z.example/c', via: 'link', from_url_id: hop2[0], kind: 'unknown' }]);
  const zBlocked = store.listExcluded(crawl).active.find((x) => x.url === 'https://z.example/c');

  check('G26', '바깥 두 다리까지는 들이고 세 다리째만 external_hop_exceeded 로 남긴다(같은 주소는 한 칸)',
    a.added === 1 && a.duplicates === 1
    && hop1[1].external_hops === 1 && hop2[1].external_hops === 2
    && c.added === 0 && zBlocked?.why === 'external_hop_exceeded',
    `한 배열 중복 → 추가 ${a.added}·중복 ${a.duplicates} · x=${hop1[1].external_hops}다리 · y=${hop2[1].external_hops}다리 · `
    + `z 추가 ${c.added} · 안 들인 사유 ${zBlocked?.why ?? '없음'}`);
}

// ---------- G27. 잘못된 쪽에서는 링크를 거두지 않는다 ----------
// 200 을 주는 오류 쪽에도 메뉴와 바닥글은 그대로다. 본문이 있다는 이유만으로 링크를 따라가면
// 거짓 양성이 그대로 번진다. report 경로만 막고 여기를 열어 두면 씨앗·홈 오류 쪽에서 새어 나간다.
{
  const crawl = 'g3-bad-page-links';
  store.createCrawl(crawl, {
    seeds: [`${BASE}/`],
    policy: { ...FAST, allow_domains: [new URL(BASE).hostname], external_hop_max: 2 },
  });
  // skipSitemaps 로 홈 수집을 빼고, 오류 쪽 하나만 extraSeeds 로 넣는다.
  // (sitemapSeeds 는 XML 사이트맵 전용이라 그 쪽으로 주면 링크 수집기까지 가지 않는다.)
  const r = await settle(crawl, {
    origin: BASE, worker: 'gate3', skipSitemaps: true, extraSeeds: [`${BASE}/soft404`],
  }, crawl);
  const st = store.loadState(crawl);
  const fromBad = Object.values(st.urls)
    .filter((u) => (u.discovered_by || []).some((d) => String(d) === `link:${BASE}/soft404`));
  const ext = Object.values(st.urls).filter((u) => u.domain === 'x.example');
  const verdict = (r.fetched || []).find((f) => String(f.requested).endsWith('/soft404'))?.page_validity;

  check('G27', '잘못된 쪽(200 오류 쪽)에서는 링크를 한 칸도 거두지 않는다',
    verdict === 'invalid' && fromBad.length === 0 && ext.length === 0,
    `그 쪽 판정 ${verdict} · 그 쪽에서 들어온 칸 ${fromBad.length} · x.example ${ext.length}칸`);
}

const passed = results.filter((r) => r.pass).length;
console.log(`\n${'='.repeat(60)}`);
console.log(`게이트 3(로컬): ${passed}/${results.length} 통과`);
for (const r of results.filter((x) => !x.pass)) console.log(`  실패 ${r.no}. ${r.name} — ${r.detail}`);
console.log(`샌드박스: ${SANDBOX}${process.env.KEEP_SANDBOX === '1' ? ' (보존)' : ' (종료 시 삭제)'}`);
process.exit(passed === results.length ? 0 : 1);
