// robots.txt — 명시적으로 막은 곳만 막힌 것으로 센다.
//
// 계획서 5-4: "robots.txt 의 명시적 차단은 robots_disallowed 로 기록". 기록이지 판정이 아니다 —
// 막힌 줄을 그대로 남기고, 그래서 이 항목을 어떻게 할지는 에이전트가 정한다.
//
// [무엇을 "명시적" 으로 볼 것인가]
// robots.txt 가 없거나(404) 못 읽으면 **막힌 것이 아니다.** 규격은 5xx 를 전부 금지로 읽으라고
// 하지만, 그렇게 하면 상대 서버가 잠깐 흔들리는 것만으로 조사가 통째로 멈추면서 정작 왜 멈췄는지는
// 아무도 모른다. 여기서는 "못 읽었다" 를 그 상태 그대로(unknown) 남기고 나간다.
//
// 이 파일에는 네트워크 코드가 없다. 가져오는 일은 부른 쪽이 넘겨준 fetcher 가 한다 —
// 그래야 robots 도 다른 요청과 똑같은 안전 검사·속도 제한을 받는다.

export const ROBOTS_MAX_BYTES = 512 * 1024;

/**
 * 명시적으로 막힌 항목에 붙는 관찰 이름. 계획서 5-4 가 이 이름을 못박았다.
 * 여기 한 곳에만 두어 수집 계층(#28)이 딴 이름을 지어내지 않게 한다.
 */
export const ROBOTS_DISALLOWED = 'robots_disallowed';

/** 이 도구가 스스로를 부르는 이름. 도메인마다 바꾸지 않는다 — 그건 탐지 회피다. */
export const USER_AGENT = 'web-search-mcp/2.0 (local research workbench)';

/** robots 매칭에 쓰는 짧은 이름. User-agent 줄과 견줄 때 이것을 쓴다. */
export const ROBOTS_AGENT = 'web-search-mcp';

/**
 * robots.txt 한 장을 규칙 묶음으로 읽는다.
 * @returns {{groups:{agents:string[], rules:{type:string,path:string}[]}[], sitemaps:string[], lines:number}}
 */
