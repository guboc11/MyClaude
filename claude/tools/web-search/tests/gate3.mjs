#!/usr/bin/env node
// 게이트 3 — 산출물 다섯 종·교차 연결·중간 종료.
//
//   node tests/gate3.mjs          전부 실행하고 판정 (exit 0 이면 통과)
//   node tests/gate3.mjs --json
//
// 앞 게이트와 같은 규율이다.
//   - 단위·구성 시험은 **자식 프로세스로** 돌려 실제 종료 코드를 받는다.
//   - 통합 확인은 임시 git 프로젝트를 만들고 **진짜 MCP 서버를 stdio 자식으로 띄워 버튼으로만** 한다.
//   - 네트워크는 이 시험이 띄운 127.0.0.1 fixture 밖으로 나가지 않으며, 그 사실을 따로 판정한다.
//
// 브라우저 항목은 playwright 가 있어야 돈다. 없으면 **건너뛰지 않고 실패한다** —
// 게이트가 환경 때문에 조용히 헐거워지면 그 게이트는 없는 것과 같다.

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

import { POINTER_DIRS, verifyArtifacts } from '../lib/artifacts.mjs';
import { openDb } from '../lib/db.mjs';
import { WARNING_CODES } from '../lib/errors.mjs';
import { resolvePlaywright } from '../lib/collect/browser.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOL_ROOT = path.resolve(HERE, '..');
const FIXTURE_SERVER = path.join(HERE, 'fixtures', 'server.mjs');
const MCP_SERVER = path.join(TOOL_ROOT, 'server.mjs');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'manifest.json'), 'utf8'));
const AS_JSON = process.argv.includes('--json');

const results = [];
const add = (id, title, pass, detail) => results.push({ id, title, pass: Boolean(pass), detail: String(detail) });
const sha = (b) => createHash('sha256').update(b).digest('hex');

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'gate3-'));
process.on('exit', () => { try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* 이미 없으면 그만 */ } });

// ── 자식으로 돌리는 구성 시험 ─────────────────────────────────

const runSuite = (rel, opts = {}) => {
  const r = spawnSync(process.execPath, [path.join(TOOL_ROOT, rel), '--json'], {
    cwd: opts.cwd ?? TOOL_ROOT, env: { ...process.env, ...opts.env }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  let parsed = null;
  try { parsed = JSON.parse(r.stdout.slice(r.stdout.indexOf('{'))); } catch { /* 말없이 죽은 경우 */ }
  return { status: r.status, parsed, stderr: (r.stderr ?? '').slice(0, 300) };
};

// ── fixture 와 MCP 서버 ───────────────────────────────────────

function startFixture() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [FIXTURE_SERVER], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const t = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('fixture 가 안 떴다')); }, 5000);
    child.stdout.on('data', (d) => { out += d; if (out.includes('\n')) { clearTimeout(t); resolve({ child, base: out.split('\n')[0].trim() }); } });
    child.on('exit', (c) => { clearTimeout(t); reject(new Error(`fixture 가 먼저 끝났다 (${c})`)); });
  });
}

