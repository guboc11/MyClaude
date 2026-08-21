#!/usr/bin/env node
// 무키 검색 공급자 사전 probe — 식별 가능한 자동화 UA 로만 잰다.
//
//   node tests/spikes/search-provider/probe.mjs
//
// [UA] 브라우저로 가장하지 않는다. 가장한 채 통과한 결과는 채택 근거가 될 수 없다.
// 여기서 막히면 blocked 다. 연락처를 지어내지 않고 도구 이름과 판만 밝힌다.
//
// [경계] 유료 등록·키 발급·CAPTCHA 우회를 하지 않는다. 도메인마다 간격을 두고 한 번씩만 두드린다.
// 원문은 artifacts/ 에 남기고 stdout 에는 수치와 분류만 낸다.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ART = path.join(HERE, 'artifacts');
const RESULTS = path.join(HERE, 'results');

const UA = 'WebSearchMCP-Spike/2.0 (+automated evaluation; no browser emulation)';
const DOMAIN_GAP_MS = 4000;
const TIMEOUT_MS = 20000;

const lastHit = new Map();
const log = [];

async function get(url, { label, saveAs }) {
  const host = new URL(url).hostname;
  const prev = lastHit.get(host) ?? 0;
  const wait = Math.max(0, prev + DOMAIN_GAP_MS - Date.now());
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastHit.set(host, Date.now());

  const t0 = Date.now();
  const rec = { label, requested: url, host, ua: UA, waited_ms: wait };
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': UA, accept: '*/*' },
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = await res.text();
    rec.status = res.status;
    rec.final = res.url;
    rec.content_type = res.headers.get('content-type');
    rec.bytes = Buffer.byteLength(body, 'utf8');
    rec.elapsed_ms = Date.now() - t0;
    if (saveAs) {
      const p = path.join(ART, saveAs);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, body);
      rec.artifact = path.relative(HERE, p);
    }
    rec.body = body;
  } catch (e) {
    rec.status = 0;
    rec.final = url;
    rec.elapsed_ms = Date.now() - t0;
    rec.error = e.message.slice(0, 160);
    rec.body = '';
  }
  log.push({ ...rec, body: undefined });
  return rec;
}

// 응답이 무엇인지 사실로만 가른다. 상태 200 하나로 성공이라 하지 않는다.
function classify(rec, { expect }) {
  const b = rec.body || '';
  const lower = b.toLowerCase();
  if (rec.error) return { verdict: /timeout|abort/i.test(rec.error) ? 'timeout' : 'provider_error', why: rec.error };
  if (/captcha|verifying your browser|are you a robot|challenge-platform/i.test(b)) {
    return { verdict: 'captcha', why: '본문에 사람 확인 화면 표시가 있다' };
  }
  if (rec.status === 403 || rec.status === 429) return { verdict: 'blocked', why: `HTTP ${rec.status}` };
  if (rec.status >= 500) return { verdict: 'provider_error', why: `HTTP ${rec.status}` };
  if (rec.status !== 200) return { verdict: 'provider_error', why: `HTTP ${rec.status}` };
  if (expect === 'rss' && !/<rss|<feed|<item>/i.test(b)) {
    return { verdict: 'no_result_format', why: 'RSS·Atom 형식이 아니다' };
  }
  if (expect === 'html-results' && !/<a [^>]*href=/i.test(b)) {
    return { verdict: 'no_result_format', why: '결과 링크가 없다' };
  }
  if (expect === 'html-results' && lower.includes('unfortunately, bots use duckduckgo too')) {
    return { verdict: 'blocked', why: '자동 접근 거절 문구' };
  }
  return { verdict: 'reachable', why: '형식은 왔다. 이용 조건·결과 품질은 따로 본다' };
}

// ── 후보 ──────────────────────────────────────────────────────

const CANDIDATES = [
  {
    id: 'ddg-html', name: 'DuckDuckGo HTML endpoint',
    endpoint: 'https://html.duckduckgo.com/html/?q={q}',
    keyless: true, kind: 'general-web-results',
    robots_artifact: 'robots/html.duckduckgo.com.txt',
  },
  {
    id: 'ddg-lite', name: 'DuckDuckGo Lite endpoint',
    endpoint: 'https://lite.duckduckgo.com/lite/?q={q}',
    keyless: true, kind: 'general-web-results',
    robots_artifact: 'robots/lite.duckduckgo.com.txt',
  },
  {
    id: 'bing-rss', name: 'Bing 공개 RSS 검색 형식',
    endpoint: 'https://www.bing.com/search?q={q}&format=rss',
    keyless: true, kind: 'general-web-results',
    robots_artifact: 'robots/www.bing.com.txt',
  },
];

// ── 실행 ──────────────────────────────────────────────────────

fs.mkdirSync(ART, { recursive: true });
fs.mkdirSync(RESULTS, { recursive: true });

const started = Date.now();
const findings = [];

// 1) 새 후보의 robots
{
  const r = await get('https://www.bing.com/robots.txt', { label: 'robots:bing', saveAs: 'robots/www.bing.com.txt' });
  findings.push({ step: 'robots', target: 'www.bing.com', status: r.status, bytes: r.bytes, artifact: r.artifact });
}

// 2) robots 가 막지 않은 후보에만 질의 한 번씩
const PROBE_Q = 'wedding invitation';
for (const c of CANDIDATES) {
  const url = c.endpoint.replace('{q}', encodeURIComponent(PROBE_Q));
  const expect = c.id === 'bing-rss' ? 'rss' : 'html-results';
  const rec = await get(url, { label: `probe:${c.id}`, saveAs: `probe/${c.id}.txt` });
  const v = classify(rec, { expect });
  findings.push({
    step: 'probe', candidate: c.id, requested: rec.requested, final: rec.final,
    status: rec.status, content_type: rec.content_type, bytes: rec.bytes, elapsed_ms: rec.elapsed_ms,
    verdict: v.verdict, why: v.why, artifact: rec.artifact,
  });
}

// 3) 공식 이용 조건 원문 (robots 와 별개 근거)
for (const [label, url, saveAs] of [
  ['tos:ddg-aup', 'https://duckduckgo.com/acceptable-use-policy', 'tos/duckduckgo-acceptable-use.html'],
  ['tos:bing-msa', 'https://www.microsoft.com/en-us/servicesagreement', 'tos/microsoft-services-agreement.html'],
]) {
  const r = await get(url, { label, saveAs });
  findings.push({ step: 'terms', target: label, status: r.status, final: r.final, bytes: r.bytes, artifact: r.artifact });
}

const report = {
  spike: 'search-provider probe',
  ran_at: new Date().toISOString(),
  user_agent: UA,
  ua_note: '브라우저로 가장하지 않는 식별 가능한 자동화 UA. 앞선 예비 조회에 쓴 Chrome UA 는 비교용이었고 채택 근거로 쓰지 않는다.',
  pacing: { domain_gap_ms: DOMAIN_GAP_MS, timeout_ms: TIMEOUT_MS },
  requests: log.length,
  total_ms: Date.now() - started,
  findings,
  request_log: log,
};
fs.writeFileSync(path.join(RESULTS, 'probe.json'), `${JSON.stringify(report, null, 2)}\n`);

for (const f of findings) {
  if (f.step === 'probe') console.log(`${f.candidate.padEnd(10)} ${String(f.status).padStart(3)} ${String(f.bytes).padStart(7)}B ${f.verdict.padEnd(16)} ${f.why}`);
  else console.log(`${f.step.padEnd(6)} ${f.target} → ${f.status} ${f.bytes ?? ''}B`);
}
console.log(`요청 ${log.length}건 · 총 ${Math.round((Date.now() - started) / 1000)}초 · 도메인 간격 ${DOMAIN_GAP_MS}ms · UA ${UA}`);
