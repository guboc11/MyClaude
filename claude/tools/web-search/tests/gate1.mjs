#!/usr/bin/env node
// 게이트 1 — workspace 와 URL 명부가 대량 입력에서도 안전한지 판정한다.
//
//   node tests/gate1.mjs           # 전부 실행하고 판정 (exit 0 이면 통과)
//   node tests/gate1.mjs --json
//
// 단위 시험은 자식 프로세스로 돌려 실제 종료 코드를 받고, 통합 확인은 진짜 MCP 서버를
// stdio 자식으로 띄워 버튼으로만 한다 — 내부 함수를 직접 부르면 경계를 건너뛴 시험이 된다.
// 네트워크는 쓰지 않는다.

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

let networkAttempts = 0;
globalThis.fetch = (...a) => { networkAttempts++; throw new Error(`게이트 1 은 네트워크를 쓰지 않는다: ${String(a[0]).slice(0, 60)}`); };

const items = [];
const add = (id, title, pass, detail, evidence = null) => items.push({ id, title, pass, detail, evidence });
const sha256 = (p) => createHash('sha256').update(fs.readFileSync(p)).digest('hex');

// ── 준비: 임시 git 프로젝트 ───────────────────────────────────

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'gate1-'));
const PROJECT = path.join(SANDBOX, 'project');
const OUTSIDE = path.join(SANDBOX, 'outside');
fs.mkdirSync(PROJECT, { recursive: true });
fs.mkdirSync(OUTSIDE, { recursive: true });
execFileSync('git', ['init', '-q', '.'], { cwd: PROJECT });
process.on('exit', () => { try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* 이미 없으면 그만 */ } });

// ── MCP 클라이언트 (순서를 지킨다) ────────────────────────────