function startMcp(projectDir, extraArgs = []) {
  const child = spawn(process.execPath, [MCP_SERVER, ...extraArgs], {
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
      try { const m = JSON.parse(line); if (waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } } catch { /* 사람 줄은 무시 */ }
    }
  });
  let id = 0;
  const call = (method, params, timeoutMs = 120_000) => new Promise((resolve, reject) => {
    const n = ++id;
    const t = setTimeout(() => reject(new Error(`${method} 응답이 ${timeoutMs}ms 안에 안 왔다`)), timeoutMs);
    waiting.set(n, (m) => { clearTimeout(t); resolve(m); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: n, method, params })}\n`);
  });
  const ready = (async () => {
    await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'gate3', version: '1' } });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  })();
  return {
    child, call, ready,
    tool: (name, args, ms) => call('tools/call', { name, arguments: args }, ms),
    async stop() { child.kill('SIGTERM'); await new Promise((r) => { child.on('exit', r); setTimeout(r, 1500); }); },
  };
}

const { child: fixture, base: BASE } = await startFixture();
const PORT = Number(new URL(BASE).port);
const MCP_ARGS = (dir) => [
  `--allow-fixture-host=127.0.0.1:${PORT}`,
  `--pace-db=${path.join(dir, 'pace.db')}`,
  '--pace-min-interval-ms=1', '--pace-jitter-ms=0', '--pace-retry-backoff-ms=1',
];

const serverHits = async () => {
  const r = await fetch(`${BASE}/control/hits`);
  return r.json();
};
const resetHits = () => fetch(`${BASE}/control/reset`);

// 바깥으로 나갔는지 지켜본다. 이 게이트가 부르는 fetch 는 fixture 제어용뿐이다.
const contacted = new Set();
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  contacted.add(new URL(typeof input === 'string' ? input : input.url).host);
  return realFetch(input, init);
};

const wsRootOf = (dir, id) => path.join(dir, '.claude', 'websearch-workspace', id);
const linesOf = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

let depsDir = null;
try { depsDir = resolvePlaywright({}).from; } catch { depsDir = null; }

try {
  // ══ G3-1 구성 시험 ═════════════════════════════════════════
  {
    const suites = [
      'tests/fixtures/verify-fixtures.mjs', 'tests/artifacts/verify.mjs', 'tests/pace/verify.mjs',
      'tests/network/verify.mjs', 'tests/collect-http/verify.mjs', 'tests/images/verify.mjs',
      'tests/collect-run/verify.mjs', 'tests/diagnostics/verify.mjs',
    ];
    const ran = suites.map((s) => ({ s, ...runSuite(s) }));
    const bad = ran.filter((r) => r.status !== 0 || !r.parsed?.pass);
    const total = ran.reduce((n, r) => n + (r.parsed?.total ?? 0), 0);
    add('G3-1', '수집 계층 구성 시험 8묶음', bad.length === 0,
      bad.length ? bad.map((b) => `${b.s} exit=${b.status} ${b.stderr}`).join(' / ')
        : `${suites.length}묶음 ${total}항목 전부 통과`);
  }

  // ══ G3-2 브라우저 구성 시험 ════════════════════════════════
  {
    if (depsDir === null) {
      add('G3-2', '브라우저 구성 시험 2묶음', false,
        'playwright 를 못 찾았습니다. WEBSEARCH_DEPS_DIR 로 자리를 알려 주거나 그 프로젝트에서 게이트를 돌리십시오'
        + ' — 브라우저 수집(#29·#30)은 게이트 3 의 범위라 건너뛰지 않습니다');
    } else {
      const suites = ['tests/browser/verify.mjs', 'tests/browser-images/verify.mjs'];
      const ran = suites.map((s) => ({ s, ...runSuite(s, { env: { WEBSEARCH_DEPS_DIR: depsDir } }) }));
      const bad = ran.filter((r) => r.status !== 0 || !r.parsed?.pass);
      const total = ran.reduce((n, r) => n + (r.parsed?.total ?? 0), 0);
      add('G3-2', '브라우저 구성 시험 2묶음', bad.length === 0,
        bad.length ? bad.map((b) => `${b.s} exit=${b.status} ${b.stderr}`).join(' / ')
          : `${suites.length}묶음 ${total}항목 전부 통과 · playwright ${depsDir.replace(os.homedir(), '~')}`);
    }
  }

  // ══ 버튼으로 도는 통합 판 ═══════════════════════════════════
  const projectDir = path.join(SANDBOX, 'proj');
  fs.mkdirSync(projectDir, { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: projectDir });
  const mcp = startMcp(projectDir, MCP_ARGS(projectDir));
  await mcp.ready;

  const ws = (await mcp.tool('workspace_new', { topic: 'gate3', brief: '게이트 3 — 산출물·교차 연결·중간 종료' })).result.structuredContent;
  const root = wsRootOf(projectDir, ws.workspace_id);

  // ══ G3-3 요청하지 않은 산출물 0 ════════════════════════════
  const EIGHT = [
    ['/static/normal', ['text']],
    ['/js/rendered', ['dom']],
    ['/error/soft-404', ['text', 'links']],
    ['/redirect/one', ['links']],
    ['/status/404', ['text']],
    ['/slow/2s', ['dom', 'links']],
    ['/images/partial', ['images']],
    ['/long/page', ['text', 'dom', 'links']],
  ];
  {
    await mcp.tool('add_urls', {
      workspace: ws.workspace_id, source_kind: 'seed', source_value: 'gate3',
      urls: EIGHT.map(([p]) => `${BASE}${p}`),
    });
    const perItem = [];
    for (const [p, outputs] of EIGHT) {
      const leased = (await mcp.tool('next', { workspace: ws.workspace_id, worker_id: 'g3', count: 1 })).result.structuredContent;
      const got = await mcp.tool('collect', {
        workspace: ws.workspace_id, lease_id: leased.lease_id, mode: 'http', outputs,
      }, 60_000);
      const idx = linesOf(root, got.result.structuredContent.index_path);
      perItem.push({ p, outputs, line: idx[0], response: got.result });
    }

    const WANTED_FILES = { text: 'text.txt', dom: 'dom.html.gz', links: 'links.jsonl', images: 'images.jsonl' };
    const extra = [];
    for (const { p, outputs, line } of perItem) {
      const dir = path.join(root, 'artifacts', 'pages', String(line.item_id), line.attempt_id);
      const files = fs.readdirSync(dir).filter((f) => f !== 'manifest.json' && f !== 'images');
      const want = outputs.map((o) => WANTED_FILES[o]).sort();
      if (JSON.stringify(files.sort()) !== JSON.stringify(want)) extra.push(`${p}: ${files.join('·')} ≠ ${want.join('·')}`);
      if (fs.existsSync(path.join(dir, 'screenshot.png'))) extra.push(`${p}: 안 시킨 screenshot 이 생겼다`);
    }
    add('G3-3', 'fixture 8종에서 요청하지 않은 산출물 0', extra.length === 0,
      extra.length ? extra.join(' / ') : `8종 각각 시킨 파일만 생겼다 (${EIGHT.map(([p, o]) => `${p.split('/').pop()}:${o.length}`).join(' ')})`);

    // ══ G3-5 응답 4KB·원문 없음 ══════════════════════════════
    const sizes = perItem.map((x) => Buffer.byteLength(JSON.stringify(x.response)));
    const leaked = perItem.filter((x) => {
      const s = JSON.stringify(x.response);
      return s.includes('<html') || s.includes('디자인 12') || s.includes('Something went wrong');
    });
    add('G3-5', '원문은 파일에만 · MCP 응답 4KB 이내',
      Math.max(...sizes) <= 4096 && leaked.length === 0,
      `응답 최대 ${Math.max(...sizes)}바이트 (상한 4096) · 원문 조각이 실린 응답 ${leaked.length}건`);

    // ══ G3-6 URL·상태·경고 대조 ══════════════════════════════
    const want = [
      ['/redirect/one', (l) => l.final_url.endsWith('/redirect/arrived') && l.warnings.includes('redirected')],
      ['/error/soft-404', (l) => l.http_status === 200 && l.warnings.includes('error_page_text_detected') && l.result === 'success'],
      ['/status/404', (l) => l.http_status === 404 && l.warnings.includes('http_error_status') && l.result === 'success'],
      ['/images/partial', (l) => l.warnings.includes('image_fetch_partial') && l.result === 'partial'],
      ['/long/page', (l) => l.result === 'success' && l.http_status === 200],
      ['/js/rendered', (l) => l.result === 'success'],
    ];
    const wrong = want.filter(([p, check]) => !check(perItem.find((x) => x.p === p).line));
    const allHaveUrls = perItem.every((x) => x.line.requested_url && (x.line.final_url || x.line.result === 'failed'));
    add('G3-6', '요청·최종 URL 과 상태·경고가 기대대로', wrong.length === 0 && allHaveUrls,
      wrong.length ? `어긋남: ${wrong.map(([p]) => p).join('·')}`
        : `리다이렉트·200오류·404·그림일부·긴쪽·JS 여섯 자리가 기대대로 · 모든 줄에 요청/최종 URL 있음`);
  }

  // ══ G3-4 screenshot+http 는 접속 전에 거절 ═════════════════
  {
    await resetHits();
    const leased = (await mcp.tool('add_urls', {
      workspace: ws.workspace_id, source_kind: 'seed', source_value: 'gate3-shot', urls: [`${BASE}/static/plain`],
    })).result.structuredContent;
    const lease = (await mcp.tool('next', { workspace: ws.workspace_id, worker_id: 'g3', count: 1 })).result.structuredContent;
    const refused = await mcp.tool('collect', {
      workspace: ws.workspace_id, lease_id: lease.lease_id, mode: 'http', outputs: ['screenshot', 'text'],
    });
    const hits = await serverHits();
    add('G3-4', 'screenshot+http 는 네트워크 전에 거절',
      refused.result.isError === true && Object.keys(hits).filter((k) => !k.startsWith('/control')).length === 0,
      `${String(refused.result.content[0].text).slice(0, 70)} · 서버가 받은 요청 ${Object.keys(hits).length}건`);
    void leased;
  }

  // ══ G3-8 이미지 manifest 전수 대조 ═════════════════════════
  {
    const db = openDb(root, path.join(root, 'workspace.db'));
    const manifests = db.prepare("SELECT attempt_id, path FROM artifacts WHERE kind = 'image_manifest'").all();
    const problems = [];
    let rowsChecked = 0;
    for (const m of manifests) {
      const rows = linesOf(root, m.path);
      const good = rows.filter((r) => r.ok);
      const dbRows = db.prepare("SELECT path, byte_size, sha256 FROM artifacts WHERE attempt_id = ? AND kind = 'image'").all(m.attempt_id);
      if (good.length !== dbRows.length) problems.push(`${m.attempt_id}: 성공 줄 ${good.length} ≠ 장부 ${dbRows.length}`);
      for (const r of good) {
        rowsChecked++;
        const abs = path.join(root, r.path);
        if (!fs.existsSync(abs)) { problems.push(`${r.path} 없음`); continue; }
        if (fs.statSync(abs).size !== r.byte_size) problems.push(`${r.path} 크기 어긋남`);
        if (sha(fs.readFileSync(abs)) !== r.sha256) problems.push(`${r.path} 지문 어긋남`);
        const inDb = dbRows.find((d) => d.path === r.path);
        if (!inDb || inDb.sha256 !== r.sha256 || inDb.byte_size !== r.byte_size) problems.push(`${r.path} 장부와 어긋남`);
      }
      for (const r of rows.filter((x) => !x.ok)) if (r.path !== null) problems.push(`${r.url} 실패인데 경로가 있다`);
    }
    add('G3-8', '이미지 manifest 와 실제 파일·지문 전수 일치', problems.length === 0 && rowsChecked > 0,
      problems.length ? problems.slice(0, 4).join(' / ') : `manifest ${manifests.length}장 · 성공 줄 ${rowsChecked}개 전수 대조 일치`);
    db.close();
  }

  // ══ G3-9 무작위 30개 교차 연결 0 ═══════════════════════════
  {
    const N = 30;
    const nums = Array.from({ length: N }, (_, i) => i + 1);
    await mcp.tool('add_urls', {
      workspace: ws.workspace_id, source_kind: 'seed', source_value: 'gate3-unique',
      urls: nums.map((n) => `${BASE}/unique/${n}`),
    });
    const lease = (await mcp.tool('next', { workspace: ws.workspace_id, worker_id: 'g3-x', count: N })).result.structuredContent;
    const got = await mcp.tool('collect', {
      workspace: ws.workspace_id, lease_id: lease.lease_id, mode: 'http', outputs: ['text', 'links'],
    }, 180_000);
    const idx = linesOf(root, got.result.structuredContent.index_path);

    const mixed = [];
    for (const line of idx) {
      const n = Number(new URL(line.requested_url).pathname.split('/').pop());
      const text = fs.readFileSync(path.join(root, line.outputs.text), 'utf8');
      // 제 표지는 있어야 하고, 남의 표지는 하나도 없어야 한다.
      if (!text.includes(`MARKER-${n}-ONLY`)) mixed.push(`item ${line.item_id}: 제 표지 MARKER-${n} 없음`);
      const others = nums.filter((k) => k !== n && text.includes(`MARKER-${k}-ONLY`));
      if (others.length) mixed.push(`item ${line.item_id}: 남의 표지 ${others.join(',')} 섞임`);
      // 링크 장부의 자기 참조도 제 번호를 가리켜야 한다.
      const links = linesOf(root, line.outputs.links);
      if (!links.some((l) => l.url === `${BASE}/unique/${n + 1}`)) mixed.push(`item ${line.item_id}: 링크가 제 다음 쪽을 안 가리킨다`);
      // 요약이 가리키는 실행 폴더가 제 item 번호 아래에 있어야 한다.
      if (!line.manifest.startsWith(`artifacts/pages/${line.item_id}/`)) mixed.push(`item ${line.item_id}: 요약 경로가 남의 자리`);
    }
    add('G3-9', `무작위 ${N}개 item 에서 URL·자료 교차 연결 0`,
      idx.length === N && mixed.length === 0,
      mixed.length ? mixed.slice(0, 4).join(' / ')
        : `${N}개 각각 제 표지만 있고 남의 표지 0 · 링크·요약 경로도 제 번호를 가리킨다`);
  }

  await mcp.stop();

  // ══ G3-7 수집 도중 강제 종료 ═══════════════════════════════
  {
    const dir2 = path.join(SANDBOX, 'kill');
    fs.mkdirSync(dir2, { recursive: true });
    spawnSync('git', ['init', '-q'], { cwd: dir2 });
    const m2 = startMcp(dir2, MCP_ARGS(dir2));
    await m2.ready;
    const w2 = (await m2.tool('workspace_new', { topic: 'gate3-kill', brief: '수집 도중 강제 종료' })).result.structuredContent;
    const r2 = wsRootOf(dir2, w2.workspace_id);
    // 첫 항목은 반드시 도중에 있게 만든다. /hang/body 는 머리만 주고 본문을 안 끝내므로,
    // 끊는 순간 그 실행은 확실히 "열려 있는" 상태다. 12MB 쪽은 너무 빨리 끝나 끊어도 이미 지난 뒤였다.
    await m2.tool('add_urls', {
      workspace: w2.workspace_id, source_kind: 'seed', source_value: 'k',
      urls: [`${BASE}/hang/body`, `${BASE}/long/huge`],
    });
    const lease = (await m2.tool('next', { workspace: w2.workspace_id, worker_id: 'k', count: 2 })).result.structuredContent;

    m2.tool('collect', {
      workspace: w2.workspace_id, lease_id: lease.lease_id, mode: 'http', outputs: ['dom', 'text'],
    }, 60_000).catch(() => {});
    await new Promise((r) => setTimeout(r, 1200));
    m2.child.kill('SIGKILL');
    await new Promise((r) => { m2.child.on('exit', r); setTimeout(r, 1500); });

    const db = openDb(r2, path.join(r2, 'workspace.db'));
    const v = verifyArtifacts(db, r2);
    const unfinished = db.prepare('SELECT attempt_id, item_id FROM attempts WHERE finished_at IS NULL').all();
    const rows = db.prepare('SELECT path FROM artifacts').all();
    const tempInLedger = rows.filter((r) => path.basename(r.path).startsWith('.part-'));
    const listed = new Set(rows.map((r) => r.path));
    const tempListed = v.incomplete.filter((p) => listed.has(p));
    // 진짜로 도중에 끊었는가. 안 끝난 실행이 없으면 이 항목은 아무것도 증명하지 못한 것이다.
    const reallyMidFlight = unfinished.length >= 1;
    add('G3-7', '수집 도중 강제 종료 — 만들다 만 것이 artifact 로 안 보임',
      reallyMidFlight && tempInLedger.length === 0 && tempListed.length === 0
      && v.missing.length === 0 && v.sha_mismatch.length === 0 && v.orphans.length === 0,
      `도중에 끊긴 실행 ${unfinished.length}건(있어야 이 시험이 성립한다) · 장부 ${v.checked}줄`
      + ` · 장부에 든 임시 파일 ${tempInLedger.length} · 디스크의 만들다 만 파일 ${v.incomplete.length}(그중 장부에 오른 것 ${tempListed.length})`
      + ` · 없는 파일 ${v.missing.length} · 지문 어긋남 ${v.sha_mismatch.length} · 고아 ${v.orphans.length}`);
    db.close();
  }

  // ══ G3-10 LEGACY 불변 · 금지 import 0 ══════════════════════
  {
    const audit = runSuite('tests/baseline/verify-reuse-audit.mjs');
    // [대조는 --verify 다] 예전에 여기서 있지도 않은 --check 를 주었고, baseline.mjs 는 모르는 깃발을
    // 쓰기로 받아 얼려 둔 기준선을 덮어썼다. 덮어쓰기는 언제나 성공하니 게이트는 PASS 를 냈다.
    // 지금은 baseline.mjs 가 모르는 깃발을 거절하지만, 부르는 쪽도 뜻을 분명히 적는다.
    const PROJECT = process.env.CLAUDE_PROJECT_DIR || path.resolve(TOOL_ROOT, '..', '..', '..', 'Github', 'WORK', 'GoraeUniverse', 'dibang');
    const baseline = spawnSync(process.execPath,
      [path.join(HERE, 'baseline', 'baseline.mjs'), '--verify', '--project', PROJECT], {
        cwd: TOOL_ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
      });
    add('G3-10', 'LEGACY 불변 · 금지 import 0',
      audit.status === 0 && baseline.status === 0,
      `재사용 감사 exit=${audit.status} · 기준선 대조 exit=${baseline.status}`
      + `${baseline.status !== 0 ? ` — ${(baseline.stdout ?? '').split('\n').slice(-3).join(' ')}` : ''}`);
  }

  // ══ G3-11 게이트가 밖으로 안 나갔다 ════════════════════════
  {
    const outside = [...contacted].filter((h) => !h.startsWith('127.0.0.1:'));
    add('G3-11', '게이트 자체가 127.0.0.1 밖으로 나가지 않음', outside.length === 0,
      `접촉한 곳 ${[...contacted].join(', ') || '없음'}`);
  }

  // ══ G3-12 낱말이 새지 않았다 ═══════════════════════════════
  {
    const db = openDb(root, path.join(root, 'workspace.db'));
    const warned = new Set(db.prepare('SELECT warning_codes FROM attempts WHERE warning_codes IS NOT NULL').all()
      .flatMap((r) => JSON.parse(r.warning_codes)));
    const unknown = [...warned].filter((w) => !WARNING_CODES.includes(w));
    const pointerDirsOk = POINTER_DIRS.includes('collect') && POINTER_DIRS.includes('leases');
    add('G3-12', '이 게이트가 낸 관찰이 모두 낱말표에 있음', unknown.length === 0 && pointerDirsOk,
      `관찰 ${warned.size}종(${[...warned].join('·')}) · 모르는 이름 ${unknown.length}`);
    db.close();
  }
} finally {
  await new Promise((r) => { fixture.on('exit', r); fixture.kill('SIGTERM'); setTimeout(r, 1500); });
}

const failed = results.filter((r) => !r.pass);
if (AS_JSON) {
  process.stdout.write(`${JSON.stringify({ gate: 3, pass: failed.length === 0, total: results.length, failed: failed.length, results }, null, 2)}\n`);
} else {
  for (const r of results) process.stdout.write(`${r.pass ? 'PASS' : 'FAIL'}  ${r.id}  ${r.title}\n        ${r.detail}\n`);
  process.stdout.write(`\n${failed.length === 0 ? 'PASS' : 'FAIL'} — ${results.length - failed.length}/${results.length}\n`);
}
process.exit(failed.length === 0 ? 0 : 1);
