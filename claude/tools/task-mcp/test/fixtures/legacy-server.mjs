#!/usr/bin/env node
// 2026-08-16 분리 전 코드의 언 사본이며 G1의 비교 기준이니 고치지 말 것.
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
// 캠페인 = 그룹 위의 한 층. 여러 태스크 그룹과 여러 계획서·조사가 딸리는 큰 일을 담는다.
// 날짜 접두를 붙이지 않는다 — 몇 달을 가므로 시작일이 이름에 박히면 방해가 된다.
function campaignsRoot() {
  return path.join(projectDir(), '.claude', 'campaigns');
}
function safeName(name) {
  return String(name ?? '').replace(/[\\/]/g, '').trim();
}
function campaignDir(name) {
  return path.join(campaignsRoot(), safeName(name));
}
function mainContextDir(name) {
  return path.join(campaignDir(name), 'main-context');
}
function subDirNames(root) {
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch { return []; }
}
function listCampaignNames() {
  return subDirNames(campaignsRoot()).sort();
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
  // KST 기준 날짜. toISOString은 UTC라 KST 00:00~08:59에 그룹 폴더가 어제 날짜로 찍힌다 (2026-07-30 발견).
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
}
function now() {
  return new Date().toISOString();
}

function groupPath(groupId) {
  // groupId = 폴더명 "{date}-{slug}". 하위경로 이탈 방지.
  // 그룹은 두 자리에 산다: .claude/tasks/ 바로 아래, 또는 캠페인 한 겹 아래.
  // 어느 쪽에 있든 이름은 여전히 폴더명 하나다 — 경로로 바꾸면 기존 group_id 표기가 전부 어긋난다.
  const safe = safeName(groupId);
  const top = path.join(tasksRoot(), safe);
  if (fs.existsSync(top)) return { safe, dir: top, campaign: null };
  for (const c of listCampaignNames()) {
    const inCampaign = path.join(campaignsRoot(), c, safe);
    if (fs.existsSync(inCampaign)) return { safe, dir: inCampaign, campaign: c };
  }
  // 없는 그룹이면 기존과 같은 경로를 돌려준다(오류 메시지가 이전과 같게).
  return { safe, dir: top, campaign: null };
}
function ensureGroupForTopic(topic, campaign) {
  const id = `${today()}-${slug(topic)}`;
  const c = campaign ? requireCampaign(campaign) : null;
  const dir = c ? path.join(campaignDir(c), id) : path.join(tasksRoot(), id);
  // 한 이름이 두 자리에 살면 목록에서 한쪽이 가려진다. 찾을 때 헤매지 말고 만들 때 막는다.
  const found = groupPath(id);
  if (fs.existsSync(found.dir) && path.resolve(found.dir) !== path.resolve(dir)) {
    throw new Error(`그룹 이름 "${id}"이 이미 ${found.campaign ? `캠페인 "${found.campaign}"` : '.claude/tasks'} 아래 있습니다. 다른 주제로 만드세요.`);
  }
  fs.mkdirSync(dir, { recursive: true });
  return { id, dir, campaign: c };
}
function listGroupIds() {
  // 두 자리를 함께 훑는다. 돌려주는 것은 예전처럼 그룹 이름뿐 —
  // 실제 경로는 호출부가 groupPath()로 푼다.
  const out = [...subDirNames(tasksRoot())];
  for (const c of listCampaignNames()) {
    out.push(...subDirNames(path.join(campaignsRoot(), c)).filter((n) => n !== 'main-context'));
  }
  return [...new Set(out)].sort();
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
// 태스크부터 집은 세션이 맥락으로 가는 길을 보게 하는 한 줄. 캠페인에 안 속한 그룹에는 아무것도 안 붙는다.
function campaignHint(campaign) {
  return campaign ? `이 그룹은 캠페인 "${campaign}" 소속 — main-context/README.md 먼저\n` : '';
}
function renderGroup(id, tasks, showOwner = false) {
  if (!tasks.length) return `[${id}] (비어 있음)`;
  const lines = tasks.map((t) => `  ${MARK[t.status] || '[ ]'} ${t.number}. ${t.tag ? `[${t.tag}] ` : ''}${t.content} (${t.status})${t.description ? '  +상세' : ''}${showOwner && t.owner ? `  @${String(t.owner).slice(0, 8)}` : ''}`);
  const done = tasks.filter((t) => t.status === 'completed').length;
  return `[${id}]  ${done}/${tasks.length} 완료\n${lines.join('\n')}`;
}

// ---- tool 구현 ----
function toolAdd({ group, content, tag, description, activeForm, campaign }) {
  if (!group || !content) throw new Error('group, content는 필수입니다.');
  const { id, dir, campaign: camp } = ensureGroupForTopic(group, campaign);
  const existing = readTasks(dir);
  const number = (existing.reduce((m, t) => Math.max(m, t.number), 0)) + 1;
  const status = 'pending';
  const rec = {
    number, content, tag: tag || '', description: description || '', activeForm: activeForm || content,
    status, owner: OWNER, group_id: id, created_at: now(), updated_at: now(),
  };
  fs.writeFileSync(path.join(dir, taskFileName(number, status, content, rec.tag)), JSON.stringify(rec, null, 2) + '\n');
  const tasks = readTasks(dir).filter((t) => (t.owner || '') === OWNER);
  return `추가됨: group_id="${id}", number=${number}.\n${campaignHint(camp)}${renderGroup(id, tasks)}\n\n(업데이트는 task_update{group_id:"${id}", number:${number}, status})`;
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
  const { safe, dir, campaign } = groupPath(group_id);
  const cur = findTaskFile(dir, number);
  if (!cur) throw new Error(`task-${number} 를 group "${safe}" 에서 못 찾음.`);
  const rec = JSON.parse(fs.readFileSync(path.join(dir, cur), 'utf8'));
  return `${campaignHint(campaign)}[${safe}] #${number} (${rec.status})${rec.tag ? ` [${rec.tag}]` : ''}\n제목: ${rec.content}\n\n설명:\n${rec.description || '(없음)'}`;
}
function toolList({ group_id, all } = {}) {
  // 기본: 내 패널(owner) 것만. all=true면 다른 패널 포함 전체(오버사이트).
  const mine = (tasks) => (all ? tasks : tasks.filter((t) => (t.owner || '') === OWNER));
  if (group_id) {
    const { safe, dir, campaign } = groupPath(group_id);
    return campaignHint(campaign) + renderGroup(safe, mine(readTasks(dir)), !!all);
  }
  const blocks = [];
  for (const id of listGroupIds()) {
    const { dir, campaign } = groupPath(id);
    const tasks = mine(readTasks(dir));
    if (tasks.length) blocks.push(campaignHint(campaign) + renderGroup(id, tasks, !!all));
  }
  if (!blocks.length) return all ? '태스크 없음. task_add로 시작하세요.' : '내 태스크 없음(다른 패널 것 보려면 all:true).';
  return blocks.join('\n\n');
}

// ---- 캠페인 ----
// 파일 만들기는 exclusive create('ax')로 한다 — writeFileSync는 자르기라
// 두 패널이 동시에 첫 글을 적으면 한쪽 내용이 사라진다. 이어붙이기는 항상 append.
function createIfAbsent(p, header) {
  try { fs.writeFileSync(p, header, { flag: 'ax' }); } catch { /* 이미 있음 */ }
}
function readTextOr(p, fallback = '') {
  try { return fs.readFileSync(p, 'utf8'); } catch { return fallback; }
}
// 설계상 차례에 올리지 않는 문서 — 정합 검사에서 제외한다.
// NOTES.md는 던져두는 자리이지 주제 문서가 아니다. 이걸 어긋남으로 치면 노트를 쓰는
// 캠페인마다 영구 경고가 붙고, 경보가 소음이 되면 진짜 어긋남을 놓친다.
const UNLISTED_DOCS = new Set(['README.md', 'INDEX.md', 'NOTES.md']);
function contextDocs(name) {
  try {
    return fs.readdirSync(mainContextDir(name))
      .filter((f) => f.endsWith('.md') && !UNLISTED_DOCS.has(f))
      .sort();
  } catch { return []; }
}
function indexEntries(name) {
  const txt = readTextOr(path.join(mainContextDir(name), 'INDEX.md'));
  return [...txt.matchAll(/^- \[[^\]]*\]\(([^)]+)\)/gm)].map((m) => m[1]);
}
function registerInIndex(name, file, summary) {
  if (indexEntries(name).includes(file)) return false;
  fs.appendFileSync(path.join(mainContextDir(name), 'INDEX.md'),
    `- [${file.replace(/\.md$/, '')}](${file}) — ${summary}\n`);
  return true;
}
function campaignGroupIds(name) {
  return subDirNames(campaignDir(name)).filter((n) => n !== 'main-context').sort();
}
function campaignStatus(name) {
  const m = readTextOr(path.join(mainContextDir(name), 'README.md')).match(/^상태:\s*(.+)$/m);
  return m ? m[1].trim() : '';
}
function attachedLines(name, file) {
  return readTextOr(path.join(campaignDir(name), file))
    .split('\n').filter((l) => l.trim().startsWith('- '));
}
function requireCampaign(name) {
  const id = safeName(name);
  if (!id || !fs.existsSync(campaignDir(id))) {
    throw new Error(`캠페인 "${id}" 없음. campaign_list로 확인하거나 campaign_add로 만드세요.`);
  }
  return id;
}

