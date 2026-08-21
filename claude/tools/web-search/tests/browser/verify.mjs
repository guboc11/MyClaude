#!/usr/bin/env node
// mode=browser 수집 시험 — 태스크 #29.
//
// playwright 는 이 도구 폴더가 아니라 **부른 프로젝트**에 있다. 그래서 이 시험은
// playwright 가 깔린 프로젝트에서 돌리거나 그 자리를 알려 줘야 한다.
//
//   cd <playwright 가 있는 프로젝트> && node ~/.claude/tools/web-search/tests/browser/verify.mjs
//   WEBSEARCH_DEPS_DIR=<그 프로젝트> node tests/browser/verify.mjs
//
// 완료 조건이 "JS fixture 에서 HTTP 와 browser 결과 차이가 기대값대로 재현된다" 이므로
// 같은 쪽을 두 방식으로 받아 manifest 의 기대값과 나란히 견준다.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

import { artifactsOf, verifyArtifacts, writeManifest } from '../../lib/artifacts.mjs';
import { finishAttempt, startAttempt } from '../../lib/attempts.mjs';
import { createDb } from '../../lib/db.mjs';
import { FIXTURE_FLAG, parseFixtureAllow } from '../../lib/fixture-allow.mjs';
import { addUrls } from '../../lib/items.mjs';
import { nextBatch } from '../../lib/lease.mjs';
import {
  BROWSER_CAPABILITY, BROWSER_OUTPUTS, NO_PINNED_CONNECTION, collectBrowser, resolvePlaywright,
} from '../../lib/collect/browser.mjs';
import { collectHttp } from '../../lib/collect/http.mjs';
import { checkRequest, runCollect } from '../../lib/collect/index.mjs';
import { fetchSafely } from '../../lib/http.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOL_ROOT = path.resolve(HERE, '..', '..');
const FIXTURE_SERVER = path.join(TOOL_ROOT, 'tests', 'fixtures', 'server.mjs');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(TOOL_ROOT, 'tests', 'fixtures', 'manifest.json'), 'utf8'));
const AS_JSON = process.argv.includes('--json');

const results = [];
const ok = (id, pass, detail) => results.push({ id, pass: Boolean(pass), detail: String(detail) });
const routeOf = (p) => [...MANIFEST.routes, ...MANIFEST.supporting_routes].find((r) => r.path === p);
async function rejectsWith(code, fn) {
  try { await fn(); return { pass: false, detail: '던지지 않았다' }; } catch (e) {
    return { pass: e?.code === code, detail: `code=${e?.code}${e?.code === code ? '' : ` (기대 ${code})`}` };
  }
}

// ── playwright 자리부터 ───────────────────────────────────────
const DEPS_DIR = process.env.WEBSEARCH_DEPS_DIR ?? process.cwd();
let found = null;
try {
  found = resolvePlaywright({ depsDir: DEPS_DIR });
} catch (e) {
  process.stderr.write(`${e.message}\n\n`
    + 'playwright 가 있는 프로젝트에서 돌리거나 WEBSEARCH_DEPS_DIR 로 그 자리를 알려 주십시오.\n');
  process.exit(2);
}

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-'));
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

const root = path.join(SANDBOX, 'ws');
fs.mkdirSync(root, { recursive: true });
const db = createDb(root, path.join(root, 'workspace.db'), {
  workspaceId: '2026-08-12-browser', projectRoot: SANDBOX, briefPath: path.join(root, 'brief.md'), nowMs: NOW,
});
addUrls(db, [{ url: `${BASE}/js/rendered`, line: 1 }], { source_kind: 'seed', source_value: 'manual', nowMs: NOW });

let seq = 0;
const newAttempt = (collector) => startAttempt(db, {
  itemId: 1, operation: 'collect', collector,
  requestedOutputs: ['text'], requestedUrl: `${BASE}/x${++seq}`, nowMs: NOW,
}).attempt_id;

const fileOf = (rel) => fs.readFileSync(path.join(root, rel));
const grabBrowser = (p, outputs, extra = {}) => collectBrowser(db, {
  root, attemptId: newAttempt('browser'), url: `${BASE}${p}`, outputs,
  fixtureAllow: ALLOW, depsDir: DEPS_DIR, nowMs: NOW, ...extra,
});

