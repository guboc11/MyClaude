import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import {
  PROJECT_SERVER,
  callTool,
  callToolAsync,
  legacyTaskGroupDir,
  listTools,
  makeProject,
  mcpTaskGroupDir,
  removeProject,
} from './helpers.mjs';

const projects = [];

after(() => {
  for (const project of projects) removeProject(project);
});

function fixture(prefix) {
  const project = makeProject(prefix);
  projects.push(project);
  return project;
}

function addGroup(project, topic, worker = 'surface:worker') {
  const output = callTool(PROJECT_SERVER, project, 'task_group_add', {
    topic,
    worker: { name: 'WRKR3', surface: worker },
    manager: { name: 'MNGR3', surface: 'surface:manager' },
  }, 'surface:manager');
  return /group_id="([^"]+)"/.exec(output)?.[1];
}

function groupDir(project, groupId) {
  return mcpTaskGroupDir(project, groupId);
}

function readGroup(project, groupId) {
  return JSON.parse(fs.readFileSync(path.join(groupDir(project, groupId), 'GROUP.json'), 'utf8'));
}

function taskFile(project, groupId, number) {
  return fs.readdirSync(groupDir(project, groupId))
    .find((file) => new RegExp(`^task-${number}-.+\\.json$`).test(file));
}

function readTask(project, groupId, number) {
  const file = taskFile(project, groupId, number);
  return { file, record: JSON.parse(fs.readFileSync(path.join(groupDir(project, groupId), file), 'utf8')) };
}

test('G3: owner와 assignee를 나누고 목록은 assignee를 기준으로 거른다', () => {
  const project = fixture('task-mcp-g3-assignee-');
  const groupId = addGroup(project, '담당자 기본값');
  assert.equal(readGroup(project, groupId).status, 'pending');

  callTool(PROJECT_SERVER, project, 'task_add', {
    group_id: groupId,
    content: '매니저가 넣은 워커 태스크',
  }, 'surface:manager');
  const task = readTask(project, groupId, 1).record;
  assert.equal(task.owner, 'surface:manager');
  assert.equal(task.assignee, 'surface:worker');
  assert.equal(task.instruction, '');
  assert.deepEqual(task.depends_on, []);
  assert.equal(task.priority, 0);

  assert.match(callTool(PROJECT_SERVER, project, 'task_list', {}, 'surface:worker'), /매니저가 넣은 워커 태스크/);
  assert.doesNotMatch(callTool(PROJECT_SERVER, project, 'task_list', {}, 'surface:manager'), /매니저가 넣은 워커 태스크/);
  assert.match(callTool(PROJECT_SERVER, project, 'task_list', { group_id: groupId }, 'surface:other'), /매니저가 넣은 워커 태스크/);

  const legacyId = '2026-07-01-legacy-assignee';
  fs.mkdirSync(legacyTaskGroupDir(project, legacyId), { recursive: true });
  callTool(PROJECT_SERVER, project, 'task_add', {
    group_id: legacyId,
    content: '옛 그룹 기본 담당자',
  }, 'surface:legacy-caller');
  assert.equal(readTask(project, legacyId, 1).record.assignee, 'surface:legacy-caller');
  assert.match(callTool(PROJECT_SERVER, project, 'task_list', {}, 'surface:legacy-caller'), /옛 그룹 기본 담당자/);
  console.log('new_group_default_status=pending');
  console.log('owner_assignee_separated=true');
  console.log('legacy_default_assignee=caller');
});

test('G3: 새 그룹은 첫 task_next에서 pending에서 in_progress로 바뀐다', () => {
  const project = fixture('task-mcp-g3-group-status-');
  const groupId = addGroup(project, '그룹 상태 전이');
  assert.equal(readGroup(project, groupId).status, 'pending');
  callTool(PROJECT_SERVER, project, 'task_add', {
    group_id: groupId,
    content: '첫 태스크',
  });
  assert.equal(readGroup(project, groupId).status, 'pending');
  callTool(PROJECT_SERVER, project, 'task_next', { group_id: groupId });
  assert.equal(readGroup(project, groupId).status, 'in_progress');
  console.log('named_group_status_transition=pending,pending,in_progress');
});

