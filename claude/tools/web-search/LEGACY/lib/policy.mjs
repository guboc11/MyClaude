// web-search — 정책(경계) 검증
// 계획서 2-7, 2-8. 태스크 16.
//
// [원칙 1] 경계는 크롤을 만들 때 고정한다. 나중에 넓히면 "전수"의 뜻이 조용히 바뀐다.
// [원칙 2] exhaustive 는 언제 그만둘지를 정할 수 없다. 목표 개수·시간·페이지로 끊으면 전수가 아니다.
// [원칙 3] 못 쓰는 값은 조용히 고쳐 쓰지 않고 거절한다. 조용히 고치면 사람이 준 경계와
//   실제로 도는 경계가 달라지고, 그 차이는 보고서 어디에도 안 남는다.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { crawlPaths } from './paths.mjs';
import { validPathPattern } from './boundary.mjs';

export const MODES = ['exhaustive', 'pilot'];

// pilot 에서만 둘 수 있는 "그만둘 조건"
export const BUDGET_KEYS = ['target_count', 'max_pages', 'time_budget_ms', 'max_domains'];

// 만든 뒤 못 바꾸는 것 — 이걸 바꾸면 다른 크롤이다
export const FROZEN_KEYS = [
  'mode', 'allow_domains', 'deny_domains', 'keep_params_by_domain', 'drop_params', 'drop_params_by_domain',
  // 무엇을 목록·상세로 볼지, 어떤 낱말을 신호로 볼지, 누구의 프로필 판을 썼는지 —
  // 도중에 바뀌면 앞뒤 결과가 같은 잣대로 모인 것이 아니게 된다
  'listing_path_patterns', 'detail_path_patterns', 'required_words', 'required_words_role',
  'domain_profile_ref', 'exclude_path_patterns', 'exclude_query_keys',
  'coverage_targets', 'domain_meta',
];

// 사람이 넓힐 수 있는 제동 상한 — 멈춘 자리에서 이어 달리려면 필요하다
export const ADJUSTABLE_KEYS = [
  'min_interval_ms', 'interval_jitter_ms', 'daily_cap', 'domain_url_cap',
  'external_hop_max', 'sitemap_depth_max', 'path_shape_cap', 'query_combo_cap', 'faceted_cap',
  'lease_ttl_ms', 'max_attempts', 'block_threshold', 'block_sleep_ms', 'retry_backoff_ms',
  ...BUDGET_KEYS,
];

// [한 표] 만들 때와 넓힐 때가 같은 잣대를 써야 한다.
// 방향만 보고 범위를 안 보면 block_sleep_ms 에 10의 15승 같은 값이 들어가 사실상 영영 쉰다.
export const RANGES = {
  external_hop_max: [0, 5],
  min_interval_ms: [0, 3_600_000],
  interval_jitter_ms: [0, 3_600_000],
  daily_cap: [1, 1_000_000],
  domain_url_cap: [1, 1_000_000],
  path_shape_cap: [1, 1_000_000],
  query_combo_cap: [1, 1_000_000],
  faceted_cap: [1, 1_000_000],
  sitemap_depth_max: [1, 32],
  lease_ttl_ms: [1_000, 86_400_000],
  max_attempts: [1, 20],
  block_threshold: [1, 100],
  block_sleep_ms: [1_000, 86_400_000],
  retry_backoff_ms: [1_000, 86_400_000],   // 0 은 물러나지 않는다는 뜻이라 받지 않는다
  target_count: [1, 10_000_000],
  max_pages: [1, 10_000_000],
  time_budget_ms: [1, 10_000_000],
  max_domains: [1, 10_000_000],
};

// [추천값일 뿐 기본값이 아니다] 전수 수집에서 태그·보관함·검색 경로를 자동으로 빼면,
// 그 안에만 있는 유한한 목록까지 조용히 놓친다. 그리고 excluded 가 "사람이 정한 경계"라는 뜻을 잃는다.
// 그래서 기본은 빈 목록이고, 사이트를 보고 그 도메인에만 적어 넣는다.
// 쪽(page)·정렬(sort·order)은 추천값에도 넣지 않는다 — 목록을 훑는 정상 통로다.
export const SUGGESTED_EXCLUDE_PATHS = [
  '/calendar', '/calendar/**', '/search', '/search/**',
  '/tag/**', '/tags/**', '/archive/**', '/archives/**',
];
export const SUGGESTED_EXCLUDE_QUERY_KEYS = [
  'date', 'year', 'month', 'day', 'from', 'to',
  'q', 'query', 'keyword', 'search', 'filter',
];

