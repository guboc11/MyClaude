#!/usr/bin/env node
// 게이트 4 — 크롤 굴리기. 계획서 4장 게이트 4 + 2026-08-11 매니저 구현 계약 6조.
//
// [원칙] 합격 판정은 전부 로컬 fixture 로만 한다. 외부 사이트에는 접속하지 않는다.
// [원칙] 부분 결과를 최종으로 채점하지 않는다 — 최종 상태까지 몰아붙인 뒤 본다(게이트 3의 교훈).
//
// 실행: WEBSEARCH_DEPS_DIR=<레포> node tests/gate4.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.join(HERE, '..', 'lib');
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'websearch-gate4-'));
process.env.CLAUDE_PROJECT_DIR = SANDBOX;

const results = [];
function check(no, name, pass, detail = '') {
  results.push({ no, name, pass, detail });
  console.log(`${pass ? 'O' : 'X'}  ${no}. ${name}${detail ? `\n      ${detail}` : ''}`);
}

const store = await import(path.join(LIB, 'store.mjs'));
const policyLib = await import(path.join(LIB, 'policy.mjs'));
const boundary = await import(path.join(LIB, 'boundary.mjs'));
const { normalizeUrl } = await import(path.join(LIB, 'url.mjs'));

const fx = spawn(process.execPath, [path.join(HERE, '..', 'fixtures', 'server.mjs')], { stdio: ['ignore', 'pipe', 'pipe'] });
const BASE = await new Promise((res) => fx.stdout.once('data', (d) => res(String(d).trim())));
const HOST = new URL(BASE).hostname;
console.log(`샌드박스: ${SANDBOX}\nfixture: ${BASE}\n`);
process.on('exit', () => {
  try { fx.kill(); } catch {}
  if (process.env.KEEP_SANDBOX !== '1') { try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch {} }
});

const FAST = { min_interval_ms: 5, interval_jitter_ms: 0, daily_cap: 5000, lease_ttl_ms: 300_000 };

// ---------- H1. exhaustive 와 pilot 은 애초에 다른 약속이다 ----------
{
  const tries = [];
  const t = (label, fn) => { try { fn(); tries.push(`${label}:통과됨(잘못)`); } catch (e) { tries.push(`${label}:거절(${e.message.slice(0, 30)})`); } };

  // exhaustive 는 "언제 그만둘지"를 못 정한다 — 정하는 순간 전수가 아니다
  t('목표개수', () => policyLib.validatePolicy({ mode: 'exhaustive', allow_domains: [HOST], target_count: 100 }));
  t('페이지예산', () => policyLib.validatePolicy({ mode: 'exhaustive', allow_domains: [HOST], max_pages: 50 }));
  t('시간예산', () => policyLib.validatePolicy({ mode: 'exhaustive', allow_domains: [HOST], time_budget_ms: 60_000 }));
  // exhaustive 는 범위가 정의돼 있어야 한다
  t('범위없음', () => policyLib.validatePolicy({ mode: 'exhaustive' }));
  // 허용과 제외에 같은 도메인
  t('허용제외충돌', () => policyLib.validatePolicy({ mode: 'pilot', allow_domains: ['a.test'], deny_domains: ['a.test'] }));
  // 값 범위
  t('간격음수', () => policyLib.validatePolicy({ mode: 'pilot', min_interval_ms: -1 }));
  t('상한0', () => policyLib.validatePolicy({ mode: 'pilot', domain_url_cap: 0 }));
  t('모드오타', () => policyLib.validatePolicy({ mode: 'exhausitve' }));

  const allRejected = tries.every((x) => !x.includes('통과됨'));

  const ex = policyLib.validatePolicy({ mode: 'exhaustive', allow_domains: [HOST] });
  const pi = policyLib.validatePolicy({ mode: 'pilot', target_count: 10, max_pages: 3 });
  const pilotSampled = pi.sampled === true && pi.target_count === 10;
  const exNotSampled = ex.sampled === false && ex.target_count === null;

  check('H1', 'exhaustive 는 목표 개수·시간·페이지로 끊을 수 없고 범위가 있어야 한다 (pilot 은 sampled 로 표시)',
    allRejected && pilotSampled && exNotSampled,
    `거절 ${tries.length}종: ${tries.join(' / ')}\n      exhaustive sampled=${ex.sampled} 목표=${ex.target_count} · pilot sampled=${pi.sampled} 목표=${pi.target_count}`);
}

