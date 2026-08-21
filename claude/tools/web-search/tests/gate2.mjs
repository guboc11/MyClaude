#!/usr/bin/env node
// 게이트 2 — 실제 MCP 프로세스 열 개에서 임대·반납·복구가 성립하는지 판정한다.
//
//   node tests/gate2.mjs [--json]
//
// 일꾼은 tests/gate2-worker.mjs — 저마다 server.mjs 를 자식으로 띄운 독립 MCP 클라이언트다.
// 시각은 DB 의 lease_expires_at 을 앞당겨 흐르게 한다. 시스템 시계를 만지지 않는다.

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SERVER = path.join(ROOT, 'server.mjs');
const WORKER = path.join(HERE, 'gate2-worker.mjs');

const WORKERS = 10;
const EACH = 100;
const TOTAL = WORKERS * EACH;
const KILL_TARGETS = 2;

let networkAttempts = 0;
globalThis.fetch = (...a) => { networkAttempts++; throw new Error(`게이트 2 는 네트워크를 쓰지 않는다: ${String(a[0]).slice(0, 60)}`); };

const items = [];
const add = (id, title, pass, detail, evidence = null) => items.push({ id, title, pass, detail, evidence });

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'gate2-'));
const PROJECT = path.join(SANDBOX, 'project');
fs.mkdirSync(PROJECT, { recursive: true });
execFileSync('git', ['init', '-q', '.'], { cwd: PROJECT });
process.on('exit', () => { try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* 이미 없으면 그만 */ } });

// ── MCP 한 통 ─────────────────────────────────────────────────

function connect() {
  const child = spawn(process.execPath, [SERVER], {
    stdio: ['pipe', 'pipe', 'pipe'], cwd: PROJECT, env: { ...process.env, CLAUDE_PROJECT_DIR: PROJECT },
  });
  const pending = new Map();
  let buffer = '';
  let nextId = 1;
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (!line) continue;
      let msg = null;
      try { msg = JSON.parse(line); } catch { continue; }
      const w = msg.id != null && pending.get(msg.id);
      if (w) { pending.delete(msg.id); w(msg); }
    }
  });
  return {
    request(method, params, limitMs = 60_000) {
      const id = nextId++;
      return new Promise((resolve) => {
        const t = setTimeout(() => { pending.delete(id); resolve(null); }, limitMs);
        pending.set(id, (m) => { clearTimeout(t); resolve(m); });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    },
    notify(m, p) { child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: m, params: p })}\n`); },
    close() { child.kill('SIGTERM'); },
  };
}
async function session() {
  const mcp = connect();
  await mcp.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'gate2', version: '1' } });
  mcp.notify('notifications/initialized');
  return mcp;
}
const call = async (mcp, name, args) => (await mcp.request('tools/call', { name, arguments: args }))?.result;

const openDbRaw = (ws) => new DatabaseSync(path.join(PROJECT, '.claude', 'websearch-workspace', ws, 'workspace.db'));

// ── 준비: workspace 둘과 URL 1,000개 ──────────────────────────

// [이름을 날짜로 지어내지 않는다] workspace_id 는 만든 날(KST)로 시작한다. 여기에 어제 날짜를
// 박아 두면 자정을 넘긴 다음 날 이 게이트가 없는 폴더를 찾다 죽는다 — 2026-08-13 에 실제로 그랬다.
// 만든 쪽이 돌려준 이름을 그대로 쓴다.
let WS = null;
let WS_OTHER = null;
let wsRoot = null;
{
  const mcp = await session();
  const a = await call(mcp, 'workspace_new', { topic: 'gate two', brief: '게이트 2 임대 검증' });
  wsRoot = a.structuredContent.workspace_path;
  WS = a.structuredContent.workspace_id;
  const other = await call(mcp, 'workspace_new', { topic: 'gate two other', brief: '다른 workspace' });
  WS_OTHER = other.structuredContent.workspace_id;

  const lines = [...Array(TOTAL)].map((_, i) => JSON.stringify({ url: `https://lease.example.com/p/${i}` }));
  fs.writeFileSync(path.join(wsRoot, 'seed.jsonl'), `${lines.join('\n')}\n`);
  const added = await call(mcp, 'add_urls', { workspace: WS, source_kind: 'seed', source_value: 'gate2', file: 'seed.jsonl' });
  add('G2-1', `URL ${TOTAL}건 준비`, added.structuredContent?.added === TOTAL,
    `새로 ${added.structuredContent?.added} · 중복 ${added.structuredContent?.duplicates} · 거절 ${added.structuredContent?.rejected}`);
  mcp.close();
}

