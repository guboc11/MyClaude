#!/usr/bin/env node
// 최종 status 시험 — 태스크 #42.
//
//   node tests/status-full/verify.mjs
//   node tests/status-full/verify.mjs --json
//
// 완료 조건이 "시나리오 C 의 장애 대상을 status 만으로 특정할 수 있다" 이다.
// 그래서 여기서는 **status 응답 하나만 손에 쥐고** 망가진 항목을 찾아낼 수 있는지 본다 —
// DB 를 다시 뒤지지 않고, 긴 로그를 열지 않고.
//
// 크기도 같이 잰다. 항목이 1,000개를 넘어도 응답은 4KB 안이어야 한다. 총계와 표본만 담고
// 목록을 통째로 싣지 않는다는 성질이 여기서 지켜진다.
//
// 네트워크는 쓰지 않는다. 마지막 항목이 그 사실을 판정한다.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { writeArtifact } from '../../lib/artifacts.mjs';
import { finishAttempt, startAttempt } from '../../lib/attempts.mjs';
import { createDb } from '../../lib/db.mjs';
import { runExport } from '../../lib/export.mjs';
import { addUrls } from '../../lib/items.mjs';
import { statusLine, statusOf } from '../../lib/status.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AS_JSON = process.argv.includes('--json');

let networkAttempts = 0;
globalThis.fetch = (...a) => {
  networkAttempts++;
  throw new Error(`이 시험은 네트워크를 쓰지 않는다: fetch(${String(a[0]).slice(0, 60)})`);
};

const results = [];
const ok = (id, pass, detail) => results.push({ id, pass: Boolean(pass), detail: String(detail) });

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'status-full-'));
process.on('exit', () => { try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* 이미 없으면 그만 */ } });

const NOW = 1_700_000_000_000;
const ITEMS = 1200;
const ERROR_KINDS = 20;

// 아주 긴 URL 하나를 섞는다. 표본이 URL 을 통째로 싣는지 잘라 싣는지 여기서 갈린다.
const LONG_TAIL = 'z'.repeat(400);

const root = path.join(SANDBOX, 'ws');
fs.mkdirSync(root, { recursive: true });
const db = createDb(root, path.join(root, 'workspace.db'), {
  workspaceId: '2026-08-12-status-full', projectRoot: SANDBOX, briefPath: path.join(root, 'brief.md'), nowMs: NOW,
});

addUrls(db, Array.from({ length: ITEMS }, (_, i) => ({ url: `https://shop${i % 40}.example/p/${i}?ref=${LONG_TAIL}` })),
  { source_kind: 'seed', source_value: 'bulk', nowMs: NOW });

// 실패 여러 갈래 — 갈래 수보다 적게 보여 주는지 보려고 스무 가지를 만든다.
const att = db.prepare(`INSERT INTO attempts
  (attempt_id, item_id, operation, collector, requested_url, final_url, http_status, result,
   warning_codes, error_stage, error_code, error_message_short, requested_outputs, started_at, finished_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

for (let k = 0; k < ERROR_KINDS; k++) {
  // 갈래마다 건수를 다르게 둔다. 가장 잦은 것이 맨 앞에 오는지 보려는 것이다.
  for (let n = 0; n <= k; n++) {
    const itemId = (k * 30) + n + 1;
    att.run(`AF-${k}-${n}`, itemId, 'collect', 'http',
      `https://shop${itemId % 40}.example/p/${itemId}?ref=${LONG_TAIL}`, null, null, 'failed',
      JSON.stringify(['slow_response']), 'transport', `err_code_${k}`, `${k}번 갈래가 터졌다`,
      JSON.stringify(['text', 'dom']), NOW, NOW + 10);
    db.prepare("UPDATE items SET work_state = 'failed' WHERE item_id = ?").run(itemId);
  }
}

