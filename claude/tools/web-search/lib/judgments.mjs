// judgments — 에이전트의 판정을 수집 상태와 따로 쌓는다.
//
// 계획서 3-4·4-7. 이 계층이 지키는 것은 넷이다.
//   (1) 판정은 **덮이지 않는다.** 워커가 다른 판정을 내면 새 줄이 하나 더 생긴다.
//   (2) 근거는 **있는 척할 수 없다.** 지목한 artifact 가 이 workspace 의 이 item 것이어야 하고,
//       파일이 실제로 그 자리에 그 크기·그 지문으로 있어야 한다.
//   (3) label 을 **해석하지 않는다.** 'done' 이라고 적어도 item 상태는 안 변하고 URL 도 안 는다.
//       무엇을 할지는 에이전트가 정한다 — 여기서는 적을 뿐이다.
//   (4) "판정 없음" 도 **한 모양의 명시적 반납**이다. label 은 NULL 이고 왜인지는 note 에 남는다.
//
// 잘못된 판정 한 줄이 나머지를 끌고 죽지 않는다. 그 줄만 사유와 함께 거절하고 나머지는 저장한다.
// 저장은 한 transaction 이라 "절반만 들어간 보고" 는 나오지 않는다.

import fs from 'node:fs';
import { checkArtifactFile } from './artifacts.mjs';
import { tx } from './db.mjs';
import { MAX_FILE_BYTES, MAX_LINES } from './import.mjs';
import { resolveInputFile } from './paths.mjs';

export class JudgmentError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'JudgmentError';
    this.code = code;
  }
}
const fail = (code, message) => { throw new JudgmentError(code, message); };

/** 판정 한 줄에 반드시 있어야 하는 칸. 없는 칸을 기본값으로 채워 주지 않는다 —
 *  안 적은 것과 비워 둔 것은 다르고, 그 차이를 우리가 대신 정하면 안 된다. */
export const JUDGMENT_FIELDS = Object.freeze(['item_id', 'label', 'confidence', 'evidence_artifact_ids', 'note']);

const blank = (s) => typeof s !== 'string' || s.trim() === '';

/**
 * 판정 한 줄을 검사한다. DB 를 한 줄도 바꾸지 않는다.
 *
 * @returns {{ok:true, row:object} | {ok:false, item_id, reason:string, detail?:object}}
 */
export function checkJudgment(db, root, j) {
  const itemId = Number(j?.item_id);
  const at = (reason, detail) => ({ ok: false, item_id: j?.item_id ?? null, reason, ...(detail ? { detail } : {}) });

  for (const f of JUDGMENT_FIELDS) {
    if (!j || !Object.prototype.hasOwnProperty.call(j, f)) return at('missing_field', { field: f });
  }
  if (!Number.isInteger(itemId)) return at('item_id_type');
  if (!db.prepare('SELECT 1 AS ok FROM items WHERE item_id = ?').get(itemId)) return at('item_not_here');

  // label — NULL 이거나 빈칸 아닌 글자. 그 사이는 없다.
  if (j.label !== null && j.label !== undefined && typeof j.label !== 'string') return at('label_type');
  const label = j.label === undefined ? null : j.label;
  if (label !== null && label.trim() === '') return at('label_blank');

  // confidence — 판정이 있을 때만, 0 과 1 사이.
  let confidence = j.confidence === undefined ? null : j.confidence;
  if (confidence !== null) {
    if (typeof confidence !== 'number' || !Number.isFinite(confidence)) return at('confidence_type');
    if (confidence < 0 || confidence > 1) return at('confidence_range', { confidence });
    if (label === null) return at('confidence_without_label');
    confidence = Number(confidence);
  }

  if (j.note !== null && j.note !== undefined && typeof j.note !== 'string') return at('note_type');
  const note = j.note === null || j.note === undefined ? '' : j.note;
  // 라벨 없이 반납할 수는 있다. 다만 왜인지는 적어야 "보고 나서 못 정했다" 가 된다.
  if (label === null && blank(note)) return at('abstain_needs_note');

  const ids = j.evidence_artifact_ids;
  if (!Array.isArray(ids)) return at('evidence_type');
  const evidence = [];
  for (const raw of ids) {
    const one = checkArtifactFile(db, root, raw);
    if (!one.ok) return at(one.reason, { artifact_id: raw, ...(one.detail ?? {}) });
    // 이 item 의 근거여야 한다. 옆 item 의 화면을 근거로 대면 그건 다른 것을 본 것이다.
    if (one.row.item_id !== itemId) {
      return at('evidence_other_item', { artifact_id: one.row.artifact_id, belongs_to: one.row.item_id });
    }
    evidence.push(one.row.artifact_id);
  }

  return { ok: true, row: { item_id: itemId, label, confidence, evidence_artifact_ids: evidence, note } };
}

/**
 * 검사를 통과한 판정 한 줄을 **부른 쪽의 transaction 안에서** 넣는다.
 *
 * report 는 판정 저장·done 전환·임대 해제를 한 transaction 으로 묶어야 해서(#40),
 * 저장이 스스로 transaction 을 열면 안 된다. 그래서 여는 자리와 넣는 자리를 갈라 둔다.
 *
 * @param d   지금 transaction 이 걸린 연결
 * @param row checkJudgment 가 통과시킨 row
 */
