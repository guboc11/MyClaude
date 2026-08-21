// retry — 고른 항목만 다시 대기로. 증거는 그대로 둔다.
//
// 계획서 4-9. 지우지 않는 것이 이 버튼의 요점이다. attempts·artifacts·judgments 를 건드리면
// "왜 그렇게 판정했는가" 를 나중에 되짚을 수 없다. 다음 collect 는 새 attempt_id 를 쓴다.

import { tx } from './db.mjs';

export class RetryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RetryError';
    this.code = code;
  }
}
const fail = (code, message) => { throw new RetryError(code, message); };

/** 다시 대기로 돌릴 수 있는 상태. 임대 중이거나 이미 대기인 것은 대상이 아니다. */
const RETRYABLE = new Set(['failed', 'done']);

/**
 * @returns {{requeued, rejected, reject_reasons}}
 */
export function retryItems(db, { itemIds, reason, nowMs = Date.now() }) {
  if (!Array.isArray(itemIds) || itemIds.length === 0) fail('item_ids', 'item_ids 가 비었습니다');
  if (typeof reason !== 'string' || !reason.trim()) fail('reason', 'reason 이 비었습니다 — 왜 다시 하는지 남겨야 합니다');

  return tx(db, (d) => {
    const find = d.prepare('SELECT item_id, work_state, leased_by FROM items WHERE item_id = ?');
    const requeue = d.prepare(`
      UPDATE items
         SET work_state = 'queued', lease_id = NULL, leased_by = NULL, lease_expires_at = NULL,
             collected_at = NULL, updated_at = ?
       WHERE item_id = ? AND work_state = ?`);
    const note = d.prepare('INSERT INTO retries (item_id, from_state, reason, created_at) VALUES (?,?,?,?)');

    let requeued = 0;
    const rejects = [];
    for (const raw of itemIds) {
      const id = Number(raw);
      if (!Number.isInteger(id)) { rejects.push({ item_id: raw, reason: 'not_an_item_id' }); continue; }
      const row = find.get(id);
      // 이 workspace 에 없는 번호는 다른 장부의 것이거나 지어낸 것이다. 둘 다 받지 않는다.
      if (!row) { rejects.push({ item_id: raw, reason: 'not_in_this_workspace' }); continue; }
      if (row.work_state === 'leased') { rejects.push({ item_id: raw, reason: 'leased_by_another_worker' }); continue; }
      if (!RETRYABLE.has(row.work_state)) { rejects.push({ item_id: raw, reason: `not_retryable_${row.work_state}` }); continue; }

      const changed = Number(requeue.run(nowMs, id, row.work_state).changes);
      if (changed !== 1) { rejects.push({ item_id: raw, reason: 'state_changed_mid_retry' }); continue; }
      note.run(id, row.work_state, reason.trim(), nowMs);
      requeued++;
    }

    const byReason = new Map();
    for (const r of rejects) byReason.set(r.reason, (byReason.get(r.reason) ?? 0) + 1);
    return {
      requeued,
      rejected: rejects.length,
      reject_reasons: [...byReason.entries()].map(([why, count]) => ({ reason: why, count })),
    };
  });
}

/** 어떤 항목이 몇 번 되돌려졌는가. 증거를 지우지 않으므로 이력은 여기서만 보인다. */
export function retryHistory(db, itemId) {
  return db.prepare('SELECT from_state, reason, created_at FROM retries WHERE item_id = ? ORDER BY retry_id').all(itemId);
}
