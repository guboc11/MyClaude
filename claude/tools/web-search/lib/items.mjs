// URL 명부 — 한 canonical_url 은 한 item, 발견 경로는 모두 남는다.
//
// 계획서 3-4·4-2. 여기서 하지 않는 것: 의미 판정, 자동 방문, 자동 확장.
// 넣기만 하고, 무엇을 열지는 에이전트가 next 로 정한다.

import { normalizeUrl, UrlError } from './url.mjs';
import { tx } from './db.mjs';
import { SOURCE_KINDS } from './schema.mjs';
import { summarizeRejections } from './import.mjs';

export class ItemsError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ItemsError';
    this.code = code;
  }
}
const fail = (code, message) => { throw new ItemsError(code, message); };

/**
 * 레코드를 명부에 넣는다. 한 transaction 안에서 전부 되거나 전부 안 된다.
 *
 * @param db          열린 workspace.db
 * @param records     [{url, line}]
 * @param opts        { source_kind, source_value, nowMs, sourceItemId, normalizeOpts }
 * @returns {{received, added, duplicates, rejected, reject_reasons}}
 */
export function addUrls(db, records, {
  source_kind: sourceKind, source_value: sourceValue, nowMs = Date.now(), sourceItemId = null, normalizeOpts = {},
} = {}) {
  if (!SOURCE_KINDS.includes(sourceKind)) {
    fail('source_kind', `source_kind 는 ${SOURCE_KINDS.join('·')} 중 하나여야 합니다`);
  }
  if (typeof sourceValue !== 'string' || !sourceValue.trim()) fail('source_value', 'source_value 가 비었습니다');

  // 부모 항목을 지목했다면 이 workspace 안에 있어야 한다. 다른 장부의 번호를 받아들이지 않는다.
  if (sourceItemId !== null) {
    const found = db.prepare('SELECT 1 AS ok FROM items WHERE item_id = ?').get(sourceItemId);
    if (!found) fail('source_item_not_here', `source_item_id ${sourceItemId} 는 이 workspace 에 없습니다`);
  }

  const rejected = [];
  const normalized = [];
  for (const r of records) {
    try {
      const n = normalizeUrl(r.url, normalizeOpts);
      normalized.push({ ...n, line: r.line ?? null });
    } catch (e) {
      if (!(e instanceof UrlError)) throw e;
      rejected.push({ line: r.line ?? null, reason: `url_${e.code}` });
    }
  }

  const counts = tx(db, (d) => {
    const findItem = d.prepare('SELECT item_id FROM items WHERE canonical_url = ?');
    const insertItem = d.prepare(`
      INSERT INTO items (original_url, canonical_url, domain, work_state, created_at, updated_at)
      VALUES (?, ?, ?, 'queued', ?, ?)`);
    const insertSource = d.prepare(`
      INSERT OR IGNORE INTO sources (item_id, source_kind, source_value, source_item_id, discovered_at)
      VALUES (?, ?, ?, ?, ?)`);

    let added = 0;
    let duplicates = 0;
    for (const n of normalized) {
      const existing = findItem.get(n.canonical_url);
      let itemId;
      if (existing) {
        itemId = existing.item_id;
        duplicates++;
      } else {
        // 같은 묶음 안에 같은 주소가 두 번 있어도 item 은 하나다.
        itemId = Number(insertItem.run(n.original_url, n.canonical_url, n.domain, nowMs, nowMs).lastInsertRowid);
        added++;
      }
      // 중복이어도 발견 출처는 남긴다. 같은 출처를 같은 값으로 두 번 적는 것만 조용히 넘긴다.
      insertSource.run(itemId, sourceKind, sourceValue, sourceItemId, nowMs);
    }
    return { added, duplicates };
  });

  return {
    received: records.length,
    added: counts.added,
    duplicates: counts.duplicates,
    rejected: rejected.length,
    reject_reasons: summarizeRejections(rejected),
  };
}

/** 상태 합계. total 은 넷의 합과 같아야 한다. */
export function stateCounts(db) {
  const rows = db.prepare('SELECT work_state, COUNT(*) AS n FROM items GROUP BY work_state').all();
  const by = Object.fromEntries(rows.map((r) => [r.work_state, r.n]));
  const queued = by.queued ?? 0;
  const leased = by.leased ?? 0;
  const done = by.done ?? 0;
  const failed = by.failed ?? 0;
  const total = db.prepare('SELECT COUNT(*) AS n FROM items').get().n;
  return { total, queued, leased, done, failed };
}
