import fs from 'node:fs';
import path from 'node:path';

import {
  MARK,
  OWNER,
  STATUSES,
  findTaskFile,
  groupPath,
  listGroupIds,
  normalizeTaskRecord,
  now,
  readGroupRecord,
  readTasks,
  requireGroup,
  requireWritableGroup,
  taskFileName,
  writeGroupRecord,
} from '../lib.mjs';

// 태스크부터 집은 세션이 맥락으로 가는 길을 보게 하는 한 줄. 캠페인에 안 속한 그룹에는 아무것도 안 붙는다.
export function campaignHint(campaign) {
  return campaign
    ? `이 그룹은 캠페인 "${campaign}" 소속 — campaign-context/MAIN_CONTEXT.md 먼저 (없으면 옛 main-context/README.md)\n`
    : '';
}

export function renderGroup(id, tasks, showOwner = false) {
  if (!tasks.length) return `[${id}] (비어 있음)`;
  const lines = tasks.map((t) => `  ${MARK[t.status] || '[ ]'} ${t.number}. ${t.tag ? `[${t.tag}] ` : ''}${t.content} (${t.status})${t.description ? '  +상세' : ''}${showOwner && t.owner ? `  @${String(t.owner).slice(0, 8)}` : ''}`);
  const done = tasks.filter((t) => t.status === 'completed').length;
  return `[${id}]  ${done}/${tasks.length} 완료\n${lines.join('\n')}`;
}

function validateDependsOn(dependsOn) {
  if (!Array.isArray(dependsOn) || !dependsOn.every((number) => Number.isInteger(number) && number > 0)) {
    throw new Error('depends_on은 양의 정수 태스크 번호 배열이어야 합니다.');
  }
  return [...new Set(dependsOn)];
}

function validatePriority(priority) {
  if (!Number.isInteger(priority)) throw new Error('priority는 정수여야 합니다.');
  return priority;
}

function defaultAssignee(dir) {
  return readGroupRecord(dir)?.worker?.surface || OWNER;
}

function taskRecord(record) {
  const { file, ...stored } = record;
  return stored;
}

function writeTask(file, record) {
  fs.writeFileSync(file, `${JSON.stringify(taskRecord(record), null, 2)}\n`);
}

function renderTask(id, task, campaign) {
  const dependencies = task.depends_on.length ? task.depends_on.map((number) => `#${number}`).join(', ') : '(없음)';
  return `${campaignHint(campaign)}[${id}] #${task.number} (${task.status})${task.tag ? ` [${task.tag}]` : ''}\n` +
    `제목: ${task.content}\n` +
    `activeForm: ${task.activeForm}\n` +
    `owner: ${task.owner || '(없음)'}\n` +
    `assignee: ${task.assignee || '(없음)'}\n` +
    `priority: ${task.priority}\n` +
    `depends_on: ${dependencies}\n\n` +
    `지시:\n${task.instruction || '(없음)'}\n\n` +
    `설명:\n${task.description || '(없음)'}`;
}

function markGroupInProgress(dir) {
  const group = readGroupRecord(dir);
  if (!group || group.status !== 'pending') return;
  group.status = 'in_progress';
  group.updated_at = now();
  writeGroupRecord(dir, group);
}

export function toolAdd({
  group_id, content, tag, description, activeForm, instruction, depends_on, priority, assignee,
}) {
  if (!group_id || !content) throw new Error('group_id, content는 필수입니다.');
  const { safe: id, dir, campaign: camp } = requireWritableGroup(group_id);
  const existing = readTasks(dir);
  const number = (existing.reduce((m, t) => Math.max(m, t.number), 0)) + 1;
  const status = 'pending';
  const rec = {
    number, content, tag: tag || '', description: description || '', activeForm: activeForm || content,
    instruction: instruction || '',
    depends_on: depends_on == null ? [] : validateDependsOn(depends_on),
    priority: priority == null ? 0 : validatePriority(priority),
    status, owner: OWNER, assignee: assignee ?? defaultAssignee(dir),
    group_id: id, created_at: now(), updated_at: now(),
  };
  writeTask(path.join(dir, taskFileName(number, status, content, rec.tag)), rec);
  const tasks = readTasks(dir);
  return `추가됨: group_id="${id}", number=${number}.\n${campaignHint(camp)}${renderGroup(id, tasks)}\n\n(업데이트는 task_update{group_id:"${id}", number:${number}, status})`;
}

