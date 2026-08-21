#!/usr/bin/env node
// robots·sitemap 파서 시험 — 태스크 #33.
//
//   node tests/map-parser/verify.mjs
//   node tests/map-parser/verify.mjs --json
//
// 완료 조건이 "선언 URL 수와 source_kind 가 fixture 기대값과 정확히 일치" 이므로,
// 손으로 적은 개수 계약(manifest 의 sitemaps 블록)과 실제로 센 수를 나란히 견준다.
//
// 모든 요청은 이 시험이 띄운 127.0.0.1 fixture 로만 간다.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

import { FIXTURE_FLAG, parseFixtureAllow } from '../../lib/fixture-allow.mjs';
import { fetchSafely } from '../../lib/http.mjs';
import { CONVENTIONAL_PATHS, declaredSitemaps, sitemapSeeds } from '../../lib/map/robots.mjs';
import { SITEMAP_LIMITS, crawlSitemaps, looksGzipped, parseSitemap } from '../../lib/map/sitemap.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOL_ROOT = path.resolve(HERE, '..', '..');
const FIXTURE_SERVER = path.join(TOOL_ROOT, 'tests', 'fixtures', 'server.mjs');
const CONTRACT = JSON.parse(fs.readFileSync(path.join(TOOL_ROOT, 'tests', 'fixtures', 'manifest.json'), 'utf8')).sitemaps;
const AS_JSON = process.argv.includes('--json');

const results = [];
const ok = (id, pass, detail) => results.push({ id, pass: Boolean(pass), detail: String(detail) });

function startFixture() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [FIXTURE_SERVER], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const t = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('fixture 가 안 떴다')); }, 5000);
    child.stdout.on('data', (d) => { out += d; if (out.includes('\n')) { clearTimeout(t); resolve({ child, base: out.split('\n')[0].trim() }); } });
    child.on('exit', (c) => { clearTimeout(t); reject(new Error(`fixture 가 먼저 끝났다 (${c})`)); });
  });
}

const { child: fixture, base: BASE } = await startFixture();
const PORT = Number(new URL(BASE).port);
const ALLOW = parseFixtureAllow([`${FIXTURE_FLAG}=127.0.0.1:${PORT}`]);

// sitemap 을 가져오는 문. 다른 요청과 똑같은 안전 검사·상한을 받는다.
const calls = [];
const fetchOne = async (url) => {
  calls.push(url);
  const r = await fetchSafely(url, { fixtureAllow: ALLOW, maxBytes: 8 * 1024 * 1024 });
  return { ok: r.ok, status: r.status, final_url: r.final_url, body: r.body, error_code: r.error_code };
};

