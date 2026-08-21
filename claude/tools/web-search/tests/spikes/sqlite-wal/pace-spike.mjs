#!/usr/bin/env node
// 전역 pace.db 실측 — 서로 다른 프로젝트에서 온 프로세스 20개가 같은 도메인을 예약한다.
//
//   node tests/spikes/sqlite-wal/pace-spike.mjs [--json]
//
// 표 이름은 spike_ 로 시작한다. 이 spike 전용이고 #24 가 만들 진짜 계약이 아니다.
//
// 부모(이 파일)가 표를 만들고 일꾼을 띄우고 과녁을 죽인다. 일꾼은 pace-worker.mjs.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER = path.join(HERE, 'pace-worker.mjs');
const RESULTS = path.join(HERE, 'results');

// [자기 자리에서 잰다] 처음에는 계획서 8절이 정한 운영용 `runtime/pace.db` 를 그대로 썼다.
// 도구가 실제로 쓰이기 시작하자 두 가지가 어긋났다 — spike 표가 운영 장부에 섞였고,
// "다 끝난 뒤 -wal·-shm 이 남지 않는가" 라는 검사가 **다른 프로세스가 그 장부를 쓰는 중이면**
// 실패했다(2026-08-12, 시나리오 B 수집이 도는 동안 게이트 0 이 이 이유로 빨간불이 됐다).
// SQLite 가 잠금을 다루는 방식은 파일이 어디 있든 같으므로, 자기 폴더에서 재고 운영 장부는
// 건드리지 않는다. 재는 성질은 그대로다.
const RUNTIME_DIR = process.env.WEBSEARCH_SPIKE_RUNTIME
  ?? path.join(os.tmpdir(), 'web-search-pace-spike');
const DB = path.join(RUNTIME_DIR, 'pace.db');

const WORKERS = 20;
const RESERVATIONS_EACH = 3;
const MIN_INTERVAL_MS = 25;
const BUSY_TIMEOUT_MS = 5000;
const KILL_TARGETS = 2;
const WAIT_LIMIT_MS = 30_000;
const DOMAIN = 'spike.invalid';

const checks = [];
const ok = (id, pass, detail) => checks.push({ id, pass, detail });

// ── 표 준비 — 매 실행이 서로 독립되도록 이 spike 표만 비운다 ──

fs.mkdirSync(RUNTIME_DIR, { recursive: true });
const db = new DatabaseSync(DB);
const journalMode = db.prepare('PRAGMA journal_mode = WAL').get().journal_mode;
db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
db.exec(`
  CREATE TABLE IF NOT EXISTS spike_pace_domain (
    domain TEXT PRIMARY KEY,
    next_allowed_at INTEGER NOT NULL
  );
  -- 일부러 (domain, slot_index) 에 UNIQUE 를 걸지 않는다.
  -- 중복을 DB 제약으로 막아 버리면 transaction 이 실제로 막고 있는지 잴 수 없다.
  CREATE TABLE IF NOT EXISTS spike_pace_reservation (
    id INTEGER PRIMARY KEY,
    domain TEXT NOT NULL,
    slot_index INTEGER NOT NULL,
    allowed_at INTEGER NOT NULL,
    pid INTEGER NOT NULL,
    cwd TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
`);
// [안전 경계] 이 spike 는 spike_ 로 시작하는 자기 표의 행만 지운다.
// 다른 표를 지우거나 pace.db 파일 자체를 삭제하지 않는다 — 이 폴더는 도구 전역 자리다.
const tablesBefore = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name);
const foreignTables = tablesBefore.filter((n) => !n.startsWith('spike_') && !n.startsWith('sqlite_'));
db.exec('DELETE FROM spike_pace_reservation');
db.exec('DELETE FROM spike_pace_domain');
const tablesAfterClear = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name);
db.close();

ok('P1-exact-path', fs.existsSync(DB), `${DB} (journal_mode=${journalMode})`);
ok('P1b-safety-boundary',
  foreignTables.every((n) => tablesAfterClear.includes(n)) && tablesAfterClear.every((n) => n.startsWith('spike_') || n.startsWith('sqlite_') || foreignTables.includes(n)),
  `표 ${tablesAfterClear.join(', ') || '(없음)'} · 이 spike 가 만들지 않은 표 ${foreignTables.length}개는 손대지 않았다`);

// ── 서로 다른 프로젝트 경로 20개 ──────────────────────────────

const projectRoots = Array.from({ length: WORKERS }, (_, i) =>
  fs.mkdtempSync(path.join(os.tmpdir(), `pace-proj-${i}-`)));

