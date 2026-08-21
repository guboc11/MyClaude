#!/usr/bin/env node
// report 와 판정 저장의 종단 시험 — 태스크 #40.
//
//   node tests/report-judgments/verify.mjs
//   node tests/report-judgments/verify.mjs --json
//
// 완료 조건이 "transaction 실패 주입에서 상태와 judgments 가 반쪽만 반영되는 사례가 0" 이다.
// 그러니 잘 되는 길만 보면 아무 의미가 없다 — **실제로 중간에서 실패시킨다.**
// 판정을 넣는 도중 DB 트리거로 한 줄을 막고, 그때 판정·done·임대·report 넷이 모두 없던 일이
// 되는지 본다. 그 다음 트리거를 떼고 같은 보고를 다시 해서, 앞의 실패가 흔적을 안 남겼는지 본다.
//
// 네트워크는 쓰지 않는다. 마지막 항목이 그 사실을 판정한다.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { writeArtifact } from '../../lib/artifacts.mjs';
import { finishAttempt, startAttempt } from '../../lib/attempts.mjs';
import { createDb } from '../../lib/db.mjs';
import { addUrls } from '../../lib/items.mjs';
import { judgmentsOf } from '../../lib/judgments.mjs';
import { nextBatch } from '../../lib/lease.mjs';
import { ReportError, reportKeyOf, submitReport } from '../../lib/report.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AS_JSON = process.argv.includes('--json');

let networkAttempts = 0;
globalThis.fetch = (...a) => {
  networkAttempts++;
  throw new Error(`이 시험은 네트워크를 쓰지 않는다: fetch(${String(a[0]).slice(0, 60)})`);
};

const results = [];
const ok = (id, pass, detail) => results.push({ id, pass: Boolean(pass), detail: String(detail) });
function throwsWith(code, fn) {
  try { fn(); return { pass: false, detail: '던지지 않았다' }; } catch (e) {
    return { pass: e?.code === code, detail: `code=${e?.code}${e?.code === code ? '' : ` (기대 ${code})`}` };
  }
}

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'report-judgments-'));
process.on('exit', () => { try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* 이미 없으면 그만 */ } });

const T0 = 1_700_000_000_000;
let seq = 0;

/** 항목 넷 · 앞의 셋은 수집 기록과 진짜 근거 파일까지 있는 workspace. */
async function freshWorkspace({ items = 4, collected = 3 } = {}) {
  const root = path.join(SANDBOX, `ws${++seq}`);
  fs.mkdirSync(root, { recursive: true });
  const db = createDb(root, path.join(root, 'workspace.db'), {
    workspaceId: `2026-08-12-report-${seq}`, projectRoot: SANDBOX, briefPath: path.join(root, 'brief.md'), nowMs: T0,
  });
  addUrls(db, Array.from({ length: items }, (_, i) => ({ url: `https://example.com/p${i + 1}`, line: i + 1 })),
    { source_kind: 'seed', source_value: 'manual', nowMs: T0 });

  const evidence = {};
  for (let itemId = 1; itemId <= collected; itemId++) {
    const a = startAttempt(db, {
      itemId, operation: 'collect', collector: 'http',
      requestedOutputs: ['text'], requestedUrl: `https://example.com/p${itemId}`, nowMs: T0,
    });
    const art = await writeArtifact(db, {
      root, attemptId: a.attempt_id, kind: 'text', name: 'page.txt', data: `item ${itemId}\n`, nowMs: T0,
    });
    finishAttempt(db, { attemptId: a.attempt_id, result: 'success', httpStatus: 200, nowMs: T0 + 10 });
    db.prepare('UPDATE items SET collected_at = ? WHERE item_id = ?').run(T0 + 10, itemId);
    evidence[itemId] = { artifact_id: art.artifact_id, abs: path.join(root, art.path) };
  }
  return { root, db, evidence };
}

const judge = (itemId, over = {}) => ({
  item_id: itemId, label: '후보', confidence: 0.7, evidence_artifact_ids: [], note: '메모', ...over,
});
const counts = (db) => ({
  judgments: db.prepare('SELECT COUNT(*) AS n FROM judgments').get().n,
  done: db.prepare("SELECT COUNT(*) AS n FROM items WHERE work_state = 'done'").get().n,
  leased: db.prepare("SELECT COUNT(*) AS n FROM items WHERE work_state = 'leased'").get().n,
  reports: db.prepare('SELECT COUNT(*) AS n FROM reports').get().n,
});
const reasonsOf = (r) => r.reject_reasons.map((x) => `${x.reason}×${x.count}`).join(' · ');