function toolCampaignAdd({ name, about }) {
  if (!name) throw new Error('name은 필수입니다.');
  const id = slug(name); // 캠페인은 날짜 접두를 붙이지 않는다 — 몇 달을 가므로 시작일이 방해가 된다
  if (fs.existsSync(campaignDir(id))) throw new Error(`이미 있는 캠페인입니다: ${id}`);
  fs.mkdirSync(mainContextDir(id), { recursive: true });
  createIfAbsent(path.join(mainContextDir(id), 'README.md'),
    `# ${id}\n\n상태: 진행 중\n\n${about || '(설명 없음 — 이 자리에 무엇을 왜 하는 일이고 무엇은 안 할지 적는다)'}\n\n` +
    `> 이 문서는 사람이 관리한다. 도구는 만들 때 말고는 건드리지 않는다.\n` +
    `> 끝나면 위 "상태:" 줄을 "상태: 종료 (YYYY-MM-DD) — 한 줄 이유" 로 바꾼다.\n`);
  createIfAbsent(path.join(mainContextDir(id), 'INDEX.md'), `# ${id} — main-context 차례\n\n`);
  return `캠페인 생성: ${id}\n- .claude/campaigns/${id}/main-context/README.md (머리말 — 이후 사람이 관리)\n\n` +
    `(태스크는 task_add{campaign:"${id}"}, 맥락은 campaign_note{name:"${id}"}, 펼쳐보기는 campaign_read{name:"${id}"})`;
}

