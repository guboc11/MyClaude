// web-search — 긍정 조건 판정기
// 계획서 2-3. 이 도구에서 가장 중요한 부분.
//
// [대원칙] "알려진 실패 문구가 없다"는 정상이라는 증거가 아니다.
// 종류별로 정상의 증거를 요구하고, 증거가 모자라면 억지로 정상·실패에 넣지 않고
// needs_visual_review 로 뺀다.
//
// 판정 결과는 셋:
//   content_validated     강한 증거가 있고 모순이 없다
//   invalid               오류 문구·빈 화면·엉뚱한 최종 주소가 확인됐다
//   needs_visual_review   어느 쪽도 부족하다
//
// page_validity 와 extraction_status 는 분리한다 —
// "정상 페이지를 열었다"와 "카드를 다 뽑았다"는 다른 얘기다.

import { normalizeUrl } from './url.mjs';
import { requireDep } from './deps.mjs';

function loadJsdom() {
  return requireDep('jsdom');
}

// 오류 화면의 지문. 이건 invalid 를 "확인"하는 데만 쓴다 — 없다고 정상이 되는 게 아니다.
const ERROR_MARKS = [
  'something went wrong', 'page not found', '404 not found', 'not found',
  'whoops', 'oops', '403 forbidden', '429 too many requests', 'access denied',
  'sorry, you have been blocked', 'error occurred', '페이지를 찾을 수 없', '잘못된 접근',
];
const MIN_TEXT = 200;          // 이보다 짧으면 내용이 없다고 본다
const SMALL_IMG = 60;          // 로고·SNS 아이콘 거르기(가로 또는 세로가 이보다 작으면 장식)

function textOf(doc) {
  const clone = doc.body?.cloneNode(true);
  if (!clone) return '';
  for (const el of clone.querySelectorAll('script,style,noscript')) el.remove();
  return (clone.textContent || '').replace(/\s+/g, ' ').trim();
}

/** header·nav·footer·aside 안에 있는가 — 카드 후보에서 제외할 자리 */
function inChrome(el) {
  return !!el.closest('header, nav, footer, aside, [role="navigation"], [role="banner"], [role="contentinfo"]');
}

function imgSize(img) {
  const w = Number(img.getAttribute('width')) || 0;
  const h = Number(img.getAttribute('height')) || 0;
  return { w, h };
}

/** 같은 파서로 문서를 만든다 — 카드 고르기를 다른 곳에서도 같은 잣대로 하려고 연다. */
export function parseDoc(html, url) {
  const { JSDOM } = loadJsdom();
  try { return new JSDOM(String(html || ''), { url }).window.document; } catch { return null; }
}

