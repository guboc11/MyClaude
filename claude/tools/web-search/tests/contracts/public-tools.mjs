#!/usr/bin/env node
// 공개 10개 버튼 계약 시험 — 구현보다 먼저 기준을 고정한다.
//
//   node tests/contracts/public-tools.mjs                    # 본시험. 구현 전에는 RED(exit 1)가 정상
//   node tests/contracts/public-tools.mjs --red-state        # RED 원인이 "도구 미구현" 하나뿐인지 확인(exit 0)
//   node tests/contracts/public-tools.mjs --json             # 결과를 JSON 으로
//   node tests/contracts/public-tools.mjs --server <경로>    # 다른 구현을 겨눠 계약 자체를 대조
//
// 실패마다 scope(공개 도구 이름 또는 tools/list)와 reason 을 붙인다. --red-state 는 그 범위를 검사한다.
// MCP 순서를 지킨다: initialize 응답 → initialized → tools/list 응답 → tools/call.
// 서버는 임시 디렉터리를 cwd 이자 CLAUDE_PROJECT_DIR 로 띄우고, 끝나면 그 디렉터리만 지운다.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOL_ROOT = path.resolve(HERE, '..', '..');
const FIXTURE = path.join(HERE, 'fixtures', 'public-tools.json');

// 기본은 등록된 진입점. --server 는 계약이 위반을 실제로 잡는지 대조 서버로 확인하기 위한 것이다.
const serverArg = process.argv.indexOf('--server');
const SERVER = serverArg !== -1 ? path.resolve(process.argv[serverArg + 1]) : path.join(TOOL_ROOT, 'server.mjs');

const spec = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
const EXPECTED = spec.public_tool_names;
const MAX_BYTES = spec.response_contract.max_bytes;

// 키 순서에 흔들리지 않는 깊은 비교.
const canon = (v) => {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
};
const same = (a, b) => canon(a) === canon(b);
const sorted = (a) => [...(a ?? [])].sort();
const typeList = (t) => sorted(Array.isArray(t) ? t : [t]);

// ── 임시 디렉터리는 내가 만든 것만, 어느 종료 경로에서든 지운다 ──

let probeDir = null;
let probePath = null;
function cleanupProbe() {
  if (!probeDir) return;              // 중복 호출 안전
  const target = probeDir;
  probeDir = null;
  try { fs.rmSync(target, { recursive: true, force: true }); } catch { /* 이미 없으면 그만 */ }
}
process.on('exit', cleanupProbe);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { cleanupProbe(); process.exit(130); });

// ── 순서를 지키는 MCP stdio 클라이언트 ─────────────────────────

