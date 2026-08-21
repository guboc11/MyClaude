#!/usr/bin/env node
// 태스크 22 실전 워커 — seed 도메인 한 곳에 한 명. 다른 도메인끼리만 동시에 돈다.
//
// [MCP 경계] 이 파일은 store/fetch/discover 를 import 하지 않는다.
//   워커마다 server.mjs 를 stdio 자식으로 띄우고 crawl_new·discover·lease·fetch·report·status 를
//   전부 tools/call 로 보낸다. 내부 모듈로 질러가면 실전에서 정작 쓰는 길을 시험하지 못한다.
//
// 고리는 둘이고 섞이지 않는다.
//   [가] 발견 — discover(origin) 을 완주할 때까지 이어 부른다(lease 안 씀).
//   [나] URL 처리 — lease → 종류별 처리 → report.
//
// [목록 우선] 상세를 전부 열면 "요청을 얼마나 줄였나" 라는 이번 회차 측정이 무효가 된다.
//   detail  → 열지 않고 known_deferred 로 재운다. 재우기가 허용되는 종류는 이것 하나뿐이다.
//   listing → 연다.
//   unknown → 분류 근거가 없다는 뜻이므로 연다. 경로 깊이로 상세라고 짐작해 재우지 않는다.
//             (숨은 쪽 예산을 넣으면 exhaustive 가 아니다.)
//
// 회차 기한에 걸려 못 연 것은 queued 로 되돌린다 — 완료가 아니라 paused_incomplete 여야 한다.
//
// 응답은 글이다. 못 읽으면 추측하지 않고 멈추고 원문을 로그에 남긴다.
//
// 실행: WEBSEARCH_DEPS_DIR=<레포> CLAUDE_PROJECT_DIR=<레포> node field/worker.mjs <크롤> <origin>

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, '..', 'server.mjs');
const [CRAWL, ORIGIN] = process.argv.slice(2);
if (!CRAWL || !ORIGIN) { console.error('사용법: worker.mjs <크롤> <origin>'); process.exit(2); }

const PROJECT = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const CRAWL_DIR = path.join(PROJECT, '.claude', 'web-search', CRAWL);
const HOST = new URL(ORIGIN).hostname;
const WORKER = `W:${HOST}`;
const log = (...a) => console.log(`[${HOST}] ${a.join(' ')}`);

// 표(lease_token)는 유효 기간이 있다. 한꺼번에 여럿 잡고 순서대로 열면 뒤쪽 표가 만료된다.
// 하나씩 빌려 하나씩 처리한다.
const LEASE_BATCH = 1;
const RUN_DEADLINE = Date.now() + 45 * 60_000;   // 운영 회차 제한. 남은 것은 queued 로 되돌린다.

// [속도는 도구가 강제한다] 간격을 낮추는 우회는 로컬 fixture 에서만 허용한다.
// 실도메인에서 이 환경변수가 켜져 있으면 조용히 무시하지 않고 실패시킨다 —
// 감싸는 쪽이 예의를 깎아내릴 수 있으면 그 계약은 계약이 아니다.
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const IS_LOCAL = LOCAL_HOSTS.has(new URL(ORIGIN).hostname);
const localOnly = (name) => {
  if (process.env[name] == null) return null;
  if (!IS_LOCAL) {
    console.error(`[${new URL(ORIGIN).hostname}] ${name} 는 로컬 fixture 에서만 쓸 수 있습니다.`);
    process.exit(2);
  }
  return process.env[name];
};
const PACE = {
  interval: Number(localOnly('WS_MIN_INTERVAL_MS') ?? 10_000),
  jitter: Number(localOnly('WS_JITTER_MS') ?? 5_000),
};
// fixture 바닥글의 x.example 은 이제 경계 판정까지 올라온다. 로컬 스모크가 진짜 바깥으로
// 나가면 안 되므로 그 자리에서만 막는다. 실사이트 정책에는 몰래 넣지 않는다.
const DENY = (localOnly('WS_DENY_DOMAINS') || '').split(',').map((s) => s.trim()).filter(Boolean);

// ---------- MCP 자식 하나 ----------
const child = spawn('node', [SERVER], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, CLAUDE_PROJECT_DIR: PROJECT },
});
const MCP_PID = child.pid;
let stderrTail = '';
child.stderr.on('data', (d) => { stderrTail = (stderrTail + d).slice(-4000); });

let buf = '';
const pending = new Map();
child.stdout.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    try {
      const m = JSON.parse(line);
      if (m.id != null && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    } catch { /* JSON-RPC 아닌 줄은 무시 */ }
  }
});

