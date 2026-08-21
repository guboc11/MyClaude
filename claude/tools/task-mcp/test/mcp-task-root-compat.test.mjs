import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';

import { renderMarkdownRecord } from '../lib.mjs';
import {
  LEGACY_SERVER,
  PROJECT_SERVER,
  callTool,
  legacyTaskGroupDir,
  legacyTaskRoot,
  makeProject,
  mcpTaskGroupDir,
  mcpTaskRoot,
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

function treeManifest(root, dir = root, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    const relative = path.relative(root, full).split(path.sep).join('/');
    if (entry.isDirectory()) treeManifest(root, full, out);
    else out.push(`${relative}\t${createHash('sha256').update(fs.readFileSync(full)).digest('hex')}`);
  }
  return out;
}

function treeChecksum(root) {
  return createHash('sha256').update(treeManifest(root).join('\n')).digest('hex');
}

function planBody(marker) {
  return ['왜', '스펙', '합의', '단계', '검증', '미결']
    .map((title) => `## ${title}\n${marker} ${title}`)
    .join('\n\n');
}

function seedGroup(root, groupId, marker) {
  const dir = path.join(root, groupId);
  const timestamp = '2026-08-16T00:00:00.000Z';
  fs.mkdirSync(path.join(dir, 'notes'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'plans'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'extra'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'GROUP.json'), `${JSON.stringify({
    id: groupId,
    title: `${marker} 그룹`,
    about: `${marker} 설명`,
    status: 'pending',
    campaign: null,
    worker: { name: 'WRKR3', surface: 'surface:worker' },
    manager: null,
    created_at: timestamp,
    updated_at: timestamp,
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, `task-1-pending-[root]-${marker}.json`), `${JSON.stringify({
    number: 1,
    content: `${marker} 태스크`,
    tag: 'root',
    description: `${marker} 태스크 설명`,
    activeForm: `${marker} 진행 중`,
    instruction: `${marker} 지시`,
    depends_on: [],
    priority: 0,
    status: 'pending',
    owner: 'surface:owner',
    assignee: 'surface:worker',
    group_id: groupId,
    created_at: timestamp,
    updated_at: timestamp,
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, 'notes', `note-1-${marker}-노트.md`), renderMarkdownRecord({
    number: 1,
    title: `${marker} 노트`,
    author: 'surface:author',
    created_at: timestamp,
    updated_at: timestamp,
  }, `${marker} 노트 본문`));
  fs.writeFileSync(path.join(dir, 'plans', `plan-1-${marker}-계획.md`), renderMarkdownRecord({
    number: 1,
    title: `${marker} 계획`,
    author: 'surface:author',
    created_at: timestamp,
    updated_at: timestamp,
  }, planBody(marker)));
  fs.writeFileSync(path.join(dir, 'NOTES.md'), `# ${marker} 옛 노트\n\n${marker} NOTES 보존\n`);
  fs.writeFileSync(path.join(dir, 'extra', 'keep.txt'), `${marker} 보존 파일\n`);
  return dir;
}

function taskFile(dir, number = 1) {
  return fs.readdirSync(dir).find((file) => new RegExp(`^task-${number}-.+\\.json$`).test(file));
}

test('저장 뿌리: 새 그룹과 새 태스크·노트·계획서는 .claude/mcp-task에만 생긴다', () => {
  const project = fixture('task-mcp-root-new-writes-');
  const output = callTool(PROJECT_SERVER, project, 'task_group_add', { topic: '새 뿌리 쓰기' });
  const groupId = /group_id="([^"]+)"/.exec(output)?.[1];
  assert.ok(groupId);
  callTool(PROJECT_SERVER, project, 'task_add', { group_id: groupId, content: '새 태스크' });
  callTool(PROJECT_SERVER, project, 'task_group_note_add', {
    group_id: groupId,
    title: '새 노트',
    body: '새 노트 본문',
  });
  callTool(PROJECT_SERVER, project, 'task_group_plan_add', { group_id: groupId, title: '새 계획' });

  const dir = mcpTaskGroupDir(project, groupId);
  assert.equal(fs.existsSync(dir), true);
  assert.equal(fs.existsSync(legacyTaskRoot(project)), false);
  assert.equal(fs.existsSync(path.join(dir, 'GROUP.json')), true);
  assert.ok(taskFile(dir));
  assert.deepEqual(fs.readdirSync(path.join(dir, 'notes')), ['note-1-새-노트.md']);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'plans')), ['plan-1-새-계획.md']);
  console.log('new_writes_root=.claude/mcp-task');
  console.log('legacy_write_paths=0');
});

