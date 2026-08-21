#!/usr/bin/env node
// lib/items.mjs 단위 시험 — 한 URL 은 한 item, 발견 경로는 모두 남는다.
//
//   node tests/unit/items.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDb } from '../../lib/db.mjs';
import { addUrls, stateCounts, ItemsError } from '../../lib/items.mjs';

const results = [];
const ok = (id, pass, detail) => results.push({ id, pass, detail });
function throwsWith(code, fn) {
  try { fn(); return { pass: false, detail: '던지지 않았다' }; } catch (e) {
    if (!(e instanceof ItemsError)) return { pass: false, detail: `뜻밖의 오류: ${e.message.slice(0, 80)}` };
    return { pass: e.code === code, detail: `code=${e.code}${e.code === code ? '' : ` (기대 ${code})`}` };
  }
}

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'items-unit-'));
process.on('exit', () => { try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* 이미 없으면 그만 */ } });

let seq = 0;
function freshDb() {
  const root = path.join(SANDBOX, `ws${++seq}`);
  fs.mkdirSync(root, { recursive: true });
  return createDb(root, path.join(root, 'workspace.db'), {
    workspaceId: `2026-08-12-items-${seq}`, projectRoot: SANDBOX, briefPath: path.join(root, 'brief.md'), nowMs: 1,
  });
}
const rec = (urls) => urls.map((u, i) => ({ url: u, line: i + 1 }));
const seed = { source_kind: 'seed', source_value: 'manual', nowMs: 1000 };

// ── 기본 ──────────────────────────────────────────────────────

{
  const db = freshDb();
  const r = addUrls(db, rec(['https://example.com/a', 'https://example.com/b']), seed);
  ok('T1-added', r.received === 2 && r.added === 2 && r.duplicates === 0 && r.rejected === 0,
    `받은 것 ${r.received} · 새로 ${r.added} · 중복 ${r.duplicates} · 거절 ${r.rejected}`);

  const rows = db.prepare('SELECT canonical_url, original_url, domain, work_state, created_at FROM items ORDER BY item_id').all();
  ok('T2-new-is-queued', rows.every((x) => x.work_state === 'queued' && x.created_at === 1000 && x.domain === 'example.com'),
    `모두 queued · 시각·도메인 기록됨`);
  ok('T3-original-kept', rows[0].original_url === 'https://example.com/a', rows[0].original_url);
  db.close();
}

// ── 중복은 item 을 늘리지 않고 출처만 는다 ────────────────────

{
  const db = freshDb();
  addUrls(db, rec(['https://example.com/a?utm_source=x']), seed);
  const again = addUrls(db, rec(['https://example.com/a/']), { source_kind: 'search', source_value: 'wedding', nowMs: 2000 });
  ok('T4-duplicate-not-new', again.added === 0 && again.duplicates === 1, `새로 ${again.added} · 중복 ${again.duplicates}`);

  const items = db.prepare('SELECT COUNT(*) AS n FROM items').get().n;
  const sources = db.prepare('SELECT source_kind, source_value FROM sources ORDER BY source_id').all();
  ok('T5-sources-accumulate', items === 1 && sources.length === 2
    && sources.map((s) => s.source_kind).join(',') === 'seed,search',
    `item ${items}개 · 출처 ${sources.map((s) => `${s.source_kind}:${s.source_value}`).join(' | ')}`);

  // 같은 출처를 같은 값으로 다시 넣어도 늘지 않는다
  addUrls(db, rec(['https://example.com/a']), { source_kind: 'search', source_value: 'wedding', nowMs: 3000 });
  ok('T6-same-source-idempotent', db.prepare('SELECT COUNT(*) AS n FROM sources').get().n === 2, '출처 2개 그대로');
  db.close();
}

// ── 한 묶음 안의 중복 ─────────────────────────────────────────

{
  const db = freshDb();
  const r = addUrls(db, rec([
    'https://example.com/x', 'https://example.com/x/', 'https://example.com/x?fbclid=1', 'https://example.com/y',
  ]), seed);
  ok('T7-intra-batch-dupe', r.added === 2 && r.duplicates === 2 && db.prepare('SELECT COUNT(*) AS n FROM items').get().n === 2,
    `새로 ${r.added} · 중복 ${r.duplicates}`);
  db.close();
}

// ── 거절 ──────────────────────────────────────────────────────

