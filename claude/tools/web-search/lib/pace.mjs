// 도메인 속도 — 도구 전역에 하나뿐인 장부.
//
// 계획서 8절. workspace 는 여럿이어도 상대 서버는 하나다. 그래서 이 장부만 workspace 밖,
// 도구 옆에 둔다: ~/.claude/tools/web-search/runtime/pace.db
//
// [핵심] 확인이 아니라 예약이다.
// "마지막 접속 시각을 보고 비었으면 나간다" 는 두 프로세스가 같은 틈을 보고 함께 나간다.
// 여기서는 transaction 안에서 **다음 허용 시각을 먼저 밀어 놓고** 자기 차례를 받아 나온다.
// 부른 쪽은 받은 시각까지 기다렸다가 나가면 된다 — 다시 물어볼 필요도, 경쟁할 필요도 없다.
// (#5 spike 가 20개 프로세스로 실측했다. 예약 없이 읽고 쓰면 같은 자리를 두 번 내준다.)
//
// [책임은 하나] 도메인별 다음 허용 시각. 그것뿐이다.
// item 상태도, 판정도, workspace 이야기도 이 DB 에 넣지 않는다 — 시험이 스키마를 직접 확인한다.
//
// [자동으로 오래 재우지 않는다] 403 한 번에 몇 시간 쉬면 조사가 통째로 멈추는데, 정작 왜 멈췄는지는
// 아무도 모른다. 자동 물러남에는 천장(MAX_AUTO_BACKOFF_MS)이 있고, 그보다 긴 휴면은
// 에이전트가 sleepDomain 으로 직접 정할 때만 생긴다.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { applyPragmas, assertRuntimeSupported, tx } from './db.mjs';

export class PaceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PaceError';
    this.code = code;
  }
}
const fail = (code, message) => { throw new PaceError(code, message); };

export const PACE_SCHEMA_VERSION = 1;

/** 기본 정책. 넉넉하게 잡는다 — 빨리 끝내는 것보다 상대 서버에 폐를 안 끼치는 쪽이 먼저다. */
export const PACE_DEFAULTS = Object.freeze({
  min_interval_ms: 10_000,
  jitter_ms: 5_000,
  retry_backoff_ms: 60_000,
});

/**
 * 자동으로 물러날 수 있는 최대치. 5분.
 * opts 로 이보다 큰 값을 넘겨도 자동 경로에서는 여기서 잘린다 — 긴 휴면은 사람이 정하는 일이다.
 */
export const MAX_AUTO_BACKOFF_MS = 5 * 60_000;

/** 한 도메인의 예약 이력을 이만큼만 남긴다. 장부가 끝없이 자라지 않게. */
const RESERVATION_KEEP = 200;

const DDL = `
CREATE TABLE IF NOT EXISTS pace_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 도메인 하나에 한 줄. 여기에 item·판정·workspace 상태를 두지 않는다(계획서 8).
CREATE TABLE IF NOT EXISTS pace_domain (
  domain               TEXT PRIMARY KEY,
  next_allowed_at      INTEGER NOT NULL,
  last_reserved_at     INTEGER,
  slot_seq             INTEGER NOT NULL DEFAULT 0,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_backoff_ms      INTEGER,
  -- 차단 낌새는 세기만 한다. 이 수를 보고 스스로 재우지 않는다.
  blocked_count        INTEGER NOT NULL DEFAULT 0,
  -- 여기 값이 들어오는 길은 sleepDomain 하나뿐이다. 자동 경로는 절대 이 칸을 쓰지 않는다.
  sleep_until          INTEGER,
  sleep_reason         TEXT,
  sleep_set_by         TEXT,
  updated_at           INTEGER NOT NULL
);

-- 누가 언제 어느 자리를 받아 갔는지. 간격이 실제로 지켜졌는지 뒤에서 대조하려면 이게 있어야 한다.
CREATE TABLE IF NOT EXISTS pace_reservation (
  reservation_id INTEGER PRIMARY KEY,
  domain         TEXT NOT NULL,
  slot_index     INTEGER NOT NULL,
  allowed_at     INTEGER NOT NULL,
  gap_ms         INTEGER NOT NULL,
  holder         TEXT,
  reserved_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS pace_reservation_by_domain ON pace_reservation (domain, reservation_id);
`;

// ── 자리와 열기 ───────────────────────────────────────────────

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 이 도구의 전역 pace 장부. 어느 프로세스에서 불러도 같은 파일을 가리킨다. */
export const defaultPacePath = () => path.resolve(HERE, '..', 'runtime', 'pace.db');

