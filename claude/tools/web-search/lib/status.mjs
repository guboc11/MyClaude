// status — 기계 상태를 짧고 거짓 없이.
//
// 계획서 4-8. 대기와 임대가 0이어도 "조사 완료" 라고 말하지 않는다. workspace_drained 만 말한다.
// 그 둘은 다른 말이다 — 넣은 일이 없을 뿐, 못 본 것은 여전히 못 봤다.

import { OUTPUT_TO_KIND } from './artifacts.mjs';
import { ERROR_CODES, WARNINGS, describeError } from './errors.mjs';
import { stateCounts } from './items.mjs';
import { leaseHealth } from './lease.mjs';

export class StatusError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StatusError';
    this.code = code;
  }
}

const TOP_ERRORS = 5;
const TOP_WARNINGS = 5;
const URL_CUT = 100;

const short = (u) => (u === null || u === undefined ? null : String(u).slice(0, URL_CUT));

/** 사람이 읽는 줄에만 쓴다. 반환 객체에는 바이트 수 그대로 넣는다. */
const humanBytes = (n) => {
  if (n < 1024) return `${n}바이트`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
};

/**
 * 실패 한 건을 되짚는 데 필요한 것 전부(계획서 5-5). 긴 로그를 열지 않아도 여기까지는 보인다.
 * item_id·attempt_id·요청/최종 URL·만든 것·빠진 것·요약 파일·다시 돌릴 번호.
 */
function sampleFor(db, stage, code) {
  const a = db.prepare(`
    SELECT attempt_id, item_id, collector, requested_url, final_url, http_status,
           requested_outputs, error_message_short
      FROM attempts
     WHERE result = 'failed' AND COALESCE(error_stage, 'unknown') = ? AND COALESCE(error_code, 'unknown') = ?
     ORDER BY COALESCE(finished_at, started_at) DESC LIMIT 1`).get(stage, code);
  if (!a) return null;

  const kinds = new Set(db.prepare('SELECT kind FROM artifacts WHERE attempt_id = ?').all(a.attempt_id).map((r) => r.kind));
  const requested = a.requested_outputs === null ? [] : JSON.parse(a.requested_outputs);
  return {
    item_id: a.item_id,
    attempt_id: a.attempt_id,
    collector: a.collector,
    requested_url: short(a.requested_url),
    final_url: short(a.final_url),
    http_status: a.http_status,
    produced: requested.filter((o) => kinds.has(OUTPUT_TO_KIND[o])),
    missing: requested.filter((o) => !kinds.has(OUTPUT_TO_KIND[o])),
    manifest: a.item_id === null ? null : `artifacts/pages/${a.item_id}/${a.attempt_id}/manifest.json`,
    // 다시 돌릴 대상. retry 버튼에 그대로 넣으면 된다.
    retry_item_id: a.item_id,
    // 장부에는 300자까지 들어 있다. 그대로 다섯 갈래를 실으면 한글에서 4KB 를 넘길 수 있어 여기서 자른다.
    message_short: short(a.error_message_short),
  };
}

/**
 * 응답을 상한 안으로 들인다. **총계는 절대 건드리지 않고** 표본부터 덜어 낸다.
 *
 * status 는 일이 잘못됐을 때 마지막으로 붙드는 창이다. 그것이 "너무 커서 못 보낸다" 로 죽으면
 * 정작 필요한 순간에 아무것도 못 본다. 그래서 크면 오류를 내지 않고 줄인다.
 * 다만 **줄였다는 사실은 남긴다** — 조용히 덜어 내면 "표본이 원래 없었다" 로 읽힌다.
 */
function fitWithin(status, budget) {
  const size = () => Buffer.byteLength(JSON.stringify(status), 'utf8');
  if (size() <= budget) return status;

  let droppedSamples = 0;
  for (let i = status.top_errors.length - 1; i >= 0 && size() > budget; i--) {
    if (status.top_errors[i].sample === null) continue;
    status.top_errors[i].sample = null;
    droppedSamples++;
  }
  let droppedRows = 0;
  while (size() > budget && status.top_errors.length > 1) {
    status.top_errors.pop();
    droppedRows++;
  }
  status.top_errors.push({
    kind: 'note',
    stage: null,
    code: 'trimmed_for_size',
    count: droppedSamples + droppedRows,
    retryable: null,
    why: `응답 상한 ${budget}바이트에 맞추느라 표본 ${droppedSamples}건·줄 ${droppedRows}건을 덜어 냈습니다.`
      + ' 총계는 그대로입니다.',
    sample: null,
  });
  return status;
}

