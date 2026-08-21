#!/usr/bin/env node
// 게이트 0 — 기술 결정과 실패 재현이 실제로 갖춰졌는지 독립으로 판정한다.
//
//   node tests/gate0.mjs            # 전부 실행하고 판정
//   node tests/gate0.mjs --json     # 결과를 JSON 으로
//
// 하위 시험을 자식 프로세스로 돌려 실제 종료 코드를 받고, 산출물 JSON 에서 핵심 수치를
// 직접 읽어 대조한다. 자식이 "PASS" 라고 찍었다는 것만으로 통과시키지 않는다.
// 네트워크를 다시 부르지 않는다 — #6 은 보존한 증거만 본다.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PROJECT = process.env.CLAUDE_PROJECT_DIR || '/Users/taewonpark/Github/WORK/GoraeUniverse/dibang';

let networkAttempts = 0;
globalThis.fetch = (...a) => { networkAttempts++; throw new Error(`게이트 0 은 네트워크를 쓰지 않는다: ${String(a[0]).slice(0, 60)}`); };

const items = [];
const add = (id, title, pass, detail, evidence) => items.push({ id, title, pass, detail, evidence });
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

function run(label, args, { cwd = ROOT } = {}) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, args, { cwd, encoding: 'utf8', timeout: 300_000 });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  return { label, cmd: `node ${args.join(' ')}`, exit: r.status, ms: Date.now() - t0, out };
}

const runs = {};

// ── #1 frozen 기준선 ──────────────────────────────────────────

{
  runs.baseline = run('#1 baseline', ['tests/baseline/baseline.mjs', '--verify', '--project', PROJECT]);
  const saved = readJson(path.join(ROOT, 'tests/baseline/baseline.json'));
  const legacy = saved.measured.frozen.legacy;
  const crawl = saved.measured.frozen.existing_crawl_data;

  // 기준선이 말하는 값을 여기서 다시 계산한다. 저장된 숫자를 그대로 믿지 않는다.
  const byteOrder = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));
  const walk = (root) => {
    const out = [];
    const stack = [root];
    while (stack.length) {
      const dir = stack.pop();
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) stack.push(abs); else out.push(path.relative(root, abs));
      }
    }
    return out.sort(byteOrder);
  };
  const aggregate = (root, rels) => {
    let lines = '';
    for (const rel of rels) lines += `${createHash('sha256').update(fs.readFileSync(path.join(root, rel))).digest('hex')}  ${rel}\n`;
    return createHash('sha256').update(lines, 'utf8').digest('hex');
  };
  const legacyRels = walk(path.join(ROOT, 'LEGACY'));
  const legacyAgg = aggregate(path.join(ROOT, 'LEGACY'), legacyRels);

  // [기준선이 "없다" 고 적은 자리는 걷지 않는다]
  // 기존 수집 데이터는 사용자 결정으로 지웠고(2026-08-13, 62MB) 기준선도 부재로 다시 적혔다.
  // 그런데 여기서는 그 폴더를 무조건 열어 보다가 ENOENT 로 죽었다 — 재는 성질은 "1,365개가
  // 그대로인가" 가 아니라 **기준선이 말한 상태가 지금도 그대로인가** 다. 있다고 적혔으면 내용까지
  // 맞춰 보고, 없다고 적혔으면 **여전히 없어야 한다** — 되살아났다면 그것도 어긋남이다.
  const crawlRoot = path.join(PROJECT, '.claude', 'web-search');
  const crawlNow = fs.existsSync(crawlRoot);
  let crawlRels = [];
  let crawlAgg = null;
  let crawlOk;
  let crawlSaid;
  if (crawl.exists) {
    crawlRels = walk(crawlRoot);
    crawlAgg = aggregate(crawlRoot, crawlRels);
    crawlOk = crawlNow && crawlRels.length === crawl.file_count && crawlAgg === crawl.content_aggregate_sha256;
    crawlSaid = `기존 수집 데이터 ${crawlRels.length}개(기준선 ${crawl.file_count})/내용 집계 ${crawlAgg === crawl.content_aggregate_sha256 ? '일치' : '불일치'}`;
  } else {
    crawlOk = !crawlNow && crawl.file_count === 0 && crawl.content_aggregate_sha256 === null;
    crawlSaid = `기존 수집 데이터는 기준선에 부재로 적혀 있고 지금도 ${crawlNow ? '**있다(어긋남)**' : '없다'}`;
  }

  const okAll = runs.baseline.exit === 0
    && legacyRels.length === 36 && legacy.file_count === 36 && legacyAgg === legacy.aggregate_sha256
    && crawlOk;
  add('G0-1', '#1 frozen 기준선 불변', okAll,
    `baseline --verify exit ${runs.baseline.exit} · LEGACY ${legacyRels.length}개/집계 ${legacyAgg === legacy.aggregate_sha256 ? '일치' : '불일치'}`
    + ` · ${crawlSaid}`,
    { legacy_aggregate: legacyAgg, crawl_content_aggregate: crawlAgg });
}

