import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

import {
  LEGACY_SERVER,
  PROJECT_SERVER,
  REPO,
  callTool,
  callToolDirect,
  countCampaigns,
  countTaskFiles,
  legacyTaskGroupDir,
  listTools,
  makeLegacyReadView,
  makeProject,
  mcpTaskGroupDir,
  normalize,
  removeProject,
  snapshotProject,
} from './helpers.mjs';

const projects = [];
const LEGACY_TOOLS = [
  'task_add',
  'task_update',
  'task_get',
  'task_list',
  'campaign_add',
  'campaign_read',
  'campaign_note',
  'campaign_plan',
  'campaign_research',
  'campaign_list',
];
const RETAINED_LEGACY_NAMES = LEGACY_TOOLS.filter((name) => name !== 'campaign_plan');

after(() => {
  for (const project of projects) removeProject(project);
});

function fixture(prefix) {
  const project = makeProject(prefix);
  projects.push(project);
  return project;
}

function normalizeCampaignHint(value) {
  return String(value).replace(
    /^(이 그룹은 캠페인 "[^"]+" 소속 — ).+$/gm,
    '$1<CONTEXT_HINT>',
  );
}

function normalizeTaskRootHint(value) {
  return String(value).replace(
    /\.claude\/(?:tasks|mcp-task)(?=\/|[\s)\]}",.:;]|$)/g,
    '.claude/<TASK_ROOT>',
  );
}

function normalizeTaskRootSnapshot(files) {
  return files.map((entry) => ({
    ...entry,
    file: entry.file.replace(
      /^\.claude\/(?:tasks|mcp-task)(?=\/|$)/,
      '.claude/<TASK_ROOT>',
    ),
  }));
}

function normalizeScenarioOutput(output) {
  return output.map((value) => normalizeTaskRootHint(value));
}

function assertOnlyTaskRoot(files, rootName) {
  const taskFiles = files.filter((entry) => /^\.claude\/(?:tasks|mcp-task)\//.test(entry.file));
  assert.ok(taskFiles.length > 0, `${rootName} 아래 비교 파일이 있어야 합니다.`);
  assert.ok(taskFiles.every((entry) => entry.file.startsWith(`.claude/${rootName}/`)));
}

function legacyCampaignNames() {
  const root = path.join(REPO, '.claude', 'campaigns');
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => !fs.existsSync(path.join(root, name, 'campaign-context', 'MAIN_CONTEXT.md')))
    .sort();
}

function campaignRow(output, name) {
  return String(output).split('\n').find((line) => line.startsWith(`- ${name} —`));
}

function seedTasks(dir) {
  const groupId = '2026-08-16-g1-work';
  fs.mkdirSync(dir, { recursive: true });
  const records = [
    {
      number: 1,
      content: '첫 태스크',
      tag: 'core',
      description: '분리 전후 상세 설명',
      activeForm: '첫 태스크를 처리하는 중',
      status: 'pending',
      owner: 'surface:g1',
      group_id: groupId,
      created_at: '2026-08-16T00:00:00.000Z',
      updated_at: '2026-08-16T00:00:00.000Z',
    },
    {
      number: 2,
      content: '둘째 태스크',
      tag: 'follow-up',
      description: '',
      activeForm: '둘째 태스크',
      status: 'pending',
      owner: 'surface:g1',
      group_id: groupId,
      created_at: '2026-08-16T00:00:00.000Z',
      updated_at: '2026-08-16T00:00:00.000Z',
    },
  ];
  fs.writeFileSync(path.join(dir, 'task-1-pending-[core]-첫-태스크.json'), `${JSON.stringify(records[0], null, 2)}\n`);
  fs.writeFileSync(path.join(dir, 'task-2-pending-[follow-up]-둘째-태스크.json'), `${JSON.stringify(records[1], null, 2)}\n`);
  return groupId;
}

function runScenario(server, project, dir) {
  const output = [];
  const call = (name, args) => output.push(normalize(callTool(server, project, name, args)));
  const groupId = seedTasks(dir);
  call('task_list', { all: true });
  call('task_list', { group_id: groupId, all: true });

  return { output, files: snapshotProject(project) };
}

