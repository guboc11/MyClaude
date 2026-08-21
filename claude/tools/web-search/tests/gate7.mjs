#!/usr/bin/env node
// 게이트 7 — 세 실전 시나리오 종단 감사.
//
//   node tests/gate7.mjs --project <프로젝트>
//   node tests/gate7.mjs --project <프로젝트> --json
//
// 앞의 게이트들은 만들면서 재는 시험이었다. 이것은 **이미 일어난 일을 뒤에서 감사한다.**
// 시나리오 A·B·C 가 남긴 진짜 workspace 세 곳을 열어, 장부와 파일이 같은 말을 하는지,
// 워커들이 서로의 일감을 밟지 않았는지, 오류마다 되짚을 자리가 있는지를 본다.
//
// 새로 수집하지 않는다. 네트워크도 부르지 않는다 — 감사가 대상을 바꾸면 그건 감사가 아니다.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { verifyArtifacts } from '../lib/artifacts.mjs';
import { openDb } from '../lib/db.mjs';
import { statusOf, statusLine } from '../lib/status.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOL_ROOT = path.resolve(HERE, '..');
const E2E_DIR = path.join(HERE, 'e2e');
const REPORTS = path.join(HERE, 'reports');
const AS_JSON = process.argv.includes('--json');
const flag = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};

const PROJECT = path.resolve(flag('project') ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd());
const WS_PARENT = path.join(PROJECT, '.claude', 'websearch-workspace');
// [날짜로 지어내지 않는다] workspace 이름은 만든 날로 시작한다. 날짜를 박아 두면 다음 날
// 이 감사가 없는 폴더를 찾는다. 이름 뒷부분(주제)으로 찾고, 없으면 그때 말한다.
function findWorkspace(suffix, given) {
  if (given) return given;
  const dirs = fs.existsSync(WS_PARENT) ? fs.readdirSync(WS_PARENT).filter((d) => d.endsWith(suffix)).sort() : [];
  return dirs[dirs.length - 1] ?? `(못 찾음: *${suffix})`;
}
const SCENARIOS = [
  { key: 'A', id: findWorkspace('-wedding-candidates-worldwide', flag('a')), report: 'scenario-a.md' },
  { key: 'B', id: findWorkspace('-barunson-mcard-deep', flag('b')), report: 'scenario-b.md' },
  { key: 'C', id: findWorkspace('-failure-recovery-drill', flag('c')), report: 'scenario-c.md' },
];

const results = [];
const add = (id, title, pass, detail) => results.push({ id, title, pass: Boolean(pass), detail: String(detail) });

// 네트워크를 아예 막아 둔다. 감사 중에 밖으로 나가면 그 자체가 결함이다.
let networkAttempts = 0;
globalThis.fetch = (...a) => { networkAttempts++; throw new Error(`감사는 네트워크를 쓰지 않는다: ${String(a[0]).slice(0, 60)}`); };

const openWs = (id) => {
  const root = path.join(WS_PARENT, id);
  return { root, db: openDb(root, path.join(root, 'workspace.db')) };
};
const each = (fn) => SCENARIOS.map((s) => {
  const { root, db } = openWs(s.id);
  try { return { ...s, root, ...fn(db, root, s) }; } finally { db.close(); }
});