/**
 * 장부를 연다. 없으면 만든다 — 전역 장부라 "누가 먼저 만들었나" 를 따질 자리가 아니다.
 * @param {{dbPath?: string}} [opts] 시험은 여기에 임시 경로를 준다. 환경변수는 보지 않는다.
 */
export function openPace({ dbPath = defaultPacePath() } = {}) {
  assertRuntimeSupported();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  // 외래키를 쓰지 않는 장부다. 표 둘 사이에 참조가 없다 — 도메인 줄이 지워져도 이력은 남아야 한다.
  const db = applyPragmas(new DatabaseSync(dbPath), { foreignKeys: false });
  try {
    tx(db, (d) => {
      d.exec(DDL);
      d.prepare('INSERT OR IGNORE INTO pace_meta (key, value) VALUES (?, ?)')
        .run('schema_version', String(PACE_SCHEMA_VERSION));
    });
  } catch (e) {
    db.close();
    throw e;
  }
  const version = Number(db.prepare("SELECT value FROM pace_meta WHERE key = 'schema_version'").get()?.value);
  if (version !== PACE_SCHEMA_VERSION) {
    db.close();
    fail('pace_schema_mismatch', `pace.db 스키마가 다릅니다 (DB ${version} ≠ 코드 ${PACE_SCHEMA_VERSION})`);
  }
  return db;
}

// ── 값 다듬기 ─────────────────────────────────────────────────