// ── #2 공개 10개 버튼 계약 (구현 전이므로 red-state 가 통과 조건) ──

{
  // 구현이 붙기 시작하면 "공개 도구 0개" 는 기준이 못 된다. 살아남는 불변식만 본다 —
  // 실패는 아직 만들지 않은 버튼에서만 나오고, 만든 버튼은 계약을 전부 지킨다.
  runs.contractNormal = run('#2 contract', ['tests/contracts/public-tools.mjs', '--json']);
  let parsed = null;
  try { parsed = JSON.parse(runs.contractNormal.out); } catch { /* 아래에서 실패로 잡힌다 */ }
  const checks = parsed?.checks ?? [];
  const failed = checks.filter((c) => c.ok === false);
  const reasons = [...new Set(failed.map((c) => c.reason))].sort();
  const allowedReasons = ['tool_missing', 'tools_list_mismatch'];
  const listed = parsed?.listed ?? [];
  const missing = parsed?.missing ?? [];
  const allowedScopes = new Set([...missing, 'tools/list']);
  const negatives = checks.filter((c) => c.kind === 'negative');
  const implementedFailures = failed.filter((c) => listed.includes(c.scope));
  const allImplemented = missing.length === 0;

  runs.contractRed = run('#2 미구현 범위 확인',
    ['tests/contracts/public-tools.mjs', '--red-state', ...(missing.length ? ['--expect-missing', missing.join(',')] : [])]);

  const okAll = parsed !== null
    && runs.contractRed.exit === 0
    && runs.contractNormal.exit === (allImplemented ? 0 : 1)
    && (parsed?.extra ?? []).length === 0
    && reasons.every((r) => allowedReasons.includes(r))
    && failed.every((c) => allowedScopes.has(c.scope))
    && implementedFailures.length === 0
    && negatives.every((c) => c.ok === true);
  add('G0-2', '#2 계약 위반은 미구현 버튼에서만 나온다', okAll,
    `본시험 exit ${runs.contractNormal.exit} · 범위 확인 exit ${runs.contractRed.exit}`
    + ` · 구현 ${listed.length}개 [${listed.join(', ') || '없음'}] · 미구현 ${missing.length}개 · 초과 ${(parsed?.extra ?? []).length}`
    + ` · 실패 ${failed.length}건 원인 [${reasons.join(', ') || '없음'}] · 구현된 버튼 실패 ${implementedFailures.length}`
    + ` · 부정 시험 ${negatives.filter((c) => c.ok).length}/${negatives.length} 통과`,
    {
      not_product_green: '계약이 고정됐다는 뜻이지 남은 버튼이 동작한다는 뜻이 아니다.',
      at_first_pass: '게이트 0 을 처음 통과시킬 때는 공개 도구가 0개였다. 그 뒤 구현이 붙어도 같은 불변식으로 판정한다.',
    });
}

// ── #3 재사용 감사 ────────────────────────────────────────────

{
  runs.reuse = run('#3 reuse-audit', ['tests/baseline/verify-reuse-audit.mjs']);
  runs.reuseScan = run('#3 forbidden-scan', ['tests/baseline/verify-reuse-audit.mjs', '--scan']);
  const m = runs.reuse.out.match(/판정 분포: (\{[^}]*\}) · 총 (\d+)행/);
  const dist = m ? JSON.parse(m[1]) : null;
  const rows = m ? Number(m[2]) : -1;
  const okAll = runs.reuse.exit === 0 && runs.reuseScan.exit === 0
    && rows === 87 && dist?.['reuse-as-is'] === 26 && dist?.['copy-and-rewrite'] === 23 && dist?.reject === 38;
  add('G0-3', '#3 함수 단위 판정과 금지 import 0', okAll,
    `verify exit ${runs.reuse.exit} · scan exit ${runs.reuseScan.exit} · ${rows}행 · reuse ${dist?.['reuse-as-is']} / copy ${dist?.['copy-and-rewrite']} / reject ${dist?.reject}`,
    { scan_scope: 'server.mjs 와 lib/**/*.mjs · 지금은 lib/ 가 없어 실질 검사는 #8 이후' });
}