export function putJudgment(d, { row, workerId, nowMs }) {
  return Number(d.prepare(`
    INSERT INTO judgments (item_id, worker_id, label, confidence, evidence_artifact_ids, note, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
    row.item_id, workerId, row.label, row.confidence,
    JSON.stringify(row.evidence_artifact_ids), row.note, nowMs,
  ).lastInsertRowid);
}

/**
 * 검사를 통과한 판정만 저장한다. item 의 work_state 는 손대지 않는다 — 그 전환은 report 의 몫이다.
 *
 * @param opts { workerId, judgments, nowMs }
 * @returns {{stored:number, rejected:number, judgment_ids:number[], rejects:object[], reject_reasons:{reason,count}[]}}
 */
export function recordJudgments(db, root, { workerId, judgments, nowMs = Date.now() } = {}) {
  if (blank(workerId)) fail('worker_id', 'worker_id 가 비었습니다');
  if (!Array.isArray(judgments)) fail('judgments', 'judgments 는 배열이어야 합니다');

  const checked = judgments.map((j) => checkJudgment(db, root, j));
  const good = checked.filter((c) => c.ok);
  const rejects = checked.filter((c) => !c.ok).map(({ item_id: itemId, reason, detail }) => ({ item_id: itemId, reason, ...(detail ? { detail } : {}) }));

  const ids = tx(db, (d) => good.map((c) => putJudgment(d, { row: c.row, workerId, nowMs })));

  return { stored: ids.length, rejected: rejects.length, judgment_ids: ids, rejects, reject_reasons: countReasons(rejects) };
}

/** 거절 사유를 종류별로 센다. 응답에는 원문 대신 이 셈만 싣는다. */
export function countReasons(rejects) {
  const byReason = new Map();
  for (const r of rejects) byReason.set(r.reason, (byReason.get(r.reason) ?? 0) + 1);
  return [...byReason.entries()].map(([reason, count]) => ({ reason, count }));
}

/**
 * workspace 안의 JSONL 에서 판정을 읽는다. 한 줄이 판정 하나다.
 *
 * 긴 판정 묶음을 MCP 응답으로 주고받지 않으려는 자리라, 읽기 규칙은 add_urls 의 파일 입력과 같다 —
 * workspace 밖은 안 읽고, 크기·줄 수 상한이 있고, **깨진 줄은 버리지 않고 줄 번호와 사유로 센다.**
 *
 * 줄 번호는 판정 객체에 끼워 넣지 않고 나란한 배열로 돌려준다 — 우리가 만든 칸이 에이전트가 보낸
 * 자료에 섞이면, 나중에 그 칸이 어디서 왔는지 아무도 모르게 된다.
 *
 * @returns {{received:number, judgments:object[], lines:number[], rejects:{line:number, reason:string}[], source:object}}
 */
export function parseJudgmentsFile(root, file) {
  if (typeof file !== 'string' || file.trim() === '') fail('no_input', 'file 이 비었습니다');
  const abs = resolveInputFile(root, file);
  const bytes = fs.statSync(abs).size;
  if (bytes > MAX_FILE_BYTES) fail('file_too_large', `판정 파일이 ${bytes}바이트로 상한 ${MAX_FILE_BYTES} 을 넘습니다`);

  const lines = fs.readFileSync(abs, 'utf8').split('\n');
  if (lines.length > MAX_LINES) fail('too_many_lines', `줄 수가 ${lines.length}로 상한 ${MAX_LINES} 을 넘습니다`);

  const judgments = [];
  const at = [];
  const rejects = [];
  let received = 0;
  lines.forEach((line, i) => {
    const t = line.trim();
    if (!t) return;
    received++;
    let v;
    try { v = JSON.parse(t); } catch (e) { rejects.push({ line: i + 1, reason: 'json_parse', detail: { message: e.message.slice(0, 60) } }); return; }
    if (!v || typeof v !== 'object' || Array.isArray(v)) { rejects.push({ line: i + 1, reason: 'not_an_object' }); return; }
    judgments.push(v);
    at.push(i + 1);
  });
  return { received, judgments, lines: at, rejects, source: { kind: 'jsonl', path: abs, bytes } };
}

/** 이 item 에 쌓인 판정 전부. 최신이 아니라 **전부**를 준다. */
export function judgmentsOf(db, itemId) {
  return db.prepare(`
    SELECT judgment_id, item_id, worker_id, label, confidence, evidence_artifact_ids, note, created_at
      FROM judgments WHERE item_id = ? ORDER BY judgment_id`).all(Number(itemId))
    .map((r) => ({
      ...r,
      evidence_artifact_ids: JSON.parse(r.evidence_artifact_ids),
      // 라벨 없는 줄은 "아직 아무도 안 봤다" 가 아니라 "보고 나서 안 붙였다" 다.
      abstained: r.label === null,
    }));
}

/**
 * 같은 item 에 서로 다른 label 이 붙은 곳. 어느 쪽이 맞는지 고르지 않는다 — 갈렸다는 사실만 센다.
 * 라벨 없는 반납은 다른 의견으로 세지 않는다. 반대 의견이 아니라 의견 없음이다.
 */
export function conflictingItems(db) {
  return db.prepare(`
    SELECT item_id, COUNT(DISTINCT label) AS labels, COUNT(*) AS judgments
      FROM judgments WHERE label IS NOT NULL
     GROUP BY item_id HAVING COUNT(DISTINCT label) > 1
     ORDER BY item_id`).all();
}

/** workspace 전체 셈. status 가 쓴다. */
export function judgmentCounts(db) {
  const total = db.prepare('SELECT COUNT(*) AS n FROM judgments').get().n;
  const abstained = db.prepare('SELECT COUNT(*) AS n FROM judgments WHERE label IS NULL').get().n;
  const items = db.prepare('SELECT COUNT(DISTINCT item_id) AS n FROM judgments').get().n;
  return { total, labeled: total - abstained, abstained, items_judged: items, conflicts: conflictingItems(db).length };
}
