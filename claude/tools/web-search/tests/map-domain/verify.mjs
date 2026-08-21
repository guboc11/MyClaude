#!/usr/bin/env node
// map_domain 시험 — 태스크 #34.
//
//   node tests/map-domain/verify.mjs
//   node tests/map-domain/verify.mjs --json
//
// 완료 조건이 "map 결과와 items/sources/지도 파일 수가 일치하고 새 item 은 queued 에만 있다" 이므로,
// 응답의 수 · 장부의 수 · 지도 파일의 수 셋을 서로 견준다.
//
// 뒷부분은 **진짜 MCP 서버를 stdio 자식으로 띄워 버튼으로만** 부른다.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { verifyArtifacts } from '../../lib/artifacts.mjs';
import { getAttempt } from '../../lib/attempts.mjs';
import { createDb, openDb } from '../../lib/db.mjs';
import { FIXTURE_FLAG, parseFixtureAllow } from '../../lib/fixture-allow.mjs';
import { fetchSafely } from '../../lib/http.mjs';
import { addUrls } from '../../lib/items.mjs';
import { nextBatch } from '../../lib/lease.mjs';
import { runCollect } from '../../lib/collect/index.mjs';
import { internalUrlsFromManifests, resolveTarget, runMap } from '../../lib/map/index.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOL_ROOT = path.resolve(HERE, '..', '..');
const FIXTURE_SERVER = path.join(TOOL_ROOT, 'tests', 'fixtures', 'server.mjs');
const MCP_SERVER = path.join(TOOL_ROOT, 'server.mjs');
const CONTRACT = JSON.parse(fs.readFileSync(path.join(TOOL_ROOT, 'tests', 'fixtures', 'manifest.json'), 'utf8')).sitemaps;
const AS_JSON = process.argv.includes('--json');

const results = [];
const ok = (id, pass, detail) => results.push({ id, pass: Boolean(pass), detail: String(detail) });
async function rejectsWith(code, fn) {
  try { await fn(); return { pass: false, detail: '던지지 않았다' }; } catch (e) {
    return { pass: e?.code === code, detail: `code=${e?.code}${e?.code === code ? '' : ` (기대 ${code})`}` };
  }
}

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'map-domain-'));
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
const FAST = { min_interval_ms: 1, jitter_ms: 0, retry_backoff_ms: 1 };

const plainFetch = (u, o = {}) => fetchSafely(u, { fixtureAllow: ALLOW, ...o });

let wsSeq = 0;
function freshWorkspace() {
  const root = path.join(SANDBOX, `ws${++wsSeq}`);
  fs.mkdirSync(root, { recursive: true });
  const db = createDb(root, path.join(root, 'workspace.db'), {
    workspaceId: `2026-08-12-map-${wsSeq}`, projectRoot: SANDBOX, briefPath: path.join(root, 'brief.md'), nowMs: NOW,
  });
  return { root, db };
}

