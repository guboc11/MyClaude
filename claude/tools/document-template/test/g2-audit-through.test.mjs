import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadDefinition, toolAdd, toolPack, toolRegister } from '../server.mjs';
import { readIndexLinks, updateIndexPaths } from '../lib.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const originalProjectDir = process.env.CLAUDE_PROJECT_DIR;
let fixture;
let packedEntry;
let scanBefore;

const git = (...args) => execFileSync('git', ['-C', fixture, ...args], { encoding: 'utf8' }).trim();

function commit(message) {
  git('add', '-A');
  git('-c', 'user.name=G2', '-c', 'user.email=g2@example.invalid', 'commit', '-q', '-m', message);
}

function indexFile() {
  return path.join(fixture, '_AUDIT', 'INDEX.md');
}

before(() => {
  fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'document-template-g2-'));
  fs.cpSync(path.join(REPO, '_AUDIT'), path.join(fixture, '_AUDIT'), { recursive: true });
  const definition = path.join(fixture, '.claude', 'mcp-document-template', '_AUDIT');
  fs.mkdirSync(path.dirname(definition), { recursive: true });
  fs.cpSync(path.join(REPO, '.claude', 'mcp-document-template', '_AUDIT'), definition, { recursive: true });
  fs.copyFileSync(
    path.join(REPO, '.claude', 'mcp-document-template', 'shapes.json'),
    path.join(fixture, '.claude', 'mcp-document-template', 'shapes.json'),
  );
  git('init', '-q');
  commit('fixture: audit and definition');
  process.env.CLAUDE_PROJECT_DIR = fixture;
});

after(() => {
  if (originalProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
  else process.env.CLAUDE_PROJECT_DIR = originalProjectDir;
  fs.rmSync(fixture, { recursive: true, force: true });
});

test('register 뒤 기존 _AUDIT 항목을 전부 읽는다', async () => {
  await toolRegister({ name: '_AUDIT' });
  const definition = await loadDefinition('_AUDIT');
  assert.ok(definition.target.startsWith(`${fixture}${path.sep}`), '격리 사본 밖의 대상을 가리킴');
  const items = await definition.shapeModule.scan(definition.ctx);
  const links = readIndexLinks(fs.readFileSync(indexFile(), 'utf8'), definition.config.index.section);
  assert.equal(items.length, links.length);
  scanBefore = items.length;
  console.log(`scan_before=${items.length}`);
});

test('add가 항목과 INDEX 행을 하나씩 늘린다', async () => {
  await toolAdd({ name: '_AUDIT', title: 'g2-isolated-probe', tag: 'SWEEP', summary: 'G2 격리 검증' });
  const definition = await loadDefinition('_AUDIT');
  const items = await definition.shapeModule.scan(definition.ctx);
  const links = readIndexLinks(fs.readFileSync(indexFile(), 'utf8'), definition.config.index.section);
  assert.equal(items.length, scanBefore + 1);
  assert.equal(links.length, items.length);
  console.log(`scan_after_add=${items.length}`);
  console.log(`index_after_add=${links.length}`);
});

test('pack이 추적 항목 하나를 git mv로 월 폴더에 넣는다', async () => {
  const definition = await loadDefinition('_AUDIT');
  const target = definition.target;
  const created = `${definition.ctx.today}-SWEEP-g2-isolated-probe`;
  commit('fixture: add through document-template');

  let index = fs.readFileSync(indexFile(), 'utf8');
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d{4}-\d{2}-\d{2}-.+/.test(entry.name) || entry.name === created) continue;
    const month = entry.name.slice(0, 7);
    fs.mkdirSync(path.join(target, month), { recursive: true });
    git('mv', '--', `_AUDIT/${entry.name}`, `_AUDIT/${month}/${entry.name}`);
    index = updateIndexPaths(index, [{ from: entry.name, to: `${month}/${entry.name}` }]);
  }

  const oldName = '2000-01-01-SWEEP-g2-isolated-probe';
  git('mv', '--', `_AUDIT/${created}`, `_AUDIT/${oldName}`);
  index = index.replaceAll(created, oldName);
  fs.writeFileSync(indexFile(), index);
  commit('fixture: leave one tracked root item for pack');

  const output = await toolPack({ name: '_AUDIT' });
  const moved = Number(/이동: (\d+)건/.exec(output)?.[1]);
  assert.equal(moved, 1);
  packedEntry = `_AUDIT/2000-01/${oldName}/SUMMARY.md`;
  assert.ok(fs.existsSync(path.join(fixture, packedEntry)));
  console.log(`moved=${moved}`);
});

test('pack 뒤에도 SUMMARY의 Git 이력이 이어진다', () => {
  commit('fixture: pack through document-template');
  const history = git('log', '--follow', '--format=%H', '--', packedEntry).split('\n').filter(Boolean);
  const preserved = history.length >= 2 ? 1 : 0;
  assert.equal(preserved, 1);
  console.log(`history_preserved=${preserved}`);
});
