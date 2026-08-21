#!/usr/bin/env node
// 회귀 시험 — 2026-08-11 매니저 검수에서 재현된 결함들
// 실행: node tests/regress.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.join(HERE, '..', 'lib');
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'websearch-regress-'));
process.env.CLAUDE_PROJECT_DIR = SANDBOX;
// 자기 폴더는 자기가 치운다. 이 시험은 자식을 SIGKILL 하므로 exit 훅에 건다.
process.on('exit', () => {
  if (process.env.KEEP_SANDBOX === '1') return;
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch {}
});

const results = [];
function check(no, name, pass, detail = '') {
  results.push({ no, name, pass, detail });
  console.log(`${pass ? 'O' : 'X'}  ${no}. ${name}${detail ? `\n      ${detail}` : ''}`);
}

const paths = await import(path.join(LIB, 'paths.mjs'));
const lock = await import(path.join(LIB, 'lock.mjs'));
const store = await import(path.join(LIB, 'store.mjs'));
const url = await import(path.join(LIB, 'url.mjs'));

console.log(`샌드박스: ${SANDBOX}\n`);

// ---------- R1. 크롤 이름으로 저장 자리를 벗어날 수 없다 ----------
{
  const bad = ['..', '.', '../../etc', 'a/b', 'a\\b', '', '   ', '.hidden', 'x\u0000y', 'ctl\u0001name', 'z'.repeat(200)];
  const leaked = [];
  for (const name of bad) {
    try {
      const d = paths.crawlDir(name);
      leaked.push(`${JSON.stringify(name)} → ${d}`);
    } catch { /* 거절이 정답 */ }
  }
  // 정상 이름은 통과해야 한다(과잉 차단 방지)
  let normalOk = false;
  try { normalOk = paths.crawlDir('kr-mcheong-2026').startsWith(paths.root()); } catch {}
  check('R1', '크롤 이름으로 root 밖을 가리킬 수 없다(11종 거절, 정상 이름은 통과)',
    leaked.length === 0 && normalOk,
    leaked.length ? `새어나감: ${leaked.join(' | ')}` : `거절 ${bad.length}종 · 정상 이름 통과=${normalOk}`);
}

