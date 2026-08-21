// web-search — 경계 판정과 도메인 안쪽 제동
// 계획서 2-7. 태스크 16·17.
//
// [원칙 1] 경계를 통과하지 못한 링크는 더미에 들어가지 않는다. 대신 왜 떨어졌는지는 남긴다.
//   떨어진 것을 안 남기면 "안 나왔다"와 "우리가 막았다"를 나중에 구분할 수 없다.
// [원칙 2] 깊이는 바깥 도메인으로 넘어갈 때만 오른다. 같은 도메인 안은 유지하고,
//   대신 형태별 개수로 제동을 건다 — 같은 사이트 안에서 무한히 늘어나는 건 깊이가 아니라 형태다.
// [원칙 3] 상한에 닿으면 조용히 자르지 않는다. 어떤 형태가 몇 개 늘었는지 세워 사람에게 넘긴다.

/** 도메인이 목록에 드는가 — 자신이거나 하위 도메인이면 든다. */
export function domainMatches(domain, list) {
  const d = String(domain || '').toLowerCase().replace(/^www\./, '');
  return list.some((raw) => {
    const x = String(raw).toLowerCase().replace(/^www\./, '');
    return d === x || d.endsWith(`.${x}`);
  });
}

// ---------- 경로 무늬 (도메인 프로필과 정책이 함께 쓰는 하나의 문법) ----------
//
// 프로필은 "/products/*" 같은 모양을 제안하고 정책은 그 모양으로 판정한다. 문법이 갈리면
// 같은 글자가 두 뜻이 된다 — 정규식으로 읽으면 * 는 "앞 글자의 반복"이라 /products/abc 를 못 맞춘다.
// 그래서 임의 정규식을 받지 않는다. 받지 않으면 중첩 반복으로 인한 멈춤(ReDoS)도 애초에 없다.
//   *   경로 한 조각(슬래시 없는 한 덩어리)
//   **  남은 조각 전부
export function validPathPattern(p) {
  if (typeof p !== 'string' || !p.trim()) return { ok: false, why: '빈 값' };
  if (!p.startsWith('/')) return { ok: false, why: '/ 로 시작해야 합니다' };
  if (/[?#\s]/.test(p)) return { ok: false, why: '경로만 적습니다(물음표·우물정자·공백 불가)' };
  if (!/^[A-Za-z0-9._~\-/*%]+$/.test(p)) return { ok: false, why: '경로 무늬에 쓸 수 없는 글자가 있습니다' };
  for (const seg of p.split('/')) {
    if (seg.includes('*') && seg !== '*' && seg !== '**') {
      return { ok: false, why: `조각 안에서 * 를 섞어 쓸 수 없습니다: "${seg}"` };
    }
  }
  return { ok: true };
}

export function pathPatternRegExp(p) {
  const v = validPathPattern(p);
  if (!v.ok) throw new Error(`경로 무늬가 잘못되었습니다("${p}"): ${v.why}`);
  const body = p.split('/').map((seg) => {
    if (seg === '') return '';
    if (seg === '**') return '.+';
    if (seg === '*') return '[^/]+';
    return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }).join('/');
  return new RegExp(`^${body}/?$`);
}

export function matchesPathPattern(url, pattern) {
  let p;
  try { p = new URL(url).pathname; } catch { p = String(url); }
  return pathPatternRegExp(pattern).test(p);
}

/** 정책에 박아 둔 무늬로 목록·상세를 가른다. 둘 다 맞거나 둘 다 아니면 판단을 미룬다. */
export function classifyByPolicy(pol, url) {
  const hitL = (pol.listing_path_patterns || []).filter((p) => matchesPathPattern(url, p));
  const hitD = (pol.detail_path_patterns || []).filter((p) => matchesPathPattern(url, p));
  if (hitL.length && !hitD.length) return { kind: 'listing', matched: hitL };
  if (hitD.length && !hitL.length) return { kind: 'detail', matched: hitD };
  // 둘 다 맞으면 무늬가 서로 부딪히는 것이다. 아무거나 고르지 않고 판단을 미룬다.
  if (hitL.length && hitD.length) return { kind: null, matched: [...hitL, ...hitD], why: 'both_matched' };
  return { kind: null, matched: [] };
}

/** 경로의 "형태" — 마지막 조각이 숫자·해시면 * 로 뭉갠다. /p/12 와 /p/13 은 같은 형태다. */
export function pathShape(u) {
  try {
    const p = new URL(u).pathname;
    return p.split('/').map((seg) => {
      if (!seg) return seg;
      if (/^\d+$/.test(seg)) return '*';
      if (/^[0-9a-f]{8,}$/i.test(seg)) return '*';
      if (/\d{4}-\d{2}(-\d{2})?$/.test(seg)) return '*';
      return seg;
    }).join('/') || '/';
  } catch { return String(u); }
}

/** 쿼리 키 조합 — 값이 아니라 키의 짜임을 본다. sort=a 와 sort=b 는 같은 조합이다. */
export function queryCombo(u) {
  try {
    const keys = [...new URL(u).searchParams.keys()].map((k) => k.toLowerCase()).sort();
    return keys.join('&');
  } catch { return ''; }
}

// 달력·검색·거르개 — 조합만으로 끝없이 늘어나는 자리다. 따로 더 낮은 상한을 쓴다.
const FACETED_PATH = /(calendar|search|filter|tag|archive|date)/i;
const FACETED_KEY = /^(q|query|keyword|search|page|date|year|month|day|from|to|min|max|sort|order|filter|tag|category|cat|color|size|price)$/i;

export function facetKind(u) {
  try {
    const url = new URL(u);
    if (FACETED_PATH.test(url.pathname)) return 'path';
    const keys = [...url.searchParams.keys()];
    if (keys.some((k) => FACETED_KEY.test(k))) return 'query';
    return null;
  } catch { return null; }
}

/** 무엇 때문에 거르개로 봤는지 — 경로 낱말인지, 어떤 쿼리 키인지. 근거로 남긴다. */
export function facetKeys(u) {
  const out = [];
  try {
    const url = new URL(u);
    const m = url.pathname.match(FACETED_PATH);
    if (m) out.push(`path:${m[1].toLowerCase()}`);
    for (const k of url.searchParams.keys()) if (FACETED_KEY.test(k)) out.push(`query:${k.toLowerCase()}`);
  } catch {}
  return out;
}

function emptyDomainRec(domain) {
  return {
    domain, url_count: 0, shapes: {}, combos: {}, faceted: 0,
    facet_keys: {},        // 어떤 거르개 키가 몇 번 나왔나
    excluded_by: {},       // 어떤 규칙으로 몇 건을 안 들였나
    boundary_review: null,
  };
}

/**
 * 아예 들이지 않기로 정한 자리인가. 상한보다 먼저 본다 —
 * 상한은 "몇 개까지"이고 이건 "여기는 아니다"라 뜻이 다르다.
 */
export function matchExclusion(pol, url) {
  for (const p of pol.exclude_path_patterns || []) {
    if (matchesPathPattern(url, p)) return { why: 'excluded_path_pattern', evidence: { pattern: p } };
  }
  const keys = pol.exclude_query_keys || [];
  if (keys.length) {
    try {
      for (const k of new URL(url).searchParams.keys()) {
        if (keys.includes(k.toLowerCase())) return { why: 'excluded_query_key', evidence: { key: k.toLowerCase() } };
      }
    } catch {}
  }
  return null;
}

/**
 * 한 주소가 더미에 들어가도 되는지 본다. 장부를 바꾸지 않고 판단만 한다.
 * @param {object} pol      고정된 정책
 * @param {object} state    현재 장부(도메인 계수기를 본다)
 * @param {object} target   { url, domain }  이미 정규화된 것
 * @param {object|null} from  부모 기록 { domain, external_hops }
 * @returns {{ok:boolean, why?:string, evidence?:object, external_hops:number}}
 */
export function admit(pol, state, target, from = null) {
  const domains = state.domains || {};
  const rec = domains[target.domain] || emptyDomainRec(target.domain);
  const fromHops = from?.external_hops ?? 0;
  const allow = pol.allow_domains || [];
  const deny = pol.deny_domains || [];

  if (deny.length && domainMatches(target.domain, deny)) {
    return { ok: false, why: 'denied_domain', evidence: { deny_domains: deny }, external_hops: fromHops };
  }

  // 들이지 않기로 정한 자리는 한 건도 큐에 넣지 않는다(상한을 채운 뒤 막는 것이 아니다)
  const ex = matchExclusion(pol, target.url);
  if (ex) {
    return { ok: false, why: ex.why, evidence: { ...ex.evidence, facet_keys: facetKeys(target.url) }, external_hops: fromHops };
  }

  // 같은 도메인 안에서는 깊이가 오르지 않는다. 허용 목록 안이어도 마찬가지다.
  const sameDomain = !!from && from.domain === target.domain;
  const inAllow = allow.length ? domainMatches(target.domain, allow) : false;
  let hops = fromHops;
  if (!sameDomain && !inAllow) {
    hops = fromHops + 1;
    if (hops > (pol.external_hop_max ?? 2)) {
      return {
        ok: false, why: 'external_hop_exceeded',
        evidence: { from_domain: from?.domain ?? null, hops, external_hop_max: pol.external_hop_max },
        external_hops: hops,
      };
    }
  }

  // ---- 도메인 안쪽 제동 ----
  if (rec.url_count >= pol.domain_url_cap) {
    return {
      ok: false, why: 'domain_url_cap',
      evidence: { domain: target.domain, url_count: rec.url_count, cap: pol.domain_url_cap },
      external_hops: hops,
    };
  }
  const shape = pathShape(target.url);
  if ((rec.shapes[shape] || 0) >= pol.path_shape_cap) {
    return {
      ok: false, why: 'path_shape_cap',
      evidence: { shape, count: rec.shapes[shape], cap: pol.path_shape_cap },
      external_hops: hops,
    };
  }
  const combo = queryCombo(target.url);
  if (combo && (rec.combos[combo] || 0) >= pol.query_combo_cap) {
    return {
      ok: false, why: 'query_combo_cap',
      evidence: { combo, count: rec.combos[combo], cap: pol.query_combo_cap },
      external_hops: hops,
    };
  }
  const facet = facetKind(target.url);
  if (facet && rec.faceted >= pol.faceted_cap) {
    return {
      ok: false, why: 'faceted_cap',
      evidence: { facet, count: rec.faceted, cap: pol.faceted_cap },
      external_hops: hops,
    };
  }

  return { ok: true, external_hops: hops, shape, combo, facet, facet_keys: facet ? facetKeys(target.url) : [] };
}

/** 받아들인 주소를 도메인 계수기에 반영한다. */
export function countAccepted(state, target, verdict) {
  state.domains = state.domains || {};
  const rec = state.domains[target.domain] || (state.domains[target.domain] = emptyDomainRec(target.domain));
  rec.url_count++;
  if (verdict.shape) rec.shapes[verdict.shape] = (rec.shapes[verdict.shape] || 0) + 1;
  if (verdict.combo) rec.combos[verdict.combo] = (rec.combos[verdict.combo] || 0) + 1;
  if (verdict.facet) {
    rec.faceted++;
    rec.facet_keys = rec.facet_keys || {};
    for (const k of verdict.facet_keys || []) rec.facet_keys[k] = (rec.facet_keys[k] || 0) + 1;
  }
  return rec;
}

/** 안 들인 것도 센다. 무엇을 왜 안 봤는지가 보고서의 절반이다. */
export function countExcluded(state, domain, why, evidence) {
  state.domains = state.domains || {};
  const rec = state.domains[domain] || (state.domains[domain] = emptyDomainRec(domain));
  rec.excluded_by = rec.excluded_by || {};
  const label = evidence?.pattern ? `${why}:${evidence.pattern}`
    : evidence?.key ? `${why}:${evidence.key}` : why;
  rec.excluded_by[label] = (rec.excluded_by[label] || 0) + 1;
  rec.facet_keys = rec.facet_keys || {};
  for (const k of evidence?.facet_keys || []) rec.facet_keys[k] = (rec.facet_keys[k] || 0) + 1;
  return rec;
}

/**
 * 상한에 닿았다. 조용히 자르지 않고 도메인을 세워 둔다 —
 * 어떤 형태가 몇 개까지 늘었는지가 사람이 판단할 근거다.
 */
export function raiseBoundaryReview(state, domain, why, evidence, nowMs) {
  state.domains = state.domains || {};
  const rec = state.domains[domain] || (state.domains[domain] = emptyDomainRec(domain));
  const top = (obj, n) => Object.entries(obj || {}).sort((a, b) => b[1] - a[1]).slice(0, n)
    .map(([k, v]) => ({ what: k, count: v }));
  rec.boundary_review = {
    why, evidence,
    at: nowMs, at_iso: new Date(nowMs).toISOString(),
    url_count: rec.url_count,
    top_shapes: top(rec.shapes, 5),
    top_combos: top(rec.combos, 5),
    faceted: rec.faceted,
    top_facet_keys: top(rec.facet_keys, 5),
    excluded_by: top(rec.excluded_by, 5),
    note: '상한에 닿아 더 넣지 않습니다. 자른 게 아니라 세워 둔 것이니 사람이 보고 넓히거나 닫으세요.',
  };
  return rec.boundary_review;
}