// 호출 기록 — 크롤 폴더가 생기기 전 호출은 모았다가 뒤에 쏟는다
const logBuf = [];
const flushLog = () => {
  if (!fs.existsSync(CRAWL_DIR) || !logBuf.length) return;
  fs.appendFileSync(path.join(CRAWL_DIR, 'mcp-log.jsonl'), logBuf.splice(0).map((x) => JSON.stringify(x)).join('\n') + '\n');
};

let nextId = 1;
function rpc(method, params, timeoutMs) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} 무응답 ${timeoutMs}ms`)); }, timeoutMs);
    pending.set(id, (m) => { clearTimeout(timer); resolve(m); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

const TIMEOUT = { fetch: 420_000, discover: 420_000, _default: 90_000 };
async function callTool(name, args = {}) {
  const t0 = Date.now();
  const m = await rpc('tools/call', { name, arguments: args }, TIMEOUT[name] || TIMEOUT._default);
  const text = m.result?.content?.[0]?.text ?? '';
  const isError = !!m.result?.isError;
  logBuf.push({ at: new Date().toISOString(), tool: name, args, ms: Date.now() - t0, isError, text });
  flushLog();
  return { text, isError };
}

// 응답을 못 읽으면 추측하지 않는다
function stop(why, text) {
  log(`멈춤: ${why}`);
  if (text) log(`  응답 원문: ${text.split('\n').slice(0, 3).join(' / ')}`);
  finish(1, why);
}

const counts = {
  crawl: CRAWL, host: HOST, origin: ORIGIN,
  worker_pid: process.pid, mcp_pid: MCP_PID,
  discovered_total: null,
  listing_fetched: 0,
  detail_known_deferred: 0,
  unknown_fetched: 0,
  fetch_refused: 0,
  links_seen: 0,          // 이 쪽들을 열며 본 링크 수
  links_added: 0,         // 그중 실제로 더미에 든 수(따라가지 않은 것과 구분해야 미관측을 안 숨긴다)
  requeued_on_deadline: 0,
  requeued_on_blocker: 0,
  report_not_applied: 0,
  network_deferrals: 0,
  blocked: null,
  completion: null,
  completion_reason: null,
};

let finished = false;
function finish(code, note) {
  if (finished) return; finished = true;
  counts.finished_at = new Date().toISOString();
  counts.exit_code = code;
  if (note) counts.note = note;
  try {
    if (fs.existsSync(CRAWL_DIR)) {
      flushLog();
      fs.writeFileSync(path.join(CRAWL_DIR, 'run-meta.json'), JSON.stringify(counts, null, 2));
    }
  } catch {}
  try { child.stdin.end(); child.kill('SIGTERM'); } catch {}
  log(`종료 코드 ${code} · 워커 PID ${process.pid} · MCP PID ${MCP_PID}`);
  process.exit(code);
}
process.on('SIGTERM', () => finish(143, 'SIGTERM'));
process.on('SIGINT', () => finish(130, 'SIGINT'));

const nap = (s) => new Promise((r) => setTimeout(r, Math.max(1, s) * 1000 + 200));

// ---------- 시작 ----------
counts.started_at = new Date().toISOString();

// 워커는 매뉴얼부터 읽는다. 사람 워커에게 시키는 첫 문장을 자동 워커도 똑같이 지킨다.
{
  const manualPath = path.join(HERE, '..', 'MANUAL.md');
  const body = fs.readFileSync(manualPath);
  const sha = crypto.createHash('sha256').update(body).digest('hex');
  counts.manual = { path: manualPath, sha256: sha, bytes: body.length };
  log('MANUAL.md 를 먼저 Read 하라');
  log(`  읽음: ${manualPath}`);
  log(`  sha256=${sha} · ${body.length}바이트`);
}
log(`워커 PID ${process.pid} · MCP PID ${MCP_PID} · ${ORIGIN}`);

await rpc('initialize', {}, 30_000);
const tl = await rpc('tools/list', {}, 30_000);
const names = new Set((tl.result?.tools || []).map((t) => t.name));
for (const need of ['crawl_new', 'discover', 'lease', 'fetch', 'report', 'status', 'cycle_report']) {
  if (!names.has(need)) stop(`도구가 없습니다: ${need}`);
}
log(`도구 ${names.size}개 확인`);

// ---------- 크롤 만들기 ----------
{
  const r = await callTool('crawl_new', {
    crawl: CRAWL,
    seeds: [ORIGIN],
    policy: {
      mode: 'exhaustive', allow_domains: [HOST], external_hop_max: 2,
      // 로컬 스모크에서만 채워진다. 실사이트에서는 빈 배열이라 아무것도 막지 않는다.
      deny_domains: DENY,
      min_interval_ms: PACE.interval, interval_jitter_ms: PACE.jitter,
      daily_cap: 5_000, domain_url_cap: 20_000, path_shape_cap: 5_000,
      query_combo_cap: 2_000, faceted_cap: 500, sitemap_depth_max: 8,
      lease_ttl_ms: 900_000, max_attempts: 3,
    },
  });
  if (r.isError && !/이미 있는 크롤/.test(r.text)) stop('crawl_new 실패', r.text);
  log(r.isError ? '기존 크롤 이어감' : '크롤 생성 · exhaustive · 간격 10초±5초');
}
flushLog();

// ---------- [가] 발견 고리 ----------
// 횟수로 자르지 않는다 — 세는 상한은 곧 숨은 쪽 예산이다. 멈추는 것은 회차 기한뿐.
while (true) {
  if (Date.now() > RUN_DEADLINE) { counts.blocked = { where: 'discover', why: 'run_deadline' }; break; }
  const r = await callTool('discover', { crawl: CRAWL, origin: ORIGIN, worker: WORKER });
  if (r.isError) stop('discover 오류', r.text);
  const t = r.text;

  if (/^이미 끝낸 회차입니다/.test(t)) { log('이미 끝낸 회차 — 다시 훑지 않음'); break; }
  if (/^경계에서 멈췄습니다/.test(t)) {
    counts.blocked = { where: 'discover', why: 'needs_boundary_review' };
    log('경계에서 멈춤 — 우회하지 않음'); break;
  }
  const wait = t.match(/^아직 안 끝났습니다 — (\d+)초 뒤 .*?\(사유 (\w+)\)/);
  if (wait) {
    const [, sec, why] = wait;
    if (why === 'domain_sleeping' || Number(sec) > 600) {
      counts.blocked = { where: 'discover', why, wait_seconds: Number(sec) };
      log(`발견 중단: ${why} (남은 ${sec}초) — 우회하지 않고 그대로 둠`); break;
    }
    log(`발견 대기 ${sec}초 (${why})`);
    await nap(Number(sec));
    continue;
  }
  const done = t.match(/^발견 (\d+)건 · 중복 (\d+)건 · 네트워크 (\d+)회/);
  if (done) { log(`발견 완주 — ${done[1]}건(중복 ${done[2]}) · 네트워크 ${done[3]}회`); break; }
  stop('discover 응답을 읽지 못했습니다', t);
}

// ---------- [나] URL 처리 고리 ----------

// report 는 "반영 1" 이어야 실제로 들어간 것이다. 반영 0 은 표가 회수됐다는 뜻이고,
// 그건 도메인이 느린 것과 달리 불변조건이 깨진 것이다 — 되풀이해 가리지 않고 워커를 실패로 끝낸다.
async function reportOne(base, state) {
  const r = await callTool('report', { crawl: CRAWL, items: [{ ...base, state }] });
  if (r.isError) { counts.report_not_applied++; stop('report 오류 — 불변조건 실패', r.text); }
  const m = r.text.match(/반영 (\d+) · 거절 (\d+)/);
  if (!m) stop('report 응답을 읽지 못했습니다', r.text);
  if (Number(m[1]) !== 1) {
    counts.report_not_applied++;
    stop(`report 반영 ${m[1]} — 불변조건 실패(늦은 표일 수 있음)`, r.text);
  }
  // 이 report 안에서 링크가 합쳐졌으면 그 셈도 받아 둔다(없는 응답은 0)
  const lk = r.text.match(/링크 본 것 (\d+) · 들인 것 (\d+)/);
  if (lk) { counts.links_seen += Number(lk[1]); counts.links_added += Number(lk[2]); }
  return true;
}

// "N건 임대 (대기 M 남음)" + "url_id kind url" / "    token=..."
// 머리의 개수와 실제로 읽어 낸 개수가 다르면 대기줄이 빈 것으로 오판하면 안 된다.
function parseLease(t) {
  if (/^빌려줄 것이 없습니다/.test(t)) return [];
  const head = t.match(/^(\d+)건 임대/);
  if (!head) stop('lease 응답을 읽지 못했습니다', t);
  const out = [];
  const lines = t.split('\n').slice(1);
  for (let i = 0; i < lines.length; i++) {
    const h = lines[i].match(/^(\S+) (\S+) (\S+)$/);
    const tok = (lines[i + 1] || '').match(/^\s+token=(\S+)$/);
    if (h && tok) { out.push({ url_id: h[1], kind: h[2], url: h[3], lease_token: tok[1] }); i++; }
  }
  if (out.length !== Number(head[1])) {
    stop(`lease 머리는 ${head[1]}건인데 ${out.length}건만 읽었습니다`, t);
  }
  return out;
}

// 도메인이 자면 이 회차의 URL 처리는 여기서 끝난다. 같은 주소를 즉시 다시 빌리면
// 네트워크는 0회인데 MCP 호출과 로그만 45분 동안 불어난다.
let haltReason = null;

while (Date.now() < RUN_DEADLINE && !haltReason) {
  const lr = await callTool('lease', { crawl: CRAWL, n: LEASE_BATCH, worker: WORKER });
  if (lr.isError) stop('lease 오류', lr.text);
  const items = parseLease(lr.text);
  if (!items.length) { log('대기줄 비었음'); break; }
  log(`임대 ${items.length}건`);

  for (const it of items) {
    const base = { url_id: it.url_id, lease_token: it.lease_token };
    // 빌린 직후 기한이 지났으면 쥔 채로 놓지 않는다 — 바로 대기줄로 되돌린다.
    // leased 로 남겨 두면 "남은 것은 queued" 라는 보고와 실제 장부가 어긋난다.
    if (Date.now() > RUN_DEADLINE) {
      await reportOne(base, 'queued');
      counts.requeued_on_deadline++;
      continue;
    }

    // 재우기가 허용되는 종류는 detail 하나뿐이다.
    if (it.kind === 'detail') {
      await reportOne(base, 'known_deferred');
      counts.detail_known_deferred++;
      continue;
    }

    let body = null;
    while (Date.now() < RUN_DEADLINE) {
      const fr = await callTool('fetch', { crawl: CRAWL, url: it.url, kind: it.kind, max_tier: 'chrome', ...base });
      // 거절과 오류는 도메인이 느린 것이 아니라 계약이 깨진 것이다 — 같은 주소를 다시 빌리지 않는다.
      if (fr.isError) { counts.fetch_refused++; stop('fetch 오류 — 불변조건 실패', fr.text); }
      const t = fr.text;
      const ref = t.match(/^거절: (\S+)/);
      if (ref) { counts.fetch_refused++; stop(`fetch 거절: ${ref[1]} — 불변조건 실패`, t); }
      const w = t.match(/^대기 (\d+)초 \((\w+)\)/);
      if (w) {
        counts.network_deferrals++;
        const [, sec, why] = w;
        if (why === 'domain_sleeping' || Number(sec) > 600) {
          counts.blocked = counts.blocked || { where: 'fetch', why, wait_seconds: Number(sec), url: it.url };
          haltReason = `${why} (남은 ${sec}초)`;
          break;
        }
        await nap(Number(sec));
        continue;
      }
      body = t; break;
    }
    // 못 연 것은 대기줄로 되돌린다 — 완료로 보이면 안 된다
    if (!body) {
      await reportOne(base, 'queued');
      // 기한 때문인지 막혀서인지를 섞으면 "얼마나 처리했나" 가 틀어진다
      if (haltReason) { counts.requeued_on_blocker++; break; }
      counts.requeued_on_deadline++;
      continue;
    }

    const head = body.split('\n')[0].match(/^(\w+) · 추출 (\w+) · (\w+)/);
    if (!head) stop('fetch 응답을 읽지 못했습니다', body);
    const [, validity, , visual] = head;
    const state = validity === 'invalid' ? 'invalid'
      : validity === 'needs_visual_review' ? 'needs_visual_review'
        : (validity === 'content_validated' && visual === 'visual_validated') ? 'visual_validated' : 'fetched';
    await reportOne(base, state);
    if (it.kind === 'listing') counts.listing_fetched++; else counts.unknown_fetched++;
    const cards = body.match(/카드 (\d+)/);
    log(`${it.kind} ${validity} 카드 ${cards ? cards[1] : '?'} ${it.url}`);
  }
}

if (haltReason) log(`URL 처리 중단: ${haltReason} — 우회하지 않고 상태 보고로 넘어감`);

// ---------- 장부 남기기 ----------
{
  const s = await callTool('status', { crawl: CRAWL });
  const total = s.text.match(/전체 (\d+)/);
  const comp = s.text.match(/완료판정: (\w+) \(([^)]*)\)/);
  counts.discovered_total = total ? Number(total[1]) : null;
  if (comp) { counts.completion = comp[1]; counts.completion_reason = comp[2]; }
  log(`상태: 전체 ${counts.discovered_total} · ${counts.completion} (${counts.completion_reason})`);

  const c = await callTool('cycle_report', { crawl: CRAWL, who: WORKER, reason: '태스크 22 실전 1회차' });
  log(c.text.split('\n')[0]);
}

log(`끝 — 발견 ${counts.discovered_total} · listing 연 것 ${counts.listing_fetched} · `
  + `detail 재움 ${counts.detail_known_deferred} · unknown 연 것 ${counts.unknown_fetched} · `
  + `링크 본 것 ${counts.links_seen}·들인 것 ${counts.links_added} · `
  + `기한에 되돌린 것 ${counts.requeued_on_deadline} · 반영 안 된 report ${counts.report_not_applied}`);
finish(0);
