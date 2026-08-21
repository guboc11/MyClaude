#!/usr/bin/env node
// 전역 pace 장부 시험 — 태스크 #24.
//
//   node tests/pace/verify.mjs
//   node tests/pace/verify.mjs --json
//
// 완료 조건이 "workspace 가 달라도 같은 도메인의 실제 요청 간격이 정책보다 짧아지지 않는다" 이므로,
// 한 프로세스에서 함수를 불러 보는 것으로는 아무것도 증명하지 못한다. 서로 다른 cwd 에서
// **진짜 프로세스 스무 개**를 같은 순간에 들여보낸다.
//
// 네트워크는 쓰지 않는다. 마지막 항목이 그 사실을 판정한다.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import {
  MAX_AUTO_BACKOFF_MS, PACE_DEFAULTS, PaceError,
  defaultPacePath, normalizeDomain, openPace, peek, record, reservationsOf,
  reserve, sleepDomain, wakeDomain, withPace,
} from '../../lib/pace.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER = path.join(HERE, 'worker.mjs');
const AS_JSON = process.argv.includes('--json');

let networkAttempts = 0;
globalThis.fetch = (...a) => { networkAttempts++; throw new Error(`네트워크 금지: ${String(a[0]).slice(0, 60)}`); };

const results = [];
const ok = (id, pass, detail) => results.push({ id, pass: Boolean(pass), detail: String(detail) });
function throwsWith(code, fn) {
  try { fn(); return { pass: false, detail: '던지지 않았다' }; } catch (e) {
    return { pass: e?.code === code, detail: `code=${e?.code}${e?.code === code ? '' : ` (기대 ${code})`}` };
  }
}

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'pace-'));
process.on('exit', () => { try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* 이미 없으면 그만 */ } });

let seq = 0;
const freshDbPath = () => path.join(SANDBOX, `pace${++seq}`, 'pace.db');
const NOW = 1_700_000_000_000;

// ══ A. 예약의 성질 ════════════════════════════════════════════

{
  const db = openPace({ dbPath: freshDbPath() });
  const noJitter = { min_interval_ms: 1000, jitter_ms: 0 };

  const r1 = reserve(db, 'example.com', { holder: 'w1', opts: noJitter, nowMs: NOW });
  const r2 = reserve(db, 'example.com', { holder: 'w2', opts: noJitter, nowMs: NOW });
  const r3 = reserve(db, 'example.com', { holder: 'w3', opts: noJitter, nowMs: NOW });

  ok('A1-first-is-now', r1.granted && r1.allowed_at === NOW && r1.wait_ms === 0 && r1.slot_index === 0,
    `allowed_at=${r1.allowed_at - NOW}ms 뒤 · slot ${r1.slot_index}`);
  ok('A2-queue-not-race',
    r2.allowed_at === NOW + 1000 && r3.allowed_at === NOW + 2000 && r2.slot_index === 1 && r3.slot_index === 2,
    `같은 순간에 물어도 ${[r1, r2, r3].map((r) => r.allowed_at - NOW).join('·')}ms 로 갈린다`);
  ok('A3-everyone-granted', [r1, r2, r3].every((r) => r.granted), '아무도 되돌려 보내지 않는다 — 다시 물을 필요가 없다');

  // 다른 도메인은 서로 막지 않는다
  const other = reserve(db, 'other.example', { holder: 'w1', opts: noJitter, nowMs: NOW });
  ok('A4-domains-independent', other.allowed_at === NOW && other.slot_index === 0, `다른 도메인은 ${other.allowed_at - NOW}ms`);

  // 이름 다듬기 — 대소문자·끝점이 달라도 한 줄이다
  const upper = reserve(db, 'EXAMPLE.com.', { holder: 'w4', opts: noJitter, nowMs: NOW });
  ok('A5-domain-normalized', upper.domain === 'example.com' && upper.allowed_at === NOW + 3000,
    `${upper.domain} · ${upper.allowed_at - NOW}ms — 같은 줄을 이어받았다`);

  // jitter 는 범위 안에서만 흔든다
  const jittered = [];
  for (let i = 0; i < 20; i++) jittered.push(reserve(db, 'j.example', { opts: { min_interval_ms: 100, jitter_ms: 50 }, nowMs: NOW }).gap_ms);
  ok('A6-jitter-in-range', jittered.every((g) => g >= 100 && g < 150), `간격 ${Math.min(...jittered)}~${Math.max(...jittered)}ms`);

  // 줄이 너무 길면 자리를 잡지 않는다 — 잡아 두고 안 쓰면 그 자리가 통째로 빈다
  const before = peek(db, 'example.com', { nowMs: NOW }).next_allowed_at;
  const refused = reserve(db, 'example.com', { maxWaitMs: 100, opts: noJitter, nowMs: NOW });
  const after = peek(db, 'example.com', { nowMs: NOW }).next_allowed_at;
  ok('A7-queue-too-long-does-not-consume',
    !refused.granted && refused.reason === 'queue_too_long' && refused.slot_index === null && after === before,
    `${refused.reason} · 다음 허용 시각 그대로(${before === after})`);

  const badDomain = throwsWith('bad_domain', () => reserve(db, 'http://example.com/path', { nowMs: NOW }));
  const badPolicy = throwsWith('bad_policy', () => reserve(db, 'example.com', { opts: { min_interval_ms: 'x' }, nowMs: NOW }));
  ok('A8-input-guards', badDomain.pass && badPolicy.pass, `도메인 ${badDomain.detail} · 정책 ${badPolicy.detail}`);

  // undefined 는 "지정 안 함" 이지 "기본값을 지우라" 가 아니다
  const undef = reserve(db, 'u.example', { opts: { min_interval_ms: undefined, jitter_ms: 0 }, nowMs: NOW });
  const next = reserve(db, 'u.example', { opts: { min_interval_ms: undefined, jitter_ms: 0 }, nowMs: NOW });
  ok('A9-undefined-keeps-default',
    Number.isFinite(next.allowed_at) && next.allowed_at - undef.allowed_at === PACE_DEFAULTS.min_interval_ms,
    `기본 간격 ${next.allowed_at - undef.allowed_at}ms 가 그대로 걸렸다`);

  db.close();
}