function toolCampaignRead({ name, full } = {}) {
  const id = requireCampaign(name);
  const out = [readTextOr(path.join(mainContextDir(id), 'README.md'), '(README 없음)').trim()];

  // 차례 — 도구가 관리한다
  const docs = contextDocs(id), idx = indexEntries(id);
  out.push(`## 차례 (main-context)\n${idx.length
    ? readTextOr(path.join(mainContextDir(id), 'INDEX.md')).split('\n').filter((l) => l.startsWith('- ')).join('\n')
    : '(빈 차례)'}`);

  // 실물과 차례가 어긋나면 알리기만 한다. 빠진 게 실수인지 일부러인지 도구는 알 수 없다.
  const notIndexed = docs.filter((d) => !idx.includes(d));
  const ghosts = idx.filter((f) => !docs.includes(f));
  if (notIndexed.length || ghosts.length) {
    out.push(`! 차례와 실물이 어긋납니다 (자동으로 고치지 않습니다)\n` +
      `  차례에 없는 문서: ${notIndexed.length ? notIndexed.join(', ') : '없음'}\n` +
      `  실물이 없는 등재: ${ghosts.length ? ghosts.join(', ') : '없음'}`);
  }

  // 계획서·조사 — 기본은 건수만, 전체는 full:true
  const plans = attachedLines(id, 'plans.md'), researches = attachedLines(id, 'researches.md');
  // 기본 출력에도 가장 최근 1건은 요약까지 보인다 — 건수만으로는 "어디까지 왔는지"가 안 잡힌다.
  // 매단 순서가 곧 시간순이므로 마지막 줄이 최신이다.
  const latest = (lines, label) => (lines.length ? `\n  최근 ${label}: ${lines[lines.length - 1].replace(/^-\s*/, '')}` : '');
  out.push(full
    ? `## 계획서 ${plans.length}건\n${plans.join('\n') || '(없음)'}\n\n## 조사 ${researches.length}건\n${researches.join('\n') || '(없음)'}`
    : `## 계획서 ${plans.length}건 · 조사 ${researches.length}건  (목록은 full:true)` +
      latest(plans, '계획서') + latest(researches, '조사'));

  // 그룹 — 기본은 진행 중인 것만
  const gids = campaignGroupIds(id);
  const blocks = [];
  let hidden = 0;
  for (const g of gids) {
    const tasks = readTasks(groupPath(g).dir);
    const open = tasks.filter((t) => t.status !== 'completed').length;
    if (!full && (!tasks.length || open === 0)) { hidden += 1; continue; }
    blocks.push(renderGroup(g, tasks, true));
  }
  out.push(`## 태스크 그룹 ${gids.length}개\n${blocks.join('\n\n') || '(진행 중인 그룹 없음)'}` +
    (hidden ? `\n\n(끝났거나 빈 그룹 ${hidden}개는 숨김 — full:true로 전체)` : ''));

  return out.join('\n\n');
}

