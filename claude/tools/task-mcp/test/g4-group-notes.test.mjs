import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { parseMarkdownRecord, renderMarkdownRecord } from '../lib.mjs';
import {
  PROJECT_SERVER,
  callTool,
  callToolError,
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

function addGroup(project, topic) {
  const output = callTool(PROJECT_SERVER, project, 'task_group_add', { topic });
  return /group_id="([^"]+)"/.exec(output)?.[1];
}

function groupDir(project, groupId) {
  return mcpTaskGroupDir(project, groupId);
}

function notesDir(project, groupId) {
  return path.join(groupDir(project, groupId), 'notes');
}

function noteFile(project, groupId, number) {
  return fs.readdirSync(notesDir(project, groupId))
    .find((file) => new RegExp(`^note-${number}-.+\\.md$`).test(file));
}

function readNote(project, groupId, number) {
  const file = noteFile(project, groupId, number);
  const text = fs.readFileSync(path.join(notesDir(project, groupId), file), 'utf8');
  const parsed = parseMarkdownRecord(text);
  return { file, text, ...parsed };
}

test('G4: 두 surface가 만든 노트를 각자 수정해도 두 파일이 모두 남는다', () => {
  const project = fixture('task-mcp-g4-two-authors-');
  const groupId = addGroup(project, '두 작성자 노트');
  const firstOutput = callTool(PROJECT_SERVER, project, 'task_group_note_add', {
    group_id: groupId,
    title: 'A의 노트',
    body: 'A의 옛 본문',
  }, 'surface:a');
  const secondOutput = callTool(PROJECT_SERVER, project, 'task_group_note_add', {
    group_id: groupId,
    title: 'B의 노트',
    body: 'B의 옛 본문',
  }, 'surface:b');
  assert.match(firstOutput, /number=1/);
  assert.match(secondOutput, /number=2/);

  const firstBefore = readNote(project, groupId, 1);
  const secondBefore = readNote(project, groupId, 2);
  assert.equal(firstBefore.metadata.number, '1');
  assert.equal(firstBefore.metadata.author, 'surface:a');
  assert.equal(secondBefore.metadata.number, '2');
  assert.equal(secondBefore.metadata.author, 'surface:b');

  callTool(PROJECT_SERVER, project, 'task_group_note_update', {
    group_id: groupId,
    number: 1,
    body: 'A의 교체 본문',
  }, 'surface:a');
  callTool(PROJECT_SERVER, project, 'task_group_note_update', {
    group_id: groupId,
    number: 2,
    body: 'B의 교체 본문',
  }, 'surface:b');

  const firstAfter = readNote(project, groupId, 1);
  const secondAfter = readNote(project, groupId, 2);
  assert.equal(firstAfter.body, 'A의 교체 본문');
  assert.equal(secondAfter.body, 'B의 교체 본문');
  assert.doesNotMatch(firstAfter.body, /옛 본문/);
  assert.doesNotMatch(secondAfter.body, /옛 본문/);
  assert.equal(firstAfter.metadata.author, firstBefore.metadata.author);
  assert.equal(secondAfter.metadata.author, secondBefore.metadata.author);
  assert.equal(firstAfter.metadata.created_at, firstBefore.metadata.created_at);
  assert.equal(secondAfter.metadata.created_at, secondBefore.metadata.created_at);
  assert.notEqual(firstAfter.metadata.updated_at, firstBefore.metadata.updated_at);
  assert.notEqual(secondAfter.metadata.updated_at, secondBefore.metadata.updated_at);
  assert.equal(fs.readdirSync(notesDir(project, groupId)).filter((file) => file.endsWith('.md')).length, 2);

  const groupGet = callTool(PROJECT_SERVER, project, 'task_group_get', { group_id: groupId });
  const dashboard = callTool(PROJECT_SERVER, project, 'task_group_list', { all: true });
  assert.match(groupGet, /노트 2 · 계획서 0/);
  assert.match(dashboard, /노트 2 · 계획서 0/);
  console.log('independent_note_files=2');
  console.log('replace_removes_old_body=true');
  console.log('group_note_count=2');
});