function connect(cwd) {
  const child = spawn('node', [SERVER], {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd,
    // cwd 와 프로젝트 루트를 모두 임시 경로로 고정한다. 시험이 실제 프로젝트에 workspace 를 만들면 안 된다.
    env: { ...process.env, CLAUDE_PROJECT_DIR: cwd },
  });
  const pending = new Map();
  let buffer = '';
  let stderr = '';
  let nextId = 1;

  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (!line) continue;
      let msg = null;
      try { msg = JSON.parse(line); } catch { continue; }
      const waiter = msg.id != null && pending.get(msg.id);
      if (waiter) { pending.delete(msg.id); waiter({ msg, bytes: Buffer.byteLength(line, 'utf8') }); }
    }
  });
  child.stderr.on('data', (c) => { stderr += c; });

  return {
    request(method, params, timeoutMs = 15000) {
      const id = nextId++;
      return new Promise((resolve) => {
        const timer = setTimeout(() => { pending.delete(id); resolve({ msg: null, bytes: 0, timeout: true }); }, timeoutMs);
        pending.set(id, (v) => { clearTimeout(timer); resolve(v); });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    },
    notify(method, params) { child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`); },
    stderr: () => stderr,
    close() { child.kill('SIGTERM'); },
  };
}

// ── 검사 장부 ─────────────────────────────────────────────────

const checks = [];
const add = (kind, id, scope, ok, reason, detail) => checks.push({ kind, id, scope, ok, reason: ok ? null : reason, detail });
const defer = (id, scope, why) => checks.push({ kind: 'deferred', id, scope, ok: null, reason: null, detail: why });

// ── 0. fixture 자체 일관성 — 여기서 틀리면 시험이 무의미하다 ──

{
  const toolKeys = Object.keys(spec.tools);
  add('fixture', 'F1-names-match-tools', 'fixture', same(sorted(EXPECTED), sorted(toolKeys)), 'fixture_names_mismatch',
    { public_tool_names: EXPECTED.length, tools: toolKeys.length });
  add('fixture', 'F2-ten-tools', 'fixture', EXPECTED.length === 10 && new Set(EXPECTED).size === 10, 'fixture_not_ten', { count: EXPECTED.length });

  const problems = [];
  for (const [name, t] of Object.entries(spec.tools)) {
    const req = t.required ?? [];
    const opt = t.optional ?? [];
    const overlap = req.filter((f) => opt.includes(f));
    if (overlap.length) problems.push({ name, what: 'required_optional_overlap', overlap });
    if (new Set(req).size !== req.length || new Set(opt).size !== opt.length) problems.push({ name, what: 'duplicate_field' });
    for (const f of t.one_of ?? []) if (!opt.includes(f)) problems.push({ name, what: 'one_of_not_in_optional', field: f });
    if (!(t.returns ?? []).length) problems.push({ name, what: 'returns_empty' });
    for (const f of t.returns ?? []) if (spec.forbidden.return_fields.includes(f)) problems.push({ name, what: 'return_field_forbidden', field: f });
    const ji = t.judgment_item;
    if (ji && !same(sorted(Object.keys(ji.types ?? {})), sorted(ji.properties))) problems.push({ name, what: 'judgment_types_incomplete' });
    if (t.conditional && !(t.conditional.branches ?? []).length) problems.push({ name, what: 'conditional_empty' });
  }
  for (const key of Object.keys(spec.enums)) if (!spec.tools[key.split('.')[0]]) problems.push({ name: key, what: 'enum_for_unknown_tool' });
  add('fixture', 'F3-field-consistency', 'fixture', problems.length === 0, 'fixture_field_problem', problems);
  add('fixture', 'F4-max-bytes', 'fixture', MAX_BYTES === 4096, 'fixture_max_bytes', { max_bytes: MAX_BYTES });
  add('fixture', 'F5-forbidden-lists', 'fixture',
    spec.forbidden.tool_names.length > 0 && spec.forbidden.input_fields.length > 0 && spec.forbidden.return_fields.length > 0,
    'fixture_forbidden_empty', null);
}

if (checks.some((c) => c.kind === 'fixture' && !c.ok)) {
  for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  [fixture] ${c.id}${c.ok ? '' : ` — ${c.reason} ${JSON.stringify(c.detail)}`}`);
  console.log('중단  fixture 가 자기모순이라 서버 검사를 진행하지 않습니다');
  process.exit(2);
}

// ── 1. 실제 handshake ─────────────────────────────────────────

probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'websearch-contract-'));
probePath = probeDir;
const mcp = connect(probeDir);

const initReply = await mcp.request('initialize', {
  protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'public-tools-contract', version: '3' },
});
{
  const r = initReply.msg?.result;
  const ok = !!r && typeof r.protocolVersion === 'string'
    && typeof r.serverInfo?.name === 'string' && typeof r.serverInfo?.version === 'string';
  add('positive', 'C0-initialize', 'tools/list', ok, 'initialize_failed', {
    timeout: !!initReply.timeout,
    protocolVersion: r?.protocolVersion ?? null,
    serverInfo: r?.serverInfo ?? null,
  });
}

mcp.notify('notifications/initialized');
const listReply = await mcp.request('tools/list', {});

const listed = listReply.msg?.result?.tools ?? [];
const byName = new Map(listed.map((t) => [t.name, t]));
const names = listed.map((t) => t.name).sort();
const missing = EXPECTED.filter((n) => !byName.has(n));
const extra = names.filter((n) => !EXPECTED.includes(n));

add('positive', 'C1-tools-list', 'tools/list',
  listed.length === EXPECTED.length && missing.length === 0 && extra.length === 0,
  'tools_list_mismatch', { expected: EXPECTED.length, actual: listed.length, missing, extra });

