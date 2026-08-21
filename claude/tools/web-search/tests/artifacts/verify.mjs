#!/usr/bin/env node
// attempt·artifact 저장 계층 시험 — 태스크 #23.
//
//   node tests/artifacts/verify.mjs
//   node tests/artifacts/verify.mjs --json
//
// 완료 조건이 "DB artifact 와 실제 파일 수·크기·지문이 전부 일치한다" 이므로, 잘 되는 길만 보면
// 아무것도 증명하지 못한다. 네 가지를 실제로 주입한다: 쓰기 실패 · 강제 종료 · 중복 이름 · 지문 불일치.
//
// 네트워크는 쓰지 않는다. 마지막 항목이 그 사실을 판정한다.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ArtifactError, MANIFEST_NAME, TEMP_PREFIX,
  artifactsOf, atomicWrite, attemptStorageDir, incompleteFiles,
  listArtifactFiles, verifyArtifacts, writeArtifact, writeManifest,
} from '../../lib/artifacts.mjs';
import { AttemptError, finishAttempt, getAttempt, startAttempt, unfinishedAttempts } from '../../lib/attempts.mjs';
import { createDb, openDb } from '../../lib/db.mjs';
import { addUrls } from '../../lib/items.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AS_JSON = process.argv.includes('--json');

// ── 네트워크 차단 ─────────────────────────────────────────────
let networkAttempts = 0;
const blocked = (what) => (...a) => {
  networkAttempts++;
  throw new Error(`이 시험은 네트워크를 쓰지 않는다: ${what}(${String(a[0]).slice(0, 60)})`);
};
globalThis.fetch = blocked('fetch');

const results = [];
const ok = (id, pass, detail) => results.push({ id, pass: Boolean(pass), detail: String(detail) });

function throwsWith(code, fn) {
  try { fn(); return { pass: false, detail: '던지지 않았다' }; } catch (e) {
    const c = e?.code;
    return { pass: c === code, detail: `code=${c}${c === code ? '' : ` (기대 ${code})`}` };
  }
}
async function rejectsWith(code, fn) {
  try { await fn(); return { pass: false, detail: '던지지 않았다' }; } catch (e) {
    const c = e?.code;
    return { pass: c === code, detail: `code=${c}${c === code ? '' : ` (기대 ${code})`}` };
  }
}

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'artifacts-unit-'));
process.on('exit', () => { try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* 이미 없으면 그만 */ } });

const NOW = 1_700_000_000_000;
let seq = 0;

/** 항목 두 개가 들어 있는 workspace 를 새로 만든다. */
function freshWorkspace() {
  const root = path.join(SANDBOX, `ws${++seq}`);
  fs.mkdirSync(root, { recursive: true });
  const db = createDb(root, path.join(root, 'workspace.db'), {
    workspaceId: `2026-08-12-artifacts-${seq}`, projectRoot: SANDBOX, briefPath: path.join(root, 'brief.md'), nowMs: NOW,
  });
  addUrls(db, [{ url: 'https://example.com/one', line: 1 }, { url: 'https://example.com/two', line: 2 }],
    { source_kind: 'seed', source_value: 'manual', nowMs: NOW });
  return { root, db, dbPath: path.join(root, 'workspace.db') };
}

const sha = (abs) => createHash('sha256').update(fs.readFileSync(abs)).digest('hex');

// ══ A. attempt 장부 ═══════════════════════════════════════════

