#!/usr/bin/env node
// export 시험 — 태스크 #41.
//
//   node tests/export/verify.mjs
//   node tests/export/verify.mjs --json
//
// 완료 조건이 "DB 기대 행 수와 두 형식 파싱 결과가 일치한다" 이므로, 파일을 쓰고 크기만 재면
// 아무것도 증명하지 못한다. **두 형식을 도로 읽어** DB 와 맞춰 본다.
// CSV 는 여기서 직접 파싱한다 — 쓰는 쪽과 읽는 쪽이 같은 코드면 둘 다 틀려도 맞아떨어진다.
//
// 일부러 까다로운 값을 넣는다: 쉼표 · 큰따옴표 · 줄바꿈 · 빈 값 · 상충 판정 · 0행.
//
// 네트워크는 쓰지 않는다. 마지막 항목이 그 사실을 판정한다.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { writeArtifact } from '../../lib/artifacts.mjs';
import { finishAttempt, startAttempt } from '../../lib/attempts.mjs';
import { createDb } from '../../lib/db.mjs';
import { DEFAULT_FIELDS, EXPORT_FIELDS, csvCell, runExport } from '../../lib/export.mjs';
import { addUrls } from '../../lib/items.mjs';
import { recordJudgments } from '../../lib/judgments.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AS_JSON = process.argv.includes('--json');

let networkAttempts = 0;
globalThis.fetch = (...a) => {
  networkAttempts++;
  throw new Error(`이 시험은 네트워크를 쓰지 않는다: fetch(${String(a[0]).slice(0, 60)})`);
};

const results = [];
const ok = (id, pass, detail) => results.push({ id, pass: Boolean(pass), detail: String(detail) });
async function rejectsWith(code, fn) {
  try { await fn(); return { pass: false, detail: '던지지 않았다' }; } catch (e) {
    return { pass: e?.code === code, detail: `code=${e?.code}${e?.code === code ? '' : ` (기대 ${code})`}` };
  }
}

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'export-unit-'));
process.on('exit', () => { try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* 이미 없으면 그만 */ } });

const T0 = 1_700_000_000_000;

// ── CSV 를 도로 읽는다 (RFC 4180) ─────────────────────────────
// 쓰는 쪽과 다른 코드로 읽어야 왕복 확인에 뜻이 있다.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cur = '';
  let quoted = false;
  let i = 0;
  // 마지막 줄 끝만 걷어 낸다. '\n' 한 글자만 떼면 CRLF 로 끝난 파일에서 '\r' 이 마지막 칸에 남는다.
  const body = text.replace(/\r\n$|\n$/, '');
  while (i < body.length) {
    const c = body[i];
    if (quoted) {
      if (c === '"') {
        if (body[i + 1] === '"') { cur += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      cur += c; i++; continue;
    }
    if (c === '"') { quoted = true; i++; continue; }
    if (c === ',') { row.push(cur); cur = ''; i++; continue; }
    if (c === '\r' && body[i + 1] === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; i += 2; continue; }
    cur += c; i++;
  }
  row.push(cur);
  rows.push(row);
  return rows;
}

const readJsonl = (abs) => fs.readFileSync(abs, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));

// ── 자료 ──────────────────────────────────────────────────────
// 까다로운 값이 여러 칸에 흩어져 있어야 한다. 한 곳만 어렵게 하면 그 한 곳만 증명된다.
const NASTY_NOTE = '쉼표, 그리고 "따옴표"\n둘째 줄';
const NASTY_LABEL = '후보, 확인 필요';
const SEARCH_QUERY = '수제 청첩장, 서울';