// ══ A. 파일로 보내는 길 ═══════════════════════════════════════
{
  const { root, db, evidence } = await freshWorkspace();
  const lease = nextBatch(db, root, { workerId: 'w1', count: 3, nowMs: T0 });
  const ids = lease.items.map((x) => x.item_id);

  const file = path.join(root, 'judgments.jsonl');
  fs.writeFileSync(file, [
    JSON.stringify(judge(ids[0], { evidence_artifact_ids: [evidence[ids[0]].artifact_id], note: '가격표 있음' })),
    '',
    '{ 이건 JSON 이 아니다',
    JSON.stringify(judge(ids[1], { label: null, confidence: null, note: '못 정했다' })),
    JSON.stringify(judge(ids[2])),
  ].join('\n'));

  const r = submitReport(db, root, { leaseId: lease.lease_id, workerId: 'w1', file: 'judgments.jsonl', nowMs: T0 + 100 });
  const c = counts(db);
  ok('A1-file-input', r.accepted === 3 && r.rejected === 1 && r.source === 'file'
    && c.judgments === 3 && c.done === 3 && c.leased === 0,
    `파일에서 반영 ${r.accepted} · 거절 ${r.rejected}(${reasonsOf(r)}) · 판정 ${c.judgments}줄 · done ${c.done}`);

  const broken = r.reject_reasons.find((x) => x.reason === 'json_parse');
  ok('A2-broken-line-counted', broken !== undefined && broken.count === 1,
    '깨진 줄은 조용히 사라지지 않고 사유로 남는다 — json_parse×1');

  const both = throwsWith('both_inputs', () => submitReport(db, root, { leaseId: lease.lease_id, workerId: 'w1', judgments: [], file: 'judgments.jsonl' }));
  const none = throwsWith('no_input', () => submitReport(db, root, { leaseId: lease.lease_id, workerId: 'w1' }));
  ok('A3-input-exclusive', both.pass && none.pass, `둘 다 ${both.detail} · 없음 ${none.detail}`);

  const outside = throwsWith('input_outside_workspace', () => submitReport(db, root, { leaseId: lease.lease_id, workerId: 'w1', file: '../../etc/hosts' }));
  ok('A4-outside-workspace', outside.pass, outside.detail);

  db.close();
}

// ══ B. 같은 내용이면 어느 길로 와도 같은 보고 ═════════════════
{
  const { root, db, evidence } = await freshWorkspace();
  const lease = nextBatch(db, root, { workerId: 'w1', count: 2, nowMs: T0 });
  const ids = lease.items.map((x) => x.item_id);
  const list = ids.map((id) => judge(id, { evidence_artifact_ids: [evidence[id].artifact_id] }));

  const file = path.join(root, 'same.jsonl');
  fs.writeFileSync(file, `${list.map((j) => JSON.stringify(j)).join('\n')}\n`);

  const first = submitReport(db, root, { leaseId: lease.lease_id, workerId: 'w1', judgments: list, nowMs: T0 + 100 });
  const afterFirst = counts(db);
  const second = submitReport(db, root, { leaseId: lease.lease_id, workerId: 'w1', file: 'same.jsonl', nowMs: T0 + 200 });
  const afterSecond = counts(db);

  ok('B1-same-content-same-report', first.accepted === 2 && second.duplicate === true && second.accepted === 2
    && afterFirst.judgments === afterSecond.judgments && afterSecond.reports === 1,
    `배열로 ${first.accepted}건 반영 → 같은 내용을 파일로 다시 보내니 duplicate=${second.duplicate}`
    + ` · 판정 ${afterFirst.judgments}줄 그대로 · report ${afterSecond.reports}줄`);

  ok('B2-key-is-content', reportKeyOf({ leaseId: lease.lease_id, workerId: 'w1', judgments: list })
    === reportKeyOf({ leaseId: lease.lease_id, workerId: 'w1', judgments: [...list].reverse() }),
    '지문은 내용에서 나온다 — 순서가 달라도 같은 보고');

  db.close();
}

