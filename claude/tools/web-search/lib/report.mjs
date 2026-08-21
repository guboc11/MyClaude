// report — 지금 임대의 수집 끝난 항목만 한 번 반납한다.
//
// 계획서 4-7. 다섯 가지를 지킨다.
//   (1) 지금 임대·지금 워커가 아니면 아무것도 바꾸지 않는다
//   (2) 수집 기록이 없는 항목은 done 으로 만들지 않는다 — 안 본 것을 봤다고 하지 않는다
//   (3) 판정의 근거가 이 item 의 실제 파일인지 확인한다(#39) — 없는 근거를 댄 판정은 안 받는다
//   (4) 판정 저장·done 전환·임대 해제가 **한 transaction** 이다. 중간에 죽으면 셋 다 없던 일이 된다
//   (5) 같은 report 를 두 번 보내도 한 번만 반영한다
//
// **일부가 잘못됐을 때의 계약:** 잘못된 줄만 사유와 함께 거절하고, 나머지는 반영한다.
// 한 줄 때문에 멀쩡한 아홉 줄을 되돌리지 않는다. 다만 "반영" 은 통째로 커밋되거나 통째로 취소된다 —
// 절반만 done 이 되고 판정은 안 들어간 상태는 나오지 않는다.
//
// label 을 해석해 다음 작업을 만들지 않는다. 판정은 저장할 뿐이고 방향은 에이전트가 정한다.

import { createHash } from 'node:crypto';
import { tx } from './db.mjs';
import { checkJudgment, countReasons, parseJudgmentsFile, putJudgment } from './judgments.mjs';
import { assertLeaseCurrent, LeaseError } from './lease.mjs';

export class ReportError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ReportError';
    this.code = code;
  }
}
const fail = (code, message) => { throw new ReportError(code, message); };

/** 같은 요청인지 가리는 지문. 순서만 다른 판정은 같은 요청으로 본다. */
export function reportKeyOf({ leaseId, workerId, judgments }) {
  const canon = [...judgments]
    .map((j) => JSON.stringify([j.item_id, j.label ?? null, j.confidence ?? null, j.evidence_artifact_ids ?? [], j.note ?? '']))
    .sort();
  return createHash('sha256').update(JSON.stringify([leaseId, workerId, canon])).digest('hex').slice(0, 32);
}

/**
 * @param opts { leaseId, workerId, judgments, file, nowMs }
 * @returns {{accepted, rejected, done, duplicate, reject_reasons, source}}
 */
export function submitReport(db, root, { leaseId, workerId, judgments, file, nowMs = Date.now() } = {}) {
  const hasArray = Array.isArray(judgments);
  const hasFile = typeof file === 'string' && file !== '';
  if (hasArray && hasFile) fail('both_inputs', 'judgments 와 file 중 하나만 주세요');
  if (!hasArray && !hasFile) fail('no_input', 'judgments 나 file 중 하나는 있어야 합니다');

  // 파일에서 읽은 경우, 못 읽은 줄은 여기서 이미 사유가 붙는다. 조용히 사라지지 않는다.
  const parsed = hasFile ? parseJudgmentsFile(root, file) : null;
  const list = hasFile ? parsed.judgments : judgments;
  const lineOf = (i) => (hasFile ? parsed.lines[i] : null);
  const fileRejects = hasFile ? parsed.rejects.map((r) => ({ item_id: null, reason: r.reason, line: r.line })) : [];

  // [순서] 멱등 확인이 임대 확인보다 먼저다.
  // 첫 보고가 성공하면 그 임대는 풀린다. 그 뒤 같은 요청이 다시 오면(응답을 못 받아 다시 보내는
  // 흔한 경우) 임대부터 보면 "만료된 임대" 로 거절돼 버린다. 이미 받아 둔 요청은 같은 답을 준다.
  // 처음 보는 요청이라면 아래 임대 확인에서 걸린다 — 늦은 보고는 여전히 거절된다.
  const key = reportKeyOf({ leaseId, workerId, judgments: list });
  const seen = db.prepare('SELECT accepted, rejected FROM reports WHERE report_key = ?').get(key);
  if (seen) {
    // 두 번째 호출은 아무것도 바꾸지 않고 처음의 셈을 그대로 돌려준다. 판정 줄도 늘지 않는다.
    return {
      accepted: seen.accepted, rejected: seen.rejected, done: seen.accepted,
      duplicate: true, reject_reasons: [], source: hasFile ? 'file' : 'inline',
    };
  }

  // 여기서 걸리면 DB 를 한 줄도 건드리지 않는다.
  let leasedRows;
  try {
    leasedRows = assertLeaseCurrent(db, { leaseId, workerId, nowMs });
  } catch (e) {
    if (e instanceof LeaseError) fail(e.code, e.message);
    throw e;
  }
  const leasedIds = new Set(leasedRows.map((r) => r.item_id));

  // ── 검사는 transaction 밖에서 끝낸다 ──────────────────────────
  // 근거 파일을 읽는 일이 섞여 있어서, 쓰기 잠금을 쥔 채로 하면 다른 워커를 그만큼 세운다.
  const hasCollect = db.prepare(`
    SELECT COUNT(*) AS n FROM attempts
     WHERE item_id = ? AND operation = 'collect' AND result IN ('success', 'partial')`);

  const ready = [];
  const rejects = [...fileRejects];
  list.forEach((j, i) => {
    const line = lineOf(i);
    const no = (reason, detail) => rejects.push({ item_id: j?.item_id ?? null, reason, ...(line ? { line } : {}), ...(detail ? { detail } : {}) });

    // [사유 순서] 반납할 자격 → 수집 여부 → 판정 내용. 앞의 것이 안 되면 뒤는 볼 것도 없다.
    const itemId = Number(j?.item_id);
    if (!Number.isInteger(itemId) || !leasedIds.has(itemId)) { no('not_in_this_lease'); return; }
    if (hasCollect.get(itemId).n === 0) { no('not_collected'); return; }

    const checked = checkJudgment(db, root, j);
    if (!checked.ok) { no(checked.reason, checked.detail); return; }
    ready.push(checked.row);
  });

  // ── 저장·전환·해제는 한 묶음 ─────────────────────────────────
  return tx(db, (d) => {
    const finish = d.prepare(`
      UPDATE items
         SET work_state = 'done', lease_id = NULL, leased_by = NULL, lease_expires_at = NULL, updated_at = ?
       WHERE item_id = ? AND lease_id = ?`);

    let accepted = 0;
    for (const row of ready) {
      putJudgment(d, { row, workerId, nowMs });
      const changed = Number(finish.run(nowMs, row.item_id, leaseId).changes);
      // 검사와 저장 사이에 임대가 바뀌었다면 이 줄은 못 받는다. transaction 이 통째로 되돌아간다.
      if (changed !== 1) fail('lease_changed_mid_report', `item ${row.item_id} 의 임대가 보고 중에 바뀌었습니다`);
      accepted++;
    }

    d.prepare('INSERT INTO reports (report_key, lease_id, worker_id, accepted, rejected, created_at) VALUES (?,?,?,?,?,?)')
      .run(key, leaseId, workerId, accepted, rejects.length, nowMs);

    return {
      accepted,
      rejected: rejects.length,
      done: accepted,
      duplicate: false,
      reject_reasons: countReasons(rejects),
      source: hasFile ? 'file' : 'inline',
    };
  });
}