// ---------- H2. 경계는 만들 때 고정된다 ----------
{
  store.createCrawl('h2', { seeds: [`${BASE}/listing-plain`], policy: { ...FAST, mode: 'exhaustive' } });
  const pol = store.loadPolicy('h2');
  // 씨앗이 있으면 허용 도메인이 씨앗에서 정해져 남는다
  const derived = (pol.allow_domains || []).includes(HOST);

  const WR = { who: 'gate4', reason: '시험' };
  const tries = [];
  const t = (label, fn) => { try { fn(); tries.push(`${label}:통과됨(잘못)`); } catch (e) { tries.push(`${label}:거절`); } };
  t('모드바꾸기', () => store.updatePolicy('h2', { mode: 'pilot' }, WR));
  t('허용도메인바꾸기', () => store.updatePolicy('h2', { allow_domains: ['other.test'] }, WR));
  t('제외도메인바꾸기', () => store.updatePolicy('h2', { deny_domains: ['x.test'] }, WR));
  t('who없이', () => store.updatePolicy('h2', { domain_url_cap: 9_999 }, { reason: 'x' }));
  t('reason없이', () => store.updatePolicy('h2', { domain_url_cap: 9_999 }, { who: 'x' }));
  const frozen = tries.every((x) => !x.includes('통과됨'));

  // 브레이크는 사람이 넓힐 수 있어야 한다(멈춘 자리에서 이어 달리려면)
  let widened = false;
  try { store.updatePolicy('h2', { domain_url_cap: 9_999 }, WR); widened = store.loadPolicy('h2').domain_url_cap === 9_999; } catch {}

  // 넓힌 근거가 이벤트로 남는다
  const ev = fs.readFileSync(path.join(SANDBOX, '.claude/web-search/h2/events.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map(JSON.parse).find((e) => e.type === 'policy_updated');
  const logged = ev?.who === 'gate4' && ev?.reason === '시험' && ev?.changes?.domain_url_cap?.to === 9_999;

  check('H2', '모드와 허용·제외 도메인은 만든 뒤 못 바꾸고, 제동 상한만 누가·왜와 함께 넓힐 수 있다',
    derived && frozen && widened && logged && store.loadPolicy('h2').mode === 'exhaustive',
    `씨앗에서 허용 도메인 정해짐=${derived} [${pol.allow_domains}] · 고정 ${tries.join(' / ')} · `
    + `상한 넓히기=${widened} · 근거 이벤트=${logged}(${ev?.changes?.domain_url_cap?.from}→${ev?.changes?.domain_url_cap?.to})`);
}

// ---------- H2b. 상한은 넓히기만, 예의(간격)는 줄일 수 없다 ----------
{
  store.createCrawl('h2b', {
    seeds: [], policy: { ...FAST, mode: 'pilot', domain_url_cap: 100, external_hop_max: 1, interval_jitter_ms: 100 },
  });
  const WR = { who: 'gate4', reason: '방향 시험' };
  const tries = [];
  const t = (label, fn) => { try { fn(); tries.push(`${label}:통과됨(잘못)`); } catch { tries.push(`${label}:거절`); } };
  t('상한낮추기', () => store.updatePolicy('h2b', { domain_url_cap: 10 }, WR));
  t('깊이낮추기', () => store.updatePolicy('h2b', { external_hop_max: 0 }, WR));
  t('간격줄이기', () => store.updatePolicy('h2b', { min_interval_ms: 1 }, WR));
  t('흔들림줄이기', () => store.updatePolicy('h2b', { interval_jitter_ms: 10 }, WR));   // 100 → 10 은 낮추기
  t('하루상한늘리기', () => store.updatePolicy('h2b', { daily_cap: 99_999 }, WR));
  const blocked = tries.every((x) => x.includes('거절'));

  let up = false;
  try { store.updatePolicy('h2b', { min_interval_ms: 50 }, WR); up = store.loadPolicy('h2b').min_interval_ms === 50; } catch {}
  let down = false;
  try { store.updatePolicy('h2b', { daily_cap: 10 }, WR); down = store.loadPolicy('h2b').daily_cap === 10; } catch {}

  check('H2b', '경계 상한은 넓히는 쪽으로만, 접속 간격은 늘리는 쪽으로만, 하루 상한은 줄이는 쪽으로만 바뀐다',
    blocked && up && down,
    `${tries.join(' / ')} · 간격 늘리기=${up} · 하루 상한 줄이기=${down}`);
}

// ---------- H3. 경계를 통과하지 못한 링크는 더미에 안 들어간다(사유는 남는다) ----------
{
  store.createCrawl('h3', {
    seeds: [`${BASE}/listing-plain`],
    policy: { ...FAST, mode: 'pilot', allow_domains: [HOST], deny_domains: ['evil.test'], external_hop_max: 0 },
  });
  const seedId = normalizeUrl(`${BASE}/listing-plain`).id;

  const r = store.addUrls('h3', [
    { url: `${BASE}/p/1`, kind: 'detail', via: 'link', from_url_id: seedId, discovered_by: 'link' },        // 같은 도메인 — 통과
    { url: 'http://evil.test/x', kind: 'unknown', via: 'link', from_url_id: seedId, discovered_by: 'link' }, // 제외 도메인
    { url: 'http://outside.test/y', kind: 'unknown', via: 'link', from_url_id: seedId, discovered_by: 'link' }, // 바깥 이동 금지
  ]);

  const st = store.loadState('h3');
  const urls = Object.values(st.urls).map((u) => u.url);
  const noEvil = !urls.some((u) => u.includes('evil.test'));
  const noOutside = !urls.some((u) => u.includes('outside.test'));
  const insideIn = urls.some((u) => u.endsWith('/p/1'));

  // 탈락은 조용히 사라지지 않는다 — 이벤트와 증거로 남는다
  const events = fs.readFileSync(path.join(SANDBOX, '.claude/web-search/h3/events.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse);
  const rejects = events.filter((e) => e.type === 'boundary_rejected');
  const evilWhy = rejects.find((e) => String(e.url).includes('evil.test'))?.why;
  const outWhy = rejects.find((e) => String(e.url).includes('outside.test'))?.why;

  check('H3', '경계를 통과 못 한 링크는 더미에 안 들어가고, 탈락 후보와 사유는 남는다',
    insideIn && noEvil && noOutside && r.rejected === 2 && rejects.length === 2
    && evilWhy === 'denied_domain' && outWhy === 'external_hop_exceeded',
    `안쪽 등록=${insideIn} · 제외 도메인 등록 안 됨=${noEvil} · 바깥 등록 안 됨=${noOutside} · `
    + `거절 ${r.rejected}건 / 이벤트 ${rejects.length}건 [${evilWhy}, ${outWhy}]`);
}

// ---------- H4. 깊이는 바깥으로 넘어갈 때만 올린다 ----------
{
  store.createCrawl('h4', {
    seeds: [`${BASE}/listing-plain`],
    policy: { ...FAST, mode: 'pilot', allow_domains: [HOST], external_hop_max: 1 },
  });
  const seedId = normalizeUrl(`${BASE}/listing-plain`).id;
  const seedHops = store.loadState('h4').urls[seedId]?.external_hops;

  // 같은 도메인 다섯 걸음 — 깊이가 안 오른다
  let cur = seedId;
  for (let i = 1; i <= 5; i++) {
    store.addUrls('h4', [{ url: `${BASE}/chain/${i}`, kind: 'unknown', via: 'link', from_url_id: cur, discovered_by: 'link' }]);
    cur = normalizeUrl(`${BASE}/chain/${i}`).id;
  }
  const deepInside = store.loadState('h4').urls[cur]?.external_hops;

  // 바깥으로 한 걸음 — 오른다. 거기서 또 한 걸음 — 막힌다.
  store.addUrls('h4', [{ url: 'http://out1.test/a', kind: 'unknown', via: 'link', from_url_id: cur, discovered_by: 'link' }]);
  const out1 = store.loadState('h4').urls[normalizeUrl('http://out1.test/a').id];
  const r2 = store.addUrls('h4', [{ url: 'http://out2.test/b', kind: 'unknown', via: 'link', from_url_id: normalizeUrl('http://out1.test/a').id, discovered_by: 'link' }]);
  const out2 = store.loadState('h4').urls[normalizeUrl('http://out2.test/b').id];

  check('H4', '같은 도메인 안에서는 깊이가 안 오르고, 바깥으로 넘어갈 때만 오른다',
    seedHops === 0 && deepInside === 0 && out1?.external_hops === 1 && !out2 && r2.rejected === 1,
    `씨앗 ${seedHops} · 같은 도메인 5걸음 뒤 ${deepInside} · 바깥 한 걸음 ${out1?.external_hops} · 바깥 두 걸음 등록=${!!out2}(거절 ${r2.rejected}건)`);
}

// ---------- H5. 기능성 파라미터는 살고 추적 파라미터는 죽는다(경계와 함께) ----------
{
  store.createCrawl('h5', {
    seeds: [], policy: { ...FAST, mode: 'pilot', keep_params_by_domain: { [HOST]: ['goodsNo'] } },
  });
  store.addUrls('h5', [
    { url: `${BASE}/goods?goodsNo=1&utm_source=z`, kind: 'detail', via: 'manual', discovered_by: 'seed' },
    { url: `${BASE}/goods?goodsNo=1`, kind: 'detail', via: 'manual', discovered_by: 'seed' },
    { url: `${BASE}/goods?goodsNo=2`, kind: 'detail', via: 'manual', discovered_by: 'seed' },
  ]);
  const urls = Object.values(store.loadState('h5').urls).map((u) => u.url);
  const goods = urls.filter((u) => u.includes('/goods'));
  check('H5', '기능성 파라미터로 갈리는 주소는 서로 다르게, 추적 파라미터만 다른 주소는 하나로',
    goods.length === 2 && !goods.some((u) => u.includes('utm_source')),
    `등록 ${goods.length}건: ${goods.map((u) => u.replace(BASE, '')).join(' , ')}`);
}

// ---------- H6. 같은 주소를 여러 번 넣어도 계수기는 한 번만 는다 ----------
{
  store.createCrawl('h6', {
    seeds: [], policy: { ...FAST, mode: 'pilot', domain_url_cap: 5, path_shape_cap: 3, query_combo_cap: 2, faceted_cap: 2 },
  });
  const one = `${BASE}/same?page=2`;
  for (let i = 0; i < 40; i++) {
    store.addUrls('h6', [{ url: one, kind: 'listing', via: 'manual', discovered_by: `probe-${i}` }]);
  }
  const st = store.loadState('h6');
  const dom = st.domains?.[HOST] || {};
  const rec = Object.values(st.urls)[0];
  const shapes = Object.values(dom.shapes || {});
  const combos = Object.values(dom.combos || {});
  const events = fs.readFileSync(path.join(SANDBOX, '.claude/web-search/h6/events.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map(JSON.parse);
  const noReject = !events.some((e) => e.type === 'boundary_rejected' || e.type === 'needs_boundary_review');

  check('H6', '같은 주소를 40번 넣어도 계수기는 1이고 상한에 걸리지 않는다 (발견 경로만 합쳐진다)',
    Object.keys(st.urls).length === 1 && dom.url_count === 1
    && shapes.every((v) => v === 1) && combos.every((v) => v === 1) && dom.faceted === 1
    && (rec.discovered_by || []).length === 40 && !dom.boundary_review && noReject,
    `주소 ${Object.keys(st.urls).length}개 · url_count=${dom.url_count} · 형태 [${shapes}] · 조합 [${combos}] · `
    + `거르개 ${dom.faceted} · 발견 경로 ${(rec.discovered_by || []).length}개 · 상한 세움=${!!dom.boundary_review} · 거절 이벤트 없음=${noReject}`);
}

// ---------- H7. 출처는 닫힌 목록이고, link·report 는 장부에 있는 부모를 대야 한다 ----------
{
  store.createCrawl('h7', {
    seeds: [`${BASE}/listing-plain`],
    policy: { ...FAST, mode: 'pilot', allow_domains: [HOST], external_hop_max: 2 },
  });
  const seedId = normalizeUrl(`${BASE}/listing-plain`).id;

  const r = store.addUrls('h7', [
    // 부모 없이 바깥 주소를 link 로 — "새 씨앗인 척" 하는 우회
    { url: 'http://sneak.test/a', kind: 'unknown', via: 'link', discovered_by: 'seed' },
    // 장부에 없는 부모를 댄 경우
    { url: 'http://sneak.test/b', kind: 'unknown', via: 'report', from_url_id: 'deadbeefdeadbeefdead', discovered_by: 'report' },
    // 출처 자체가 목록 밖
    { url: `${BASE}/ok-1`, kind: 'unknown', via: 'trustme', discovered_by: 'seed' },
    // 출처를 아예 안 준 경우
    { url: `${BASE}/ok-2`, kind: 'unknown', discovered_by: 'seed' },
    // 제대로 댄 경우 — 통과해야 한다(과잉 차단 방지)
    { url: `${BASE}/ok-3`, kind: 'unknown', via: 'link', from_url_id: seedId, discovered_by: 'link' },
  ]);
  const urls = Object.values(store.loadState('h7').urls).map((u) => u.url);
  const events = fs.readFileSync(path.join(SANDBOX, '.claude/web-search/h7/events.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map(JSON.parse).filter((e) => e.type === 'boundary_rejected');
  const whys = events.map((e) => e.why);
  const noSneak = !urls.some((u) => u.includes('sneak.test'));
  const okIn = urls.some((u) => u.endsWith('/ok-3'));
  const blockedOthers = !urls.some((u) => u.endsWith('/ok-1') || u.endsWith('/ok-2'));

  check('H7', '부모 없는 link·report 와 목록에 없는 출처는 거절된다 (discovered_by 문자열을 권한으로 믿지 않는다)',
    noSneak && blockedOthers && okIn && r.added === 1 && r.rejected === 4
    && whys.filter((w) => w === 'unknown_parent').length === 2
    && whys.filter((w) => w === 'bad_provenance').length === 2,
    `추가 ${r.added}건(=${urls.filter((u) => u.endsWith('/ok-3')).length}) · 거절 ${r.rejected}건 [${whys.join(', ')}] · `
    + `바깥 우회 막힘=${noSneak}`);
}

// ---------- H8. 범위 밖 씨앗과 겹치는 허용·제외는 만들 때 막고, 반쪽 폴더를 안 남긴다 ----------
{
  const dirOf = (c) => path.join(SANDBOX, '.claude/web-search', c);
  const tries = [];
  const t = (label, name, fn) => {
    try { fn(); tries.push(`${label}:통과됨(잘못)`); }
    catch { tries.push(`${label}:거절${fs.existsSync(dirOf(name)) ? '(폴더남음!)' : ''}`); }
  };
  t('범위밖씨앗', 'h8a', () => store.createCrawl('h8a', {
    seeds: ['http://elsewhere.test/x'], policy: { ...FAST, mode: 'pilot', allow_domains: [HOST] } }));
  t('제외된씨앗', 'h8b', () => store.createCrawl('h8b', {
    seeds: [`${BASE}/x`], policy: { ...FAST, mode: 'pilot', deny_domains: [HOST] } }));
  t('허용자식제외부모', 'h8c', () => store.createCrawl('h8c', {
    seeds: [], policy: { ...FAST, mode: 'pilot', allow_domains: ['shop.a.test'], deny_domains: ['a.test'] } }));
  t('도메인에스킴', 'h8d', () => store.createCrawl('h8d', {
    seeds: [], policy: { ...FAST, mode: 'pilot', allow_domains: ['https://a.test'] } }));
  t('도메인에경로', 'h8e', () => store.createCrawl('h8e', {
    seeds: [], policy: { ...FAST, mode: 'pilot', allow_domains: ['a.test/shop'] } }));
  t('도메인에포트', 'h8f', () => store.createCrawl('h8f', {
    seeds: [], policy: { ...FAST, mode: 'pilot', allow_domains: ['a.test:8080'] } }));
  t('도메인에공백', 'h8g', () => store.createCrawl('h8g', {
    seeds: [], policy: { ...FAST, mode: 'pilot', allow_domains: [' a.test'] } }));
  t('기능파라미터가문자열아님', 'h8h', () => store.createCrawl('h8h', {
    seeds: [], policy: { ...FAST, mode: 'pilot', keep_params_by_domain: { 'a.test': [1, 2] } } }));
  t('버릴파라미터가배열아님', 'h8i', () => store.createCrawl('h8i', {
    seeds: [], policy: { ...FAST, mode: 'pilot', drop_params: 'utm_source' } }));

  const allRejected = tries.every((x) => !x.includes('통과됨'));
  const noHalfDirs = !tries.some((x) => x.includes('폴더남음'));

  check('H8', '범위 밖 씨앗·겹치는 허용제외·도메인 아닌 값은 만들 때 막고, 반쪽 크롤 폴더를 안 남긴다',
    allRejected && noHalfDirs,
    `${tries.join(' / ')}`);
}

// ---------- H9. 상한에 걸린 후보는 주차되고, 넓히면 그 후보가 저절로 큐로 돌아온다 ----------
{
  const WR = (reason) => ({ who: 'gate4', reason });
  store.createCrawl('h9', { seeds: [], policy: { ...FAST, mode: 'pilot', domain_url_cap: 3 } });
  for (let i = 1; i <= 9; i++) {
    store.addUrls('h9', [{ url: `${BASE}/cap/${i}`, kind: 'unknown', via: 'manual', discovered_by: 'test' }]);
  }
  const before = store.loadState('h9');
  const rev = before.domains?.[HOST]?.boundary_review;
  const parked = Object.values(before.boundary_candidates || {});
  const parkedRight = parked.length === 6
    && parked.every((c) => c.why === 'domain_url_cap' && c.via === 'manual' && c.evidence && c.discovered_by.length);
  const stoppedAt3 = Object.keys(before.urls).length === 3;
  const raised = !!rev && rev.why === 'domain_url_cap';

  // 상관없는 상한을 넓혀도 후보는 그대로 세워져 있다
  store.updatePolicy('h9', { faceted_cap: 999 }, WR('상관없는 상한'));
  const s1 = store.loadState('h9');
  const stillRaised = !!s1.domains?.[HOST]?.boundary_review && Object.keys(s1.boundary_candidates).length === 6;

  // 조금만 넓히면 일부만 돌아오고 검토는 남는다
  const partial = store.updatePolicy('h9', { domain_url_cap: 5 }, WR('일부만 확인했다'));
  const s2 = store.loadState('h9');
  const partialRight = partial.readmitted_count === 2 && partial.still_waiting === 4
    && Object.keys(s2.urls).length === 5 && !!s2.domains?.[HOST]?.boundary_review;
  // 세워 둔 후보가 남아 있는 동안은 complete 가 아니다
  const midStatus = store.status('h9');
  const notCompleteWhileWaiting = midStatus.completion === 'paused_incomplete'
    && midStatus.boundary_candidates === 4;

  // 충분히 넓히면 남은 것이 전부 돌아오고 검토가 내려간다 — 수동으로 다시 넣지 않는다
  const full = store.updatePolicy('h9', { domain_url_cap: 50 }, WR('같은 형태가 아니라 실제 상품이라 넓힌다'));
  const s3 = store.loadState('h9');
  const all9 = Object.keys(s3.urls).length === 9
    && [1, 2, 3, 4, 5, 6, 7, 8, 9].every((i) => Object.values(s3.urls).some((u) => u.url.endsWith(`/cap/${i}`)));
  const emptied = Object.keys(s3.boundary_candidates).length === 0 && !s3.domains?.[HOST]?.boundary_review;
  const queued = Object.values(s3.urls).filter((u) => u.state === 'queued').length === 9;

  const ev = fs.readFileSync(path.join(SANDBOX, '.claude/web-search/h9/events.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map(JSON.parse);
  const admittedEv = ev.filter((e) => e.type === 'boundary_candidate_admitted');
  const clearEv = ev.find((e) => e.type === 'boundary_review_cleared');
  const grounded = admittedEv.length === 6 && admittedEv.every((e) => e.who === 'gate4' && e.reason)
    && !!clearEv?.who && !!clearEv?.reason;

  check('H9', '상한에 걸린 후보는 주차되고, 그 상한을 근거와 함께 넓히면 원래 후보가 저절로 큐로 돌아온다',
    stoppedAt3 && raised && parkedRight && stillRaised && partialRight && all9 && emptied && queued && grounded
    && notCompleteWhileWaiting,
    `상한 3에서 멈춤=${stoppedAt3} · 주차 ${parked.length}건(형식 맞음=${parkedRight}) · 상관없는 상한으로는 그대로=${stillRaised}\n`
    + `      5로 넓힘 → 복귀 ${partial.readmitted_count}건 남음 ${partial.still_waiting}건 검토 유지=${!!s2.domains?.[HOST]?.boundary_review}\n`
    + `      50으로 넓힘 → 전부 복귀=${all9} 주차 비었음=${emptied} 전부 대기 상태=${queued} · 복귀 이벤트 ${admittedEv.length}건(근거 있음=${grounded})`);
}

// ---------- H10. 두 프로세스가 동시에 넓혀도 서로의 변경을 잃지 않는다 ----------
{
  const WR = { who: 'gate4', reason: '동시 갱신 시험' };
  const child = (crawl, patchJson, startAt) => new Promise((resolve) => {
    const code = `
      const store = await import(${JSON.stringify(path.join(LIB, 'store.mjs'))});
      const startAt = Number(process.argv[2]);
      while (Date.now() < startAt) {}                       // 같은 순간에 들어가게 맞춘다
      try {
        store.updatePolicy(process.argv[1], JSON.parse(process.argv[3]), { who: 'p' + process.argv[4], reason: '동시' });
        console.log('OK');
      } catch (e) { console.log('ERR ' + e.message.slice(0, 40)); }
    `;
    const p = spawn(process.execPath, ['--input-type=module', '-e', code, crawl, String(startAt), patchJson, patchJson.length + ''],
      { env: { ...process.env, CLAUDE_PROJECT_DIR: SANDBOX }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', () => resolve({ out: out.trim(), err: err.trim() }));
  });

  // (가) 서로 다른 상한을 동시에 넓힌다 — 둘 다 남아야 한다
  store.createCrawl('h10a', { seeds: [], policy: { ...FAST, mode: 'pilot', domain_url_cap: 10, path_shape_cap: 10 } });
  const t1 = Date.now() + 400;
  const [a1, a2] = await Promise.all([
    child('h10a', JSON.stringify({ domain_url_cap: 100 }), t1),
    child('h10a', JSON.stringify({ path_shape_cap: 200 }), t1),
  ]);
  const polA = store.loadPolicy('h10a');
  const evA = fs.readFileSync(path.join(SANDBOX, '.claude/web-search/h10a/events.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map(JSON.parse).filter((e) => e.type === 'policy_updated');
  const bothKept = polA.domain_url_cap === 100 && polA.path_shape_cap === 200;
  const twoEvents = evA.length === 2
    && evA.some((e) => e.changes?.domain_url_cap?.from === 10 && e.changes?.domain_url_cap?.to === 100)
    && evA.some((e) => e.changes?.path_shape_cap?.from === 10 && e.changes?.path_shape_cap?.to === 200);

  // (나) 같은 상한을 서로 다른 값으로 동시에 — 옛 값 기준으로 낮은 쪽이 통과하면 안 된다
  store.createCrawl('h10b', { seeds: [], policy: { ...FAST, mode: 'pilot', domain_url_cap: 3 } });
  const t2 = Date.now() + 400;
  await Promise.all([
    child('h10b', JSON.stringify({ domain_url_cap: 50 }), t2),
    child('h10b', JSON.stringify({ domain_url_cap: 40 }), t2),
  ]);
  const polB = store.loadPolicy('h10b');
  const evB = fs.readFileSync(path.join(SANDBOX, '.claude/web-search/h10b/events.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map(JSON.parse).filter((e) => e.type === 'policy_updated');
  const endsAtMax = polB.domain_url_cap === 50;
  const neverWentDown = evB.every((e) => e.changes.domain_url_cap.to > e.changes.domain_url_cap.from);

  check('H10', '두 프로세스가 동시에 넓혀도 서로의 변경을 잃지 않고, 옛 값 기준으로 낮은 값이 끼어들지 못한다',
    bothKept && twoEvents && endsAtMax && neverWentDown && evB.length >= 1,
    `(가) 서로 다른 상한: url_cap=${polA.domain_url_cap} shape_cap=${polA.path_shape_cap} · 이벤트 ${evA.length}개 짝맞음=${twoEvents} [${a1.out} / ${a2.out}]\n`
    + `      (나) 같은 상한 경합: 최종 ${polB.domain_url_cap}(기대 50) · 적용 ${evB.length}건 모두 오름=${neverWentDown} `
    + `[${evB.map((e) => `${e.changes.domain_url_cap.from}→${e.changes.domain_url_cap.to}`).join(', ')}]`);
}

// ---------- H11. MCP 도 who·reason 없이는 정책을 못 바꾼다 ----------
{
  const server = path.join(HERE, '..', 'server.mjs');
  store.createCrawl('h11', { seeds: [], policy: { ...FAST, mode: 'pilot', domain_url_cap: 5 } });
  for (let i = 1; i <= 8; i++) store.addUrls('h11', [{ url: `${BASE}/m/${i}`, kind: 'unknown', via: 'manual', discovered_by: 't' }]);

  const out = await new Promise((resolve) => {
    const p = spawn(process.execPath, [server], { env: { ...process.env, CLAUDE_PROJECT_DIR: SANDBOX }, stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '';
    p.stdout.on('data', (d) => (buf += d));
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n');
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'update_policy', arguments: { crawl: 'h11', patch: { domain_url_cap: 50 } } } }) + '\n');
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'update_policy', arguments: { crawl: 'h11', patch: { domain_url_cap: 50 }, who: '  ', reason: '  ' } } }) + '\n');
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'update_policy', arguments: { crawl: 'h11', patch: { domain_url_cap: 50 }, who: 'manager', reason: '실제 상품이라 넓힌다' } } }) + '\n');
    p.stdin.end();
    p.on('close', () => resolve(buf));
    setTimeout(() => { try { p.kill(); } catch {} resolve(buf); }, 60_000);
  });
  const by = Object.fromEntries(out.trim().split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).map((m) => [m.id, m]));
  const names = (by[2]?.result?.tools || []).map((t) => t.name);
  const schema = (by[2]?.result?.tools || []).find((t) => t.name === 'update_policy')?.inputSchema;
  const schemaRequires = ['crawl', 'patch', 'who', 'reason'].every((k) => (schema?.required || []).includes(k))
    && schema?.properties?.who?.minLength === 1 && schema?.properties?.reason?.minLength === 1;
  const textOf = (m) => String(m?.result?.content?.[0]?.text || '') + String(m?.error?.message || '');
  const noWho = textOf(by[3]);
  const blankWho = textOf(by[4]);
  const good = textOf(by[5]);
  const runtimeRejects = /who|reason|필수|비워/.test(noWho) && /who|reason|비워/.test(blankWho)
    && !noWho.includes('정책 갱신') && !blankWho.includes('정책 갱신');
  const goodWorks = good.includes('정책 갱신') && /3건이 큐로 돌아갔/.test(good)
    && store.loadPolicy('h11').domain_url_cap === 50;

  check('H11', 'MCP 도 who·reason 없이는 경계를 못 넓힌다 — 스키마와 실제 동작 양쪽에서 막힌다',
    names.includes('update_policy') && schemaRequires && runtimeRejects && goodWorks,
    `스키마 필수 갖춤=${schemaRequires} · 안 주면 거절=${!noWho.includes('정책 갱신')} · 빈칸도 거절=${!blankWho.includes('정책 갱신')}\n`
    + `      제대로 주면: ${good.split('\n').slice(0, 3).join(' | ')}`);
}

// ---------- H12. 정책 판은 뒤로 가지 않고, 뒤진 정책으로는 판정 자체를 안 한다 ----------
{
  // (가) 넣기와 넓히기가 겹쳐도 끝난 자리가 어긋나지 않는다
  store.createCrawl('h12a', { seeds: [], policy: { ...FAST, mode: 'pilot', domain_url_cap: 3 } });
  const startAt = Date.now() + 500;
  const adder = `
    const store = await import(${JSON.stringify(path.join(LIB, 'store.mjs'))});
    const startAt = Number(process.argv[1]);
    while (Date.now() < startAt) {}
    for (let i = 1; i <= 20; i++) {
      store.addUrls('h12a', [{ url: process.argv[2] + '/race/' + i, kind: 'unknown', via: 'manual', discovered_by: 'r' }]);
    }
    console.log('ADDED');
  `;
  const widener = `
    const store = await import(${JSON.stringify(path.join(LIB, 'store.mjs'))});
    const startAt = Number(process.argv[1]);
    while (Date.now() < startAt + 20) {}
    store.updatePolicy('h12a', { domain_url_cap: 20 }, { who: 'widener', reason: '겹침 시험' });
    console.log('WIDENED');
  `;
  // 자식이 조용히 죽으면 원인이 가려진다. 종료 코드·신호·stderr 를 반드시 들고 온다.
  const run = (code, args) => new Promise((resolve) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', code, ...args],
      { env: { ...process.env, CLAUDE_PROJECT_DIR: SANDBOX }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (err += d));
    p.on('close', (code2, signal) => resolve({ out: out.trim(), err: err.trim(), code: code2, signal }));
  });
  const [ra, rw] = await Promise.all([
    run(adder, [String(startAt), BASE]),
    run(widener, [String(startAt)]),
  ]);
  // 마지막으로 한 번 더 건드려 남은 후보까지 따라잡게 한다
  store.addUrls('h12a', [{ url: `${BASE}/race/1`, kind: 'unknown', via: 'manual', discovered_by: 'r' }]);
  const s = store.loadState('h12a');
  const pol = store.loadPolicy('h12a');
  const raceUrls = Object.values(s.urls).filter((u) => /\/race\/\d+$/.test(u.url)).length;
  const noneStranded = Object.keys(s.boundary_candidates).length === 0;
  const versionForward = s.policy_seen_version === pol.policy_version && pol.policy_version === 2;
  const evText = fs.readFileSync(path.join(SANDBOX, '.claude/web-search/h12a/events.jsonl'), 'utf8');
  const noStale = !evText.includes('stale_policy_ignored');

  // (나) 장부가 앞서 있고 정책 파일이 뒤지면, 그 정책으로는 아무것도 판정하지 않는다
  store.createCrawl('h12b', { seeds: [], policy: { ...FAST, mode: 'pilot', deny_domains: ['evil.test'] } });
  const stPath = path.join(SANDBOX, '.claude/web-search/h12b/state.json');
  const st0 = JSON.parse(fs.readFileSync(stPath, 'utf8'));
  st0.policy_seen_version = 5;                       // 정책 파일(v1)보다 앞선 장부를 만든다
  fs.writeFileSync(stPath, JSON.stringify(st0, null, 2));
  const evBefore = fs.readFileSync(path.join(SANDBOX, '.claude/web-search/h12b/events.jsonl'), 'utf8');
  let threw = '';
  try {
    store.addUrls('h12b', [{ url: 'http://evil.test/x', kind: 'unknown', via: 'manual', discovered_by: 't' }]);
  } catch (e) { threw = e.message; }
  const evAfter = fs.readFileSync(path.join(SANDBOX, '.claude/web-search/h12b/events.jsonl'), 'utf8');
  const st1 = JSON.parse(fs.readFileSync(stPath, 'utf8'));
  // 판정이 아예 안 돌았다는 증거: 거절 이벤트조차 없고, 판 번호도 그대로다
  const noJudging = !threw.includes('undefined') && !!threw
    && evAfter === evBefore && st1.policy_seen_version === 5 && Object.keys(st1.urls).length === 0;

  const childrenOk = ra.code === 0 && rw.code === 0 && ra.out === 'ADDED' && rw.out === 'WIDENED';

  check('H12', '정책 판은 뒤로 가지 않고, 장부보다 뒤진 정책으로는 정규화·입장 판정을 시작조차 하지 않는다',
    childrenOk && raceUrls === 20 && noneStranded && versionForward && noStale && noJudging,
    `(가) 겹쳐 돌린 뒤: /race 등록 ${raceUrls}/20 · 세워 둔 후보 ${Object.keys(s.boundary_candidates).length}건 · `
    + `판 ${s.policy_seen_version}=${pol.policy_version} · 뒤진 정책 사용 없음=${noStale}\n`
    + `      자식: adder code=${ra.code} signal=${ra.signal} out="${ra.out}" err="${ra.err.split('\n').slice(-3).join(' / ')}"\n`
    + `      자식: widener code=${rw.code} signal=${rw.signal} out="${rw.out}" err="${rw.err.split('\n').slice(-3).join(' / ')}"\n`
    + `      (나) 장부가 앞설 때: 거절 메시지="${threw.slice(0, 40)}" · 이벤트 변화 없음=${evAfter === evBefore} · `
    + `등록 ${Object.keys(st1.urls).length}건 · 판 ${st1.policy_seen_version}(그대로)`);
}

// ---------- H13. 정책을 쓴 직후 죽어도 후보가 살아나고 누가·왜가 남는다 ----------
{
  store.createCrawl('h13', { seeds: [], policy: { ...FAST, mode: 'pilot', domain_url_cap: 3 } });
  for (let i = 1; i <= 6; i++) store.addUrls('h13', [{ url: `${BASE}/c/${i}`, kind: 'unknown', via: 'manual', discovered_by: 't' }]);
  const v0 = store.loadState('h13').version;

  const crash = `
    const store = await import(${JSON.stringify(path.join(LIB, 'store.mjs'))});
    store.updatePolicy('h13', { domain_url_cap: 50 }, { who: 'crashguy', reason: '실제 상품이라 넓힌다' });
    console.log('NOT_REACHED');
  `;
  const kid = await new Promise((resolve) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', crash], {
      env: { ...process.env, CLAUDE_PROJECT_DIR: SANDBOX, NODE_ENV: 'test', WEBSEARCH_FAULT: 'after_events' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('close', (c, sig) => resolve({ out: out.trim(), sig: sig || c }));
  });
  const killed = String(kid.sig) === 'SIGKILL' && !kid.out.includes('NOT_REACHED');

  // 파일은 앞서 갔고 장부는 못 따라온 상태
  const polMid = store.loadPolicy('h13');
  const stMid = store.loadState('h13');
  const midRight = polMid.policy_version === 2 && polMid.last_change?.who === 'crashguy'
    && polMid.last_change?.reason === '실제 상품이라 넓힌다'
    && stMid.version === v0 && stMid.policy_seen_version === 1
    && Object.keys(stMid.boundary_candidates).length === 3;

  // 다음 프로세스가 이어 붙인다
  store.addUrls('h13', [{ url: `${BASE}/c/7`, kind: 'unknown', via: 'manual', discovered_by: 't' }]);
  const stEnd = store.loadState('h13');
  const polEnd = store.loadPolicy('h13');
  const recovered = [1, 2, 3, 4, 5, 6, 7].every((i) => Object.values(stEnd.urls).some((u) => u.url.endsWith(`/c/${i}`)))
    && Object.keys(stEnd.boundary_candidates).length === 0;
  const notRolledBack = polEnd.policy_version === 2 && stEnd.policy_seen_version === 2;

  const ev = fs.readFileSync(path.join(SANDBOX, '.claude/web-search/h13/events.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map(JSON.parse);
  const tombstoned = ev.some((e) => e.type === 'orphan_events_rolled_back');
  const rec = ev.find((e) => e.type === 'policy_change_recovered');
  const auditKept = rec?.who === 'crashguy' && rec?.reason === '실제 상품이라 넓힌다'
    && rec?.from_version === 1 && rec?.to_version === 2
    && rec.v <= stEnd.version;                     // 무효 처리된 이벤트가 아니라 살아 있는 기록

  check('H13', '정책을 쓴 직후 죽어도 다음 프로세스가 후보를 살리고, 판을 되돌리지 않으며, 누가·왜를 지키다',
    killed && midRight && recovered && notRolledBack && tombstoned && auditKept,
    `죽음=${killed}(${kid.sig}) · 파일 v${polMid.policy_version} 장부 v${stMid.policy_seen_version} 세워 둔 후보 ${Object.keys(stMid.boundary_candidates).length}건\n`
    + `      복구: 전부 등록=${recovered} · 판 안 되돌림=${notRolledBack}(파일 ${polEnd.policy_version}, 장부 ${stEnd.policy_seen_version}) · `
    + `무효 표시=${tombstoned} · 감사 기록 보존=${auditKept}(${rec?.who}, "${rec?.reason}")`);
}

// ---------- H14. 정책 원문 항목이 실제로 검증되고 저장된다 ----------
{
  const tries = [];
  const t = (label, fn) => { try { fn(); tries.push(`${label}:통과됨(잘못)`); } catch { tries.push(`${label}:거절`); } };
  t('무늬가정규식', () => policyLib.validatePolicy({ mode: 'pilot', listing_path_patterns: ['^/products/(.*)+$'] }));
  t('무늬에별표섞기', () => policyLib.validatePolicy({ mode: 'pilot', detail_path_patterns: ['/pro*ducts/x'] }));
  t('무늬가슬래시로안시작', () => policyLib.validatePolicy({ mode: 'pilot', listing_path_patterns: ['products/*'] }));
  t('낱말을거르개로', () => policyLib.validatePolicy({ mode: 'pilot', required_words: ['청첩장'], required_words_role: 'filter' }));
  t('휴면기준0', () => policyLib.validatePolicy({ mode: 'pilot', block_threshold: 0 }));
  t('없는프로필참조', () => policyLib.validatePolicy({ mode: 'pilot', domain_profile_ref: 'no-such-crawl' }));
  const rejected = tries.every((x) => !x.includes('통과됨'));

  const pol = policyLib.validatePolicy({
    mode: 'pilot',
    listing_path_patterns: ['/products/*', '/collections/**'],
    detail_path_patterns: ['/products/*/detail'],
    required_words: ['청첩장', 'invitation'],
    block_threshold: 2, block_sleep_ms: 60_000, retry_backoff_ms: 5_000,
  });
  const stored = pol.listing_path_patterns.length === 2 && pol.detail_path_patterns.length === 1
    && pol.required_words.length === 2 && pol.required_words_role === 'review_signal_only'
    && pol.block_threshold === 2 && pol.block_sleep_ms === 60_000 && pol.retry_backoff_ms === 5_000;

  // 프로필이 내놓는 모양 그대로 판정된다 — 정규식으로 읽으면 여기서 어긋난다
  const c1 = boundary.classifyByPolicy(pol, `${BASE}/products/abc`);
  const c2 = boundary.classifyByPolicy(pol, `${BASE}/collections/spring/2026`);
  const c3 = boundary.classifyByPolicy(pol, `${BASE}/products/abc/detail`);
  const c4 = boundary.classifyByPolicy(pol, `${BASE}/notice/1`);
  const c5 = boundary.classifyByPolicy(pol, `${BASE}/products/abc/extra`);   // * 는 한 조각만
  const classifies = c1.kind === 'listing' && c2.kind === 'listing' && c3.kind === 'detail'
    && c4.kind === null && c5.kind === null;

  check('H14', '목록·상세 무늬·필수 낱말·휴면 기준이 정책에 검증되어 저장되고, 프로필과 같은 문법으로 판정된다',
    rejected && stored && classifies,
    `거절 ${tries.length}종: ${tries.join(' / ')}\n`
    + `      저장=${stored} · /products/abc→${c1.kind} · /collections/spring/2026→${c2.kind} · `
    + `/products/abc/detail→${c3.kind} · /notice/1→${c4.kind} · /products/abc/extra→${c5.kind}(한 조각만)`);
}

// ---------- H15. 정책의 물러남 폭이 pace 에 실제로 쓰인다(휴면은 H19 에서 실제 fetch 로) ----------
{
  const pace = await import(path.join(LIB, 'pace.mjs'));
  const opts = { block_threshold: 2, block_sleep_ms: 45_000, retry_backoff_ms: 3_000, min_interval_ms: 5, jitter_ms: 0 };
  // 벽시계 차이를 재면 기계가 잠깐 밀릴 때 값이 흔들린다. 기록된 물러남 폭을 그대로 본다.
  const dom2 = `h15b-${Date.now()}.test`;
  pace.record(dom2, { failed: true, opts });
  const back1 = pace.peek(dom2).last_backoff_ms;
  pace.record(dom2, { failed: true, opts });
  const back2 = pace.peek(dom2).last_backoff_ms;
  const backedOff = back1 === 3_000 && back2 === 6_000;                                  // 정책 3초 → 두 배

  // [보조] 정책이 fetch 를 거쳐 그대로 넘어가는지 소스로도 한 번 본다(주 증거는 H19 의 실제 동작이다)
  const fetchSrc = fs.readFileSync(path.join(LIB, 'fetch.mjs'), 'utf8');
  const wired = /block_threshold:\s*opts\.paceOpts\?\.block_threshold\s*\?\?\s*pol\.block_threshold/.test(fetchSrc)
    && /pace\.record\([^)]*opts:\s*paceOpts/.test(fetchSrc);

  check('H15', '정책의 물러나는 간격이 기본값이 아니라 그대로 쓰인다',
    backedOff && wired,
    `기록된 물러남 ${back1}ms → ${back2}ms(정책 3초에서 두 배, 기본이면 60000ms) · `
    + `fetch 가 정책을 넘김(보조 확인)=${wired}`);
}

// ---------- H16. 필수 낱말은 실제 수집 경로에서 신호로만 남는다(버리지 않는다) ----------
{
  store.createCrawl('h16', {
    seeds: [], policy: { ...FAST, mode: 'pilot', min_interval_ms: 0, interval_jitter_ms: 0, required_words: ['청첩장'] },
  });
  const { fetchOne } = await import(path.join(LIB, 'fetch.mjs'));
  // /listing-plain 에는 낱말이 있고, /img-only 에는 글자가 거의 없다
  const targets = [`${BASE}/listing-plain`, `${BASE}/img-only`];
  store.addUrls('h16', targets.map((u) => ({ url: u, kind: 'listing', via: 'manual', discovered_by: 't' })));
  const leased = store.lease('h16', 5, 'w').leased;
  let exposedBody = false;
  for (const l of leased) {
    const r = await fetchOne('h16', { url: l.url, url_id: l.url_id, lease_token: l.lease_token, kind: 'listing', maxTier: 'curl' });
    // 워커가 report 에 본문을 싣지 않는다 — 낱말 판정은 이미 fetch 가 해 두었다
    const rep = store.report('h16', [{ url_id: l.url_id, lease_token: l.lease_token, state: r.page_validity === 'invalid' ? 'invalid' : 'fetched' }]);
    if (rep.accepted !== 1) exposedBody = true;
  }
  const st = store.loadState('h16');
  const plain = Object.values(st.urls).find((u) => u.url.endsWith('/listing-plain'));
  const imgOnly = Object.values(st.urls).find((u) => u.url.endsWith('/img-only'));
  const s = store.status('h16');
  const kept = !!plain && !!imgOnly && imgOnly.state !== 'excluded';
  const signalOnly = !!imgOnly?.review_required && imgOnly.review_required.why === 'required_words_missing'
    && !plain?.review_required && (plain?.matched_words || []).includes('청첩장');
  const queryable = s.review_required === 1 && s.review_required_sample[0]?.url.endsWith('/img-only');

  check('H16', '필수 낱말이 없어도 큐에서 사라지지 않고, 실제 수집 경로에서 검토 신호로 남아 조회된다',
    !exposedBody && kept && signalOnly && queryable,
    `낱말 있는 쪽: 상태 ${plain?.state} 맞은 낱말 [${plain?.matched_words}] · `
    + `이미지 위주 쪽: 상태 ${imgOnly?.state} 검토 신호 ${imgOnly?.review_required?.why}\n`
    + `      status 검토 대기 ${s.review_required}건 (${s.review_required_sample[0]?.url?.replace(BASE, '')}) · 본문은 report 로 넘기지 않음`);
}

// ---------- H16b. 낱말 판정은 그 임대의 것만 쓴다 ----------
{
  const { fetchOne } = await import(path.join(LIB, 'fetch.mjs'));
  store.createCrawl('h16b', {
    seeds: [], policy: { ...FAST, mode: 'pilot', min_interval_ms: 0, interval_jitter_ms: 0, required_words: ['청첩장'], lease_ttl_ms: 1_000 },
  });
  store.addUrls('h16b', [{ url: `${BASE}/img-only`, kind: 'listing', via: 'manual', discovered_by: 't' }]);

  // 1) 첫 임대에서 가져오기만 하고 반납하지 않는다 — 판정은 이 임대에 묶여 남는다
  const a = store.lease('h16b', 1, 'w1').leased[0];
  await fetchOne('h16b', { url: a.url, url_id: a.url_id, lease_token: a.lease_token, kind: 'listing', maxTier: 'curl' });
  const wordsFile = path.join(SANDBOX, '.claude/web-search/h16b/manifests', a.url_id, 'notes', 'words.json');
  const w = JSON.parse(fs.readFileSync(wordsFile, 'utf8'));
  const boundToLease = w.lease_token === a.lease_token && w.missing === true;

  // 2) 임대가 만료돼 다른 워커가 받아 가고, 새로 가져오지 않은 채 반납한다
  await new Promise((res) => setTimeout(res, 1_200));
  const b = store.lease('h16b', 1, 'w2').leased[0];
  const reassigned = !!b && b.lease_token !== a.lease_token;
  const rep = store.report('h16b', [{ url_id: b.url_id, lease_token: b.lease_token, state: 'fetched' }]);
  const afterStale = store.loadState('h16b').urls[b.url_id];
  const staleNotUsed = rep.accepted === 1 && !afterStale.review_required && !afterStale.matched_words;

  // 3) 이번 임대로 실제로 가져온 뒤 반납하면 그때는 적용된다
  store.requeue('h16b', [b.url_id], 'h16b_recheck');
  const c = store.lease('h16b', 1, 'w3').leased[0];
  await fetchOne('h16b', { url: c.url, url_id: c.url_id, lease_token: c.lease_token, kind: 'listing', maxTier: 'curl' });
  store.report('h16b', [{ url_id: c.url_id, lease_token: c.lease_token, state: 'fetched' }]);
  const afterFresh = store.loadState('h16b').urls[c.url_id];
  const freshApplied = afterFresh.review_required?.why === 'required_words_missing';

  check('H16b', '낱말 판정은 그 임대에서 실제로 가져온 것만 쓴다 — 옛 임대의 판정은 새 보고에 안 붙는다',
    boundToLease && reassigned && staleNotUsed && freshApplied,
    `판정이 임대에 묶임=${boundToLease} · 만료 후 재배정=${reassigned} · `
    + `안 가져오고 반납했을 때 검토 신호=${afterStale.review_required?.why ?? '없음'}(기대 없음) · `
    + `제대로 가져온 뒤 반납했을 때=${afterFresh.review_required?.why ?? '없음'}(기대 required_words_missing)`);
}

// ---------- H18. 무늬는 실제 큐 기록의 종류를 정하고, 고정한 판은 원본이 바뀌어도 안 흔들린다 ----------
{
  const disc = await import(path.join(LIB, 'discover.mjs'));

  // (가) 크롤 전체 무늬가 실제 장부 기록에 적용된다
  store.createCrawl('h18', {
    seeds: [], policy: { ...FAST, mode: 'pilot', detail_path_patterns: ['/products/*'], listing_path_patterns: ['/collections/*'] },
  });
  store.addUrls('h18', [
    { url: `${BASE}/products/abc`, via: 'manual', discovered_by: 't' },                       // kind 안 줌
    { url: `${BASE}/collections/spring`, via: 'manual', discovered_by: 't' },
    { url: `${BASE}/products/xyz`, kind: 'listing', via: 'manual', discovered_by: 't' },      // 명시 kind
    { url: `${BASE}/notice/1`, via: 'manual', discovered_by: 't' },
  ]);
  const u = (suffix) => Object.values(store.loadState('h18').urls).find((x) => x.url.endsWith(suffix));
  const byPolicy = u('/products/abc')?.kind === 'detail' && u('/products/abc')?.kind_source === 'policy'
    && u('/collections/spring')?.kind === 'listing'
    && u('/products/xyz')?.kind === 'listing' && u('/products/xyz')?.kind_source === 'given'
    && u('/notice/1')?.kind === 'unknown';

  // (나) 확정된 프로필을 고정해 쓰면 그 판으로 판정하고, 원본이 나중에 바뀌어도 안 변한다
  store.createCrawl('h18src', { seeds: [], policy: { ...FAST, mode: 'pilot' } });
  disc.proposeProfile('h18src', HOST, { detailSamples: [`${BASE}/goods/abc`], listingSamples: [`${BASE}/shop/all`] });
  disc.confirmProfile('h18src', HOST, { who: 'gate4', reason: '카드 묶음 확인' });

  store.createCrawl('h18pin', { seeds: [], policy: { ...FAST, mode: 'pilot', domain_profile_ref: 'h18src' } });
  const pinned = store.loadPolicy('h18pin').domain_profile_pinned;
  const pinnedRight = pinned?.from === 'h18src'
    && (pinned.profiles?.[HOST]?.detail_path_patterns || []).includes('/goods/*')
    && typeof pinned.profiles?.[HOST]?.source_sha256 === 'string';

  store.addUrls('h18pin', [{ url: `${BASE}/goods/one`, via: 'manual', discovered_by: 't' }]);
  const first = Object.values(store.loadState('h18pin').urls).find((x) => x.url.endsWith('/goods/one'));
  const usedPinned = first?.kind === 'detail' && first?.kind_source === `profile:${HOST}`;

  // 원본 프로필을 바꿔 버린다 — 고정해 둔 크롤의 판정은 그대로여야 한다
  const profFile = path.join(SANDBOX, '.claude/web-search/h18src/domain-profiles', `${HOST.replace(/[^a-z0-9.-]/gi, '_')}.json`);
  const orig = JSON.parse(fs.readFileSync(profFile, 'utf8'));
  fs.writeFileSync(profFile, JSON.stringify({ ...orig, detail_path_patterns: ['/entirely-different/*'] }, null, 2));
  store.addUrls('h18pin', [{ url: `${BASE}/goods/two`, via: 'manual', discovered_by: 't' }]);
  const second = Object.values(store.loadState('h18pin').urls).find((x) => x.url.endsWith('/goods/two'));
  const stillPinned = second?.kind === 'detail' && second?.kind_source === `profile:${HOST}`;

  check('H18', '무늬가 실제 큐 기록의 종류를 정하고(명시 kind 는 안 덮음), 고정한 프로필 판은 원본이 바뀌어도 안 흔들린다',
    byPolicy && pinnedRight && usedPinned && stillPinned,
    `(가) /products/abc→${u('/products/abc')?.kind}(${u('/products/abc')?.kind_source}) · /collections/spring→${u('/collections/spring')?.kind} · `
    + `명시 kind 보존=${u('/products/xyz')?.kind}(${u('/products/xyz')?.kind_source}) · /notice/1→${u('/notice/1')?.kind}\n`
    + `      (나) 고정 [${pinned?.profiles?.[HOST]?.detail_path_patterns}] 해시 있음=${!!pinned?.profiles?.[HOST]?.source_sha256} · `
    + `첫 판정 ${first?.kind}(${first?.kind_source}) · 원본 바꾼 뒤 ${second?.kind}(${second?.kind_source})`);
}

// ---------- H17. 제외 기록은 조회되고, 제대로 된 부모로 다시 오면 해소된다 ----------
{
  store.createCrawl('h17', {
    seeds: [`${BASE}/listing-plain`],
    policy: { ...FAST, mode: 'pilot', allow_domains: [HOST, 'partner.test'], external_hop_max: 0 },
  });
  const seedId = normalizeUrl(`${BASE}/listing-plain`).id;
  // 바깥 이동 한도 0 — 허용 목록 밖 도메인에서 온 부모를 통해서는 못 들어온다
  store.addUrls('h17', [{ url: 'http://far.test/a', kind: 'unknown', via: 'link', from_url_id: seedId, discovered_by: 'link' }]);
  // partner.test 는 허용 목록 안이라 들어온다. 거기서 far.test 로는 여전히 못 간다.
  store.addUrls('h17', [{ url: 'http://partner.test/p', kind: 'unknown', via: 'link', from_url_id: seedId, discovered_by: 'link' }]);

  const ex1 = store.listExcluded('h17');
  const st1 = store.status('h17');
  const parked = ex1.active.length === 1 && ex1.active[0].url === 'http://far.test/a'
    && ex1.active[0].why === 'external_hop_exceeded' && !!ex1.active[0].evidence
    && ex1.active[0].from_url_id === seedId;
  const visible = st1.excluded_active === 1 && st1.excluded_sample[0]?.why === 'external_hop_exceeded';
  const notInLedger = !Object.values(store.loadState('h17').urls).some((u) => u.url.includes('far.test'));

  // 같은 주소가 이번엔 허용 목록 안 부모에서, 그리고 far.test 도 허용에 들어온 뒤 발견된다
  store.updatePolicy('h17', { external_hop_max: 1 }, { who: 'gate4', reason: '한 걸음까지는 본다' });
  const partnerId = normalizeUrl('http://partner.test/p').id;
  store.addUrls('h17', [{ url: 'http://far.test/a', kind: 'unknown', via: 'link', from_url_id: partnerId, discovered_by: 'link2' }]);

  const st2 = store.loadState('h17');
  const ex2 = store.listExcluded('h17');
  const nowIn = Object.values(st2.urls).find((u) => u.url === 'http://far.test/a');
  const resolvedRight = ex2.active.length === 0 && ex2.resolved.length === 1
    && ex2.resolved[0].resolved_via === 'link' && ex2.resolved[0].resolved_from_url_id === partnerId
    && ex2.resolved[0].history.some((h) => h.action === 'excluded')
    && ex2.resolved[0].history.some((h) => h.action === 'readmitted');
  const s2 = store.status('h17');

  check('H17', '정책상 제외는 더미에 안 들어가되 조회되고, 나중에 제대로 된 길로 오면 해소 이력으로 남는다',
    parked && visible && notInLedger && nowIn?.state === 'queued' && resolvedRight
    && s2.excluded_active === 0 && s2.excluded_resolved === 1,
    `처음: 활성 제외 ${ex1.active.length}건(${ex1.active[0]?.why}) · 더미에 없음=${notInLedger} · status 노출=${visible}\n`
    + `      나중: 상태 ${nowIn?.state} · 활성 제외 ${s2.excluded_active}건 · 해소 이력 ${s2.excluded_resolved}건 `
    + `(${ex2.resolved[0]?.history?.map((h) => h.action).join('→')})`);
}

// ---------- H19. 실제 403 을 두 번 맞으면 정책이 정한 만큼 쉰다 ----------
// [순서] pace 장부는 도메인 단위라 이 시험이 fixture 도메인을 재운다. 그래서 맨 뒤에 둔다.
{
  const pace = await import(path.join(LIB, 'pace.mjs'));
  const paths = await import(path.join(LIB, 'paths.mjs'));
  const { fetchOne } = await import(path.join(LIB, 'fetch.mjs'));
  const paceFile = paths.paceFile(HOST);
  try { fs.rmSync(paceFile, { force: true }); } catch {}          // 앞선 시험이 남긴 자취를 지우고 시작

  // 같은 도메인을 연달아 두드리는 시험이다. 간격이 남아 있으면 두 번째가 403 이 아니라
  // "간격 때문에 미룸"으로 돌아와 시험이 흔들린다(2026-08-11 간헐 실패의 원인).
  store.createCrawl('h19', {
    seeds: [], policy: { ...FAST, mode: 'pilot', min_interval_ms: 0, interval_jitter_ms: 0, block_threshold: 2, block_sleep_ms: 60_000 },
  });
  store.addUrls('h19', [
    { url: `${BASE}/forbidden?a=1`, kind: 'unknown', via: 'manual', discovered_by: 't' },
    { url: `${BASE}/forbidden?a=2`, kind: 'unknown', via: 'manual', discovered_by: 't' },
  ]);
  const leased = store.lease('h19', 2, 'w').leased;
  const seen = [];
  for (const l of leased) {
    const r = await fetchOne('h19', { url: l.url, url_id: l.url_id, lease_token: l.lease_token, kind: 'unknown', maxTier: 'curl' });
    const p = pace.peek(HOST);
    // 안 자는 상태는 sleep_until 이 0 이라 그대로 빼면 뜻 없는 음수가 찍힌다
    seen.push({
      status: r.status, deferred: !!r.deferred, calls: r.network_calls,
      block_score: p.block_score, sleep_in: Math.max(0, Math.round((p.sleep_until - Date.now()) / 1000)),
    });
  }
  const got403 = seen.length === 2 && seen.every((s) => s.status === 403 && !s.deferred && s.calls === 1);
  const firstNoSleep = seen[0]?.block_score === 1 && seen[0]?.sleep_in === 0;
  const secondSleeps = seen[1]?.sleep_in > 50 && seen[1]?.sleep_in <= 60;   // 기본 3시간이 아니라 정책의 60초

  try { fs.rmSync(paceFile, { force: true }); } catch {}          // 뒤에 올 시험을 재우지 않는다
  check('H19', '실제로 403 을 맞으면 정책이 정한 기준에서 정책이 정한 만큼 쉰다(기본값이 아니라)',
    got403 && firstNoSleep && secondSleeps,
    `1회차: 상태 ${seen[0]?.status} 네트워크 ${seen[0]?.calls}회 미룸=${seen[0]?.deferred} 차단점수 ${seen[0]?.block_score} 휴면 ${seen[0]?.sleep_in}초 · `
    + `2회차: 상태 ${seen[1]?.status} 네트워크 ${seen[1]?.calls}회 미룸=${seen[1]?.deferred} 휴면 ${seen[1]?.sleep_in}초(정책 60초, 기본이면 10800초)`);
}

// ---------- H20. 넓힐 때도 만들 때와 같은 범위를 지킨다 ----------
{
  store.createCrawl('h20', { seeds: [], policy: { ...FAST, mode: 'pilot' } });
  const WR = { who: 'gate4', reason: '범위 시험' };
  const tries = [];
  const t = (label, fn) => { try { fn(); tries.push(`${label}:통과됨(잘못)`); } catch { tries.push(`${label}:거절`); } };
  t('휴면터무니없이김', () => store.updatePolicy('h20', { block_sleep_ms: 10 ** 15 }, WR));
  t('재시도횟수과다', () => store.updatePolicy('h20', { max_attempts: 10 ** 9 }, WR));
  t('가지깊이과다', () => store.updatePolicy('h20', { sitemap_depth_max: 10_000 }, WR));
  t('임대시간과다', () => store.updatePolicy('h20', { lease_ttl_ms: 10 ** 12 }, WR));
  t('바깥깊이과다', () => store.updatePolicy('h20', { external_hop_max: 99 }, WR));
  t('정수아님', () => store.updatePolicy('h20', { domain_url_cap: 1.5 }, WR));
  t('빈갱신', () => store.updatePolicy('h20', {}, WR));
  const allRejected = tries.every((x) => !x.includes('통과됨'));
  const versionUntouched = store.loadPolicy('h20').policy_version === 1;

  // 범위 안이면 통과한다(과잉 차단 방지)
  let ok = false;
  // 기본이 3시간이므로 그보다 긴 값이라야 "넓히기"다
  try { store.updatePolicy('h20', { block_sleep_ms: 14_400_000 }, WR); ok = store.loadPolicy('h20').block_sleep_ms === 14_400_000; } catch {}
  const defaultsMatchPace = policyLib.validatePolicy({ mode: 'pilot' }).block_sleep_ms === 3 * 60 * 60 * 1000;
  let backoffZero = false;
  try { policyLib.validatePolicy({ mode: 'pilot', retry_backoff_ms: 0 }); } catch { backoffZero = true; }

  check('H20', '넓힐 때도 만들 때와 같은 형식·최소·최대를 지키고, 빈 갱신으로 판만 올리지 못한다',
    allRejected && versionUntouched && ok && defaultsMatchPace && backoffZero,
    `${tries.join(' / ')}\n      거절된 뒤 판 그대로=${versionUntouched} · 범위 안은 통과=${ok} · `
    + `휴면 기본 3시간=${defaultsMatchPace} · 물러남 0 거절=${backoffZero}`);
}

// ---------- H21. 숨은 글자로 검토 신호를 지우지 않는다 ----------
{
  const { fetchOne } = await import(path.join(LIB, 'fetch.mjs'));
  // 같은 도메인 연속 fetch — 간격을 0 으로 두지 않으면 두 번째가 미뤄져 흔들린다
  store.createCrawl('h21', { seeds: [], policy: { ...FAST, mode: 'pilot', min_interval_ms: 0, interval_jitter_ms: 0, required_words: ['청첩장'] } });
  store.addUrls('h21', [
    { url: `${BASE}/words-in-script`, kind: 'listing', via: 'manual', discovered_by: 't' },
    { url: `${BASE}/listing-plain`, kind: 'listing', via: 'manual', discovered_by: 't' },
  ]);
  for (const l of store.lease('h21', 2, 'w').leased) {
    await fetchOne('h21', { url: l.url, url_id: l.url_id, lease_token: l.lease_token, kind: 'listing', maxTier: 'curl' });
    store.report('h21', [{ url_id: l.url_id, lease_token: l.lease_token, state: 'fetched' }]);
  }
  const st = store.loadState('h21');
  const hidden = Object.values(st.urls).find((u) => u.url.endsWith('/words-in-script'));
  const real = Object.values(st.urls).find((u) => u.url.endsWith('/listing-plain'));
  check('H21', 'script·주석에만 있는 낱말로는 검토 신호가 지워지지 않는다(보이는 글자만 본다)',
    hidden?.review_required?.why === 'required_words_missing' && !hidden?.matched_words
    && !real?.review_required && (real?.matched_words || []).includes('청첩장'),
    `숨은 낱말 쪽: 검토 신호 ${hidden?.review_required?.why ?? '없음'}(기대 required_words_missing) 맞은 낱말 [${hidden?.matched_words ?? ''}] · `
    + `실제 본문 쪽: 검토 신호 ${real?.review_required?.why ?? '없음'} 맞은 낱말 [${real?.matched_words}]`);
}

// ---------- I1. 세션은 기본으로, 정렬은 도메인 설정으로만 지우고, 보존이 언제나 먼저다 ----------
{
  store.createCrawl('i1', {
    seeds: [],
    policy: {
      ...FAST, mode: 'pilot',
      drop_params_by_domain: { [HOST]: ['sort', 'view'] },
      keep_params_by_domain: { [HOST]: ['theme'] },      // 이 도메인에만 있는 기능성 키
    },
  });
  const add = (u) => { store.addUrls('i1', [{ url: u, kind: 'unknown', via: 'manual', discovered_by: 't' }]); };
  add(`${BASE}/s?goodsNo=7&PHPSESSID=abc`);        // 세션은 기본 제거
  add(`${BASE}/s?goodsNo=7`);                      // → 위와 같은 한 칸
  add(`${BASE}/t?id=3&sort=new`);                  // 정렬은 이 도메인 설정으로 제거
  add(`${BASE}/t?id=3&sort=old`);                  // → 위와 같은 한 칸
  add(`${BASE}/u?theme=rose&sort=new`);            // 도메인 keep 이 있어도
  add(`${BASE}/u?theme=rose`);
  add(`${BASE}/v?id=9&goodsNo=2&page=3&sort=x`);   // 기본 기능성 ID 는 그대로 남아야
  const urls = Object.values(store.loadState('i1').urls).map((u) => u.url.replace(BASE, ''));
  const one = (p) => urls.filter((u) => u.startsWith(p)).length;
  const keptIds = urls.find((u) => u.startsWith('/v')) || '';

  // 다른 도메인에는 정렬 설정이 없으므로 그대로 남는다
  store.createCrawl('i1b', { seeds: [], policy: { ...FAST, mode: 'pilot' } });
  store.addUrls('i1b', [
    { url: `${BASE}/w?sort=new`, kind: 'unknown', via: 'manual', discovered_by: 't' },
    { url: `${BASE}/w?sort=old`, kind: 'unknown', via: 'manual', discovered_by: 't' },
  ]);
  const sortKept = Object.keys(store.loadState('i1b').urls).length === 2;

  // 같은 키를 지우라고도 남기라고도 하면 만들 때 거절
  let clash = false;
  try {
    policyLib.validatePolicy({ mode: 'pilot', drop_params_by_domain: { 'a.test': ['sort'] }, keep_params_by_domain: { 'a.test': ['sort'] } });
  } catch { clash = true; }

  check('I1', '세션은 기본 제거, 정렬은 도메인 설정으로만 제거, 기능성 ID 보존이 언제나 먼저다',
    one('/s') === 1 && one('/t') === 1 && one('/u') === 1
    && keptIds.includes('id=9') && keptIds.includes('goodsNo=2') && keptIds.includes('page=3') && !keptIds.includes('sort')
    && sortKept && clash,
    `세션 제거 → /s ${one('/s')}칸 · 도메인 정렬 제거 → /t ${one('/t')}칸 · keep 있는 도메인도 /u ${one('/u')}칸\n`
    + `      기능성 ID 보존: ${keptIds} · 설정 없는 쪽은 정렬 유지=${sortKept} · 제거·보존 충돌 거절=${clash}`);
}

// ---------- I2. 내용 지문은 실제로 가져온 그 임대의 것만 쓴다 ----------
{
  const { fetchOne } = await import(path.join(LIB, 'fetch.mjs'));
  const text = await import(path.join(LIB, 'text.mjs'));
  store.createCrawl('i2', { seeds: [], policy: { ...FAST, mode: 'pilot', min_interval_ms: 0, interval_jitter_ms: 0, lease_ttl_ms: 1_000 } });
  // 내용이 같고 글이 넉넉한 두 쪽 + 글이 거의 없는 쪽
  store.addUrls('i2', [
    { url: `${BASE}/mutable`, kind: 'listing', via: 'manual', discovered_by: 't' },
    { url: `${BASE}/mutable-twin`, kind: 'listing', via: 'manual', discovered_by: 't' },
    { url: `${BASE}/img-only`, kind: 'listing', via: 'manual', discovered_by: 't' },
  ]);
  for (const l of store.lease('i2', 5, 'w').leased) {
    await fetchOne('i2', { url: l.url, url_id: l.url_id, lease_token: l.lease_token, kind: 'listing', maxTier: 'curl' });
    // 워커가 가짜 지문을 실어 보내도 무시돼야 한다
    store.report('i2', [{ url_id: l.url_id, lease_token: l.lease_token, state: 'fetched', content_hash: 'deadbeef', text: '거짓말' }]);
  }
  const st = store.loadState('i2');
  const byUrl = (s) => Object.values(st.urls).find((u) => u.url.endsWith(s));
  const a = byUrl('/mutable'), b = byUrl('/mutable-twin'), img = byUrl('/img-only');
  const noLie = ![a, b, img].some((u) => u?.content_hash === 'deadbeef');
  const hashed = !!a?.content_hash && a.content_hash === b?.content_hash
    && a.content_hash_meta?.version === 1 && a.content_hash_meta?.normalize === 'visible-text/collapse-space';
  const shortOne = !img?.content_hash && img?.content_hash_unavailable?.why === 'content_hash_unavailable';

  // 늦은 임대는 안 붙는다: 만료 뒤 재임대해 가져오지 않고 반납
  store.requeue('i2', [img.url_id ?? Object.keys(st.urls).find((k) => st.urls[k] === img)], 'i2_recheck');
  const again = store.lease('i2', 1, 'w2').leased[0];
  const rep2 = store.report('i2', [{ url_id: again.url_id, lease_token: again.lease_token, state: 'fetched' }]);
  const rid = 'i2-fixed-report';
  const first = store.report('i2', [{ url_id: again.url_id, lease_token: again.lease_token, state: 'fetched' }], rid);
  const dup = store.report('i2', [{ url_id: again.url_id, lease_token: again.lease_token, state: 'fetched' }], rid);
  const idempotent = dup.duplicate === true && dup.accepted === 0;

  const groups = store.listContentGroups('i2');
  const grouped = groups.length === 1 && groups[0].url_ids.length === 2
    && Object.values(store.loadState('i2').urls).length === 3;      // 아무것도 지우지 않았다

  check('I2', '내용 지문은 그 임대에 실제로 가져온 본문에서만 나오고, 워커의 주장과 늦은 임대는 안 붙는다',
    noLie && hashed && shortOne && idempotent && grouped && rep2.accepted === 1,
    `워커 주장 무시=${noLie} · 같은 내용 두 주소 지문 일치=${hashed}(${a?.content_hash?.slice(0, 12)}) · `
    + `짧은 본문은 묶지 않음=${shortOne}\n      같은 보고 두 번=한 번만 반영(${idempotent}) · `
    + `묶음 ${groups.length}개(${groups[0]?.url_ids?.length}칸), 장부 주소 ${Object.values(store.loadState('i2').urls).length}개(삭제 0)`);
}

// ---------- I2c. 내용이 바뀌면 옛 묶음에서 빠진다(이력은 남는다) ----------
{
  const { fetchOne } = await import(path.join(LIB, 'fetch.mjs'));
  store.createCrawl('i2c', { seeds: [], policy: { ...FAST, mode: 'pilot', min_interval_ms: 0, interval_jitter_ms: 0 } });
  const targets = [`${BASE}/mutable`, `${BASE}/mutable-twin`];
  store.addUrls('i2c', targets.map((u) => ({ url: u, kind: 'listing', via: 'manual', discovered_by: 't' })));

  const pass = async (who) => {
    for (const l of store.lease('i2c', 5, who).leased) {
      await fetchOne('i2c', { url: l.url, url_id: l.url_id, lease_token: l.lease_token, kind: 'listing', maxTier: 'curl' });
      store.report('i2c', [{ url_id: l.url_id, lease_token: l.lease_token, state: 'fetched' }]);
    }
  };
  await pass('w1');
  const g1 = store.listContentGroups('i2c');
  const pairedFirst = g1.length === 1 && g1[0].url_ids.length === 2;

  // /mutable 의 본문만 바꾼 뒤 그 주소만 다시 가져온다
  await fetch(`${BASE}/sitemap-ctl?mutate=1`).then((x) => x.text());
  const mid = Object.entries(store.loadState('i2c').urls).find(([, u]) => u.url.endsWith('/mutable'))[0];
  store.requeue('i2c', [mid], 'i2c_recheck');
  await pass('w2');
  const g2 = store.listContentGroups('i2c');
  const leftGroup = g2.length === 0;                       // 둘이 갈렸으니 조회에 묶음이 없다
  const st2 = store.loadState('i2c');
  const changedHash = st2.urls[mid].content_hash && st2.urls[mid].content_hash !== g1[0]?.hash;

  // 이번엔 거의 빈 쪽으로 만들고 다시 가져온다 — 어느 묶음에도 없어야 한다
  await fetch(`${BASE}/sitemap-ctl?mutate=2`).then((x) => x.text());
  store.requeue('i2c', [mid], 'i2c_recheck2');
  await pass('w3');
  const st3 = store.loadState('i2c');
  const nowUnavailable = !st3.urls[mid].content_hash
    && st3.urls[mid].content_hash_unavailable?.why === 'content_hash_unavailable';
  const inNoGroup = !Object.values(st3.content_groups || {}).some((g) => g.url_ids.includes(mid));

  const ev = fs.readFileSync(path.join(SANDBOX, '.claude/web-search/i2c/events.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map(JSON.parse);
  // 두 번 바뀌었으니 빠짐도 두 번이다 — 처음 묶음에서 새 지문으로, 새 지문에서 "잴 수 없음"으로
  const leftEvents = ev.filter((e) => e.type === 'content_group_left');
  const historyKept = leftEvents.length === 2
    && leftEvents.every((e) => e.url_id === mid)
    && leftEvents[0].hash === g1[0]?.hash && !!leftEvents[0].to && leftEvents[0].to !== g1[0]?.hash
    && leftEvents[1].hash === leftEvents[0].to && leftEvents[1].to === null;

  await fetch(`${BASE}/sitemap-ctl?reset=1`).then((x) => x.text());
  check('I2c', '내용이 바뀌거나 잴 수 없게 되면 옛 묶음에서 빠지고, 빠졌다는 이력은 남는다',
    pairedFirst && leftGroup && changedHash && nowUnavailable && inNoGroup && historyKept,
    `처음 묶임=${pairedFirst} · 본문 바뀐 뒤 조회 묶음 ${g2.length}개(지문 달라짐=${changedHash})\n`
    + `      거의 빈 쪽으로 다시 가져온 뒤: 지문 없음=${nowUnavailable} · 어느 묶음에도 없음=${inNoGroup}\n`
    + `      빠짐 이력 ${leftEvents.length}건(맞음=${historyKept}): `
    + `${leftEvents.map((e) => `${String(e.hash).slice(0, 8)}→${e.to ? String(e.to).slice(0, 8) : '없음'}`).join(', ')}`);
}

// ---------- I2b. Jina 머리말은 지문에서 걷어낸다 ----------
{
  const { canonicalContent, stripJinaHeader } = await import(path.join(LIB, 'text.mjs'));
  const body = (u) => `Title: 청첩장 목록\nURL Source: ${u}\nPublished Time: 2026-08-01\nMarkdown Content:\n같은 본문입니다. 카드 열두 장.`;
  const x = canonicalContent(body('https://a.test/list?page=1'), { markdown: true });
  const y = canonicalContent(body('https://a.test/list?page=2'), { markdown: true });
  const noHead = !x.includes('URL Source') && !x.includes('Title:') && x.startsWith('같은 본문입니다');
  // 머리말 표시가 없는 판도 앞머리 줄만 걷는다
  const z = stripJinaHeader('Title: 가\nURL Source: https://b.test/x\n\n본문 시작');
  check('I2b', 'Jina 머리말의 주소 때문에 같은 본문이 다른 지문이 되지 않는다',
    x === y && noHead && z === '본문 시작',
    `주소만 다른 두 판의 표준형 일치=${x === y} · 머리말 제거=${noHead} ("${x.slice(0, 20)}…") · 표시 없는 판=${JSON.stringify(z)}`);
}

// ---------- I3. 쪽 마름은 도착 순서와 무관하다 ----------
{
  const { fetchOne } = await import(path.join(LIB, 'fetch.mjs'));
  const run = async (crawl, order) => {
    store.createCrawl(crawl, {
      seeds: [], policy: { ...FAST, mode: 'pilot', min_interval_ms: 0, interval_jitter_ms: 0, listing_path_patterns: ['/paged'] },
    });
    // 장부에 목록으로 넣는다. fetch 인자로 종류를 우회하지 않는다 — pageOf 는 장부 근거만 본다.
    const urls = [1, 2, 3, 4, 5, 6].map((n) => `${BASE}/paged?page=${n}`);
    store.addUrls(crawl, urls.map((u) => ({ url: u, kind: 'listing', via: 'manual', discovered_by: 't' })));
    const leased = store.lease(crawl, 10, 'w').leased;
    const byIndex = {};
    for (const l of leased) byIndex[new URL(l.url).searchParams.get('page')] = l;
    for (const n of order) {
      const l = byIndex[String(n)];
      // 목록은 화면을 봐야 "제대로 봤다"가 된다. curl 만으로는 늘 "모름"이라 마름을 못 잰다.
      await fetchOne(crawl, { url: l.url, url_id: l.url_id, lease_token: l.lease_token, kind: 'listing', maxTier: 'headless' });
      store.report(crawl, [{ url_id: l.url_id, lease_token: l.lease_token, state: 'fetched' }]);
    }
    return store.listPageSeries(crawl, { needed: 2 })[0];
  };
  const inOrder = await run('i3a', [1, 2, 3, 4, 5, 6]);
  const shuffled = await run('i3b', [3, 1, 5, 2, 6, 4]);
  const same = JSON.stringify(inOrder?.per_page) === JSON.stringify(shuffled?.per_page)
    && inOrder?.dry === shuffled?.dry && inOrder?.dry_from === shuffled?.dry_from;
  // 1·2쪽이 카드를 겹치므로 2쪽의 새것은 6이 아니라 4다 — 겹침을 제대로 뺐다는 증거
  const nov = (s) => (s?.per_page || []).map((p) => p.novelty).join(',');
  const overlapHandled = nov(inOrder) === '6,4,2,0,0,0' && inOrder?.dry === true && inOrder?.dry_from === 4;

  check('I3', '새 카드 없는 연속 쪽 판정이 보고 도착 순서에 흔들리지 않는다',
    same && overlapHandled,
    `순서대로: 쪽별 새것 [${nov(inOrder)}] 마름=${inOrder?.dry}(${inOrder?.dry_from}쪽부터) · `
    + `뒤섞어: [${nov(shuffled)}] 마름=${shuffled?.dry}(${shuffled?.dry_from}쪽부터) · 같은 답=${same}`);
}

// ---------- I4. 정렬이 다른 쪽은 다른 묶음이고, 상세의 ?p= 는 쪽이 아니다 ----------
{
  const { pageOf } = await import(path.join(LIB, 'pagination.mjs'));
  const L = { kind: 'listing', kindSource: 'policy' };
  const s1 = pageOf(`${BASE}/paged?page=2&sort=new`, L);
  const s2 = pageOf(`${BASE}/paged?page=2&sort=old`, L);
  const detail = pageOf(`${BASE}/goods?p=77`, { kind: 'detail', kindSource: 'policy' });
  const unknownKind = pageOf(`${BASE}/paged?page=2`, { kind: 'unknown', kindSource: 'default' });
  const offsetOff = pageOf(`${BASE}/paged?offset=20`, L);
  const offsetOn = pageOf(`${BASE}/paged?offset=20`, { ...L, offsetStep: 20 });

  const { seriesDryness } = await import(path.join(LIB, 'pagination.mjs'));
  const gapCase = seriesDryness({ pages: { 1: { emitted: ['x'] }, 100: { emitted: [] }, 101: { emitted: [] } } }, 3);
  const unknownCase = seriesDryness({
    pages: { 1: { emitted: ['x'] }, 2: { unknown: true, why: 'page_validity:invalid' }, 3: { emitted: [] }, 4: { emitted: [] } },
  }, 3);

  check('I4', '정렬이 다르면 다른 묶음이고, 상세의 ?p= 와 번호 건너뜀·모르는 쪽은 연속으로 세지 않는다',
    s1.series !== s2.series && s1.index === 2 && detail === null && unknownKind === null
    && offsetOff === null && offsetOn?.index === 2
    && gapCase.dry === false && gapCase.gaps.length === 1
    && unknownCase.dry === false && unknownCase.broken_by?.why === 'page_validity:invalid',
    `정렬별 묶음 분리=${s1.series !== s2.series} · 상세 ?p=77 은 쪽 아님=${detail === null} · `
    + `목록 확정 전에는 쪽 아님=${unknownKind === null} · offset 은 보폭 줄 때만=${offsetOff === null}/${offsetOn?.index}\n`
    + `      1·100·101 마름=${gapCase.dry}(빈 구간 ${JSON.stringify(gapCase.gaps)}) · 모르는 쪽이 연속을 끊음=${unknownCase.broken_by?.why}`);
}

// ---------- I5. 사람이 정한 제외 자리는 한 건도 안 들어가고, 사유·빈도가 조회된다 ----------
{
  // 기본값은 비어 있다 — 안 적으면 아무것도 자동으로 빠지지 않는다
  const bare = policyLib.validatePolicy({ mode: 'pilot' });
  const emptyByDefault = bare.exclude_path_patterns.length === 0 && bare.exclude_query_keys.length === 0;
  const noPageSort = !policyLib.SUGGESTED_EXCLUDE_QUERY_KEYS.some((k) => ['page', 'sort', 'order'].includes(k))
    && !policyLib.SUGGESTED_EXCLUDE_PATHS.some((p) => /page|sort|order/.test(p));

  store.createCrawl('i5', {
    seeds: [], policy: {
      ...FAST, mode: 'pilot', faceted_cap: 3,
      exclude_path_patterns: ['/calendar'], exclude_query_keys: ['q'],
    },
  });
  for (let d = 1; d <= 8; d++) {
    store.addUrls('i5', [{ url: `${BASE}/calendar?date=2026-08-0${d}`, kind: 'unknown', via: 'manual', discovered_by: 't' }]);
  }
  store.addUrls('i5', [
    { url: `${BASE}/find?q=ring`, kind: 'unknown', via: 'manual', discovered_by: 't' },
    { url: `${BASE}/paged?page=2&sort=new`, kind: 'unknown', via: 'manual', discovered_by: 't' },   // 쪽·정렬은 막지 않는다
  ]);

  const st = store.loadState('i5');
  const inQueue = Object.values(st.urls).filter((u) => u.url.includes('/calendar') || u.url.includes('/find')).length;
  const pagedIn = Object.values(st.urls).some((u) => u.url.includes('/paged'));
  const ex = store.listExcluded('i5');
  const byPath = ex.active.filter((x) => x.why === 'excluded_path_pattern');
  const byKey = ex.active.filter((x) => x.why === 'excluded_query_key');
  const evidenceOk = byPath.length === 8 && byPath[0].evidence?.pattern === '/calendar'
    && byKey.length === 1 && byKey[0].evidence?.key === 'q';
  const noCandidates = Object.keys(st.boundary_candidates).length === 0;   // 상한을 채우기 전에 막았다
  const s = store.status('i5');
  const freq = s.excluded_by.find((x) => x.rule === 'excluded_path_pattern:/calendar');
  const facetKeysCounted = (st.domains?.[HOST]?.facet_keys?.['query:date'] || 0) === 8;

  check('I5', '사람이 정한 제외 자리는 큐에 한 건도 안 들어가고, 규칙·빈도가 근거로 조회된다(쪽·정렬은 안 막는다)',
    emptyByDefault && noPageSort && inQueue === 0 && pagedIn && evidenceOk && noCandidates
    && freq?.count === 8 && facetKeysCounted,
    `기본값 비어 있음=${emptyByDefault} · 추천값에 쪽·정렬 없음=${noPageSort}\n`
    + `      큐 진입 ${inQueue}건(0이어야) · 쪽·정렬 주소는 들어옴=${pagedIn} · `
    + `안 들임: 경로규칙 ${byPath.length}건(${byPath[0]?.evidence?.pattern}) 쿼리키 ${byKey.length}건(${byKey[0]?.evidence?.key})\n`
    + `      상한 후보로 새지 않음=${noCandidates} · status 규칙별 빈도 ${freq?.rule}=${freq?.count} · 거르개 키 빈도 query:date=${st.domains?.[HOST]?.facet_keys?.['query:date']}`);
}

// ---------- I6. 근거는 MCP 로 읽을 수 있고, 마름은 표시일 뿐 아무것도 버리지 않는다 ----------
{
  const server = path.join(HERE, '..', 'server.mjs');
  const out = await new Promise((resolve) => {
    const p = spawn(process.execPath, [server], { env: { ...process.env, CLAUDE_PROJECT_DIR: SANDBOX }, stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '';
    p.stdout.on('data', (d) => (buf += d));
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n');
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'evidence', arguments: { crawl: 'i3a', what: 'page_series' } } }) + '\n');
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'evidence', arguments: { crawl: 'i2c', what: 'content_groups' } } }) + '\n');
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'evidence', arguments: { crawl: 'i5', what: 'excluded' } } }) + '\n');
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'status', arguments: { crawl: 'i3a' } } }) + '\n');
    p.stdin.end();
    p.on('close', () => resolve(buf));
    setTimeout(() => { try { p.kill(); } catch {} resolve(buf); }, 60_000);
  });
  const by = Object.fromEntries(out.trim().split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).map((m) => [m.id, m]));
  const names = (by[2]?.result?.tools || []).map((t) => t.name);
  const t = (id) => String(by[id]?.result?.content?.[0]?.text || '');
  const seriesText = t(3), groupText = t(4), exText = t(5);

  const statusText = t(6);
  const hasTool = names.includes('evidence');
  const seriesOk = /쪽 묶음 \d+개/.test(seriesText) && /마름=true/.test(seriesText) && seriesText.includes('버리지 않습니다');
  const groupOk = groupText.includes('묶음이 없습니다') || /같아 보이는 묶음 \d+개/.test(groupText);
  const exOk = /안 들인 것 9건/.test(exText) && exText.includes('excluded_path_pattern');
  // status 자체에도 요약이 나와야 한다 — evidence 도구가 그 자리를 대신하지 않는다
  const statusOk = /같아 보이는 묶음 \d+개 · 쪽 묶음 1개\(마름 1개\)/.test(statusText)
    && /안 들임 \d+건\(풀린 이력 \d+건\)/.test(statusText);
  // 마름이 표시일 뿐이라는 증거: 그 쪽들이 여전히 장부에 그대로 있다
  const stillThere = Object.values(store.loadState('i3a').urls).filter((u) => u.url.includes('/paged')).length === 6;

  check('I6', '같아 보이는 묶음·쪽 마름·안 들인 것을 MCP 로 읽을 수 있고(status 요약 포함), 마름은 표시일 뿐 아무것도 버리지 않는다',
    hasTool && seriesOk && groupOk && exOk && statusOk && stillThere,
    `evidence 도구 있음=${hasTool}\n      쪽 묶음: ${seriesText.split('\n').slice(0, 2).join(' | ')}\n`
    + `      안 들인 것: ${exText.split('\n')[0]}\n`
    + `      status 요약: ${statusText.split('\n').filter((l) => l.includes('묶음') || l.includes('안 들임')).join(' | ')}\n`
    + `      마른 쪽도 장부에 그대로 ${Object.values(store.loadState('i3a').urls).filter((u) => u.url.includes('/paged')).length}칸`);
}

