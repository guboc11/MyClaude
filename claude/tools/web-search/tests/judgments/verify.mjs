#!/usr/bin/env node
// judgments 보존 계층 시험 — 태스크 #39.
//
//   node tests/judgments/verify.mjs
//   node tests/judgments/verify.mjs --json
//
// 완료 조건이 "같은 item 의 상충 판정 둘과 각 근거가 모두 조회되고 collect 상태는 변하지 않는다"
// 이므로, 잘 되는 길만 보면 아무것도 증명하지 못한다. 실제로 망가뜨려 본다:
//   근거 파일을 지우고 · 같은 크기로 내용만 바꾸고 · 옆 item 의 근거를 대고 · 계층을 우회해 직접 넣는다.
//
// 네트워크는 쓰지 않는다. 마지막 항목이 그 사실을 판정한다.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { attemptStorageDir, writeArtifact } from '../../lib/artifacts.mjs';
import { finishAttempt, startAttempt } from '../../lib/attempts.mjs';
import { applyPragmas, createDb } from '../../lib/db.mjs';
import { addUrls } from '../../lib/items.mjs';
import {
  JudgmentError, conflictingItems, judgmentCounts, judgmentsOf, recordJudgments,
} from '../../lib/judgments.mjs';
import { SCHEMA_VERSION } from '../../lib/schema.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AS_JSON = process.argv.includes('--json');

// ── 네트워크 차단 ─────────────────────────────────────────────
let networkAttempts = 0;
globalThis.fetch = (...a) => {
  networkAttempts++;
  throw new Error(`이 시험은 네트워크를 쓰지 않는다: fetch(${String(a[0]).slice(0, 60)})`);
};

const results = [];
const ok = (id, pass, detail) => results.push({ id, pass: Boolean(pass), detail: String(detail) });

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'judgments-unit-'));
process.on('exit', () => { try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* 이미 없으면 그만 */ } });

const NOW = 1_700_000_000_000;
let seq = 0;

/**
 * 항목 둘과 각 항목의 수집 기록·근거 파일이 들어 있는 workspace 를 새로 만든다.
 * 근거 검증을 재려면 진짜 파일이 있어야 한다 — 가짜 id 만으로는 아무것도 증명 못 한다.
 */
async function freshWorkspace() {
  const root = path.join(SANDBOX, `ws${++seq}`);
  fs.mkdirSync(root, { recursive: true });
  const db = createDb(root, path.join(root, 'workspace.db'), {
    workspaceId: `2026-08-12-judgments-${seq}`, projectRoot: SANDBOX, briefPath: path.join(root, 'brief.md'), nowMs: NOW,
  });
  addUrls(db, [{ url: 'https://example.com/one', line: 1 }, { url: 'https://example.com/two', line: 2 }],
    { source_kind: 'seed', source_value: 'manual', nowMs: NOW });

  const evidence = {};
  for (const itemId of [1, 2]) {
    const a = startAttempt(db, {
      itemId, operation: 'collect', collector: 'http',
      requestedOutputs: ['text'], requestedUrl: `https://example.com/${itemId}`, nowMs: NOW,
    });
    const art = await writeArtifact(db, {
      root, attemptId: a.attempt_id, kind: 'text', name: 'page.txt',
      data: `item ${itemId} 의 본문\n`, nowMs: NOW,
    });
    finishAttempt(db, { attemptId: a.attempt_id, result: 'success', httpStatus: 200, nowMs: NOW + 10 });
    evidence[itemId] = { attempt: a.attempt_id, artifact_id: art.artifact_id, path: art.path, abs: path.join(root, art.path) };
  }
  return { root, db, evidence };
}

const judge = (itemId, over = {}) => ({
  item_id: itemId, label: '후보', confidence: 0.8, evidence_artifact_ids: [], note: '', ...over,
});
const reasonOf = (r, itemId) => r.rejects.find((x) => x.item_id === itemId)?.reason ?? null;

