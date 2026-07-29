#!/usr/bin/env node
// task-mcp — 무의존성 MCP stdio 서버 (프로젝트별 파일 기반 태스크)
//
// 저장: <project>/.claude/tasks/{YYYY-MM-DD}-{slug(group)}/task-{number}-{status}.json
//   - 태스크 1개 = JSON 파일 1개. status를 파일명·내용 양쪽에 기록(파일 트리로 한눈에 파악).
//   - 상태 변경 시 파일을 rename (task-2-pending.json -> task-2-in_progress.json).
//   - 완료 항목도 지우지 않고 누적.
// project 경로: CLAUDE_PROJECT_DIR > process.cwd()
// stdout에는 JSON-RPC만, 로그는 stderr로.

import fs from 'node:fs';
import path from 'node:path';

const STATUSES = ['pending', 'in_progress', 'completed'];
const MARK = { pending: '[ ]', in_progress: '[~]', completed: '[x]' };
// owner = 태스크를 만든 패널(CMUX_SURFACE_ID). task_list 기본은 자기 owner 것만 = 패널 간 격리.
const OWNER = process.env.CMUX_SURFACE_ID || '';

const log = (...a) => process.stderr.write(`[task-mcp] ${a.join(' ')}\n`);

function projectDir() {
  return process.env.CLAUDE_PROJECT_DIR || process.cwd();
}
function tasksRoot() {
  return path.join(projectDir(), '.claude', 'tasks');
}
function slug(s, max = 60) {
  return (String(s ?? '').trim()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .slice(0, max)
    .replace(/^-+|-+$/g, '')) || 'task';
}
// 파일명: task-{번호}-{status}-[태그]-{제목}.json  (태그 없으면 [태그] 생략)
function taskFileName(number, status, content, tag) {
  const t = tag ? `-[${slug(tag, 20)}]` : '';
  return `task-${number}-${status}${t}-${slug(content, 40)}.json`;
}
function today() {
  return new Date().toISOString().slice(0, 10);
}
function now() {
  return new Date().toISOString();
}