function connect() {
  const child = spawn(process.execPath, [SERVER], {
    stdio: ['pipe', 'pipe', 'pipe'], cwd: PROJECT, env: { ...process.env, CLAUDE_PROJECT_DIR: PROJECT },
  });
  const pending = new Map();
  let buffer = '';
  let stderr = '';
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
      if (w) { pending.delete(msg.id); w({ msg, bytes: Buffer.byteLength(line, 'utf8') }); }
    }
  });
  child.stderr.on('data', (d) => { stderr += d; });
  return {
    request(method, params, limitMs = 60_000) {
      const id = nextId++;
      return new Promise((resolve) => {
        const t = setTimeout(() => { pending.delete(id); resolve({ msg: null, bytes: 0, timeout: true }); }, limitMs);
        pending.set(id, (v) => { clearTimeout(t); resolve(v); });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    },
    notify(method, params) { child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`); },
    stderr: () => stderr,
    close() { child.kill('SIGTERM'); },
  };
}
async function openSession() {
  const mcp = connect();
  await mcp.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'gate1', version: '1' } });
  mcp.notify('notifications/initialized');
  return mcp;
}
const call = async (mcp, name, args) => {
  const r = await mcp.request('tools/call', { name, arguments: args });
  return { result: r.msg?.result, bytes: r.bytes, timeout: r.timeout };
};

// ── 1. 단위 시험 전부 ─────────────────────────────────────────

const UNITS = ['paths', 'db', 'workspace-new', 'url', 'import', 'items', 'status'];
const unitRuns = {};
{
  const failedUnits = [];
  for (const u of UNITS) {
    const r = spawnSync(process.execPath, [path.join('tests', 'unit', `${u}.mjs`)], { cwd: ROOT, encoding: 'utf8', timeout: 300_000 });
    const out = `${r.stdout || ''}`;
    const m = out.match(/PASS\s+.*?단위 시험 (\d+)항목 통과/);
    unitRuns[u] = { exit: r.status, checks: m ? Number(m[1]) : 0 };
    if (r.status !== 0) failedUnits.push(`${u}(exit ${r.status})`);
  }
  const totalChecks = Object.values(unitRuns).reduce((n, v) => n + v.checks, 0);
  add('G1-1', '단위 시험 전부 통과', failedUnits.length === 0,
    `${UNITS.length}개 파일 · 검사 ${totalChecks}항목 · ${Object.entries(unitRuns).map(([k, v]) => `${k}:${v.checks}`).join(' ')}`
    + (failedUnits.length ? ` · 실패 ${failedUnits.join(', ')}` : ''), unitRuns);
}

// ── 2. workspace 생성과 이름 충돌 ─────────────────────────────

// [이름을 날짜로 지어내지 않는다] workspace_id 는 만든 날(KST)로 시작한다. 어제 날짜를 박아 두면
// 자정을 넘긴 다음 날 없는 폴더를 찾다 죽는다 — 2026-08-13 에 실제로 그랬다.
// 만든 쪽이 돌려준 이름을 쓰고, 모양만 본다.
let WS = null;
let wsPath = null;
{
  const mcp = await openSession();
  const made = await call(mcp, 'workspace_new', { topic: 'gate one', brief: '게이트 1 통합 확인' });
  wsPath = made.result?.structuredContent?.workspace_path;
  WS = made.result?.structuredContent?.workspace_id;
  const idOk = /^\d{4}-\d{2}-\d{2}-gate-one$/.test(WS ?? '');

  // 충돌 전 지문을 떠 둔다
  const before = { brief: sha256(path.join(wsPath, 'brief.md')), db: sha256(path.join(wsPath, 'workspace.db')) };
  const dup = await call(mcp, 'workspace_new', { topic: 'Gate One', brief: '같은 이름 다시' });
  const after = { brief: sha256(path.join(wsPath, 'brief.md')), db: sha256(path.join(wsPath, 'workspace.db')) };

  add('G1-2', '같은 이름 충돌에서 기존 파일이 변하지 않는다',
    idOk && dup.result?.isError === true && before.brief === after.brief && before.db === after.db,
    `생성 ${made.result?.structuredContent?.workspace_id} · 재생성 거절 ${dup.result?.isError}`
    + ` · brief 지문 ${before.brief === after.brief ? '그대로' : '바뀜'} · db 지문 ${before.db === after.db ? '그대로' : '바뀜'}`,
    { message: dup.result?.content?.[0]?.text?.slice(0, 90) });
  mcp.close();
}

// ── 3. URL 10,000개 — 신규·중복·출처 ──────────────────────────

const N = 10_000;
const DUP = 1_000;
{
  const mcp = await openSession();
  const lines = [];
  for (let i = 0; i < N; i++) lines.push(JSON.stringify({ url: `https://big.example.com/p/${i}?utm_source=batch` }));
  for (let i = 0; i < DUP; i++) lines.push(JSON.stringify({ url: `https://big.example.com/p/${i}?fbclid=zz` }));  // 추적만 다름 → 합쳐짐
  lines.push('{"url":"ftp://big.example.com/bad"}');                                                             // 거절
  fs.writeFileSync(path.join(wsPath, 'seed.jsonl'), `${lines.join('\n')}\n`);

  const t0 = Date.now();
  const r = await call(mcp, 'add_urls', { workspace: WS, source_kind: 'seed', source_value: 'gate1-bulk', file: 'seed.jsonl' });
  const ms = Date.now() - t0;
  const sc = r.result?.structuredContent;
  add('G1-3', 'URL 1만 건의 신규·중복·거절이 기대와 같다',
    sc?.received === N + DUP + 1 && sc?.added === N && sc?.duplicates === DUP && sc?.rejected === 1,
    `받은 것 ${sc?.received} · 새로 ${sc?.added} · 중복 ${sc?.duplicates} · 거절 ${sc?.rejected} · ${ms}ms`);
  add('G1-4', '응답에 입력 원문이 실리지 않는다', r.bytes <= 4096,
    `응답 ${r.bytes}바이트 ≤ 4096 (입력은 ${fs.statSync(path.join(wsPath, 'seed.jsonl')).size}바이트)`);

  // 출처가 다르면 item 은 그대로, sources 만 는다
  const more = await call(mcp, 'add_urls', { workspace: WS, source_kind: 'sitemap', source_value: 'https://big.example.com/sitemap.xml', urls: [
    'https://big.example.com/p/0', 'https://big.example.com/p/1', 'https://big.example.com/p/2',
  ] });
  const db = new DatabaseSync(path.join(wsPath, 'workspace.db'));
  const itemCount = db.prepare('SELECT COUNT(*) AS n FROM items').get().n;
  const sourceCount = db.prepare('SELECT COUNT(*) AS n FROM sources').get().n;
  const multi = db.prepare('SELECT COUNT(*) AS n FROM (SELECT item_id FROM sources GROUP BY item_id HAVING COUNT(*) > 1)').get().n;
  db.close();
  add('G1-5', '중복은 item 을 늘리지 않고 출처만 는다',
    more.result?.structuredContent?.added === 0 && itemCount === N && sourceCount === N + 3 && multi === 3,
    `item ${itemCount} · sources ${sourceCount} · 출처가 둘 이상인 item ${multi}개`);
  mcp.close();
}

// ── 4. 추적 병합·기능성 보존 표본 전수 ────────────────────────

{
  const S = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'url-samples.json'), 'utf8'));
  const mcp = await openSession();
  const sampleMade = await call(mcp, 'workspace_new', { topic: 'sample check', brief: '표본 전수 대조' });
  const sampleWs = sampleMade.result.structuredContent.workspace_id;
  const sampleRoot = sampleMade.result.structuredContent.workspace_path;

  const mergeUrls = S.merge_groups.flatMap((g) => g.urls);
  await call(mcp, 'add_urls', { workspace: sampleWs, source_kind: 'seed', source_value: 'merge', file: (() => {
    fs.writeFileSync(path.join(sampleRoot, 'merge.jsonl'), `${mergeUrls.map((u) => JSON.stringify({ url: u })).join('\n')}\n`);
    return 'merge.jsonl';
  })() });
  const distinctUrls = S.distinct_pairs.flatMap((p) => [p.a, p.b]);
  await call(mcp, 'add_urls', { workspace: sampleWs, source_kind: 'seed', source_value: 'distinct', file: (() => {
    fs.writeFileSync(path.join(sampleRoot, 'distinct.jsonl'), `${distinctUrls.map((u) => JSON.stringify({ url: u })).join('\n')}\n`);
    return 'distinct.jsonl';
  })() });

  const db = new DatabaseSync(path.join(sampleRoot, 'workspace.db'));
  const urls = new Set(db.prepare('SELECT canonical_url FROM items').all().map((r) => r.canonical_url));
  db.close();

  // 기대 수를 손으로 어림하지 않는다. 표본이 말하는 열쇠를 모아 그 개수와 견준다.
  // (정규화 자체가 옳은지는 단위 시험 U1~U3 이 손으로 적은 기대값으로 이미 본다.
  //  여기서 볼 것은 "같은 규칙이 MCP 를 거쳐도 적용되고, DB 가 그 열쇠로 합치는가" 다.)
  const { normalizeUrl } = await import('../lib/url.mjs');
  const expectedKeys = new Set([
    ...S.merge_groups.map((g) => g.expect),
    ...distinctUrls.map((u) => normalizeUrl(u).canonical_url),
  ]);
  const mergeOk = S.merge_groups.every((g) => urls.has(g.expect));
  const pairsSplit = S.distinct_pairs.filter((p) => normalizeUrl(p.a).canonical_url !== normalizeUrl(p.b).canonical_url).length;
  const missing = [...expectedKeys].filter((k) => !urls.has(k));
  const extra = [...urls].filter((k) => !expectedKeys.has(k));

  add('G1-6', '추적 파라미터는 합쳐지고 기능성 파라미터는 보존된다',
    mergeOk && pairsSplit === S.distinct_pairs.length && missing.length === 0 && extra.length === 0,
    `표본 ${mergeUrls.length + distinctUrls.length}개 → item ${urls.size}개 = 열쇠 ${expectedKeys.size}개`
    + ` · 합침 열쇠 ${S.merge_groups.length}개 모두 존재 ${mergeOk} · 갈려야 할 쌍 ${pairsSplit}/${S.distinct_pairs.length}`
    + ` · 빠짐 ${missing.length} · 군더더기 ${extra.length}`,
    { missing: missing.slice(0, 3), extra: extra.slice(0, 3) });
  mcp.close();
}

