#!/usr/bin/env node
// 브라우저 그림 수집 시험 — 태스크 #30.
//
//   cd <playwright 가 있는 프로젝트> && node ~/.claude/tools/web-search/tests/browser-images/verify.mjs
//   WEBSEARCH_DEPS_DIR=<그 프로젝트> node tests/browser-images/verify.mjs
//
// 완료 조건이 "manifest 와 파일 지문이 일치하고 의미 기반 제외가 0건" 이므로
// 줄·파일·장부 셋을 견주고, **문서에 있는 그림 참조가 하나도 빠지지 않았는지**를 따로 본다.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

import { verifyArtifacts } from '../../lib/artifacts.mjs';
import { startAttempt } from '../../lib/attempts.mjs';
import { createDb } from '../../lib/db.mjs';
import { FIXTURE_FLAG, parseFixtureAllow } from '../../lib/fixture-allow.mjs';
import { addUrls } from '../../lib/items.mjs';
import { nextBatch } from '../../lib/lease.mjs';
import { collectBrowser, resolvePlaywright } from '../../lib/collect/browser.mjs';
import { collectHttp } from '../../lib/collect/http.mjs';
import { runCollect } from '../../lib/collect/index.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOL_ROOT = path.resolve(HERE, '..', '..');
const FIXTURE_SERVER = path.join(TOOL_ROOT, 'tests', 'fixtures', 'server.mjs');
const AS_JSON = process.argv.includes('--json');

const results = [];
const ok = (id, pass, detail) => results.push({ id, pass: Boolean(pass), detail: String(detail) });
const sha = (buf) => createHash('sha256').update(buf).digest('hex');

const DEPS_DIR = process.env.WEBSEARCH_DEPS_DIR ?? process.cwd();
try { resolvePlaywright({ depsDir: DEPS_DIR }); } catch (e) {
  process.stderr.write(`${e.message}\n\nplaywright 가 있는 프로젝트에서 돌리거나 WEBSEARCH_DEPS_DIR 로 알려 주십시오.\n`);
  process.exit(2);
}

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-images-'));
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

const root = path.join(SANDBOX, 'ws');
fs.mkdirSync(root, { recursive: true });
const db = createDb(root, path.join(root, 'workspace.db'), {
  workspaceId: '2026-08-12-browser-images', projectRoot: SANDBOX, briefPath: path.join(root, 'brief.md'), nowMs: NOW,
});
addUrls(db, [{ url: `${BASE}/images/browser`, line: 1 }], { source_kind: 'seed', source_value: 'manual', nowMs: NOW });

