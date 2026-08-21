#!/usr/bin/env node
// 진단 시험 — 태스크 #31.
//
//   node tests/diagnostics/verify.mjs
//   node tests/diagnostics/verify.mjs --json
//
// 완료 조건이 "fixture 장애 각각을 status+manifest 만으로 구분할 수 있다" 이므로,
// 서로 다른 장애 여섯 종을 한 workspace 에 넣고 **긴 로그를 열지 않은 채** 각각을 가려낸다.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createDb } from '../../lib/db.mjs';
import {
  ERROR_CODES, ERROR_STAGES, PARTIAL_WARNINGS, WARNINGS, WARNING_CODES,
  assertWarnings, classifyOutcome, describeError, detectErrorPageText, isKnownError,
} from '../../lib/errors.mjs';
import { FIXTURE_FLAG, parseFixtureAllow } from '../../lib/fixture-allow.mjs';
import { addUrls } from '../../lib/items.mjs';
import { nextBatch } from '../../lib/lease.mjs';
import { runCollect } from '../../lib/collect/index.mjs';
import { statusLine, statusOf } from '../../lib/status.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOL_ROOT = path.resolve(HERE, '..', '..');
const FIXTURE_SERVER = path.join(TOOL_ROOT, 'tests', 'fixtures', 'server.mjs');
const MANIFEST_DOC = JSON.parse(fs.readFileSync(path.join(TOOL_ROOT, 'tests', 'fixtures', 'manifest.json'), 'utf8'));
const AS_JSON = process.argv.includes('--json');

const results = [];
const ok = (id, pass, detail) => results.push({ id, pass: Boolean(pass), detail: String(detail) });

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'diagnostics-'));
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

