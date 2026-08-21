// robots 에서 sitemap 을 찾는 쪽.
//
// 태스크 #33. `lib/robots.mjs` 는 "여기 들어가도 되나" 를 답하고(정책), 이 파일은
// "이 도메인이 스스로 알려 준 주소 목록이 어디 있나" 를 답한다(발견). 파싱은 한 번만 한다 —
// robots 를 두 곳에서 따로 읽으면 두 곳의 이해가 갈라진다.
//
// [선언과 짐작을 구분한다] robots.txt 가 `Sitemap:` 으로 적어 준 것과, 우리가 관례로 넘겨짚는
// `/sitemap.xml` 은 다른 것이다. 앞은 도메인이 한 말이고 뒤는 우리 추측이다.
// 그 차이가 나중에 URL 의 source_kind 로 남는다 — robots 냐 sitemap 이냐.

import { parseRobots } from '../robots.mjs';

/** 관례로 넘겨짚는 자리. 도메인이 알려 준 것이 아니라 우리가 찍어 보는 곳이다. */
export const CONVENTIONAL_PATHS = Object.freeze(['/sitemap.xml', '/sitemap_index.xml']);

/**
 * robots.txt 한 장에서 sitemap 선언을 뽑는다.
 *
 * @param {string} robotsText
 * @param {string} origin  상대 주소를 풀 기준(`http://host:port`)
 * @returns {{url:string, raw:string, origin:'robots'}[]}  같은 주소가 여러 번 적혀 있어도 한 줄이다
 */
export function declaredSitemaps(robotsText, origin) {
  const parsed = parseRobots(robotsText);
  const out = [];
  const seen = new Set();
  for (const raw of parsed.sitemaps) {
    let url;
    try { url = new URL(raw, origin).toString(); } catch { continue; }
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({ url, raw, origin: 'robots' });
  }
  return out;
}

/**
 * 이 도메인에서 열어 볼 sitemap 후보를 순서대로.
 *
 * robots 가 알려 준 것이 먼저다. 관례 자리는 **robots 가 아무것도 안 알려 줬을 때만** 찍어 본다 —
 * 선언이 있는데도 넘겨짚으면 남의 서버를 이유 없이 한 번 더 두드리는 것이다.
 *
 * @returns {{seeds:{url,raw,origin}[], declared:number, guessed:number, robots_state:string}}
 */
export function sitemapSeeds({ robotsText, robotsState = 'allowed', origin }) {
  const declared = robotsText === null || robotsText === undefined ? [] : declaredSitemaps(robotsText, origin);
  if (declared.length) {
    return { seeds: declared, declared: declared.length, guessed: 0, robots_state: robotsState };
  }
  const guessed = CONVENTIONAL_PATHS.map((p) => ({ url: new URL(p, origin).toString(), raw: p, origin: 'convention' }));
  return { seeds: guessed, declared: 0, guessed: guessed.length, robots_state: robotsState };
}
