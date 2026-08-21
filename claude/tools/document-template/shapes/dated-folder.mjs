import fs from 'node:fs';
import path from 'node:path';

export const shape = {
  name: 'dated-folder',
  requires: ['item_pattern'],
  optional: ['tags', 'entry', 'tidy'],
};

const DATE_ITEM_RE = /^(\d{4}-\d{2})-\d{2}-.+/;
const MONTH_RE = /^\d{4}-\d{2}$/;
const TITLE_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const posix = (value) => value.split(path.sep).join('/');
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function patternRegex(ctx) {
  const source = String(ctx.config.item_pattern);
  let cursor = 0;
  let regex = '^';
  for (const match of source.matchAll(/\{(date|title|tag|TAG)\}/g)) {
    regex += escapeRegex(source.slice(cursor, match.index));
    const key = match[1];
    if (key === 'date') regex += '\\d{4}-\\d{2}-\\d{2}';
    else if (key === 'title') regex += '[a-z0-9]+(?:-[a-z0-9]+)*';
    else {
      const tags = Array.isArray(ctx.config.tags) ? ctx.config.tags : [];
      regex += tags.length ? `(?:${tags.map(escapeRegex).join('|')})` : '[A-Za-z0-9_-]+';
    }
    cursor = match.index + match[0].length;
  }
  regex += `${escapeRegex(source.slice(cursor))}$`;
  return new RegExp(regex);
}

export function validateName(ctx, name) {
  const safe = ctx.lib.validateSafeSegment(name);
  if (!safe.ok) return safe;
  if (!patternRegex(ctx).test(String(name))) {
    return { ok: false, reason: `이름이 item_pattern과 다릅니다: "${name}" — ${ctx.config.item_pattern}` };
  }
  return { ok: true };
}

export function nameItem(ctx, input) {
  const title = String(input?.title ?? '');
  if (!title) throw new Error('title이 필요합니다 (kebab-case 영문).');
  if (!TITLE_RE.test(title)) {
    throw new Error(`title이 kebab-case가 아닙니다: "${title}" — 소문자 영문·숫자·하이픈만 씁니다.`);
  }

  const needsTag = /\{(?:tag|TAG)\}/.test(ctx.config.item_pattern);
  const tags = Array.isArray(ctx.config.tags) ? ctx.config.tags : [];
  const tag = input?.tag ? String(input.tag) : '';
  if (needsTag && !tag) throw new Error(`tag가 필요합니다 — 어휘: ${tags.join(', ') || '(제한 없음)'}`);
  if (needsTag && tags.length && !tags.includes(tag)) {
    throw new Error(`tag가 어휘 밖입니다: "${tag}" — 허용: ${tags.join(', ')}`);
  }
  if (!needsTag && tag) throw new Error('이 형식은 tag를 쓰지 않습니다.');

  const item = ctx.lib.fillVars(ctx.config.item_pattern, {
    date: ctx.today,
    title,
    tag,
    summary: input?.summary,
  });
  const valid = validateName(ctx, item);
  if (!valid.ok) throw new Error(valid.reason);
  return { item };
}

function copyStubs(ctx, itemDir, vars) {
  if (!fs.existsSync(ctx.stubsDir)) return [];
  const made = [];

  function visit(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const source = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(source);
        continue;
      }
      if (!entry.isFile()) continue;
      const relative = path.relative(ctx.stubsDir, source);
      const target = path.join(itemDir, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, ctx.lib.fillVars(fs.readFileSync(source, 'utf8'), vars));
      made.push(posix(relative));
    }
  }

  visit(ctx.stubsDir);
  return made.sort();
}

export function create(ctx, input) {
  if (!fs.existsSync(ctx.target)) throw new Error(`대상 폴더 없음: ${ctx.target}`);
  const { item } = nameItem(ctx, input);
  const itemDir = path.join(ctx.target, item);
  if (fs.existsSync(itemDir)) throw new Error(`동명 항목이 이미 있습니다: ${item}`);
  fs.mkdirSync(itemDir);

  const vars = {
    item,
    date: ctx.today,
    title: input.title,
    tag: input.tag,
    summary: input.summary,
  };
  const made = copyStubs(ctx, itemDir, vars);
  const entry = ctx.config.entry ? posix(path.join(item, ctx.config.entry)) : item;
  return { item, dir: item, entry, made };
}

function scannedItem(ctx, name, relative, month, tidied) {
  const entry = ctx.config.entry ? posix(path.join(relative, ctx.config.entry)) : null;
  return {
    name,
    path: posix(relative),
    entry: entry && fs.existsSync(path.join(ctx.target, entry)) ? entry : null,
    month,
    tidied,
  };
}

export function scan(ctx) {
  if (!fs.existsSync(ctx.target)) return [];
  const items = [];
  for (const entry of fs.readdirSync(ctx.target, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (MONTH_RE.test(entry.name)) {
      const monthDir = path.join(ctx.target, entry.name);
      for (const child of fs.readdirSync(monthDir, { withFileTypes: true })) {
        if (!child.isDirectory()) continue;
        items.push(scannedItem(ctx, child.name, path.join(entry.name, child.name), entry.name, true));
      }
      continue;
    }
    const month = DATE_ITEM_RE.exec(entry.name)?.[1] ?? null;
    items.push(scannedItem(ctx, entry.name, entry.name, month, false));
  }
  return items.sort((left, right) => left.path.localeCompare(right.path));
}

function previousMonth(today) {
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  return month === 1 ? `${year - 1}-12` : `${year}-${String(month - 1).padStart(2, '0')}`;
}

export function tidy(ctx) {
  if (!fs.existsSync(ctx.target)) throw new Error(`대상 폴더 없음: ${ctx.target}`);
  const currentMonth = ctx.today.slice(0, 7);
  const graceDays = Number.isInteger(ctx.config.tidy?.grace_days) ? ctx.config.tidy.grace_days : 4;
  const day = Number(ctx.today.slice(8, 10));
  const deferredMonth = day <= graceDays ? previousMonth(ctx.today) : null;
  const rootItems = scan(ctx).filter((item) => !item.tidied && item.month && item.month < currentMonth);
  const candidates = rootItems.filter((item) => item.month !== deferredMonth);
  const deferred = rootItems.filter((item) => item.month === deferredMonth);
  if (!candidates.length) {
    const note = deferred.length ? ` (직전 달 ${deferred.length}건은 ${graceDays}일 유예)` : '';
    throw new Error(`미정리 0건 — 묶을 항목이 없습니다.${note}`);
  }

  const moved = [];
  for (const item of candidates) {
    const from = item.path;
    const to = posix(path.join(item.month, item.name));
    ctx.lib.gitMove(ctx.repo, path.join(ctx.target, from), path.join(ctx.target, to));
    moved.push({ from, to });
  }
  return { moved };
}
