import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import {
  RESERVED_CAMPAIGN_DIRS,
  campaignGroupIds,
  groupPath,
  listGroupIds,
  today,
} from '../lib.mjs';
import {
  PROJECT_SERVER,
  REPO,
  callTool,
  callToolError,
  legacyTaskGroupDir,
  legacyTaskRoot,
  listTools,
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

function addCampaign(project, name = 'g2-campaign') {
  const output = callTool(PROJECT_SERVER, project, 'campaign_add', { name, about: 'G2' });
  const id = /캠페인 생성: ([^\n]+)/.exec(output)?.[1];
  assert.ok(id, 'campaign_add가 생성한 캠페인 이름을 돌려줘야 합니다.');
  return id;
}

function withProject(project, fn) {
  const original = process.env.CLAUDE_PROJECT_DIR;
  process.env.CLAUDE_PROJECT_DIR = project;
  try { return fn(); } finally {
    if (original === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = original;
  }
}

function groupRecord(project, groupId, campaign = null) {
  const base = campaign
    ? path.join(project, '.claude', 'campaigns', campaign)
    : mcpTaskRoot(project);
  return JSON.parse(fs.readFileSync(path.join(base, groupId, 'GROUP.json'), 'utf8'));
}

function writeLegacyTask(dir, groupId) {
  fs.mkdirSync(dir, { recursive: true });
  const record = {
    number: 1,
    content: '옛 태스크',
    tag: 'legacy',
    description: '',
    activeForm: '옛 태스크',
    status: 'pending',
    owner: 'surface:legacy',
    group_id: groupId,
    created_at: '2026-08-16T00:00:00.000Z',
    updated_at: '2026-08-16T00:00:00.000Z',
  };
  fs.writeFileSync(path.join(dir, 'task-1-pending-[legacy]-옛-태스크.json'), `${JSON.stringify(record, null, 2)}\n`);
}

function countGroupRecords(root) {
  let count = 0;
  const visited = new Set();
  function visit(dir) {
    if (!fs.existsSync(dir)) return;
    const real = fs.realpathSync(dir);
    if (visited.has(real)) return;
    visited.add(real);
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.name === 'GROUP.json') count += 1;
    }
  }
  visit(mcpTaskRoot(root));
  visit(legacyTaskRoot(root));
  visit(path.join(root, '.claude', 'campaigns'));
  return count;
}

test('G2: 새 그룹에 GROUP.json과 호출 패널 worker, null manager가 기록된다', () => {
  const project = fixture('task-mcp-g2-group-');
  const output = callTool(PROJECT_SERVER, project, 'task_group_add', {
    topic: '2026-08-02-2026-08-01-그룹',
    about: 'G2 그룹 설명',
  }, 'surface:worker');
  const groupId = /group_id="([^"]+)"/.exec(output)?.[1];
  assert.equal(groupId, `${today()}-그룹`);
  assert.match(output.split('\n')[0], /2026-08-02, 2026-08-01 를 뗐습니다/);

  const record = groupRecord(project, groupId);
  assert.equal(record.id, groupId);
  assert.equal(record.title, '그룹');
  assert.equal(record.about, 'G2 그룹 설명');
  assert.equal(record.status, 'pending');
  assert.equal(record.campaign, null);
  assert.deepEqual(record.worker, { name: 'surface:worker', surface: 'surface:worker' });
  assert.equal(record.manager, null);
  assert.equal(record.created_at, record.updated_at);
  const list = callTool(PROJECT_SERVER, project, 'task_group_list', { all: true });
  assert.match(list, /매니저 없음/);
  console.log(`group_id=${groupId}`);
  console.log('manager_null=true');
});

