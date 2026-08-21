import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { toolShapeNew, toolShapeRegister } from '../server.mjs';

let fixture;
let shapesDir;

function registryFile() {
  return path.join(fixture, '.claude', 'mcp-document-template', 'shapes.json');
}

function readRegistry() {
  return JSON.parse(fs.readFileSync(registryFile(), 'utf8'));
}

before(() => {
  fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'document-template-g5-'));
  shapesDir = path.join(fixture, 'shapes');
  fs.mkdirSync(path.dirname(registryFile()), { recursive: true });
  fs.mkdirSync(shapesDir);
  fs.writeFileSync(registryFile(), '{\n  "shapes": []\n}\n');
});

after(() => {
  fs.rmSync(fixture, { recursive: true, force: true });
});

test('shape_new의 빈 뼈대는 shape_register가 거부한다', async () => {
  await toolShapeNew({
    name: 'g5-probe',
    depth: '{item}.md',
    item_pattern: '{title}.md',
  }, { shapesDir });

  await assert.rejects(
    () => toolShapeRegister({ name: 'g5-probe' }, { repo: fixture, shapesDir }),
    /shape 구현이 비어 있습니다/,
  );
  assert.deepEqual(readRegistry().shapes, []);
  console.log('empty_rejected=1');
});

test('가운데를 채운 shape는 등록되고 재호출해도 중복되지 않는다', async () => {
  fs.writeFileSync(path.join(shapesDir, 'g5-probe.mjs'), [
    "export const shape = { name: 'g5-probe', requires: ['item_pattern'], optional: [] };",
    'export function nameItem(ctx, input) { void ctx; return { item: String(input.title) }; }',
    'export function validateName(ctx, name) { void ctx; return { ok: Boolean(name) }; }',
    "export function create(ctx, input) { void ctx; return { item: String(input.title), dir: null, entry: String(input.title), made: [] }; }",
    'export function scan(ctx) { void ctx; return []; }',
    '',
  ].join('\n'));

  const first = await toolShapeRegister({ name: 'g5-probe' }, { repo: fixture, shapesDir });
  const second = await toolShapeRegister({ name: 'g5-probe' }, { repo: fixture, shapesDir });
  const registry = readRegistry();
  assert.equal(registry.shapes.length, 1);
  assert.equal(registry.shapes[0].name, 'g5-probe');
  assert.match(registry.shapes[0].registered_at, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(first, /신규 등재/);
  assert.match(second, /재검사 완료/);
  console.log('filled_registered=1');
});