export class PolicyError extends Error {
  constructor(errors) {
    super(errors.join(' / '));
    this.name = 'PolicyError';
    this.errors = errors;
  }
}

function normDomain(d) { return String(d).trim().toLowerCase().replace(/^www\./, ''); }

// 도메인 칸에는 도메인만 적는다. "https://a.test/x:8080" 을 받아 주면 경계가 무엇인지
// 사람과 코드가 서로 다르게 읽는다.
function domainList(v, what, errors) {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) { errors.push(`${what} 는 배열이어야 합니다.`); return []; }
  const out = [];
  for (const d of v) {
    if (typeof d !== 'string' || !d.trim()) { errors.push(`${what} 에 빈 값이 있습니다.`); continue; }
    const raw = d.trim();
    if (raw !== d) { errors.push(`${what} 에 앞뒤 공백이 있습니다: "${d}"`); continue; }
    if (/\s/.test(raw)) { errors.push(`${what} 에 공백을 쓸 수 없습니다: "${d}"`); continue; }
    if (/:\/\//.test(raw)) { errors.push(`${what} 에는 스킴(http://)을 빼고 도메인만 적습니다: "${d}"`); continue; }
    if (raw.includes('/')) { errors.push(`${what} 에는 경로를 쓸 수 없습니다: "${d}"`); continue; }
    if (raw.includes(':')) { errors.push(`${what} 에는 포트를 쓸 수 없습니다: "${d}"`); continue; }
    if (raw.includes('?') || raw.includes('#') || raw.includes('@')) { errors.push(`${what} 에 쓸 수 없는 글자가 있습니다: "${d}"`); continue; }
    if (raw.startsWith('.') || raw.endsWith('.')) { errors.push(`${what} 의 도메인이 점으로 시작·끝납니다: "${d}"`); continue; }
    if (!/^[a-z0-9.-]+$/i.test(raw)) { errors.push(`${what} 에 도메인이 아닌 글자가 있습니다: "${d}"`); continue; }
    out.push(normDomain(raw));
  }
  return [...new Set(out)];
}

/** a 가 b 이거나 b 의 하위 도메인인가 */
function under(a, b) { return a === b || a.endsWith(`.${b}`); }

function stringArray(v, what, errors) {
  if (!Array.isArray(v)) { errors.push(`${what} 는 문자열 배열이어야 합니다.`); return false; }
  for (const x of v) {
    if (typeof x !== 'string' || !x.trim()) { errors.push(`${what} 에 문자열이 아닌 값이 있습니다.`); return false; }
  }
  return true;
}

// 목록·상세 판별 규칙은 도메인 프로필이 내놓는 것과 "같은 문법"으로 쓴다 — 경로 조각 와일드카드.
// 정규식으로 받으면 프로필의 "/products/*" 가 /products/abc 를 못 맞추고(별표가 반복 기호가 된다),
// 임의 정규식을 받는 순간 중첩 반복으로 멈추는 위험까지 떠안는다.
function patternArray(v, what, errors) {
  if (v === undefined || v === null) return [];
  if (!stringArray(v, what, errors)) return [];
  for (const src of v) {
    const r = validPathPattern(src);
    if (!r.ok) errors.push(`${what} 의 "${src}" 는 경로 무늬가 아닙니다: ${r.why}`);
  }
  return [...v];
}

function intIn(v, def, { key, errors }) {
  const [min, max] = RANGES[key];
  if (v === undefined || v === null) return def;
  if (typeof v !== 'number' || !Number.isInteger(v)) { errors.push(`${key} 는 정수여야 합니다: ${v}`); return def; }
  if (v < min || v > max) { errors.push(`${key} 는 ${min}~${max} 여야 합니다: ${v}`); return def; }
  return v;
}

/**
 * 정책을 검증해 고정형으로 만든다. 하나라도 어긋나면 PolicyError 로 거절한다.
 * @param {object} input  사람이 준 값
 * @param {string[]} seedDomains  씨앗에서 뽑은 도메인 — allow_domains 를 안 줬을 때의 근거
 */
