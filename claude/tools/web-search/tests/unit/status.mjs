#!/usr/bin/env node
// lib/status.mjs 단위 시험 — 짧고, 거짓 없고, 계약 키만.
//
//   node tests/unit/status.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createDb, openDb, DbError } from '../../lib/db.mjs';
import { addUrls } from '../../lib/items.mjs';
import { statusOf, statusLine, StatusError } from '../../lib/status.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONTRACT = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'contracts', 'fixtures', 'public-tools.json'), 'utf8'));

const results = [];
const ok = (id, pass, detail) => results.push({ id, pass, detail });
const sorted = (a) => [...a].sort();

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'status-unit-'));
process.on('exit', () => { try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* 이미 없으면 그만 */ } });

let seq = 0;
function freshWs() {
  const root = path.join(SANDBOX, `ws${++seq}`);
  fs.mkdirSync(root, { recursive: true });
  const dbPath = path.join(root, 'workspace.db');
  const db = createDb(root, dbPath, {
    workspaceId: `2026-08-12-status-${seq}`, projectRoot: SANDBOX, briefPath: path.join(root, 'brief.md'), nowMs: 1,
  });
  return { root, dbPath, db };
}
const NOW = 1_000_000;

// ── 빈 workspace ──────────────────────────────────────────────

{
  const { db } = freshWs();
  const s = statusOf(db, { nowMs: NOW });
  ok('S1-empty', s.total === 0 && s.queued === 0 && s.workspace_drained === true && s.last_export === null,
    `전부 0 · workspace_drained=${s.workspace_drained}`);
  ok('S2-drained-is-not-complete',
    !('research_complete' in s) && !('goal_achieved' in s) && !('auto_complete' in s) && !('completion' in s),
    '완료를 뜻하는 필드가 하나도 없다');
  ok('S3-line-warns', statusLine(s).includes('조사 완료라는 뜻은 아닙니다'), statusLine(s));
  db.close();
}

// ── 계약 키와 정확히 일치 ─────────────────────────────────────

{
  const { db } = freshWs();
  const s = statusOf(db, { nowMs: NOW });
  const want = sorted(CONTRACT.tools.status.returns);
  const got = sorted(Object.keys(s));
  ok('S4-contract-keys', JSON.stringify(got) === JSON.stringify(want),
    got.length === want.length ? `${got.length}개 키 일치` : `받은 [${got.join(',')}] 기대 [${want.join(',')}]`);
  db.close();
}

// ── 상태 섞인 workspace ───────────────────────────────────────

{
  const { db } = freshWs();
  addUrls(db, [...Array(10)].map((_, i) => ({ url: `https://example.com/p/${i}`, line: i + 1 })),
    { source_kind: 'seed', source_value: 'manual', nowMs: NOW });

  const ids = db.prepare('SELECT item_id FROM items ORDER BY item_id').all().map((r) => r.item_id);
  const setLeased = db.prepare("UPDATE items SET work_state='leased', lease_id=?, leased_by=?, lease_expires_at=?, collected_at=?, updated_at=? WHERE item_id=?");
  setLeased.run('L1', 'w1', NOW + 60_000, null, NOW, ids[0]);          // 임대만
  setLeased.run('L2', 'w1', NOW + 60_000, NOW, NOW, ids[1]);           // 수집까지 — 보고 대기
  setLeased.run('L3', 'w2', NOW - 1000, NOW, NOW, ids[2]);             // 만료된 임대
  db.prepare("UPDATE items SET work_state='done', updated_at=? WHERE item_id=?").run(NOW, ids[3]);
  db.prepare("UPDATE items SET work_state='failed', updated_at=? WHERE item_id=?").run(NOW, ids[4]);
  db.prepare('UPDATE items SET review_required=1 WHERE item_id IN (?, ?)').run(ids[5], ids[6]);

  const s = statusOf(db, { nowMs: NOW });
  ok('S5-counts', s.total === 10 && s.queued === 5 && s.leased === 3 && s.done === 1 && s.failed === 1,
    `전체 ${s.total} · 대기 ${s.queued} · 임대 ${s.leased} · 완료 ${s.done} · 실패 ${s.failed}`);
  ok('S6-invariant', s.total === s.queued + s.leased + s.done + s.failed, '합계 불변식');
  ok('S7-awaiting-report', s.awaiting_report === 2, `수집까지 끝난 임대 ${s.awaiting_report}건`);
  ok('S8-expired', s.expired_leases === 1, `만료 임대 ${s.expired_leases}건`);
  ok('S9-review', s.review_required === 2, `확인 필요 ${s.review_required}건`);
  ok('S10-not-drained', s.workspace_drained === false, '대기·임대가 남았으니 false');
  db.close();
}

// ── 오류와 산출물 집계 ────────────────────────────────────────

