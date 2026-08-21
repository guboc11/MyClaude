// web-search — 수집 계단 3·4단 (브라우저)
// 계획서 2-2, 2-4.
//
// 3단 headless, 4단 실제 크롬(channel:'chrome', headless:false).
// playwright 는 도구 폴더가 아니라 "부른 프로젝트"의 node_modules 에 있다(레포에 1.60.0 설치됨).
//
// 이 단에서만 화면 캡처가 생긴다. curl·Jina 로 끝난 페이지에는 캡처가 없고,
// 그래서 visual_tier 가 null 이며 목록이면 최종 통과가 아니다(계획서 2-4).

import fs from 'node:fs';
import path from 'node:path';
import { crawlPaths, ensureCrawlDirs } from './paths.mjs';
import { requireDep } from './deps.mjs';

function loadPlaywright() {
  return requireDep('playwright');
}

// 봇 차단 화면인지 — 지문으로 판정한다. "오류 문구 없음"을 정상 근거로 쓰지 않기 위해,
// 여기서는 오직 "막혔다"만 판단하고 정상 판정은 judge 가 긍정 증거로 따로 한다.
const CHALLENGE_MARKS = [
  'Sorry, you have been blocked',
  'Checking your browser before accessing',
  'cf-browser-verification',
  'Just a moment...',
  '__cf_chl_',
  'Attention Required! | Cloudflare',
  'Enable JavaScript and cookies to continue',
];

function looksLikeChallenge(html, title) {
  const t = `${title || ''}\n${String(html || '').slice(0, 4000)}`;
  return CHALLENGE_MARKS.some((m) => t.includes(m));
}

const VIEWPORT = { width: 1280, height: 900 };
// 캡처 배율. 자리(bbox)는 CSS 픽셀이고 그림은 이 배율만큼 크다 — 둘을 같이 적어야 되짚을 수 있다.
const DEVICE_SCALE = 1;
// 카드 후보로 볼 최소 크기. 머리·꼬리의 아이콘 링크를 자연스럽게 걸러 낸다.
const CARD_MIN_SIDE = 60;
// 한 쪽에서 잘라 낼 카드 수 상한. 넘으면 조용히 자르지 않고 잘렸다고 남긴다.
const CARD_MAX = 60;
// 스크롤 종료를 보장하는 두 상한. 어느 쪽이든 먼저 걸리면 멈춘다.
const SCROLL_MAX_STEPS = 12;
const SCROLL_BUDGET_MS = 5_000;
// fullPage 캡처 높이 상한. 무한 스크롤 페이지는 수만 픽셀이 되어 캡처 자체가 안 끝난다.
const SHOT_MAX_HEIGHT = 12_000;

/**
 * @param {string} url
 * @param {object} opts { tier: 'headless'|'chrome', userAgent, crawl, slug }
 */
