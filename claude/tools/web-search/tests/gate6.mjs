#!/usr/bin/env node
// 게이트 6 — 판정·export·상태 분리.
//
//   node tests/gate6.mjs          전부 실행하고 판정 (exit 0 이면 통과)
//   node tests/gate6.mjs --json
//
// 재려는 것은 하나다: **기계가 본 사실, 사람이 내린 판정, 다음 사람에게 넘길 결과가 서로 덮어쓰지 않는가.**
//   - 수집 상태가 판정을 바꾸지 않고, 판정이 수집 상태를 바꾸지 않는가
//   - 갈린 판정 둘이 각자의 근거와 함께 남는가
//   - 내보낸 줄에서 원본까지 되짚어지는가
//   - 다음 사람이 export 와 status **만** 보고 다음 묶음을 정할 수 있는가
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
const MANAGER = path.join(HERE, 'gate6-manager.mjs');
const AS_JSON = process.argv.includes('--json');

const results = [];
const add = (id, title, pass, detail) => results.push({ id, title, pass: Boolean(pass), detail: String(detail) });

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'gate6-'));
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
    await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'gate6', version: '1' } });
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

try {
  // ══ G6-1 구성 시험 ═════════════════════════════════════════
  {
    const suites = [
      'tests/judgments/verify.mjs', 'tests/report-judgments/verify.mjs',
      'tests/export/verify.mjs', 'tests/status-full/verify.mjs',
    ];
    const ran = suites.map((s) => ({ s, ...runSuite(s) }));
    const bad = ran.filter((r) => r.status !== 0 || !r.parsed?.pass);
    const total = ran.reduce((n, r) => n + (r.parsed?.total ?? 0), 0);
    add('G6-1', '판정·보고·export·status 구성 시험 4묶음', bad.length === 0,
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

  const ws = (await mcp.tool('workspace_new', { topic: 'gate6', brief: '게이트 6 — 사실·판정·export 의 분리' })).result.structuredContent;
  const root = path.join(projectDir, '.claude', 'websearch-workspace', ws.workspace_id);
  const openWs = () => openDb(root, path.join(root, 'workspace.db'));
  const readLines = (rel) => fs.readFileSync(path.join(root, rel), 'utf8').split('\n').filter((l) => l.trim());

  // 여덟 곳. 잘 되는 것 넷, 상태 코드가 나쁜 것 둘(수집은 되고 경고가 붙는다),
  // 정말 실패하는 것 둘(끝없는 되돌림 · 사설 주소로 넘김). 실패가 0이면 실패 쪽 항목이 헛돈다.
  const PAGES = ['/static/normal', '/links/mixed', '/about', '/help',
    '/status/500', '/status/404', '/redirect/loop', '/redirect/private'];
  await mcp.tool('add_urls', {
    workspace: ws.workspace_id, source_kind: 'seed', source_value: '게이트 6 씨앗',
    urls: PAGES.map((p) => `${BASE}${p}`),
  });
  await mcp.tool('add_urls', {
    workspace: ws.workspace_id, source_kind: 'search', source_value: '수제 청첩장, 서울',
    urls: [`${BASE}/static/normal`, `${BASE}/about`],
  });

  const lease1 = (await mcp.tool('next', { workspace: ws.workspace_id, worker_id: 'w1', count: 8 })).result.structuredContent;
  await mcp.tool('collect', { workspace: ws.workspace_id, lease_id: lease1.lease_id, mode: 'http', outputs: ['text', 'links'] });

  // 수집된 것만 판정과 함께 반납한다. 근거는 그 item 의 artifact 여야 한다.
  const db1 = openWs();
  const collected = db1.prepare(`
    SELECT t.item_id, MIN(a.artifact_id) AS art FROM attempts t JOIN artifacts a ON a.attempt_id = t.attempt_id
     WHERE t.operation = 'collect' AND t.result IN ('success','partial') GROUP BY t.item_id ORDER BY t.item_id`).all();
  const failedItems = db1.prepare("SELECT DISTINCT item_id FROM attempts WHERE result = 'failed'").all().map((r) => r.item_id);
  db1.close();

  const FIRST_LABELS = ['후보', '후보', '제외', null];
  const reported = collected.slice(0, 4);
  await mcp.tool('report', {
    workspace: ws.workspace_id, lease_id: lease1.lease_id, worker_id: 'w1',
    judgments: reported.map((c, i) => ({
      item_id: String(c.item_id), label: FIRST_LABELS[i], confidence: FIRST_LABELS[i] === null ? null : 0.8,
      evidence_artifact_ids: [String(c.art)], note: FIRST_LABELS[i] === null ? '본문만 봐서는 못 정하겠다' : '본문에 근거가 있다',
    })),
  });

  const target = reported[0].item_id;   // 여기에 두 번째 판정을 붙일 것이다

  // ══ G6-2 판정이 수집 상태를 건드리지 않는다 ════════════════
  {
    const db = openWs();
    const before = db.prepare('SELECT work_state, collected_at FROM items WHERE item_id = ?').get(target);
    const attemptsBefore = db.prepare('SELECT COUNT(*) AS n FROM attempts').get().n;
    db.close();

    // 라벨에 상태 이름을 그대로 써 본다. 해석하면 여기서 티가 난다.
    const lease2 = (await mcp.tool('next', { workspace: ws.workspace_id, worker_id: 'w2', count: 6 })).result.structuredContent;
    const db2 = openWs();
    const stillLeasedToW2 = db2.prepare("SELECT COUNT(*) AS n FROM items WHERE leased_by = 'w2'").get().n;
    db2.close();

    const db4 = openWs();
    const after = db4.prepare('SELECT COUNT(*) AS n FROM attempts').get().n;
    const states = Object.fromEntries(db4.prepare('SELECT work_state, COUNT(*) AS n FROM items GROUP BY work_state').all().map((x) => [x.work_state, x.n]));
    db4.close();

    // 판정을 받은 것(done)도, 아직 반납 안 한 것(leased)도, 실패한 것(failed)도 다시 안 나간다.
    // 대기가 0이면 다음 워커는 빈손이어야 한다 — 그것이 여기서 재는 성질이다.
    add('G6-2', 'report 로 done 이 된 항목은 다시 빌려지지 않고, 판정은 수집 기록을 안 건드린다',
      before.work_state === 'done' && before.collected_at !== null
      && lease2.leased === 0 && stillLeasedToW2 === 0 && (states.queued ?? 0) === 0
      && after === attemptsBefore,
      `판정 뒤 item ${target} 은 ${before.work_state} · 수집 시각 그대로`
      + ` · 상태 ${Object.entries(states).map(([k, v]) => `${k} ${v}`).join('·')} 에서 w2 가 새로 빌린 것 ${lease2.leased}건`
      + ` · 실행 기록 ${attemptsBefore}건 그대로`);
  }

  // ══ 같은 item 에 다른 판정 하나 더 ══════════════════════════
  // done 을 다시 대기로 돌리고(증거는 그대로), 다시 수집해 새 근거로 다른 라벨을 붙인다.
  await mcp.tool('retry', { workspace: ws.workspace_id, item_ids: [String(target)], reason: '두 번째 눈으로 다시 본다' });
  const lease3 = (await mcp.tool('next', { workspace: ws.workspace_id, worker_id: 'w3', count: 10 })).result.structuredContent;
  await mcp.tool('collect', { workspace: ws.workspace_id, lease_id: lease3.lease_id, mode: 'http', outputs: ['text'] });

  const db3 = openWs();
  const secondArt = db3.prepare(`
    SELECT a.artifact_id FROM attempts t JOIN artifacts a ON a.attempt_id = t.attempt_id
     WHERE t.item_id = ? ORDER BY a.artifact_id DESC LIMIT 1`).get(target).artifact_id;
  const leasedNow = db3.prepare("SELECT item_id FROM items WHERE leased_by = 'w3' AND collected_at IS NOT NULL").all().map((r) => r.item_id);
  db3.close();

  await mcp.tool('report', {
    workspace: ws.workspace_id, lease_id: lease3.lease_id, worker_id: 'w3',
    judgments: leasedNow.map((id) => ({
      item_id: String(id), label: id === target ? '제외' : '후보', confidence: 0.6,
      evidence_artifact_ids: id === target ? [String(secondArt)] : [],
      note: id === target ? '두 번째로 보니 다르게 읽힌다' : '나머지도 같이 반납',
    })),
  });

  // ══ G6-3 갈린 판정 둘과 각자의 근거 ════════════════════════
  {
    const db = openWs();
    const rows = db.prepare('SELECT worker_id, label, evidence_artifact_ids FROM judgments WHERE item_id = ? ORDER BY judgment_id').all(target);
    const evid = rows.map((r) => JSON.parse(r.evidence_artifact_ids)).flat();
    const attemptsOf = evid.map((a) => db.prepare(`
      SELECT t.attempt_id, t.item_id FROM artifacts a JOIN attempts t ON t.attempt_id = a.attempt_id WHERE a.artifact_id = ?`).get(a));
    const state = db.prepare('SELECT work_state FROM items WHERE item_id = ?').get(target).work_state;
    db.close();

    add('G6-3', '같은 item 의 상충 판정 둘이 각자의 근거와 함께 남는다',
      rows.length === 2 && rows[0].label !== rows[1].label
      && rows[0].worker_id !== rows[1].worker_id
      && evid.length === 2 && evid[0] !== evid[1]
      && attemptsOf.every((a) => a.item_id === target)
      && attemptsOf[0].attempt_id !== attemptsOf[1].attempt_id
      && state === 'done',
      `item ${target}: ${rows.map((r) => `${r.worker_id}="${r.label}"`).join(' vs ')}`
      + ` · 근거 artifact ${evid.join('·')}(서로 다른 실행 ${attemptsOf.map((a) => a.attempt_id.slice(0, 8)).join('·')})`
      + ` · 기계 상태는 ${state} 하나뿐이다`);
  }

  // ══ G6-4 retry 가 판정을 지우지 않는다 ═════════════════════
  {
    const db = openWs();
    const hist = db.prepare('SELECT COUNT(*) AS n FROM retries WHERE item_id = ?').get(target).n;
    const kept = db.prepare('SELECT COUNT(*) AS n FROM judgments WHERE item_id = ?').get(target).n;
    const attempts = db.prepare('SELECT COUNT(*) AS n FROM attempts WHERE item_id = ?').get(target).n;
    db.close();
    add('G6-4', '다시 대기로 돌려도 앞선 판정과 증거가 남는다', hist === 1 && kept === 2 && attempts === 2,
      `되돌린 이력 ${hist}건 · 남은 판정 ${kept}건 · 수집 기록 ${attempts}건 — 지워진 것 없음`);
  }

  // ══ export ═════════════════════════════════════════════════
  const FIELDS = ['item_id', 'canonical_url', 'domain', 'work_state', 'labels', 'judgments', 'sources', 'attempt_ids', 'manifest_paths', 'artifact_paths', 'error_codes'];
  const jsonl = (await mcp.tool('export', { workspace: ws.workspace_id, format: 'jsonl', fields: FIELDS })).result.structuredContent;
  const csv = (await mcp.tool('export', { workspace: ws.workspace_id, format: 'csv', fields: FIELDS })).result.structuredContent;

  // ══ G6-5 모든 줄에서 원본까지 되짚어진다 ═══════════════════
  {
    const rows = readLines(jsonl.path).map((l) => JSON.parse(l));
    const db = openWs();
    const problems = [];
    for (const r of rows) {
      if (!db.prepare('SELECT 1 AS ok FROM items WHERE item_id = ?').get(r.item_id)) problems.push(`item ${r.item_id} 없음`);
      if ((r.sources ?? []).length === 0) problems.push(`item ${r.item_id} 출처 없음`);
      for (const a of r.attempt_ids ?? []) {
        if (!db.prepare('SELECT 1 AS ok FROM attempts WHERE attempt_id = ? AND item_id = ?').get(a, r.item_id)) problems.push(`실행 ${a} 가 item ${r.item_id} 것이 아님`);
      }
      for (const p of [...(r.manifest_paths ?? []), ...(r.artifact_paths ?? [])]) {
        if (!fs.existsSync(path.join(root, p))) problems.push(`파일 없음 ${p}`);
      }
    }
    db.close();
    const traced = rows.reduce((n, r) => n + (r.artifact_paths ?? []).length + (r.manifest_paths ?? []).length, 0);
    add('G6-5', 'export 의 모든 줄에서 source → item → attempt → artifact 로 되짚어진다',
      problems.length === 0 && rows.length > 0 && traced > 0,
      problems.length ? problems.slice(0, 3).join(' / ')
        : `${rows.length}줄 전부 — 출처·실행·파일 ${traced}개가 실제로 그 자리에 있다`);
  }

  // ══ G6-6 두 형식이 같은 줄 수 ══════════════════════════════
  {
    const jrows = readLines(jsonl.path).length;
    const csvText = fs.readFileSync(path.join(root, csv.path), 'utf8');
    // 큰따옴표 밖의 CRLF 만 줄바꿈이다. 판정 메모에 줄바꿈이 들어 있어도 줄이 늘지 않아야 한다.
    let depth = 0;
    let lines = 1;
    for (let i = 0; i < csvText.length; i++) {
      if (csvText[i] === '"') depth ^= 1;
      else if (!depth && csvText[i] === '\r' && csvText[i + 1] === '\n') { lines++; i++; }
    }
    // 마지막 줄도 CRLF 로 닫히므로 센 줄 수는 "머리글 + 자료줄 + 빈 꼬리" 다.
    const csvRows = lines - 2;
    const db = openWs();
    const dbRows = db.prepare('SELECT COUNT(*) AS n FROM items').get().n;
    db.close();
    add('G6-6', 'DB 기대 행 수와 두 형식의 행 수가 같다',
      jrows === dbRows && csvRows === dbRows && jsonl.rows === dbRows,
      `DB item ${dbRows}개 · jsonl ${jrows}줄 · csv ${csvRows}줄(머리글 뺀 수)`);
  }

  // ══ G6-7 필터별 기대 수 대조 ═══════════════════════════════
  {
    const db = openWs();
    const want = {
      done: db.prepare("SELECT COUNT(*) AS n FROM items WHERE work_state = 'done'").get().n,
      failed: db.prepare("SELECT COUNT(*) AS n FROM items WHERE work_state = 'failed'").get().n,
      label후보: db.prepare("SELECT COUNT(DISTINCT item_id) AS n FROM judgments WHERE label = '후보'").get().n,
      search: db.prepare("SELECT COUNT(DISTINCT item_id) AS n FROM sources WHERE source_kind = 'search'").get().n,
    };
    db.close();

    const runs = {
      done: await mcp.tool('export', { workspace: ws.workspace_id, format: 'jsonl', filter_state: 'done' }),
      failed: await mcp.tool('export', { workspace: ws.workspace_id, format: 'jsonl', filter_state: 'failed' }),
      label후보: await mcp.tool('export', { workspace: ws.workspace_id, format: 'jsonl', filter_label: '후보' }),
      search: await mcp.tool('export', { workspace: ws.workspace_id, format: 'jsonl', filter_source: 'search:수제 청첩장, 서울' }),
    };
    const bad = [];
    for (const [k, r] of Object.entries(runs)) {
      const sc = r.result.structuredContent;
      const parsed = readLines(sc.path).length;
      if (sc.rows !== want[k] || parsed !== want[k]) bad.push(`${k}: 기대 ${want[k]} · 응답 ${sc.rows} · 파일 ${parsed}`);
    }
    // 없는 라벨은 0줄이고, 오타 난 상태는 오류여야 한다.
    const zero = (await mcp.tool('export', { workspace: ws.workspace_id, format: 'jsonl', filter_label: '있을 리 없는 라벨' })).result.structuredContent;
    const typo = (await mcp.tool('export', { workspace: ws.workspace_id, format: 'jsonl', filter_state: 'finished' })).result;

    // [0 대 0 은 일치가 아니다] 걸러 낼 것이 실제로 있어야 이 항목이 뜻을 가진다.
    add('G6-7', '필터별 기대 행 수와 실제 파일의 행 수가 같다',
      bad.length === 0 && zero.rows === 0 && typo.isError === true
      && Object.values(want).every((n) => n > 0),
      bad.length ? bad.join(' / ')
        : `${Object.entries(want).map(([k, v]) => `${k}=${v}`).join(' · ')} 전부 일치(넷 다 0보다 크다)`
          + ` · 없는 라벨 0줄 · 오타 난 상태는 오류(0줄로 둔갑 안 함)`);
  }

  // ══ G6-8 상위 역할이 export·status 만으로 다음을 정한다 ════
  {
    const all = (await mcp.tool('export', {
      workspace: ws.workspace_id, format: 'jsonl',
      fields: ['item_id', 'work_state', 'labels', 'judgment_count', 'error_codes'],
    })).result.structuredContent;
    const status = (await mcp.tool('status', { workspace: ws.workspace_id })).result.structuredContent;

    // 볼 수 있는 것을 딱 둘로 만든다. 빈 폴더에 두 파일만 복사한다.
    const deskDir = path.join(SANDBOX, 'manager-desk');
    fs.mkdirSync(deskDir, { recursive: true });
    fs.copyFileSync(path.join(root, all.path), path.join(deskDir, 'export.jsonl'));
    fs.writeFileSync(path.join(deskDir, 'status.json'), JSON.stringify(status, null, 2));

    const r = spawnSync(process.execPath, [MANAGER, path.join(deskDir, 'export.jsonl'), path.join(deskDir, 'status.json')],
      { cwd: deskDir, encoding: 'utf8' });
    let plan = null;
    try { plan = JSON.parse(r.stdout); } catch { /* 아래에서 잡힌다 */ }

    const db = openWs();
    const realQueued = db.prepare("SELECT item_id FROM items WHERE work_state = 'queued' ORDER BY item_id").all().map((x) => x.item_id);
    const realFailed = db.prepare("SELECT item_id FROM items WHERE work_state = 'failed' ORDER BY item_id").all().map((x) => x.item_id);
    const realUnlabeled = db.prepare(`
      SELECT i.item_id FROM items i WHERE i.work_state = 'done'
       AND NOT EXISTS (SELECT 1 FROM judgments j WHERE j.item_id = i.item_id AND j.label IS NOT NULL)
       ORDER BY i.item_id`).all().map((x) => x.item_id);
    const realConflict = db.prepare(`
      SELECT item_id FROM judgments WHERE label IS NOT NULL GROUP BY item_id HAVING COUNT(DISTINCT label) > 1`).all().map((x) => x.item_id);
    db.close();

    const same = (a, b) => JSON.stringify((a ?? []).slice().sort((x, y) => x - y)) === JSON.stringify(b.slice().sort((x, y) => x - y));
    add('G6-8', 'export 와 status 만 가진 새 프로세스가 다음 묶음을 정한다',
      r.status === 0 && plan !== null
      && same(plan.next_item_ids, realQueued) && same(plan.retry_item_ids, realFailed)
      && same(plan.needs_judgment_item_ids, realUnlabeled) && same(plan.conflicted_item_ids, realConflict)
      && plan.saw_files.length === 2,
      plan === null ? `매니저가 죽었다: ${(r.stderr || r.stdout).slice(0, 160)}`
        : `책상에 놓인 파일 ${plan.saw_files.join('·')} 둘뿐 — 다음 ${plan.next_item_ids.length}건`
          + ` · 다시 ${plan.retry_item_ids.length}건 · 판정 없는 완료 ${plan.needs_judgment_item_ids.length}건`
          + ` · 갈린 판정 ${plan.conflicted_item_ids.length}건 (DB 와 전부 일치)`
          + ` · "${plan.why[2]}"`);
  }

  // ══ G6-9 status 는 완료를 말하지 않는다 ════════════════════
  {
    const r = (await mcp.tool('status', { workspace: ws.workspace_id })).result;
    const s = r.structuredContent;
    const text = r.content[0].text;
    const bytes = Buffer.byteLength(JSON.stringify(r), 'utf8');
    add('G6-9', 'status 는 기계 상태만 말하고 조사 완료를 말하지 않는다',
      !('completion' in s) && !('research_complete' in s) && typeof s.workspace_drained === 'boolean'
      && s.total === s.queued + s.leased + s.done + s.failed && bytes <= 4096
      && (!s.workspace_drained || text.includes('조사 완료라는 뜻은 아닙니다')),
      `열두 키 · 합계 ${s.total} = ${s.queued}+${s.leased}+${s.done}+${s.failed}`
      + ` · 산출물 ${s.artifact_counts.files}개 ${s.artifact_counts.bytes}바이트 · 응답 ${bytes}바이트`);
  }

  // ══ G6-10 장부와 파일이 일치 ═══════════════════════════════
  {
    const db = openWs();
    const v = verifyArtifacts(db, root);
    const exports = fs.readdirSync(path.join(root, 'exports')).filter((n) => !n.startsWith('.'));
    db.close();
    add('G6-10', 'export 를 여러 번 내도 장부와 파일이 일치하고 지난 export 가 남는다',
      v.checked === v.ok && v.orphans.length === 0 && v.manifest_missing.length === 0 && v.incomplete.length === 0
      && exports.length >= 6,
      `장부 ${v.checked}줄 전부 일치 · 고아 ${v.orphans.length} · 만들다 만 것 ${v.incomplete.length}`
      + ` · exports 폴더에 ${exports.length}개(덮어쓰지 않는다)`);
  }

  await mcp.stop();

  // ══ G6-11 LEGACY 불변 · 금지 import 0 ══════════════════════
  {
    const audit = runSuite('tests/baseline/verify-reuse-audit.mjs');
    const PROJECT = process.env.CLAUDE_PROJECT_DIR || path.resolve(TOOL_ROOT, '..', '..', '..', 'Github', 'WORK', 'GoraeUniverse', 'dibang');
    const baseline = spawnSync(process.execPath,
      [path.join(HERE, 'baseline', 'baseline.mjs'), '--verify', '--project', PROJECT],
      { cwd: TOOL_ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    add('G6-11', 'LEGACY 불변 · 금지 import 0', audit.status === 0 && baseline.status === 0,
      `재사용 감사 exit=${audit.status} · 기준선 대조 exit=${baseline.status}`);
  }

  // ══ G6-12 게이트가 밖으로 안 나갔다 ════════════════════════
  {
    const outside = [...contacted].filter((h) => !h.startsWith('127.0.0.1:'));
    add('G6-12', '게이트 자체가 127.0.0.1 밖으로 나가지 않음', outside.length === 0,
      `접촉한 곳 ${[...contacted].join(', ') || '없음'}`);
  }
} finally {
  await new Promise((r) => { fixture.on('exit', r); fixture.kill('SIGTERM'); setTimeout(r, 1500); });
}

const failed = results.filter((r) => !r.pass);
if (AS_JSON) {
  process.stdout.write(`${JSON.stringify({ gate: 6, pass: failed.length === 0, total: results.length, failed: failed.length, results }, null, 2)}\n`);
} else {
  for (const r of results) process.stdout.write(`${r.pass ? 'PASS' : 'FAIL'}  ${r.id}  ${r.title}\n        ${r.detail}\n`);
  process.stdout.write(`\n${failed.length === 0 ? 'PASS' : 'FAIL'} — ${results.length - failed.length}/${results.length}\n`);
}
process.exit(failed.length === 0 ? 0 : 1);
