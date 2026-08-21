// mode=browser 수집 — 렌더된 문서에서, 시킨 산출물만.
//
// 태스크 #29. http 모드와 **같은 계약**으로 저장한다. text 는 text.txt, links 는 links.jsonl,
// dom 은 dom.html.gz — 다른 것은 "받은 바이트" 대신 "렌더가 끝난 뒤의 문서" 라는 점뿐이다.
//
// ─────────────────────────────────────────────────────────────
// [보증 범위가 http 모드와 다르다 — 숨기지 않는다]
//
// http 모드는 검사한 IP 로 소켓을 못 박는다(#25). 브라우저는 자기 네트워크 계층으로 페이지와
// 하위 자원을 요청하므로 **같은 수준의 연결 고정을 보장할 수 없다.** 우리가 하는 것은
//   - 나가기 전 목적지 검사(URL·규약·DNS) — 요청 하나하나에 대해
//   - 위험한 곳이면 그 요청을 아예 끊기
// 까지이고, 검사 뒤 연결 직전에 DNS 가 바뀌는 경우(rebinding)를 막지는 못한다.
//
// 그래서 브라우저 모드로 만든 **모든** attempt 에 browser_no_pinned_connection 경고가 붙는다.
// 성공했을 때도 빠지지 않는다. 두 모드가 같은 안전 수준인 것처럼 보이면 안 된다.
// ─────────────────────────────────────────────────────────────
//
// 실제 크롬(channel)이나 로그인 세션은 쓰지 않는다. 번들 chromium 을 헤드리스로만 띄운다.

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import zlib from 'node:zlib';

import { writeArtifact } from '../artifacts.mjs';
import { detectErrorPageText, isThinText } from '../errors.mjs';
import { checkTarget } from '../network-policy.mjs';
import { BROWSER_IMAGE_DEFAULTS, DOM_IMAGE_SNAPSHOT, attachImageObserver, collectBrowserImages } from './browser-images.mjs';
import { extractLinks, linksToJsonl } from './extract-links.mjs';
import { extractText } from './extract-text.mjs';

export class BrowserError extends Error {
  constructor(stage, code, message) {
    super(message ?? code);
    this.name = 'BrowserError';
    this.stage = stage;
    this.code = code;
  }
}

/** 브라우저 모드가 만들 수 있는 것. http 가 못 만드는 screenshot 이 여기 있다. */
export const BROWSER_OUTPUTS = ['screenshot', 'text', 'dom', 'links', 'images'];

/** 이 모드의 보증 범위를 한 줄로. 도구 설명과 manifest 가 같은 문장을 쓴다. */
export const BROWSER_CAPABILITY =
  '브라우저 모드: 요청마다 목적지를 검사하고 속도 예약은 페이지 이동마다 걸지만'
  + ' 연결 대상 IP 고정은 없습니다(http 모드에는 있습니다).'
  + ' 모든 결과에 browser_no_pinned_connection 경고가 붙습니다.';

/** 성공해도 빠지지 않는 경고. 두 모드의 보증 차이가 기록으로 남는 자리다. */
export const NO_PINNED_CONNECTION = 'browser_no_pinned_connection';

const VIEWPORT = { width: 1280, height: 900 };
const DEVICE_SCALE = 1;
// 스크롤 종료를 보장하는 두 상한. 어느 쪽이든 먼저 걸리면 멈춘다.
const SCROLL_MAX_STEPS = 12;
const SCROLL_BUDGET_MS = 5_000;
// fullPage 캡처 높이 상한. 무한 스크롤 쪽은 수만 픽셀이 되어 캡처 자체가 안 끝난다.
const SHOT_MAX_HEIGHT = 12_000;

// 봇 차단 화면의 지문. **판정이 아니라 관찰이다** — 여기 걸려도 수집 성공 여부는 바뀌지 않는다.
// (1차는 `ok: !challenge` 로 성공을 뒤집었다. 그러면 에이전트는 원본을 볼 기회조차 잃는다.)
const CHALLENGE_MARKS = [
  'Sorry, you have been blocked',
  'Checking your browser before accessing',
  'cf-browser-verification',
  'Just a moment...',
  '__cf_chl_',
  'Attention Required! | Cloudflare',
  'Enable JavaScript and cookies to continue',
];
const looksBlocked = (html, title) => {
  const t = `${title || ''}\n${String(html || '').slice(0, 4000)}`;
  return CHALLENGE_MARKS.find((m) => t.includes(m)) ?? null;
};

// ── playwright 찾기 ───────────────────────────────────────────

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * playwright 는 이 도구 폴더가 아니라 **부른 프로젝트**의 node_modules 에 있다.
 * 못 찾으면 조용히 http 로 갈아타지 않는다 — 어디를 찾아봤는지까지 말하고 실패한다.
 */