export async function fetchWithBrowser(url, opts = {}) {
  const { tier = 'headless', userAgent, crawl, slug = 'page', captureId, collectCards = false } = opts;
  const t0 = Date.now();
  const cardBoxes = [];
  let cardsCapped = false;
  let captureMeta = null;
  const { chromium } = loadPlaywright();

  const launch = tier === 'chrome'
    ? { headless: false, channel: 'chrome' }
    : { headless: true };

  let browser;
  try {
    browser = await chromium.launch(launch);
  } catch (e) {
    return { tier, ok: false, status: 0, final: url, body: '', bytes: 0, ms: Date.now() - t0, error: `launch: ${e.message.slice(0, 160)}` };
  }

  try {
    const ctx = await browser.newContext({ viewport: VIEWPORT, userAgent });
    const page = await ctx.newPage();
    let status = 0;
    try {
      const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      status = resp?.status() ?? 0;
    } catch (e) {
      await browser.close();
      return { tier, ok: false, status: 0, final: url, body: '', bytes: 0, ms: Date.now() - t0, error: `goto: ${e.message.split('\n')[0].slice(0, 160)}` };
    }

    // 지연 로딩을 깨우되 사람처럼 끊어서 내린다(한 번에 끝까지 내리면 안 불러오는 곳이 있다).
    //
    // [종료 보장] 무한 스크롤 페이지는 내릴수록 scrollHeight 가 늘어난다. 그걸 그대로 따라가면
    // 영영 안 끝난다(2026-08-11 deardeer.kr 에서 5분 이상 멈춰 관찰이 중단됐다).
    // 그래서 단계 수와 총 시간을 둘 다 고정하고, 바깥에도 별도 시간 제한을 건다 — 셋 중 하나만
    // 걸려도 끝난다. 상한에 닿았으면 그 사실을 flag 로 남긴다(조용히 멈추지 않는다).
    const scrollInfo = await Promise.race([
      page.evaluate(async ({ maxSteps, budgetMs }) => {
        const t0 = Date.now();
        const step = Math.max(200, Math.floor(innerHeight * 0.7));
        let steps = 0;
        let y = 0;
        let capped = false;
        while (steps < maxSteps) {
          if (Date.now() - t0 > budgetMs) { capped = 'time'; break; }
          if (y >= document.body.scrollHeight - innerHeight) break;   // 바닥에 닿았다
          y += step;
          scrollTo(0, y);
          steps++;
          await new Promise((r) => setTimeout(r, 120));
        }
        if (steps >= maxSteps) capped = capped || 'steps';
        scrollTo(0, 0);
        return { steps, capped, height: document.body.scrollHeight };
      }, { maxSteps: SCROLL_MAX_STEPS, budgetMs: SCROLL_BUDGET_MS }),
      new Promise((r) => setTimeout(() => r({ steps: -1, capped: 'outer_timeout', height: 0 }), SCROLL_BUDGET_MS + 3_000)),
    ]).catch(() => ({ steps: -1, capped: 'error', height: 0 }));
    await page.waitForTimeout(300);

    const html = await page.content();
    const title = await page.title().catch(() => '');
    const final = page.url();
    const challenge = looksLikeChallenge(html, title);

    // 화면 캡처 — 이 단의 존재 이유. 기본은 fullPage 지만 높이에 상한을 둔다.
    let shot = null;
    let shotTruncated = false;
    if (crawl) {
      const p = ensureCrawlDirs(crawl);
      const domain = new URL(final).hostname;
      const dir = path.join(p.captures, domain);
      fs.mkdirSync(dir, { recursive: true });
      // 파일명에 고유 id 를 넣는다. 날짜+slug+tier 만 쓰면 다시 돌릴 때 앞선 증거를 덮어쓴다.
      // 증거는 덮어쓰지 않는다 — 판정이 왜 그랬는지 나중에 되짚을 수 없게 되기 때문이다.
      const day = new Date().toISOString().slice(0, 10);
      const uniq = captureId || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      shot = path.join(dir, `${day}-${slug}-${tier}-${uniq}.jpg`);
      const pageH = await page.evaluate(() => document.body.scrollHeight).catch(() => 0);
      const shotOpts = { path: shot, type: 'jpeg', quality: 72 };
      if (pageH > SHOT_MAX_HEIGHT) {
        // 상한을 넘으면 위에서부터 잘라 찍는다. 조용히 통짜로 시도하면 캡처가 안 끝난다.
        shotTruncated = true;
        Object.assign(shotOpts, { clip: { x: 0, y: 0, width: VIEWPORT.width, height: SHOT_MAX_HEIGHT } });
      } else {
        shotOpts.fullPage = true;
      }
      await page.screenshot(shotOpts).catch(() => { shot = null; });

      // [카드 자리] 여기서는 자리만 잰다. 자르는 일은 이 통짜 캡처에서 나중에 한다 —
      // 요소를 따로 다시 찍으면 그건 "목록 캡처에서 잘라 낸 것"이 아니라 다른 그림이다.
      // 어느 것이 진짜 카드인지도 여기서 고르지 않는다. 그 판단은 judge 한곳에서만 한다.
      if (collectCards) {
        const raw = await page.evaluate((minSide) => {
          const out = [];
          const seen = new Set();
          // judge 와 같은 자리를 잰다 — 카드는 링크 한 줄이 아니라 그 링크를 품은 상자다.
          // 인라인 <a> 만 재면 꾸밈이 없는 문서에서 글자 높이만큼만 잡혀 카드가 아니게 된다.
          const put = (el, href, m) => {
            if (!el || seen.has(el)) return;
            const r = el.getBoundingClientRect();
            if (r.width < minSide || r.height < minSide) return;     // 메뉴 아이콘 같은 잔챙이
            seen.add(el);
            out.push({
              href: href || null, img: m ? (m.currentSrc || m.src || '') : '',
              // 페이지 좌표(스크롤 포함). 화면 안 좌표는 스크롤에 따라 달라진다.
              x: Math.round(r.left + scrollX), y: Math.round(r.top + scrollY),
              w: Math.round(r.width), h: Math.round(r.height),
            });
          };
          for (const a of document.querySelectorAll('a[href]')) {
            const m = a.querySelector('img');
            if (m) put(a.closest('article, li, figure, div') || a, a.href, m);
          }
          // 상세 링크가 없는 목록(덮개 창으로 여는 것)도 자리를 재 둔다
          for (const m of document.querySelectorAll('img')) {
            if (m.closest('a[href]')) continue;
            put(m.closest('article, li, figure, div'), null, m);
          }
          return out;
        }, CARD_MIN_SIDE).catch(() => []);
        // 여기서는 자르지 않는다. 반복 묶음과 맞춰 본 뒤에 상한을 건다 —
        // 먼저 자르면 앞쪽 잔챙이 때문에 진짜 카드가 잘려 나간다.
        cardBoxes.push(...raw);
        const cssW = await page.evaluate(() => Math.max(
          document.documentElement.scrollWidth, document.body.scrollWidth)).catch(() => VIEWPORT.width);
        captureMeta = {
          device_scale_factor: DEVICE_SCALE, viewport: { ...VIEWPORT },
          page_css_width: cssW, page_css_height: pageH,
          shot_truncated: shotTruncated, shot_max_height: SHOT_MAX_HEIGHT,
          candidates_capped: cardsCapped, card_min_side: CARD_MIN_SIDE,
        };
      }
    }

    await browser.close();
    const closed = !browser.isConnected();     // 닫혔는지 스스로 증언한다(환경의 프로세스 수에 기대지 않는다)
    const scrollFlags = [];
    if (scrollInfo?.capped) scrollFlags.push(`scroll_capped:${scrollInfo.capped}`);
    if (shotTruncated) scrollFlags.push('shot_truncated');
    return {
      tier, ok: !challenge, status, final, body: html, bytes: html.length,
      ms: Date.now() - t0, shot, challenge, title,
      scroll: scrollInfo, browserFlags: scrollFlags, closed,
      card_candidates: cardBoxes, capture_meta: captureMeta,
    };
  } catch (e) {
    try { await browser.close(); } catch {}
    return { tier, ok: false, status: 0, final: url, body: '', bytes: 0, ms: Date.now() - t0, error: e.message.slice(0, 160) };
  }
}
