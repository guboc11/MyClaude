#!/usr/bin/env node
// 쓰는 도중에 죽는 프로세스. 부모(verify.mjs)가 SIGKILL 로 끊는다.
//
//   node tests/artifacts/kill-child.mjs <workspace-root> <db-path> <item-id>
//
// 일부러 진짜 코드 경로를 탄다 — writeArtifact 에 "한 조각 주고 영영 안 끝나는" 흐름을 건넨다.
// 그러면 임시 파일은 실제로 만들어지고 rename 은 절대 오지 않는다. 강제 종료를 흉내 내려고
// 손으로 .part- 파일을 만들어 두면, 정작 진짜 코드가 그런 파일을 남기는지는 확인하지 못한다.

import { openDb } from '../../lib/db.mjs';
import { writeArtifact } from '../../lib/artifacts.mjs';
import { startAttempt } from '../../lib/attempts.mjs';

const [root, dbPath, itemId] = process.argv.slice(2);
const db = openDb(root, dbPath);

const { attempt_id: attemptId } = startAttempt(db, {
  itemId: Number(itemId),
  operation: 'collect',
  collector: 'http',
  requestedOutputs: ['text', 'dom'],
  requestedUrl: 'http://127.0.0.1/static/normal',
  nowMs: 1_700_000_000_000,
});

// 부모가 무엇을 죽였는지 알 수 있게 먼저 알린다.
process.stdout.write(`${attemptId}\n`);

async function* stalls() {
  yield Buffer.from('여기까지는 디스크에 들어간다. 그다음은 영영 오지 않는다.\n');
  process.stdout.write('ready\n');
  await new Promise(() => {});   // 여기서 멈춘다. 부모가 SIGKILL 한다.
}

await writeArtifact(db, {
  root,
  attemptId,
  kind: 'text',
  name: 'text.txt',
  data: stalls(),
  nowMs: 1_700_000_000_000,
});

process.stdout.write('절대 여기까지 오면 안 된다\n');
