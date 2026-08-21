#!/usr/bin/env node
// lib/import.mjs 단위 시험 — 입력 방식이 달라도 같은 레코드가 나오는가.
//
//   node tests/unit/import.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseInput, summarizeRejections, ImportError, MAX_URLS_INLINE } from '../../lib/import.mjs';
import { PathError } from '../../lib/paths.mjs';

const results = [];
const ok = (id, pass, detail) => results.push({ id, pass, detail });
function throwsWith(code, fn) {
  try { fn(); return { pass: false, detail: '던지지 않았다' }; } catch (e) {
    if (!(e instanceof ImportError) && !(e instanceof PathError)) return { pass: false, detail: `뜻밖의 오류: ${e.message.slice(0, 80)}` };
    return { pass: e.code === code, detail: `code=${e.code}${e.code === code ? '' : ` (기대 ${code})`}` };
  }
}

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'import-unit-'));
const OUTSIDE = fs.mkdtempSync(path.join(os.tmpdir(), 'import-out-'));
process.on('exit', () => {
  for (const d of [ROOT, OUTSIDE]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* 이미 없으면 그만 */ } }
});
const write = (name, text) => { const p = path.join(ROOT, name); fs.writeFileSync(p, text); return name; };

// ── 세 입력이 같은 레코드로 ───────────────────────────────────

const THREE = ['https://example.com/a', 'https://example.com/b', 'https://example.com/c'];
{
  const inline = parseInput(ROOT, { urls: THREE });
  write('three.jsonl', THREE.map((u) => JSON.stringify({ url: u })).join('\n'));
  const jsonl = parseInput(ROOT, { file: 'three.jsonl' });
  write('three.csv', `url,note\n${THREE.map((u) => `${u},메모`).join('\n')}`);
  const csv = parseInput(ROOT, { file: 'three.csv' });

  const same = [inline, jsonl, csv].every((r) => JSON.stringify(r.records.map((x) => x.url)) === JSON.stringify(THREE));
  ok('I1-same-records', same, `배열·JSONL·CSV 모두 ${THREE.length}개 같은 순서`);
  ok('I2-source-kind', inline.source.kind === 'inline' && jsonl.source.kind === 'jsonl' && csv.source.kind === 'csv',
    `${inline.source.kind}·${jsonl.source.kind}·${csv.source.kind}`);
  ok('I3-line-numbers', jsonl.records[2].line === 3 && csv.records[2].line === 4,
    `JSONL 셋째 줄 ${jsonl.records[2].line} · CSV 셋째 값은 머리글 다음이라 ${csv.records[2].line}행`);
}

// ── JSONL 여러 모양 ───────────────────────────────────────────

{
  write('mixed.jsonl', [
    '{"url":"https://example.com/1"}',
    '"https://example.com/2"',
    'https://example.com/3',
    '',
    '   ',
    '{"link":"https://example.com/4"}',
    '{"href":"https://example.com/5"}',
    '{"no_url_here":1}',
    '{깨진 json',
    '[1,2,3]',
  ].join('\n'));
  const r = parseInput(ROOT, { file: 'mixed.jsonl' });
  ok('I4-jsonl-shapes', r.records.length === 5 && r.records.map((x) => x.url).join(',') === 'https://example.com/1,https://example.com/2,https://example.com/3,https://example.com/4,https://example.com/5',
    `읽은 것 ${r.records.length}개`);
  ok('I5-jsonl-rejected', r.rejected.length === 3 && r.received === 8,
    `거절 ${r.rejected.length}건(줄 ${r.rejected.map((x) => x.line).join(',')}) · 빈 줄은 세지 않아 받은 것 ${r.received}`);
  ok('I6-reject-has-reason', r.rejected.every((x) => x.reason && x.line > 0),
    r.rejected.map((x) => `${x.line}행: ${x.reason.slice(0, 30)}`).join(' / '));
}

// ── CSV 함정 ──────────────────────────────────────────────────

