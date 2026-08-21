#!/usr/bin/env node
// 로컬 가짜 사이트 — 게이트 2의 유일한 합격 기준
// 계획서 게이트 2. 외부 사이트(minted 의 Cloudflare 등)는 내일 달라지므로 합격 조건으로 쓰지 않는다.
//
// PLAN 의 다섯 페이지 + 태스크 7에서 더한 함정 두 개 = 일곱.
//   1 정상 목록(JSON-LD 있음)      /listing-jsonld
//   1' 정상 목록(JSON-LD 없음)     /listing-plain
//   2 상태 200 인 오류 페이지       /soft404
//   3 홈으로 튕기는 상세            /products/gone
//   4 JS 실행 전 비어 있는 페이지    /js-only
//   5 403·429 재시도                /flaky
//   6 [함정] 카드 두 개짜리 목록     /listing-two
//   7 [함정] nav·footer 에 이미지+링크 반복  /nav-trap
//   + 애매한 페이지                 /ambiguous   (needs_visual_review 가 실제로 쌓이는지 보려고)
//
// 실행: node fixtures/server.mjs [포트]   — 포트를 안 주면 빈 포트를 잡아 stdout 첫 줄에 알린다.

import http from 'node:http';

const IMG = (n) => `/img/${n}.png`;

function card(i, href) {
  return `<article class="card">
    <a href="${href}"><img src="${IMG(i)}" width="240" height="320" alt="상품 ${i}"></a>
    <a class="title" href="${href}">디자인 ${i}</a>
  </article>`;
}