// ---------- 카드 자료 계약 (태스크 18) ----------
const { fetchOne: fetchCard } = await import(path.join(LIB, 'fetch.mjs'));
const cardsLib = await import(path.join(LIB, 'cards.mjs'));

/** 목록 하나를 실제 경로로 훑어 장부까지 넣는다. */
async function collectListing(crawl, urls, { policy = {}, worker = 'w', payload = null } = {}) {
  if (!fs.existsSync(path.join(SANDBOX, '.claude/web-search', crawl))) {
    store.createCrawl(crawl, { seeds: [], policy: { ...FAST, mode: 'pilot', min_interval_ms: 0, interval_jitter_ms: 0, ...policy } });
  }
  store.addUrls(crawl, urls.map((u) => ({ url: u, kind: 'listing', via: 'manual', discovered_by: 't' })));
  // 목표만 딱 임대한다. 큐 전체를 빌리면 부르지도 않은 상세까지 묶여, 뒤 시험이 그걸 못 빌린다.
  const leased = [];
  for (const u of urls) {
    const id = normalizeUrl(u).id;
    let lz = store.leaseUrl(crawl, id, worker);
    if (!lz.ok && String(lz.why).startsWith('not_queued')) {
      store.requeue(crawl, [id], 'collect_listing');
      lz = store.leaseUrl(crawl, id, worker);
    }
    if (!lz.ok) continue;
    await fetchCard(crawl, { url: u, url_id: id, lease_token: lz.lease_token, kind: 'listing', maxTier: 'headless' });
    store.report(crawl, [{ url_id: id, lease_token: lz.lease_token, state: 'fetched', ...(payload || {}) }]);
    leased.push({ url: u, url_id: id, lease_token: lz.lease_token });
  }
  return leased;
}

