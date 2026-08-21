#!/usr/bin/env node
// 1차 거짓 성공 네 사례의 회귀 fixture 검증 — 네트워크 0회.
//
//   node tests/fixtures/false-success/verify.mjs
//
// 이 시험은 "구현이 고쳐졌는가"를 보지 않는다. 아직 구현이 없다.
// 보는 것은 "무엇이 잘못이었고 무엇이 옳은 결과인지가 기계가 읽을 수 있게 고정됐는가"이다.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOL_ROOT = path.resolve(HERE, '..', '..', '..');

// ── 네트워크 차단 — 이 시험이 도는 동안 바깥으로 나가면 실패한다 ──
let networkAttempts = 0;
const blocked = (what) => (...args) => {
  networkAttempts++;
  throw new Error(`이 시험은 네트워크를 쓰지 않는다: ${what}(${String(args[0]).slice(0, 60)})`);
};
globalThis.fetch = blocked('fetch');
if (typeof globalThis.XMLHttpRequest !== 'undefined') globalThis.XMLHttpRequest = blocked('XMLHttpRequest');
if (typeof globalThis.WebSocket !== 'undefined') globalThis.WebSocket = blocked('WebSocket');

const CASES = [
  'A-status-200-error-page',
  'B-requested-final-mismatch',
  'C-visible-cards-extractor-zero',
  'D-false-complete-unvisited-112',
];
const NAMES = {
  'A-status-200-error-page': 'R-FALSE-200-ERROR',
  'B-requested-final-mismatch': 'R-FALSE-REDIRECT-MISMATCH',
  'C-visible-cards-extractor-zero': 'R-FALSE-CARDS-ZERO',
  'D-false-complete-unvisited-112': 'R-FALSE-COMPLETE-UNVISITED',
};
const REQUIRED_FIELDS = ['schema', 'id', 'source_evidence', 'old_behavior', 'inputs', 'new_expectation', 'regression_name'];

const results = [];
const ok = (id, pass, detail) => results.push({ id, pass, detail });

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const sha256 = (p) => createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const keysDeep = (v, out = []) => {
  if (Array.isArray(v)) v.forEach((x) => keysDeep(x, out));
  else if (v && typeof v === 'object') for (const [k, val] of Object.entries(v)) { out.push(k); keysDeep(val, out); }
  return out;
};

// ── 1. 네 사례가 정확히 있고 필수 필드를 갖췄는가 ─────────────