// ══ B. 403 하나로 오래 자지 않는다 ════════════════════════════

{
  const db = openPace({ dbPath: freshDbPath() });

  const once = record(db, 'blocked.example', { blocked: true, nowMs: NOW });
  const state = peek(db, 'blocked.example', { nowMs: NOW });
  ok('B1-one-403-no-long-sleep',
    state.sleep_until === null && once.next_allowed_at - NOW <= MAX_AUTO_BACKOFF_MS && once.blocked_count === 1,
    `물러남 ${(once.next_allowed_at - NOW) / 1000}초 · 휴면 없음 · 차단 세기 ${once.blocked_count}`);

  // 계속 실패해도 천장을 넘지 않는다 — opts 로 큰 값을 줘도 자동 경로에서는 잘린다
  let last = null;
  for (let i = 0; i < 12; i++) {
    last = record(db, 'blocked.example', { failed: true, opts: { retry_backoff_ms: 3 * 3600 * 1000 }, nowMs: NOW });
  }
  ok('B2-auto-backoff-capped',
    last.backoff_ms === MAX_AUTO_BACKOFF_MS && last.capped === true && peek(db, 'blocked.example', { nowMs: NOW }).sleep_until === null,
    `열세 번 실패해도 ${last.backoff_ms / 1000}초에서 멈춘다 (천장 ${MAX_AUTO_BACKOFF_MS / 1000}초) · 자동 휴면 없음`);

  const okAgain = record(db, 'blocked.example', { ok: true, nowMs: NOW });
  ok('B3-success-clears-failures', okAgain.consecutive_failures === 0 && okAgain.blocked_count === 1,
    `연속 실패 ${okAgain.consecutive_failures} · 차단 세기는 지우지 않는다 ${okAgain.blocked_count}`);

  db.close();
}

// ══ C. 긴 휴면은 사람이 정할 때만 ═════════════════════════════