// ── 5. 상태 합계와 경계 거절 ──────────────────────────────────

{
  const mcp = await openSession();
  const st = await call(mcp, 'status', { workspace: WS });
  const s = st.result?.structuredContent;
  add('G1-7', '상태 합계 불변식과 4KB 상한',
    s && s.total === s.queued + s.leased + s.done + s.failed && s.total === N && st.bytes <= 4096
    && !('research_complete' in s) && s.workspace_drained === false,
    `total ${s?.total} = queued ${s?.queued} + leased ${s?.leased} + done ${s?.done} + failed ${s?.failed}`
    + ` · 응답 ${st.bytes}바이트 · workspace_drained ${s?.workspace_drained}`);

  // workspace 밖 파일과 심볼릭 링크
  const outFile = path.join(OUTSIDE, 'secret.jsonl');
  fs.writeFileSync(outFile, '{"url":"https://evil.example.com/secret"}\n');
  const abs = await call(mcp, 'add_urls', { workspace: WS, source_kind: 'import', source_value: 'x', file: outFile });
  const trav = await call(mcp, 'add_urls', { workspace: WS, source_kind: 'import', source_value: 'x', file: '../../../etc/hosts' });
  fs.symlinkSync(outFile, path.join(wsPath, 'link.jsonl'));
  const link = await call(mcp, 'add_urls', { workspace: WS, source_kind: 'import', source_value: 'x', file: 'link.jsonl' });

  const db = new DatabaseSync(path.join(wsPath, 'workspace.db'));
  const leaked = db.prepare("SELECT COUNT(*) AS n FROM items WHERE canonical_url LIKE '%evil.example.com%'").get().n;
  db.close();
  add('G1-8', 'workspace 밖 입력과 심볼릭 링크를 거절한다',
    abs.result?.isError === true && trav.result?.isError === true && link.result?.isError === true && leaked === 0,
    `절대경로 ${abs.result?.isError} · 상위 이동 ${trav.result?.isError} · 심볼릭 링크 ${link.result?.isError} · 들어간 바깥 URL ${leaked}건`,
    { messages: [abs, trav, link].map((r) => r.result?.content?.[0]?.text?.slice(0, 60)) });

  const unknownWs = await call(mcp, 'status', { workspace: '2026-08-12-no-such-workspace' });
  add('G1-9', '없는 workspace 를 0건으로 꾸미지 않는다', unknownWs.result?.isError === true,
    unknownWs.result?.content?.[0]?.text?.slice(0, 80));
  mcp.close();
}