{
  const db = freshDb();
  const r = addUrls(db, rec([
    'https://example.com/ok', 'ftp://example.com/x', 'https://user:pw@example.com/y', 'not a url', '',
  ]), seed);
  ok('T8-rejects', r.added === 1 && r.rejected === 4, `새로 ${r.added} · 거절 ${r.rejected}`);
  ok('T9-reject-reasons', r.reject_reasons.length > 0 && r.reject_reasons.every((x) => x.reason.startsWith('url_')),
    r.reject_reasons.map((x) => `${x.reason}×${x.count}`).join(', '));

  const badKind = throwsWith('source_kind', () => addUrls(db, rec(['https://example.com/z']), { source_kind: 'guess', source_value: 'x' }));
  ok('T10-source-kind-closed', badKind.pass, badKind.detail);
  const badValue = throwsWith('source_value', () => addUrls(db, rec(['https://example.com/z']), { source_kind: 'seed', source_value: '  ' }));
  ok('T11-source-value-required', badValue.pass, badValue.detail);

  const foreign = throwsWith('source_item_not_here', () => addUrls(db, rec(['https://example.com/z']), { ...seed, sourceItemId: 999999 }));
  ok('T12-foreign-parent-rejected', foreign.pass, `${foreign.detail} — 다른 장부의 번호를 받지 않는다`);
  db.close();
}

// ── 부모를 지목한 발견 ────────────────────────────────────────

{
  const db = freshDb();
  addUrls(db, rec(['https://example.com/parent']), seed);
  const parentId = db.prepare('SELECT item_id FROM items').get().item_id;
  addUrls(db, rec(['https://example.com/child']), {
    source_kind: 'internal_link', source_value: 'https://example.com/parent', nowMs: 4000, sourceItemId: parentId,
  });
  const s = db.prepare("SELECT source_item_id FROM sources WHERE source_kind = 'internal_link'").get();
  ok('T13-parent-recorded', s.source_item_id === parentId, `부모 item ${s.source_item_id}`);
  db.close();
}

// ── 되돌리기 ──────────────────────────────────────────────────

{
  const db = freshDb();
  addUrls(db, rec(['https://example.com/before']), seed);
  const before = stateCounts(db).total;
  // 넣는 도중 실패하면 그 묶음은 통째로 되돌아가야 한다.
  let threw = false;
  try {
    addUrls(db, rec(['https://example.com/ok1', 'https://example.com/ok2']), { ...seed, sourceItemId: 424242 });
  } catch { threw = true; }
  ok('T14-rollback', threw && stateCounts(db).total === before, `던졌다=${threw} · 항목 ${before} → ${stateCounts(db).total}`);
  db.close();
}

// ── 10,000개 ──────────────────────────────────────────────────

{
  const db = freshDb();
  const N = 10_000;
  const urls = [];
  for (let i = 0; i < N; i++) urls.push(`https://big.example.com/p/${i}?utm_source=batch`);
  // 앞의 1,000개는 추적 파라미터만 다르게 한 번 더 — 합쳐져야 한다
  for (let i = 0; i < 1000; i++) urls.push(`https://big.example.com/p/${i}?fbclid=zz`);
  urls.push('ftp://big.example.com/bad');

  const t0 = Date.now();
  const r = addUrls(db, rec(urls), seed);
  const ms = Date.now() - t0;
  const counts = stateCounts(db);
  ok('T15-bulk-counts', r.received === urls.length && r.added === N && r.duplicates === 1000 && r.rejected === 1,
    `받은 것 ${r.received} · 새로 ${r.added} · 중복 ${r.duplicates} · 거절 ${r.rejected} · ${ms}ms`);
  ok('T16-bulk-invariant', counts.total === N && counts.total === counts.queued + counts.leased + counts.done + counts.failed,
    `total ${counts.total} = queued ${counts.queued} + leased ${counts.leased} + done ${counts.done} + failed ${counts.failed}`);
  ok('T17-bulk-sources', db.prepare('SELECT COUNT(*) AS n FROM sources').get().n === N,
    `출처 ${db.prepare('SELECT COUNT(*) AS n FROM sources').get().n}개 — 같은 출처·같은 값이라 중복분은 늘지 않는다`);

  // 같은 것을 다시 넣어도 합계가 흔들리지 않는다
  const again = addUrls(db, rec(urls), seed);
  ok('T18-rerun-stable', again.added === 0 && again.duplicates === N + 1000 && stateCounts(db).total === N,
    `다시 넣기 → 새로 ${again.added} · 중복 ${again.duplicates} · 총계 ${stateCounts(db).total}`);

  // 출처가 다르면 그만큼 는다
  const other = addUrls(db, rec(urls.slice(0, 100)), { source_kind: 'sitemap', source_value: 'https://big.example.com/sitemap.xml', nowMs: 5000 });
  ok('T19-new-source-grows', other.added === 0 && db.prepare('SELECT COUNT(*) AS n FROM sources').get().n === N + 100,
    `출처 ${db.prepare('SELECT COUNT(*) AS n FROM sources').get().n}개`);
  db.close();
}

// ── 출력 ──────────────────────────────────────────────────────

for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.id} — ${r.detail}`);
const failed = results.filter((r) => !r.pass);
console.log(failed.length === 0 ? `PASS  명부 단위 시험 ${results.length}항목 통과` : `FAIL  ${failed.length}건`);
process.exit(failed.length === 0 ? 0 : 1);
