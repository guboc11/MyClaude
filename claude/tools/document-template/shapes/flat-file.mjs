import fs from 'node:fs';
import path from 'node:path';

export const shape = {
  name: 'flat-file',
  requires: ['item_pattern'],
  optional: [],
};

const TITLE_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const META_FILES = new Set(['README.md', 'INDEX.md']);

function renderItem(pattern, title) {
  return String(pattern)
    .replaceAll('{TITLE}', title.toUpperCase().replaceAll('-', '_'))
    .replaceAll('{title}', title);
}

function patternRegex(pattern) {
  const escaped = String(pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped
    .replace('\\{TITLE\\}', '[A-Z0-9]+(?:_[A-Z0-9]+)*')
    .replace('\\{title\\}', '[a-z0-9]+(?:-[a-z0-9]+)*')}$`);
}

export function validateName(ctx, name) {
  const safe = ctx.lib.validateSafeSegment(name);
  if (!safe.ok) return safe;
  if (!patternRegex(ctx.config.item_pattern).test(String(name))) {
    return { ok: false, reason: `이름이 item_pattern과 다릅니다: "${name}" — ${ctx.config.item_pattern}` };
  }
  return { ok: true };
}

export function nameItem(ctx, input) {
  const title = String(input?.title ?? '');
  if (!TITLE_RE.test(title)) {
    throw new Error(`title이 kebab-case가 아닙니다: "${title}" — 소문자 영문·숫자·하이픈만 씁니다.`);
  }
  if (input?.tag) throw new Error('flat-file 형식은 tag를 쓰지 않습니다.');
  const item = renderItem(ctx.config.item_pattern, title);
  const valid = validateName(ctx, item);
  if (!valid.ok) throw new Error(valid.reason);
  return { item };
}

function stubText(ctx, vars) {
  if (!fs.existsSync(ctx.stubsDir)) return '';
  const files = fs.readdirSync(ctx.stubsDir, { withFileTypes: true }).filter((entry) => entry.isFile());
  if (!files.length) return '';
  if (files.length > 1) throw new Error('flat-file stub은 한 파일만 둘 수 있습니다.');
  return ctx.lib.fillVars(fs.readFileSync(path.join(ctx.stubsDir, files[0].name), 'utf8'), vars);
}

export function create(ctx, input) {
  if (!fs.existsSync(ctx.target)) throw new Error(`대상 폴더 없음: ${ctx.target}`);
  const { item } = nameItem(ctx, input);
  const file = path.join(ctx.target, item);
  if (fs.existsSync(file)) throw new Error(`동명 항목이 이미 있습니다: ${item}`);
  const vars = { item, title: input.title, summary: input.summary };
  fs.writeFileSync(file, stubText(ctx, vars), { flag: 'wx' });
  return { item, dir: null, entry: item, made: [item] };
}

export function scan(ctx) {
  if (!fs.existsSync(ctx.target)) return [];
  return fs.readdirSync(ctx.target, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md') && !META_FILES.has(entry.name))
    .map((entry) => ({
      name: entry.name,
      path: entry.name,
      entry: entry.name,
      month: null,
      tidied: true,
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
}