// ══ C. 근거 검증이 report 에서도 산다 ═════════════════════════
{
  const { root, db, evidence } = await freshWorkspace();
  const lease = nextBatch(db, root, { workerId: 'w1', count: 3, nowMs: T0 });
  const [i1, i2, i3] = lease.items.map((x) => x.item_id);

  fs.rmSync(evidence[i2].abs);   // 장부에는 있는데 파일이 사라진 근거

  const r = submitReport(db, root, {
    leaseId: lease.lease_id, workerId: 'w1', nowMs: T0 + 100,
    judgments: [
      judge(i1, { evidence_artifact_ids: [evidence[i1].artifact_id] }),
      judge(i2, { evidence_artifact_ids: [evidence[i2].artifact_id] }),
      judge(i3, { evidence_artifact_ids: [evidence[i1].artifact_id] }),   // 옆 item 의 근거
    ],
  });
  const states = Object.fromEntries(db.prepare('SELECT item_id, work_state FROM items ORDER BY item_id').all().map((x) => [x.item_id, x.work_state]));

  ok('C1-evidence-checked-in-report', r.accepted === 1 && r.rejected === 2
    && r.reject_reasons.some((x) => x.reason === 'evidence_file_missing')
    && r.reject_reasons.some((x) => x.reason === 'evidence_other_item'),
    `반영 ${r.accepted} · 거절 ${r.rejected}(${reasonsOf(r)})`);

  ok('C2-rejected-stay-leased', states[i1] === 'done' && states[i2] === 'leased' && states[i3] === 'leased',
    `근거가 성립한 것만 done — ${Object.entries(states).map(([k, v]) => `${k}:${v}`).join(' ')}`);

  ok('C3-traceback', judgmentsOf(db, i1)[0].evidence_artifact_ids[0] === evidence[i1].artifact_id,
    '반영된 판정에서 근거 artifact 로 되짚어진다');

  db.close();
}

// ══ D. 사유의 앞뒤 순서 ═══════════════════════════════════════
{
  const { root, db, evidence } = await freshWorkspace({ items: 5, collected: 3 });
  const lease = nextBatch(db, root, { workerId: 'w1', count: 2, nowMs: T0 });   // item 1·2 만 빌린다
  const leased = lease.items.map((x) => x.item_id);
  const notLeased = 4;   // 남의 것도 아니고 그냥 안 빌린 것 (수집 기록도 없다)

  const r = submitReport(db, root, {
    leaseId: lease.lease_id, workerId: 'w1', nowMs: T0 + 100,
    judgments: [
      { item_id: notLeased, label: 42, confidence: 9, evidence_artifact_ids: 'x', note: 5 },   // 전부 엉망
      judge(leased[0], { evidence_artifact_ids: [evidence[leased[0]].artifact_id] }),
    ],
  });
  ok('D1-lease-check-first', r.accepted === 1 && r.rejected === 1
    && r.reject_reasons[0].reason === 'not_in_this_lease',
    `내용이 아무리 엉망이어도 자격이 먼저다 — ${reasonsOf(r)}`);

  // 임대에는 있는데 수집이 없는 항목: 내용 검사보다 '안 봤다' 가 앞선다
  const { root: root2, db: db2 } = await freshWorkspace({ items: 3, collected: 0 });
  const lease2 = nextBatch(db2, root2, { workerId: 'w1', count: 2, nowMs: T0 });
  const r2 = submitReport(db2, root2, {
    leaseId: lease2.lease_id, workerId: 'w1', nowMs: T0 + 100,
    judgments: [{ item_id: lease2.items[0].item_id, label: '', confidence: null, evidence_artifact_ids: [], note: '' }],
  });
  ok('D2-collect-check-before-content', r2.accepted === 0 && r2.reject_reasons[0].reason === 'not_collected',
    `수집 기록이 없으면 라벨을 보기 전에 거절 — ${reasonsOf(r2)}`);

  db.close();
  db2.close();
}

