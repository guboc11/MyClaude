#!/usr/bin/env node
// 시나리오 C 진행기 — 태스크 #46. 장애가 났을 때 되찾을 수 있는가.
//
//   node tests/e2e/scenario-c.mjs run --project <dir> --out <record.json>
//
// 이 시나리오만 **fixture 서버**를 쓴다. 일부러 멈추고 끊고 틀린 화면을 받아야 하는데,
// 그걸 남의 사이트에 대고 하는 것은 예의가 아니고, 무엇보다 같은 장애가 다시 안 난다.
// 장애는 만들어야 재현되고, 재현돼야 "되찾을 수 있다" 를 증명할 수 있다.
//
// 버튼만 부른다. 수집은 전부 collect 가 하고, 여기서는 서버를 죽이고 시계를 넘길 뿐이다.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { die, flagOf, say, startMcp, writeJson } from './mcp-client.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(HERE, '..', 'fixtures', 'server.mjs');
const argv = process.argv.slice(2);
const flag = flagOf(argv);
if (argv[0] !== 'run') die('단계: run');

const projectDir = path.resolve(flag('project') ?? die('--project 가 필요합니다'));
const outPath = flag('out') ?? die('--out 이 필요합니다');
const record = { steps: [], started_at_note: '시각은 기록하지 않는다 — 결과가 시각에 기대면 안 된다' };
const step = (n, what, detail) => { record.steps.push({ n, what, detail }); say(`${n}. ${what}\n   ${detail}`); };