const stateSnapshot = (db) => JSON.stringify({
  items: db.prepare('SELECT item_id, work_state, lease_id, collected_at, updated_at FROM items ORDER BY item_id').all(),
  itemCount: db.prepare('SELECT COUNT(*) AS n FROM items').get().n,
  sources: db.prepare('SELECT COUNT(*) AS n FROM sources').get().n,
  attempts: db.prepare('SELECT attempt_id, result FROM attempts ORDER BY attempt_id').all(),
  artifacts: db.prepare('SELECT COUNT(*) AS n FROM artifacts').get().n,
});

// ══ A. 저장과 조회 ════════════════════════════════════════════
{
  const { root, db, evidence } = await freshWorkspace();

  const r = recordJudgments(db, root, {
    workerId: 'w1', nowMs: NOW + 100,
    judgments: [judge(1, { evidence_artifact_ids: [evidence[1].artifact_id], note: '가격표가 있다' })],
  });
  const rows = judgmentsOf(db, 1);
  ok('A1-store-and-read', r.stored === 1 && r.rejected === 0 && rows.length === 1
    && rows[0].worker_id === 'w1' && rows[0].label === '후보' && rows[0].confidence === 0.8
    && rows[0].note === '가격표가 있다' && rows[0].created_at === NOW + 100
    && JSON.stringify(rows[0].evidence_artifact_ids) === JSON.stringify([evidence[1].artifact_id])
    && rows[0].abstained === false,
    `저장 ${r.stored} · 조회 ${rows.length}줄 · 근거 ${rows[0].evidence_artifact_ids.join(',')}`);

  // 칸이 빠진 줄은 그 줄만 거절하고 나머지는 저장한다.
  const partial = recordJudgments(db, root, {
    workerId: 'w1', nowMs: NOW + 110,
    judgments: [{ item_id: 2, label: '후보', confidence: null, note: '메모' }, judge(2, { note: '멀쩡한 줄' })],
  });
  ok('A2-missing-field-rejects-one-row', partial.stored === 1 && partial.rejected === 1
    && partial.rejects[0].reason === 'missing_field' && partial.rejects[0].detail.field === 'evidence_artifact_ids'
    && judgmentsOf(db, 2).length === 1,
    `저장 ${partial.stored} · 거절 ${partial.rejected}(${partial.rejects[0].reason}: ${partial.rejects[0].detail.field})`);

  const foreign = recordJudgments(db, root, { workerId: 'w1', nowMs: NOW, judgments: [judge(9999)] });
  ok('A3-foreign-item', foreign.stored === 0 && reasonOf(foreign, 9999) === 'item_not_here', reasonOf(foreign, 9999));

  const labels = recordJudgments(db, root, {
    workerId: 'w1', nowMs: NOW, judgments: [judge(1, { label: '  ' }), judge(1, { label: 42 })],
  });
  ok('A4-label-shape', labels.stored === 0 && labels.rejects.map((x) => x.reason).join(',') === 'label_blank,label_type',
    labels.rejects.map((x) => x.reason).join(' · '));

  const conf = recordJudgments(db, root, {
    workerId: 'w1', nowMs: NOW,
    judgments: [judge(1, { confidence: 1.5 }), judge(1, { confidence: 'high' }), judge(1, { label: null, confidence: 0.5, note: '왜' })],
  });
  ok('A5-confidence-guards', conf.stored === 0
    && conf.rejects.map((x) => x.reason).join(',') === 'confidence_range,confidence_type,confidence_without_label',
    conf.rejects.map((x) => x.reason).join(' · '));

  // 판정 없음도 판정이다 — 다만 왜인지는 적어야 한다.
  const abstain = recordJudgments(db, root, {
    workerId: 'w2', nowMs: NOW + 120,
    judgments: [judge(1, { label: null, confidence: null, note: '본문이 비어 못 정했다' }), judge(2, { label: null, confidence: null, note: '' })],
  });
  const abstained = judgmentsOf(db, 1).find((x) => x.abstained);
  ok('A6-abstain-is-explicit', abstain.stored === 1 && abstain.rejected === 1
    && reasonOf(abstain, 2) === 'abstain_needs_note'
    && abstained !== undefined && abstained.label === null && abstained.note === '본문이 비어 못 정했다',
    `반납 저장 ${abstain.stored}(label=null·사유 있음) · 사유 없는 반납은 ${reasonOf(abstain, 2)}`);

  db.close();
}

