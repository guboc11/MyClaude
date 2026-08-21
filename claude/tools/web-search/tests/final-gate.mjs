#!/usr/bin/env node
// 최종 게이트 — 태스크 #49.
//
//   node tests/final-gate.mjs --project <프로젝트>
//   node tests/final-gate.mjs --project <프로젝트> --json
//   node tests/final-gate.mjs --project <프로젝트> --skip-rerun     (집계만 다시)
//
// 재는 것은 구현량이 아니라 **계획서 1-2 의 열 가지 완료 조건**이다. 조건마다 근거를 어디서
// 가져왔는지 함께 남긴다 — 통과했다는 말만 있고 무엇을 보고 그렇게 말했는지가 없으면,
// 그 문장은 나중에 아무 힘이 없다.
//
// 하나라도 못 채우면 "개발 완료" 라고 쓰지 않는다. 대신 못 채운 조건과 그 태스크 번호,
// 다시 돌려 볼 명령을 남긴다.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { verifyArtifacts } from '../lib/artifacts.mjs';
import { openDb } from '../lib/db.mjs';
import { PUBLIC_TOOL_NAMES } from '../lib/tool-schemas.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOL_ROOT = path.resolve(HERE, '..');
const AS_JSON = process.argv.includes('--json');
const SKIP_RERUN = process.argv.includes('--skip-rerun');
const flag = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};
const PROJECT = path.resolve(flag('project') ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd());
const WS_PARENT = path.join(PROJECT, '.claude', 'websearch-workspace');
// [날짜로 지어내지 않는다] workspace 이름은 만든 날로 시작한다. 날짜를 박으면 다음 날 못 찾는다.
const findWorkspace = (suffix) => {
  const dirs = fs.existsSync(WS_PARENT) ? fs.readdirSync(WS_PARENT).filter((d) => d.endsWith(suffix)).sort() : [];
  return dirs[dirs.length - 1] ?? `(못 찾음: *${suffix})`;
};
const WORKSPACES = [
  { key: 'A', id: findWorkspace('-wedding-candidates-worldwide'), what: '후보 사이트 찾기(5개 언어)' },
  { key: 'B', id: findWorkspace('-barunson-mcard-deep'), what: '한 판매 도메인 깊게' },
  { key: 'C', id: findWorkspace('-failure-recovery-drill'), what: '장애 복구 연습' },
];

// ── 1. 깨끗한 상태에서 다시 돌린다 ────────────────────────────
// 게이트 5 는 exit 2 가 정상이다 — 잴 대상(확정 검색 공급자)이 없다는 뜻이고, 그것이 확정 결론이다.
const RERUN = [
  { name: '계약', cmd: ['tests/contracts/public-tools.mjs'], expect: [0, 1], note: 'search 한 곳에서만 실패(미구현)' },
  ...[0, 1, 2, 3, 4].map((n) => ({ name: `게이트 ${n}`, cmd: [`tests/gate${n}.mjs`], expect: [0] })),
  { name: '게이트 5', cmd: ['tests/gate5.mjs'], expect: [2], note: 'BLOCKED — 잴 대상 없음' },
  { name: '게이트 6', cmd: ['tests/gate6.mjs'], expect: [0] },
  { name: '게이트 7', cmd: ['tests/gate7.mjs', '--project', PROJECT], expect: [0] },
  { name: '전환·smoke', cmd: ['tests/transition/verify.mjs', '--project', PROJECT], expect: [0] },
];

const runs = [];
if (!SKIP_RERUN) {
  for (const r of RERUN) {
    const t0 = Date.now();
    const out = spawnSync(process.execPath, r.cmd.map((c, i) => (i === 0 ? path.join(TOOL_ROOT, c) : c)), {
      cwd: TOOL_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, CLAUDE_PROJECT_DIR: PROJECT, WEBSEARCH_DEPS_DIR: PROJECT },
    });
    runs.push({
      name: r.name, command: `node ${r.cmd.join(' ')}`, exit: out.status,
      expected: r.expect, ok: r.expect.includes(out.status), seconds: Math.round((Date.now() - t0) / 1000),
      note: r.note ?? null,
    });
  }
}