test('G2: 그룹 수정은 필드를 갱신하고 옛 그룹은 update에서만 승격한다', () => {
  const project = fixture('task-mcp-g2-upgrade-');
  const legacyId = '2026-07-01-legacy-group';
  const legacyDir = legacyTaskGroupDir(project, legacyId);
  writeLegacyTask(legacyDir, legacyId);
  const legacyTask = path.join(legacyDir, 'task-1-pending-[legacy]-옛-태스크.json');
  const legacyBefore = fs.readFileSync(legacyTask, 'utf8');
  const legacyRecordFile = path.join(legacyDir, 'GROUP.json');
  const promotedRecordFile = path.join(mcpTaskGroupDir(project, legacyId), 'GROUP.json');

  const getOutput = callTool(PROJECT_SERVER, project, 'task_group_get', { group_id: legacyId });
  const listOutput = callTool(PROJECT_SERVER, project, 'task_group_list', { all: true });
  assert.match(getOutput, /옛 그룹/);
  assert.match(listOutput, /옛 그룹/);
  assert.equal(fs.existsSync(legacyRecordFile), false);
  assert.equal(fs.existsSync(mcpTaskRoot(project)), false);

  callTool(PROJECT_SERVER, project, 'task_group_update', {
    group_id: legacyId,
    title: '승격된 옛 그룹',
    about: '명시적으로 승격',
    status: 'in_progress',
    worker: { name: 'WRKR3', surface: 'surface:90' },
    manager: { name: 'MNGR3', surface: 'surface:87' },
  });
  assert.equal(fs.existsSync(legacyRecordFile), false);
  assert.equal(fs.readFileSync(legacyTask, 'utf8'), legacyBefore);
  assert.equal(fs.existsSync(promotedRecordFile), true);
  const record = JSON.parse(fs.readFileSync(promotedRecordFile, 'utf8'));
  assert.equal(record.title, '승격된 옛 그룹');
  assert.equal(record.about, '명시적으로 승격');
  assert.equal(record.status, 'in_progress');
  assert.deepEqual(record.worker, { name: 'WRKR3', surface: 'surface:90' });
  assert.deepEqual(record.manager, { name: 'MNGR3', surface: 'surface:87' });
  console.log('legacy_read_writes=0');
  console.log('legacy_upgrade_writes=1');
});

test('G2: 예약 폴더 셋은 모든 그룹 탐색에서 제외되고 예약 이름 생성도 거부된다', () => {
  const project = fixture('task-mcp-g2-reserved-');
  const campaign = addCampaign(project);
  const campaignDir = path.join(project, '.claude', 'campaigns', campaign);
  for (const reserved of RESERVED_CAMPAIGN_DIRS) fs.mkdirSync(path.join(campaignDir, reserved), { recursive: true });

  const fresh = callTool(PROJECT_SERVER, project, 'task_group_list', { campaign, all: true });
  assert.match(fresh, /태스크 그룹 없음/);
  withProject(project, () => {
    assert.deepEqual(campaignGroupIds(campaign), []);
    assert.deepEqual(listGroupIds(), []);
    for (const reserved of RESERVED_CAMPAIGN_DIRS) {
      assert.equal(groupPath(reserved).campaign, null);
      assert.equal(groupPath(reserved).dir, mcpTaskGroupDir(project, reserved));
    }
  });

  for (const reserved of RESERVED_CAMPAIGN_DIRS) {
    const error = callToolError(PROJECT_SERVER, project, 'task_group_add', { topic: reserved });
    assert.match(error, /예약 폴더 이름/);
  }
  console.log('fresh_campaign_groups=0');
  console.log(`reserved_filtered=${RESERVED_CAMPAIGN_DIRS.size}`);
});

test('G2: 캠페인 소속·중복 위치·없는 캠페인·없는 그룹 오류를 지킨다', () => {
  const project = fixture('task-mcp-g2-errors-');
  const campaign = addCampaign(project);
  const campaignOutput = callTool(PROJECT_SERVER, project, 'task_group_add', {
    topic: '캠페인 그룹',
    campaign,
    worker: { name: 'WRKR3', surface: 'surface:90' },
  });
  const campaignGroupId = /group_id="([^"]+)"/.exec(campaignOutput)?.[1];
  assert.equal(groupRecord(project, campaignGroupId, campaign).campaign, campaign);

  callTool(PROJECT_SERVER, project, 'task_group_add', { topic: '중복 그룹' });
  assert.match(callToolError(PROJECT_SERVER, project, 'task_group_add', {
    topic: '중복 그룹',
    campaign,
  }), /이미 있는 그룹/);
  assert.match(callToolError(PROJECT_SERVER, project, 'task_group_add', {
    topic: '없는 캠페인 그룹',
    campaign: 'missing-campaign',
  }), /캠페인 .* 없음/);
  assert.match(callToolError(PROJECT_SERVER, project, 'task_add', {
    group_id: 'missing-group',
    content: '생기면 안 되는 태스크',
  }), /task_group_add/);
  assert.equal(fs.existsSync(mcpTaskGroupDir(project, 'missing-group')), false);
  assert.equal(fs.existsSync(legacyTaskGroupDir(project, 'missing-group')), false);
  console.log('missing_group_files=0');
});

