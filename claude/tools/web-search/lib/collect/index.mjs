// collect 조정 — 임대받은 항목을 하나씩, 시킨 방식 그대로.
//
// 태스크 #28. 이 계층이 하는 일은 잇는 것이다. 임대 확인 → 예약 → 수집 → 기록 → 상태 전환.
// 새로 판단하는 것은 없다.
//
// [숨은 승격 없음] 입력한 mode 만 실행한다. http 로 시켰는데 내용이 빈약해 보인다고 브라우저로
// 갈아타지 않는다. 1차는 그 계단(http → Jina → 크롬)을 안에 숨겨 두었고, 그래서 에이전트는
// 자기가 무엇을 시켰는지도 모르게 됐다.
//
// [실패는 항목 하나에서 멈춘다] 열 개 중 셋이 실패해도 앞서 끝난 일곱의 attempt·artifact 는 그대로다.
// 실패한 항목만 임대를 놓고 failed 로 간다. 나머지는 report 를 기다리며 leased 로 남는다.
//
// [예약 뒤에 나간다] 네트워크로 나가는 모든 요청(쪽 하나, 그림 한 장)이 전역 pace 를 거친다.
// 이 파일이 그 문을 씌우는 자리다.

import fs from 'node:fs';
import path from 'node:path';
import { finishAttempt, startAttempt } from '../attempts.mjs';
import { atomicWrite, writeManifest } from '../artifacts.mjs';
import { fetchSafely } from '../http.mjs';
import { assertWarnings, classifyOutcome } from '../errors.mjs';
import { assertLeaseCurrent, LeaseError } from '../lease.mjs';
import { openPace, record as recordPace, reserve } from '../pace.mjs';
import { resolveInside } from '../paths.mjs';
import { COLLECT_MODES, COLLECT_OUTPUTS } from '../tool-schemas.mjs';
import { BROWSER_OUTPUTS, collectBrowser } from './browser.mjs';
import { collectHttp, HTTP_OUTPUTS } from './http.mjs';

export class CollectRunError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CollectRunError';
    this.code = code;
  }
}
const fail = (code, message) => { throw new CollectRunError(code, message); };

/**
 * 한 항목이 자기 차례를 기다릴 수 있는 최대 시간.
 *
 * 이 상한이 없으면 도메인이 물러남에 들어간 순간 collect 한 번이 몇 분씩 멈춰 서고, 부른 쪽은
 * 왜 안 끝나는지 알 수 없다. 여기서 끊으면 그 항목만 pace/queue_too_long 으로 실패하고
 * 에이전트가 "이 도메인은 지금 쉬는 중" 이라는 사실을 곧바로 본다. 나중에 retry 하면 된다.
 */
export const DEFAULT_MAX_WAIT_MS = 120_000;

/**
 * 방식마다 만들 수 있는 산출물.
 *   screenshot 은 브라우저에서만 나오고, images 는 아직 http 에서만 나온다(#30 이 브라우저 쪽을 맡는다).
 * 못 만드는 것을 시키면 접속 전에 거절한다 — 나갔다 와서 "이건 안 된다" 고 하면 이미 두드린 뒤다.
 */
export const OUTPUTS_BY_MODE = Object.freeze({
  http: HTTP_OUTPUTS,
  browser: BROWSER_OUTPUTS,
});

/**
 * 접속하기 **전에** 입력을 본다. 나갔다 와서 "이건 못 만든다" 고 하면 이미 남의 서버를 두드린 뒤다.
 * @returns {{mode:string, outputs:string[]}}
 */
export function checkRequest({ mode, outputs }) {
  if (!COLLECT_MODES.includes(mode)) fail('bad_mode', `mode 는 ${COLLECT_MODES.join('·')} 중 하나입니다`);
  if (!Array.isArray(outputs) || outputs.length === 0) fail('no_outputs', '만들 산출물을 하나 이상 적어야 합니다');

  const unknown = outputs.filter((o) => !COLLECT_OUTPUTS.includes(o));
  if (unknown.length) fail('bad_output', `모르는 산출물입니다: ${unknown.join('·')}`);

  const allowed = OUTPUTS_BY_MODE[mode];
  const impossible = outputs.filter((o) => !allowed.includes(o));
  if (impossible.length) {
    fail('output_not_in_mode',
      `mode=${mode} 로는 ${impossible.join('·')} 를 만들 수 없습니다 (가능: ${allowed.join('·')})`);
  }
  // 중복은 조용히 하나로 줄인다 — 같은 파일을 두 번 만들 수는 없다.
  return { mode, outputs: [...new Set(outputs)] };
}

