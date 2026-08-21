// 진단 낱말 — 경고와 오류의 이름을 한 곳에 모은다.
//
// 계획서 5-2·5-5. 목적은 하나다: **긴 로그를 열지 않고 오류 한 건의 원인과 다시 돌릴 대상을 찾는 것.**
//
// 낱말이 여기저기 흩어지면 같은 일이 http 에서는 `timeout`, 브라우저에서는 `nav_timeout` 이 되고,
// status 는 둘을 다른 문제로 센다. 그러면 "무슨 일이 몇 번 있었나" 에 아무도 답할 수 없다.
//
// [경고는 판정이 아니다] 여기 있는 warning 은 전부 관찰이다. 자료가 쓸 만한지는 에이전트가
// report 로 말한다. 특히 error_page_text_detected 는 "이 문구가 보인다" 일 뿐,
// 그 쪽이 무효라는 뜻이 아니다 — 1차가 그 둘을 한 값으로 합쳤다가 무너졌다.

export class ErrorVocabError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ErrorVocabError';
    this.code = code;
  }
}

// ── 경고 ──────────────────────────────────────────────────────

/**
 * 관찰 이름표. `affects_result` 는 이 관찰이 결과 판정을 partial 로 내리는지다.
 * 'none' 은 알려는 주되 판정은 안 바꾸는 것.
 */
export const WARNINGS = Object.freeze({
  redirected: { why: '요청한 URL 과 도착한 URL 이 다르다', affects_result: 'none' },
  http_error_status: { why: '상태가 400 이상이다. 자료는 받았을 수 있다', affects_result: 'none' },
  error_page_text_detected: { why: '본문에 오류 문구가 보인다 — 관찰일 뿐 무효 판정이 아니다', affects_result: 'none' },
  empty_text: { why: '보이는 글자가 하나도 없다', affects_result: 'none' },
  thin_text: {
    why: '받은 본문이 차림표·머리글 정도밖에 안 된다 — 내용을 자바스크립트로 그리는 쪽일 수 있다.'
      + ' browser 모드로 다시 보면 달라질 수 있다',
    affects_result: 'none',
  },
  charset_unsupported: { why: '선언된 인코딩을 몰라 utf-8 로 읽었다', affects_result: 'none' },
  robots_disallowed: { why: 'robots.txt 가 명시적으로 막았다', affects_result: 'none' },
  blocked_page_suspected: { why: '봇 차단 화면의 지문이 보인다 — 관찰일 뿐이다', affects_result: 'none' },
  subresource_blocked: { why: '쪽 안의 일부 요청을 안전 규칙으로 끊었다', affects_result: 'none' },
  images_not_requested_by_browser: { why: '브라우저가 안 고른 후보·화면 밖 그림이라 부르지 않았다', affects_result: 'none' },
  image_mime_mismatch: { why: '머리에 적힌 형식과 바이트가 말하는 형식이 다르다', affects_result: 'none' },
  browser_no_pinned_connection: { why: '브라우저 모드라 연결 대상 IP 고정이 없다', affects_result: 'none' },

  // 아래는 "받긴 받았는데 다 받지는 못했다" 는 것들이다. 그래서 판정이 partial 로 내려간다.
  response_truncated: { why: '응답이 크기 상한에 걸려 잘렸다', affects_result: 'partial' },
  image_fetch_partial: { why: '선언된 그림 중 일부를 못 받았다', affects_result: 'partial' },
  image_fetch_none: { why: '선언된 그림을 하나도 못 받았다', affects_result: 'partial' },
  images_over_limit: { why: '그림 수 상한에 걸려 나머지는 시도하지 않았다', affects_result: 'partial' },
  image_scan_capped: { why: 'CSS 배경을 훑다 요소 수 상한에 걸렸다', affects_result: 'partial' },
  screenshot_truncated: { why: '전체 캡처가 높이 상한에서 잘렸다', affects_result: 'partial' },
  scroll_limit_reached: { why: '스크롤 상한에 걸려 더 내려가지 않았다', affects_result: 'partial' },
});

export const WARNING_CODES = Object.freeze(Object.keys(WARNINGS));
/** 이 관찰이 붙으면 결과가 partial 로 내려간다. */
export const PARTIAL_WARNINGS = Object.freeze(WARNING_CODES.filter((w) => WARNINGS[w].affects_result === 'partial'));

export const isKnownWarning = (w) => Object.prototype.hasOwnProperty.call(WARNINGS, w);

