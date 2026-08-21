#!/usr/bin/env node
// 게이트 1 — 장부 불변 조건 9항목
// 계획서 _PLAN/2026-08-11-web-search-mcp/PLAN.md 4장 게이트 1
//
// 3·7·8 은 진짜 프로세스를 둘 이상 띄우고 죽여야 하므로 child_process 로 돌린다.
// 실행: node tests/gate1.mjs   (CLAUDE_PROJECT_DIR 를 임시 폴더로 잡고 돈다)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.join(HERE, '..', 'lib');

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'websearch-gate1-'));
process.env.CLAUDE_PROJECT_DIR = SANDBOX;
// 자기 폴더는 자기가 치운다. 이 시험은 자식을 SIGKILL 하므로 exit 훅에 건다.
// 조사하려면 KEEP_SANDBOX=1 로 남긴다.
process.on('exit', () => {
  if (process.env.KEEP_SANDBOX === '1') return;
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch {}
});

const results = [];
function check(no, name, pass, detail = '') {
  results.push({ no, name, pass, detail });
  console.log(`${pass ? 'O' : 'X'}  ${no}. ${name}${detail ? `\n      ${detail}` : ''}`);
}

const store = await import(path.join(LIB, 'store.mjs'));
const pace = await import(path.join(LIB, 'pace.mjs'));
const { normalizeUrl } = await import(path.join(LIB, 'url.mjs'));
const { crawlPaths } = await import(path.join(LIB, 'paths.mjs'));

console.log(`샌드박스: ${SANDBOX}\n`);

// ---------- 1. 추적 파라미터만 다른 주소가 하나로 합쳐진다 ----------
{
  const a = normalizeUrl('https://Example.com/products/abc?utm_source=x&gclid=1#frag');
  const b = normalizeUrl('https://example.com/products/abc/?fbclid=zz');
  const c = normalizeUrl('https://example.com/products/abc');
  const same = a.id === b.id && b.id === c.id;
  check(1, '추적 파라미터만 다른 주소가 하나로 합쳐진다', same, `${a.url} | id 3개 = ${[a.id, b.id, c.id].join(',')}`);
}

// ---------- 2. 기능성 파라미터는 보존된다 ----------
{
  const a = normalizeUrl('https://shop.example.com/goods?goodsNo=100&utm_source=x');
  const b = normalizeUrl('https://shop.example.com/goods?goodsNo=200&utm_source=y');
  const kept = a.url.includes('goodsNo=100') && b.url.includes('goodsNo=200') && a.id !== b.id;
  check(2, '기능성 파라미터는 보존된다(다른 상품이 안 합쳐진다)', kept, `${a.url}\n      ${b.url}`);
}

// ---------- 3. 두 프로세스가 동시에 lease 해도 겹치지 않는다 ----------
store.createCrawl('g1', {
  seeds: Array.from({ length: 40 }, (_, i) => `https://fixture.local/p/${i}`),
  policy: { mode: 'pilot', lease_ttl_ms: 2000, max_attempts: 5 },
});

function runChild(code) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', code], {
      env: { ...process.env, CLAUDE_PROJECT_DIR: SANDBOX },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => resolve({ out: out.trim(), err: err.trim(), code }));
  });
}

// [중요] spawn 만으로는 경합이 안 생긴다 — node 시작에 수십 ms 가 걸려 앞선 쪽이 이미 끝나 있다.
// 그래서 공통 시작 시각(startAt)까지 각자 바쁜 대기했다가 같은 순간에 임계 구역으로 들어가게 한다.
// 이 배리어가 없으면 잠금을 완전히 꺼도 시험이 통과한다(2026-08-11 음성 대조로 확인).
const BARRIER = (startAt) => `
  while (Date.now() < ${startAt}) { /* busy-wait: setTimeout 은 수 ms 오차가 난다 */ }
`;

