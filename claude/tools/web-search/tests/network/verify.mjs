#!/usr/bin/env node
// HTTP 전송·DNS·redirect·robots 안전 계층 시험 — 태스크 #25.
//
//   node tests/network/verify.mjs
//   node tests/network/verify.mjs --json
//
// 완료 조건이 "위험 목적지 네트워크 호출 0" 이므로, 막혔다는 말만으로는 부족하다.
// 막힌 홉마다 **연결이 성립하지 않았다는 사실**(pinned_ip·connected_ip 가 없음)을 기록으로 확인하고,
// 맞은 쪽(fixture 서버)의 요청 수로도 대조한다.
//
// 바깥으로는 나가지 않는다. 모든 요청은 이 시험이 띄운 127.0.0.1 fixture 로만 간다.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { FIXTURE_FLAG, parseFixtureAllow } from '../../lib/fixture-allow.mjs';
import { HTTP_DEFAULTS, fetchSafely, robotsFetcher } from '../../lib/http.mjs';
import { ROBOTS_AGENT, ROBOTS_DISALLOWED, checkRobots, createRobotsCache, parseRobots, robotsDecision } from '../../lib/robots.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_SERVER = path.resolve(HERE, '..', 'fixtures', 'server.mjs');
const MANIFEST = JSON.parse(fs.readFileSync(path.resolve(HERE, '..', 'fixtures', 'manifest.json'), 'utf8'));
const AS_JSON = process.argv.includes('--json');

let fetchAttempts = 0;
globalThis.fetch = (...a) => { fetchAttempts++; throw new Error(`이 시험은 fetch 를 쓰지 않는다: ${String(a[0]).slice(0, 60)}`); };

const results = [];
const ok = (id, pass, detail) => results.push({ id, pass: Boolean(pass), detail: String(detail) });
const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const driftOf = (p) => [...MANIFEST.routes, ...MANIFEST.supporting_routes].find((r) => r.path === p)?.drift;

// 어디로 못을 박았는지 전부 모은다. 마지막에 127.0.0.1 밖이 하나도 없어야 한다.
const pinnedEver = new Set();
const collect = (r) => { for (const h of r.hops) if (h.pinned_ip) pinnedEver.add(h.pinned_ip); return r; };

function startFixture() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [FIXTURE_SERVER], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const t = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('fixture 가 안 떴다')); }, 5000);
    child.stdout.on('data', (d) => {
      out += d;
      if (out.includes('\n')) { clearTimeout(t); resolve({ child, base: out.split('\n')[0].trim() }); }
    });
    child.on('exit', (c) => { clearTimeout(t); reject(new Error(`fixture 가 먼저 끝났다 (${c})`)); });
  });
}

const { child: fixture, base: BASE } = await startFixture();
const PORT = Number(new URL(BASE).port);
const ALLOW = parseFixtureAllow([`${FIXTURE_FLAG}=127.0.0.1:${PORT}`]);
const go = (url, opts = {}) => fetchSafely(url, { fixtureAllow: ALLOW, ...opts }).then(collect);

// 서버 쪽 요청 수 — 수집기의 자기 보고가 아니라 맞은 쪽의 기록이다.
const hits = async () => {
  const r = await fetchSafely(`${BASE}/control/hits`, { fixtureAllow: ALLOW });
  return JSON.parse(r.body.toString('utf8'));
};
const resetHits = () => fetchSafely(`${BASE}/control/reset`, { fixtureAllow: ALLOW });

