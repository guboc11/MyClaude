#!/usr/bin/env node
// 수집 시험용 로컬 가짜 사이트 — 게이트 3 의 합격 기준.
//
// 왜 로컬인가: 외부 사이트는 내일 달라진다. 달라지는 것을 합격 조건으로 쓰면 시험이 실패했을 때
// 우리 코드가 틀린 것인지 남의 사이트가 바뀐 것인지 가릴 수 없다.
//
// 태스크 #22 가 요구한 여덟 종류를 담는다. 종류마다 라우트가 하나 이상이다.
//   1 정상 정적          /static/normal · /static/plain
//   2 JS 렌더링          /js/rendered
//   3 상태 200 오류      /error/soft-404
//   4 리다이렉트         /redirect/one · /redirect/chain-3 · /redirect/loop · /redirect/to-error
//   5 404·403·429        /status/404 · /status/403 · /status/429 · /status/500 · /status/429-then-200
//   6 무한 로딩·타임아웃 /hang/headers · /hang/body · /slow/2s · /infinite/scroll
//   7 이미지 일부 실패   /images/partial
//   8 매우 긴 페이지     /long/page · /long/huge
// 그 밖은 받침 라우트다 — 링크가 가리키는 작은 쪽들, robots, 그림, 그리고 /control.
//
// 결정성 규칙 두 가지. 이 둘이 깨지면 지문 대조가 무의미해진다.
//   - 본문에 절대 URL 을 쓰지 않는다. 포트가 실행마다 달라지므로 본문에 포트가 들어가면 지문이 흔들린다.
//   - 본문에 시각·난수를 쓰지 않는다.
//
// 실행: node tests/fixtures/server.mjs [포트]
//       포트를 안 주면 빈 포트를 잡아 stdout 첫 줄에 base URL 을 적는다.
//       언제나 127.0.0.1 에만 묶는다.

import http from 'node:http';
import zlib from 'node:zlib';

// ── 조각 ──────────────────────────────────────────────────────

// 모든 쪽에 같은 머리·바닥이 붙는다. 링크 6 · 그림 6 — 본문이 없어도 이만큼은 늘 있다.
// (본문 링크만 세는 수집기는 여기서 걸린다. 실제 사이트가 이렇게 생겼다.)
const HEADER = `<header><nav>
<a href="/"><img src="/img/ok/logo.png" width="32" height="32" alt="집"></a>
<a href="/about"><img src="/img/ok/nav1.png" width="20" height="20" alt="소개"></a>
<a href="/help"><img src="/img/ok/nav2.png" width="20" height="20" alt="도움말"></a>
</nav></header>`;

const FOOTER = `<footer>
<a href="/terms"><img src="/img/ok/f1.png" width="18" height="18" alt="이용약관"></a>
<a href="/privacy"><img src="/img/ok/f2.png" width="18" height="18" alt="개인정보"></a>
<a href="/contact"><img src="/img/ok/f3.png" width="18" height="18" alt="문의"></a>
</footer>`;

const page = (title, body, head = '') =>
  `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>${title}</title>${head}</head>
<body>
${HEADER}
<main>${body}</main>
${FOOTER}
</body></html>`;

/** 카드 하나 = 링크 2 · 그림 1. */
const card = (i, href, img = `/img/ok/p${i}.png`) =>
  `<article class="card">
<a class="thumb" href="${href}"><img src="${img}" width="240" height="320" alt="디자인 ${i}"></a>
<a class="title" href="${href}">디자인 ${i}</a>
</article>`;

const grid = (n, hrefPrefix) =>
  `<div class="grid">\n${Array.from({ length: n }, (_, i) => card(i + 1, `${hrefPrefix}${i + 1}`)).join('\n')}\n</div>`;

const JSONLD = (n) => `<script type="application/ld+json">${JSON.stringify({
  '@context': 'https://schema.org',
  '@type': 'ItemList',
  itemListElement: Array.from({ length: n }, (_, i) => ({
    '@type': 'ListItem', position: i + 1,
    item: { '@type': 'Product', name: `디자인 ${i + 1}`, url: `/products/p${i + 1}` },
  })),
})}</script>`;