/** 이미지와 링크를 함께 품은 반복 묶음을 찾는다. 선택자 하나에 기대지 않는다. */
export function findCardGroups(doc, baseUrl) {
  const anchors = [...doc.querySelectorAll('a[href]')];
  const candidates = [];
  for (const a of anchors) {
    if (inChrome(a)) continue;                       // nav·footer·로고 자리 제외
    const img = a.querySelector('img') || (a.parentElement && a.parentElement.querySelector('img'));
    if (!img) continue;
    const { w, h } = imgSize(img);
    if ((w && w < SMALL_IMG) || (h && h < SMALL_IMG)) continue;   // 아이콘 크기 제외
    let href;
    try { href = normalizeUrl(a.getAttribute('href'), { base: baseUrl }).url; } catch { continue; }
    candidates.push({ a, img, href, container: a.closest('article, li, div') || a.parentElement });
  }
  if (!candidates.length) {
    // 링크가 하나도 없는 목록(덮개 창으로 여는 것)이 있다. 여기서 그냥 끝내면 그런 목록은 통째로 안 보인다.
    const only = findImageOnlyGroups(doc);
    return only.cards.length >= 2 ? only : { groups: [], cards: [] };
  }

  // 같은 부모 아래 모인 것들을 한 묶음으로 본다(구조 반복이 곧 목록이다)
  const byParent = new Map();
  for (const c of candidates) {
    const parent = c.container?.parentElement || c.a.parentElement;
    if (!parent) continue;
    const key = parent;
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(c);
  }

  const groups = [];
  for (const [parent, items] of byParent.entries()) {
    const hrefs = new Set(items.map((i) => i.href));
    if (hrefs.size < 2) continue;                    // 모두 같은 주소를 가리키면 목록이 아니다
    const paths = [...hrefs].map((h) => new URL(h).pathname);
    const shapes = new Set(paths.map((p) => p.replace(/[^/]+$/, '*')));
    groups.push({
      parent, items, unique: hrefs.size,
      similarPath: shapes.size <= Math.max(1, Math.ceil(paths.length / 4)),   // 경로 형태가 몇 갈래인가
    });
  }
  groups.sort((a, b) => b.unique - a.unique);
  const best = groups[0];
  const cards = best ? dedupeCards(best.items) : [];
  if (cards.length >= 2) return { groups, cards };

  // [상세 링크가 없는 목록] 카드를 눌러 덮개 창(모달)을 여는 목록은 상세 주소가 아예 없다.
  // 링크로만 찾으면 그런 목록은 통째로 안 보인다. 링크 방식으로 못 찾았을 때만 이 길을 본다 —
  // 먼저 보면 멀쩡한 링크 목록의 판정을 흔든다.
  const noLink = findImageOnlyGroups(doc);
  if (noLink.cards.length >= 2) return { groups: noLink.groups, cards: noLink.cards };
  return { groups, cards };
}

/** 이미지를 품은 형제 묶음. 상세 링크가 없어도 카드는 카드다. */
function findImageOnlyGroups(doc) {
  const byParent = new Map();
  for (const img of doc.querySelectorAll('img')) {
    if (inChrome(img)) continue;
    if (img.closest('a[href]')) continue;                 // 링크가 있으면 위쪽 길이 맡는다
    const { w, h } = imgSize(img);
    if ((w && w < SMALL_IMG) || (h && h < SMALL_IMG)) continue;
    const box = img.closest('article, li, figure, div');
    const parent = box?.parentElement;
    if (!box || !parent) continue;
    if (!byParent.has(parent)) byParent.set(parent, []);
    byParent.get(parent).push({ img, container: box });
  }
  const groups = [];
  for (const [parent, items] of byParent.entries()) {
    if (items.length < 2) continue;
    groups.push({ parent, items, unique: items.length, similarPath: true, linkless: true });
  }
  groups.sort((a, b) => b.unique - a.unique);
  const best = groups[0];
  const cards = best ? best.items.map((it) => ({
    href: null,
    img: it.img.getAttribute('src') || '',
    text: (it.container.textContent || '').trim().slice(0, 80),
  })) : [];
  return { groups, cards };
}

function dedupeCards(items) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    if (seen.has(it.href)) continue;
    seen.add(it.href);
    out.push({ href: it.href, img: it.img.getAttribute('src') || '', text: (it.a.textContent || '').trim().slice(0, 80) });
  }
  return out;
}

/** 페이지가 스스로 밝힌 상품 수 — "총 12개", "12 items" 같은 표시 */
export function declaredCount(doc) {
  const t = textOf(doc).slice(0, 3000);
  const m = t.match(/(?:총|전체)\s*([0-9,]+)\s*(?:개|건)/) || t.match(/([0-9,]+)\s*(?:items|products|results)\b/i);
  return m ? Number(m[1].replace(/,/g, '')) : null;
}

export function jsonLdItems(doc) {
  let n = 0;
  for (const s of doc.querySelectorAll('script[type="application/ld+json"]')) {
    let data;
    try { data = JSON.parse(s.textContent); } catch { continue; }
    for (const node of [].concat(data)) {
      if (!node || typeof node !== 'object') continue;
      if (node['@type'] === 'ItemList' && Array.isArray(node.itemListElement)) n += node.itemListElement.length;
      if (node['@type'] === 'Product') n += 1;
    }
  }
  return n;
}

/**
 * 목록·상세·사이트맵을 판정한다.
 * @param {object} input { html, markdown, requested, final, status, kind, profile }
 * @returns {{page_validity, extraction_status, evidence:string[], negatives:string[], cards, declared, jsonld}}
 */