{
  const N = 6, EACH = 5;
  const startAt = Date.now() + 900;
  const leaseCode = `
    const s = await import(${JSON.stringify(path.join(LIB, 'store.mjs'))});
    s.loadState('g1');                      // 첫 파일 읽기까지 미리 끝내 둔다
    ${BARRIER(startAt)}                     // 배리어는 임계 구역 바로 앞
    const got = []; let retries = 0, lastErr = '';
    for (let round = 0; round < 3; round++) {
      let tries = 0;
      while (tries++ < 80) {
        try { const r = s.lease('g1', ${EACH}, 'w'+process.pid); got.push(...r.leased.map(x => x.url_id)); break; }
        catch (e) { retries++; lastErr = e.message.slice(0,60); await new Promise(r => setTimeout(r, 5 + Math.random()*15)); }
      }
    }
    console.log(JSON.stringify({ ids: got, retries, lastErr }));
  `;
  const runs = await Promise.all(Array.from({ length: N }, () => runChild(leaseCode)));
  const objs = runs.map((r) => { try { return JSON.parse(r.out); } catch { return { ids: [], retries: -1 }; } });
  const lists = objs.map((o) => o.ids);
  const totalRetries = objs.reduce((s, o) => s + (o.retries || 0), 0);
  const all = lists.flat();
  const uniq = new Set(all);
  const dupCount = all.length - uniq.size;
  const errs = runs.filter((r) => r.err).map((r) => r.err.slice(0, 120));
  check(3, `서로 다른 ${N}개 프로세스가 같은 순간에 lease 해도 겹치지 않는다`,
    all.length > 0 && dupCount === 0,
    `총 배정 ${all.length}건, 고유 ${uniq.size}건, 중복 ${dupCount}건 (프로세스별 ${lists.map((l) => l.length).join('/')}, 경합재시도 ${totalRetries}회: ${objs.find(o=>o.lastErr)?.lastErr || '없음'})${errs.length ? `\n      stderr: ${errs[0]}` : ''}`);
}

// ---------- 4~6. 임대 수명과 report 규약 (별도 크롤 — 3번이 g1 씨앗을 다 소진한다) ----------
store.createCrawl('g2', {
  seeds: Array.from({ length: 10 }, (_, i) => `https://fixture2.local/p/${i}`),
  policy: { mode: 'pilot', lease_ttl_ms: 2000, max_attempts: 5 },
});
{
  const before = store.lease('g2', 1, 'slow');
  const id = before.leased[0]?.url_id;
  const oldToken = before.leased[0]?.lease_token;
  await new Promise((r) => setTimeout(r, 2200));       // lease_ttl_ms=2000
  const after = store.lease('g2', 40, 'fast');
  const got = after.leased.find((x) => x.url_id === id);
  check(4, '임대 만료 후 재배정된다', !!got && got.lease_token !== oldToken,
    `url_id=${id} 새토큰=${got?.lease_token?.slice(0, 8)} 옛토큰=${oldToken?.slice(0, 8)}`);

  // ---------- 5. 이전 워커의 늦은 report 가 거절된다 ----------
  const late = store.report('g2', [{ url_id: id, lease_token: oldToken, state: 'fetched' }]);
  check(5, '이전 워커의 늦은 report 가 거절된다',
    late.accepted === 0 && late.rejects[0]?.why === 'stale_lease_token',
    `accepted=${late.accepted} rejected=${late.rejected} why=${late.rejects[0]?.why}`);

  // ---------- 6. 같은 report 를 두 번 보내도 한 번만 반영된다 ----------
  const rid = 'fixed-report-id-001';
  const r1 = store.report('g2', [{ url_id: id, lease_token: got.lease_token, state: 'fetched' }], rid);
  const r2 = store.report('g2', [{ url_id: id, lease_token: got.lease_token, state: 'invalid' }], rid);
  const st = store.loadState('g2');
  check(6, '같은 report 를 두 번 보내도 한 번만 반영된다',
    r1.accepted === 1 && r2.duplicate === true && st.urls[id].state === 'fetched',
    `1차 accepted=${r1.accepted}, 2차 duplicate=${r2.duplicate}, 최종상태=${st.urls[id].state}`);
}