/**
 * 나가는 문 하나. 예약을 받고, 자기 차례에 나가고, 결과를 알린다.
 * fetchSafely 를 그대로 쓰지 않고 이것을 쓰는 이유는 "예약을 빠뜨렸다" 가 생기지 않게 하려는 것이다.
 */
export function pacedFetcher(paceDb, { holder, paceOpts = {}, fetchOptions = {}, maxWaitMs = null }) {
  const hostOf = (u) => new URL(u).hostname.replace(/^\[(.+)\]$/, '$1');
  const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

  // [홉마다 예약한다] 리다이렉트 한 홉도 서버 입장에서는 요청 하나다. 요청 전체에 한 번만 걸면
  // 체인 다섯 홉이 간격 0 으로 나간다. 그래서 전송 계층이 매 홉 직전에 이 문을 두드리게 했다.
  return async (url, opts = {}) => fetchSafely(url, {
    ...fetchOptions,
    ...opts,
    beforeHop: async (hopUrl) => {
      const slot = reserve(paceDb, hostOf(hopUrl), { holder, opts: paceOpts, maxWaitMs });
      if (!slot.granted) return { reason: slot.reason, wait_ms: slot.wait_ms };
      await sleep(slot.wait_ms);
      return null;
    },
    afterHop: async (hopUrl, { ok: fine, status }) => {
      recordPace(paceDb, hostOf(hopUrl), {
        ok: fine && status < 400,
        failed: !fine,
        blocked: status === 429 || status === 403,
        opts: paceOpts,
      });
    },
  });
}

/**
 * 판정 규칙은 lib/errors.mjs 한 곳에 있다. 여기서 따로 재지 않는다 —
 * 두 곳에서 재면 status 가 세는 것과 응답이 말하는 것이 갈라진다.
 */
const classify = (r) => classifyOutcome(r);

/**
 * 임대받은 항목을 모두 수집한다.
 *
 * @param {{
 *   root:string, leaseId:string, workerId?:string, mode:string, outputs:string[],
 *   paceDb?:object, pacePath?:string, paceOpts?:object, fetchOptions?:object,
 *   imageOptions?:object, nowMs?:number, clock?:()=>number
 * }} o
 * @returns {Promise<{
 *   succeeded:number, partial:number, failed:number, warnings:object,
 *   index_path:string, awaiting_report:number, items:object[]
 * }>}
 */
