#!/usr/bin/env node
// 전환 확인 — 태스크 #48.
//
//   node tests/transition/verify.mjs
//   node tests/transition/verify.mjs --json
//
// 등록된 진입점이 새 core 를 부르는가, 옛 구현이 몰래 딸려 오지 않는가, 새 프로젝트에서
// 처음부터 끝까지 도는가를 본다.
//
// "옛 것을 안 부른다" 는 **두 번 확인한다.** 소스를 읽어 확인하고(정적),
// 실제로 띄운 뒤 그 프로세스가 연 파일을 세어 확인한다(실행 중). 소스만 보면
// 동적 import 를 놓치고, 실행만 보면 안 지나간 길을 놓친다.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PUBLIC_TOOL_NAMES } from '../../lib/tool-schemas.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOL_ROOT = path.resolve(HERE, '..', '..');
const SERVER = path.join(TOOL_ROOT, 'server.mjs');
const MANUAL = path.join(TOOL_ROOT, 'MANUAL.md');
const AS_JSON = process.argv.includes('--json');
const flag = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};
const PROJECT = path.resolve(flag('project') ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd());

/** 아직 없는 버튼. 없는 이유가 문서에 있어야 한다. */
const NOT_BUILT = ['search'];
/** 옛 구현에서 넘어오면 안 되는 이름들(계획서 1-3·9절). */
const FORBIDDEN_NAMES = ['LEGACY', 'cards', 'wake_details', 'domain-profile', 'domain_profile', 'pagination'];

const results = [];
const ok = (id, pass, detail) => results.push({ id, pass: Boolean(pass), detail: String(detail) });

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'transition-'));
process.on('exit', () => { try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* 이미 없으면 그만 */ } });

// 서버가 실제로 불러온 모듈을 여기 쌓는다(trace-hook.mjs).
const TRACE = path.join(SANDBOX, 'loaded-modules.txt');