// ── 6. 서버를 껐다 켜도 상태가 같다 ───────────────────────────

{
  const mcp = await openSession();          // 새 프로세스
  const st = await call(mcp, 'status', { workspace: WS });
  const s = st.result?.structuredContent;
  const db = new DatabaseSync(path.join(wsPath, 'workspace.db'));
  const integrity = db.prepare('PRAGMA integrity_check').get().integrity_check;
  const items2 = db.prepare('SELECT COUNT(*) AS n FROM items').get().n;
  db.close();
  add('G1-10', '재시작 뒤에도 상태가 같고 DB 가 멀쩡하다',
    s?.total === N && items2 === N && integrity === 'ok',
    `새 서버가 본 total ${s?.total} · DB item ${items2} · integrity_check ${integrity}`);

  const sidecars = fs.readdirSync(wsPath).filter((f) => /events\.jsonl|state\.json/.test(f));
  add('G1-11', '이중 장부가 없다', sidecars.length === 0,
    `workspace 파일 ${fs.readdirSync(wsPath).join(', ')}`);
  mcp.close();
}

// ── 7. git 에 노출되지 않는다 ─────────────────────────────────

{
  const targets = [
    path.relative(PROJECT, wsPath),
    path.relative(PROJECT, path.join(wsPath, 'workspace.db')),
    path.relative(PROJECT, path.join(wsPath, 'artifacts', 'pages')),
    path.relative(PROJECT, path.join(wsPath, 'exports')),
  ];
  const checks = targets.map((t) => {
    const r = spawnSync('git', ['check-ignore', '-v', t], { cwd: PROJECT, encoding: 'utf8' });
    return { target: t, ignored: r.status === 0, rule: (r.stdout || '').trim() };
  });
  const status = spawnSync('git', ['status', '--porcelain'], { cwd: PROJECT, encoding: 'utf8' }).stdout || '';
  const exposed = status.split('\n').filter((l) => l.includes('websearch-workspace'));
  add('G1-12', 'workspace 산출물이 git 에 나타나지 않는다',
    checks.every((c) => c.ignored) && exposed.length === 0,
    `check-ignore ${checks.filter((c) => c.ignored).length}/${checks.length} · git status 노출 ${exposed.length}줄`,
    { rules: checks.map((c) => c.rule) });
}

// ── 8. 계약 — 실패는 미구현 버튼에서만 ────────────────────────

