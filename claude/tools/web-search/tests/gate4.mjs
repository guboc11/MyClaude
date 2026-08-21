#!/usr/bin/env node
// 게이트 4 — 도메인 지도 범위·비재귀.
//
//   node tests/gate4.mjs          전부 실행하고 판정 (exit 0 이면 통과)
//   node tests/gate4.mjs --json
//
// 재려는 것은 하나다: **지도가 누락을 숨기거나 몰래 따라다니지 않는가.**
//   - 못 본 것을 0건 완료로 바꾸지 않는가
//   - 발견한 곳을 자기가 방문하지 않는가
//
// 구성 시험은 자식 프로세스로 돌려 실제 종료 코드를 받고, 통합 확인은 임시 git 프로젝트에
// **진짜 MCP 서버를 stdio 자식으로 띄워 버튼으로만** 한다.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { verifyArtifacts } from '../lib/artifacts.mjs';
import { openDb } from '../lib/db.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOL_ROOT = path.resolve(HERE, '..');
const FIXTURE_SERVER = path.join(HERE, 'fixtures', 'server.mjs');
const MCP_SERVER = path.join(TOOL_ROOT, 'server.mjs');
const CONTRACT = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'manifest.json'), 'utf8')).sitemaps;
const AS_JSON = process.argv.includes('--json');

const results = [];
const add = (id, title, pass, detail) => results.push({ id, title, pass: Boolean(pass), detail: String(detail) });

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'gate4-'));
process.on('exit', () => { try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* 이미 없으면 그만 */ } });

const runSuite = (rel) => {
  const r = spawnSync(process.execPath, [path.join(TOOL_ROOT, rel), '--json'], {
    cwd: TOOL_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  let parsed = null;
  try { parsed = JSON.parse(r.stdout.slice(r.stdout.indexOf('{'))); } catch { /* 말없이 죽은 경우 */ }
  return { status: r.status, parsed, stderr: (r.stderr ?? '').slice(0, 300) };
};

function startFixture() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [FIXTURE_SERVER], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const t = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('fixture 가 안 떴다')); }, 5000);
    child.stdout.on('data', (d) => { out += d; if (out.includes('\n')) { clearTimeout(t); resolve({ child, base: out.split('\n')[0].trim() }); } });
    child.on('exit', (c) => { clearTimeout(t); reject(new Error(`fixture 가 먼저 끝났다 (${c})`)); });
  });
}

