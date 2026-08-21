// web-search — URL 정규화
// 계획서 2-1. 정규화 결과의 해시가 url_id 이고, 그게 중복 판정의 유일한 열쇠다.
//
// 두 가지를 동시에 지켜야 한다:
//   (1) 추적 파라미터만 다른 주소는 하나로 합쳐진다
//   (2) 상품을 구분하는 기능성 파라미터는 보존된다  ← 지우면 서로 다른 상품이 한 주소가 된다

import crypto from 'node:crypto';

// 널리 쓰이는 추적 파라미터. policy.json 의 drop_params 로 덧붙일 수 있다.
export const DEFAULT_DROP_PARAMS = [
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id',
  'gclid', 'fbclid', 'msclkid', 'yclid', 'igshid', 'ttclid',
  'ref', 'referrer', 'source', 'src', 'spm', 'scm',
  '_ga', '_gl', 'mc_cid', 'mc_eid', 'oly_enc_id', 'trk', 'trk_contact',
  'n_media', 'n_query', 'n_rank', 'n_ad_group', 'n_ad', 'n_keyword', 'NaPm', // 네이버 유입 추적
  // 세션 딱지 — 사람마다 달라지고 내용은 같다. 안 지우면 같은 쪽이 사람 수만큼 늘어난다.
  'sessionid', 'session_id', 'phpsessid', 'jsessionid', 'aspsessionid', 'sid',
  'cfid', 'cftoken', 'zenid', '_sid', 'ssid',
];

// 정렬·보기 파라미터는 기본으로 지우지 않는다.
// 정렬을 바꾸면 실제로 다른 상품이 노출되는 목록이 있어서, 일괄로 지우면 그런 사이트의 목록이
// 통째로 한 칸이 된다. 지울지는 사이트를 보고 policy.drop_params_by_domain 에 적는다.
export const SORTING_PARAMS = ['sort', 'order', 'orderby', 'sortby', 'view', 'display', 'listtype'];

// 기능성 파라미터 기본값 — 이게 없으면 상품이 구분되지 않는 흔한 키들.
// 도메인별 지정(policy.keep_params[domain])이 있으면 그쪽이 우선한다.
export const DEFAULT_KEEP_PARAMS = [
  'id', 'no', 'idx', 'seq', 'pid', 'goodsno', 'goodsid', 'productno', 'productid',
  'p', 'page', 'cate', 'category', 'cateno', 'code', 'sku', 'variant', 'v',
];

function stripDefaultPort(u) {
  if ((u.protocol === 'http:' && u.port === '80') || (u.protocol === 'https:' && u.port === '443')) u.port = '';
}

/**
 * @param {string} input  원본 URL (상대 주소면 base 필요)
 * @param {object} opts   { base, dropParams[], keepParams[], keepParamsByDomain{} }
 * @returns {{url:string, id:string, domain:string, dropped:string[]}}
 */
export function normalizeUrl(input, opts = {}) {
  const base = opts.base ? new URL(opts.base) : undefined;
  const u = new URL(String(input).trim(), base);

  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`지원하지 않는 스킴: ${u.protocol}`);
  }

  u.protocol = u.protocol.toLowerCase();
  u.hostname = u.hostname.toLowerCase().replace(/\.$/, '');
  stripDefaultPort(u);
  u.hash = '';                       // 프래그먼트는 서버에 전달되지 않으므로 항상 제거

  const domain = u.hostname;
  // [합집합] 도메인별 보존이 기본 보존을 "대체"하면, 그 도메인에 keep 을 하나만 적는 순간
  // id·goodsNo 같은 기본 보호가 통째로 사라진다. 보존은 언제나 더하기다.
  const keepSet = new Set([
    ...DEFAULT_KEEP_PARAMS,
    ...(opts.keepParams ?? []),
    ...(opts.keepParamsByDomain?.[domain] ?? []),
  ].map((k) => k.toLowerCase()));
  // 도메인별 제거는 기본 목록에 "더한다"(대체가 아니다). 보존은 언제나 제거보다 먼저다.
  const dropSet = new Set([
    ...(opts.dropParams ?? DEFAULT_DROP_PARAMS),
    ...(opts.dropParamsByDomain?.[domain] ?? []),
  ].map((k) => k.toLowerCase()));

  const dropped = [];
  const kept = [];
  for (const [k, v] of u.searchParams.entries()) {
    const lower = k.toLowerCase();
    if (keepSet.has(lower)) { kept.push([k, v]); continue; }   // 보존이 제거보다 우선
    if (dropSet.has(lower)) { dropped.push(k); continue; }
    kept.push([k, v]);
  }
  // 키 정렬 — 순서만 다른 주소가 다른 것으로 세지 않도록.
  // 같은 key·같은 value 면 0 을 돌려줘야 한다(안 그러면 정렬이 불안정해져 같은 주소가 두 모양이 된다).
  kept.sort((a, b) => {
    if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
    if (a[1] !== b[1]) return a[1] < b[1] ? -1 : 1;
    return 0;
  });
  u.search = '';
  for (const [k, v] of kept) u.searchParams.append(k, v);

  // 경로: 빈 경로는 "/", 그 외에는 끝 슬래시 제거. 퍼센트 인코딩은 URL이 이미 정규화한다.
  u.pathname = u.pathname === '' ? '/' : u.pathname.replace(/\/+$/, '') || '/';

  const url = u.toString();
  return { url, id: urlId(url), domain, dropped };
}

export function urlId(normalizedUrl) {
  return crypto.createHash('sha256').update(normalizedUrl).digest('hex').slice(0, 20);
}

/**
 * www. 만 무시하고 호스트를 그대로 견준다.
 *
 * [이름을 바꾼 이유] 전에는 sameSite 라 부르며 "등록 도메인이 같으면 참"이라 적어 뒀는데
 * 구현은 그게 아니었다. shop.example.com 과 www.example.com 은 여기서 거짓이다.
 * 등록 도메인을 제대로 가르려면 공용 접미사 목록(Public Suffix List)이 있어야 한다 —
 * "마지막 두 라벨"로 추측하면 co.kr·com.au 같은 곳에서 전부 틀린다.
 * 목록을 들일 때까지는 이름이 하는 일을 정확히 말하도록 두고, 필요해지면 그때 제대로 만든다.
 */
export function sameHostIgnoringWww(a, b) {
  const strip = (h) => String(h).toLowerCase().replace(/^www\./, '');
  return strip(a) === strip(b);
}
