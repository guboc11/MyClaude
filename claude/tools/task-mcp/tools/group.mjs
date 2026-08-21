import fs from 'node:fs';
import path from 'node:path';

import {
  GROUP_STATUSES,
  OWNER,
  RESERVED_CAMPAIGN_DIRS,
  campaignDir,
  datedName,
  groupPath,
  listGroupIds,
  now,
  readGroupRecord,
  readTasks,
  requireCampaign,
  requireGroup,
  requireWritableGroup,
  safeName,
  slug,
  tasksRoot,
  writeGroupRecord,
} from '../lib.mjs';
import { renderGroup } from './task.mjs';

const GROUP_STATUS_LABEL = { pending: '대기', in_progress: '진행 중', done: '완료' };

function person(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !value.name || !value.surface) {
    throw new Error(`${label}는 {name, surface} 형식이어야 합니다.`);
  }
  return { name: String(value.name), surface: String(value.surface) };
}

function callerWorker() {
  return { name: OWNER || 'unknown', surface: OWNER };
}

function dateNotice(strippedDates) {
  return strippedDates.length
    ? `(주제 앞머리의 날짜 ${strippedDates.join(', ')} 를 뗐습니다)\n`
    : '';
}

function inferLegacyStatus(tasks) {
  if (tasks.length && tasks.every((task) => task.status === 'completed')) return 'done';
  if (tasks.some((task) => task.status === 'in_progress')) return 'in_progress';
  return 'pending';
}

function groupView(found) {
  const record = readGroupRecord(found.dir);
  if (record) return { ...record, campaign: record.campaign ?? found.campaign, legacy: false };
  const tasks = readTasks(found.dir);
  return {
    id: found.safe,
    title: found.safe,
    about: '',
    status: inferLegacyStatus(tasks),
    campaign: found.campaign,
    worker: null,
    manager: null,
    created_at: null,
    updated_at: null,
    legacy: true,
  };
}

function markdownFiles(dir) {
  try {
    return fs.readdirSync(dir)
      .filter((file) => file.endsWith('.md'))
      .sort();
  } catch { return []; }
}

export function groupDocuments(dir) {
  const notes = markdownFiles(path.join(dir, 'notes'));
  const plans = markdownFiles(path.join(dir, 'plans'));
  if (fs.existsSync(path.join(dir, 'NOTES.md'))) notes.unshift('NOTES.md (옛 자리)');
  if (fs.existsSync(path.join(dir, 'plans.md'))) plans.unshift('plans.md (옛 자리)');
  return { notes, plans };
}

function personLabel(value, empty) {
  return value ? `${value.name} (${value.surface})` : empty;
}

function dashboardBlock(group, tasks, notes, plans) {
  const done = tasks.filter((task) => task.status === 'completed').length;
  const next = tasks.find((task) => task.status !== 'completed');
  const campaign = group.campaign ? `  ·  캠페인 ${group.campaign}` : '';
  const nextLabel = next
    ? `#${next.number} ${next.tag ? `[${next.tag}] ` : ''}${next.content}`
    : '없음';
  return `[${group.id}]  ${GROUP_STATUS_LABEL[group.status] || group.status}${campaign}${group.legacy ? '  ·  옛 그룹' : ''}\n` +
    `  워커   ${personLabel(group.worker, '워커 없음')}      매니저  ${personLabel(group.manager, '매니저 없음')}\n` +
    `  태스크 ${done}/${tasks.length} 완료 · 다음 → ${nextLabel}\n` +
    `  노트 ${notes.length} · 계획서 ${plans.length}`;
}