// ── 등록된 그대로 띄운다 ──────────────────────────────────────
function startAsRegistered(projectDir) {
  const child = spawn(process.execPath, ['--import', path.join(HERE, 'trace-register.mjs'), SERVER], {
    cwd: projectDir,
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: projectDir,
      WEBSEARCH_DEPS_DIR: PROJECT,
      WEBSEARCH_TRACE_OUT: TRACE,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  let buf = '';
  const waiting = new Map();
  child.stdout.on('data', (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try { const m = JSON.parse(line); if (waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } } catch { /* 무시 */ }
    }
  });
  let id = 0;
  const call = (method, params, ms = 60_000) => new Promise((resolve, reject) => {
    const n = ++id;
    const t = setTimeout(() => reject(new Error(`${method} 응답 없음`)), ms);
    waiting.set(n, (m) => { clearTimeout(t); resolve(m); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: n, method, params })}\n`);
  });
  child.on('exit', () => { for (const [n, f] of waiting) { waiting.delete(n); f({ error: { message: '서버가 끝났다' } }); } });
  return {
    child, call,
    tool: (name, args) => call('tools/call', { name, arguments: args }),
    stderr: () => stderr,
    async stop() { child.kill('SIGTERM'); await new Promise((r) => { child.on('exit', r); setTimeout(r, 1500); }); },
  };
}

const project = path.join(SANDBOX, 'fresh-project');
fs.mkdirSync(project, { recursive: true });
spawnSync('git', ['init', '-q'], { cwd: project });

const mcp = startAsRegistered(project);
const init = await mcp.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'transition', version: '1' } });
mcp.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

// ══ T1 등록 진입점이 새 core 를 부른다 ═══════════════════════
{
  const info = init.result?.serverInfo ?? {};
  const listed = (await mcp.call('tools/list', {})).result.tools.map((t) => t.name).sort();
  const expected = PUBLIC_TOOL_NAMES.filter((n) => !NOT_BUILT.includes(n)).sort();
  ok('T1-entrypoint', info.name === 'web-search' && JSON.stringify(listed) === JSON.stringify(expected),
    `${info.name} ${info.version} · 버튼 ${listed.length}개: ${listed.join(' ')}`);
}

// ══ T2 계약은 열이고 낸 것은 아홉 ════════════════════════════
{
  const listed = (await mcp.call('tools/list', {})).result.tools.map((t) => t.name);
  const missing = PUBLIC_TOOL_NAMES.filter((n) => !listed.includes(n));
  // 계약(#2)은 열을 정했지만 search 는 만들지 않기로 했다(#6·게이트 5).
  // 없는 것을 목록에 내지 않는 것이 이 도구의 규율이라, 아홉이 맞는 상태다.
  ok('T2-nine-of-ten', PUBLIC_TOOL_NAMES.length === 10 && JSON.stringify(missing) === JSON.stringify(NOT_BUILT),
    `계약 ${PUBLIC_TOOL_NAMES.length}개 중 낸 것 ${listed.length}개 · 안 낸 것 ${missing.join(',')}`
    + ' — 무키 공급자가 없어 만들지 않았다(tests/reports/gate5.md)');
}

// ══ T3 안 만든 버튼을 부르면 갈 길을 알려 준다 ════════════════
{
  const r = (await mcp.tool('search', { workspace: 'x', queries: ['가나다'] })).result;
  const text = r.content?.[0]?.text ?? '';
  ok('T3-not-built-says-where-to-go', r.isError === true && text.includes('add_urls') && text.includes('decision.md'),
    `isError=${r.isError} · "${text.slice(0, 60)}…"`);
}

// ══ T4 새 프로젝트에서 처음부터 끝까지 ═══════════════════════
let workspaceId = null;
{
  const ws = (await mcp.tool('workspace_new', { topic: 'transition smoke', brief: '전환 확인용 빈 조사' })).result.structuredContent;
  workspaceId = ws.workspace_id;
  const added = (await mcp.tool('add_urls', {
    workspace: ws.workspace_id, source_kind: 'seed', source_value: '전환 확인',
    urls: ['https://example.com/a', 'https://example.com/b', 'https://example.com/a'],
  })).result.structuredContent;
  const st = (await mcp.tool('status', { workspace: ws.workspace_id })).result.structuredContent;
  const ex = (await mcp.tool('export', { workspace: ws.workspace_id, format: 'jsonl' })).result.structuredContent;
  const rows = fs.readFileSync(path.join(ws.workspace_path, ex.path), 'utf8').split('\n').filter(Boolean);
  ok('T4-smoke', added.added === 2 && added.duplicates === 1 && st.total === 2 && st.queued === 2
    && ex.rows === 2 && rows.length === 2,
    `workspace_new → add_urls(새 ${added.added}·중복 ${added.duplicates}) → status(전체 ${st.total})`
    + ` → export(${ex.rows}줄, 파일에도 ${rows.length}줄)`);
}

// ══ T5 새 프로젝트의 .gitignore 규칙 ═════════════════════════
{
  const lines = fs.readFileSync(path.join(project, '.gitignore'), 'utf8').split('\n').map((l) => l.trim());
  const hits = lines.filter((l) => l === '.claude/websearch-workspace/');
  const checked = spawnSync('git', ['check-ignore', '-q', '.claude/websearch-workspace/probe'], { cwd: project });
  ok('T5-gitignore', hits.length === 1 && checked.status === 0,
    `새 프로젝트에 규칙 ${hits.length}줄 · git 이 실제로 무시함(exit ${checked.status})`);
}

// ══ T6 실행 중에 옛 구현을 안 열었다 ═════════════════════════
{
  // 여기까지 오면 이 프로세스는 아홉 버튼 중 다섯을 실제로 지나왔다.
  // 그동안 **불러온 모듈**을 본다. 열린 파일을 세는 것으로는 안 된다 —
  // Node 는 모듈을 읽고 바로 닫아서, 실행 중에 열려 있는 .mjs 가 하나도 없다.
  const loaded = fs.existsSync(TRACE)
    ? [...new Set(fs.readFileSync(TRACE, 'utf8').split('\n').filter(Boolean))].map((u) => u.replace('file://', ''))
    : [];
  const fromTool = loaded.filter((p) => p.startsWith(TOOL_ROOT));
  const legacy = fromTool.filter((p) => p.includes(`${path.sep}LEGACY${path.sep}`));
  const collectLoaded = fromTool.some((p) => p.endsWith('lib/collect/index.mjs'));
  ok('T6-runtime-no-legacy', fromTool.length >= 20 && legacy.length === 0 && collectLoaded,
    `실행 중 불러온 이 도구의 모듈 ${fromTool.length}개(수집 계층 포함 ${collectLoaded})`
    + ` · 그중 LEGACY ${legacy.length}개`);
}

await mcp.stop();

// ══ T7 소스에도 옛 구현을 안 부른다 ══════════════════════════
{
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'LEGACY' || e.name === 'node_modules') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.mjs')) files.push(p);
    }
  };
  walk(path.join(TOOL_ROOT, 'lib'));
  files.push(SERVER);
  const hits = [];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8')
      .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of src.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) {
      const spec = m[1];
      if (FORBIDDEN_NAMES.some((n) => spec.includes(n))) hits.push(`${path.relative(TOOL_ROOT, f)} → ${spec}`);
    }
  }
  ok('T7-source-no-legacy', hits.length === 0,
    hits.length ? hits.join(' / ') : `lib·server 의 .mjs ${files.length}개에서 금지 이름 import 0건`);
}

// ══ T8 매뉴얼이 버튼을 다 적고, 없는 것도 적는다 ═════════════
{
  const text = fs.readFileSync(MANUAL, 'utf8');
  const listed = PUBLIC_TOOL_NAMES.filter((n) => !NOT_BUILT.includes(n));
  const missingFromDoc = listed.filter((n) => !new RegExp(`\\b${n}\\b`).test(text));
  const saysNotBuilt = NOT_BUILT.every((n) => new RegExp(`\\b${n}\\b`).test(text));
  const hasRecovery = /복구|되찾|만료/.test(text);
  const hasLimits = /안 하는 것|한계|못 하는/.test(text);
  ok('T8-manual', missingFromDoc.length === 0 && saysNotBuilt && hasRecovery && hasLimits && text.length > 3000,
    missingFromDoc.length ? `매뉴얼에 없는 버튼: ${missingFromDoc.join(',')}`
      : `버튼 ${listed.length}개 전부 · 안 만든 것 명시 · 복구 절 있음 · 안 하는 것 절 있음 · ${text.length}자`);
}

// ══ T9 옛 자료는 그대로다 ════════════════════════════════════
{
  const baseline = spawnSync(process.execPath,
    [path.join(TOOL_ROOT, 'tests', 'baseline', 'baseline.mjs'), '--verify', '--project', PROJECT],
    { cwd: TOOL_ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  ok('T9-frozen-untouched', baseline.status === 0, `기준선 대조 exit=${baseline.status}`);
}

// ══ T10 stderr 가 조용하다 ═══════════════════════════════════
{
  const noise = mcp.stderr().split('\n').filter((l) => l.trim() && !/ExperimentalWarning|--trace-warnings/.test(l));
  ok('T10-quiet-stderr', noise.length === 0, noise.length ? noise.slice(0, 2).join(' / ') : '실험 기능 경고 말고는 조용하다');
}

const failed = results.filter((r) => !r.pass);
if (AS_JSON) {
  process.stdout.write(`${JSON.stringify({ pass: failed.length === 0, total: results.length, failed: failed.length, workspace: workspaceId, results }, null, 2)}\n`);
} else {
  for (const r of results) process.stdout.write(`${r.pass ? 'PASS' : 'FAIL'}  ${r.id}\n        ${r.detail}\n`);
  process.stdout.write(`\n${failed.length === 0 ? 'PASS' : 'FAIL'} — ${results.length - failed.length}/${results.length}\n`);
}
process.exit(failed.length === 0 ? 0 : 1);