{
  const db = openPace({ dbPath: freshDbPath() });

  const noReason = throwsWith('sleep_reason_required', () => sleepDomain(db, 'x.example', { untilMs: NOW + 1000, setBy: 'agent', nowMs: NOW }));
  const noOwner = throwsWith('sleep_owner_required', () => sleepDomain(db, 'x.example', { untilMs: NOW + 1000, reason: '차단', nowMs: NOW }));
  const past = throwsWith('bad_sleep_until', () => sleepDomain(db, 'x.example', { untilMs: NOW - 1, reason: '차단', setBy: 'agent', nowMs: NOW }));
  ok('C1-sleep-needs-reason-and-owner', noReason.pass && noOwner.pass && past.pass,
    `이유 ${noReason.detail} · 정한 이 ${noOwner.detail} · 과거 ${past.detail}`);

  sleepDomain(db, 'x.example', { untilMs: NOW + 3 * 3600 * 1000, reason: '운영자가 차단을 확인함', setBy: 'agent:surface63', nowMs: NOW });
  const asleep = reserve(db, 'x.example', { nowMs: NOW });
  ok('C2-sleeping-refuses',
    !asleep.granted && asleep.reason === 'domain_sleeping' && asleep.wait_ms === 3 * 3600 * 1000,
    `${asleep.reason} · ${asleep.wait_ms / 3600000}시간 남음`);

  const info = peek(db, 'x.example', { nowMs: NOW });
  ok('C3-sleep-records-why', info.sleep_reason === '운영자가 차단을 확인함' && info.sleep_set_by === 'agent:surface63',
    `${info.sleep_set_by} — "${info.sleep_reason}"`);

  wakeDomain(db, 'x.example', { nowMs: NOW });
  const awake = reserve(db, 'x.example', { nowMs: NOW });
  ok('C4-wake-clears', awake.granted && peek(db, 'x.example', { nowMs: NOW }).sleep_until === null, '깨우면 바로 자리를 받는다');

  db.close();
}

// ══ D. 이 장부에는 item·판정이 없다 ═══════════════════════════

{
  const dbPath = freshDbPath();
  const db = openPace({ dbPath });
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
  const columns = tables.flatMap((t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => `${t}.${c.name}`));
  const forbidden = /item|judgment|label|work_state|lease|confidence|artifact|verdict|complete/i;
  const found = columns.filter((c) => forbidden.test(c));
  ok('D1-no-workspace-state-in-pace',
    found.length === 0 && JSON.stringify(tables) === '["pace_domain","pace_meta","pace_reservation"]',
    `표 ${tables.join('·')} · 금지 낱말이 든 칸 ${found.length}개`);
  ok('D2-columns-are-timing-only',
    columns.filter((c) => c.startsWith('pace_domain.')).join(',')
    === 'pace_domain.domain,pace_domain.next_allowed_at,pace_domain.last_reserved_at,pace_domain.slot_seq,'
      + 'pace_domain.consecutive_failures,pace_domain.last_backoff_ms,pace_domain.blocked_count,'
      + 'pace_domain.sleep_until,pace_domain.sleep_reason,pace_domain.sleep_set_by,pace_domain.updated_at',
    `pace_domain 칸 ${columns.filter((c) => c.startsWith('pace_domain.')).length}개 — 시각과 세기뿐`);
  db.close();
}

// ══ E. 프로세스가 바뀌어도 이어진다 ═══════════════════════════

{
  const dbPath = freshDbPath();
  const first = openPace({ dbPath });
  reserve(first, 'keep.example', { holder: 'before', opts: { min_interval_ms: 5000, jitter_ms: 0 }, nowMs: NOW });
  const savedNext = peek(first, 'keep.example', { nowMs: NOW }).next_allowed_at;
  first.close();

  const second = openPace({ dbPath });
  const after = reserve(second, 'keep.example', { holder: 'after', opts: { min_interval_ms: 5000, jitter_ms: 0 }, nowMs: NOW });
  ok('E1-survives-reopen',
    after.slot_index === 1 && after.allowed_at === savedNext,
    `닫았다 열어도 slot ${after.slot_index} · 이전 예약을 이어받았다`);
  second.close();
}

// ══ F. 하나뿐인 문 — withPace ═════════════════════════════════