export function parseRobots(text) {
  const groups = [];
  const sitemaps = [];
  let current = null;
  let lastWasAgent = false;
  let lines = 0;

  for (const raw of String(text ?? '').split(/\r?\n/)) {
    lines++;
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const at = line.indexOf(':');
    if (at === -1) continue;
    const field = line.slice(0, at).trim().toLowerCase();
    const value = line.slice(at + 1).trim();

    if (field === 'user-agent') {
      // 이어진 User-agent 줄은 같은 묶음을 가리킨다.
      if (!lastWasAgent || !current) { current = { agents: [], rules: [] }; groups.push(current); }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (field === 'sitemap') { sitemaps.push(value); continue; }
    if (field !== 'allow' && field !== 'disallow') continue;
    if (!current) { current = { agents: ['*'], rules: [] }; groups.push(current); }
    // "Disallow:" 처럼 값이 비면 아무것도 막지 않는다는 뜻이다.
    if (field === 'disallow' && value === '') { current.rules.push({ type: 'allow', path: '/' }); continue; }
    if (value === '') continue;
    current.rules.push({ type: field, path: value });
  }

  return { groups, sitemaps, lines };
}

/** 우리를 가리키는 묶음을 고른다. 이름을 콕 집은 쪽이 `*` 보다 세다. */
function groupFor(parsed, agent) {
  const me = agent.toLowerCase();
  let star = null;
  let best = null;
  let bestLen = -1;
  for (const g of parsed.groups) {
    for (const a of g.agents) {
      if (a === '*') { star = star ?? g; continue; }
      if (me.startsWith(a) && a.length > bestLen) { best = g; bestLen = a.length; }
    }
  }
  return best ?? star ?? null;
}

/** robots 의 경로 무늬를 정규식으로. `*` 는 아무거나, `$` 는 끝. */
function patternToRegex(pattern) {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') { out += '.*'; continue; }
    if (c === '$' && i === pattern.length - 1) { out += '$'; continue; }
    out += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}`);
}

/**
 * 이 경로가 막혔는가.
 *
 * 긴 무늬가 이긴다. 길이가 같으면 Allow 가 이긴다 — 규격이 그렇고, 애매할 때 덜 막는 쪽이 맞다.
 *
 * @returns {{allowed:boolean, matched:{type,path}|null, agent_group:string[]|null}}
 */
export function robotsDecision(parsed, { agent = ROBOTS_AGENT, path = '/' } = {}) {
  const group = groupFor(parsed, agent);
  if (!group) return { allowed: true, matched: null, agent_group: null };

  let winner = null;
  for (const rule of group.rules) {
    if (!patternToRegex(rule.path).test(path)) continue;
    if (winner === null
      || rule.path.length > winner.path.length
      || (rule.path.length === winner.path.length && rule.type === 'allow')) {
      winner = rule;
    }
  }
  if (!winner) return { allowed: true, matched: null, agent_group: group.agents };
  return { allowed: winner.type === 'allow', matched: { type: winner.type, path: winner.path }, agent_group: group.agents };
}

// ── 도메인별 기억 ─────────────────────────────────────────────

/**
 * 한 프로세스가 도는 동안만 기억한다. 파일로 남기지 않는다 —
 * robots 는 상대가 언제든 바꿀 수 있고, 오래된 사본으로 막거나 뚫는 것은 둘 다 잘못이다.
 */
export function createRobotsCache({ ttlMs = 30 * 60_000 } = {}) {
  return { ttlMs, entries: new Map() };
}

/**
 * 이 URL 을 두드려도 되는지 본다. 없으면 fetcher 로 robots.txt 를 한 번 가져와 기억한다.
 *
 * @param {(url:string)=>Promise<{ok:boolean, status:number|null, body:Buffer|null, error_code:string|null}>} fetcher
 * @returns {Promise<{allowed:boolean, state:'allowed'|'disallowed'|'unknown', matched, robots_status, sitemaps, from_cache, reason}>}
 */
export async function checkRobots(rawUrl, { fetcher, cache, agent = ROBOTS_AGENT, nowMs = Date.now() }) {
  const u = new URL(rawUrl);
  const origin = `${u.protocol}//${u.host}`;
  const pathAndQuery = `${u.pathname}${u.search}`;

  let entry = cache?.entries.get(origin);
  const fresh = entry && (nowMs - entry.fetched_at) < (cache?.ttlMs ?? 0);
  let fromCache = Boolean(fresh);

  if (!fresh) {
    const got = await fetcher(`${origin}/robots.txt`);
    entry = got.ok && got.body
      ? { parsed: parseRobots(got.body.slice(0, ROBOTS_MAX_BYTES).toString('utf8')), status: got.status, error_code: null, fetched_at: nowMs }
      : { parsed: null, status: got.status ?? null, error_code: got.error_code ?? null, fetched_at: nowMs };
    cache?.entries.set(origin, entry);
    fromCache = false;
  }

  // 404·410 은 "규칙이 없다" 는 뜻이다. 그 밖의 실패는 "모른다" 로 남긴다 — 둘 다 막지 않는다.
  if (!entry.parsed) {
    const noRules = entry.status === 404 || entry.status === 410;
    return {
      allowed: true,
      state: noRules ? 'allowed' : 'unknown',
      matched: null,
      robots_status: entry.status,
      sitemaps: [],
      from_cache: fromCache,
      warning_code: null,
      reason: noRules ? 'no_robots_file' : (entry.error_code ?? `robots_status_${entry.status}`),
    };
  }

  const d = robotsDecision(entry.parsed, { agent, path: pathAndQuery });
  return {
    allowed: d.allowed,
    state: d.allowed ? 'allowed' : 'disallowed',
    matched: d.matched,
    robots_status: entry.status,
    sitemaps: entry.parsed.sitemaps,
    from_cache: fromCache,
    // 막혔다는 관찰만 남긴다. 그래서 이 항목을 어떻게 할지는 에이전트가 정한다.
    warning_code: d.allowed ? null : ROBOTS_DISALLOWED,
    reason: d.matched ? `${d.matched.type}:${d.matched.path}` : 'no_matching_rule',
  };
}