const ABOUT_TEXT = `<p>저희는 결혼을 앞둔 두 분을 위해 모바일 청첩장과 종이 청첩장을 함께 만드는 작은 가게입니다.
계절과 예식장 분위기에 맞춘 디자인을 꾸준히 늘려 왔습니다.</p>
<p>모바일 청첩장은 신랑 신부 소개, 예식 안내, 오시는 길, 축하 메시지, 마음 전하실 곳을 한 장에 담습니다.
종이 청첩장은 봉투와 내지를 따로 고를 수 있고, 인쇄 방식도 활판과 박, 일반 인쇄 중에서 정할 수 있습니다.</p>
<p>주문 전에 시안을 먼저 보내 드리니 천천히 보시고 고쳐야 할 곳을 알려 주세요.</p>`;

// ── 보내기 ────────────────────────────────────────────────────

const sendHtml = (res, code, html) => {
  res.writeHead(code, { 'content-type': 'text/html; charset=utf-8' });
  res.end(html);
};
const sendText = (res, code, txt, type = 'text/plain; charset=utf-8') => {
  res.writeHead(code, { 'content-type': type });
  res.end(txt);
};
const redirect = (res, to, code = 302) => {
  // 상대 경로로 보낸다. 절대 URL 이면 포트가 들어가 지문이 실행마다 달라진다.
  res.writeHead(code, { location: to, 'content-type': 'text/html; charset=utf-8' });
  res.end(page('이동', `<p>이 쪽은 <a href="${to}">다른 곳</a>으로 옮겨졌습니다.</p>`));
};

// EUC-KR 로 인코딩된 쪽. 원문(UTF-8)은 이렇다:
//   <!doctype html><html lang="ko"><head><meta charset="euc-kr"><title>옛 인코딩</title></head>
//   <body>
//   <h1>한글 인코딩 시험</h1>
//   <p>이 쪽은 EUC-KR 로 보냅니다. 글자가 깨지면 텍스트에서 바로 보입니다.</p>
//   <a href="/static/normal">목록으로</a>
//   </body></html>
const EUC_KR_PAGE = Buffer.from(
  'PCFkb2N0eXBlIGh0bWw+PGh0bWwgbGFuZz0ia28iPjxoZWFkPjxtZXRhIGNoYXJzZXQ9ImV1Yy1rciI+PHRpdGxlPr++IMDO'
  + 'xNq1+TwvdGl0bGU+PC9oZWFkPgo8Ym9keT4KPGgxPsfRsdsgwM7E2rX5IL3Dx+g8L2gxPgo8cD7AzCDCysC6IEVVQy1LUiC3'
  + 'ziC6uLPAtM+02S4gsdvA2rChILH6wfa46SDF2L26xq6/obytILnZt84gurjA1LTPtNkuPC9wPgo8YSBocmVmPSIvc3RhdGlj'
  + 'L25vcm1hbCI+uPG3z8C4t848L2E+CjwvYm9keT48L2h0bWw+Cg==',
  'base64',
);

// 1x1 투명 PNG. 고정 바이트다.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

// ── 큰 쪽은 한 번만 만들어 둔다 ────────────────────────────────
// 만들 때마다 새로 이어 붙이면 느리기도 하고, 실수로 바뀌는 값이 섞일 자리가 생긴다.

const built = new Map();
const buildOnce = (key, make) => {
  if (!built.has(key)) built.set(key, make());
  return built.get(key);
};

const LONG_CARDS = 2000;
const HUGE_TARGET_BYTES = 12 * 1024 * 1024;
const FILLER = `<p>이 문단은 아주 긴 쪽을 만들기 위한 채움 글입니다. 청첩장 종이와 인쇄 방식, 봉투 색, `
  + `글씨체를 고르는 과정을 길게 적어 두었습니다. 같은 문장이 정해진 횟수만큼 반복되므로 실행할 때마다 `
  + `같은 바이트가 나옵니다. 이 쪽은 응답 크기 상한과 텍스트 잘림 표시를 시험하는 자리입니다.</p>\n`;

// ── 라우트 ────────────────────────────────────────────────────

// 홀딩 중인 응답. 프로세스를 끝낼 때 반드시 끊어 준다 — 안 그러면 서버가 안 죽는다.
const held = new Set();
const holdForever = (req, res, writeSomething) => {
  held.add(res);
  res.on('close', () => held.delete(res));
  if (writeSomething) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.write(`<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>도중에 멈춤</title></head>\n<body>\n${HEADER}\n<main><h1>여기까지만 왔습니다`);
  }
  // 그 뒤로 아무것도 하지 않는다. 부른 쪽이 스스로 끊어야 끝난다.
};

const hits = new Map();
const flaky = new Map();