// ---------- J1. 목록 캡처에서 카드 열둘을 잘라 장부에 남긴다 ----------
{
  const src = `${BASE}/listing-plain`;
  await collectListing('j1', [src]);
  const cards = store.listCards('j1');
  const complete = cards.every((c) => c.source_url === src && c.detail_url && c.bbox
    && c.capture_path && fs.existsSync(c.capture_path)
    && c.crop_path && fs.existsSync(c.crop_path) && fs.statSync(c.crop_path).size > 0
    && c.crop_px?.w > 0 && c.crop_px?.h > 0
    && c.discovered_cycle === 1 && cardsLib.DETAIL_STATES.includes(c.detail_state));
  const cropped = cards.filter((c) => c.crop_path).length;
  const ev = fs.readFileSync(path.join(SANDBOX, '.claude/web-search/j1/events.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map(JSON.parse).find((e) => e.type === 'cards_merged');

  check('J1', '목록 캡처에서 카드 열둘을 잘라 내고, 잘린 파일 수가 장부 카드 수와 같다',
    cards.length === 12 && cropped === 12 && complete
    && ev?.total === 12 && ev?.cropped === 12 && ev?.extraction_status === 'complete',
    `카드 ${cards.length}장 · 자른 파일 ${cropped}개 · 모든 칸 채움=${complete} · `
    + `첫 카드 ${cards[0]?.card_id?.slice(0, 12)}(${cards[0]?.id_confidence}) bbox ${JSON.stringify(cards[0]?.bbox)} `
    + `crop ${cards[0]?.crop_px?.w}x${cards[0]?.crop_px?.h}`);
}

// ---------- J2. 다시 훑어도 ID·개수가 그대로고 회차가 안 밀린다 ----------
{
  const src = `${BASE}/listing-plain`;
  const before = store.listCards('j1').map((c) => c.card_id).sort();
  const beforeCycle = store.listCards('j1')[0]?.discovered_cycle;
  const ids = Object.keys(store.loadState('j1').urls);
  store.requeue('j1', ids, 'j2_recheck');
  await collectListing('j1', [src], { worker: 'w2' });
  const after = store.listCards('j1');
  const sameIds = JSON.stringify(before) === JSON.stringify(after.map((c) => c.card_id).sort());
  const cycleKept = after.every((c) => c.discovered_cycle === beforeCycle);

  // 추적 파라미터가 붙어도 같은 카드다
  const withUtm = cardsLib.matchBoxes(
    [{ href: `${BASE}/products/q1?utm_source=x`, img: '/img/1.png' }],
    [], { base: BASE }, BASE,
  );
  const sameAsPlain = cardsLib.matchBoxes([{ href: `${BASE}/products/q1`, img: '/img/1.png' }], [], { base: BASE }, BASE);
  const utmSame = withUtm[0].norm_href === sameAsPlain[0].norm_href;

  check('J2', '같은 목록을 다시 훑어도 카드 ID·개수가 그대로고 발견 회차가 밀리지 않는다',
    after.length === 12 && sameIds && cycleKept && utmSame,
    `다시 훑은 뒤 ${after.length}장 · ID 그대로=${sameIds} · 회차 ${beforeCycle}→${after[0]?.discovered_cycle} · `
    + `추적 파라미터 붙어도 같은 카드=${utmSame}`);
}

// ---------- J3. 워커의 주장·늦은 임대·중복 보고는 카드에 영향이 없다 ----------
{
  const src = `${BASE}/listing-two`;
  store.createCrawl('j3', { seeds: [], policy: { ...FAST, mode: 'pilot', min_interval_ms: 0, interval_jitter_ms: 0, lease_ttl_ms: 1_000 } });
  store.addUrls('j3', [{ url: src, kind: 'listing', via: 'manual', discovered_by: 't' }]);

  // (가) 가져오지 않고 카드를 주장하며 반납한다
  const a = store.lease('j3', 1, 'liar').leased[0];
  store.report('j3', [{ url_id: a.url_id, lease_token: a.lease_token, state: 'fetched',
    cards: [{ card_id: 'fake', detail_url: 'http://evil.test/x' }] }]);
  const afterLie = store.listCards('j3').length;

  // (나) 제대로 가져오되, 임대가 만료돼 다른 워커가 받은 뒤 늦게 반납한다
  store.requeue('j3', [a.url_id], 'j3_stale');
  const b = store.lease('j3', 1, 'slow').leased[0];
  await fetchCard('j3', { url: b.url, url_id: b.url_id, lease_token: b.lease_token, kind: 'listing', maxTier: 'headless' });
  await new Promise((res) => setTimeout(res, 1_200));
  const c = store.lease('j3', 1, 'next').leased[0];              // 만료돼 재배정
  const late = store.report('j3', [{ url_id: b.url_id, lease_token: b.lease_token, state: 'fetched' }]);
  const afterLate = store.listCards('j3').length;

  // (다) 새 임대로는 가져오지 않고 반납 — 옛 임대의 카드가 붙으면 안 된다
  store.report('j3', [{ url_id: c.url_id, lease_token: c.lease_token, state: 'fetched' }]);
  const afterWrongLease = store.listCards('j3').length;

  // (라) 제대로 가져와 반납하고, 같은 보고를 두 번 보낸다
  store.requeue('j3', [c.url_id], 'j3_ok');
  const d = store.lease('j3', 1, 'good').leased[0];
  await fetchCard('j3', { url: d.url, url_id: d.url_id, lease_token: d.lease_token, kind: 'listing', maxTier: 'headless' });
  const rid = 'j3-report';
  store.report('j3', [{ url_id: d.url_id, lease_token: d.lease_token, state: 'fetched' }], rid);
  const n1 = store.listCards('j3').length;
  const dup = store.report('j3', [{ url_id: d.url_id, lease_token: d.lease_token, state: 'fetched' }], rid);
  const n2 = store.listCards('j3').length;

  check('J3', '워커가 주장한 카드·늦은 임대·중복 보고는 장부 카드에 영향이 0이다',
    afterLie === 0 && late.accepted === 0 && afterLate === 0 && afterWrongLease === 0
    && n1 === 2 && dup.duplicate === true && n2 === 2
    && !store.listCards('j3').some((x) => x.card_id === 'fake'),
    `가짜 주장 뒤 ${afterLie}장 · 늦은 반납 거절=${late.accepted === 0}(그 뒤 ${afterLate}장) · `
    + `안 가져온 새 임대 반납 뒤 ${afterWrongLease}장\n      제대로 반납 ${n1}장 · 같은 보고 두 번 뒤 ${n2}장(중복=${dup.duplicate})`);
}

// ---------- J4. 잘라 낸 그림이 정말 그 목록 캡처의 그 자리다 ----------
{
  const c = store.listCards('j1')[0];
  const py = `
import json,sys
from PIL import Image, ImageChops
req=json.loads(sys.stdin.read())
shot=Image.open(req["shot"]).convert("RGB")
box=req["box"]
ref=shot.crop((box[0],box[1],box[2],box[3]))
got=Image.open(req["crop"]).convert("RGB")
same_size = ref.size==got.size
diff=ImageChops.difference(ref,got) if same_size else None
bbox=diff.getbbox() if diff else "size_mismatch"
# jpeg 재압축 때문에 완전히 같지는 않다. 평균 차이로 본다.
import functools,operator
stat=None
if diff:
    h=diff.convert("L").histogram()
    total=sum(i*h[i] for i in range(256)); n=sum(h)
    stat=total/max(1,n)
print(json.dumps({"same_size":same_size,"ref_size":ref.size,"got_size":got.size,"mean_diff":stat}))
`;
  const out = await new Promise((resolve) => {
    const p = spawn('python3', ['-c', py], { stdio: ['pipe', 'pipe', 'pipe'] });
    let o = '', e = '';
    p.stdout.on('data', (d) => (o += d)); p.stderr.on('data', (d) => (e += d));
    p.on('close', () => { try { resolve(JSON.parse(o)); } catch { resolve({ error: (e || o).slice(0, 120) }); } });
    p.stdin.end(JSON.stringify({ shot: c.capture_path, crop: c.crop_path, box: c.crop_px.box }));
  });
  check('J4', '잘라 낸 그림은 그 목록 캡처의 그 사각형에서 나온 것이다',
    out.same_size === true && typeof out.mean_diff === 'number' && out.mean_diff < 6,
    `캡처에서 같은 자리를 다시 잘라 견줌: 크기 ${JSON.stringify(out.ref_size)}=${JSON.stringify(out.got_size)} · `
    + `평균 차이 ${out.mean_diff?.toFixed?.(2)}(작을수록 같은 그림, jpeg 재압축 오차만 남음)${out.error ? ` · ${out.error}` : ''}`);
}

// ---------- J4b. 캡처 밖 좌표를 검은 여백으로 채워 통과시키지 않는다 ----------
{
  const c = store.listCards('j1')[0];
  const script = path.join(LIB, 'crop_cards.py');
  const outDir = path.join(SANDBOX, 'j4b-crops');
  const ask = (boxes) => new Promise((resolve) => {
    const p = spawn('python3', [script], { stdio: ['pipe', 'pipe', 'pipe'] });
    let o = '', e = '';
    p.stdout.on('data', (d) => (o += d)); p.stderr.on('data', (d) => (e += d));
    p.on('close', () => { try { resolve(JSON.parse(o)); } catch { resolve({ error: (e || o).slice(0, 120) }); } });
    p.stdin.end(JSON.stringify({ shot: c.capture_path, out_dir: outDir, css_width: 1280, css_height: 4000, boxes }));
  });
  const r = await ask([
    { name: 'neg', x: -50, y: -40, w: 200, h: 200 },     // 왼쪽 위로 삐져나간 자리
    { name: 'far', x: 100, y: 99999, w: 200, h: 200 },   // 캡처 아래 바깥
  ]);
  const neg = (r.results || []).find((x) => x.name === 'neg');
  const far = (r.results || []).find((x) => x.name === 'far');
  const negClamped = neg?.ok === true && neg.why === 'clipped_to_shot'
    && neg.pixel_box?.[0] === 0 && neg.pixel_box?.[1] === 0;
  const farRefused = far?.ok === false && far.why === 'outside_shot';

  check('J4b', '캡처 밖으로 나간 좌표는 검은 여백으로 채우지 않고, 잘렸다고 남기거나 아예 거절한다',
    negClamped && farRefused,
    `왼쪽 위로 나간 자리: 0,0 으로 당겨 자름=${negClamped}(${neg?.why}, 픽셀 ${JSON.stringify(neg?.pixel_box)}) · `
    + `캡처 아래 바깥: 거절=${farRefused}(${far?.why})`);
}

// ---------- J5. 확정되지 않은 쪽은 성공한 척하지 않는다 ----------
{
  const src = `${BASE}/ambiguous`;
  await collectListing('j5', [src]);
  const cards = store.listCards('j5');
  const urlRec = Object.values(store.loadState('j5').urls)[0];
  const note = JSON.parse(fs.readFileSync(path.join(SANDBOX, '.claude/web-search/j5/manifests',
    Object.keys(store.loadState('j5').urls)[0], 'notes/cards.json'), 'utf8'));
  const cropDirEmpty = !note.cards.some((c) => c.crop_path);

  check('J5', '판정이 확정되지 않은 쪽은 카드를 만들어 내지 않고 사유를 남긴다',
    note.extraction_status === 'incomplete' && (note.why || []).length > 0
    && cards.length === 0 && cropDirEmpty
    && urlRec.cards_extraction_status === 'incomplete' && (urlRec.cards_why || []).length > 0,
    `추출 상태 ${note.extraction_status} 사유 ${JSON.stringify(note.why)} · 장부 카드 ${cards.length}장 · 자른 것 없음=${cropDirEmpty}\n`
    + `      장부에 남은 사유 ${JSON.stringify(urlRec.cards_why)}`);
}

// ---------- J6. 상세 링크가 없는 목록도 카드가 되고, 겹친 그림은 같은 카드다 ----------
{
  const p1 = `${BASE}/nolink?page=1`;
  const p2 = `${BASE}/nolink?page=2`;
  await collectListing('j6', [p1, p2], { policy: { listing_path_patterns: ['/nolink'] } });
  const cards = store.listCards('j6');
  const uniq = new Set(cards.map((c) => c.card_id));
  const fallbackAll = cards.every((c) => c.id_confidence === 'image_url' && c.detail_url === null && c.crop_path);
  const series = store.listPageSeries('j6', { needed: 3 })[0];
  const nov = (series?.per_page || []).map((x) => x.novelty).join(',');

  check('J6', '상세 링크 없는 목록도 카드가 되고, 두 쪽에 겹친 그림은 같은 카드로 한 번만 센다',
    cards.length === 10 && uniq.size === 10 && fallbackAll && nov === '6,4',
    `카드 ${cards.length}장(고유 ${uniq.size}) · 모두 그림 기준 대체 ID + 잘림=${fallbackAll} · `
    + `쪽별 새것 [${nov}](겹친 둘이 빠져 2쪽은 4)`);
}

// ---------- J7. 상세 상태는 장부와 맞고, 바깥 어휘는 셋뿐이다 ----------
{
  const src = `${BASE}/listing-plain`;
  await collectListing('j7', [src]);
  const before = store.listCards('j7');
  const allDeferred = before.every((c) => c.detail_state === 'known_deferred');

  // 상세를 큐에 올리는 길은 깨우기 하나뿐이다 — 목록을 다시 훑지 않아도 카드가 바로 따라와야 한다.
  // (링크로 이미 장부에 들어와 자고 있어도, 깨우는 것은 wake_details 만 한다.)
  const target = before[0].detail_url;
  store.wakeDetails('j7', [before[0].card_id], { who: 'gate4', reason: '이 카드의 상세를 본다' });
  const mid = store.listCards('j7').find((c) => c.detail_url === target);

  // 그 상세만 딱 집어 가져온다. 다른 대기 항목과 섞이지 않게 한 건만 임대한다.
  const did = normalizeUrl(target).id;
  const dlz = store.leaseUrl('j7', did, 'w3');
  await fetchCard('j7', { url: target, url_id: did, lease_token: dlz.lease_token, kind: 'detail', maxTier: 'curl' });
  store.report('j7', [{ url_id: did, lease_token: dlz.lease_token, state: 'fetched' }]);
  const done = store.listCards('j7').find((c) => c.detail_url === target);
  const onlyThree = store.listCards('j7').every((c) => cardsLib.DETAIL_STATES.includes(c.detail_state));

  const others = store.listCards('j7').filter((c) => c.detail_url !== target);
  const othersUntouched = others.every((c) => c.detail_state === 'known_deferred');

  check('J7', '카드의 상세 상태는 목록을 다시 훑지 않아도 장부를 따라가고, 바깥 값은 셋뿐이다',
    allDeferred && mid?.detail_state === 'queued' && done?.detail_state === 'fetched'
    && onlyThree && othersUntouched,
    `처음 전부 known_deferred=${allDeferred} · 큐에 넣자마자 ${mid?.detail_state} · 그 상세만 가져오자 ${done?.detail_state} · `
    + `나머지 ${others.length}장은 그대로=${othersUntouched} · 바깥 어휘 셋뿐=${onlyThree} [${cardsLib.DETAIL_STATES.join(', ')}]`);
}

// ---------- J8. 본 브라우저 계단으로 올라간 목록에서도 카드가 나온다 ----------
{
  const src = `${BASE}/js-only`;      // curl 로는 비어 있어 본 계단이 headless 까지 올라간다
  await collectListing('j8', [src]);
  const cards = store.listCards('j8');
  const rec = Object.values(store.loadState('j8').urls)[0];
  const cropped = cards.filter((c) => c.crop_path && fs.existsSync(c.crop_path)).length;
  const fromMainTier = cards.every((c) => c.capture_path && !c.capture_path.includes('-visual'));

  check('J8', '본 계단이 브라우저까지 올라간 목록에서도 그 캡처에서 카드를 잘라 낸다',
    cards.length === 12 && cropped === 12 && fromMainTier && rec.cards_extraction_status === 'complete',
    `카드 ${cards.length}장 · 자름 ${cropped}개 · 본 계단 캡처에서 나옴=${fromMainTier}(${path.basename(cards[0]?.capture_path || '')})`);
}

// ---------- 요약·고정판·깨우기·회차 (태스크 19) ----------

// ---------- K1. 완료는 이 크롤 경계 안에서만 선언되고, 남은 일이 하나라도 있으면 아니다 ----------
{
  const src = `${BASE}/listing-plain`;
  store.createCrawl('k1', {
    seeds: [src],
    policy: {
      ...FAST, mode: 'pilot', min_interval_ms: 0, interval_jitter_ms: 0,
      required_words: ['없는낱말'],       // 일부러 걸리게 해서 사람 확인 대기를 만든다
      coverage_targets: { country: ['KR', 'US'], vendor_type: ['mcheong'] },
      domain_meta: { [HOST]: { country: 'KR' } },
    },
  });
  const id = normalizeUrl(src).id;
  const lz = store.leaseUrl('k1', id, 'w');
  await fetchCard('k1', { url: src, url_id: id, lease_token: lz.lease_token, kind: 'listing', maxTier: 'headless' });
  store.report('k1', [{ url_id: id, lease_token: lz.lease_token, state: 'fetched' }]);

  const s1 = store.status('k1');
  const blockedByReview = s1.completion === 'paused_incomplete' && s1.review_required === 1
    && s1.completion_reason.includes('사람 확인');
  const scopeStated = s1.completion_scope.includes(HOST);
  // 훑기를 시작하지 않은 자리는 "끝났다"가 아니다
  const notStarted = s1.origins.some((o) => o.origin === BASE && o.state === 'not_started');
  const coverageBlank = s1.coverage.country?.blanks?.includes('US')
    && s1.coverage.country?.found?.includes('KR')
    && s1.coverage.vendor_type?.blanks?.includes('mcheong')
    && s1.coverage.vendor_type?.unlabeled_domains?.includes(HOST);
  const words = s1.top_words.length > 0 && s1.top_domains[0]?.domain === HOST;

  check('K1', '완료는 이 크롤 경계 안에서만 말하고, 사람 확인·못 훑은 자리가 있으면 완료가 아니다',
    blockedByReview && scopeStated && notStarted && coverageBlank && words,
    `판정 ${s1.completion} — ${s1.completion_reason}\n`
    + `      범위: ${s1.completion_scope} · 자리 상태 ${JSON.stringify(s1.origins)}\n`
    + `      빈칸 country=[${s1.coverage.country?.blanks}] vendor_type 표 없는 도메인 ${s1.coverage.vendor_type?.unlabeled_domains?.length}곳 · `
    + `자주 나온 낱말 ${s1.top_words.slice(0, 3).map((t) => t.term).join(',')}`);
}

// ---------- K2. 낱말·도메인 집계가 다시 훑거나 중복 보고해도 부풀지 않는다 ----------
{
  const src = `${BASE}/listing-plain`;
  store.createCrawl('k2', { seeds: [], policy: { ...FAST, mode: 'pilot', min_interval_ms: 0, interval_jitter_ms: 0 } });
  const id = normalizeUrl(src).id;
  store.addUrls('k2', [{ url: src, kind: 'listing', via: 'manual', discovered_by: 't' }]);
  const l1 = store.leaseUrl('k2', id, 'w');
  await fetchCard('k2', { url: src, url_id: id, lease_token: l1.lease_token, kind: 'listing', maxTier: 'headless' });
  const rid = 'k2-report';
  store.report('k2', [{ url_id: id, lease_token: l1.lease_token, state: 'fetched' }], rid);
  const once = store.status('k2');
  store.report('k2', [{ url_id: id, lease_token: l1.lease_token, state: 'fetched' }], rid);   // 같은 보고 두 번
  const dup = store.status('k2');

  store.requeue('k2', [id], 'k2_recheck');
  const l2 = store.leaseUrl('k2', id, 'w2');
  await fetchCard('k2', { url: src, url_id: id, lease_token: l2.lease_token, kind: 'listing', maxTier: 'headless' });
  store.report('k2', [{ url_id: id, lease_token: l2.lease_token, state: 'fetched' }]);
  const again = store.status('k2');

  const w = (s) => s.top_words.find((t) => t.term === '청첩장')?.count ?? 0;
  check('K2', '자주 나온 낱말·도메인은 다시 훑거나 같은 보고가 겹쳐도 두 번 세지 않는다',
    w(once) > 0 && w(once) === w(dup) && w(once) === w(again)
    && once.top_domains[0].urls === again.top_domains[0].urls,
    `"청첩장" 셈: 한 번 ${w(once)} → 같은 보고 두 번 ${w(dup)} → 다시 훑은 뒤 ${w(again)} · `
    + `도메인 주소 수 ${once.top_domains[0].urls}→${again.top_domains[0].urls}`);
}

// ---------- K3. 고정판은 완료일 때만 뜨고, 뜬 뒤 장부가 바뀌어도 안 변한다 ----------
{
  const src = `${BASE}/listing-plain`;
  store.createCrawl('k3', { seeds: [], policy: { ...FAST, mode: 'pilot', min_interval_ms: 0, interval_jitter_ms: 0 } });
  const id = normalizeUrl(src).id;
  store.addUrls('k3', [{ url: src, kind: 'listing', via: 'manual', discovered_by: 't' }]);
  const lz = store.leaseUrl('k3', id, 'w');
  await fetchCard('k3', { url: src, url_id: id, lease_token: lz.lease_token, kind: 'listing', maxTier: 'headless' });
  store.report('k3', [{ url_id: id, lease_token: lz.lease_token, state: 'fetched' }]);

  // 아직 할 일이 남은 상태를 만들어 두고 고정판을 청해 본다 — 거절해야 한다
  store.addUrls('k3', [{ url: `${BASE}/products/q1`, kind: 'detail', via: 'manual', discovered_by: 't' }]);
  const st = store.status('k3');
  let refused = '';
  try { store.snapshotNew('k3', { who: 'gate4', reason: '완료 전' }); } catch (e) { refused = e.message.slice(0, 30); }
  const snap = store.snapshotNew('k3', { who: 'gate4', reason: '지금 상태를 굳힌다', force: true });
  const dir = snap.dir;
  const cardsBefore = fs.readFileSync(path.join(dir, 'cards.json'), 'utf8');

  // 고정판을 뜬 뒤 장부를 바꿔도 그 폴더는 그대로여야 한다
  store.addUrls('k3', [{ url: `${BASE}/listing-two`, kind: 'listing', via: 'manual', discovered_by: 't' }]);
  const cardsAfter = fs.readFileSync(path.join(dir, 'cards.json'), 'utf8');
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const frozen = cardsBefore === cardsAfter && manifest.state_version < store.loadState('k3').version;

  // 죽다 만 임시 폴더는 다음 호출이 치운다
  const tmpLeft = path.join(SANDBOX, '.claude/web-search/k3/snapshots', '.tmp-99-deadbeef');
  fs.mkdirSync(tmpLeft, { recursive: true });
  const snap2 = store.snapshotNew('k3', { who: 'gate4', reason: '두 번째', force: true });
  const swept = !fs.existsSync(tmpLeft) && snap2.swept_tmp === 1 && snap2.snapshot === 2;
  const noHalf = fs.readdirSync(path.join(SANDBOX, '.claude/web-search/k3/snapshots')).every((f) => /^\d+$/.test(f));

  check('K3', '고정판은 완료 전엔 거절하고(억지로 뜨면 그 사실을 적고), 뜬 뒤 장부가 바뀌어도 안 변한다',
    refused.includes('아직 끝나지 않아') && manifest.forced === true && frozen
    && swept && noHalf && manifest.cards === 12 && manifest.cards_sha256.length === 64,
    `완료 전 거절="${refused}" · 억지로 뜸=${manifest.forced} · 카드 ${manifest.cards}장 지문 ${manifest.cards_sha256.slice(0, 12)}\n`
    + `      장부 바뀐 뒤에도 내용 그대로=${frozen}(고정판 v${manifest.state_version} < 지금 v${store.loadState('k3').version}) · `
    + `죽다 만 임시 폴더 치움=${swept} · 반쪽 폴더 없음=${noHalf}`);
}

// ---------- K4. wake_details 는 상세 있는 것만, 부모를 대고, 한 번만 깨운다 ----------
{
  const src = `${BASE}/listing-plain`;
  store.createCrawl('k4', { seeds: [], policy: { ...FAST, mode: 'pilot', min_interval_ms: 0, interval_jitter_ms: 0 } });
  const id = normalizeUrl(src).id;
  store.addUrls('k4', [{ url: src, kind: 'listing', via: 'manual', discovered_by: 't' }]);
  const lz = store.leaseUrl('k4', id, 'w');
  await fetchCard('k4', { url: src, url_id: id, lease_token: lz.lease_token, kind: 'listing', maxTier: 'headless' });
  store.report('k4', [{ url_id: id, lease_token: lz.lease_token, state: 'fetched' }]);
  // 상세 링크가 없는 카드도 섞는다
  await collectListing('k4', [`${BASE}/nolink?page=1`], { policy: {}, worker: 'w2' });

  const cards = store.listCards('k4');
  const withDetail = cards.filter((c) => c.detail_url).slice(0, 3);
  const without = cards.filter((c) => !c.detail_url).slice(0, 2);
  const parentOk = withDetail.every((c) => c.source_url_id && store.loadState('k4').urls[c.source_url_id]);

  const r1 = store.wakeDetails('k4', [...withDetail, ...without].map((c) => c.card_id).concat(['no-such-card']),
    { who: 'picker', reason: '눈으로 골랐다' });
  const st1 = store.loadState('k4');
  // 카드 id 는 그림 주소로도 만들어져 장부 키와 다르다. 장부는 상세 주소의 url_id 로 봐야 한다.
  const detailId = (c) => normalizeUrl(c.detail_url).id;
  const queuedNow = withDetail.every((c) => st1.urls[detailId(c)]?.state === 'queued');
  // 부모(목록)의 깊이를 그대로 물려받아야 한다 — 부모를 지우면 0 으로 되살아난다
  const parentHops = st1.urls[withDetail[0].source_url_id]?.external_hops;
  const hops = withDetail.every((c) => st1.urls[detailId(c)]?.external_hops === parentHops);
  const skipWhy = r1.skipped.map((s) => s.why).sort();

  // 두 번 깨워도 다시 등록되지 않는다.
  // 전체 queued 수를 세면 안 된다 — 링크로 정상적으로 들어온 비상세 대기가 함께 있다.
  const r2 = store.wakeDetails('k4', withDetail.map((c) => c.card_id), { who: 'picker', reason: '또 눌렀다' });
  const st2 = store.loadState('k4');
  const stillOne = withDetail.every((c) => {
    const id = detailId(c);
    const sameUrl = Object.entries(st2.urls).filter(([, u]) => u.url === st2.urls[id]?.url);
    return sameUrl.length === 1 && st2.urls[id]?.state === 'queued';
  });

  check('K4', '고른 카드의 상세만 부모를 대고 깨우며, 상세 없는 카드와 두 번째 요청은 사유와 함께 건너뛴다',
    parentOk && r1.queued === 3 && queuedNow && hops
    && skipWhy.length === 3 && skipWhy.includes('unknown_card') && skipWhy.filter((x) => x === 'no_detail_url').length === 2
    && r2.queued === 0 && r2.skipped.every((s) => s.why === 'already_queued') && stillOne,
    `카드에 부모 있음=${parentOk} · 깨움 ${r1.queued}건(모두 queued=${queuedNow}, 부모 깊이 ${parentHops} 물려받음=${hops})\n`
    + `      건너뜀 [${skipWhy.join(', ')}] · 두 번째 요청 깨움 ${r2.queued}건 [${r2.skipped.map((s) => s.why).join(', ')}] · 큐 그대로=${stillOne}`);
}

// ---------- K5. 회차 보고서는 원자적으로 쓰이고, 변화 없이 또 부르면 회차가 안 는다 ----------
{
  const r1 = store.writeCycleReport('k4', { who: 'gate4', reason: '1회차 마감' });
  const file1 = r1.path;
  const body = fs.readFileSync(file1, 'utf8');
  const hasAll = body.includes('완료 판정') && body.includes('막힌 것') && body.includes('카드 수 대조')
    && body.includes('자주 나온 것') && body.includes('빈칸 표') && body.includes('고정판');
  const cycleNow = store.loadState('k4').current_cycle;

  // 바로 두 번 더 부른다 — 파일 수·회차·장부 판이 모두 그대로여야 한다
  const vAfterFirst = store.loadState('k4').version;
  const r2 = store.writeCycleReport('k4', { who: 'gate4', reason: '바로 또' });
  const r2b = store.writeCycleReport('k4', { who: 'gate4', reason: '한 번 더' });
  const cycleAfter = store.loadState('k4').current_cycle;
  const vAfterRetries = store.loadState('k4').version;
  const files = fs.readdirSync(path.join(SANDBOX, '.claude/web-search/k4/reports')).filter((f) => /^cycle-\d+\.md$/.test(f));

  // 장부가 바뀌면 다음 회차가 열린다
  store.addUrls('k4', [{ url: `${BASE}/listing-two`, kind: 'listing', via: 'manual', discovered_by: 't' }]);
  const r3 = store.writeCycleReport('k4', { who: 'gate4', reason: '2회차 마감' });

  check('K5', '회차 보고서는 한 번만 열리고, 장부가 그대로면 빈 회차가 늘지 않는다',
    r1.cycle === 1 && hasAll && cycleNow === 2
    && r2.unchanged === true && r2b.unchanged === true && cycleAfter === 2 && files.length === 1
    && vAfterRetries === vAfterFirst
    && r3.unchanged === false && r3.cycle === 2 && store.loadState('k4').current_cycle === 3,
    `1회차 → ${path.basename(file1)}(모든 꼭지 있음=${hasAll}) 다음 회차 ${cycleNow}\n`
    + `      두 번 더 부름: 새로 안 씀=${r2.unchanged}/${r2b.unchanged} 회차 ${cycleAfter} 파일 ${files.length}개 `
    + `장부 판 ${vAfterFirst}→${vAfterRetries}(그대로) · `
    + `장부 바뀐 뒤: ${r3.cycle}회차 열림(다음 ${store.loadState('k4').current_cycle})`);
}

// ---------- K6. MCP 로도 요약·깨우기·고정판·회차가 실제로 돈다 ----------
{
  const server = path.join(HERE, '..', 'server.mjs');
  const k4state = store.loadState('k4');
  const wakeTarget = store.listCards('k4').find((c) => c.detail_url
    && (!k4state.urls[c.card_id] || k4state.urls[c.card_id].state === 'known_deferred'));
  const out = await new Promise((resolve) => {
    const p = spawn(process.execPath, [server], { env: { ...process.env, CLAUDE_PROJECT_DIR: SANDBOX }, stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '';
    p.stdout.on('data', (d) => (buf += d));
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n');
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'status', arguments: { crawl: 'k1' } } }) + '\n');
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'wake_details', arguments: { crawl: 'k4', card_ids: [wakeTarget?.card_id || 'none'], who: 'mcp', reason: '골랐다' } } }) + '\n');
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'snapshot', arguments: { crawl: 'k4', who: 'mcp', reason: '굳힌다', force: true } } }) + '\n');
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'cycle_report', arguments: { crawl: 'k4', who: 'mcp', reason: '마감' } } }) + '\n');
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'snapshot', arguments: { crawl: 'k4', list: true } } }) + '\n');
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'wake_details', arguments: { crawl: 'k4', card_ids: ['x'] } } }) + '\n');
    p.stdin.end();
    p.on('close', () => resolve(buf));
    setTimeout(() => { try { p.kill(); } catch {} resolve(buf); }, 60_000);
  });
  const by = Object.fromEntries(out.trim().split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).map((m) => [m.id, m]));
  const names = (by[2]?.result?.tools || []).map((t) => t.name);
  const t = (id) => String(by[id]?.result?.content?.[0]?.text || '') + String(by[id]?.error?.message || '');
  const statusText = t(3);
  const hasTools = ['wake_details', 'snapshot', 'cycle_report'].every((n) => names.includes(n));
  const statusShows = /자주 나온 도메인:/.test(statusText) && /자주 나온 낱말:/.test(statusText)
    && /빈칸 표:/.test(statusText) && /카드 \d+장 · 표시 수 대조/.test(statusText)
    && /사람 확인 대기 \d+건/.test(statusText);
  const woke = /깨움 1건 \/ 요청 1건/.test(t(4));
  const snapped = /고정판 #\d+ 떴습니다/.test(t(5));
  const cycled = /회차 보고서를 썼습니다/.test(t(6));
  const listed = /^#1 · 카드/.test(t(7));
  const needsWho = /who|reason/.test(t(8)) && !t(8).includes('깨움');

  check('K6', 'MCP 로도 요약·깨우기·고정판·회차가 실제로 돌고, 누가·왜 없이는 안 된다',
    hasTools && statusShows && woke && snapped && cycled && listed && needsWho,
    `도구 있음=${hasTools} · status 본문에 도메인·낱말·빈칸·카드 대조 노출=${statusShows}\n`
    + `      ${statusText.split('\n').filter((l) => l.includes('자주 나온') || l.includes('빈칸') || l.includes('표시 수')).slice(0, 3).join(' | ')}\n`
    + `      깨우기=${woke} · 고정판=${snapped} · 회차=${cycled} · 목록=${listed} · 누가·왜 없으면 거절=${needsWho}`);
}

