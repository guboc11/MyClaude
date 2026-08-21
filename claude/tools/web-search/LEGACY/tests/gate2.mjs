#!/usr/bin/env node
// 게이트 2 — 수집 계단. 합격 판정은 로컬 fixture 로만 한다.
// 계획서 게이트 2 + 태스크 12. 외부 사이트 동작은 합격 조건이 아니다(내일 달라진다).
//
// 실행: node tests/gate2.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.join(HERE, '..', 'lib');
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'websearch-gate2-'));
process.env.CLAUDE_PROJECT_DIR = SANDBOX;

const results = [];
function check(no, name, pass, detail = '') {
  results.push({ no, name, pass, detail });
  console.log(`${pass ? 'O' : 'X'}  ${no}. ${name}${detail ? `\n      ${detail}` : ''}`);
}

const store = await import(path.join(LIB, 'store.mjs'));
const { fetchOne } = await import(path.join(LIB, 'fetch.mjs'));

// ---- fixture 서버 띄우기 ----
const fx = spawn(process.execPath, [path.join(HERE, '..', 'fixtures', 'server.mjs')], { stdio: ['ignore', 'pipe', 'pipe'] });
const BASE = await new Promise((res) => fx.stdout.once('data', (d) => res(String(d).trim())));
console.log(`샌드박스: ${SANDBOX}\nfixture: ${BASE}\n`);
// fixture 를 내리고 최상위 샌드박스도 치운다. 실패로 끝나도 exit 훅에서 돈다.
const bye = () => {
  try { fx.kill(); } catch {}
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch {}
};
process.on('exit', bye);

// 로컬 시험이라 간격을 짧게 — pace 는 여전히 호출되고, 예약이 실제로 일어난다
const POLICY = { mode: 'pilot', min_interval_ms: 60, interval_jitter_ms: 20, daily_cap: 500, lease_ttl_ms: 120_000 };
const PAGES = {
  listingJsonld: `${BASE}/listing-jsonld`,
  listingPlain: `${BASE}/listing-plain`,
  soft404: `${BASE}/soft404`,
  redirect: `${BASE}/products/gone`,
  jsOnly: `${BASE}/js-only`,
  flaky: `${BASE}/flaky`,
  listingTwo: `${BASE}/listing-two`,
  navTrap: `${BASE}/nav-trap`,
  ambiguous: `${BASE}/ambiguous`,
  listingPaged: `${BASE}/listing-paged`,
};
store.createCrawl('g2fix', { seeds: Object.values(PAGES), policy: POLICY });

// url → { url_id, lease_token } 표를 만든다
const leased = store.lease('g2fix', 50, 'gate2');
const tok = Object.fromEntries(leased.leased.map((x) => [x.url, { url_id: x.url_id, lease_token: x.lease_token }]));
const get = (u) => tok[u] || {};

