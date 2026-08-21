#!/usr/bin/env node
// workspace.db 실측 — 내장 node:sqlite 가 공유 장부로 충분한지 본다.
//
//   node tests/spikes/sqlite-wal/workspace-spike.mjs [--json]
//
// 부모(이 파일)가 스키마를 만들고 일꾼을 띄우고 과녁을 죽인다. 일꾼은 workspace-worker.mjs.
// 결과는 results/workspace.json 에 남는다. pace.db 결과와는 파일을 나눈다 — 목적도 경합도 다르다.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER = path.join(HERE, 'workspace-worker.mjs');
const RESULTS = path.join(HERE, 'results');

const WORKERS = 10;
const ROWS_EACH = 20;
const KILL_TARGETS = 2;
// 기본 5초. 붐빔 경로가 실제로 걸리는지 보려면 아주 짧게 줄여 돌린다(감사용).
const BUSY_TIMEOUT_MS = Number(process.env.WS_SPIKE_BUSY_TIMEOUT_MS || 5000);

const checks = [];
const ok = (id, pass, detail) => checks.push({ id, pass, detail });

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-spike-'));
const DB = path.join(sandbox, 'workspace.db');

// ── 스키마 ────────────────────────────────────────────────────

const db = new DatabaseSync(DB);
const journalMode = db.prepare('PRAGMA journal_mode = WAL').get().journal_mode;
db.exec('PRAGMA foreign_keys = ON');
db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
db.exec(`
  CREATE TABLE items (
    item_id INTEGER PRIMARY KEY,
    canonical_url TEXT NOT NULL UNIQUE,
    work_state TEXT NOT NULL,
    owner TEXT,
    updated_at INTEGER NOT NULL DEFAULT (unixepoch('subsec') * 1000)
  );
  CREATE TABLE attempts (
    attempt_id INTEGER PRIMARY KEY,
    item_id INTEGER NOT NULL REFERENCES items(item_id) ON DELETE CASCADE,
    collector TEXT NOT NULL
  );
`);

const fkOn = db.prepare('PRAGMA foreign_keys').get().foreign_keys;
const busySet = db.prepare('PRAGMA busy_timeout').get().timeout;
ok('W1-pragmas', journalMode === 'wal' && fkOn === 1 && busySet === BUSY_TIMEOUT_MS,
  `journal_mode=${journalMode} · foreign_keys=${fkOn} · busy_timeout=${busySet}`);

// ── transaction rollback ──────────────────────────────────────

{
  db.exec('BEGIN IMMEDIATE');
  db.prepare('INSERT INTO items (canonical_url, work_state) VALUES (?, ?)').run('https://spike.invalid/rolled-back', 'queued');
  db.exec('ROLLBACK');
  const found = db.prepare('SELECT COUNT(*) AS n FROM items WHERE canonical_url = ?').get('https://spike.invalid/rolled-back').n;
  ok('W2-rollback', found === 0, `rollback 뒤 남은 행 ${found}`);
}

// ── foreign_keys 가 실제로 막는가 ─────────────────────────────

{
  let blocked = false;
  try {
    db.prepare('INSERT INTO attempts (item_id, collector) VALUES (?, ?)').run(999999, 'http');
  } catch (e) { blocked = /FOREIGN KEY/i.test(e.message); }
  ok('W3-foreign-keys-enforced', blocked, blocked ? '없는 item_id 의 attempt 가 거절됨' : '외래키가 강제되지 않음');
}

db.close();

// ── 10개 프로세스 동시 쓰기 ───────────────────────────────────

// 모든 자식 대기에 벽시계 제한을 건다. 넘으면 SIGKILL 하고 timeout 으로 돌려준다 —
// 영원히 멈추는 설계를 시험이 통과시키지 않게 하려는 것이다.
const WAIT_LIMIT_MS = 30_000;

