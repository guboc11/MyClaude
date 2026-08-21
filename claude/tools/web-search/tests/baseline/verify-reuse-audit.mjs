#!/usr/bin/env node
// 재사용 감사(#3) 자체 검증 — 표에 빠진 심볼이 없는지, 판정값이 셋뿐인지,
// 금지 목록이 자기모순은 아닌지, 그리고 그 규칙이 실제 코드에서 옳게 걸리는지 본다.
//
//   node tests/baseline/verify-reuse-audit.mjs          # 전체 검증
//   node tests/baseline/verify-reuse-audit.mjs --scan   # 새 runtime 의 금지 import·토큰 검사만

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOL_ROOT = path.resolve(HERE, '..', '..');
const AUDIT = path.join(HERE, 'reuse-audit.md');
const RULES = path.join(HERE, 'forbidden-imports.json');

const TARGETS = ['lib/url.mjs', 'lib/text.mjs', 'lib/pace.mjs', 'lib/browser.mjs', 'lib/discover.mjs'];
const VERDICTS = new Set(['reuse-as-is', 'copy-and-rewrite', 'reject']);

const results = [];
const ok = (id, pass, detail) => results.push({ id, pass, detail });

const rules = JSON.parse(fs.readFileSync(RULES, 'utf8'));

// ── 새 runtime 파일 목록 ──────────────────────────────────────

function runtimeFiles() {
  const out = [];
  const server = path.join(TOOL_ROOT, 'server.mjs');
  if (fs.existsSync(server)) out.push(server);
  const libDir = path.join(TOOL_ROOT, 'lib');
  if (fs.existsSync(libDir)) {
    const stack = [libDir];
    while (stack.length) {
      const dir = stack.pop();
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) stack.push(p);
        else if (e.isFile() && p.endsWith('.mjs')) out.push(p);
      }
    }
  }
  return out;
}

// ── 금지 규칙을 한 줄(코드)에 적용한다 ────────────────────────

function violationsInLine(line) {
  const hits = [];
  for (const rule of rules.forbidden_import_paths.legacy_origin) {
    if (/\b(import|require)\b|\bfrom\s*['"]/.test(line) && line.includes(rule.pattern)) {
      hits.push({ kind: 'legacy_origin', pattern: rule.pattern });
    }
  }
  for (const rule of rules.forbidden_import_paths.forbidden_names) {
    if (line.includes(rule.pattern)) hits.push({ kind: 'forbidden_name', pattern: rule.pattern });
  }
  for (const t of rules.forbidden_tokens) {
    if (line.includes(t.token)) hits.push({ kind: 'token', group: t.group, pattern: t.token });
  }
  return hits;
}

function scanRuntime() {
  const files = runtimeFiles();
  const found = [];
  for (const file of files) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      for (const h of violationsInLine(line)) {
        found.push({ file: path.relative(TOOL_ROOT, file), line: i + 1, ...h, text: line.trim().slice(0, 120) });
      }
    });
  }
  return { files: files.map((f) => path.relative(TOOL_ROOT, f)), found };
}

if (process.argv.includes('--scan')) {
  const { files, found } = scanRuntime();
  console.log(`검사 대상 runtime 파일 ${files.length}개: ${files.join(', ') || '(없음)'}`);
  for (const f of found) console.log(`위반 ${f.file}:${f.line} [${f.kind}] ${f.pattern} — ${f.text}`);
  console.log(found.length === 0
    ? `PASS  금지 import·토큰 0건${files.length <= 1 ? ' (아직 lib/ 가 없어 검사할 새 코드가 거의 없다)' : ''}`
    : `FAIL  금지 ${found.length}건`);
  process.exit(found.length === 0 ? 0 : 1);
}

// ── 1. 감사 표 파싱 ───────────────────────────────────────────

const md = fs.readFileSync(AUDIT, 'utf8');
const rows = [];
for (const line of md.split('\n')) {
  if (!line.startsWith('|')) continue;
  const cells = line.split('|').slice(1, -1).map((c) => c.trim());
  if (cells.length < 6) continue;
  const m = cells[0].match(/^`((?:lib|tests)\/[^:`]+):(\d+)`$/);
  if (!m) continue;
  rows.push({
    file: m[1], line: Number(m[2]),
    symbol: cells[1].replace(/`/g, '').replace(/\s*\(재export\)/, '').trim(),
    verdict: cells[2], reason: cells[3], home: cells[4], tests: cells[5],
  });
}
ok('V1-rows-parsed', rows.length >= 80, `표에서 읽은 행 ${rows.length}개`);

// ── 2. 판정값은 셋뿐 ──────────────────────────────────────────

{
  const bad = rows.filter((r) => !VERDICTS.has(r.verdict));
  ok('V2-verdict-vocabulary', bad.length === 0,
    bad.length ? bad.map((r) => `${r.file}:${r.line} → "${r.verdict}"`).join(', ') : '세 값 외 0건');
}

// ── 3. 근거와 회귀 시험이 빠진 행 0 ───────────────────────────

{
  const bad = rows.filter((r) => !r.reason || r.reason === '—' || !r.tests || r.tests === '—');
  ok('V3-reason-and-test', bad.length === 0,
    bad.length ? bad.map((r) => `${r.file}:${r.line} ${r.symbol}`).join(', ') : `모든 ${rows.length}행에 근거·시험 있음`);
}

// ── 4. 대상 파일의 심볼이 표에 하나도 빠지지 않았는지 ─────────