function runWorker(args, { cwd, expectHeld = false, limitMs = WAIT_LIMIT_MS } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [WORKER, ...args], { stdio: ['ignore', 'pipe', 'pipe'], cwd });
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

// ── 20개 프로세스가 같은 순간에 같은 도메인을 예약한다 ────────

const startAt = Date.now() + 900;
const runs = await Promise.all(projectRoots.map((cwd, i) => runWorker([
  '--db', DB, '--tag', `p${i}`, '--domain', DOMAIN,
  '--reservations', String(RESERVATIONS_EACH), '--interval', String(MIN_INTERVAL_MS),
  '--start-at', String(startAt), '--busy-timeout', String(BUSY_TIMEOUT_MS),
], { cwd })));

const parsed = runs.map((r) => { try { return JSON.parse(r.out); } catch { return null; } });
const alive = parsed.filter(Boolean);
const worked = alive.filter((r) => !r.fatal);   // 시작에서 죽은 일꾼은 셈에서 뺀다
const timedOut = runs.filter((r) => r.timeout).length;
const plannedTotal = worked.reduce((s, r) => s + r.planned, 0);
const granted = worked.reduce((s, r) => s + r.granted, 0);
const busyTotal = worked.reduce((s, r) => s + r.busy_retries, 0);
const gaveUp = worked.reduce((s, r) => s + r.gave_up, 0);
const allWaits = worked.flatMap((r) => r.waits_ms);
const workerErrors = worked.flatMap((r) => r.errors);
const distinctCwd = new Set(worked.map((r) => r.cwd)).size;

{
  // 시작에서 죽은 일꾼을 수만 세고 넘기지 않는다. 왜 죽었는지까지 남긴다.
  const fatalWorkers = alive.filter((r) => r.fatal).map((r) => `${r.tag}: ${r.fatal}`);
  const silentWorkers = runs.filter((r, i) => !parsed[i])
    .map((r) => (r.timeout ? '대기 한도 초과' : (r.err || `exit ${r.code}`).slice(0, 90)));
  ok('P2-all-workers-finished', worked.length === WORKERS && timedOut === 0 && fatalWorkers.length === 0,
    `일꾼 ${worked.length}/${WORKERS} · 대기 한도 초과 ${timedOut}`
    + (fatalWorkers.length ? ` · 시작 실패 [${fatalWorkers.join(' | ')}]` : '')
    + (silentWorkers.length ? ` · 말없이 끝난 것 [${silentWorkers.join(' | ')}]` : ''));
}
ok('P3-distinct-project-roots', distinctCwd === WORKERS, `서로 다른 cwd ${distinctCwd}개`);

// ── 예약 장부 검사 ────────────────────────────────────────────

const after = new DatabaseSync(DB);
after.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
const rows = after.prepare('SELECT slot_index, allowed_at, pid FROM spike_pace_reservation WHERE domain = ? ORDER BY allowed_at, id').all(DOMAIN);
const slots = rows.map((r) => r.slot_index);
const dupSlots = slots.length - new Set(slots).size;
const times = rows.map((r) => r.allowed_at);
const dupTimes = times.length - new Set(times).size;
const gaps = times.slice(1).map((t, i) => t - times[i]);
const tooClose = gaps.filter((g) => g < MIN_INTERVAL_MS);

// 붐빔에 흔들리지 않는 셈. 계획한 예약 = 받은 것 + 포기한 것 + 오류, 장부 = 받은 것.
ok('P4-reservation-accounting',
  plannedTotal === granted + gaveUp + workerErrors.length && rows.length === granted && gaveUp === 0,
  `계획 ${plannedTotal} = 받음 ${granted} + 포기 ${gaveUp} + 오류 ${workerErrors.length} · 장부 ${rows.length}`);
ok('P5-no-duplicate-slot', dupSlots === 0, `같은 slot_index 중복 ${dupSlots}건`);
ok('P6-no-duplicate-time', dupTimes === 0, `같은 allowed_at 중복 ${dupTimes}건`);
ok('P7-interval-respected', tooClose.length === 0,
  `연속 예약 ${gaps.length}쌍 중 ${MIN_INTERVAL_MS}ms 미만 ${tooClose.length}건 · 최소 간격 ${gaps.length ? Math.min(...gaps) : '-'}ms`);
ok('P8-no-worker-errors', workerErrors.length === 0,
  workerErrors.length ? workerErrors.slice(0, 3).join(' / ')
    : `오류 0 · SQLITE_BUSY ${busyTotal}회 · busy_timeout ${BUSY_TIMEOUT_MS}ms · 실제 대기 최대 ${Math.max(...allWaits)}ms 평균 ${Math.round(allWaits.reduce((a, b) => a + b, 0) / allWaits.length)}ms`);
after.close();