export function validatePolicy(input = {}, seedDomains = []) {
  const errors = [];
  const mode = input.mode ?? 'pilot';
  if (!MODES.includes(mode)) errors.push(`mode 는 ${MODES.join(' 또는 ')} 여야 합니다: "${mode}"`);

  const deny = domainList(input.deny_domains, 'deny_domains', errors);
  let allow = domainList(input.allow_domains, 'allow_domains', errors);
  let allowFrom = 'given';
  if (!allow.length && seedDomains.length) {
    allow = [...new Set(seedDomains.map(normDomain))];
    allowFrom = 'seeds';            // 씨앗이 곧 범위다. 근거를 남긴다.
  }
  // 같은 도메인만이 아니라 포함 관계도 충돌이다 —
  // 허용 a.example.com + 제외 example.com 은 "된다"와 "안 된다"를 동시에 말한 것이다.
  const clashes = [];
  for (const a of allow) {
    for (const d of deny) if (under(a, d) || under(d, a)) clashes.push(`${a} ↔ ${d}`);
  }
  if (clashes.length) errors.push(`허용과 제외가 서로 겹칩니다: ${clashes.join(', ')}`);

  // 그만둘 조건 — exhaustive 에는 둘 수 없다
  const budgets = {};
  for (const k of BUDGET_KEYS) {
    const v = input[k];
    if (v === undefined || v === null) { budgets[k] = null; continue; }
    if (mode === 'exhaustive') {
      errors.push(`exhaustive 에는 ${k} 를 둘 수 없습니다 — 그만둘 조건을 정하면 전수가 아닙니다.`);
      budgets[k] = null;
      continue;
    }
    budgets[k] = intIn(v, null, { key: k, errors });
  }
  if (mode === 'exhaustive' && !allow.length) {
    errors.push('exhaustive 는 범위가 있어야 합니다 — allow_domains 를 주거나 씨앗을 주세요.');
  }

  const pol = {
    policy_version: 1,              // 넓힐 때마다 오른다. 장부가 어느 판까지 반영했는지 대조하는 열쇠.
    mode,
    sampled: mode === 'pilot',      // pilot 결과에는 반드시 표본이라는 표시가 붙는다
    allow_domains: allow,
    allow_domains_from: allowFrom,
    deny_domains: deny,
    external_hop_max: intIn(input.external_hop_max, 2, { key: 'external_hop_max', errors }),
    drop_params: input.drop_params ?? null,
    keep_params_by_domain: input.keep_params_by_domain ?? {},
    // 정렬·보기처럼 사이트마다 뜻이 다른 파라미터는 여기에 적어야만 지운다
    drop_params_by_domain: input.drop_params_by_domain ?? {},
    min_interval_ms: intIn(input.min_interval_ms, 10_000, { key: 'min_interval_ms', errors }),
    interval_jitter_ms: intIn(input.interval_jitter_ms, 5_000, { key: 'interval_jitter_ms', errors }),
    daily_cap: intIn(input.daily_cap, 300, { key: 'daily_cap', errors }),
    domain_url_cap: intIn(input.domain_url_cap, 2_000, { key: 'domain_url_cap', errors }),
    // 도메인 안쪽 제동 — 같은 형태가 몇 개까지 늘어도 되는가
    path_shape_cap: intIn(input.path_shape_cap, 500, { key: 'path_shape_cap', errors }),
    query_combo_cap: intIn(input.query_combo_cap, 200, { key: 'query_combo_cap', errors }),
    faceted_cap: intIn(input.faceted_cap, 50, { key: 'faceted_cap', errors }),
    sitemap_depth_max: intIn(input.sitemap_depth_max, 4, { key: 'sitemap_depth_max', errors }),
    lease_ttl_ms: intIn(input.lease_ttl_ms, 120_000, { key: 'lease_ttl_ms', errors }),
    max_attempts: intIn(input.max_attempts, 3, { key: 'max_attempts', errors }),

    // 목록·상세 판별 규칙 — 어떤 판을 썼는지 크롤에 박아 둔다
    listing_path_patterns: patternArray(input.listing_path_patterns, 'listing_path_patterns', errors),
    detail_path_patterns: patternArray(input.detail_path_patterns, 'detail_path_patterns', errors),
    // [아예 안 들어가는 자리] 달력·검색처럼 조합만으로 끝없이 늘어나는 곳은 상한으로 막기 전에
    // 애초에 들이지 않는다. 상한은 "몇 개까지"이고 이건 "여기는 아니다"라는 다른 말이다.
    // 쪽·정렬은 여기 넣지 않는다 — 그건 목록을 훑는 정상 통로다.
    exclude_path_patterns: patternArray(input.exclude_path_patterns ?? [], 'exclude_path_patterns', errors),
    exclude_query_keys: (() => {
      const v = input.exclude_query_keys ?? [];
      return stringArray(v, 'exclude_query_keys', errors) ? v.map((k) => String(k).toLowerCase()) : [];
    })(),
    // 확정된 도메인 프로필을 빌려 쓸 때, 어느 크롤의 판인지 고정한다
    domain_profile_ref: input.domain_profile_ref ?? null,
    domain_profile_pinned: null,

    // [빈칸 표] 나라·언어·검색 경로·업체 유형은 코드가 짐작하지 않는다.
    // 사람이 목표로 적어 둔 칸과, 도메인마다 사람이 적어 둔 값만 근거로 쓴다.
    // 짐작해서 채우면 빈칸이 사라져 무엇을 아직 안 봤는지 알 수 없게 된다.
    coverage_targets: input.coverage_targets ?? {},
    domain_meta: input.domain_meta ?? {},

    // 차단 낌새와 휴면 — 몇 번 이상하면 얼마나 쉬는가
    block_threshold: intIn(input.block_threshold, 3, { key: 'block_threshold', errors }),
    block_sleep_ms: intIn(input.block_sleep_ms, 3 * 60 * 60 * 1000, { key: 'block_sleep_ms', errors }),
    retry_backoff_ms: intIn(input.retry_backoff_ms, 60_000, { key: 'retry_backoff_ms', errors }),

    // 필수 낱말 — 버리는 조건이 아니라 "사람이 봐야 한다"는 신호로만 쓴다.
    // 이미지 위주 사이트와 다른 언어 사이트에서 낱말이 없다는 이유로 빼면 진짜를 놓친다.
    required_words: [],
    required_words_role: 'review_signal_only',
    ...budgets,
  };
  if (input.required_words !== undefined && input.required_words !== null) {
    if (stringArray(input.required_words, 'required_words', errors)) pol.required_words = [...input.required_words];
  }
  if (input.required_words_role !== undefined && input.required_words_role !== 'review_signal_only') {
    errors.push('required_words 는 거르는 조건이 될 수 없습니다 — required_words_role 은 review_signal_only 뿐입니다.');
  }
  if (pol.domain_profile_ref !== null) {
    if (typeof pol.domain_profile_ref !== 'string' || !pol.domain_profile_ref.trim()) {
      errors.push('domain_profile_ref 는 프로필을 빌려 올 크롤 이름이어야 합니다.');
    } else {
      try {
        const dir = crawlPaths(pol.domain_profile_ref).profiles;
        if (!fs.existsSync(dir)) errors.push(`domain_profile_ref 로 지정한 크롤에 프로필이 없습니다: ${pol.domain_profile_ref}`);
        else {
          // [고정] 상태와 시각만 베끼면 원본이 바뀐 뒤 "그때 쓴 판"을 되살릴 수 없다.
          // 실제 무늬와 카드 서명까지 통째로 박고, 원문 해시로 나중에 대조할 수 있게 한다.
          const pinned = {};
          for (const f of fs.readdirSync(dir)) {
            if (!f.endsWith('.json')) continue;
            let text;
            try { text = fs.readFileSync(path.join(dir, f), 'utf8'); } catch { continue; }
            let rec;
            try { rec = JSON.parse(text); } catch { continue; }
            if (rec.status !== 'confirmed' && rec.status !== 'manual_override') continue;
            pinned[rec.domain] = {
              status: rec.status,
              at: rec.confirmed_at ?? rec.overridden_at ?? null,
              listing_path_patterns: rec.listing_path_patterns ?? [],
              detail_path_patterns: rec.detail_path_patterns ?? [],
              accepted_card_signature: rec.accepted_card_signature ?? null,
              manual_selectors: rec.manual_selectors ?? null,
              source_sha256: crypto.createHash('sha256').update(text).digest('hex'),
            };
            for (const p of [...pinned[rec.domain].listing_path_patterns, ...pinned[rec.domain].detail_path_patterns]) {
              const v = validPathPattern(p);
              if (!v.ok) errors.push(`${rec.domain} 프로필의 무늬 "${p}" 를 쓸 수 없습니다: ${v.why}`);
            }
          }
          if (!Object.keys(pinned).length) {
            errors.push(`domain_profile_ref 로 지정한 크롤에 확정된 프로필이 없습니다: ${pol.domain_profile_ref}`);
          }
          pol.domain_profile_pinned = { from: pol.domain_profile_ref, at: Date.now(), profiles: pinned };
        }
      } catch (e) { errors.push(`domain_profile_ref 를 읽을 수 없습니다: ${e.message}`); }
    }
  }

  if (typeof pol.keep_params_by_domain !== 'object' || pol.keep_params_by_domain === null
      || Array.isArray(pol.keep_params_by_domain)) {
    errors.push('keep_params_by_domain 은 { 도메인: [파라미터] } 꼴이어야 합니다.');
  } else {
    for (const [dom, list] of Object.entries(pol.keep_params_by_domain)) {
      domainList([dom], `keep_params_by_domain 의 키 "${dom}"`, errors);
      stringArray(list, `keep_params_by_domain["${dom}"]`, errors);
    }
  }
  if (pol.drop_params !== null) stringArray(pol.drop_params, 'drop_params', errors);

  // 빈칸 표의 축과 값 — 축 이름과 값 목록만 받는다
  if (typeof pol.coverage_targets !== 'object' || pol.coverage_targets === null || Array.isArray(pol.coverage_targets)) {
    errors.push('coverage_targets 는 { 축: [값] } 꼴이어야 합니다.');
  } else {
    for (const [axis, vals] of Object.entries(pol.coverage_targets)) {
      if (!/^[a-z_]{2,30}$/.test(axis)) errors.push(`coverage_targets 의 축 이름이 이상합니다: "${axis}"`);
      stringArray(vals, `coverage_targets["${axis}"]`, errors);
    }
  }
  if (typeof pol.domain_meta !== 'object' || pol.domain_meta === null || Array.isArray(pol.domain_meta)) {
    errors.push('domain_meta 는 { 도메인: { 축: 값 } } 꼴이어야 합니다.');
  } else {
    for (const [dom, meta] of Object.entries(pol.domain_meta)) {
      domainList([dom], `domain_meta 의 키 "${dom}"`, errors);
      if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) {
        errors.push(`domain_meta["${dom}"] 는 { 축: 값 } 꼴이어야 합니다.`);
        continue;
      }
      for (const [axis, v] of Object.entries(meta)) {
        if (typeof v !== 'string' || !v.trim()) errors.push(`domain_meta["${dom}"]["${axis}"] 는 문자열이어야 합니다.`);
      }
    }
  }
  if (typeof pol.drop_params_by_domain !== 'object' || pol.drop_params_by_domain === null
      || Array.isArray(pol.drop_params_by_domain)) {
    errors.push('drop_params_by_domain 은 { 도메인: [파라미터] } 꼴이어야 합니다.');
  } else {
    for (const [dom, list] of Object.entries(pol.drop_params_by_domain)) {
      domainList([dom], `drop_params_by_domain 의 키 "${dom}"`, errors);
      if (!stringArray(list, `drop_params_by_domain["${dom}"]`, errors)) continue;
      // 같은 도메인에서 "지워라"와 "지우지 마라"를 동시에 말하면, 코드는 보존을 택하고
      // 사람은 제거를 기대한다. 그 어긋남을 조용히 두지 않는다.
      const keep = (pol.keep_params_by_domain?.[dom] || []).map((k) => String(k).toLowerCase());
      const both = list.map((k) => String(k).toLowerCase()).filter((k) => keep.includes(k));
      if (both.length) {
        errors.push(`${dom} 에서 같은 파라미터를 지우라고도 남기라고도 했습니다: ${both.join(', ')}`);
      }
    }
  }

  // 씨앗이 경계 밖이면 크롤 자체가 앞뒤가 안 맞는다 — 만들기 전에 막는다
  for (const sd of seedDomains.map(normDomain)) {
    if (deny.length && deny.some((d) => under(sd, d))) errors.push(`씨앗 도메인이 제외 목록에 있습니다: ${sd}`);
    else if (allowFrom === 'given' && allow.length && !allow.some((a) => under(sd, a))) {
      errors.push(`씨앗 도메인이 허용 범위 밖입니다: ${sd} (허용 ${allow.join(', ')})`);
    }
  }

  // 알아듣지 못한 키는 조용히 버리지 않는다 — 오타를 정책인 척 두면 경계가 새어 나간다
  const known = new Set([...Object.keys(pol), 'allow_domains_from', 'sampled']);
  const unknown = Object.keys(input).filter((k) => !known.has(k));
  if (unknown.length) errors.push(`모르는 정책 키가 있습니다(오타?): ${unknown.join(', ')}`);

  if (errors.length) throw new PolicyError(errors);
  return pol;
}

