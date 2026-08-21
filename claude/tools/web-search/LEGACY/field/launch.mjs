#!/usr/bin/env node
// 태스크 22 실전 launcher — 아홉 크롤의 이름·씨앗·역할을 여기에 못 박는다.
//
// 규칙
//  - 한 도메인에 워커 하나. 이미 그 크롤을 도는 워커가 있으면 시작하지 않는다.
//  - 이미 있는 크롤 폴더에는 정책(allow_domains·mode)과 씨앗이 같을 때만 이어 붙인다.
//  - 속도 우회 환경변수(WS_MIN_INTERVAL_MS·WS_JITTER_MS)는 실전에서 아예 금지한다.
//  - 완료 판정은 바깥 셸이 아니라 워커의 실제 종료 코드로 한다(wait 직후 그대로 보존).
//
// 실행: WEBSEARCH_DEPS_DIR=<레포> CLAUDE_PROJECT_DIR=<레포> node field/launch.mjs [크롤이름...|all]

import fs from 'node:fs';
import path from 'node:path';
import { spawn, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER = path.join(HERE, 'worker.mjs');
const PROJECT = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const ROOT = path.join(PROJECT, '.claude', 'web-search');

// 이름 · 씨앗 · 역할 — 역할은 2026-08-11 사전 실측에서 나온 값 그대로다(짐작 아님)
const FLEET = [
  { crawl: 'kr-deardeer', origin: 'https://deardeer.kr/', role: '국내 · 사이트맵 138건 기준점' },
  { crawl: 'kr-barunson', origin: 'https://mcard.barunsoncard.com/', role: '국내 · 302 우회 확인 대상' },
  { crawl: 'kr-theirmood', origin: 'https://theirmood.com/', role: '국내 · 소규모 목록' },
  { crawl: 'kr-itscard', origin: 'https://itscard.co.kr/', role: '국내' },
  { crawl: 'kr-bojagi', origin: 'https://bojagicard.com/', role: '국내 · JS/Jina 관찰 대상(무키 Jina 403, 최종 tier 그대로 기록)' },
  { crawl: 'kr-salondeletter', origin: 'https://salondeletter.com/', role: '국내' },
  { crawl: 'ex-paperlesspost', origin: 'https://www.paperlesspost.com/', role: 'JS/Jina 경로 후보 — curl 406 · 무키 Jina 403 · headless 200 카드 48 (Jina 성공 아님)' },
  { crawl: 'ex-optimalprint', origin: 'https://www.optimalprint.com/', role: '언어·지역 리다이렉트 — / → /en 실측' },
  { crawl: 'ex-minted', origin: 'https://www.minted.com/', role: 'Cloudflare 차단형 — curl 403 · Jina 403 뒤 전역 pace 휴면' },
  // 1회차 뒤 고친 것(종류 판정·링크 병합)을 같은 조건에서 다시 재는 자리.
  // 기존 kr-barunson 장부는 실패 실측 그대로 보존해야 하므로 이름을 따로 둔다.
  { crawl: 'kr-barunson-postfix', origin: 'https://mcard.barunsoncard.com/', role: '국내 · 수정 뒤 후속 회차(1회차와 나란히 비교)' },
];

// [속도는 도구가 강제한다] 감싸는 쪽이 예의를 깎을 수 있으면 계약이 아니다.
if (process.env.WS_MIN_INTERVAL_MS != null || process.env.WS_JITTER_MS != null) {
  console.error('WS_MIN_INTERVAL_MS·WS_JITTER_MS 가 켜져 있습니다. 실전 launcher 에서는 쓸 수 없습니다.');
  process.exit(2);
}

const want = process.argv.slice(2);
const picked = (!want.length || want[0] === 'all') ? FLEET : FLEET.filter((f) => want.includes(f.crawl));
const unknown = want.filter((w) => w !== 'all' && !FLEET.some((f) => f.crawl === w));
if (unknown.length) { console.error(`표에 없는 크롤: ${unknown.join(', ')}`); process.exit(2); }

// 지금 도는 워커 — 한 도메인에 둘을 붙이지 않는다
let running = '';
try { running = execSync('ps -eo command', { encoding: 'utf8' }); } catch {}

function precheck(f) {
  if (new RegExp(`worker\\.mjs ${f.crawl} `).test(running)) return `이미 그 크롤을 도는 워커가 있음`;
  const dir = path.join(ROOT, f.crawl);
  if (!fs.existsSync(path.join(dir, 'state.json'))) return null;          // 새로 만든다
  // 이어 붙이려면 정책과 씨앗이 같아야 한다 — 다르면 앞뒤가 다른 잣대로 모인다
  let pol;
  try { pol = JSON.parse(fs.readFileSync(path.join(dir, 'policy.json'), 'utf8')); }
  catch (e) { return `policy.json 을 읽지 못함: ${e.message}`; }
  const host = new URL(f.origin).hostname;
  if (pol.mode !== 'exhaustive') return `mode 가 ${pol.mode} (exhaustive 여야 함)`;
  if ((pol.allow_domains || []).join(',') !== host) return `allow_domains 가 [${pol.allow_domains}] (기대 [${host}])`;
  let seeds = '';
  try { seeds = fs.readFileSync(path.join(dir, 'seeds.jsonl'), 'utf8'); } catch {}
  if (!seeds.includes(f.origin)) return `씨앗에 ${f.origin} 가 없음`;
  return null;
}

const record = { at: new Date().toISOString(), launcher_pid: process.pid, runs: [] };
const jobs = [];

for (const f of picked) {
  const why = precheck(f);
  if (why) {
    console.log(`건너뜀  ${f.crawl.padEnd(18)} — ${why}`);
    record.runs.push({ crawl: f.crawl, origin: f.origin, role: f.role, skipped: why });
    continue;
  }
  const dir = path.join(ROOT, f.crawl);
  const resumed = fs.existsSync(path.join(dir, 'state.json'));
  let before = null;
  if (resumed) {
    const st = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
    before = {};
    for (const r of Object.values(st.urls || {})) before[r.state] = (before[r.state] || 0) + 1;
  }

  const log = path.join(dir, 'worker.log');
  fs.mkdirSync(dir, { recursive: true });
  const out = fs.openSync(log, 'a');
  const child = spawn('node', [WORKER, f.crawl, f.origin], {
    env: process.env, stdio: ['ignore', out, out],
  });
  console.log(`시작    ${f.crawl.padEnd(18)} PID ${child.pid} ${resumed ? `(이어감 · 이전 상태 ${JSON.stringify(before)})` : '(새로)'} ${f.origin}`);

  const entry = {
    crawl: f.crawl, origin: f.origin, role: f.role,
    worker_pid: child.pid, resumed, state_before: before,
    started_at: new Date().toISOString(), log,
  };
  record.runs.push(entry);
  jobs.push(new Promise((resolve) => {
    child.on('close', (code, signal) => {
      // 워커의 실제 종료 코드를 그대로 보존한다 — 뒤에 무엇을 하든 이 값이 판정 기준이다
      entry.worker_exit = code;
      entry.signal = signal;
      entry.finished_at = new Date().toISOString();
      try {
        const m = JSON.parse(fs.readFileSync(path.join(dir, 'run-meta.json'), 'utf8'));
        entry.run_meta_exit = m.exit_code;
        entry.mcp_pid = m.mcp_pid;
        entry.completion = m.completion;
        entry.blocked = m.blocked;
      } catch {}
      console.log(`끝      ${f.crawl.padEnd(18)} 워커 종료 ${code}${signal ? `/${signal}` : ''} · run-meta ${entry.run_meta_exit} · ${entry.completion ?? '-'}`);
      fs.closeSync(out);
      resolve();
    });
  }));
}

await Promise.all(jobs);

const recPath = path.join(ROOT, `launch-${record.at.replace(/[:.]/g, '-')}.json`);
fs.writeFileSync(recPath, JSON.stringify(record, null, 2));
console.log(`\n실행 기록: ${recPath}`);
const bad = record.runs.filter((r) => r.worker_exit !== 0 && !r.skipped);
console.log(bad.length ? `실패 ${bad.length}건: ${bad.map((b) => `${b.crawl}(${b.worker_exit})`).join(', ')}` : '시작한 워커 모두 종료 코드 0');
process.exit(bad.length ? 1 : 0);
