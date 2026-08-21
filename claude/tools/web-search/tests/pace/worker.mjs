#!/usr/bin/env node
// 전역 pace 장부에 예약을 잡는 일꾼. 부모가 서로 다른 cwd 에서 스무 개를 띄운다.
//
//   node tests/pace/worker.mjs --db <경로> --tag <이름> --domain <도메인>
//                              --reservations <n> --interval <ms> --start-at <epoch_ms> [--unsafe]
//
// --unsafe 는 대조용이다. 진짜 lib 을 쓰지 않고 transaction 없이 읽고 쓴다.
// 이 모드에서 같은 자리가 두 번 나와야 시험이 "중복을 잡아낼 수 있다" 는 것이 증명된다.

import { DatabaseSync } from 'node:sqlite';
import { openPace, reserve } from '../../lib/pace.mjs';

const arg = (k, d = null) => {
  const i = process.argv.indexOf(k);
  return i === -1 ? d : process.argv[i + 1];
};
const has = (k) => process.argv.includes(k);

const DB = arg('--db');
const TAG = arg('--tag');
const DOMAIN = arg('--domain', 'fixture.invalid');
const N = Number(arg('--reservations', '3'));
const INTERVAL = Number(arg('--interval', '25'));
const START_AT = Number(arg('--start-at', '0'));
const UNSAFE = has('--unsafe');

const out = { tag: TAG, pid: process.pid, cwd: process.cwd(), planned: N, granted: 0, slots: [], errors: [] };

let db;
try {
  if (UNSAFE) {
    db = new DatabaseSync(DB);
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA journal_mode = WAL');
  } else {
    db = openPace({ dbPath: DB });
  }
} catch (e) {
  process.stdout.write(`${JSON.stringify({ tag: TAG, pid: process.pid, fatal: `open: ${e.message.slice(0, 160)}` })}\n`);
  process.exit(3);
}

// 같은 순간에 들어간다. 이 문이 없으면 프로세스 시작 지연 때문에 앞선 쪽이 이미 끝나 있어
// 경합 자체가 생기지 않는다.
while (Date.now() < START_AT) { /* busy-wait */ }

const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** 대조용 — 읽기와 쓰기 사이를 일부러 벌린다. 잠금이 없으면 두 프로세스가 같은 값을 읽는다. */
function unsafeReserve() {
  const row = db.prepare('SELECT next_allowed_at, slot_seq FROM pace_domain WHERE domain = ?').get(DOMAIN)
    ?? { next_allowed_at: 0, slot_seq: 0 };
  const now = Date.now();
  const allowedAt = Math.max(now, row.next_allowed_at);
  const slot = row.slot_seq;
  const spin = Date.now() + 2;
  while (Date.now() < spin) { /* busy-wait */ }
  db.prepare(`
    INSERT INTO pace_domain (domain, next_allowed_at, last_reserved_at, slot_seq, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(domain) DO UPDATE SET
      next_allowed_at = excluded.next_allowed_at, last_reserved_at = excluded.last_reserved_at,
      slot_seq = excluded.slot_seq, updated_at = excluded.updated_at`)
    .run(DOMAIN, allowedAt + INTERVAL, now, slot + 1, now);
  db.prepare('INSERT INTO pace_reservation (domain, slot_index, allowed_at, gap_ms, holder, reserved_at) VALUES (?,?,?,?,?,?)')
    .run(DOMAIN, slot, allowedAt, INTERVAL, TAG, now);
  return { slot_index: slot, allowed_at: allowedAt };
}

for (let i = 0; i < N; i++) {
  let settled = false;
  for (let t = 0; t < 8 && !settled; t++) {
    try {
      const r = UNSAFE
        ? unsafeReserve()
        // jitter 를 0 으로 둔다 — 간격이 정확히 INTERVAL 이라야 "정책보다 짧아졌는가" 를 딱 잘라 볼 수 있다.
        : reserve(db, DOMAIN, { holder: TAG, opts: { min_interval_ms: INTERVAL, jitter_ms: 0 } });
      if (r.granted === false) { out.errors.push(`not_granted:${r.reason}`); settled = true; break; }
      out.slots.push({ slot_index: r.slot_index, allowed_at: r.allowed_at, holder: TAG });
      out.granted++;
      settled = true;
    } catch (e) {
      if (/SQLITE_BUSY|database is locked/i.test(e.message)) sleepMs(15 + Math.floor(Math.random() * 30));
      else { out.errors.push(e.message.slice(0, 120)); settled = true; }
    }
  }
  if (!settled) out.errors.push('gave_up');
}

db.close();
process.stdout.write(`${JSON.stringify(out)}\n`);
