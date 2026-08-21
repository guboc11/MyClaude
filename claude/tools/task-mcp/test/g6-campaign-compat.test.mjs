import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';

import { parseMarkdownRecord, today } from '../lib.mjs';
import {
  PROJECT_SERVER,
  REPO,
  callTool,
  callToolError,
  listTools,
  listToolsOutput,
  makeProject,
  removeProject,
} from './helpers.mjs';

const projects = [];
const REAL_LEGACY_CAMPAIGNS = [
  '2026-q3-project-remodel',
  'envelope-mcheong-sales-test',
  'envelope-video',
  'mcheong-design-quality',
];

after(() => {
  for (const project of projects) removeProject(project);
});

function fixture(prefix) {
  const project = makeProject(prefix);
  projects.push(project);
  return project;
}

function addCampaign(project, name = 'G6 캠페인') {
  const output = callTool(PROJECT_SERVER, project, 'campaign_add', { name, about: 'G6 검증' });
  const id = /캠페인 생성: ([^\n]+)/.exec(output)?.[1];
  assert.ok(id, 'campaign_add가 생성한 캠페인 이름을 돌려줘야 합니다.');
  return { id, output };
}

function campaignPath(project, name, ...rest) {
  return path.join(project, '.claude', 'campaigns', name, ...rest);
}

function writeLegacyTask(dir, groupId) {
  fs.mkdirSync(dir, { recursive: true });
  const record = {
    number: 1,
    content: '옛 캠페인 태스크',
    tag: 'legacy',
    description: '',
    activeForm: '옛 캠페인 태스크',
    status: 'pending',
    owner: 'surface:legacy',
    group_id: groupId,
    created_at: '2026-08-16T00:00:00.000Z',
    updated_at: '2026-08-16T00:00:00.000Z',
  };
  fs.writeFileSync(path.join(dir, 'task-1-pending-[legacy]-옛-캠페인-태스크.json'), `${JSON.stringify(record, null, 2)}\n`);
}

function snapshotTrees(root, names) {
  const out = [];
  function visit(base, dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      const relative = path.relative(root, full).split(path.sep).join('/');
      if (entry.isDirectory()) {
        out.push({ path: `${relative}/`, type: 'dir' });
        visit(base, full);
      } else {
        const hash = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
        out.push({ path: relative, type: 'file', hash });
      }
    }
  }
  for (const name of names) {
    const dir = path.join(root, name);
    assert.ok(fs.existsSync(dir), `실물 옛 캠페인이 없습니다: ${name}`);
    visit(dir, dir);
  }
  return out;
}

test('G6: 최종 도구는 22개이며 campaign_plan 없이 캠페인 계약 5개만 노출한다', () => {
  const project = fixture('task-mcp-g6-tools-');
  const tools = listTools(PROJECT_SERVER, project);
  assert.equal(tools.length, 22);
  assert.equal(tools.includes('campaign_plan'), false);
  assert.deepEqual(tools.slice(-5), [
    'campaign_add',
    'campaign_read',
    'campaign_note',
    'campaign_research',
    'campaign_list',
  ]);

  const signatures = listToolsOutput(PROJECT_SERVER, project).split('\n')
    .filter((line) => line.startsWith('- campaign_'));
  assert.deepEqual(signatures, [
    '- campaign_add(name, about?)',
    '- campaign_read(name, full?)',
    '- campaign_note(name, title, text, topic?)',
    '- campaign_research(name, topic)',
    '- campaign_list()',
  ]);
  assert.match(callToolError(PROJECT_SERVER, project, 'campaign_plan', {}), /알 수 없는 도구: campaign_plan/);
  console.log('visible_tool_count=22');
  console.log('campaign_tools=add,read,note,research,list');
  console.log('campaign_plan_exposed=false');
});

