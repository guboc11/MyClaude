import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseReadme, readReadmeClause } from '../lib.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

function loadLegacyParser() {
  const file = path.join(REPO, '_ARCHIVED', 'template-mcp', 'server.mjs');
  const source = fs.readFileSync(file, 'utf8');
  const start = source.indexOf('function parseDoc(text) {');
  const marker = '\n}\n\n// ── 도구: template_register';
  const end = source.indexOf(marker, start);
  assert.notEqual(start, -1, '옛 서버에서 parseDoc 시작을 찾지 못함');
  assert.notEqual(end, -1, '옛 서버에서 parseDoc 끝을 찾지 못함');

  const context = {};
  vm.runInNewContext(`${source.slice(start, end + 2)}\nglobalThis.parseDoc = parseDoc;`, context);
  return context.parseDoc;
}

test('G1: _AUDIT README의 모든 주소 조항이 옛 파서와 바이트 단위로 같다', () => {
  const readme = fs.readFileSync(path.join(REPO, '_AUDIT', 'README.md'), 'utf8');
  const legacy = loadLegacyParser()(readme);
  const current = parseReadme(readme);
  assert.equal(
    current.sections.map(({ addr }) => addr).join('\n'),
    legacy.sections.map(({ addr }) => addr).join('\n'),
  );

  let byteDiff = 0;
  for (const section of legacy.sections) {
    const before = legacy.lines.slice(section.start, section.end).join('\n').trim();
    const after = readReadmeClause(readme, section.addr);
    if (!Buffer.from(before).equals(Buffer.from(after))) byteDiff += 1;
  }

  console.log(`byte_diff=${byteDiff}`);
  assert.equal(byteDiff, 0);
});