// ── 2. 입력 스키마를 정확히 비교한다 ──────────────────────────

for (const name of EXPECTED) {
  const tool = byName.get(name);
  if (!tool) { add('positive', `C2-input:${name}`, name, false, 'tool_missing', { name }); continue; }

  const want = spec.tools[name];
  const schema = tool.inputSchema ?? {};
  const props = schema.properties ?? {};
  const problems = [];

  const wantProps = sorted([...(want.required ?? []), ...(want.optional ?? [])]);
  if (!same(sorted(Object.keys(props)), wantProps)) problems.push({ what: 'properties', expected: wantProps, actual: sorted(Object.keys(props)) });
  if (!same(sorted(schema.required), sorted(want.required))) problems.push({ what: 'required', expected: sorted(want.required), actual: sorted(schema.required) });
  if (schema.additionalProperties !== spec.input_schema_policy.additional_properties) {
    problems.push({ what: 'additionalProperties', expected: spec.input_schema_policy.additional_properties, actual: schema.additionalProperties });
  }

  if (want.one_of) {
    const kw = spec.input_schema_policy.one_of_keyword;
    const branches = (schema[kw] ?? []).map((b) => sorted(b.required));
    if (!same(sorted(branches.map((b) => b.join(','))), sorted(want.one_of.map((f) => f)))) {
      problems.push({ what: kw, expected: want.one_of.map((f) => [f]), actual: branches });
    }
  }

  for (const [key, allowed] of Object.entries(spec.enums)) {
    const [t, field] = key.split('.');
    if (t !== name) continue;
    const declared = props[field]?.enum ?? props[field]?.items?.enum ?? null;
    if (!declared || !same(sorted(declared), sorted(allowed))) problems.push({ what: `enum:${field}`, expected: allowed, actual: declared });
  }

  for (const [field, rule] of Object.entries(want.property_rules ?? {})) {
    for (const [k, v] of Object.entries(rule)) {
      if (props[field]?.[k] !== v) problems.push({ what: `${field}.${k}`, expected: v, actual: props[field]?.[k] });
    }
  }

  // 조건부 계약 — mode=http 이면 screenshot 금지. 구조를 그대로 비교한다.
  if (want.conditional) {
    const kw = want.conditional.keyword;
    if (!same(schema[kw], want.conditional.branches)) {
      problems.push({ what: `conditional:${kw}`, expected: want.conditional.branches, actual: schema[kw] ?? null });
    }
  }

  // 판정 항목 — 이름·필수·null 허용 여부·중첩 additionalProperties 까지
  if (want.judgment_item) {
    const ji = want.judgment_item;
    const item = props.judgments?.items ?? {};
    const itemProps = item.properties ?? {};
    if (!same(sorted(Object.keys(itemProps)), sorted(ji.properties))) {
      problems.push({ what: 'judgment_item.properties', expected: sorted(ji.properties), actual: sorted(Object.keys(itemProps)) });
    }
    if (!same(sorted(item.required), sorted(ji.required))) {
      problems.push({ what: 'judgment_item.required', expected: sorted(ji.required), actual: sorted(item.required) });
    }
    if (item.additionalProperties !== ji.additional_properties) {
      problems.push({ what: 'judgment_item.additionalProperties', expected: ji.additional_properties, actual: item.additionalProperties });
    }
    for (const [field, wantType] of Object.entries(ji.types)) {
      const actual = itemProps[field]?.type;
      if (!same(typeList(wantType), typeList(actual))) {
        problems.push({ what: `judgment_item.type:${field}`, expected: typeList(wantType), actual: actual === undefined ? null : typeList(actual) });
      }
    }
  }

  add('positive', `C2-input:${name}`, name, problems.length === 0, 'input_schema_mismatch', problems);
}

// ── 3. 반환 계약을 outputSchema 로 선언했는지 ─────────────────