test('저장 뿌리: 옛 자리만 있는 그룹은 모든 읽기에서 보이고 두 tree를 바꾸지 않는다', () => {
  const project = fixture('task-mcp-root-legacy-read-');
  const groupId = '2026-08-01-legacy-read';
  const legacyDir = seedGroup(legacyTaskRoot(project), groupId, '옛읽기');
  const before = treeChecksum(legacyDir);

  assert.match(callTool(PROJECT_SERVER, project, 'task_group_get', { group_id: groupId }), /옛읽기 그룹/);
  assert.match(callTool(PROJECT_SERVER, project, 'task_group_list', { all: true }), new RegExp(groupId));
  assert.match(callTool(PROJECT_SERVER, project, 'task_get', { group_id: groupId, number: 1 }), /옛읽기 태스크/);
  assert.match(callTool(PROJECT_SERVER, project, 'task_list', { group_id: groupId, all: true }), /옛읽기 태스크/);
  assert.match(callTool(PROJECT_SERVER, project, 'task_group_note_get', { group_id: groupId, number: 1 }), /옛읽기 노트 본문/);
  assert.match(callTool(PROJECT_SERVER, project, 'task_group_note_list', { group_id: groupId }), /옛읽기 노트/);
  assert.match(callTool(PROJECT_SERVER, project, 'task_group_plan_get', { group_id: groupId, number: 1 }), /옛읽기 스펙/);
  assert.match(callTool(PROJECT_SERVER, project, 'task_group_plan_list', { group_id: groupId }), /옛읽기 계획/);

  assert.equal(treeChecksum(legacyDir), before);
  assert.equal(fs.existsSync(mcpTaskRoot(project)), false);
  console.log('legacy_read_tree_unchanged=true');
  console.log('legacy_read_new_tree_writes=0');
});

test('저장 뿌리: 옛 그룹 수정은 그룹 전체를 새 자리로 승격하고 옛 tree를 그대로 둔다', () => {
  const project = fixture('task-mcp-root-promote-');
  const groupId = '2026-08-01-promote';
  const legacyDir = seedGroup(legacyTaskRoot(project), groupId, '승격전');
  const before = treeChecksum(legacyDir);

  callTool(PROJECT_SERVER, project, 'task_group_update', { group_id: groupId, title: '승격 후 그룹' });
  callTool(PROJECT_SERVER, project, 'task_update', { group_id: groupId, number: 1, content: '승격 후 태스크' });
  callTool(PROJECT_SERVER, project, 'task_group_note_update', { group_id: groupId, number: 1, body: '승격 후 노트' });
  callTool(PROJECT_SERVER, project, 'task_group_plan_update', {
    group_id: groupId,
    number: 1,
    section: 'spec',
    body: '승격 후 스펙',
  });

  assert.equal(treeChecksum(legacyDir), before);
  const promotedDir = mcpTaskGroupDir(project, groupId);
  assert.equal(fs.existsSync(path.join(promotedDir, 'extra', 'keep.txt')), true);
  assert.match(fs.readFileSync(path.join(promotedDir, 'NOTES.md'), 'utf8'), /승격전 NOTES 보존/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(promotedDir, 'GROUP.json'), 'utf8')).title, '승격 후 그룹');
  assert.match(fs.readFileSync(path.join(promotedDir, taskFile(promotedDir)), 'utf8'), /승격 후 태스크/);
  assert.match(fs.readFileSync(path.join(promotedDir, 'notes', 'note-1-승격전-노트.md'), 'utf8'), /승격 후 노트/);
  assert.match(fs.readFileSync(path.join(promotedDir, 'plans', 'plan-1-승격전-계획.md'), 'utf8'), /승격 후 스펙/);
  console.log('legacy_promotion_copies_whole_group=true');
  console.log('legacy_tree_unchanged_after_updates=true');
});