// ---------- 7. 두 크롤이 동시에 fetch 해도 전역 pace 가 지켜진다 ----------
{
  const N = 6;
  const startAt = Date.now() + 900;
  const paceCode = `
    const p = await import(${JSON.stringify(path.join(LIB, 'pace.mjs'))});
    p.peek('shared.example.com');           // 모듈·파일 읽기를 미리 끝내 둔다
    ${BARRIER(startAt)}                     // 배리어는 임계 구역 바로 앞
    let r; try { r = p.reserve('shared.example.com', { min_interval_ms: 60000, jitter_ms: 0, daily_cap: 100 }); }
    catch (e) { r = { ok: false, why: 'lock_timeout' }; }
    console.log(JSON.stringify(r));
  `;
  const runs = await Promise.all(Array.from({ length: N }, () => runChild(paceCode)));
  const parsed = runs.map((r) => { try { return JSON.parse(r.out); } catch { return { ok: null }; } });
  const okCount = parsed.filter((x) => x.ok === true).length;
  check(7, `${N}개 프로세스가 같은 순간에 pace_reserve 해도 정확히 하나만 통과한다`,
    okCount === 1,
    `통과 ${okCount}건 / ${N} — 결과: ${parsed.map((x) => (x.ok ? 'OK' : x.why || 'fail')).join(',')}`);
}

// ---------- 8. 잠금을 쥔 프로세스를 강제 종료해도 회수된다 ----------
{
  const holdCode = `
    const l = await import(${JSON.stringify(path.join(LIB, 'lock.mjs'))});
    const p = await import(${JSON.stringify(path.join(LIB, 'paths.mjs'))});
    const cp = p.crawlPaths('g1');
    p.ensureCrawlDirs('g1');
    const h = l.tryAcquire(cp.lock, cp.stale, 1000);
    console.log(h ? 'HELD' : 'FAIL');
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', holdCode], {
    env: { ...process.env, CLAUDE_PROJECT_DIR: SANDBOX }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((r) => { child.stdout.once('data', r); });
  const lockDir = crawlPaths('g1').lock;
  const heldBefore = fs.existsSync(lockDir);
  child.kill('SIGKILL');
  await new Promise((r) => setTimeout(r, 6500));      // ttl 1s + grace 5s
  let recovered = false, err = '';
  try {
    const r = store.lease('g1', 1, 'after-kill');
    recovered = true;
  } catch (e) { err = e.message; }
  const staleLeft = fs.existsSync(crawlPaths('g1').stale) && fs.readdirSync(crawlPaths('g1').stale).length > 0;
  check(8, '잠금 보유 프로세스를 SIGKILL 해도 회수되고 이어진다',
    heldBefore && recovered && staleLeft,
    `잠금생성=${heldBefore} 회수후lease=${recovered} stale보존=${staleLeft}${err ? ` err=${err}` : ''}`);
}

// ---------- 9. 재시작 후 상태가 이어진다 ----------
{
  const before = store.status('g1');
  const readCode = `
    const s = await import(${JSON.stringify(path.join(LIB, 'store.mjs'))});
    console.log(JSON.stringify(s.status('g1')));
  `;
  const R = await runChild(readCode);
  let after = {};
  try { after = JSON.parse(R.out); } catch {}
  const same = after.version === before.version && after.total === before.total;
  check(9, '새 프로세스에서 읽어도 상태가 그대로다(재시작 복구)', same,
    `version ${before.version}→${after.version}, total ${before.total}→${after.total}`);
}

// ---------- 요약 ----------
const passed = results.filter((r) => r.pass).length;
console.log(`\n${'='.repeat(60)}`);
console.log(`게이트 1: ${passed}/${results.length} 통과`);
for (const r of results.filter((x) => !x.pass)) console.log(`  실패 ${r.no}. ${r.name} — ${r.detail}`);
console.log(`샌드박스: ${SANDBOX}${process.env.KEEP_SANDBOX === '1' ? ' (보존)' : ' (종료 시 삭제)'}`);
process.exit(passed === results.length ? 0 : 1);