// ── 2. 실제 수치를 장부에서 긁는다 ────────────────────────────
const tally = [];
for (const w of WORKSPACES) {
  const root = path.join(WS_PARENT, w.id);
  if (!fs.existsSync(path.join(root, 'workspace.db'))) { tally.push({ ...w, missing: true }); continue; }
  const db = openDb(root, path.join(root, 'workspace.db'));
  try {
    const one = (s, ...a) => db.prepare(s).get(...a);
    const all = (s, ...a) => db.prepare(s).all(...a);
    const v = verifyArtifacts(db, root);
    tally.push({
      ...w,
      root,
      items: one('SELECT COUNT(*) AS n FROM items').n,
      states: Object.fromEntries(all('SELECT work_state, COUNT(*) AS n FROM items GROUP BY work_state').map((r) => [r.work_state, r.n])),
      domains: one('SELECT COUNT(DISTINCT domain) AS n FROM items').n,
      sources: one('SELECT COUNT(*) AS n FROM sources').n,
      duplicate_sources: one('SELECT COUNT(*) AS n FROM sources').n - one('SELECT COUNT(*) AS n FROM items').n,
      workers: one('SELECT COUNT(DISTINCT worker_id) AS n FROM judgments').n,
      // 지금 살아 있는 임대가 아니라 **여태 나간 임대**를 센다. 워커가 몇 번 나눠 가져갔는지가
      // 알고 싶은 것이고, 그 기록은 임대마다 남긴 작업 목록 파일에 있다.
      leases_ever: fs.existsSync(path.join(root, 'artifacts', 'leases'))
        ? fs.readdirSync(path.join(root, 'artifacts', 'leases')).filter((f) => f.endsWith('.jsonl')).length : 0,
      leases_live: one('SELECT COUNT(DISTINCT lease_id) AS n FROM items WHERE lease_id IS NOT NULL').n,
      attempts: Object.fromEntries(all('SELECT COALESCE(result, ?) AS r, COUNT(*) AS n FROM attempts GROUP BY r', '안 끝남').map((r) => [r.r, r.n])),
      artifacts: Object.fromEntries(all('SELECT kind, COUNT(*) AS n, SUM(byte_size) AS b FROM artifacts GROUP BY kind').map((r) => [r.kind, { files: r.n, bytes: r.b }])),
      artifact_bytes: one('SELECT COALESCE(SUM(byte_size), 0) AS b FROM artifacts').b,
      judgments: one('SELECT COUNT(*) AS n FROM judgments').n,
      abstained: one('SELECT COUNT(*) AS n FROM judgments WHERE label IS NULL').n,
      retries: one('SELECT COUNT(*) AS n FROM retries').n,
      errors: Object.fromEntries(all('SELECT error_stage AS s, error_code AS c, COUNT(*) AS n FROM attempts WHERE result = ? GROUP BY s, c', 'failed').map((r) => [`${r.s}/${r.c}`, r.n])),
      warnings: Object.fromEntries(all('SELECT j.value AS w, COUNT(*) AS n FROM attempts a, json_each(a.warning_codes) j WHERE a.warning_codes IS NOT NULL GROUP BY w ORDER BY n DESC').map((r) => [r.w, r.n])),
      ledger: { checked: v.checked, ok: v.ok, orphans: v.orphans.length, incomplete: v.incomplete.length, manifest_missing: v.manifest_missing.length },
    });
  } finally { db.close(); }
}
const live = tally.filter((t) => !t.missing);
const sum = (f) => live.reduce((n, t) => n + f(t), 0);