async function build() {
  const root = path.join(SANDBOX, 'ws');
  fs.mkdirSync(root, { recursive: true });
  const db = createDb(root, path.join(root, 'workspace.db'), {
    workspaceId: '2026-08-12-export', projectRoot: SANDBOX, briefPath: path.join(root, 'brief.md'), nowMs: T0,
  });

  addUrls(db, [{ url: 'https://alpha.example/one' }, { url: 'https://alpha.example/two' }],
    { source_kind: 'seed', source_value: 'manual', nowMs: T0 });
  addUrls(db, [{ url: 'https://beta.example/three' }], { source_kind: 'search', source_value: SEARCH_QUERY, nowMs: T0 });
  addUrls(db, [{ url: 'https://beta.example/four' }], { source_kind: 'sitemap', source_value: 'https://beta.example/sitemap.xml', nowMs: T0 });

  // item 1 — 성공 수집 · 근거 파일 · 상충 판정 둘
  const a1 = startAttempt(db, { itemId: 1, operation: 'collect', collector: 'http', requestedOutputs: ['text'], requestedUrl: 'https://alpha.example/one', nowMs: T0 });
  const art = await writeArtifact(db, { root, attemptId: a1.attempt_id, kind: 'text', name: 'page.txt', data: 'SECRET-BODY-MARKER 본문 전체\n', nowMs: T0 });
  finishAttempt(db, { attemptId: a1.attempt_id, result: 'success', httpStatus: 200, warningCodes: ['redirected'], nowMs: T0 + 10 });
  db.prepare('UPDATE items SET collected_at = ?, work_state = ? WHERE item_id = 1').run(T0 + 10, 'done');
  recordJudgments(db, root, {
    workerId: 'w1', nowMs: T0 + 20,
    judgments: [{ item_id: 1, label: NASTY_LABEL, confidence: 0.9, evidence_artifact_ids: [art.artifact_id], note: NASTY_NOTE }],
  });
  recordJudgments(db, root, {
    workerId: 'w2', nowMs: T0 + 30,
    judgments: [{ item_id: 1, label: '제외', confidence: 0.2, evidence_artifact_ids: [], note: '재고 없음' }],
  });

  // item 2 — 실패 수집 · 오류 코드와 경고
  const a2 = startAttempt(db, { itemId: 2, operation: 'collect', collector: 'http', requestedOutputs: ['text'], requestedUrl: 'https://alpha.example/two', nowMs: T0 });
  finishAttempt(db, {
    attemptId: a2.attempt_id, result: 'failed', errorStage: 'transport', errorCode: 'connect_timeout',
    warningCodes: ['slow_response'], nowMs: T0 + 20,
  });
  db.prepare("UPDATE items SET work_state = 'failed' WHERE item_id = 2").run();

  // item 3 — 검색에서 나왔고 아직 대기. 수집도 판정도 없다(빈 값 자리)
  // item 4 — sitemap 에서 나왔고 대기
  return { root, db, artifactPath: art.path };
}

const { root, db, artifactPath } = await build();
const dbItems = db.prepare('SELECT item_id, canonical_url, domain, work_state FROM items ORDER BY item_id').all();

// ══ A. 두 형식이 같은 말을 한다 ═══════════════════════════════
{
  const j = await runExport(db, root, { format: 'jsonl', nowMs: T0 + 1000 });
  const c = await runExport(db, root, { format: 'csv', nowMs: T0 + 2000 });
  const jrows = readJsonl(path.join(root, j.path));
  const crows = parseCsv(fs.readFileSync(path.join(root, c.path), 'utf8'));
  const header = crows[0];
  const cbody = crows.slice(1);

  ok('A1-row-count', j.rows === dbItems.length && jrows.length === dbItems.length && cbody.length === dbItems.length,
    `DB item ${dbItems.length}개 · jsonl ${jrows.length}줄 · csv ${cbody.length}줄`);

  ok('A2-default-fields', JSON.stringify(header) === JSON.stringify(DEFAULT_FIELDS)
    && JSON.stringify(Object.keys(jrows[0])) === JSON.stringify(DEFAULT_FIELDS),
    `기본 칸 ${header.length}개 — ${header.join(' ')}`);

  // 같은 값인지 칸마다 맞춰 본다. 배열·객체는 CSV 에서 JSON 글자로 들어간다.
  const mismatches = [];
  jrows.forEach((jr, n) => {
    header.forEach((f, k) => {
      const want = typeof jr[f] === 'object' && jr[f] !== null ? JSON.stringify(jr[f]) : String(jr[f] ?? '');
      if (cbody[n][k] !== want) mismatches.push(`${n + 1}행 ${f}: csv="${cbody[n][k]}" ≠ jsonl="${want}"`);
    });
  });
  ok('A3-two-formats-agree', mismatches.length === 0, mismatches.length ? mismatches.slice(0, 3).join(' / ') : `${jrows.length}줄 × ${header.length}칸 전부 일치`);

  ok('A4-anchor-always', jrows.every((r) => Number.isInteger(r.item_id)), '모든 줄에 item_id 가 있다');
}

