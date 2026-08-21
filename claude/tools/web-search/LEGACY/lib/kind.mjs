// 주소의 종류 판정 — 목록인가 상세인가 사이트맵인가.
//
// discover 와 store 두 곳이 같은 잣대를 써야 한다. 한쪽만 쓰면 같은 주소가
// 발견 경로에서는 detail 이고 report 경로에서는 unknown 이 되어, 목록 우선 규칙이 조용히 깨진다.
// (store 가 discover 를 부르면 순환이 되므로 이 모듈로 따로 뺐다. 2026-08-11)

/**
 * @param {string} url
 * @param {{cards?:number}} hint  카드 수 같은 관찰값. 없으면 경로 모양만 본다.
 * @returns {{kind:'listing'|'detail'|'sitemap'|'unknown', status:string, evidence:string[]}}
 */
export function classifyKind(url, hint = {}) {
  const evidence = [];
  let u;
  try { u = new URL(url); } catch { return { kind: 'unknown', status: 'needs_review', evidence: ['bad_url'] }; }
  const p = u.pathname.toLowerCase();

  if (/\.xml$/.test(p) || /sitemap/.test(p)) {
    evidence.push('path_looks_sitemap');
    return { kind: 'sitemap', status: 'proposed', evidence };
  }
  if ((hint.cards ?? 0) >= 2) evidence.push(`cards:${hint.cards}`);
  if (/(list|listing|collections?|products?$|catalog|goods$|mcard|category)/.test(p)) evidence.push('path_looks_listing');

  // 상세는 "한 물건을 가리키는 마지막 조각"이다.
  // /detail 로 끝날 때만 보면 /Product/Detail/1188 같은 실제 상세를 놓친다
  // (2026-08-11 바른손 실측: 69개가 unknown 으로 새어 나가 목록 우선 절감이 0이 됐다).
  // 반대로 /product/list 처럼 마지막 조각이 목록을 뜻하는 말이면 상세가 아니다 —
  // 둘 다 걸리면 unknown 이 되어 워커가 그 쪽을 열어 버린다.
  const lastSeg = p.replace(/\/+$/, '').split('/').pop() || '';
  const LISTING_LAST = /^(list|listing|all|index|category|categories|collection|collections|product|products|goods|catalog)$/;
  if (/(\/products?\/[^/]+|\/detail(\/[^/]+)?|\/goods\/[^/]+|\/item\/[^/]+|\/p\/[^/]+)$/.test(p)
      && !LISTING_LAST.test(lastSeg)) {
    evidence.push('path_looks_detail');
  }

  const listingish = evidence.some((e) => e.startsWith('cards:')) || evidence.includes('path_looks_listing');
  const detailish = evidence.includes('path_looks_detail');
  if (listingish && !detailish) return { kind: 'listing', status: 'proposed', evidence };
  if (detailish && !listingish) return { kind: 'detail', status: 'proposed', evidence };
  return { kind: 'unknown', status: 'needs_review', evidence: evidence.length ? evidence : ['no_signal'] };
}
