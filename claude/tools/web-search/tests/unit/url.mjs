#!/usr/bin/env node
// lib/url.mjs · lib/network-policy.mjs 단위 시험.
//
//   node tests/unit/url.mjs
//
// DNS 는 갈아 끼운 해석기로만 다룬다. 시험이 실제 이름을 물으면 그날그날 답이 달라진다.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeUrl, sameHostIgnoringWww, UrlError, DEFAULT_KEEP_PARAMS, SORTING_PARAMS } from '../../lib/url.mjs';
import { classifyIp, isPublicIp, checkTarget, checkRedirect } from '../../lib/network-policy.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const S = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'fixtures', 'url-samples.json'), 'utf8'));

const results = [];
const ok = (id, pass, detail) => results.push({ id, pass, detail });

// 실제 DNS 를 부르면 시험이 그날의 응답에 흔들린다. 표를 보고 답하는 해석기를 쓴다.
const tableResolver = (table) => async (hostname) => {
  if (!(hostname in table)) { const e = new Error('not found'); e.code = 'ENOTFOUND'; throw e; }
  return table[hostname];
};

// ── 합쳐져야 하는 것 ──────────────────────────────────────────

{
  let urls = 0;
  const bad = [];
  for (const g of S.merge_groups) {
    for (const u of g.urls) {
      urls++;
      const got = normalizeUrl(u).canonical_url;
      if (got !== g.expect) bad.push(`${u} → ${got} (기대 ${g.expect})`);
    }
  }
  ok('U1-merge', bad.length === 0, bad.length ? `${bad.length}건 어긋남: ${bad.slice(0, 3).join(' / ')}` : `표본 ${urls}개가 ${S.merge_groups.length}개 열쇠로 합쳐짐`);
}

// ── 갈라져야 하는 것 ──────────────────────────────────────────

{
  const bad = S.distinct_pairs.filter((p) => normalizeUrl(p.a).canonical_url === normalizeUrl(p.b).canonical_url)
    .map((p) => `${p.a} == ${p.b} (${p.why})`);
  ok('U2-distinct', bad.length === 0, bad.length ? bad.join(' / ') : `${S.distinct_pairs.length}쌍 모두 갈림 — 병합 오탐 0`);
}

// ── 정규화 ────────────────────────────────────────────────────

{
  const bad = S.normalize.filter((c) => normalizeUrl(c.in).canonical_url !== c.out)
    .map((c) => `${c.in} → ${normalizeUrl(c.in).canonical_url} (기대 ${c.out})`);
  ok('U3-normalize', bad.length === 0, bad.length ? bad.join(' / ') : `${S.normalize.length}건 모두 기대대로`);
}

// ── 거절 ──────────────────────────────────────────────────────

{
  const bad = [];
  for (const c of S.reject) {
    try { normalizeUrl(c.in); bad.push(`${JSON.stringify(c.in)}: 던지지 않았다`); } catch (e) {
      if (!(e instanceof UrlError)) bad.push(`${JSON.stringify(c.in)}: UrlError 가 아니다`);
      else if (e.code !== c.code) bad.push(`${JSON.stringify(c.in)}: code=${e.code} (기대 ${c.code})`);
    }
  }
  ok('U4-reject', bad.length === 0, bad.length ? bad.join(' / ') : `${S.reject.length}종 모두 거절 (자격정보 포함)`);
}

// ── 보존·제거 정책 ────────────────────────────────────────────

