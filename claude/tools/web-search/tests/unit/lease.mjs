#!/usr/bin/env node
// lib/lease.mjs · lib/report.mjs · lib/retry.mjs 단위 시험.
//
//   node tests/unit/lease.mjs
//
// 시각은 전부 인자로 넣는다. 시스템 시계를 만지지 않고 경계 시각을 다루기 위해서다.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDb } from '../../lib/db.mjs';
import { addUrls } from '../../lib/items.mjs';
import {
  DEFAULT_COUNT, MAX_COUNT, LeaseError, assertLeaseCurrent, leaseHealth, nextBatch, overlappingItems, reclaimExpired,
} from '../../lib/lease.mjs';
import { ReportError, reportKeyOf, submitReport } from '../../lib/report.mjs';
import { RetryError, retryHistory, retryItems } from '../../lib/retry.mjs';

const results = [];
const ok = (id, pass, detail) => results.push({ id, pass, detail });
function throwsWith(code, fn) {
  try { fn(); return { pass: false, detail: '던지지 않았다' }; } catch (e) {
    const known = e instanceof LeaseError || e instanceof ReportError || e instanceof RetryError;
    if (!known) return { pass: false, detail: `뜻밖의 오류: ${e.message.slice(0, 80)}` };
    return { pass: e.code === code, detail: `code=${e.code}${e.code === code ? '' : ` (기대 ${code})`}` };
  }
}

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'lease-unit-'));
process.on('exit', () => { try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* 이미 없으면 그만 */ } });

const T0 = 1_700_000_000_000;
let seq = 0;
function freshWs(urlCount = 10) {
  const root = path.join(SANDBOX, `ws${++seq}`);
  fs.mkdirSync(root, { recursive: true });
  const db = createDb(root, path.join(root, 'workspace.db'), {
    workspaceId: `2026-08-12-lease-${seq}`, projectRoot: SANDBOX, briefPath: path.join(root, 'brief.md'), nowMs: T0,
  });
  if (urlCount) {
    addUrls(db, [...Array(urlCount)].map((_, i) => ({ url: `https://example.com/p/${i}`, line: i + 1 })),
      { source_kind: 'seed', source_value: 'manual', nowMs: T0 });
  }
  return { root, db };
}
// collect 는 아직 없다(#26~28). 그래서 수집 기록을 손으로 만들어 report 의 앞길을 연다.
const markCollected = (db, itemId, result = 'success', nowMs = T0) => {
  db.prepare('INSERT INTO attempts (attempt_id, item_id, operation, collector, result, started_at) VALUES (?,?,?,?,?,?)')
    .run(`att-${itemId}-${Math.random().toString(36).slice(2, 8)}`, itemId, 'collect', 'http', result, nowMs);
  db.prepare('UPDATE items SET collected_at = ? WHERE item_id = ?').run(nowMs, itemId);
};
const judgment = (itemId, note = '메모') => ({ item_id: itemId, label: null, confidence: null, evidence_artifact_ids: [], note });

// ── 임대 기본 ─────────────────────────────────────────────────

{
  const { root, db } = freshWs(10);
  const r = nextBatch(db, root, { workerId: 'w1', count: 4, nowMs: T0 });
  ok('L1-lease-basic', r.leased === 4 && /^L-[0-9a-f]{32}$/.test(r.lease_id) && r.expires_at === T0 + 3_600_000,
    `${r.leased}건 · ${r.lease_id.slice(0, 10)}… · 만료 +${(r.expires_at - T0) / 60000}분`);

  const file = path.join(root, r.work_file);
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  ok('L2-work-file', lines.length === 4 && lines.every((x) => x.item_id && x.url) && r.work_file.startsWith('artifacts/leases/'),
    `${r.work_file} · ${lines.length}줄`);

  const state = db.prepare("SELECT COUNT(*) AS n FROM items WHERE work_state='leased' AND lease_id = ?").get(r.lease_id).n;
  ok('L3-marked-leased', state === 4, `leased ${state}건`);
  ok('L4-no-overlap', overlappingItems(db).length === 0, '한 항목을 두 임대가 잡은 경우 0');
  db.close();
}

// ── 겹치지 않는다 ─────────────────────────────────────────────

{
  const { root, db } = freshWs(10);
  const a = nextBatch(db, root, { workerId: 'w1', count: 6, nowMs: T0 });
  const b = nextBatch(db, root, { workerId: 'w2', count: 6, nowMs: T0 });
  const ids = new Set([...a.items, ...b.items].map((x) => x.item_id));
  ok('L5-disjoint', a.leased === 6 && b.leased === 4 && ids.size === 10,
    `앞 ${a.leased} · 뒤 ${b.leased} · 고유 ${ids.size}`);
  const c = nextBatch(db, root, { workerId: 'w3', count: 5, nowMs: T0 });
  ok('L6-empty-queue', c.leased === 0 && c.items.length === 0 && fs.readFileSync(path.join(root, c.work_file), 'utf8') === '',
    '빌릴 것이 없으면 0건 · 빈 작업 파일');
  db.close();
}