/** 모르는 이름이 섞여 들어오면 세워 둔다. 조용히 통과시키면 낱말이 다시 흩어진다. */
export function assertWarnings(list) {
  const unknown = (list ?? []).filter((w) => !isKnownWarning(w));
  if (unknown.length) {
    throw new ErrorVocabError('unknown_warning',
      `모르는 관찰 이름입니다: ${unknown.join('·')} — lib/errors.mjs 의 WARNINGS 에 먼저 적으십시오`);
  }
  return list ?? [];
}

// ── 실패 단계와 코드 ──────────────────────────────────────────

/** 어디까지 갔다가 넘어졌나. 단계를 알면 다음에 무엇을 볼지가 정해진다. */
export const ERROR_STAGES = Object.freeze({
  input: '부른 쪽이 준 값이 잘못됐다. 네트워크로 나가기 전이다',
  url: 'URL 을 읽을 수 없거나 http·https 가 아니다',
  policy: '나가면 안 되는 목적지다',
  dns: '이름을 주소로 못 바꿨다',
  pace: '속도 제한 때문에 자리를 못 받았다',
  connect: '주소까지는 알았는데 붙지 못했다',
  tls: '붙었는데 암호화 악수에서 넘어졌다',
  response: '보냈는데 응답 머리가 안 왔거나 늦었다',
  body: '머리는 왔는데 본문이 안 끝났다',
  redirect: '따라가다 고리에 걸렸거나 갈 곳이 없다',
  robots: 'robots.txt 가 막았다',
  deps: '필요한 프로그램이 이 자리에 없다',
  navigate: '브라우저가 그 쪽으로 못 갔다',
  render: '브라우저가 그렸지만 제때 못 끝냈다',
  browser: '브라우저 자체가 넘어졌다',
  collector: '수집기 코드가 터졌다',
  request: '그 밖의 전송 실패',
});

/**
 * 우리가 만들어 내는 실패 코드. `retryable` 은 "조건이 달라지면 다시 될 수도 있다" 는 뜻이지
 * "다시 하면 된다" 는 약속이 아니다.
 */
