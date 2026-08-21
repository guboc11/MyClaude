#!/usr/bin/env node
// 태스크 22 사전 실측 — 추가 3곳의 "역할"을 지금 계단으로 직접 재서 정한다.
// 과거 기대 문장은 증거가 아니다. requested/final/status/content_tier/page_validity/flags 만 본다.
//
// 규칙: 후보마다 1회씩만. 같은 도메인은 하나뿐이라 도메인끼리는 동시에 돈다.
// 유료 키·로그인·CAPTCHA 우회 없음. 막히면 막힌 그대로 적는다.
//
// 실행: WEBSEARCH_DEPS_DIR=<레포> CLAUDE_PROJECT_DIR=<레포> node tests/probe-roles.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.join(HERE, '..', 'lib');
const CRAWL = 'probe-2026-08-11';

const store = await import(path.join(LIB, 'store.mjs'));
const paths = await import(path.join(LIB, 'paths.mjs'));
const { fetchOne } = await import(path.join(LIB, 'fetch.mjs'));

// 후보 — 국내 6곳과 겹치지 않는 고유 도메인. 역할은 미정이고, 재 본 뒤에 붙인다.
const CANDIDATES = [
  { url: 'https://www.paperlesspost.com/cards/category/wedding-invitations', kind: 'listing', asks: 'JS 목록' },
  { url: 'https://www.zola.com/wedding-planning/wedding-invitations', kind: 'listing', asks: 'JS 목록' },
  { url: 'https://www.minted.com/wedding-invitations', kind: 'listing', asks: '브라우저 필요' },
  { url: 'https://www.papier.com/', kind: 'unknown', asks: '지역·언어' },
  { url: 'https://www.optimalprint.com/', kind: 'unknown', asks: '지역·언어' },
  { url: 'https://www.rosemood.co.uk/', kind: 'unknown', asks: '지역·언어' },
];

const RESUME = process.env.RESUME_EXISTING === '1';
const root = paths.root();
console.log(`장부: ${path.join(root, CRAWL)}${RESUME ? '  (이어가기)' : ''}\n`);

let tok;
if (RESUME) {
  const st = store.loadState(CRAWL);
  tok = Object.fromEntries(Object.entries(st.urls)
    .filter(([, r]) => r.lease?.token)
    .map(([id, r]) => [r.url, { url_id: id, lease_token: r.lease.token }]));
} else {
  store.createCrawl(CRAWL, {
    seeds: CANDIDATES.map((c) => c.url),
    policy: {
      mode: 'pilot', min_interval_ms: 10_000, interval_jitter_ms: 5_000,
      daily_cap: 30, lease_ttl_ms: 900_000,
    },
  });
  const leased = store.lease(CRAWL, 20, 'probe');
  tok = Object.fromEntries(leased.leased.map((x) => [x.url, { url_id: x.url_id, lease_token: x.lease_token }]));
}

const findLease = (url) => {
  const key = Object.keys(tok).find((k) => k === url || k.replace(/\/$/, '') === url.replace(/\/$/, ''));
  return tok[key] || {};
};

// 도메인이 다 다르므로 동시에 돈다 — 같은 도메인을 겹쳐 두드리지 않는다.
const runOne = async (c) => {
  const host = new URL(c.url).hostname;
  const lease = findLease(c.url);
  const DEADLINE = Date.now() + 5 * 60_000;
  let r = null;
  for (let i = 0; i < 40; i++) {
    r = await fetchOne(CRAWL, { url: c.url, kind: c.kind, maxTier: 'chrome', ...lease });
    if (!r.deferred) break;
    if (r.why === 'daily_cap' || (r.wait_seconds || 0) > 120 || Date.now() > DEADLINE) {
      console.log(`  … ${host} 중단: ${r.why} (${r.wait_seconds}초 요구)`);
      return { c, host, err: `중단: ${r.why}`, resume: r.resume };
    }
    console.log(`  … ${host} 대기 ${r.wait_seconds}초 (${r.why}, 끝낸 단 [${(r.resume?.done_tiers || []).join(',')}])`);
    await new Promise((res) => setTimeout(res, ((r.wait_seconds || 1) * 1000) + 200));
  }
  if (r?.refused) return { c, host, err: `거절: ${r.why}` };
  return { c, host, r };
};

const rows = await Promise.all(CANDIDATES.map(runOne));

console.log(`\n${'='.repeat(78)}\n실측 결과 (${new Date().toISOString()})\n`);
for (const x of rows) {
  if (!x.r) { console.log(`${x.host}\n  ${x.err}\n`); continue; }
  const r = x.r;
  console.log(`${x.host}   [${x.c.asks} 후보]`);
  console.log(`  requested  ${r.requested}`);
  console.log(`  final      ${r.final}${r.final !== r.requested ? '   ← 다름' : ''}`);
  console.log(`  status     ${r.status}`);
  console.log(`  content_tier ${r.content_tier}   visual ${r.visual_tier || '없음'} (${r.visual})`);
  console.log(`  page_validity ${r.page_validity} / 추출 ${r.extraction_status} / 카드 ${r.cards}`);
  console.log(`  flags      [${(r.flags || []).join(', ')}]`);
  console.log(`  증거       [${(r.positive_evidence || []).join(', ')}]`);
  console.log(`  부정       [${(r.negatives || []).join(', ')}]`);
  console.log(`  단계       ${(r.attempts || []).map((a) => `${a.tier}:${a.status}${a.promote_reason ? `(${a.promote_reason})` : ''}`).join(' → ')}`);
  console.log('');
}

const out = path.join(root, CRAWL, 'probe-roles.json');
fs.writeFileSync(out, JSON.stringify(rows.map((x) => ({
  url: x.c.url, host: x.host, asks: x.c.asks, err: x.err,
  ...(x.r ? {
    requested: x.r.requested, final: x.r.final, status: x.r.status,
    content_tier: x.r.content_tier, visual_tier: x.r.visual_tier, visual: x.r.visual,
    page_validity: x.r.page_validity, extraction_status: x.r.extraction_status, cards: x.r.cards,
    flags: x.r.flags, positive_evidence: x.r.positive_evidence, negatives: x.r.negatives,
    attempts: x.r.attempts, shot: x.r.shot,
  } : {}),
})), null, 2));
console.log(`실측 기록: ${out}`);
process.exit(0);
