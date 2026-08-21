#!/usr/bin/env node
// lib/db.mjs · lib/schema.mjs 단위 시험 — DB 하나만으로 상태가 서는지 본다.
//
//   node tests/unit/db.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  DbError, assertRuntimeSupported, createDb, openDb, withDb, tx, readMeta, integrityCheck,
} from '../../lib/db.mjs';
import { SCHEMA_VERSION } from '../../lib/schema.mjs';

const results = [];
const ok = (id, pass, detail) => results.push({ id, pass, detail });

function throwsWith(code, fn) {
  try { fn(); return { pass: false, detail: '던지지 않았다' }; } catch (e) {
    if (!(e instanceof DbError)) return { pass: false, detail: `DbError 가 아니다: ${e.message.slice(0, 90)}` };
    return { pass: e.code === code, detail: `code=${e.code}${e.code === code ? '' : ` (기대 ${code})`}` };
  }
}
function throwsAny(fn) {
  try { fn(); return { pass: false, detail: '던지지 않았다' }; } catch (e) { return { pass: true, detail: e.message.slice(0, 90) }; }
}

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'db-unit-'));
const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'db-outside-'));
process.on('exit', () => {
  for (const d of [sandbox, outside]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* 이미 없으면 그만 */ } }
});

const ROOT = path.join(sandbox, 'ws');
fs.mkdirSync(ROOT, { recursive: true });
const DB = path.join(ROOT, 'workspace.db');
const NOW = Date.parse('2026-08-12T00:00:00Z');
const META = { workspaceId: '2026-08-12-db-unit', projectRoot: sandbox, briefPath: path.join(ROOT, 'brief.md'), nowMs: NOW };

// ── 실행 환경 ─────────────────────────────────────────────────

{
  const rt = assertRuntimeSupported();
  ok('D1-runtime', rt.node === process.versions.node && rt.experimental === true,
    `Node ${rt.node} · node:sqlite 는 실험 기능이라 표시로 남긴다`);
}

// ── 만들기 ────────────────────────────────────────────────────

let db = createDb(ROOT, DB, META);
{
  const mode = db.prepare('PRAGMA journal_mode').get().journal_mode;
  const fk = db.prepare('PRAGMA foreign_keys').get().foreign_keys;
  const busy = db.prepare('PRAGMA busy_timeout').get().timeout;
  ok('D2-pragmas', mode === 'wal' && fk === 1 && busy === 5000, `journal_mode=${mode} · foreign_keys=${fk} · busy_timeout=${busy}`);

  const meta = readMeta(db);
  ok('D3-meta', meta.schema_version === String(SCHEMA_VERSION) && meta.workspace_id === META.workspaceId && meta.project_root === sandbox,
    `schema_version=${meta.schema_version} · workspace_id=${meta.workspace_id}`);

  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
  const want = ['artifacts', 'attempts', 'items', 'judgments', 'meta', 'reports', 'retries', 'sources'];
  ok('D4-tables', JSON.stringify(tables) === JSON.stringify(want), tables.join(', '));
}

// ── 제약이 실제로 붙드는가 ────────────────────────────────────

