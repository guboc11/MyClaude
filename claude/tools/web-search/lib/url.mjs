// URL 정규화 — canonical_url 이 중복 판정의 유일한 열쇠다.
//
// 계획서 4-2·5-4, 게이트 1. 두 가지를 동시에 지켜야 한다.
//   (1) 추적 파라미터만 다른 주소는 하나로 합쳐진다
//   (2) 상품·쪽을 구분하는 기능성 파라미터는 보존된다  ← 지우면 서로 다른 쪽이 한 주소가 된다
//
// 파생 id 를 만들지 않는다. 중복 판정은 canonical_url 자체로 하고, item_id 는 DB 가 준다.
// (LEGACY 는 sha256 앞 20자를 열쇠로 썼다. 열쇠가 둘이면 어느 쪽이 진짜인지 흐려진다.)


/** 널리 쓰이는 추적 파라미터. 지워도 가리키는 쪽이 달라지지 않는다. */
export const DEFAULT_DROP_PARAMS = [
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id', 'utm_reader',
  'gclid', 'gclsrc', 'dclid', 'fbclid', 'msclkid', 'yclid', 'igshid', 'ttclid', 'twclid', 'li_fat_id',
  'ref', 'referrer', 'source', 'src', 'spm', 'scm', 'trk', 'trk_contact', 'mkt_tok',
  '_ga', '_gl', '_hsenc', '_hsmi', 'mc_cid', 'mc_eid', 'oly_enc_id', 'vero_id', 'wickedid',
  'n_media', 'n_query', 'n_rank', 'n_ad_group', 'n_ad', 'n_keyword', 'NaPm',   // 네이버 유입 추적
  // 세션 딱지 — 사람마다 달라지고 내용은 같다. 안 지우면 같은 쪽이 사람 수만큼 늘어난다.
  'sessionid', 'session_id', 'phpsessid', 'jsessionid', 'aspsessionid', 'sid',
  'cfid', 'cftoken', 'zenid', '_sid', 'ssid',
];

/**
 * 정렬·보기 파라미터는 기본으로 지우지 않는다.
 * 정렬을 바꾸면 실제로 다른 상품이 노출되는 목록이 있어서, 일괄로 지우면 그런 사이트의 목록이
 * 통째로 한 칸이 된다. 지울지는 사이트를 보고 dropParamsByDomain 에 적는다.
 */
export const SORTING_PARAMS = ['sort', 'order', 'orderby', 'sortby', 'view', 'display', 'listtype'];

/** 이게 없으면 서로 다른 쪽이 구분되지 않는 흔한 열쇠들. 제거보다 언제나 먼저다. */
export const DEFAULT_KEEP_PARAMS = [
  'id', 'no', 'idx', 'seq', 'pid', 'goodsno', 'goodsid', 'productno', 'productid',
  'p', 'page', 'offset', 'start', 'cate', 'category', 'cateno', 'code', 'sku', 'variant', 'v',
  'q', 'query', 'keyword', 'lang', 'locale', 'hl', 'country', 'currency', 'size', 'color',
];

export class UrlError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'UrlError';
    this.code = code;
  }
}
const fail = (code, message) => { throw new UrlError(code, message); };

function stripDefaultPort(u) {
  if ((u.protocol === 'http:' && u.port === '80') || (u.protocol === 'https:' && u.port === '443')) u.port = '';
}

/**
 * @param {string} input 원본 URL (상대 주소면 opts.base 필요)
 * @param {object} opts { base, dropParams[], keepParams[], keepParamsByDomain{}, dropParamsByDomain{} }
 * @returns {{canonical_url:string, original_url:string, domain:string, dropped:string[]}}
 */
export function normalizeUrl(input, opts = {}) {
  if (typeof input !== 'string' || !input.trim()) fail('empty', 'URL 이 비었습니다');
  const original = input.trim();

  let u;
  try {
    u = new URL(original, opts.base ? new URL(opts.base) : undefined);
  } catch {
    fail('unparsable', `URL 로 읽을 수 없습니다: ${original.slice(0, 80)}`);
  }

  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    fail('scheme', `http·https 만 받습니다: ${u.protocol}`);
  }
  // 자격정보가 든 주소는 다듬지 않고 거절한다. 지워 주면 장부에는 안 남지만 부른 쪽은 그 사실을 모른다.
  if (u.username || u.password) fail('userinfo', 'URL 에 사용자명·비밀번호를 담을 수 없습니다');
  if (!u.hostname) fail('no_host', '호스트가 없습니다');

  u.protocol = u.protocol.toLowerCase();
  u.hostname = u.hostname.toLowerCase().replace(/\.$/, '');
  stripDefaultPort(u);
  u.hash = '';                       // 프래그먼트는 서버에 전달되지 않는다

  // [대괄호를 벗긴다] URL.hostname 은 IPv6 를 `[::1]` 로 돌려준다. 그대로 두면 net.isIP 가
  // 못 알아보고, 목적지 검사가 IP 분류를 건너뛰어 이름 풀이로 흘러간다 — IPv6 루프백·사설 주소가
  // ip_loopback 이 아니라 dns 실패로 막히거나, DNS 가 답하면 아예 안 막힌다.
  // (2026-08-12 #25 시험에서 발견. canonical_url 은 규격대로 대괄호를 유지한다.)
  const domain = u.hostname.replace(/^\[(.+)\]$/, '$1');
  // [합집합] 도메인별 보존이 기본 보존을 "대체" 하면, 그 도메인에 keep 을 하나만 적는 순간
  // id·goodsNo 같은 기본 보호가 통째로 사라진다. 보존은 언제나 더하기다.
  const keepSet = new Set([
    ...DEFAULT_KEEP_PARAMS,
    ...(opts.keepParams ?? []),
    ...(opts.keepParamsByDomain?.[domain] ?? []),
  ].map((k) => k.toLowerCase()));
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
  // 같은 key·같은 value 면 0 을 돌려줘야 정렬이 흔들리지 않는다.
  kept.sort((a, b) => {
    if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
    if (a[1] !== b[1]) return a[1] < b[1] ? -1 : 1;
    return 0;
  });
  u.search = '';
  for (const [k, v] of kept) u.searchParams.append(k, v);

  // 경로: 빈 경로는 "/", 그 외에는 끝 슬래시 제거.
  u.pathname = u.pathname === '' ? '/' : (u.pathname.replace(/\/+$/, '') || '/');

  return { canonical_url: u.toString(), original_url: original, domain, dropped };
}

/**
 * www. 만 무시하고 호스트를 그대로 견준다.
 *
 * 등록 도메인이 같은지를 보는 함수가 아니다 — shop.example.com 과 www.example.com 은 거짓이다.
 * 등록 도메인을 제대로 가르려면 공용 접미사 목록(Public Suffix List)이 있어야 하고,
 * "마지막 두 라벨" 로 추측하면 co.kr·com.au 같은 곳에서 전부 틀린다.
 */
export function sameHostIgnoringWww(a, b) {
  const strip = (h) => String(h).toLowerCase().replace(/^www\./, '');
  return strip(a) === strip(b);
}
