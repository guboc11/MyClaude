// attempt — 실행 한 번의 장부.
//
// 계획서 3-4·5-3. 모든 산출물은 "어느 항목의 어느 실행에서 나왔는가" 로 되짚을 수 있어야 한다.
// 그 되짚음의 뿌리가 attempt_id 다. 경로에도 들어가고(artifacts/pages/<item>/<attempt>/) DB 에도 있다.
//
// 두 가지를 여기서 못박는다.
//   (1) 시작할 때 이미 requested_outputs·requested_url·collector 가 적힌다.
//       끝난 뒤에 적으면 도중에 죽은 실행이 "무엇을 하려던 것인지" 조차 남지 않는다.
//   (2) 끝은 한 번뿐이다. 같은 실행을 두 번 끝내 결과를 덮어쓰지 못한다.
//
// 의미 판정은 없다. result 는 기계 작업이 끝났는지만 말하고, 자료가 쓸 만한지는 judgments 가 말한다.

import { randomBytes } from 'node:crypto';
import { tx } from './db.mjs';
import { COLLECTORS, OPERATIONS, RESULTS } from './schema.mjs';

export class AttemptError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AttemptError';
    this.code = code;
  }
}
const fail = (code, message) => { throw new AttemptError(code, message); };

/** 산출물 종류. collect 가 무엇을 만들라고 요청받았는지 적는 데 쓴다. */
export const OUTPUT_KINDS = ['screenshot', 'text', 'dom', 'links', 'images'];

/**
 * 예측할 수 없는 실행 번호.
 * 경로에 그대로 들어가므로 paths.attemptDir 의 모양 규칙(A-Za-z0-9_-)을 지킨다.
 */
export const newAttemptId = () => `A-${randomBytes(16).toString('hex')}`;

const listText = (v) => (v === null || v === undefined ? null : JSON.stringify(v));

/**
 * 실행을 연다. 여기서 이미 "무엇을 하려는가" 가 전부 적힌다.
 *
 * @returns {{attempt_id: string, started_at: number}}
 */
export function startAttempt(db, {
  itemId = null, operation, collector = null,
  requestedOutputs = null, requestedUrl = null, nowMs = Date.now(),
}) {
  if (!OPERATIONS.includes(operation)) fail('bad_operation', `operation 은 ${OPERATIONS.join('·')} 중 하나입니다`);
  if (collector !== null && !COLLECTORS.includes(collector)) {
    fail('bad_collector', `collector 는 ${COLLECTORS.join('·')} 중 하나입니다`);
  }
  if (requestedOutputs !== null) {
    if (!Array.isArray(requestedOutputs)) fail('bad_outputs', 'requested_outputs 는 배열이어야 합니다');
    const unknown = requestedOutputs.filter((o) => !OUTPUT_KINDS.includes(o));
    if (unknown.length) fail('bad_outputs', `모르는 산출물: ${unknown.join('·')}`);
  }
  // collect 는 어느 항목의 일인지가 반드시 있어야 한다. search·map 은 workspace 단위다.
  if (operation === 'collect' && (itemId === null || itemId === undefined)) {
    fail('item_required', 'collect 실행에는 item_id 가 필요합니다');
  }

  const attemptId = newAttemptId();

  return tx(db, (d) => {
    if (itemId !== null && itemId !== undefined) {
      // 남의 workspace 번호로 이 장부에 파일을 매달 수 없다.
      const found = d.prepare('SELECT item_id FROM items WHERE item_id = ?').get(Number(itemId));
      if (!found) fail('not_in_this_workspace', `이 workspace 에 없는 item_id 입니다: ${itemId}`);
    }
    d.prepare(`
      INSERT INTO attempts (attempt_id, item_id, operation, collector, requested_outputs, requested_url, started_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(attemptId, itemId === null || itemId === undefined ? null : Number(itemId),
        operation, collector, listText(requestedOutputs), requestedUrl, nowMs);
    return { attempt_id: attemptId, started_at: nowMs };
  });
}

/**
 * 실행을 닫는다. 한 번만 닫힌다 — 두 번째 호출은 결과를 덮어쓰지 않고 거절한다.
 * 덮어쓰게 두면 "성공으로 끝났다" 를 나중에 조용히 바꿔 쓸 수 있게 된다.
 */
export function finishAttempt(db, {
  attemptId, result, finalUrl = null, httpStatus = null,
  warningCodes = null, errorStage = null, errorCode = null, errorMessageShort = null,
  nowMs = Date.now(),
}) {
  if (!RESULTS.includes(result)) fail('bad_result', `result 는 ${RESULTS.join('·')} 중 하나입니다`);
  if (warningCodes !== null && !Array.isArray(warningCodes)) fail('bad_warnings', 'warning_codes 는 배열이어야 합니다');
  // 실패라고 하면서 왜 실패했는지를 안 적으면 오류 한 건의 최소 설명(계획서 5-5)이 성립하지 않는다.
  if (result === 'failed' && (!errorStage || !errorCode)) {
    fail('error_detail_required', 'failed 에는 error_stage 와 error_code 가 필요합니다');
  }

  return tx(db, (d) => {
    const row = d.prepare('SELECT attempt_id, finished_at FROM attempts WHERE attempt_id = ?').get(attemptId);
    if (!row) fail('attempt_missing', `없는 attempt_id 입니다: ${attemptId}`);
    if (row.finished_at !== null) fail('attempt_already_finished', `이미 끝난 실행입니다: ${attemptId}`);

    d.prepare(`
      UPDATE attempts
         SET result = ?, final_url = ?, http_status = ?, warning_codes = ?,
             error_stage = ?, error_code = ?, error_message_short = ?, finished_at = ?
       WHERE attempt_id = ?`)
      .run(result, finalUrl, httpStatus === null ? null : Number(httpStatus), listText(warningCodes),
        errorStage, errorCode, errorMessageShort === null ? null : String(errorMessageShort).slice(0, 300),
        nowMs, attemptId);
    return { attempt_id: attemptId, result, finished_at: nowMs };
  });
}

/** 실행 한 줄을 배열 칸까지 풀어서 돌려준다. */
export function getAttempt(db, attemptId) {
  const row = db.prepare('SELECT * FROM attempts WHERE attempt_id = ?').get(attemptId);
  if (!row) return null;
  return {
    ...row,
    requested_outputs: row.requested_outputs === null ? null : JSON.parse(row.requested_outputs),
    warning_codes: row.warning_codes === null ? null : JSON.parse(row.warning_codes),
  };
}

/** 아직 안 끝난 실행. 강제 종료로 남겨진 것을 찾는 자리다. */
export function unfinishedAttempts(db) {
  return db.prepare('SELECT attempt_id, item_id, operation, started_at FROM attempts WHERE finished_at IS NULL ORDER BY started_at').all();
}