const ROUTES = {
  '/': (req, res) => sendHtml(res, 200, page('가짜 청첩장 가게',
    `<h1>가짜 청첩장 가게</h1>${ABOUT_TEXT}
<p>목록에서 마음에 드는 디자인을 고르신 뒤 문의를 남겨 주세요.</p>`)),

  // ── 1. 정상 정적 ────────────────────────────────────────────
  '/static/normal': (req, res) => sendHtml(res, 200, page('청첩장 목록',
    `<h1>청첩장</h1><p class="count">총 12개</p>\n${grid(12, '/products/p')}`,
    JSONLD(12))),

  // 같은 모양인데 JSON-LD 가 없다. 구조만 보고도 같은 수가 나와야 한다.
  '/static/plain': (req, res) => sendHtml(res, 200, page('청첩장 목록(구조만)',
    `<h1>청첩장</h1><p class="count">총 12개</p>\n${grid(12, '/products/q')}`)),

  // ── 2. JS 렌더링 ────────────────────────────────────────────
  // HTTP 로 받으면 본문이 비어 있고, 브라우저로 열어야 카드 12장이 생긴다.
  '/js/rendered': (req, res) => sendHtml(res, 200, page('동적 목록',
    '<div id="app"></div>',
    `<script>
window.addEventListener('DOMContentLoaded', () => {
  const app = document.getElementById('app');
  app.innerHTML = ${JSON.stringify(`<p class="count">총 12개</p>\n${grid(12, '/products/j')}`)};
});
</script>`)),

  // ── 3. 상태 200 인데 화면은 오류 ────────────────────────────
  // 회귀 표본 R-FALSE-200-ERROR 와 같은 사례다. 본문을 일부러 길게 둔다 —
  // 글이 짧아서 걸리면 "오류 문구를 봤는가" 를 확인할 수 없다.
  '/error/soft-404': (req, res) => sendHtml(res, 200, page('Whoops',
    `<h1>Whoops... Something went wrong</h1>
<p>We couldn't find the page you requested. Please check the address and try again.</p>
<p>주문 조회, 배송 안내, 교환 및 반품 정책은 고객센터에서 확인하실 수 있습니다. 영업일 기준 평일
오전 열 시부터 오후 여섯 시까지 상담이 가능하며, 주말과 공휴일에는 게시판으로 문의를 남겨 주시면
다음 영업일에 순차적으로 답변드립니다.</p>
<p>청첩장 제작 과정과 종이 견본 신청 방법, 배송 일정에 대한 자세한 안내는 도움말 페이지에 정리되어
있습니다. 자주 묻는 질문을 먼저 살펴보시면 더 빠르게 해결하실 수 있습니다.</p>
<p>이 페이지가 계속 보인다면 브라우저를 새로 고치거나 잠시 후 다시 시도해 주세요.</p>`)),

  // ── 4. 리다이렉트 ───────────────────────────────────────────
  '/redirect/one': (req, res) => redirect(res, '/redirect/arrived'),
  '/redirect/chain-3': (req, res) => redirect(res, '/redirect/chain-2'),
  '/redirect/chain-2': (req, res) => redirect(res, '/redirect/chain-1'),
  '/redirect/chain-1': (req, res) => redirect(res, '/redirect/arrived'),
  '/redirect/loop': (req, res) => redirect(res, '/redirect/loop'),
  // 요청한 곳과 도착한 곳이 다르고, 도착한 곳이 오류 화면이다 — 회귀 표본 R-FALSE-REDIRECT-MISMATCH.
  '/redirect/to-error': (req, res) => redirect(res, '/error/soft-404'),
  '/redirect/permanent': (req, res) => redirect(res, '/redirect/arrived', 301),
  // 위험한 곳으로 보내는 리다이렉트. 첫 홉이 안전했다고 따라가면 안 되는 자리다(#25).
  '/redirect/private': (req, res) => redirect(res, 'http://10.0.0.5/x'),
  '/redirect/other-port': (req, res) => redirect(res, 'http://127.0.0.1:9/x'),
  '/redirect/scheme': (req, res) => redirect(res, 'ftp://example.com/x'),
  '/redirect/no-location': (req, res) => {
    res.writeHead(302, { 'content-type': 'text/html; charset=utf-8' });   // Location 이 없다
    res.end(page('어디로?', '<p>갈 곳을 안 알려 준다.</p>'));
  },
  '/redirect/arrived': (req, res) => sendHtml(res, 200, page('청첩장 목록(도착)',
    `<h1>청첩장</h1><p class="count">총 12개</p>\n${grid(12, '/products/r')}`, JSONLD(12))),

  // ── 5. 404·403·429 ──────────────────────────────────────────
  // 상태가 오류여도 본문은 온다. 수집 자체는 끝날 수 있고, 유효성 판정은 에이전트 몫이다.
  '/status/404': (req, res) => sendHtml(res, 404, page('404 Not Found',
    '<h1>404 Not Found</h1><p>요청하신 쪽을 찾을 수 없습니다.</p>')),
  '/status/403': (req, res) => sendHtml(res, 403, page('403 Forbidden',
    '<h1>403 Forbidden</h1><p>접근 권한이 없습니다.</p>')),
  '/status/500': (req, res) => sendHtml(res, 500, page('500 Internal Server Error',
    '<h1>500 Internal Server Error</h1><p>잠시 후 다시 시도해 주세요.</p>')),
  '/status/429': (req, res) => {
    res.writeHead(429, { 'content-type': 'text/html; charset=utf-8', 'retry-after': '1' });
    res.end(page('429 Too Many Requests', '<h1>429 Too Many Requests</h1><p>요청이 너무 잦습니다.</p>'));
  },

  // 두 번 막고 세 번째부터 준다. 세는 단위가 key 라서, 시험마다 새 key 를 쓰면
  // 전역 상태를 지우지 않고도 언제나 같은 순서를 본다.
  '/status/429-then-200': (req, res, url) => {
    const key = url.searchParams.get('key') || '';
    if (!key) return sendText(res, 400, 'key 파라미터가 필요합니다');
    const n = (flaky.get(key) || 0) + 1;
    flaky.set(key, n);
    if (n <= 2) {
      res.writeHead(429, { 'content-type': 'text/html; charset=utf-8', 'retry-after': '1' });
      return res.end(page('429 Too Many Requests', `<h1>429 Too Many Requests</h1><p>${n}번째 시도입니다.</p>`));
    }
    return sendHtml(res, 200, page('청첩장 목록(재시도 성공)',
      `<h1>청첩장</h1><p class="count">총 12개</p>\n${grid(12, '/products/f')}`));
  },

  // ── 6. 무한 로딩·타임아웃 ───────────────────────────────────
  // 머리조차 안 보낸다 — connect 는 되는데 아무 응답이 없는 자리.
  '/hang/headers': (req, res) => holdForever(req, res, false),
  // 머리와 본문 앞부분만 보내고 멈춘다 — 도중에 끊긴 응답.
  '/hang/body': (req, res) => holdForever(req, res, true),
  // 2초 뒤에 정상 응답. 상한이 2초보다 짧으면 걸리고 길면 통과해야 한다.
  '/slow/2s': (req, res) => {
    const t = setTimeout(() => sendHtml(res, 200, page('느린 쪽',
      `<h1>느리게 온 목록</h1><p class="count">총 12개</p>\n${grid(12, '/products/s')}`)), 2000);
    res.on('close', () => clearTimeout(t));
  },
  // 바닥에 닿을 때마다 늘어난다 — 종료 조건이 없으면 브라우저 수집이 영영 안 끝난다.
  '/infinite/scroll': (req, res) => sendHtml(res, 200, page('무한 목록',
    '<div class="grid" id="g"></div>',
    `<script>
window.addEventListener('DOMContentLoaded', () => {
  let n = 0;
  const g = document.getElementById('g');
  const add = () => {
    for (let i = 0; i < 8; i++) {
      n++;
      g.insertAdjacentHTML('beforeend',
        '<article class="card" style="height:320px"><a href="/products/inf' + n + '">'
        + '<img src="/img/ok/p1.png" width="240" height="320" alt="디자인 ' + n + '"></a>'
        + '<a class="title" href="/products/inf' + n + '">디자인 ' + n + '</a></article>');
    }
  };
  add();
  addEventListener('scroll', () => {
    if (scrollY + innerHeight > document.body.scrollHeight - 400) add();
  });
});
</script>`)),

  // ── 7. 이미지 일부 실패 ─────────────────────────────────────
  // 그림 8장을 걸어 두고 4장만 정상이다. 3장은 404, 1장은 받다 만다.
  '/images/partial': (req, res) => {
    const cards = [
      card(1, '/products/m1', '/img/ok/p1.png'),
      card(2, '/products/m2', '/img/ok/p2.png'),
      card(3, '/products/m3', '/img/ok/p3.png'),
      card(4, '/products/m4', '/img/ok/p4.png'),
      card(5, '/products/m5', '/img/fail/p5.png'),
      card(6, '/products/m6', '/img/fail/p6.png'),
      card(7, '/products/m7', '/img/fail/p7.png'),
      card(8, '/products/m8', '/img/truncated/p8.png'),
    ].join('\n');
    sendHtml(res, 200, page('그림이 일부 빠진 목록',
      `<h1>그림 일부 실패</h1><p class="count">총 8개</p>\n<div class="grid">\n${cards}\n</div>`));
  },

  // ── 8. 매우 긴 페이지 ───────────────────────────────────────
  '/long/page': (req, res) => sendHtml(res, 200, buildOnce('long', () => page('아주 긴 목록',
    `<h1>아주 긴 목록</h1><p class="count">총 ${LONG_CARDS}개</p>\n${grid(LONG_CARDS, '/products/L')}`))),

  '/long/huge': (req, res) => sendHtml(res, 200, buildOnce('huge', () => {
    const repeat = Math.ceil(HUGE_TARGET_BYTES / Buffer.byteLength(FILLER, 'utf8'));
    return page('아주 무거운 쪽', `<h1>아주 무거운 쪽</h1>\n${FILLER.repeat(repeat)}`);
  })),

  // ── 받침 라우트 ─────────────────────────────────────────────
  '/about': (req, res) => sendHtml(res, 200, page('소개', `<h1>소개</h1>${ABOUT_TEXT}`)),
  '/help': (req, res) => sendHtml(res, 200, page('도움말',
    '<h1>도움말</h1><p>주문과 배송에 대한 안내입니다.</p>')),
  '/terms': (req, res) => sendHtml(res, 200, page('이용약관',
    '<h1>이용약관</h1><p>서비스 이용에 관한 약속입니다.</p>')),
  '/privacy': (req, res) => sendHtml(res, 200, page('개인정보 처리방침',
    '<h1>개인정보 처리방침</h1><p>수집하는 정보와 보관 기간입니다.</p>')),
  '/contact': (req, res) => sendHtml(res, 200, page('문의',
    '<h1>문의</h1><p>평일 오전 열 시부터 오후 여섯 시까지 상담합니다.</p>')),

  // 브라우저로 열어야만 보이는 그림 갈래(#30).
  //   currentSrc 로 고른 판 · CSS 배경(마크업에 <img> 가 없다) · 화면 밖 lazy · 리다이렉트 · 실패 · data URI
  '/images/browser': (req, res) => sendHtml(res, 200,
    `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>브라우저 그림</title>
<meta property="og:image" content="/img/ok/og-browser.png">
<style>.bg { width: 200px; height: 120px; background-image: url("/img/ok/css-bg.png"); }
.spacer { height: 20000px; }</style></head>
<body>
<main>
<img src="/img/ok/plain.png" width="80" height="60" alt="그냥 그림">
<img src="/img/ok/one-x.png" srcset="/img/ok/one-x.png 1x, /img/ok/two-x.png 2x" width="80" height="60" alt="배율 갈래">
<picture>
<source srcset="/img/ok/chosen.webp" type="image/webp">
<img src="/img/ok/fallback.png" width="80" height="60" alt="picture 갈래">
</picture>
<div class="bg"></div>
<img src="/img/redirect/moved.png" width="80" height="60" alt="옮겨진 그림">
<img src="/img/fail/gone.png" width="80" height="60" alt="없는 그림">
<img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" alt="문서 안에 든 그림">
<div class="spacer"></div>
<img src="/img/ok/below-fold.png" loading="lazy" width="80" height="60" alt="화면 밖 그림">
</main>
</body></html>`),

  // 그림 참조 갈래를 한 쪽에 모아 둔다(#27). 머리바닥을 붙이지 않아 세기가 단순하다.
  // 같은 주소를 두 번 걸어 두었고(중복), 리다이렉트·엉뚱한 형식·404·큰 파일·data URI 가 섞여 있다.
  '/images/rich': (req, res) => sendHtml(res, 200,
    `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>그림 모음</title>
<meta property="og:image" content="/img/ok/og.png">
<meta property="og:image:alt" content="대표 그림"></head>
<body>
<main>
<img src="/img/ok/p1.png" width="60" height="60" alt="첫째">
<img src="/img/ok/p1.png" width="30" height="30" alt="첫째를 다시">
<img src="/img/ok/p2.png" srcset="/img/ok/p2.png 1x, /img/ok/p2@2x.png 2x" width="60" height="60" alt="두 배 판이 있는 그림">
<picture>
<source srcset="/img/ok/p3.webp 1x, /img/ok/p3-wide.webp 2x" type="image/webp">
<img src="/img/ok/p3.png" width="60" height="60" alt="갈래가 있는 그림">
</picture>
<img src="/img/redirect/p4.png" width="60" height="60" alt="옮겨진 그림">
<img src="/img/wrong-mime/p5.png" width="60" height="60" alt="그림이 아닌 그림">
<img src="/img/fail/p6.png" width="60" height="60" alt="없는 그림">
<img src="/img/large/p7.png" width="60" height="60" alt="아주 큰 그림">
<img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" alt="문서 안에 든 그림">
<img alt="주소 없는 그림">
</main>
</body></html>`),

  // 링크 종류를 한 쪽에 모아 둔다(#26). 머리바닥을 붙이지 않아 세기가 단순하다.
  '/links/mixed': (req, res) => sendHtml(res, 200,
    `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>링크 모음</title></head>
<body>
<nav><a href="/static/normal">목록</a></nav>
<main>
<p><a href="products/p1">상대 경로</a></p>
<p><a href="/static/plain">뿌리 경로</a></p>
<p><a href="https://example.com/outside">바깥 쪽</a></p>
<p><a href="//example.org/protocol-relative">규약 생략</a></p>
<p><a href="#section-2">같은 쪽 자리표</a></p>
<p><a href="/static/normal#tail">자리표가 붙은 내부 링크</a></p>
<p><a href="mailto:hello@example.com">메일</a></p>
<p><a href="tel:+821012345678">전화</a></p>
<p><a href="javascript:void(0)">스크립트</a></p>
<p><a href="">빈 주소</a></p>
<p><a>주소 없음</a></p>
<p><a href="/products/q1"><img src="/img/ok/p1.png" width="60" height="60" alt="그림으로만 된 링크"></a></p>
</main>
<footer><a href="/contact">문의</a></footer>
</body></html>`),

  // <base href> 가 상대 링크의 기준을 바꾼다.
  '/links/with-base': (req, res) => sendHtml(res, 200,
    `<!doctype html><html lang="ko"><head><meta charset="utf-8"><base href="/deep/nested/"><title>기준 주소</title></head>
<body><p><a href="page">상대</a> <a href="/root">뿌리</a></p></body></html>`),

  // UTF-8 이 아닌 쪽. 인코딩을 안 보고 읽으면 텍스트가 통째로 깨진다(#26).
  // 바이트를 그대로 박아 둔다 — 실행 때 변환하면 iconv 유무에 따라 결과가 달라진다.
  '/encoding/euc-kr': (req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=euc-kr' });
    res.end(EUC_KR_PAGE);
  },
  // 같은 바이트인데 머리에는 charset 이 없다. <meta charset> 을 봐야 읽힌다.
  '/encoding/meta-charset': (req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(EUC_KR_PAGE);
  },

  // robots 는 #25 의 차단 기록 시험이 쓴다.
  '/robots.txt': (req, res) => sendText(res, 200,
    'User-agent: *\nDisallow: /private/\nDisallow: /hang/\nAllow: /\n'
    + 'Sitemap: /sitemaps/from-robots.xml\n'
    + 'Sitemap: /sitemaps/from-robots.xml\n'
    // 같은 도메인이 못 읽는 sitemap 도 하나 선언한다. 실제 사이트에서 흔하고,
    // "못 읽은 것을 0건 완료로 바꾸지 않는가" 를 재려면 못 읽는 것이 실제로 있어야 한다.
    + 'Sitemap: /sitemaps/broken.xml\n'),
  '/private/page': (req, res) => sendHtml(res, 200, page('막아 둔 쪽',
    '<h1>robots 가 막은 쪽</h1><p>수집하면 robots_disallowed 로 남아야 합니다.</p>')),
};