for (const name of EXPECTED) {
  const tool = byName.get(name);
  if (!tool) { add('positive', `C3-output:${name}`, name, false, 'tool_missing', { name }); continue; }

  const want = sorted(spec.tools[name].returns);
  const out = tool.outputSchema ?? null;
  const problems = [];
  if (!out) problems.push({ what: 'outputSchema', expected: 'declared', actual: null });
  else {
    if (!same(sorted(Object.keys(out.properties ?? {})), want)) {
      problems.push({ what: 'output.properties', expected: want, actual: sorted(Object.keys(out.properties ?? {})) });
    }
    if (!same(sorted(out.required), want)) problems.push({ what: 'output.required', expected: want, actual: sorted(out.required) });
    const banned = Object.keys(out.properties ?? {}).filter((f) => spec.forbidden.return_fields.includes(f));
    if (banned.length) problems.push({ what: 'forbidden_return_field', banned });
  }
  add('positive', `C3-output:${name}`, name, problems.length === 0, 'output_schema_mismatch', problems);
}

// ── 4. 실제 성공 응답 — 짧고, 선언한 키만 담는다 ──────────────
// 새 workspace 하나만으로 오프라인에서 성공할 수 있는 도구만 지금 검사한다.

const LIVE_PROBE = ['workspace_new', 'add_urls', 'status', 'next', 'export'];
const DEFERRED_TO = {
  search: '게이트 5 — 검색 공급자 확정 뒤',
  map_domain: '게이트 4 — 실제 도메인 지도에서',
  collect: '게이트 3 — 유효한 lease 로 수집한 뒤',
  report: '게이트 2 — 유효한 lease 와 판정으로',
  retry: '게이트 2 — 실패 item 이 생긴 뒤',
};

function responseProblems(reply, name) {
  const result = reply.msg?.result;
  const problems = [];
  if (!result) problems.push({ what: 'no_result', timeout: !!reply.timeout });
  else {
    if (result.isError === true) problems.push({ what: 'not_success', isError: true });
    const sc = result.structuredContent;
    if (!sc || typeof sc !== 'object') problems.push({ what: 'structuredContent', expected: 'object', actual: sc === undefined ? null : typeof sc });
    else if (!same(sorted(Object.keys(sc)), sorted(spec.tools[name].returns))) {
      problems.push({ what: 'structuredContent.keys', expected: sorted(spec.tools[name].returns), actual: sorted(Object.keys(sc)) });
    }
    const leaked = spec.response_contract.forbidden_substrings.filter((s) => JSON.stringify(result).includes(s));
    if (leaked.length) problems.push({ what: 'raw_content_leaked', leaked });
  }
  if (reply.bytes > MAX_BYTES) problems.push({ what: 'too_large', bytes: reply.bytes, max: MAX_BYTES });
  return problems;
}

{
  let liveWorkspace = null;
  if (byName.has('workspace_new')) {
    const r = await mcp.request('tools/call', {
      name: 'workspace_new', arguments: { topic: 'contract-probe', brief: '계약 시험용 임시 workspace' },
    });
    const problems = responseProblems(r, 'workspace_new');
    add('positive', 'C4-response:workspace_new', 'workspace_new', problems.length === 0, 'response_contract', problems);
    liveWorkspace = r.msg?.result?.structuredContent?.workspace_id ?? null;
  } else {
    add('positive', 'C4-response:workspace_new', 'workspace_new', false, 'tool_missing', { name: 'workspace_new' });
  }

  const LIVE_ARGS = (ws) => ({
    add_urls: { workspace: ws, source_kind: 'seed', source_value: 'contract-probe', urls: ['https://example.com/'] },
    status: { workspace: ws },
    next: { workspace: ws, worker_id: 'contract-probe' },
    export: { workspace: ws, format: 'jsonl' },
  });

  for (const name of LIVE_PROBE.filter((n) => n !== 'workspace_new')) {
    if (!byName.has(name)) { add('positive', `C4-response:${name}`, name, false, 'tool_missing', { name }); continue; }
    if (!liveWorkspace) { add('positive', `C4-response:${name}`, name, false, 'probe_workspace_failed', { need: 'workspace_new 성공' }); continue; }
    const r = await mcp.request('tools/call', { name, arguments: LIVE_ARGS(liveWorkspace)[name] });
    const problems = responseProblems(r, name);
    add('positive', `C4-response:${name}`, name, problems.length === 0, 'response_contract', problems);
  }

  for (const [name, why] of Object.entries(DEFERRED_TO)) defer(`C4-response:${name}`, name, why);
}

