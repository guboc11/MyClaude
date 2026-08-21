import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { SHAPE_CONTRACT } from '../server.mjs';
import { renderShapeSkeleton, writeShapeSkeleton } from '../scaffold-shape.mjs';

const INPUT = {
  name: 'month-note',
  depth: '{month}/{item}.md',
  itemPattern: '{date}-{title}.md',
};

test('서버의 shape 계약과 생성자 입력을 뼈대에 넣는다', () => {
  const source = renderShapeSkeleton(INPUT);
  assert.match(source, /name: 'month-note'/);
  assert.match(source, /const ITEM_DEPTH = '\{month\}\/\{item\}\.md'/);
  assert.match(source, /const ITEM_PATTERN = '\{date\}-\{title\}\.md'/);

  for (const contract of SHAPE_CONTRACT.functions) {
    assert.ok(source.includes(`export function ${contract.name}(${contract.params.join(', ')})`));
    assert.ok(source.includes(`계약 반환: ${contract.returns}`));
  }

  assert.match(source, /return \{ ok: false, reason:/);
  assert.equal((source.match(/throw new Error\(/g) || []).length, SHAPE_CONTRACT.functions.length - 1);
});

test('뼈대 파일을 새로 쓰되 기존 파일은 덮어쓰지 않는다', () => {
  const shapesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'document-template-shape-'));
  const file = writeShapeSkeleton(INPUT, shapesDir);
  assert.equal(file, path.join(shapesDir, 'month-note.mjs'));
  assert.equal(fs.readFileSync(file, 'utf8'), renderShapeSkeleton(INPUT));
  assert.equal(spawnSync(process.execPath, ['--check', file]).status, 0);
  assert.throws(() => writeShapeSkeleton(INPUT, shapesDir), /shape 파일이 이미 있습니다/);
});

test('shape 이름·깊이·이름 규칙이 없거나 안전하지 않으면 거부한다', () => {
  assert.throws(() => renderShapeSkeleton({ ...INPUT, name: '../escape' }), /shape 이름은 kebab-case/);
  assert.throws(() => renderShapeSkeleton({ ...INPUT, depth: '' }), /depth가 필요합니다/);
  assert.throws(() => renderShapeSkeleton({ ...INPUT, itemPattern: '' }), /item-pattern이 필요합니다/);
});