// ── 1. 프로세스 10개가 같은 순간에 100개씩 ────────────────────

let leases = [];
{
  const startAt = Date.now() + 1200;
  const runs = await Promise.all([...Array(WORKERS)].map((_, i) => new Promise((resolve) => {
    const child = spawn(process.execPath, [WORKER,
      '--project', PROJECT, '--workspace', WS, '--worker', `w${i}`,
      '--count', String(EACH), '--start-at', String(startAt)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve({ timeout: true, out, err }); }, 60_000);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out: out.trim(), err: err.trim() }); });
  })));

  const parsed = runs.map((r) => { try { return JSON.parse(r.out.split('\n')[0]); } catch { return null; } });
  const alive = parsed.filter(Boolean);
  const errored = alive.filter((r) => r.error || r.fatal);
  leases = alive.filter((r) => r.lease_id);

  const db = openDbRaw(WS);
  const leasedCount = db.prepare("SELECT COUNT(*) AS n FROM items WHERE work_state='leased'").get().n;
  const overlap = db.prepare(`
    SELECT item_id FROM items WHERE lease_id IS NOT NULL GROUP BY item_id HAVING COUNT(DISTINCT lease_id) > 1`).all();
  const distinctLeases = db.prepare('SELECT COUNT(DISTINCT lease_id) AS n FROM items WHERE lease_id IS NOT NULL').get().n;
  db.close();

  add('G2-2', `독립 프로세스 ${WORKERS}개가 결과를 냈다`,
    alive.length === WORKERS && errored.length === 0 && runs.every((r) => !r.timeout),
    `일꾼 ${alive.length}/${WORKERS} · 오류 ${errored.length} · 대기 한도 초과 ${runs.filter((r) => r.timeout).length}`,
    { errors: errored.map((e) => e.error || e.fatal).slice(0, 3) });

  const sumLeased = leases.reduce((n, l) => n + l.leased, 0);
  add('G2-3', `합계 ${TOTAL} · 활성 임대 사이 중복 0`,
    sumLeased === TOTAL && leasedCount === TOTAL && overlap.length === 0 && distinctLeases === WORKERS,
    `일꾼 보고 합 ${sumLeased} · DB leased ${leasedCount} · 중복 item ${overlap.length} · 서로 다른 임대 ${distinctLeases}개`);

  // 작업 파일과 DB 가 같은 말을 하는가
  const fromFiles = new Map();
  for (const l of leases) {
    for (const line of fs.readFileSync(path.join(wsRoot, l.work_file), 'utf8').trim().split('\n')) {
      const rec = JSON.parse(line);
      fromFiles.set(rec.item_id, l.lease_id);
    }
  }
  const db2 = openDbRaw(WS);
  const fromDb = new Map(db2.prepare('SELECT item_id, lease_id FROM items WHERE lease_id IS NOT NULL').all().map((r) => [r.item_id, r.lease_id]));
  db2.close();
  const mismatch = [...fromFiles].filter(([id, lid]) => fromDb.get(id) !== lid);
  add('G2-4', '작업 파일과 DB 의 임대가 정확히 같다',
    fromFiles.size === TOTAL && fromDb.size === TOTAL && mismatch.length === 0,
    `파일 ${fromFiles.size}건 · DB ${fromDb.size}건 · 어긋남 ${mismatch.length}건`);
}

