#!/usr/bin/env node
// 게이트 2 일꾼 — 독립 MCP 클라이언트 하나. 부모가 프로세스로 띄운다.
//
//   node tests/gate2-worker.mjs --project <경로> --workspace <이름> --worker <이름>
//                               --count <n> [--lease-minutes <m>] [--start-at <epoch_ms>] [--hold]
//
// --hold 면 임대만 받고 버틴다. 부모가 SIGKILL 할 과녁이다.
// 결과는 stdout 에 JSON 한 줄. 서버 내부 함수를 직접 부르지 않고 버튼으로만 말한다.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, '..', 'server.mjs');

const arg = (k, d = null) => {
  const i = process.argv.indexOf(k);
  return i === -1 ? d : process.argv[i + 1];
};
const has = (k) => process.argv.includes(k);

const PROJECT = arg('--project');
const WORKSPACE = arg('--workspace');
const WORKER = arg('--worker');
const COUNT = Number(arg('--count', '100'));
const LEASE_MINUTES = Number(arg('--lease-minutes', '60'));
const START_AT = Number(arg('--start-at', '0'));

const child = spawn(process.execPath, [SERVER], {
  stdio: ['pipe', 'pipe', 'pipe'], cwd: PROJECT, env: { ...process.env, CLAUDE_PROJECT_DIR: PROJECT },
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
    const w = msg.id != null && pending.get(msg.id);
    if (w) { pending.delete(msg.id); w(msg); }
  }
});
child.stderr.on('data', (d) => { stderr += d; });

const request = (method, params, limitMs = 30_000) => new Promise((resolve) => {
  const id = nextId++;
  const t = setTimeout(() => { pending.delete(id); resolve(null); }, limitMs);
  pending.set(id, (m) => { clearTimeout(t); resolve(m); });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
});

const out = { worker: WORKER, pid: process.pid };
try {
  await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: WORKER, version: '1' } });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

  // 같은 순간에 임계 구역으로 들어간다. 이 배리어가 없으면 순서대로 실행돼 경합이 생기지 않는다.
  while (Date.now() < START_AT) { /* busy-wait: setTimeout 은 수 ms 오차가 난다 */ }

  const r = await request('tools/call', {
    name: 'next',
    arguments: { workspace: WORKSPACE, worker_id: WORKER, count: COUNT, lease_minutes: LEASE_MINUTES },
  });
  const res = r?.result;
  if (!res || res.isError) {
    out.error = res?.content?.[0]?.text?.slice(0, 160) ?? '응답 없음';
  } else {
    Object.assign(out, res.structuredContent);
  }
} catch (e) {
  out.fatal = e.message.slice(0, 160);
}
out.stderr_unexpected = stderr.split('\n').filter((l) => l.trim() && !/ExperimentalWarning|trace-warnings/.test(l)).length;

process.stdout.write(`${JSON.stringify(out)}\n`);
if (has('--hold')) {
  setInterval(() => {}, 1000);      // 부모가 죽일 때까지 임대를 쥔 채 산다
} else {
  child.kill('SIGTERM');
  process.exit(0);
}