// fixture 를 띄운다
const fixture = spawn(process.execPath, [FIXTURE], { stdio: ['ignore', 'pipe', 'pipe'] });
const BASE = await new Promise((res, rej) => {
  let o = '';
  const t = setTimeout(() => rej(new Error('fixture 가 안 떴다')), 5000);
  fixture.stdout.on('data', (d) => { o += d; if (o.includes('\n')) { clearTimeout(t); res(o.split('\n')[0].trim()); } });
});
const PORT = new URL(BASE).port;
const PACE = path.join(os.tmpdir(), `scenario-c-pace-${process.pid}.db`);
const ARGS = [
  `--allow-fixture-host=127.0.0.1:${PORT}`,
  `--pace-db=${PACE}`,
  '--pace-min-interval-ms=50', '--pace-jitter-ms=0', '--pace-retry-backoff-ms=50',
  `--deps-dir=${projectDir}`,
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  // ── 1. workspace 와 항목 ────────────────────────────────────
  let mcp = startMcp(projectDir, ARGS);
  await mcp.ready;
  const ws = (await mcp.tool('workspace_new', {
    topic: 'failure recovery drill',
    brief: '# 장애 복구 연습\n\n일부러 멈추고 끊고 틀린 화면을 받는다. 되찾을 수 있는지 보려는 것이다.\n'
      + '판정 이름표: 정상 · 확인 필요.\n',
  })).out;
  const root = ws.workspace_path;
  const URLS = [
    `${BASE}/static/normal`,       // 멀쩡한 것
    `${BASE}/error/soft-404`,      // 상태 200 인데 오류 화면
    `${BASE}/redirect/chain-3`,    // 세 번 넘어가는 것
    `${BASE}/hang/body`,           // 본문이 안 끝나는 것
    `${BASE}/status/500`,          // 서버 오류
  ];
  await mcp.tool('add_urls', { workspace: ws.workspace_id, source_kind: 'seed', source_value: '장애 연습', urls: URLS });
  step(1, 'workspace 와 항목 다섯', `${ws.workspace_id} · ${URLS.map((u) => new URL(u).pathname).join(' ')}`);

  // ── 2. 수집 중에 MCP 를 죽인다 ──────────────────────────────
  // 임대를 1분짜리로 낸다. 죽은 워커의 임대가 **실제로 만료되는 것**을 봐야 하는데,
  // 기본 60분으로 내면 그 장면을 못 본다.
  const lease1 = (await mcp.tool('next', { workspace: ws.workspace_id, worker_id: 'wA', count: 5, lease_minutes: 1 })).out;
  const collecting = mcp.tool('collect', {
    workspace: ws.workspace_id, lease_id: lease1.lease_id, mode: 'http', outputs: ['text'],
  }).catch((e) => ({ killed: String(e.message).slice(0, 60) }));
  await sleep(1500);                        // 몇 건 끝내고 hang 에 걸려 있을 때
  const gone = await mcp.kill('SIGKILL');
  const said = await collecting;
  step(2, '수집 중에 MCP 를 강제 종료', `임대 ${lease1.leased}건을 받아 돌던 중 SIGKILL`
    + ` · 종료 ${JSON.stringify(gone)} · 버튼은 답을 못 받았다(${said.killed ?? '응답 있음'})`);

  // ── 3. 다시 띄워 장부를 본다 ────────────────────────────────
  mcp = startMcp(projectDir, ARGS);
  await mcp.ready;
  const afterKill = (await mcp.tool('status', { workspace: ws.workspace_id })).out;
  const files = fs.readdirSync(path.join(root, 'artifacts', 'pages'), { withFileTypes: true }).length;
  step(3, '새 프로세스에서 장부가 열린다', `전체 ${afterKill.total} · 임대 ${afterKill.leased}`
    + ` · 보고 대기 ${afterKill.awaiting_report} · 산출물 ${afterKill.artifact_counts.files}개`
    + ` · 항목 폴더 ${files}개 — 죽는 순간까지 만든 것은 남아 있다`);

  // ── 4. 죽은 워커의 임대는 만료 전까지 남의 것이다 ───────────
  const early = (await mcp.tool('next', { workspace: ws.workspace_id, worker_id: 'wB', count: 5 })).out;
  step(4, '만료 전에 다음 워커가 빌리려 해 본다', `wB 가 받은 것 ${early.leased}건`
    + ' — 앞 워커가 죽었어도 그 임대는 시간이 남아 있는 동안 남의 것이다');

  // ── 5. 만료된 뒤: 늦은 보고는 거절, 일감은 돌아온다 ─────────
  await sleep(65_000);                       // 1분 임대가 실제로 지나가게 둔다
  let lateSaid = null;
  try {
    await mcp.tool('report', {
      workspace: ws.workspace_id, lease_id: lease1.lease_id, worker_id: 'wA',
      judgments: [{ item_id: '1', label: '정상', confidence: 0.9, evidence_artifact_ids: [], note: '죽었던 워커가 늦게 보낸 보고' }],
    });
    lateSaid = '받아들여졌다(그러면 안 된다)';
  } catch (e) { lateSaid = String(e.message).slice(0, 100); }
  const afterLate = (await mcp.tool('status', { workspace: ws.workspace_id })).out;
  step(5, '만료된 임대로 늦은 보고', `${lateSaid}`
    + ` · 판정은 늘지 않았다(완료 ${afterLate.done} · 판정 0)`);

  // ── 6. 돌아온 일감을 다음 워커가 이어받는다 ─────────────────
  const lease3 = (await mcp.tool('next', { workspace: ws.workspace_id, worker_id: 'wC', count: 5 })).out;
  const c3 = lease3.leased > 0
    ? (await mcp.tool('collect', {
      workspace: ws.workspace_id, lease_id: lease3.lease_id, mode: 'browser', outputs: ['text', 'screenshot'],
    })).out
    : { succeeded: 0, partial: 0, failed: 0, warnings: {} };
  step(6, '만료된 일감을 다음 워커가 이어받아 브라우저로 수집',
    `wC 가 ${lease3.leased}건 받았다(죽은 워커가 쥐고 있던 그 일감이다)`
    + ` — 성공 ${c3.succeeded} · 부분 ${c3.partial} · 실패 ${c3.failed}`
    + ` · 관찰 ${Object.entries(c3.warnings).map(([k, v]) => `${k} ${v}`).join(' · ') || '없음'}`);

  // ── 7. status 만 보고 문제를 짚는다 ─────────────────────────
  const st = (await mcp.tool('status', { workspace: ws.workspace_id })).out;
  const worst = (st.top_errors ?? []).filter((e) => e.kind === 'error');
  const pointed = worst.map((e) => ({
    stage: e.stage, code: e.code, count: e.count,
    item: e.sample?.retry_item_id ?? null, attempt: e.sample?.attempt_id ?? null,
    missing: e.sample?.missing ?? [], manifest: e.sample?.manifest ?? null,
  }));
  step(7, 'status 만 보고 문제 항목과 단계를 짚는다',
    pointed.length
      ? pointed.map((p) => `${p.stage}/${p.code}×${p.count} → item ${p.item} · ${p.attempt} · 빠진 것 ${p.missing.join('·') || '없음'}`).join(' / ')
      : '오류가 하나도 없다(이 연습에서는 나오면 안 되는 결과다)');

  // ── 8. 짚은 것만 다시 돌린다 ────────────────────────────────
  const targets = [...new Set(pointed.map((p) => p.item).filter((x) => x !== null))].map(String);
  const before = {};
  for (const id of targets) {
    const rows = (await mcp.tool('export', {
      workspace: ws.workspace_id, format: 'jsonl', fields: ['item_id', 'attempt_ids', 'artifact_paths'],
    })).out;
    const line = fs.readFileSync(path.join(root, rows.path), 'utf8').split('\n').filter(Boolean)
      .map((l) => JSON.parse(l)).find((r) => String(r.item_id) === id);
    before[id] = line;
  }
  const retried = (await mcp.tool('retry', {
    workspace: ws.workspace_id, item_ids: targets, reason: 'status 가 짚은 것만 다시',
  })).out;
  const lease4 = (await mcp.tool('next', { workspace: ws.workspace_id, worker_id: 'wD', count: 10 })).out;
  const c4 = lease4.leased > 0
    ? (await mcp.tool('collect', { workspace: ws.workspace_id, lease_id: lease4.lease_id, mode: 'http', outputs: ['text'] })).out
    : { succeeded: 0, partial: 0, failed: 0 };

  const after = {};
  const rows2 = (await mcp.tool('export', {
    workspace: ws.workspace_id, format: 'jsonl', fields: ['item_id', 'attempt_ids', 'artifact_paths'],
  })).out;
  for (const l of fs.readFileSync(path.join(root, rows2.path), 'utf8').split('\n').filter(Boolean)) {
    const r = JSON.parse(l);
    if (targets.includes(String(r.item_id))) after[String(r.item_id)] = r;
  }
  const grew = targets.map((id) => ({
    item: id,
    attempts: `${before[id]?.attempt_ids.length ?? 0} → ${after[id]?.attempt_ids.length ?? 0}`,
    kept: (before[id]?.artifact_paths ?? []).every((p) => (after[id]?.artifact_paths ?? []).includes(p)),
  }));
  step(8, '짚은 것만 다시 돌린다', `다시 대기 ${retried.requeued} · 새로 수집 성공 ${c4.succeeded}`
    + ` · ${grew.map((g) => `item ${g.item} 실행 ${g.attempts}${g.kept ? ' · 앞 증거 보존' : ' · 앞 증거 사라짐!'}`).join(' / ')}`);

  const final = (await mcp.tool('status', { workspace: ws.workspace_id })).out;
  record.final_status = final;
  record.pointed = pointed;
  record.evidence_kept = grew.every((g) => g.kept);
  record.workspace_id = ws.workspace_id;
  record.workspace_path = root;
  await mcp.stop();

  step(9, '끝난 자리', `전체 ${final.total} · 완료 ${final.done} · 실패 ${final.failed} · 대기 ${final.queued}`
    + ` · 산출물 ${final.artifact_counts.files}개 ${final.artifact_counts.bytes}바이트`);
  writeJson(outPath, record);
} finally {
  fixture.kill('SIGTERM');
  try { fs.rmSync(PACE, { force: true }); fs.rmSync(`${PACE}-wal`, { force: true }); fs.rmSync(`${PACE}-shm`, { force: true }); } catch { /* 없으면 그만 */ }
}