// 시나리오 C 의 장애 하나 — 이것만 유난히 잦게 만들어 맨 앞에 세운다.
const BROKEN_ITEM = 777;
for (let n = 0; n < 60; n++) {
  att.run(`AB-${n}`, BROKEN_ITEM, 'collect', 'browser',
    `https://shop17.example/p/${BROKEN_ITEM}`, `https://shop17.example/p/${BROKEN_ITEM}/final`, 503, 'failed',
    JSON.stringify(['browser_no_pinned_connection']), 'render', 'browser_crashed', '브라우저가 죽었다',
    JSON.stringify(['screenshot', 'dom']), NOW, NOW + 20);
}
db.prepare("UPDATE items SET work_state = 'failed' WHERE item_id = ?").run(BROKEN_ITEM);

// 성공한 것들 — 산출물과 용량이 실제로 세어지는지 보려고 진짜 파일을 쓴다.
let wroteBytes = 0;
for (let i = 0; i < 5; i++) {
  const itemId = 1000 + i;
  const a = startAttempt(db, { itemId, operation: 'collect', collector: 'http', requestedOutputs: ['text'], requestedUrl: `https://shop1.example/p/${itemId}`, nowMs: NOW });
  const art = await writeArtifact(db, { root, attemptId: a.attempt_id, kind: 'text', name: 'page.txt', data: `본문 ${itemId}\n`.repeat(3), nowMs: NOW });
  wroteBytes += art.byte_size;
  finishAttempt(db, { attemptId: a.attempt_id, result: 'success', httpStatus: 200, nowMs: NOW + 10 });
  db.prepare("UPDATE items SET work_state = 'done', collected_at = ? WHERE item_id = ?").run(NOW + 10, itemId);
}
db.prepare('UPDATE items SET review_required = 1 WHERE item_id IN (1000, 1001)').run();

const s = statusOf(db, { nowMs: NOW + 1000 });
const line = statusLine(s);
const bytes = Buffer.byteLength(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: line }], structuredContent: s } }), 'utf8');

// ══ A. 크기 ═══════════════════════════════════════════════════
{
  ok('A1-under-4kb', bytes <= 4096,
    `item ${ITEMS}개 · 실패 갈래 ${ERROR_KINDS + 1}가지 · 실행 ${db.prepare('SELECT COUNT(*) AS n FROM attempts').get().n}건일 때 응답 ${bytes}바이트 ≤ 4096`);

  const errs = s.top_errors.filter((e) => e.kind === 'error');
  const warns = s.top_errors.filter((e) => e.kind === 'warning');
  ok('A2-samples-not-lists', errs.length === 5 && warns.length === 2
    && db.prepare("SELECT COUNT(DISTINCT error_code) AS n FROM attempts WHERE result = 'failed'").get().n === ERROR_KINDS + 1,
    `실패 갈래 ${ERROR_KINDS + 1}가지 중 ${errs.length}가지만 · 관찰 ${warns.length}가지 — 목록을 통째로 싣지 않는다`);

  const longest = Math.max(...errs.map((e) => (e.sample?.requested_url ?? '').length));
  ok('A3-urls-cut', longest <= 100, `표본의 URL 은 ${longest}자까지만 (원본은 400자 넘는 것이 섞여 있다)`);
}