{
  const { root, db } = freshWorkspace();

  const a = startAttempt(db, {
    itemId: 1, operation: 'collect', collector: 'http',
    requestedOutputs: ['text', 'dom', 'images'], requestedUrl: 'https://example.com/one', nowMs: NOW,
  });
  const row = getAttempt(db, a.attempt_id);
  ok('A1-open-records-intent',
    row.requested_url === 'https://example.com/one' && row.collector === 'http'
    && JSON.stringify(row.requested_outputs) === '["text","dom","images"]'
    && row.started_at === NOW && row.finished_at === null && row.result === null,
    `시작 시점에 이미 요청 내용이 적힘 · result=${row.result}`);

  ok('A2-id-shape', /^A-[0-9a-f]{32}$/.test(a.attempt_id), a.attempt_id);

  const noItem = throwsWith('item_required', () => startAttempt(db, { operation: 'collect', collector: 'http', nowMs: NOW }));
  ok('A3-collect-needs-item', noItem.pass, noItem.detail);

  const foreign = throwsWith('not_in_this_workspace', () => startAttempt(db, { itemId: 9999, operation: 'collect', collector: 'http', nowMs: NOW }));
  ok('A4-foreign-item-rejected', foreign.pass, foreign.detail);

  const badOp = throwsWith('bad_operation', () => startAttempt(db, { operation: 'crawl', nowMs: NOW }));
  const badCol = throwsWith('bad_collector', () => startAttempt(db, { operation: 'search', collector: 'chrome', nowMs: NOW }));
  const badOut = throwsWith('bad_outputs', () => startAttempt(db, { itemId: 1, operation: 'collect', requestedOutputs: ['cards'], nowMs: NOW }));
  ok('A5-enum-guards', badOp.pass && badCol.pass && badOut.pass,
    `operation ${badOp.detail} · collector ${badCol.detail} · outputs ${badOut.detail}`);

  // search 는 항목 없이 열린다
  const s = startAttempt(db, { operation: 'search', collector: 'search-provider', requestedUrl: null, nowMs: NOW });
  ok('A6-search-without-item', getAttempt(db, s.attempt_id).item_id === null, 'item_id=null 로 열림');

  finishAttempt(db, { attemptId: a.attempt_id, result: 'success', finalUrl: 'https://example.com/one', httpStatus: 200, warningCodes: ['redirected'], nowMs: NOW + 50 });
  const done = getAttempt(db, a.attempt_id);
  ok('A7-finish-records', done.result === 'success' && done.http_status === 200
    && JSON.stringify(done.warning_codes) === '["redirected"]' && done.finished_at === NOW + 50,
    `result=${done.result} · finished_at=${done.finished_at}`);

  const twice = throwsWith('attempt_already_finished', () =>
    finishAttempt(db, { attemptId: a.attempt_id, result: 'failed', errorStage: 'x', errorCode: 'y', nowMs: NOW + 60 }));
  const after = getAttempt(db, a.attempt_id);
  ok('A8-finish-once-only', twice.pass && after.result === 'success' && after.finished_at === NOW + 50,
    `${twice.detail} · 결과는 그대로 ${after.result}`);

  const noWhy = throwsWith('error_detail_required', () =>
    finishAttempt(db, { attemptId: s.attempt_id, result: 'failed', nowMs: NOW + 70 }));
  ok('A9-failed-needs-reason', noWhy.pass, noWhy.detail);

  ok('A10-unfinished-visible', unfinishedAttempts(db).some((x) => x.attempt_id === s.attempt_id),
    `안 끝난 실행 ${unfinishedAttempts(db).length}건`);

  db.close();
}

// ══ B. 파일 하나 만들기 ═══════════════════════════════════════

