#!/usr/bin/env node
// 두 spike 를 이어 돌린다. workspace.db 와 전역 pace.db 는 목적도 경합도 달라 결과를 따로 남긴다.
//
//   node tests/spikes/sqlite-wal/run-all.mjs

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const steps = [
  ['workspace.db', 'workspace-spike.mjs'],
  ['전역 pace.db', 'pace-spike.mjs'],
];

let failed = 0;
for (const [label, file] of steps) {
  console.log(`\n=== ${label} — ${file} ===`);
  const r = spawnSync(process.execPath, [path.join(HERE, file)], { stdio: 'inherit' });
  if (r.status !== 0) failed++;
}
console.log(failed === 0 ? '\nPASS  두 spike 모두 통과' : `\nFAIL  ${failed}개 spike 실패`);
process.exit(failed === 0 ? 0 : 1);