export const ERROR_CODES = Object.freeze({
  // 입력 — 나가기 전에 걸린다
  bad_mode: { stage: 'input', short: 'mode 는 http·browser 중 하나입니다', retryable: false },
  bad_output: { stage: 'input', short: '모르는 산출물 이름입니다', retryable: false },
  no_outputs: { stage: 'input', short: '만들 산출물을 하나도 안 적었습니다', retryable: false },
  output_not_in_mode: { stage: 'input', short: '이 방식으로는 만들 수 없는 산출물입니다', retryable: false },
  unsupported_output: { stage: 'input', short: '이 수집기가 만들 수 없는 산출물입니다', retryable: false },
  stale_lease: { stage: 'input', short: '이 임대는 이미 끝났습니다', retryable: false },
  lease_expired: { stage: 'input', short: '임대가 만료됐습니다. 다시 빌리십시오', retryable: true },
  worker_mismatch: { stage: 'input', short: '이 임대를 잡은 워커가 아닙니다', retryable: false },

  // URL·목적지
  url_scheme: { stage: 'url', short: 'http·https 만 나갈 수 있습니다', retryable: false },
  url_userinfo: { stage: 'url', short: 'URL 에 사용자명·비밀번호를 담을 수 없습니다', retryable: false },
  url_unparsable: { stage: 'url', short: 'URL 로 읽을 수 없습니다', retryable: false },
  url_no_host: { stage: 'url', short: '호스트가 없습니다', retryable: false },
  ip_loopback: { stage: 'policy', short: '루프백 주소로는 나가지 않습니다', retryable: false },
  ip_private: { stage: 'policy', short: '사설망 주소로는 나가지 않습니다', retryable: false },
  ip_link_local: { stage: 'policy', short: '링크 로컬 주소로는 나가지 않습니다', retryable: false },
  ip_unspecified: { stage: 'policy', short: '지정되지 않은 주소입니다', retryable: false },
  ip_multicast: { stage: 'policy', short: '멀티캐스트 주소입니다', retryable: false },
  ip_reserved: { stage: 'policy', short: '예약된 주소입니다', retryable: false },
  ip_documentation: { stage: 'policy', short: '문서용 예시 주소입니다', retryable: false },
  ip_shared_cgnat: { stage: 'policy', short: '통신사 공유 대역 주소입니다', retryable: false },
  ip_benchmark: { stage: 'policy', short: '성능 시험용 대역 주소입니다', retryable: false },
  ip_nat64: { stage: 'policy', short: 'NAT64 대역 주소입니다', retryable: false },
  hostname_localhost: { stage: 'policy', short: 'localhost 라는 이름으로는 나가지 않습니다', retryable: false },
  resolves_to_non_public: { stage: 'policy', short: '이름이 공인 아닌 주소로 풀립니다', retryable: false },
  no_public_address: { stage: 'policy', short: '공인 주소가 하나도 없습니다', retryable: false },
  remote_address_mismatch: { stage: 'connect', short: '허용 집합 밖으로 연결됐습니다', retryable: false },

  // 이름 풀이
  dns_ENOTFOUND: { stage: 'dns', short: '그런 이름이 없습니다', retryable: false },
  dns_EAI_AGAIN: { stage: 'dns', short: '이름 풀이가 일시적으로 실패했습니다', retryable: true },
  dns_empty: { stage: 'dns', short: '이름은 있는데 주소가 안 왔습니다', retryable: true },
  dns_failed: { stage: 'dns', short: '이름을 못 풀었습니다', retryable: true },

  // 속도
  queue_too_long: { stage: 'pace', short: '이 도메인의 차례가 너무 멉니다. 나중에 다시 하십시오', retryable: true },
  domain_sleeping: { stage: 'pace', short: '이 도메인은 쉬는 중입니다', retryable: true },

  // 전송
  connect_timeout: { stage: 'connect', short: '정해진 시간 안에 연결되지 않았습니다', retryable: true },
  econnrefused: { stage: 'connect', short: '연결을 거절당했습니다', retryable: true },
  econnreset: { stage: 'connect', short: '연결이 끊겼습니다', retryable: true },
  ehostunreach: { stage: 'connect', short: '그 주소에 닿을 수 없습니다', retryable: true },
  enetunreach: { stage: 'connect', short: '망에 닿을 수 없습니다', retryable: true },
  etimedout: { stage: 'connect', short: '연결이 시간을 넘겼습니다', retryable: true },
  headers_timeout: { stage: 'response', short: '응답 머리가 제때 오지 않았습니다', retryable: true },
  body_timeout: { stage: 'body', short: '본문이 오다 멈췄습니다', retryable: true },
  overall_timeout: { stage: 'response', short: '전체 시간 상한을 넘겼습니다', retryable: true },
  decode_failed: { stage: 'body', short: '압축을 풀 수 없습니다', retryable: false },

  // 리다이렉트
  redirect_loop: { stage: 'redirect', short: '같은 곳으로 되돌아옵니다', retryable: false },
  too_many_redirects: { stage: 'redirect', short: '리다이렉트가 상한을 넘었습니다', retryable: false },
  redirect_no_location: { stage: 'redirect', short: '3xx 인데 갈 곳을 안 알려 줍니다', retryable: false },
  bad_location: { stage: 'redirect', short: 'Location 을 읽을 수 없습니다', retryable: false },

  // 브라우저
  playwright_not_found: { stage: 'deps', short: 'playwright 를 찾지 못했습니다', retryable: false },
  playwright_shape: { stage: 'deps', short: 'playwright 에 chromium 이 없습니다', retryable: false },
  goto_failed: { stage: 'navigate', short: '브라우저가 그 쪽으로 못 갔습니다', retryable: true },
  no_response: { stage: 'navigate', short: '응답 없이 끝났습니다', retryable: true },
  browser_failed: { stage: 'browser', short: '브라우저가 넘어졌습니다', retryable: true },

  // 그 밖
  collector_threw: { stage: 'collector', short: '수집기 코드가 터졌습니다', retryable: false },
  unknown: { stage: 'request', short: '알 수 없는 실패', retryable: true },
});

export const isKnownError = (code) => Object.prototype.hasOwnProperty.call(ERROR_CODES, code);

/**
 * 오류 한 건을 한 줄로. 모르는 코드도 숨기지 않고 그대로 보여 준다 —
 * "알 수 없음" 으로 뭉개면 새 실패가 영원히 안 보인다.
 */
export function describeError(stage, code) {
  const known = ERROR_CODES[code];
  const stageWhy = ERROR_STAGES[known?.stage ?? stage] ?? '알 수 없는 단계';
  const what = known?.short ?? `아직 이름표가 없는 실패입니다 (${code})`;
  return `${stage ?? known?.stage ?? '?'}/${code ?? '?'} — ${what}. (${stageWhy})`;
}

// ── 결과 판정 ─────────────────────────────────────────────────