// ══ B. 칸 고르기 ══════════════════════════════════════════════
{
  const r = await runExport(db, root, { format: 'jsonl', fields: ['canonical_url', 'labels'], nowMs: T0 + 3000 });
  const rows = readJsonl(path.join(root, r.path));
  ok('B1-anchor-prepended', JSON.stringify(Object.keys(rows[0])) === JSON.stringify(['item_id', 'canonical_url', 'labels']),
    `item_id 를 안 골라도 앞에 붙는다 — ${Object.keys(rows[0]).join(' ')}`);

  const bad = await rejectsWith('unknown_field', () => runExport(db, root, { format: 'jsonl', fields: ['canonical_url', 'titel'], nowMs: T0 + 3100 }));
  ok('B2-unknown-field-is-error', bad.pass, `${bad.detail} — 오타 난 칸이 조용히 빠지지 않는다`);

  const empty = await rejectsWith('bad_fields', () => runExport(db, root, { format: 'jsonl', fields: [], nowMs: T0 + 3200 }));
  ok('B3-empty-fields', empty.pass, empty.detail);

  ok('B4-field-catalog', EXPORT_FIELDS.length === 19 && EXPORT_FIELDS.includes('manifest_paths') && EXPORT_FIELDS.includes('artifact_paths'),
    `고를 수 있는 칸 ${EXPORT_FIELDS.length}개 (되짚기용 경로 칸 포함)`);
}

// ══ C. 거르기 ═════════════════════════════════════════════════
{
  const state = await runExport(db, root, { format: 'jsonl', filter_state: 'done', nowMs: T0 + 4000 });
  ok('C1-state', state.rows === 1 && JSON.stringify(state.filter_summary.state) === '["done"]',
    `state=done → ${state.rows}줄 (전체 ${state.filter_summary.total_items})`);

  const two = await runExport(db, root, { format: 'jsonl', filter_state: 'done,failed', nowMs: T0 + 4100 });
  ok('C2-state-list', two.rows === 2, `state=done,failed → ${two.rows}줄`);

  const domain = await runExport(db, root, { format: 'jsonl', filter_domain: 'beta.example', nowMs: T0 + 4200 });
  ok('C3-domain', domain.rows === 2, `domain=beta.example → ${domain.rows}줄`);

  // 라벨과 출처 값은 사람이 쓴 글이라 쉼표가 들어간다. 쪼개서 읽으면 아무것도 못 찾는다.
  const label = await runExport(db, root, { format: 'jsonl', filter_label: NASTY_LABEL, nowMs: T0 + 4300 });
  ok('C4-label', label.rows === 1 && label.filter_summary.label === NASTY_LABEL,
    `쉼표가 든 라벨을 통째로 한 값으로 읽는다 → ${label.rows}줄`);

  const kind = await runExport(db, root, { format: 'jsonl', filter_source: 'search', nowMs: T0 + 4400 });
  const exact = await runExport(db, root, { format: 'jsonl', filter_source: `search:${SEARCH_QUERY}`, nowMs: T0 + 4500 });
  ok('C5-source', kind.rows === 1 && exact.rows === 1, `source=search → ${kind.rows}줄 · 검색어까지 지정 → ${exact.rows}줄`);

  const warn = await runExport(db, root, { format: 'jsonl', filter_warning: 'slow_response', nowMs: T0 + 4600 });
  ok('C6-warning', warn.rows === 1 && readJsonl(path.join(root, warn.path))[0].item_id === 2,
    `warning=slow_response → item ${readJsonl(path.join(root, warn.path))[0].item_id}`);

  const both = await runExport(db, root, { format: 'jsonl', filter_state: 'queued', filter_domain: 'beta.example', nowMs: T0 + 4700 });
  ok('C7-combined', both.rows === 2 && both.filter_summary.state && both.filter_summary.domain,
    `state=queued + domain=beta.example → ${both.rows}줄 · 요약에 조건 둘 다 있다`);

  const nope = await rejectsWith('unknown_state', () => runExport(db, root, { format: 'jsonl', filter_state: 'finished', nowMs: T0 + 4800 }));
  const nosrc = await rejectsWith('unknown_source', () => runExport(db, root, { format: 'jsonl', filter_source: 'rss', nowMs: T0 + 4900 }));
  ok('C8-unknown-filter-is-error', nope.pass && nosrc.pass,
    `${nope.detail} · ${nosrc.detail} — 오타가 "0줄" 로 둔갑하지 않는다`);
}