{
  const db = openPace({ dbPath: freshDbPath() });
  const waited = [];
  const waiter = async (ms) => { waited.push(ms); };   // 진짜로 기다리지 않고 얼마를 기다릴지만 받는다

  const opts = { min_interval_ms: 400, jitter_ms: 0 };
  const r1 = await withPace(db, 'gate.example', async () => 'first', { holder: 'a', opts, nowMs: NOW, waiter });
  const r2 = await withPace(db, 'gate.example', async () => ({ failed: true }), { holder: 'b', opts, nowMs: NOW, waiter });

  ok('F1-waits-for-its-turn', waited[0] === 0 && waited[1] === 400,
    `첫째는 ${waited[0]}ms · 둘째는 ${waited[1]}ms 기다린다`);
  ok('F2-runs-and-returns', r1.granted && r1.value === 'first' && r2.granted, `${r1.value} · 둘째도 통과`);
  ok('F3-failure-recorded', peek(db, 'gate.example').consecutive_failures === 1,
    `연속 실패 ${peek(db, 'gate.example').consecutive_failures}`);

  // 안에서 터져도 결과가 남는다
  let threw = false;
  try { await withPace(db, 'gate.example', async () => { throw new Error('연결 끊김'); }, { holder: 'c', opts, nowMs: NOW, waiter }); }
  catch { threw = true; }
  ok('F4-throw-still-records', threw && peek(db, 'gate.example').consecutive_failures === 2,
    `예외가 나가도 연속 실패 ${peek(db, 'gate.example').consecutive_failures} 로 남는다`);

  const refused = await withPace(db, 'gate.example', async () => 'never', { maxWaitMs: 1, opts, nowMs: NOW, waiter });
  ok('F5-not-granted-does-not-run', !refused.granted && refused.value === null && refused.reason === 'queue_too_long',
    `${refused.reason} — 안쪽 일은 아예 돌지 않았다`);

  db.close();
}

// ══ G. 프로세스 스무 개 ═══════════════════════════════════════

const WORKERS = 20;
const PER_WORKER = 3;
const INTERVAL = 25;