function toolCampaignNote({ name, text, doc }) {
  const id = requireCampaign(name);
  if (!text) throw new Error('text는 필수입니다.');
  const file = doc ? `${slug(doc, 40)}.md` : 'NOTES.md';
  const p = path.join(mainContextDir(id), file);
  const fresh = !fs.existsSync(p);
  createIfAbsent(p, doc
    ? `# ${slug(doc, 40)}\n`
    : `# NOTES — 던져두는 자리\n\n> 뭉치면 주제 문서로 옮긴다. 옮기는 일은 사람이 시킬 때 사람이 한다.\n`);
  fs.appendFileSync(p, `\n## ${now()} · ${(OWNER || 'unknown').slice(0, 8)}\n\n${text}\n`);
  const listed = doc ? registerInIndex(id, file, String(text).split('\n')[0].slice(0, 60)) : false;
  return `적었습니다 — main-context/${file}${fresh ? ' (새 문서)' : ''}${listed ? ' · 차례 등재' : ''}`;
}

function attach(name, file, label, targetPath, summary) {
  const id = requireCampaign(name);
  if (!targetPath) throw new Error('path는 필수입니다.');
  const p = path.join(campaignDir(id), file);
  if (attachedLines(id, file).some((l) => l.includes(targetPath))) {
    return `이미 매달려 있습니다 — ${file}: ${targetPath}`;
  }
  createIfAbsent(p, `# ${label}\n`);
  fs.appendFileSync(p, `\n- ${targetPath}${summary ? ` — ${summary}` : ''} (${today()})\n`);
  return `매달았습니다 — ${file}: ${targetPath}`;
}
const toolCampaignPlan = ({ name, path: p, summary }) => attach(name, 'plans.md', '계획서', p, summary);
const toolCampaignResearch = ({ name, path: p, summary }) => attach(name, 'researches.md', '조사', p, summary);