function startMcp(projectDir, args) {
  const child = spawn(process.execPath, [MCP_SERVER, ...args], {
    cwd: projectDir, env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buf = '';
  const waiting = new Map();
  child.stdout.on('data', (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try { const m = JSON.parse(line); if (waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } } catch { /* 무시 */ }
    }
  });
  let id = 0;
  const call = (method, params, ms = 120_000) => new Promise((resolve, reject) => {
    const n = ++id;
    const t = setTimeout(() => reject(new Error(`${method} 응답이 ${ms}ms 안에 안 왔다`)), ms);
    waiting.set(n, (m) => { clearTimeout(t); resolve(m); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: n, method, params })}\n`);
  });
  const ready = (async () => {
    await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'gate4', version: '1' } });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  })();
  return {
    child, ready, call,
    tool: (name, a, ms) => call('tools/call', { name, arguments: a }, ms),
    async stop() { child.kill('SIGTERM'); await new Promise((r) => { child.on('exit', r); setTimeout(r, 1500); }); },
  };
}

const { child: fixture, base: BASE } = await startFixture();
const PORT = Number(new URL(BASE).port);

const contacted = new Set();
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  contacted.add(new URL(typeof input === 'string' ? input : input.url).host);
  return realFetch(input, init);
};
const serverHits = async () => (await fetch(`${BASE}/control/hits`)).json();
const resetHits = () => fetch(`${BASE}/control/reset`);

try {
  // ══ G4-1 구성 시험 ═════════════════════════════════════════
  {
    const suites = ['tests/map-parser/verify.mjs', 'tests/map-domain/verify.mjs'];
    const ran = suites.map((s) => ({ s, ...runSuite(s) }));
    const bad = ran.filter((r) => r.status !== 0 || !r.parsed?.pass);
    const total = ran.reduce((n, r) => n + (r.parsed?.total ?? 0), 0);
    add('G4-1', '지도 구성 시험 2묶음', bad.length === 0,
      bad.length ? bad.map((b) => `${b.s} exit=${b.status} ${b.stderr}`).join(' / ') : `${suites.length}묶음 ${total}항목 전부 통과`);
  }

  // ══ 버튼으로 도는 통합 판 ═══════════════════════════════════
  const projectDir = path.join(SANDBOX, 'proj');
  fs.mkdirSync(projectDir, { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: projectDir });
  const mcp = startMcp(projectDir, [
    `--allow-fixture-host=127.0.0.1:${PORT}`,
    `--pace-db=${path.join(projectDir, 'pace.db')}`,
    '--pace-min-interval-ms=1', '--pace-jitter-ms=0', '--pace-retry-backoff-ms=1',
  ]);
  await mcp.ready;

  const ws = (await mcp.tool('workspace_new', { topic: 'gate4', brief: '게이트 4 — 지도 범위와 비재귀' })).result.structuredContent;
  const root = path.join(projectDir, '.claude', 'websearch-workspace', ws.workspace_id);
  const readMap = (p) => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));

  // 앞서 수집해 둔 links.jsonl 을 하나 만든다 — 네 번째 출처가 실제로 쓰이는지 보려는 것.
  await mcp.tool('add_urls', {
    workspace: ws.workspace_id, source_kind: 'seed', source_value: 'gate4', urls: [`${BASE}/links/mixed`],
  });
  const lease = (await mcp.tool('next', { workspace: ws.workspace_id, worker_id: 'g4', count: 1 })).result.structuredContent;
  await mcp.tool('collect', { workspace: ws.workspace_id, lease_id: lease.lease_id, mode: 'http', outputs: ['links'] });

  await resetHits();
  const mapped = (await mcp.tool('map_domain', { workspace: ws.workspace_id, url: `${BASE}/static/normal` })).result.structuredContent;
  const doc = readMap(mapped.map_path);
  const urlSet = new Set(doc.urls.map((u) => u.url));

  // ══ G4-2 선언 URL 을 예상 수대로 발견 ══════════════════════
  {
    const want = CONTRACT.expected.from_robots;
    const fromRobots = doc.urls.filter((u) => u.source_kind === 'robots');
    const fromLinks = doc.urls.filter((u) => u.source_kind === 'internal_link');
    const sources = Object.fromEntries(doc.sources.map((s) => [s.kind, (doc.sources.filter((x) => x.kind === s.kind).length)]));
    add('G4-2', 'robots·sitemap·대표 페이지·기존 link_manifest 를 예상 수대로 발견',
      fromRobots.length === want.distinct_urls
      && doc.sources.some((s) => s.kind === 'robots' && s.state === 'read')
      && doc.sources.some((s) => s.kind === 'entry_page' && s.state === 'read')
      && doc.sources.some((s) => s.kind === 'prior_link_manifests' && s.files === 1)
      && fromLinks.length > 0 && doc.counts.discovered === doc.urls.length,
      `robots 선언 sitemap ${fromRobots.length}개(계약 ${want.distinct_urls}) · 내부 링크 ${fromLinks.length}개`
      + ` · 출처 ${Object.keys(sources).join('·')} · 발견 ${doc.counts.discovered} = 지도 ${doc.urls.length}줄`);
  }

  // ══ G4-3 정규화 대조 ═══════════════════════════════════════
  {
    const n = CONTRACT.expected.from_robots.normalization;
    const hasFragment = doc.urls.filter((u) => u.url.includes('#'));
    const hasTracking = doc.urls.filter((u) => /[?&]utm_/.test(u.url));
    add('G4-3', '상대 URL·fragment·추적 파라미터 정규화',
      urlSet.has(`${BASE}${n.relative}`)
      && urlSet.has(`${BASE}${n.fragment_dropped}`) && hasFragment.length === 0
      && urlSet.has(`${BASE}${n.tracking_collapsed}`) && hasTracking.length === 0,
      `상대 → ${n.relative} · 자리표를 뗀 ${n.fragment_dropped}(지도에 # 든 줄 ${hasFragment.length}개)`
      + ` · 추적 파라미터 짝이 ${n.tracking_collapsed} 하나로(utm 든 줄 ${hasTracking.length}개)`);
  }

  // ══ G4-4 발견은 queued, 수집은 0 ═══════════════════════════
  {
    const db = openDb(root, path.join(root, 'workspace.db'));
    const states = Object.fromEntries(db.prepare('SELECT work_state, COUNT(*) AS n FROM items GROUP BY work_state').all().map((r) => [r.work_state, r.n]));
    const ops = Object.fromEntries(db.prepare('SELECT operation, COUNT(*) AS n FROM attempts GROUP BY operation').all().map((r) => [r.operation, r.n]));
    const pageArtifacts = db.prepare(`
      SELECT COUNT(*) AS n FROM artifacts a JOIN attempts t ON t.attempt_id = a.attempt_id
       WHERE t.operation = 'collect'`).get().n;
    const items = db.prepare('SELECT COUNT(*) AS n FROM items').get().n;

    // 미리 수집한 한 건(links/mixed)만 leased 이고, 지도가 찾은 것은 전부 queued 여야 한다.
    add('G4-4', '발견 URL 은 queued · 지도가 만든 collect 실행 0',
      ops.map === 1 && ops.collect === 1 && pageArtifacts === 1
      && states.queued === items - 1 && (states.done ?? 0) === 0,
      `item ${items}개 — queued ${states.queued} · leased ${states.leased ?? 0}`
      + ` · 실행 map ${ops.map} · collect ${ops.collect}(지도 전에 우리가 부른 그 한 번)`
      + ` · collect 산출물 ${pageArtifacts}개 — 지도가 새로 만든 것 0`);

    const v = verifyArtifacts(db, root);
    add('G4-9', '지도 뒤에도 장부와 파일이 일치', v.checked === v.ok && v.orphans.length === 0
      && v.manifest_missing.length === 0 && v.incomplete.length === 0,
      `장부 ${v.checked}줄 · 고아 ${v.orphans.length} · 요약 없는 실행 ${v.manifest_missing.length}`);
    db.close();
  }

  // ══ G4-5 확인 범위와 미확인 범위가 나뉜다 ══════════════════
  {
    const read = doc.sources.filter((s) => s.state === 'read');
    const notRead = doc.sources.filter((s) => s.state !== 'read');
    add('G4-5', '지도에 확인 범위와 미확인 범위가 나뉘어 있음',
      Array.isArray(doc.unchecked) && doc.unchecked.length >= 1
      && doc.unchecked.some((u) => u.includes('대표 페이지 한 장만'))
      && read.length >= 3 && Array.isArray(doc.limits.hit),
      `확인한 출처 ${read.length}곳 · 그 밖 ${notRead.length}곳 · 미확인 범위 ${doc.unchecked.length}줄`
      + ` — "${doc.unchecked[0].slice(0, 44)}…"`);
  }

  // ══ G4-6 요청 수로 본 비재귀 ═══════════════════════════════
  {
    const hits = await serverHits();
    const site = Object.entries(hits).filter(([k]) => !k.startsWith('/control'));
    const discovered = doc.urls.map((u) => new URL(u.url).pathname);
    const visited = site.map(([k]) => k);
    // 지도가 두드린 곳은 robots·sitemap·대표 페이지뿐이어야 한다. 찾은 쪽을 가 보면 안 된다.
    const wandered = visited.filter((v) => discovered.includes(v) && v !== '/static/normal');
    add('G4-6', '찾은 쪽을 지도가 스스로 방문하지 않음',
      wandered.length === 0 && visited.includes('/robots.txt') && visited.includes('/sitemaps/from-robots.xml'),
      `서버가 받은 요청 ${site.length}곳 (${visited.join(' ')}) · 발견 ${discovered.length}곳 중 방문한 것 ${wandered.length}곳`);
  }

  // ══ G4-7 순환·중복·상한 ════════════════════════════════════
  {
    await resetHits();
    const capped = (await mcp.tool('map_domain', { workspace: ws.workspace_id, domain: `127.0.0.1:${PORT}` })).result;
    const cappedDoc = readMap(capped.structuredContent.map_path);
    const hits2 = await serverHits();
    const repeated = Object.entries(hits2).filter(([k, v]) => !k.startsWith('/control') && v > 1);
    add('G4-7', '순환·중복에서 같은 파일을 두 번 열지 않음',
      repeated.length === 0 && cappedDoc.counts.discovered > 0,
      `두 번째 지도에서 같은 경로를 두 번 이상 받은 곳 ${repeated.length}개`
      + ` · 발견 ${cappedDoc.counts.discovered} · 새 URL ${capped.structuredContent.new_urls}(이미 있는 것은 안 는다)`);
  }

  // ══ G4-8 sitemap 오류를 0건 완료로 꾸미지 않음 ═════════════
  {
    const db = openDb(root, path.join(root, 'workspace.db'));
    const mapAttempts = db.prepare("SELECT attempt_id, result, error_code FROM attempts WHERE operation = 'map' ORDER BY started_at").all();
    db.close();

    // robots 가 못 읽는 sitemap 도 하나 선언해 두었다. 그것이 지도에 오류로 남아야 하고,
    // 그 때문에 실행 판정이 success 가 아니어야 하며, 그래도 읽은 것은 그대로 세어져야 한다.
    const broken = doc.sources.find((s) => String(s.url ?? '').endsWith('/broken.xml') && s.kind !== 'sitemap_error');
    const brokenError = doc.sources.find((s) => s.kind === 'sitemap_error' && String(s.url ?? '').endsWith('/broken.xml'));
    const first = mapAttempts[0];
    add('G4-8', 'sitemap 오류가 0건 완료로 둔갑하지 않음',
      broken !== undefined && broken.state === 'unreadable'
      && brokenError !== undefined && brokenError.error === 'unreadable'
      && first.result === 'partial'
      && doc.counts.discovered === CONTRACT.expected.from_robots.distinct_urls + doc.counts.by_source_kind.internal_link
      && doc.unchecked.some((u) => u.includes('sitemap 을 다 못 읽었습니다')),
      `못 읽은 sitemap 이 ${broken?.state} 로 남고 오류 줄(${brokenError?.error})이 따로 있다`
      + ` · 실행 판정 ${first.result}(success 가 아니다) · 그래도 읽은 것은 ${doc.counts.discovered}개로 그대로 센다`
      + ` · 미확인 범위에 "${doc.unchecked.find((u) => u.includes('다 못 읽었습니다'))?.slice(0, 36)}…"`);
  }

  await mcp.stop();

  // ══ G4-10 LEGACY 불변 · 금지 import 0 ══════════════════════
  {
    const audit = runSuite('tests/baseline/verify-reuse-audit.mjs');
    const PROJECT = process.env.CLAUDE_PROJECT_DIR || path.resolve(TOOL_ROOT, '..', '..', '..', 'Github', 'WORK', 'GoraeUniverse', 'dibang');
    const baseline = spawnSync(process.execPath,
      [path.join(HERE, 'baseline', 'baseline.mjs'), '--verify', '--project', PROJECT],
      { cwd: TOOL_ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    add('G4-10', 'LEGACY 불변 · 금지 import 0', audit.status === 0 && baseline.status === 0,
      `재사용 감사 exit=${audit.status} · 기준선 대조 exit=${baseline.status}`);
  }

  // ══ G4-11 게이트가 밖으로 안 나갔다 ════════════════════════
  {
    const outside = [...contacted].filter((h) => !h.startsWith('127.0.0.1:'));
    add('G4-11', '게이트 자체가 127.0.0.1 밖으로 나가지 않음', outside.length === 0,
      `접촉한 곳 ${[...contacted].join(', ') || '없음'}`);
  }
} finally {
  await new Promise((r) => { fixture.on('exit', r); fixture.kill('SIGTERM'); setTimeout(r, 1500); });
}

const failed = results.filter((r) => !r.pass);
if (AS_JSON) {
  process.stdout.write(`${JSON.stringify({ gate: 4, pass: failed.length === 0, total: results.length, failed: failed.length, results }, null, 2)}\n`);
} else {
  for (const r of results) process.stdout.write(`${r.pass ? 'PASS' : 'FAIL'}  ${r.id}  ${r.title}\n        ${r.detail}\n`);
  process.stdout.write(`\n${failed.length === 0 ? 'PASS' : 'FAIL'} — ${results.length - failed.length}/${results.length}\n`);
}
process.exit(failed.length === 0 ? 0 : 1);