// 조건부 계약의 실제 거절은 유효한 workspace·lease 와 요청 계수가 있어야 확인할 수 있다.
{
  const combo = spec.input_combinations.find((c) => c.id === 'collect-screenshot-requires-browser');
  defer('C5-runtime:collect-screenshot', 'collect', combo.runtime_verified_at);
}

// ── 5. 부정 시험 — 지금도 통과해야 한다 ───────────────────────

{
  const hit = names.filter((n) => spec.forbidden.tool_names.includes(n));
  add('negative', 'N1-forbidden-tool-names', 'tools/list', hit.length === 0, 'forbidden_tool_exposed', { hit });
}
{
  const hit = [];
  for (const tool of listed) {
    for (const field of Object.keys(tool.inputSchema?.properties ?? {})) {
      if (spec.forbidden.input_fields.includes(field)) hit.push(`${tool.name}.${field}`);
    }
  }
  add('negative', 'N2-forbidden-input-fields', 'tools/list', hit.length === 0, 'forbidden_input_field', { hit });
}
{
  const hit = [];
  for (const [key, banned] of Object.entries(spec.forbidden.enum_values)) {
    const [t, field] = key.split('.');
    const declared = byName.get(t)?.inputSchema?.properties?.[field]?.enum ?? [];
    for (const v of declared) if (banned.includes(v)) hit.push(`${key}=${v}`);
  }
  add('negative', 'N3-forbidden-enum-values', 'tools/list', hit.length === 0, 'forbidden_enum_value', { hit });
}
{
  const hit = [];
  for (const tool of listed) {
    for (const field of Object.keys(tool.outputSchema?.properties ?? {})) {
      if (spec.forbidden.return_fields.includes(field)) hit.push(`${tool.name}.${field}`);
    }
  }
  add('negative', 'N4-forbidden-return-fields', 'tools/list', hit.length === 0, 'forbidden_return_field', { hit });
}
{
  const r = await mcp.request('tools/call', { name: 'no_such_tool', arguments: {} });
  add('negative', 'N5-unknown-tool-rejected', 'tools/list', r.msg?.result?.isError === true, 'unknown_tool_accepted', { isError: r.msg?.result?.isError ?? null });
}
{
  // node:sqlite 가 실험 기능이라 뜨는 경고는 알려진 것이라 허용한다(#5 에 한계로 기록됨).
  // 그 밖의 stderr 는 서버가 조용히 깨지고 있다는 신호이므로 그대로 실패로 둔다.
  const ALLOWED_STDERR = [
    /ExperimentalWarning: SQLite is an experimental feature/,
    /Use `node --trace-warnings \.\.\.` to show where the warning was created/,
  ];
  const unexpected = mcp.stderr().split('\n').map((l) => l.trim()).filter(Boolean)
    .filter((l) => !ALLOWED_STDERR.some((re) => re.test(l)));
  add('negative', 'N6-clean-stderr', 'tools/list', unexpected.length === 0, 'stderr_not_empty',
    { unexpected: unexpected.slice(0, 3), allowed_known_warnings: mcp.stderr().trim() !== '' });
}

// ── 출력 ──────────────────────────────────────────────────────

mcp.close();
cleanupProbe();
const probeRemoved = !fs.existsSync(probePath);

const graded = checks.filter((c) => c.kind !== 'deferred');
const failed = graded.filter((c) => !c.ok);
const failedPositive = failed.filter((c) => c.kind === 'positive');
const failedNegative = failed.filter((c) => c.kind === 'negative');
const deferred = checks.filter((c) => c.kind === 'deferred');
const mode = process.argv.includes('--red-state') ? 'red-state' : 'contract';
const asJson = process.argv.includes('--json');

if (asJson) {
  console.log(JSON.stringify({ mode, server: SERVER, probe_dir: probePath, probe_dir_removed: probeRemoved, listed: names, missing, extra, checks }, null, 2));
}