try {
  // ══ A. robots 의 선언과 관례 짐작 ═══════════════════════════
  {
    const robots = (await fetchSafely(`${BASE}/robots.txt`, { fixtureAllow: ALLOW })).body.toString('utf8');
    const declared = declaredSitemaps(robots, BASE);

    ok('A1-declared-deduped',
      declared.length === CONTRACT.robots_declares_distinct
      && declared[0].url === `${BASE}/sitemaps/from-robots.xml` && declared[0].origin === 'robots'
      && declared[1].url === `${BASE}/sitemaps/broken.xml`,
      `robots 가 ${CONTRACT.robots_declares.length}줄 적었지만 서로 다른 것은 ${declared.length}개`
      + ` (${declared.map((d) => d.raw).join(' · ')})`);

    const withDecl = sitemapSeeds({ robotsText: robots, origin: BASE });
    ok('A2-declaration-beats-guess',
      withDecl.declared === 2 && withDecl.guessed === 0
      && withDecl.seeds.every((s) => s.origin === 'robots'),
      `선언이 있으면 관례 자리(${CONVENTIONAL_PATHS.join('·')})는 찍어 보지 않는다 — 이유 없이 한 번 더 두드리지 않는다`);

    const noDecl = sitemapSeeds({ robotsText: 'User-agent: *\nDisallow:\n', origin: BASE });
    ok('A3-guess-only-when-silent',
      noDecl.declared === 0 && noDecl.guessed === CONVENTIONAL_PATHS.length
      && noDecl.seeds.every((s) => s.origin === 'convention'),
      `선언이 없을 때만 ${noDecl.guessed}곳을 넘겨짚는다`);

    const noRobots = sitemapSeeds({ robotsText: null, robotsState: 'unknown', origin: BASE });
    ok('A4-no-robots-file',
      noRobots.guessed === CONVENTIONAL_PATHS.length && noRobots.robots_state === 'unknown',
      `robots 를 못 읽어도(${noRobots.robots_state}) 멈추지 않고 관례 자리를 본다`);
  }

  // ══ B. 한 장 읽기 ═══════════════════════════════════════════
  {
    const a = await fetchSafely(`${BASE}/sitemaps/urls-a.xml`, { fixtureAllow: ALLOW });
    const parsed = parseSitemap(a.body, { baseUrl: `${BASE}/sitemaps/urls-a.xml` });
    const want = CONTRACT.files['/sitemaps/urls-a.xml'];
    ok('B1-urlset',
      parsed.kind === 'urlset' && parsed.entries.length === want.entries && parsed.error === null,
      `${parsed.kind} · 항목 ${parsed.entries.length}개 (계약 ${want.entries})`);

    const rel = parsed.entries.find((e) => e.raw === '/rel/one');
    const ent = parsed.entries.find((e) => e.raw.includes('goodsNo=300'));
    ok('B2-relative-and-entity',
      rel.loc === `${BASE}/rel/one` && ent.raw === `${BASE}/goods?goodsNo=300&color=red`,
      `상대 주소 → ${rel.loc.replace(BASE, '')} · &amp; 를 풀어 ${ent.raw.replace(BASE, '')}`);

    ok('B3-lastmod',
      parsed.entries.filter((e) => e.lastmod).length === 36 && rel.lastmod === null,
      `lastmod 가 있는 항목 ${parsed.entries.filter((e) => e.lastmod).length}개 · 없는 것은 null`);

    const gz = await fetchSafely(`${BASE}/sitemaps/urls-b.xml.gz`, { fixtureAllow: ALLOW });
    const gzParsed = parseSitemap(gz.body, { baseUrl: `${BASE}/sitemaps/urls-b.xml.gz` });
    ok('B4-gzip',
      looksGzipped(gz.body) && gzParsed.gzipped === true && gzParsed.kind === 'urlset'
      && gzParsed.entries.length === 10,
      `이름이 아니라 바이트 앞머리로 gzip 을 알아본다 · 풀어서 ${gzParsed.entries.length}개`);

    const broken = await fetchSafely(`${BASE}/sitemaps/broken.xml`, { fixtureAllow: ALLOW });
    const brokenParsed = parseSitemap(broken.body, { baseUrl: `${BASE}/sitemaps/broken.xml` });
    ok('B5-status-200-is-not-enough',
      broken.status === 200 && brokenParsed.kind === 'unknown'
      && brokenParsed.error.startsWith('not_a_sitemap') && brokenParsed.entries.length === 0,
      `상태 ${broken.status} 인데 사이트맵이 아니다 → ${brokenParsed.error.slice(0, 40)}`);

    const idx = parseSitemap('<?xml version="1.0"?><sitemapindex><sitemap><loc>/a.xml</loc></sitemap></sitemapindex>',
      { baseUrl: `${BASE}/x/y.xml` });
    ok('B6-index-kind', idx.kind === 'sitemapindex' && idx.entries[0].loc === `${BASE}/a.xml`, `${idx.kind} · ${idx.entries[0].loc.replace(BASE, '')}`);

    const badGz = parseSitemap(Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x01, 0x02]), { baseUrl: BASE });
    ok('B7-broken-gzip-says-so',
      badGz.kind === 'unknown' && badGz.error.startsWith('gunzip_failed'),
      `${badGz.error.slice(0, 40)} — 못 푼 것을 빈 사이트맵으로 꾸미지 않는다`);
  }

  // ══ C. 관례 자리에서 펼치기 ═════════════════════════════════
  let fromConvention = null;
  {
    calls.length = 0;
    fromConvention = await crawlSitemaps(
      [{ url: `${BASE}/sitemap.xml`, origin: 'convention' }], { fetchOne });
    const want = CONTRACT.expected.from_convention;

    ok('C1-url-count-matches-contract',
      fromConvention.urls.size === want.distinct_urls,
      `모은 URL ${fromConvention.urls.size}개 (계약 ${want.distinct_urls}) = urls-a 39 + urls-b 10 + deep-2 5`);

    ok('C2-source-kind',
      [...fromConvention.urls.values()].every((u) => u.source_kind === want.source_kind),
      `모두 source_kind=${want.source_kind} — 관례로 찾은 sitemap 에서 나왔다`);

    ok('C3-duplicate-collapsed',
      fromConvention.urls.has(`${BASE}/dup`) && !fromConvention.urls.has(`${BASE}/dup?utm_source=x`)
      && fromConvention.counts.duplicates >= 1,
      `추적 파라미터만 다른 짝이 한 줄로 합쳐졌다 · 겹쳐 나온 횟수 ${fromConvention.counts.duplicates}`);

    // sitemap.xml(0) → nested(1) → deep-1(2) → deep-2(3). 색인이 셋이라 urlset 은 깊이 3 이다.
    ok('C4-nested-depth',
      fromConvention.urls.get(`${BASE}/n/1`)?.depth === 3 && fromConvention.counts.max_depth_seen === 3,
      `색인 셋을 지나 깊이 ${fromConvention.counts.max_depth_seen} 의 urlset 까지 따라갔다`
      + ` · 얕은 곳(urls-a)의 URL 은 깊이 ${fromConvention.urls.get(`${BASE}/p/5`)?.depth}`);

    ok('C5-broken-is-an-error-not-zero',
      fromConvention.errors.some((e) => e.url.endsWith('/broken.xml') && e.code === 'unreadable')
      && fromConvention.partial === true,
      `못 읽은 파일이 오류로 남고 partial=${fromConvention.partial} — 0건 완료로 바꾸지 않는다`);

    ok('C6-redirect-to-seen-is-not-a-reread',
      fromConvention.files.some((f) => f.url.endsWith('/moved.xml') && f.skipped === 'already_seen_after_redirect'),
      `moved.xml 은 urls-a 로 되돌아가므로 다시 읽지 않는다 — 요청 주소가 아니라 최종 주소로 센다`);

    ok('C7-counts-add-up',
      fromConvention.counts.urlsets === 3 && fromConvention.counts.indexes === 3
      && fromConvention.counts.unreadable === 1,
      `urlset ${fromConvention.counts.urlsets} · 색인 ${fromConvention.counts.indexes} · 못 읽음 ${fromConvention.counts.unreadable}`);

    ok('C8-one-request-per-file',
      new Set(calls).size === calls.length,
      `요청 ${calls.length}번 · 서로 다른 주소 ${new Set(calls).size}개 — 같은 파일을 두 번 받지 않는다`);
  }

  // ══ D. robots 가 알려 준 쪽 ═════════════════════════════════
  {
    const robots = (await fetchSafely(`${BASE}/robots.txt`, { fixtureAllow: ALLOW })).body.toString('utf8');
    const seeds = sitemapSeeds({ robotsText: robots, origin: BASE }).seeds;
    const r = await crawlSitemaps(seeds, { fetchOne });
    const want = CONTRACT.expected.from_robots;
    ok('D1-robots-source-kind',
      r.urls.size === want.distinct_urls
      && [...r.urls.values()].every((u) => u.source_kind === 'robots')
      && r.partial === true && r.counts.unreadable === want.unreadable_files
      && r.errors.some((e) => e.url.endsWith('/broken.xml') && e.code === 'unreadable'),
      `robots 가 알려 준 sitemap 에서 ${r.urls.size}개 (계약 ${want.distinct_urls}) · 모두 source_kind=robots · partial=${r.partial}`
      + ` · 정규화: 상대 ${r.urls.has(`${BASE}/r/relative`)} · 자리표 뗌 ${r.urls.has(`${BASE}/r/frag`)}`
      + ` · 추적 파라미터 합침 ${r.urls.has(`${BASE}/r/dup`) && !r.urls.has(`${BASE}/r/dup?utm_source=x`)}`);

    ok('D2-two-kinds-differ',
      [...fromConvention.urls.values()][0].source_kind === 'sitemap'
      && [...r.urls.values()][0].source_kind === 'robots',
      '도메인이 한 말과 우리 추측이 장부에서 다른 이름으로 남는다');
  }

  // ══ E. 고리와 상한 ══════════════════════════════════════════
  {
    const loop = await crawlSitemaps([{ url: `${BASE}/sitemaps/loop.xml`, origin: 'convention' }], { fetchOne });
    ok('E1-cycle-terminates',
      loop.files.some((f) => f.skipped === 'already_seen') && loop.counts.files_opened <= 12,
      `자기 자신을 가리켜도 끝난다 · 연 파일 ${loop.counts.files_opened} · 건너뛴 것 ${loop.counts.files_skipped}`);

    const capped = await crawlSitemaps([{ url: `${BASE}/sitemaps/wide.xml`, origin: 'convention' }],
      { fetchOne, limits: { max_files: 5 } });
    ok('E2-file-limit-is-partial-not-done',
      capped.limits_hit.includes('max_files') && capped.partial === true
      && capped.counts.files_opened === 5 && capped.urls.size === 4,
      `파일 상한 5 에 닿아 ${capped.counts.files_opened}장만 열고 URL ${capped.urls.size}개 · 상한 도달 ${capped.limits_hit.join('·')}`);

    const shallow = await crawlSitemaps([{ url: `${BASE}/sitemap.xml`, origin: 'convention' }],
      { fetchOne, limits: { max_depth: 1 } });
    ok('E3-depth-limit',
      shallow.limits_hit.includes('max_depth') && shallow.errors.some((e) => e.code === 'max_depth')
      && shallow.urls.size === 49,
      `깊이 상한 1 이라 nested 아래를 안 열었다 → URL ${shallow.urls.size}개(54 에서 deep-2 의 5 가 빠짐) · 그 사실을 오류로 남긴다`);

    const fewUrls = await crawlSitemaps([{ url: `${BASE}/sitemap.xml`, origin: 'convention' }],
      { fetchOne, limits: { max_urls: 12 } });
    ok('E4-url-limit',
      fewUrls.limits_hit.includes('max_urls') && fewUrls.partial === true && fewUrls.urls.size <= 40,
      `URL 상한에 닿아 ${fewUrls.urls.size}개에서 멈추고 partial 로 남긴다`);

    ok('E5-defaults-are-bounded',
      SITEMAP_LIMITS.max_files <= 200 && SITEMAP_LIMITS.max_urls <= 50_000
      && SITEMAP_LIMITS.max_depth <= 6 && SITEMAP_LIMITS.max_bytes <= 100 * 1024 * 1024,
      `기본 상한 — 파일 ${SITEMAP_LIMITS.max_files} · URL ${SITEMAP_LIMITS.max_urls} · 깊이 ${SITEMAP_LIMITS.max_depth}`);
  }

  // ══ F. 안전 ═════════════════════════════════════════════════
  {
    // sitemap 도 다른 요청과 같은 문을 쓴다. 허용 목록이 없으면 못 나간다.
    const noDoor = await crawlSitemaps([{ url: `${BASE}/sitemap.xml`, origin: 'convention' }], {
      fetchOne: async (u) => {
        const r = await fetchSafely(u, {});
        return { ok: r.ok, status: r.status, final_url: r.final_url, body: r.body, error_code: r.error_code };
      },
    });
    ok('F1-same-safety-door',
      noDoor.urls.size === 0 && noDoor.errors[0].code === 'ip_loopback',
      `허용 목록 없이는 ${noDoor.errors[0].code} 로 막힌다 — sitemap 이라고 예외가 아니다`);

    const external = parseSitemap(
      `<?xml version="1.0"?><urlset><url><loc>http://10.0.0.5/x</loc></url><url><loc>ftp://a/b</loc></url></urlset>`,
      { baseUrl: BASE });
    ok('F2-parser-does-not-judge-targets',
      external.entries.length === 2 && external.entries[0].loc === 'http://10.0.0.5/x',
      '파서는 적힌 대로 읽는다 — 나가도 되는지는 목적지 검사가 따로 판정한다');

    const gzBomb = zlib.gzipSync(Buffer.alloc(2 * 1024 * 1024, 0x41));
    const bomb = parseSitemap(gzBomb, { baseUrl: BASE });
    ok('F3-gzip-garbage-is-unknown',
      bomb.kind === 'unknown' && bomb.error.startsWith('not_a_sitemap'),
      '풀었더니 사이트맵이 아니면 그렇다고 말한다');
  }
} finally {
  await new Promise((r) => { fixture.on('exit', r); fixture.kill('SIGTERM'); setTimeout(r, 1500); });
}

const failed = results.filter((r) => !r.pass);
if (AS_JSON) {
  process.stdout.write(`${JSON.stringify({ pass: failed.length === 0, total: results.length, failed: failed.length, results }, null, 2)}\n`);
} else {
  for (const r of results) process.stdout.write(`${r.pass ? 'PASS' : 'FAIL'}  ${r.id}\n        ${r.detail}\n`);
  process.stdout.write(`\n${failed.length === 0 ? 'PASS' : 'FAIL'} — ${results.length - failed.length}/${results.length}\n`);
}
process.exit(failed.length === 0 ? 0 : 1);
