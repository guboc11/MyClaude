#!/usr/bin/env node
// workspace.db 동시 쓰기 일꾼. 부모가 spawn 한다.
//
//   node workspace-worker.mjs --db <경로> --tag <이름> --rows <n> --start-at <epoch_ms> [--hold-open]
//
// --hold-open 이면 transaction 을 연 채 표식 행만 넣고 버틴다. 부모가 SIGKILL 할 과녁이다.
// 결과는 stdout 에 JSON 한 줄.

import { DatabaseSync } from 'node:sqlite';

const arg = (k, d = null) => {
  const i = process.argv.indexOf(k);
  return i === -1 ? d : process.argv[i + 1];
};
const has = (k) => process.argv.includes(k);

const DB = arg('--db');
const TAG = arg('--tag');
const ROWS = Number(arg('--rows', '20'));
const START_AT = Number(arg('--start-at', '0'));
const BUSY_TIMEOUT_MS = Number(arg('--busy-timeout', '5000'));

// [순서] busy_timeout 을 가장 먼저 건다. journal_mode 를 먼저 실행하면 열 개가 동시에 열 때
// 하나가 잠금에 걸려 아무 말도 못 하고 죽는다(2026-08-12 감사: 일꾼 9/10, 180행).
// 그리고 시작에서 실패해도 조용히 사라지지 않도록 한 줄을 남긴다.
let db;
try {
  db = new DatabaseSync(DB);
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
} catch (e) {
  process.stdout.write(`${JSON.stringify({ tag: TAG, pid: process.pid, fatal: `open: ${e.message.slice(0, 160)}` })}\n`);
  process.exit(3);
}

// 같은 순간에 임계 구역으로 들어가게 한다. setTimeout 은 수 ms 오차가 나서 경합이 안 생긴다.
while (Date.now() < START_AT) { /* busy-wait */ }

if (has('--hold-open')) {
  // 커밋하지 않은 채 버틴다. 이 행은 강제 종료 뒤 남아 있으면 안 된다.
  //
  // [한 번에 하나만] SQLite 는 쓰기 transaction 을 하나만 허용한다. 과녁 둘을 동시에 띄우면
  // 뒤엣놈이 busy_timeout 까지 막혀 아무 말도 못 하고, 부모는 영영 기다린다(2026-08-12 실측).
  // 그래서 부모가 과녁을 한 명씩 띄우고 죽인다. 여기서도 실패를 삼키지 않고 알린다.
  try {
    db.exec('BEGIN IMMEDIATE');
    db.prepare('INSERT INTO items (canonical_url, work_state, owner) VALUES (?, ?, ?)')
      .run(`https://spike.invalid/uncommitted/${TAG}`, 'queued', TAG);
    process.stdout.write(`${JSON.stringify({ tag: TAG, held: true, pid: process.pid })}\n`);
    setInterval(() => {}, 1000);      // 부모가 죽일 때까지 산다
  } catch (e) {
    process.stdout.write(`${JSON.stringify({ tag: TAG, held: false, pid: process.pid, error: e.message.slice(0, 160) })}\n`);
    process.exit(2);
  }
} else {
  // 붐빌 때 한 번 밀렸다고 그 줄을 버리면 총계가 실행마다 달라진다(2026-08-12 간헐 실패).
  // 실제 워커도 물러났다 다시 온다. 재시도 횟수는 따로 세어 감춘 것이 없게 한다.
  const RETRY_MAX = 8;
  const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

  const out = { tag: TAG, pid: process.pid, planned: ROWS, inserted: 0, updated: 0, busy_retries: 0, gave_up: 0, errors: [] };
  const insert = db.prepare('INSERT INTO items (canonical_url, work_state, owner) VALUES (?, ?, ?)');
  const update = db.prepare("UPDATE items SET work_state = 'leased', owner = ? WHERE canonical_url = ?");
  const attempt = db.prepare('INSERT INTO attempts (item_id, collector) VALUES ((SELECT item_id FROM items WHERE canonical_url = ?), ?)');

  for (let i = 0; i < ROWS; i++) {
    const url = `https://spike.invalid/${TAG}/${i}`;
    let settled = false;
    for (let t = 0; t < RETRY_MAX && !settled; t++) {
      try {
        db.exec('BEGIN IMMEDIATE');
        insert.run(url, 'queued', TAG);
        attempt.run(url, 'http');
        update.run(TAG, url);
        db.exec('COMMIT');
        out.inserted++;
        out.updated++;
        settled = true;
      } catch (e) {
        try { db.exec('ROLLBACK'); } catch { /* 이미 풀렸으면 그만 */ }
        if (/SQLITE_BUSY|database is locked/i.test(e.message)) {
          out.busy_retries++;
          sleepMs(20 + Math.floor(Math.random() * 40));
        } else {
          out.errors.push(e.message.slice(0, 120));
          settled = true;                 // 붐빔이 아닌 오류는 되풀이해도 같다
        }
      }
    }
    if (!settled) out.gave_up++;          // 여덟 번 물러나고도 못 들어간 줄
  }
  db.close();
  process.stdout.write(`${JSON.stringify(out)}\n`);
}