test('저장 뿌리: 옛 그룹의 task_next는 고를 태스크가 있을 때만 승격해 새 사본을 바꾼다', () => {
  const project = fixture('task-mcp-root-next-promote-');
  const groupId = '2026-08-01-next-promote';
  const legacyDir = seedGroup(legacyTaskRoot(project), groupId, '큐승격');
  const before = treeChecksum(legacyDir);

  const output = callTool(PROJECT_SERVER, project, 'task_next', { group_id: groupId });
  assert.match(output, /#1 \(in_progress\)/);
  assert.equal(treeChecksum(legacyDir), before);
  const promotedDir = mcpTaskGroupDir(project, groupId);
  assert.match(taskFile(promotedDir), /^task-1-in_progress-/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(promotedDir, 'GROUP.json'), 'utf8')).status, 'in_progress');
  console.log('task_next_promotes_before_write=true');
  console.log('task_next_legacy_tree_unchanged=true');
});

test('저장 뿌리: 호환 symlink에서는 동결 서버와 현재 서버의 쓰기가 서로 보인다', () => {
  const project = fixture('task-mcp-root-symlink-');
  fs.mkdirSync(mcpTaskRoot(project), { recursive: true });
  fs.symlinkSync('mcp-task', legacyTaskRoot(project), 'dir');

  const legacyAdd = callTool(LEGACY_SERVER, project, 'task_add', {
    group: 'symlink bridge',
    content: '동결 서버가 쓴 태스크',
  }, 'surface:legacy');
  const groupId = /group_id="([^"]+)"/.exec(legacyAdd)?.[1];
  assert.ok(groupId);
  assert.match(callTool(PROJECT_SERVER, project, 'task_get', { group_id: groupId, number: 1 }), /동결 서버가 쓴 태스크/);

  callTool(PROJECT_SERVER, project, 'task_add', {
    group_id: groupId,
    content: '현재 서버가 쓴 태스크',
  }, 'surface:current');
  const legacyList = callTool(LEGACY_SERVER, project, 'task_list', { group_id: groupId, all: true });
  assert.match(legacyList, /동결 서버가 쓴 태스크/);
  assert.match(legacyList, /현재 서버가 쓴 태스크/);
  assert.equal(fs.realpathSync(legacyTaskRoot(project)), fs.realpathSync(mcpTaskRoot(project)));
  console.log('symlink_legacy_to_current_visible=true');
  console.log('symlink_current_to_legacy_visible=true');
});

test('저장 뿌리: 새·옛 그룹은 합집합이고 같은 ID는 새 자리를 한 번만 쓴다', () => {
  const project = fixture('task-mcp-root-union-');
  const newOnly = '2026-08-01-new-only';
  const legacyOnly = '2026-08-01-legacy-only';
  const duplicate = '2026-08-01-duplicate';
  seedGroup(mcpTaskRoot(project), newOnly, '새전용');
  seedGroup(legacyTaskRoot(project), legacyOnly, '옛전용');
  seedGroup(mcpTaskRoot(project), duplicate, '새우선');
  seedGroup(legacyTaskRoot(project), duplicate, '옛후순위');

  const list = callTool(PROJECT_SERVER, project, 'task_group_list', { all: true });
  assert.match(list, new RegExp(newOnly));
  assert.match(list, new RegExp(legacyOnly));
  assert.equal((list.match(new RegExp(`\\[${duplicate}\\]`, 'g')) || []).length, 1);
  assert.match(callTool(PROJECT_SERVER, project, 'task_get', { group_id: duplicate, number: 1 }), /새우선 태스크/);
  console.log('new_legacy_group_union=true');
  console.log('duplicate_group_precedence=new');
});