try {
  // ══ A. 어디를 그릴 것인가 ═══════════════════════════════════
  {
    const byDomain = resolveTarget({ domain: '127.0.0.1' });
    const byUrl = resolveTarget({ url: `${BASE}/static/normal` });
    ok('A1-target',
      byDomain.origin === 'https://127.0.0.1' && byDomain.from === 'domain'
      && byUrl.origin === BASE && byUrl.entry_url === `${BASE}/static/normal` && byUrl.from === 'url',
      `domain → ${byDomain.origin} · url → ${byUrl.entry_url.replace(BASE, '')}`);

    const neither = await rejectsWith('need_domain_or_url', async () => resolveTarget({}));
    ok('A2-need-one', neither.pass, neither.detail);
  }

  // ══ B. 네 출처를 합친다 ═════════════════════════════════════
  let mapped = null;
  let mapRoot = null;
  let mapDb = null;
  {
    const { root, db } = freshWorkspace();
    mapRoot = root; mapDb = db;

    // 앞서 수집해 둔 links.jsonl 을 하나 만들어 둔다 — 네 번째 출처가 실제로 쓰이는지 보려는 것.
    addUrls(db, [{ url: `${BASE}/static/normal`, line: 1 }], { source_kind: 'seed', source_value: 'manual', nowMs: NOW });
    const lease = nextBatch(db, root, { workerId: 'pre', count: 1, leaseMinutes: 60, nowMs: NOW });
    await runCollect(db, {
      root, leaseId: lease.lease_id, mode: 'http', outputs: ['links'],
      pacePath: path.join(root, 'pace.db'), paceOpts: FAST, fetchOptions: { fixtureAllow: ALLOW }, nowMs: NOW,
    });
    const before = db.prepare('SELECT COUNT(*) AS n FROM items').get().n;

    mapped = await runMap(db, {
      root, url: `${BASE}/static/normal`, fetchPage: plainFetch,
      fetchOptions: { fixtureAllow: ALLOW }, nowMs: NOW,
    });
    const doc = JSON.parse(fs.readFileSync(path.join(root, mapped.map_path), 'utf8'));

    const kinds = doc.counts.by_source_kind;
    ok('B1-four-sources',
      doc.sources.some((s) => s.kind === 'robots' && s.state === 'read')
      && doc.sources.some((s) => s.kind === 'sitemap_declared')
      && doc.sources.some((s) => s.kind === 'entry_page' && s.state === 'read')
      && doc.sources.some((s) => s.kind === 'prior_link_manifests' && s.files === 1),
      `출처 ${doc.sources.length}곳 — robots·선언 sitemap·대표 페이지·앞서 모은 links 넷을 모두 봤다`);

    ok('B2-source-kind-preserved',
      kinds.robots === CONTRACT.expected.from_robots.distinct_urls
      && kinds.internal_link > 0 && !('sitemap' in kinds),
      `출처별 — robots ${kinds.robots} · internal_link ${kinds.internal_link}`
      + ` (robots 가 sitemap 을 선언했으므로 관례 자리는 안 찍었고, 그래서 source_kind=sitemap 은 없다)`);

    ok('B3-discovered-equals-map-rows',
      mapped.discovered === doc.urls.length && doc.counts.discovered === mapped.discovered,
      `응답 ${mapped.discovered} · 지도 파일 ${doc.urls.length}줄`);

    const after = db.prepare('SELECT COUNT(*) AS n FROM items').get().n;
    ok('B4-items-match',
      after - before === mapped.new_urls && mapped.new_urls > 0,
      `장부 item 이 ${before} → ${after} 로 ${after - before}개 늘었고 응답의 새 URL 도 ${mapped.new_urls}`);

    const srcRows = db.prepare('SELECT source_kind, COUNT(*) AS n FROM sources GROUP BY source_kind ORDER BY source_kind').all();
    ok('B5-sources-table-records-origin',
      srcRows.some((r) => r.source_kind === 'robots') && srcRows.some((r) => r.source_kind === 'internal_link')
      && srcRows.some((r) => r.source_kind === 'seed'),
      `sources 표: ${srcRows.map((r) => `${r.source_kind} ${r.n}`).join(' · ')}`);
  }

  // ══ C. 자동으로 따라가지 않는다 ═════════════════════════════
  {
    const states = mapDb.prepare('SELECT work_state, COUNT(*) AS n FROM items GROUP BY work_state ORDER BY work_state').all();
    const collected = mapDb.prepare('SELECT COUNT(*) AS n FROM items WHERE collected_at IS NOT NULL').get().n;
    const attempts = mapDb.prepare("SELECT operation, COUNT(*) AS n FROM attempts GROUP BY operation ORDER BY operation").all();
    ok('C1-new-items-are-queued-only',
      states.find((s) => s.work_state === 'queued').n === mapDb.prepare('SELECT COUNT(*) AS n FROM items').get().n - 1
      && collected === 1,
      `상태 ${states.map((s) => `${s.work_state} ${s.n}`).join(' · ')} — 미리 수집한 한 건 말고는 모두 queued`);

    ok('C2-no-auto-collect',
      attempts.find((a) => a.operation === 'collect').n === 1
      && attempts.find((a) => a.operation === 'map').n === 1,
      `실행 기록 ${attempts.map((a) => `${a.operation} ${a.n}`).join(' · ')} — 지도가 collect 를 부르지 않았다`);
  }

  // ══ D. 확인한 곳과 못 본 곳 ═════════════════════════════════
  {
    const doc = JSON.parse(fs.readFileSync(path.join(mapRoot, mapped.map_path), 'utf8'));
    ok('D1-unchecked-recorded',
      mapped.needs_review.length >= 1
      && mapped.needs_review.some((s) => s.includes('대표 페이지 한 장만')),
      `미확인 범위 ${mapped.needs_review.length}줄 — "${mapped.needs_review.find((s) => s.includes('한 장만'))?.slice(0, 50)}…"`);

    ok('D2-limits-recorded',
      typeof doc.limits.max_files === 'number' && Array.isArray(doc.limits.hit),
      `상한이 지도에 적혀 있다 — 파일 ${doc.limits.max_files} · URL ${doc.limits.max_urls} · 닿은 것 ${doc.limits.hit.length}개`);

    ok('D3-map-is-an-artifact',
      mapped.map_path.startsWith(`artifacts/maps/${mapped.attempt_id}/`)
      && getAttempt(mapDb, mapped.attempt_id).operation === 'map'
      && mapDb.prepare("SELECT COUNT(*) AS n FROM artifacts WHERE kind = 'map'").get().n === 1,
      `${mapped.map_path} · 실행 종류 map · 장부에 map artifact 1개`);

    const v = verifyArtifacts(mapDb, mapRoot);
    ok('D4-ledger-clean',
      v.checked === v.ok && v.orphans.length === 0 && v.manifest_missing.length === 0 && v.incomplete.length === 0,
      `장부 ${v.checked}줄 전부 파일과 일치 · 요약 없는 실행 ${v.manifest_missing.length}`);
    mapDb.close();
  }

  // ══ E. 못 읽은 출처를 0으로 꾸미지 않는다 ═══════════════════
  {
    const { root, db } = freshWorkspace();
    // 대표 페이지가 없는 자리를 준다. sitemap 은 살아 있으니 지도는 절반만 그려진다.
    const r = await runMap(db, {
      root, url: `${BASE}/no-such-entry-page`, fetchPage: plainFetch,
      fetchOptions: { fixtureAllow: ALLOW }, nowMs: NOW,
    });
    const entry = r.sources.find((s) => s.kind === 'entry_page');
    ok('E1-failed-source-is-visible',
      entry.state === 'failed' && entry.status === 404
      && r.needs_review.some((s) => s.includes('대표 페이지를 못 읽었습니다'))
      && r.discovered > 0,
      `대표 페이지 ${entry.status} → ${entry.state} · 그래도 sitemap 에서 ${r.discovered}개는 찾았다`);

    ok('E2-attempt-marked-partial',
      getAttempt(db, r.attempt_id).result === 'partial',
      `실행 판정 ${getAttempt(db, r.attempt_id).result} — 절반만 본 것을 성공이라 하지 않는다`);
    db.close();
  }

  // ══ F. 상한 ═════════════════════════════════════════════════
  {
    const { root, db } = freshWorkspace();
    const r = await runMap(db, {
      root, url: `${BASE}/static/normal`, fetchPage: plainFetch,
      fetchOptions: { fixtureAllow: ALLOW }, limits: { max_urls: 2 }, nowMs: NOW,
    });
    ok('F1-limit-hit-is-recorded',
      r.limits.hit.includes('max_urls') && r.discovered <= 40
      && r.needs_review.length >= 1,
      `URL 상한 2 에 닿아 발견 ${r.discovered}개에서 멈추고 상한 도달 ${r.limits.hit.join('·')} 로 남긴다`);
    db.close();
  }

  // ══ G. 나가면 안 되는 곳 ════════════════════════════════════
  {
    const { root, db } = freshWorkspace();
    const priv = await rejectsWith('ip_private', () => runMap(db, {
      root, domain: '10.0.0.5', fetchPage: plainFetch, fetchOptions: { fixtureAllow: ALLOW }, nowMs: NOW,
    }));
    const noDoor = await rejectsWith('ip_loopback', () => runMap(db, {
      root, url: `${BASE}/`, fetchPage: (u) => fetchSafely(u, {}), fetchOptions: {}, nowMs: NOW,
    }));
    ok('G1-policy-first',
      priv.pass && noDoor.pass
      && db.prepare('SELECT COUNT(*) AS n FROM attempts').get().n === 0,
      `사설 ${priv.detail} · 허용 목록 없음 ${noDoor.detail} · 실행 기록 0건 — 실행을 열기도 전에 걸린다`);
    db.close();
  }

  // ══ H. 앞서 모은 links 만 따로 ══════════════════════════════
  {
    const { root, db } = freshWorkspace();
    const empty = internalUrlsFromManifests(db, root, '127.0.0.1');
    ok('H1-no-manifests-yet',
      empty.urls.length === 0 && empty.files === 0 && empty.capped === false,
      `앞서 모은 것이 없으면 0개 — 네트워크를 쓰지 않는다`);
    db.close();
  }

  // ══ I. 버튼으로 ═════════════════════════════════════════════
  {
    const projectDir = path.join(SANDBOX, 'proj');
    fs.mkdirSync(projectDir, { recursive: true });
    spawnSync('git', ['init', '-q'], { cwd: projectDir });
    const mcp = spawn(process.execPath, [
      MCP_SERVER, `--allow-fixture-host=127.0.0.1:${PORT}`,
      `--pace-db=${path.join(projectDir, 'pace.db')}`,
      '--pace-min-interval-ms=1', '--pace-jitter-ms=0', '--pace-retry-backoff-ms=1',
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
      const t = setTimeout(() => reject(new Error(`${method} 응답 없음`)), 60_000);
      waiting.set(id, (m) => { clearTimeout(t); resolve(m); });
      mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
    const tool = (name, args) => call('tools/call', { name, arguments: args });

    await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

    const listed = (await call('tools/list', {})).result.tools.map((t) => t.name).sort();
    ok('I1-listed', listed.includes('map_domain'), `공개 버튼 ${listed.length}개: ${listed.join(', ')}`);

    const ws = (await tool('workspace_new', { topic: 'map-button', brief: '지도 버튼 확인' })).result.structuredContent;
    const neither = await tool('map_domain', { workspace: ws.workspace_id });
    ok('I2-one-of-required',
      neither.result.isError === true && String(neither.result.content[0].text).includes('domain'),
      `${String(neither.result.content[0].text).slice(0, 60)}`);

    const got = await tool('map_domain', { workspace: ws.workspace_id, url: `${BASE}/static/normal` });
    if (!got.result.structuredContent) {
      process.stderr.write(`[디버그] ${JSON.stringify(got.result).slice(0, 500)}\n`);
    }
    const sc = got.result.structuredContent ?? {};
    ok('I3-contract-keys',
      JSON.stringify(Object.keys(sc).sort()) === '["discovered","limits","map_path","needs_review","new_urls","sources"]',
      `돌려준 칸 ${Object.keys(sc).sort().join('·')}`);

    const wsRoot = path.join(projectDir, '.claude', 'websearch-workspace', ws.workspace_id);
    const doc = JSON.parse(fs.readFileSync(path.join(wsRoot, sc.map_path), 'utf8'));
    const db2 = openDb(wsRoot, path.join(wsRoot, 'workspace.db'));
    const items = db2.prepare('SELECT COUNT(*) AS n FROM items').get().n;
    const queued = db2.prepare("SELECT COUNT(*) AS n FROM items WHERE work_state = 'queued'").get().n;

    ok('I4-three-numbers-agree',
      sc.discovered === doc.urls.length && sc.new_urls === items && items === queued,
      `응답 발견 ${sc.discovered} · 지도 파일 ${doc.urls.length}줄 · 장부 item ${items}개 · 그중 queued ${queued}개`);

    ok('I5-response-short-and-honest',
      Buffer.byteLength(JSON.stringify(got.result)) < 4096
      && String(got.result.content[0].text).includes('자동으로 방문하지 않았습니다'),
      `응답 ${Buffer.byteLength(JSON.stringify(got.result))}바이트 · "${String(got.result.content[0].text).slice(0, 70)}…"`);

    db2.close();
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