{
  write('quoted.csv', 'name,url\n"콤마, 있음",https://example.com/q1\n"따옴표 ""안"" 있음",https://example.com/q2');
  const r = parseInput(ROOT, { file: 'quoted.csv' });
  ok('I7-csv-quotes', r.records.length === 2 && r.records[1].url === 'https://example.com/q2', `${r.records.length}개`);

  write('broken.csv', 'url,note\nhttps://example.com/ok,fine\n,빈칸\nhttps://example.com/x,a,b\n"안닫힘,x');
  const b = parseInput(ROOT, { file: 'broken.csv' });
  ok('I8-csv-broken-rows', b.records.length === 1 && b.rejected.length === 3,
    `정상 ${b.records.length} · 거절 ${b.rejected.length} — ${b.rejected.map((x) => `${x.line}행`).join(',')}`);

  const noCol = throwsWith('csv_no_url_column', () => { write('nocol.csv', 'name,note\na,b'); return parseInput(ROOT, { file: 'nocol.csv' }); });
  ok('I9-csv-needs-url-column', noCol.pass, noCol.detail);

  write('altcol.csv', 'ID,Link\n1,https://example.com/alt');
  const alt = parseInput(ROOT, { file: 'altcol.csv' });
  ok('I10-csv-url-column-alias', alt.records.length === 1 && alt.source.detail.url_column === 'Link', `열 이름 ${alt.source.detail.url_column}`);

  write('empty.csv', '');
  const empty = parseInput(ROOT, { file: 'empty.csv' });
  ok('I11-csv-empty', empty.records.length === 0 && empty.rejected.length === 0 && empty.source.detail.empty === true, '빈 파일은 0건');
}

// ── 경계와 상한 ───────────────────────────────────────────────

{
  const outFile = path.join(OUTSIDE, 'secret.jsonl');
  fs.writeFileSync(outFile, '{"url":"https://example.com/secret"}');
  const out = throwsWith('input_outside_workspace', () => parseInput(ROOT, { file: outFile }));
  ok('I12-outside-rejected', out.pass, out.detail);
  const trav = throwsWith('input_outside_workspace', () => parseInput(ROOT, { file: '../../etc/hosts' }));
  ok('I13-traversal-rejected', trav.pass, trav.detail);
  const missing = throwsWith('input_missing', () => parseInput(ROOT, { file: 'nope.jsonl' }));
  ok('I14-missing-rejected', missing.pass, missing.detail);

  const both = throwsWith('both_inputs', () => parseInput(ROOT, { urls: ['https://example.com/'], file: 'three.jsonl' }));
  ok('I15-both-rejected', both.pass, both.detail);
  const none = throwsWith('no_input', () => parseInput(ROOT, {}));
  ok('I16-none-rejected', none.pass, none.detail);

  const many = throwsWith('too_many_inline', () => parseInput(ROOT, { urls: new Array(MAX_URLS_INLINE + 1).fill('https://example.com/x') }));
  ok('I17-inline-cap', many.pass, `${many.detail} — 많으면 파일로 주라고 알린다`);
}

// ── 큰 파일도 줄 번호가 어긋나지 않는가 ───────────────────────

{
  const N = 10_000;
  const lines = [];
  for (let i = 0; i < N; i++) lines.push(i % 1000 === 500 ? '{깨진 줄' : `{"url":"https://big.example.com/${i}"}`);
  write('big.jsonl', lines.join('\n'));
  const r = parseInput(ROOT, { file: 'big.jsonl' });
  ok('I18-large-file', r.records.length === N - 10 && r.rejected.length === 10 && r.received === N,
    `받은 것 ${r.received} · 정상 ${r.records.length} · 거절 ${r.rejected.length}`);
  ok('I19-line-numbers-hold', r.rejected[0].line === 501 && r.rejected[9].line === 9501,
    `첫 거절 ${r.rejected[0].line}행 · 마지막 ${r.rejected[9].line}행`);
}

// ── 사유 요약 ─────────────────────────────────────────────────

{
  const rejected = [
    { line: 3, reason: '칸 수가 머리글과 다릅니다 (2 ≠ 3)' },
    { line: 9, reason: '칸 수가 머리글과 다릅니다 (4 ≠ 3)' },
    { line: 11, reason: 'URL 칸이 비었습니다' },
  ];
  const s = summarizeRejections(rejected);
  ok('I20-summary-groups', s.length === 2 && s[0].count === 2 && s[0].first_line === 3,
    `${s.length}갈래 · 으뜸 ${s[0].count}건(첫 줄 ${s[0].first_line}) — 숫자만 다른 사유는 한 갈래로 묶는다`);
}

// ── 출력 ──────────────────────────────────────────────────────

for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.id} — ${r.detail}`);
const failed = results.filter((r) => !r.pass);
console.log(failed.length === 0 ? `PASS  입력 파서 단위 시험 ${results.length}항목 통과` : `FAIL  ${failed.length}건`);
process.exit(failed.length === 0 ? 0 : 1);