// ── 상한과 기본값 ─────────────────────────────────────────────

{
  const { root, db } = freshWs(150);
  const d = nextBatch(db, root, { workerId: 'w1', nowMs: T0 });
  ok('L7-default-count', d.leased === DEFAULT_COUNT, `기본 ${d.leased}건`);
  const m = nextBatch(db, root, { workerId: 'w2', count: MAX_COUNT, nowMs: T0 });
  ok('L8-max-count', m.leased === MAX_COUNT, `최대 ${m.leased}건`);
  const over = throwsWith('count_max', () => nextBatch(db, root, { workerId: 'w3', count: MAX_COUNT + 1, nowMs: T0 }));
  ok('L9-over-max-rejected', over.pass, over.detail);
  const noWorker = throwsWith('worker_id', () => nextBatch(db, root, { workerId: '', nowMs: T0 }));
  ok('L10-worker-required', noWorker.pass, noWorker.detail);
  const longLease = throwsWith('lease_minutes_max', () => nextBatch(db, root, { workerId: 'w4', leaseMinutes: 24 * 60 + 1, nowMs: T0 }));
  ok('L11-lease-minutes-cap', longLease.pass, longLease.detail);
  db.close();
}

// ── 만료 경계 ─────────────────────────────────────────────────

{
  const { root, db } = freshWs(4);
  const a = nextBatch(db, root, { workerId: 'w1', count: 4, leaseMinutes: 10, nowMs: T0 });
  const exp = a.expires_at;

  ok('L12-not-expired-before', reclaimExpired(db, exp - 1) === 0, '만료 1ms 전에는 회수하지 않는다');
  ok('L13-expired-at-boundary', reclaimExpired(db, exp) === 4, '만료 시각에 회수한다');
  const back = db.prepare("SELECT COUNT(*) AS n FROM items WHERE work_state='queued' AND lease_id IS NULL").get().n;
  ok('L14-fields-cleared', back === 4, `대기로 돌아온 ${back}건 · 임대 필드도 지워졌다`);

  const b = nextBatch(db, root, { workerId: 'w2', count: 4, nowMs: exp + 1 });
  ok('L15-reassigned', b.leased === 4 && b.lease_id !== a.lease_id, `새 임대 ${b.lease_id.slice(0, 10)}…`);

  // 옛 임대로 온 요청은 아무것도 바꾸기 전에 선다
  const stale = throwsWith('stale_lease', () => assertLeaseCurrent(db, { leaseId: a.lease_id, workerId: 'w1', nowMs: exp + 2 }));
  ok('L16-stale-rejected', stale.pass, stale.detail);
  const wrongWorker = throwsWith('worker_mismatch', () => assertLeaseCurrent(db, { leaseId: b.lease_id, workerId: 'someone-else', nowMs: exp + 2 }));
  ok('L17-worker-mismatch', wrongWorker.pass, wrongWorker.detail);
  const expiredNow = throwsWith('lease_expired', () => assertLeaseCurrent(db, { leaseId: b.lease_id, workerId: 'w2', nowMs: b.expires_at + 1 }));
  ok('L18-expired-rejected', expiredNow.pass, expiredNow.detail);
  db.close();
}

// ── 일부만 만료 ───────────────────────────────────────────────

{
  const { root, db } = freshWs(6);
  const a = nextBatch(db, root, { workerId: 'w1', count: 3, leaseMinutes: 5, nowMs: T0 });
  const b = nextBatch(db, root, { workerId: 'w2', count: 3, leaseMinutes: 60, nowMs: T0 });
  const mid = a.expires_at + 1;
  const reclaimed = reclaimExpired(db, mid);
  const still = db.prepare("SELECT COUNT(*) AS n FROM items WHERE work_state='leased' AND lease_id = ?").get(b.lease_id).n;
  ok('L19-partial-expiry', reclaimed === 3 && still === 3, `회수 ${reclaimed} · 남은 임대 ${still}`);
  const h = leaseHealth(db, { nowMs: mid });
  ok('L20-health', h.expired === 0 && h.active_leases === 1, `만료 대기 ${h.expired} · 활성 임대 ${h.active_leases}`);
  db.close();
}

// ── report ────────────────────────────────────────────────────