// ══ B. 근거는 있는 척할 수 없다 ═══════════════════════════════
{
  const { root, db, evidence } = await freshWorkspace();
  const good = evidence[1].artifact_id;

  const other = recordJudgments(db, root, {
    workerId: 'w1', nowMs: NOW, judgments: [judge(1, { evidence_artifact_ids: [evidence[2].artifact_id] })],
  });
  ok('B1-evidence-of-other-item', other.stored === 0 && reasonOf(other, 1) === 'evidence_other_item'
    && other.rejects[0].detail.belongs_to === 2,
    `${reasonOf(other, 1)} — 그 근거는 item ${other.rejects[0].detail.belongs_to} 것이다`);

  const ghost = recordJudgments(db, root, { workerId: 'w1', nowMs: NOW, judgments: [judge(1, { evidence_artifact_ids: [9999] })] });
  ok('B2-evidence-not-here', ghost.stored === 0 && reasonOf(ghost, 1) === 'evidence_not_here', reasonOf(ghost, 1));

  const types = recordJudgments(db, root, {
    workerId: 'w1', nowMs: NOW,
    judgments: [judge(1, { evidence_artifact_ids: 'A-1' }), judge(1, { evidence_artifact_ids: ['x'] })],
  });
  ok('B3-evidence-type', types.stored === 0 && types.rejects.every((x) => x.reason === 'evidence_type'),
    types.rejects.map((x) => x.reason).join(' · '));

  // 여기부터가 진짜다. 장부는 그대로 두고 파일만 망가뜨린다.
  const before = fs.readFileSync(evidence[1].abs);
  fs.writeFileSync(evidence[1].abs, Buffer.alloc(before.length, 0x41));   // 크기는 같고 내용만 다르게
  const shaBad = recordJudgments(db, root, { workerId: 'w1', nowMs: NOW, judgments: [judge(1, { evidence_artifact_ids: [good] })] });

  fs.writeFileSync(evidence[1].abs, Buffer.concat([before, Buffer.from('덧붙임')]));
  const sizeBad = recordJudgments(db, root, { workerId: 'w1', nowMs: NOW, judgments: [judge(1, { evidence_artifact_ids: [good] })] });

  fs.rmSync(evidence[1].abs);
  const gone = recordJudgments(db, root, { workerId: 'w1', nowMs: NOW, judgments: [judge(1, { evidence_artifact_ids: [good] })] });

  fs.writeFileSync(evidence[1].abs, before);   // 되돌려 놓는다
  const back = recordJudgments(db, root, { workerId: 'w1', nowMs: NOW + 200, judgments: [judge(1, { evidence_artifact_ids: [good] })] });

  ok('B4-file-tampered', reasonOf(shaBad, 1) === 'evidence_sha_mismatch' && shaBad.stored === 0,
    `내용만 바꾸니 ${reasonOf(shaBad, 1)} (크기는 그대로 ${before.length}바이트)`);
  ok('B5-file-size-changed', reasonOf(sizeBad, 1) === 'evidence_size_mismatch' && sizeBad.stored === 0,
    `${reasonOf(sizeBad, 1)} — 장부 ${sizeBad.rejects[0].detail.db} · 디스크 ${sizeBad.rejects[0].detail.disk}`);
  ok('B6-file-missing', reasonOf(gone, 1) === 'evidence_file_missing' && gone.stored === 0, reasonOf(gone, 1));
  ok('B7-restored-passes', back.stored === 1 && back.rejected === 0
    && judgmentsOf(db, 1).some((j) => j.evidence_artifact_ids.includes(good)),
    `파일을 되돌리니 통과 · 근거 ${good} 이 판정에서 되짚어진다`);

  // 망가진 세 번 동안 판정이 한 줄도 안 들어갔는지 — 거절이 곧 미저장이어야 한다.
  const rows = judgmentsOf(db, 1);
  ok('B8-rejected-means-not-stored', rows.length === 1,
    `망가뜨린 채로 세 번 시도했지만 남은 판정은 ${rows.length}줄(되돌린 뒤의 그 한 줄)`);

  const sha = createHash('sha256').update(fs.readFileSync(evidence[1].abs)).digest('hex');
  const dbSha = db.prepare('SELECT sha256 FROM artifacts WHERE artifact_id = ?').get(good).sha256;
  ok('B9-ledger-untouched', sha === dbSha, '장부의 지문은 시험 내내 그대로였다 — 우리가 고친 것은 파일뿐이다');

  db.close();
}

