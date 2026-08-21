#!/usr/bin/env node
// 전역 pace.db 예약 일꾼. 부모가 서로 다른 cwd 에서 spawn 한다.
//
//   node pace-worker.mjs --db <경로> --tag <이름> --domain <도메인> --reservations <n>
//                        --interval <ms> --start-at <epoch_ms> [--busy-timeout <ms>] [--unsafe] [--hold-open]
//
// --unsafe 는 대조용이다. transaction 없이 읽고 쓴다 — 중복 발급이 실제로 나오는지 보려는 것이다.
// --hold-open 은 강제 종료 과녁이다. 커밋하지 않은 예약을 남긴 채 버틴다.
//
// 이 표들은 이 spike 전용이다(spike_ 접두). #24 가 만들 진짜 pace 계약이 아니다.

import { DatabaseSync } from 'node:sqlite';

const arg = (k, d = null) => {
  const i = process.argv.indexOf(k);
  return i === -1 ? d : process.argv[i + 1];
};
const has = (k) => process.argv.includes(k);

const DB = arg('--db');
const TAG = arg('--tag');
const DOMAIN = arg('--domain', 'spike.invalid');
const N = Number(arg('--reservations', '3'));
const INTERVAL = Number(arg('--interval', '25'));
const START_AT = Number(arg('--start-at', '0'));
const BUSY_TIMEOUT_MS = Number(arg('--busy-timeout', '5000'));
const UNSAFE = has('--unsafe');

// busy_timeout 을 먼저 건다 — journal_mode 가 먼저면 스무 개가 동시에 열 때 잠금에 걸려 죽는다.
let db;
try {
  db = new DatabaseSync(DB);
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  db.exec('PRAGMA journal_mode = WAL');
} catch (e) {
  process.stdout.write(`${JSON.stringify({ tag: TAG, pid: process.pid, fatal: `open: ${e.message.slice(0, 160)}` })}\n`);
  process.exit(3);
}

const readDomain = db.prepare('SELECT next_allowed_at FROM spike_pace_domain WHERE domain = ?');
const readSlot = db.prepare('SELECT COALESCE(MAX(slot_index), -1) AS s FROM spike_pace_reservation WHERE domain = ?');
const upsertDomain = db.prepare(`
  INSERT INTO spike_pace_domain (domain, next_allowed_at) VALUES (?, ?)
  ON CONFLICT(domain) DO UPDATE SET next_allowed_at = excluded.next_allowed_at`);
const insertReservation = db.prepare(
  'INSERT INTO spike_pace_reservation (domain, slot_index, allowed_at, pid, cwd, created_at) VALUES (?, ?, ?, ?, ?, ?)');

function reserveOnce() {
  const now = Date.now();
  const prevNext = readDomain.get(DOMAIN)?.next_allowed_at ?? 0;
  const allowedAt = Math.max(now, prevNext);
  const slot = readSlot.get(DOMAIN).s + 1;
  if (UNSAFE) {
    // 읽기와 쓰기 사이를 일부러 벌린다. 잠금이 없으면 두 프로세스가 같은 값을 읽는다.
    const spin = Date.now() + 2;
    while (Date.now() < spin) { /* busy-wait */ }
  }
  upsertDomain.run(DOMAIN, allowedAt + INTERVAL);
  insertReservation.run(DOMAIN, slot, allowedAt, process.pid, process.cwd(), now);
  return { slot, allowedAt };
}

while (Date.now() < START_AT) { /* busy-wait — 같은 순간에 들어간다 */ }

if (has('--hold-open')) {
  try {
    db.exec('BEGIN IMMEDIATE');
    insertReservation.run(DOMAIN, -999, Date.now(), process.pid, process.cwd(), Date.now());
    process.stdout.write(`${JSON.stringify({ tag: TAG, held: true, pid: process.pid, cwd: process.cwd() })}\n`);
    setInterval(() => {}, 1000);
  } catch (e) {
    process.stdout.write(`${JSON.stringify({ tag: TAG, held: false, pid: process.pid, error: e.message.slice(0, 160) })}\n`);
    process.exit(2);
  }
} else {
  // 붐빔은 실행마다 다르다. 밀리면 물러났다 다시 온다 — 실제 워커도 그렇게 한다.
  const RETRY_MAX = 8;
  const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

  const out = { tag: TAG, pid: process.pid, cwd: process.cwd(), planned: N, granted: 0, busy_retries: 0, gave_up: 0, waits_ms: [], errors: [], slots: [] };
  for (let i = 0; i < N; i++) {
    const t0 = Date.now();
    let settled = false;
    for (let t = 0; t < RETRY_MAX && !settled; t++) {
      try {
        if (UNSAFE) {
          const r = reserveOnce();               // 대조: transaction 없음
          out.slots.push(r.slot);
        } else {
          db.exec('BEGIN IMMEDIATE');            // 예약을 원자적으로 잡는다
          const r = reserveOnce();
          db.exec('COMMIT');
          out.slots.push(r.slot);
        }
        out.granted++;
        settled = true;
      } catch (e) {
        if (!UNSAFE) { try { db.exec('ROLLBACK'); } catch { /* 이미 풀렸으면 그만 */ } }
        if (/SQLITE_BUSY|database is locked/i.test(e.message)) {
          out.busy_retries++;
          sleepMs(15 + Math.floor(Math.random() * 30));
        } else {
          out.errors.push(e.message.slice(0, 120));
          settled = true;
        }
      }
    }
    if (!settled) out.gave_up++;
    out.waits_ms.push(Date.now() - t0);
  }
  db.close();
  process.stdout.write(`${JSON.stringify(out)}\n`);
}