// ---------- K7. 다 끝난 크롤은 force 없이 고정판이 떠지고, 동시에 불러도 번호가 안 겹친다 ----------
{
  const src = `${BASE}/listing-plain`;
  // 이제 목록을 열면 그 쪽에서 본 링크가 더미에 들어온다. 그래서 "다 끝난 크롤" 을 만들려면
  // 실제로 큐를 비워야 한다. 바깥 도메인은 로컬 시험이 진짜로 나가면 안 되므로 명시로 막는다.
  store.createCrawl('k7', {
    seeds: [],
    policy: { ...FAST, mode: 'pilot', min_interval_ms: 0, interval_jitter_ms: 0, deny_domains: ['x.example'] },
  });
  const id = normalizeUrl(src).id;
  store.addUrls('k7', [{ url: src, kind: 'listing', via: 'manual', discovered_by: 't' }]);
  const lz = store.leaseUrl('k7', id, 'w');
  await fetchCard('k7', { url: src, url_id: id, lease_token: lz.lease_token, kind: 'listing', maxTier: 'headless' });
  store.report('k7', [{ url_id: id, lease_token: lz.lease_token, state: 'fetched' }]);

  // 남은 대기줄을 워커와 같은 규칙으로 비운다 — 상세는 재우고, 나머지는 연다
  for (let i = 0; i < 200; i++) {
    const l = store.lease('k7', 1, 'w').leased[0];
    if (!l) break;
    if (l.kind === 'detail') { store.report('k7', [{ url_id: l.url_id, lease_token: l.lease_token, state: 'known_deferred' }]); continue; }
    const rr = await fetchCard('k7', { url: l.url, url_id: l.url_id, lease_token: l.lease_token, kind: l.kind, maxTier: 'headless' });
    store.report('k7', [{ url_id: l.url_id, lease_token: l.lease_token,
      state: rr.page_validity === 'invalid' ? 'invalid' : rr.page_validity === 'needs_visual_review' ? 'needs_visual_review' : 'fetched' }]);
  }

  const st = store.status('k7');
  const done = st.completion === 'complete';
  const snap = store.snapshotNew('k7', { who: 'gate4', reason: '끝났으니 굳힌다' });   // force 없이
  const notForced = snap.forced === false && snap.snapshot === 1;

  // 두 프로세스가 같은 순간에 뜬다 — 번호가 겹치거나 반쪽 폴더가 남으면 안 된다
  const startAt = Date.now() + 400;
  const code = `
    const store = await import(${JSON.stringify(path.join(LIB, 'store.mjs'))});
    const startAt = Number(process.argv[1]);
    while (Date.now() < startAt) {}
    const m = store.snapshotNew('k7', { who: 'p' + process.pid, reason: '동시', force: true });
    console.log('SNAP ' + m.snapshot);
  `;
  const run = () => new Promise((resolve) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', code, String(startAt)],
      { env: { ...process.env, CLAUDE_PROJECT_DIR: SANDBOX }, stdio: ['ignore', 'pipe', 'pipe'] });
    let o = '', e = '';
    p.stdout.on('data', (d) => (o += d)); p.stderr.on('data', (d) => (e += d));
    p.on('close', (c) => resolve({ out: o.trim(), err: e.trim(), code: c }));
  });
  const [a, b] = await Promise.all([run(), run()]);
  const dirs = fs.readdirSync(path.join(SANDBOX, '.claude/web-search/k7/snapshots'));
  const numbered = dirs.filter((f) => /^\d+$/.test(f)).sort();
  const noHalf = dirs.every((f) => /^\d+$/.test(f));
  const nums = [a.out, b.out].map((x) => Number(String(x).split(' ')[1]));
  const distinct = a.code === 0 && b.code === 0 && new Set(nums).size === 2;

  check('K7', '다 끝난 크롤은 force 없이 고정판이 떠지고, 동시에 불러도 번호가 겹치거나 반쪽 폴더가 남지 않는다',
    done && notForced && distinct && numbered.length === 3 && noHalf,
    `완료 판정=${st.completion} · force 없이 뜸 #${snap.snapshot}(억지 아님=${notForced})\n`
    + `      동시 두 번: [${a.out}] [${b.out}] 번호 안 겹침=${distinct} · 폴더 ${numbered.join(',')} · 반쪽 없음=${noHalf}`);
}