// ── transaction 중 강제 종료 (한 명씩) ────────────────────────

const killedPids = [];
const killRounds = [];
for (let i = 0; i < KILL_TARGETS; i++) {
  const h = await runWorker(['--db', DB, '--tag', `k${i}`, '--domain', DOMAIN, '--hold-open', '--busy-timeout', String(BUSY_TIMEOUT_MS)],
    { cwd: projectRoots[i], expectHeld: true, limitMs: 15_000 });
  if (h.timeout || !h.first?.held) {
    killRounds.push({ target: `k${i}`, held: false, note: h.timeout ? '대기 한도 초과' : h.first?.error });
    ok(`P-kill${i}-held`, false, `과녁 k${i} 가 transaction 을 열지 못함`);
    continue;
  }
  killedPids.push(h.first.pid);
  h.child.kill('SIGKILL');
  const exit = await waitExit(h.child);
  killRounds.push({ target: `k${i}`, held: true, pid: h.first.pid, exited: exit.exited, signal: exit.signal, cwd: h.first.cwd });
  ok(`P-kill${i}-exited`, exit.exited && exit.signal === 'SIGKILL', `pid ${h.first.pid} 종료=${exit.exited} 신호=${exit.signal}`);
}
await new Promise((r) => setTimeout(r, 500));

const reopened = new DatabaseSync(DB);
reopened.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
const integrity = reopened.prepare('PRAGMA integrity_check').get().integrity_check;
const uncommitted = reopened.prepare('SELECT COUNT(*) AS n FROM spike_pace_reservation WHERE slot_index = -999').get().n;
const rowsAfterKill = reopened.prepare('SELECT COUNT(*) AS n FROM spike_pace_reservation WHERE domain = ?').get(DOMAIN).n;

let writeAfterKill = false;
try {
  reopened.exec('BEGIN IMMEDIATE');
  reopened.prepare('INSERT INTO spike_pace_reservation (domain, slot_index, allowed_at, pid, cwd, created_at) VALUES (?,?,?,?,?,?)')
    .run('after-kill.invalid', 0, Date.now(), process.pid, process.cwd(), Date.now());
  reopened.exec('COMMIT');
  reopened.exec("DELETE FROM spike_pace_reservation WHERE domain = 'after-kill.invalid'");
  writeAfterKill = true;
} catch { writeAfterKill = false; }
reopened.close();

ok('P9-reopen-integrity', integrity === 'ok', `integrity_check = ${integrity}`);
ok('P10-uncommitted-rolled-back', uncommitted === 0, `커밋 안 된 예약 ${uncommitted}건 · 강제 종료 pid ${killedPids.join(',')}`);
ok('P11-committed-survived', rowsAfterKill === rows.length, `강제 종료 뒤 예약 ${rowsAfterKill} / 이전 ${rows.length}`);
ok('P12-writable-after-kill', writeAfterKill, writeAfterKill ? '강제 종료 뒤에도 새 예약이 된다' : '쓰기 불가');

const leftovers = ['pace.db-wal', 'pace.db-shm'].filter((f) => fs.existsSync(path.join(RUNTIME_DIR, f)));
ok('P13-no-permanent-lock', leftovers.length === 0,
  leftovers.length ? `남은 파일 ${leftovers.join(', ')}` : '모든 프로세스가 끝난 뒤 -wal·-shm 이 남지 않았다');

// ── 대조 실행 — 안전 조건을 빼면 실제로 깨지는가 ──────────────

const unsafeDb = path.join(RUNTIME_DIR, 'pace-unsafe-control.db');
fs.rmSync(unsafeDb, { force: true });
{
  const u = new DatabaseSync(unsafeDb);
  u.exec('PRAGMA journal_mode = WAL');
  u.exec(`
    CREATE TABLE spike_pace_domain (domain TEXT PRIMARY KEY, next_allowed_at INTEGER NOT NULL);
    CREATE TABLE spike_pace_reservation (
      id INTEGER PRIMARY KEY, domain TEXT NOT NULL, slot_index INTEGER NOT NULL,
      allowed_at INTEGER NOT NULL, pid INTEGER NOT NULL, cwd TEXT NOT NULL, created_at INTEGER NOT NULL);
  `);
  u.close();
}
const unsafeStart = Date.now() + 700;
await Promise.all(projectRoots.map((cwd, i) => runWorker([
  '--db', unsafeDb, '--tag', `u${i}`, '--domain', DOMAIN,
  '--reservations', String(RESERVATIONS_EACH), '--interval', String(MIN_INTERVAL_MS),
  '--start-at', String(unsafeStart), '--busy-timeout', String(BUSY_TIMEOUT_MS), '--unsafe',
], { cwd })));