const insertItem = (d, url, extra = {}) => d.prepare(`
  INSERT INTO items (original_url, canonical_url, domain, work_state, lease_id, leased_by, lease_expires_at, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
  url, url, new URL(url).hostname, extra.work_state ?? 'queued',
  extra.lease_id ?? null, extra.leased_by ?? null, extra.lease_expires_at ?? null, NOW, NOW);

{
  insertItem(db, 'https://example.com/a');
  const dup = throwsAny(() => insertItem(db, 'https://example.com/a'));
  ok('D5-canonical-unique', dup.pass, dup.detail);

  const orphan = throwsAny(() => db.prepare('INSERT INTO attempts (attempt_id, item_id, operation, started_at) VALUES (?,?,?,?)').run('att-x', 999999, 'collect', NOW));
  ok('D6-attempt-fk', orphan.pass, orphan.detail);

  const badOp = throwsAny(() => db.prepare('INSERT INTO attempts (attempt_id, operation, started_at) VALUES (?,?,?)').run('att-y', 'collect', NOW));
  ok('D7-collect-needs-item', badOp.pass, `collect 는 item_id 없이 못 들어간다 — ${badOp.detail}`);

  const okMap = (() => { try { db.prepare('INSERT INTO attempts (attempt_id, operation, started_at) VALUES (?,?,?)').run('att-map', 'map', NOW); return true; } catch { return false; } })();
  ok('D8-map-without-item', okMap, 'map 은 workspace 단위라 item_id 없이 들어간다');

  const artOrphan = throwsAny(() => db.prepare('INSERT INTO artifacts (attempt_id, kind, path, byte_size, sha256, created_at) VALUES (?,?,?,?,?,?)')
    .run('no-such-attempt', 'text', '/x/y', 1, 'h', NOW));
  ok('D9-artifact-fk', artOrphan.pass, artOrphan.detail);

  const badState = throwsAny(() => insertItem(db, 'https://example.com/b', { work_state: 'content_validated' }));
  ok('D10-work-state-closed', badState.pass, `기계 상태 넷 외에는 못 들어간다 — ${badState.detail}`);

  // 임대라고 말하면서 임대 정보가 없는 행은 못 만든다
  const leaseMismatch = throwsAny(() => insertItem(db, 'https://example.com/c', { work_state: 'leased' }));
  ok('D11-lease-consistency', leaseMismatch.pass, leaseMismatch.detail);
  const leaseStray = throwsAny(() => insertItem(db, 'https://example.com/d', { lease_id: 'L1', leased_by: 'w', lease_expires_at: NOW }));
  ok('D12-lease-only-when-leased', leaseStray.pass, `queued 인데 lease_id 가 있으면 거절 — ${leaseStray.detail}`);
  const leaseGood = (() => { try { insertItem(db, 'https://example.com/e', { work_state: 'leased', lease_id: 'L1', leased_by: 'w1', lease_expires_at: NOW + 1000 }); return true; } catch { return false; } })();
  ok('D13-lease-valid-accepted', leaseGood, '임대 정보가 갖춰지면 들어간다');
}

// ── 같은 출처 두 번, 다른 출처 여럿 ───────────────────────────

{
  const itemId = db.prepare('SELECT item_id FROM items WHERE canonical_url = ?').get('https://example.com/a').item_id;
  const put = db.prepare('INSERT INTO sources (item_id, source_kind, source_value, discovered_at) VALUES (?,?,?,?)');
  put.run(itemId, 'seed', 'manual', NOW);
  put.run(itemId, 'search', 'wedding invitation', NOW);
  const same = throwsAny(() => put.run(itemId, 'seed', 'manual', NOW));
  const count = db.prepare('SELECT COUNT(*) AS n FROM sources WHERE item_id = ?').get(itemId).n;
  ok('D14-sources-multi', same.pass && count === 2, `같은 출처 두 번은 거절 · 남은 출처 ${count}개`);
}

// ── transaction rollback ──────────────────────────────────────

{
  const before = db.prepare('SELECT COUNT(*) AS n FROM items').get().n;
  const threw = throwsAny(() => tx(db, (d) => {
    insertItem(d, 'https://example.com/rollback');
    throw new Error('일부러 낸 오류');
  }));
  const after = db.prepare('SELECT COUNT(*) AS n FROM items').get().n;
  ok('D15-tx-rollback', threw.pass && before === after, `항목 수 ${before} → ${after}`);

  const val = tx(db, (d) => { insertItem(d, 'https://example.com/committed'); return 'done'; });
  ok('D16-tx-commit', val === 'done' && db.prepare('SELECT COUNT(*) AS n FROM items WHERE canonical_url = ?').get('https://example.com/committed').n === 1,
    'commit 은 남는다');
}

ok('D17-integrity', integrityCheck(db) === 'ok', `integrity_check = ${integrityCheck(db)}`);
db.close();

// ── 다시 열기 — DB 만으로 상태가 선다 ─────────────────────────

{
  const counts = withDb(ROOT, DB, (d) => ({
    items: d.prepare('SELECT COUNT(*) AS n FROM items').get().n,
    sources: d.prepare('SELECT COUNT(*) AS n FROM sources').get().n,
    fk: d.prepare('PRAGMA foreign_keys').get().foreign_keys,
    mode: d.prepare('PRAGMA journal_mode').get().journal_mode,
  }));
  ok('D18-reopen', counts.items === 3 && counts.sources === 2 && counts.fk === 1 && counts.mode === 'wal',
    `items ${counts.items} · sources ${counts.sources} · 다시 연 연결에도 foreign_keys=${counts.fk}, journal_mode=${counts.mode}`);

  const sidecars = fs.readdirSync(ROOT).filter((f) => f !== 'workspace.db');
  ok('D19-no-second-ledger', sidecars.every((f) => !/events\.jsonl|state\.json/.test(f)),
    `workspace 폴더에 이중 장부 없음 (${sidecars.join(', ') || '다른 파일 없음'})`);
}

// ── 거절해야 하는 것들 ────────────────────────────────────────

{
  const exists = throwsWith('db_exists', () => createDb(ROOT, DB, META));
  ok('D20-no-overwrite', exists.pass, exists.detail);

  const outsideDb = path.join(outside, 'workspace.db');
  const out1 = throwsWith('db_outside_workspace', () => createDb(ROOT, outsideDb, META));
  ok('D21-create-outside-rejected', out1.pass && !fs.existsSync(outsideDb), `${out1.detail} · 바깥 파일 생성 ${fs.existsSync(outsideDb)}`);
  const out2 = throwsWith('db_outside_workspace', () => openDb(ROOT, outsideDb));
  ok('D22-open-outside-rejected', out2.pass, out2.detail);

  const missing = throwsWith('db_missing', () => openDb(ROOT, path.join(ROOT, 'nope.db')));
  ok('D23-open-missing-rejected', missing.pass, missing.detail);
}

// ── 스키마 판 어긋남 ──────────────────────────────────────────

{
  const oldRoot = path.join(sandbox, 'old');
  fs.mkdirSync(oldRoot, { recursive: true });
  const oldDb = path.join(oldRoot, 'workspace.db');
  createDb(oldRoot, oldDb, { ...META, workspaceId: '2026-08-12-old' }).close();
  const raw = new DatabaseSync(oldDb);
  raw.prepare("UPDATE meta SET value = '0' WHERE key = 'schema_version'").run();
  raw.close();
  const tooOld = throwsWith('schema_too_old', () => openDb(oldRoot, oldDb));
  ok('D24-schema-downgrade-rejected', tooOld.pass, tooOld.detail);

  const raw2 = new DatabaseSync(oldDb);
  raw2.prepare("UPDATE meta SET value = '99' WHERE key = 'schema_version'").run();
  raw2.close();
  const tooNew = throwsWith('schema_too_new', () => openDb(oldRoot, oldDb));
  ok('D25-schema-newer-rejected', tooNew.pass, tooNew.detail);
}
{
  const junkRoot = path.join(sandbox, 'junk');
  fs.mkdirSync(junkRoot, { recursive: true });
  const junkDb = path.join(junkRoot, 'workspace.db');
  fs.writeFileSync(junkDb, 'this is not a database');
  const bad = throwsAny(() => openDb(junkRoot, junkDb));
  ok('D26-corrupt-not-empty-workspace', bad.pass, `손상 DB 를 0건 workspace 로 꾸미지 않는다 — ${bad.detail}`);
}

// ── 출력 ──────────────────────────────────────────────────────

for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.id} — ${r.detail}`);
const failed = results.filter((r) => !r.pass);
console.log(failed.length === 0 ? `PASS  lib/db.mjs 단위 시험 ${results.length}항목 통과` : `FAIL  ${failed.length}건`);
process.exit(failed.length === 0 ? 0 : 1);