// ---------- R2. 잠금은 "없거나 완전하거나" 둘 중 하나다 (반쪽인 순간이 없다) ----------
// 예전에는 디렉터리를 만든 뒤 owner.json 을 써서 그 사이가 관측됐고, 그 틈을 본 쪽이
// 살아 있는 주인의 잠금을 걷어 갔다. 지금은 완성한 파일을 하드링크로 거니 틈이 없어야 한다.
{
  const LIBP = JSON.stringify(path.join(LIB, 'lock.mjs'));
  const dir = path.join(SANDBOX, 'r2-locks');
  fs.mkdirSync(dir, { recursive: true });
  const lockFile = path.join(dir, 'w.lock');
  const staleDir = path.join(dir, 'stale');

  const hammer = `
    const lock = await import(${LIBP});
    const until = Date.now() + 1500;
    let n = 0;
    while (Date.now() < until) {
      const h = lock.tryAcquire(${JSON.stringify(lockFile)}, ${JSON.stringify(staleDir)});
      if (h) { n++; h.release(); }
    }
    console.log('DONE ' + n);
  `;
  const spawnHammer = () => new Promise((resolve) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', hammer], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => resolve({ out: out.trim(), err: err.trim(), code }));
  });

  // 두들기는 동안 계속 들여다본다 — 있으면 반드시 읽히고, 손잡이도 같이 있어야 한다
  let peeks = 0, unreadable = 0, heldDetached = 0;
  const watching = (async () => {
    const until = Date.now() + 1500;
    const read = () => { try { return JSON.parse(fs.readFileSync(lockFile, 'utf8')); } catch { return null; } };
    while (Date.now() < until) {
      peeks++;
      // [정체로 묶는다] 들여다보는 여러 걸음 사이에 주인이 바뀌면 서로 다른 순간을 하나로 오해한다.
      // 처음 본 파일과 마지막에 본 파일이 "같은 파일(같은 dev/ino)"일 때만 한 관측으로 친다.
      const st = (p) => { try { return fs.statSync(p); } catch { return null; } };
      const same = (a, b) => !!a && !!b && a.dev === b.dev && a.ino === b.ino;
      const st0 = st(lockFile);
      if (st0) {
        const o = read();
        // [엄격] 옛 결함은 "잠금은 보이는데 주인 정보가 없다"였다. 이건 한 번도 없어야 한다.
        if (o === null) { if (same(st(lockFile), st0) && read() === null) unreadable++; }
        // 손잡이가 잠깐 떨어져 보이는 건 회수 중(손잡이를 표로 옮긴 뒤 이름을 옮기기 전)뿐이다.
        else if (o.nonce && !fs.existsSync(`${lockFile}.held.${o.nonce}`)) {
          if (same(st(lockFile), st0)) heldDetached++;
        }
      }
      await new Promise((r) => setTimeout(r, 1));
    }
  })();
  const hammers = await Promise.all([spawnHammer(), spawnHammer(), spawnHammer()]);
  await watching;

  const allDone = hammers.every((h) => h.code === 0 && h.out.startsWith('DONE'));
  const total = hammers.reduce((s, h) => s + Number(h.out.split(' ')[1] || 0), 0);
  const leftover = fs.readdirSync(dir).filter((f) => f !== 'stale').length;
  const reaps = fs.existsSync(path.join(staleDir, 'reaps.jsonl'))
    ? fs.readFileSync(path.join(staleDir, 'reaps.jsonl'), 'utf8').trim().split('\n').filter(Boolean).length : 0;
  // 손잡이가 떨어져 보였다면 그건 회수가 돌고 있었다는 뜻이라야 한다
  const detachExplained = heldDetached === 0 || reaps > 0;

  check('R2', '잠금은 보이면 반드시 읽힌다 — 주인 정보 없는 반쪽 잠금이 관측되지 않는다',
    allDone && unreadable === 0 && detachExplained && total > 50 && leftover === 0,
    `세 프로세스가 ${total}번 잡았다 풀었고 ${peeks}번 들여다봤다 · 읽히지 않는 잠금 ${unreadable}건(0이어야 함) · `
    + `회수 중 손잡이 분리 ${heldDetached}건(회수 ${reaps}회로 설명됨=${detachExplained}) · `
    + `끝난 뒤 남은 파일 ${leftover}개`);
}