export function toolGroupAdd({ topic, campaign, about, title, worker, manager }) {
  if (!topic) throw new Error('topic은 필수입니다.');
  const named = datedName(topic);
  if (RESERVED_CAMPAIGN_DIRS.has(slug(named.topic))) {
    throw new Error(`"${slug(named.topic)}"은 캠페인 예약 폴더 이름이라 태스크 그룹으로 쓸 수 없습니다.`);
  }
  const c = campaign ? requireCampaign(campaign) : null;
  const dir = c ? path.join(campaignDir(c), named.id) : path.join(tasksRoot(), named.id);
  const found = groupPath(named.id);
  if (fs.existsSync(found.dir)) {
    throw new Error(`이미 있는 그룹입니다: ${named.id}${found.campaign ? ` (캠페인 ${found.campaign})` : ''}`);
  }

  fs.mkdirSync(dir, { recursive: true });
  const timestamp = now();
  const record = {
    id: named.id,
    title: title || named.topic || 'task',
    about: about || '',
    status: 'pending',
    campaign: c,
    worker: worker ? person(worker, 'worker') : callerWorker(),
    manager: manager ? person(manager, 'manager') : null,
    created_at: timestamp,
    updated_at: timestamp,
  };
  writeGroupRecord(dir, record);
  return `${dateNotice(named.strippedDates)}그룹 생성: group_id="${named.id}".\n${dashboardBlock(record, [], [], [])}`;
}

export function toolGroupUpdate({ group_id, title, about, status, worker, manager }) {
  if (!group_id) throw new Error('group_id는 필수입니다.');
  if (title == null && about == null && status == null && worker == null && manager == null) {
    throw new Error('바꿀 값(title / about / status / worker / manager 중 하나 이상)이 필요합니다.');
  }
  if (status != null && !GROUP_STATUSES.includes(status)) {
    throw new Error(`status는 ${GROUP_STATUSES.join(' | ')} 중 하나여야 합니다.`);
  }

  const readable = requireGroup(group_id);
  readGroupRecord(readable.dir);
  const found = requireWritableGroup(group_id);
  const timestamp = now();
  const existing = readGroupRecord(found.dir);
  const record = existing || {
    id: found.safe,
    title: found.safe,
    about: '',
    status: inferLegacyStatus(readTasks(found.dir)),
    campaign: found.campaign,
    worker: null,
    manager: null,
    created_at: timestamp,
    updated_at: timestamp,
  };
  if (title != null) record.title = title;
  if (about != null) record.about = about;
  if (status != null) record.status = status;
  if (worker != null) record.worker = person(worker, 'worker');
  if (manager != null) record.manager = person(manager, 'manager');
  record.updated_at = timestamp;
  writeGroupRecord(found.dir, record);
  return `그룹 업데이트: ${found.safe}.\n${dashboardBlock(record, readTasks(found.dir), ...Object.values(groupDocuments(found.dir)))}`;
}

export function toolGroupGet({ group_id }) {
  if (!group_id) throw new Error('group_id는 필수입니다.');
  const found = requireGroup(group_id);
  const group = groupView(found);
  const tasks = readTasks(found.dir);
  const { notes, plans } = groupDocuments(found.dir);
  return `${dashboardBlock(group, tasks, notes, plans)}\n\n` +
    `제목: ${group.title}\n설명: ${group.about || '(없음)'}\n` +
    `생성: ${group.created_at || '(옛 그룹 — 기록 없음)'}\n수정: ${group.updated_at || '(옛 그룹 — 기록 없음)'}\n\n` +
    `## 태스크\n${renderGroup(group.id, tasks)}\n\n` +
    `## 노트\n${notes.join('\n') || '(없음)'}\n\n` +
    `## 계획서\n${plans.join('\n') || '(없음)'}`;
}

export function toolGroupList({ campaign, all } = {}) {
  const campaignFilter = campaign == null ? null : safeName(campaign);
  const blocks = [];
  for (const groupId of listGroupIds()) {
    const found = groupPath(groupId);
    if (campaignFilter != null && found.campaign !== campaignFilter) continue;
    const group = groupView(found);
    const tasks = readTasks(found.dir);
    if (!tasks.length && group.legacy) continue;
    if (!all && group.status === 'done') continue;
    const { notes, plans } = groupDocuments(found.dir);
    blocks.push(dashboardBlock(group, tasks, notes, plans));
  }
  if (!blocks.length) return '태스크 그룹 없음. task_group_add로 시작하세요.';
  return blocks.join('\n\n');
}