{
  const { root, db } = freshWs(5);
  const a = nextBatch(db, root, { workerId: 'w1', count: 3, nowMs: T0 });
  const [i1, i2, i3] = a.items.map((x) => x.item_id);
  markCollected(db, i1);
  markCollected(db, i2, 'partial');
  // i3 는 수집 기록이 없다

  const r = submitReport(db, root, { leaseId: a.lease_id, workerId: 'w1', judgments: [judgment(i1), judgment(i2), judgment(i3)], nowMs: T0 + 1000 });
  ok('R1-accept-collected-only', r.accepted === 2 && r.rejected === 1 && r.reject_reasons[0].reason === 'not_collected',
    `반영 ${r.accepted} · 거절 ${r.rejected} (${r.reject_reasons.map((x) => x.reason).join(',')})`);

  const done = db.prepare("SELECT COUNT(*) AS n FROM items WHERE work_state='done'").get().n;
  const stillLeased = db.prepare("SELECT COUNT(*) AS n FROM items WHERE work_state='leased'").get().n;
  ok('R2-state-moved', done === 2 && stillLeased === 1, `done ${done} · 아직 임대 ${stillLeased}(수집 안 된 것)`);
  ok('R3-judgments-saved', db.prepare('SELECT COUNT(*) AS n FROM judgments').get().n === 2, '판정 2건 저장');

  // 같은 report 를 다시
  const again = submitReport(db, root, { leaseId: a.lease_id, workerId: 'w1', judgments: [judgment(i1), judgment(i2), judgment(i3)], nowMs: T0 + 2000 });
  ok('R4-idempotent', again.duplicate === true && again.accepted === 2
    && db.prepare('SELECT COUNT(*) AS n FROM judgments').get().n === 2
    && db.prepare('SELECT COUNT(*) AS n FROM reports').get().n === 1,
    `두 번째는 duplicate=${again.duplicate} · 판정 행 그대로 2건`);

  // 순서만 바꿔도 같은 요청으로 본다
  ok('R5-key-order-stable',
    reportKeyOf({ leaseId: 'L', workerId: 'w', judgments: [judgment(1), judgment(2)] })
    === reportKeyOf({ leaseId: 'L', workerId: 'w', judgments: [judgment(2), judgment(1)] }),
    '판정 순서가 달라도 같은 지문');

  const wrong = throwsWith('worker_mismatch', () => submitReport(db, root, { leaseId: a.lease_id, workerId: 'w9', judgments: [judgment(i3)], nowMs: T0 + 3000 }));
  ok('R6-other-worker-rejected', wrong.pass, wrong.detail);
  const noLease = throwsWith('stale_lease', () => submitReport(db, root, { leaseId: 'L-nope', workerId: 'w1', judgments: [judgment(i1)], nowMs: T0 + 3000 }));
  ok('R7-unknown-lease-rejected', noLease.pass, noLease.detail);
  // 칸이 빠진 판정은 그 줄만 거절한다(#40). 던지지 않는다 — 멀쩡한 줄까지 되돌릴 이유가 없다.
  // i1 은 이미 done 이라 임대에 없으니, 자격 검사가 앞선다는 것도 여기서 같이 확인된다.
  const b2 = nextBatch(db, root, { workerId: 'w2', count: 2, nowMs: T0 + 3000 });
  markCollected(db, b2.items[0].item_id, 'success', T0 + 3000);
  const shaped = submitReport(db, root, {
    leaseId: b2.lease_id, workerId: 'w2', nowMs: T0 + 3100,
    judgments: [{ item_id: b2.items[0].item_id, label: '후보', confidence: null, note: '칸 하나가 없다' }],
  });
  ok('R8-judgment-shape', shaped.accepted === 0 && shaped.rejected === 1
    && shaped.reject_reasons[0].reason === 'missing_field',
    `반영 ${shaped.accepted} · 거절 ${shaped.rejected}(${shaped.reject_reasons[0].reason})`);
  db.close();
}

{
  // 만료된 임대의 늦은 report 는 DB 를 한 줄도 바꾸지 않는다
  const { root, db } = freshWs(3);
  const a = nextBatch(db, root, { workerId: 'w1', count: 3, leaseMinutes: 5, nowMs: T0 });
  markCollected(db, a.items[0].item_id);
  const late = T0 + (6 * 60_000);
  reclaimExpired(db, late);
  const before = db.prepare('SELECT COUNT(*) AS n FROM judgments').get().n;
  const res = throwsWith('stale_lease', () => submitReport(db, root, { leaseId: a.lease_id, workerId: 'w1', judgments: [judgment(a.items[0].item_id)], nowMs: late }));
  const after = db.prepare('SELECT COUNT(*) AS n FROM judgments').get().n;
  ok('R9-late-report-no-write', res.pass && before === after && db.prepare('SELECT COUNT(*) AS n FROM reports').get().n === 0,
    `${res.detail} · 판정 ${before}→${after} · report 기록 0`);
  db.close();
}

