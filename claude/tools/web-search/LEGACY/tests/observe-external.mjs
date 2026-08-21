#!/usr/bin/env node
// 외부 다섯 곳 관찰 — 합격 조건이 아니다. 2026-08-11 현재 바깥 상태를 그대로 적는 용도.
// 계획서 게이트 2의 관찰 표. 대상은 repo·리서치에서 이미 확인된 실재 URL 만 쓴다(추측 금지).
//
// 규칙: 대상마다 1회씩만. 도메인 간격을 넉넉히(20초). 차단·오류면 억지 우회 없이 그대로 기록.
// 실행: WEBSEARCH_DEPS_DIR=<레포> node tests/observe-external.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.join(HERE, '..', 'lib');
const OUT = process.env.OBSERVE_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'websearch-observe-'));
process.env.CLAUDE_PROJECT_DIR = OUT;

const store = await import(path.join(LIB, 'store.mjs'));
const { fetchOne } = await import(path.join(LIB, 'fetch.mjs'));

// 전부 이 세션에서 실제로 열어 확인한 주소다(2026-08-09·08-11 조사).
const TARGETS = [
  { url: 'https://deardeer.kr/mcard/list', kind: 'listing', expect: 'curl 에서 끝남', maxTier: 'chrome' },
  { url: 'https://bojagicard.com/card/', kind: 'listing', expect: 'Jina 에서 끝남', maxTier: 'chrome' },
  { url: 'https://www.minted.com/wedding/foil-pressed-wedding-invitations', kind: 'listing', expect: '실제 크롬까지 올라감', maxTier: 'chrome' },
  { url: 'https://www.greenvelope.com/online-wedding-invitations', kind: 'listing', expect: '200 이지만 invalid', maxTier: 'chrome' },
  { url: 'https://thedigitalyes.com/collections/digital-wedding-invitations', kind: 'listing', expect: 'final != requested', maxTier: 'chrome' },
];

// SKIP=deardeer.kr,other.com 으로 특정 도메인을 건너뛴다.
// RESUME_EXISTING=1 이면 기존 crawl·lease 를 그대로 이어간다(새 장부를 만들면 pace 를 우회하게 된다).
const SKIP = new Set((process.env.SKIP || '').split(',').map((s) => s.trim()).filter(Boolean));
const RESUME = process.env.RESUME_EXISTING === '1';

console.log(`저장: ${OUT}${RESUME ? '  (기존 장부 이어가기)' : ''}`);
if (SKIP.size) console.log(`건너뜀: ${[...SKIP].join(', ')}`);

let tok;
if (RESUME) {
  const st = store.loadState('observe');
  if (!Object.keys(st.urls).length) throw new Error(`이어갈 crawl 이 없습니다: ${OUT}`);
  // 기존 임대를 그대로 쓴다 — 새로 lease 하면 토큰이 바뀌어 진행 기록이 폐기된다.
  tok = Object.fromEntries(Object.entries(st.urls)
    .filter(([, r]) => r.lease?.token)
    .map(([id, r]) => [r.url, { url_id: id, lease_token: r.lease.token }]));
} else {
  store.createCrawl('observe', {
    seeds: TARGETS.map((t) => t.url),
    policy: { mode: 'pilot', min_interval_ms: 20_000, interval_jitter_ms: 6_000, daily_cap: 20, lease_ttl_ms: 600_000 },
  });
  const leased = store.lease('observe', 20, 'observer');
  tok = Object.fromEntries(leased.leased.map((x) => [x.url, { url_id: x.url_id, lease_token: x.lease_token }]));
}

