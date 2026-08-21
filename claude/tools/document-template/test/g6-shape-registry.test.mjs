import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadDefinition, toolList } from '../server.mjs';

function makeFixture({ registered = [], files = [] } = {}) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'document-template-g6-'));
  const definitions = path.join(repo, '.claude', 'mcp-document-template');
  const shapesDir = path.join(repo, 'shapes');
  fs.mkdirSync(definitions, { recursive: true });
  fs.mkdirSync(shapesDir);
  fs.writeFileSync(path.join(definitions, 'shapes.json'), `${JSON.stringify({
    shapes: registered.map((name) => ({ name, registered_at: '2026-08-16' })),
  }, null, 2)}\n`);
  for (const name of files) {
    fs.writeFileSync(path.join(shapesDir, `${name}.mjs`), [
      `export const shape = { name: '${name}', requires: [], optional: [] };`,
      'export function scan() { return []; }',
      '',
    ].join('\n'));
  }
  return { repo, shapesDir, definitions };
}

test('미등재 shape를 부르는 정의는 거부한다', async () => {
  const fixture = makeFixture({ files: ['unregistered-probe'] });
  try {
    const definition = path.join(fixture.definitions, 'probe');
    fs.mkdirSync(definition);
    fs.writeFileSync(path.join(definition, 'README.md'), '# probe\n');
    fs.writeFileSync(path.join(definition, 'config.json'), `${JSON.stringify({
      shape: 'unregistered-probe',
      index: { file: 'INDEX.md', section: '## 목록', row: '- [{summary}]({entry})' },
    }, null, 2)}\n`);

    await assert.rejects(
      () => loadDefinition('probe', fixture),
      (error) => {
        assert.equal(
          error.message,
          '등록되지 않은 형식입니다: unregistered-probe — shape_register(unregistered-probe) 먼저.',
        );
        return true;
      },
    );
    console.log('unregistered_definition_rejected=1');
  } finally {
    fs.rmSync(fixture.repo, { recursive: true, force: true });
  }
});

test('장부에만 있는 shape를 template_list가 표시한다', async () => {
  const fixture = makeFixture({ registered: ['registry-only'] });
  try {
    const output = await toolList({}, fixture);
    assert.match(output, /registry-only — 장부에 있으나 파일 없음/);
    console.log('registry_only_reported=1');
  } finally {
    fs.rmSync(fixture.repo, { recursive: true, force: true });
  }
});

test('파일에만 있는 shape를 template_list가 표시한다', async () => {
  const fixture = makeFixture({ files: ['file-only'] });
  try {
    const output = await toolList({}, fixture);
    assert.match(output, /file-only — 파일은 있으나 미등재/);
    console.log('file_only_reported=1');
  } finally {
    fs.rmSync(fixture.repo, { recursive: true, force: true });
  }
});
