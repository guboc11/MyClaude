// web-search — 수집 계단
// 계획서 2-2, 2-3, 2-4.
//
// 규칙 셋을 코드로 강제한다.
//  (1) lease_token 이 없거나 어긋나면 네트워크를 단 한 번도 건드리지 않는다.
//  (2) 어느 단이든 접속 전에 pace.reserve 를 반드시 부른다. 못 받으면 남은 초만 돌려준다.
//  (3) 상태 코드 200 이나 "오류 문구 없음"은 통과 근거가 아니다 — 판정은 judge 가 긍정 증거로 한다.
//
// 계단: curl+jsdom → Jina Reader → playwright 헤드리스 → 실제 크롬(headless:false, channel:chrome)
// 이 파일은 1·2단(curl, Jina)까지. 3·4단은 browser.mjs 가 맡고 여기서 불러 쓴다.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { crawlPaths, ensureCrawlDirs, writeAtomic } from './paths.mjs';
import { normalizeUrl } from './url.mjs';
import { visibleText, canonicalContent, termCounts } from './text.mjs';
import { pageObservation } from './pagination.mjs';
import * as store from './store.mjs';
import * as pace from './pace.mjs';

// 이보다 짧으면 내용 지문을 만들지 않는다. 빈 쪽끼리 "같은 내용"으로 묶이면 안 된다.
const CONTENT_HASH_MIN = 200;

const execFileP = promisify(execFile);

export const TIERS = ['curl', 'jina', 'headless', 'chrome'];

// 본문이 이 길이보다 짧으면 "내용이 없다"고 보고 다음 단으로 올린다.
const THIN_TEXT = 400;
const CURL_TIMEOUT_S = 20;
const JINA_TIMEOUT_S = 40;

function nowMs() { return Date.now(); }

function slugForFile(u) {
  const x = new URL(u);
  const s = `${x.pathname}${x.search}`.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'root';
  return s.slice(0, 60);
}

/** curl 한 번. 리다이렉트를 따라가되 최종 주소를 반드시 기록한다. */
async function tierCurl(url, userAgent) {
  const t0 = nowMs();
  const fmt = '\\n__META__%{http_code}|%{url_effective}|%{content_type}|%{size_download}';
  try {
    const { stdout } = await execFileP('curl', [
      '-sSL', '--max-time', String(CURL_TIMEOUT_S),
      '--compressed',
      '-A', userAgent,
      '-w', fmt,
      url,
    ], { maxBuffer: 20 * 1024 * 1024 });
    const idx = stdout.lastIndexOf('\n__META__');
    const body = idx >= 0 ? stdout.slice(0, idx) : stdout;
    const meta = idx >= 0 ? stdout.slice(idx + 9) : '';
    const [code, effective, ctype, size] = meta.split('|');
    return {
      tier: 'curl', ok: true, status: Number(code) || 0, final: effective || url,
      contentType: ctype || '', body, bytes: Number(size) || body.length, ms: nowMs() - t0,
    };
  } catch (e) {
    return { tier: 'curl', ok: false, status: 0, final: url, body: '', bytes: 0, ms: nowMs() - t0, error: e.message.slice(0, 200) };
  }
}

/** Jina Reader — 주소 앞에 r.jina.ai/ 를 붙이면 정리된 마크다운을 돌려준다. 봇 차단은 못 뚫는다. */
async function tierJina(url, userAgent) {
  const t0 = nowMs();
  const target = `https://r.jina.ai/${url}`;
  const args = ['-sSL', '--max-time', String(JINA_TIMEOUT_S), '-A', userAgent,
    '-w', '\\n__META__%{http_code}|%{url_effective}', target];
  if (process.env.JINA_API_KEY) args.unshift('-H', `Authorization: Bearer ${process.env.JINA_API_KEY}`);
  try {
    const { stdout } = await execFileP('curl', args, { maxBuffer: 20 * 1024 * 1024 });
    const idx = stdout.lastIndexOf('\n__META__');
    const body = idx >= 0 ? stdout.slice(0, idx) : stdout;
    const [code, effective] = (idx >= 0 ? stdout.slice(idx + 9) : '').split('|');
    // Jina 는 원본이 막히면 본문에 오류를 적어 돌려준다
    const blocked = /Failed to fetch|403 Forbidden|blocked|Cloudflare/i.test(body.slice(0, 600));
    return {
      tier: 'jina', ok: !blocked, status: Number(code) || 0, final: url,
      body, bytes: body.length, ms: nowMs() - t0, markdown: true,
      jinaTarget: effective || target, blocked,
    };
  } catch (e) {
    return { tier: 'jina', ok: false, status: 0, final: url, body: '', bytes: 0, ms: nowMs() - t0, error: e.message.slice(0, 200) };
  }
}

/**
 * 본문에서 "나가는 링크"를 뽑는다. HTML 은 a[href], 마크다운은 [글](주소)와 맨 주소.
 * 그림은 링크가 아니다 — 따라갈 곳이 아니라 보여 줄 것이다.
 * 경계 판정은 여기서 하지 않는다. 뽑기만 하고, 들일지는 store 가 정한다.
 */