function toolCampaignList() {
  const names = listCampaignNames();
  if (!names.length) return '캠페인 없음. campaign_add로 시작하세요.';
  const rows = names.map((n) => {
    const gids = campaignGroupIds(n);
    let open = 0, total = 0;
    for (const g of gids) {
      const ts = readTasks(groupPath(g).dir);
      total += ts.length;
      open += ts.filter((t) => t.status !== 'completed').length;
    }
    return `- ${n} — ${campaignStatus(n) || '상태 미표기'} · 그룹 ${gids.length} · 남은 태스크 ${open}/${total}`;
  });
  return `${rows.join('\n')}\n\n(펼쳐보기: campaign_read{name:"…"})`;
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
        campaign: { type: 'string', description: '캠페인 이름(선택). 주면 그룹이 그 캠페인 아래 생기고, 목록·조회에 소속이 표시된다. 없는 캠페인이면 튕긴다.' },
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
  {
    name: 'campaign_add',
    description: '캠페인을 만든다. 캠페인 = 그룹 위의 한 층으로, 여러 태스크 그룹과 여러 계획서·조사가 딸리는 큰 일을 담는다. 단발이면 그냥 task_add를 쓴다. 이름은 부르는 사람이 정한 그대로 쓴다 — 그룹과 달리 도구가 날짜를 앞에 붙이지 않으니, 날짜나 상태를 넣지 말라고 사용자를 말리지 않는다.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        name: { type: 'string', description: '캠페인 이름(주제). 예: "auth-overhaul"' },
        about: { type: 'string', description: 'README 머리말이 될 설명 — 무엇을 왜 하는 일이고 무엇은 안 할지' },
      },
      required: ['name'],
    },
  },
  {
    name: 'campaign_read',
    description: '캠페인 하나를 펼친다. 새 세션은 이것 하나만 읽고 일을 이어갈 수 있어야 한다. 기본은 머리말 + 차례 + 진행 중인 그룹까지. 차례와 실물이 어긋나면 알리되 자동으로 고치지 않는다.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        name: { type: 'string', description: '캠페인 이름' },
        full: { type: 'boolean', description: 'true면 계획서·조사 전체 목록과 끝난 그룹까지 전부. 기본 false.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'campaign_note',
    description: '캠페인 맥락에 글을 이어붙인다. doc 없으면 NOTES.md(던져두는 자리), 주면 그 주제 문서에 붙고 없던 문서면 만들어 차례에 등재한다. 이어붙이기만 하며 고쳐쓰기·지우기는 하지 않는다 — 다듬고 옮기는 일은 사람 몫이다.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        name: { type: 'string', description: '캠페인 이름' },
        text: { type: 'string', description: '적을 내용' },
        doc: { type: 'string', description: '주제 문서 이름(선택). 예: "decisions". 없으면 NOTES.md' },
      },
      required: ['name', 'text'],
    },
  },
  {
    name: 'campaign_plan',
    description: '.claude/plans 계획서 경로를 캠페인에 매단다. 원본은 .claude/plans에 그대로 두고 여기엔 경로만 적는다 — 사본은 반드시 원본과 어긋난다.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        name: { type: 'string', description: '캠페인 이름' },
        path: { type: 'string', description: '계획서 경로. 예: ".claude/plans/2026-08-01-…/PLAN.md"' },
        summary: { type: 'string', description: '한 줄 요약(선택)' },
      },
      required: ['name', 'path'],
    },
  },
  {
    name: 'campaign_research',
    description: '_RESEARCH 조사 경로를 캠페인에 매단다. campaign_plan과 같은 방식이며, 붙는 파일만 researches.md로 다르다.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        name: { type: 'string', description: '캠페인 이름' },
        path: { type: 'string', description: '조사 경로. 예: "_RESEARCH/2026-08-01-INTERNAL-…/SUMMARY.md"' },
        summary: { type: 'string', description: '한 줄 요약(선택)' },
      },
      required: ['name', 'path'],
    },
  },
  {
    name: 'campaign_list',
    description: '캠페인 목록과 각각의 상태·그룹 수·남은 태스크 수. 여기서 이름을 고른 뒤 campaign_read로 펼치는 두 걸음이 사용법이다.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  },
];
const DISPATCH = {
  task_add: toolAdd, task_update: toolUpdate, task_get: toolGet, task_list: toolList,
  campaign_add: toolCampaignAdd, campaign_read: toolCampaignRead, campaign_note: toolCampaignNote,
  campaign_plan: toolCampaignPlan, campaign_research: toolCampaignResearch, campaign_list: toolCampaignList,
};

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
