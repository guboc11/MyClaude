#!/usr/bin/env node
// collect 조정 계층 시험 — 태스크 #28.
//
//   node tests/collect-run/verify.mjs
//   node tests/collect-run/verify.mjs --json
//
// 완료 조건이 "숨은 collector 승격 없이 입력 mode 만 실행된다" 이므로,
// 시킨 것과 실제로 한 것을 서버 쪽 기록으로 견준다.
//
// 뒷부분은 **진짜 MCP 서버를 stdio 자식으로 띄워 버튼으로만** 부른다.
// 내부 함수를 직접 부르면 경계를 건너뛴 시험이 된다.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { verifyArtifacts } from '../../lib/artifacts.mjs';
import { getAttempt } from '../../lib/attempts.mjs';
import { createDb, openDb } from '../../lib/db.mjs';
import { FIXTURE_FLAG, parseFixtureAllow } from '../../lib/fixture-allow.mjs';
import { addUrls } from '../../lib/items.mjs';
import { nextBatch } from '../../lib/lease.mjs';
import { openPace, reservationsOf } from '../../lib/pace.mjs';
import { checkRequest, runCollect } from '../../lib/collect/index.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOL_ROOT = path.resolve(HERE, '..', '..');
const FIXTURE_SERVER = path.join(TOOL_ROOT, 'tests', 'fixtures', 'server.mjs');
const MCP_SERVER = path.join(TOOL_ROOT, 'server.mjs');
const AS_JSON = process.argv.includes('--json');

const results = [];
const ok = (id, pass, detail) => results.push({ id, pass: Boolean(pass), detail: String(detail) });
async function rejectsWith(code, fn) {
  try { await fn(); return { pass: false, detail: '던지지 않았다' }; } catch (e) {
    return { pass: e?.code === code, detail: `code=${e?.code}${e?.code === code ? '' : ` (기대 ${code})`}` };
  }
}

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'collect-run-'));
process.on('exit', () => { try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* 이미 없으면 그만 */ } });

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
const NOW = 1_700_000_000_000;
const FAST_PACE = { min_interval_ms: 1, jitter_ms: 0, retry_backoff_ms: 1 };

/** 맞은 쪽의 기록. 우리 자기 보고가 아니다. */
async function serverHits() {
  const { fetchSafely } = await import('../../lib/http.mjs');
  const r = await fetchSafely(`${BASE}/control/hits`, { fixtureAllow: ALLOW });
  return JSON.parse(r.body.toString('utf8'));
}
async function resetHits() {
  const { fetchSafely } = await import('../../lib/http.mjs');
  await fetchSafely(`${BASE}/control/reset`, { fixtureAllow: ALLOW });
}

let wsSeq = 0;
function freshWorkspace(urls) {
  const root = path.join(SANDBOX, `ws${++wsSeq}`);
  fs.mkdirSync(root, { recursive: true });
  const db = createDb(root, path.join(root, 'workspace.db'), {
    workspaceId: `2026-08-12-collect-run-${wsSeq}`, projectRoot: SANDBOX, briefPath: path.join(root, 'brief.md'), nowMs: NOW,
  });
  addUrls(db, urls.map((u, i) => ({ url: `${BASE}${u}`, line: i + 1 })), { source_kind: 'seed', source_value: 'manual', nowMs: NOW });
  const lease = nextBatch(db, root, { workerId: `w${wsSeq}`, count: urls.length, leaseMinutes: 60, nowMs: NOW });
  return { root, db, leaseId: lease.lease_id, pacePath: path.join(root, 'pace.db') };
}
const linesOf = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

