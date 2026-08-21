import fs from 'node:fs';
import path from 'node:path';

import {
  OWNER,
  campaignContextDir,
  campaignDir,
  campaignGroupIds,
  createIfAbsent,
  datedName,
  listCampaignNames,
  mainContextDir,
  markdownRecordFileName,
  now,
  numberedMarkdownFiles,
  readTasks,
  readTextOr,
  renderMarkdownRecord,
  requireCampaign,
  slug,
  subDirNames,
} from '../lib.mjs';
import { groupDocuments } from './group.mjs';
import { renderGroup } from './task.mjs';

// 설계상 차례에 올리지 않는 문서 — 정합 검사에서 제외한다.
// NOTES.md는 던져두는 자리이지 주제 문서가 아니다. 이걸 어긋남으로 치면 노트를 쓰는
// 캠페인마다 영구 경고가 붙고, 경보가 소음이 되면 진짜 어긋남을 놓친다.
const UNLISTED_DOCS = new Set(['README.md', 'INDEX.md', 'NOTES.md']);

function legacyContextDocs(name) {
  try {
    return fs.readdirSync(mainContextDir(name))
      .filter((f) => f.endsWith('.md') && !UNLISTED_DOCS.has(f))
      .sort();
  } catch { return []; }
}

function readIndex(file) {
  const lines = readTextOr(file).split('\n').filter((line) => line.startsWith('- '));
  const entries = lines.flatMap((line) => {
    const match = /^- \[[^\]]*\]\(([^)]+)\)/.exec(line);
    return match ? [match[1].replace(/^\.\//, '')] : [];
  });
  return { lines, entries };
}

function legacyIndex(name) {
  return readIndex(path.join(mainContextDir(name), 'INDEX.md'));
}

function currentIndex(name) {
  return readIndex(path.join(campaignContextDir(name), 'INDEX.md'));
}

function campaignStatus(name) {
  const current = readTextOr(path.join(campaignContextDir(name), 'MAIN_CONTEXT.md'));
  const legacy = readTextOr(path.join(mainContextDir(name), 'README.md'));
  const m = (current || legacy).match(/^상태:\s*(.+)$/m);
  return m ? m[1].trim() : '';
}

function contextView(name) {
  const legacyDocs = legacyContextDocs(name);
  const topics = subDirNames(campaignContextDir(name)).filter((topic) => topic !== 'notes').sort();
  const legacy = legacyIndex(name);
  const current = currentIndex(name);
  const entries = [...legacy.entries, ...current.entries];
  const lines = [...legacy.lines, ...current.lines];
  const normalized = entries.map((entry) => entry.replace(/\/+$/, ''));
  const notIndexed = [
    ...legacyDocs.filter((doc) => !normalized.includes(doc)),
    ...topics.filter((topic) => !normalized.includes(topic)).map((topic) => `${topic}/`),
  ];
  const ghosts = entries.filter((entry) => {
    const target = entry.replace(/\/+$/, '');
    return !legacyDocs.includes(target) && !topics.includes(target);
  });
  return { lines, notIndexed, ghosts };
}

function attachedLines(name, file) {
  return readTextOr(path.join(campaignDir(name), file))
    .split('\n').filter((l) => l.trim().startsWith('- '));
}

function dateNotice(strippedDates) {
  return strippedDates.length
    ? `(주제 앞머리의 날짜 ${strippedDates.join(', ')} 를 뗐습니다)\n`
    : '';
}

function ensureCurrentStructure(name) {
  const context = campaignContextDir(name);
  fs.mkdirSync(path.join(context, 'notes'), { recursive: true });
  fs.mkdirSync(path.join(campaignDir(name), 'researches'), { recursive: true });
  createIfAbsent(path.join(context, 'INDEX.md'), `# ${name} — campaign-context 차례\n\n`);
}

function registerTopic(name, topic) {
  const index = path.join(campaignContextDir(name), 'INDEX.md');
  const registered = currentIndex(name).entries.some((entry) => entry.replace(/\/+$/, '') === topic);
  if (registered) return false;
  fs.appendFileSync(index, `- [${topic}](${topic}/)\n`);
  return true;
}

export function toolCampaignAdd({ name, about }) {
  if (!name) throw new Error('name은 필수입니다.');
  const named = datedName(name);
  if (fs.existsSync(campaignDir(named.id))) throw new Error(`이미 있는 캠페인입니다: ${named.id}`);
  ensureCurrentStructure(named.id);
  createIfAbsent(path.join(campaignContextDir(named.id), 'MAIN_CONTEXT.md'),
    `# ${named.id}\n\n상태: 진행 중\n\n${about || '(설명 없음 — 이 자리에 무엇을 왜 하는 일이고 무엇은 안 할지 적는다)'}\n\n` +
    `> 이 문서는 사람이 관리한다. 도구는 만들 때 말고는 건드리지 않는다.\n` +
    `> 끝나면 위 "상태:" 줄을 "상태: 종료 (YYYY-MM-DD) — 한 줄 이유" 로 바꾼다.\n`);
  return `${dateNotice(named.strippedDates)}캠페인 생성: ${named.id}\n` +
    `- .claude/campaigns/${named.id}/campaign-context/MAIN_CONTEXT.md (머리말 — 이후 사람이 관리)\n\n` +
    `(태스크 그룹은 task_group_add{campaign:"${named.id}", topic:"…"}, 맥락은 campaign_note{name:"${named.id}", title:"…", text:"…"}, 펼쳐보기는 campaign_read{name:"${named.id}"})`;
}