// ---------- K8. 쉬는 도메인과 카드 추출 미확정은 완료를 막는다 ----------
{
  const paths2 = await import(path.join(LIB, 'paths.mjs'));

  store.createCrawl('k8', { seeds: [], policy: { ...FAST, mode: 'pilot', min_interval_ms: 0, interval_jitter_ms: 0 } });
  await collectListing('k8', [`${BASE}/ambiguous`], { worker: 'w' });
  const s1 = store.status('k8');
  const blockedByCards = s1.completion === 'paused_incomplete' && s1.cards_incomplete.length === 1
    && s1.completion_reason.includes('카드 추출이 확정 안 된');

  const s2before = store.status('k7');
  const paceFile = paths2.paceFile(HOST);
  const rec = JSON.parse(fs.readFileSync(paceFile, 'utf8'));
  const saved = JSON.stringify(rec, null, 2);
  rec.sleep_until = Date.now() + 600_000;
  fs.writeFileSync(paceFile, JSON.stringify(rec, null, 2));
  const s2 = store.status('k7');
  fs.writeFileSync(paceFile, saved);                       // 뒤 시험을 재우지 않는다
  const s2after = store.status('k7');
  const blockedBySleep = s2before.completion === 'complete' && s2.completion === 'paused_incomplete'
    && s2.sleeping_domains.length === 1 && s2.completion_reason.includes('쉬는 중')
    && s2after.completion === 'complete';

  check('K8', '카드 추출이 확정 안 된 쪽과 쉬는 도메인은 완료를 막는다',
    blockedByCards && blockedBySleep,
    `(가) 추출 미확정 ${s1.cards_incomplete.length}곳 → ${s1.completion}(${s1.completion_reason})\n`
    + `      (나) 재우기 전 ${s2before.completion} → 재운 뒤 ${s2.completion}(${s2.sleeping_domains[0]?.domain} ${s2.sleeping_domains[0]?.seconds}초) → 깨운 뒤 ${s2after.completion}`);
}