// ══ D. 0행도 파일이다 ═════════════════════════════════════════
{
  const none = await runExport(db, root, { format: 'csv', filter_domain: 'nowhere.example', nowMs: T0 + 5000 });
  const abs = path.join(root, none.path);
  const text = fs.readFileSync(abs, 'utf8');
  const rows = parseCsv(text);
  ok('D1-zero-rows', none.rows === 0 && fs.existsSync(abs)
    && rows.length === 1 && JSON.stringify(rows[0]) === JSON.stringify(DEFAULT_FIELDS),
    `0줄이어도 파일이 있고 머리글만 있다 (${text.length}바이트)`);
  ok('D2-zero-says-why', JSON.stringify(none.filter_summary.domain) === '["nowhere.example"]'
    && none.filter_summary.total_items === dbItems.length && none.filter_summary.matched === 0,
    `요약이 "무엇을 걸러 0줄" 인지 말한다 — 전체 ${none.filter_summary.total_items} 중 ${none.filter_summary.matched}`);

  const jnone = await runExport(db, root, { format: 'jsonl', filter_domain: 'nowhere.example', nowMs: T0 + 5100 });
  ok('D3-zero-jsonl-empty', fs.readFileSync(path.join(root, jnone.path), 'utf8') === '',
    'jsonl 0줄은 빈 파일이다 — 빈 줄 하나도 넣지 않는다');
}

// ══ E. 까다로운 값이 왕복한다 ═════════════════════════════════
{
  const r = await runExport(db, root, {
    format: 'csv', fields: ['canonical_url', 'labels', 'judgments', 'collected_at'], filter_state: 'done', nowMs: T0 + 6000,
  });
  const rows = parseCsv(fs.readFileSync(path.join(root, r.path), 'utf8'));
  const header = rows[0];
  const cell = (name) => rows[1][header.indexOf(name)];
  const labels = JSON.parse(cell('labels'));
  const judgments = JSON.parse(cell('judgments'));

  ok('E1-nasty-roundtrip', labels.includes(NASTY_LABEL) && judgments.some((j) => j.note === NASTY_NOTE),
    `쉼표·따옴표·줄바꿈이 CSV 를 지나 그대로 돌아온다 (라벨 ${labels.length}개 · 판정 ${judgments.length}줄)`);

  ok('E2-conflict-kept', labels.length === 2 && new Set(labels).size === 2
    && judgments.map((j) => j.worker_id).join(',') === 'w1,w2',
    `상충 판정을 하나로 줄이지 않는다 — ${labels.map((l) => l.slice(0, 8)).join(' / ')}`);

  ok('E3-evidence-in-row', judgments[0].evidence_artifact_ids.length === 1,
    '판정마다 근거 artifact 번호가 그대로 실린다');

  // 빈 값: 아직 수집 안 한 항목의 collected_at
  const q = await runExport(db, root, { format: 'csv', fields: ['collected_at', 'labels'], filter_state: 'queued', nowMs: T0 + 6100 });
  const qrows = parseCsv(fs.readFileSync(path.join(root, q.path), 'utf8'));
  const qj = await runExport(db, root, { format: 'jsonl', fields: ['collected_at', 'labels'], filter_state: 'queued', nowMs: T0 + 6200 });
  const qjrows = readJsonl(path.join(root, qj.path));
  ok('E4-empty-values', qrows[1][qrows[0].indexOf('collected_at')] === '' && qjrows[0].collected_at === null
    && qrows[1][qrows[0].indexOf('labels')] === '[]',
    'CSV 는 빈 칸 · JSONL 은 null — 빈 배열은 [] 로 그대로');

  ok('E5-csv-cell', csvCell('a,b') === '"a,b"' && csvCell('그는 "말했다"') === '"그는 ""말했다"""'
    && csvCell('줄\n바꿈') === '"줄\n바꿈"' && csvCell(null) === '' && csvCell(3) === '3',
    'RFC 4180 — 감싸기와 따옴표 겹치기');
}