export function judge(input) {
  const { html = '', requested, final, status = 0, kind = 'unknown', markdown = false, profile = null } = input;
  const evidence = [];
  const negatives = [];

  // [조기 return] done() 은 아래 값들을 닫아 본다. 마크다운 분기와 파싱 실패는 카드를 세기 전에
  // done() 을 부르므로, 여기서 안전한 기본값으로 먼저 만들어 둔다.
  // (안 그러면 그 길로 들어간 순간 "Cannot access 'cards' before initialization" 로 죽는다.
  //  2026-08-11 실전 1회차에서 국내 네 곳이 이걸로 멈춤)
  let cards = [];
  let groups = [];
  let declared = null;
  let jsonld = 0;
  let title = '';
  let text = '';
  let redirected = false;

  // --- 먼저 "확인된 실패"를 본다 (이것만으로 정상 판정을 하지는 않는다) ---
  if (status === 0) negatives.push('no_response');
  if (status === 403 || status === 429 || status === 503) negatives.push(`http_${status}`);
  if (status === 404) negatives.push('http_404');

  if (markdown) {
    // Jina 마크다운은 DOM 이 없다. 텍스트 길이와 오류 문구만 볼 수 있다.
    const t = String(html).trim();
    const low = t.toLowerCase();
    const hit = ERROR_MARKS.find((m) => low.includes(m));
    if (hit) negatives.push(`error_phrase:${hit}`);
    if (t.length < MIN_TEXT) negatives.push(`thin_text:${t.length}`);
    if (negatives.length) return done('invalid', 'uncertain');
    // 마크다운만으로는 카드 구조를 못 본다 → 목록이면 정상이라 단정하지 않는다
    evidence.push(`markdown_text:${t.length}`);
    return done(kind === 'listing' ? 'needs_visual_review' : 'content_validated', 'uncertain');
  }

  const { JSDOM } = loadJsdom();
  let doc;
  try { doc = new JSDOM(html, { url: final || requested }).window.document; }
  catch (e) { negatives.push(`parse_fail:${e.message.slice(0, 40)}`); return done('invalid', 'uncertain'); }

  title = (doc.title || '').trim();
  text = textOf(doc);
  const low = `${title}\n${text}`.toLowerCase();
  const hit = ERROR_MARKS.find((m) => low.includes(m));
  if (hit) negatives.push(`error_phrase:${hit}`);

  // 카드부터 센다. 이미지 중심 목록은 글자가 적은 게 정상이라
  // "텍스트가 짧다"를 그대로 실패로 쓰면 멀쩡한 목록을 버린다.
  // (계획서 2-7 과 같은 정신 — 낱말이 없다는 이유로 중요한 사례를 빠뜨리지 않는다.)
  const { cards: cardsEarly, groups: groupsEarly } = findCardGroups(doc, final || requested);
  if (text.length < MIN_TEXT && cardsEarly.length < 2) negatives.push(`thin_text:${text.length}`);

  // 최종 주소가 요청과 다르면 그 자체로 실패는 아니지만, 종류가 뒤바뀌었으면 실패다.
  if (requested && final && requested !== final) {
    redirected = true;
    try {
      const a = new URL(requested), b = new URL(final);
      const toRoot = b.pathname === '/' && a.pathname !== '/';
      if (toRoot) negatives.push('redirected_to_root');           // 상세를 청했는데 홈이 왔다
      else if (a.hostname.replace(/^www\./, '') !== b.hostname.replace(/^www\./, '')) negatives.push('redirected_offsite');
    } catch { /* 무시 */ }
  }

  // --- 긍정 증거를 모은다 ---
  jsonld = jsonLdItems(doc);
  if (jsonld >= 2) evidence.push(`jsonld_items:${jsonld}`);

  cards = cardsEarly; groups = groupsEarly;
  if (cards.length >= 2) evidence.push(`repeated_image_links:${cards.length}`);
  if (groups[0]?.similarPath) evidence.push('similar_path_shape');

  declared = declaredCount(doc);
  let countMatches = null;
  if (declared != null && cards.length) {
    countMatches = declared === cards.length;
    if (countMatches) {
      evidence.push(`declared_matches:${declared}`);
    } else if (declared > cards.length) {
      // 표시 수가 더 많은 것은 대개 페이지 나눔이다 — deardeer.kr 은 "총 56개"인데 한 쪽에 12개를 보인다.
      // 페이지가 잘못됐다는 뜻이 아니라 "이 쪽에서 다 못 모았다"는 뜻이므로
      // page_validity 가 아니라 extraction_status 쪽 문제로 다룬다. (2026-08-11 외부 관찰에서 발견)
      evidence.push(`declared_partial:${cards.length}/${declared}`);
    } else {
      // 표시 수보다 많이 잡혔다 — 목록이 아닌 것을 카드로 셌을 수 있다. 이건 의심 신호다.
      negatives.push(`declared_overcount:${declared}vs${cards.length}`);
    }
  }

  if (profile?.accepted_card_signature && groups[0]) {
    const sig = groupSignature(groups[0]);
    if (sig === profile.accepted_card_signature) evidence.push('profile_signature_match');
    else negatives.push('profile_signature_changed');
  }

  // --- 종합 ---
  if (negatives.length) return done('invalid', cards.length ? 'incomplete' : 'uncertain');

  if (kind === 'listing' || cards.length >= 2) {
    // "N개 이상"으로 자르지 않는다. 카드가 둘뿐인 목록도 있다.
    const strong = [
      jsonld >= 2,
      cards.length >= 2,
      countMatches === true,
      // 총수를 밝혔는데 이 쪽에는 그보다 적게 보이는 것은 쪽 나눔이다.
      // "총 56개"라고 스스로 적어 둔 쪽은 목록이 맞다는 증거이지 의심 거리가 아니다.
      // (총수와 실제 수의 대조는 여기서 하지 않는다 — extraction_status 와 묶음 대조가 맡는다.)
      evidence.some((e) => e.startsWith('declared_partial:')),
      evidence.includes('profile_signature_match'),
    ].filter(Boolean).length;
    if (strong >= 2) return done('content_validated', extraction(cards, declared, countMatches));
    if (strong === 1) return done('needs_visual_review', extraction(cards, declared, countMatches));
    return done('needs_visual_review', 'uncertain');
  }

  if (kind === 'detail') {
    const hasTitle = title.length > 0;
    const hasImg = [...doc.querySelectorAll('img')].some((i) => { const { w, h } = imgSize(i); return !w || w >= SMALL_IMG; });
    const enough = text.length >= MIN_TEXT;
    const strong = [hasTitle, hasImg, enough].filter(Boolean).length;
    if (hasTitle) evidence.push('has_title');
    if (hasImg) evidence.push('has_main_image');
    if (enough) evidence.push(`text:${text.length}`);
    return done(strong >= 3 ? 'content_validated' : 'needs_visual_review', 'uncertain');
  }

  // 종류를 모르는 페이지: 본문이 충분하고 오류가 없으면 내용은 받되, 목록으로 승격하지 않는다
  evidence.push(`text:${text.length}`);
  return done(redirected ? 'needs_visual_review' : 'content_validated', 'uncertain');

  function extraction(cardList, dec, matches) {
    if (dec == null) return cardList.length ? 'uncertain' : 'incomplete';
    return matches ? 'complete' : 'incomplete';
  }
  function done(page_validity, extraction_status) {
    return { page_validity, extraction_status, evidence, negatives, cards, declared, jsonld, title, text_len: text?.length ?? 0, redirected };
  }
}

export function groupSignature(group) {
  const el = group.items[0]?.container;
  if (!el) return '';
  const parts = [];
  let cur = el;
  for (let i = 0; i < 3 && cur; i++) {
    parts.push(`${cur.tagName.toLowerCase()}.${(cur.className || '').toString().trim().split(/\s+/).slice(0, 2).join('.')}`);
    cur = cur.parentElement;
  }
  return `${parts.join('>')}|n=${group.unique}`;
}