{
  const { root, db } = freshWorkspace();
  const { attempt_id: A } = startAttempt(db, {
    itemId: 1, operation: 'collect', collector: 'http', requestedOutputs: ['text', 'dom'], requestedUrl: 'https://example.com/one', nowMs: NOW,
  });

  const body = '보이는 텍스트를 순서대로 담는다.\n';
  const w = await writeArtifact(db, { root, attemptId: A, kind: 'text', name: 'text.txt', data: body, nowMs: NOW });

  const abs = path.join(root, w.path);
  ok('B1-path-carries-ids', w.path === `artifacts/pages/1/${A}/text.txt`, w.path);
  ok('B2-file-matches-db',
    fs.existsSync(abs) && fs.statSync(abs).size === w.byte_size && sha(abs) === w.sha256
    && w.byte_size === Buffer.byteLength(body, 'utf8'),
    `${w.byte_size}바이트 · ${w.sha256.slice(0, 12)}…`);
  ok('B3-mime-guessed', w.mime_type === 'text/plain; charset=utf-8', w.mime_type);

  const rows = artifactsOf(db, A);
  ok('B4-row-written', rows.length === 1 && rows[0].path === w.path && rows[0].byte_size === w.byte_size && rows[0].sha256 === w.sha256,
    `장부 ${rows.length}줄`);

  // 중복 이름 — 두 번째는 거절되고 첫 파일은 손대지 않는다
  const before = sha(abs);
  const dup = await rejectsWith('artifact_exists', () =>
    writeArtifact(db, { root, attemptId: A, kind: 'text', name: 'text.txt', data: '다른 내용', nowMs: NOW }));
  ok('B5-duplicate-name-rejected', dup.pass && sha(abs) === before && artifactsOf(db, A).length === 1,
    `${dup.detail} · 첫 파일 그대로 · 장부 ${artifactsOf(db, A).length}줄`);

  // 장부에 없는 파일이 이미 그 자리에 있으면 덮지 않는다
  fs.writeFileSync(path.join(root, 'artifacts', 'pages', '1', A, 'dom.html.gz'), 'leftover');
  const taken = await rejectsWith('file_exists', () =>
    writeArtifact(db, { root, attemptId: A, kind: 'dom', name: 'dom.html.gz', data: 'x', nowMs: NOW }));
  ok('B6-existing-file-not-overwritten', taken.pass && fs.readFileSync(path.join(root, 'artifacts', 'pages', '1', A, 'dom.html.gz'), 'utf8') === 'leftover',
    taken.detail);
  fs.rmSync(path.join(root, 'artifacts', 'pages', '1', A, 'dom.html.gz'));

  // 조각 흐름으로 쓰기
  async function* chunks() { yield Buffer.from('첫 조각\n'); yield Buffer.from('둘째 조각\n'); }
  const streamed = await writeArtifact(db, { root, attemptId: A, kind: 'dom', name: 'dom.html.gz', data: chunks(), nowMs: NOW });
  ok('B7-stream-write',
    fs.readFileSync(path.join(root, streamed.path), 'utf8') === '첫 조각\n둘째 조각\n'
    && streamed.mime_type === 'application/gzip' && sha(path.join(root, streamed.path)) === streamed.sha256,
    `${streamed.byte_size}바이트 · ${streamed.mime_type}`);

  // 하위 폴더 (images/)
  const img = await writeArtifact(db, { root, attemptId: A, kind: 'image', name: 'p1.png', subdir: 'images', data: Buffer.from([1, 2, 3]), nowMs: NOW });
  ok('B8-subdir', img.path === `artifacts/pages/1/${A}/images/p1.png` && img.mime_type === 'image/png' && img.byte_size === 3, img.path);

  const badKind = await rejectsWith('bad_kind', () => writeArtifact(db, { root, attemptId: A, kind: 'cards', name: 'x.txt', data: 'x', nowMs: NOW }));
  const badName = await rejectsWith('bad_name', () => writeArtifact(db, { root, attemptId: A, kind: 'text', name: 'sub/x.txt', data: 'x', nowMs: NOW }));
  const tempName = await rejectsWith('bad_name', () => writeArtifact(db, { root, attemptId: A, kind: 'text', name: `${TEMP_PREFIX}x.txt`, data: 'x', nowMs: NOW }));
  const noAttempt = await rejectsWith('attempt_missing', () => writeArtifact(db, { root, attemptId: 'A-nope', kind: 'text', name: 'x.txt', data: 'x', nowMs: NOW }));
  ok('B9-input-guards', badKind.pass && badName.pass && tempName.pass && noAttempt.pass,
    `kind ${badKind.detail} · 이름 ${badName.detail} · 임시이름 ${tempName.detail} · 실행 ${noAttempt.detail}`);

  db.close();
}

// ══ C. search·map 은 다른 자리에 쌓인다 ═══════════════════════

{
  const { root, db } = freshWorkspace();
  const s = startAttempt(db, { operation: 'search', collector: 'search-provider', nowMs: NOW });
  const m = startAttempt(db, { operation: 'map', collector: 'http', nowMs: NOW });
  const sa = await writeArtifact(db, { root, attemptId: s.attempt_id, kind: 'search_result', name: 'results.jsonl', data: '{}\n', nowMs: NOW });
  const ma = await writeArtifact(db, { root, attemptId: m.attempt_id, kind: 'map', name: 'map.jsonl', data: '{}\n', nowMs: NOW });
  ok('C1-search-map-buckets',
    sa.path === `artifacts/search/${s.attempt_id}/results.jsonl` && ma.path === `artifacts/maps/${m.attempt_id}/map.jsonl`,
    `${sa.path} · ${ma.path}`);
  db.close();
}

// ══ D. manifest ═══════════════════════════════════════════════