// ── retry ─────────────────────────────────────────────────────

{
  const { root, db } = freshWs(5);
  const a = nextBatch(db, root, { workerId: 'w1', count: 3, nowMs: T0 });
  const [i1, i2, i3] = a.items.map((x) => x.item_id);
  markCollected(db, i1);
  submitReport(db, root, { leaseId: a.lease_id, workerId: 'w1', judgments: [judgment(i1)], nowMs: T0 + 100 });   // i1 → done
  db.prepare("UPDATE items SET work_state='failed', lease_id=NULL, leased_by=NULL, lease_expires_at=NULL WHERE item_id=?").run(i2);
  // i3 는 아직 임대 중, i4·i5 는 대기

  const attemptsBefore = db.prepare('SELECT attempt_id FROM attempts ORDER BY attempt_id').all().map((r) => r.attempt_id);
  const judgmentsBefore = db.prepare('SELECT COUNT(*) AS n FROM judgments').get().n;

  const queuedIds = db.prepare("SELECT item_id FROM items WHERE work_state='queued' ORDER BY item_id").all().map((r) => r.item_id);
  const r = retryItems(db, { itemIds: [i1, i2, i3, queuedIds[0], 999999], reason: '캡처가 흐려 다시', nowMs: T0 + 200 });
  ok('Y1-retry-counts', r.requeued === 2 && r.rejected === 3,
    `다시 대기 ${r.requeued}(done·failed) · 거절 ${r.rejected} (${r.reject_reasons.map((x) => `${x.reason}×${x.count}`).join(', ')})`);
  ok('Y2-reject-reasons', r.reject_reasons.some((x) => x.reason === 'leased_by_another_worker')
    && r.reject_reasons.some((x) => x.reason === 'not_retryable_queued')
    && r.reject_reasons.some((x) => x.reason === 'not_in_this_workspace'),
    '임대 중·이미 대기·없는 번호를 각각 다른 사유로 거절');

  const attemptsAfter = db.prepare('SELECT attempt_id FROM attempts ORDER BY attempt_id').all().map((r2) => r2.attempt_id);
  ok('Y3-evidence-kept', JSON.stringify(attemptsBefore) === JSON.stringify(attemptsAfter)
    && db.prepare('SELECT COUNT(*) AS n FROM judgments').get().n === judgmentsBefore,
    `attempts ${attemptsAfter.length}건·판정 ${judgmentsBefore}건 그대로`);

  const back = db.prepare('SELECT work_state, collected_at FROM items WHERE item_id = ?').get(i1);
  ok('Y4-requeued-clean', back.work_state === 'queued' && back.collected_at === null,
    `${back.work_state} · collected_at ${back.collected_at}`);
  const hist = retryHistory(db, i1);
  ok('Y5-history', hist.length === 1 && hist[0].from_state === 'done' && hist[0].reason === '캡처가 흐려 다시',
    `${hist[0].from_state} → queued · 사유 "${hist[0].reason}"`);

  const noReason = throwsWith('reason', () => retryItems(db, { itemIds: [i2], reason: '  ', nowMs: T0 + 300 }));
  ok('Y6-reason-required', noReason.pass, noReason.detail);
  const noIds = throwsWith('item_ids', () => retryItems(db, { itemIds: [], reason: 'x', nowMs: T0 + 300 }));
  ok('Y7-ids-required', noIds.pass, noIds.detail);

  // 다시 빌려서 다시 되돌려도 이력이 쌓인다
  const b = nextBatch(db, root, { workerId: 'w2', count: 10, nowMs: T0 + 400 });
  markCollected(db, i1, 'success', T0 + 500);
  submitReport(db, root, { leaseId: b.lease_id, workerId: 'w2', judgments: [judgment(i1)], nowMs: T0 + 600 });
  retryItems(db, { itemIds: [i1], reason: '두 번째', nowMs: T0 + 700 });
  ok('Y8-repeatable', retryHistory(db, i1).length === 2, `이력 ${retryHistory(db, i1).length}건`);
  ok('Y9-new-attempt-id', db.prepare('SELECT COUNT(*) AS n FROM attempts WHERE item_id = ?').get(i1).n === 2,
    '수집 기록이 덮이지 않고 새로 쌓인다');
  db.close();
}

// ── 출력 ──────────────────────────────────────────────────────

for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.id} — ${r.detail}`);
const failed = results.filter((r) => !r.pass);
console.log(failed.length === 0 ? `PASS  임대·보고·재시도 단위 시험 ${results.length}항목 통과` : `FAIL  ${failed.length}건`);
process.exit(failed.length === 0 ? 0 : 1);
