import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
export const PROJECT_SERVER = path.join(REPO, '.claude', 'tools', 'task-mcp', 'server.mjs');
export const LEGACY_SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'legacy-server.mjs');
const MCP_CALL = path.join(REPO, '.claude', 'tools', 'mcp-call.mjs');
const ISO_TIME = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g;

export function mcpTaskRoot(project) {
  return path.join(project, '.claude', 'mcp-task');
}

export function legacyTaskRoot(project) {
  return path.join(project, '.claude', 'tasks');
}

export function mcpTaskGroupDir(project, groupId) {
  return path.join(mcpTaskRoot(project), groupId);
}

export function legacyTaskGroupDir(project, groupId) {
  return path.join(legacyTaskRoot(project), groupId);
}

export function makeProject(prefix = 'task-mcp-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function removeProject(project) {
  fs.rmSync(project, { recursive: true, force: true });
}

export function makeLegacyReadView(sourceProject) {
  const project = makeProject('task-mcp-g1-real-view-');
  const claude = path.join(project, '.claude');
  fs.mkdirSync(claude, { recursive: true });
  const currentRoot = mcpTaskRoot(sourceProject);
  const taskTarget = fs.existsSync(currentRoot) ? currentRoot : legacyTaskRoot(sourceProject);
  fs.symlinkSync(taskTarget, legacyTaskRoot(project), 'dir');
  const campaignTarget = path.join(sourceProject, '.claude', 'campaigns');
  if (fs.existsSync(campaignTarget)) {
    fs.symlinkSync(campaignTarget, path.join(claude, 'campaigns'), 'dir');
  }
  return project;
}

export function callTool(server, project, name, args = {}, surface = 'surface:g1') {
  return execFileSync(
    process.execPath,
    [MCP_CALL, server, name, JSON.stringify(args)],
    {
      cwd: REPO,
      env: { ...process.env, CLAUDE_PROJECT_DIR: project, CMUX_SURFACE_ID: surface },
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
    },
  ).trimEnd();
}

export function callToolAsync(server, project, name, args = {}, surface = 'surface:g1') {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [MCP_CALL, server, name, JSON.stringify(args)],
      {
        cwd: REPO,
        env: { ...process.env, CLAUDE_PROJECT_DIR: project, CMUX_SURFACE_ID: surface },
        encoding: 'utf8',
        maxBuffer: 4 * 1024 * 1024,
      },
      (error, stdout) => {
        if (error) {
          error.stdout = stdout;
          reject(error);
          return;
        }
        resolve(stdout.trimEnd());
      },
    );
  });
}

// mcp-call은 출력 직후 process.exit를 하므로 큰 응답의 마지막 stdout 청크가 드물게 잘린다.
// 실물 전체 목록처럼 큰 결과를 비교할 때만 JSON-RPC 응답 한 줄을 끝까지 받은 뒤 서버를 닫는다.
export function callToolDirect(server, project, name, args = {}, surface = 'surface:g1') {
  return new Promise((resolve, reject) => {
    const serverProcess = spawn(
      process.execPath,
      [server],
      {
        cwd: REPO,
        env: { ...process.env, CLAUDE_PROJECT_DIR: project, CMUX_SURFACE_ID: surface },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    let buffer = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      serverProcess.kill();
      reject(new Error(`${name} 직접 호출이 30초 안에 응답하지 않았습니다.`));
    }, 30_000);

    const finish = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      serverProcess.kill();
      fn();
    };
    serverProcess.on('error', (error) => finish(() => reject(error)));
    serverProcess.on('exit', (code) => {
      if (!settled) finish(() => reject(new Error(`${name} 직접 호출 서버가 응답 전에 종료했습니다: ${code}`)));
    });
    serverProcess.stdout.setEncoding('utf8');
    serverProcess.stdout.on('data', (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id !== 2) continue;
        const result = message.result || {};
        const text = (result.content || [])
          .filter((content) => content.type === 'text')
          .map((content) => content.text)
          .join('\n');
        finish(() => {
          if (message.error) reject(new Error(message.error.message));
          else if (result.isError) reject(new Error(text));
          else resolve(text);
        });
        return;
      }
    });
    serverProcess.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name, arguments: args },
    })}\n`);
  });
}

export function callToolError(server, project, name, args = {}, surface = 'surface:g1') {
  const result = spawnSync(
    process.execPath,
    [MCP_CALL, server, name, JSON.stringify(args)],
    {
      cwd: REPO,
      env: { ...process.env, CLAUDE_PROJECT_DIR: project, CMUX_SURFACE_ID: surface },
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  if (result.status === 0) throw new Error(`${name} 호출이 성공했지만 오류를 예상했습니다.`);
  return String(result.stdout || '').trimEnd();
}

export function listToolsOutput(server, project) {
  return execFileSync(
    process.execPath,
    [MCP_CALL, server, '--tools'],
    {
      cwd: REPO,
      env: { ...process.env, CLAUDE_PROJECT_DIR: project, CMUX_SURFACE_ID: 'surface:g1' },
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
    },
  ).trimEnd();
}

export function listTools(server, project) {
  return listToolsOutput(server, project).split('\n')
    .filter((line) => line.startsWith('- '))
    .map((line) => line.slice(2).split('(')[0]);
}

export function normalize(value) {
  return String(value).replace(ISO_TIME, '<ISO_TIME>');
}

function walkFiles(root, dir = root, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(root, full, out);
    else out.push(path.relative(root, full).split(path.sep).join('/'));
  }
  return out;
}

export function snapshotProject(project) {
  return walkFiles(project).map((file) => ({
    file,
    content: normalize(fs.readFileSync(path.join(project, file), 'utf8')),
  }));
}

export function countTaskFiles(project) {
  return walkFiles(path.join(project, '.claude'))
    .filter((file) => /(^|\/)task-\d+-.+\.json$/.test(file))
    .length;
}

export function countCampaigns(project) {
  const root = path.join(project, '.claude', 'campaigns');
  try {
    return fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).length;
  } catch {
    return 0;
  }
}