// [격리] pace 는 도메인 단위 전역이라 앞선 시험의 예약이 뒤 시험에 흘러든다.
// (2026-08-11: today_count 28 이 쌓여 L16·L20 첫 호출이 interval 에 막혔다.)
// 예약 계약을 다루는 시험은 자기만의 sandbox 에서 돌려 매 실행이 서로 독립되게 한다.
// 자기 폴더는 자기가 치운다. 안 치우면 실행마다 쌓인다(2026-08-11: 227개, 62MB 누적).
// 자식 프로세스를 죽이는 시험도 있으므로 정리는 반드시 finally 에서 한다.
async function inFreshSandbox(name, fn) {
  const prev = process.env.CLAUDE_PROJECT_DIR;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `websearch-${name}-`));
  process.env.CLAUDE_PROJECT_DIR = dir;
  try { return await fn(dir); }
  finally {
    process.env.CLAUDE_PROJECT_DIR = prev;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

// pace 가 막으면(deferred) 남은 초만큼 기다렸다 다시 온다 — 실제 워커도 이렇게 돈다.
async function go(u, kind, extra = {}) {
  for (let i = 0; i < 40; i++) {
    const r = await fetchOne('g2fix', { url: u, kind, ...get(u), ...extra });
    if (!r.deferred) return r;
    await new Promise((res) => setTimeout(res, ((r.wait_seconds || 1) * 1000) + 50));
  }
  throw new Error(`pace 대기가 끝나지 않습니다: ${u}`);
}

// ---------- L0. lease_token 없으면 네트워크 0회로 거절 ----------
{
  const r = await fetchOne('g2fix', { url: PAGES.listingJsonld, kind: 'listing' });   // 토큰 없음
  const r2 = await fetchOne('g2fix', { url: PAGES.listingJsonld, kind: 'listing', ...get(PAGES.listingJsonld), lease_token: 'wrong-token' });
  check('L0', 'lease_token 없거나 어긋나면 네트워크 0회로 거절',
    r.refused === true && r.network_calls === 0 && r2.refused === true && r2.network_calls === 0,
    `없음: refused=${r.refused} why=${r.why} net=${r.network_calls} / 틀림: why=${r2.why} net=${r2.network_calls}`);
}

// ---------- L1. 정상 목록 (JSON-LD 있음/없음) ----------
let listingA, listingB;
{
  listingA = await go(PAGES.listingJsonld, 'listing');
  listingB = await go(PAGES.listingPlain, 'listing');
  const okA = listingA.cards === 12 && listingA.positive_evidence.some((e) => e.startsWith('jsonld_items'));
  const okB = listingB.cards === 12 && listingB.positive_evidence.some((e) => e.startsWith('repeated_image_links'));
  check('L1', '정상 목록 — 카드 12개 추출, JSON-LD 있는 판과 없는 판 모두',
    okA && okB,
    `jsonld판: cards=${listingA.cards} 증거=[${listingA.positive_evidence}] / plain판: cards=${listingB.cards} 증거=[${listingB.positive_evidence}]`);
}

// ---------- L2. 상태 200 인 오류 페이지 → invalid ----------
{
  const r = await go(PAGES.soft404, 'unknown');
  check('L2', '200 인데 오류 페이지면 invalid (상태 코드로 통과시키지 않는다)',
    r.status === 200 && r.page_validity === 'invalid',
    `status=${r.status} 판정=${r.page_validity} 부정증거=[${r.negatives}]`);
}

// ---------- L3. 홈으로 튕긴 상세 → flag + invalid ----------
{
  const r = await go(PAGES.redirect, 'detail');
  check('L3', '홈으로 튕긴 상세 — redirected flag 와 invalid 판정',
    r.flags.includes('redirected') && r.negatives.includes('redirected_to_root') && r.page_validity === 'invalid',
    `requested≠final: ${r.requested} → ${r.final} / flags=[${r.flags}] 판정=${r.page_validity}`);
}

// ---------- L4. JS 전 비어 있는 페이지 → 브라우저 단으로 승격 ----------
{
  const r = await go(PAGES.jsOnly, 'listing');
  const promoted = r.flags.some((f) => f.startsWith('promoted_from_curl'));
  const reachedBrowser = ['headless', 'chrome'].includes(r.content_tier);
  check('L4', 'JS 전 비어 있는 페이지 — curl 에서 승격되어 브라우저 단에서 카드가 나온다',
    promoted && reachedBrowser && r.cards === 12,
    `승격flags=[${r.flags.filter((f) => f.startsWith('promoted'))}] content_tier=${r.content_tier} cards=${r.cards}`);
}

// ---------- L5. 403·429 재시도/휴면 ----------
{
  const paceMod = await import(path.join(LIB, 'pace.mjs'));
  const before = paceMod.peek(new URL(BASE).hostname);
  const r = await go(PAGES.flaky, 'listing');
  const after = paceMod.peek(new URL(BASE).hostname);
  const saw429 = r.attempts.some((a) => a.status === 429);
  check('L5', '429 를 만나면 승격 사유로 남기고, pace 에 차단 낌새가 기록된다',
    saw429 && r.attempts.some((a) => String(a.promote_reason || '').includes('http_429')) && after.block_score >= before.block_score,
    `attempts=${r.attempts.map((a) => `${a.tier}:${a.status}${a.promote_reason ? `(${a.promote_reason})` : ''}`).join(' → ')} block_score ${before.block_score}→${after.block_score}`);
}

// ---------- L6. [함정] 카드 두 개짜리 목록도 목록이다 ----------
{
  const r = await go(PAGES.listingTwo, 'listing');
  check('L6', '[함정] 카드가 둘뿐인 목록도 정상 목록으로 본다("N개 이상"으로 자르지 않는다)',
    r.cards === 2 && r.page_validity !== 'invalid',
    `cards=${r.cards} 판정=${r.page_validity} 증거=[${r.positive_evidence}]`);
}

// ---------- L7. [함정] nav·footer 의 이미지+링크를 카드로 오인하지 않는다 ----------
{
  const r = await go(PAGES.navTrap, 'unknown');
  check('L7', '[함정] nav·footer 에만 이미지+링크가 반복되는 페이지를 목록으로 오인하지 않는다',
    r.cards === 0,
    `cards=${r.cards} 판정=${r.page_validity} 증거=[${r.positive_evidence}]`);
}

// ---------- L8. 목록은 visual 확인 없이 통과 금지 ----------
{
  const r = await go(PAGES.listingJsonld, 'listing', { maxTier: 'curl' });   // 브라우저 못 가게 막는다
  check('L8', '목록은 화면을 보지 않으면 통과가 아니다 — curl 원문이 멀쩡해도',
    r.content_tier === 'curl' && r.visual === 'visual_unverified'
    && r.page_validity === 'needs_visual_review' && r.flags.includes('listing_needs_visual'),
    `content_tier=${r.content_tier} visual=${r.visual} 판정=${r.page_validity} flags=[${r.flags}]`);
}

// ---------- L9. 애매한 페이지는 needs_visual_review 로 쌓인다 ----------
{
  const r = await go(PAGES.ambiguous, 'unknown');
  const anyNeeds = [listingA, listingB, r].some((x) => x.page_validity === 'needs_visual_review');
  check('L9', '애매한 페이지가 needs_visual_review 로 실제로 쌓인다(전부 자동 통과면 판정이 무르다)',
    r.page_validity === 'needs_visual_review' || anyNeeds,
    `ambiguous 판정=${r.page_validity} cards=${r.cards} 증거=[${r.positive_evidence}] 부정=[${r.negatives}]`);
}

// ---------- L10. 캡처가 실제 파일로 남고 manifest 에 계약대로 적힌다 ----------
{
  const r = await go(PAGES.listingPlain, 'listing');
  const shotOk = r.shot && fs.existsSync(r.shot) && fs.statSync(r.shot).size > 1000;
  const { crawlPaths } = await import(path.join(LIB, 'paths.mjs'));
  const mdir = path.join(crawlPaths('g2fix').manifests, r.url_id);
  // manifest 폴더에는 attempt JSON 말고도 body-*.txt(진행 저장용)가 함께 있다.
  // 이름 순 마지막을 집으면 attempt id 첫 글자에 따라 body 파일이 잡힌다(간헐 실패의 원인이었다).
  const files = (fs.existsSync(mdir) ? fs.readdirSync(mdir) : [])
    .filter((f) => f.endsWith('.json') && f !== 'progress.json')
    .sort((a, b) => fs.statSync(path.join(mdir, b)).mtimeMs - fs.statSync(path.join(mdir, a)).mtimeMs);
  const man = files.length ? JSON.parse(fs.readFileSync(path.join(mdir, files[0]), 'utf8')) : {};
  const keys = ['requested', 'final', 'status', 'title', 'text_len', 'flags', 'shot', 'content_tier', 'visual_tier'];
  const hasAll = keys.every((k) => k in man);
  check('L10', '캡처가 파일로 남고 manifest 에 requested/final/status/title/text_len/flags/shot/content·visual tier 가 있다',
    shotOk && hasAll && r.visual === 'visual_validated',
    `shot=${r.shot ? path.basename(r.shot) : 'none'}(${shotOk ? fs.statSync(r.shot).size + 'B' : '없음'}) visual=${r.visual} manifest키=${hasAll ? '전부' : keys.filter((k) => !(k in man)).join(',') + ' 없음'}`);
}

// ---------- L11. resumable fetch — deferred 뒤 재호출이 끝낸 단을 다시 요청하지 않는다 ----------
// (2026-08-11 사고: deferred 뒤 curl 부터 재시작해 같은 페이지에 19회 요청, daily_cap 소진)
{
  const pace2 = await import(path.join(LIB, 'pace.mjs'));
  const host = new URL(BASE).hostname;
  // 간격을 길게 준 새 크롤 — curl 을 끝낸 뒤 다음 단 예약에서 반드시 막히게 만든다
  store.createCrawl('g2resume', {
    seeds: [`${BASE}/js-only`],
    policy: { mode: 'pilot', min_interval_ms: 3_000, interval_jitter_ms: 0, daily_cap: 50, lease_ttl_ms: 120_000 },
  });
  const lz = store.lease('g2resume', 1, 'resume');
  const { url_id, lease_token, url } = lz.leased[0];

  const before = pace2.peek(host).today_count;
  const r1 = await fetchOne('g2resume', { url, url_id, lease_token, kind: 'listing' });
  const afterFirst = pace2.peek(host).today_count;

  // 첫 호출은 curl 을 하고 다음 단 예약에서 막혀야 한다
  const deferredOk = r1.deferred === true && r1.resume?.done_tiers?.includes('curl') && r1.network_calls === 1;

  await new Promise((res) => setTimeout(res, ((r1.wait_seconds || 1) * 1000) + 200));
  const r2 = await fetchOne('g2resume', { url, url_id, lease_token, kind: 'listing' });
  const afterSecond = pace2.peek(host).today_count;

  // 재호출은 curl 을 건너뛰고 다음 단부터 — attempts 에 curl 이 두 번 있으면 안 된다
  const curlCount = (r2.attempts || []).filter((a) => a.tier === 'curl').length;
  const resumedFromNext = curlCount === 1;
  // 하루 카운트는 실제로 나간 요청 수만큼만 늘어야 한다
  const spent = afterSecond - before;
  const actualCalls = r1.network_calls + (r2.network_calls || 0);
  const countMatches = spent === actualCalls;

  // stale token 으로는 이어받을 수 없다
  const r3 = await fetchOne('g2resume', { url, url_id, lease_token: 'other-token', kind: 'listing' });
  const staleRejected = r3.refused === true && r3.network_calls === 0;

  check('L11', 'deferred 뒤 재호출이 끝낸 단을 다시 요청하지 않는다(resumable) · 하루 카운트가 실제 요청 수와 같다 · stale token 은 이어받지 못한다',
    deferredOk && resumedFromNext && countMatches && staleRejected,
    `1차: deferred=${r1.deferred} done=[${r1.resume?.done_tiers}] net=${r1.network_calls} / `
    + `2차: curl호출수=${curlCount} net=${r2.network_calls} content_tier=${r2.content_tier} / `
    + `daily_count +${spent} vs 실제요청 ${actualCalls} / stale거절=${staleRejected}`);
}

// ---------- L12. 무한 스크롤 페이지도 제한 시간 안에 끝난다 ----------
{
  const t0 = Date.now();
  store.createCrawl('g2scroll', {
    seeds: [`${BASE}/infinite`],
    policy: { mode: 'pilot', min_interval_ms: 60, interval_jitter_ms: 20, daily_cap: 50, lease_ttl_ms: 120_000 },
  });
  const lz = store.lease('g2scroll', 1, 'scroll');
  const { url_id, lease_token, url } = lz.leased[0];
  let r;
  for (let i = 0; i < 20; i++) {
    r = await fetchOne('g2scroll', { url, url_id, lease_token, kind: 'listing' });
    if (!r.deferred) break;
    await new Promise((res) => setTimeout(res, ((r.wait_seconds || 1) * 1000) + 50));
  }
  const elapsed = Date.now() - t0;
  const capped = (r.flags || []).some((f) => f.startsWith('scroll_capped'));
  check('L12', '스크롤할 때마다 길어지는 페이지도 상한에 걸려 끝나고, 상한 도달이 flag 로 남는다',
    elapsed < 60_000 && capped,
    `소요 ${(elapsed / 1000).toFixed(1)}초 flags=[${(r.flags || []).filter((f) => f.startsWith('scroll_capped') || f === 'shot_truncated')}] 판정=${r.page_validity}`);
}

// ---------- L13. Jina 전역 한도가 코드로 예약된다 ----------
{
  const pace3 = await import(path.join(LIB, 'pace.mjs'));
  const a = pace3.reserve('r.jina.ai', { min_interval_ms: 3_100, jitter_ms: 400, daily_cap: 5_000 });
  const b = pace3.reserve('r.jina.ai', { min_interval_ms: 3_100, jitter_ms: 400, daily_cap: 5_000 });
  const perMin = Math.floor(60_000 / 3_100);
  check('L13', `Jina 무키 한도(분당 20회)를 전역 pace 로 예약한다 — 간격 3.1초면 분당 최대 ${perMin}회`,
    a.ok === true && b.ok === false && perMin <= 20,
    `1차 예약=${a.ok}(간격 ${a.reserved_gap_ms}ms) 2차=${b.ok}(${b.why}, ${b.wait_seconds}초 대기) → 분당 상한 ${perMin}회`);
}

// ---------- L14. 페이지 나눔 — 표시 수가 더 많아도 페이지는 정상이다 ----------
{
  const r = await go(PAGES.listingPaged, 'listing');
  check('L14', '"총 56개"인데 이 쪽에 12개면 페이지 나눔 — invalid 가 아니라 extraction_status 로 다룬다',
    r.page_validity !== 'invalid' && r.cards === 12 && r.declared === 56
    && r.extraction_status === 'incomplete'
    && (r.positive_evidence || []).some((e) => e.startsWith('declared_partial')),
    `판정=${r.page_validity} 추출=${r.extraction_status} 카드=${r.cards}/표시=${r.declared} 증거=[${r.positive_evidence}]`);
}

// ---------- L15. visual 확인도 progress 단계 — deferred 뒤 content 를 되풀이하지 않는다 ----------
// (2026-08-11 매니저 재현: 내부에서 5초 자고 포기하면 progress 가 지워져 curl 부터 재시작했다)
{
  store.createCrawl('g2visual', {
    seeds: [`${BASE}/listing-plain`],
    policy: { mode: 'pilot', min_interval_ms: 2_500, interval_jitter_ms: 0, daily_cap: 50, lease_ttl_ms: 120_000 },
  });
  const lz = store.lease('g2visual', 1, 'vis');
  const { url_id, lease_token, url } = lz.leased[0];

  const r1 = await fetchOne('g2visual', { url, url_id, lease_token, kind: 'listing' });
  const deferredOnVisual = r1.deferred === true && String(r1.why).startsWith('visual_')
    && r1.resume?.next_tier === 'visual-only' && r1.resume?.done_tiers?.includes('curl');

  await new Promise((res) => setTimeout(res, ((r1.wait_seconds || 1) * 1000) + 200));
  const r2 = await fetchOne('g2visual', { url, url_id, lease_token, kind: 'listing' });
  const curlAgain = (r2.attempts || []).filter((a) => a.tier === 'curl').length;
  const gotVisual = r2.visual === 'visual_validated' && !!r2.shot;

  const r3 = await fetchOne('g2visual', { url, url_id, lease_token: 'nope', kind: 'listing' });

  check('L15', 'visual 확인이 progress 단계다 — 남은 초를 돌려주고, 재호출은 content 를 되풀이하지 않는다',
    deferredOnVisual && curlAgain === 1 && gotVisual && r3.refused === true && r3.network_calls === 0,
    `1차: deferred=${r1.deferred} why=${r1.why} next=${r1.resume?.next_tier} / 2차: curl재호출=${curlAgain} visual=${r2.visual} / stale거절=${r3.refused}`);
}

// ---------- L16. [fetch 경로] Jina 전역이 막히면 원 도메인 카운트가 더 늘지 않는다 ----------
// 매니저 지적: 앞서는 pace.reserve 를 직접 두 번 부른 시험이라 fetch 와의 연결 증거가 아니었다.
// 여기서는 fetchOne 을 실제로 부른다. 외부 네트워크는 쓰지 않는다 —
// r.jina.ai 를 미리 소진시켜 두 번째 예약에서 막히게 하므로 Jina 로 나가는 요청 자체가 없다.
await inFreshSandbox('jina', async () => {
  const pace4 = await import(path.join(LIB, 'pace.mjs'));
  const host = new URL(BASE).hostname;

  store.createCrawl('g2jina', {
    seeds: [`${BASE}/soft404`],           // curl 에서 승격되어 jina 단으로 들어가는 페이지
    policy: { mode: 'pilot', min_interval_ms: 50, interval_jitter_ms: 0, daily_cap: 100, lease_ttl_ms: 120_000 },
  });
  const lz = store.lease('g2jina', 1, 'jina');
  const { url_id, lease_token, url } = lz.leased[0];

  // r.jina.ai 를 길게 막아 둔다(이 예약은 이름표 없이 — 시험이 직접 소진시키는 것)
  pace4.reserve('r.jina.ai', { min_interval_ms: 600_000, jitter_ms: 0, daily_cap: 5_000 });

  const c0 = pace4.peek(host).today_count;
  // jinaForPrivate: 로컬 주소로도 jina 단에 들어가게 하는 시험 전용 옵션.
  // 앞선 시험들이 같은 도메인을 두드려 curl 단부터 간격에 걸릴 수 있으니,
  // "jina 단에서 막힘"에 도달할 때까지 기다렸다 다시 부른다(이 대기 중 요청은 나가지 않는다).
  let r1 = null;
  for (let i = 0; i < 40; i++) {
    r1 = await fetchOne('g2jina', { url, url_id, lease_token, kind: 'unknown', jinaForPrivate: true });
    if (!r1.deferred || String(r1.why).startsWith('jina_')) break;
    await new Promise((res) => setTimeout(res, ((r1.wait_seconds || 1) * 1000) + 50));
  }
  const c1 = pace4.peek(host).today_count;

  const r2 = await fetchOne('g2jina', { url, url_id, lease_token, kind: 'unknown', jinaForPrivate: true });
  const c2 = pace4.peek(host).today_count;

  const stoppedOnJina = r1.deferred === true && String(r1.why).startsWith('jina_')
    && r1.resume?.done_tiers?.includes('curl');
  const secondNoNetwork = r2.deferred === true && r2.network_calls === 0;

  // 장기 대기를 흉내내 여러 번 더 불러도 원 도메인 카운트가 안 늘어야 한다.
  // (Jina 가 몇 시간 자는 동안 워커가 주기적으로 되물어보는 상황)
  for (let i = 0; i < 5; i++) {
    await fetchOne('g2jina', { url, url_id, lease_token, kind: 'unknown', jinaForPrivate: true });
  }
  const c3 = pace4.peek(host).today_count;

  // 준비 단계(루프)에서 curl 을 몇 번 실제로 보냈는지는 실행마다 다를 수 있다.
  // (curl 예약이 간격에 막히면 대기 후 다시 오므로, jina 에서 멈춘 그 호출의 net 은 1일 수도 0일 수도 있다.)
  // 그러니 고정 숫자를 적지 않고 실제 값에서 읽는다. 이 시험이 지켜보는 것은 하나다 —
  // "Jina 가 막힌 채 몇 번을 더 불러도 원 도메인 카운트가 더 늘지 않는다".
  const curlSent = (r1.resume?.done_tiers || []).includes('curl');
  // c1 > c0 와 curlSent 를 함께 요구한다 — 이게 없으면 "원 도메인 예약이 아예 안 일어나도"
  // 뒤의 '안 늘어남'만 보고 통과해 버린다(약화 방지).
  check('L16', '[fetch 경로] Jina 전역이 막힌 채 반복 호출해도 요청 0회이고 원 도메인 카운트가 더 늘지 않는다',
    stoppedOnJina && secondNoNetwork && curlSent === true && c1 > c0 && c2 === c1 && c3 === c1,
    `1차: deferred=${r1.deferred} why=${r1.why} net=${r1.network_calls} (curl 완료=${curlSent}) / 2차: net=${r2.network_calls} / `
    + `원 도메인 today_count ${c0}→${c1}→${c2}→${c3}(5회 더 부른 뒤) — 2차 이후 불변이 핵심`);
});

// ---------- L20. 네트워크 직전에 죽어도 다음 호출이 무계상 우회를 못 한다 ----------
// permit 을 "요청 뒤"에 지우면 그 사이 죽었을 때 이름표가 남아 요청만 되풀이된다(fail-open).
// "요청 직전"에 지우므로, 죽어도 다음 호출은 정상 경로를 타 카운트가 는다(과대계상 = 안전).
await inFreshSandbox('fault', async (SBOX) => {
  const pace5 = await import(path.join(LIB, 'pace.mjs'));
  const host = new URL(BASE).hostname;
  store.createCrawl('g2fault', {
    seeds: [`${BASE}/listing-jsonld`],
    policy: { mode: 'pilot', min_interval_ms: 50, interval_jitter_ms: 0, daily_cap: 100, lease_ttl_ms: 120_000 },
  });
  const lz = store.lease('g2fault', 1, 'fault');
  const { url_id, lease_token, url } = lz.leased[0];

  const before = pace5.peek(host).today_count;
  // 자식 프로세스에서 curl 단 네트워크 직전에 죽인다.
  // 도메인 간격에 막히면 죽기 전에 deferred 로 끝나므로, 예약을 받을 때까지 자식 안에서 기다린다.
  // 자식은 반드시 "이 시험의 격리 sandbox"를 봐야 한다. 상위 SANDBOX 를 넘기면 임대를 못 찾아
  // verifyLease 에서 네트워크 전에 거절되고, 죽지도 않은 채 끝난다(엉뚱한 이유로 실패).
  const crashCode = `
    const { fetchOne } = await import(${JSON.stringify(path.join(LIB, 'fetch.mjs'))});
    for (let i = 0; i < 40; i++) {
      const r = await fetchOne('g2fault', { url: ${JSON.stringify(url)}, url_id: ${JSON.stringify(url_id)},
        lease_token: ${JSON.stringify(lease_token)}, kind: 'listing', maxTier: 'curl' });
      if (r.refused) { console.log('REFUSED:' + r.why); process.exit(2); }   // 임대를 못 봤다는 뜻
      if (!r.deferred) break;
      await new Promise((res) => setTimeout(res, ((r.wait_seconds || 1) * 1000) + 50));
    }
    console.log('NOT_REACHED');
  `;
  const cp = await import('node:child_process');
  const killed = cp.spawnSync(process.execPath, ['--input-type=module', '-e', crashCode], {
    env: { ...process.env, CLAUDE_PROJECT_DIR: SBOX, NODE_ENV: 'test', WEBSEARCH_FAULT_BEFORE_REQUEST: 'curl' },
    encoding: 'utf8',
  });
  const out = String(killed.stdout || '');
  const leaseSeen = !out.includes('REFUSED:');          // 죽기 전에 임대 검사를 통과했는가
  const died = killed.signal === 'SIGKILL' && !out.includes('NOT_REACHED') && leaseSeen;
  const afterCrash = pace5.peek(host).today_count;

  // 다음 호출은 이름표가 없으므로 정상 경로 — 카운트가 한 번 더 늘어야 한다(무계상 우회 금지)
  let r = null;
  for (let i = 0; i < 20; i++) {
    r = await fetchOne('g2fault', { url, url_id, lease_token, kind: 'listing', maxTier: 'curl' });
    if (!r.deferred) break;
    await new Promise((res) => setTimeout(res, ((r.wait_seconds || 1) * 1000) + 50));
  }
  const afterRetry = pace5.peek(host).today_count;

  check('L20', '네트워크 직전에 죽어도 permit 이 이미 소비돼, 다음 호출이 무계상으로 재요청하지 못한다',
    died && leaseSeen && afterCrash - before === 1 && afterRetry - afterCrash >= 1,
    `SIGKILL=${died}(signal=${killed.signal} code=${killed.status}) 임대통과=${leaseSeen} · today_count ${before}→${afterCrash}(죽은 뒤)→${afterRetry}(재시도 뒤)`
    + `${killed.stderr ? `\n      자식 stderr: ${String(killed.stderr).slice(0, 200)}` : ''}`
    + `${killed.stdout ? `\n      자식 stdout: ${String(killed.stdout).slice(0, 120)}` : ''}`);
});

// ---------- L21. permit 만료 계약 — 대기가 길면 만료되고 카운트는 과대계상 쪽으로 는다 ----------
await inFreshSandbox('ttl', async () => {
  const pace6 = await import(path.join(LIB, 'pace.mjs'));
  const dom = 'ttl-test.example';
  const key = 'crawlZ:urlZ:curl';
  const c0 = pace6.peek(dom).today_count;
  const a = pace6.reserve(dom, { min_interval_ms: 10, jitter_ms: 0, daily_cap: 100, permit_ttl_ms: 300 }, key);
  const c1 = pace6.peek(dom).today_count;
  const b = pace6.reserve(dom, { min_interval_ms: 10, jitter_ms: 0, daily_cap: 100, permit_ttl_ms: 300 }, key);  // 재사용
  const c2 = pace6.peek(dom).today_count;
  await new Promise((res) => setTimeout(res, 450));                                    // 만료 대기
  const c = pace6.reserve(dom, { min_interval_ms: 10, jitter_ms: 0, daily_cap: 100, permit_ttl_ms: 300 }, key);
  const c3 = pace6.peek(dom).today_count;

  // 기본 TTL 은 하루 경계를 넉넉히 넘겨야 한다 — 짧으면 긴 대기 중 원 도메인 한도를 헛되이 태운다.
  const dom2 = 'ttl-default.example';
  pace6.reserve(dom2, { min_interval_ms: 10, jitter_ms: 0, daily_cap: 100 }, 'k-default');
  const rec = pace6.peek(dom2);
  const defaultTtlHours = Math.round((rec.permits['k-default'].expires_at - rec.permits['k-default'].issued_at) / 3600_000);

  check('L21', 'permit 기본 만료는 26시간 이상(긴 대기 중 원 도메인 한도를 안 태운다) · 짧은 만료는 시험 override 로만',
    a.ok && b.reused_permit === true && c1 - c0 === 1 && c2 === c1
    && c.ok === true && c.reused_permit !== true && c3 - c2 === 1
    && defaultTtlHours >= 26,
    `1차 ok · 2차 재사용=${b.reused_permit} · 만료 후 3차 재사용=${c.reused_permit || false} · 카운트 ${c0}→${c1}→${c2}→${c3} · 기본 TTL ${defaultTtlHours}시간`);
});

// ---------- L17. 캡처는 덮어쓰지 않는다 ----------
{
  const r1 = await go(`${BASE}/listing-jsonld`, 'listing');
  // 같은 주소를 다시 임대해 다시 가져온다
  store.report('g2fix', [{ url_id: r1.url_id, lease_token: get(PAGES.listingJsonld).lease_token, state: 'queued' }]);
  const relz = store.lease('g2fix', 50, 'again');
  const again = relz.leased.find((x) => x.url_id === r1.url_id);
  let r2 = null;
  if (again) {
    for (let i = 0; i < 30; i++) {
      r2 = await fetchOne('g2fix', { url: again.url, url_id: again.url_id, lease_token: again.lease_token, kind: 'listing' });
      if (!r2.deferred) break;
      await new Promise((res) => setTimeout(res, ((r2.wait_seconds || 1) * 1000) + 50));
    }
  }
  const bothExist = r1.shot && r2?.shot && fs.existsSync(r1.shot) && fs.existsSync(r2.shot);
  check('L17', '같은 주소를 다시 가져와도 앞선 캡처를 덮어쓰지 않는다',
    bothExist && r1.shot !== r2.shot,
    `1차 ${r1.shot ? path.basename(r1.shot) : '없음'}\n      2차 ${r2?.shot ? path.basename(r2.shot) : '없음'}`);
}

// ---------- L18. 실제 크롬(channel:chrome, headless:false) 단이 로컬에서 실제로 돈다 ----------
{
  const { fetchWithBrowser } = await import(path.join(LIB, 'browser.mjs'));
  const r = await fetchWithBrowser(`${BASE}/listing-jsonld`, {
    tier: 'chrome', userAgent: 'gate2-chrome-smoke', crawl: 'g2fix', slug: 'chrome-smoke', captureId: 'smoke1',
  });
  const shotOk = r.shot && fs.existsSync(r.shot) && fs.statSync(r.shot).size > 1000;
  // 닫힘은 브라우저 스스로 증언하게 한다. 시스템의 크롬 프로세스 수를 세면 사용자가 창을 열고
  // 닫는 것만으로 결과가 흔들린다(2026-08-11: 11회 중 1회 간헐 실패의 유력 원인).
  check('L18', '실제 크롬 단이 로컬 fixture 로 실제 열리고 닫힌다(외부 사이트 아님)',
    r.status === 200 && (r.body || '').includes('class="card"') && shotOk && r.closed === true,
    `status=${r.status} body=${(r.body || '').length}자 shot=${shotOk ? path.basename(r.shot) : '없음'} closed=${r.closed}${r.error ? ` err=${r.error}` : ''}`);
}

// ---------- L19. MCP 왕복 — tools/list 에 fetch 가 있고 실제로 호출된다 ----------
{
  const server = path.join(HERE, '..', 'server.mjs');
  const reqs = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    // 간격을 일부러 크게 잡는다 — curl 뒤 visual 예약이 반드시 막혀 deferred 가 나고,
    // 그래야 "deferred → 대기 → 같은 lease_token 으로 재호출 → 최종" 고리가 실제로 돈다.
    // (작게 두면 curl 속도에 따라 deferred 가 났다 안 났다 해서 시험이 흔들린다.)
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'crawl_new', arguments: { crawl: 'mcpfetch', seeds: [`${BASE}/listing-jsonld`], policy: { min_interval_ms: 2000, interval_jitter_ms: 0 } } } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'lease', arguments: { crawl: 'mcpfetch', n: 1 } } },
  ];
  const out1 = await new Promise((resolve) => {
    const p = spawn(process.execPath, [server], { env: { ...process.env, CLAUDE_PROJECT_DIR: SANDBOX }, stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '';
    p.stdout.on('data', (d) => (buf += d));
    for (const r of reqs) p.stdin.write(JSON.stringify(r) + '\n');
    setTimeout(() => { p.stdin.end(); p.kill(); resolve(buf); }, 2000);
  });
  const msgs1 = out1.trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const byId1 = Object.fromEntries(msgs1.map((m) => [m.id, m]));
  const toolNames = (byId1[2]?.result?.tools || []).map((t) => t.name);
  const hasFetch = toolNames.includes('fetch');
  const leaseText = String(byId1[4]?.result?.content?.[0]?.text || '');
  const token = (leaseText.match(/token=([0-9a-f-]{36})/) || [])[1];

  // MCP 로 fetch 를 부른다. deferred 가 오면 남은 초를 기다렸다 같은 lease_token 으로 다시 부른다.
  // 마지막(최종 응답이 나올) 호출에서는 요청을 보내자마자 stdin 을 닫아,
  // 진행 중이던 응답이 버려지지 않는지 결정적으로 확인한다.
  // (앞서는 curl 이 간격보다 빨리 끝나면 deferred 가 최종 응답이 되어 시험이 흔들렸다 — 시간 의존.)
  const callFetch = (closeImmediately) => new Promise((resolve) => {
    const p = spawn(process.execPath, [server], { env: { ...process.env, CLAUDE_PROJECT_DIR: SANDBOX }, stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '';
    p.stdout.on('data', (d) => (buf += d));
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n');
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'fetch', arguments: { crawl: 'mcpfetch', url: `${BASE}/listing-jsonld`, lease_token: token, kind: 'listing', max_tier: 'headless' } } }) + '\n');
    if (closeImmediately) p.stdin.end();                // 진행 중 응답이 살아남아야 한다
    p.on('close', () => resolve(buf));
    setTimeout(() => { try { p.kill(); } catch {} resolve(buf); }, 90_000);
  });
  const readMsg = (txt) => {
    const m = txt.trim().split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).find((x) => x.id === 9);
    return String(m?.result?.content?.[0]?.text || '');
  };

  let ftext = '';
  let rounds = 0;
  let firstWasDeferred = null;
  const deferredTexts = [];
  if (token) {
    for (let i = 0; i < 12; i++) {
      rounds++;
      ftext = readMsg(await callFetch(true));           // 매 호출마다 stdin 을 바로 닫는다
      if (i === 0) firstWasDeferred = /^대기 \d+초/.test(ftext);
      if (!/^대기 \d+초/.test(ftext)) break;             // 최종 응답에 도달
      deferredTexts.push(ftext);
      const secs = Number((ftext.match(/^대기 (\d+)초/) || [])[1] || 1);
      await new Promise((res) => setTimeout(res, secs * 1000 + 200));
    }
  }
  const noBody = !ftext.includes('<html') && !ftext.includes('<!doctype') && ftext.length < 1200;
  const hasManifest = ftext.includes('manifest ');
  // deferred 응답도 짧고 본문이 없어야 한다
  const deferredClean = deferredTexts.every((t) => t.length < 400 && !t.includes('<html') && !t.includes('<!doctype'));

  check('L19', 'MCP 왕복 — deferred 를 실제로 거쳐 최종까지 가고, stdin 을 닫아도 응답이 살아남으며, 둘 다 본문 없이 요약만 온다',
    hasFetch && toolNames.length >= 13 && !!token && hasManifest && noBody && deferredClean
    && firstWasDeferred === true && rounds >= 2,   // 첫 응답은 deferred, 두 번째 이후 최종

    `tools=${toolNames.length}개(fetch=${hasFetch}) token=${token ? '발급' : '없음'} · 호출 ${rounds}회(첫 응답 deferred=${firstWasDeferred}, 중간 deferred ${deferredTexts.length}회)\n`
    + `      최종 응답 ${ftext.length}자 · manifest=${hasManifest} · 본문없음=${noBody} · deferred도 깨끗=${deferredClean}\n`
    + `      ${ftext.split('\n').slice(0, 2).join(' | ')}`);
}