try {
  // ══ A. 낱말이 한 곳에 있는가 ════════════════════════════════
  {
    ok('A1-warning-vocabulary',
      WARNING_CODES.length >= 15 && WARNING_CODES.every((w) => typeof WARNINGS[w].why === 'string' && WARNINGS[w].why.length > 5),
      `관찰 이름 ${WARNING_CODES.length}종, 모두 왜 붙는지가 적혀 있다`);

    ok('A2-partial-set-derived',
      PARTIAL_WARNINGS.every((w) => WARNINGS[w].affects_result === 'partial')
      && PARTIAL_WARNINGS.includes('screenshot_truncated') && PARTIAL_WARNINGS.includes('image_fetch_partial')
      && !PARTIAL_WARNINGS.includes('http_error_status'),
      `판정을 partial 로 내리는 관찰 ${PARTIAL_WARNINGS.length}종은 표에서 뽑는다 — 따로 적은 목록이 없다`);

    // fixture manifest 가 선언한 이름이 낱말표에 다 있는가. 두 문서가 갈라지면 안 된다.
    const declared = Object.keys(MANIFEST_DOC.warning_codes).filter((k) => k !== 'note');
    const missing = declared.filter((w) => !WARNING_CODES.includes(w));
    ok('A3-fixture-manifest-agrees',
      missing.length === 0,
      `fixture 계약이 적은 관찰 ${declared.length}종이 모두 낱말표에 있다 · 빠진 것 ${missing.length}`);

    let threw = null;
    try { assertWarnings(['redirected', '지어낸_이름']); } catch (e) { threw = e; }
    ok('A4-unknown-warning-rejected',
      threw?.code === 'unknown_warning' && threw.message.includes('지어낸_이름'),
      `${threw?.code} — 모르는 이름은 조용히 통과시키지 않는다`);

    const stages = new Set(Object.values(ERROR_CODES).map((e) => e.stage));
    ok('A5-every-code-has-a-known-stage',
      [...stages].every((s) => Object.prototype.hasOwnProperty.call(ERROR_STAGES, s)),
      `실패 코드 ${Object.keys(ERROR_CODES).length}개가 쓰는 단계 ${stages.size}종이 모두 표에 있다`);

    ok('A6-describe-unknown-honestly',
      describeError('response', 'never_seen_before').includes('아직 이름표가 없는 실패'),
      '모르는 코드를 "알 수 없음" 으로 뭉개지 않는다 — 그러면 새 실패가 영원히 안 보인다');
  }

  // ══ B. 판정 규칙 ════════════════════════════════════════════
  {
    const cases = [
      [{ ok: true, produced: ['text'], missing: [], warnings: [] }, 'success'],
      [{ ok: true, produced: ['text'], missing: [], warnings: ['http_error_status'] }, 'success'],
      [{ ok: true, produced: ['text'], missing: [], warnings: ['error_page_text_detected'] }, 'success'],
      [{ ok: true, produced: ['text'], missing: ['dom'], warnings: [] }, 'partial'],
      [{ ok: true, produced: ['text', 'images'], missing: [], warnings: ['image_fetch_partial'] }, 'partial'],
      [{ ok: true, produced: ['screenshot'], missing: [], warnings: ['screenshot_truncated'] }, 'partial'],
      [{ ok: true, produced: [], missing: ['text'], warnings: [] }, 'failed'],
      [{ ok: false, produced: [], missing: ['text'], warnings: [] }, 'failed'],
    ];
    const wrong = cases.filter(([input, want]) => classifyOutcome(input) !== want);
    ok('B1-plan-5-2-rule', wrong.length === 0,
      `${cases.length}가지 경우가 계획서 5-2 대로 갈린다 · 어긋남 ${wrong.length}`);

    ok('B2-status-is-not-a-verdict',
      classifyOutcome({ ok: true, produced: ['text'], missing: [], warnings: ['http_error_status', 'error_page_text_detected'] }) === 'success',
      '404 든 오류 화면이든, 요청한 산출물이 다 생겼으면 기계 작업은 success 다');
  }

  // ══ C. 오류 화면 문구는 관찰이다 ════════════════════════════
  {
    const hit = detectErrorPageText('We couldn\'t find it. Something went wrong here.', 'Whoops');
    const clean = detectErrorPageText('청첩장 열두 장을 소개합니다.', '청첩장 목록');
    ok('C1-detects-and-says-what',
      hit.detected && hit.phrase === 'whoops' && hit.where === 'title' && !clean.detected,
      `걸린 문구 "${hit.phrase}"(${hit.where}) · 정상 쪽은 안 걸린다`);
  }

  // ══ D. 장애 여섯 종을 한 자리에 ═════════════════════════════
  const root = path.join(SANDBOX, 'ws');
  fs.mkdirSync(root, { recursive: true });
  const db = createDb(root, path.join(root, 'workspace.db'), {
    workspaceId: '2026-08-12-diagnostics', projectRoot: SANDBOX, briefPath: path.join(root, 'brief.md'), nowMs: NOW,
  });

  // 여섯 종: 정상 · 200 오류화면 · 404 · 그림 일부 실패 · 응답 없음(타임아웃) · 리다이렉트 고리
  const urls = ['/static/normal', '/error/soft-404', '/status/404', '/images/rich', '/hang/headers', '/redirect/loop'];
  addUrls(db, urls.map((u, i) => ({ url: `${BASE}${u}`, line: i + 1 })), { source_kind: 'seed', source_value: 'manual', nowMs: NOW });
  const lease = nextBatch(db, root, { workerId: 'diag', count: urls.length, leaseMinutes: 60, nowMs: NOW });

  const run = await runCollect(db, {
    root, leaseId: lease.lease_id, mode: 'http', outputs: ['text', 'images'],
    pacePath: path.join(root, 'pace.db'), paceOpts: FAST,
    fetchOptions: { fixtureAllow: ALLOW, timeouts: { headers_timeout_ms: 400, connect_timeout_ms: 2000 } },
    nowMs: NOW,
  });
  const idx = fs.readFileSync(path.join(root, run.index_path), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const at = (p) => idx.find((l) => l.requested_url.endsWith(p));
  const manifestOf = (l) => JSON.parse(fs.readFileSync(path.join(root, l.manifest), 'utf8'));

  {
    ok('D1-six-outcomes',
      idx.length === 6 && run.succeeded + run.partial + run.failed === 6,
      `여섯 항목 · 성공 ${run.succeeded} · 부분 ${run.partial} · 실패 ${run.failed}`);

    const distinct = new Map();
    for (const l of idx) {
      const m = manifestOf(l);
      const key = `${m.result}|${(m.warning_codes ?? []).sort().join(',')}|${m.error ? `${m.error.stage}/${m.error.code}` : '-'}`;
      distinct.set(key, [...(distinct.get(key) ?? []), l.requested_url.replace(BASE, '')]);
    }
    ok('D2-each-failure-is-distinguishable',
      distinct.size === 6,
      `요약만 보고 여섯을 서로 다르게 가려낸다:\n        `
      + [...distinct.entries()].map(([k, v]) => `${v.join()} → ${k}`).join('\n        '));
  }

  // ══ E. 요약 하나로 되짚기 ═══════════════════════════════════
  {
    const soft = manifestOf(at('/error/soft-404'));
    ok('E1-200-error-page',
      soft.result === 'success' && soft.http_status === 200
      && soft.warning_codes.includes('error_page_text_detected')
      && !('page_validity' in soft) && soft.error === null,
      `상태 ${soft.http_status} · 판정 ${soft.result} · 관찰 ${soft.warning_codes.join('·')} — 판정 칸은 없다`);

    const notFound = manifestOf(at('/status/404'));
    ok('E2-404-differs-from-200-error',
      notFound.http_status === 404 && notFound.warning_codes.includes('http_error_status')
      && soft.http_status === 200 && !soft.warning_codes.includes('http_error_status'),
      `404 는 http_error_status 로, 200 오류화면은 error_page_text_detected 로 갈린다`);

    const hang = manifestOf(at('/hang/headers'));
    ok('E3-timeout-has-everything-to-retry',
      hang.result === 'failed' && hang.error.stage === 'response' && hang.error.code === 'headers_timeout'
      && hang.retry_item_id === hang.item_id && hang.missing_outputs.length === 2
      && hang.produced_outputs.length === 0 && hang.requested_url.endsWith('/hang/headers'),
      `${hang.error.stage}/${hang.error.code} · 빠진 산출물 ${hang.missing_outputs.join('·')}`
      + ` · 다시 돌릴 번호 ${hang.retry_item_id}`);

    const loop = manifestOf(at('/redirect/loop'));
    ok('E4-redirect-loop',
      loop.result === 'failed' && loop.error.code === 'redirect_loop' && loop.final_url === null,
      `${loop.error.stage}/${loop.error.code}`);

    const rich = manifestOf(at('/images/rich'));
    ok('E5-partial-says-what-is-missing',
      rich.result === 'partial' && rich.warning_codes.includes('image_fetch_partial')
      && rich.missing_outputs.length === 0 && rich.produced_outputs.length === 2,
      `그림 일부 실패라 ${rich.result} · 산출물은 다 생겼다(${rich.produced_outputs.join('·')})`
      + ' — "빠진 산출물" 과 "덜 채워진 산출물" 은 다른 말이다');
  }

  // ══ F. status 만 보고도 찾아간다 ════════════════════════════
  {
    const s = statusOf(db, { nowMs: NOW });
    const errs = s.top_errors.filter((e) => e.kind === 'error');
    const warns = s.top_errors.filter((e) => e.kind === 'warning');

    ok('F1-errors-and-warnings-both-listed',
      errs.length === 2 && warns.length > 0
      && errs.every((e) => e.stage && e.code && e.why) && warns.every((w) => w.why),
      `오류 ${errs.length}종 · 관찰 ${warns.length}종 · 줄마다 왜 그런지가 적혀 있다`);

    const timeout = errs.find((e) => e.code === 'headers_timeout');
    ok('F2-sample-has-plan-5-5-fields',
      timeout.sample.item_id && timeout.sample.attempt_id && timeout.sample.requested_url
      && Array.isArray(timeout.sample.produced) && Array.isArray(timeout.sample.missing)
      && timeout.sample.manifest && timeout.sample.retry_item_id === timeout.sample.item_id,
      `item ${timeout.sample.item_id} · ${timeout.sample.attempt_id.slice(0, 10)}… · 빠진 것 ${timeout.sample.missing.join('·')}`
      + ` · 요약 ${timeout.sample.manifest.split('/').slice(-2).join('/')}`);

    ok('F3-sample-manifest-exists',
      fs.existsSync(path.join(root, timeout.sample.manifest)),
      `status 가 가리킨 요약 파일이 실재한다 — 긴 로그를 열지 않고 여기까지 온다`);

    ok('F4-retryable-marked',
      timeout.retryable === true && errs.find((e) => e.code === 'redirect_loop').retryable === false,
      `headers_timeout 은 다시 될 수도 있고(${timeout.retryable}) redirect_loop 는 아니다`);

    ok('F5-contract-keys-unchanged',
      JSON.stringify(Object.keys(s).sort()) === JSON.stringify([
        'artifact_counts', 'awaiting_report', 'done', 'expired_leases', 'failed', 'last_export',
        'leased', 'queued', 'review_required', 'top_errors', 'total', 'workspace_drained',
      ]),
      `계약이 정한 열두 칸 그대로다 — 경고는 top_errors 안에 kind 로 갈아 넣었다`);

    const line = statusLine(s);
    ok('F6-one-line-points-somewhere',
      line.includes('가장 잦음') && /item \d+/.test(line) && line.length < 300,
      `"${line.slice(0, 150)}…"`);

    const size = Buffer.byteLength(JSON.stringify(s));
    ok('F7-fits-in-a-response', size < 4096, `status 응답 ${size}바이트 (상한 4096)`);
  }

  // ══ G. 모르는 낱말이 새어 나가지 않는가 ═════════════════════
  {
    const codes = db.prepare('SELECT DISTINCT error_code FROM attempts WHERE error_code IS NOT NULL').all().map((r) => r.error_code);
    const unknown = codes.filter((c) => !isKnownError(c));
    ok('G1-every-produced-code-is-named',
      unknown.length === 0,
      `이 실행이 낸 실패 코드 ${codes.length}종(${codes.join('·')})이 모두 낱말표에 있다`);

    const warnRows = db.prepare('SELECT warning_codes FROM attempts WHERE warning_codes IS NOT NULL').all();
    const seen = new Set(warnRows.flatMap((r) => JSON.parse(r.warning_codes)));
    ok('G2-every-produced-warning-is-named',
      [...seen].every((w) => WARNING_CODES.includes(w)),
      `이 실행이 낸 관찰 ${seen.size}종(${[...seen].join('·')})이 모두 낱말표에 있다`);
  }

  db.close();
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