// 넓히기만 되는 값 — 낮추면 이미 받아들인 것과 앞으로 받을 것의 기준이 어긋난다
const GROW_ONLY = ['domain_url_cap', 'external_hop_max', 'sitemap_depth_max',
  'path_shape_cap', 'query_combo_cap', 'faceted_cap', 'max_attempts', 'lease_ttl_ms',
  'block_sleep_ms', 'retry_backoff_ms', ...BUDGET_KEYS];
// 남의 서버를 더 세게 두드리게 만드는 값 — 넓히기와 정반대 방향이라 따로 막는다
const POLITENESS = ['min_interval_ms', 'interval_jitter_ms'];
// 조심하는 쪽으로만 — 하루 상한은 줄이기만, 차단 낌새 기준은 낮추기만(더 빨리 쉰다)
const SHRINK_ONLY = ['daily_cap', 'block_threshold'];

/**
 * 만든 뒤 바꿔도 되는 값인지 본다. 지금 값과 견줘 방향까지 본다.
 * @param {object} patch  바꿀 값
 * @param {object} current  지금 정책
 */
export function checkUpdate(patch = {}, current = {}) {
  const errors = [];
  if (!patch || typeof patch !== 'object' || Array.isArray(patch) || !Object.keys(patch).length) {
    // 빈 갱신은 아무것도 안 바꾸면서 판 번호만 올려, 감사 기록에 뜻 없는 줄을 남긴다
    throw new PolicyError(['바꿀 값이 없습니다 — 빈 갱신으로 정책 판만 올릴 수 없습니다.']);
  }
  for (const [k, v] of Object.entries(patch)) {
    if (FROZEN_KEYS.includes(k)) { errors.push(`${k} 는 크롤을 만들 때 고정됩니다 — 바꾸려면 새 크롤을 만드세요.`); continue; }
    if (!ADJUSTABLE_KEYS.includes(k)) { errors.push(`모르는 정책 키입니다: ${k}`); continue; }
    // [같은 잣대] 넓히는 방향이어도 만들 때와 같은 형식·범위를 지켜야 한다.
    const range = RANGES[k];
    if (range) {
      if (typeof v !== 'number' || !Number.isInteger(v)) { errors.push(`${k} 는 정수여야 합니다: ${v}`); continue; }
      if (v < range[0] || v > range[1]) { errors.push(`${k} 는 ${range[0]}~${range[1]} 여야 합니다: ${v}`); continue; }
    }
    const old = current[k];
    if (GROW_ONLY.includes(k)) {
      if (typeof old === 'number' && v < old) {
        errors.push(`${k} 는 넓히기만 됩니다(${old} → ${v}). 좁히려면 새 크롤을 만드세요 — `
          + '이미 받아들인 것과 앞으로 받을 것의 기준이 달라집니다.');
      }
    } else if (POLITENESS.includes(k)) {
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) { errors.push(`${k} 는 0 이상 정수여야 합니다: ${v}`); continue; }
      if (typeof old === 'number' && v < old) {
        errors.push(`${k} 를 줄이면 더 세게 두드리게 됩니다(${old} → ${v}). 간격은 늘리는 쪽으로만 바꿉니다.`);
      }
    } else if (SHRINK_ONLY.includes(k)) {
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) { errors.push(`${k} 는 1 이상 정수여야 합니다: ${v}`); continue; }
      if (typeof old === 'number' && v > old) {
        errors.push(`${k} 를 늘리면 덜 조심하게 됩니다(${old} → ${v}). 이 값은 줄이는 쪽으로만 바꿉니다.`);
      }
    }
  }
  if (errors.length) throw new PolicyError(errors);
  return true;
}