// ══ C. 상충 판정은 둘 다 남는다 ═══════════════════════════════
{
  const { root, db, evidence } = await freshWorkspace();
  const e1 = [evidence[1].artifact_id];

  recordJudgments(db, root, { workerId: 'w1', nowMs: NOW + 10, judgments: [judge(1, { label: '후보', confidence: 0.9, evidence_artifact_ids: e1, note: '가격표 있음' })] });
  recordJudgments(db, root, { workerId: 'w2', nowMs: NOW + 20, judgments: [judge(1, { label: '제외', confidence: 0.3, evidence_artifact_ids: e1, note: '재고가 없다' })] });
  recordJudgments(db, root, { workerId: 'w1', nowMs: NOW + 30, judgments: [judge(1, { label: '후보', confidence: 0.95, evidence_artifact_ids: e1, note: '다시 봐도 후보' })] });
  recordJudgments(db, root, { workerId: 'w3', nowMs: NOW + 40, judgments: [judge(2, { label: null, confidence: null, note: '못 정했다' })] });

  const rows = judgmentsOf(db, 1);
  const conflicts = conflictingItems(db);
  ok('C1-both-sides-kept', rows.length === 3
    && rows.map((r) => `${r.worker_id}:${r.label}`).join(' ') === 'w1:후보 w2:제외 w1:후보'
    && rows.every((r) => r.note.length > 0),
    `item 1 에 판정 ${rows.length}줄 — ${rows.map((r) => `${r.worker_id}=${r.label}(${r.confidence})`).join(' · ')}`);

  ok('C2-conflict-visible', conflicts.length === 1 && conflicts[0].item_id === 1 && conflicts[0].labels === 2 && conflicts[0].judgments === 3,
    `갈린 item ${conflicts.length}개 — item ${conflicts[0].item_id} 에 서로 다른 label ${conflicts[0].labels}가지 · 판정 ${conflicts[0].judgments}줄`);

  ok('C3-same-worker-appends', rows.filter((r) => r.worker_id === 'w1').length === 2,
    '같은 워커가 두 번 내면 덮이지 않고 두 줄이 된다');

  ok('C4-abstain-is-not-a-side', conflictingItems(db).every((c) => c.item_id !== 2),
    '라벨 없는 반납은 반대 의견으로 세지 않는다 — 의견 없음이다');

  const counts = judgmentCounts(db);
  ok('C5-counts', counts.total === 4 && counts.labeled === 3 && counts.abstained === 1
    && counts.items_judged === 2 && counts.conflicts === 1,
    `전체 ${counts.total} · 라벨 있음 ${counts.labeled} · 반납 ${counts.abstained} · 판정된 item ${counts.items_judged} · 갈림 ${counts.conflicts}`);

  db.close();
}