// ── 2. 두 프로세스를 강제 종료하고 그 항목만 재배정 ───────────

{
  const startAt = Date.now() + 600;
  const held = [];
  for (let i = 0; i < KILL_TARGETS; i++) {
    // 큐가 비었으니 먼저 두 임대를 회수해 대상을 만든다 — 만료 시각을 앞당겨 시간이 흐른 셈 친다.
    const db = openDbRaw(WS);
    const victim = leases[i].lease_id;
    db.prepare('UPDATE items SET lease_expires_at = ? WHERE lease_id = ?').run(Date.now() - 1000, victim);
    db.close();

    const child = spawn(process.execPath, [WORKER,
      '--project', PROJECT, '--workspace', WS, '--worker', `killme${i}`,
      '--count', String(EACH), '--lease-minutes', '60', '--start-at', String(startAt + (i * 300)), '--hold'],
    { stdio: ['ignore', 'pipe', 'pipe'] });
    const first = await new Promise((resolve) => {
      let out = '';
      const t = setTimeout(() => resolve(null), 30_000);
      child.stdout.on('data', (d) => { out += d; if (out.includes('\n')) { clearTimeout(t); resolve(JSON.parse(out.split('\n')[0])); } });
    });
    held.push({ child, first });
  }

  const heldOk = held.every((h) => h.first?.lease_id && h.first.leased === EACH);
  const heldLeaseIds = held.map((h) => h.first?.lease_id);
  const heldItemIds = new Set();
  for (const h of held) {
    for (const line of fs.readFileSync(path.join(wsRoot, h.first.work_file), 'utf8').trim().split('\n')) {
      heldItemIds.add(JSON.parse(line).item_id);
    }
  }
  for (const h of held) h.child.kill('SIGKILL');
  await new Promise((r) => setTimeout(r, 500));

  // 죽은 워커의 임대를 만료시켜 시간이 흐른 것으로 만든다
  const db = openDbRaw(WS);
  const expiredAt = Date.now() - 1;
  for (const lid of heldLeaseIds) db.prepare('UPDATE items SET lease_expires_at = ? WHERE lease_id = ?').run(expiredAt, lid);
  const beforeOther = db.prepare("SELECT lease_id, COUNT(*) AS n FROM items WHERE work_state='leased' AND lease_id NOT IN (?, ?) GROUP BY lease_id").all(...heldLeaseIds);
  db.close();

  const mcp = await session();
  const re = await call(mcp, 'next', { workspace: WS, worker_id: 'rescuer', count: 100 });
  const reassigned = new Set(fs.readFileSync(path.join(wsRoot, re.structuredContent.work_file), 'utf8').trim().split('\n').map((l) => JSON.parse(l).item_id));
  const db2 = openDbRaw(WS);
  const afterOther = db2.prepare("SELECT lease_id, COUNT(*) AS n FROM items WHERE work_state='leased' AND lease_id NOT IN (?, ?, ?) GROUP BY lease_id").all(...heldLeaseIds, re.structuredContent.lease_id);
  const overlap2 = db2.prepare('SELECT item_id FROM items WHERE lease_id IS NOT NULL GROUP BY item_id HAVING COUNT(DISTINCT lease_id) > 1').all();
  db2.close();

  const onlyVictims = [...reassigned].every((id) => heldItemIds.has(id));
  const othersUntouched = JSON.stringify(beforeOther) === JSON.stringify(afterOther);
  add('G2-5', '강제 종료된 워커의 항목만 재배정된다',
    heldOk && re.structuredContent.leased === 100 && onlyVictims && othersUntouched && overlap2.length === 0,
    `과녁 ${KILL_TARGETS}개 임대 ${heldOk ? '성립' : '실패'} · 재배정 ${re.structuredContent.leased}건 모두 과녁 것 ${onlyVictims}`
    + ` · 다른 임대 ${afterOther.length}개 그대로 ${othersUntouched} · 중복 ${overlap2.length}`);
  mcp.close();
}