// ══ B. 시나리오 C — status 만으로 장애를 특정한다 ═════════════
{
  // 여기서부터는 DB 를 안 본다. 손에 쥔 것은 status 응답 하나뿐이라고 치고 짚어 나간다.
  const worst = s.top_errors.find((e) => e.kind === 'error');
  const sample = worst?.sample ?? {};

  ok('B1-worst-first', worst.code === 'browser_crashed' && worst.count === 60 && worst.stage === 'render',
    `가장 잦은 장애 ${worst.stage}/${worst.code} ${worst.count}건`);

  ok('B2-points-at-the-item', sample.item_id === BROKEN_ITEM && sample.retry_item_id === BROKEN_ITEM,
    `status 가 item ${sample.item_id} 를 지목한다 — retry 에 그대로 넣을 번호 ${sample.retry_item_id}`);

  ok('B3-enough-to-diagnose',
    typeof sample.attempt_id === 'string' && sample.attempt_id.length > 0
    && sample.collector === 'browser' && sample.http_status === 503
    && sample.requested_url !== sample.final_url
    && JSON.stringify(sample.missing) === JSON.stringify(['screenshot', 'dom'])
    && sample.produced.length === 0
    && typeof worst.why === 'string' && worst.why.length > 0,
    `실행 ${sample.attempt_id} · ${sample.collector} · 상태 ${sample.http_status} · 요청≠최종`
    + ` · 빠진 산출물 ${sample.missing.join('·')} · 뜻 "${worst.why.slice(0, 24)}…"`);

  ok('B4-manifest-path', sample.manifest === `artifacts/pages/${BROKEN_ITEM}/${sample.attempt_id}/manifest.json`,
    `요약 파일 자리까지 알려 준다 — ${sample.manifest}`);

  // 실제로 그 번호가 망가진 그 항목인가. 여기서만 DB 를 열어 대조한다.
  const real = db.prepare("SELECT item_id, work_state FROM items WHERE item_id = ?").get(sample.retry_item_id);
  ok('B5-the-guess-was-right', real.work_state === 'failed'
    && db.prepare("SELECT COUNT(*) AS n FROM attempts WHERE item_id = ? AND error_code = 'browser_crashed'").get(real.item_id).n === 60,
    `짚은 item ${real.item_id} 은 실제로 ${real.work_state} 이고 같은 오류가 60건이다`);
}

// ══ C. 산출물 수와 용량 ═══════════════════════════════════════
{
  const real = db.prepare('SELECT COUNT(*) AS n, SUM(byte_size) AS b FROM artifacts').get();
  ok('C1-artifact-sum', s.artifact_counts.files === real.n && s.artifact_counts.bytes === real.b
    && s.artifact_counts.bytes === wroteBytes,
    `산출물 ${s.artifact_counts.files}개 · ${s.artifact_counts.bytes}바이트 (실제로 쓴 ${wroteBytes}바이트와 같다)`);
  ok('C2-by-kind', JSON.stringify(s.artifact_counts.by_kind) === JSON.stringify({ text: 5 }),
    JSON.stringify(s.artifact_counts.by_kind));
  ok('C3-line-shows-size', line.includes('산출물 5개'), `한 줄 요약: "${line.slice(0, 60)}…"`);
}

// ══ D. export 경로 ════════════════════════════════════════════
{
  const e = await runExport(db, root, { format: 'jsonl', filter_state: 'failed', nowMs: NOW + 2000 });
  const s2 = statusOf(db, { nowMs: NOW + 2000 });
  ok('D1-last-export', s2.last_export === e.path && statusLine(s2).includes(e.path),
    `최근 export ${s2.last_export} (${e.rows}줄)`);
}

// ══ E. 대기·임대 없음과 조사 완료는 다르다 ════════════════════
{
  const r2 = path.join(SANDBOX, 'ws2');
  fs.mkdirSync(r2, { recursive: true });
  const db2 = createDb(r2, path.join(r2, 'workspace.db'), {
    workspaceId: '2026-08-12-drained', projectRoot: SANDBOX, briefPath: path.join(r2, 'brief.md'), nowMs: NOW,
  });
  addUrls(db2, [{ url: 'https://one.example/a' }], { source_kind: 'seed', source_value: 'x', nowMs: NOW });
  db2.prepare("UPDATE items SET work_state = 'done', collected_at = ? WHERE item_id = 1").run(NOW);
  const sd = statusOf(db2, { nowMs: NOW });
  const ld = statusLine(sd);
  ok('E1-drained-is-not-complete', sd.workspace_drained === true
    && ld.includes('대기·임대 없음') && ld.includes('조사 완료라는 뜻은 아닙니다')
    && !Object.keys(sd).some((k) => /complete|finished|research_done/i.test(k)),
    `workspace_drained=true 이고 그 말이 무엇이 아닌지 같은 줄에 적힌다 — "${ld.slice(-34)}"`);
  db2.close();
}

