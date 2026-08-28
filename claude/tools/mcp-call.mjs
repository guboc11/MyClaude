#!/usr/bin/env node
// mcp-call — 등록 없는 환경(MCP 미지원 하네스)용 stdio MCP 호출기
//
// 왜: 윈도우 클로드 데스크탑 등 .mcp.json을 읽지 못하는 환경에서, 레포 클론만으로
//     자작 MCP 도구를 쓰기 위한 호환층. 설계: _ARCHIVED/_PLAN/2026-07-31-mcp-call/PLAN.md
//
// 사용법:
//   node .claude/tools/mcp-call.mjs <서버> --tools                # 도구 목록·인자 요약
//   node .claude/tools/mcp-call.mjs <서버> <도구>                 # 인자 없는 호출
//   node .claude/tools/mcp-call.mjs <서버> <도구> '<JSON>'        # 인라인 인자
//   node .claude/tools/mcp-call.mjs <서버> <도구> @args.json      # 파일 인자 (윈도우 권장)
//   <서버> = .mcp.json의 stdio 등록 이름, 또는 .mjs 파일 경로(등록 전 개발용)
//
// 종료 코드: 0 성공 / 1 도구 거부·서버 에러 / 2 인자·해석 오류 / 3 무응답(30초)
// 셸을 경유하지 않고(spawn shell:false) node 안에서만 조립한다 — PowerShell·cmd·bash 어디서든 동일.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// 레포 루트 역산: 이 파일은 <루트>/.claude/tools/ 에 산다. 어느 디렉토리에서 불러도 동작.
const ROOT = process.env.CLAUDE_PROJECT_DIR
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const USAGE = `mcp-call — 등록 없는 환경용 stdio MCP 호출기
  node .claude/tools/mcp-call.mjs <서버> --tools
  node .claude/tools/mcp-call.mjs <서버> <도구> ['JSON' | @파일]
<서버> = .mcp.json의 stdio 등록 이름 또는 .mjs 경로. 종료 코드: 0 성공 / 1 거부 / 2 인자 오류 / 3 무응답`;

function fail(msg, code) { process.stderr.write(msg + '\n'); process.exit(code); }

// ── 서버 해석 (.mcp.json이 진실원) ────────────────────────────

function resolveServer(name) {
  if (/\.(mjs|js|cjs)$/.test(name)) {
    const p = path.isAbsolute(name) ? name : path.join(ROOT, name);
    if (!fs.existsSync(p)) fail(`서버 파일 없음: ${p}`, 2);
    return { command: process.execPath, args: [p], label: name };
  }
  const mcpPath = path.join(ROOT, '.mcp.json');
  if (!fs.existsSync(mcpPath)) fail(`.mcp.json 없음: ${mcpPath} (레포 루트: ${ROOT})`, 2);
  let conf;
  try { conf = JSON.parse(fs.readFileSync(mcpPath, 'utf8')); }
  catch (e) { fail(`.mcp.json 파싱 실패: ${e.message}`, 2); }
  const servers = conf.mcpServers || {};
  const stdioNames = Object.keys(servers).filter((k) => servers[k].type === 'stdio').sort();
  const entry = servers[name];
  if (!entry) fail(`등록에 없는 서버: "${name}"\nstdio 서버: ${stdioNames.join(', ')}`, 2);
  if (entry.type !== 'stdio') {
    fail(`"${name}"은(는) ${entry.type} 방식이라 이 호출기의 대상이 아닙니다 (stdio 전용).\nstdio 서버: ${stdioNames.join(', ')}`, 2);
  }
  return { command: entry.command, args: entry.args || [], label: name };
}

// ── 인자 해석 (@파일이면 파일에서 — 셸 따옴표 우회) ───────────

function parseToolArgs(raw) {
  if (raw === undefined) return {};
  let text = raw;
  if (raw.startsWith('@')) {
    const rel = raw.slice(1);
    const tryPaths = path.isAbsolute(rel) ? [rel] : [path.resolve(process.cwd(), rel), path.join(ROOT, rel)];
    const found = tryPaths.find((p) => fs.existsSync(p));
    if (!found) fail(`인자 파일 없음: ${rel} (찾은 위치: ${tryPaths.join(' / ')})`, 2);
    text = fs.readFileSync(found, 'utf8');
  }
  try { return JSON.parse(text); }
  catch (e) { fail(`인자 JSON 파싱 실패: ${e.message}\n받은 내용 앞부분: ${text.slice(0, 120)}`, 2); }
}

// ── 프로토콜 (initialize → tools/list 또는 tools/call) ────────

const TIMEOUT_MS = 30_000; // 응답 대기 한도 — 죽은 서버에 무한 대기 방지 (자동 실행 아님)
const FINAL_ID = 2;

function run(srv, finalMsg, onFinal) {
  const child = spawn(srv.command, srv.args, {
    cwd: ROOT,
    env: { ...process.env, CLAUDE_PROJECT_DIR: ROOT },
    shell: false,                    // 셸 비경유 — 특수문자 해석 차단
    stdio: ['pipe', 'pipe', 'inherit'], // 서버 stderr 로그는 그대로 통과
  });
  child.on('error', (e) => fail(`서버 실행 실패: ${srv.label} — ${e.message}`, 2));
  const timer = setTimeout(() => { child.kill(); fail(`무응답(${TIMEOUT_MS / 1000}초): ${srv.label}`, 3); }, TIMEOUT_MS);

  let buf = '';
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).replace(/\r$/, '').trim(); // \r\n 관대
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; } // 프로토콜 외 stdout 줄은 무시
      if (msg.id === FINAL_ID) {
        clearTimeout(timer);
        child.kill();
        onFinal(msg);
        return;
      }
    }
  });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }) + '\n');
  child.stdin.write(JSON.stringify(finalMsg) + '\n');
}

function printToolList(msg) {
  if (msg.error) fail(`서버 에러: ${msg.error.message}`, 1);
  const tools = msg.result?.tools || [];
  for (const t of tools) {
    const props = t.inputSchema?.properties || {};
    const required = new Set(t.inputSchema?.required || []);
    const args = Object.keys(props).map((k) => (required.has(k) ? k : `${k}?`)).join(', ');
    const desc = (t.description || '').split('\n')[0];
    process.stdout.write(`- ${t.name}(${args})\n    ${desc}\n`);
  }
  process.exit(0);
}

function printCallResult(msg) {
  if (msg.error) fail(`서버 에러: ${msg.error.message}`, 1);
  const r = msg.result || {};
  const text = (r.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  process.stdout.write(text + '\n');
  process.exit(r.isError ? 1 : 0);
}

// ── 진입 ──────────────────────────────────────────────────────

const [serverArg, toolArg, rawArgs, extra] = process.argv.slice(2);
if (!serverArg || !toolArg) fail(USAGE, 2);
if (extra !== undefined) fail(`인자가 너무 많습니다 — JSON은 따옴표로 감싸거나 @파일로 넘기세요.\n\n${USAGE}`, 2);

const srv = resolveServer(serverArg);
if (toolArg === '--tools') {
  run(srv, { jsonrpc: '2.0', id: FINAL_ID, method: 'tools/list' }, printToolList);
} else {
  const args = parseToolArgs(rawArgs);
  run(srv, { jsonrpc: '2.0', id: FINAL_ID, method: 'tools/call', params: { name: toolArg, arguments: args } }, printCallResult);
}