test('G3: 옛 태스크의 새 칸은 읽을 때만 기본값을 채운다', () => {
  const project = fixture('task-mcp-g3-legacy-read-');
  const groupId = '2026-07-01-old-task';
  const dir = legacyTaskGroupDir(project, groupId);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'task-1-pending-[legacy]-옛-태스크.json');
  const record = {
    number: 1,
    content: '옛 태스크',
    tag: 'legacy',
    description: '옛 설명',
    activeForm: '옛 태스크 진행 중',
    status: 'pending',
    owner: 'surface:legacy-owner',
    group_id: groupId,
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z',
  };
  fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
  const before = fs.readFileSync(file, 'utf8');
  const output = callTool(PROJECT_SERVER, project, 'task_get', { group_id: groupId, number: 1 });
  assert.match(output, /assignee: surface:legacy-owner/);
  assert.match(output, /priority: 0/);
  assert.match(output, /depends_on: \(없음\)/);
  assert.match(output, /지시:\n\(없음\)/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  console.log('legacy_read_rewrites=0');
});

test('G3: task_next는 선행 조건 뒤 우선순위와 번호 순으로 고르고 진행 중 태스크를 유지한다', () => {
  const project = fixture('task-mcp-g3-order-');
  const groupId = addGroup(project, '큐 순서');
  const add = (content, priority, depends_on = []) => callTool(PROJECT_SERVER, project, 'task_add', {
    group_id: groupId,
    content,
    description: `${content} 설명`,
    instruction: `${content} 지시`,
    priority,
    depends_on,
  }, 'surface:manager');
  add('낮은 우선순위', 2);
  add('높은 우선순위 앞번호', 9);
  add('높은 우선순위 뒷번호', 9);
  add('선행 뒤 최고 우선순위', 99, [1]);

  const first = callTool(PROJECT_SERVER, project, 'task_next', { group_id: groupId }, 'surface:other');
  assert.match(first, /#2 \(in_progress\)/);
  assert.match(first, /높은 우선순위 앞번호 설명/);
  assert.match(first, /높은 우선순위 앞번호 지시/);
  assert.equal(readGroup(project, groupId).status, 'in_progress');
  const selected = readTask(project, groupId, 2);
  assert.match(selected.file, /^task-2-in_progress-/);
  assert.equal(selected.record.status, 'in_progress');

  const repeated = callTool(PROJECT_SERVER, project, 'task_next', { group_id: groupId }, 'surface:other');
  assert.match(repeated, /#2 \(in_progress\)/);
  callTool(PROJECT_SERVER, project, 'task_update', { group_id: groupId, number: 2, status: 'completed' });

  assert.match(callTool(PROJECT_SERVER, project, 'task_next', { group_id: groupId }), /#3 \(in_progress\)/);
  callTool(PROJECT_SERVER, project, 'task_update', { group_id: groupId, number: 3, status: 'completed' });
  assert.match(callTool(PROJECT_SERVER, project, 'task_next', { group_id: groupId }), /#1 \(in_progress\)/);
  assert.match(callTool(PROJECT_SERVER, project, 'task_next', { group_id: groupId }), /#1 \(in_progress\)/);
  callTool(PROJECT_SERVER, project, 'task_update', { group_id: groupId, number: 1, status: 'completed' });
  assert.match(callTool(PROJECT_SERVER, project, 'task_next', { group_id: groupId }), /#4 \(in_progress\)/);
  console.log('selection_order=2,3,1,4');
  console.log('repeat_returns_same=true');
  console.log('group_status_transition=pending->in_progress');
  console.log('task_next_assignee_filter=false');
});

test('G3: 모두 막힘과 모두 완료 메시지를 구분하고 기다리는 번호를 보여준다', () => {
  const project = fixture('task-mcp-g3-messages-');
  const groupId = addGroup(project, '큐 메시지');
  callTool(PROJECT_SERVER, project, 'task_add', {
    group_id: groupId,
    content: '없는 선행을 기다림',
    depends_on: [99],
  });
  const blocked = callTool(PROJECT_SERVER, project, 'task_next', { group_id: groupId });
  assert.match(blocked, /모두 막혀/);
  assert.match(blocked, /#1 → #99/);
  callTool(PROJECT_SERVER, project, 'task_update', { group_id: groupId, number: 1, status: 'completed' });
  const completed = callTool(PROJECT_SERVER, project, 'task_next', { group_id: groupId });
  assert.match(completed, /모든 태스크가 완료/);
  assert.notEqual(blocked, completed);
  console.log('blocked_message_has_waiting_numbers=true');
  console.log('completed_message_distinct=true');
});

test('G3: task_update와 task_get이 새 칸과 activeForm을 보존한다', () => {
  const project = fixture('task-mcp-g3-update-');
  const groupId = addGroup(project, '태스크 칸 수정');
  callTool(PROJECT_SERVER, project, 'task_add', {
    group_id: groupId,
    content: '칸 수정 대상',
    activeForm: '처음 진행형',
  }, 'surface:manager');
  callTool(PROJECT_SERVER, project, 'task_update', {
    group_id: groupId,
    number: 1,
    description: '바뀐 설명',
    activeForm: '바뀐 진행형',
    instruction: '바뀐 지시',
    depends_on: [2],
    priority: 7,
    assignee: 'surface:other-worker',
  });
  const task = readTask(project, groupId, 1).record;
  assert.equal(task.activeForm, '바뀐 진행형');
  assert.equal(task.instruction, '바뀐 지시');
  assert.deepEqual(task.depends_on, [2]);
  assert.equal(task.priority, 7);
  assert.equal(task.assignee, 'surface:other-worker');
  const output = callTool(PROJECT_SERVER, project, 'task_get', { group_id: groupId, number: 1 });
  for (const value of ['바뀐 설명', '바뀐 진행형', '바뀐 지시', 'depends_on: #2', 'priority: 7', 'assignee: surface:other-worker']) {
    assert.match(output, new RegExp(value));
  }
  console.log('task_fields_update_get=true');
  console.log('activeForm_preserved=true');
});

test('G3: 두 프로세스가 함께 task_next를 불러도 같은 태스크를 받고 잠금 파일을 남기지 않는다', async () => {
  const project = fixture('task-mcp-g3-race-');
  const groupId = addGroup(project, '동시 큐');
  callTool(PROJECT_SERVER, project, 'task_add', {
    group_id: groupId,
    content: '동시에 집을 태스크',
    instruction: '한 번만 진행 상태로 바꾼다',
  });
  const outputs = await Promise.all([
    callToolAsync(PROJECT_SERVER, project, 'task_next', { group_id: groupId }, 'surface:first'),
    callToolAsync(PROJECT_SERVER, project, 'task_next', { group_id: groupId }, 'surface:second'),
  ]);
  for (const output of outputs) assert.match(output, /#1 \(in_progress\)/);
  const files = fs.readdirSync(groupDir(project, groupId));
  assert.equal(files.filter((file) => /^task-1-in_progress-.+\.json$/.test(file)).length, 1);
  assert.deepEqual(files.filter((file) => /lock|\.tmp$/i.test(file)), []);
  assert.equal(readTask(project, groupId, 1).record.status, 'in_progress');
  console.log('concurrent_call_results=#1,#1');
  console.log('lock_files=0');
});

test('G3: task_next를 포함한 그룹·태스크 큐 도구 9개가 계속 노출된다', () => {
  const project = fixture('task-mcp-g3-tools-');
  const tools = listTools(PROJECT_SERVER, project);
  const expected = [
    'task_group_add', 'task_group_update', 'task_group_get', 'task_group_list',
    'task_add', 'task_update', 'task_get', 'task_list', 'task_next',
  ];
  assert.deepEqual(tools.filter((name) => expected.includes(name)), expected);
  console.log(`g3_contract_tool_count=${expected.length}`);
  console.log(`visible_tool_count=${tools.length}`);
});