// ══ F. 상한을 정말 넘겨 본다 ══════════════════════════════════
// [믿지 말고 만든다] "4KB 안에 든다" 를 재려면 넘칠 뻔한 자료를 실제로 만들어야 한다.
// 장부에는 오류 메시지가 300자까지 들어간다. 한글이면 한 글자가 3바이트라 다섯 갈래만으로도
// 상한을 넘긴다 — 그때 status 가 죽는지, 줄이고 살아 남는지를 본다.
{
  const r3 = path.join(SANDBOX, 'ws3');
  fs.mkdirSync(r3, { recursive: true });
  const db3 = createDb(r3, path.join(r3, 'workspace.db'), {
    workspaceId: '2026-08-12-fat', projectRoot: SANDBOX, briefPath: path.join(r3, 'brief.md'), nowMs: NOW,
  });
  addUrls(db3, Array.from({ length: 12 }, (_, i) => ({ url: `https://fat.example/${i}` })),
    { source_kind: 'seed', source_value: 'x', nowMs: NOW });
  const fat = db3.prepare(`INSERT INTO attempts
    (attempt_id, item_id, operation, collector, requested_url, result, error_stage, error_code,
     error_message_short, requested_outputs, started_at, finished_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (let k = 0; k < 8; k++) {
    fat.run(`AX-${k}`, k + 1, 'collect', 'http', `https://fat.example/${k}`, 'failed',
      'parse', `fat_${k}`, '아주 긴 오류 설명이 그대로 실리면 응답이 부풀어 오른다. '.repeat(9).slice(0, 300),
      JSON.stringify(['text']), NOW, NOW + 1);
    db3.prepare("UPDATE items SET work_state = 'failed' WHERE item_id = ?").run(k + 1);
  }
  const raw = statusOf(db3, { nowMs: NOW, budgetBytes: 1_000_000 });   // 안 줄였을 때의 크기
  const fit = statusOf(db3, { nowMs: NOW });
  const rawBytes = Buffer.byteLength(JSON.stringify(raw), 'utf8');
  const fitBytes = Buffer.byteLength(JSON.stringify(fit), 'utf8');
  const note = fit.top_errors.find((e) => e.kind === 'note');

  ok('F1-really-would-overflow', rawBytes > 3000,
    `안 줄이면 ${rawBytes}바이트로 상한 밖이다 — 이 항목이 헛돌지 않는다는 증거`);
  ok('F2-trimmed-and-alive', fitBytes <= 3000 && fit.total === raw.total && fit.failed === raw.failed,
    `줄여서 ${fitBytes}바이트 · 총계는 그대로(전체 ${fit.total} · 실패 ${fit.failed})`);
  ok('F3-trim-is-visible', note !== undefined && note.count > 0 && statusLine(fit).includes('응답 상한'),
    `무엇을 뺐는지 남는다 — ${note?.count}건, "${statusLine(fit).slice(-40)}"`);
  db3.close();
}

// ══ G. 계약 열두 키 ═══════════════════════════════════════════
{
  const CONTRACT = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'contracts', 'fixtures', 'public-tools.json'), 'utf8'));
  const want = [...CONTRACT.tools.status.returns].sort();
  const got = Object.keys(s).sort();
  ok('G1-twelve-keys', JSON.stringify(want) === JSON.stringify(got),
    `${got.length}개 — ${got.join(' ')}`);
}

ok('H1-no-network', networkAttempts === 0, `네트워크 시도 ${networkAttempts}회`);

db.close();

const failed = results.filter((r) => !r.pass);
if (AS_JSON) {
  process.stdout.write(`${JSON.stringify({ pass: failed.length === 0, total: results.length, failed: failed.length, results }, null, 2)}\n`);
} else {
  for (const r of results) process.stdout.write(`${r.pass ? 'PASS' : 'FAIL'}  ${r.id}\n        ${r.detail}\n`);
  process.stdout.write(`\n${failed.length === 0 ? 'PASS' : 'FAIL'} — ${results.length - failed.length}/${results.length}\n`);
}
process.exit(failed.length === 0 ? 0 : 1);