export function resolvePlaywright({ depsDir = null, cwd = process.cwd(), projectDir = process.env.CLAUDE_PROJECT_DIR } = {}) {
  const tried = [];
  const candidates = [depsDir, projectDir, cwd, path.resolve(HERE, '..', '..')].filter(Boolean);
  for (const dir of candidates) {
    const from = createRequire(path.join(path.resolve(dir), 'noop.cjs'));
    for (const name of ['playwright', 'playwright-core']) {
      try {
        const resolved = from.resolve(name);
        return { path: resolved, package: name, from: path.resolve(dir), tried };
      } catch { tried.push(`${path.resolve(dir)} → ${name}`); }
    }
  }
  throw new BrowserError('deps', 'playwright_not_found',
    `playwright 를 찾지 못했습니다. 찾아본 곳: ${tried.join(' · ')}`);
}

// 찾은 자리별로 기억한다. 하나만 기억하면 나중에 다른 depsDir 를 줘도 조용히 앞의 것을 쓰게 되고,
// 그러면 "어디 것을 썼나" 라는 물음에 코드가 거짓을 말한다.
const loaded = new Map();
async function loadChromium(opts) {
  const found = resolvePlaywright(opts);
  if (loaded.has(found.path)) return loaded.get(found.path);
  const mod = await import(pathToFileURL(found.path).href);
  const chromium = mod.chromium ?? mod.default?.chromium;
  if (!chromium) throw new BrowserError('deps', 'playwright_shape', `${found.package} 에 chromium 이 없습니다`);
  const entry = { chromium, found };
  loaded.set(found.path, entry);
  return entry;
}

// ── 수집 ──────────────────────────────────────────────────────

/**
 * @param {{
 *   root:string, attemptId:string, url:string, outputs:string[],
 *   resolver?:Function, fixtureAllow?:Array, gate?:Function,
 *   navTimeoutMs?:number, overallTimeoutMs?:number, depsDir?:string, nowMs?:number
 * }} o
 *   gate 는 "나가도 되는 차례인가" 를 묻는 문이다(속도 예약). 조정 계층(#28)이 넣어 준다.
 *   null 을 돌려주면 나가고, {reason} 을 돌려주면 그 요청을 끊는다.
 *
 * @returns {Promise<object>} collectHttp 와 같은 모양
 */