// ---------- L22. MCP pace_reserve 를 domain 만 주고 불러도 기본값이 살아 있다 ----------
// (선택 인자를 그대로 넘기면 {min_interval_ms: undefined} 가 되어 기본값을 지우고
//  gap 이 NaN → next_allowed_at 이 null → 간격이 아예 안 걸렸다. 2026-08-11 매니저 감사.)
await inFreshSandbox('mcpdefault', async (SBOX) => {
  const server = path.join(HERE, '..', 'server.mjs');
  const out = await new Promise((resolve) => {
    const p = spawn(process.execPath, [server], { env: { ...process.env, CLAUDE_PROJECT_DIR: SBOX }, stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '';
    p.stdout.on('data', (d) => (buf += d));
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n');
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'pace_reserve', arguments: { domain: 'defaults.example' } } }) + '\n');
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'pace_reserve', arguments: { domain: 'defaults.example' } } }) + '\n');
    setTimeout(() => { p.stdin.end(); p.kill(); resolve(buf); }, 2500);
  });
  const byId = Object.fromEntries(out.trim().split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).map((m) => [m.id, m]));
  const first = String(byId[2]?.result?.content?.[0]?.text || '');
  const second = String(byId[3]?.result?.content?.[0]?.text || '');
  const noNaN = !first.includes('NaN') && first.includes('예약됨');
  const secondBlocked = second.includes('대기') && second.includes('interval');

  check('L22', 'MCP pace_reserve 를 domain 만 주고 불러도 기본 간격이 살아 있다(NaN 아님, 두 번째는 거절)',
    noNaN && secondBlocked,
    `1차: ${first.slice(0, 70)} / 2차: ${second.slice(0, 50)}`);
});