{
  const { root, db } = freshWorkspace();
  const { attempt_id: A } = startAttempt(db, {
    itemId: 2, operation: 'collect', collector: 'http',
    requestedOutputs: ['text', 'dom', 'images'], requestedUrl: 'https://example.com/two', nowMs: NOW,
  });
  await writeArtifact(db, { root, attemptId: A, kind: 'text', name: 'text.txt', data: '내용\n', nowMs: NOW });
  finishAttempt(db, {
    attemptId: A, result: 'partial', finalUrl: 'https://example.com/two/final', httpStatus: 200,
    warningCodes: ['redirected', 'image_fetch_partial'],
    errorStage: 'images', errorCode: 'image_fetch_failed', errorMessageShort: '그림 3장을 못 받았습니다',
    nowMs: NOW + 100,
  });
  const mf = await writeManifest(db, root, A, { nowMs: NOW + 101 });
  const doc = JSON.parse(fs.readFileSync(path.join(root, mf.path), 'utf8'));

  ok('D1-manifest-has-plan-5-5-fields',
    doc.workspace_id === `2026-08-12-artifacts-${seq}` && doc.item_id === 2 && doc.attempt_id === A
    && doc.requested_url === 'https://example.com/two' && doc.final_url === 'https://example.com/two/final'
    && doc.collector === 'http' && doc.error.stage === 'images' && doc.error.code === 'image_fetch_failed'
    && doc.retry_item_id === 2,
    'workspace·item·attempt·요청/최종 URL·실패 단계·코드·재실행 번호 모두 있음');

  ok('D2-missing-outputs',
    JSON.stringify(doc.produced_outputs) === '["text"]' && JSON.stringify(doc.missing_outputs) === '["dom","images"]',
    `만든 것 ${doc.produced_outputs} · 빠진 것 ${doc.missing_outputs}`);

  ok('D3-artifacts-listed',
    doc.artifacts.length === 1 && doc.artifacts[0].sha256 === artifactsOf(db, A)[0].sha256
    && doc.artifacts[0].byte_size === artifactsOf(db, A)[0].byte_size,
    `${doc.artifacts.length}개 · 지문 일치`);

  ok('D4-manifest-is-not-an-artifact',
    !artifactsOf(db, A).some((r) => r.path.endsWith(MANIFEST_NAME))
    && !listArtifactFiles(root, getAttempt(db, A)).some((p) => p.endsWith(MANIFEST_NAME)),
    'manifest 는 장부에도 파일 목록에도 안 들어간다');

  ok('D5-no-temp-left', incompleteFiles(root).length === 0, `임시 파일 ${incompleteFiles(root).length}개`);

  // 다시 써도 반쪽이 남지 않는다
  const again = await writeManifest(db, root, A, { nowMs: NOW + 102 });
  const doc2 = JSON.parse(fs.readFileSync(path.join(root, again.path), 'utf8'));
  ok('D6-manifest-rewritable', doc2.written_at === NOW + 102 && incompleteFiles(root).length === 0, `written_at=${doc2.written_at}`);

  db.close();
}

// ══ E. 쓰기 실패 주입 ═════════════════════════════════════════

{
  const { root, db } = freshWorkspace();
  const { attempt_id: A } = startAttempt(db, { itemId: 1, operation: 'collect', collector: 'http', requestedOutputs: ['text'], nowMs: NOW });

  // (1) 흐름이 도중에 터진다
  async function* explodes() {
    yield Buffer.from('앞부분은 들어간다');
    throw new Error('연결이 끊겼습니다');
  }
  let threw = false;
  try { await writeArtifact(db, { root, attemptId: A, kind: 'text', name: 'text.txt', data: explodes(), nowMs: NOW }); }
  catch { threw = true; }
  const dir = attemptStorageDir(root, getAttempt(db, A));
  ok('E1-broken-stream',
    threw && !fs.existsSync(path.join(dir, 'text.txt')) && artifactsOf(db, A).length === 0 && incompleteFiles(root).length === 0,
    `최종 파일 없음 · 장부 ${artifactsOf(db, A).length}줄 · 임시 파일 ${incompleteFiles(root).length}개`);

  // (2) 폴더를 읽기 전용으로 만든다
  fs.mkdirSync(dir, { recursive: true });
  fs.chmodSync(dir, 0o500);
  const denied = await rejectsWith('EACCES', () =>
    writeArtifact(db, { root, attemptId: A, kind: 'text', name: 'text.txt', data: '못 쓴다', nowMs: NOW }));
  fs.chmodSync(dir, 0o700);
  ok('E2-write-denied', denied.pass && artifactsOf(db, A).length === 0,
    `${denied.detail} · 장부 ${artifactsOf(db, A).length}줄`);

  // (3) 실패한 뒤에도 같은 이름으로 다시 쓸 수 있다 — 실패가 자리를 잠그지 않는다
  const retry = await writeArtifact(db, { root, attemptId: A, kind: 'text', name: 'text.txt', data: '이번엔 된다\n', nowMs: NOW });
  ok('E3-retry-after-failure', artifactsOf(db, A).length === 1 && fs.existsSync(path.join(root, retry.path)),
    `장부 ${artifactsOf(db, A).length}줄 · ${retry.byte_size}바이트`);

  db.close();
}