export function toolCampaignRead({ name, full } = {}) {
  const id = requireCampaign(name);
  const currentMain = readTextOr(path.join(campaignContextDir(id), 'MAIN_CONTEXT.md'));
  const legacyMain = readTextOr(path.join(mainContextDir(id), 'README.md'));
  const out = [(currentMain || legacyMain || '(MAIN_CONTEXT 없음)').trim()];

  // 차례 — 도구가 관리한다
  const context = contextView(id);
  out.push(`## 차례 (campaign-context)\n${context.lines.length
    ? context.lines.join('\n')
    : '(빈 차례)'}`);

  // 실물과 차례가 어긋나면 알리기만 한다. 빠진 게 실수인지 일부러인지 도구는 알 수 없다.
  if (context.notIndexed.length || context.ghosts.length) {
    out.push(`! 차례와 실물이 어긋납니다 (자동으로 고치지 않습니다)\n` +
      `  차례에 없는 문서·폴더: ${context.notIndexed.length ? context.notIndexed.join(', ') : '없음'}\n` +
      `  실물이 없는 등재: ${context.ghosts.length ? context.ghosts.join(', ') : '없음'}`);
  }

  // 새 리서치 폴더와 옛 연결 파일. 옛 plans.md·researches.md는 읽기만 한다.
  const researchDirs = subDirNames(path.join(campaignDir(id), 'researches')).sort();
  const plans = attachedLines(id, 'plans.md'), researches = attachedLines(id, 'researches.md');
  const latest = (lines, label) => (lines.length ? `\n  최근 ${label}: ${lines[lines.length - 1].replace(/^-\s*/, '')}` : '');
  out.push(full
    ? `## 리서치 폴더 ${researchDirs.length}개\n${researchDirs.map((dir) => `- researches/${dir}/`).join('\n') || '(없음)'}\n\n` +
      `### 옛 plans.md ${plans.length}건 (읽기 전용)\n${plans.join('\n') || '(없음)'}\n\n` +
      `### 옛 researches.md ${researches.length}건 (읽기 전용)\n${researches.join('\n') || '(없음)'}`
    : `## 리서치 폴더 ${researchDirs.length}개 · 옛 계획서 ${plans.length}건 · 옛 조사 ${researches.length}건  (목록은 full:true)` +
      latest(plans, '계획서') + latest(researches, '조사'));

  // 그룹 — 기본은 진행 중인 것만
  const gids = campaignGroupIds(id);
  const blocks = [];
  let hidden = 0;
  for (const g of gids) {
    const dir = path.join(campaignDir(id), g);
    const tasks = readTasks(dir);
    const open = tasks.filter((t) => t.status !== 'completed').length;
    if (!full && (!tasks.length || open === 0)) { hidden += 1; continue; }
    const { notes, plans: groupPlans } = groupDocuments(dir);
    blocks.push(`${renderGroup(g, tasks, true)}\n  노트 ${notes.length} · 계획서 ${groupPlans.length}`);
  }
  out.push(`## 태스크 그룹 ${gids.length}개\n${blocks.join('\n\n') || '(진행 중인 그룹 없음)'}` +
    (hidden ? `\n\n(끝났거나 빈 그룹 ${hidden}개는 숨김 — full:true로 전체)` : ''));

  return out.join('\n\n');
}

export function toolCampaignNote({ name, title, text, topic }) {
  const id = requireCampaign(name);
  if (!title || text == null) throw new Error('name, title, text는 필수입니다.');
  if (topic != null && !String(topic).trim()) throw new Error('topic은 빈 문자열일 수 없습니다.');
  ensureCurrentStructure(id);
  const topicId = topic == null ? null : slug(topic);
  const relativeDir = topicId || 'notes';
  const dir = path.join(campaignContextDir(id), relativeDir);
  fs.mkdirSync(dir, { recursive: true });
  const existing = numberedMarkdownFiles(dir, 'note');
  const number = existing.reduce((max, note) => Math.max(max, note.number), 0) + 1;
  const timestamp = now();
  const file = markdownRecordFileName('note', number, title);
  const record = renderMarkdownRecord({
    number,
    title: String(title),
    author: OWNER,
    created_at: timestamp,
    updated_at: timestamp,
  }, text);
  fs.writeFileSync(path.join(dir, file), record, { flag: 'wx' });
  const listed = topicId ? registerTopic(id, topicId) : false;
  return `캠페인 노트 추가: name="${id}", file="campaign-context/${relativeDir}/${file}"${listed ? ' · 주제 폴더 차례 등재' : ''}.`;
}

export function toolCampaignResearch({ name, topic }) {
  const id = requireCampaign(name);
  if (!topic) throw new Error('name, topic은 필수입니다.');
  ensureCurrentStructure(id);
  const named = datedName(topic);
  const dir = path.join(campaignDir(id), 'researches', named.id);
  if (fs.existsSync(dir)) throw new Error(`이미 있는 리서치 폴더입니다: ${named.id}`);
  fs.mkdirSync(dir);
  return `${dateNotice(named.strippedDates)}리서치 폴더 생성: .claude/campaigns/${id}/researches/${named.id}/`;
}

export function toolCampaignList() {
  const names = listCampaignNames();
  if (!names.length) return '캠페인 없음. campaign_add로 시작하세요.';
  const rows = names.map((n) => {
    const gids = campaignGroupIds(n);
    let open = 0, total = 0;
    for (const g of gids) {
      const ts = readTasks(path.join(campaignDir(n), g));
      total += ts.length;
      open += ts.filter((t) => t.status !== 'completed').length;
    }
    return `- ${n} — ${campaignStatus(n) || '상태 미표기'} · 그룹 ${gids.length} · 남은 태스크 ${open}/${total}`;
  });
  return `${rows.join('\n')}\n\n(펼쳐보기: campaign_read{name:"…"})`;
}