const dirs = fs.readdirSync(HERE, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
ok('F1-case-set', JSON.stringify(dirs) === JSON.stringify([...CASES].sort()), `폴더 ${dirs.join(', ')}`);

const cases = {};
{
  const problems = [];
  for (const id of CASES) {
    const p = path.join(HERE, id, 'case.json');
    if (!fs.existsSync(p)) { problems.push(`${id}: case.json 없음`); continue; }
    const c = readJson(p);
    cases[id] = c;
    for (const f of REQUIRED_FIELDS) if (c[f] === undefined) problems.push(`${id}: ${f} 없음`);
    if (c.id !== id) problems.push(`${id}: id 가 폴더 이름과 다름(${c.id})`);
    if (c.regression_name !== NAMES[id]) problems.push(`${id}: 회귀 이름 ${c.regression_name} ≠ ${NAMES[id]}`);
  }
  ok('F2-required-fields', problems.length === 0, problems.length ? problems.join(', ') : `네 사례 모두 ${REQUIRED_FIELDS.length}개 필수 필드와 회귀 이름 일치`);
}

// ── 2. 입력 파일이 실재하고 크기·지문이 적힌 값과 같은가 ──────

{
  const problems = [];
  let count = 0;
  for (const id of CASES) {
    for (const input of cases[id]?.inputs ?? []) {
      const abs = path.join(HERE, id, input.path);
      if (!fs.existsSync(abs)) { problems.push(`${id}/${input.path}: 없음`); continue; }
      count++;
      const bytes = fs.statSync(abs).size;
      if (bytes !== input.bytes) problems.push(`${id}/${input.path}: 크기 ${bytes} ≠ ${input.bytes}`);
      const hash = sha256(abs);
      if (hash !== input.sha256) problems.push(`${id}/${input.path}: 지문 ${hash.slice(0, 12)} ≠ ${input.sha256.slice(0, 12)}`);
    }
  }
  ok('F3-inputs-exist-and-match', problems.length === 0, problems.length ? problems.join(', ') : `입력 ${count}개 크기·지문 일치`);
}

// ── 3. 근거로 든 LEGACY 파일과 줄이 실재하는가 ────────────────

{
  const problems = [];
  let checked = 0;
  for (const id of CASES) {
    for (const e of cases[id]?.source_evidence ?? []) {
      if (!e.file?.startsWith('LEGACY/')) continue;      // 대화 기록 근거는 파일이 없다
      const abs = path.join(TOOL_ROOT, e.file);
      if (!fs.existsSync(abs)) { problems.push(`${id}: ${e.file} 없음`); continue; }
      checked++;
      if (e.line != null) {
        const lines = fs.readFileSync(abs, 'utf8').split('\n').length;
        if (e.line > lines) problems.push(`${id}: ${e.file}:${e.line} 은 파일 길이 ${lines} 를 넘음`);
      }
    }
  }
  ok('F4-evidence-files', problems.length === 0, problems.length ? problems.join(', ') : `LEGACY 근거 ${checked}건 파일·줄 실재`);
}

// ── 4. 새 기대에 금지 필드가 없고, 사실과 판정이 갈려 있는가 ──

{
  const problems = [];
  for (const id of CASES) {
    const c = cases[id];
    const ne = c.new_expectation ?? {};
    const keys = new Set(keysDeep(ne));
    for (const banned of ne.must_not_contain ?? []) {
      if (keys.has(banned)) problems.push(`${id}: 금지 필드 ${banned} 가 새 기대에 있음`);
    }
    if (!(ne.transport || ne.status_report)) problems.push(`${id}: 관측 사실 절(transport·status_report)이 없음`);
    if (!('judgment' in ne) || ne.judgment !== null) problems.push(`${id}: judgment 가 null 이 아님`);
    if (ne.judgment_owner !== 'agent') problems.push(`${id}: judgment_owner 가 agent 가 아님`);
    if (!(c.old_behavior?.fields_that_should_not_exist ?? []).length) problems.push(`${id}: 옛 잘못 필드 목록이 비었음`);
  }
  ok('F5-fact-judgment-split', problems.length === 0, problems.length ? problems.join(', ') : '네 사례 모두 사실·판정 분리, 금지 필드 0');
}

// ── 5. 사례별 알맹이 ──────────────────────────────────────────

{
  const c = cases['A-status-200-error-page'];
  const t = readJson(path.join(HERE, c.id, 'input/transport.json'));
  const htmlPath = path.join(HERE, c.id, 'input/page.html');
  const html = fs.readFileSync(htmlPath, 'utf8');
  const problems = [];
  if (t.http_status !== 200) problems.push(`입력 상태가 200 이 아님(${t.http_status})`);
  if (t.requested_url !== t.final_url) problems.push('A 는 리다이렉트 사례가 아니어야 한다');
  if (t.body_byte_size !== fs.statSync(htmlPath).size) {
    problems.push(`body_byte_size ${t.body_byte_size} ≠ page.html 실제 ${fs.statSync(htmlPath).size}`);
  }
  if (!/Whoops|went wrong/i.test(html)) problems.push('본문에 오류 문구가 없음');
  if (c.new_expectation.collect_result !== 'success') problems.push('수집 자체는 success 여야 한다');
  if (!(c.new_expectation.warning_codes ?? []).length) problems.push('warning 이 비었음');
  if (c.new_expectation.review_required !== true) problems.push('review_required 가 true 가 아님');
  ok('F6-caseA-200-error', problems.length === 0,
    problems.length ? problems.join(', ') : `상태 200 · 본문에 오류 문구 · success + warning ${c.new_expectation.warning_codes.join(',')} + review_required`);
}

{
  const c = cases['B-requested-final-mismatch'];
  const r = readJson(path.join(HERE, c.id, 'input/redirect-chain.json'));
  const problems = [];
  if (r.requested_url === r.final_url) problems.push('requested 와 final 이 같음');
  if (c.new_expectation.transport.requested_url === c.new_expectation.transport.final_url) problems.push('새 기대에서도 같음');
  if (c.new_expectation.requested_equals_final !== false) problems.push('requested_equals_final 이 false 가 아님');
  if ((r.redirect_chain ?? []).length < 2) problems.push('리다이렉트 홉이 2 미만');
  if (r.redirect_chain.at(-1).status !== 200) problems.push('마지막 홉이 200 이 아님');
  const finalHtml = path.join(HERE, c.id, 'input/final-page.html');
  if (r.body_byte_size !== fs.statSync(finalHtml).size) {
    problems.push(`body_byte_size ${r.body_byte_size} ≠ final-page.html 실제 ${fs.statSync(finalHtml).size}`);
  }
  if (!(c.new_expectation.warning_codes ?? []).includes('redirected')) problems.push('redirected warning 이 없음');
  ok('F7-caseB-redirect', problems.length === 0,
    problems.length ? problems.join(', ') : `${r.requested_url} → ${r.final_url} · 홉 ${r.redirect_chain.length} · warning ${c.new_expectation.warning_codes.join(',')}`);
}

{
  const c = cases['C-visible-cards-extractor-zero'];
  const html = fs.readFileSync(path.join(HERE, c.id, 'input/listing.html'), 'utf8');
  const legacy = readJson(path.join(HERE, c.id, 'input/legacy-extraction.json'));
  const visible = (html.match(/<article class="card">/g) ?? []).length;
  const problems = [];
  if (visible !== c.visible_card_count) problems.push(`문서의 카드 ${visible} ≠ 적힌 ${c.visible_card_count}`);
  if (visible <= 0) problems.push('보이는 카드가 0');
  if (legacy.ledger_cards !== 0) problems.push(`옛 추출 결과가 0 이 아님(${legacy.ledger_cards})`);
  if (c.legacy_extracted_count !== 0) problems.push('legacy_extracted_count 가 0 이 아님');
  if (/https?:\/\//.test(html.replace(/http:\/\/www\.w3\.org\/2000\/svg/g, ''))) problems.push('바깥 주소를 참조함');
  for (const need of ['dom', 'screenshot']) {
    if (!(c.new_expectation.artifacts_preserved ?? []).includes(need)) problems.push(`원본 보존 목록에 ${need} 없음`);
  }
  if (c.new_expectation.core_does_not_count_cards !== true) problems.push('core 가 카드를 세지 않는다는 계약이 없음');

  // screenshot 을 보존한다고 적었으면 실제 시각 표본이 입력에 있어야 한다
  const shotPath = path.join(HERE, c.id, 'input/screenshot.svg');
  if ((c.new_expectation.artifacts_present ?? []).includes('screenshot')) {
    if (!fs.existsSync(shotPath)) problems.push('screenshot 을 주장하는데 시각 표본 파일이 없음');
    else {
      if (!(c.inputs ?? []).some((i) => i.path === 'input/screenshot.svg')) problems.push('시각 표본이 inputs 해시 목록에 없음');
      const svg = fs.readFileSync(shotPath, 'utf8');
      const cells = (svg.match(/<rect x="/g) ?? []).length;
      if (cells !== visible) problems.push(`시각 표본의 칸 ${cells} ≠ 문서의 카드 ${visible}`);
      if (/https?:\/\//.test(svg.replace(/http:\/\/www\.w3\.org\/2000\/svg/g, ''))) problems.push('시각 표본이 바깥 주소를 참조함');
    }
  }
  ok('F8-caseC-visible-cards', problems.length === 0,
    problems.length ? problems.join(', ') : `보이는 카드 ${visible} · 시각 표본 칸 ${(fs.readFileSync(shotPath, 'utf8').match(/<rect x="/g) ?? []).length} · 옛 추출 ${legacy.ledger_cards} · 원본 ${c.new_expectation.artifacts_preserved.join('·')} 보존`);
}

{
  const c = cases['D-false-complete-unvisited-112'];
  const state = readJson(path.join(HERE, c.id, 'input/legacy-state.json'));
  const events = fs.readFileSync(path.join(HERE, c.id, 'input/events.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const seen = events.reduce((s, e) => s + (e.links_seen ?? 0), 0);
  const added = events.reduce((s, e) => s + (e.links_added ?? 0), 0);
  const sr = c.new_expectation.status_report ?? {};
  const problems = [];
  if (seen !== 112) problems.push(`events 의 links_seen 합이 ${seen}`);
  if (added !== 0) problems.push(`links_added 합이 ${added}`);
  if (c.unvisited_discovered !== 112) problems.push('case.json 의 112 가 아님');
  if (c.unvisited_breakdown.reduce((a, b) => a + b, 0) !== 112) problems.push('내역 합이 112 가 아님');
  if (state.completion !== 'complete') problems.push('옛 장부가 complete 가 아니면 이 사례가 성립하지 않음');
  if (sr.queued !== 0 || sr.leased !== 0) problems.push('대기·임대가 0 이 아님');
  if (sr.workspace_drained !== true) problems.push('workspace_drained 가 true 가 아님');
  for (const banned of ['research_complete', 'goal_achieved', 'auto_complete', 'completion']) {
    if (keysDeep(c.new_expectation).includes(banned)) problems.push(`새 기대에 ${banned} 가 있음`);
  }

  // status 는 #2 계약의 열두 키만 쓴다. 112 는 status 가 아니라 관측 보존 쪽에 있어야 한다.
  const contract = readJson(path.join(TOOL_ROOT, 'tests/contracts/fixtures/public-tools.json'));
  const allowed = new Set(contract.tools.status.returns);
  const outside = Object.keys(sr).filter((k) => !allowed.has(k));
  if (outside.length) problems.push(`status_report 에 계약 외 필드: ${outside.join(', ')}`);
  const po = c.new_expectation.preserved_observation ?? {};
  if (po.unvisited_discovered !== 112) problems.push('preserved_observation 에 112 가 없음');
  if (po.breakdown?.reduce((a, b) => a + b, 0) !== 112) problems.push('preserved_observation 내역 합이 112 가 아님');
  if (po.must_survive !== true) problems.push('112 가 살아남아야 한다는 계약이 없음');

  // done=5 의 근거 — label=null 판정 다섯 건이 반납됐다
  const judgments = fs.readFileSync(path.join(HERE, c.id, 'input/judgments.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l));
  if (judgments.length !== sr.done) problems.push(`판정 ${judgments.length}건 ≠ done ${sr.done}`);
  if (judgments.length !== c.new_expectation.judgments_stored) problems.push('judgments_stored 가 실제 건수와 다름');
  if (!judgments.every((j) => j.label === null && j.confidence === null)) problems.push('label·confidence 가 모두 null 이 아님');
  if (!judgments.every((j) => (j.evidence_artifact_ids ?? []).length > 0 && j.note)) problems.push('근거나 메모가 빠진 판정이 있음');
  if (sr.awaiting_report !== 0) problems.push('report 를 받았으므로 awaiting_report 는 0 이어야 함');

  ok('F9-caseD-false-complete', problems.length === 0,
    problems.length ? problems.join(', ')
      : `events 합 ${seen}(${c.unvisited_breakdown.join('+')}) · 들인 것 ${added} · 옛 completion=${state.completion}`
        + ` → status 는 계약 열두 키만(workspace_drained=true, done=${sr.done}, awaiting_report=0),`
        + ` 112 는 preserved_observation 에 보존, label=null 판정 ${judgments.length}건`);
}

// ── 6. 네트워크 0회 증명 ──────────────────────────────────────

{
  const files = [];
  const stack = [HERE];
  while (stack.length) {
    const dir = stack.pop();
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(p); else files.push(p);
    }
  }
  const BANNED = [
    "node:http", "node:https", "node:net", "node:tls", "node:dgram",
    "require('http')", 'require("http")', "playwright", "puppeteer", "XMLHttpRequest(",
  ];
  // 이 검증기 자신은 금지 문자열을 목록으로 들고 있어야 하므로 본문 검사에서 뺀다.
  // 대신 아래에서 import 를 허용 목록과 정확히 대조해 스스로도 빠져나가지 못하게 한다.
  const SELF = fileURLToPath(import.meta.url);
  const hits = [];
  for (const f of files.filter((x) => x !== SELF)) {
    const text = fs.readFileSync(f, 'utf8');
    for (const b of BANNED) if (text.includes(b)) hits.push(`${path.relative(HERE, f)}: ${b}`);
    if (/\bfetch\s*\(/.test(text)) hits.push(`${path.relative(HERE, f)}: fetch(`);
  }
  ok('F10-no-network-imports', hits.length === 0,
    hits.length ? hits.join(', ') : `fixture 파일 ${files.length - 1}개(검증기 제외)에 http·https·net·fetch·playwright 참조 0`);

  const ALLOWED_IMPORTS = ['node:crypto', 'node:fs', 'node:path', 'node:url'];
  const selfImports = [...fs.readFileSync(SELF, 'utf8').matchAll(/^import[^;]*?from\s*'([^']+)'/gm)].map((m) => m[1]).sort();
  ok('F10b-verifier-imports', JSON.stringify(selfImports) === JSON.stringify(ALLOWED_IMPORTS),
    `검증기 자신의 import: ${selfImports.join(', ')} (허용: ${ALLOWED_IMPORTS.join(', ')})`);
  ok('F11-no-network-calls', networkAttempts === 0,
    `실행 중 네트워크 호출 시도 ${networkAttempts}회 (fetch·XMLHttpRequest·WebSocket 을 던지도록 바꿔 두고 셌다)`);
}

// ── 출력 ──────────────────────────────────────────────────────

for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.id} — ${r.detail}`);
const failed = results.filter((r) => !r.pass);
console.log(`사례 ${CASES.length}개 · 회귀 이름 ${Object.values(NAMES).join(', ')}`);
console.log(failed.length === 0 ? 'PASS  네 거짓 성공 사례가 회귀 fixture 로 고정됐다' : `FAIL  ${failed.length}건`);
process.exit(failed.length === 0 ? 0 : 1);
