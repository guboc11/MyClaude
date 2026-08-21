import fs from 'node:fs';
import path from 'node:path';

import {
  OWNER,
  markdownRecordFileName,
  now,
  numberedMarkdownFiles,
  parseMarkdownRecord,
  renderMarkdownRecord,
  requireGroup,
  requireWritableGroup,
} from '../lib.mjs';

const PREFIX = 'plan';
const EMPTY = '<!-- 비어 있음 -->';

export const PLAN_SECTIONS = Object.freeze([
  { key: 'why', title: '왜' },
  { key: 'spec', title: '스펙' },
  { key: 'agreement', title: '합의' },
  { key: 'steps', title: '단계' },
  { key: 'verification', title: '검증' },
  { key: 'open', title: '미결' },
]);

export const PLAN_SECTION_KEYS = PLAN_SECTIONS.map((section) => section.key);

function plansDir(groupDir) {
  return path.join(groupDir, 'plans');
}

function requireNumber(number) {
  if (!Number.isInteger(number) || number < 1) throw new Error('number는 양의 정수여야 합니다.');
}

function planMetadata(number, title, author, createdAt, updatedAt) {
  return {
    number,
    title,
    author,
    created_at: createdAt,
    updated_at: updatedAt,
  };
}

function renderPlanBody(sections) {
  return sections.map((section) => `## ${section.title}\n${section.body}`).join('\n\n');
}

function emptyPlanBody() {
  return renderPlanBody(PLAN_SECTIONS.map((section) => ({ ...section, body: EMPTY })));
}

function parsePlanBody(body) {
  let rest = String(body);
  const sections = [];
  for (let index = 0; index < PLAN_SECTIONS.length; index += 1) {
    const definition = PLAN_SECTIONS[index];
    const heading = `## ${definition.title}\n`;
    if (!rest.startsWith(heading)) throw new Error(`계획서 틀이 깨졌습니다: ${definition.title} 칸을 찾지 못했습니다.`);
    rest = rest.slice(heading.length);
    const next = PLAN_SECTIONS[index + 1];
    if (!next) {
      sections.push({ ...definition, body: rest });
      break;
    }
    const boundary = `\n\n## ${next.title}\n`;
    const end = rest.indexOf(boundary);
    if (end < 0) throw new Error(`계획서 틀이 깨졌습니다: ${next.title} 칸을 찾지 못했습니다.`);
    sections.push({ ...definition, body: rest.slice(0, end) });
    rest = rest.slice(end + 2);
  }
  return sections;
}

function readPlan(groupDir, number) {
  requireNumber(number);
  const entry = numberedMarkdownFiles(plansDir(groupDir), PREFIX)
    .find((candidate) => candidate.number === number);
  if (!entry) throw new Error(`plan-${number} 을 찾지 못했습니다.`);
  const full = path.join(plansDir(groupDir), entry.file);
  const text = fs.readFileSync(full, 'utf8');
  const parsed = parseMarkdownRecord(text);
  return { ...entry, full, text, ...parsed, sections: parsePlanBody(parsed.body) };
}

function emptySections(sections) {
  return sections.filter((section) => section.body.includes(EMPTY));
}

function emptySummary(sections) {
  const empty = emptySections(sections);
  return `안 채운 칸 ${empty.length}개: ${empty.length ? empty.map((section) => section.title).join(', ') : '없음'}`;
}

function appendSectionBody(current, added) {
  const existing = current.includes(EMPTY) ? '' : current;
  if (!existing) return added;
  if (!added) return existing;
  return `${existing}\n\n${added}`;
}

export function toolGroupPlanAdd({ group_id, title }) {
  if (!group_id || !title) throw new Error('group_id, title은 필수입니다.');
  const found = requireWritableGroup(group_id);
  const dir = plansDir(found.dir);
  const existing = numberedMarkdownFiles(dir, PREFIX);
  const number = existing.reduce((max, plan) => Math.max(max, plan.number), 0) + 1;
  const timestamp = now();
  const metadata = planMetadata(number, String(title), OWNER, timestamp, timestamp);
  const file = markdownRecordFileName(PREFIX, number, title);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, file), renderMarkdownRecord(metadata, emptyPlanBody()), { flag: 'wx' });
  return `계획서 추가: group_id="${found.safe}", number=${number}, file="plans/${file}".\n${emptySummary(parsePlanBody(emptyPlanBody()))}`;
}

export function toolGroupPlanUpdate({ group_id, number, section, body, append }) {
  if (!group_id || number == null || section == null || body == null) {
    throw new Error('group_id, number, section, body는 필수입니다.');
  }
  const definition = PLAN_SECTIONS.find((candidate) => candidate.key === section);
  if (!definition) throw new Error(`section은 ${PLAN_SECTION_KEYS.join(' | ')} 중 하나여야 합니다.`);
  const readable = requireGroup(group_id);
  readPlan(readable.dir, number);
  const found = requireWritableGroup(group_id);
  const plan = readPlan(found.dir, number);
  const target = plan.sections.find((candidate) => candidate.key === definition.key);
  target.body = append ? appendSectionBody(target.body, String(body)) : String(body);
  const metadata = planMetadata(
    number,
    plan.metadata.title,
    plan.metadata.author,
    plan.metadata.created_at,
    now(),
  );
  fs.writeFileSync(plan.full, renderMarkdownRecord(metadata, renderPlanBody(plan.sections)));
  return `계획서 업데이트: group_id="${found.safe}", number=${number}, section=${section}.\n${emptySummary(plan.sections)}`;
}

export function toolGroupPlanGet({ group_id, number }) {
  if (!group_id || number == null) throw new Error('group_id, number는 필수입니다.');
  const found = requireGroup(group_id);
  const plan = readPlan(found.dir, number);
  return `${plan.text.trimEnd()}\n\n${emptySummary(plan.sections)}`;
}

export function toolGroupPlanList({ group_id }) {
  if (!group_id) throw new Error('group_id는 필수입니다.');
  const found = requireGroup(group_id);
  const lines = numberedMarkdownFiles(plansDir(found.dir), PREFIX).map((entry) => {
    const plan = readPlan(found.dir, entry.number);
    return `#${entry.number} ${plan.metadata.title} · 빈칸 ${emptySections(plan.sections).length}개`;
  });
  if (!lines.length) return `계획서 없음: group_id="${found.safe}".`;
  return `[${found.safe}] 계획서 목록\n${lines.join('\n')}`;
}