// ══ E. 실패 주입 — 반쪽이 없다 ════════════════════════════════
{
  const { root, db, evidence } = await freshWorkspace();
  const lease = nextBatch(db, root, { workerId: 'w1', count: 3, nowMs: T0 });
  const ids = lease.items.map((x) => x.item_id);
  const list = ids.map((id, k) => judge(id, {
    evidence_artifact_ids: [evidence[id].artifact_id],
    // 세 줄 중 마지막 줄에서 터지게 한다. 앞의 두 줄은 이미 들어간 뒤다.
    note: k === ids.length - 1 ? 'POISON' : `정상 ${k}`,
  }));

  const before = counts(db);
  db.exec(`CREATE TRIGGER poison BEFORE INSERT ON judgments
           WHEN NEW.note = 'POISON' BEGIN SELECT RAISE(ABORT, 'poisoned'); END`);

  let blew = null;
  try { submitReport(db, root, { leaseId: lease.lease_id, workerId: 'w1', judgments: list, nowMs: T0 + 100 }); } catch (e) { blew = e; }
  const mid = counts(db);

  // 터진 것이 **우리가 심은 그 실패**인지부터 본다. 다른 이유로 던졌으면 이 항목은 아무것도 못 잰다.
  ok('E1-nothing-half-applied', blew !== null && String(blew.message).includes('poisoned')
    && mid.judgments === before.judgments && mid.done === before.done
    && mid.leased === before.leased && mid.reports === before.reports,
    `세 줄 중 셋째에서 터뜨림("${String(blew?.message).slice(0, 24)}") — 판정 ${before.judgments}→${mid.judgments}`
    + ` · done ${before.done}→${mid.done} · 임대 ${before.leased}→${mid.leased} · report ${before.reports}→${mid.reports}`);

  ok('E2-lease-survives', db.prepare('SELECT COUNT(*) AS n FROM items WHERE lease_id = ?').get(lease.lease_id).n === 3,
    '임대도 풀리지 않았다 — 워커는 그대로 다시 시도할 수 있다');

  // [헛돌지 않게] 앞의 두 줄이 애초에 못 들어가는 줄이었다면 E1 은 아무것도 증명하지 못한다.
  // 막는 장치를 **그대로 둔 채** 그 두 줄만 보내 본다. 통과하면, E1 에서도 두 줄은 들어갔다가
  // 셋째에서 통째로 되돌아간 것이다.
  const twoOnly = submitReport(db, root, { leaseId: lease.lease_id, workerId: 'w1', judgments: list.slice(0, 2), nowMs: T0 + 150 });
  const afterTwo = counts(db);
  ok('E3-the-two-rows-were-insertable', twoOnly.accepted === 2 && afterTwo.judgments === 2 && afterTwo.done === 2,
    `막는 장치를 둔 채 앞 두 줄만 보내니 반영 ${twoOnly.accepted} — E1 에서 되돌아간 것은 "들어갔던" 두 줄이다`);

  db.exec('DROP TRIGGER poison');
  const rest = submitReport(db, root, {
    leaseId: lease.lease_id, workerId: 'w1', nowMs: T0 + 200,
    judgments: [{ ...list[2], note: '이제는 들어간다' }],
  });
  const after = counts(db);
  ok('E4-retry-clean', rest.accepted === 1 && after.judgments === 3 && after.done === 3 && after.reports === 2,
    `막은 것을 치우고 셋째 줄을 보내니 반영 ${rest.accepted} · 판정 ${after.judgments}줄 · done ${after.done}`
    + ' — 앞의 실패가 흔적을 안 남겼다');

  ok('E5-counts-agree', after.judgments === after.done && after.leased === 0,
    `판정 ${after.judgments} = done ${after.done} · 남은 임대 ${after.leased} — 셋이 늘 같이 움직인다`);

  db.close();
}

// ══ F. 늦은 보고·모르는 임대 ══════════════════════════════════
{
  const { root, db, evidence } = await freshWorkspace();
  const lease = nextBatch(db, root, { workerId: 'w1', count: 2, leaseMinutes: 5, nowMs: T0 });
  const ids = lease.items.map((x) => x.item_id);
  const late = T0 + (6 * 60_000);
  const before = counts(db);
  const r = throwsWith('lease_expired', () => submitReport(db, root, {
    leaseId: lease.lease_id, workerId: 'w1', nowMs: late,
    judgments: [judge(ids[0], { evidence_artifact_ids: [evidence[ids[0]].artifact_id] })],
  }));
  const after = counts(db);
  ok('F1-late-report-writes-nothing', r.pass && JSON.stringify(before) === JSON.stringify(after),
    `${r.detail} · 판정 ${after.judgments} · report ${after.reports}`);

  const e = new ReportError('x', 'y');
  ok('F2-error-type', e instanceof ReportError && e.name === 'ReportError', e.name);
  db.close();
}

// ══ G. 네트워크 ═══════════════════════════════════════════════
ok('G1-no-network', networkAttempts === 0, `네트워크 시도 ${networkAttempts}회`);

// ── 판정 ──────────────────────────────────────────────────────
const failed = results.filter((r) => !r.pass);
if (AS_JSON) {
  process.stdout.write(`${JSON.stringify({ pass: failed.length === 0, total: results.length, failed: failed.length, results }, null, 2)}\n`);
} else {
  for (const r of results) process.stdout.write(`${r.pass ? 'PASS' : 'FAIL'}  ${r.id}\n        ${r.detail}\n`);
  process.stdout.write(`\n${failed.length === 0 ? 'PASS' : 'FAIL'} — ${results.length - failed.length}/${results.length}\n`);
}
process.exit(failed.length === 0 ? 0 : 1);