test('G1: 후속 단계에서 계약이 바뀌지 않은 기존 도구의 동작·출력·파일 결과가 분리 전과 같다', () => {
  const legacyProject = fixture('task-mcp-g1-legacy-');
  const splitProject = fixture('task-mcp-g1-split-');
  const groupId = '2026-08-16-g1-work';
  const legacy = runScenario(LEGACY_SERVER, legacyProject, legacyTaskGroupDir(legacyProject, groupId));
  const split = runScenario(PROJECT_SERVER, splitProject, mcpTaskGroupDir(splitProject, groupId));

  assertOnlyTaskRoot(legacy.files, 'tasks');
  assertOnlyTaskRoot(split.files, 'mcp-task');
  assert.deepEqual(normalizeScenarioOutput(split.output), normalizeScenarioOutput(legacy.output));
  assert.deepEqual(normalizeTaskRootSnapshot(split.files), normalizeTaskRootSnapshot(legacy.files));
  console.log(`fixture_calls=${split.output.length}`);
  console.log(`fixture_files=${split.files.length}`);
  console.log('legacy_task_root=.claude/tasks');
  console.log('split_task_root=.claude/mcp-task');
  console.log('fixture_parity=true');
});

test('G1: 저장 뿌리 정규화는 정확한 경로 한 종류만 지운다', () => {
  assert.equal(
    normalizeTaskRootHint('저장 .claude/tasks/group/task-1.json'),
    '저장 .claude/<TASK_ROOT>/group/task-1.json',
  );
  assert.equal(
    normalizeTaskRootHint('저장 .claude/mcp-task/group/task-1.json'),
    '저장 .claude/<TASK_ROOT>/group/task-1.json',
  );
  assert.equal(
    normalizeTaskRootHint('보존 .claude/tasks-archive/group 및 본문 tasks'),
    '보존 .claude/tasks-archive/group 및 본문 tasks',
  );
  const snapshot = normalizeTaskRootSnapshot([
    { file: '.claude/tasks/group/task-1.json', content: '본문 .claude/tasks 는 유지' },
    { file: '.claude/tasks-archive/record.json', content: '그대로' },
  ]);
  assert.deepEqual(snapshot, [
    { file: '.claude/<TASK_ROOT>/group/task-1.json', content: '본문 .claude/tasks 는 유지' },
    { file: '.claude/tasks-archive/record.json', content: '그대로' },
  ]);
  console.log('task_root_normalization_only=true');
});

test('G1: 분리 전 도구 이름 중 4-5에서 제거하기로 한 campaign_plan만 빠진다', () => {
  const project = fixture('task-mcp-g1-tools-');
  const legacy = listTools(LEGACY_SERVER, project);
  const split = listTools(PROJECT_SERVER, project);

  assert.deepEqual(legacy, LEGACY_TOOLS);
  assert.deepEqual(split.filter((name) => RETAINED_LEGACY_NAMES.includes(name)), RETAINED_LEGACY_NAMES);
  assert.equal(split.includes('campaign_plan'), false);
  console.log(`legacy_tool_count=${legacy.length}`);
  console.log(`split_tool_count=${split.length}`);
});

test('G1: 실물 태스크·옛 캠페인 목록은 읽기 결과가 같고 파일 수가 줄지 않는다', async () => {
  const taskFilesBefore = countTaskFiles(REPO);
  const campaignsBefore = countCampaigns(REPO);
  const legacyView = makeLegacyReadView(REPO);
  projects.push(legacyView);
  const [legacyTasks, splitTasks] = await Promise.all([
    callToolDirect(LEGACY_SERVER, legacyView, 'task_list', { all: true }),
    callToolDirect(PROJECT_SERVER, REPO, 'task_list', { all: true }),
  ]);
  const legacyCampaigns = callTool(LEGACY_SERVER, legacyView, 'campaign_list', {});
  const splitCampaigns = callTool(PROJECT_SERVER, REPO, 'campaign_list', {});

  assert.equal(normalizeCampaignHint(splitTasks), normalizeCampaignHint(legacyTasks));
  const legacyNames = legacyCampaignNames();
  for (const name of legacyNames) {
    assert.equal(campaignRow(splitCampaigns, name), campaignRow(legacyCampaigns, name));
  }
  assert.equal(countTaskFiles(REPO), taskFilesBefore);
  assert.equal(countCampaigns(REPO), campaignsBefore);
  console.log(`real_task_files=${taskFilesBefore}`);
  console.log(`real_campaigns=${campaignsBefore}`);
  console.log(`real_legacy_campaigns=${legacyNames.length}`);
  console.log('real_task_list_parity=true');
  console.log('real_legacy_campaign_list_parity=true');
});