const uc = new DatabaseSync(unsafeDb);
const uRows = uc.prepare('SELECT slot_index, allowed_at FROM spike_pace_reservation WHERE domain = ? ORDER BY allowed_at, id').all(DOMAIN);
const uSlots = uRows.map((r) => r.slot_index);
const uDupSlots = uSlots.length - new Set(uSlots).size;
const uTimes = uRows.map((r) => r.allowed_at);
const uGaps = uTimes.slice(1).map((t, i) => t - uTimes[i]);
const uTooClose = uGaps.filter((g) => g < MIN_INTERVAL_MS);
uc.close();
fs.rmSync(unsafeDb, { force: true });
fs.rmSync(`${unsafeDb}-wal`, { force: true });
fs.rmSync(`${unsafeDb}-shm`, { force: true });

ok('P14-control-catches-duplicates', uDupSlots > 0 || uTooClose.length > 0,
  `transaction 을 뺀 대조: 예약 ${uRows.length}건 중 slot 중복 ${uDupSlots}건 · 간격 위반 ${uTooClose.length}건`
  + ((uDupSlots > 0 || uTooClose.length > 0) ? ' → 시험이 실제로 잡는다' : ' → 아무것도 안 잡혔다면 이 시험은 공허하다'));

// ── 정리와 저장 ───────────────────────────────────────────────

for (const p of projectRoots) fs.rmSync(p, { recursive: true, force: true });

fs.mkdirSync(RESULTS, { recursive: true });
const report = {
  spike: 'global pace.db',
  ran_at: new Date().toISOString(),
  node_version: process.version,
  sqlite_version: new DatabaseSync(':memory:').prepare('select sqlite_version() as v').get().v,
  db_path: DB,
  tables: ['spike_pace_domain', 'spike_pace_reservation'],
  table_note: '이 spike 전용 표다. #24 가 만들 진짜 pace 계약이 아니며, 스키마를 그대로 쓰라는 뜻도 아니다.',
  safety_boundary: {
    clears: ['spike_pace_domain 의 행', 'spike_pace_reservation 의 행'],
    never: ['다른 표 삭제', 'pace.db 파일 삭제', 'runtime 폴더의 다른 파일 손대기'],
    tables_seen_before: tablesBefore,
    foreign_tables_untouched: foreignTables,
  },
  limitation: {
    experimental: 'node:sqlite 는 Node v22.21.0 에서 아직 실험 기능이라 실행마다 ExperimentalWarning 이 뜬다.',
    means: '이번 실측이 이 환경에서 통과했다는 뜻이지 API 가 앞으로 그대로 남는다는 보장은 아니다.',
    guard_needed: '구현에 Node 최소 버전 확인을 넣고, node:sqlite import 실패나 동작 변화를 명시적 오류로 드러내야 한다.',
  },
  settings: {
    workers: WORKERS, reservations_each: RESERVATIONS_EACH, min_interval_ms: MIN_INTERVAL_MS,
    busy_timeout_ms: BUSY_TIMEOUT_MS, kill_targets: KILL_TARGETS, domain: DOMAIN,
  },
  measured: {
    journal_mode: journalMode,
    distinct_project_roots: distinctCwd,
    planned_reservations: plannedTotal,
    reservations: rows.length,
    gave_up: gaveUp,
    accounting_holds: plannedTotal === granted + gaveUp + workerErrors.length && rows.length === granted,
    duplicate_slot_index: dupSlots,
    duplicate_allowed_at: dupTimes,
    min_gap_ms: gaps.length ? Math.min(...gaps) : null,
    interval_violations: tooClose.length,
    sqlite_busy_count: busyTotal,
    wait_ms: { max: Math.max(...allWaits), avg: Math.round(allWaits.reduce((a, b) => a + b, 0) / allWaits.length) },
    worker_errors: workerErrors,
    killed_pids: killedPids,
    kill_rounds: killRounds,
    integrity_check: integrity,
    uncommitted_after_kill: uncommitted,
    writable_after_kill: writeAfterKill,
    permanent_lock_files: leftovers,
    control_without_transaction: { reservations: uRows.length, duplicate_slot_index: uDupSlots, interval_violations: uTooClose.length },
  },
  checks,
};
fs.writeFileSync(path.join(RESULTS, 'pace.json'), `${JSON.stringify(report, null, 2)}\n`);

if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
else for (const c of checks) console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.id} — ${c.detail}`);

const failed = checks.filter((c) => !c.pass);
console.log(failed.length === 0 ? `PASS  전역 pace.db 실측 ${checks.length}항목 통과` : `FAIL  ${failed.length}건`);
process.exit(failed.length === 0 ? 0 : 1);