try {
  // ══ A. 접속 전에 입력을 본다 ════════════════════════════════
  {
    const shot = await rejectsWith('output_not_in_mode', async () => checkRequest({ mode: 'http', outputs: ['text', 'screenshot'] }));
    const badMode = await rejectsWith('bad_mode', async () => checkRequest({ mode: 'chrome', outputs: ['text'] }));
    const badOut = await rejectsWith('bad_output', async () => checkRequest({ mode: 'http', outputs: ['cards'] }));
    const none = await rejectsWith('no_outputs', async () => checkRequest({ mode: 'http', outputs: [] }));
    ok('A1-input-checked-first', shot.pass && badMode.pass && badOut.pass && none.pass,
      `screenshot+http ${shot.detail} · 모르는 mode ${badMode.detail} · 모르는 산출물 ${badOut.detail} · 빈 목록 ${none.detail}`);

    ok('A2-duplicates-collapse',
      JSON.stringify(checkRequest({ mode: 'http', outputs: ['text', 'text', 'dom'] }).outputs) === '["text","dom"]',
      '같은 산출물을 두 번 적어도 파일은 한 번 만든다');

    const { root, db, pacePath } = freshWorkspace(['/static/normal']);
    await resetHits();
    const refused = await rejectsWith('output_not_in_mode', () => runCollect(db, {
      root, leaseId: 'L-nope', mode: 'http', outputs: ['screenshot'],
      pacePath, paceOpts: FAST_PACE, fetchOptions: { fixtureAllow: ALLOW }, nowMs: NOW,
    }));
    const h = await serverHits();
    ok('A3-no-network-on-bad-input',
      refused.pass && Object.keys(h).length === 0,
      `${refused.detail} · 서버가 받은 요청 ${Object.keys(h).length}건 — 임대 확인보다도 먼저 걸린다`);
    db.close();
  }

  // ══ B. 임대와 mode ══════════════════════════════════════════
  {
    const { root, db, pacePath } = freshWorkspace(['/static/normal']);
    await resetHits();

    const stale = await rejectsWith('stale_lease', () => runCollect(db, {
      root, leaseId: 'L-0000000000000000000000000000000000', mode: 'http', outputs: ['text'],
      pacePath, paceOpts: FAST_PACE, fetchOptions: { fixtureAllow: ALLOW }, nowMs: NOW,
    }));
    ok('B1-stale-lease-before-network', stale.pass && Object.keys(await serverHits()).length === 0,
      `${stale.detail} · 서버가 받은 요청 0건`);
    db.close();
  }

  {
    // [조건을 믿지 않고 만든다] playwright 를 못 찾는 상황을 재려면 찾는 길을 **전부** 막아야 한다.
    // resolvePlaywright 는 depsDir → CLAUDE_PROJECT_DIR → cwd → 도구 폴더 순으로 본다.
    // 예전에는 가짜 depsDir 하나만 주고 나머지를 그대로 뒀는데, 환경에 CLAUDE_PROJECT_DIR 가 있는
    // 자리에서는 playwright 가 발견되어 정작 재려던 실패가 안 일어났다 — 환경에 따라 통과했다
    // 깨졌다 하는 시험이었다(2026-08-12 게이트 3 독립 재검증에서 드러남).
    // 그래서 node_modules 가 없는 임시 폴더에서, 그 두 환경변수를 지우고 자식 프로세스로 돌린다.
    await resetHits();
    const cleanCwd = path.join(SANDBOX, 'no-node-modules');
    fs.mkdirSync(cleanCwd, { recursive: true });
    const env = { ...process.env };
    delete env.CLAUDE_PROJECT_DIR;
    delete env.WEBSEARCH_DEPS_DIR;
    const child = spawnSync(process.execPath, [path.join(HERE, 'no-deps-child.mjs'), BASE, cleanCwd], {
      cwd: cleanCwd, env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
    });
    let out = null;
    try { out = JSON.parse(child.stdout.slice(child.stdout.indexOf('{'))); } catch { /* 말없이 죽은 경우 */ }

    ok('B2-no-silent-downgrade',
      out !== null && out.playwright_reachable === null && out.has_project_env === false
      && out.failed === 1 && out.succeeded === 0
      && out.error?.stage === 'deps' && out.error?.code === 'playwright_not_found'
      && out.produced.length === 0 && out.artifact_files.length === 0 && out.artifact_rows === 0
      && out.has_manifest === true
      && Object.keys(await serverHits()).length === 0,
      out === null ? `자식이 결과를 못 냈다 (exit=${child.status}) ${String(child.stderr).slice(0, 200)}`
        : `playwright 가 정말 안 잡히는 자리에서(${out.playwright_reachable}) ${out.error?.stage}/${out.error?.code}`
          + ` · 산출물 ${out.artifact_files.length}개·장부 ${out.artifact_rows}줄 · 요약은 남음 ${out.has_manifest}`
          + ` · 서버가 받은 요청 0건 — browser 로 시켰는데 조용히 http 로 갈아타지 않는다`);

    ok('B3-collector-not-lied-about',
      out !== null && out.collector === 'browser',
      out === null ? '자식 결과 없음' : `실패해도 장부에는 시킨 대로 collector=${out.collector} 로 적혀 있다`);
  }

  // ══ C. 여러 항목 ════════════════════════════════════════════
  {
    const { root, db, leaseId, pacePath } = freshWorkspace(['/static/normal', '/static/plain', '/redirect/one']);
    await resetHits();
    const r = await runCollect(db, {
      root, leaseId, mode: 'http', outputs: ['text', 'links'],
      pacePath, paceOpts: FAST_PACE, fetchOptions: { fixtureAllow: ALLOW }, nowMs: NOW,
    });

    ok('C1-counts',
      r.succeeded === 3 && r.partial === 0 && r.failed === 0 && r.awaiting_report === 3,
      `성공 ${r.succeeded} · 부분 ${r.partial} · 실패 ${r.failed} · report 대기 ${r.awaiting_report}`);

    const states = db.prepare('SELECT work_state, COUNT(*) AS n FROM items GROUP BY work_state').all();
    ok('C2-success-stays-leased',
      states.length === 1 && states[0].work_state === 'leased' && states[0].n === 3,
      `성공한 항목은 report 전까지 ${states[0].work_state} 로 남는다 (${states[0].n}건)`);

    const idx = linesOf(root, r.index_path);
    ok('C3-index',
      idx.length === 3 && idx.every((l) => l.manifest && l.attempt_id && l.result === 'success')
      && idx.every((l) => fs.existsSync(path.join(root, l.manifest))),
      `색인 ${idx.length}줄 · 줄마다 실행 번호와 요약 경로가 있고 파일이 실재한다`);

    ok('C4-redirect-recorded',
      idx[2].requested_url.endsWith('/redirect/one') && idx[2].final_url.endsWith('/redirect/arrived')
      && idx[2].warnings.includes('redirected'),
      `요청 ${idx[2].requested_url.replace(BASE, '')} → 도착 ${idx[2].final_url.replace(BASE, '')}`);

    ok('C5-collector-recorded',
      idx.every((l) => getAttempt(db, l.attempt_id).collector === 'http'
        && JSON.stringify(getAttempt(db, l.attempt_id).requested_outputs) === '["text","links"]'),
      '장부에 collector=http 와 요청한 산출물이 그대로 적혀 있다');

    ok('C6-only-requested-outputs',
      idx.every((l) => Object.keys(l.outputs).sort().join() === 'links,text'),
      `항목마다 ${Object.keys(idx[0].outputs).sort().join('·')} 만 만들었다`);

    // 예약을 실제로 했는가 — 쪽 3개 = 요청 3번
    const pace = openPace({ dbPath: pacePath });
    const reserved = reservationsOf(pace, '127.0.0.1', 500);
    pace.close();
    const hits = await serverHits();
    const requests = Object.values(hits).reduce((n, v) => n + v, 0);
    ok('C7-reserved-before-every-request',
      reserved.length === requests && requests === 4,
      `서버가 받은 요청 ${requests}번(리다이렉트 한 홉 포함) · 예약 ${reserved.length}번 — 예약 없이 나간 요청 0`);

    const v = verifyArtifacts(db, root);
    ok('C8-ledger-clean',
      v.checked === v.ok && v.manifest_missing.length === 0 && v.orphans.length === 0 && v.incomplete.length === 0,
      `장부 ${v.checked}줄 전부 일치 · 요약 없는 실행 ${v.manifest_missing.length}`
      + ` · 고아 ${v.orphans.length}${v.orphans.length ? ` (${v.orphans.join(', ')})` : ''}`
      + ` · 만들다 만 것 ${v.incomplete.length}`);
    db.close();
  }

  // ══ D. 하나가 실패해도 나머지는 남는다 ══════════════════════
  {
    const { root, db, leaseId, pacePath } = freshWorkspace(['/static/normal', '/hang/headers', '/static/plain']);
    const r = await runCollect(db, {
      root, leaseId, mode: 'http', outputs: ['text'],
      pacePath, paceOpts: FAST_PACE,
      fetchOptions: { fixtureAllow: ALLOW, timeouts: { headers_timeout_ms: 400, connect_timeout_ms: 2000 } },
      nowMs: NOW,
    });
    const idx = linesOf(root, r.index_path);
    const rows = db.prepare('SELECT item_id, work_state, lease_id FROM items ORDER BY item_id').all();

    ok('D1-one-failure-does-not-stop-the-rest',
      r.succeeded === 2 && r.failed === 1 && idx[1].result === 'failed'
      && idx[0].result === 'success' && idx[2].result === 'success',
      `성공 ${r.succeeded} · 실패 ${r.failed} — 가운데가 실패해도 뒤 항목이 돈다`);

    ok('D2-failed-item-releases-lease',
      rows[1].work_state === 'failed' && rows[1].lease_id === null
      && rows[0].work_state === 'leased' && rows[2].work_state === 'leased',
      `실패한 항목만 ${rows[1].work_state} 로 가고 임대를 놓는다 · 나머지는 ${rows[0].work_state}`);

    ok('D3-failure-has-stage-and-code',
      idx[1].error.stage === 'response' && idx[1].error.code === 'headers_timeout' && idx[1].outputs.text === undefined,
      `${idx[1].error.stage}/${idx[1].error.code} · 만든 파일 없음`);

    ok('D4-earlier-work-preserved',
      fs.existsSync(path.join(root, idx[0].outputs.text)) && fs.existsSync(path.join(root, idx[0].manifest))
      && fs.existsSync(path.join(root, idx[1].manifest)),
      '앞서 끝난 항목의 파일과 요약이 그대로 있고, 실패한 항목도 요약은 남는다');

    ok('D5-awaiting-counts-only-leased',
      r.awaiting_report === 2, `report 대기 ${r.awaiting_report}건 — 실패한 항목은 빠진다`);
    db.close();
  }

  // ══ E. 부분 성공 ════════════════════════════════════════════
  {
    const { root, db, leaseId, pacePath } = freshWorkspace(['/images/rich']);
    const r = await runCollect(db, {
      root, leaseId, mode: 'http', outputs: ['text', 'images'],
      pacePath, paceOpts: FAST_PACE, fetchOptions: { fixtureAllow: ALLOW }, nowMs: NOW,
    });
    const idx = linesOf(root, r.index_path);
    ok('E1-partial',
      r.partial === 1 && r.succeeded === 0 && r.failed === 0
      && idx[0].warnings.includes('image_fetch_partial')
      && db.prepare('SELECT work_state FROM items WHERE item_id = 1').get().work_state === 'leased',
      `그림 셋을 못 받아 부분 ${r.partial} · 그래도 임대는 유지된다 (report 를 기다린다)`);
    ok('E2-warnings-counted',
      r.warnings.image_fetch_partial === 1 && typeof r.warnings === 'object',
      `경고를 종류별로 센다: ${JSON.stringify(r.warnings)}`);
    db.close();
  }

  // ══ F. 버튼으로 부른다 ══════════════════════════════════════
  {
    const projectDir = path.join(SANDBOX, 'proj');
    fs.mkdirSync(projectDir, { recursive: true });
    const mcp = spawn(process.execPath, [
      MCP_SERVER,
      `--allow-fixture-host=127.0.0.1:${PORT}`,
      `--pace-db=${path.join(projectDir, 'pace.db')}`,
      '--pace-min-interval-ms=1', '--pace-jitter-ms=0',
    ], { cwd: projectDir, env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir }, stdio: ['pipe', 'pipe', 'pipe'] });

    let buf = '';
    const waiting = new Map();
    mcp.stdout.on('data', (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id !== undefined && waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); }
        } catch { /* 사람이 읽을 줄은 무시 */ }
      }
    });
    let rpcId = 0;
    const call = (method, params) => new Promise((resolve, reject) => {
      const id = ++rpcId;
      const t = setTimeout(() => reject(new Error(`${method} 응답이 20초 안에 안 왔다`)), 20_000);
      waiting.set(id, (m) => { clearTimeout(t); resolve(m); });
      mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
    const tool = (name, args) => call('tools/call', { name, arguments: args });

    await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

    const listed = (await call('tools/list', {})).result.tools.map((t) => t.name).sort();
    ok('F1-collect-is-listed', listed.includes('collect'), `공개 버튼 ${listed.length}개: ${listed.join(', ')}`);

    const ws = (await tool('workspace_new', {
      topic: 'collect-button',
      brief: '버튼으로 부른 수집이 계약대로 도는지 본다',
    })).result.structuredContent;
    await tool('add_urls', {
      workspace: ws.workspace_id, source_kind: 'seed', source_value: 'manual',
      urls: [`${BASE}/static/normal`, `${BASE}/status/404`],
    });
    const leased = (await tool('next', { workspace: ws.workspace_id, worker_id: 'button-worker', count: 2 })).result.structuredContent;

    // 접속 전에 걸리는가 — 서버 기록으로 확인한다
    await resetHits();
    const badShot = await tool('collect', { workspace: ws.workspace_id, lease_id: leased.lease_id, mode: 'http', outputs: ['screenshot'] });
    ok('F2-screenshot-http-rejected-before-network',
      badShot.result.isError === true && Object.keys(await serverHits()).length === 0,
      `${String(badShot.result.content[0].text).slice(0, 80)} · 서버가 받은 요청 0건`);

    const got = await tool('collect', { workspace: ws.workspace_id, lease_id: leased.lease_id, mode: 'http', outputs: ['text', 'dom'] });
    const sc = got.result.structuredContent;
    ok('F3-contract-keys',
      JSON.stringify(Object.keys(sc).sort()) === '["awaiting_report","failed","index_path","partial","succeeded","warnings"]',
      `돌려준 칸 ${Object.keys(sc).sort().join('·')}`);
    ok('F4-collected-through-the-button',
      sc.succeeded === 2 && sc.partial === 0 && sc.failed === 0 && sc.awaiting_report === 2
      && sc.warnings.http_error_status === 1,
      `성공 ${sc.succeeded} · 부분 ${sc.partial} · 대기 ${sc.awaiting_report} · 경고 ${JSON.stringify(sc.warnings)}`);

    const wsRoot = path.join(projectDir, '.claude', 'websearch-workspace', ws.workspace_id);
    const idx = linesOf(wsRoot, sc.index_path);
    ok('F5-index-usable',
      idx.length === 2 && idx.every((l) => fs.existsSync(path.join(wsRoot, l.manifest))),
      `색인 ${idx.length}줄이 실재하는 요약을 가리킨다`);

    const asJson = JSON.stringify(got.result);
    ok('F6-response-is-short-and-has-no-content',
      Buffer.byteLength(asJson) < 1200 && !asJson.includes('디자인 12') && !asJson.includes('<html'),
      `응답 ${Buffer.byteLength(asJson)}바이트 · 원문 조각 없음`);

    // 404 는 부분이지 실패가 아니다 — 자료는 받았고 유효성은 에이전트 몫이다
    const errItem = idx.find((l) => l.requested_url.endsWith('/status/404'));
    ok('F7-http-error-is-not-collect-failure',
      errItem.result === 'success' && errItem.http_status === 404 && errItem.produced.length === 2
      && errItem.warnings.includes('http_error_status') && errItem.error === null,
      `404 인데 요청한 산출물 ${errItem.produced.length}개를 다 만들었으니 판정은 ${errItem.result} 이고`
      + ` 상태는 관찰(${errItem.warnings.join('·')})로만 남는다 — 기계 작업이 끝난 것과 자료가 쓸 만한 것은 다른 물음이다`);

    // 속도 정책은 버튼 입력으로 못 바꾼다
    const sneaky = await tool('collect', {
      workspace: ws.workspace_id, lease_id: leased.lease_id, mode: 'http', outputs: ['text'], pace_min_interval_ms: 0,
    });
    ok('F8-policy-not-settable-by-input',
      sneaky.result.isError === true && String(sneaky.result.content[0].text).includes('모르는 인자'),
      `${String(sneaky.result.content[0].text).slice(0, 70)}`);

    mcp.kill('SIGTERM');
    await new Promise((r) => { mcp.on('exit', r); setTimeout(r, 1500); });
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
