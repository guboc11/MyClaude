// 임대 — 여러 워커가 같은 항목을 동시에 잡지 않게 한다.
//
// 계획서 4-5·6-3. 고르는 일과 표시하는 일이 갈라지면 그 틈에 다른 워커가 같은 것을 가져간다.
// 그래서 회수·선택·전환을 한 transaction 안에서 끝낸다.
//
// 시각은 언제나 인자로 받는다. 시험이 시스템 시계를 만지지 않고 경계 시각을 다룰 수 있어야 한다.

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { tx } from './db.mjs';
import { resolveInside } from './paths.mjs';

export const DEFAULT_COUNT = 20;
export const MAX_COUNT = 100;
export const DEFAULT_LEASE_MINUTES = 60;
export const MAX_LEASE_MINUTES = 24 * 60;

export class LeaseError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LeaseError';
    this.code = code;
  }
}
const fail = (code, message) => { throw new LeaseError(code, message); };

/** 예측할 수 없는 임대 번호. 순번을 쓰면 남의 임대를 짐작해 부를 수 있다. */
export const newLeaseId = () => `L-${randomBytes(16).toString('hex')}`;

/**
 * 만료된 임대를 대기로 되돌린다. 만료되지 않은 것은 건드리지 않는다.
 * @returns 회수한 건수
 */
export function reclaimExpired(db, nowMs = Date.now()) {
  const r = db.prepare(`
    UPDATE items
       SET work_state = 'queued', lease_id = NULL, leased_by = NULL, lease_expires_at = NULL, updated_at = ?
     WHERE work_state = 'leased' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?`).run(nowMs, nowMs);
  return Number(r.changes);
}

/**
 * 대기 중인 항목을 한 워커에게 빌려준다.
 *
 * @returns {{lease_id, expires_at, work_file, leased, items}}
 */
export function nextBatch(db, root, {
  workerId, count = DEFAULT_COUNT, leaseMinutes = DEFAULT_LEASE_MINUTES, nowMs = Date.now(),
} = {}) {
  if (typeof workerId !== 'string' || !workerId.trim()) fail('worker_id', 'worker_id 가 비었습니다');
  if (!Number.isInteger(count) || count < 1) fail('count', 'count 는 1 이상의 정수여야 합니다');
  if (count > MAX_COUNT) fail('count_max', `count 는 ${MAX_COUNT} 이하여야 합니다 (받은 ${count})`);
  if (!Number.isInteger(leaseMinutes) || leaseMinutes < 1) fail('lease_minutes', 'lease_minutes 는 1 이상의 정수여야 합니다');
  if (leaseMinutes > MAX_LEASE_MINUTES) fail('lease_minutes_max', `lease_minutes 는 ${MAX_LEASE_MINUTES} 이하여야 합니다`);

  const leaseId = newLeaseId();
  const expiresAt = nowMs + (leaseMinutes * 60_000);

  const picked = tx(db, (d) => {
    // 먼저 회수한다. 죽은 워커가 붙들고 있던 것을 남겨 두면 큐가 마르지 않은 채로 멈춘다.
    reclaimExpired(d, nowMs);
    const rows = d.prepare(`
      SELECT item_id, canonical_url FROM items
       WHERE work_state = 'queued' ORDER BY item_id LIMIT ?`).all(count);
    if (rows.length === 0) return [];
    const mark = d.prepare(`
      UPDATE items
         SET work_state = 'leased', lease_id = ?, leased_by = ?, lease_expires_at = ?, updated_at = ?
       WHERE item_id = ? AND work_state = 'queued'`);
    for (const r of rows) {
      const changed = Number(mark.run(leaseId, workerId, expiresAt, nowMs, r.item_id).changes);
      // 같은 transaction 안이라 여기서 0이 나올 수 없다. 나온다면 가정이 깨진 것이라 세워 둔다.
      if (changed !== 1) fail('lease_race', `임대 표시가 어긋났습니다 (item ${r.item_id})`);
    }
    return rows;
  });

  // 작업 목록은 파일로 준다. 응답에 URL 을 다 실으면 100건에서 이미 4KB 를 넘는다.
  const dir = resolveInside(root, 'artifacts', 'leases');
  fs.mkdirSync(dir, { recursive: true });
  const workFile = path.join(dir, `${leaseId}.jsonl`);
  fs.writeFileSync(workFile, picked.map((r) => JSON.stringify({ item_id: r.item_id, url: r.canonical_url })).join('\n') + (picked.length ? '\n' : ''));

  return {
    lease_id: leaseId,
    expires_at: expiresAt,
    work_file: path.relative(root, workFile),
    leased: picked.length,
    items: picked,
  };
}

/**
 * 이 임대가 지금도 유효한지 본다. **아무것도 바꾸기 전에** 부른다.
 *
 * 옛 임대로 온 요청을 여기서 세운다 — 회수돼 남에게 다시 빌려준 항목을 늦게 온 결과가 덮으면
 * 그 워커가 본 적도 없는 자료가 장부에 박힌다.
 */
export function assertLeaseCurrent(db, { leaseId, workerId, nowMs = Date.now() }) {
  if (typeof leaseId !== 'string' || !leaseId) fail('lease_id', 'lease_id 가 비었습니다');
  const rows = db.prepare(`
    SELECT item_id, canonical_url, leased_by, lease_expires_at, collected_at
      FROM items WHERE lease_id = ? ORDER BY item_id`).all(leaseId);
  if (rows.length === 0) fail('stale_lease', '이 lease_id 로 잡힌 항목이 없습니다. 만료돼 회수됐거나 이미 반납됐습니다.');
  if (workerId !== undefined && rows.some((r) => r.leased_by !== workerId)) {
    fail('worker_mismatch', '이 임대를 잡은 워커가 아닙니다');
  }
  const expired = rows.filter((r) => r.lease_expires_at !== null && r.lease_expires_at <= nowMs);
  if (expired.length) fail('lease_expired', `임대가 만료됐습니다 (만료된 항목 ${expired.length}건)`);
  return rows;
}

/** 만료가 지났지만 아직 회수되지 않은 것과, 곧 만료될 것을 나눠 센다. */
export function leaseHealth(db, { nowMs = Date.now(), soonMs = 5 * 60_000 } = {}) {
  const expired = db.prepare(
    "SELECT COUNT(*) AS n FROM items WHERE work_state = 'leased' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?").get(nowMs).n;
  const soon = db.prepare(
    "SELECT COUNT(*) AS n FROM items WHERE work_state = 'leased' AND lease_expires_at > ? AND lease_expires_at <= ?").get(nowMs, nowMs + soonMs).n;
  const active = db.prepare(
    'SELECT COUNT(DISTINCT lease_id) AS n FROM items WHERE lease_id IS NOT NULL').get().n;
  return { expired, expiring_soon: soon, active_leases: active };
}

/** 활성 임대끼리 같은 항목을 잡고 있는지. 0이어야 한다. */
export function overlappingItems(db) {
  return db.prepare(`
    SELECT item_id, COUNT(DISTINCT lease_id) AS leases
      FROM items WHERE lease_id IS NOT NULL
     GROUP BY item_id HAVING leases > 1`).all();
}