/**
 * 최근 오류·경고 상위 항목(계획서 4-8). 오류와 경고를 한 목록에 담되 kind 로 갈라 둔다 —
 * 계약이 정한 칸은 top_errors 하나이고, 거기에 무엇이 들었는지는 줄마다 스스로 말한다.
 */
function topProblems(db) {
  const errors = db.prepare(`
    SELECT COALESCE(error_stage, 'unknown') AS stage, COALESCE(error_code, 'unknown') AS code, COUNT(*) AS count
      FROM attempts WHERE result = 'failed'
     GROUP BY stage, code ORDER BY count DESC, code ASC LIMIT ?`).all(TOP_ERRORS);

  const out = errors.map((e) => ({
    kind: 'error',
    stage: e.stage,
    code: e.code,
    count: e.count,
    retryable: ERROR_CODES[e.code]?.retryable ?? null,
    why: describeError(e.stage, e.code),
    sample: sampleFor(db, e.stage, e.code),
  }));

  // 경고는 attempts 의 배열 칸에 들어 있다. 이름별로 펴서 센다.
  let warned = [];
  try {
    warned = db.prepare(`
      SELECT j.value AS code, COUNT(*) AS count
        FROM attempts a, json_each(a.warning_codes) j
       WHERE a.warning_codes IS NOT NULL
       GROUP BY j.value ORDER BY count DESC, code ASC LIMIT ?`).all(TOP_WARNINGS);
  } catch {
    // JSON 함수를 못 쓰는 SQLite 라면 손으로 센다. 세는 방법이 달라도 수는 같아야 한다.
    const tally = new Map();
    for (const r of db.prepare('SELECT warning_codes FROM attempts WHERE warning_codes IS NOT NULL').all()) {
      for (const w of JSON.parse(r.warning_codes)) tally.set(w, (tally.get(w) ?? 0) + 1);
    }
    warned = [...tally.entries()].map(([code, count]) => ({ code, count }))
      .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code)).slice(0, TOP_WARNINGS);
  }

  for (const w of warned) {
    out.push({
      kind: 'warning',
      stage: null,
      code: w.code,
      count: w.count,
      retryable: null,
      why: WARNINGS[w.code]?.why ?? '아직 이름표가 없는 관찰입니다',
      // 경고는 실패가 아니라서 되짚을 자리가 attempt 하나로 좁혀지지 않는다. 수와 뜻만 남긴다.
      sample: null,
    });
  }
  return out;
}

/**
 * structuredContent 에 허락된 자리. MCP 응답 상한 4,096바이트에서 한 줄 요약과 JSON-RPC 겉옷 몫을 뺀 값.
 * 넉넉히 잡는다 — 남는 것은 낭비지만 모자라면 status 자체가 안 온다.
 */
export const STATUS_BUDGET_BYTES = 3000;

/**
 * @returns 계약(#2)이 정한 열두 키. 그 밖의 것을 끼워 넣지 않는다.
 */
