import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as lib from '../lib.mjs';
import { loadDefinition, toolAdd, toolPack } from '../server.mjs';
import * as datedFolder from '../shapes/dated-folder.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

async function measuredDefinition(name) {
  const definition = await loadDefinition(name, { repo: REPO });
  const items = await definition.shapeModule.scan(definition.ctx);
  const index = fs.readFileSync(path.join(definition.target, definition.config.index.file), 'utf8');
  const compared = lib.compareIndex(items, index, definition.config.index.section);
  return { definition, items, index, compared };
}

function assertIndexMatches(items, compared) {
  assert.equal(items.length, compared.links.length);
  assert.deepEqual([compared.missing.length, compared.stale.length], [0, 0]);
}

test('AUDIT 실물·INDEX·SUMMARY·이름 판정을 잰다', async () => {
  const { definition, items, compared } = await measuredDefinition('_AUDIT');
  const summary = items.filter((item) => item.entry?.endsWith('/SUMMARY.md')).length;
  const invalid = items.filter((item) => !definition.shapeModule.validateName(definition.ctx, item.name).ok).length;
  assertIndexMatches(items, compared);
  console.log(`AUDIT scan=${items.length} index=${compared.links.length} summary=${summary} invalid=${invalid}`);
});

test('RESEARCH를 이사하지 않고 dated-folder로 잰다', () => {
  const config = {
    item_pattern: '{date}-{TAG}-{title}',
    tags: ['INTERNAL', 'LEARN', 'COMPARE', 'MARKET'],
    entry: 'SUMMARY.md',
  };
  const ctx = {
    repo: REPO,
    target: path.join(REPO, '_RESEARCH'),
    defDir: path.join(REPO, '.claude', 'templates', 'research'),
    stubsDir: path.join(REPO, '.claude', 'templates', 'research', 'stubs'),
    config,
    today: lib.todayKst(),
    lib,
  };
  const items = datedFolder.scan(ctx);
  const index = fs.readFileSync(path.join(ctx.target, 'INDEX.md'), 'utf8');
  const compared = lib.compareIndex(items, index, '## 주제 목록 (최신순)');
  const summary = items.filter((item) => item.entry?.endsWith('/SUMMARY.md')).length;
  const invalid = items.filter((item) => !datedFolder.validateName(ctx, item.name).ok).length;
  assertIndexMatches(items, compared);
  console.log(`RESEARCH scan=${items.length} index=${compared.links.length} summary=${summary} invalid=${invalid}`);
});

test('CRAFT_GUIDE flat-file 실물과 INDEX가 같다', async () => {
  const { items, compared } = await measuredDefinition('_CRAFT_GUIDE');
  assertIndexMatches(items, compared);
  console.log(`CRAFT_GUIDE scan=${items.length} index=${compared.links.length}`);
});

test('CURRENT_SHAPE flat-file 실물과 INDEX가 같다', async () => {
  const { items, compared } = await measuredDefinition('_CURRENT_SHAPE');
  assertIndexMatches(items, compared);
  console.log(`CURRENT_SHAPE scan=${items.length} index=${compared.links.length}`);
});

test('MANUALS flat-file 실물과 INDEX가 같다', async () => {
  const { items, compared } = await measuredDefinition('_MANUALS');
  assertIndexMatches(items, compared);
  console.log(`MANUALS scan=${items.length} index=${compared.links.length}`);
});

test('CHANGE_CHRONICLE dated-file과 동적 월 섹션을 검증한다', async () => {
  const { definition, items, index, compared } = await measuredDefinition('_CHANGE_CHRONICLE');
  const invalid = items.filter((item) => !definition.shapeModule.validateName(definition.ctx, item.name).ok).length;
  assertIndexMatches(items, compared);
  assert.equal(invalid, 0);
  assert.ok(items.every((item) => item.entry === item.path && item.month));

  const newSection = lib.fillVars(definition.config.index.section, { month: '9999-01' });
  const withNewMonth = lib.insertIndexRow(index, newSection, '- [future](9999-01/future.md)', { createSection: true });
  assert.ok(withNewMonth.indexOf(newSection) < withNewMonth.indexOf('## 2026-08'));
  assert.throws(() => lib.insertIndexRow(index, '## 없는 고정 섹션', '- row'), /INDEX에 섹션 없음/);
  console.log(`CHANGE_CHRONICLE scan=${items.length} index=${compared.links.length}`);
});

test('ARCHIVED 루트 실물과 INDEX가 같다', async () => {
  const { items, compared } = await measuredDefinition('_ARCHIVED');
  assertIndexMatches(items, compared);
  console.log(`ARCHIVED scan=${items.length} index=${compared.links.length}`);
});

test('flat-file 세 폴더의 pack을 거부한다', async () => {
  let rejected = 0;
  for (const name of ['_CRAFT_GUIDE', '_CURRENT_SHAPE', '_MANUALS']) {
    await assert.rejects(() => toolPack({ name }), /이 폴더에는 없는 동작.*tidy/);
    rejected += 1;
  }
  assert.equal(rejected, 3);
  console.log(`flat_pack_rejected=${rejected}`);
});

test('ARCHIVED add를 파일 생성 전에 거부한다', async () => {
  const before = fs.readdirSync(path.join(REPO, '_ARCHIVED')).sort();
  await assert.rejects(
    () => toolAdd({ name: '_ARCHIVED', title: 'g3-must-not-create', summary: '금지 검증' }),
    /이 폴더에는 없는 동작.*create/,
  );
  const after = fs.readdirSync(path.join(REPO, '_ARCHIVED')).sort();
  assert.deepEqual(after, before);
  console.log('archived_add_rejected=1');
});