let seq = 0;
const newAttempt = () => startAttempt(db, {
  itemId: 1, operation: 'collect', collector: 'browser',
  requestedOutputs: ['images'], requestedUrl: `${BASE}/images/browser#${++seq}`, nowMs: NOW,
}).attempt_id;
const fileOf = (rel) => fs.readFileSync(path.join(root, rel));
const linesOf = (rel) => fileOf(rel).toString('utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

try {
  const run = await collectBrowser(db, {
    root, attemptId: newAttempt(), url: `${BASE}/images/browser`, outputs: ['images'],
    fixtureAllow: ALLOW, depsDir: DEPS_DIR, nowMs: NOW,
  });
  const rows = linesOf(run.outputs.images.path);
  const at = (p) => rows.find((r) => r.url === `${BASE}${p}`);
  const c = run.outputs.images;

  // ══ A. 브라우저만 볼 수 있는 것 ═════════════════════════════
  {
    const oneX = at('/img/ok/one-x.png');
    const twoX = at('/img/ok/two-x.png');
    ok('A1-current-src',
      oneX.is_current_src === true && oneX.ok === true
      && twoX.is_current_src === false && twoX.reason === 'not_requested_by_browser',
      `배율 1 화면이라 브라우저가 고른 것은 one-x (${oneX.ok ? '받음' : '못 받음'}),`
      + ` two-x 는 ${twoX.reason} 로 남는다 — 후보를 지우지 않는다`);

    const chosen = at('/img/ok/chosen.webp');
    const fallback = at('/img/ok/fallback.png');
    ok('A2-picture-choice',
      chosen.is_current_src === true && chosen.ok === true && fallback.is_current_src === false,
      `picture 에서 브라우저가 고른 것은 ${chosen.url.split('/').pop()} · 대비책 ${fallback.url.split('/').pop()} 도 줄로 남는다`);

    const bg = at('/img/ok/css-bg.png');
    ok('A3-css-background',
      bg && bg.ok === true && bg.references.some((r) => r.from === 'css.background-image') && c.css_background === 1,
      `CSS 배경 그림을 잡았다 — 마크업에 <img> 가 없어 HTML 만 훑어서는 못 찾는 자리다`);

    const og = at('/img/ok/og-browser.png');
    ok('A4-og-image',
      og && og.references[0].from === 'og:image' && og.reason === 'not_requested_by_browser',
      `대표 그림은 참조로 잡히지만 브라우저가 부르지는 않는다 → ${og.reason}`);

    const lazy = at('/img/ok/below-fold.png');
    ok('A5-lazy-below-fold',
      lazy && lazy.reason === 'not_requested_by_browser' && lazy.references[0].loading === 'lazy'
      && run.warnings.includes('images_not_requested_by_browser'),
      `화면 밖 lazy 그림은 브라우저가 안 불렀다 · 그 사실을 ${lazy.reason} 와 경고로 남긴다`);
  }

  // ══ B. 표시 크기와 원본·최종 URL ════════════════════════════
  {
    const plain = at('/img/ok/plain.png');
    ok('B1-displayed-size',
      plain.displayed.width === 80 && plain.displayed.height === 60 && plain.natural.width === 1,
      `화면에 놓인 크기 ${plain.displayed.width}×${plain.displayed.height} · 원래 크기 ${plain.natural.width}×${plain.natural.height}`);

    const red = at('/img/redirect/moved.png');
    ok('B2-redirect-both-urls',
      red.ok === true && red.redirected === true
      && red.requested_url.endsWith('/img/redirect/moved.png') && red.final_url.endsWith('/img/ok/p1.png'),
      `요청 ${red.requested_url.replace(BASE, '')} → 도착 ${red.final_url.replace(BASE, '')}`);

    ok('B3-mime-recorded',
      rows.filter((r) => r.ok).every((r) => r.declared_mime === 'image/png' && r.sniffed_mime === 'image/png'),
      `받은 ${c.downloaded}장 모두 머리와 바이트가 같은 형식이라고 말한다`);

    const gone = at('/img/fail/gone.png');
    ok('B4-http-error',
      gone.ok === false && gone.reason === 'http_error' && gone.http_status === 404 && gone.path === null,
      `${gone.reason} · 상태 ${gone.http_status} · 파일 없음`);
  }

  // ══ C. data·blob 규칙 ═══════════════════════════════════════
  {
    const data = rows.find((r) => r.kind === 'data_uri');
    ok('C1-data-uri-rule',
      data && data.ok === false && data.reason === 'data_uri' && data.path === null && data.sha256 === null,
      '문서 안에 든 그림은 바깥 파일로 저장하지 않는다 — 바이트는 이미 dom.html.gz 에 있다');
    ok('C2-no-blob-mistake',
      rows.every((r) => r.path === null || /^https?:/.test(r.url)),
      '파일이 붙은 줄은 모두 http(s) 주소다 — data·blob 이 외부 파일로 새지 않는다');
  }

  // ══ D. 완료 조건 — 줄·파일·장부 1:1 ════════════════════════
  {
    const good = rows.filter((r) => r.ok);
    const dir = path.join(root, path.dirname(run.outputs.images.path), 'images');
    const files = fs.readdirSync(dir).sort();
    const dbImages = db.prepare("SELECT path, byte_size, sha256 FROM artifacts WHERE kind = 'image' ORDER BY path").all();
    const bad = good.filter((r) => {
      const abs = path.join(root, r.path);
      return !fs.existsSync(abs) || fs.statSync(abs).size !== r.byte_size || sha(fs.readFileSync(abs)) !== r.sha256;
    });
    ok('D1-one-to-one',
      good.length === files.length && good.length === dbImages.length && bad.length === 0 && good.length === 6,
      `성공 줄 ${good.length} · 실제 파일 ${files.length} · 장부 ${dbImages.length} · 지문 어긋남 ${bad.length}`);

    const v = verifyArtifacts(db, root);
    ok('D2-ledger-clean',
      v.checked === v.ok && v.orphans.length === 0 && v.incomplete.length === 0 && v.sha_mismatch.length === 0,
      `장부 ${v.checked}줄 전부 일치`);
  }

  // ══ E. 의미로 거른 것이 0건인가 ═════════════════════════════
  {
    // 문서에 적힌 그림 주소를 시험이 따로 세어, manifest 가 하나도 안 빠뜨렸는지 본다.
    const html = fileOf((await collectHttp(db, {
      root, attemptId: newAttempt(), url: `${BASE}/images/browser`, outputs: ['dom'],
      fetchOptions: { fixtureAllow: ALLOW }, nowMs: NOW,
    })).outputs.dom.path);
    const raw = (await import('node:zlib')).gunzipSync(html).toString('utf8');
    const declared = new Set();
    for (const m of raw.matchAll(/(?:src|content)="(\/img\/[^"]+)"/g)) declared.add(`${BASE}${m[1]}`);
    for (const m of raw.matchAll(/srcset="([^"]+)"/g)) {
      for (const part of m[1].split(',')) {
        const u = part.trim().split(/\s+/)[0];
        if (u.startsWith('/img/')) declared.add(`${BASE}${u}`);
      }
    }
    for (const m of raw.matchAll(/url\("(\/img\/[^"]+)"\)/g)) declared.add(`${BASE}${m[1]}`);

    const inManifest = new Set(rows.map((r) => r.url));
    const missing = [...declared].filter((u) => !inManifest.has(u));
    const tiny = rows.filter((r) => r.ok && r.natural && r.natural.width <= 1);
    ok('E1-nothing-dropped-by-meaning',
      missing.length === 0 && declared.size >= 9,
      `문서에 적힌 그림 주소 ${declared.size}개가 모두 장부에 있다 · 빠진 것 ${missing.length}개`);
    ok('E2-tiny-images-kept',
      tiny.length > 0,
      `1픽셀짜리 그림 ${tiny.length}장도 크기를 이유로 빼지 않는다`);
    // 항등식으로 본다. 이유를 손으로 나열하면 새 이유가 생길 때 조용히 새어 나간다.
    const byReason = {};
    for (const r of rows) byReason[r.ok ? 'ok' : (r.reason ?? 'null')] = (byReason[r.ok ? 'ok' : (r.reason ?? 'null')] ?? 0) + 1;
    const summed = Object.values(byReason).reduce((n, v) => n + v, 0);
    ok('E3-rows-cover-everything',
      c.rows === rows.length && summed === rows.length && (byReason.null ?? 0) === 0,
      `줄 ${rows.length}개가 이유별로 빠짐없이 갈린다: ${Object.entries(byReason).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
  }

  // ══ F. 두 모드의 그림 결과가 다르다 ═════════════════════════
  {
    const httpRun = await collectHttp(db, {
      root, attemptId: newAttempt(), url: `${BASE}/images/browser`, outputs: ['images'],
      fetchOptions: { fixtureAllow: ALLOW }, nowMs: NOW,
    });
    const httpRows = linesOf(httpRun.outputs.images.path);
    const httpUrls = new Set(httpRows.map((r) => r.url));
    ok('F1-http-cannot-see-css-background',
      !httpUrls.has(`${BASE}/img/ok/css-bg.png`) && rows.some((r) => r.url === `${BASE}/img/ok/css-bg.png`),
      'HTML 만 훑는 http 모드는 CSS 배경을 못 본다 — 브라우저 모드만 잡는다');
    ok('F2-http-has-no-current-src',
      httpRows.every((r) => r.is_current_src === undefined),
      'http 모드에는 currentSrc 라는 개념 자체가 없다 — 어느 판이 뜰지는 렌더해 봐야 안다');
    ok('F3-http-downloads-candidates-browser-does-not',
      httpRun.outputs.images.downloaded > c.downloaded,
      `http 는 후보를 모두 받아 ${httpRun.outputs.images.downloaded}장, 브라우저는 실제로 쓴 ${c.downloaded}장`);
  }

  // ══ G. 조정 계층에서 ════════════════════════════════════════
  {
    const wsRoot = path.join(SANDBOX, 'ws2');
    fs.mkdirSync(wsRoot, { recursive: true });
    const db2 = createDb(wsRoot, path.join(wsRoot, 'workspace.db'), {
      workspaceId: '2026-08-12-bi-run', projectRoot: SANDBOX, briefPath: path.join(wsRoot, 'brief.md'), nowMs: NOW,
    });
    addUrls(db2, [{ url: `${BASE}/images/browser`, line: 1 }], { source_kind: 'seed', source_value: 'manual', nowMs: NOW });
    const lease = nextBatch(db2, wsRoot, { workerId: 'bi', count: 1, leaseMinutes: 60, nowMs: NOW });
    const r = await runCollect(db2, {
      root: wsRoot, leaseId: lease.lease_id, mode: 'browser', outputs: ['images', 'screenshot'],
      pacePath: path.join(wsRoot, 'pace.db'), paceOpts: { min_interval_ms: 1, jitter_ms: 0, retry_backoff_ms: 1 },
      fetchOptions: { fixtureAllow: ALLOW }, depsDir: DEPS_DIR, nowMs: NOW,
    });
    const idx = fs.readFileSync(path.join(wsRoot, r.index_path), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    ok('G1-through-the-coordinator',
      (r.succeeded + r.partial) === 1 && idx[0].produced.sort().join() === 'images,screenshot'
      && idx[0].warnings.includes('browser_no_pinned_connection'),
      `${idx[0].result} · ${idx[0].produced.join('·')} · 경고 ${idx[0].warnings.join('·')}`);
    const v = verifyArtifacts(db2, wsRoot);
    ok('G2-ledger-clean', v.checked === v.ok && v.orphans.length === 0 && v.manifest_missing.length === 0,
      `장부 ${v.checked}줄 전부 일치`);
    db2.close();
  }
} finally {
  await new Promise((r) => { fixture.on('exit', r); fixture.kill('SIGTERM'); setTimeout(r, 1500); });
  db.close();
}

const failed = results.filter((r) => !r.pass);
if (AS_JSON) {
  process.stdout.write(`${JSON.stringify({ pass: failed.length === 0, total: results.length, failed: failed.length, results }, null, 2)}\n`);
} else {
  for (const r of results) process.stdout.write(`${r.pass ? 'PASS' : 'FAIL'}  ${r.id}\n        ${r.detail}\n`);
  process.stdout.write(`\n${failed.length === 0 ? 'PASS' : 'FAIL'} — ${results.length - failed.length}/${results.length}\n`);
}
process.exit(failed.length === 0 ? 0 : 1);