test('G6: 새 캠페인은 연속 날짜를 모두 떼고 새 구조만 만들며 태스크 그룹 수가 0이다', () => {
  const project = fixture('task-mcp-g6-add-');
  const { id, output } = addCampaign(project, '2026-08-02-2026-08-01-새 캠페인');
  assert.equal(id, `${today()}-새-캠페인`);
  assert.match(output.split('\n')[0], /2026-08-02, 2026-08-01 를 뗐습니다/);

  const root = campaignPath(project, id);
  assert.deepEqual(fs.readdirSync(root).sort(), ['campaign-context', 'researches']);
  assert.deepEqual(fs.readdirSync(path.join(root, 'campaign-context')).sort(), [
    'INDEX.md',
    'MAIN_CONTEXT.md',
    'notes',
  ]);
  assert.deepEqual(fs.readdirSync(path.join(root, 'researches')), []);
  assert.match(fs.readFileSync(path.join(root, 'campaign-context', 'MAIN_CONTEXT.md'), 'utf8'), /^상태: 진행 중$/m);
  assert.match(callTool(PROJECT_SERVER, project, 'task_group_list', { campaign: id, all: true }), /태스크 그룹 없음/);
  assert.match(callTool(PROJECT_SERVER, project, 'campaign_read', { name: id, full: true }), /## 태스크 그룹 0개/);
  console.log(`new_campaign_id=${id}`);
  console.log('new_campaign_groups=0');
  console.log('new_campaign_reserved_dirs=campaign-context,researches');
});

test('G6: campaign_note는 호출마다 노트 한 장을 만들고 주제 폴더를 INDEX에 한 번만 올린다', () => {
  const project = fixture('task-mcp-g6-note-');
  const { id } = addCampaign(project);
  callTool(PROJECT_SERVER, project, 'campaign_note', {
    name: id,
    title: '분류 전 노트',
    text: '아직 주제를 정하지 않은 본문',
  }, 'surface:notes');
  callTool(PROJECT_SERVER, project, 'campaign_note', {
    name: id,
    title: '첫 결정',
    text: '결정 본문 1',
    topic: '결정',
  }, 'surface:author-a');
  callTool(PROJECT_SERVER, project, 'campaign_note', {
    name: id,
    title: '둘째 결정',
    text: '결정 본문 2',
    topic: '결정',
  }, 'surface:author-b');

  const context = campaignPath(project, id, 'campaign-context');
  assert.deepEqual(fs.readdirSync(path.join(context, 'notes')), ['note-1-분류-전-노트.md']);
  assert.deepEqual(fs.readdirSync(path.join(context, '결정')).sort(), [
    'note-1-첫-결정.md',
    'note-2-둘째-결정.md',
  ]);
  const first = parseMarkdownRecord(fs.readFileSync(path.join(context, '결정', 'note-1-첫-결정.md'), 'utf8'));
  assert.equal(first.metadata.number, '1');
  assert.equal(first.metadata.title, '첫 결정');
  assert.equal(first.metadata.author, 'surface:author-a');
  assert.equal(first.metadata.created_at, first.metadata.updated_at);
  assert.equal(first.body, '결정 본문 1');

  const index = fs.readFileSync(path.join(context, 'INDEX.md'), 'utf8');
  assert.equal((index.match(/\[결정\]\(결정\/\)/g) || []).length, 1);
  assert.doesNotMatch(index, /note-1-|note-2-/);
  assert.equal(fs.existsSync(campaignPath(project, id, 'main-context')), false);
  console.log('campaign_note_files=3');
  console.log('topic_index_entries=1');
  console.log('legacy_main_context_writes=0');
});

test('G6: 옛 캠페인에 새 노트·리서치를 써도 옛 파일은 그대로이고 리서치 폴더는 비어 있다', () => {
  const project = fixture('task-mcp-g6-legacy-write-');
  const id = 'legacy-write-campaign';
  const legacyContext = campaignPath(project, id, 'main-context');
  fs.mkdirSync(legacyContext, { recursive: true });
  const legacyFiles = {
    README: '# 옛 머리말\n\n상태: 옛 진행\n',
    INDEX: '# 옛 차례\n\n',
    NOTES: '# 옛 노트\n\n옛 본문\n',
  };
  for (const [name, body] of Object.entries(legacyFiles)) {
    fs.writeFileSync(path.join(legacyContext, `${name}.md`), body);
  }
  fs.writeFileSync(campaignPath(project, id, 'plans.md'), '# 계획서\n\n- old-plan\n');
  fs.writeFileSync(campaignPath(project, id, 'researches.md'), '# 조사\n\n- old-research\n');
  const oldPaths = [
    path.join(legacyContext, 'README.md'),
    path.join(legacyContext, 'INDEX.md'),
    path.join(legacyContext, 'NOTES.md'),
    campaignPath(project, id, 'plans.md'),
    campaignPath(project, id, 'researches.md'),
  ];
  const before = oldPaths.map((file) => fs.readFileSync(file, 'utf8'));

  callTool(PROJECT_SERVER, project, 'campaign_note', {
    name: id,
    title: '새 자리 노트',
    text: '새 본문',
  });
  const research = callTool(PROJECT_SERVER, project, 'campaign_research', {
    name: id,
    topic: '2026-08-03-2026-08-02-호환 조사',
  });
  assert.match(research.split('\n')[0], /2026-08-03, 2026-08-02 를 뗐습니다/);
  const researchId = `${today()}-호환-조사`;
  assert.deepEqual(fs.readdirSync(campaignPath(project, id, 'researches', researchId)), []);
  assert.deepEqual(oldPaths.map((file) => fs.readFileSync(file, 'utf8')), before);

  const read = callTool(PROJECT_SERVER, project, 'campaign_read', { name: id, full: true });
  assert.ok(read.startsWith('# 옛 머리말'));
  assert.match(read, /old-plan/);
  assert.match(read, /old-research/);
  assert.match(read, new RegExp(`researches/${researchId}/`));
  console.log('legacy_campaign_file_writes=0');
  console.log(`empty_research_folder=${researchId}`);
  console.log('legacy_status_fallback=true');
});

test('G6: campaign_read는 옛 파일과 새 폴더를 합쳐 정해진 순서와 그룹 문서 건수로 보여준다', () => {
  const project = fixture('task-mcp-g6-read-order-');
  const id = 'legacy-mixed-campaign';
  const legacyContext = campaignPath(project, id, 'main-context');
  const currentContext = campaignPath(project, id, 'campaign-context');
  fs.mkdirSync(legacyContext, { recursive: true });
  fs.mkdirSync(path.join(currentContext, 'notes'), { recursive: true });
  fs.mkdirSync(path.join(currentContext, '등록-주제'), { recursive: true });
  fs.mkdirSync(path.join(currentContext, '차례-밖-주제'), { recursive: true });
  fs.mkdirSync(campaignPath(project, id, 'researches', `${today()}-실물-조사`), { recursive: true });
  fs.writeFileSync(path.join(legacyContext, 'README.md'), '# 옛 머리말\n\n상태: 옛 상태\n');
  fs.writeFileSync(path.join(legacyContext, 'INDEX.md'),
    '# 옛 차례\n\n- [평평한 주제](flat.md)\n- [유령](ghost.md)\n');
  fs.writeFileSync(path.join(legacyContext, 'flat.md'), '# 평평한 주제\n');
  fs.writeFileSync(path.join(legacyContext, 'orphan.md'), '# 차례 밖 문서\n');
  fs.writeFileSync(path.join(currentContext, 'MAIN_CONTEXT.md'), '# 새 머리말\n\n상태: 새 상태\n');
  fs.writeFileSync(path.join(currentContext, 'INDEX.md'), '# 새 차례\n\n- [등록 주제](등록-주제/)\n');
  fs.writeFileSync(campaignPath(project, id, 'plans.md'), '# 옛 계획서\n\n- old-plan\n');
  fs.writeFileSync(campaignPath(project, id, 'researches.md'), '# 옛 조사\n\n- old-research\n');

  const groupId = `${today()}-legacy-group`;
  const group = campaignPath(project, id, groupId);
  writeLegacyTask(group, groupId);
  fs.writeFileSync(path.join(group, 'NOTES.md'), '# 옛 그룹 노트\n');
  fs.writeFileSync(path.join(group, 'plans.md'), '# 옛 그룹 계획서\n');

  const output = callTool(PROJECT_SERVER, project, 'campaign_read', { name: id, full: true });
  const positions = [
    output.indexOf('# 새 머리말'),
    output.indexOf('## 차례 (campaign-context)'),
    output.indexOf('! 차례와 실물이 어긋납니다'),
    output.indexOf('## 리서치 폴더'),
    output.indexOf('## 태스크 그룹'),
  ];
  assert.ok(positions.every((position) => position >= 0));
  assert.deepEqual([...positions].sort((a, b) => a - b), positions);
  assert.match(output, /\[평평한 주제\]\(flat\.md\)/);
  assert.match(output, /\[등록 주제\]\(등록-주제\/\)/);
  assert.match(output, /차례에 없는 문서·폴더: orphan\.md, 차례-밖-주제\//);
  assert.match(output, /실물이 없는 등재: ghost\.md/);
  assert.match(output, /옛 plans\.md 1건 \(읽기 전용\)/);
  assert.match(output, /옛 researches\.md 1건 \(읽기 전용\)/);
  assert.match(output, /노트 1 · 계획서 1/);
  assert.match(callTool(PROJECT_SERVER, project, 'campaign_list', {}), /legacy-mixed-campaign — 새 상태/);
  console.log('campaign_read_order=MAIN_CONTEXT,index,mismatch,researches,groups');
  console.log('legacy_flat_and_current_topic_visible=true');
  console.log('campaign_group_documents=notes:1,plans:1');
});

test('G6: 실물 옛 캠페인 네 개는 campaign_list·campaign_read 뒤에도 파일 경로와 내용이 같다', () => {
  const root = path.join(REPO, '.claude', 'campaigns');
  const before = snapshotTrees(root, REAL_LEGACY_CAMPAIGNS);
  const list = callTool(PROJECT_SERVER, REPO, 'campaign_list', {});
  for (const name of REAL_LEGACY_CAMPAIGNS) {
    assert.match(list, new RegExp(`^- ${name} —`, 'm'));
    const output = callTool(PROJECT_SERVER, REPO, 'campaign_read', { name, full: true });
    assert.match(output, /## 태스크 그룹/);
  }
  const afterSnapshot = snapshotTrees(root, REAL_LEGACY_CAMPAIGNS);
  assert.deepEqual(afterSnapshot, before);
  console.log(`real_legacy_campaigns=${REAL_LEGACY_CAMPAIGNS.length}`);
  console.log(`real_legacy_entries=${before.length}`);
  console.log('real_legacy_campaign_writes=0');
});