if (mode === 'contract') {
  if (!asJson) {
    console.log(`공개 도구 기대 ${EXPECTED.length} · 실제 ${listed.length} · 없음 ${missing.length} · 초과 ${extra.length}`);
    for (const c of graded) console.log(`${c.ok ? 'PASS' : 'FAIL'}  [${c.kind}] ${c.id}${c.ok ? '' : ` — ${c.reason}`}`);
    for (const c of deferred) console.log(`DEFER [${c.scope}] ${c.id} — ${c.detail}`);
    console.log(`임시 probe 디렉터리 정리됨: ${probeRemoved ? '예' : '아니오'} (${probePath})`);
    console.log(failed.length === 0
      ? `GREEN  채점 ${graded.length}건 전부 통과 · 뒤로 미룬 검사 ${deferred.length}건`
      : `RED  ${failed.length}건 실패 (양성 ${failedPositive.length} · 부정 ${failedNegative.length}) · 뒤로 미룬 검사 ${deferred.length}건`);
  }
  process.exit(failed.length === 0 ? 0 : 1);
}

// 구현이 하나씩 붙으면 "0개" 는 더 이상 기준이 못 된다. 살아남는 불변식은 이것이다 —
// 실패는 "아직 만들지 않은 버튼" 에서만 나오고, 만든 버튼은 계약을 전부 지킨다.
// --expect-missing 으로 아직 없는 버튼을 명시한다. 기본값은 열 개 전부(구현 전 상태).
const missArg = process.argv.indexOf('--expect-missing');
const EXPECT_MISSING = missArg !== -1
  ? process.argv[missArg + 1].split(',').map((s) => s.trim()).filter(Boolean)
  : [...EXPECTED];
const EXPECT_IMPLEMENTED = EXPECTED.filter((n) => !EXPECT_MISSING.includes(n));

const ALLOWED_SCOPES = new Set([...EXPECT_MISSING, 'tools/list']);
const ALLOWED_REASONS = new Set(['tools_list_mismatch', 'tool_missing']);
const c1 = graded.find((c) => c.id === 'C1-tools-list');
const implementedFailures = failed.filter((c) => EXPECT_IMPLEMENTED.includes(c.scope));

const asserts = [
  ['fixture 자체 검사 통과', checks.filter((c) => c.kind === 'fixture').every((c) => c.ok)],
  ['initialize 정상 응답', graded.find((c) => c.id === 'C0-initialize').ok === true],
  ['기대 10개', c1.detail.expected === 10],
  [`공개 도구 ${EXPECT_IMPLEMENTED.length}개`, listed.length === EXPECT_IMPLEMENTED.length],
  [`없는 도구 정확히 ${EXPECT_MISSING.length}개`,
    missing.length === EXPECT_MISSING.length && EXPECT_MISSING.every((n) => missing.includes(n))],
  ['초과 도구 0개', extra.length === 0],
  ['실패 scope 가 미구현 버튼과 tools/list 안', failed.every((c) => ALLOWED_SCOPES.has(c.scope))],
  ['실패 원인이 미구현 계열뿐', failed.every((c) => ALLOWED_REASONS.has(c.reason))],
  ['구현된 버튼은 계약을 전부 지킴', implementedFailures.length === 0],
  ['부정 시험은 전부 통과', failedNegative.length === 0],
  ['양성 실패가 실제로 존재(빈 통과 아님)', failedPositive.length > 0 || EXPECT_MISSING.length === 0],
  ['임시 probe 디렉터리 정리됨', probeRemoved],
];

if (!asJson) {
  for (const [label, ok] of asserts) console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  console.log(`구현됨 [${EXPECT_IMPLEMENTED.join(', ') || '없음'}] · 미구현 [${EXPECT_MISSING.join(', ') || '없음'}]`);
  console.log(`실패 원인 분포: ${JSON.stringify(Object.fromEntries(
    [...new Set(failed.map((c) => c.reason))].map((r) => [r, failed.filter((c) => c.reason === r).length]),
  ))}`);
}
const allOk = asserts.every(([, ok]) => ok);
console.log(allOk ? 'PASS  실패가 미구현 버튼에서만 나옵니다' : 'FAIL  실패 원인이 예상 범위를 벗어납니다');
process.exit(allOk ? 0 : 1);