test('G2: 태스크와 GROUP.json이 없는 폴더는 그룹 목록에서 제외된다', () => {
  const project = fixture('task-mcp-g2-empty-directory-');
  const emptyId = 'empty-material';
  const materialId = 'assets-source';
  fs.mkdirSync(mcpTaskGroupDir(project, emptyId), { recursive: true });
  fs.mkdirSync(mcpTaskGroupDir(project, materialId), { recursive: true });
  fs.writeFileSync(path.join(mcpTaskGroupDir(project, materialId), 'artifact.txt'), '자료 파일\n');

  withProject(project, () => {
    assert.equal(listGroupIds().includes(emptyId), true);
    assert.equal(listGroupIds().includes(materialId), true);
  });
  for (const all of [false, true]) {
    const list = callTool(PROJECT_SERVER, project, 'task_group_list', { all });
    assert.doesNotMatch(list, new RegExp(`\\[${emptyId}\\]`));
    assert.doesNotMatch(list, new RegExp(`\\[${materialId}\\]`));
  }
  console.log('empty_directory_candidates=2');
  console.log('empty_directory_dashboard_rows=0');
  console.log('listGroupIds_boundary_unchanged=true');
});

test('G2: task_group_add로 만든 태스크 0개 빈 그룹은 목록에 남는다', () => {
  const project = fixture('task-mcp-g2-empty-recorded-group-');
  const output = callTool(PROJECT_SERVER, project, 'task_group_add', { topic: '빈 명시 그룹' });
  const groupId = /group_id="([^"]+)"/.exec(output)?.[1];
  assert.ok(groupId);
  const files = fs.readdirSync(mcpTaskGroupDir(project, groupId));
  assert.deepEqual(files, ['GROUP.json']);

  for (const all of [false, true]) {
    const list = callTool(PROJECT_SERVER, project, 'task_group_list', { all });
    assert.match(list, new RegExp(`\\[${groupId}\\]`));
    assert.match(list, /태스크 0\/0 완료/);
  }
  console.log('recorded_empty_group_task_files=0');
  console.log('recorded_empty_group_visible=true');
});

test('G2: 기존 그룹의 task_add는 activeForm을 유지하고 옛 그룹 50개가 모두 보인다', () => {
  const project = fixture('task-mcp-g2-legacy-list-');
  for (let number = 1; number <= 50; number += 1) {
    const id = `legacy-${String(number).padStart(2, '0')}`;
    const dir = legacyTaskGroupDir(project, id);
    if (number === 1) fs.mkdirSync(dir, { recursive: true });
    else writeLegacyTask(dir, id);
  }
  const target = 'legacy-01';
  callTool(PROJECT_SERVER, project, 'task_add', {
    group_id: target,
    content: '옛 그룹에 추가',
    activeForm: 'activeForm 유지 중',
  }, 'surface:legacy-worker');
  const promotedDir = mcpTaskGroupDir(project, target);
  const taskFile = fs.readdirSync(promotedDir)
    .find((file) => file.startsWith('task-1-'));
  const task = JSON.parse(fs.readFileSync(path.join(promotedDir, taskFile), 'utf8'));
  assert.equal(task.activeForm, 'activeForm 유지 중');
  assert.deepEqual(fs.readdirSync(legacyTaskGroupDir(project, target)), []);

  const list = callTool(PROJECT_SERVER, project, 'task_group_list', { all: true });
  const legacyRows = list.split('\n').filter((line) => /^\[legacy-\d+\]/.test(line));
  assert.equal(legacyRows.length, 50);
  console.log(`legacy_fixture_groups=${legacyRows.length}`);
  console.log('activeForm_preserved=true');
});

test('G2: 그룹 도구 4개가 같은 순서로 계속 노출된다', () => {
  const project = fixture('task-mcp-g2-tools-');
  const tools = listTools(PROJECT_SERVER, project);
  assert.deepEqual(tools.slice(0, 4), [
    'task_group_add',
    'task_group_update',
    'task_group_get',
    'task_group_list',
  ]);
  console.log('g2_group_tool_count=4');
  console.log(`visible_tool_count=${tools.length}`);
});

test('G2: 실물 그룹 대시보드 읽기는 GROUP.json을 만들지 않는다', () => {
  const before = countGroupRecords(REPO);
  callTool(PROJECT_SERVER, REPO, 'task_group_list', { all: true });
  const after = countGroupRecords(REPO);
  assert.equal(after, before);
  const realGroups = withProject(REPO, () => listGroupIds().length);
  assert.ok(realGroups >= 50);
  console.log(`real_group_ids=${realGroups}`);
  console.log(`real_group_records_before=${before}`);
  console.log(`real_group_records_after=${after}`);
});