// 네트워크에 나가기 전에 지금 장부가 어떤 상태인지 눈으로 확인한다.
{
  const pace = await import(path.join(LIB, 'pace.mjs'));
  console.log('\n[네트워크 전 확인]');
  for (const t of TARGETS) {
    const host = new URL(t.url).hostname;
    const p = pace.peek(host);
    const lease = tok[Object.keys(tok).find((k) => k.startsWith(t.url.replace(/\/$/, '')) || t.url.startsWith(k)) || ''] || {};
    let done = '없음';
    try {
      const pf = path.join(OUT, '.claude', 'web-search', 'observe', 'manifests', lease.url_id || '_', 'progress.json');
      done = Object.keys(JSON.parse(fs.readFileSync(pf, 'utf8')).tiers).join(',') || '없음';
    } catch {}
    console.log(`  ${host.padEnd(24)} 오늘 ${String(p.today_count).padStart(2)}회 · 대기 ${p.waiting_seconds}s · 끝낸 단 ${done}${SKIP.has(host) ? '  → 건너뜀' : ''}`);
  }
  console.log('');
}

const rows = [];
for (const t of TARGETS) {
  const host = new URL(t.url).hostname;
  if (SKIP.has(host)) {
    rows.push({ t, skipped: true, note: '지시에 따라 네트워크 접근 안 함' });
    console.log(`${host}\n  건너뜀 — 네트워크 접근하지 않음\n`);
    continue;
  }
  const key = Object.keys(tok).find((k) => k.startsWith(t.url.replace(/\/$/, '')) || t.url.startsWith(k));
  const lease = tok[key] || {};
  let r;
  // resumable fetch 이므로 재호출은 끝낸 단을 다시 요청하지 않는다.
  // 그래도 상한을 둔다 — 하루 한도에 걸리면 몇 시간을 기다리게 되므로 그때는 그대로 기록하고 넘어간다.
  const DEADLINE = Date.now() + 4 * 60_000;
  for (let i = 0; i < 30; i++) {
    r = await fetchOne('observe', { url: t.url, kind: t.kind, maxTier: t.maxTier, ...lease });
    if (!r.deferred) break;
    if (r.why === 'daily_cap' || (r.wait_seconds || 0) > 120 || Date.now() > DEADLINE) {
      process.stdout.write(`  … ${new URL(t.url).hostname} 중단: ${r.why} (${r.wait_seconds}초 대기 요구) — 관찰 포기, 그대로 기록\n`);
      rows.push({ t, err: `관찰 중단: ${r.why}, 남은 대기 ${r.wait_seconds}초`, resume: r.resume });
      r = null;
      break;
    }
    process.stdout.write(`  … ${new URL(t.url).hostname} 대기 ${r.wait_seconds}초 (${r.why}, 끝낸 단 [${r.resume?.done_tiers || []}])\n`);
    await new Promise((res) => setTimeout(res, ((r.wait_seconds || 1) * 1000) + 200));
  }
  if (!r) continue;
  if (r.refused) { rows.push({ t, err: `거절: ${r.why}` }); continue; }
  rows.push({ t, r });
  console.log(`${new URL(t.url).hostname}
  기대       ${t.expect}
  content    ${r.content_tier}   visual ${r.visual_tier || '없음'} (${r.visual})
  status     ${r.status}   final ${r.final}
  판정       ${r.page_validity} / 추출 ${r.extraction_status} / 카드 ${r.cards}
  증거       [${(r.positive_evidence || []).join(', ')}]
  부정       [${(r.negatives || []).join(', ')}]
  flags      [${(r.flags || []).join(', ')}]
  단계       ${(r.attempts || []).map((a) => `${a.tier}:${a.status}${a.promote_reason ? `(${a.promote_reason})` : ''}`).join(' → ')}
  캡처       ${r.shot || '없음'}
`);
}

fs.writeFileSync(path.join(OUT, 'observation.json'), JSON.stringify(rows.map((x) => ({
  url: x.t.url, expect: x.t.expect, err: x.err,
  ...(x.r ? {
    content_tier: x.r.content_tier, visual_tier: x.r.visual_tier, visual: x.r.visual,
    status: x.r.status, final: x.r.final, page_validity: x.r.page_validity,
    extraction_status: x.r.extraction_status, cards: x.r.cards,
    positive_evidence: x.r.positive_evidence, negatives: x.r.negatives,
    flags: x.r.flags, attempts: x.r.attempts, shot: x.r.shot,
  } : {}),
})), null, 2));
console.log(`관찰 기록: ${path.join(OUT, 'observation.json')}`);
