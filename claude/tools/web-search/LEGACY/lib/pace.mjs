// web-search — 전역 속도 장부
// 계획서 2-9, 2-7. 사용자 요구: "조심조심, 시간이 오래 걸려도 상관없으니".
//
// [핵심] "마지막 접속 시각을 확인"만 하면 두 프로세스가 같은 틈을 보고 동시에 나간다.
// 도메인 잠금을 잡은 채 다음 허용 시각을 먼저 "예약"하고 잠금을 푼 뒤 접속한다.
//
// 이 장부는 크롤 바깥에 하나다 — 크롤이 여럿이어도 한 사이트를 동시에 두드리면 안 된다.

import fs from 'node:fs';
import path from 'node:path';
import { paceFile, paceLockDir, globalDir, writeAtomic, readJson } from './paths.mjs';
import { withLock } from './lock.mjs';

const DEFAULTS = {
  min_interval_ms: 10_000,
  jitter_ms: 5_000,
  daily_cap: 300,
  block_sleep_ms: 3 * 60 * 60 * 1000,   // 차단 낌새면 세 시간 재운다
  block_threshold: 3,
  retry_backoff_ms: 60_000,             // 실패 첫 걸음. 이후 두 배씩 물러난다.
  retry_backoff_max_ms: 30 * 60_000,
};

function nowMs() { return Date.now(); }
function today() { return new Date(nowMs()).toISOString().slice(0, 10); }
function staleDir() { return path.join(globalDir(), 'locks', 'stale'); }

function emptyRec(domain) {
  return {
    domain,
    last_access_at: 0,
    next_allowed_at: 0,
    today_date: today(),
    today_count: 0,
    block_score: 0,
    consecutive_failures: 0,
    sleep_until: 0,
    user_agent: pickUserAgent(),   // 한 도메인에는 같은 것을 유지 — 매번 바꾸면 오히려 수상하다
    permits: {},                   // key -> { issued_at, expires_at }  아래 설명 참고
  };
}

// [permit] 예약과 실제 요청 사이가 벌어질 수 있다.
// Jina 단은 원 도메인과 r.jina.ai 를 둘 다 예약해야 하는데, 앞이 되고 뒤가 막히면
// 요청은 0회인데 앞 도메인 카운트만 늘어난다(2026-08-11 매니저 재현).
// 그래서 예약에 이름표를 달아 파일에 남기고, 같은 이름표로 다시 오면 카운트를 늘리지 않고
// 그 예약을 그대로 쓴다. 파일에 남으므로 프로세스가 달라도, 워커가 여럿이어도 성립한다.
//
// [소비 시점 계약] 이름표는 "요청을 보낸 뒤"가 아니라 "필요한 예약을 모두 얻고 네트워크로 나가기
// 직전"에 지운다. 보낸 뒤에 지우면 그 사이 죽었을 때 이름표가 남아 다음 호출이 요청을 되풀이하면서
// 카운트는 안 느는 상태가 된다 — 요청은 나가는데 장부에 안 잡히는 쪽(fail-open)이라 위험하다.
// 먼저 지우면 죽어도 실제보다 많이 세는 쪽으로만 틀린다. 속도보다 안전이 먼저다.
//
// [만료 계약] 기본 26시간. 하루 경계(daily_cap 초기화)를 넉넉히 넘긴다.
//
// 짧게 두면 안 되는 이유: Jina 가 몇 시간 자거나 하루 한도에 걸린 동안, 그 단을 기다리는
// URL 마다 이름표가 만료되고 원 도메인 예약을 다시 태운다. 요청은 한 번도 안 나갔는데
// 원 도메인 today_count 만 올라 결국 그 도메인이 daily_cap 으로 멈춘다 — 전수 수집이 목표인
// 크롤러에서 이건 곧 누락이다. 그래서 대기보다 이름표가 오래 살아야 한다.
// 26시간이 지나면 한 번 과대계상되는데, 그건 무계상보다 안전한 쪽이라 받아들인다.
// 짧은 만료는 시험에서 permit_ttl_ms 로만 지정한다.
const PERMIT_TTL_MS = 26 * 60 * 60_000;

function prunePermits(rec) {
  const t = nowMs();
  for (const [k, v] of Object.entries(rec.permits || {})) {
    if (!v || v.expires_at < t) delete rec.permits[k];
  }
  return rec;
}

function pickUserAgent() {
  return 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
}

function load(domain) {
  const rec = readJson(paceFile(domain), null) || emptyRec(domain);
  if (rec.today_date !== today()) { rec.today_date = today(); rec.today_count = 0; }
  return rec;
}

/**
 * 접속 권한을 예약한다. 잠금 안에서 next_allowed_at 을 먼저 밀어 두므로
 * 다음 호출자는 그 시각을 보고 기다린다.
 * @returns {{ok:true, user_agent}} 또는 {{ok:false, wait_seconds, why}}
 */
// 넘어온 값 중 undefined 는 "지정 안 함"이지 "undefined 로 덮으라"가 아니다.
// (MCP 도구가 선택 인자를 그대로 넘기면 {min_interval_ms: undefined} 가 되어 기본값을 지운다.
//  그러면 gap 이 NaN 이 되고 next_allowed_at 이 JSON 에서 null 이 되어 간격이 아예 안 걸린다.
//  2026-08-11 매니저 감사에서 발견.)
function withDefaults(opts) {
  const out = { ...DEFAULTS };
  for (const [k, v] of Object.entries(opts || {})) if (v !== undefined) out[k] = v;
  return out;
}