function runWorker(args, { expectHeld = false, limitMs = WAIT_LIMIT_MS } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [WORKER, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* 이미 죽었으면 그만 */ }
      finish({ timeout: true, out: out.trim(), err: err.trim(), child });
    }, limitMs);

    child.stdout.on('data', (d) => {
      out += d;
      if (expectHeld && out.includes('\n')) finish({ child, first: JSON.parse(out.split('\n')[0]) });
    });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => { if (!expectHeld) finish({ code, out: out.trim(), err: err.trim() }); });
  });
}

const waitExit = (child, limitMs = 5000) => new Promise((resolve) => {
  let settled = false;
  const done = (v) => { if (!settled) { settled = true; clearTimeout(t); resolve(v); } };
  const t = setTimeout(() => done({ exited: false }), limitMs);
  child.on('close', (code, signal) => done({ exited: true, code, signal }));
});

const startAt = Date.now() + 800;
const runs = await Promise.all(Array.from({ length: WORKERS }, (_, i) => runWorker([
  '--db', DB, '--tag', `w${i}`, '--rows', String(ROWS_EACH),
  '--start-at', String(startAt), '--busy-timeout', String(BUSY_TIMEOUT_MS),
])));

const parsed = runs.map((r) => { try { return JSON.parse(r.out); } catch { return null; } });
const alive = parsed.filter(Boolean);
// 시작에서 죽은 일꾼은 셈에 넣지 않는다. 대신 W4 가 그 사실을 드러낸다.
const worked = alive.filter((r) => !r.fatal);
const planned = worked.reduce((s, r) => s + r.planned, 0);
const inserted = worked.reduce((s, r) => s + r.inserted, 0);
const busyTotal = worked.reduce((s, r) => s + r.busy_retries, 0);
const gaveUp = worked.reduce((s, r) => s + r.gave_up, 0);
const workerErrors = worked.flatMap((r) => r.errors);

const after = new DatabaseSync(DB);
after.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
const rowCount = after.prepare('SELECT COUNT(*) AS n FROM items').get().n;
const uniqCount = after.prepare('SELECT COUNT(DISTINCT canonical_url) AS n FROM items').get().n;
const attemptCount = after.prepare('SELECT COUNT(*) AS n FROM attempts').get().n;
const leased = after.prepare("SELECT COUNT(*) AS n FROM items WHERE work_state = 'leased'").get().n;

// 결과를 못 낸 일꾼이 있으면 왜 그런지까지 말한다. 수만 세면 다음 사람이 또 헤맨다.
const fatalWorkers = alive.filter((r) => r.fatal).map((r) => `${r.tag}: ${r.fatal}`);
const silentWorkers = runs.filter((r, i) => !parsed[i])
  .map((r) => (r.timeout ? '대기 한도 초과' : (r.err || `exit ${r.code}`).slice(0, 90)));
ok('W4-all-workers-finished', alive.length === WORKERS && fatalWorkers.length === 0,
  `일꾼 ${alive.length}/${WORKERS} 가 결과를 냈다`
  + (fatalWorkers.length ? ` · 시작 실패 [${fatalWorkers.join(' | ')}]` : '')
  + (silentWorkers.length ? ` · 말없이 끝난 것 [${silentWorkers.join(' | ')}]` : ''));

// [결정성] 붐빔은 실행마다 다르다. 그래서 "정확히 200행" 이 아니라 셈이 맞는지를 본다 —
// 계획한 줄 = 들어간 줄 + 포기한 줄 + 오류, 그리고 장부의 행 수 = 일꾼이 보고한 삽입 수.
// (2026-08-12 감사: 재시도가 없던 판은 붐빌 때 180행이 나와 간헐 실패했다.)
ok('W5-row-accounting', planned === inserted + gaveUp + workerErrors.length && rowCount === inserted,
  `계획 ${planned} = 들어감 ${inserted} + 포기 ${gaveUp} + 오류 ${workerErrors.length} · 장부 행 ${rowCount}`);
ok('W5b-none-given-up', gaveUp === 0,
  gaveUp ? `${gaveUp}줄이 여덟 번 물러나고도 못 들어갔다` : `물러났다 다시 온 횟수 ${busyTotal}회, 포기 0`);