export async function collectBrowser(db, {
  root, attemptId, url, outputs,
  resolver, fixtureAllow = [], gate = null, imageOptions = {},
  navTimeoutMs = 30_000, overallTimeoutMs = 60_000, depsDir = null, nowMs = Date.now(),
}) {
  const unknown = outputs.filter((o) => !BROWSER_OUTPUTS.includes(o));
  if (unknown.length) {
    throw new BrowserError('input', 'unsupported_output',
      `브라우저 수집기가 만들 수 없는 산출물입니다: ${unknown.join('·')} (가능: ${BROWSER_OUTPUTS.join('·')})`);
  }
  const want = new Set(outputs);
  const started = Date.now();

  const base = {
    requested_url: url, final_url: null, status: null, title: null, charset: null,
    redirected: false, truncated: false, outputs: {}, produced: [], missing: [...outputs],
    // 이 경고는 성공해도 빠지지 않는다.
    warnings: [NO_PINNED_CONNECTION],
    capability: BROWSER_CAPABILITY,
    hops: 0, elapsed_ms: 0,
    requests: { allowed: 0, blocked: 0, paced: 0 },
    error_stage: null, error_code: null, error_message_short: null,
  };
  const bail = (stage, code, message) => ({
    ...base, ok: false, elapsed_ms: Date.now() - started,
    error_stage: stage, error_code: code, error_message_short: String(message).slice(0, 200),
  });

  // (1) 첫 목적지부터 검사한다. 브라우저를 띄우기도 전이다.
  const first = await checkTarget(url, { resolver, fixtureAllow });
  if (!first.allow) {
    const stage = String(first.reason).startsWith('url_') ? 'url' : String(first.reason).startsWith('dns_') ? 'dns' : 'policy';
    return bail(stage, first.reason, `${first.hostname ?? url} 로는 나가지 않습니다`);
  }

  let chromium;
  try {
    ({ chromium } = await loadChromium({ depsDir }));
  } catch (e) {
    return bail(e.stage ?? 'deps', e.code ?? 'playwright_not_found', e.message);
  }

  let browser = null;
  let context = null;
  const blockedUrls = [];
  let allowed = 0;
  let paced = 0;

  try {
    // 실제 크롬도, 저장해 둔 로그인 세션도 쓰지 않는다. 매번 빈 판이다.
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({
      viewport: VIEWPORT,
      deviceScaleFactor: DEVICE_SCALE,
      ignoreHTTPSErrors: false,
      javaScriptEnabled: true,
    });
    const page = await context.newPage();
    page.setDefaultTimeout(navTimeoutMs);

    // 그림을 시켰으면 로딩 중 지나가는 응답을 그 자리에서 받아 둔다. 나중에 다시 받지 않는다 —
    // 두 번 두드리는 것이고, 그때 받은 것과 지금 받는 것이 다를 수도 있다.
    const observer = want.has('images')
      ? attachImageObserver(page, { maxImageBytes: imageOptions.maxImageBytes ?? BROWSER_IMAGE_DEFAULTS.max_image_bytes })
      : null;

    // (2) 요청 하나하나를 검사한다. 하위 자원도 목적지 검사는 예외가 아니다.
    await page.route('**/*', async (route, request) => {
      const target = request.url();
      if (!/^https?:/i.test(target)) { await route.continue(); return; }
      const check = await checkTarget(target, { resolver, fixtureAllow });
      if (!check.allow) {
        blockedUrls.push({ url: target.slice(0, 200), reason: check.reason });
        await route.abort('blockedbyclient');
        return;
      }
      allowed++;
      await route.continue();
    });

    // (3) 속도 예약은 **이동을 시작하기 전에** 한 번. 페이지 한 장이 예약 한 건이다.
    //
    // [두 번 틀린 자리다]
    // 처음에는 요청마다 예약을 잡았다. 한 페이지가 그림·글꼴로 수십 번 요청하는데 그 하나하나가
    // 도메인 간격(기본 10초)을 기다려, 진짜 사이트에서는 한 장도 못 열었다(시나리오 A, 프랑스 5곳).
    // 그래서 본문 이동에만 걸도록 좁혔는데, 그것도 **route 안에서** 기다렸다. 기다리는 동안
    // page.goto 의 시계는 그대로 흘러서, 워커 셋이 같은 도메인에 줄을 서자 22쪽 중 21쪽이
    // 30초 초과로 죽었다(시나리오 B, 2026-08-12).
    //
    // 기다림은 이동 밖에 있어야 한다. 여기서 차례를 받고, 받은 다음에 이동을 시작한다 —
    // 그래야 이동 시간 30초가 "페이지를 여는 데 쓴 시간" 만 센다. http 모드가 pausedMs 로
    // 하는 일과 같은 것을, 브라우저에서는 이렇게 한다.
    if (gate) {
      const refusal = await gate(first.canonical_url ?? url);
      if (refusal) return bail('pace', refusal.reason, `차례를 못 받았습니다(${refusal.wait_ms ?? 0}ms 기다려야 합니다)`);
      paced++;
    }

    // (4) 이동. redirect 는 브라우저가 따라가지만 그 홉들도 위 route 검사를 다시 받는다.
    let response;
    try {
      response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: navTimeoutMs });
    } catch (e) {
      return bail('navigate', 'goto_failed', e.message.split('\n')[0]);
    }
    if (!response) return bail('navigate', 'no_response', '응답 없이 끝났습니다');

    const chain = [];
    for (let r = response.request().redirectedFrom(); r; r = r.redirectedFrom()) chain.unshift(r.url());
    base.hops = chain.length + 1;
    base.status = response.status();
    base.final_url = page.url();
    base.redirected = base.final_url !== url;

    // (4) 지연 로딩을 깨우되 반드시 끝난다. 단계 수와 시간, 바깥 시계 셋 중 하나만 걸려도 멈춘다.
    //     (무한 스크롤 쪽은 내릴수록 높이가 늘어난다. 그대로 따라가면 영영 안 끝난다.)
    let scroll = { steps: 0, capped: false };
    try {
      scroll = await Promise.race([
        page.evaluate(async ({ maxSteps, budgetMs }) => {
          const t0 = Date.now();
          const step = Math.max(200, Math.floor(innerHeight * 0.7));
          let steps = 0;
          let y = 0;
          let capped = false;
          while (steps < maxSteps) {
            if (Date.now() - t0 > budgetMs) { capped = 'time'; break; }
            if (y >= document.body.scrollHeight - innerHeight) break;
            y += step;
            scrollTo(0, y);
            steps++;
            await new Promise((r) => setTimeout(r, 120));
          }
          if (steps >= maxSteps) capped = capped || 'steps';
          return { steps, capped };
        }, { maxSteps: SCROLL_MAX_STEPS, budgetMs: SCROLL_BUDGET_MS }),
        new Promise((r) => setTimeout(() => r({ steps: 0, capped: 'outer' }), SCROLL_BUDGET_MS + 3000)),
      ]);
    } catch { scroll = { steps: 0, capped: 'error' }; }
    if (scroll.capped) base.warnings.push('scroll_limit_reached');

    if (Date.now() - started > overallTimeoutMs) return bail('render', 'overall_timeout', `전체 ${overallTimeoutMs}ms 를 넘겼습니다`);

    const html = await page.content();
    base.title = await page.title();
    base.charset = 'utf-8';   // page.content() 는 언제나 UTF-8 문자열이다

    const mark = looksBlocked(html, base.title);
    if (mark) base.warnings.push('blocked_page_suspected');
    const rendered = extractText(html);
    const errPage = detectErrorPageText(rendered.text, base.title);
    if (errPage.detected) {
      base.warnings.push('error_page_text_detected');
      base.error_page_phrase = { phrase: errPage.phrase, where: errPage.where };
    }
    if (base.redirected) base.warnings.push('redirected');
    if (base.status >= 400) base.warnings.push('http_error_status');
    if (blockedUrls.length) base.warnings.push('subresource_blocked');

    const results = {};

    // (5) 산출물. http 모드와 같은 이름·같은 계약이다.
    if (want.has('dom')) {
      const gz = zlib.gzipSync(Buffer.from(html, 'utf8'), { level: 9 });
      const a = await writeArtifact(db, { root, attemptId, kind: 'dom', name: 'dom.html.gz', data: gz, nowMs });
      results.dom = { path: a.path, byte_size: a.byte_size, original_bytes: Buffer.byteLength(html, 'utf8'), sha256: a.sha256 };
    }
    if (want.has('text')) {
      const t = extractText(html);
      const a = await writeArtifact(db, { root, attemptId, kind: 'text', name: 'text.txt', data: `${t.text}\n`, nowMs });
      results.text = {
        path: a.path, byte_size: a.byte_size, chars: t.chars, lines: t.lines,
        skipped_hidden: t.skipped_hidden, skipped_script_style: t.skipped_script_style,
      };
      if (t.chars === 0) base.warnings.push('empty_text');
      else if (isThinText(t.chars)) base.warnings.push('thin_text');
    }
    if (want.has('links')) {
      const { links, counts, base_href: baseHref } = extractLinks(html, base.final_url);
      const a = await writeArtifact(db, { root, attemptId, kind: 'link_manifest', name: 'links.jsonl', data: linksToJsonl(links), nowMs });
      results.links = { path: a.path, byte_size: a.byte_size, ...counts, base_href: baseHref };
    }
    if (want.has('images')) {
      const snapshot = await page.evaluate(DOM_IMAGE_SNAPSHOT, {
        maxScanned: imageOptions.maxScannedElements ?? BROWSER_IMAGE_DEFAULTS.max_scanned_elements,
      });
      const responses = await observer.stop();
      const img = await collectBrowserImages(db, {
        root, attemptId, snapshot, responses,
        maxImages: imageOptions.maxImages, maxImageBytes: imageOptions.maxImageBytes, nowMs,
      });
      results.images = { path: img.manifest.path, byte_size: img.manifest.byte_size, ...img.counts };
      base.warnings.push(...img.warnings);
    }

    if (want.has('screenshot')) {
      const height = await page.evaluate(() => document.body.scrollHeight);
      const tooTall = height > SHOT_MAX_HEIGHT;
      const png = await page.screenshot(tooTall
        ? { clip: { x: 0, y: 0, width: VIEWPORT.width, height: SHOT_MAX_HEIGHT } }
        : { fullPage: true });
      const a = await writeArtifact(db, { root, attemptId, kind: 'screenshot', name: 'screenshot.png', data: png, nowMs });
      results.screenshot = {
        path: a.path, byte_size: a.byte_size, sha256: a.sha256,
        viewport: VIEWPORT, device_scale: DEVICE_SCALE,
        page_height: height, captured_height: tooTall ? SHOT_MAX_HEIGHT : height,
      };
      if (tooTall) base.warnings.push('screenshot_truncated');
    }

    const produced = BROWSER_OUTPUTS.filter((o) => results[o] !== undefined);
    return {
      ...base, ok: true,
      outputs: results,
      produced,
      missing: outputs.filter((o) => !produced.includes(o)),
      requests: { allowed, blocked: blockedUrls.length, paced },
      blocked_requests: blockedUrls.slice(0, 20),
      rendered_at: Date.now(),
      scroll,
      elapsed_ms: Date.now() - started,
    };
  } catch (e) {
    return bail(e.stage ?? 'browser', e.code ?? 'browser_failed', e.message.split('\n')[0]);
  } finally {
    // 관측을 안 멈추고 판을 닫으면 읽다 만 응답이 남는다.
    // (6) 시간이 지났든 터졌든 판은 반드시 치운다. 이미 만든 파일은 그대로 남는다.
    try { if (context) await context.close(); } catch { /* 이미 닫혔으면 그만 */ }
    try { if (browser) await browser.close(); } catch { /* 같음 */ }
  }
}
