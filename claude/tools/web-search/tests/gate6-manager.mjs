#!/usr/bin/env node
// 게이트 6 의 "상위 에이전트" 역할 — 다음 묶음을 정하는 새 프로세스.
//
//   node tests/gate6-manager.mjs <export.jsonl> <status.json>
//
// 이 프로세스가 볼 수 있는 것은 **딱 두 파일**이다. workspace.db 도, artifacts 폴더도 없다.
// 게이트가 그 둘만 빈 폴더에 복사해 두고 여기를 부른다 — 못 본다고 믿는 것이 아니라
// 볼 수 없게 만들어 놓고 부른다. 아래에서 그 사실을 스스로 한 번 더 확인한다.
//
// 하는 일은 판단이다. 무엇을 다음에 돌릴지 정하고, 왜 그렇게 정했는지 함께 낸다.

import fs from 'node:fs';
import path from 'node:path';

const [exportPath, statusPath] = process.argv.slice(2);
const out = (o) => { process.stdout.write(`${JSON.stringify(o, null, 2)}\n`); process.exit(o.error ? 1 : 0); };

if (!exportPath || !statusPath) out({ error: '쓰는 법: gate6-manager.mjs <export.jsonl> <status.json>' });

// 이 폴더에 정말 두 파일뿐인가. 장부가 손 닿는 곳에 있으면 이 실습은 뜻이 없다.
const here = path.dirname(path.resolve(exportPath));
const visible = fs.readdirSync(here).sort();
const forbidden = visible.filter((n) => /\.db($|-)/.test(n) || n === 'artifacts');
if (forbidden.length) out({ error: `장부가 보이는 자리다: ${forbidden.join(', ')}` });

const rows = fs.readFileSync(exportPath, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
const status = JSON.parse(fs.readFileSync(statusPath, 'utf8'));

// ── 판단 ──────────────────────────────────────────────────────
// 규칙은 단순하다. 아직 안 본 것 → 본 뒤 판정이 안 붙은 것 → 실패한 것 순으로 손댄다.
const queued = rows.filter((r) => r.work_state === 'queued').map((r) => r.item_id);
const failed = rows.filter((r) => r.work_state === 'failed').map((r) => r.item_id);
// 봤는데 아무도 라벨을 안 붙인 것. 1차가 무너진 자리가 정확히 여기다 — 다 됐다고 적히지만 판정이 없다.
const doneWithoutLabel = rows.filter((r) => r.work_state === 'done' && (r.labels ?? []).length === 0).map((r) => r.item_id);
const conflicted = rows.filter((r) => new Set(r.labels ?? []).size > 1).map((r) => r.item_id);

const worst = (status.top_errors ?? []).find((e) => e.kind === 'error');

out({
  read_only: [path.basename(exportPath), path.basename(statusPath)],
  saw_files: visible,
  totals: { rows: rows.length, status_total: status.total, done: status.done, failed: status.failed, queued: status.queued },
  next_item_ids: queued,
  retry_item_ids: failed,
  needs_judgment_item_ids: doneWithoutLabel,
  conflicted_item_ids: conflicted,
  // 상위 역할이 사람에게 할 말. status 와 export 만으로 여기까지 말할 수 있어야 한다.
  why: [
    `대기 ${queued.length}건을 다음 묶음으로 돌린다`,
    failed.length ? `실패 ${failed.length}건은 ${worst ? `${worst.stage}/${worst.code}` : '원인 미상'} 부터 다시 본다` : '실패 없음',
    doneWithoutLabel.length ? `수집은 됐지만 판정이 없는 ${doneWithoutLabel.length}건이 남아 있다 — 완료로 세면 안 된다` : '판정 없는 완료 없음',
    conflicted.length ? `판정이 갈린 ${conflicted.length}건은 사람이 봐야 한다` : '갈린 판정 없음',
    status.workspace_drained ? '대기·임대는 비었지만 조사가 끝났다는 뜻은 아니다' : '아직 돌릴 일이 남아 있다',
  ],
});