function groupPath(groupId) {
  // groupId = 폴더명 "{date}-{slug}". 하위경로 이탈 방지.
  const safe = String(groupId).replace(/[\\/]/g, '').trim();
  return { safe, dir: path.join(tasksRoot(), safe) };
}
function ensureGroupForTopic(topic) {
  const id = `${today()}-${slug(topic)}`;
  const dir = path.join(tasksRoot(), id);
  fs.mkdirSync(dir, { recursive: true });
  return { id, dir };
}
function listGroupIds() {
  try {
    return fs.readdirSync(tasksRoot(), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch { return []; }
}
function readTasks(dir) {
  let files;
  try { files = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const f of files) {
    const m = f.match(/^task-(\d+)-.+\.json$/);
    if (!m) continue;
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      out.push({ file: f, ...data, number: Number(m[1]) });
    } catch { /* skip corrupt */ }
  }
  return out.sort((a, b) => a.number - b.number);
}
function findTaskFile(dir, number) {
  let files;
  try { files = fs.readdirSync(dir); } catch { return null; }
  return files.find((f) => new RegExp(`^task-${number}-.+\\.json$`).test(f)) || null;
}
function renderGroup(id, tasks, showOwner = false) {
  if (!tasks.length) return `[${id}] (비어 있음)`;
  const lines = tasks.map((t) => `  ${MARK[t.status] || '[ ]'} ${t.number}. ${t.tag ? `[${t.tag}] ` : ''}${t.content} (${t.status})${t.description ? '  +상세' : ''}${showOwner && t.owner ? `  @${String(t.owner).slice(0, 8)}` : ''}`);
  const done = tasks.filter((t) => t.status === 'completed').length;
  return `[${id}]  ${done}/${tasks.length} 완료\n${lines.join('\n')}`;
}

// ---- tool 구현 ----
function toolAdd({ group, content, tag, description, activeForm }) {
  if (!group || !content) throw new Error('group, content는 필수입니다.');
  const { id, dir } = ensureGroupForTopic(group);
  const existing = readTasks(dir);
  const number = (existing.reduce((m, t) => Math.max(m, t.number), 0)) + 1;
  const status = 'pending';
  const rec = {
    number, content, tag: tag || '', description: description || '', activeForm: activeForm || content,
    status, owner: OWNER, group_id: id, created_at: now(), updated_at: now(),
  };
  fs.writeFileSync(path.join(dir, taskFileName(number, status, content, rec.tag)), JSON.stringify(rec, null, 2) + '\n');
  const tasks = readTasks(dir).filter((t) => (t.owner || '') === OWNER);
  return `추가됨: group_id="${id}", number=${number}.\n${renderGroup(id, tasks)}\n\n(업데이트는 task_update{group_id:"${id}", number:${number}, status})`;
}
function toolUpdate({ group_id, number, status, tag, description, content, activeForm }) {
  if (!group_id || number == null) throw new Error('group_id, number는 필수입니다.');
  if (status != null && !STATUSES.includes(status)) throw new Error(`status는 ${STATUSES.join(' | ')} 중 하나여야 합니다.`);
  if (status == null && tag == null && description == null && content == null && activeForm == null)
    throw new Error('바꿀 값(status / tag / description / content / activeForm 중 하나 이상)이 필요합니다.');
  const { safe, dir } = groupPath(group_id);
  const cur = findTaskFile(dir, number);
  if (!cur) throw new Error(`task-${number} 를 group "${safe}" 에서 못 찾음.`);
  const full = path.join(dir, cur);
  const rec = JSON.parse(fs.readFileSync(full, 'utf8'));
  if (description != null) rec.description = description;
  if (content != null) rec.content = content;
  if (activeForm != null) rec.activeForm = activeForm;
  if (tag != null) rec.tag = tag;
  if (status != null) rec.status = status;
  rec.updated_at = now();
  const next = path.join(dir, taskFileName(number, rec.status, rec.content, rec.tag));
  fs.writeFileSync(full, JSON.stringify(rec, null, 2) + '\n');
  if (path.basename(full) !== path.basename(next)) fs.renameSync(full, next);
  return `업데이트됨: ${safe}/task-${number}${status != null ? ` -> ${status}` : ' (내용 수정)'}.\n${renderGroup(safe, readTasks(dir))}`;
}
function toolGet({ group_id, number }) {
  if (!group_id || number == null) throw new Error('group_id, number는 필수입니다.');
  const { safe, dir } = groupPath(group_id);
  const cur = findTaskFile(dir, number);
  if (!cur) throw new Error(`task-${number} 를 group "${safe}" 에서 못 찾음.`);
  const rec = JSON.parse(fs.readFileSync(path.join(dir, cur), 'utf8'));
  return `[${safe}] #${number} (${rec.status})${rec.tag ? ` [${rec.tag}]` : ''}\n제목: ${rec.content}\n\n설명:\n${rec.description || '(없음)'}`;
}
function toolList({ group_id, all } = {}) {
  // 기본: 내 패널(owner) 것만. all=true면 다른 패널 포함 전체(오버사이트).
  const mine = (tasks) => (all ? tasks : tasks.filter((t) => (t.owner || '') === OWNER));
  if (group_id) {
    const { safe, dir } = groupPath(group_id);
    return renderGroup(safe, mine(readTasks(dir)), !!all);
  }
  const blocks = [];
  for (const id of listGroupIds()) {
    const tasks = mine(readTasks(path.join(tasksRoot(), id)));
    if (tasks.length) blocks.push(renderGroup(id, tasks, !!all));
  }
  if (!blocks.length) return all ? '태스크 없음. task_add로 시작하세요.' : '내 태스크 없음(다른 패널 것 보려면 all:true).';
  return blocks.join('\n\n');
}

const TOOLS = [
  {
    name: 'task_add',
    description: '새 태스크 1개를 프로젝트 폴더에 파일로 추가한다. group은 넓은 범위로 잡고(그 폴더에 여러 태스크가 쌓임), 디테일은 tag·content·description에 담는다. 파일명: task-{번호}-{status}-[태그]-{제목}.json. 생성한 패널이 owner로 자동 기록됨(task_list 기본은 자기 owner 것만).',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        group: { type: 'string', description: '넓은 범위(broad)의 그룹 폴더명. 예: "인증", "랜딩 리디자인". 세부는 tag·content로.' },
        content: { type: 'string', description: '한 줄 제목(목록·파일명에 표시). 짧게.' },
        tag: { type: 'string', description: '분류 태그(선택, 짧게). 파일명·목록에 [태그]로 표시. 예: backend, ui, bug' },
        description: { type: 'string', description: '긴 상세 설명(선택). 목록엔 안 뜨고 task_get으로 조회. 길이 제한 없음.' },
        activeForm: { type: 'string', description: '진행 중 표시용 현재진행형 라벨(선택)' },
      },
      required: ['group', 'content'],
    },
  },
  {
    name: 'task_update',
    description: '기존 태스크의 status/tag/description/content를 변경한다(status·tag·content 바뀌면 파일명도 rename). 하나 이상 주면 됨.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        group_id: { type: 'string', description: 'task_add가 돌려준 그룹 폴더명(예: 2026-07-08-auth-flow)' },
        number: { type: 'integer', description: '태스크 번호' },
        status: { type: 'string', enum: STATUSES, description: '상태 변경(선택)' },
        tag: { type: 'string', description: '태그 갱신(선택)' },
        description: { type: 'string', description: '긴 상세 설명 갱신(선택)' },
        content: { type: 'string', description: '한 줄 제목 갱신(선택)' },
        activeForm: { type: 'string', description: '현재진행형 라벨 갱신(선택)' },
      },
      required: ['group_id', 'number'],
    },
  },
  {
    name: 'task_get',
    description: '태스크 1개의 전체 내용(긴 description 포함)을 조회한다.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        group_id: { type: 'string', description: '그룹 폴더명' },
        number: { type: 'integer', description: '태스크 번호' },
      },
      required: ['group_id', 'number'],
    },
  },
  {
    name: 'task_list',
    description: '태스크 목록을 렌더한다. 기본은 내 패널(owner) 것만 보임. all:true면 다른 패널 포함 전체(오버사이트). group_id 주면 그 그룹만.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        group_id: { type: 'string', description: '특정 그룹만 볼 때(선택)' },
        all: { type: 'boolean', description: 'true면 다른 패널 것 포함 전체. 기본 false=내 것만(패널 격리).' },
      },
    },
  },
];
const DISPATCH = { task_add: toolAdd, task_update: toolUpdate, task_get: toolGet, task_list: toolList };