{
  const { db } = freshWs();
  addUrls(db, [{ url: 'https://example.com/e', line: 1 }], { source_kind: 'seed', source_value: 'manual', nowMs: NOW });
  const itemId = db.prepare('SELECT item_id FROM items').get().item_id;
  const att = db.prepare('INSERT INTO attempts (attempt_id, item_id, operation, collector, result, error_stage, error_code, started_at) VALUES (?,?,?,?,?,?,?,?)');
  att.run('a1', itemId, 'collect', 'http', 'failed', 'connect', 'ETIMEDOUT', NOW);
  att.run('a2', itemId, 'collect', 'http', 'failed', 'connect', 'ETIMEDOUT', NOW);
  att.run('a3', itemId, 'collect', 'http', 'failed', 'tls', 'CERT_INVALID', NOW);
  att.run('a4', itemId, 'collect', 'http', 'success', null, null, NOW);
  const art = db.prepare('INSERT INTO artifacts (attempt_id, kind, path, byte_size, sha256, created_at) VALUES (?,?,?,?,?,?)');
  art.run('a4', 'text', '/p/text.txt', 10, 'h1', NOW);
  art.run('a4', 'dom', '/p/dom.html.gz', 20, 'h2', NOW);
  art.run('a4', 'link_manifest', '/p/links.jsonl', 30, 'h3', NOW);

  const s = statusOf(db, { nowMs: NOW });
  ok('S11-top-errors', s.top_errors.length === 2 && s.top_errors[0].code === 'ETIMEDOUT' && s.top_errors[0].count === 2,
    s.top_errors.map((e) => `${e.code}@${e.stage}×${e.count}`).join(', '));
  ok('S12-artifact-counts', JSON.stringify(s.artifact_counts.by_kind) === JSON.stringify({ dom: 1, link_manifest: 1, text: 1 })
    && s.artifact_counts.files === 3 && s.artifact_counts.bytes === 60,
    `${JSON.stringify(s.artifact_counts.by_kind)} · 파일 ${s.artifact_counts.files}개 · ${s.artifact_counts.bytes}바이트`);

  db.prepare("INSERT INTO meta (key, value) VALUES ('last_export', ?)").run('exports/2026-08-12.jsonl');
  ok('S13-last-export', statusOf(db, { nowMs: NOW }).last_export === 'exports/2026-08-12.jsonl', '내보내기 경로가 있으면 그대로');
  db.close();
}

// ── 손상·불일치를 정상으로 꾸미지 않는다 ─────────────────────

{
  const { db } = freshWs();
  addUrls(db, [{ url: 'https://example.com/x', line: 1 }], { source_kind: 'seed', source_value: 'manual', nowMs: NOW });
  // 합계가 어긋나도록 상태 표를 억지로 비튼다. DB 제약을 우회해 넣는다.
  db.exec('PRAGMA writable_schema = OFF');
  let threw = null;
  try {
    // work_state 를 넷 밖으로 못 바꾸므로, 대신 statusOf 가 세는 두 경로가 어긋나게 만든다.
    // items 표에는 있지만 GROUP BY 결과에는 안 잡히는 상태를 만들 수 없으니, 함수를 직접 시험한다.
    const fake = { prepare: (sql) => ({ all: () => (sql.includes('GROUP BY') ? [{ work_state: 'queued', n: 1 }] : []), get: () => ({ n: 5 }) }) };
    statusOf(fake, { nowMs: NOW });
  } catch (e) { threw = e; }
  ok('S14-sum-mismatch-detected', threw instanceof StatusError && threw.code === 'state_sum_mismatch',
    threw ? `${threw.code}: ${threw.message.slice(0, 70)}` : '어긋난 합계를 그냥 넘겼다');
  db.close();
}
{
  const root = path.join(SANDBOX, 'corrupt');
  fs.mkdirSync(root, { recursive: true });
  const p = path.join(root, 'workspace.db');
  fs.writeFileSync(p, 'not a database at all');
  let code = null;
  try { openDb(root, p); } catch (e) { code = e instanceof DbError ? e.code : e.message.slice(0, 40); }
  ok('S15-corrupt-not-zero', code !== null, `손상 DB 는 0건 workspace 가 아니라 오류 — ${code}`);
}
{
  const root = path.join(SANDBOX, 'nodb');
  fs.mkdirSync(root, { recursive: true });
  let code = null;
  try { openDb(root, path.join(root, 'workspace.db')); } catch (e) { code = e.code; }
  ok('S16-missing-db', code === 'db_missing', `없는 DB — ${code}`);
}

// ── 응답 크기 ─────────────────────────────────────────────────

{
  const { db } = freshWs();
  const many = [...Array(2000)].map((_, i) => ({ url: `https://example.com/big/${i}`, line: i + 1 }));
  addUrls(db, many, { source_kind: 'seed', source_value: 'manual', nowMs: NOW });
  const itemId = db.prepare('SELECT item_id FROM items').get().item_id;
  const att = db.prepare('INSERT INTO attempts (attempt_id, item_id, operation, collector, result, error_stage, error_code, started_at) VALUES (?,?,?,?,?,?,?,?)');
  for (let i = 0; i < 50; i++) att.run(`e${i}`, itemId, 'collect', 'http', 'failed', `stage${i}`, `CODE_${i}`, NOW);
  const s = statusOf(db, { nowMs: NOW });
  const bytes = Buffer.byteLength(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: statusLine(s) }], structuredContent: s } }), 'utf8');
  ok('S17-response-small', bytes <= CONTRACT.response_contract.max_bytes && s.top_errors.length === 5,
    `응답 ${bytes}바이트 ≤ ${CONTRACT.response_contract.max_bytes} · 오류 갈래는 상위 ${s.top_errors.length}개만`);
  db.close();
}

// ── 출력 ──────────────────────────────────────────────────────

for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.id} — ${r.detail}`);
const failed = results.filter((r) => !r.pass);
console.log(failed.length === 0 ? `PASS  status 단위 시험 ${results.length}항목 통과` : `FAIL  ${failed.length}건`);
process.exit(failed.length === 0 ? 0 : 1);