async function runFleet(dbPath, { unsafe = false } = {}) {
  const startAt = Date.now() + 900;
  const kids = [];
  for (let i = 0; i < WORKERS; i++) {
    // workspace 가 다르다는 것을 cwd 로 흉내 낸다 — 서로 다른 자리에서 온 프로세스들이다.
    const cwd = path.join(SANDBOX, `holder-${i}`);
    fs.mkdirSync(cwd, { recursive: true });
    const args = [WORKER, '--db', dbPath, '--tag', `w${i}`, '--domain', 'shared.example',
      '--reservations', String(PER_WORKER), '--interval', String(INTERVAL), '--start-at', String(startAt)];
    if (unsafe) args.push('--unsafe');
    kids.push(new Promise((resolve) => {
      const c = spawn(process.execPath, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      c.stdout.on('data', (d) => { out += d; });
      c.stderr.on('data', (d) => { err += d; });
      c.on('exit', (code) => {
        let parsed = null;
        try { parsed = JSON.parse(out.trim().split('\n').filter(Boolean).pop()); } catch { /* 말없이 죽은 경우 */ }
        resolve({ code, parsed, stderr: err.slice(0, 200) });
      });
    }));
  }
  return Promise.all(kids);
}

{
  const dbPath = freshDbPath();
  openPace({ dbPath }).close();   // 스키마를 먼저 세워 둔다
  const fleet = await runFleet(dbPath);

  const silent = fleet.filter((f) => !f.parsed);
  const errored = fleet.flatMap((f) => f.parsed?.errors ?? []);
  const granted = fleet.reduce((n, f) => n + (f.parsed?.granted ?? 0), 0);

  ok('G1-all-workers-reported', silent.length === 0 && fleet.length === WORKERS,
    `${WORKERS - silent.length}/${WORKERS} 일꾼이 결과를 냈다${silent.length ? ` · 말없이 죽음: ${silent.map((s) => s.stderr).join(' / ')}` : ''}`);
  ok('G2-all-granted', granted === WORKERS * PER_WORKER && errored.length === 0,
    `예약 ${granted}/${WORKERS * PER_WORKER} · 오류 ${errored.length}건`);

  const db = openPace({ dbPath });
  const rows = reservationsOf(db, 'shared.example', 1000);

  const slots = rows.map((r) => r.slot_index);
  const unique = new Set(slots);
  const expected = [...Array(WORKERS * PER_WORKER).keys()];
  ok('G3-no-duplicate-slots',
    unique.size === slots.length && JSON.stringify([...unique].sort((a, b) => a - b)) === JSON.stringify(expected),
    `자리 ${slots.length}개 · 서로 다른 자리 ${unique.size}개 · 0부터 ${WORKERS * PER_WORKER - 1}까지 빠짐없이`);

  // ── 완료 조건 ──
  const times = rows.map((r) => r.allowed_at);
  const gaps = times.slice(1).map((t, i) => t - times[i]);
  const tooClose = gaps.filter((g) => g < INTERVAL);
  ok('G4-interval-never-shorter',
    tooClose.length === 0 && gaps.length === WORKERS * PER_WORKER - 1,
    `이웃한 자리 ${gaps.length}쌍 · 정책 ${INTERVAL}ms 보다 가까운 쌍 ${tooClose.length}개 · 실제 최소 ${Math.min(...gaps)}ms`);

  const holders = new Set(rows.map((r) => r.holder));
  const interleaved = rows.slice(1).filter((r, i) => r.holder !== rows[i].holder).length;
  ok('G5-across-holders',
    holders.size === WORKERS,
    `서로 다른 주인 ${holders.size}명이 한 줄을 나눠 섰다 · 주인이 바뀐 지점 ${interleaved}곳`);

  ok('G6-span-matches-policy',
    times[times.length - 1] - times[0] >= INTERVAL * (WORKERS * PER_WORKER - 1),
    `첫 자리부터 마지막 자리까지 ${times[times.length - 1] - times[0]}ms (최소 ${INTERVAL * (WORKERS * PER_WORKER - 1)}ms)`);

  db.close();
}

// ══ H. 음성 대조 — 예약 없이 하면 무너진다 ════════════════════

{
  const dbPath = freshDbPath();
  openPace({ dbPath }).close();
  const fleet = await runFleet(dbPath, { unsafe: true });
  const db = openPace({ dbPath });
  const rows = reservationsOf(db, 'shared.example', 1000);
  const slots = rows.map((r) => r.slot_index);
  const dupes = slots.length - new Set(slots).size;
  const times = [...rows].map((r) => r.allowed_at).sort((a, b) => a - b);
  const tooClose = times.slice(1).filter((t, i) => t - times[i] < INTERVAL).length;

  ok('H1-unsafe-breaks-it', dupes > 0 || tooClose > 0,
    `transaction 없이 하면 같은 자리 ${dupes}번 겹치고 정책보다 가까운 쌍 ${tooClose}개가 생긴다`
    + ' — 시험이 이 실패를 실제로 볼 수 있다는 뜻이다');
  ok('H2-fleet-ran', fleet.filter((f) => f.parsed).length === WORKERS, `대조 일꾼 ${fleet.filter((f) => f.parsed).length}/${WORKERS}`);
  db.close();
}

// ══ I. 이력이 무한정 자라지 않는다 ════════════════════════════

{
  const db = openPace({ dbPath: freshDbPath() });
  for (let i = 0; i < 450; i++) reserve(db, 'many.example', { opts: { min_interval_ms: 1, jitter_ms: 0 }, nowMs: NOW });
  const kept = db.prepare('SELECT COUNT(*) AS n FROM pace_reservation WHERE domain = ?').get('many.example').n;
  const seqNow = peek(db, 'many.example', { nowMs: NOW }).slot_seq;
  ok('I1-history-bounded', kept <= 250 && seqNow === 450,
    `예약 450번 뒤 남은 이력 ${kept}줄 · 자리 번호는 ${seqNow} 로 계속 는다`);
  db.close();
}

// ══ J. 자리와 마무리 ══════════════════════════════════════════

{
  ok('J1-global-path', defaultPacePath().endsWith(path.join('web-search', 'runtime', 'pace.db')),
    defaultPacePath().replace(os.homedir(), '~'));

  // 이 시험은 전역 장부를 건드리지 않았다
  const globalDb = defaultPacePath();
  const touched = fs.existsSync(globalDb) ? fs.statSync(globalDb).mtimeMs : null;
  ok('J2-global-db-untouched', touched === null || Date.now() - touched > 5000,
    touched === null ? '전역 장부는 아직 없다' : `전역 장부 마지막 변경 ${Math.round((Date.now() - touched) / 1000)}초 전`);

  ok('J3-no-network', networkAttempts === 0, `네트워크 시도 ${networkAttempts}회`);
}

// ── 판정 ──────────────────────────────────────────────────────

const failed = results.filter((r) => !r.pass);
if (AS_JSON) {
  process.stdout.write(`${JSON.stringify({ pass: failed.length === 0, total: results.length, failed: failed.length, results }, null, 2)}\n`);
} else {
  for (const r of results) process.stdout.write(`${r.pass ? 'PASS' : 'FAIL'}  ${r.id}\n        ${r.detail}\n`);
  process.stdout.write(`\n${failed.length === 0 ? 'PASS' : 'FAIL'} — ${results.length - failed.length}/${results.length}\n`);
}
process.exit(failed.length === 0 ? 0 : 1);