test('G4: append는 이어붙이고 제목 변경은 파일명과 앞머리를 함께 바꾼다', () => {
  const project = fixture('task-mcp-g4-append-title-');
  const groupId = addGroup(project, '이어붙이기와 제목');
  callTool(PROJECT_SERVER, project, 'task_group_note_add', {
    group_id: groupId,
    title: '처음 제목',
    body: '처음 본문',
  }, 'surface:author');
  const before = readNote(project, groupId, 1);

  callTool(PROJECT_SERVER, project, 'task_group_note_update', {
    group_id: groupId,
    number: 1,
    title: '바뀐 제목',
    body: '이어붙인 본문',
    append: true,
  }, 'surface:author');
  const afterNote = readNote(project, groupId, 1);
  assert.equal(fs.existsSync(path.join(notesDir(project, groupId), before.file)), false);
  assert.equal(afterNote.file, 'note-1-바뀐-제목.md');
  assert.equal(afterNote.metadata.title, '바뀐 제목');
  assert.equal(afterNote.metadata.author, 'surface:author');
  assert.equal(afterNote.metadata.created_at, before.metadata.created_at);
  assert.notEqual(afterNote.metadata.updated_at, before.metadata.updated_at);
  assert.equal(afterNote.body, '처음 본문\n\n이어붙인 본문');

  const getOutput = callTool(PROJECT_SERVER, project, 'task_group_note_get', { group_id: groupId, number: 1 });
  assert.equal(getOutput, afterNote.text.trimEnd());
  const listOutput = callTool(PROJECT_SERVER, project, 'task_group_note_list', { group_id: groupId });
  for (const value of [
    '#1 바뀐 제목',
    '작성 surface:author',
    `생성 ${afterNote.metadata.created_at}`,
    `수정 ${afterNote.metadata.updated_at}`,
  ]) assert.match(listOutput, new RegExp(value));
  console.log('append_preserves_both_bodies=true');
  console.log('title_frontmatter_and_filename_synced=true');
  console.log('note_get_list_metadata_match=true');
});

test('G4: 다음 번호는 현재 노트의 가장 큰 번호 다음이다', () => {
  const project = fixture('task-mcp-g4-next-number-');
  const groupId = addGroup(project, '노트 다음 번호');
  const dir = notesDir(project, groupId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'note-7-미리-있는-노트.md'), renderMarkdownRecord({
    number: 7,
    title: '미리 있는 노트',
    author: 'surface:seed',
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z',
  }, '미리 있는 본문'));
  const output = callTool(PROJECT_SERVER, project, 'task_group_note_add', {
    group_id: groupId,
    title: '다음 노트',
    body: '여덟 번째 본문',
  });
  assert.match(output, /number=8/);
  assert.equal(readNote(project, groupId, 8).metadata.number, '8');
  console.log('highest_note_number=7');
  console.log('next_note_number=8');
});

test('G4: 옛 NOTES.md는 목록 맨 위에 읽기 전용으로 보이고 수정되지 않는다', () => {
  const project = fixture('task-mcp-g4-legacy-notes-');
  const groupId = addGroup(project, '옛 노트 읽기');
  const legacy = path.join(groupDir(project, groupId), 'NOTES.md');
  fs.writeFileSync(legacy, '# 옛 노트\n\n건드리면 안 되는 본문\n');
  const before = fs.readFileSync(legacy, 'utf8');
  callTool(PROJECT_SERVER, project, 'task_group_note_add', {
    group_id: groupId,
    title: '새 노트',
    body: '새 본문',
  });
  const listBeforeUpdate = callTool(PROJECT_SERVER, project, 'task_group_note_list', { group_id: groupId });
  assert.ok(listBeforeUpdate.indexOf('NOTES.md (옛 자리 · 읽기 전용)') < listBeforeUpdate.indexOf('#1 새 노트'));
  callTool(PROJECT_SERVER, project, 'task_group_note_update', {
    group_id: groupId,
    number: 1,
    body: '새 노트만 수정',
  });
  assert.match(callToolError(PROJECT_SERVER, project, 'task_group_note_update', {
    group_id: groupId,
    number: 99,
    body: '옛 파일을 고치려는 시도',
  }), /note-99 를 찾지 못했습니다/);
  assert.equal(fs.readFileSync(legacy, 'utf8'), before);
  assert.match(callTool(PROJECT_SERVER, project, 'task_group_get', { group_id: groupId }), /노트 2 · 계획서 0/);
  console.log('legacy_notes_list_position=first');
  console.log('legacy_notes_writes=0');
});

test('G4: 노트 도구를 포함한 그룹·태스크 계약 도구 13개가 계속 노출된다', () => {
  const project = fixture('task-mcp-g4-tools-');
  const tools = listTools(PROJECT_SERVER, project);
  const expected = [
    'task_group_add', 'task_group_update', 'task_group_get', 'task_group_list',
    'task_group_note_add', 'task_group_note_update', 'task_group_note_get', 'task_group_note_list',
    'task_add', 'task_update', 'task_get', 'task_list', 'task_next',
  ];
  assert.deepEqual(tools.filter((name) => expected.includes(name)), expected);
  console.log('g4_note_tool_count=4');
  console.log(`g4_contract_tool_count=${expected.length}`);
  console.log(`visible_tool_count=${tools.length}`);
});