export function statusOf(db, { nowMs = Date.now(), budgetBytes = STATUS_BUDGET_BYTES } = {}) {
  const counts = stateCounts(db);
  // 합이 안 맞으면 어딘가 상태를 잘못 옮긴 것이다. 조용히 넘기면 뒤의 모든 집계가 거짓이 된다.
  const sum = counts.queued + counts.leased + counts.done + counts.failed;
  if (sum !== counts.total) {
    throw new StatusError('state_sum_mismatch',
      `상태 합계가 맞지 않습니다: total ${counts.total} ≠ queued ${counts.queued} + leased ${counts.leased} + done ${counts.done} + failed ${counts.failed}`);
  }

  const awaitingReport = db.prepare(
    "SELECT COUNT(*) AS n FROM items WHERE work_state = 'leased' AND collected_at IS NOT NULL").get().n;
  const reviewRequired = db.prepare('SELECT COUNT(*) AS n FROM items WHERE review_required = 1').get().n;
  // 만료·곧 만료·활성 임대는 한 곳에서 센다. status 와 next 가 서로 다른 셈을 쓰면 안 된다.
  const health = leaseHealth(db, { nowMs });

  const topErrors = topProblems(db);

  // 종류별 수와 **전체 용량**을 같이 낸다(계획서 4-8). 수만 보면 "다섯 장" 이 5KB 인지 500MB 인지
  // 알 수 없고, 다음 배분을 정하는 쪽은 그 차이로 판단이 갈린다.
  const byKind = db.prepare('SELECT kind, COUNT(*) AS n, SUM(byte_size) AS b FROM artifacts GROUP BY kind ORDER BY kind').all();
  const artifactCounts = {
    by_kind: Object.fromEntries(byKind.map((r) => [r.kind, r.n])),
    files: byKind.reduce((n, r) => n + r.n, 0),
    bytes: byKind.reduce((n, r) => n + (r.b ?? 0), 0),
  };

  const lastExport = db.prepare("SELECT value FROM meta WHERE key = 'last_export'").get()?.value ?? null;

  return fitWithin({
    total: counts.total,
    queued: counts.queued,
    leased: counts.leased,
    done: counts.done,
    failed: counts.failed,
    awaiting_report: awaitingReport,
    review_required: reviewRequired,
    expired_leases: health.expired,
    top_errors: topErrors,
    artifact_counts: artifactCounts,
    last_export: lastExport,
    // 넣은 일에 대기·임대가 남지 않았다는 뜻뿐이다. 조사가 끝났다는 뜻이 아니다.
    workspace_drained: counts.queued === 0 && counts.leased === 0,
  }, budgetBytes);
}

/**
 * 사람이 한 줄로 읽을 요약. 긴 목록은 넣지 않는다.
 * @param extra leaseHealth 처럼 계약 밖이지만 알려 주면 좋은 것 — 반환 객체가 아니라 글에만 넣는다.
 */
export function statusLine(s, extra = {}) {
  const head = `전체 ${s.total} · 대기 ${s.queued} · 임대 ${s.leased} · 완료 ${s.done} · 실패 ${s.failed}`;
  const tail = [];
  if (s.awaiting_report) tail.push(`보고 대기 ${s.awaiting_report}`);
  if (s.expired_leases) tail.push(`만료 임대 ${s.expired_leases}(회수 대상)`);
  if (extra.expiring_soon) tail.push(`곧 만료 ${extra.expiring_soon}`);
  if (extra.active_leases) tail.push(`활성 임대 ${extra.active_leases}건`);
  if (s.review_required) tail.push(`확인 필요 ${s.review_required}`);
  const errs = s.top_errors.filter((e) => e.kind === 'error');
  const warns = s.top_errors.filter((e) => e.kind === 'warning');
  const trimmed = s.top_errors.find((e) => e.kind === 'note' && e.code === 'trimmed_for_size');
  if (errs.length) {
    const worst = errs[0];
    tail.push(`오류 ${errs.reduce((n, e) => n + e.count, 0)}(가장 잦음 ${worst.stage}/${worst.code}`
      + `${worst.sample ? ` · item ${worst.sample.retry_item_id}` : ''})`);
  }
  if (warns.length) tail.push(`관찰 ${warns.reduce((n, e) => n + e.count, 0)}`);
  if (trimmed) tail.push(`표본 ${trimmed.count}건은 응답 상한 때문에 뺐습니다(총계는 그대로)`);
  if (s.artifact_counts.files) tail.push(`산출물 ${s.artifact_counts.files}개 ${humanBytes(s.artifact_counts.bytes)}`);
  if (s.last_export) tail.push(`최근 export ${s.last_export}`);
  if (s.workspace_drained) tail.push('대기·임대 없음(조사 완료라는 뜻은 아닙니다)');
  return tail.length ? `${head} · ${tail.join(' · ')}` : head;
}