export function extractOutgoingLinks(body, { markdown = false, base = null } = {}) {
  const text = String(body || '');
  const out = [];
  const push = (raw) => {
    const s = String(raw || '').trim();
    if (!s || /^(#|javascript:|mailto:|tel:|data:)/i.test(s)) return;
    try { out.push(base ? new URL(s, base).toString() : new URL(s).toString()); } catch { /* 주소가 아니면 버린다 */ }
  };

  if (markdown) {
    // ![그림](...) 은 건너뛰고 [글](주소) 만 — 앞 글자가 ! 인지로 가른다
    for (const m of text.matchAll(/(!?)\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      if (m[1] !== '!') push(m[2]);
    }
    // 마크다운 본문에는 맨 주소도 그냥 적힌다
    for (const m of text.matchAll(/(?<![(<\]])\bhttps?:\/\/[^\s<>()"']+/g)) push(m[0]);
  } else {
    for (const m of text.matchAll(/<a[^>]+href=["']([^"']+)["']/gi)) push(m[1]);
  }
  return [...new Set(out)];
}

/** 다음 단으로 올릴지, 올린다면 왜인지. 모호한 표현 대신 참·거짓이 갈리는 조건만 쓴다. */
export function promotionReason(res, kind) {
  if (!res.ok && res.error) return `tier_error:${res.tier}`;
  if (res.tier === 'curl') {
    if (res.status === 0) return 'no_response';
    if (res.status === 403 || res.status === 429 || res.status === 503) return `http_${res.status}`;
    if (/^application\/(xml|rss)|\+xml/.test(res.contentType || '')) return null;   // 사이트맵은 여기서 끝
    // 카드 마크업이 있으면 글자가 적어도 승격하지 않는다 — 이미지 중심 목록은 원래 글자가 적다.
    const hasCards = hasRepeatedImageLinks(res.body);
    const textLen = htmlTextLength(res.body);
    if (!hasCards && textLen < THIN_TEXT) return `thin_text:${textLen}<${THIN_TEXT}`;
    if (kind === 'listing' && !hasCards) return 'listing_without_card_markup';
    return null;
  }
  if (res.tier === 'jina') {
    if (res.blocked) return 'jina_blocked';
    if (res.status === 0) return 'jina_no_response';
    if ((res.body || '').trim().length < THIN_TEXT) return `jina_thin:${(res.body || '').trim().length}`;
    return null;
  }
  if (res.tier === 'headless') {
    if (res.challenge) return 'bot_challenge';
    if (res.status === 403 || res.status === 503) return `http_${res.status}`;
    return null;
  }
  return null;
}

function htmlTextLength(html) {
  return visibleText(html).length;
}

// 아주 거친 사전 검사 — 진짜 판정은 judge 가 한다. 여기서는 승격 여부만 가른다.
// script·style 을 먼저 걷어낸다. 안 그러면 JS 가 나중에 그릴 카드 HTML 이 문자열로 들어 있을 때
// "이미 카드가 있다"고 잘못 보고 브라우저 단으로 안 올라간다(/js-only 가 그랬다).
function hasRepeatedImageLinks(html) {
  const cleaned = String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    // 머리·꼬리·메뉴는 어느 페이지에나 아이콘 링크가 반복된다. judge 와 같은 자리를 제외한다.
    .replace(/<header[\s\S]*?<\/header>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<aside[\s\S]*?<\/aside>/gi, ' ');
  const anchors = cleaned.match(/<a[^>]*>[\s\S]{0,400}?<\/a>/gi) || [];
  return anchors.filter((a) => /<img[^>]*>/i.test(a)).length >= 2;
}

/**
 * 한 주소를 가져온다.
 * @param {string} crawl
 * @param {object} opts { url, lease_token, url_id, kind, maxTier, paceOpts, browser }
 * @returns 증거 객체 (페이지 내용이 아니라 증거를 돌려준다)
 */
export async function fetchOne(crawl, opts = {}) {
  const { url, lease_token, url_id, kind = 'unknown', maxTier = 'chrome' } = opts;

  // (1) 임대 검사 — 여기서 막히면 네트워크 0회
  const v = store.verifyLease(crawl, { url, url_id, lease_token });
  if (!v.ok) {
    return { refused: true, why: v.why, network_calls: 0, url, crawl };
  }
  const target = v.rec.url;
  const domain = v.rec.domain;
  const pol = store.loadPolicy(crawl);
  // 정책에 적어 둔 값은 실제로 쓰여야 한다 — 차단 낌새 기준·휴면 길이·물러나는 간격까지 함께 넘긴다.
  // (저장만 되고 pace 기본값이 도는 설정은 정책이 아니라 장식이다.)
  const paceOpts = {
    min_interval_ms: opts.paceOpts?.min_interval_ms ?? pol.min_interval_ms,
    jitter_ms: opts.paceOpts?.jitter_ms ?? pol.interval_jitter_ms,
    daily_cap: opts.paceOpts?.daily_cap ?? pol.daily_cap,
    block_threshold: opts.paceOpts?.block_threshold ?? pol.block_threshold,
    block_sleep_ms: opts.paceOpts?.block_sleep_ms ?? pol.block_sleep_ms,
    retry_backoff_ms: opts.paceOpts?.retry_backoff_ms ?? pol.retry_backoff_ms,
  };

  const attemptId = crypto.randomUUID().slice(0, 8);
  const maxIdx = TIERS.indexOf(maxTier) >= 0 ? TIERS.indexOf(maxTier) : TIERS.length - 1;

  // 이전 호출이 남긴 진행을 잇는다. 임대가 다르면 readProgress 가 null 을 준다(폐기).
  const prog = readProgress(crawl, v.url_id, lease_token) || {
    lease_token, url_id: v.url_id, url: target, tiers: {}, attempts: [], flags: [], started_at: nowMs(),
  };
  const attempts = prog.attempts;
  const flags = prog.flags;
  let networkCalls = 0;                 // 이번 호출에서 실제로 나간 요청 수

  let res = null;
  let stoppedAt = null;
  for (let i = 0; i <= maxIdx; i++) {
    const tier = TIERS[i];

    // 이미 끝낸 단은 다시 요청하지 않는다 — resumable fetch 의 핵심.
    if (prog.tiers[tier]) {
      res = unstashTier(prog.tiers[tier]);
      const whySaved = prog.tiers[tier].promote_reason;
      if (!whySaved) break;             // 그때 여기서 끝났다
      continue;                          // 그때 승격했으므로 다음 단으로
    }

    // Jina 는 바깥에서 원본을 가져오는 서비스다. 사설·로컬 주소는 가져올 수 없으므로 건너뛴다.
    // opts.jinaForPrivate 는 시험 전용 — 사설 주소로도 Jina 단에 들어가 예약 계약을 검증할 때만 쓴다.
    if (tier === 'jina' && isPrivateHost(domain) && !opts.jinaForPrivate) {
      if (!flags.includes('jina_skipped:private_host')) flags.push('jina_skipped:private_host');
      prog.tiers[tier] = { tier, skipped: 'private_host', promote_reason: 'skipped' };
      writeProgress(crawl, v.url_id, prog);
      continue;
    }

    // (2) 접속 전에 예약. 못 받으면 여기서 멈추고, 다음 호출이 "이 단부터" 잇는다.
    // 예약에 이름표(permit)를 달아 둔다 — 뒤이은 예약이 막혀 요청을 못 보내도
    // 다음 호출이 같은 이름표로 그 예약을 그대로 쓰므로 카운트가 헛되이 늘지 않는다.
    const permitKey = `${crawl}:${v.url_id}:${tier}`;
    const reserved = pace.reserve(domain, paceOpts, permitKey);
    if (!reserved.ok) { stoppedAt = { tier, wait: reserved.wait_seconds, why: reserved.why }; break; }
    let jinaReserved = null;
    const jinaPermitKey = `${crawl}:${v.url_id}:jina-svc`;
    if (tier === 'jina') {
      // 무키 한도는 분당 20회다. 3.1초 간격이면 분당 최대 19회로 그 아래에 머문다.
      jinaReserved = pace.reserve('r.jina.ai', { min_interval_ms: 3_100, jitter_ms: 400, daily_cap: 5_000 }, jinaPermitKey);
      if (!jinaReserved.ok) {
        // 원 도메인 예약은 이름표로 남아 있다 — 다음 호출이 재사용하므로 카운트가 안 늘어난다.
        stoppedAt = { tier, wait: jinaReserved.wait_seconds, why: `jina_${jinaReserved.why}`, holding_permit: permitKey };
        break;
      }
    }

    const ua = reserved.user_agent;

    // [순서가 중요하다] 필요한 예약을 모두 얻은 뒤, 네트워크로 나가기 "직전"에 이름표를 지운다.
    // 보낸 뒤에 지우면 그 사이에 죽었을 때 이름표가 남아, 다음 호출이 요청을 되풀이하면서
    // 카운트는 안 느는 상태가 된다(요청은 나가는데 장부에 안 잡히는 fail-open).
    // 먼저 지우면 죽어도 장부가 실제보다 많이 세는 쪽으로만 틀린다 — 속도보다 안전이 먼저다.
    pace.consume(domain, permitKey);
    if (tier === 'jina') pace.consume('r.jina.ai', jinaPermitKey);
    faultBeforeRequest(tier);            // 시험용: 이 자리에서 죽여 위 계약을 검증한다

    networkCalls++;
    if (tier === 'curl') res = await tierCurl(target, ua);
    else if (tier === 'jina') res = await tierJina(target, ua);
    else {
      const { fetchWithBrowser } = await import('./browser.mjs');
      // 본 계단이 브라우저까지 올라오면 여기서 캡처가 생기고 시각 확인 단은 건너뛴다.
      // 그러니 카드 자리도 여기서 같이 재야 한다 — 안 그러면 그 경로에서는 자리가 영영 없다.
      res = await fetchWithBrowser(target, {
        tier, userAgent: ua, crawl, slug: slugForFile(target), captureId: `${attemptId}-${tier}`,
        collectCards: kind === 'listing',
      });
    }
    for (const bf of res.browserFlags || []) if (!flags.includes(bf)) flags.push(bf);

    const blocked = res.status === 403 || res.status === 429 || res.blocked || res.challenge;
    pace.record(domain, { blocked, failed: !res.ok && !blocked, opts: paceOpts });

    const why = promotionReason(res, kind);
    attempts.push({ tier, status: res.status, final: res.final, bytes: res.bytes, ms: res.ms, promote_reason: why, error: res.error });
    prog.tiers[tier] = { ...stashTier(crawl, v.url_id, res), promote_reason: why };
    writeProgress(crawl, v.url_id, prog);      // 원자적 — 여기서 죽어도 다음 호출이 잇는다

    if (!why) break;
    flags.push(`promoted_from_${tier}:${why}`);
    if (i === maxIdx) { flags.push('max_tier_reached'); break; }
  }

  // 예약에 막혀 멈췄으면 이어갈 정보를 함께 돌려준다. 이미 끝낸 단은 다시 요청되지 않는다.
  if (stoppedAt) {
    return {
      deferred: true, wait_seconds: stoppedAt.wait, why: stoppedAt.why,
      resume: { crawl, url_id: v.url_id, lease_token, next_tier: stoppedAt.tier, done_tiers: Object.keys(prog.tiers) },
      network_calls: networkCalls, url: target, crawl,
    };
  }

  // [계약] 원문을 얻은 단과 화면을 본 단은 다르다.
  // 목록은 화면 확인이 필요한데(계획서 2-4), curl 로 내용이 충분하면 승격이 일어나지 않는다.
  // 그래서 내용은 curl 것을 그대로 쓰고, 시각 확인만 따로 한 번 더 돈다.
  // 이렇게 해야 "deardeer 는 curl 에서 끝남"과 "목록은 visual 없이 통과 금지"가 함께 성립한다.
  // 시각 확인도 progress 의 한 단계다. 예약에 막히면 기다리지 않고 남은 초를 돌려주며,
  // 다음 호출은 앞 단(content)을 되풀이하지 않고 여기서 이어간다.
  // (2026-08-11 매니저 재현: 내부에서 5초 자고 포기하면 progress 가 지워져 curl 부터 재시작했다.)
  let visualPass = prog.tiers['visual-only'] ? unstashTier(prog.tiers['visual-only']) : null;
  const wantVisual = kind === 'listing' && !res?.shot && !visualPass
    && TIERS.indexOf(maxTier) >= TIERS.indexOf('headless');
  if (wantVisual && res?.ok !== false) {
    const vPermit = `${crawl}:${v.url_id}:visual-only`;
    const rv = pace.reserve(domain, paceOpts, vPermit);
    if (!rv.ok) {
      // 여기서 멈춘다. content 단은 progress 에 남아 있으므로 다음 호출이 이 자리부터 잇는다.
      return {
        deferred: true, wait_seconds: rv.wait_seconds, why: `visual_${rv.why}`,
        resume: { crawl, url_id: v.url_id, lease_token, next_tier: 'visual-only', done_tiers: Object.keys(prog.tiers) },
        network_calls: networkCalls, url: target, crawl,
      };
    }
    // content 단과 같은 계약 — 나가기 직전에 이름표를 지운다.
    pace.consume(domain, vPermit);
    faultBeforeRequest('visual-only');
    networkCalls++;
    const { fetchWithBrowser } = await import('./browser.mjs');
    visualPass = await fetchWithBrowser(res?.final || target, {
      tier: 'headless', userAgent: rv.user_agent, crawl, slug: slugForFile(target), captureId: `${attemptId}-visual`,
      collectCards: kind === 'listing',      // 목록일 때만 카드 자리를 잰다
    });
    for (const bf of visualPass.browserFlags || []) if (!flags.includes(bf)) flags.push(bf);
    pace.record(domain, { blocked: !!visualPass.challenge, failed: !visualPass.ok && !visualPass.challenge, opts: paceOpts });
    attempts.push({ tier: 'headless(visual-only)', status: visualPass.status, final: visualPass.final, ms: visualPass.ms, purpose: 'visual_confirm' });
    flags.push('visual_pass_added');
    prog.tiers['visual-only'] = { ...stashTier(crawl, v.url_id, { ...visualPass, tier: 'visual-only' }), promote_reason: null };
    writeProgress(crawl, v.url_id, prog);
  }

  const finalUrl = res?.final || target;
  if (finalUrl !== target) flags.push('redirected');           // 실패가 아니라 판정 대상으로 보낸다

  // (3) 판정 — 상태 코드나 "오류 문구 없음"이 아니라 긍정 증거로 가른다
  const { judge } = await import('./judge.mjs');
  const verdict = judge({
    html: res?.body || '', markdown: !!res?.markdown,
    requested: target, final: finalUrl, status: res?.status ?? 0,
    kind, profile: opts.profile || null,
  });

  // 원문을 얻은 단과 화면을 실제로 본 단은 다른 것이다. 합치지 않는다.
  const contentTier = res?.tier || null;
  const shotPath = res?.shot || visualPass?.shot || null;
  const visualTier = shotPath ? (res?.shot ? res.tier : `${visualPass.tier}(visual-only)`) : null;
  let visual = visualTier ? 'visual_validated' : 'visual_unverified';

  // [계약] 목록은 화면을 보지 않으면 최종 통과가 아니다(계획서 2-4).
  // curl 로 원문이 멀쩡해도 그것만으로는 통과시키지 않는다.
  let pageValidity = verdict.page_validity;
  if (kind === 'listing' && pageValidity === 'content_validated' && visual !== 'visual_validated') {
    pageValidity = 'needs_visual_review';
    flags.push('listing_needs_visual');
  }
  if (pageValidity === 'invalid') visual = visualTier ? 'visual_validated' : 'visual_unverified';

  const evidence = {
    requested: target,
    final: finalUrl,
    status: res?.status ?? 0,
    title: verdict.title || extractTitle(res?.body || ''),
    text_len: res?.markdown ? String(res.body || '').trim().length : htmlTextLength(res?.body || ''),
    page_validity: pageValidity,
    extraction_status: verdict.extraction_status,
    visual,
    content_tier: contentTier,           // 원문을 어느 단에서 얻었나
    visual_tier: visualTier,             // 화면을 실제로 본 단(캡처가 있는 단만)
    shot: shotPath,
    positive_evidence: verdict.evidence,
    negatives: verdict.negatives,
    cards: verdict.cards?.length ?? 0,
    declared: verdict.declared ?? null,
    flags,
    attempts,
    network_calls: networkCalls,
    attempt_id: attemptId,
    fetched_at: nowMs(),
  };

  // [필수 낱말] 본문을 밖으로 내보내지 않고 여기서 본다. 결과는 낱말 목록뿐이다.
  // 없다고 버리지 않는다 — 장부에 "사람이 봐야 한다"는 표시만 남기려고 재 두는 것이다.
  const words = pol.required_words || [];
  let wordsResult = null;
  if (words.length) {
    // 보이는 글자에서만 찾는다. script·주석에 숨은 낱말이 검토 신호를 지우면
    // 정작 사람이 봐야 할 이미지 위주 페이지가 조용히 통과한다.
    const visible = res?.markdown ? String(res.body || '') : visibleText(res?.body || '');
    const hay = `${evidence.title || ''}\n${visible}`.toLowerCase();
    const matched = words.filter((w) => hay.includes(String(w).toLowerCase()));
    // 지금 이 임대에 묶어 둔다. 임대가 바뀌면 이 판정은 남의 것이라 쓰지 않는다.
    wordsResult = { checked: true, matched, missing: matched.length === 0, at: nowMs(), lease_token, attempt_id: attemptId };
    evidence.words_matched = matched;
    evidence.words_missing = wordsResult.missing;
  }

  const p = ensureCrawlDirs(crawl);
  const mdir = path.join(p.manifests, v.url_id);
  fs.mkdirSync(mdir, { recursive: true });
  // 곁기록(낱말·내용 지문·쪽 관찰)은 시도 기록과 섞지 않는다.
  // 같은 자리에 두면 "가장 최근 .json" 을 시도 기록으로 읽는 쪽이 엉뚱한 파일을 집는다.
  const notesDir = path.join(mdir, 'notes');
  fs.mkdirSync(notesDir, { recursive: true });
  fs.writeFileSync(path.join(mdir, `${attemptId}.json`), JSON.stringify({
    ...evidence, body_bytes: res?.bytes ?? 0, card_hrefs: (verdict.cards || []).slice(0, 50).map((c) => c.href),
  }, null, 2));
  // report 가 본문 없이도 이 판정을 이어받을 수 있게 따로 남긴다
  if (wordsResult) writeAtomic(path.join(notesDir, 'words.json'), JSON.stringify(wordsResult, null, 2));

  // [나가는 링크] 이 쪽에서 본 링크를 이번 표와 판정에 묶어 남긴다.
  // 워커가 report 성공 뒤 따로 넣게 하면 그 사이에 죽을 때 발견이 통째로 사라진다.
  // 합치는 일은 report 가 같은 원자 변경 안에서 한다 — 여기서는 남기기만 한다.
  // 판정을 함께 묶는 이유: 200 을 주는 오류 쪽에도 메뉴와 바닥글은 그대로라, 근거 없이 따라가면
  // 거짓 양성이 그대로 번진다.
  writeAtomic(path.join(notesDir, 'links.json'), JSON.stringify({
    lease_token, attempt_id: attemptId, at: nowMs(),
    source_url_id: v.url_id, source_url: res?.final || res?.requested || v.url,
    // 시각 확인까지 반영한 최종 판정이어야 한다 — verdict 만 보면 목록을 글자만 보고도
    // content_validated 로 읽어, 아직 모르는 쪽의 링크를 따라가게 된다
    page_validity: pageValidity,
    markdown: !!res?.markdown,
    links: extractOutgoingLinks(res?.body || '', {
      markdown: !!res?.markdown, base: res?.final || res?.requested || v.url,
    }),
  }, null, 2));


  // [내용 지문] 워커가 주장한 값은 근거가 아니다. 본문을 쥔 여기서 재고, 이 임대에 묶어 남긴다.
  // 보이는 글자가 없거나 너무 짧으면 같은 지문으로 묶지 않는다 —
  // 빈 쪽끼리 "내용이 같다"고 묶으면 서로 상관없는 주소가 한 무더기가 된다.
  {
    const canon = canonicalContent(res?.body || '', { markdown: !!res?.markdown });
    const rec = canon.length < CONTENT_HASH_MIN
      ? { available: false, why: 'content_hash_unavailable', text_len: canon.length, min: CONTENT_HASH_MIN }
      : {
        available: true,
        hash: crypto.createHash('sha256').update(canon).digest('hex').slice(0, 32),
        algo: 'sha256/hex32', normalize: 'visible-text/collapse-space', version: 1,
        text_len: canon.length,
      };
    writeAtomic(path.join(notesDir, 'content.json'), JSON.stringify({ ...rec, lease_token, attempt_id: attemptId, at: nowMs() }, null, 2));

    // [낱말] 이 쪽에서 자주 나온 낱말을 쪽마다 한 번만 세어 둔다.
    // 합치는 것은 status 가 한다 — 그래야 다시 훑거나 보고가 겹쳐도 두 번 세지 않는다.
    writeAtomic(path.join(notesDir, 'terms.json'), JSON.stringify({
      terms: termCounts(canon), text_len: canon.length,   // 자르지 않는다 — 자르기는 status 가 한다
      declared: verdict.declared ?? null,
      lease_token, attempt_id: attemptId, at: nowMs(),
    }, null, 2));
  }

  // [같은 잣대] 장부가 url_id 를 만들 때 쓰는 정책을 그대로 넘긴다.
  // 안 그러면 같은 주소가 여기선 A, 장부에선 B 가 되어 "새 카드"가 늘 새것으로 보인다.
  const normOpts = {
    base: finalUrl || target,
    dropParams: pol.drop_params ?? undefined,
    keepParamsByDomain: pol.keep_params_by_domain ?? {},
    dropParamsByDomain: pol.drop_params_by_domain ?? {},
  };

  // [카드] 목록이면, 판정에 쓴 그 캡처에서 카드 자리를 잘라 낸다.
  // 캡처가 없거나 자리를 못 쟀거나 추출이 확정되지 않았으면 성공한 척하지 않고 사유를 남긴다.
  // 쪽 관찰보다 먼저 한다 — 쪽이 "무엇을 내놓았는가"의 단위가 곧 카드이기 때문이다.
  let cardsNote = null;
  if (kind === 'listing') {
    // 캡처는 한 곳에서만 온다 — 본 계단이 브라우저까지 올라왔으면 그것, 아니면 시각 확인 단.
    const capSrc = res?.shot ? res : (visualPass?.shot ? visualPass : null);
    cardsNote = await buildCardsNote({
      crawl, capSrc, verdict, pageValidity, finalUrl, target, domain,
      normOpts, notesDir, attemptId, lease_token, sourceUrlId: v.url_id,
    });
    writeAtomic(path.join(notesDir, 'cards.json'), JSON.stringify(cardsNote, null, 2));
    if (cardsNote.extraction_status !== 'complete') {
      evidence.extraction_status = 'incomplete';
      for (const w of cardsNote.why || []) if (!flags.includes(`cards:${w}`)) flags.push(`cards:${w}`);
    }
    evidence.cards_adopted = cardsNote.cards.length;
    evidence.cards_cropped = cardsNote.cards.filter((c) => c.crop_path).length;
  }

  // [쪽 관찰] 이 쪽이 실제로 내놓은 카드를 그대로 남긴다.
  // "새것 몇 개"는 여기서 세지 않는다 — 그 수는 보고가 도착한 순서에 따라 달라진다.
  // 목록에서는 카드 ID 를 쓴다. 상세 링크가 없는 목록은 링크로 세면 첫 쪽부터 "새것 0" 이 된다.
  {
    let ids;
    let extractionStatus;
    if (kind === 'listing') {
      ids = (cardsNote?.cards || []).map((c) => c.card_id);
      extractionStatus = cardsNote?.extraction_status ?? 'uncertain';
    } else {
      ids = [];
      for (const c of verdict.cards || []) {
        if (!c.href) continue;
        try { ids.push(normalizeUrl(c.href, normOpts).id); } catch {}
      }
      extractionStatus = verdict.extraction_status;
    }
    const obs = pageObservation({ pageValidity, visual, extractionStatus, detailIds: ids });
    writeAtomic(path.join(notesDir, 'page.json'), JSON.stringify({
      ...obs, url: finalUrl || target, lease_token, attempt_id: attemptId, at: nowMs(),
    }, null, 2));
  }

  // 한 주소를 끝냈으니 진행 기록은 걷는다(다음 임대가 옛 진행을 물려받지 않게).
  clearProgress(crawl, v.url_id);

  return { ...evidence, url_id: v.url_id, crawl, body: res?.body || '', markdown: !!res?.markdown, card_list: verdict.cards || [] };
}

// ---------- 카드 ----------

const CARD_ADOPT_MAX = 60;      // 한 쪽에서 장부에 담을 카드 수 상한. 넘으면 조용히 자르지 않는다.

/** 목록 캡처에서 좌표로 잘라 낸다. 파이썬(PIL)에 한 번에 넘긴다. */
async function cropFromShot(reqObj) {
  const script = path.join(path.dirname(new URL(import.meta.url).pathname), 'crop_cards.py');
  const { spawn } = await import('node:child_process');
  return new Promise((resolve) => {
    const p = spawn('python3', [script], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', () => {
      try { resolve(JSON.parse(out)); }
      catch { resolve({ ok: false, why: `crop_helper_failed: ${(err || out).slice(0, 120)}` }); }
    });
    p.stdin.end(JSON.stringify(reqObj));
  });
}

async function buildCardsNote(ctx) {
  const {
    crawl, capSrc, verdict, pageValidity, finalUrl, target, domain,
    normOpts, notesDir, attemptId, lease_token, sourceUrlId,
  } = ctx;
  const why = [];
  const base = { lease_token, attempt_id: attemptId, at: nowMs(), source_url: finalUrl || target, cards: [] };

  // [축을 나눈다] "이 쪽의 카드를 다 뽑았는가"와 "쪽이 밝힌 총수와 맞는가"는 다른 물음이다.
  // 총수가 이 쪽 카드보다 크다는 건 쪽 나눔이라는 뜻이지 추출이 실패했다는 뜻이 아니다.
  // 둘을 한데 묶으면 쪽 나눈 목록에서는 카드가 한 장도 안 쌓인다(deardeer 가 그 모양이다).
  // 총수 대조는 아래 reconciliation 으로 따로 남기고, status 가 묶음 단위로 푼다.
  if (!capSrc?.shot) why.push('no_capture');
  if (!capSrc?.card_candidates?.length) why.push('no_boxes');
  // 판정이 확정되지 않은 쪽에서는 카드를 만들지 않는다(태스크 18 계약).
  // 표시 총수와의 대조는 여기서 안 본다 — 그건 아래 reconciliation 과 묶음 대조가 맡는다.
  if (!['content_validated', 'visual_validated'].includes(pageValidity)) why.push(`page_validity:${pageValidity}`);
  if (why.length) return { ...base, extraction_status: 'incomplete', why, capture_path: capSrc?.shot || null };

  // 어느 것이 진짜 카드인지는 judge 한곳에서만 고른다. 브라우저가 잰 자리는 거기에 맞춘다.
  const { parseDoc, findCardGroups } = await import('./judge.mjs');
  const doc = parseDoc(capSrc.body || '', finalUrl || target);
  const chosen = doc ? findCardGroups(doc, finalUrl || target).cards : [];
  if (chosen.length < 2) return { ...base, extraction_status: 'incomplete', why: ['no_card_group'], capture_path: capSrc.shot };

  const { matchBoxes, buildCard } = await import('./cards.mjs');
  let matched = matchBoxes(chosen, capSrc.card_candidates, normOpts, finalUrl || target);
  if (matched.length > CARD_ADOPT_MAX) {
    why.push(`adopt_capped:${matched.length}>${CARD_ADOPT_MAX}`);
    matched = matched.slice(0, CARD_ADOPT_MAX);
  }
  const ledgerState = store.loadState(crawl);
  // 한 쪽에서 같은 그림이 몇 번 쓰였는지 — 대체 ID 가 그림만으로 갈리는지 판단하는 근거
  const imageCounts = new Map();
  for (const m of matched) if (m.img_abs) imageCounts.set(m.img_abs, (imageCounts.get(m.img_abs) || 0) + 1);
  const cards = matched.map((m) => buildCard(m, {
    sourceUrl: finalUrl || target, sourceUrlId: ctx.sourceUrlId, domain, capturePath: capSrc.shot, normOpts, ledgerState, imageCounts,
  }));

  const withBox = cards.filter((c) => c.bbox);
  if (withBox.length !== cards.length) why.push(`missing_bbox:${cards.length - withBox.length}`);

  if (withBox.length) {
    const meta = capSrc.capture_meta || {};
    const cropDir = path.join(path.dirname(capSrc.shot), 'cards', attemptId);
    const r = await cropFromShot({
      shot: capSrc.shot, out_dir: cropDir,
      css_width: meta.page_css_width, css_height: meta.page_css_height,
      boxes: withBox.map((c) => ({ name: String(c.position).padStart(3, '0'), ...c.bbox })),
    });
    if (!r.ok) why.push(r.why || 'crop_failed');
    else {
      const byName = new Map((r.results || []).map((x) => [x.name, x]));
      for (const c of withBox) {
        const got = byName.get(String(c.position).padStart(3, '0'));
        if (got?.ok) { c.crop_path = got.path; c.crop_px = { w: got.w, h: got.h, bytes: got.bytes, box: got.pixel_box }; c.crop_why = got.why || null; }
        else { c.crop_why = got?.why || 'crop_missing'; }
      }
      const failed = withBox.filter((c) => !c.crop_path).length;
      if (failed) why.push(`crop_failed:${failed}`);
      base.shot_px = r.shot_px; base.scale = r.scale;
    }
  }
  if (meta_capped(capSrc)) why.push('candidates_capped');

  return {
    ...base, cards,
    capture_path: capSrc.shot,
    capture_meta: capSrc.capture_meta || null,
    extraction_status: why.length ? 'incomplete' : 'complete',
    why,
    // 표시 총수 대조는 카드 추출과 별개다. 여기서는 사실만 적고 판단은 status 가 묶음까지 보고 한다.
    reconciliation: (() => {
      const d = verdict.declared ?? null;
      const n = cards.length;
      if (d == null) return { state: 'count_not_declared', declared: null, page_count: n };
      if (d === n) return { state: 'matches_page', declared: d, page_count: n };
      if (d > n) return { state: 'declared_exceeds_page', declared: d, page_count: n };
      return { state: 'overcount', declared: d, page_count: n };
    })(),
  };
}

function meta_capped(capSrc) { return !!capSrc?.capture_meta?.candidates_capped; }

// ---------- 진행 저장 (resumable fetch) ----------
//
// [왜 필요한가] 한 호출 안에서 curl 을 끝내고 다음 단 예약에 막혀 deferred 를 돌려주면,
// 호출자가 다시 부를 때 진행이 없어 curl 부터 재시작한다. 그러면 같은 페이지에 요청을 거듭 보내고
// 도메인 하루 한도를 헛되이 태운다. (2026-08-11 deardeer.kr 에서 curl 19회 → daily_cap 20 소진.)
// 그래서 끝낸 단을 crawl 장부에 원자적으로 적어 두고, 재호출은 그다음 단부터 잇는다.
// 임대가 바뀌면 남의 진행이므로 폐기한다.

function progressFile(crawl, urlId) {
  return path.join(crawlPaths(crawl).manifests, urlId, 'progress.json');
}

function readProgress(crawl, urlId, leaseToken) {
  try {
    const p = JSON.parse(fs.readFileSync(progressFile(crawl, urlId), 'utf8'));
    if (p.lease_token !== leaseToken) return null;      // 다른 임대의 진행 — 폐기
    return p;
  } catch { return null; }
}

function writeProgress(crawl, urlId, prog) {
  const f = progressFile(crawl, urlId);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(prog, null, 2));
  fs.renameSync(tmp, f);                                 // 원자적 교체
}

function clearProgress(crawl, urlId) {
  try { fs.unlinkSync(progressFile(crawl, urlId)); } catch {}
}

/** 단계 결과에서 본문을 따로 파일로 빼고 요약만 진행 기록에 남긴다(진행 파일이 비대해지지 않게). */
function stashTier(crawl, urlId, res) {
  const dir = path.join(crawlPaths(crawl).manifests, urlId);
  fs.mkdirSync(dir, { recursive: true });
  const bodyFile = path.join(dir, `body-${res.tier}.txt`);
  try { fs.writeFileSync(bodyFile, res.body || ''); } catch {}
  const { body, ...rest } = res;
  return { ...rest, bodyFile };
}

function unstashTier(saved) {
  let body = '';
  try { body = fs.readFileSync(saved.bodyFile, 'utf8'); } catch {}
  return { ...saved, body };
}

// 결정적 고장 주입 — 시험 전용.
// [안전장치] 변수 하나만으로 죽이면 운영 중인 MCP 프로세스도 죽는다. 그래서 NODE_ENV=test 를
// 함께 요구한다. 둘 다 맞을 때만 동작하고, 평소에는 이 함수가 아무 일도 하지 않는다.
function faultBeforeRequest(tier) {
  if (process.env.NODE_ENV !== 'test') return;
  if (process.env.WEBSEARCH_FAULT_BEFORE_REQUEST === tier) {
    process.kill(process.pid, 'SIGKILL');
  }
}

/** 로컬·사설 주소인가 — 바깥 서비스(Jina)로 넘길 수 없는 대상 */
export function isPrivateHost(host) {
  const h = String(host || '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.localhost')) return true;
  if (/^127\./.test(h) || h === '::1' || h === '0.0.0.0') return true;
  if (/^10\./.test(h) || /^192\.168\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  return false;
}

export function extractTitle(html) {
  const m = String(html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (m) return m[1].replace(/\s+/g, ' ').trim().slice(0, 200);
  const md = String(html || '').match(/^Title:\s*(.+)$/m);   // Jina 마크다운은 첫 줄에 Title: 을 준다
  return md ? md[1].trim().slice(0, 200) : '';
}