// ══ F. 강제 종료 주입 ═════════════════════════════════════════

{
  const { root, db, dbPath } = freshWorkspace();
  db.close();   // 자식이 열 수 있게 놓아 준다

  const child = spawn(process.execPath, [path.join(HERE, 'kill-child.mjs'), root, dbPath, '1'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stderr.on('data', (d) => { err += d; });
  const attemptId = await new Promise((resolve, reject) => {
    const t = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`자식이 10초 안에 준비되지 않았다: ${err.slice(0, 300)}`)); }, 10_000);
    child.stdout.on('data', (d) => {
      out += d;
      if (out.includes('ready\n')) { clearTimeout(t); resolve(out.split('\n')[0]); }
    });
    child.on('exit', (c) => { clearTimeout(t); reject(new Error(`자식이 먼저 끝났다 (code=${c}) ${err.slice(0, 300)}`)); });
  });

  child.kill('SIGKILL');
  await new Promise((r) => child.on('exit', r));

  const back = openDb(root, dbPath);
  const a = getAttempt(back, attemptId);
  const dir = attemptStorageDir(root, a);
  const temps = incompleteFiles(root);
  const finalFile = path.join(dir, 'text.txt');

  ok('F1-no-final-file', !fs.existsSync(finalFile), `${finalFile.replace(root, '')} 없음`);
  ok('F2-no-row', artifactsOf(back, attemptId).length === 0, `장부 ${artifactsOf(back, attemptId).length}줄`);
  ok('F3-temp-left-and-named', temps.length === 1 && path.basename(temps[0]).startsWith(TEMP_PREFIX), temps.join(', ') || '없음');
  ok('F4-temp-not-in-file-list', listArtifactFiles(root, a).length === 0,
    `정상 파일 목록 ${listArtifactFiles(root, a).length}개`);
  ok('F5-attempt-still-open', a.finished_at === null && unfinishedAttempts(back).some((x) => x.attempt_id === attemptId),
    `안 끝난 실행으로 남음 · 요청 내용은 ${JSON.stringify(a.requested_outputs)}`);

  const v = verifyArtifacts(back, root);
  ok('F6-verify-counts-incomplete',
    v.checked === 0 && v.orphans.length === 0 && v.incomplete.length === 1,
    `장부 ${v.checked} · 고아 ${v.orphans.length} · 만들다 만 것 ${v.incomplete.length}`);

  back.close();
}

// ══ G. 대조 — 완료 조건 ═══════════════════════════════════════