export async function runCollect(db, {
  root, leaseId, workerId, mode, outputs,
  paceDb = null, pacePath = undefined, paceOpts = {}, fetchOptions = {}, imageOptions = {},
  browserOptions = {}, depsDir = null,
  maxWaitMs = DEFAULT_MAX_WAIT_MS, nowMs = Date.now(), clock = Date.now,
}) {
  const req = checkRequest({ mode, outputs });

  // (1) 임대가 지금 것인지 먼저 본다. 네트워크는 그 뒤다.
  let leased;
  try {
    leased = assertLeaseCurrent(db, { leaseId, workerId, nowMs });
  } catch (e) {
    if (e instanceof LeaseError) fail(e.code, e.message);
    throw e;
  }

  const ownPace = paceDb === null;
  const pace = paceDb ?? openPace(pacePath ? { dbPath: pacePath } : {});
  const workspaceId = db.prepare("SELECT value FROM meta WHERE key = 'workspace_id'").get()?.value ?? 'unknown';
  const fetchPage = pacedFetcher(pace, { holder: workspaceId, paceOpts, fetchOptions, maxWaitMs });
  // 브라우저는 자기 네트워크 계층으로 나가므로 fetchSafely 를 못 쓴다. 대신 요청마다 이 문을 두드린다.
  const hostOf = (u) => new URL(u).hostname.replace(/^\[(.+)\]$/, '$1');
  const sleepMs = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());
  const paceGate = async (target) => {
    const slot = reserve(pace, hostOf(target), { holder: workspaceId, opts: paceOpts, maxWaitMs });
    if (!slot.granted) return { reason: slot.reason, wait_ms: slot.wait_ms };
    await sleepMs(slot.wait_ms);
    return null;
  };

  const lines = [];
  const counts = { success: 0, partial: 0, failed: 0 };
  const warnings = {};

  try {
    for (const item of leased) {
      // (3) 항목마다 실행을 연다. 여기서 이미 무엇을 하려는지가 장부에 적힌다.
      const started = clock();
      const { attempt_id: attemptId } = startAttempt(db, {
        itemId: item.item_id, operation: 'collect', collector: req.mode,
        requestedOutputs: req.outputs, requestedUrl: item.canonical_url, nowMs: started,
      });

      let r;
      try {
        r = req.mode === 'browser'
          ? await collectBrowser(db, {
            root, attemptId, url: item.canonical_url, outputs: req.outputs,
            resolver: fetchOptions.resolver, fixtureAllow: fetchOptions.fixtureAllow ?? [],
            gate: paceGate, depsDir, imageOptions, ...browserOptions, nowMs: clock(),
          })
          : await collectHttp(db, {
            root, attemptId, url: item.canonical_url, outputs: req.outputs,
            fetchPage, fetchOptions, imageOptions, nowMs: clock(),
          });
      } catch (e) {
        // 수집기가 통째로 터져도 장부는 닫는다. 안 닫으면 "안 끝난 실행" 으로 영원히 남는다.
        r = {
          ok: false, requested_url: item.canonical_url, final_url: null, status: null,
          outputs: {}, produced: [], missing: req.outputs, warnings: [],
          error_stage: 'collector', error_code: e.code ?? 'collector_threw',
          error_message_short: String(e.message).slice(0, 200), hops: 0,
        };
      }

      // 모르는 관찰 이름이 섞이면 여기서 세워 둔다. 조용히 통과시키면 낱말이 다시 흩어진다.
      assertWarnings(r.warnings);
      const verdict = classify(r);
      counts[verdict]++;
      for (const w of r.warnings) warnings[w] = (warnings[w] ?? 0) + 1;

      finishAttempt(db, {
        attemptId,
        result: verdict === 'success' ? 'success' : (verdict === 'partial' ? 'partial' : 'failed'),
        finalUrl: r.final_url, httpStatus: r.status,
        warningCodes: r.warnings.length ? r.warnings : null,
        errorStage: r.error_stage, errorCode: r.error_code, errorMessageShort: r.error_message_short,
        nowMs: clock(),
      });
      const mf = await writeManifest(db, root, attemptId, { nowMs: clock() });

      // (4) 상태 전환. 성공·부분은 report 를 기다리며 leased 로 남는다.
      //     하나도 못 만든 실패만 임대를 놓고 failed 로 간다.
      if (verdict === 'failed') {
        db.prepare(`
          UPDATE items SET work_state = 'failed', lease_id = NULL, leased_by = NULL,
                 lease_expires_at = NULL, updated_at = ?
           WHERE item_id = ? AND lease_id = ?`).run(clock(), item.item_id, leaseId);
      } else {
        db.prepare('UPDATE items SET collected_at = ?, updated_at = ? WHERE item_id = ? AND lease_id = ?')
          .run(clock(), clock(), item.item_id, leaseId);
      }

      lines.push({
        item_id: item.item_id,
        attempt_id: attemptId,
        requested_url: item.canonical_url,
        final_url: r.final_url,
        http_status: r.status,
        result: verdict,
        elapsed_ms: r.elapsed_ms ?? null,
        waited_ms: r.waited_ms ?? 0,
        produced: r.produced,
        missing: r.missing,
        warnings: r.warnings,
        error: r.error_code ? { stage: r.error_stage, code: r.error_code, message_short: r.error_message_short } : null,
        manifest: mf.path,
        outputs: Object.fromEntries(Object.entries(r.outputs).map(([k, v]) => [k, v.path])),
      });
    }
  } finally {
    if (ownPace) pace.close();
  }

  // (5) 이번 부름의 색인. 응답에는 이 경로만 싣고 내용은 파일에 둔다.
  const dir = resolveInside(root, 'artifacts', 'collect');
  fs.mkdirSync(dir, { recursive: true });
  const name = `${leaseId}-${String(nowMs)}.jsonl`;
  const written = await atomicWrite(dir, name, lines.map((l) => JSON.stringify(l)).join('\n') + (lines.length ? '\n' : ''));

  const awaiting = db.prepare(
    "SELECT COUNT(*) AS n FROM items WHERE lease_id = ? AND work_state = 'leased'").get(leaseId).n;

  return {
    succeeded: counts.success,
    partial: counts.partial,
    failed: counts.failed,
    warnings,
    index_path: path.relative(root, written.abs).split(path.sep).join('/'),
    awaiting_report: awaiting,
    items: lines,
  };
}