// ══ F. 원본을 복사하지 않고 덮어쓰지 않는다 ═══════════════════
{
  const r = await runExport(db, root, { format: 'jsonl', fields: ['artifact_paths', 'manifest_paths'], nowMs: T0 + 7000 });
  const text = fs.readFileSync(path.join(root, r.path), 'utf8');
  const rows = readJsonl(path.join(root, r.path));

  ok('F1-no-original-copied', !text.includes('SECRET-BODY-MARKER') && text.includes(artifactPath),
    `본문은 안 들어오고 경로만 들어온다 — "${artifactPath}"`);

  const withPath = rows.find((x) => x.artifact_paths.length > 0);
  ok('F2-path-resolves', fs.existsSync(path.join(root, withPath.artifact_paths[0]))
    && fs.existsSync(path.join(root, withPath.manifest_paths[0].replace('/manifest.json', ''))),
    '적힌 경로로 실제 파일 자리에 닿는다');

  // 같은 시각에 두 번 내보내도 앞의 것이 살아 있다
  const first = await runExport(db, root, { format: 'jsonl', nowMs: T0 + 8000 });
  const firstText = fs.readFileSync(path.join(root, first.path), 'utf8');
  const second = await runExport(db, root, { format: 'jsonl', filter_state: 'done', nowMs: T0 + 8000 });
  ok('F3-never-overwrite', first.path !== second.path
    && fs.readFileSync(path.join(root, first.path), 'utf8') === firstText,
    `같은 시각에 두 번 내도 ${path.basename(first.path)} 와 ${path.basename(second.path)} 로 갈린다`);

  const last = db.prepare("SELECT value FROM meta WHERE key = 'last_export'").get().value;
  ok('F4-last-export-recorded', last === second.path, `meta.last_export = ${last}`);

  const files = fs.readdirSync(path.join(root, 'exports')).filter((n) => !n.startsWith('.'));
  ok('F5-all-kept', files.length >= 15, `지난 export 가 지워지지 않고 ${files.length}개 남아 있다`);
}

// ══ G. 네트워크 ═══════════════════════════════════════════════
ok('G1-no-network', networkAttempts === 0, `네트워크 시도 ${networkAttempts}회`);

db.close();

// ── 판정 ──────────────────────────────────────────────────────
const failed = results.filter((r) => !r.pass);
if (AS_JSON) {
  process.stdout.write(`${JSON.stringify({ pass: failed.length === 0, total: results.length, failed: failed.length, results }, null, 2)}\n`);
} else {
  for (const r of results) process.stdout.write(`${r.pass ? 'PASS' : 'FAIL'}  ${r.id}\n        ${r.detail}\n`);
  process.stdout.write(`\n${failed.length === 0 ? 'PASS' : 'FAIL'} — ${results.length - failed.length}/${results.length}\n`);
}
process.exit(failed.length === 0 ? 0 : 1);