ok('W6-unique-key', uniqCount === rowCount, `고유 canonical_url ${uniqCount} / 전체 ${rowCount}`);
ok('W7-update-applied', leased === rowCount, `leased ${leased} / ${rowCount}`);
ok('W8-child-rows', attemptCount === rowCount, `attempts ${attemptCount} / items ${rowCount}`);
ok('W9-no-worker-errors', workerErrors.length === 0, workerErrors.length ? workerErrors.slice(0, 3).join(' / ') : `붐빔이 아닌 오류 0`);
after.close();

// ── transaction 중 강제 종료 ──────────────────────────────────

// [순서] 과녁을 한 명씩 다룬다. SQLite 는 쓰기 transaction 을 하나만 허용하므로
// 둘을 동시에 열어 두려 하면 뒤엣놈이 busy_timeout 까지 막힌다(첫 설계가 여기서 멈췄다).
// 그래서 "열림 확인 → SIGKILL → 종료 확인" 을 한 바퀴씩 돌린다.
const killedPids = [];
const killRounds = [];
for (let i = 0; i < KILL_TARGETS; i++) {
  const h = await runWorker(['--db', DB, '--tag', `kill${i}`, '--start-at', '0', '--hold-open'], { expectHeld: true, limitMs: 15_000 });
  if (h.timeout || !h.first?.held) {
    killRounds.push({ target: `kill${i}`, held: false, note: h.timeout ? 'transaction 을 여는 데 실패(대기 한도 초과)' : h.first?.error });
    ok(`W-kill${i}-held`, false, `과녁 kill${i} 가 transaction 을 열지 못함: ${h.first?.error ?? 'timeout'}`);
    continue;
  }
  killedPids.push(h.first.pid);
  h.child.kill('SIGKILL');
  const exit = await waitExit(h.child);
  killRounds.push({ target: `kill${i}`, held: true, pid: h.first.pid, exited: exit.exited, signal: exit.signal });
  ok(`W-kill${i}-exited`, exit.exited && exit.signal === 'SIGKILL', `pid ${h.first.pid} 종료=${exit.exited} 신호=${exit.signal}`);
}
await new Promise((r) => setTimeout(r, 500));

const reopened = new DatabaseSync(DB);
reopened.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
const integrity = reopened.prepare('PRAGMA integrity_check').get().integrity_check;
const uncommitted = reopened.prepare("SELECT COUNT(*) AS n FROM items WHERE canonical_url LIKE '%/uncommitted/%'").get().n;
const rowsAfterKill = reopened.prepare('SELECT COUNT(*) AS n FROM items').get().n;

let writeAfterKill = false;
try {
  reopened.exec('BEGIN IMMEDIATE');
  reopened.prepare('INSERT INTO items (canonical_url, work_state) VALUES (?, ?)').run('https://spike.invalid/after-kill', 'queued');
  reopened.exec('COMMIT');
  writeAfterKill = true;
} catch (e) {
  writeAfterKill = false;
  ok('W-write-after-kill-error', false, e.message.slice(0, 120));
}
reopened.close();

ok('W10-reopen-integrity', integrity === 'ok', `integrity_check = ${integrity}`);
ok('W11-uncommitted-rolled-back', uncommitted === 0, `커밋 안 된 표식 행 ${uncommitted} · 강제 종료 pid ${killedPids.join(',')}`);
ok('W12-committed-survived', rowsAfterKill === rowCount, `강제 종료 뒤 행 ${rowsAfterKill} / 이전 ${rowCount}`);
ok('W13-writable-after-kill', writeAfterKill, writeAfterKill ? '강제 종료 뒤에도 새 쓰기가 된다(영구 잠금 없음)' : '쓰기 불가');

const leftovers = fs.readdirSync(sandbox).filter((f) => f.endsWith('-wal') || f.endsWith('-shm'));
ok('W14-no-stale-lock-files', leftovers.length === 0, leftovers.length ? `남은 파일 ${leftovers.join(', ')}` : '모든 연결을 닫은 뒤 -wal·-shm 이 남지 않았다');