// ── 3. 늦은 report·중복 report·다른 workspace ─────────────────

{
  const mcp = await session();
  const lease = await call(mcp, 'next', { workspace: WS, worker_id: 'reporter', count: 3 });
  const leaseId = lease.structuredContent.lease_id;
  const ids = fs.readFileSync(path.join(wsRoot, lease.structuredContent.work_file), 'utf8').trim().split('\n').map((l) => JSON.parse(l).item_id);

  // collect 는 아직 없다(#26~28). 수집 기록을 손으로 만들어 report 의 앞길만 연다.
  const db = openDbRaw(WS);
  for (const id of ids) {
    db.prepare('INSERT INTO attempts (attempt_id, item_id, operation, collector, result, started_at) VALUES (?,?,?,?,?,?)')
      .run(`g2-att-${id}`, id, 'collect', 'http', 'success', Date.now());
    db.prepare('UPDATE items SET collected_at = ? WHERE item_id = ?').run(Date.now(), id);
  }
  db.close();

  const j = ids.map((id) => ({ item_id: id, label: null, confidence: null, evidence_artifact_ids: [], note: '판정 미정' }));
  const first = await call(mcp, 'report', { workspace: WS, lease_id: leaseId, worker_id: 'reporter', judgments: j });
  const second = await call(mcp, 'report', { workspace: WS, lease_id: leaseId, worker_id: 'reporter', judgments: j });
  const db2 = openDbRaw(WS);
  const judgmentRows = db2.prepare('SELECT COUNT(*) AS n FROM judgments').get().n;
  const reportRows = db2.prepare('SELECT COUNT(*) AS n FROM reports').get().n;
  const doneRows = db2.prepare("SELECT COUNT(*) AS n FROM items WHERE work_state='done'").get().n;
  db2.close();
  add('G2-6', '같은 report 두 번 중 한 번만 반영된다',
    first.structuredContent?.accepted === 3 && second.structuredContent?.accepted === 3
    && judgmentRows === 3 && reportRows === 1 && doneRows === 3,
    `1차 반영 ${first.structuredContent?.accepted} · 2차 ${second.structuredContent?.accepted}(같은 셈) · 판정 행 ${judgmentRows} · report 기록 ${reportRows} · done ${doneRows}`);

  // 반납된 임대에 **다른** 보고를 보낸다. 같은 보고는 멱등 경로라 같은 답을 주는 것이 맞고,
  // 여기서 볼 것은 "처음 보는 요청이 죽은 임대로 오면 거절되는가" 다.
  const different = j.map((x) => ({ ...x, note: '다른 판정' }));
  const late = await call(mcp, 'report', { workspace: WS, lease_id: leaseId, worker_id: 'reporter', judgments: different });
  const dbLate = openDbRaw(WS);
  const judgmentsAfterLate = dbLate.prepare('SELECT COUNT(*) AS n FROM judgments').get().n;
  dbLate.close();
  add('G2-7', '반납된 임대로 온 새 report 는 거절되고 아무것도 안 바뀐다',
    late.isError === true && judgmentsAfterLate === judgmentRows,
    `${late.content?.[0]?.text?.slice(0, 70)} · 판정 ${judgmentRows}→${judgmentsAfterLate}`);

  // 다른 workspace 에 같은 lease_id 로
  const cross = await call(mcp, 'report', { workspace: WS_OTHER, lease_id: leaseId, worker_id: 'reporter', judgments: j });
  const dbOther = openDbRaw(WS_OTHER);
  const otherJ = dbOther.prepare('SELECT COUNT(*) AS n FROM judgments').get().n;
  dbOther.close();
  add('G2-8', '다른 workspace 의 lease_id 를 받지 않는다', cross.isError === true && otherJ === 0,
    `${cross.content?.[0]?.text?.slice(0, 70)} · 저쪽 판정 ${otherJ}건`);
  mcp.close();
}