const SYMBOL_RE = /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)|^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=|^export\s*\{\s*([A-Za-z_$][\w$]*)/;
{
  const missing = [];
  let total = 0;
  for (const rel of TARGETS) {
    const abs = path.join(TOOL_ROOT, 'LEGACY', rel);
    const lines = fs.readFileSync(abs, 'utf8').split('\n');
    lines.forEach((line, i) => {
      const m = line.match(SYMBOL_RE);
      if (!m) return;
      const name = m[1] || m[2] || m[3];
      total++;
      const hit = rows.find((r) => r.file === rel && r.line === i + 1 && r.symbol === name);
      if (!hit) missing.push(`${rel}:${i + 1} ${name}`);
    });
  }
  ok('V4-symbol-coverage', missing.length === 0,
    missing.length ? `표에 없는 심볼 ${missing.length}개: ${missing.slice(0, 8).join(', ')}` : `대상 심볼 ${total}개 전부 표에 있음`);
}

// ── 5. 대상 파일과 임대 시험이 모두 등장하는지 ────────────────

{
  const files = new Set(rows.map((r) => r.file));
  const want = [...TARGETS, 'tests/gate1.mjs'];
  const absent = want.filter((f) => !files.has(f));
  ok('V5-target-files', absent.length === 0, absent.length ? `표에 없는 대상: ${absent.join(', ')}` : want.join(', '));
}

// ── 6. 임대 경합·만료·늦은 보고 세 성질이 실제로 다뤄졌는지 ───

{
  const leaseRows = rows.filter((r) => r.file === 'tests/gate1.mjs');
  const need = ['R-LEASE-1', 'R-LEASE-2', 'R-LEASE-3', 'R-LEASE-4'];
  const covered = need.filter((id) => leaseRows.some((r) => r.tests.includes(id)));
  ok('V6-lease-properties', covered.length === need.length,
    `임대 행 ${leaseRows.length}개 · 다룬 성질 ${covered.join(', ')}`);
}

// ── 7. 금지 목록 자체 검사 ────────────────────────────────────

{
  const problems = [];
  const paths = [
    ...rules.forbidden_import_paths.legacy_origin.map((r) => r.pattern),
    ...rules.forbidden_import_paths.forbidden_names.map((r) => r.pattern),
  ];
  if (new Set(paths).size !== paths.length) problems.push('경로 패턴 중복');
  const tokens = rules.forbidden_tokens.map((t) => t.token);
  if (new Set(tokens).size !== tokens.length) problems.push('토큰 중복');
  for (const g of rules.required_groups) {
    if (!rules.forbidden_tokens.some((t) => t.group === g)) problems.push(`필수 금지군 없음: ${g}`);
  }
  for (const t of rules.forbidden_tokens) if (!t.why) problems.push(`이유 없는 토큰: ${t.token}`);
  ok('V7-rules-consistency', problems.length === 0,
    problems.length ? problems.join(', ') : `경로 ${paths.length} · 토큰 ${tokens.length} · 필수 금지군 ${rules.required_groups.length} 모두 채움`);
}

// ── 8. 규칙이 실제 코드 줄에서 옳게 갈리는지 (자체 대조) ──────
// #8 은 새 lib/paths.mjs 를 만든다. 이름이 같다는 이유로 막으면 안 된다.

{
  const cases = [
    { line: "import { workspacePaths } from './paths.mjs';", expect: false, why: '#8 이 만드는 새 lib/paths.mjs — 허용' },
    { line: "import { crawlPaths } from '../LEGACY/lib/paths.mjs';", expect: true, why: 'LEGACY 옛 구현 — 금지' },
    { line: "import * as store from './store.mjs';", expect: false, why: 'v2 가 새로 쓰는 이름 — 허용' },
    { line: "import * as store from '../LEGACY/lib/store.mjs';", expect: true, why: 'LEGACY 옛 구현 — 금지' },
    { line: "import { classifyKind } from './kind.mjs';", expect: true, why: '이름 자체가 금지된 의미 모듈' },
    { line: "import { cardsFrom } from './cards.mjs';", expect: true, why: '카드 인식' },
    { line: "const res = await fetchOne(url);", expect: false, why: '금지 토큰이 아닌 평범한 호출 — 허용' },
    { line: "if (verdict.page_validity === 'content_validated') {", expect: true, why: '의미 판정 토큰' },
    { line: "await page.goto(url, { waitUntil: 'domcontentloaded' });", expect: false, why: '정상 브라우저 호출 — 허용' },
    { line: "const b = await chromium.launch({ headless: false, channel: 'chrome' });", expect: true, why: '실제 크롬 자동 실행' },
  ];
  const wrong = cases.filter((c) => (violationsInLine(c.line).length > 0) !== c.expect);
  ok('V8-rule-selftest', wrong.length === 0,
    wrong.length ? wrong.map((c) => `${c.why}: ${c.line}`).join(' / ') : `표본 ${cases.length}개 모두 기대대로 갈림`);
}

// ── 9. 지금 runtime 에 위반 0 ─────────────────────────────────

{
  const { files, found } = scanRuntime();
  ok('V9-runtime-clean', found.length === 0,
    `runtime 파일 ${files.length}개(${files.join(', ') || '없음'}) · 위반 ${found.length}건`
    + (files.length <= 1 ? ' — 아직 lib/ 가 없어 실질 검사는 #8 이후' : ''));
}

// ── 출력 ──────────────────────────────────────────────────────

for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.id} — ${r.detail}`);
const failed = results.filter((r) => !r.pass);

const counts = rows.reduce((acc, r) => { acc[r.verdict] = (acc[r.verdict] || 0) + 1; return acc; }, {});
console.log(`판정 분포: ${JSON.stringify(counts)} · 총 ${rows.length}행`);
console.log(failed.length === 0 ? 'PASS  감사 문서와 금지 목록 검증 통과' : `FAIL  ${failed.length}건`);
process.exit(failed.length === 0 ? 0 : 1);
