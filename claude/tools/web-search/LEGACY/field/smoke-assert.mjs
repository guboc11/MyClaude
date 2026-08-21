#!/usr/bin/env node
// 스모크 판정 — worker 가 남긴 장부만 보고 계약 여섯 가지를 확인한다.
// 실행: node field/smoke-assert.mjs <샌드박스> <worker 실제 종료코드>

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const [SB, EXIT_RAW] = process.argv.slice(2);
const WORKER_EXIT = Number(EXIT_RAW);
const DIR = path.join(SB, '.claude', 'web-search', 'smoke');

const results = [];
const check = (no, name, pass, detail = '') => {
  results.push({ no, pass });
  console.log(`${pass ? 'O' : 'X'}  ${no}. ${name}${detail ? `\n      ${detail}` : ''}`);
};

const meta = JSON.parse(fs.readFileSync(path.join(DIR, 'run-meta.json'), 'utf8'));
const calls = fs.readFileSync(path.join(DIR, 'mcp-log.jsonl'), 'utf8')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l));

// ---- S1. 매뉴얼을 실제로 읽고 경로와 지문을 남겼다 ----
{
  const real = crypto.createHash('sha256').update(fs.readFileSync(path.join(HERE, '..', 'MANUAL.md'))).digest('hex');
  check('S1', '매뉴얼 경로와 sha256 이 기록되고 실제 파일과 같다',
    !!meta.manual?.path && meta.manual.sha256 === real,
    `기록 ${meta.manual?.sha256?.slice(0, 16)} · 실제 ${real.slice(0, 16)} · ${meta.manual?.path}`);
}

// ---- S2. 운영 호출이 모두 MCP 를 지났다 ----
{
  const used = new Set(calls.map((c) => c.tool));
  const need = ['crawl_new', 'discover', 'lease', 'fetch', 'report', 'status', 'cycle_report'];
  const miss = need.filter((n) => !used.has(n));
  check('S2', '운영 호출 7종이 모두 mcp-log 에 있다', miss.length === 0,
    miss.length ? `빠짐: ${miss.join(', ')}` : need.map((n) => `${n} ${calls.filter((c) => c.tool === n).length}회`).join(' · '));
}

// ---- S3. known_deferred 로 재운 것은 detail 뿐이다 ----
{
  // lease 응답에서 url_id → kind 를 복원한다
  const kindOf = new Map();
  for (const c of calls.filter((x) => x.tool === 'lease')) {
    const lines = c.text.split('\n');
    for (const l of lines) {
      const m = l.match(/^(\S+) (\S+) (\S+)$/);
      if (m && m[1] !== '빌려줄') kindOf.set(m[1], m[2]);
    }
  }
  const deferred = calls.filter((c) => c.tool === 'report' && c.args.items?.[0]?.state === 'known_deferred')
    .map((c) => c.args.items[0].url_id);
  const wrong = deferred.filter((id) => kindOf.get(id) !== 'detail');
  // 0건이면 계약을 시험한 것이 아니다 — 최소 한 건은 실제로 재웠어야 한다
  check('S3', 'known_deferred 는 kind=detail 만이고, 실제로 한 건 이상 재웠다',
    deferred.length > 0 && wrong.length === 0,
    wrong.length ? `detail 아닌데 재움: ${wrong.slice(0, 5).join(', ')} (종류 ${wrong.slice(0, 5).map((i) => kindOf.get(i)).join(',')})`
      : `재운 것 ${deferred.length}건 전부 detail · 임대에서 본 종류 ${[...new Set(kindOf.values())].join(', ')}`);
}

// ---- S4. unknown 은 실제로 열었다(재우지 않았다) ----
{
  const kindOf = new Map();
  for (const c of calls.filter((x) => x.tool === 'lease')) {
    for (const l of c.text.split('\n')) {
      const m = l.match(/^(\S+) (\S+) (\S+)$/);
      if (m && m[1] !== '빌려줄') kindOf.set(m[1], m[2]);
    }
  }
  const unknowns = [...kindOf.entries()].filter(([, k]) => k === 'unknown').map(([id]) => id);
  const fetched = new Set(calls.filter((c) => c.tool === 'fetch').map((c) => c.args.url_id));
  const queuedBack = new Set(calls.filter((c) => c.tool === 'report' && c.args.items?.[0]?.state === 'queued')
    .map((c) => c.args.items[0].url_id));
  const deferredIds = new Set(calls.filter((c) => c.tool === 'report' && c.args.items?.[0]?.state === 'known_deferred')
    .map((c) => c.args.items[0].url_id));
  // 기한·차단으로 되돌린 것은 열지 않아도 된다. 그 밖의 unknown 은 반드시 열려야 한다.
  const notOpened = unknowns.filter((id) => !fetched.has(id) && !queuedBack.has(id));
  const unknownDeferred = unknowns.filter((id) => deferredIds.has(id));
  // 전부 되돌려 놓고 통과하면 안 된다 — 최소 한 건은 응답까지 받아 셈이 올라가야 한다
  check('S4', 'unknown 은 재우지 않고 실제로 열었다(응답까지 받은 것 1건 이상)',
    unknowns.length > 0 && notOpened.length === 0 && unknownDeferred.length === 0 && meta.unknown_fetched > 0,
    `unknown ${unknowns.length}건 · fetch 호출한 것 ${unknowns.filter((i) => fetched.has(i)).length} · `
    + `응답까지 받은 것(meta) ${meta.unknown_fetched} · 되돌린 것 ${unknowns.filter((i) => queuedBack.has(i)).length} · `
    + `재운 것 ${unknownDeferred.length} · 안 연 것 ${notOpened.length}`);
}