{
  // 도메인별 보존은 기본 보존을 대체하지 않고 더한다
  const withDomainKeep = normalizeUrl('https://shop.example.com/g?goodsNo=1&mycustom=7&utm_source=x', {
    keepParamsByDomain: { 'shop.example.com': ['mycustom'] },
  }).canonical_url;
  ok('U5-keep-is-union', withDomainKeep === 'https://shop.example.com/g?goodsNo=1&mycustom=7',
    withDomainKeep);

  // 도메인별 제거를 지정하면 정렬 파라미터도 지울 수 있다
  const dropSort = normalizeUrl('https://shop.example.com/list?sort=new&page=2', {
    dropParamsByDomain: { 'shop.example.com': ['sort'] },
  }).canonical_url;
  ok('U6-domain-drop', dropSort === 'https://shop.example.com/list?page=2', dropSort);

  // 보존이 제거보다 먼저다 — 같은 이름이 양쪽에 있으면 남는다
  const conflict = normalizeUrl('https://example.com/p?page=2', { dropParams: ['page'] }).canonical_url;
  ok('U7-keep-beats-drop', conflict === 'https://example.com/p?page=2', conflict);

  ok('U8-sorting-not-dropped', SORTING_PARAMS.every((p) => !DEFAULT_KEEP_PARAMS.includes(p))
    && normalizeUrl('https://example.com/l?sort=new').canonical_url === 'https://example.com/l?sort=new',
    '정렬 파라미터는 기본 목록 어느 쪽에도 없고 그대로 남는다');
}

{
  ok('U9-same-host-ignoring-www',
    sameHostIgnoringWww('www.example.com', 'example.com') === true
    && sameHostIgnoringWww('shop.example.com', 'www.example.com') === false,
    'www 만 무시한다 — 등록 도메인 판정이 아니다');
}

{
  const r = normalizeUrl('https://example.com/p?utm_source=a&fbclid=b&id=7');
  ok('U10-original-and-dropped', r.original_url === 'https://example.com/p?utm_source=a&fbclid=b&id=7'
    && r.dropped.sort().join(',') === 'fbclid,utm_source' && r.domain === 'example.com',
    `원본 보존 · 지운 것 [${r.dropped.join(', ')}] · domain ${r.domain}`);
}

// ── IP 갈래 ───────────────────────────────────────────────────

{
  const badPub = S.network.public_ips.filter((a) => !isPublicIp(a));
  ok('U11-public-ips', badPub.length === 0, badPub.length ? badPub.join(', ') : `공인 ${S.network.public_ips.length}개 통과`);

  const badBlk = S.network.blocked_ips.filter((c) => classifyIp(c.address) !== c.kind)
    .map((c) => `${c.address} → ${classifyIp(c.address)} (기대 ${c.kind})`);
  ok('U12-blocked-ips', badBlk.length === 0, badBlk.length ? badBlk.join(' / ') : `위험 주소 ${S.network.blocked_ips.length}개 갈래까지 정확`);
}

// ── 목적지 검사 ───────────────────────────────────────────────

{
  const resolver = tableResolver({ 'good.example.com': ['93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946'] });
  const r = await checkTarget('https://good.example.com/path/?utm_source=x', { resolver });
  ok('U13-allow-public', r.allow === true && r.addresses.length === 2 && r.canonical_url === 'https://good.example.com/path'
    && typeof r.checked_at === 'number' && r.reason === null,
    `허용 · 근거 주소 ${r.addresses.length}개 · canonical ${r.canonical_url}`);
  ok('U14-addresses-are-the-basis', r.addresses.every(isPublicIp),
    '판정 근거가 된 주소만 돌려준다 — 연결 계층이 이 중에서만 고른다');
}