try {
  ok('B0-playwright-found',
    found.package === 'playwright' || found.package === 'playwright-core',
    `${found.package} 를 ${found.from.replace(os.homedir(), '~')} 에서 찾았다`);

  // ══ A. 같은 쪽, 두 방식 ═════════════════════════════════════
  {
    const httpRun = await collectHttp(db, {
      root, attemptId: newAttempt('http'), url: `${BASE}/js/rendered`, outputs: ['text', 'links', 'dom'],
      fetchOptions: { fixtureAllow: ALLOW }, nowMs: NOW,
    });
    const browserRun = await grabBrowser('/js/rendered', ['text', 'links', 'dom', 'screenshot']);

    const httpText = fileOf(httpRun.outputs.text.path).toString('utf8');
    const browserText = fileOf(browserRun.outputs.text.path).toString('utf8');
    const want = routeOf('/js/rendered');

    ok('A1-http-sees-nothing',
      httpRun.outputs.links.total === want.expect.links && !httpText.includes('총 12개'),
      `HTTP 로는 링크 ${httpRun.outputs.links.total}개 · 카드 글자 없음 (manifest 기대 ${want.expect.links})`);

    ok('A2-browser-sees-the-cards',
      browserRun.ok && browserRun.outputs.links.total === want.browser.links
      && browserText.includes(want.browser.text_contains[0]) && browserText.includes('디자인 12'),
      `브라우저로는 링크 ${browserRun.outputs.links.total}개 (manifest 기대 ${want.browser.links})`
      + ` · "${want.browser.text_contains[0]}" 보임`);

    ok('A3-difference-is-the-point',
      browserRun.outputs.links.total - httpRun.outputs.links.total === 24
      && browserText.length > httpText.length,
      `두 방식의 차이가 카드 12장 × 링크 2개 = ${browserRun.outputs.links.total - httpRun.outputs.links.total}개로 재현된다`);

    const domHtml = zlib.gunzipSync(fileOf(browserRun.outputs.dom.path)).toString('utf8');
    ok('A4-dom-is-rendered',
      domHtml.includes('<article class="card"') && domHtml.includes('디자인 12'),
      '브라우저의 dom 은 렌더가 끝난 문서다 — script 가 만든 카드가 들어 있다');

    ok('A5-manifest-fields',
      browserRun.final_url === `${BASE}/js/rendered` && browserRun.status === 200
      && browserRun.title === '동적 목록' && Number.isFinite(browserRun.rendered_at),
      `최종 ${browserRun.final_url.replace(BASE, '')} · 상태 ${browserRun.status} · 제목 "${browserRun.title}" · 렌더 완료 시각 있음`);

    // ══ B. 보증 차이가 기록으로 남는다 ════════════════════════
    ok('B1-warning-always-present',
      browserRun.ok === true && browserRun.warnings.includes(NO_PINNED_CONNECTION),
      `성공했는데도 ${NO_PINNED_CONNECTION} 가 붙어 있다 (경고 ${browserRun.warnings.join('·')})`);

    ok('B2-http-has-no-such-warning',
      !httpRun.warnings.includes(NO_PINNED_CONNECTION),
      `http 결과의 경고: ${httpRun.warnings.length ? httpRun.warnings.join('·') : '없음'} — 두 모드가 기록으로 구분된다`);

    ok('B3-capability-line',
      browserRun.capability === BROWSER_CAPABILITY
      && browserRun.capability.includes('연결 대상 IP 고정은 없습니다')
      && browserRun.capability.includes('http 모드에는 있습니다'),
      `"${browserRun.capability.slice(0, 60)}…"`);
  }

  // ══ C. 모든 브라우저 attempt 에 경고가 있는가 (전수) ════════
  {
    const paths = ['/static/normal', '/error/soft-404', '/status/404', '/redirect/one'];
    const runs = [];
    for (const p of paths) {
      const attemptId = newAttempt('browser');
      const r = await collectBrowser(db, {
        root, attemptId, url: `${BASE}${p}`, outputs: ['text'],
        fixtureAllow: ALLOW, depsDir: DEPS_DIR, nowMs: NOW,
      });
      finishAttempt(db, {
        attemptId, result: r.ok ? 'success' : 'failed', finalUrl: r.final_url, httpStatus: r.status,
        warningCodes: r.warnings, errorStage: r.error_stage, errorCode: r.error_code,
        errorMessageShort: r.error_message_short, nowMs: NOW,
      });
      const mf = await writeManifest(db, root, attemptId, { nowMs: NOW });
      runs.push({ p, r, doc: JSON.parse(fileOf(mf.path).toString('utf8')) });
    }

    ok('C1-every-browser-manifest-carries-it',
      runs.every((x) => x.doc.warning_codes.includes(NO_PINNED_CONNECTION)),
      `브라우저 수집 ${runs.length}건 전부 manifest 에 ${NO_PINNED_CONNECTION} 가 있다`);

    ok('C2-collector-recorded-as-browser',
      runs.every((x) => x.doc.collector === 'browser'),
      '장부에 collector=browser 로 남는다');

    const err = runs.find((x) => x.p === '/status/404');
    ok('C3-status-not-a-verdict',
      err.r.ok === true && err.r.status === 404 && err.r.warnings.includes('http_error_status')
      && err.r.produced.join() === 'text',
      `404 여도 요청한 산출물을 만든다 (${err.r.produced.join('·')}) · 경고로만 남긴다`);

    const soft = runs.find((x) => x.p === '/error/soft-404');
    ok('C4-blocked-mark-is-observation-only',
      soft.r.ok === true && !('page_validity' in soft.r) && !('is_error_page' in soft.r),
      '오류 화면에도 판정 칸을 만들지 않는다');
  }

  // ══ D. 무한 스크롤이 끝난다 ═════════════════════════════════
  {
    const t0 = Date.now();
    const r = await grabBrowser('/infinite/scroll', ['text', 'links']);
    const took = Date.now() - t0;
    ok('D1-infinite-scroll-terminates',
      r.ok && took < 30_000 && r.warnings.includes('scroll_limit_reached') && r.scroll.capped !== false,
      `${took}ms 에 끝났다 · 상한 사유 ${r.scroll.capped} · ${r.warnings.includes('scroll_limit_reached') ? '조용히 멈추지 않고 남긴다' : '표시 없음'}`);
    ok('D2-partial-content-kept',
      r.outputs.links.total > 6,
      `내려간 만큼의 링크 ${r.outputs.links.total}개는 그대로 남는다`);
  }

  // ══ E. 위험한 곳은 브라우저에서도 막힌다 ════════════════════
  {
    const noDoor = await collectBrowser(db, {
      root, attemptId: newAttempt('browser'), url: `${BASE}/static/normal`, outputs: ['text'],
      fixtureAllow: [], depsDir: DEPS_DIR, nowMs: NOW,
    });
    ok('E1-first-target-checked-before-launch',
      !noDoor.ok && noDoor.error_stage === 'policy' && noDoor.error_code === 'ip_loopback'
      && noDoor.produced.length === 0,
      `${noDoor.error_stage}/${noDoor.error_code} — 브라우저를 띄우기도 전에 걸린다`);

    const priv = await collectBrowser(db, {
      root, attemptId: newAttempt('browser'), url: 'http://10.0.0.5/x', outputs: ['text'],
      fixtureAllow: ALLOW, depsDir: DEPS_DIR, nowMs: NOW,
    });
    ok('E2-private-blocked', !priv.ok && priv.error_code === 'ip_private', `${priv.error_stage}/${priv.error_code}`);

    // 쪽은 안전한데 그 안의 그림이 사설망을 가리키는 경우
    const mixed = await grabBrowser('/images/rich', ['text']);
    ok('E3-subresources-checked-too',
      mixed.ok && mixed.requests.allowed > 1,
      `하위 자원 ${mixed.requests.allowed}건이 하나하나 검사를 받고 나갔다 · 끊긴 것 ${mixed.requests.blocked}건`);
  }

  // ══ F. 입력과 산출물 ════════════════════════════════════════
  {
    // [시점에 매이지 않기] "images 는 아직 없다" 로 적으면 #30 이 붙이는 순간 깨진다.
    // 지켜야 할 성질은 "선언한 것만 만들고, 선언 안 한 것은 띄우기도 전에 거절한다" 이다.
    const notDeclared = ['cards', 'pdf', 'video'].filter((o) => !BROWSER_OUTPUTS.includes(o));
    const badOut = await rejectsWith('unsupported_output', () => grabBrowser('/static/normal', [notDeclared[0]]));
    const declaredWorks = await grabBrowser('/static/normal', BROWSER_OUTPUTS.filter((o) => o !== 'images'));
    ok('F1-only-declared-outputs',
      badOut.pass && declaredWorks.ok
      && BROWSER_OUTPUTS.filter((o) => o !== 'images').every((o) => declaredWorks.produced.includes(o)),
      `선언한 것(${BROWSER_OUTPUTS.join('·')}) 은 만들고, 선언 안 한 "${notDeclared[0]}" 는 ${badOut.detail}`
      + ' — 없는 것을 있는 척하지 않는다');

    const shotOnly = await grabBrowser('/static/normal', ['screenshot']);
    const dir = path.dirname(path.join(root, shotOnly.outputs.screenshot.path));
    ok('F2-only-requested',
      shotOnly.produced.join() === 'screenshot' && fs.readdirSync(dir).join() === 'screenshot.png',
      `screenshot 만 요청 → 폴더에 ${fs.readdirSync(dir).join('·')} 뿐`);

    const png = fileOf(shotOnly.outputs.screenshot.path);
    ok('F3-real-png',
      png[0] === 0x89 && png.toString('latin1', 1, 4) === 'PNG'
      && shotOnly.outputs.screenshot.viewport.width === 1280
      && shotOnly.outputs.screenshot.page_height > 0,
      `${png.length}바이트 PNG · 화면 ${shotOnly.outputs.screenshot.viewport.width}×${shotOnly.outputs.screenshot.viewport.height}`
      + ` · 쪽 높이 ${shotOnly.outputs.screenshot.page_height}px`);

    const tall = await grabBrowser('/long/page', ['screenshot']);
    ok('F4-screenshot-height-cap',
      tall.ok && tall.outputs.screenshot.page_height > tall.outputs.screenshot.captured_height
      && tall.warnings.includes('screenshot_truncated'),
      `쪽 높이 ${tall.outputs.screenshot.page_height}px 를 ${tall.outputs.screenshot.captured_height}px 에서 자르고 잘렸다고 남긴다`);

    ok('F5-mode-guard',
      JSON.stringify(checkRequest({ mode: 'browser', outputs: ['screenshot', 'text'] }).outputs) === '["screenshot","text"]',
      'browser 모드에서는 screenshot 이 통과한다');
  }

  // ══ G. 조정 계층에서 ════════════════════════════════════════
  {
    const wsRoot = path.join(SANDBOX, 'ws2');
    fs.mkdirSync(wsRoot, { recursive: true });
    const db2 = createDb(wsRoot, path.join(wsRoot, 'workspace.db'), {
      workspaceId: '2026-08-12-browser-run', projectRoot: SANDBOX, briefPath: path.join(wsRoot, 'brief.md'), nowMs: NOW,
    });
    addUrls(db2, [{ url: `${BASE}/js/rendered`, line: 1 }], { source_kind: 'seed', source_value: 'manual', nowMs: NOW });
    const lease = nextBatch(db2, wsRoot, { workerId: 'bw', count: 1, leaseMinutes: 60, nowMs: NOW });

    const r = await runCollect(db2, {
      root: wsRoot, leaseId: lease.lease_id, mode: 'browser', outputs: ['screenshot', 'text'],
      pacePath: path.join(wsRoot, 'pace.db'), paceOpts: { min_interval_ms: 1, jitter_ms: 0, retry_backoff_ms: 1 },
      fetchOptions: { fixtureAllow: ALLOW }, depsDir: DEPS_DIR, nowMs: NOW,
    });
    const idx = fs.readFileSync(path.join(wsRoot, r.index_path), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

    ok('G1-browser-through-the-coordinator',
      r.succeeded === 1 && idx[0].produced.sort().join() === 'screenshot,text'
      && idx[0].warnings.includes(NO_PINNED_CONNECTION),
      `조정 계층으로도 ${idx[0].produced.join('·')} 를 만들고 경고가 따라온다`);

    ok('G2-warning-counted-in-response',
      r.warnings[NO_PINNED_CONNECTION] === 1,
      `응답의 경고 셈에도 들어 있다: ${JSON.stringify(r.warnings)}`);

    const v = verifyArtifacts(db2, wsRoot);
    ok('G3-ledger-clean',
      v.checked === v.ok && v.orphans.length === 0 && v.incomplete.length === 0 && v.manifest_missing.length === 0,
      `장부 ${v.checked}줄 전부 파일과 일치`);
    db2.close();
  }

  // ══ I. 버튼과 도구 설명에도 한계가 적혀 있다 ═══════════════
  {
    const projectDir = path.join(SANDBOX, 'proj');
    fs.mkdirSync(projectDir, { recursive: true });
    const mcp = spawn(process.execPath, [
      path.join(TOOL_ROOT, 'server.mjs'),
      `--allow-fixture-host=127.0.0.1:${PORT}`,
      `--pace-db=${path.join(projectDir, 'pace.db')}`,
      '--pace-min-interval-ms=1', '--pace-jitter-ms=0',
      `--deps-dir=${DEPS_DIR}`,
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
        try { const m = JSON.parse(line); if (waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } } catch { /* 무시 */ }
      }
    });
    let rpcId = 0;
    const call = (method, params) => new Promise((resolve, reject) => {
      const id = ++rpcId;
      const t = setTimeout(() => reject(new Error(`${method} 응답이 60초 안에 안 왔다`)), 60_000);
      waiting.set(id, (m) => { clearTimeout(t); resolve(m); });
      mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
    const tool = (name, args) => call('tools/call', { name, arguments: args });

    await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

    const desc = (await call('tools/list', {})).result.tools.find((t) => t.name === 'collect').description;
    ok('I1-tool-description-says-the-difference',
      desc.includes('browser_no_pinned_connection') && desc.includes('연결 대상 IP 고정은 없')
      && desc.includes('mode=http'),
      `도구 설명이 두 모드의 보증 차이를 적는다: "…${desc.slice(desc.indexOf('mode=http'), desc.indexOf('mode=http') + 60)}…"`);

    const ws = (await tool('workspace_new', { topic: 'browser-button', brief: '브라우저 모드 한계 문구 확인' })).result.structuredContent;
    await tool('add_urls', { workspace: ws.workspace_id, source_kind: 'seed', source_value: 'manual', urls: [`${BASE}/js/rendered`] });
    const leased = (await tool('next', { workspace: ws.workspace_id, worker_id: 'bw', count: 1 })).result.structuredContent;
    const got = await tool('collect', { workspace: ws.workspace_id, lease_id: leased.lease_id, mode: 'browser', outputs: ['text', 'screenshot'] });
    const text = got.result.content[0].text;

    ok('I2-response-carries-the-limit',
      got.result.structuredContent.succeeded === 1
      && text.includes('연결 대상 IP 고정은 없습니다') && text.includes(NO_PINNED_CONNECTION),
      `버튼 응답: "${text.slice(0, 110)}…"`);

    const httpGot = await tool('collect', { workspace: ws.workspace_id, lease_id: leased.lease_id, mode: 'http', outputs: ['text'] });
    ok('I3-http-response-does-not',
      !String(httpGot.result.content[0].text ?? '').includes('연결 대상 IP 고정은 없습니다'),
      `http 응답에는 그 문구가 없다 — 두 모드가 응답에서도 구분된다`);

    mcp.kill('SIGTERM');
    await new Promise((r) => { mcp.on('exit', r); setTimeout(r, 1500); });
  }

  // ══ H. 못 찾으면 못 찾았다고 한다 ═══════════════════════════
  {
    const nowhere = path.join(SANDBOX, 'no-deps');
    fs.mkdirSync(nowhere, { recursive: true });
    let thrown = null;
    try { resolvePlaywright({ depsDir: nowhere, cwd: nowhere, projectDir: nowhere }); } catch (e) { thrown = e; }
    ok('H1-honest-when-missing',
      thrown?.code === 'playwright_not_found' && thrown.message.includes(nowhere),
      `${thrown?.code} · 어디를 찾아봤는지 메시지에 있다`);

    const v = verifyArtifacts(db, root);
    ok('H2-ledger-clean',
      v.checked === v.ok && v.sha_mismatch.length === 0 && v.orphans.length === 0 && v.incomplete.length === 0,
      `장부 ${v.checked}줄 · artifact ${artifactsOf(db, null).length ?? 0} · 어긋남 0`);
  }
} finally {
  await new Promise((r) => { fixture.on('exit', r); fixture.kill('SIGTERM'); setTimeout(r, 1500); });
  db.close();
}

const failed = results.filter((r) => !r.pass);
if (AS_JSON) {
  process.stdout.write(`${JSON.stringify({ pass: failed.length === 0, total: results.length, failed: failed.length, results }, null, 2)}\n`);
} else {
  for (const r of results) process.stdout.write(`${r.pass ? 'PASS' : 'FAIL'}  ${r.id}\n        ${r.detail}\n`);
  process.stdout.write(`\n${failed.length === 0 ? 'PASS' : 'FAIL'} — ${results.length - failed.length}/${results.length}\n`);
}
process.exit(failed.length === 0 ? 0 : 1);
