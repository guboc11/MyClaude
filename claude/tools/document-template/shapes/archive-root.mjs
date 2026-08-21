import fs from 'node:fs';

export const shape = {
  name: 'archive-root',
  requires: [],
  optional: [],
};

export function validateName(ctx, name) {
  return ctx.lib.validateSafeSegment(name);
}

export function nameItem(ctx, input) {
  const item = String(input?.title ?? '');
  if (input?.tag) throw new Error('archive-root 형식은 tag를 쓰지 않습니다.');
  const valid = validateName(ctx, item);
  if (!valid.ok) throw new Error(valid.reason);
  return { item };
}

export function scan(ctx) {
  if (!fs.existsSync(ctx.target)) return [];
  return fs.readdirSync(ctx.target, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      name: entry.name,
      path: entry.name,
      entry: null,
      month: null,
      tidied: true,
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
}