// ── 제어 ──────────────────────────────────────────────────────
// 시험이 서버 쪽 사실을 확인하고 상태를 되돌리는 자리. 사이트의 일부가 아니다.

const CONTROL = {
  '/control/hits': (req, res) => sendText(res, 200, JSON.stringify(Object.fromEntries(hits)), 'application/json; charset=utf-8'),

  // 받은 요청 머리를 그대로 돌려준다. Host 가 IP 가 아니라 원래 이름 그대로인지,
  // 쿠키가 따라오지 않는지를 서버 쪽에서 확인하는 자리다(#25). 응답이 요청마다 달라지므로
  // 사이트 라우트가 아니라 제어 라우트다 — 지문 대조 대상이 아니다.
  '/control/echo': (req, res) => sendText(res, 200,
    JSON.stringify({ method: req.method, url: req.url, headers: req.headers }), 'application/json; charset=utf-8'),

  // 쿠키를 심어 놓고 다른 곳으로 보낸다. 따라간 요청에 쿠키가 실리면 안 된다.
  '/control/set-cookie': (req, res) => {
    res.writeHead(302, {
      'set-cookie': ['sid=must-not-travel; Path=/', 'tracker=nope; Path=/'],
      location: '/control/echo',
      'content-type': 'text/html; charset=utf-8',
    });
    res.end('이동');
  },
  '/control/reset': (req, res) => {
    hits.clear();
    flaky.clear();
    sendText(res, 200, 'reset');
  },
  '/control/release-hangs': (req, res) => {
    const n = held.size;
    for (const r of held) r.destroy();
    held.clear();
    sendText(res, 200, String(n));
  },
};