/**
 * 계획서 5-2 를 그대로 옮긴 규칙. **자료가 쓸 만한지는 보지 않는다.**
 *   success — 요청한 산출물이 다 생겼다
 *   partial — 생기긴 했는데 일부가 모자라다(그림 일부 실패·잘림 따위)
 *   failed  — 하나도 못 만들었다
 */
export function classifyOutcome({ ok, produced = [], missing = [], warnings = [] }) {
  if (!ok) return 'failed';
  if (produced.length === 0) return 'failed';
  if (missing.length > 0) return 'partial';
  if (warnings.some((w) => PARTIAL_WARNINGS.includes(w))) return 'partial';
  return 'success';
}

// ── 오류 화면 문구 ────────────────────────────────────────────

/**
 * 널리 쓰이는 오류 화면 문구. **판정이 아니라 관찰이다.**
 * 상태 200 으로 오는 오류 화면을 사람이 놓치지 않도록 표시만 한다 — 수집 성공 여부는 안 바꾼다.
 */
export const ERROR_PAGE_PHRASES = Object.freeze([
  'something went wrong', 'whoops', 'page not found', '404 not found', 'not found',
  'oops', 'an error occurred', 'temporarily unavailable', 'service unavailable',
  '페이지를 찾을 수 없', '오류가 발생', '잘못된 접근', '일시적인 오류', '존재하지 않는 페이지',
]);

/** 오류 문구가 "맨 앞" 이라고 볼 자리. 머리글·차림표를 지나면 대개 여기까지다. */
export const ERROR_PAGE_HEAD_CHARS = 400;

/**
 * 이보다 짧으면 "차림표만 받았다" 로 본다.
 * 2026-08-12 실측: 자바스크립트로 그리는 상품 쪽 68장이 모두 742~1,444자였고, 그 글자는 전부
 * 머리글·차림표·숨은 안내 문구였다. 내용이 있는 쪽은 1,700자를 넘었다.
 */
export const THIN_TEXT_CHARS = 1500;

/**
 * 상태 200 으로 오는 오류 화면인가. **판정이 아니라 관찰이다.**
 *
 * [넓게 잡으면 신호가 죽는다] 처음에는 본문 앞 4,000자 아무 데나 문구가 있으면 표시했다.
 * 2026-08-12 시나리오 B 에서 한 사이트의 71쪽 중 **68쪽**에 이 표시가 붙었다 — 그 사이트가
 * 화면 곳곳에 쓸 안내 문구("저장되었습니다. 오류가 발생하였습니다.")를 페이지마다 숨겨 두고
 * 자바스크립트로 꺼내 쓰기 때문이었다. 96%에 붙는 표시는 아무것도 알려 주지 않는다.
 * 더 나쁜 것은, 그 소음에 익숙해지면 **진짜 오류 화면도 같이 넘기게 된다.**
 *
 * 그래서 둘 중 하나일 때만 표시한다.
 *   (1) 제목에 있다 — 오류 화면은 제목부터 그렇게 말한다
 *   (2) 본문 맨 앞(400자)에 있다 — 머리글을 지나자마자 그 말이 나온다
 * 긴 정상 쪽 깊숙이 박힌 안내 문구는 표시하지 않는다.
 *
 * "내용이 거의 없다" 는 다른 사실이라 다른 이름으로 적는다(thin_text). 둘을 한 이름에 묶으면
 * "오류 화면이라서 짧은가" 와 "자바스크립트로 그려서 짧은가" 가 구별되지 않는다.
 *
 * @returns {{detected:boolean, phrase:string|null, where:'title'|'head'|null, at:number|null}}
 */
export function detectErrorPageText(text, title = null) {
  const body = String(text ?? '');
  const lower = body.toLowerCase();
  const t = String(title ?? '').toLowerCase();

  for (const p of ERROR_PAGE_PHRASES) {
    if (t.includes(p)) return { detected: true, phrase: p, where: 'title', at: t.indexOf(p) };
  }
  const head = lower.slice(0, ERROR_PAGE_HEAD_CHARS);
  for (const p of ERROR_PAGE_PHRASES) {
    if (head.includes(p)) return { detected: true, phrase: p, where: 'head', at: head.indexOf(p) };
  }
  return { detected: false, phrase: null, where: null, at: null };
}

/** 글자는 있는데 내용은 없는 쪽인가. empty_text 와 다른 사실이다 — 저쪽은 아예 0자다. */
export const isThinText = (chars) => chars > 0 && chars < THIN_TEXT_CHARS;
