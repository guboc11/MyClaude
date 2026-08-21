import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as lib from '../lib.mjs';
import { loadDefinition } from '../server.mjs';

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

test('RESEARCH 새 정의가 실물·INDEX·SUMMARY를 전부 읽는다', async () => {
  const { definition, items, compared } = await measuredDefinition('_RESEARCH');
  const summary = items.filter((item) => item.entry?.endsWith('/SUMMARY.md')).length;
  const invalid = items.filter((item) => !definition.shapeModule.validateName(definition.ctx, item.name).ok).length;
  assertIndexMatches(items, compared);
  console.log(`RESEARCH scan=${items.length} index=${compared.links.length} summary=${summary} invalid=${invalid}`);
});

test('E2E 새 INDEX가 run을 빠짐없이 담는다', async () => {
  const { definition, items, index, compared } = await measuredDefinition('_E2E');
  const links = lib.readIndexLinks(index, definition.config.index.section);
  const broken = links.filter((link) => !fs.existsSync(path.join(definition.target, link.target)));
  const auxiliary = index.split('\n').filter((line) => line.startsWith('- 고정 부속 — ') && line.includes('[scenarios/](./scenarios/)'));
  const scenarioLinks = [...index.matchAll(/\[[^\]]*scenarios\/[^\]]*\]\([^)]+\)/g)];
  assertIndexMatches(items, compared);
  assert.equal(broken.length, 0);
  assert.equal(auxiliary.length, 1);
  assert.equal(scenarioLinks.length, 1);
  assert.ok(!links.some((link) => link.target.replace(/\/$/, '') === 'scenarios'));
  console.log(`E2E scan=${items.length} index=${compared.links.length}`);
});

test('plans 중첩 정의의 실물과 INDEX가 같다', async () => {
  const { definition, items, compared } = await measuredDefinition('.claude/plans');
  assert.equal(definition.target, path.join(REPO, '.claude', 'plans'));
  assertIndexMatches(items, compared);
  console.log(`plans scan=${items.length} index=${compared.links.length}`);
});
