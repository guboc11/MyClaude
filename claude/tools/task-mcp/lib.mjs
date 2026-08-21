import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const STATUSES = ['pending', 'in_progress', 'completed'];
export const GROUP_STATUSES = ['pending', 'in_progress', 'done'];
export const MARK = { pending: '[ ]', in_progress: '[~]', completed: '[x]' };
export const RESERVED_CAMPAIGN_DIRS = new Set(['campaign-context', 'main-context', 'researches']);
// owner = 태스크를 만든 패널(CMUX_SURFACE_ID). task_list 기본은 자기 owner 것만 = 패널 간 격리.
export const OWNER = process.env.CMUX_SURFACE_ID || '';

export function projectDir() {
  return process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

export function tasksRoot() {
  return path.join(projectDir(), '.claude', 'mcp-task');
}

export function legacyTasksRoot() {
  return path.join(projectDir(), '.claude', 'tasks');
}

// 캠페인 = 그룹 위의 한 층. 여러 태스크 그룹과 여러 계획서·조사가 딸리는 큰 일을 담는다.
// 날짜 접두를 붙이지 않는다 — 몇 달을 가므로 시작일이 이름에 박히면 방해가 된다.
export function campaignsRoot() {
  return path.join(projectDir(), '.claude', 'campaigns');
}

export function safeName(name) {
  return String(name ?? '').replace(/[\\/]/g, '').trim();
}

export function campaignDir(name) {
  return path.join(campaignsRoot(), safeName(name));
}

export function campaignContextDir(name) {
  return path.join(campaignDir(name), 'campaign-context');
}

export function mainContextDir(name) {
  return path.join(campaignDir(name), 'main-context');
}

export function subDirNames(root) {
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch { return []; }
}

export function listCampaignNames() {
  return subDirNames(campaignsRoot()).sort();
}

export function slug(s, max = 60) {
  return (String(s ?? '').trim()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .slice(0, max)
    .replace(/^-+|-+$/g, '')) || 'task';
}

// 파일명: task-{번호}-{status}-[태그]-{제목}.json  (태그 없으면 [태그] 생략)
export function taskFileName(number, status, content, tag) {
  const t = tag ? `-[${slug(tag, 20)}]` : '';
  return `task-${number}-${status}${t}-${slug(content, 40)}.json`;
}

export function today() {
  // KST 기준 날짜. toISOString은 UTC라 KST 00:00~08:59에 그룹 폴더가 어제 날짜로 찍힌다 (2026-07-30 발견).
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
}

export function now() {
  return new Date().toISOString();
}

export function datedName(topic) {
  const raw = String(topic ?? '').trim();
  const dates = [];
  let rest = raw;
  while (/^\d{4}-\d{2}-\d{2}-/.test(rest)) {
    dates.push(rest.slice(0, 10));
    rest = rest.slice(11);
  }
  return { id: `${today()}-${slug(rest)}`, topic: rest, strippedDates: dates };
}

export function groupPath(groupId) {
  // groupId = 폴더명 "{date}-{slug}". 하위경로 이탈 방지.
  // 그룹은 새·옛 독립 자리 또는 캠페인 한 겹 아래에 산다.
  // 어느 쪽에 있든 이름은 여전히 폴더명 하나다 — 경로로 바꾸면 기존 group_id 표기가 전부 어긋난다.
  const safe = safeName(groupId);
  const top = path.join(tasksRoot(), safe);
  if (!RESERVED_CAMPAIGN_DIRS.has(safe)) {
    if (fs.existsSync(top)) return { safe, dir: top, campaign: null };
    const legacy = path.join(legacyTasksRoot(), safe);
    if (fs.existsSync(legacy)) return { safe, dir: legacy, campaign: null };
    for (const c of listCampaignNames()) {
      const inCampaign = path.join(campaignsRoot(), c, safe);
      if (fs.existsSync(inCampaign)) return { safe, dir: inCampaign, campaign: c };
    }
  }
  // 없는 그룹이면 기존과 같은 경로를 돌려준다(오류 메시지가 이전과 같게).
  return { safe, dir: top, campaign: null };
}

export function campaignGroupIds(name) {
  return subDirNames(campaignDir(name))
    .filter((groupId) => !RESERVED_CAMPAIGN_DIRS.has(groupId))
    .sort();
}

export function listGroupIds() {
  // 새·옛 독립 자리와 캠페인을 함께 훑는다. 돌려주는 것은 예전처럼 그룹 이름뿐 —
  // 실제 경로는 호출부가 groupPath()로 푼다.
  const out = subDirNames(tasksRoot()).filter((groupId) => !RESERVED_CAMPAIGN_DIRS.has(groupId));
  out.push(...subDirNames(legacyTasksRoot()).filter((groupId) => !RESERVED_CAMPAIGN_DIRS.has(groupId)));
  for (const c of listCampaignNames()) {
    out.push(...campaignGroupIds(c));
  }
  return [...new Set(out)].sort();
}

export function requireGroup(groupId) {
  const found = groupPath(groupId);
  if (!found.safe || RESERVED_CAMPAIGN_DIRS.has(found.safe) || !fs.existsSync(found.dir)) {
    throw new Error(`그룹 "${found.safe}" 없음. task_group_add로 먼저 만드세요.`);
  }
  return found;
}

export function requireWritableGroup(groupId) {
  const found = requireGroup(groupId);
  if (found.campaign) return found;

  const destination = path.join(tasksRoot(), found.safe);
  if (found.dir === destination) return found;
  if (fs.existsSync(destination)) return { safe: found.safe, dir: destination, campaign: null };

  fs.mkdirSync(tasksRoot(), { recursive: true });
  const temporary = path.join(
    path.dirname(tasksRoot()),
    `.mcp-task-promote-${found.safe}-${process.pid}-${randomUUID()}`,
  );

  // 이 레포에서는 tasks 호환 symlink 뒤 이 분기가 거의 안 돈다. 이동하지 않은 다른 레포의
  // 실물 .claude/tasks 그룹을 전역 서버가 처음 수정할 때 필요한 경로이므로 제거하지 않는다.
  try {
    fs.cpSync(found.dir, temporary, {
      recursive: true,
      force: false,
      errorOnExist: true,
      preserveTimestamps: true,
    });
    try {
      fs.renameSync(temporary, destination);
    } catch (cause) {
      if (!fs.existsSync(destination)) throw cause;
    }
  } catch (cause) {
    if (!fs.existsSync(destination)) throw cause;
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { recursive: true, force: true });
  }

  return { safe: found.safe, dir: destination, campaign: null };
}