function page(title, body, head = '') {
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>${title}</title>${head}</head>
<body>
<header><nav><a href="/"><img src="/img/logo.png" width="32" height="32" alt="로고"></a>
  <a href="/about"><img src="/img/i1.png" width="20" height="20" alt="소개"></a>
  <a href="/help"><img src="/img/i2.png" width="20" height="20" alt="도움말"></a></nav></header>
<main>${body}</main>
<footer><a href="https://x.example/1"><img src="/img/s1.png" width="18" height="18" alt="sns1"></a>
  <a href="https://x.example/2"><img src="/img/s2.png" width="18" height="18" alt="sns2"></a>
  <a href="https://x.example/3"><img src="/img/s3.png" width="18" height="18" alt="sns3"></a></footer>
</body></html>`;
}

const JSONLD = (n) => `<script type="application/ld+json">${JSON.stringify({
  '@context': 'https://schema.org', '@type': 'ItemList',
  itemListElement: Array.from({ length: n }, (_, i) => ({
    '@type': 'ListItem', position: i + 1,
    item: { '@type': 'Product', name: `디자인 ${i + 1}`, url: `/products/p${i + 1}` },
  })),
})}</script>`;

const flakyHits = new Map();

const ROUTES = {
  // 홈은 "정상인 쪽"의 본보기다. 글이 너무 짧으면 판정기가 thin_text 로 invalid 를 주고,
  // 그러면 정상 홈에서 링크를 거두는 시험 자체가 성립하지 않는다. 오류 문구 없이 충분히 적는다.
  '/': (req, res) => send(res, 200, page('홈',
    `<h1>가짜 청첩장 가게</h1>
     <p>안녕하세요. 저희는 결혼을 앞둔 두 분을 위해 모바일 청첩장과 종이 청첩장을 함께 만드는
     작은 가게입니다. 2014년에 문을 열어 지금까지 여러 쌍의 예식을 도왔고, 계절과 예식장 분위기에
     맞춘 디자인을 꾸준히 늘려 왔습니다.</p>
     <p>모바일 청첩장은 신랑 신부 소개, 예식 안내, 오시는 길, 축하 메시지, 마음 전하실 곳을
     한 장에 담습니다. 종이 청첩장은 봉투와 내지를 따로 고를 수 있고, 인쇄 방식도 활판과 박,
     일반 인쇄 중에서 정할 수 있습니다. 주문 전에 시안을 먼저 보내 드리니 천천히 보시고
     고쳐야 할 곳을 알려 주세요.</p>
     <p>목록에서 마음에 드는 디자인을 고르신 뒤 문의를 남기시면, 담당자가 하루 안에 답을 드립니다.</p>
     <p><a href="/listing-jsonld">청첩장 목록</a> · <a href="/hidden-only-linked">사이트맵에 없는 쪽</a></p>`)),

  // 1. 정상 목록 — JSON-LD 있음. 카드 12개, 표시 수도 명시
  '/listing-jsonld': (req, res) => send(res, 200, page('청첩장 목록',
    `<h1>청첩장</h1><p class="count">총 12개</p><div class="grid">
     ${Array.from({ length: 12 }, (_, i) => card(i + 1, `/products/p${i + 1}`)).join('')}</div>`,
    JSONLD(12))),

  // 1'. 정상 목록 — JSON-LD 없음. 반복 DOM 만으로 판정돼야 한다
  '/listing-plain': (req, res) => send(res, 200, page('청첩장 목록(구조만)',
    `<h1>청첩장</h1><p class="count">총 12개</p><div class="grid">
     ${Array.from({ length: 12 }, (_, i) => card(i + 1, `/products/q${i + 1}`)).join('')}</div>`)),

  // 2. 상태 200 인 오류 페이지 — 실제 greenvelope 가 이랬다.
  // [중요] 본문을 일부러 길게 둔다. 텍스트가 짧아서 걸리면 "오류 문구 판정"이 실제로 도는지
  // 확인할 수 없다(음성 대조가 무의미해진다). 오직 문구로만 걸려야 한다.
  '/soft404': (req, res) => send(res, 200, page('Whoops',
    `<h1>Whoops... Something went wrong</h1>
     <p>We couldn't find the page you requested. Please check the address and try again.</p>
     <p>주문 조회, 배송 안내, 교환 및 반품 정책은 고객센터에서 확인하실 수 있습니다.
        영업일 기준 평일 오전 열 시부터 오후 여섯 시까지 상담이 가능하며, 주말과 공휴일에는
        게시판으로 문의를 남겨 주시면 다음 영업일에 순차적으로 답변드립니다.</p>
     <p>청첩장 제작 과정과 종이 견본 신청 방법, 배송 일정에 대한 자세한 안내는 도움말 페이지에
        정리되어 있습니다. 자주 묻는 질문을 먼저 살펴보시면 더 빠르게 해결하실 수 있습니다.</p>
     <p>이 페이지가 계속 보인다면 브라우저를 새로 고치거나 잠시 후 다시 시도해 주세요.</p>`)),

  // 3. 홈으로 튕기는 상세
  '/products/gone': (req, res) => { res.writeHead(302, { Location: '/' }); res.end(); },

  // 4. JS 실행 전에는 비어 있는 페이지
  '/js-only': (req, res) => send(res, 200, page('동적 목록',
    '<div id="app"></div>',
    `<script>
      window.addEventListener('DOMContentLoaded', () => {
        const g = document.createElement('div'); g.className = 'grid';
        g.innerHTML = ${JSON.stringify(Array.from({ length: 12 }, (_, i) => card(i + 1, `/products/j${i + 1}`)).join(''))};
        const c = document.createElement('p'); c.className='count'; c.textContent='총 12개';
        document.getElementById('app').append(c, g);
      });
    </script>`)),

  // 5. 403·429 — 처음 두 번은 429(Retry-After), 세 번째부터 정상
  '/flaky': (req, res) => {
    const key = 'flaky';
    const n = (flakyHits.get(key) || 0) + 1;
    flakyHits.set(key, n);
    if (n <= 2) {
      res.writeHead(429, { 'Retry-After': '1', 'content-type': 'text/html; charset=utf-8' });
      return res.end(page('Too Many Requests', '<h1>429 Too Many Requests</h1>'));
    }
    return send(res, 200, page('청첩장 목록', `<p class="count">총 12개</p><div class="grid">
      ${Array.from({ length: 12 }, (_, i) => card(i + 1, `/products/f${i + 1}`)).join('')}</div>`, JSONLD(12)));
  },
  '/forbidden': (req, res) => send(res, 403, page('Forbidden', '<h1>403 Forbidden</h1>')),

  // 6. [함정] 카드가 두 개뿐인 정상 목록 — "N개 이상"으로 자르면 여기서 틀린다
  '/listing-two': (req, res) => send(res, 200, page('신상품',
    `<h1>신상품</h1><p class="count">총 2개</p><div class="grid">
     ${card(1, '/products/n1')}${card(2, '/products/n2')}</div>`)),

  // + [함정] 페이지 나눔 — "총 56개"라 적혀 있는데 이 쪽에는 12개만 보인다.
  // deardeer.kr 이 실제로 이랬다. 이 차이를 페이지 잘못으로 보면 멀쩡한 목록을 버린다.
  '/listing-paged': (req, res) => send(res, 200, page('청첩장 목록(1/5)',
    `<h1>청첩장</h1><p class="count">총 56개</p><div class="grid">
     ${Array.from({ length: 12 }, (_, i) => card(i + 1, `/products/pg${i + 1}`)).join('')}</div>
     <nav class="pager"><a href="/listing-paged?page=2">2</a><a href="/listing-paged?page=3">3</a></nav>`)),

  // 7. [함정] 본문에는 상품이 없고 nav·footer 에만 이미지+링크가 반복된다
  '/nav-trap': (req, res) => send(res, 200, page('회사 소개',
    '<h1>회사 소개</h1><p>저희는 청첩장을 만듭니다. 상품 목록은 다른 곳에 있습니다.</p>')),

  // + [함정] 스크롤할 때마다 높이가 늘어나는 페이지 — 종료 보장이 없으면 영영 안 끝난다.
  // (2026-08-11 deardeer.kr 에서 실제로 스크롤 루프가 안 끝나 관찰이 중단됐다.)
  '/infinite': (req, res) => send(res, 200, page('무한 목록',
    '<div class="grid" id="g"></div>',
    `<script>
      // script 가 head 에 있으므로 DOM 이 준비된 뒤에 붙여야 한다(/js-only 와 같은 이유)
      window.addEventListener('DOMContentLoaded', () => {
        let n = 0;
        const g = document.getElementById('g');
        function add() {
          for (let i = 0; i < 8; i++) {
            n++;
            g.insertAdjacentHTML('beforeend',
              '<article class="card" style="height:320px"><a href="/products/inf' + n + '">' +
              '<img src="/img/' + n + '.png" width="240" height="320" alt="상품 ' + n + '"></a>' +
              '<a class="title" href="/products/inf' + n + '">디자인 ' + n + '</a></article>');
          }
        }
        add();
        // 바닥 근처로 내려올 때마다 더 붙인다 — scrollHeight 가 끝없이 늘어난다
        addEventListener('scroll', () => {
          if (scrollY + innerHeight > document.body.scrollHeight - 400) add();
        });
      });
    </script>`)),

  // + 애매한 페이지 — 이미지+링크 묶음이 둘인데 경로가 제각각이고 표시 수도 없다
  '/ambiguous': (req, res) => send(res, 200, page('소식',
    `<h1>소식</h1>
     <div><a href="/notice/1"><img src="${IMG('a')}" width="200" height="120" alt="공지"></a><a href="/notice/1">공지사항</a></div>
     <div><a href="/blog/xyz"><img src="${IMG('b')}" width="200" height="120" alt="블로그"></a><a href="/blog/xyz">블로그 글</a></div>`)),
};

function send(res, code, html) {
  res.writeHead(code, { 'content-type': 'text/html; charset=utf-8' });
  res.end(html);
}

function sendXml(res, xml) {
  res.writeHead(200, { 'content-type': 'application/xml; charset=utf-8' });
  res.end(xml);
}
function sendText(res, txt) {
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(txt);
}

// 게이트 3 — 발견(discover) 시험 자산.
// [주의] 138·11 이라는 수는 2026-08-11 에 실제 deardeer.kr·theirmood.com 에서 관찰한 값이다.
// 여기서는 그 수를 가진 로컬 사이트맵을 만들어 "파서와 개수 계약"만 검증한다.
// 외부 사이트를 다시 부르지 않으며, 실제 사이트의 현재 수치를 재검증하는 것도 아니다.
// 시험이 사이트맵 내용을 결정적으로 바꾸기 위한 스위치(무작위 요소 없음)
const ctl = { bump: false, hide: false, breakB: false, norobots: false, mutate: 0 };

const SITEMAP_ROUTES = {
  // robots 에 Sitemap 이 여러 줄 (norobots=1 이면 선언을 지운다 — guess 경로를 보기 위해)
  '/robots.txt': (req, res, base) => sendText(res, ctl.norobots
    ? 'User-agent: *\nDisallow: /admin\n'
    : `User-agent: *\nDisallow: /admin\nSitemap: ${base}/sitemap-a.xml\nSitemap: ${base}/sitemap-index.xml\n`),

  // 인덱스 하나에 자식 둘. b 는 스위치로 "200 인데 오류 HTML" 이 되게 만든다(greenvelope 형).
  '/sitemap-pair.xml': (req, res, base) => sendXml(res,
    `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n`
    + `<sitemap><loc>${base}/sitemap-pair-a.xml</loc></sitemap>\n`
    + `<sitemap><loc>${base}/sitemap-pair-b.xml</loc></sitemap>\n</sitemapindex>`),
  '/sitemap-pair-a.xml': (req, res, base) => sendXml(res,
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n`
    + Array.from({ length: 3 }, (_, i) => `<url><loc>${base}/pa/${i + 1}</loc><lastmod>2026-08-04</lastmod></url>`).join('\n')
    + `\n</urlset>`),
  '/sitemap-pair-b.xml': (req, res, base) => {
    if (ctl.breakB) {
      // 200 이면서 사이트맵이 아니다 — 상태 코드만 보면 통과시키게 되는 자리
      return send(res, 200, page('일시 오류', '<h1>Something went wrong</h1><p>잠시 후 다시 시도해 주세요.</p>'));
    }
    sendXml(res, `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n`
      + Array.from({ length: 2 }, (_, i) => `<url><loc>${base}/pb/${i + 1}</loc><lastmod>2026-08-04</lastmod></url>`).join('\n')
      + `\n</urlset>`);
  },

  // 138개 — 상대 주소·추적 파라미터·중복을 섞어 정규화까지 함께 본다.
  // [제어] /sitemap-ctl?bump=1 을 부르면 /p/7 의 lastmod 만 바뀌고,
  //        /sitemap-ctl?hide=1 을 부르면 /p/9 가 목록에서 사라진다. 시험이 changed·사라짐을 만들 때 쓴다.
  '/sitemap-a.xml': (req, res, base) => {
    const urls = [];
    for (let i = 1; i <= 138; i++) {
      if (i === 1) urls.push(`<url><loc>/rel/one</loc></url>`);                       // 상대 주소
      else if (i === 2) urls.push(`<url><loc>${base}/dup?utm_source=x</loc></url>`);   // 추적 파라미터
      else if (i === 3) urls.push(`<url><loc>${base}/dup</loc></url>`);                // 위와 같은 주소
      else {
        if (i === 9 && ctl.hide) { urls.push(`<url><loc>${base}/p/filler</loc><lastmod>2026-08-01</lastmod></url>`); continue; }
        const lm = (i === 7 && ctl.bump) ? '2026-12-31' : `2026-08-0${(i % 9) + 1}`;
        urls.push(`<url><loc>${base}/p/${i}</loc><lastmod>${lm}</lastmod></url>`);
      }
    }
    sendXml(res, `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>`);
  },

  // 시험이 사이트맵 내용을 결정적으로 바꾸는 스위치
  '/sitemap-ctl': (req, res) => {
    const q = new URL(req.url, 'http://x').searchParams;
    if (q.has('bump')) ctl.bump = q.get('bump') === '1';
    if (q.has('hide')) ctl.hide = q.get('hide') === '1';
    if (q.has('breakb')) ctl.breakB = q.get('breakb') === '1';
    if (q.has('norobots')) ctl.norobots = q.get('norobots') === '1';
    if (q.has('mutate')) ctl.mutate = Number(q.get('mutate')) || 0;
    if (q.has('reset')) { ctl.bump = false; ctl.hide = false; ctl.breakB = false; ctl.norobots = false; ctl.mutate = 0; }
    sendText(res, `bump=${ctl.bump} hide=${ctl.hide} breakB=${ctl.breakB} norobots=${ctl.norobots} mutate=${ctl.mutate}`);
  },

  // 11개 — 데어무드 규모
  '/sitemap-small.xml': (req, res, base) => sendXml(res,
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n`
    + Array.from({ length: 11 }, (_, i) => `<url><loc>${base}/s/${i + 1}</loc><lastmod>2026-08-05</lastmod></url>`).join('\n')
    + `\n</urlset>`),

  // 사이트맵 인덱스 — 다른 사이트맵을 가리키고, 그중 하나는 자기 자신을 가리켜 순환을 만든다
  '/sitemap-index.xml': (req, res, base) => sendXml(res,
    `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n`
    + `<sitemap><loc>${base}/sitemap-small.xml</loc></sitemap>\n`
    + `<sitemap><loc>${base}/sitemap-loop.xml</loc></sitemap>\n`
    + `</sitemapindex>`),
  '/sitemap-loop.xml': (req, res, base) => sendXml(res,
    `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n`
    + `<sitemap><loc>${base}/sitemap-index.xml</loc></sitemap>\n`   // 되돌아간다 — 순환
    + `<sitemap><loc>${base}/sitemap-loop.xml</loc></sitemap>\n`    // 자기 자신
    + `</sitemapindex>`),

  // [함정] 형제 사이트맵 90개 — 형제 수를 "깊이"로 세면 중간에 조용히 잘린다.
  // 가지의 깊이는 2단(index → child)뿐이므로 전부 처리돼야 한다.
  '/sitemap-wide.xml': (req, res, base) => sendXml(res,
    `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n`
    + Array.from({ length: 90 }, (_, i) => `<sitemap><loc>${base}/sitemap-w/${i + 1}.xml</loc></sitemap>`).join('\n')
    + `\n</sitemapindex>`),

  // [함정] XML 규칙대로 & 를 &amp; 로 적은 loc. 해독하지 않으면 파라미터가 통째로 틀어진다.
  '/sitemap-entity.xml': (req, res, base) => sendXml(res,
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n`
    // 먼저 오는 줄에는 lastmod 가 없다 — 장부에 먼저 박히는 값이 null 이 되게 해서,
    // 나중 줄의 lastmod 가 장부까지 반영되는지 본다.
    + `<url><loc>${base}/goods?goodsNo=300&amp;color=red</loc></url>\n`
    + `<url><loc>${base}/goods?goodsNo=300&amp;color=red&amp;utm_source=x</loc><lastmod>2026-08-06</lastmod></url>\n`
    + `</urlset>`),

  // 느린 사이트맵 — 응답 도중에 프로세스를 죽여 "실행권을 쥔 채 죽는" 상황을 만든다
  '/sitemap-slow.xml': (req, res, base) => {
    setTimeout(() => sendXml(res,
      `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n`
      + `<url><loc>${base}/slow/1</loc><lastmod>2026-08-03</lastmod></url>\n</urlset>`), 2_500);
  },

  // 이미지 위주 목록 — 글자가 거의 없다. 필수 낱말이 없다고 버리면 이런 사이트가 통째로 빠진다.
  '/img-only': (req, res) => send(res, 200, page('',
    `<div class="grid">${Array.from({ length: 12 }, (_, i) =>
      `<article class="card"><a href="/products/i${i + 1}"><img src="/img/${i + 1}.png" alt=""></a></article>`).join('')}</div>`)),

  // [함정] 필수 낱말이 script·주석에만 있다. 원문 전체에서 찾으면 사람이 못 보는 글자로 통과한다.
  '/words-in-script': (req, res) => send(res, 200, page('',
    '<!-- 청첩장 -->\n'
    + '<script type="application/json">{"keyword":"청첩장"}</script>\n'
    + `<div class="grid">${Array.from({ length: 12 }, (_, i) =>
      `<article class="card"><a href="/products/s${i + 1}"><img src="/img/${i + 1}.png" alt=""></a></article>`).join('')}</div>`)),

  // 쪽 나눈 목록. 1·2쪽은 카드 일부를 겹쳐 내고, 4쪽부터는 새 카드가 없다.
  // 정렬(sort)이 붙으면 다른 묶음이다. 세션 딱지(sid)는 붙어도 같은 쪽이어야 한다.
  '/paged': (req, res) => {
    const q = new URL(req.url, 'http://x').searchParams;
    const n = Number(q.get('page') || '1');
    const sort = q.get('sort') || 'new';
    let ids;
    if (n === 1) ids = [1, 2, 3, 4, 5, 6];
    else if (n === 2) ids = [5, 6, 7, 8, 9, 10];        // 1쪽과 둘을 겹친다
    else if (n === 3) ids = [11, 12];
    else ids = [11, 12];                                 // 4쪽부터는 새것이 없다
    const cards = ids.map((i) => `<article class="card"><a href="/goods?goodsNo=${i}&sid=zz${n}">`
      + `<img src="/img/${i}.png" alt=""><h3>청첩장 ${i}</h3></a></article>`).join('');
    // 이 쪽에 실제로 보이는 수를 그대로 적는다 — 선언 수와 카드 수가 맞아야 판정이 확정된다.
    // (선언과 실제가 어긋나는 경우는 /listing-paged 가 맡는다.)
    send(res, 200, page(`목록 ${n}쪽 (${sort})`,
      `<h1>청첩장</h1><p class="count">총 ${ids.length}개</p><p>정렬 ${sort} · ${n}쪽입니다.</p>`
      + `<div class="grid">${cards}</div>`));
  },

  // 내용이 바뀌는 쪽 — /sitemap-ctl?mutate=1 로 본문을, mutate=2 로 거의 빈 쪽으로 만든다
  '/mutable': (req, res) => {
    if (ctl.mutate === 2) return send(res, 200, page('', '<div class="grid"></div>'));
    const body = ctl.mutate === 1
      ? '<h1>바뀐 본문</h1><p>' + '전혀 다른 이야기입니다. 청첩장 소개가 아니라 공지입니다. '.repeat(6) + '</p>'
      : '<h1>처음 본문</h1><p>' + '같은 내용을 담은 쪽입니다. 청첩장 열두 장을 소개합니다. '.repeat(6) + '</p>';
    send(res, 200, page('바뀌는 쪽', body));
  },
  // 위와 처음에는 같은 내용을 내는 짝
  '/mutable-twin': (req, res) => send(res, 200, page('바뀌는 쪽',
    '<h1>처음 본문</h1><p>' + '같은 내용을 담은 쪽입니다. 청첩장 열두 장을 소개합니다. '.repeat(6) + '</p>')),

  // [함정] 쪽마다 "목록 전체 수"를 적는 목록. 쪽 수로는 절대 안 맞고, 두 쪽을 합쳐야 맞는다.
  // 1쪽 1~6, 2쪽 5~10 으로 둘을 겹쳐 둔다 — 단순 합(12)이 아니라 합집합(10)이라야 맞는다.
  '/paged-total': (req, res) => {
    const n = Number(new URL(req.url, 'http://x').searchParams.get('page') || '1');
    const ids = n === 1 ? [1, 2, 3, 4, 5, 6] : [5, 6, 7, 8, 9, 10];
    const cards = ids.map((i) => `<article class="card"><a href="/goods?goodsNo=t${i}">`
      + `<img src="/img/t${i}.png" width="240" height="320" alt=""><h3>청첩장 ${i}</h3></a></article>`).join('');
    send(res, 200, page(`전체 표시 목록 ${n}쪽`,
      `<h1>청첩장</h1><p class="count">총 10개</p><p>${n}쪽입니다.</p><div class="grid">${cards}</div>`));
  },

  // [함정] 상세 링크가 없는 목록 — 카드를 누르면 덮개 창이 열리는 방식.
  // 링크로만 카드를 세면 이런 목록은 통째로 안 보인다. 두 쪽이 그림 둘을 겹쳐 낸다.
  '/nolink': (req, res) => {
    const n = Number(new URL(req.url, 'http://x').searchParams.get('page') || '1');
    const ids = n === 1 ? [1, 2, 3, 4, 5, 6] : [5, 6, 7, 8, 9, 10];
    const cards = ids.map((i) => `<article class="card" data-item="${i}">`
      + `<img src="/img/n${i}.png" width="240" height="320" alt="청첩장 ${i}"><h3>청첩장 ${i}</h3></article>`).join('');
    send(res, 200, page(`덮개 창 목록 ${n}쪽`,
      `<h1>청첩장</h1><p class="count">총 ${ids.length}개</p><p>눌러서 크게 보는 목록입니다.</p>`
      + `<div class="grid">${cards}</div>`));
  },

  // 달력 — 조합만으로 끝없이 늘어나는 자리
  // (아래 /maze 는 경로가 끝없이 갈라지는 자리다 — 라우팅은 파일 아래쪽 동적 처리에 있다)
  '/calendar': (req, res) => {
    const d = new URL(req.url, 'http://x').searchParams.get('date') || '';
    send(res, 200, page('달력', `<h1>${d || '이번 달'}</h1><p>날짜별 보기입니다. 청첩장 일정.</p>`));
  },

  '/dup': (req, res) => send(res, 200, page('중복 대상', '<h1>같은 주소</h1><p>추적 파라미터만 다른 판.</p>')),
  '/rel/one': (req, res) => send(res, 200, page('상대 주소', '<h1>상대 주소로 적힌 항목</h1>')),

  // 사이트맵에 없는 내부 링크 — 홈에서만 닿는다
  '/hidden-only-linked': (req, res) => send(res, 200, page('링크로만 닿는 쪽',
    '<h1>사이트맵에 없는 쪽</h1><p>내부 링크로만 발견된다.</p>')),

  // 바른손 302 재현 — 정상 최종 내용 / 오류 최종 내용 두 갈래
  '/redir-ok': (req, res, base) => { res.writeHead(302, { Location: `${base}/redir-ok-final` }); res.end(); },
  '/redir-ok-final': (req, res) => send(res, 200, page('청첩장 목록(리다이렉트 도착)',
    `<h1>청첩장</h1><p class="count">총 12개</p><div class="grid">
     ${Array.from({ length: 12 }, (_, i) => card(i + 1, `/products/r${i + 1}`)).join('')}</div>`, JSONLD(12))),
  '/redir-bad': (req, res, base) => { res.writeHead(302, { Location: `${base}/redir-bad-final` }); res.end(); },
  '/redir-bad-final': (req, res) => send(res, 200, page('Whoops',
    `<h1>Whoops... Something went wrong</h1>
     <p>요청하신 페이지를 찾을 수 없습니다. 주소를 다시 확인해 주세요.</p>
     <p>주문 조회와 배송 안내는 고객센터에서 확인하실 수 있습니다. 평일 오전 열 시부터
        오후 여섯 시까지 상담이 가능하며 주말에는 게시판으로 문의를 남겨 주세요.</p>
     <p>청첩장 제작 과정과 종이 견본 신청 방법은 도움말에 정리되어 있습니다.</p>`)),

  // 쿼리 조합으로 같은 내용이 늘어나는 자리 — 자동 폐기가 아니라 표시만 해야 한다
  '/same-content': (req, res) => send(res, 200, page('같은 내용',
    '<h1>정렬만 다른 같은 목록</h1><p class="count">총 3개</p><div class="grid">'
    + [1, 2, 3].map((i) => card(i, `/products/sc${i}`)).join('') + '</div>')),
  // 기능성 파라미터로 서로 다른 상품 — 여기서 합쳐지면 안 된다(음성 시험)
  '/goods': (req, res) => {
    const id = new URL(req.url, 'http://x').searchParams.get('goodsNo') || '0';
    send(res, 200, page(`상품 ${id}`, `<h1>상품 ${id}</h1><p>이 쪽은 goodsNo=${id} 전용 내용입니다.</p>`));
  },
};