export function reserve(domain, opts = {}, permitKey = null) {
  const cfg = withDefaults(opts);
  fs.mkdirSync(path.dirname(paceFile(domain)), { recursive: true });
  return withLock(paceLockDir(domain), staleDir(), () => {
    const rec = prunePermits(load(domain));
    const t = nowMs();

    // [순서] 차단 휴면은 이름표보다 먼저 본다. Jina 를 기다리는 사이 이 도메인에 차단 낌새가
    // 생겼다면 보류 중이던 이름표로 그걸 뚫고 나가면 안 된다.
    // 이름표는 지우지 않고 남겨 둔다 — 휴면이 끝나면 그대로 다시 쓴다.
    if (rec.sleep_until > t) {
      writeAtomic(paceFile(domain), JSON.stringify(rec, null, 2));
      return { ok: false, wait_seconds: Math.ceil((rec.sleep_until - t) / 1000), why: 'domain_sleeping' };
    }

    // 이미 받아 둔 예약이 있으면 그대로 쓴다 — 카운트도 간격도 다시 건드리지 않는다.
    // (하루 한도는 이미 차감된 예약이므로 여기서 다시 볼 필요가 없다.)
    if (permitKey && rec.permits?.[permitKey]) {
      writeAtomic(paceFile(domain), JSON.stringify(rec, null, 2));
      return { ok: true, user_agent: rec.user_agent, reused_permit: true, permit_key: permitKey, today_count: rec.today_count };
    }
    if (rec.today_count >= cfg.daily_cap) {
      const tomorrow = new Date(new Date().toISOString().slice(0, 10)).getTime() + 24 * 3600 * 1000;
      return { ok: false, wait_seconds: Math.ceil((tomorrow - t) / 1000), why: 'daily_cap' };
    }
    if (rec.next_allowed_at > t) {
      return { ok: false, wait_seconds: Math.ceil((rec.next_allowed_at - t) / 1000), why: 'interval' };
    }

    // 간격은 일정하게 두지 않는다 — 규칙적이면 오히려 티가 난다
    const gap = cfg.min_interval_ms + Math.floor(Math.random() * cfg.jitter_ms);
    rec.last_access_at = t;
    rec.next_allowed_at = t + gap;
    rec.today_count += 1;
    if (permitKey) {
      rec.permits = rec.permits || {};
      rec.permits[permitKey] = { issued_at: t, expires_at: t + (cfg.permit_ttl_ms ?? PERMIT_TTL_MS) };
    }
    writeAtomic(paceFile(domain), JSON.stringify(rec, null, 2));
    return { ok: true, user_agent: rec.user_agent, reserved_gap_ms: gap, today_count: rec.today_count, permit_key: permitKey };
  });
}

/**
 * 필요한 예약을 모두 얻고 **네트워크로 나가기 직전에** 부른다(보낸 뒤가 아니다).
 * 이름표를 지워 두면, 그 직후 죽어도 다음 호출이 정상 경로를 타 카운트가 는다 —
 * 요청은 나가는데 장부에 안 잡히는 상태를 만들지 않기 위해서다.
 */
export function consume(domain, permitKey) {
  if (!permitKey) return { ok: false };
  return withLock(paceLockDir(domain), staleDir(), () => {
    const rec = prunePermits(load(domain));
    const had = !!rec.permits?.[permitKey];
    if (had) delete rec.permits[permitKey];
    writeAtomic(paceFile(domain), JSON.stringify(rec, null, 2));
    return { ok: true, had };
  });
}

/** 접속 결과를 알려 준다. 차단 낌새가 쌓이면 그 도메인을 재운다. */
export function record(domain, { blocked = false, failed = false, opts = {} } = {}) {
  const cfg = withDefaults(opts);
  return withLock(paceLockDir(domain), staleDir(), () => {
    const rec = load(domain);
    if (blocked) {
      rec.block_score += 1;
      if (rec.block_score >= cfg.block_threshold) {
        rec.sleep_until = nowMs() + cfg.block_sleep_ms;
        rec.block_score = 0;
      }
    } else if (failed) {
      rec.consecutive_failures += 1;
      // 지수적으로 물러난다. 첫 걸음 폭은 정책이 정한다(retry_backoff_ms).
      const backoff = Math.min(cfg.retry_backoff_ms * 2 ** (rec.consecutive_failures - 1), cfg.retry_backoff_max_ms);
      rec.next_allowed_at = Math.max(rec.next_allowed_at, nowMs() + backoff);
      rec.last_backoff_ms = backoff;
    } else {
      rec.consecutive_failures = 0;
    }
    writeAtomic(paceFile(domain), JSON.stringify(rec, null, 2));
    return { domain, block_score: rec.block_score, sleep_until: rec.sleep_until, next_allowed_at: rec.next_allowed_at };
  });
}

export function peek(domain) {
  const rec = load(domain);
  const t = nowMs();
  return {
    ...rec,
    waiting_seconds: Math.max(0, Math.ceil((Math.max(rec.next_allowed_at, rec.sleep_until) - t) / 1000)),
  };
}