// ── 대조 — 안전 조건을 빼면 실제로 통과해 버리는가 ────────────
// foreign_keys 는 연결마다 켜야 한다. 끄고 열면 같은 삽입이 그냥 들어간다 —
// W3 이 무언가를 실제로 재고 있었다는 증거다.

let orphanAccepted = false;
{
  const loose = new DatabaseSync(DB);
  loose.exec('PRAGMA foreign_keys = OFF');
  try {
    loose.prepare('INSERT INTO attempts (item_id, collector) VALUES (?, ?)').run(999999, 'http');
    orphanAccepted = true;
    loose.exec('DELETE FROM attempts WHERE item_id = 999999');
  } catch { orphanAccepted = false; }
  loose.close();
}
ok('W15-control-foreign-keys-off', orphanAccepted,
  orphanAccepted
    ? 'foreign_keys 를 끄면 없는 item_id 의 attempt 가 그대로 들어간다 → W3 이 실제로 재고 있다'
    : '끈 상태에서도 막혔다면 W3 은 다른 이유로 통과한 것이다');

// ── 결과 저장 ─────────────────────────────────────────────────

fs.mkdirSync(RESULTS, { recursive: true });
const report = {
  spike: 'workspace.db',
  ran_at: new Date().toISOString(),
  node_version: process.version,
  sqlite_version: new DatabaseSync(':memory:').prepare('select sqlite_version() as v').get().v,
  sandbox,
  settings: { workers: WORKERS, rows_each: ROWS_EACH, kill_targets: KILL_TARGETS, busy_timeout_ms: BUSY_TIMEOUT_MS },
  limitation: {
    experimental: 'node:sqlite 는 Node v22.21.0 에서 아직 실험 기능이라 실행마다 ExperimentalWarning 이 뜬다.',
    means: '이번 실측이 이 환경에서 통과했다는 뜻이지 API 가 앞으로 그대로 남는다는 보장은 아니다.',
    guard_needed: '구현에 Node 최소 버전 확인을 넣고, node:sqlite import 실패나 동작 변화를 명시적 오류로 드러내야 한다.',
  },
  measured: {
    journal_mode: journalMode,
    foreign_keys: fkOn,
    planned_rows: planned,
    rows: rowCount,
    unique_canonical_url: uniqCount,
    attempts: attemptCount,
    leased: leased,
    sqlite_busy_retries: busyTotal,
    gave_up: gaveUp,
    accounting_holds: planned === inserted + gaveUp + workerErrors.length && rowCount === inserted,
    worker_errors: workerErrors,
    killed_pids: killedPids,
    kill_rounds: killRounds,
    kill_design_note: '첫 설계는 과녁 둘의 쓰기 transaction 을 동시에 열어 두려 했고, SQLite 의 단일 writer 제약 때문에 뒤엣놈이 busy_timeout 에 막혀 시험이 멈췄다(2026-08-12 실측, 2분 한도 초과). 지금은 한 명씩 열고 죽이며, 모든 자식 대기에 벽시계 제한과 SIGKILL 정리를 걸었다.',
    integrity_check: integrity,
    uncommitted_rows_after_kill: uncommitted,
    writable_after_kill: writeAfterKill,
    stale_lock_files: leftovers,
    control_foreign_keys_off_accepts_orphan: orphanAccepted,
  },
  checks,
};
fs.writeFileSync(path.join(RESULTS, 'workspace.json'), `${JSON.stringify(report, null, 2)}\n`);
fs.rmSync(sandbox, { recursive: true, force: true });

if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
else for (const c of checks) console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.id} — ${c.detail}`);

const failed = checks.filter((c) => !c.pass);
console.log(failed.length === 0 ? `PASS  workspace.db 실측 ${checks.length}항목 통과` : `FAIL  ${failed.length}건`);
process.exit(failed.length === 0 ? 0 : 1);
