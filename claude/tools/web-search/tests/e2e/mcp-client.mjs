// 실전 시나리오 진행기가 함께 쓰는 MCP 손잡이.
//
// **여기에는 http 요청도 playwright 도 없다.** import 는 child_process·fs·path 뿐이다 —
// 수집은 전부 collect 버튼이 하고, 진행기는 버튼을 누르고 돌려받은 경로를 읽을 뿐이다.
// 게이트 7 이 이 파일과 진행기들의 import 를 검사한다.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const MCP_SERVER = path.resolve(HERE, '..', '..', 'server.mjs');

export const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
export const writeJson = (p, o) => fs.writeFileSync(p, `${JSON.stringify(o, null, 2)}\n`);
export const say = (s) => process.stdout.write(`${s}\n`);
export const die = (s) => { process.stderr.write(`${s}\n`); process.exit(1); };

/** argv 에서 --이름 값 을 꺼낸다. */
export function flagOf(argv) {
  return (name, fallback = null) => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? fallback : argv[i + 1];
  };
}

/** MCP 서버를 stdio 자식으로 띄운다. 부를 수 있는 것은 버튼뿐이다. */
export function startMcp(projectDir, args = []) {
  const child = spawn(process.execPath, [MCP_SERVER, ...args], {
    cwd: projectDir, env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (d) => process.stderr.write(`[mcp] ${d}`));
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
  const pending = new Map();
  const call = (method, params, ms = 3_600_000) => new Promise((resolve, reject) => {
    const n = ++id;
    const t = setTimeout(() => reject(new Error(`${method} 응답이 ${ms}ms 안에 안 왔다`)), ms);
    pending.set(n, { method, reject, timer: t });
    waiting.set(n, (m) => { clearTimeout(t); pending.delete(n); resolve(m); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: n, method, params })}\n`);
  });

  // [서버가 죽으면 그 자리에서 안다] 부른 쪽이 답을 기다리는 동안 서버가 죽으면, 그 답은
  // 영영 안 온다. 그런데 기다림에는 한 시간짜리 시계밖에 없어서 부른 쪽이 한 시간을 선다 —
  // 2026-08-12 시나리오 C 가 이렇게 21분을 멈춰 있었다(일부러 죽여 놓고 답을 기다렸다).
  // 죽음은 답이 아니지만 소식은 된다. 기다리던 것을 전부 그 자리에서 깨운다.
  child.on('exit', (code, signal) => {
    for (const [n, p] of pending) {
      clearTimeout(p.timer);
      waiting.delete(n);
      p.reject(new Error(`${p.method} 을 기다리는 중에 MCP 가 끝났다 (code=${code} signal=${signal})`));
    }
    pending.clear();
  });
  const ready = (async () => {
    await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } }, 30_000);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  })();
  return {
    ready,
    call,
    /** 버튼 하나. 실패하면 그 자리에서 던진다 — 조용히 넘어가지 않는다. */
    async tool(name, args, ms) {
      const r = await call('tools/call', { name, arguments: args }, ms);
      const res = r.result ?? {};
      if (res.isError) throw new Error(`${name} 실패: ${res.content?.[0]?.text ?? '까닭 모름'}`);
      return { text: res.content?.[0]?.text ?? '', out: res.structuredContent ?? {} };
    },
    /** 일부러 죽일 때 쓴다(시나리오 C). 얌전히 끝내지 않는 것이 요점이다. */
    async kill(signal = 'SIGKILL') {
      child.kill(signal);
      return new Promise((r) => { child.on('exit', (code, sig) => r({ code, signal: sig })); setTimeout(() => r({ code: null, signal }), 3000); });
    },
    async stop() { child.kill('SIGTERM'); await new Promise((r) => { child.on('exit', r); setTimeout(r, 2000); }); },
  };
}

/** 버튼 한 번을 위해 서버를 띄우고 반드시 닫는다. */
export async function withMcp(projectDir, args, fn) {
  const mcp = startMcp(projectDir, args);
  await mcp.ready;
  try { return await fn(mcp); } finally { await mcp.stop(); }
}