try {
  // ══ A. 되는 길 ══════════════════════════════════════════════
  {
    const r = await go(`${BASE}/static/normal`);
    const d = driftOf('/static/normal');
    ok('N1-basic-get',
      r.ok && r.status === 200 && r.body.length === d.body_bytes && sha(r.body) === d.body_sha256
      && r.final_url === `${BASE}/static/normal` && r.redirected === false && r.truncated === false,
      `${r.status} · ${r.body.length}바이트 · 지문이 fixture 계약과 같다 · ${r.elapsed_ms}ms`);

    ok('N2-minimal-headers',
      r.headers['content-type'] === 'text/html; charset=utf-8' && !('set-cookie' in r.headers)
      && Object.keys(r.headers).every((k) => k === k.toLowerCase()),
      `돌려준 머리 ${Object.keys(r.headers).join('·')}`);

    ok('N3-hop-recorded',
      r.hops.length === 1 && r.hops[0].pinned_ip === '127.0.0.1' && r.hops[0].connected_ip === '127.0.0.1'
      && r.hops[0].remote_verified === true && Number.isFinite(r.hops[0].checked_at),
      `홉 1개 · 못 박은 곳 ${r.hops[0].pinned_ip} · 실제로 붙은 곳 ${r.hops[0].connected_ip} · 확인됨 ${r.hops[0].remote_verified}`);
  }

  // ══ B. 시험 문이 없으면 아예 못 나간다 ══════════════════════
  {
    await resetHits();
    const r = await fetchSafely(`${BASE}/static/normal`);   // fixtureAllow 없이
    const h = await hits();
    ok('N4-no-door-no-request',
      !r.ok && r.error_stage === 'policy' && r.error_code === 'ip_loopback'
      && r.hops[0].pinned_ip === null && r.hops[0].connected_ip === null
      && Object.keys(h).length === 0,
      `${r.error_stage}/${r.error_code} · 못 박은 곳 없음 · 서버가 받은 요청 ${Object.keys(h).length}건`);
  }

  // ══ C. 이름은 이름대로 나간다 ═══════════════════════════════
  {
    let resolverCalls = 0;
    const resolver = async (name) => { resolverCalls++; return name === 'fixture.test' ? ['127.0.0.1'] : []; };
    const r = await go(`http://fixture.test:${PORT}/control/echo`, { resolver });
    const echoed = JSON.parse(r.body.toString('utf8'));

    ok('N5-host-header-kept',
      r.ok && echoed.headers.host === `fixture.test:${PORT}`,
      `서버가 받은 Host = ${echoed.headers.host} (IP 가 아니라 이름 그대로)`);
    ok('N6-connected-to-pinned',
      r.hops[0].pinned_ip === '127.0.0.1' && r.hops[0].connected_ip === '127.0.0.1' && resolverCalls === 1,
      `이름 풀이 ${resolverCalls}회 · 붙은 곳 ${r.hops[0].connected_ip} — 검사와 연결 사이에 다시 풀지 않았다`);
    ok('N7-no-cookie-header',
      !('cookie' in echoed.headers) && !('authorization' in echoed.headers),
      `보낸 머리 ${Object.keys(echoed.headers).sort().join('·')}`);
  }

  // ══ D. DNS 가 바뀌어도 못은 그대로 ══════════════════════════
  {
    let call = 0;
    // 첫 번째 풀이는 안전한 곳, 두 번째부터는 사설망. 검사 뒤에 바뀌는 상황이다.
    const flipping = async () => (++call === 1 ? ['127.0.0.1'] : ['10.0.0.5']);
    const first = await go(`http://rebind.test:${PORT}/static/normal`, { resolver: flipping });
    const callsAfterFirst = call;   // 두 번째 요청이 세기를 늘리기 전에 잡아 둔다
    const second = await go(`http://rebind.test:${PORT}/static/normal`, { resolver: flipping });

    ok('N8-rebinding-pin-holds',
      first.ok && first.hops[0].connected_ip === '127.0.0.1' && callsAfterFirst === 1,
      `첫 요청은 검사한 곳(${first.hops[0].connected_ip})으로 붙었고 그 요청 동안 이름 풀이는 ${callsAfterFirst}회뿐이었다`);
    ok('N9-rebinding-next-request-rechecks',
      !second.ok && second.error_code === 'resolves_to_non_public'
      && second.hops[0].pinned_ip === null && second.hops[0].connected_ip === null,
      `다음 요청은 다시 검사해서 ${second.error_code} 로 막혔다 · 연결 시도 없음`);
  }

  // ══ E. 리다이렉트 — 홉마다 다시 검사 ═══════════════════════
  {
    const chain = await go(`${BASE}/redirect/chain-3`);
    const stamps = chain.hops.map((h) => h.checked_at);
    ok('N10-chain-followed',
      chain.ok && chain.hops.length === 4 && chain.final_url === `${BASE}/redirect/arrived`
      && chain.redirected === true && chain.status === 200,
      `홉 ${chain.hops.length}개 · 도착 ${chain.final_url.replace(BASE, '')}`);
    ok('N11-every-hop-rechecked',
      chain.hops.every((h) => h.addresses.length === 1 && h.remote_verified === true && Number.isFinite(h.checked_at))
      && new Set(stamps).size >= 1 && stamps.every((s, i) => i === 0 || s >= stamps[i - 1]),
      `홉마다 검사·고정·확인이 다시 일어났다 (${chain.hops.map((h) => `${h.url.replace(BASE, '')}→${h.status}`).join(' ')})`);

    const priv = await go(`${BASE}/redirect/private`);
    ok('N12-private-redirect-blocked',
      !priv.ok && priv.error_stage === 'policy' && priv.error_code === 'ip_private'
      && priv.hops.length === 2 && priv.hops[1].pinned_ip === null && priv.hops[1].connected_ip === null,
      `${priv.error_code} · 둘째 홉(${priv.hops[1].hostname})에 연결한 적 없음`);

    const otherPort = await go(`${BASE}/redirect/other-port`);
    ok('N13-loopback-other-port-blocked',
      !otherPort.ok && otherPort.error_code === 'ip_loopback' && otherPort.hops[1].connected_ip === null,
      `${otherPort.error_code} — 같은 루프백이라도 허용 목록에 없는 포트다`);

    const scheme = await go(`${BASE}/redirect/scheme`);
    ok('N14-scheme-redirect-blocked',
      !scheme.ok && scheme.error_stage === 'url' && String(scheme.error_code).startsWith('url_'),
      `${scheme.error_stage}/${scheme.error_code}`);

    const loop = await go(`${BASE}/redirect/loop`);
    ok('N15-loop-caught',
      !loop.ok && loop.error_stage === 'redirect' && loop.error_code === 'redirect_loop',
      `${loop.error_code} · 홉 ${loop.hops.length}개에서 멈춤`);

    const capped = await go(`${BASE}/redirect/chain-3`, { maxRedirects: 1 });
    ok('N16-redirect-cap',
      !capped.ok && capped.error_code === 'too_many_redirects' && capped.hops.length === 2,
      `${capped.error_code} · 홉 ${capped.hops.length}개에서 멈춤`);

    const noLoc = await go(`${BASE}/redirect/no-location`);
    ok('N17-no-location',
      !noLoc.ok && noLoc.error_code === 'redirect_no_location' && noLoc.status === 302,
      `${noLoc.error_code} · 상태 ${noLoc.status}`);
  }

  // ══ F. set-cookie 는 받아 두지 않는다 ═══════════════════════
  {
    const stopped = await go(`${BASE}/control/set-cookie`, { maxRedirects: 0 });
    const followed = await go(`${BASE}/control/set-cookie`);
    const echoed = JSON.parse(followed.body.toString('utf8'));
    ok('N18-set-cookie-dropped',
      !('set-cookie' in stopped.headers) && stopped.status === 302
      && !('cookie' in echoed.headers),
      `돌려준 머리에 set-cookie 없음 · 따라간 요청에도 cookie 없음`);
  }

  // ══ G. 시간 상한 ════════════════════════════════════════════
  {
    const t = { connect_timeout_ms: 2000, headers_timeout_ms: 600, body_timeout_ms: 600, overall_timeout_ms: 5000 };
    const noHeaders = await go(`${BASE}/hang/headers`, { timeouts: t });
    ok('N19-headers-timeout',
      !noHeaders.ok && noHeaders.error_stage === 'response' && noHeaders.error_code === 'headers_timeout',
      `${noHeaders.error_stage}/${noHeaders.error_code} · ${noHeaders.elapsed_ms}ms`);

    const noBody = await go(`${BASE}/hang/body`, { timeouts: t });
    ok('N20-body-timeout',
      !noBody.ok && noBody.error_stage === 'body' && noBody.error_code === 'body_timeout',
      `${noBody.error_stage}/${noBody.error_code} · ${noBody.elapsed_ms}ms`);

    const tooSlow = await go(`${BASE}/slow/2s`, { timeouts: t });
    const inTime = await go(`${BASE}/slow/2s`, { timeouts: { ...t, headers_timeout_ms: 4000 } });
    ok('N21-limit-is-real-not-always-on',
      !tooSlow.ok && tooSlow.error_code === 'headers_timeout' && inTime.ok && inTime.status === 200,
      `600ms 상한에서는 걸리고 4000ms 상한에서는 통과한다 (${inTime.elapsed_ms}ms)`);

    const overall = await go(`${BASE}/slow/2s`, { timeouts: { ...t, headers_timeout_ms: 9000, overall_timeout_ms: 500 } });
    ok('N22-overall-timeout',
      !overall.ok && overall.error_code === 'overall_timeout',
      `${overall.error_code} · ${overall.elapsed_ms}ms — 요청 하나가 길어도 전체 상한이 끊는다`);

    const refused = await fetchSafely('http://127.0.0.1:9/x', {
      fixtureAllow: parseFixtureAllow([`${FIXTURE_FLAG}=127.0.0.1:9`]), timeouts: t,
    }).then(collect);
    ok('N23-connect-failure-staged',
      !refused.ok && refused.error_stage === 'connect' && refused.error_code !== null,
      `${refused.error_stage}/${refused.error_code}`);
  }

  // ══ H. 크기 상한 ════════════════════════════════════════════
  {
    const capped = await go(`${BASE}/long/huge`, { maxBytes: 1024 * 1024, timeouts: { body_timeout_ms: 5000 } });
    const whole = await go(`${BASE}/long/page`, { timeouts: { body_timeout_ms: 5000 } });
    const d = driftOf('/long/page');
    ok('N24-size-cap',
      capped.ok && capped.truncated === true && capped.body.length === 1024 * 1024,
      `12MB 쪽을 ${capped.body.length}바이트에서 자르고 잘렸다고 표시한다`);
    ok('N25-under-cap-not-truncated',
      whole.ok && whole.truncated === false && whole.body.length === d.body_bytes && sha(whole.body) === d.body_sha256,
      `${whole.body.length}바이트 · 상한 아래라 그대로 · 지문이 fixture 계약과 같다`);
  }

  // ══ I. robots ═══════════════════════════════════════════════
  {
    const txt = [
      'User-agent: *', 'Disallow: /admin', '',
      `User-agent: ${ROBOTS_AGENT}`, 'Disallow: /private/', 'Allow: /private/ok', 'Disallow:',
      'Sitemap: https://example.com/sitemap.xml',
    ].join('\n');
    const parsed = parseRobots(txt);
    const mine = robotsDecision(parsed, { agent: ROBOTS_AGENT, path: '/private/page' });
    const allowed = robotsDecision(parsed, { agent: ROBOTS_AGENT, path: '/private/ok' });
    const other = robotsDecision(parsed, { agent: ROBOTS_AGENT, path: '/admin' });

    ok('N26-robots-parse',
      parsed.groups.length === 2 && parsed.sitemaps.length === 1
      && mine.allowed === false && mine.matched.path === '/private/'
      && allowed.allowed === true && allowed.matched.path === '/private/ok',
      `내 이름을 콕 집은 묶음이 이긴다 · 긴 무늬가 이긴다 (${allowed.matched.path})`);
    ok('N27-other-agent-rule-not-mine',
      other.allowed === true,
      `* 묶음의 /admin 은 내 묶음이 따로 있으므로 적용되지 않는다`);

    const wild = parseRobots('User-agent: *\nDisallow: /x$\nDisallow: /a*b');
    ok('N28-robots-wildcards',
      robotsDecision(wild, { path: '/x' }).allowed === false
      && robotsDecision(wild, { path: '/xy' }).allowed === true
      && robotsDecision(wild, { path: '/aQQb/z' }).allowed === false,
      '$ 는 끝, * 는 아무거나');

    const cache = createRobotsCache({ ttlMs: 60_000 });
    const fetcher = robotsFetcher({ fixtureAllow: ALLOW });
    const blocked = await checkRobots(`${BASE}/private/page`, { fetcher, cache });
    const fine = await checkRobots(`${BASE}/static/normal`, { fetcher, cache });
    ok('N29-robots-live',
      blocked.allowed === false && blocked.state === 'disallowed' && blocked.matched.path === '/private/'
      && blocked.warning_code === ROBOTS_DISALLOWED && fine.warning_code === null
      && fine.allowed === true && fine.from_cache === true,
      `fixture robots 가 /private/ 을 막고 ${blocked.warning_code} 로 남는다 · 두 번째 조회는 기억한 것을 쓴다(${fine.from_cache})`);

    // 못 읽으면 막지 않는다 — 상태 그대로 남긴다
    const missing = await checkRobots('http://nowhere.test/a', {
      fetcher: async () => ({ ok: false, status: 404, body: null, error_code: null }),
      cache: createRobotsCache(),
    });
    const broken = await checkRobots('http://nowhere.test/a', {
      fetcher: async () => ({ ok: false, status: null, body: null, error_code: 'connect_timeout' }),
      cache: createRobotsCache(),
    });
    ok('N30-robots-unreadable-does-not-block',
      missing.allowed === true && missing.state === 'allowed' && missing.reason === 'no_robots_file'
      && broken.allowed === true && broken.state === 'unknown' && broken.reason === 'connect_timeout',
      `404 는 "규칙 없음"(${missing.state}) · 못 읽은 것은 "모름"(${broken.state}) — 둘 다 막지 않는다`);
  }

  // ══ J. 완료 조건 ════════════════════════════════════════════
  {
    const dangerous = [
      await go(`${BASE}/redirect/private`),
      await go(`${BASE}/redirect/other-port`),
      await go(`${BASE}/redirect/scheme`),
      await fetchSafely('http://10.0.0.5/x', { fixtureAllow: ALLOW }).then(collect),
      await fetchSafely('http://169.254.169.254/latest/meta-data/', { fixtureAllow: ALLOW }).then(collect),
      await fetchSafely('http://[::1]:80/x', { fixtureAllow: ALLOW }).then(collect),
      await fetchSafely('http://user:pw@example.com/x', { fixtureAllow: ALLOW }).then(collect),
    ];
    const everConnected = dangerous.flatMap((r) => r.hops).filter((h) => h.connected_ip !== null && h.status === null);
    const unsafeHops = dangerous.flatMap((r) => r.hops).filter((h) => h.pinned_ip !== null && h.pinned_ip !== '127.0.0.1');
    ok('N31-zero-dangerous-calls',
      dangerous.every((r) => !r.ok) && everConnected.length === 0 && unsafeHops.length === 0,
      `위험한 목적지 ${dangerous.length}종 모두 거절 · 그중 연결이 성립한 홉 0개 · 127.0.0.1 밖에 못 박은 홉 0개`);

    const noStage = dangerous.filter((r) => !r.error_stage || !r.error_code);
    ok('N32-every-failure-has-stage-and-code',
      noStage.length === 0,
      `실패 ${dangerous.length}건 모두 단계·코드가 있다: ${dangerous.map((r) => `${r.error_stage}/${r.error_code}`).join(' · ')}`);

    ok('N33-only-loopback-ever-pinned',
      [...pinnedEver].every((ip) => ip === '127.0.0.1'),
      `이 시험이 못 박은 곳 전부: ${[...pinnedEver].join(', ')}`);
    ok('N34-no-global-fetch', fetchAttempts === 0, `fetch 시도 ${fetchAttempts}회 (node:http 로만 나갔다)`);

    ok('N35-defaults-are-bounded',
      HTTP_DEFAULTS.max_redirects <= 10 && HTTP_DEFAULTS.max_bytes <= 64 * 1024 * 1024
      && HTTP_DEFAULTS.overall_timeout_ms <= 60_000,
      `리다이렉트 ${HTTP_DEFAULTS.max_redirects}홉 · 크기 ${HTTP_DEFAULTS.max_bytes / 1048576}MB · 전체 ${HTTP_DEFAULTS.overall_timeout_ms / 1000}초`);
  }
} finally {
  await fetchSafely(`${BASE}/control/release-hangs`, { fixtureAllow: ALLOW }).catch(() => {});
  fixture.kill('SIGTERM');
}

const failed = results.filter((r) => !r.pass);
if (AS_JSON) {
  process.stdout.write(`${JSON.stringify({ pass: failed.length === 0, total: results.length, failed: failed.length, results }, null, 2)}\n`);
} else {
  for (const r of results) process.stdout.write(`${r.pass ? 'PASS' : 'FAIL'}  ${r.id}\n        ${r.detail}\n`);
  process.stdout.write(`\n${failed.length === 0 ? 'PASS' : 'FAIL'} — ${results.length - failed.length}/${results.length}\n`);
}
process.exit(failed.length === 0 ? 0 : 1);