// 실제로 몇 번 두드렸는지 서버 쪽에서 센다 — "재방문 0" 을 크롤러 자기 보고가 아니라
// 맞은 쪽 기록으로 확인하기 위해서다.
const hits = new Map();

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  if (u.pathname === '/hits') {
    if (u.searchParams.has('reset')) hits.clear();
    return sendText(res, JSON.stringify(Object.fromEntries(hits)));
  }
  hits.set(u.pathname, (hits.get(u.pathname) || 0) + 1);
  if (u.pathname.startsWith('/img/')) {           // 1x1 투명 PNG
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
    res.writeHead(200, { 'content-type': 'image/png', 'content-length': png.length });
    return res.end(png);
  }
  if (u.pathname === '/reset-flaky') { flakyHits.clear(); return send(res, 200, 'ok'); }
  const base = `http://127.0.0.1:${server.address().port}`;
  // 형제 사이트맵 90장 — 각각 항목 하나씩
  const w = u.pathname.match(/^\/sitemap-w\/(\d+)\.xml$/);
  if (w) {
    return sendXml(res, `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n`
      + `<url><loc>${base}/w/${w[1]}</loc><lastmod>2026-08-01</lastmod></url>\n</urlset>`);
  }
  // [함정] 진짜 깊은 가지 — 0 → 1 → … → 7 로 7단 중첩. 기본 경계(4)를 반드시 넘는다.
  // [함정] 끝없이 갈라지는 경로. 한 쪽이 자식 둘을 낳아 같은 형태(/maze/*)가 무한히 는다.
  // 상한이 없으면 이런 자리 하나가 크롤 전체를 잡아먹는다.
  const mz = u.pathname.match(/^\/maze\/(\d+)$/);
  if (mz) {
    const n = Number(mz[1]);
    return send(res, 200, page(`갈림길 ${n}`,
      `<h1>갈림길 ${n}</h1><p>여기서 또 갈라집니다.</p>`
      + `<a href="/maze/${n * 2}">왼쪽</a> <a href="/maze/${n * 2 + 1}">오른쪽</a>`));
  }

  const dp = u.pathname.match(/^\/sitemap-deep\/(\d+)\.xml$/);
  if (dp) {
    const n = Number(dp[1]);
    if (n < 7) {
      return sendXml(res, `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n`
        + `<sitemap><loc>${base}/sitemap-deep/${n + 1}.xml</loc></sitemap>\n</sitemapindex>`);
    }
    return sendXml(res, `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n`
      + `<url><loc>${base}/deep/a</loc><lastmod>2026-08-02</lastmod></url>\n`
      + `<url><loc>${base}/deep/b</loc><lastmod>2026-08-02</lastmod></url>\n</urlset>`);
  }
  const sm = SITEMAP_ROUTES[u.pathname];
  if (sm) return sm(req, res, base);
  const h = ROUTES[u.pathname];
  if (h) return h(req, res);
  return send(res, 404, page('404', '<h1>404 Not Found</h1>'));
});

const port = Number(process.argv[2]) || 0;
server.listen(port, '127.0.0.1', () => {
  const p = server.address().port;
  process.stdout.write(`http://127.0.0.1:${p}\n`);
});