// ---------- K9. 사이트맵을 건너뛴 훑기는 어느 모드에서도 완주가 아니다 ----------
{
  const disc = await import(path.join(LIB, 'discover.mjs'));
  store.createCrawl('k9', { seeds: [], policy: { ...FAST, mode: 'pilot', min_interval_ms: 0, interval_jitter_ms: 0 } });
  let r = null;
  for (let i = 0; i < 300; i++) {
    r = await disc.discover('k9', { origin: BASE, worker: 'k9', skipSitemaps: true, extraSeeds: [`${BASE}/listing-two`], fetchSeeds: true });
    if (!r.deferred) break;
    await new Promise((res) => setTimeout(res, ((r.wait_seconds || 1) * 1000) + 20));
  }
  const o1 = store.status('k9').origins.find((x) => x.origin === BASE);

  for (let i = 0; i < 400; i++) {
    r = await disc.discover('k9', { origin: BASE, worker: 'k9', refresh: true });
    if (!r.deferred) break;
    await new Promise((res) => setTimeout(res, ((r.wait_seconds || 1) * 1000) + 20));
  }
  const o2 = store.status('k9').origins.find((x) => x.origin === BASE);

  check('K9', '사이트맵을 건너뛴 훑기는 완주로 안 치고, 사이트맵까지 본 뒤에야 끝난 것으로 본다',
    r?.done === true && o1?.state === 'done_without_sitemaps' && o2?.state === 'done' && o2.sitemaps_visited >= 3,
    `건너뛴 회차: ${o1?.state}(사이트맵 ${o1?.sitemaps_visited}개) → 사이트맵까지 본 회차: ${o2?.state}(${o2?.sitemaps_visited}개)`);
}

// ---------- K10. 표시 총수는 묶음 합집합과 맞을 때만 통과하고, 범위를 모르면 사람에게 넘긴다 ----------
{
  store.createCrawl('k10', {
    seeds: [], policy: { ...FAST, mode: 'pilot', min_interval_ms: 0, interval_jitter_ms: 0, listing_path_patterns: ['/listing-paged'] },
  });
  await collectListing('k10', [`${BASE}/listing-paged?page=1`], { worker: 'w' });
  const s1 = store.status('k10');
  const asReview = s1.declared_needs_review.length === 1 && s1.card_count_mismatch.length === 0
    && s1.declared_needs_review[0].declared === 56 && s1.completion_reason.includes('표시 수의 범위를 모르는');

  // 쪽마다 "목록 전체 수"를 적는 목록 — 쪽 수로는 절대 안 맞고 두 쪽 합집합이라야 맞는다
  store.createCrawl('k10b', {
    seeds: [], policy: { ...FAST, mode: 'pilot', min_interval_ms: 0, interval_jitter_ms: 0, listing_path_patterns: ['/paged-total'] },
  });
  await collectListing('k10b', [`${BASE}/paged-total?page=1`], { worker: 'w' });
  const half = store.status('k10b');
  const halfUnknown = half.declared_needs_review.length === 1
    && half.declared_needs_review[0].declared === 10 && half.declared_needs_review[0].page === 6
    && half.card_count_mismatch.length === 0;

  await collectListing('k10b', [`${BASE}/paged-total?page=2`], { worker: 'w2' });
  const s2 = store.status('k10b');
  const union = new Set(Object.values(store.loadState('k10b').urls).flatMap((u) => u.card_ids || [])).size;
  const matched = s2.declared_needs_review.length === 0 && s2.card_count_mismatch.length === 0 && union === 10;

  check('K10', '표시 수는 쪽 수나 묶음 합집합과 맞을 때만 통과하고, 범위를 모르면 어긋났다고 단정하지 않는다',
    asReview && halfUnknown && matched,
    `총 56개라 적고 12장 보인 쪽 → 사람 확인 ${s1.declared_needs_review.length}건(어긋남 단정 ${s1.card_count_mismatch.length}건)\n`
    + `      전체 10개 선언·1쪽만 모음(6장) → 사람 확인 ${half.declared_needs_review.length}건 · `
    + `2쪽까지 모아 합집합 ${union}개 → 사람 확인 ${s2.declared_needs_review.length}건 · 어긋남 ${s2.card_count_mismatch.length}건`);
}

// ---------- K11. 회차 보고서에 막힌 근거·깨우기·고정판이 값으로 들어간다 ----------
{
  // 카드가 실제로 있는 크롤이라야 깨우기·고정판이 값으로 들어간다
  store.createCrawl('k11', { seeds: [], policy: { ...FAST, mode: 'pilot', min_interval_ms: 0, interval_jitter_ms: 0 } });
  await collectListing('k11', [`${BASE}/listing-plain`], { worker: 'w' });

  const rep = store.writeCycleReport('k11', { who: 'gate4', reason: '보고서 본문 확인' });
  const body = fs.readFileSync(rep.path, 'utf8');
  const firstHadNoWake = body.includes('이 회차에 깨운 상세가 없습니다');

  // 한 회차에서 두 번 깨운다 — 합계가 남아야 하고 마지막 것만 남으면 안 된다
  const two = store.listCards('k11').filter((c) => c.detail_state === 'known_deferred' && c.detail_url).slice(0, 2);
  store.wakeDetails('k11', [two[0].card_id], { who: 'picker', reason: '첫 번째' });
  store.wakeDetails('k11', [two[1].card_id], { who: 'picker', reason: '두 번째' });
  store.snapshotNew('k11', { who: 'gate4', reason: '보고서용', force: true });
  const rep2 = store.writeCycleReport('k11', { who: 'gate4', reason: '두 번째 회차' });
  const body2 = fs.readFileSync(rep2.path, 'utf8');

  // 깨우지 않고 다음 회차 보고서를 쓰면 지난 회차 깨우기가 다시 나오면 안 된다
  store.addUrls('k11', [{ url: `${BASE}/listing-two`, kind: 'listing', via: 'manual', discovered_by: 't' }]);
  const rep3 = store.writeCycleReport('k11', { who: 'gate4', reason: '세 번째 회차' });
  const body3 = fs.readFileSync(rep3.path, 'utf8');
  const noCarryOver = body3.includes('이 회차에 깨운 상세가 없습니다');

  const hasWake = /## 깨운 상세\n- 이 회차 2번 불러 요청 2건 중 2건 깨움/.test(body2);
  const hasSnap = /## 고정판\n- #1 · 카드 \d+장/.test(body2);
  const hasLeft = body2.includes('## 아직 남은 일');
  const hasCounts = /주소 \d+개 · 카드 \d+장/.test(body2);

  check('K11', '회차 보고서에 그 회차의 깨우기 합계·고정판·남은 일이 값으로 들어가고, 지난 회차 것이 되풀이되지 않는다',
    firstHadNoWake && hasWake && hasSnap && hasLeft && hasCounts
    && rep2.cycle === rep.cycle + 1 && noCarryOver && rep3.cycle === rep2.cycle + 1,
    `1회차: 깨운 것 없음 표기=${firstHadNoWake}\n`
    + `      2회차: ${body2.split('\n').filter((l) => l.startsWith('- ') && (l.includes('깨움') || l.includes('#1 ·'))).join(' | ')}\n`
    + `      3회차: 지난 깨우기 안 되풀이=${noCarryOver} · 남은 일 꼭지=${hasLeft} · 셈 들어감=${hasCounts}`);
}

// ---------- K12. 고정판은 판정과 내용이 같은 판에서 나온다 ----------
{
  const before = store.loadState('k7').version;
  const snap = store.snapshotNew('k7', { who: 'gate4', reason: '판 대조', force: true });
  const cards = JSON.parse(fs.readFileSync(path.join(snap.dir, 'cards.json'), 'utf8'));
  const live = store.listCards('k7');
  const sameNow = JSON.stringify(cards.map((c) => c.card_id).sort()) === JSON.stringify(live.map((c) => c.card_id).sort());
  const versionSane = snap.state_version === before && store.loadState('k7').version === before + 1;

  store.addUrls('k7', [{ url: `${BASE}/listing-two`, kind: 'listing', via: 'manual', discovered_by: 't' }]);
  const after = JSON.parse(fs.readFileSync(path.join(snap.dir, 'cards.json'), 'utf8'));
  const frozen = JSON.stringify(after) === JSON.stringify(cards);

  check('K12', '고정판의 판정·내용·판 번호가 한 시점에서 나오고, 그 뒤 장부가 바뀌어도 안 변한다',
    sameNow && versionSane && frozen && snap.cards === cards.length,
    `뜬 직후 살아 있는 장부와 같음=${sameNow} · 판 번호 ${snap.state_version}(뜨기 전 ${before}, 뜬 뒤 ${store.loadState('k7').version}) · `
    + `장부 바뀐 뒤에도 그대로=${frozen} · 카드 ${snap.cards}장`);
}

// ========== 게이트 4 본 항목 (계획서 4장 다섯 줄) ==========

// ---------- G4-1. 워커 둘이 동시에 빌려도 겹치지 않는다 ----------
{
  store.createCrawl('g41', { seeds: [], policy: { ...FAST, mode: 'pilot' } });
  store.addUrls('g41', Array.from({ length: 40 }, (_, i) => ({
    url: `${BASE}/maze/${100 + i}`, kind: 'unknown', via: 'manual', discovered_by: 't',
  })));
  const startAt = Date.now() + 400;
  const code = `
    const store = await import(${JSON.stringify(path.join(LIB, 'store.mjs'))});
    const startAt = Number(process.argv[1]);
    while (Date.now() < startAt) {}
    const r = store.lease('g41', 20, 'w' + process.pid);
    console.log(JSON.stringify(r.leased.map((x) => [x.url_id, x.lease_token])));
  `;
  const run = () => new Promise((resolve) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', code, String(startAt)],
      { env: { ...process.env, CLAUDE_PROJECT_DIR: SANDBOX }, stdio: ['ignore', 'pipe', 'pipe'] });
    let o = '', e = '';
    p.stdout.on('data', (d) => (o += d)); p.stderr.on('data', (d) => (e += d));
    p.on('close', (c) => resolve({ out: o.trim(), err: e.trim(), code: c }));
  });
  const [a, b] = await Promise.all([run(), run()]);
  const A = JSON.parse(a.out || '[]');
  const B = JSON.parse(b.out || '[]');
  const idsA = new Set(A.map((x) => x[0]));
  const overlap = B.filter((x) => idsA.has(x[0]));
  const tokens = [...A, ...B].map((x) => x[1]);
  const tokensUnique = new Set(tokens).size === tokens.length;
  const st = store.loadState('g41');
  const leasedCount = Object.values(st.urls).filter((u) => u.state === 'leased').length;

  check('G4-1', '워커 둘이 같은 크롤에서 동시에 빌려도 같은 주소·같은 표를 두 번 주지 않는다',
    a.code === 0 && b.code === 0 && A.length + B.length === 40 && overlap.length === 0
    && tokensUnique && leasedCount === 40,
    `프로세스 A ${A.length}건 · B ${B.length}건 · 겹친 주소 ${overlap.length}건 · 표 모두 다름=${tokensUnique} · `
    + `장부에 임대 표시 ${leasedCount}건`);
}