// ---------- R3. events 쓴 뒤 state 교체 전에 SIGKILL — 장부가 모순되지 않는다 ----------
{
  store.createCrawl('r3', { seeds: ['https://a.local/1', 'https://a.local/2'], policy: { mode: 'pilot' } });
  const before = store.loadState('r3');
  const eventsPath = paths.crawlPaths('r3').events;
  const linesBefore = fs.readFileSync(eventsPath, 'utf8').trim().split('\n').filter(Boolean).length;

  // 결정적 고장 주입: events 를 쓴 직후 SIGKILL
  const crashCode = `
    const s = await import(${JSON.stringify(path.join(LIB, 'store.mjs'))});
    s.addUrls('r3', [{ url: 'https://a.local/3', kind: 'detail', via: 'manual', discovered_by: 'test' }]);
    console.log('NOT_REACHED');
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', crashCode], {
    env: { ...process.env, CLAUDE_PROJECT_DIR: SANDBOX, NODE_ENV: 'test', WEBSEARCH_FAULT: 'after_events' },
    encoding: 'utf8',
  });
  const killed = r.signal === 'SIGKILL' && !String(r.stdout).includes('NOT_REACHED');

  const midState = store.loadState('r3');
  const linesMid = fs.readFileSync(eventsPath, 'utf8').trim().split('\n').filter(Boolean).length;
  const orphanLeft = linesMid > linesBefore;                    // 이벤트만 남았다
  const stateUnchanged = midState.version === before.version;   // 상태는 그대로

  // 다음 변경에서 reconcile 이 무효를 표시하고, 장부가 모순되지 않아야 한다
  store.addUrls('r3', [{ url: 'https://a.local/4', kind: 'detail', via: 'manual', discovered_by: 'test' }]);
  const after = store.loadState('r3');
  const evText = fs.readFileSync(eventsPath, 'utf8');
  const hasTombstone = evText.includes('orphan_events_rolled_back');
  const ghost = Object.values(after.urls).some((u) => u.url === 'https://a.local/3');
  const realOne = Object.values(after.urls).some((u) => u.url === 'https://a.local/4');
  // 두 번째 reconcile 이 같은 것을 또 무효 처리하지 않아야 한다(무한 증식 방지)
  const n1 = (fs.readFileSync(eventsPath, 'utf8').match(/orphan_events_rolled_back/g) || []).length;
  store.addUrls('r3', [{ url: 'https://a.local/5', kind: 'detail', via: 'manual', discovered_by: 'test' }]);
  const n2 = (fs.readFileSync(eventsPath, 'utf8').match(/orphan_events_rolled_back/g) || []).length;

  check('R3', 'events 쓴 뒤 state 교체 전 SIGKILL — state 가 진실이고 장부가 모순되지 않는다',
    killed && orphanLeft && stateUnchanged && hasTombstone && !ghost && realOne && n1 === n2,
    `SIGKILL=${killed} 고아이벤트남음=${orphanLeft} state불변=${stateUnchanged} tombstone=${hasTombstone} `
    + `유령URL없음=${!ghost} 다음변경정상=${realOne} tombstone중복증식=${n2 - n1}건`);
}

// ---------- R4. 같은 key/value 쿼리 comparator 가 0 을 돌려준다 ----------
{
  const a = url.normalizeUrl('https://x.local/p?k=1&k=1&a=2');
  const b = url.normalizeUrl('https://x.local/p?a=2&k=1&k=1');
  const stable = a.url === b.url && a.id === b.id;
  const hasSameHost = typeof url.sameHostIgnoringWww === 'function' && url.sameSite === undefined;
  check('R4', '중복 key/value 정렬이 안정적이고, sameSite 는 sameHostIgnoringWww 로 정리됐다',
    stable && hasSameHost,
    `정렬안정=${stable} (${a.url}) · sameHostIgnoringWww 존재=${typeof url.sameHostIgnoringWww === 'function'} · 옛 sameSite 제거=${url.sameSite === undefined}`);
}

// ---------- R5. MCP smoke: initialize / tools list / crawl_new / lease ----------
{
  const server = path.join(HERE, '..', 'server.mjs');
  const reqs = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'crawl_new', arguments: { crawl: 'smoke', seeds: ['https://s.local/a', 'https://s.local/b'] } } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'lease', arguments: { crawl: 'smoke', n: 2 } } },
    { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'crawl_new', arguments: { crawl: '../escape', seeds: [] } } },
  ];
  const out = await new Promise((resolve) => {
    const p = spawn(process.execPath, [server], { env: { ...process.env, CLAUDE_PROJECT_DIR: SANDBOX }, stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '';
    p.stdout.on('data', (d) => (buf += d));
    for (const r of reqs) p.stdin.write(JSON.stringify(r) + '\n');
    setTimeout(() => { p.stdin.end(); p.kill(); resolve(buf); }, 1500);
  });
  const msgs = out.trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const byId = Object.fromEntries(msgs.map((m) => [m.id, m]));
  const init = byId[1]?.result?.serverInfo?.name === 'web-search';
  const tools = (byId[2]?.result?.tools || []).length;
  const created = String(byId[3]?.result?.content?.[0]?.text || '').includes('크롤 생성');
  const leased = String(byId[4]?.result?.content?.[0]?.text || '').includes('임대');
  const escapeBlocked = byId[5]?.result?.isError === true || String(byId[5]?.result?.content?.[0]?.text || '').startsWith('Error:');
  check('R5', 'MCP smoke — initialize·tools/list·crawl_new·lease 동작, 탈출 이름은 거절',
    init && tools >= 12 && created && leased && escapeBlocked,
    `initialize=${init} tools=${tools}개 crawl_new=${created} lease=${leased} 탈출거절=${escapeBlocked}`);
}

// ---------- R6. 회수당한 옛 손잡이가 새 주인의 잠금을 건드리지 않는다 ----------
{
  const lock = await import(path.join(LIB, 'lock.mjs'));
  const dir = path.join(SANDBOX, 'r6-locks');
  fs.mkdirSync(dir, { recursive: true });
  const lockFile = path.join(dir, 'x.lock');
  const staleDir = path.join(dir, 'stale');

  const oldH = lock.tryAcquire(lockFile, staleDir);
  const gotFirst = !!oldH && oldH.valid();

  // 사람이 억지로 걷어 간다(살아 있는 주인은 자동 회수 대상이 아니므로 이 통로로 만든다)
  const rep = lock.repairLock(lockFile, staleDir);
  const oldLostIt = rep.ok && oldH.valid() === false;

  // 새 주인이 들어온다
  const newH = lock.tryAcquire(lockFile, staleDir);
  const newGot = !!newH && newH.valid();

  // 뒤늦게 옛 손잡이가 잠금을 푼다 — 새 주인의 것을 건드리면 안 된다
  const oldRelease = oldH.release();
  const newStillValid = newH.valid() && fs.existsSync(lockFile);
  // 그 사이 제3자가 끼어들 틈도 없어야 한다
  const thirdBlocked = lock.tryAcquire(lockFile, staleDir) === null;
  const newRelease = newH.release();
  const goneAfter = !fs.existsSync(lockFile);

  // 옛 손잡이가 남긴 임시 파일이 흘러 있지 않아야 한다
  const leftovers = fs.readdirSync(dir).filter((f) => f.includes('.held.') || f.includes('.tmp.'));

  check('R6', '회수당한 옛 손잡이가 뒤늦게 풀어도 새 주인의 잠금을 치우지 않는다',
    gotFirst && oldLostIt && newGot && oldRelease === false && newStillValid && thirdBlocked
    && newRelease === true && goneAfter && leftovers.length === 0,
    `첫 획득=${gotFirst} · 사람이 회수=${rep.ok}(옛 손잡이 무효=${oldLostIt}) · 새 주인 획득=${newGot}\n`
    + `      옛 손잡이 release 결과=${oldRelease}(기대 false) · 새 주인 유지=${newStillValid} · 제3자 차단=${thirdBlocked} · `
    + `새 주인 release=${newRelease} 뒤 파일 없음=${goneAfter} · 남은 임시파일 ${leftovers.length}개`);
}

// ---------- R7. 회수자 여럿이 동시에 달려들어도 죽은 잠금은 한 번만 걷힌다 ----------
{
  const LIBP = JSON.stringify(path.join(LIB, 'lock.mjs'));
  const dir = path.join(SANDBOX, 'r7-locks');
  fs.mkdirSync(dir, { recursive: true });
  const lockFile = path.join(dir, 'y.lock');
  const staleDir = path.join(dir, 'stale');

  // 1) 잠금을 쥔 채 죽는 주인을 만든다
  const victim = spawn(process.execPath, ['--input-type=module', '-e', `
    const lock = await import(${LIBP});
    const h = lock.tryAcquire(${JSON.stringify(lockFile)}, ${JSON.stringify(staleDir)});
    console.log(h ? 'HELD' : 'NO');
    await new Promise(() => {});                       // 풀지 않고 버틴다
  `], { stdio: ['ignore', 'pipe', 'pipe'] });
  const held = await new Promise((res) => victim.stdout.once('data', (d) => res(String(d).trim())));
  victim.kill('SIGKILL');
  await new Promise((res) => victim.once('close', res));
  const lockLeft = fs.existsSync(lockFile);
  await new Promise((res) => setTimeout(res, 400));     // 죽은 주인 유예(300ms)를 넘긴다

  // 2) 회수자 넷이 같은 순간에 달려든다
  const startAt = Date.now() + 400;
  const racer = `
    const lock = await import(${LIBP});
    const startAt = Number(process.argv[1]);
    while (Date.now() < startAt) {}
    try {
      const h = lock.acquire(${JSON.stringify(lockFile)}, ${JSON.stringify(staleDir)}, { waitMs: 8000 });
      if (!h.valid()) { console.log('INVALID'); process.exit(2); }
      const t = Date.now(); while (Date.now() - t < 40) {}
      if (!h.valid()) { console.log('LOST'); process.exit(3); }
      h.release();
      console.log('OK');
    } catch (e) { console.log('ERR ' + e.message.slice(0, 60)); process.exit(4); }
  `;
  const runRacer = () => new Promise((resolve) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', racer, String(startAt)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => resolve({ out: out.trim(), err: err.trim(), code }));
  });
  const racers = await Promise.all([runRacer(), runRacer(), runRacer(), runRacer()]);

  const allOk = racers.every((r) => r.code === 0 && r.out === 'OK');
  const reapLines = fs.existsSync(path.join(staleDir, 'reaps.jsonl'))
    ? fs.readFileSync(path.join(staleDir, 'reaps.jsonl'), 'utf8').trim().split('\n').filter(Boolean) : [];
  const reapedOnce = reapLines.length === 1;            // 죽은 잠금 하나만 걷혔다 — 산 것을 뺏었다면 더 늘었다
  const cleanAfter = !fs.existsSync(lockFile)
    && fs.readdirSync(dir).filter((f) => f.includes('.held.') || f.includes('.claim.')
      || f.includes('.tmp.') || f.includes('.beat.')).length === 0;

  check('R7', '죽은 잠금에 회수자 넷이 동시에 달려들어도 한 번만 걷히고, 아무도 남의 잠금을 뺏지 않는다',
    held === 'HELD' && lockLeft && allOk && reapedOnce && cleanAfter,
    `죽은 주인이 남긴 잠금=${lockLeft} · 회수자 결과 [${racers.map((r) => r.out).join(', ')}]\n`
    + `      걷어 간 횟수 ${reapLines.length}(기대 1) · 끝난 뒤 잠금·손잡이·표 남음 없음=${cleanAfter}`);
}

// ---------- R8. 만료 갱신 도중 어디서 죽어도 다음 프로세스가 회수한다 ----------
{
  const LIBP = JSON.stringify(path.join(LIB, 'lock.mjs'));
  const rows = [];
  for (const fault of ['renew_after_write', 'renew_after_rename', 'none']) {
    const dir = path.join(SANDBOX, `r8-${fault}`);
    fs.mkdirSync(dir, { recursive: true });
    const lockFile = path.join(dir, 'z.lock');
    const staleDir = path.join(dir, 'stale');

    const kid = spawn(process.execPath, ['--input-type=module', '-e', `
      const lock = await import(${LIBP});
      const h = lock.tryAcquire(${JSON.stringify(lockFile)}, ${JSON.stringify(staleDir)}, 800);
      h.renew(800);
      console.log('RENEWED');
      await new Promise(() => {});
    `], { env: { ...process.env, NODE_ENV: 'test', WEBSEARCH_LOCK_FAULT: fault }, stdio: ['ignore', 'pipe', 'pipe'] });
    // close 청취는 한 번만 걸어 두고 나눠 쓴다. 나중에 또 걸면 이미 끝난 자식을 영영 기다린다.
    const closed = new Promise((res) => kid.once('close', () => res('CLOSED')));
    const first = await Promise.race([
      new Promise((res) => kid.stdout.once('data', (d) => res(String(d).trim()))),
      closed.then(() => 'DIED'),
    ]);
    if (fault === 'none') kid.kill('SIGKILL');          // 중단점이 없으면 우리가 죽인다
    await closed;

    // 잠금 이름과 손잡이가 같은 파일로 남아 있어야 회수가 가능하다
    const held = fs.readdirSync(dir).find((f) => f.includes('.held.'));
    const same = held ? (() => {
      try {
        const a = fs.statSync(lockFile); const b = fs.statSync(path.join(dir, held));
        return a.dev === b.dev && a.ino === b.ino;
      } catch { return false; }
    })() : false;

    await new Promise((res) => setTimeout(res, 400));   // 죽은 주인 유예를 넘긴다
    const lockLib = await import(path.join(LIB, 'lock.mjs'));
    const h2 = lockLib.tryAcquire(lockFile, staleDir);
    const took = !!h2 && h2.valid();
    if (h2) h2.release();
    const leftover = fs.readdirSync(dir)
      .filter((f) => f.includes('.held.') || f.includes('.beat.') || f.includes('.claim.') || f.includes('.tmp.')).length;
    rows.push({ fault, first, same, took, leftover });
  }
  const allRecovered = rows.every((r) => (r.first === 'RENEWED' || r.first === 'DIED') && r.same && r.took && r.leftover === 0);

  check('R8', '만료 갱신 도중 어느 지점에서 죽어도 잠금 정체가 어긋나지 않고 다음 프로세스가 회수한다',
    allRecovered,
    rows.map((r) => `${r.fault}: 첫출력=${r.first} 잠금·손잡이 같은 파일=${r.same} 다음이 회수=${r.took} 잔재 ${r.leftover}개`).join('\n      '));
}

// ---------- R9. 죽었다고 판정한 그 주인만 걷는다 (판정 뒤 주인이 바뀌면 손대지 않는다) ----------
// 순서를 손으로 만든다: P1 이 A 를 죽었다고 판정 → 멈춤 → 그 사이 A 를 걷고 B 가 들어옴 → P1 재개.
{
  const LIBP = JSON.stringify(path.join(LIB, 'lock.mjs'));
  const dir = path.join(SANDBOX, 'r9-locks');
  fs.mkdirSync(dir, { recursive: true });
  const lockFile = path.join(dir, 'v.lock');
  const staleDir = path.join(dir, 'stale');
  const gate = path.join(dir, 'gate');
  const ready = path.join(dir, 'ready');

  // A: 잠금을 쥔 채 죽는다
  const a = spawn(process.execPath, ['--input-type=module', '-e', `
    const lock = await import(${LIBP});
    lock.tryAcquire(${JSON.stringify(lockFile)}, ${JSON.stringify(staleDir)});
    console.log('A_HELD');
    await new Promise(() => {});
  `], { stdio: ['ignore', 'pipe', 'pipe'] });
  const aHeld = await new Promise((res) => a.stdout.once('data', (d) => res(String(d).trim())));
  a.kill('SIGKILL');
  await new Promise((res) => a.once('close', res));
  await new Promise((res) => setTimeout(res, 400));      // 죽은 주인 유예를 넘긴다

  // P1: A 를 죽었다고 판정한 뒤 장벽에서 멈춘다
  const p1 = spawn(process.execPath, ['--input-type=module', '-e', `
    const lock = await import(${LIBP});
    const h = lock.tryAcquire(${JSON.stringify(lockFile)}, ${JSON.stringify(staleDir)});
    console.log(h ? 'P1_GOT' : 'P1_NULL');
  `], {
    env: { ...process.env, NODE_ENV: 'test', WEBSEARCH_LOCK_BARRIER: `after_inspect::${gate}::${ready}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const p1Closed = new Promise((res) => {
    let out = '';
    p1.stdout.on('data', (d) => (out += d));
    p1.once('close', (code) => res({ out: out.trim(), code }));
  });
  // [증거] 잠깐 재우는 것으로는 P1 이 판정을 마치고 멈췄다는 보장이 없다.
  // 장벽이 남긴 도착 표시를 실제로 본 뒤에만 다음으로 간다.
  let arrived = false;
  for (let i = 0; i < 1500; i++) {
    if (fs.existsSync(ready)) { arrived = true; break; }
    await new Promise((res) => setTimeout(res, 10));
  }

  // 그 사이 이 프로세스가 A 를 걷고 B 로 들어간다
  const b = lock.tryAcquire(lockFile, staleDir);
  const bGot = !!b && b.valid();
  fs.writeFileSync(gate, 'go');                          // P1 재개
  const p1r = await p1Closed;

  const bStillValid = !!b && b.valid() && fs.existsSync(lockFile);
  const reapLines = fs.existsSync(path.join(staleDir, 'reaps.jsonl'))
    ? fs.readFileSync(path.join(staleDir, 'reaps.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  const onlyDeadReaped = reapLines.length === 1 && reapLines[0].victim?.pid === a.pid;
  if (b) b.release();

  check('R9', '죽었다고 판정한 그 주인만 걷는다 — 판정 뒤 새 주인이 들어와도 그 잠금은 안전하다',
    aHeld === 'A_HELD' && arrived && bGot && bStillValid && p1r.out === 'P1_NULL' && p1r.code === 0 && onlyDeadReaped,
    `A 죽음(pid ${a.pid}) · P1 이 판정 뒤 멈춘 것 확인=${arrived} · 그 사이 B 획득=${bGot} · P1 재개 결과=${p1r.out}(기대 P1_NULL) · `
    + `B 그대로 유효=${bStillValid}\n      걷어 간 기록 ${reapLines.length}건, 대상 pid=${reapLines.map((r) => r.victim?.pid).join(',')}(A 만이어야 함)`);
}

// ---------- R10. 없는 크롤을 "빈 크롤" 로 보고하지 않는다 ----------
// loadState 는 없는 크롤에 빈 상태를 돌려준다(크롤 생성 경로에 필요). 그 값이 그대로
// status 로 나가면 이름을 잘못 쓴 워커가 "전체 0 · 다 봤다" 로 오해한다.
// (2026-08-11 태스크 21 등록 검증에서 `[no-such-crawl] v0 · mode=undefined · 전체 0` 재현)
{
  const missing = store.status('r10-nosuch');
  store.createCrawl('r10-real', { mode: 'pilot', allow_domains: ['example.test'], seeds: ['https://example.test/'] });
  const present = store.status('r10-real');

  // MCP 본문까지 본다 — 라이브러리만 고치고 표시가 그대로면 워커는 여전히 오해한다
  const serverPath = path.join(HERE, '..', 'server.mjs');
  const sp = spawn('node', [serverPath], { env: { ...process.env, CLAUDE_PROJECT_DIR: SANDBOX }, stdio: ['pipe', 'pipe', 'pipe'] });
  let sbuf = ''; const got = new Map();
  sp.stdout.on('data', (d) => {
    sbuf += d; let i;
    while ((i = sbuf.indexOf('\n')) >= 0) {
      const line = sbuf.slice(0, i); sbuf = sbuf.slice(i + 1);
      if (line.trim()) { try { const m = JSON.parse(line); if (m.id != null) got.set(m.id, m); } catch {} }
    }
  });
  const call = (id, crawl) => sp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'status', arguments: { crawl } } }) + '\n');
  sp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n');
  call(2, 'r10-nosuch');
  call(3, 'r10-real');
  const t0 = Date.now();
  while (Date.now() - t0 < 15000 && !(got.has(2) && got.has(3))) await new Promise((r) => setTimeout(r, 40));
  sp.stdin.end(); sp.kill('SIGTERM');
  const bodyOf = (id) => got.get(id)?.result?.content?.[0]?.text || '';
  const missBody = bodyOf(2).split('\n')[0], hasBody = bodyOf(3).split('\n')[0];
  const noSideEffect = !fs.existsSync(paths.crawlPaths('r10-nosuch').dir);

  check('R10', '없는 크롤은 "전체 0" 이 아니라 없다고 답한다(있는 크롤은 그대로)',
    missing.exists === false && present.exists === true
    && /없습니다/.test(missBody) && !/전체 \d/.test(missBody) && !/undefined/.test(missBody)
    // 있는 쪽은 씨앗 하나를 넣었으니 전체 1 이고, mode 가 값으로 찍혀야 한다
    && /mode=pilot/.test(hasBody) && /전체 1/.test(hasBody)
    && !/없습니다/.test(hasBody) && !/undefined/.test(hasBody)
    && noSideEffect,
    `없는 쪽 exists=${missing.exists} 본문="${missBody}"\n      `
    + `있는 쪽 exists=${present.exists} 본문="${hasBody}"\n      `
    + `조회만으로 폴더 생기지 않음=${noSideEffect}`);
}