// ── 서버 ──────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const p = url.pathname;

  // 제어 라우트는 세지 않는다. 세면 "몇 번 두드렸나" 가 시험 도구 때문에 흐려진다.
  const control = CONTROL[p];
  if (control) return control(req, res, url);

  hits.set(p, (hits.get(p) || 0) + 1);

  if (p.startsWith('/img/ok/')) {
    res.writeHead(200, { 'content-type': 'image/png', 'content-length': PNG.length });
    return res.end(PNG);
  }
  if (p.startsWith('/img/fail/')) return sendText(res, 404, '없는 그림입니다');
  // 옮겨진 그림 — 그림도 리다이렉트를 탄다(#27).
  if (p.startsWith('/img/redirect/')) return redirect(res, '/img/ok/p1.png');
  // 그림이라고 걸어 뒀는데 오는 것은 HTML 이다. 형식만 믿으면 이런 것이 그림으로 저장된다.
  if (p.startsWith('/img/wrong-mime/')) return sendHtml(res, 200, page('그림이 아님', '<h1>여기는 그림이 아닙니다</h1>'));
  // 아주 큰 그림 — 크기 상한에 걸려야 한다.
  if (p.startsWith('/img/large/')) {
    const big = buildOnce('big-image', () => Buffer.concat([PNG.subarray(0, 8), Buffer.alloc(3 * 1024 * 1024, 0x41)]));
    res.writeHead(200, { 'content-type': 'image/png', 'content-length': big.length });
    return res.end(big);
  }
  if (p.startsWith('/img/truncated/')) {
    // 길이를 크게 적어 두고 앞부분만 보낸 뒤 끊는다 — 받다 만 파일이 정상 artifact 로
    // 올라가는지 보는 자리다.
    res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(PNG.length) });
    res.write(PNG.subarray(0, 20));
    return res.socket.destroy();
  }

  // ── sitemap 묶음(#33) ────────────────────────────────────────
  // 규격상 <loc> 는 절대 URL 이라 Host 머리로 만든다. 그래서 본문에 포트가 들어가고,
  // 이 라우트들만 지문 대조(drift)에서 빠진다 — 대신 **개수 계약**이 manifest 에 있다.
  if (p.startsWith('/sitemaps/') || p === '/sitemap.xml') {
    const origin = `http://${req.headers.host}`;
    const urlset = (entries) => `<?xml version="1.0" encoding="UTF-8"?>\n`
      + `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n`
      + entries.join('\n') + `\n</urlset>\n`;
    const index = (locs) => `<?xml version="1.0" encoding="UTF-8"?>\n`
      + `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n`
      + locs.map((l) => `<sitemap><loc>${l}</loc></sitemap>`).join('\n') + `\n</sitemapindex>\n`;
    const sendXml = (xml) => { res.writeHead(200, { 'content-type': 'application/xml; charset=utf-8' }); res.end(xml); };

    if (p === '/sitemap.xml') {
      return sendXml(index([
        `${origin}/sitemaps/urls-a.xml`,
        `${origin}/sitemaps/urls-b.xml.gz`,
        `${origin}/sitemaps/nested.xml`,
        `${origin}/sitemaps/broken.xml`,
        `${origin}/sitemaps/moved.xml`,
      ]));
    }
    if (p === '/sitemaps/from-robots.xml') {
      // 정규화 세 갈래(상대·자리표·추적 파라미터)를 여기 함께 둔다 — 게이트 4 가 지도 결과에서 잰다.
      return sendXml(urlset([
        `<url><loc>${origin}/r/1</loc><lastmod>2026-08-01</lastmod></url>`,
        `<url><loc>${origin}/r/2</loc></url>`,
        `<url><loc>${origin}/r/3</loc><lastmod>2026-08-02</lastmod></url>`,
        '<url><loc>/r/relative</loc></url>',
        `<url><loc>${origin}/r/frag#section</loc></url>`,
        `<url><loc>${origin}/r/dup?utm_source=x</loc></url>`,
        `<url><loc>${origin}/r/dup</loc></url>`,
      ]));
    }
    if (p === '/sitemaps/urls-a.xml') {
      const e = [];
      e.push('<url><loc>/rel/one</loc></url>');                                   // 상대 주소
      e.push(`<url><loc>${origin}/dup?utm_source=x</loc></url>`);                 // 추적 파라미터
      e.push(`<url><loc>${origin}/dup</loc></url>`);                              // 위와 같은 주소
      e.push(`<url><loc>${origin}/goods?goodsNo=300&amp;color=red</loc></url>`);  // 실체 참조
      for (let i = 5; i <= 40; i++) e.push(`<url><loc>${origin}/p/${i}</loc><lastmod>2026-08-0${(i % 9) + 1}</lastmod></url>`);
      return sendXml(urlset(e));
    }
    if (p === '/sitemaps/urls-b.xml.gz') {
      const xml = urlset(Array.from({ length: 10 }, (_, i) => `<url><loc>${origin}/b/${i + 1}</loc></url>`));
      const gz = buildOnce(`gz-${req.headers.host}`, () => zlib.gzipSync(Buffer.from(xml, 'utf8'), { level: 9 }));
      res.writeHead(200, { 'content-type': 'application/gzip', 'content-length': gz.length });
      return res.end(gz);
    }
    if (p === '/sitemaps/nested.xml') return sendXml(index([`${origin}/sitemaps/deep-1.xml`]));
    if (p === '/sitemaps/deep-1.xml') return sendXml(index([`${origin}/sitemaps/deep-2.xml`]));
    if (p === '/sitemaps/deep-2.xml') {
      return sendXml(urlset(Array.from({ length: 5 }, (_, i) => `<url><loc>${origin}/n/${i + 1}</loc></url>`)));
    }
    // 상태 200 인데 사이트맵이 아니다. 상태만 보면 통과시키게 되는 자리.
    if (p === '/sitemaps/broken.xml') return sendHtml(res, 200, page('일시 오류', '<h1>Something went wrong</h1>'));
    if (p === '/sitemaps/moved.xml') return redirect(res, '/sitemaps/urls-a.xml');
    // 자기 자신과 뿌리 색인을 함께 가리킨다 — 고리.
    if (p === '/sitemaps/loop.xml') return sendXml(index([`${origin}/sitemaps/loop.xml`, `${origin}/sitemap.xml`]));
    // 형제가 많은 색인. 파일 수 상한을 시험한다.
    if (p === '/sitemaps/wide.xml') {
      return sendXml(index(Array.from({ length: 30 }, (_, i) => `${origin}/sitemaps/w/${i + 1}.xml`)));
    }
    const w = p.match(/^\/sitemaps\/w\/(\d+)\.xml$/);
    if (w) return sendXml(urlset([`<url><loc>${origin}/w/${w[1]}</loc></url>`]));
    return sendHtml(res, 404, page('404', '<h1>없는 사이트맵</h1>'));
  }

  // 서로 다른 쪽 여럿이 필요할 때 쓴다(#32 교차 연결 시험). 번호마다 고유한 표지가 들어 있다.
  const uniq = p.match(/^\/unique\/(\d+)$/);
  if (uniq) {
    const n = Number(uniq[1]);
    return sendHtml(res, 200, page(`고유 항목 ${n}`,
      `<h1>고유 항목 ${n}</h1><p class="marker">MARKER-${n}-ONLY</p>
<p>이 쪽에만 있는 표지입니다. 다른 번호의 자료에 이 글자가 나오면 자료가 섞인 것입니다.</p>
<a href="/unique/${n + 1}">다음 항목</a>`));
  }

  const handler = ROUTES[p];
  if (handler) return handler(req, res, url);

  return sendHtml(res, 404, page('404 Not Found', '<h1>404 Not Found</h1><p>없는 쪽입니다.</p>'));
});

const shutdown = () => {
  for (const r of held) r.destroy();
  held.clear();
  server.close(() => process.exit(0));
  // 남은 연결이 붙잡고 있으면 close 가 안 끝난다. 짧게 기다리고 끝낸다.
  setTimeout(() => process.exit(0), 300).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

const port = Number(process.argv[2]) || 0;
server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`http://127.0.0.1:${server.address().port}\n`);
});