// ---- MCP stdio (JSON-RPC 2.0, newline-delimited) ----
function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }
function reply(id, result) { send({ jsonrpc: '2.0', id, result }); }
function replyErr(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }); }

function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    return reply(id, {
      protocolVersion: params?.protocolVersion || '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'task-mcp', version: '0.1.0' },
    });
  }
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return;
  if (method === 'ping') return reply(id, {});
  if (method === 'tools/list') return reply(id, { tools: TOOLS });
  if (method === 'tools/call') {
    const fn = DISPATCH[params?.name];
    if (!fn) return reply(id, { content: [{ type: 'text', text: `알 수 없는 도구: ${params?.name}` }], isError: true });
    try {
      const text = fn(params.arguments || {});
      return reply(id, { content: [{ type: 'text', text }] });
    } catch (e) {
      return reply(id, { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true });
    }
  }
  if (id != null) return replyErr(id, -32601, `Method not found: ${method}`);
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { log('parse fail:', line.slice(0, 120)); continue; }
    try { handle(msg); } catch (e) { log('handle error:', e.message); }
  }
});
process.stdin.on('end', () => process.exit(0));
log(`started. projectDir=${projectDir()} (CLAUDE_PROJECT_DIR=${process.env.CLAUDE_PROJECT_DIR || '<unset>'})`);