// ---------- R11. 이른 판정 경로가 터지지 않는다 ----------
// judge 의 done() 은 cards·declared·jsonld·title·text 를 읽는데, 이 값들이 만들어지기 전에
// 부르는 길이 셋 있었다(Jina 마크다운 실패·마크다운 성공·HTML 파싱 실패).
// 그 길로 들어가면 "Cannot access 'cards' before initialization" 으로 죽는다.
// (2026-08-11 실전 1회차에서 deardeer·itscard·salondeletter 세 곳이 이걸로 멈춤)
{
  const judge = await import(path.join(LIB, 'judge.mjs'));
  // 이름 → [인자, 기대 판정]. 터지지 않는 것만 보면 잘못된 판정도 통과한다.
  const cases = [
    ['마크다운 얇음(목록)', { html: '짧다', markdown: true, status: 200, kind: 'listing' }, 'invalid'],
    ['마크다운 정상(목록)', { html: 'x'.repeat(2000), markdown: true, status: 200, kind: 'listing' }, 'needs_visual_review'],
    ['마크다운 정상(상세)', { html: 'x'.repeat(2000), markdown: true, status: 200, kind: 'detail' }, 'content_validated'],
    ['응답 없음(status 0)', { html: 'x'.repeat(2000), markdown: true, status: 0, kind: 'listing' }, 'invalid'],
    // JSDOM 은 url 이 주소 꼴이 아니면 생성에서 던진다 — parse_fail 조기 return 을 실제로 지난다
    ['HTML 파싱 실패', { html: '<html><body>x</body></html>', markdown: false, status: 200, kind: 'listing', requested: 'ht!tp://x', final: 'ht!tp://x' }, 'invalid'],
  ];
  const errs = [];
  const shapes = [];
  for (const [name, args, want] of cases) {
    try {
      const r = judge.judge({ requested: 'https://x.test/a', final: 'https://x.test/a', ...args });
      // 돌아온 모양도 계약대로여야 한다 — 터지지만 않으면 되는 게 아니다
      if (!Array.isArray(r.cards) || typeof r.page_validity !== 'string' || typeof r.text_len !== 'number') {
        errs.push(`${name}: 모양이 계약과 다름 ${JSON.stringify(Object.keys(r))}`);
      }
      if (r.page_validity !== want) errs.push(`${name}: ${want} 여야 하는데 ${r.page_validity}`);
      shapes.push(`${name}→${r.page_validity}`);
    } catch (e) {
      errs.push(`${name}: ${e.message}`);
    }
  }
  check('R11', '카드를 세기 전에 끝나는 판정 길도 터지지 않고 판정이 맞는다(마크다운·파싱 실패)',
    errs.length === 0,
    errs.length ? errs.join(' / ') : shapes.join(' · '));
}