// ── 4. retry 전후 증거 보존 ───────────────────────────────────

{
  const mcp = await session();
  const db = openDbRaw(WS);
  const doneIds = db.prepare("SELECT item_id FROM items WHERE work_state='done' ORDER BY item_id").all().map((r) => r.item_id);
  const attemptsBefore = db.prepare('SELECT attempt_id, item_id, result FROM attempts ORDER BY attempt_id').all();
  const judgmentsBefore = db.prepare('SELECT COUNT(*) AS n FROM judgments').get().n;
  const fingerprintBefore = createHash('sha256').update(JSON.stringify(attemptsBefore)).digest('hex');
  db.close();

  const r = await call(mcp, 'retry', { workspace: WS, item_ids: doneIds.map(String), reason: '게이트 2 재시도 확인' });

  const db2 = openDbRaw(WS);
  const attemptsAfter = db2.prepare('SELECT attempt_id, item_id, result FROM attempts ORDER BY attempt_id').all();
  const fingerprintAfter = createHash('sha256').update(JSON.stringify(attemptsAfter)).digest('hex');
  const judgmentsAfter = db2.prepare('SELECT COUNT(*) AS n FROM judgments').get().n;
  const backToQueue = db2.prepare("SELECT COUNT(*) AS n FROM items WHERE work_state='queued' AND item_id IN (SELECT item_id FROM retries)").get().n;
  const history = db2.prepare('SELECT COUNT(*) AS n FROM retries').get().n;
  db2.close();

  add('G2-9', 'retry 뒤에도 attempts·판정 지문이 그대로다',
    r.structuredContent.requeued === doneIds.length && fingerprintBefore === fingerprintAfter
    && judgmentsBefore === judgmentsAfter && backToQueue === doneIds.length && history === doneIds.length,
    `다시 대기 ${r.structuredContent.requeued} · attempts 지문 ${fingerprintBefore === fingerprintAfter ? '동일' : '변함'}`
    + ` · 판정 ${judgmentsBefore}→${judgmentsAfter} · 이력 ${history}건`);

  const badRetry = await call(mcp, 'retry', { workspace: WS, item_ids: ['999999'], reason: '없는 번호' });
  add('G2-10', '다른 장부의 번호는 되돌리지 않는다',
    badRetry.structuredContent?.requeued === 0 && badRetry.structuredContent?.rejected === 1,
    badRetry.content?.[0]?.text?.slice(0, 90));
  mcp.close();
}

// ── 5. 상태와 계약 ────────────────────────────────────────────