// ---- S5. report 는 반영 1, 늦은 표 0 ----
{
  const reps = calls.filter((c) => c.tool === 'report');
  const bad = reps.filter((c) => !/반영 1 · 거절 0/.test(c.text));
  const stale = reps.filter((c) => /stale_lease_token/.test(c.text));
  check('S5', 'report 는 모두 반영 1 · 늦은 표 0건', reps.length > 0 && bad.length === 0 && stale.length === 0,
    `report ${reps.length}회 · 반영 1 아닌 것 ${bad.length} · stale ${stale.length}`
    + (bad.length ? `\n      예: ${bad[0].text.split('\n')[0]}` : ''));
}

// ---- S6. 남은 것은 queued/leased 이고 완료 판정은 paused_incomplete 다 ----
{
  // state.json 에 counts 가 없을 수 있으니 urls 에서 직접 센다 — 0 처럼 보이면 판정이 헛돈다
  const st = JSON.parse(fs.readFileSync(path.join(DIR, 'state.json'), 'utf8'));
  const byState = {};
  for (const r of Object.values(st.urls || {})) byState[r.state] = (byState[r.state] || 0) + 1;
  const q = byState.queued || 0;
  const ld = byState.leased || 0;
  const lastStatus = [...calls].reverse().find((c) => c.tool === 'status');
  const comp = lastStatus?.text.match(/완료판정: (\w+)/)?.[1];
  // 남은 일이 있으면 반드시 paused_incomplete. 다 끝났으면 complete 여도 된다.
  const consistent = (q + ld > 0) ? comp === 'paused_incomplete' : !!comp;
  check('S6', '남은 URL 은 queued/leased 이고 완료 판정이 그와 맞는다', consistent,
    `상태별 ${Object.entries(byState).map(([k, v]) => `${k} ${v}`).join(' · ')} · 완료판정 ${comp}\n      `
    + `기한 되돌림 ${meta.requeued_on_deadline} · 막혀서 되돌림 ${meta.requeued_on_blocker}`);
}

// ---- S8. 바깥 도메인은 장부에 남되 한 번도 건드리지 않았다 ----
// 링크를 경계까지 올리기 시작했으니, 로컬 스모크가 진짜 바깥으로 나가지 않았다는 것을
// "안 보였다" 가 아니라 "안 들였고 안 열었다" 로 보여야 한다.
{
  const st = JSON.parse(fs.readFileSync(path.join(DIR, 'state.json'), 'utf8'));
  const inQueue = Object.values(st.urls || {}).filter((u) => /(^|\.)x\.example$/.test(u.domain || ''));
  // 안 들인 기록의 url_id 로 manifest 를 본다. 큐에서 찾으면 0건일 때 검사가 공허해진다.
  const excluded = Object.entries(st.excluded || {})
    .filter(([, x]) => /(^|\.)x\.example$/.test(x.domain || ''))
    .map(([id, x]) => ({ id, ...x }));
  const allDenied = excluded.length > 0 && excluded.every((x) => x.why === 'denied_domain');
  const fetchCalls = calls.filter((c) => c.tool === 'fetch' && /x\.example/.test(JSON.stringify(c.args)));
  const mdir = path.join(DIR, 'manifests');
  const opened = excluded.filter((x) => fs.existsSync(path.join(mdir, x.id)));   // 폴더가 있으면 실제로 연 것

  check('S8', 'fixture 바닥글의 x.example 은 안 들이고 한 번도 열지 않았다(사유는 장부에 남는다)',
    inQueue.length === 0 && excluded.length > 0 && allDenied
    && fetchCalls.length === 0 && opened.length === 0,
    `큐에 든 것 ${inQueue.length} · 안 들인 기록 ${excluded.length}건(사유 ${[...new Set(excluded.map((x) => x.why))].join(',') || '없음'}, 전부 denied_domain=${allDenied}) · `
    + `fetch 호출 ${fetchCalls.length} · 그 url_id 의 manifest ${opened.length}개`);
}

// ---- S9. 링크 셈이 워커 장부와 MCP 응답에서 같다 ----
// 이 두 수가 없으면 "바깥 도메인 0건"과 "아직 안 봤다"를 나중에 가를 수 없다.
{
  let seen = 0, added = 0;
  for (const c of calls.filter((x) => x.tool === 'report')) {
    const m = c.text.match(/링크 본 것 (\d+) · 들인 것 (\d+)/);
    if (m) { seen += Number(m[1]); added += Number(m[2]); }
  }
  check('S9', '워커가 적은 링크 셈이 MCP report 응답 합계와 정확히 같다',
    meta.links_seen > 0 && meta.links_added > 0
    && meta.links_seen === seen && meta.links_added === added,
    `run-meta 본 것 ${meta.links_seen}·들인 것 ${meta.links_added} · `
    + `mcp-log 합계 본 것 ${seen}·들인 것 ${added}`);
}

// ---- S7. worker 가 실제로 0 으로 끝났다 ----
check('S7', 'worker 실제 종료 코드 0', WORKER_EXIT === 0 && meta.exit_code === 0,
  `셸이 받은 코드 ${WORKER_EXIT} · run-meta 기록 ${meta.exit_code}`);

console.log(`\n셈: 발견 ${meta.discovered_total} · listing ${meta.listing_fetched} · `
  + `detail 재움 ${meta.detail_known_deferred} · unknown 연 것 ${meta.unknown_fetched} · `
  + `기한 되돌림 ${meta.requeued_on_deadline} · 막혀서 되돌림 ${meta.requeued_on_blocker} · `
  + `반영 안 됨 ${meta.report_not_applied}`);
console.log(`PID: worker ${meta.worker_pid} · MCP ${meta.mcp_pid}`);

const passed = results.filter((r) => r.pass).length;
console.log(`\n스모크: ${passed}/${results.length} 통과`);
process.exit(passed === results.length ? 0 : 1);