// ---------- R12. 실제 사이트의 상세 경로를 상세로 읽는다 ----------
// 상세 정규식이 "/detail 로 끝날 때"만 맞아, 바른손의 /Product/Detail/1188 이 unknown 이 됐다.
// unknown 은 워커가 여는 종류라, 목록 우선으로 아낄 요청 69건을 그대로 다 열어 버렸다.
// (2026-08-11 실전 1회차 kr-barunson 장부에서 확인)
{
  const { classifyKind } = await import(path.join(LIB, 'kind.mjs'));
  const cases = [
    ['https://mcard.barunsoncard.com/Product/Detail/1188', 'detail'],
    ['https://mcard.barunsoncard.com/product/detail/1188?x=1', 'detail'],
    ['https://example.test/products/q1', 'detail'],
    ['https://example.test/detail', 'detail'],
    // 목록은 목록으로 남아야 한다 — 상세 규칙을 넓히다 목록을 삼키면 안 된다
    ['https://mcard.barunsoncard.com/Product/List', 'listing'],
    ['https://example.test/listing-plain', 'listing'],
    ['https://example.test/sitemap.xml', 'sitemap'],
    ['https://example.test/about', 'unknown'],
  ];
  const bad = [];
  const seen = [];
  for (const [u, want] of cases) {
    const got = classifyKind(u, {}).kind;
    seen.push(`${new URL(u).pathname}→${got}`);
    if (got !== want) bad.push(`${u} : ${want} 여야 하는데 ${got}`);
  }
  check('R12', '실제 상세 경로(/Product/Detail/1188)를 상세로 읽고, 목록은 목록으로 남는다',
    bad.length === 0, bad.length ? bad.join(' / ') : seen.join(' · '));
}

const passed = results.filter((r) => r.pass).length;
console.log(`\n${'='.repeat(60)}`);
console.log(`회귀 시험: ${passed}/${results.length} 통과`);
for (const r of results.filter((x) => !x.pass)) console.log(`  실패 ${r.no}. ${r.name} — ${r.detail}`);
console.log(`샌드박스: ${SANDBOX}${process.env.KEEP_SANDBOX === '1' ? ' (보존)' : ' (종료 시 삭제)'}`);
process.exit(passed === results.length ? 0 : 1);