// ── #4 네 거짓 성공 사례 ──────────────────────────────────────

{
  runs.falseSuccess = run('#4 false-success', ['tests/fixtures/false-success/verify.mjs']);
  const dir = path.join(ROOT, 'tests/fixtures/false-success');
  const A = readJson(path.join(dir, 'A-status-200-error-page/case.json'));
  const B = readJson(path.join(dir, 'B-requested-final-mismatch/case.json'));
  const C = readJson(path.join(dir, 'C-visible-cards-extractor-zero/case.json'));
  const D = readJson(path.join(dir, 'D-false-complete-unvisited-112/case.json'));
  const events = fs.readFileSync(path.join(dir, 'D-false-complete-unvisited-112/input/events.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const seen = events.reduce((s, e) => s + (e.links_seen ?? 0), 0);

  const okAll = runs.falseSuccess.exit === 0
    && A.new_expectation.transport.http_status === 200
    && B.new_expectation.requested_equals_final === false
    && C.visible_card_count === 18 && C.legacy_extracted_count === 0
    && D.unvisited_discovered === 112 && seen === 112
    && D.new_expectation.status_report.workspace_drained === true;
  add('G0-4', '#4 네 거짓 성공을 로컬에서 재현', okAll,
    `verify exit ${runs.falseSuccess.exit} · A 상태 ${A.new_expectation.transport.http_status} · B requested≠final ${B.new_expectation.requested_equals_final === false}`
    + ` · C 보이는 카드 ${C.visible_card_count}/추출 ${C.legacy_extracted_count} · D 미방문 ${D.unvisited_discovered}(events 합 ${seen})`,
    { regression_names: [A, B, C, D].map((c) => c.regression_name) });
}

// ── #5 SQLite 실측 ────────────────────────────────────────────

{
  runs.sqlite = run('#5 sqlite spikes', ['tests/spikes/sqlite-wal/run-all.mjs']);
  const ws = readJson(path.join(ROOT, 'tests/spikes/sqlite-wal/results/workspace.json'));
  const pc = readJson(path.join(ROOT, 'tests/spikes/sqlite-wal/results/pace.json'));
  // [경로를 못 박지 않는다] 이 spike 는 처음에 운영용 runtime/pace.db 를 그대로 썼고 여기서도
  // 그 경로를 그대로 기대했다. 도구가 실제로 쓰이기 시작하자 spike 표가 운영 장부에 섞이고
  // "잔존 잠금 0" 검사가 남의 사용에 걸려 넘어져서, spike 를 자기 폴더로 옮겼다(2026-08-12).
  // 그러자 이 자리가 옛 경로를 단정한 채 남아 게이트가 빨간불이 됐다 — G1-13 과 같은 부류다.
  // 재려는 성질은 "그 경로에 있다" 가 아니라 **서로 다른 곳에서 온 프로세스가 한 장부를 함께 쓴다**이다.
  const paceDbShared = typeof pc.db_path === 'string'
    && path.basename(pc.db_path) === 'pace.db'
    && pc.measured.distinct_project_roots === pc.settings.workers
    && pc.measured.reservations > 0;

  // 붐빔은 실행마다 다르므로 고정 수치를 기대하지 않는다. 셈이 맞는지와 안전 성질만 본다.
  // (2026-08-12 감사: 200행 고정 기대가 붐비는 실행에서 180행을 만나 거짓 경보를 냈다.)
  const wsOk = ws.settings.workers === 10 && ws.measured.accounting_holds === true
    && ws.measured.gave_up === 0 && ws.measured.unique_canonical_url === ws.measured.rows
    && ws.measured.integrity_check === 'ok' && ws.measured.uncommitted_rows_after_kill === 0
    && ws.measured.writable_after_kill === true && ws.measured.stale_lock_files.length === 0
    && ws.measured.killed_pids.length === 2 && ws.measured.control_foreign_keys_off_accepts_orphan === true;
  const pcOk = paceDbShared && pc.settings.workers === 20
    && pc.measured.accounting_holds === true && pc.measured.gave_up === 0
    && pc.measured.distinct_project_roots === 20
    && pc.measured.duplicate_slot_index === 0 && pc.measured.duplicate_allowed_at === 0
    && pc.measured.interval_violations === 0 && pc.measured.integrity_check === 'ok'
    && pc.measured.uncommitted_after_kill === 0 && pc.measured.permanent_lock_files.length === 0
    && pc.measured.killed_pids.length === 2
    && (pc.measured.control_without_transaction.duplicate_slot_index > 0
      || pc.measured.control_without_transaction.interval_violations > 0);
  const limitOk = !!ws.limitation?.experimental && !!pc.limitation?.experimental && ws.node_version === 'v22.21.0';

  add('G0-5', '#5 내장 SQLite 가 공유 장부로 충분', runs.sqlite.exit === 0 && wsOk && pcOk && limitOk,
    `run-all exit ${runs.sqlite.exit} · workspace ${ws.settings.workers}프로세스/${ws.measured.rows}행(셈 일치 ${ws.measured.accounting_holds}, 포기 ${ws.measured.gave_up}, 물러남 ${ws.measured.sqlite_busy_retries}), 강제 종료 ${ws.measured.killed_pids.length}건, integrity ${ws.measured.integrity_check}, 잔존 잠금 ${ws.measured.stale_lock_files.length}`
    + ` · pace ${pc.settings.workers}프로세스/${pc.measured.reservations}예약, 중복 ${pc.measured.duplicate_slot_index}, 간격 위반 ${pc.measured.interval_violations}, 잔존 잠금 ${pc.measured.permanent_lock_files.length}`
    + ` · 대조(transaction 제거) 중복 ${pc.measured.control_without_transaction.duplicate_slot_index}건`,
    { pace_db_path: pc.db_path, node: ws.node_version, sqlite: ws.sqlite_version, limitation: ws.limitation.experimental });
}

// ── #6 검색 공급자 — 확정이 아니라 "미완료 결정" 으로 통과 ────

{
  runs.provider = run('#6 search-provider', ['tests/spikes/search-provider/verify.mjs']);
  const cand = readJson(path.join(ROOT, 'tests/spikes/search-provider/candidates.json'));
  const decision = fs.readFileSync(path.join(ROOT, 'tests/spikes/search-provider/decision.md'), 'utf8');
  const need = [
    /직접\s*`?search`?\s*버튼은 미완료/,
    /add_urls/,
    /제품 기능으로 아직 없다/,
    /#36`·`#37`·`#38` 은 착수할 수 없다/,
  ];
  const okAll = runs.provider.exit === 0
    && cand.candidates.length === 9
    && cand.summary.survivors.length === 0
    && cand.evidence_manifest.files.length === 17
    && cand.summary.corpus_run === false
    && need.every((re) => re.test(decision));
  add('G0-6', '#6 direct search 미완료 결정이 근거와 함께 명시', okAll,
    `verify exit ${runs.provider.exit} · 후보 ${cand.candidates.length}곳 전멸(살아남은 ${cand.summary.survivors.length}) · 증거 ${cand.evidence_manifest.files.length}개`
    + ` · corpus 실행 ${cand.summary.corpus_run} · 결정 문구 ${need.filter((re) => re.test(decision)).length}/${need.length}`,
    { decision: 'direct search 미완료 · WebSearch → add_urls 경로 유지 · #36~#38 선행 불충족' });
}

// ── 네트워크 0회 ──────────────────────────────────────────────

add('G0-7', '게이트 0 자체가 네트워크를 부르지 않음', networkAttempts === 0,
  `호출 시도 ${networkAttempts}회 (fetch 를 던지도록 바꿔 두고 셌다)`, null);

// ── 출력 ──────────────────────────────────────────────────────

const failed = items.filter((i) => !i.pass);
const report = {
  gate: 0,
  ran_at: new Date().toISOString(),
  node_version: process.version,
  project_root: PROJECT,
  items,
  runs: Object.fromEntries(Object.entries(runs).map(([k, v]) => [k, { cmd: v.cmd, exit: v.exit, ms: v.ms }])),
  verdict: failed.length === 0 ? 'PASS' : 'FAIL',
};
fs.mkdirSync(path.join(ROOT, 'tests/reports'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'tests/reports/gate0.json'), `${JSON.stringify(report, null, 2)}\n`);

if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
else {
  for (const i of items) console.log(`${i.pass ? 'PASS' : 'FAIL'}  ${i.id} ${i.title}\n      ${i.detail}`);
  console.log('\n실행한 하위 시험:');
  for (const v of Object.values(runs)) console.log(`  exit ${String(v.exit).padStart(2)} · ${String(v.ms).padStart(6)}ms · ${v.cmd}`);
}
console.log(failed.length === 0
  ? `\nPASS  게이트 0 — ${items.length}항목 전부 통과. #8 이후로 진행할 수 있다.`
  : `\nFAIL  게이트 0 — ${failed.length}항목 실패. ${failed.map((f) => f.id).join(', ')} 를 고치기 전에는 #8 을 시작하지 않는다.`);
process.exit(failed.length === 0 ? 0 : 1);
