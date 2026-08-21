import fs from 'node:fs';
import path from 'node:path';

export const shape = {
  name: 'dated-file',
  requires: ['item_pattern'],
  optional: ['tidy'],
};

const MONTH_RE = /^\d{4}-\d{2}$/;
const DATE_RE = /^(\d{4}-\d{2})-\d{2}-.+/;
const TITLE_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const META_FILES = new Set(['README.md', 'INDEX.md']);

const posix = (value) => value.split(path.sep).join('/');
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function patternRegex(ctx) {
  const source = String(ctx.config.item_pattern);
  let cursor = 0;
  let regex = '^';
  for (const match of source.matchAll(/\{(date|title)\}/g)) {
    regex += escapeRegex(source.slice(cursor, match.index));
    regex += match[1] === 'date' ? '\\d{4}-\\d{2}-\\d{2}' : '[a-z0-9]+(?:-[a-z0-9]+)*';
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
  if (!TITLE_RE.test(title)) {
    throw new Error(`title이 kebab-case가 아닙니다: "${title}" — 소문자 영문·숫자·하이픈만 씁니다.`);
  }
  if (input?.tag) throw new Error('dated-file 형식은 tag를 쓰지 않습니다.');
  const item = ctx.lib.fillVars(ctx.config.item_pattern, { date: ctx.today, title });
  const valid = validateName(ctx, item);
  if (!valid.ok) throw new Error(valid.reason);
  return { item };
}

function stubText(ctx, vars) {
  if (!fs.existsSync(ctx.stubsDir)) return '';
  const files = fs.readdirSync(ctx.stubsDir, { withFileTypes: true }).filter((entry) => entry.isFile());
  if (!files.length) return '';
  if (files.length > 1) throw new Error('dated-file stub은 한 파일만 둘 수 있습니다.');
  return ctx.lib.fillVars(fs.readFileSync(path.join(ctx.stubsDir, files[0].name), 'utf8'), vars);
}

export function create(ctx, input) {
  if (!fs.existsSync(ctx.target)) throw new Error(`대상 폴더 없음: ${ctx.target}`);
  const { item } = nameItem(ctx, input);
  const month = ctx.today.slice(0, 7);
  const dir = path.join(ctx.target, month);
  const file = path.join(dir, item);
  if (fs.existsSync(file)) throw new Error(`동명 항목이 이미 있습니다: ${item}`);
  fs.mkdirSync(dir, { recursive: true });
  const entry = posix(path.join(month, item));
  const vars = { item, date: ctx.today, title: input.title, summary: input.summary };
  fs.writeFileSync(file, stubText(ctx, vars), { flag: 'wx' });
  return { item, dir: month, entry, made: [entry] };
}

function scannedFile(name, relative, month, tidied) {
  return { name, path: posix(relative), entry: posix(relative), month, tidied };
}

export function scan(ctx) {
  if (!fs.existsSync(ctx.target)) return [];
  const items = [];
  for (const entry of fs.readdirSync(ctx.target, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.md') && !META_FILES.has(entry.name)) {
      items.push(scannedFile(entry.name, entry.name, DATE_RE.exec(entry.name)?.[1] ?? null, false));
      continue;
    }
    if (!entry.isDirectory() || !MONTH_RE.test(entry.name)) continue;
    for (const child of fs.readdirSync(path.join(ctx.target, entry.name), { withFileTypes: true })) {
      if (!child.isFile() || !child.name.endsWith('.md')) continue;
      items.push(scannedFile(child.name, path.join(entry.name, child.name), entry.name, true));
    }
  }
  return items.sort((left, right) => left.path.localeCompare(right.path));
}

export function tidy(ctx) {
  if (!fs.existsSync(ctx.target)) throw new Error(`대상 폴더 없음: ${ctx.target}`);
  const candidates = scan(ctx).filter((item) => !item.tidied && item.month);
  if (!candidates.length) throw new Error('미정리 0건 — 묶을 항목이 없습니다.');
  const moved = [];
  for (const item of candidates) {
    const from = item.path;
    const to = posix(path.join(item.month, item.name));
    ctx.lib.gitMove(ctx.repo, path.join(ctx.target, from), path.join(ctx.target, to));
    moved.push({ from, to });
  }
  return { moved };
}