/** 도메인 이름을 한 모양으로. 대소문자·끝점 차이로 두 줄이 생기면 간격이 반으로 준다. */
export function normalizeDomain(domain) {
  if (typeof domain !== 'string') fail('bad_domain', '도메인은 문자열이어야 합니다');
  const d = domain.trim().toLowerCase().replace(/\.$/, '');
  if (!d) fail('bad_domain', '도메인이 비었습니다');
  if (d.length > 253) fail('bad_domain', '도메인이 너무 깁니다');
  if (/[/\\?#\s]/.test(d)) fail('bad_domain', `도메인에 경로나 공백을 넣을 수 없습니다: ${d.slice(0, 60)}`);
  return d;
}

// 넘어온 값 중 undefined 는 "지정 안 함" 이지 "undefined 로 덮으라" 가 아니다.
// (선택 인자를 그대로 넘기면 {min_interval_ms: undefined} 가 되어 기본값을 지운다. 그러면 간격이
//  NaN 이 되어 아예 안 걸린다 — 1차에서 실제로 났던 사고다.)
function withDefaults(opts) {
  const out = { ...PACE_DEFAULTS };
  for (const [k, v] of Object.entries(opts || {})) if (v !== undefined) out[k] = v;
  for (const k of ['min_interval_ms', 'jitter_ms', 'retry_backoff_ms']) {
    const v = Number(out[k]);
    if (!Number.isFinite(v) || v < 0) fail('bad_policy', `${k} 가 수가 아닙니다: ${out[k]}`);
    out[k] = v;
  }
  return out;
}

const emptyRow = (domain) => ({
  domain, next_allowed_at: 0, last_reserved_at: null, slot_seq: 0,
  consecutive_failures: 0, last_backoff_ms: null, blocked_count: 0,
  sleep_until: null, sleep_reason: null, sleep_set_by: null, updated_at: 0,
});

const readRow = (db, domain) =>
  db.prepare('SELECT * FROM pace_domain WHERE domain = ?').get(domain) ?? emptyRow(domain);

// ── 예약 ──────────────────────────────────────────────────────

/**
 * 이 도메인에 나갈 자리를 하나 받는다. **네트워크로 나가기 전에** 부른다.
 *
 * 받은 allowed_at 까지 기다렸다가 나가면 된다. 다시 물어볼 필요가 없다 —
 * 그 자리는 이미 내 것으로 잡혀 있고, 다른 프로세스는 그 뒤 자리를 받는다.
 *
 * @param {{holder?:string, maxWaitMs?:number, opts?:object, nowMs?:number, random?:()=>number}} o
 * @returns {{granted:boolean, domain:string, allowed_at:number|null, wait_ms:number,
 *            slot_index:number|null, gap_ms:number|null, reason:string|null}}
 */
export function reserve(db, domain, {
  holder = null, maxWaitMs = null, opts = {}, nowMs = Date.now(), random = Math.random,
} = {}) {
  const d = normalizeDomain(domain);
  const cfg = withDefaults(opts);
  const who = holder === null || holder === undefined ? null : String(holder).slice(0, 64);

  return tx(db, (tdb) => {
    const row = readRow(tdb, d);

    // 에이전트가 직접 걸어 둔 휴면. 자동으로는 이 칸에 값이 들어오지 않는다.
    if (row.sleep_until !== null && row.sleep_until > nowMs) {
      return {
        granted: false, domain: d, allowed_at: null, wait_ms: row.sleep_until - nowMs,
        slot_index: null, gap_ms: null, reason: 'domain_sleeping',
      };
    }

    const allowedAt = Math.max(nowMs, row.next_allowed_at);
    const waitMs = allowedAt - nowMs;

    // 줄이 너무 길면 자리를 잡지 않고 돌아간다. 잡아 두고 안 쓰면 그 자리가 통째로 빈다.
    if (maxWaitMs !== null && waitMs > maxWaitMs) {
      return {
        granted: false, domain: d, allowed_at: null, wait_ms: waitMs,
        slot_index: null, gap_ms: null, reason: 'queue_too_long',
      };
    }

    // 간격을 일정하게 두지 않는다. 규칙적인 두드림이 오히려 눈에 띈다.
    const gap = cfg.min_interval_ms + Math.floor(random() * cfg.jitter_ms);
    const slot = row.slot_seq;

    tdb.prepare(`
      INSERT INTO pace_domain (domain, next_allowed_at, last_reserved_at, slot_seq, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(domain) DO UPDATE SET
        next_allowed_at = excluded.next_allowed_at,
        last_reserved_at = excluded.last_reserved_at,
        slot_seq = excluded.slot_seq,
        updated_at = excluded.updated_at`)
      .run(d, allowedAt + gap, nowMs, slot + 1, nowMs);

    tdb.prepare(`
      INSERT INTO pace_reservation (domain, slot_index, allowed_at, gap_ms, holder, reserved_at)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run(d, slot, allowedAt, gap, who, nowMs);

    // 가끔 옛 이력을 걷어낸다. 200 자리마다 한 번이라 실행마다 달라지지 않는다.
    if (slot > 0 && slot % RESERVATION_KEEP === 0) {
      tdb.prepare(`
        DELETE FROM pace_reservation
         WHERE domain = ? AND reservation_id NOT IN (
           SELECT reservation_id FROM pace_reservation WHERE domain = ? ORDER BY reservation_id DESC LIMIT ?
         )`).run(d, d, RESERVATION_KEEP);
    }

    return { granted: true, domain: d, allowed_at: allowedAt, wait_ms: waitMs, slot_index: slot, gap_ms: gap, reason: null };
  });
}

// ── 결과 알리기 ───────────────────────────────────────────────

/**
 * 나갔다 온 결과를 알린다. 성공이면 물러남을 푼다.
 *
 * blocked 는 **세기만 한다.** 403 하나로 몇 시간 재우면 조사가 통째로 멈추는데 왜 멈췄는지는
 * 아무도 모른다. 실패에는 물러남을 주되 MAX_AUTO_BACKOFF_MS 에서 자른다.
 */
export function record(db, domain, { ok = false, failed = false, blocked = false, opts = {}, nowMs = Date.now() } = {}) {
  const d = normalizeDomain(domain);
  const cfg = withDefaults(opts);

  return tx(db, (tdb) => {
    const row = readRow(tdb, d);
    let { consecutive_failures: fails, blocked_count: blockedCount, next_allowed_at: next } = row;
    let backoff = null;

    if (blocked) blockedCount += 1;
    if (failed || blocked) {
      fails += 1;
      // 두 배씩 물러나되 천장에서 자른다. opts 로 더 큰 값을 줘도 자동 경로에서는 안 넘어간다.
      const raw = cfg.retry_backoff_ms * (2 ** (fails - 1));
      backoff = Math.min(raw, MAX_AUTO_BACKOFF_MS);
      next = Math.max(next, nowMs + backoff);
    } else if (ok) {
      fails = 0;
    }

    tdb.prepare(`
      INSERT INTO pace_domain (domain, next_allowed_at, consecutive_failures, last_backoff_ms, blocked_count, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(domain) DO UPDATE SET
        next_allowed_at = excluded.next_allowed_at,
        consecutive_failures = excluded.consecutive_failures,
        last_backoff_ms = excluded.last_backoff_ms,
        blocked_count = excluded.blocked_count,
        updated_at = excluded.updated_at`)
      .run(d, next, fails, backoff, blockedCount, nowMs);

    return {
      domain: d, next_allowed_at: next, consecutive_failures: fails,
      blocked_count: blockedCount, backoff_ms: backoff, capped: backoff === MAX_AUTO_BACKOFF_MS,
    };
  });
}

// ── 명시적 휴면 ───────────────────────────────────────────────

/**
 * 이 도메인을 정해진 시각까지 쉬게 한다. **에이전트가 정할 때만** 부른다.
 * 왜 재우는지와 누가 정했는지를 함께 적는다 — 이유 없는 휴면은 나중에 아무도 풀지 못한다.
 */
export function sleepDomain(db, domain, { untilMs, reason, setBy, nowMs = Date.now() }) {
  const d = normalizeDomain(domain);
  if (!Number.isFinite(untilMs) || untilMs <= nowMs) fail('bad_sleep_until', '휴면 끝 시각이 지금보다 뒤여야 합니다');
  if (!reason || String(reason).trim() === '') fail('sleep_reason_required', '왜 재우는지 적어야 합니다');
  if (!setBy || String(setBy).trim() === '') fail('sleep_owner_required', '누가 정했는지 적어야 합니다');

  return tx(db, (tdb) => {
    tdb.prepare(`
      INSERT INTO pace_domain (domain, next_allowed_at, sleep_until, sleep_reason, sleep_set_by, updated_at)
      VALUES (?, COALESCE((SELECT next_allowed_at FROM pace_domain WHERE domain = ?), 0), ?, ?, ?, ?)
      ON CONFLICT(domain) DO UPDATE SET
        sleep_until = excluded.sleep_until,
        sleep_reason = excluded.sleep_reason,
        sleep_set_by = excluded.sleep_set_by,
        updated_at = excluded.updated_at`)
      .run(d, d, Math.floor(untilMs), String(reason).slice(0, 200), String(setBy).slice(0, 64), nowMs);
    return { domain: d, sleep_until: Math.floor(untilMs), reason: String(reason).slice(0, 200) };
  });
}

/** 휴면을 푼다. 재운 것과 마찬가지로 사람이 정하는 일이다. */
export function wakeDomain(db, domain, { nowMs = Date.now() } = {}) {
  const d = normalizeDomain(domain);
  return tx(db, (tdb) => {
    tdb.prepare(`
      UPDATE pace_domain SET sleep_until = NULL, sleep_reason = NULL, sleep_set_by = NULL, updated_at = ?
       WHERE domain = ?`).run(nowMs, d);
    return { domain: d, sleep_until: null };
  });
}

// ── 읽기 ──────────────────────────────────────────────────────

/** 상태를 바꾸지 않고 들여다본다. */
export function peek(db, domain, { nowMs = Date.now() } = {}) {
  const d = normalizeDomain(domain);
  const row = readRow(db, d);
  const until = Math.max(row.next_allowed_at, row.sleep_until ?? 0);
  return { ...row, domain: d, waiting_ms: Math.max(0, until - nowMs) };
}

/** 이 도메인의 최근 예약들. 간격이 실제로 지켜졌는지 대조할 때 쓴다. */
export const reservationsOf = (db, domain, limit = RESERVATION_KEEP) =>
  db.prepare('SELECT slot_index, allowed_at, gap_ms, holder, reserved_at FROM pace_reservation WHERE domain = ? ORDER BY slot_index LIMIT ?')
    .all(normalizeDomain(domain), limit);

// ── 하나뿐인 문 ───────────────────────────────────────────────

const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

/**
 * 예약하고 · 자기 차례까지 기다리고 · 나갔다 와서 · 결과를 알린다.
 *
 * collect·map·search 는 모두 이 함수로 나간다. 나가는 길이 하나여야 "예약을 빠뜨렸다" 가
 * 생기지 않는다. 안 쓰고 직접 fetch 하면 그 자리는 장부에 없는 요청이 된다.
 *
 * @param {(slot:{allowed_at:number, slot_index:number}) => Promise<{blocked?:boolean, failed?:boolean}|any>} fn
 */
export async function withPace(db, domain, fn, {
  holder = null, maxWaitMs = null, opts = {}, nowMs = Date.now(), random = Math.random, waiter = sleep,
} = {}) {
  const slot = reserve(db, domain, { holder, maxWaitMs, opts, nowMs, random });
  if (!slot.granted) return { granted: false, reason: slot.reason, wait_ms: slot.wait_ms, value: null };

  await waiter(slot.wait_ms);

  try {
    const value = await fn(slot);
    const blocked = value?.blocked === true;
    const failed = value?.failed === true;
    record(db, domain, { ok: !blocked && !failed, blocked, failed, opts, nowMs: Date.now() });
    return { granted: true, reason: null, wait_ms: slot.wait_ms, slot_index: slot.slot_index, value };
  } catch (e) {
    record(db, domain, { failed: true, opts, nowMs: Date.now() });
    throw e;
  }
}