{
  const mcp = await session();
  const st = await call(mcp, 'status', { workspace: WS });
  const s = st.structuredContent;
  const db = openDbRaw(WS);
  const dbCounts = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM items) AS total,
      (SELECT COUNT(*) FROM items WHERE work_state='queued') AS queued,
      (SELECT COUNT(*) FROM items WHERE work_state='leased') AS leased,
      (SELECT COUNT(*) FROM items WHERE work_state='done') AS done,
      (SELECT COUNT(*) FROM items WHERE work_state='failed') AS failed`).get();
  db.close();
  add('G2-11', 'status 가 DB 와 같은 말을 하고 합계가 맞는다',
    s.total === dbCounts.total && s.queued === dbCounts.queued && s.leased === dbCounts.leased
    && s.done === dbCounts.done && s.failed === dbCounts.failed
    && s.total === s.queued + s.leased + s.done + s.failed && s.total === TOTAL,
    `total ${s.total} = ${s.queued}+${s.leased}+${s.done}+${s.failed} · 보고 대기 ${s.awaiting_report} · 만료 임대 ${s.expired_leases}`);
  mcp.close();
}
{
  // 게이트 2가 세운 버튼들. 뒤 게이트에서 더 늘어도 이것들은 계속 있어야 한다.
  // "정확히 여섯" 을 기대하면 collect·export 가 붙는 순간 시험이 그날에 못 박혀 깨진다.
  const GATE2_BUTTONS = ['workspace_new', 'add_urls', 'next', 'report', 'retry', 'status'];
  const j = spawnSync(process.execPath, ['tests/contracts/public-tools.mjs', '--json'], { cwd: ROOT, encoding: 'utf8', timeout: 120_000 });
  let parsed = null;
  try { parsed = JSON.parse(j.stdout); } catch { /* 아래에서 잡힌다 */ }
  const listed = parsed?.listed ?? [];
  const missing = parsed?.missing ?? [];
  const r = spawnSync(process.execPath, ['tests/contracts/public-tools.mjs', '--red-state',
    ...(missing.length ? ['--expect-missing', missing.join(',')] : [])], { cwd: ROOT, encoding: 'utf8', timeout: 120_000 });
  const present = GATE2_BUTTONS.every((n) => listed.includes(n));
  const failedListed = (parsed?.checks ?? []).filter((c) => c.ok === false && listed.includes(c.scope));
  add('G2-12', '게이트 2의 여섯 버튼이 있고, 공개된 버튼은 모두 계약을 지킨다',
    parsed !== null && r.status === 0 && present && failedListed.length === 0 && (parsed?.extra ?? []).length === 0
    && missing.every((n) => !listed.includes(n)),
    `게이트 2 버튼 ${GATE2_BUTTONS.filter((n) => listed.includes(n)).length}/${GATE2_BUTTONS.length} 존재`
    + ` · 공개 ${listed.length}개 [${listed.join(', ')}] 중 계약 실패 ${failedListed.length} · 미구현 ${missing.length}개는 비공개`);
}
{
  const unit = spawnSync(process.execPath, ['tests/unit/lease.mjs'], { cwd: ROOT, encoding: 'utf8', timeout: 300_000 });
  const m = (unit.stdout || '').match(/단위 시험 (\d+)항목 통과/);
  add('G2-13', '임대·보고·재시도 단위 시험', unit.status === 0, `exit ${unit.status} · ${m ? `${m[1]}항목` : '수치 못 읽음'}`);
  const base = spawnSync(process.execPath, ['tests/baseline/baseline.mjs', '--verify', '--project',
    process.env.CLAUDE_PROJECT_DIR || '/Users/taewonpark/Github/WORK/GoraeUniverse/dibang'], { cwd: ROOT, encoding: 'utf8' });
  const scan = spawnSync(process.execPath, ['tests/baseline/verify-reuse-audit.mjs', '--scan'], { cwd: ROOT, encoding: 'utf8' });
  add('G2-14', 'LEGACY 불변 · 금지 import 0', base.status === 0 && scan.status === 0,
    `기준선 exit ${base.status} · 금지 검사 exit ${scan.status}`);
}

add('G2-15', '게이트 2 자체가 네트워크를 부르지 않음', networkAttempts === 0, `호출 시도 ${networkAttempts}회`);

// ── 출력 ──────────────────────────────────────────────────────

const failed = items.filter((i) => !i.pass);
const report = {
  gate: 2, ran_at: new Date().toISOString(), node_version: process.version,
  sandbox_project: PROJECT, workspace: WS, workers: WORKERS, each: EACH, total: TOTAL,
  items, verdict: failed.length === 0 ? 'PASS' : 'FAIL',
};
fs.mkdirSync(path.join(ROOT, 'tests/reports'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'tests/reports/gate2.json'), `${JSON.stringify(report, null, 2)}\n`);

if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
else for (const i of items) console.log(`${i.pass ? 'PASS' : 'FAIL'}  ${i.id} ${i.title}\n      ${i.detail}`);
console.log(failed.length === 0
  ? `\nPASS  게이트 2 — ${items.length}항목 전부 통과. #22 이후로 진행할 수 있다.`
  : `\nFAIL  게이트 2 — ${failed.length}항목 실패: ${failed.map((f) => f.id).join(', ')}`);
process.exit(failed.length === 0 ? 0 : 1);