// 게이트 1이 세운 세 버튼. 뒤 게이트에서 버튼이 늘어도 이 셋은 계속 있어야 한다.
const GATE1_BUTTONS = ['workspace_new', 'add_urls', 'status'];
{
  // [시점에 매이지 않기] "공개 버튼이 정확히 셋" 을 기대하면 게이트 2에서 여섯이 되는 순간 깨진다.
  // 그건 제품 결함이 아니라 시험이 그날에 못 박힌 것이다. 살아남는 불변식만 본다.
  const j = spawnSync(process.execPath, ['tests/contracts/public-tools.mjs', '--json'], { cwd: ROOT, encoding: 'utf8', timeout: 120_000 });
  let parsed = null;
  try { parsed = JSON.parse(j.stdout); } catch { /* 아래에서 잡힌다 */ }
  const listed = parsed?.listed ?? [];
  const missing = parsed?.missing ?? [];
  const checks = parsed?.checks ?? [];

  const r = spawnSync(process.execPath, ['tests/contracts/public-tools.mjs', '--red-state',
    ...(missing.length ? ['--expect-missing', missing.join(',')] : [])], { cwd: ROOT, encoding: 'utf8', timeout: 120_000 });

  const gate1Present = GATE1_BUTTONS.every((n) => listed.includes(n));
  const failedListed = checks.filter((c) => c.ok === false && listed.includes(c.scope));
  const missingAreHidden = missing.every((n) => !listed.includes(n));

  add('G1-13', '게이트 1의 세 버튼이 있고, 공개된 버튼은 모두 계약을 지킨다',
    parsed !== null && r.status === 0 && gate1Present && failedListed.length === 0
    && (parsed?.extra ?? []).length === 0 && missingAreHidden,
    `게이트 1 버튼 ${GATE1_BUTTONS.filter((n) => listed.includes(n)).length}/${GATE1_BUTTONS.length} 존재`
    + ` · 공개 ${listed.length}개 [${listed.join(', ')}] 중 계약 실패 ${failedListed.length}`
    + ` · 미구현 ${missing.length}개는 비공개 ${missingAreHidden} · 초과 ${(parsed?.extra ?? []).length}`);
}

// ── 9. frozen 기준선 ──────────────────────────────────────────

{
  const r = spawnSync(process.execPath, ['tests/baseline/baseline.mjs', '--verify', '--project', process.env.CLAUDE_PROJECT_DIR || '/Users/taewonpark/Github/WORK/GoraeUniverse/dibang'],
    { cwd: ROOT, encoding: 'utf8', timeout: 120_000 });
  const scan = spawnSync(process.execPath, ['tests/baseline/verify-reuse-audit.mjs', '--scan'], { cwd: ROOT, encoding: 'utf8' });
  add('G1-14', 'LEGACY·기존 데이터 불변, 새 코드에 금지 import 0',
    r.status === 0 && scan.status === 0,
    `기준선 exit ${r.status} · 금지 검사 exit ${scan.status} · ${(scan.stdout || '').split('\n')[0]}`);
}

add('G1-15', '게이트 1 자체가 네트워크를 부르지 않음', networkAttempts === 0, `호출 시도 ${networkAttempts}회`);

// ── 출력 ──────────────────────────────────────────────────────

const failed = items.filter((i) => !i.pass);
const report = {
  gate: 1, ran_at: new Date().toISOString(), node_version: process.version,
  sandbox_project: PROJECT, workspace: WS, urls_loaded: N, duplicates: DUP,
  unit_runs: unitRuns, items, verdict: failed.length === 0 ? 'PASS' : 'FAIL',
};
fs.mkdirSync(path.join(ROOT, 'tests/reports'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'tests/reports/gate1.json'), `${JSON.stringify(report, null, 2)}\n`);

if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
else for (const i of items) console.log(`${i.pass ? 'PASS' : 'FAIL'}  ${i.id} ${i.title}\n      ${i.detail}`);
console.log(failed.length === 0
  ? `\nPASS  게이트 1 — ${items.length}항목 전부 통과. #16 이후로 진행할 수 있다.`
  : `\nFAIL  게이트 1 — ${failed.length}항목 실패: ${failed.map((f) => f.id).join(', ')}`);
process.exit(failed.length === 0 ? 0 : 1);