// ---------- L23. 차단 휴면이 보류 permit 을 이긴다 ----------
await inFreshSandbox('sleepwins', async () => {
  const p7 = await import(path.join(LIB, 'pace.mjs'));
  const dom = 'sleep-test.example';
  const key = 'crawlS:urlS:curl';
  const a = p7.reserve(dom, { min_interval_ms: 10, jitter_ms: 0, daily_cap: 100 }, key);   // 이름표 발급
  // 이 도메인에 차단 낌새를 쌓아 휴면으로 보낸다
  for (let i = 0; i < 3; i++) p7.record(dom, { blocked: true, opts: { block_threshold: 3, block_sleep_ms: 60_000 } });
  const sleeping = p7.peek(dom).sleep_until > Date.now();
  const b = p7.reserve(dom, { min_interval_ms: 10, jitter_ms: 0, daily_cap: 100 }, key);   // 이름표가 있어도 막혀야
  const permitKept = !!p7.peek(dom).permits?.[key];                                        // 이름표는 살아 있어야

  check('L23', '차단 휴면 중에는 보류 중인 permit 으로도 나갈 수 없다(단 permit 은 보존된다)',
    a.ok === true && sleeping && b.ok === false && b.why === 'domain_sleeping' && permitKept,
    `1차 발급=${a.ok} · 휴면=${sleeping} · 휴면 중 재요청 ok=${b.ok}(${b.why}) · 이름표 보존=${permitKept}`);
});

const passed = results.filter((r) => r.pass).length;
console.log(`\n${'='.repeat(60)}`);
console.log(`게이트 2(로컬): ${passed}/${results.length} 통과`);
for (const r of results.filter((x) => !x.pass)) console.log(`  실패 ${r.no}. ${r.name} — ${r.detail}`);
console.log(`샌드박스: ${SANDBOX}`);
bye();
process.exit(passed === results.length ? 0 : 1);