{
  // [왜 막혔는지까지 본다] "막혔다" 만 보면 이름 풀이가 실패해서 막힌 것도 통과시킨다.
  // 실제로 http://[::1]/x 가 그랬다 — URL.hostname 이 대괄호를 붙여 돌려주는 바람에 IP 분류를
  // 건너뛰고 DNS 로 흘러가 ENOTFOUND 로 막혔다(2026-08-12 #25 시험에서 발견).
  // 주소를 그대로 적은 곳은 반드시 ip_* 사유로 막혀야 한다.
  const bad = [];
  const reasons = [];
  for (const u of S.network.blocked_hosts) {
    const r = await checkTarget(u, { resolver: tableResolver({}) });
    reasons.push(`${new URL(u).host}→${r.reason}`);
    if (r.allow) { bad.push(`${u} 통과`); continue; }
    const literal = /^(\d|\[)/.test(new URL(u).hostname);
    if (literal && !String(r.reason).startsWith('ip_')) bad.push(`${u} 사유가 ${r.reason}`);
    if (!literal && !String(r.reason).startsWith('hostname_') && !String(r.reason).startsWith('dns_')) bad.push(`${u} 사유가 ${r.reason}`);
  }
  ok('U15-blocked-hosts', bad.length === 0,
    bad.length ? bad.join(', ') : `${S.network.blocked_hosts.length}종 거절 · ${reasons.join(' ')}`);
}

{
  // 공인과 사설이 섞여 오면 통째로 거절한다
  const resolver = tableResolver({ 'mixed.example.com': ['93.184.216.34', '10.0.0.5'] });
  const r = await checkTarget('https://mixed.example.com/', { resolver });
  ok('U16-mixed-rejected', r.allow === false && r.reason === 'resolves_to_non_public' && r.rejected[0].kind === 'private',
    `${r.reason} · 걸린 주소 ${r.rejected.map((x) => `${x.address}(${x.kind})`).join(', ')}`);
}
{
  const r = await checkTarget('https://nowhere.example.com/', { resolver: tableResolver({}) });
  ok('U17-dns-failure-not-allowed', r.allow === false && r.reason === 'dns_ENOTFOUND', r.reason);
  const empty = await checkTarget('https://empty.example.com/', { resolver: tableResolver({ 'empty.example.com': [] }) });
  ok('U18-empty-answer-not-allowed', empty.allow === false && empty.reason === 'dns_empty',
    `빈 답을 허용으로 바꾸지 않는다 — ${empty.reason}`);
}

// ── DNS 가 바뀌는 경우(rebinding) ─────────────────────────────

{
  // 같은 이름이 처음에는 공인, 두 번째에는 사설을 내놓는다
  let call = 0;
  const flipping = async () => (++call === 1 ? ['93.184.216.34'] : ['127.0.0.1']);
  const first = await checkTarget('https://flip.example.com/', { resolver: flipping });
  const second = await checkTarget('https://flip.example.com/', { resolver: flipping });
  ok('U19-rebinding-first-clean', first.allow === true && first.addresses.join() === '93.184.216.34'
    && !first.addresses.some((a) => !isPublicIp(a)),
    `처음 판정의 허용 집합 [${first.addresses.join(', ')}] — 사설이 섞이지 않았다`);
  ok('U20-rebinding-second-denied', second.allow === false && second.rejected[0]?.kind === 'loopback',
    `두 번째 조회는 거절 — ${second.reason}`);
}

// ── 리다이렉트는 홉마다 다시 본다 ─────────────────────────────

{
  const resolver = tableResolver({ 'good.example.com': ['93.184.216.34'], 'evil.example.com': ['169.254.169.254'] });
  const hop1 = await checkRedirect('/next/page', 'https://good.example.com/start', { resolver });
  ok('U21-redirect-relative', hop1.allow === true && hop1.canonical_url === 'https://good.example.com/next/page',
    hop1.canonical_url);
  const hop2 = await checkRedirect('http://evil.example.com/meta', 'https://good.example.com/start', { resolver });
  ok('U22-redirect-rechecked', hop2.allow === false && hop2.rejected[0]?.kind === 'link_local',
    `앞 홉이 통과했다고 다음 홉을 통과시키지 않는다 — ${hop2.reason}`);
  const hop3 = await checkRedirect('ftp://good.example.com/x', 'https://good.example.com/start', { resolver });
  ok('U23-redirect-scheme', hop3.allow === false && hop3.reason === 'url_scheme', hop3.reason);
}

// ── 출력 ──────────────────────────────────────────────────────

const totalUrls = S.merge_groups.reduce((n, g) => n + g.urls.length, 0)
  + (S.distinct_pairs.length * 2) + S.normalize.length + S.reject.length;
for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.id} — ${r.detail}`);
const failed = results.filter((r) => !r.pass);
console.log(`URL 표본 ${totalUrls}개 · IP 표본 ${S.network.public_ips.length + S.network.blocked_ips.length}개`);
console.log(failed.length === 0 ? `PASS  URL·네트워크 정책 단위 시험 ${results.length}항목 통과` : `FAIL  ${failed.length}건`);
process.exit(failed.length === 0 ? 0 : 1);