// ── 3. 표본에서 파일과 출처 URL 이 잘못 이어졌는지 ────────────
const sample = { checked: 0, wrong: [] };
for (const t of live) {
  const db = openDb(t.root, path.join(t.root, 'workspace.db'));
  try {
    const rows = db.prepare(`
      SELECT a.path, a.byte_size, a.sha256, t2.attempt_id, t2.item_id, t2.requested_url, i.canonical_url
        FROM artifacts a
        JOIN attempts t2 ON t2.attempt_id = a.attempt_id
        JOIN items i ON i.item_id = t2.item_id
       ORDER BY a.artifact_id`).all();
    const step = Math.max(1, Math.floor(rows.length / 15));
    for (const r of rows.filter((_, i) => i % step === 0).slice(0, 15)) {
      sample.checked++;
      const abs = path.join(t.root, r.path);
      if (!fs.existsSync(abs)) { sample.wrong.push(`${t.key} ${r.path} 파일 없음`); continue; }
      const buf = fs.readFileSync(abs);
      if (buf.length !== r.byte_size || createHash('sha256').update(buf).digest('hex') !== r.sha256) {
        sample.wrong.push(`${t.key} ${r.path} 크기·지문 다름`); continue;
      }
      // 경로에 박힌 item 번호가 실제 그 item 인가 — 자리 자체가 되짚기의 일부다.
      const inPath = r.path.match(/artifacts\/pages\/(\d+)\//);
      if (inPath && Number(inPath[1]) !== r.item_id) { sample.wrong.push(`${t.key} ${r.path} 경로의 item 번호가 다름`); continue; }
      const mf = path.join(t.root, 'artifacts', 'pages', String(r.item_id), r.attempt_id, 'manifest.json');
      if (fs.existsSync(mf)) {
        const doc = JSON.parse(fs.readFileSync(mf, 'utf8'));
        if (doc.requested_url !== r.requested_url) sample.wrong.push(`${t.key} ${r.path} 요약 URL 불일치`);
        else if (doc.requested_url !== r.canonical_url) sample.wrong.push(`${t.key} ${r.path} item 주소와 요청 주소 불일치`);
      }
    }
  } finally { db.close(); }
}

// ── 4. 계획서 1-2 의 열 조건 ──────────────────────────────────
const reportsHave = (f) => fs.existsSync(path.join(HERE, 'reports', f));
const gateOk = (name) => !SKIP_RERUN && runs.find((r) => r.name === name)?.ok === true;
const allRerunOk = !SKIP_RERUN && runs.every((r) => r.ok);

const CONDITIONS = [
  {
    id: 'P1', text: '실제 MCP 클라이언트 여러 개가 같은 workspace 를 사용한다',
    met: live.some((t) => t.workers >= 2) && gateOk('게이트 2'),
    evidence: `판정한 워커 ${live.map((t) => `${t.key} ${t.workers}명`).join('·')} · 게이트 2(10개 MCP 프로세스)`,
  },
  {
    id: 'P2', text: '활성 임대가 겹치지 않고 워커 종료 뒤 작업이 유실되지 않는다',
    met: gateOk('게이트 2') && gateOk('게이트 7') && reportsHave('scenario-c.md'),
    evidence: '게이트 2·7 · 시나리오 C(강제 종료 뒤 산출물 3개 보존, 만료 뒤 회수 5건)',
  },
  {
    id: 'P3', text: 'URL 1,000개 이상에서 상태 합계와 실제 항목 수가 정확히 맞는다',
    met: gateOk('게이트 1'),
    evidence: '게이트 1(1,000+ URL) · status-full 시험(item 1,200개, 응답 3.3KB)',
  },
  {
    id: 'P4', text: '요청한 산출물만 만들어지고 긴 내용은 MCP 응답에 섞이지 않는다',
    met: gateOk('게이트 3') && gateOk('게이트 6'),
    evidence: '게이트 3(산출물 5종·요청한 것만) · 게이트 6(버튼 응답 4KB 이내)',
  },
  {
    id: 'P5', text: '임의 표본에서 파일과 출처 URL 이 잘못 연결된 사례가 0건이다',
    met: sample.wrong.length === 0 && sample.checked >= 30,
    evidence: `표본 ${sample.checked}개 · 어긋남 ${sample.wrong.length}건`,
  },
  {
    id: 'P6', text: '상태 200 오류 화면·리다이렉트·타임아웃·차단을 짧은 상태 보고에서 구분할 수 있다',
    met: gateOk('게이트 3') && live.some((t) => Object.keys(t.warnings).length >= 4),
    evidence: `관찰 낱말 ${[...new Set(live.flatMap((t) => Object.keys(t.warnings)))].length}가지가 실전에서 실제로 붙었다`,
  },
  {
    id: 'P7', text: '한 항목 재시도 시 이전 원본은 보존되고 새 실행이 별도 기록된다',
    met: sum((t) => t.retries) > 0 && gateOk('게이트 2') && reportsHave('scenario-c.md'),
    evidence: `다시 대기 ${sum((t) => t.retries)}건 · 시나리오 C(실행 2→3, 앞 증거 보존)`,
  },
  {
    id: 'P8', text: '후보 사이트 찾기와 한 도메인 깊게 수집하기 두 실전 시나리오가 모두 통과한다',
    met: reportsHave('scenario-a.md') && reportsHave('scenario-b.md') && gateOk('게이트 7'),
    evidence: 'scenario-a.md(업체 63곳) · scenario-b.md(한 도메인 92곳) · 게이트 7 감사 14항목',
  },
  {
    id: 'P9', text: '직접 검색 버튼은 검증된 검색 방식 하나가 실제로 작동해야 완료로 표시한다',
    met: false,
    evidence: '무키 공급자 9곳 전멸 — 작동하는 방식이 없어 이 버튼을 완료로 표시하지 않는다'
      + '(tests/spikes/search-provider/decision.md · tests/reports/gate5.md)',
    blocked_by: ['#36', '#37', '#38'],
  },
  {
    id: 'P10', text: '상품 카드 자동 인식이나 의미 기반 완료 판정 없이도 목표 작업이 가능하다',
    met: gateOk('게이트 6') && gateOk('게이트 7') && reportsHave('scenario-a.md'),
    evidence: '게이트 6(상위 역할이 export·status 만으로 다음 묶음 결정) · 게이트 7 G7-10(기계가 완료를 말하지 않음)',
  },
];

// [안 잰 것을 못 채운 것으로 적지 않는다] --skip-rerun 은 집계만 다시 하는 자리다.
// 그때 게이트를 안 돌렸으니 조건 대부분은 **판정할 수 없다** — 그걸 "미달" 로 적으면
// 이 보고가 거짓말을 한다.
const unmet = SKIP_RERUN ? [] : CONDITIONS.filter((c) => !c.met);
const verdict = SKIP_RERUN ? 'NOT_JUDGED' : (allRerunOk && unmet.length === 0 ? 'COMPLETE' : 'INCOMPLETE');

// ── 5. 내보내기 ───────────────────────────────────────────────
const summary = {
  verdict,
  checked_at_note: '수치는 이 실행에서 장부와 파일을 직접 읽은 값이다',
  buttons: { contract: PUBLIC_TOOL_NAMES.length, listed: PUBLIC_TOOL_NAMES.length - 1, not_built: ['search'] },
  reruns: runs,
  totals: {
    workspaces: live.length,
    items: sum((t) => t.items),
    domains: sum((t) => t.domains),
    sources: sum((t) => t.sources),
    workers: live.map((t) => t.workers),
    leases_ever: sum((t) => t.leases_ever),
    leases_live: sum((t) => t.leases_live),
    attempts: live.reduce((acc, t) => {
      for (const [k, n] of Object.entries(t.attempts)) acc[k] = (acc[k] ?? 0) + n;
      return acc;
    }, {}),
    artifacts: live.reduce((acc, t) => {
      for (const [k, v] of Object.entries(t.artifacts)) {
        acc[k] = acc[k] ?? { files: 0, bytes: 0 };
        acc[k].files += v.files; acc[k].bytes += v.bytes;
      }
      return acc;
    }, {}),
    artifact_bytes: sum((t) => t.artifact_bytes),
    judgments: sum((t) => t.judgments),
    abstained: sum((t) => t.abstained),
    retries: sum((t) => t.retries),
    ledger_checked: sum((t) => t.ledger.checked),
    ledger_ok: sum((t) => t.ledger.ok),
    ledger_orphans: sum((t) => t.ledger.orphans),
  },
  per_workspace: tally,
  sample,
  conditions: CONDITIONS,
  unmet: unmet.map((c) => ({ id: c.id, text: c.text, blocked_by: c.blocked_by ?? [] })),
};

if (AS_JSON) {
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
} else {
  const w = (s) => process.stdout.write(`${s}\n`);
  w('── 다시 돌린 것 ─────────────────────────────');
  for (const r of runs) w(`${r.ok ? 'OK  ' : 'FAIL'} ${r.name.padEnd(10)} exit ${String(r.exit).padStart(2)} (기대 ${r.expected.join('|')}) ${r.seconds}초${r.note ? ` — ${r.note}` : ''}`);
  if (SKIP_RERUN) w('(--skip-rerun: 다시 돌리지 않음)');
  w('');
  w('── 실측 ─────────────────────────────────────');
  w(`workspace ${summary.totals.workspaces}곳 · item ${summary.totals.items}개 · 도메인 ${summary.totals.domains}곳 · 출처 ${summary.totals.sources}줄`);
  w(`판정한 워커 ${summary.totals.workers.join('·')}명 · 여태 나간 임대 ${summary.totals.leases_ever}건(지금 살아 있는 것 ${summary.totals.leases_live}) · 다시 대기 ${summary.totals.retries}건`);
  w(`실행 ${Object.entries(summary.totals.attempts).map(([k, n]) => `${k} ${n}`).join(' · ')}`);
  w(`산출물 ${Object.values(summary.totals.artifacts).reduce((n, v) => n + v.files, 0)}개 ${(summary.totals.artifact_bytes / 1024 / 1024).toFixed(1)}MB`);
  w(`  ${Object.entries(summary.totals.artifacts).map(([k, v]) => `${k} ${v.files}`).join(' · ')}`);
  w(`판정 ${summary.totals.judgments}줄(라벨 없음 ${summary.totals.abstained})`);
  w(`장부 대 파일 ${summary.totals.ledger_ok}/${summary.totals.ledger_checked} 일치 · 고아 ${summary.totals.ledger_orphans}`);
  w(`표본 ${sample.checked}개 · 파일과 출처 URL 어긋남 ${sample.wrong.length}건`);
  w('');
  if (SKIP_RERUN) {
    w('── 계획서 1-2 완료 조건 ─────────────────────');
    w('안 쟀다. 조건 열 가지는 게이트를 실제로 돌려야 판정된다 — --skip-rerun 없이 다시 돌리십시오.');
    w('(안 잰 것을 "못 채웠다" 로 적으면 이 보고가 거짓말을 한다.)');
  } else {
    w('── 계획서 1-2 완료 조건 ─────────────────────');
    for (const c of CONDITIONS) w(`${c.met ? 'PASS' : 'MISS'} ${c.id} ${c.text}\n      ${c.evidence}`);
    w('');
    if (verdict === 'COMPLETE') w('개발 완료 조건 열 가지 전부 통과');
    else {
      w(`**개발 완료라고 쓰지 않는다** — 못 채운 조건 ${unmet.length}가지: ${unmet.map((c) => c.id).join(', ')}`);
      for (const c of unmet) w(`  ${c.id}: ${c.text}${c.blocked_by ? ` (태스크 ${c.blocked_by.join('·')})` : ''}`);
      w('  다시 돌려 보려면: node tests/gate5.mjs · node tests/spikes/search-provider/verify.mjs');
    }
  }
}
process.exit(verdict === 'COMPLETE' ? 0 : 2);