// ---------- G4-2. 죽은 워커의 몫은 시간이 지나면 다른 워커에게 간다 ----------
{
  store.createCrawl('g42', { seeds: [], policy: { ...FAST, mode: 'pilot', lease_ttl_ms: 1_000, max_attempts: 5 } });
  const u = `${BASE}/maze/7`;
  store.addUrls('g42', [{ url: u, kind: 'unknown', via: 'manual', discovered_by: 't' }]);
  const id = normalizeUrl(u).id;

  // 자식이 빌려 쥔 채 죽는다
  const kid = spawn(process.execPath, ['--input-type=module', '-e', `
    const store = await import(${JSON.stringify(path.join(LIB, 'store.mjs'))});
    const r = store.leaseUrl('g42', ${JSON.stringify(id)}, 'dead-worker');
    console.log(r.lease_token);
    await new Promise(() => {});
  `], { env: { ...process.env, CLAUDE_PROJECT_DIR: SANDBOX }, stdio: ['ignore', 'pipe', 'pipe'] });
  const oldToken = await new Promise((res) => kid.stdout.once('data', (d) => res(String(d).trim())));
  const closed = new Promise((res) => kid.once('close', (c, s) => res(s || c)));
  kid.kill('SIGKILL');
  const sig = await closed;

  const heldByDead = store.loadState('g42').urls[id].lease?.worker === 'dead-worker';
  // 아직 시간이 안 지났으면 남이 못 가져간다
  const tooSoon = store.leaseUrl('g42', id, 'next');
  await new Promise((res) => setTimeout(res, 1_200));       // 실제 TTL 이 지나기를 기다린다
  const reassigned = store.leaseUrl('g42', id, 'next');
  const newToken = reassigned.lease_token;

  // 죽은 워커의 옛 표로 온 결과는 거절된다
  const late = store.report('g42', [{ url_id: id, lease_token: oldToken, state: 'fetched' }]);
  const ok = store.report('g42', [{ url_id: id, lease_token: newToken, state: 'fetched' }]);
  const ev = fs.readFileSync(path.join(SANDBOX, '.claude/web-search/g42/events.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map(JSON.parse);
  const expiredEv = ev.find((e) => e.type === 'lease_expired_requeued' && e.url_id === id);
  const rejectedEv = ev.find((e) => e.type === 'late_report_rejected' && e.url_id === id);

  check('G4-2', '빌린 워커가 죽으면 시간이 지난 뒤 그 몫이 다른 워커에게 가고, 죽은 워커의 옛 표는 거절된다',
    String(sig) === 'SIGKILL' && heldByDead && tooSoon.ok === false && tooSoon.why === 'already_leased'
    && reassigned.ok === true && newToken !== oldToken
    && late.accepted === 0 && late.rejects[0].why === 'stale_lease_token' && ok.accepted === 1
    && !!expiredEv && !!rejectedEv,
    `죽음=${sig} · 죽은 워커가 쥐고 있었음=${heldByDead} · 시간 전 재배정 거절=${tooSoon.why}\n`
    + `      시간 뒤 재배정=${reassigned.ok}(표 바뀜=${newToken !== oldToken}) · 옛 표 보고 거절=${late.rejects[0]?.why} · 새 표 보고 반영=${ok.accepted}건\n`
    + `      장부 기록: 만료 회수=${!!expiredEv} 늦은 보고 거절=${!!rejectedEv}`);
}

// ---------- G4-3. 경계 밖 링크는 더미에 없고, 이유·부모·규칙이 남는다 ----------
{
  const seed = `${BASE}/listing-plain`;
  store.createCrawl('g43', {
    seeds: [seed],
    policy: { ...FAST, mode: 'pilot', allow_domains: [HOST], deny_domains: ['blocked.test'], external_hop_max: 0 },
  });
  const parent = normalizeUrl(seed).id;
  const r = store.addUrls('g43', [
    { url: 'http://blocked.test/a', kind: 'unknown', via: 'link', from_url_id: parent, discovered_by: 'link:목록' },
    { url: 'http://outside.test/b', kind: 'unknown', via: 'link', from_url_id: parent, discovered_by: 'link:목록' },
  ]);
  const st = store.loadState('g43');
  const inLedger = Object.values(st.urls).some((x) => /blocked\.test|outside\.test/.test(x.url));
  const ex = store.listExcluded('g43');
  const den = ex.active.find((x) => x.url.includes('blocked.test'));
  const hop = ex.active.find((x) => x.url.includes('outside.test'));
  const s = store.status('g43');
  const shown = s.excluded_active === 2 && s.excluded_sample.some((x) => x.why === 'denied_domain');

  check('G4-3', '경계를 통과 못 한 링크는 더미·대기줄에 없고, 사유·부모·규칙 근거가 남는다',
    !inLedger && r.rejected === 2 && ex.active.length === 2
    && den?.why === 'denied_domain' && den.from_url_id === parent && den.evidence?.deny_domains?.includes('blocked.test')
    && hop?.why === 'external_hop_exceeded' && hop.from_url_id === parent && hop.evidence?.external_hop_max === 0
    && den.discovered_by.includes('link:목록') && shown,
    `더미에 없음=${!inLedger} · 거절 ${r.rejected}건 · 제외 장부 ${ex.active.length}건\n`
    + `      제외 도메인: ${den?.why} 규칙 ${JSON.stringify(den?.evidence?.deny_domains)} 부모=${den?.from_url_id === parent} 발견경로 ${den?.discovered_by}\n`
    + `      바깥 이동: ${hop?.why} 한도 ${hop?.evidence?.external_hop_max} 부모=${hop?.from_url_id === parent} · status 노출=${shown}`);
}

// ---------- G4-4. 끝없이 갈라지는 자리는 상한에 서고, 늘어난 형태가 보고서까지 간다 ----------
{
  const seed = `${BASE}/maze/1`;
  store.createCrawl('g44', {
    seeds: [seed],
    policy: { ...FAST, mode: 'pilot', allow_domains: [HOST], path_shape_cap: 8, domain_url_cap: 500 },
  });
  // [실제 순회] 갈림길을 진짜로 열어 그 쪽이 내놓은 링크를 수확해 큐에 넣는다.
  // 주소를 손으로 넣으면 fixture 를 쓴 것이 아니라 상한 계산만 시험하는 셈이 된다.
  let fetched = 0;
  for (let step = 0; step < 60; step++) {
    const queued = Object.entries(store.loadState('g44').urls).find(([, u]) => u.state === 'queued' && /\/maze\//.test(u.url));
    if (!queued) break;
    const [uid, rec] = queued;
    const lz = store.leaseUrl('g44', uid, 'maze');
    if (!lz.ok) break;
    const got = await fetchCard('g44', { url: rec.url, url_id: uid, lease_token: lz.lease_token, kind: 'unknown', maxTier: 'curl' });
    store.report('g44', [{ url_id: uid, lease_token: lz.lease_token, state: 'fetched' }]);
    fetched++;
    // 그 쪽이 실제로 내놓은 갈림길 링크만 거둔다
    const hrefs = [...String(got.body || '').matchAll(/<a[^>]+href="([^"]+)"/g)].map((m) => m[1])
      .filter((h) => /^\/maze\//.test(h));
    if (hrefs.length) {
      store.addUrls('g44', hrefs.map((h) => ({
        url: new URL(h, BASE).toString(), kind: 'unknown',
        via: 'link', from_url_id: uid, discovered_by: `link:${got.final || rec.url}`,
      })));
    }
  }
  const st = store.loadState('g44');
  const rev = st.domains?.[HOST]?.boundary_review;
  const maze = Object.values(st.urls).filter((x) => /\/maze\//.test(x.url)).length;
  const parked = Object.values(st.boundary_candidates).filter((c) => c.why === 'path_shape_cap').length;
  const shape = rev?.top_shapes?.find((t) => t.what === '/maze/*');
  const s = store.status('g44');
  const inStatus = s.boundary_review_domains.includes(HOST) && s.boundary_candidates === parked
    && s.completion === 'paused_incomplete' && s.completion_reason.includes('경계 검토 대기');

  // status 구조에도 형태·개수·상한이 값으로 있어야 한다
  const sr = s.boundary_reviews.find((b) => b.domain === HOST);
  const inStatusStruct = sr?.why === 'path_shape_cap' && sr.evidence?.cap === 8
    && sr.top_shapes.some((x) => x.what === '/maze/*' && x.count === 8);

  // 회차 보고서 본문에도 같은 값이 찍혀야 한다
  const rep = store.writeCycleReport('g44', { who: 'gate4', reason: '상한 근거가 보고서에 남는지' });
  const body = fs.readFileSync(rep.path, 'utf8');
  const inReport = /경계 검토 127\.0\.0\.1: path_shape_cap \(상한 8\)/.test(body)
    && /늘어난 형태 \/maze\/\* 8개/.test(body);

  check('G4-4', '끝없이 갈라지는 자리는 실제 순회에서 상한에 서고, 늘어난 경로 형태·개수·상한이 status 와 보고서에 값으로 남는다',
    fetched === 8 && maze === 8 && parked > 0 && rev?.why === 'path_shape_cap' && shape?.count === 8
    && rev.evidence?.cap === 8 && inStatus && inStatusStruct && inReport,
    `실제로 연 갈림길 ${fetched}쪽 · 들인 /maze 주소 ${maze}개(상한 8) · 세워 둔 후보 ${parked}건 · 사유 ${rev?.why}\n`
    + `      status 구조: ${JSON.stringify(sr?.top_shapes)} 상한 ${sr?.evidence?.cap} · 완료 아님=${inStatus}\n`
    + `      보고서 ${path.basename(rep.path)}: ${body.split('\n').find((l) => l.includes('경계 검토')) || '(없음)'}`);
}

// ---------- G4-5. MCP status 가 도메인·낱말·막힘 표본·빈칸을 값으로 보여 준다 ----------
{
  const server = path.join(HERE, '..', 'server.mjs');
  const out = await new Promise((resolve) => {
    const p = spawn(process.execPath, [server], { env: { ...process.env, CLAUDE_PROJECT_DIR: SANDBOX }, stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '';
    p.stdout.on('data', (d) => (buf += d));
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n');
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'status', arguments: { crawl: 'k1' } } }) + '\n');
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'status', arguments: { crawl: 'g44' } } }) + '\n');
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'evidence', arguments: { crawl: 'g43', what: 'excluded' } } }) + '\n');
    p.stdin.end();
    p.on('close', () => resolve(buf));
    setTimeout(() => { try { p.kill(); } catch {} resolve(buf); }, 60_000);
  });
  const by = Object.fromEntries(out.trim().split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).map((m) => [m.id, m]));
  const t = (id) => String(by[id]?.result?.content?.[0]?.text || '');
  const k1 = t(2), g44 = t(3), ex = t(4);

  const hasDomains = /자주 나온 도메인: 127\.0\.0\.1\(\d+\)/.test(k1);
  const hasWords = /자주 나온 낱말: \S+\(\d+\)/.test(k1);
  const hasCoverage = /빈칸 표:\n\s+country: 빈칸 \[US\]/.test(k1) && /vendor_type: 빈칸 \[mcheong\]/.test(k1);
  const hasReview = /사람 확인 대기 1건/.test(k1);
  // 막힌 곳은 개수만이 아니라 어떤 형태가 몇 개까지 늘어 어느 상한에 닿았는지가 보여야 한다
  const hasBoundary = /상한에 세워 둔 후보 \d+건/.test(g44)
    && /경계 검토 127\.0\.0\.1: path_shape_cap\(상한 8\) · 형태 \/maze\/\* 8개/.test(g44);
  const hasExcluded = /안 들인 것 2건/.test(ex) && ex.includes('denied_domain');

  check('G4-5', 'MCP status 가 자주 나온 도메인·낱말, 막힌 곳의 형태·개수·상한, 빈칸 표를 실제 값으로 보여 준다',
    hasDomains && hasWords && hasCoverage && hasReview && hasBoundary && hasExcluded,
    `${k1.split('\n').filter((l) => /자주 나온|빈칸|사람 확인/.test(l)).join('\n      ')}\n`
    + `      g44: ${g44.split('\n').filter((l) => l.includes('경계 검토') || l.includes('상한에 세워')).join(' | ')}\n`
    + `      evidence: ${ex.split('\n')[0]}`);
}

// ---------- L1~L5. 목록을 열며 본 링크가 장부로 돌아온다 ----------
// discover 가 직접 연 씨앗·홈에서만 링크를 거두면, 사이트맵으로 큐에 든 뒤 워커가 연
// 목록·후기 쪽의 링크는 어디에도 안 남는다. 그러면 "새 바깥 도메인 0" 은 관찰이 아니라 미관측이다.
// 계약: fetch 가 이번 표와 판정에 묶인 "나가는 링크" note 를 남기고, report 가 그 표를
// 받아들이는 같은 원자 변경 안에서만 그 note 를 읽어 경계 판정을 거쳐 더미에 합친다.
// (워커가 report 성공 뒤 따로 add_urls 하면 그 사이에 죽을 때 링크가 사라진다.)
{
  const { fetchOne } = await import(path.join(LIB, 'fetch.mjs'));
  const crawl = 'l-links';
  store.createCrawl(crawl, {
    seeds: [`${BASE}/listing-jsonld`],
    policy: { ...FAST, mode: 'exhaustive', allow_domains: [HOST], external_hop_max: 2 },
  });
  const a = store.lease(crawl, 1, 'w1').leased[0];
  const fr = await fetchOne(crawl, { url: a.url, url_id: a.url_id, lease_token: a.lease_token, kind: 'listing', maxTier: 'headless' });

  // L2 를 먼저 본다 — 들일 링크가 실제로 있는데도 표가 틀리면 한 칸도 안 들어와야 한다.
  // note 가 아예 없으면 "0칸" 은 안전이 아니라 아무것도 안 한 것이다.
  const notePath = path.join(SANDBOX, '.claude/web-search', crawl, 'manifests', a.url_id, 'notes', 'links.json');
  const note = fs.existsSync(notePath) ? JSON.parse(fs.readFileSync(notePath, 'utf8')) : null;
  const beforeStale = Object.keys(store.loadState(crawl).urls).length;
  const staleRep = store.report(crawl, [{ url_id: a.url_id, lease_token: '틀린표', state: 'fetched' }]);
  const afterStale = Object.keys(store.loadState(crawl).urls).length;
  check('L2', '들일 링크가 있는데도 늦은 표면 한 칸도 안 들인다(임대 검사가 먼저다)',
    !!note && (note.links || []).length >= 1
    && staleRep.accepted === 0 && afterStale === beforeStale,
    `링크 note ${note ? `있음(${(note.links || []).length}개)` : '없음'} · 반영 ${staleRep.accepted} · `
    + `거절 ${(staleRep.rejects || []).map((x) => x.why).join(',')} · 장부 ${beforeStale} → ${afterStale}칸`);

  const rep = store.report(crawl, [{ url_id: a.url_id, lease_token: a.lease_token, state: 'fetched' }]);
  const st = store.loadState(crawl);
  const inner = Object.values(st.urls).filter((u) => u.domain === HOST && u.url !== a.url);
  const outer = Object.values(st.urls).filter((u) => u.domain === 'x.example');
  // [출처] discovered_by 는 사람이 읽는 메모다. 권한의 근거는 구조화된 provenance 여야 한다.
  const parented = [...inner, ...outer]
    .filter((u) => (u.provenance || []).some((p) => p.via === 'link' && p.from_url_id === a.url_id));
  const hops1 = outer.filter((u) => u.external_hops === 1);
  const all = [...inner, ...outer];
  // 목록 우선 계약 — 상세는 처음부터 재워 두고, 나머지만 대기줄에 든다
  const details = all.filter((u) => u.kind === 'detail');
  const nonDetail = all.filter((u) => u.kind !== 'detail');
  const detailAsleep = details.filter((u) => u.state === 'known_deferred');
  const queued = nonDetail.filter((u) => u.state === 'queued');
  const p1 = inner.find((u) => /\/products\/p1$/.test(u.url));

  check('L1', `정상 표로 반납하면 그 쪽(판정 ${fr.page_validity})에서 본 링크가 부모·다리 수·종류를 달고 들어오고, 상세는 재워진다`,
    rep.accepted === 1 && inner.length > 0 && outer.length === 3
    && hops1.length === 3 && parented.length === all.length
    && details.length > 0 && detailAsleep.length === details.length
    && queued.length === nonDetail.length
    && p1?.kind === 'detail' && p1?.state === 'known_deferred',
    `반영 ${rep.accepted}(링크 본 것 ${rep.links_seen} · 들인 것 ${rep.links_added}) · 안쪽 ${inner.length}칸 · `
    + `바깥 ${outer.length}칸(한 다리 ${hops1.length}) · 부모=${a.url_id} 기록 ${parented.length} · `
    + `상세 ${details.length}칸(재움 ${detailAsleep.length}) · 그 밖 대기 ${queued.length}/${nonDetail.length} · `
    + `/products/p1 → ${p1?.kind}/${p1?.state}`);

  // 같은 쪽을 다시 열어 같은 링크를 또 보내도 한 칸이어야 한다
  store.requeue(crawl, [a.url_id], 'l3_recheck');
  const b = store.lease(crawl, 1, 'w1').leased.find((x) => x.url_id === a.url_id);
  await fetchOne(crawl, { url: b.url, url_id: b.url_id, lease_token: b.lease_token, kind: 'listing', maxTier: 'headless' });
  const beforeDup = Object.keys(store.loadState(crawl).urls).length;
  store.report(crawl, [{ url_id: b.url_id, lease_token: b.lease_token, state: 'fetched' }]);
  const stDup = store.loadState(crawl);
  const afterDup = Object.keys(stDup.urls).length;
  // 합쳐졌다고 말하려면 합칠 것이 실제로 있어야 한다. 그리고 같은 부모가 두 번 쌓이면 안 된다.
  const linkRows = Object.values(stDup.urls).filter((u) => (u.provenance || []).some((p) => p.via === 'link'));
  const sameParentTwice = linkRows.filter((u) => {
    const keys = (u.provenance || []).map((p) => `${p.via}|${p.from_url_id}`);
    return new Set(keys).size !== keys.length;
  });
  check('L3', '같은 링크를 다시 보고해도 한 칸으로 합쳐지고, 같은 부모 출처가 두 번 쌓이지 않는다',
    beforeDup > 1 && linkRows.length > 0 && afterDup === beforeDup && sameParentTwice.length === 0,
    `링크로 들어온 칸 ${linkRows.length} · 다시 열기 전 ${beforeDup}칸 → 뒤 ${afterDup}칸 · `
    + `같은 부모 중복 ${sameParentTwice.length}건`);
}

// ---------- L4. 마크다운 본문의 링크도 뽑는다 ----------
// note 파일을 시험이 직접 고치면 아무것도 증명하지 못한다. 뽑는 함수를 진짜 마크다운으로 부른다.
{
  // 아직 없는 함수면 빈 배열로 둔다 — 시험 전체를 멈추지 말고 이 항목만 X 가 되어야 한다
  const mod = await import(path.join(LIB, 'fetch.mjs'));
  const extractOutgoingLinks = mod.extractOutgoingLinks || (() => []);
  const md = [
    '# 목록',
    '[상세 하나](/p/1) 그리고 [바깥 가게](https://md.example/shop)',
    '맨 주소도 있다: https://plain.example/x',
    '![그림](/img/a.png)',                      // 그림은 링크가 아니다
  ].join('\n');
  const fromMd = extractOutgoingLinks(md, { markdown: true, base: `${BASE}/listing-plain` });

  const html = `<a href="/p/2">둘</a><a href="https://html.example/y">바깥</a>`;
  const fromHtml = extractOutgoingLinks(html, { markdown: false, base: `${BASE}/listing-plain` });

  const has = (arr, s) => arr.some((u) => u === s || u.endsWith(s));
  check('L4', '마크다운과 HTML 본문에서 나가는 링크를 같은 함수로 뽑는다(그림은 링크가 아니다)',
    has(fromMd, '/p/1') && has(fromMd, 'https://md.example/shop') && has(fromMd, 'https://plain.example/x')
    && !fromMd.some((u) => u.endsWith('/img/a.png'))
    && has(fromHtml, '/p/2') && has(fromHtml, 'https://html.example/y'),
    `마크다운 ${fromMd.length}개 [${fromMd.slice(0, 4).join(' , ')}] · HTML ${fromHtml.length}개 [${fromHtml.join(' , ')}]`);
}

// ---------- L5. 잘못된 쪽의 링크는 따라가지 않는다 ----------
// 200 을 주는 오류 쪽에도 메뉴와 바닥글은 그대로 있다. 그걸 따라가면 greenvelope 같은
// 거짓 양성이 그대로 번진다. 그래서 note 에 판정을 묶고, invalid 면 한 칸도 넓히지 않는다.
{
  const { fetchOne } = await import(path.join(LIB, 'fetch.mjs'));
  const crawl = 'l-bad';
  store.createCrawl(crawl, {
    seeds: [`${BASE}/soft404`],
    policy: { ...FAST, mode: 'exhaustive', allow_domains: [HOST], external_hop_max: 2 },
  });
  const a = store.lease(crawl, 1, 'w1').leased[0];
  const fr = await fetchOne(crawl, { url: a.url, url_id: a.url_id, lease_token: a.lease_token, kind: 'listing', maxTier: 'headless' });
  const notePath = path.join(SANDBOX, '.claude/web-search', crawl, 'manifests', a.url_id, 'notes', 'links.json');
  const note = fs.existsSync(notePath) ? JSON.parse(fs.readFileSync(notePath, 'utf8')) : null;
  const before = Object.keys(store.loadState(crawl).urls).length;
  // 워커가 "정상이었다" 고 주장해도(state=fetched) 근거는 note 의 판정이어야 한다
  store.report(crawl, [{ url_id: a.url_id, lease_token: a.lease_token, state: 'fetched' }]);
  const after = Object.keys(store.loadState(crawl).urls).length;
  check('L5', `잘못된 쪽(판정 ${fr.page_validity})의 링크는, 워커가 정상이라 주장해도 한 칸도 넓히지 않는다`,
    fr.page_validity === 'invalid' && note?.page_validity === 'invalid'
    && (note?.links || []).length > 0 && after === before,
    `fetch 판정 ${fr.page_validity} · note 판정 ${note?.page_validity} · note 안 링크 ${(note?.links || []).length}개 · `
    + `워커 주장 fetched · 장부 ${before} → ${after}칸`);
}

// ---------- L6. 아직 모르는 쪽도 자동으로 넓히지 않는다 ----------
// needs_visual_review 는 "잘못됐다"가 아니라 "아직 모른다"다. 그런데 모르는 쪽의 메뉴를
// 따라가면 로그인으로 튕긴 쪽의 메뉴까지 그대로 번진다(실전 barunson 에 그런 쪽이 있었다).
// 그래서 근거가 content_validated 일 때만 넓힌다. 링크 note 는 지우지 않고 남겨,
// 나중에 사람이 확인하고 풀어 주는 길은 따로 열어 둔다.
{
  const { fetchOne } = await import(path.join(LIB, 'fetch.mjs'));
  const crawl = 'l-unsure';
  store.createCrawl(crawl, {
    seeds: [`${BASE}/listing-plain`],
    policy: { ...FAST, mode: 'exhaustive', allow_domains: [HOST], external_hop_max: 2 },
  });
  const a = store.lease(crawl, 1, 'w1').leased[0];
  // 목록을 글자만 보고 판정하면 "눈으로 봐야 한다"가 된다
  const fr = await fetchOne(crawl, { url: a.url, url_id: a.url_id, lease_token: a.lease_token, kind: 'listing', maxTier: 'curl' });
  const notePath = path.join(SANDBOX, '.claude/web-search', crawl, 'manifests', a.url_id, 'notes', 'links.json');
  const note = fs.existsSync(notePath) ? JSON.parse(fs.readFileSync(notePath, 'utf8')) : null;
  const before = Object.keys(store.loadState(crawl).urls).length;
  store.report(crawl, [{ url_id: a.url_id, lease_token: a.lease_token, state: 'needs_visual_review' }]);
  const after = Object.keys(store.loadState(crawl).urls).length;
  check('L6', `아직 모르는 쪽(판정 ${fr.page_validity})은 링크를 남기되 자동으로 넓히지 않는다`,
    fr.page_validity === 'needs_visual_review'
    && note?.page_validity === 'needs_visual_review' && (note?.links || []).length > 0
    && after === before,
    `fetch 판정 ${fr.page_validity} · note 판정 ${note?.page_validity} · 남긴 링크 ${(note?.links || []).length}개 · `
    + `장부 ${before} → ${after}칸`);
}

const passed = results.filter((r) => r.pass).length;
console.log(`\n${'='.repeat(60)}`);
console.log(`게이트 4(로컬): ${passed}/${results.length} 통과`);
const g4 = results.filter((r) => r.no.startsWith('G4-'));
console.log(`게이트 4 본 항목: ${g4.filter((r) => r.pass).length}/${g4.length} 통과`);
for (const r of results.filter((x) => !x.pass)) console.log(`  실패 ${r.no}. ${r.name} — ${r.detail}`);
console.log(`샌드박스: ${SANDBOX}${process.env.KEEP_SANDBOX === '1' ? ' (보존)' : ' (종료 시 삭제)'}`);
process.exit(passed === results.length ? 0 : 1);