// ══ D. label 을 해석하지 않는다 ═══════════════════════════════
{
  const { root, db, evidence } = await freshWorkspace();
  const before = stateSnapshot(db);

  const r = recordJudgments(db, root, {
    workerId: 'w1', nowMs: NOW + 300,
    judgments: [
      judge(1, { label: 'done', evidence_artifact_ids: [evidence[1].artifact_id], note: '상태 이름을 라벨로 썼다' }),
      judge(2, { label: 'failed', evidence_artifact_ids: [evidence[2].artifact_id], note: '이것도' }),
    ],
  });
  const after = stateSnapshot(db);
  const states = db.prepare('SELECT item_id, work_state FROM items ORDER BY item_id').all();

  ok('D1-label-not-interpreted', r.stored === 2 && before === after && states.every((s) => s.work_state === 'queued'),
    `label 'done'·'failed' 를 저장했지만 work_state 는 ${states.map((s) => s.work_state).join('·')} 그대로`);

  ok('D2-no-new-work', db.prepare('SELECT COUNT(*) AS n FROM items').get().n === 2
    && db.prepare('SELECT COUNT(*) AS n FROM attempts').get().n === 2,
    '판정이 URL 이나 실행을 새로 만들지 않는다 — item 2개 · 실행 2개 그대로');

  // 부분 실패: 좋은 둘 · 나쁜 하나 → 좋은 둘만 들어가고 셈이 맞는다
  const mixed = recordJudgments(db, root, {
    workerId: 'w2', nowMs: NOW + 310,
    judgments: [judge(1, { note: 'a' }), judge(9999), judge(2, { note: 'b' })],
  });
  const stored = db.prepare("SELECT COUNT(*) AS n FROM judgments WHERE worker_id = 'w2'").get().n;
  ok('D3-partial-batch', mixed.stored === 2 && mixed.rejected === 1 && stored === 2
    && JSON.stringify(mixed.reject_reasons) === JSON.stringify([{ reason: 'item_not_here', count: 1 }]),
    `저장 ${mixed.stored} · 거절 ${mixed.rejected}(${mixed.reject_reasons[0].reason}) · DB 에 실제로 ${stored}줄`);

  let threw = null;
  try { recordJudgments(db, root, { workerId: '  ', judgments: [] }); } catch (e) { threw = e; }
  ok('D4-worker-required', threw instanceof JudgmentError && threw.code === 'worker_id', `code=${threw?.code}`);

  db.close();
}

// ══ E. 계층을 우회해도 DB 가 막는다 ═══════════════════════════
{
  const { root, db } = await freshWorkspace();
  db.close();

  // 우리 계층을 건너뛰고 SQL 로 직접 밀어 넣어 본다. 마지막 문이 있는지 보려는 것이다.
  const raw = applyPragmas(new DatabaseSync(path.join(root, 'workspace.db')));
  const push = (cols) => {
    try {
      raw.prepare(`INSERT INTO judgments (item_id, worker_id, label, confidence, evidence_artifact_ids, note, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?)`).run(...cols);
      return 'INSERT 됨';
    } catch (e) { return String(e.message).includes('CHECK') ? 'CHECK 가 막음' : `다른 오류: ${e.message.slice(0, 40)}`; }
  };
  const cases = {
    'label 이 빈 문자열': push([1, 'w', '   ', null, '[]', 'x', NOW]),
    'worker_id 가 빈 문자열': push([1, '  ', '후보', null, '[]', 'x', NOW]),
    'confidence 가 1 밖': push([1, 'w', '후보', 1.5, '[]', 'x', NOW]),
    '라벨 없이 확신도만': push([1, 'w', null, 0.5, '[]', 'x', NOW]),
    '사유 없는 반납': push([1, 'w', null, null, '[]', '  ', NOW]),
    '근거가 JSON 배열이 아님': push([1, 'w', '후보', null, 'A-1', 'x', NOW]),
  };
  const blockedAll = Object.values(cases).every((v) => v === 'CHECK 가 막음');
  const left = raw.prepare('SELECT COUNT(*) AS n FROM judgments').get().n;
  raw.close();
  ok('E1-db-is-the-last-door', blockedAll && left === 0,
    `${Object.entries(cases).map(([k, v]) => `${k} → ${v}`).join(' · ')} · 남은 줄 ${left}`);

  ok('E2-schema-version', SCHEMA_VERSION === 2, `schema_version=${SCHEMA_VERSION} (제약을 걸었으므로 옛 DB 는 안 연다)`);
}

// ══ F. 네트워크 ═══════════════════════════════════════════════
ok('F1-no-network', networkAttempts === 0, `네트워크 시도 ${networkAttempts}회`);

// ── 판정 ──────────────────────────────────────────────────────
const failed = results.filter((r) => !r.pass);
if (AS_JSON) {
  process.stdout.write(`${JSON.stringify({ pass: failed.length === 0, total: results.length, failed: failed.length, results }, null, 2)}\n`);
} else {
  for (const r of results) process.stdout.write(`${r.pass ? 'PASS' : 'FAIL'}  ${r.id}\n        ${r.detail}\n`);
  process.stdout.write(`\n${failed.length === 0 ? 'PASS' : 'FAIL'} — ${results.length - failed.length}/${results.length}\n`);
}
process.exit(failed.length === 0 ? 0 : 1);