export function toolUpdate({
  group_id, number, status, tag, description, content, activeForm,
  instruction, depends_on, priority, assignee,
}) {
  if (!group_id || number == null) throw new Error('group_id, number는 필수입니다.');
  if (status != null && !STATUSES.includes(status)) throw new Error(`status는 ${STATUSES.join(' | ')} 중 하나여야 합니다.`);
  if (status == null && tag == null && description == null && content == null && activeForm == null &&
      instruction == null && depends_on == null && priority == null && assignee == null) {
    throw new Error('바꿀 값(status / tag / description / content / activeForm / instruction / depends_on / priority / assignee 중 하나 이상)이 필요합니다.');
  }
  const readable = groupPath(group_id);
  const readableFile = findTaskFile(readable.dir, number);
  if (!readableFile) throw new Error(`task-${number} 를 group "${readable.safe}" 에서 못 찾음.`);
  const { safe, dir } = requireWritableGroup(group_id);
  const cur = findTaskFile(dir, number);
  if (!cur) throw new Error(`task-${number} 를 group "${safe}" 에서 못 찾음.`);
  const full = path.join(dir, cur);
  const rec = normalizeTaskRecord(JSON.parse(fs.readFileSync(full, 'utf8')), cur, Number(number));
  if (description != null) rec.description = description;
  if (content != null) rec.content = content;
  if (activeForm != null) rec.activeForm = activeForm;
  if (instruction != null) rec.instruction = instruction;
  if (depends_on != null) rec.depends_on = validateDependsOn(depends_on);
  if (priority != null) rec.priority = validatePriority(priority);
  if (assignee != null) rec.assignee = assignee;
  if (tag != null) rec.tag = tag;
  if (status != null) rec.status = status;
  rec.updated_at = now();
  const next = path.join(dir, taskFileName(number, rec.status, rec.content, rec.tag));
  writeTask(full, rec);
  if (path.basename(full) !== path.basename(next)) fs.renameSync(full, next);
  return `업데이트됨: ${safe}/task-${number}${status != null ? ` -> ${status}` : ' (내용 수정)'}.\n${renderGroup(safe, readTasks(dir))}`;
}

export function toolGet({ group_id, number }) {
  if (!group_id || number == null) throw new Error('group_id, number는 필수입니다.');
  const { safe, dir, campaign } = groupPath(group_id);
  const cur = findTaskFile(dir, number);
  if (!cur) throw new Error(`task-${number} 를 group "${safe}" 에서 못 찾음.`);
  const rec = normalizeTaskRecord(JSON.parse(fs.readFileSync(path.join(dir, cur), 'utf8')), cur, Number(number));
  return renderTask(safe, rec, campaign);
}

export function toolList({ group_id, all } = {}) {
  // 기본: 내 패널에 배정된 것만. all=true면 다른 패널 포함 전체(오버사이트).
  const mine = (tasks) => (all ? tasks : tasks.filter((t) => (t.assignee || '') === OWNER));
  if (group_id) {
    const { safe, dir, campaign } = groupPath(group_id);
    return campaignHint(campaign) + renderGroup(safe, readTasks(dir), !!all);
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

export function toolNext({ group_id }) {
  if (!group_id) throw new Error('group_id는 필수입니다.');

  // 두 호출이 같은 pending 파일을 골라도 rename에 성공한 한쪽만 상태를 쓴다.
  // 늦은 호출은 처음부터 다시 읽어 이미 in_progress가 된 태스크를 돌려준다.
  while (true) {
    const { safe, dir, campaign } = requireGroup(group_id);
    const tasks = readTasks(dir);
    const current = tasks.find((task) => task.status === 'in_progress');
    if (current) {
      return `이미 진행 중인 태스크입니다.\n${renderTask(safe, current, campaign)}`;
    }

    const pending = tasks.filter((task) => task.status === 'pending');
    if (!pending.length) {
      if (tasks.length && tasks.every((task) => task.status === 'completed')) {
        return `모든 태스크가 완료되었습니다: ${safe}.`;
      }
      return `태스크가 없습니다: ${safe}.`;
    }

    const completed = new Set(tasks
      .filter((task) => task.status === 'completed')
      .map((task) => task.number));
    const eligible = pending
      .filter((task) => task.depends_on.every((dependency) => completed.has(dependency)))
      .sort((a, b) => b.priority - a.priority || a.number - b.number);

    if (!eligible.length) {
      const waits = pending.map((task) => {
        const unresolved = task.depends_on.filter((dependency) => !completed.has(dependency));
        return `#${task.number} → ${unresolved.map((dependency) => `#${dependency}`).join(', ')}`;
      });
      return `선행 태스크가 끝나지 않아 모두 막혀 있습니다: ${safe}.\n${waits.join('\n')}`;
    }

    const selected = eligible[0];
    const writable = requireWritableGroup(group_id);
    if (writable.dir !== dir) continue;
    const source = path.join(dir, selected.file);
    const target = path.join(dir, taskFileName(selected.number, 'in_progress', selected.content, selected.tag));
    try {
      fs.renameSync(source, target);
    } catch (cause) {
      if (cause.code === 'ENOENT') continue;
      throw cause;
    }

    selected.status = 'in_progress';
    selected.updated_at = now();
    writeTask(target, selected);
    markGroupInProgress(dir);
    return `다음 태스크를 시작합니다.\n${renderTask(safe, selected, campaign)}`;
  }
}