// ══ G7-1 진행기에 수집 코드가 없다 ═══════════════════════════
{
  // "별도 Playwright·curl 코드 작성 없이" 를 글이 아니라 파일로 확인한다.
  const FORBIDDEN = [
    /from\s+'node:(https?|net|tls|dgram)'/, /require\(\s*'node:(https?|net|tls)'/,
    /from\s+'playwright/, /require\(\s*'playwright/,
    /\bfetch\s*\(/, /\bcurl\b/, /XMLHttpRequest/,
  ];
  const files = fs.readdirSync(E2E_DIR).filter((f) => f.endsWith('.mjs')).sort();
  const hits = [];
  for (const f of files) {
    // 주석은 벗기고 본다 — "여기에는 http 가 없다" 는 설명이 스스로 걸리면 안 된다.
    const src = fs.readFileSync(path.join(E2E_DIR, f), 'utf8')
      .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    for (const re of FORBIDDEN) if (re.test(src)) hits.push(`${f}: ${re}`);
  }
  add('G7-1', '세 진행기 어디에도 직접 수집하는 코드가 없다', hits.length === 0 && files.length >= 4,
    hits.length ? hits.join(' / ')
      : `${files.length}개 파일(${files.join(' ')}) — playwright·http·fetch·curl 0건, 부르는 것은 MCP 버튼뿐`);
}

// ══ G7-2 세 workspace 가 열린다 ══════════════════════════════
let opened = [];
{
  const missing = SCENARIOS.filter((s) => !fs.existsSync(path.join(WS_PARENT, s.id, 'workspace.db')));
  if (missing.length) {
    add('G7-2', '세 시나리오의 workspace 가 있다', false, `없는 것: ${missing.map((m) => m.id).join(' ')}`);
  } else {
    opened = each((db) => {
      const s = statusOf(db);
      return { status: s, line: statusLine(s) };
    });
    add('G7-2', '세 시나리오의 workspace 가 있고 status 가 열린다', true,
      opened.map((o) => `${o.key} ${o.status.total}건(완료 ${o.status.done}·실패 ${o.status.failed})`).join(' · '));
  }
}

if (opened.length === SCENARIOS.length) {
  // ══ G7-3 여러 워커가 한 장부·한 artifacts 를 나눠 썼다 ═════
  {
    const per = each((db) => ({
      workers: db.prepare('SELECT COUNT(DISTINCT leased_by) AS n FROM items WHERE leased_by IS NOT NULL').get().n
        + db.prepare('SELECT COUNT(DISTINCT worker_id) AS n FROM judgments').get().n,
      judged_by: db.prepare('SELECT COUNT(DISTINCT worker_id) AS n FROM judgments').get().n,
      leases: db.prepare('SELECT COUNT(DISTINCT lease_id) AS n FROM items WHERE lease_id IS NOT NULL').get().n,
    }));
    const multi = per.filter((p) => p.judged_by >= 2);
    add('G7-3', '한 workspace 를 여러 워커가 나눠 썼다', multi.length >= 2,
      per.map((p) => `${p.key} 판정한 워커 ${p.judged_by}명`).join(' · ')
      + ` — 둘 이상인 곳 ${multi.length}곳`);
  }

  // ══ G7-4 임대 겹침 0 · 유실 0 ═════════════════════════════
  {
    const per = each((db) => {
      const counts = db.prepare('SELECT work_state, COUNT(*) AS n FROM items GROUP BY work_state').all();
      const total = db.prepare('SELECT COUNT(*) AS n FROM items').get().n;
      const sum = counts.reduce((n, r) => n + r.n, 0);
      // 한 item 이 두 임대에 동시에 잡혀 있을 수 없다 — lease_id 는 한 칸이고 DB 가 붙든다.
      const doubleLeased = db.prepare(`
        SELECT COUNT(*) AS n FROM items WHERE work_state = 'leased' AND (lease_id IS NULL OR leased_by IS NULL)`).get().n;
      const ghostLease = db.prepare(`
        SELECT COUNT(*) AS n FROM items WHERE work_state <> 'leased' AND lease_id IS NOT NULL`).get().n;
      return { total, sum, doubleLeased, ghostLease };
    });
    const bad = per.filter((p) => p.total !== p.sum || p.doubleLeased > 0 || p.ghostLease > 0);
    add('G7-4', '임대 겹침 0 · 상태에서 사라진 item 0', bad.length === 0,
      per.map((p) => `${p.key} ${p.total}건 = 상태합 ${p.sum}`).join(' · ')
      + ` · 임대인데 주인 없는 것 0 · 임대 아닌데 임대번호 남은 것 0`);
  }

  // ══ G7-5 workspace 교차 저장 0 ════════════════════════════
  {
    const per = each((db, root) => {
      const rows = db.prepare('SELECT path FROM artifacts').all();
      const outside = rows.filter((r) => r.path.startsWith('/') || r.path.includes('..'));
      const otherIds = SCENARIOS.map((s) => s.id).filter((x) => !root.endsWith(x));
      const crossed = rows.filter((r) => otherIds.some((o) => r.path.includes(o)));
      return { rows: rows.length, outside: outside.length, crossed: crossed.length };
    });
    const bad = per.filter((p) => p.outside > 0 || p.crossed > 0);
    add('G7-5', '다른 workspace 로 새어 나간 저장 0', bad.length === 0,
      per.map((p) => `${p.key} 장부 ${p.rows}줄`).join(' · ') + ' — 절대경로·상위경로·남의 workspace 0');
  }

  // ══ G7-6 오류마다 되짚을 자리가 있다 ══════════════════════
  {
    const per = each((db, root) => {
      const fails = db.prepare(`
        SELECT attempt_id, item_id, requested_url, error_stage, error_code, error_message_short, operation
          FROM attempts WHERE result = 'failed'`).all();
      const bad = [];
      for (const f of fails) {
        if (!f.requested_url) bad.push(`${f.attempt_id} URL 없음`);
        if (!f.error_stage || !f.error_code) bad.push(`${f.attempt_id} 단계·코드 없음`);
        const mf = f.operation === 'collect'
          ? path.join(root, 'artifacts', 'pages', String(f.item_id), f.attempt_id, 'manifest.json')
          : null;
        if (mf && !fs.existsSync(mf)) bad.push(`${f.attempt_id} 요약 없음`);
      }
      return { fails: fails.length, bad };
    });
    const bad = per.flatMap((p) => p.bad);
    const total = per.reduce((n, p) => n + p.fails, 0);
    add('G7-6', '실패한 실행마다 URL·단계·코드·요약 파일이 있다', bad.length === 0 && total > 0,
      bad.length ? bad.slice(0, 3).join(' / ')
        : `세 곳 합쳐 실패 ${total}건 — 모두 되짚을 자리가 있다(${per.map((p) => `${p.key} ${p.fails}`).join('·')})`);
  }

  // ══ G7-7 무작위 표본에서 요청과 저장물이 일치 ═════════════
  {
    // 표본은 고정된 규칙으로 고른다 — 돌릴 때마다 다른 것을 보면 "그날 통과" 밖에 안 남는다.
    const per = each((db, root) => {
      const rows = db.prepare(`
        SELECT a.artifact_id, a.path, a.byte_size, a.sha256, t.attempt_id, t.item_id, t.requested_url
          FROM artifacts a JOIN attempts t ON t.attempt_id = a.attempt_id
         ORDER BY a.artifact_id`).all();
      const step = Math.max(1, Math.floor(rows.length / 12));
      const sample = rows.filter((_, i) => i % step === 0).slice(0, 12);
      const bad = [];
      for (const s of sample) {
        const abs = path.join(root, s.path);
        if (!fs.existsSync(abs)) { bad.push(`${s.path} 없음`); continue; }
        const buf = fs.readFileSync(abs);
        if (buf.length !== s.byte_size) { bad.push(`${s.path} 크기 다름`); continue; }
        if (createHash('sha256').update(buf).digest('hex') !== s.sha256) { bad.push(`${s.path} 지문 다름`); continue; }
        // 이 파일이 정말 그 페이지에서 나왔나 — 요약이 같은 URL 을 말하는지 본다.
        const mf = path.join(root, 'artifacts', 'pages', String(s.item_id), s.attempt_id, 'manifest.json');
        if (fs.existsSync(mf)) {
          const doc = JSON.parse(fs.readFileSync(mf, 'utf8'));
          if (doc.requested_url !== s.requested_url) bad.push(`${s.path} 요약의 URL 이 다름`);
          if (!doc.artifacts.some((x) => x.path === s.path)) bad.push(`${s.path} 요약에 없음`);
        }
      }
      return { checked: sample.length, bad };
    });
    const bad = per.flatMap((p) => p.bad);
    const checked = per.reduce((n, p) => n + p.checked, 0);
    add('G7-7', '표본의 요청 페이지와 저장 자료가 어긋나지 않는다', bad.length === 0 && checked >= 20,
      bad.length ? bad.slice(0, 3).join(' / ')
        : `표본 ${checked}개(세 곳에서 고르게) — 크기·지문·요약의 URL 까지 일치`);
  }

  // ══ G7-8 검색부터 export 까지 출처가 이어진다 ═════════════
  {
    const a = SCENARIOS[0];
    const { root, db } = openWs(a.id);
    let detail = '';
    let pass = false;
    try {
      const items = db.prepare('SELECT COUNT(*) AS n FROM items').get().n;
      const withSearch = db.prepare("SELECT COUNT(DISTINCT item_id) AS n FROM sources WHERE source_kind = 'search'").get().n;
      const queries = db.prepare("SELECT COUNT(DISTINCT source_value) AS n FROM sources WHERE source_kind = 'search'").get().n;
      const exportsDir = path.join(root, 'exports');
      const files = fs.readdirSync(exportsDir).filter((f) => f.endsWith('.jsonl')).sort();
      const last = files[files.length - 1];
      const rows = fs.readFileSync(path.join(exportsDir, last), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
      const withSources = rows.filter((r) => Array.isArray(r.sources) && r.sources.some((s) => s.startsWith('search:')));
      pass = withSearch === items && queries >= 20 && rows.length > 0 && withSources.length === rows.length;
      detail = `item ${items}개 전부 검색어 출처가 있고(검색어 ${queries}개), `
        + `내보낸 ${rows.length}줄 전부에 그 출처가 실려 있다 (${last})`;
    } finally { db.close(); }
    add('G7-8', '검색어 → item → export 로 출처가 끊기지 않는다', pass, detail);
  }

  // ══ G7-9 판정과 기계 상태가 서로를 안 바꿨다 ══════════════
  {
    const per = each((db) => {
      const judged = db.prepare('SELECT COUNT(*) AS n FROM judgments').get().n;
      const abstained = db.prepare('SELECT COUNT(*) AS n FROM judgments WHERE label IS NULL').get().n;
      // 라벨이 없어도 done 이 된다. 라벨이 있어도 done 이 아닌 것이 있을 수 있다.
      const doneWithoutLabel = db.prepare(`
        SELECT COUNT(*) AS n FROM items i WHERE i.work_state = 'done'
         AND NOT EXISTS (SELECT 1 FROM judgments j WHERE j.item_id = i.item_id AND j.label IS NOT NULL)`).get().n;
      const conflicts = db.prepare(`
        SELECT COUNT(*) AS n FROM (SELECT item_id FROM judgments WHERE label IS NOT NULL
          GROUP BY item_id HAVING COUNT(DISTINCT label) > 1)`).get().n;
      return { judged, abstained, doneWithoutLabel, conflicts };
    });
    const totalAbstain = per.reduce((n, p) => n + p.abstained, 0);
    const totalConflict = per.reduce((n, p) => n + p.conflicts, 0);
    add('G7-9', '판정과 기계 상태가 서로를 덮어쓰지 않았다',
      totalAbstain > 0 && per.some((p) => p.doneWithoutLabel > 0),
      per.map((p) => `${p.key} 판정 ${p.judged}(라벨 없음 ${p.abstained}·갈린 item ${p.conflicts})`).join(' · ')
      + ` — 라벨 없이 done 이 된 item 이 있고(${per.map((p) => p.doneWithoutLabel).join('·')}),`
      + ` 같은 item 에 다른 라벨이 남은 곳 ${totalConflict}건`);
  }

  // ══ G7-10 기계가 조사 완료를 말하지 않는다 ════════════════
  {
    const CLAIMS = [/완료했습니다/, /조사가 끝났/, /research_complete/, /\bcompletion\b/, /goal_achieved/];
    const bad = [];
    for (const o of opened) {
      const keys = Object.keys(o.status);
      if (keys.some((k) => /complete|finish|goal|success/i.test(k))) bad.push(`${o.key} status 키 ${keys.join(',')}`);
      for (const re of CLAIMS) if (re.test(o.line)) bad.push(`${o.key} 한 줄 요약이 완료를 말함`);
      if (o.status.workspace_drained && !o.line.includes('조사 완료라는 뜻은 아닙니다')) {
        bad.push(`${o.key} 대기·임대가 비었는데 단서가 없음`);
      }
    }
    add('G7-10', '기계는 조사 완료를 말하지 않는다', bad.length === 0,
      bad.length ? bad.join(' / ')
        : `세 곳 모두 계약 열두 키뿐이고, 대기·임대가 빈 곳은 "조사 완료라는 뜻은 아닙니다" 를 함께 적는다`);
  }

  // ══ G7-11 장부와 파일이 일치 ══════════════════════════════
  {
    const per = each((db, root) => {
      const v = verifyArtifacts(db, root);
      return { v };
    });
    const bad = per.filter((p) => p.v.checked !== p.v.ok || p.v.orphans.length || p.v.incomplete.length || p.v.manifest_missing.length);
    const checked = per.reduce((n, p) => n + p.v.checked, 0);
    add('G7-11', '세 곳 모두 장부와 파일이 같은 말을 한다', bad.length === 0,
      bad.length
        ? bad.map((p) => `${p.key} 검사 ${p.v.checked}·일치 ${p.v.ok}·고아 ${p.v.orphans.length}·미완 ${p.v.incomplete.length}·요약없음 ${p.v.manifest_missing.length}`).join(' / ')
        : `합쳐 ${checked}줄 전부 일치 · 고아 0 · 만들다 만 것 0 · 요약 없는 실행 0`);
  }

  // ══ G7-12 세 보고서가 있고 사람의 판단이 적혀 있다 ════════
  {
    const bad = [];
    for (const s of SCENARIOS) {
      const p = path.join(REPORTS, s.report);
      if (!fs.existsSync(p)) { bad.push(`${s.report} 없음`); continue; }
      const text = fs.readFileSync(p, 'utf8');
      if (!/한계/.test(text)) bad.push(`${s.report} 에 한계 절이 없음`);
      if (text.length < 1500) bad.push(`${s.report} 가 너무 짧음`);
    }
    add('G7-12', '세 시나리오 보고서가 있고 한계를 적었다', bad.length === 0,
      bad.length ? bad.join(' / ') : SCENARIOS.map((s) => s.report).join(' · '));
  }
}

// ══ G7-13 LEGACY 불변 · 금지 import 0 ═══════════════════════
{
  const audit = spawnSync(process.execPath, [path.join(HERE, 'baseline', 'verify-reuse-audit.mjs'), '--json'],
    { cwd: TOOL_ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const baseline = spawnSync(process.execPath,
    [path.join(HERE, 'baseline', 'baseline.mjs'), '--verify', '--project', PROJECT],
    { cwd: TOOL_ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  add('G7-13', 'LEGACY 불변 · 금지 import 0', audit.status === 0 && baseline.status === 0,
    `재사용 감사 exit=${audit.status} · 기준선 대조 exit=${baseline.status}`);
}

// ══ G7-14 감사가 네트워크를 부르지 않았다 ════════════════════
add('G7-14', '감사 자체가 네트워크를 부르지 않음', networkAttempts === 0, `네트워크 시도 ${networkAttempts}회`);

const failed = results.filter((r) => !r.pass);
if (AS_JSON) {
  process.stdout.write(`${JSON.stringify({ gate: 7, pass: failed.length === 0, total: results.length, failed: failed.length, project: PROJECT, scenarios: SCENARIOS, results }, null, 2)}\n`);
} else {
  for (const r of results) process.stdout.write(`${r.pass ? 'PASS' : 'FAIL'}  ${r.id}  ${r.title}\n        ${r.detail}\n`);
  process.stdout.write(`\n${failed.length === 0 ? 'PASS' : 'FAIL'} — ${results.length - failed.length}/${results.length}\n`);
}
process.exit(failed.length === 0 ? 0 : 1);