export function groupRecordPath(dir) {
  return path.join(dir, 'GROUP.json');
}

export function readGroupRecord(dir) {
  const file = groupRecordPath(dir);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (cause) {
    throw new Error(`GROUP.json 파싱 실패: ${cause.message}`);
  }
}

export function writeGroupRecord(dir, record) {
  fs.writeFileSync(groupRecordPath(dir), `${JSON.stringify(record, null, 2)}\n`);
}

export function taskStatusFromFile(file) {
  return /^task-\d+-(pending|in_progress|completed)(?:-|\.json$)/.exec(file)?.[1] || null;
}

export function normalizeTaskRecord(data, file, number) {
  return {
    ...data,
    number,
    activeForm: data.activeForm ?? data.content ?? '',
    instruction: data.instruction ?? '',
    depends_on: Array.isArray(data.depends_on) ? data.depends_on : [],
    priority: Number.isInteger(data.priority) ? data.priority : 0,
    assignee: data.assignee ?? data.owner ?? '',
    status: taskStatusFromFile(file) || data.status,
    file,
  };
}

export function readTasks(dir) {
  let files;
  try { files = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const f of files) {
    const m = f.match(/^task-(\d+)-.+\.json$/);
    if (!m) continue;
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      out.push(normalizeTaskRecord(data, f, Number(m[1])));
    } catch { /* skip corrupt */ }
  }
  return out.sort((a, b) => a.number - b.number);
}

export function findTaskFile(dir, number) {
  let files;
  try { files = fs.readdirSync(dir); } catch { return null; }
  return files.find((f) => new RegExp(`^task-${number}-.+\\.json$`).test(f)) || null;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function numberedMarkdownFiles(dir, prefix) {
  let files;
  try { files = fs.readdirSync(dir); } catch { return []; }
  const pattern = new RegExp(`^${escapeRegExp(prefix)}-(\\d+)-.+\\.md$`);
  return files.flatMap((file) => {
    const match = pattern.exec(file);
    return match ? [{ file, number: Number(match[1]) }] : [];
  }).sort((a, b) => a.number - b.number || a.file.localeCompare(b.file));
}

export function markdownRecordFileName(prefix, number, title) {
  return `${prefix}-${number}-${slug(title, 60)}.md`;
}

export function renderMarkdownRecord(metadata, body) {
  const header = Object.entries(metadata).map(([key, value]) => {
    const text = String(value ?? '');
    if (/[\r\n]/.test(text)) throw new Error(`앞머리 ${key} 값에는 줄바꿈을 넣을 수 없습니다.`);
    return `${key}: ${text}`;
  });
  return `---\n${header.join('\n')}\n---\n\n${String(body ?? '')}\n`;
}

export function parseMarkdownRecord(text) {
  const source = String(text);
  if (!source.startsWith('---\n')) throw new Error('Markdown 앞머리가 없습니다.');
  const end = source.indexOf('\n---\n', 4);
  if (end < 0) throw new Error('Markdown 앞머리가 닫히지 않았습니다.');
  const metadata = {};
  for (const line of source.slice(4, end).split('\n')) {
    const colon = line.indexOf(':');
    if (colon < 1) throw new Error(`Markdown 앞머리 줄을 읽을 수 없습니다: ${line}`);
    metadata[line.slice(0, colon)] = line.slice(colon + 1).replace(/^ /, '');
  }
  let body = source.slice(end + 5);
  if (body.startsWith('\n')) body = body.slice(1);
  if (body.endsWith('\n')) body = body.slice(0, -1);
  return { metadata, body };
}

// 파일 만들기는 exclusive create('ax')로 한다 — writeFileSync는 자르기라
// 두 패널이 동시에 첫 글을 적으면 한쪽 내용이 사라진다. 이어붙이기는 항상 append.
export function createIfAbsent(p, header) {
  try { fs.writeFileSync(p, header, { flag: 'ax' }); } catch { /* 이미 있음 */ }
}

export function readTextOr(p, fallback = '') {
  try { return fs.readFileSync(p, 'utf8'); } catch { return fallback; }
}

export function requireCampaign(name) {
  const id = safeName(name);
  if (!id || !fs.existsSync(campaignDir(id))) {
    throw new Error(`캠페인 "${id}" 없음. campaign_list로 확인하거나 campaign_add로 만드세요.`);
  }
  return id;
}