{
  const { root, db } = freshWorkspace();
  const made = [];
  for (const itemId of [1, 2]) {
    const { attempt_id: A } = startAttempt(db, {
      itemId, operation: 'collect', collector: 'http', requestedOutputs: ['text', 'dom', 'images'],
      requestedUrl: `https://example.com/${itemId}`, nowMs: NOW,
    });
    made.push(await writeArtifact(db, { root, attemptId: A, kind: 'text', name: 'text.txt', data: `텍스트 ${itemId}\n`, nowMs: NOW }));
    made.push(await writeArtifact(db, { root, attemptId: A, kind: 'dom', name: 'dom.html.gz', data: Buffer.from([0x1f, 0x8b, itemId]), nowMs: NOW }));
    made.push(await writeArtifact(db, { root, attemptId: A, kind: 'image_manifest', name: 'images.jsonl', data: '{"n":1}\n', nowMs: NOW }));
    for (const n of [1, 2, 3]) {
      made.push(await writeArtifact(db, { root, attemptId: A, kind: 'image', name: `i${n}.png`, subdir: 'images', data: Buffer.from([n, n, n, n]), nowMs: NOW }));
    }
    finishAttempt(db, { attemptId: A, result: 'success', finalUrl: `https://example.com/${itemId}`, httpStatus: 200, nowMs: NOW + 10 });
    await writeManifest(db, root, A, { nowMs: NOW + 11 });
  }

  const clean = verifyArtifacts(db, root);
  const onDisk = fs.readdirSync(path.join(root, 'artifacts', 'pages'), { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name !== MANIFEST_NAME && !e.name.startsWith(TEMP_PREFIX)).length;
  ok('G1-all-consistent',
    clean.checked === 12 && clean.ok === 12 && clean.missing.length === 0
    && clean.size_mismatch.length === 0 && clean.sha_mismatch.length === 0
    && clean.orphans.length === 0 && clean.incomplete.length === 0 && onDisk === 12,
    `장부 ${clean.checked} · 온전 ${clean.ok} · 실제 파일 ${onDisk}`);

  // 지문 불일치 주입 — 크기는 그대로 두고 내용만 바꾼다
  const victim = path.join(root, made[0].path);
  const original = fs.readFileSync(victim);
  const twisted = Buffer.from(original);
  twisted[0] = twisted[0] ^ 0xff;
  fs.writeFileSync(victim, twisted);
  const bad = verifyArtifacts(db, root);
  ok('G2-sha-mismatch-caught',
    bad.sha_mismatch.length === 1 && bad.sha_mismatch[0] === made[0].path && bad.size_mismatch.length === 0 && bad.ok === 11,
    `지문 어긋남 ${bad.sha_mismatch.length}건 · 크기는 그대로`);
  fs.writeFileSync(victim, original);

  // 크기 불일치 주입
  fs.appendFileSync(victim, '덧붙임');
  const grown = verifyArtifacts(db, root);
  ok('G3-size-mismatch-caught', grown.size_mismatch.length === 1 && grown.size_mismatch[0].path === made[0].path,
    `크기 어긋남 ${grown.size_mismatch.length}건 (${grown.size_mismatch[0]?.db} → ${grown.size_mismatch[0]?.disk})`);
  fs.writeFileSync(victim, original);

  // 파일이 사라진 경우
  fs.rmSync(victim);
  const gone = verifyArtifacts(db, root);
  ok('G4-missing-caught', gone.missing.length === 1 && gone.missing[0] === made[0].path, `없어진 것 ${gone.missing.length}건`);
  fs.writeFileSync(victim, original);

  // 아무도 안 가리키는 파일
  const stray = path.join(path.dirname(victim), 'stray.txt');
  fs.writeFileSync(stray, '누가 만들었지');
  const orphaned = verifyArtifacts(db, root);
  ok('G5-orphan-caught', orphaned.orphans.length === 1 && orphaned.orphans[0].endsWith('/stray.txt'), `고아 ${orphaned.orphans.length}건`);
  fs.rmSync(stray);

  ok('G6-back-to-clean', JSON.stringify(verifyArtifacts(db, root)) === JSON.stringify(clean), '주입을 되돌리면 처음 상태와 같다');

  // 끝났는데 요약이 없는 실행을 잡아낸다 — #28 이 manifest 쓰기를 빠뜨리면 여기서 걸린다
  ok('G7-manifest-required-when-finished', clean.manifest_missing.length === 0, `요약 없는 실행 ${clean.manifest_missing.length}건`);
  const orphanAttempt = startAttempt(db, { itemId: 1, operation: 'collect', collector: 'http', requestedOutputs: ['text'], nowMs: NOW });
  finishAttempt(db, { attemptId: orphanAttempt.attempt_id, result: 'failed', errorStage: 'connect', errorCode: 'refused', nowMs: NOW + 20 });
  const noSummary = verifyArtifacts(db, root);
  ok('G8-manifest-missing-caught',
    noSummary.manifest_missing.length === 1 && noSummary.manifest_missing[0] === orphanAttempt.attempt_id,
    `요약 없는 실행 ${noSummary.manifest_missing.length}건 — 산출물이 하나도 없는 실패도 요약은 남겨야 한다`);
  await writeManifest(db, root, orphanAttempt.attempt_id, { nowMs: NOW + 21 });
  ok('G9-manifest-fixes-it', verifyArtifacts(db, root).manifest_missing.length === 0, '요약을 쓰면 해소된다');

  db.close();
}

// ══ H. atomicWrite 자체 ═══════════════════════════════════════

{
  const dir = path.join(SANDBOX, 'atomic');
  const w = await atomicWrite(dir, 'a.txt', '한 줄\n');
  ok('H1-atomic-basic', fs.readFileSync(w.abs, 'utf8') === '한 줄\n' && w.sha256 === sha(w.abs), `${w.bytes}바이트`);
  const left = fs.readdirSync(dir).filter((n) => n.startsWith(TEMP_PREFIX));
  ok('H2-no-temp-left', left.length === 0, `남은 임시 파일 ${left.length}개`);

  const bad = await rejectsWith('bad_name', () => atomicWrite(dir, '../escape.txt', 'x'));
  ok('H3-name-guard', bad.pass, bad.detail);

  ok('H4-no-network', networkAttempts === 0, `네트워크 시도 ${networkAttempts}회`);
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
