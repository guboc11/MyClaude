#!/usr/bin/env node
// 그림 참조·다운로드 시험 — 태스크 #27.
//
//   node tests/images/verify.mjs
//   node tests/images/verify.mjs --json
//
// 완료 조건이 "성공 manifest 행과 실제 파일·artifact 지문이 1:1 일치" 이므로,
// 줄 수·파일 수·장부 줄 수 셋을 서로 견준다. 하나라도 어긋나면 실패다.
//
// 모든 요청은 이 시험이 띄운 127.0.0.1 fixture 로만 간다.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { artifactsOf, verifyArtifacts } from '../../lib/artifacts.mjs';
import { startAttempt } from '../../lib/attempts.mjs';
import { createDb } from '../../lib/db.mjs';
import { FIXTURE_FLAG, parseFixtureAllow } from '../../lib/fixture-allow.mjs';
import { fetchSafely } from '../../lib/http.mjs';
import { addUrls } from '../../lib/items.mjs';
import { collectHttp } from '../../lib/collect/http.mjs';
import { extractImageRefs, parseSrcset } from '../../lib/collect/extract-images.mjs';
import { collectImages, sniffImageMime } from '../../lib/collect/images.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_SERVER = path.resolve(HERE, '..', 'fixtures', 'server.mjs');
const AS_JSON = process.argv.includes('--json');

let fetchAttempts = 0;
globalThis.fetch = (...a) => { fetchAttempts++; throw new Error(`fetch 금지: ${String(a[0]).slice(0, 60)}`); };

const results = [];
const ok = (id, pass, detail) => results.push({ id, pass: Boolean(pass), detail: String(detail) });
const sha = (buf) => createHash('sha256').update(buf).digest('hex');

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'images-'));
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
  workspaceId: '2026-08-12-images', projectRoot: SANDBOX, briefPath: path.join(root, 'brief.md'), nowMs: NOW,
});
addUrls(db, [{ url: `${BASE}/images/rich`, line: 1 }], { source_kind: 'seed', source_value: 'manual', nowMs: NOW });

let seq = 0;
const newAttempt = () => startAttempt(db, {
  itemId: 1, operation: 'collect', collector: 'http',
  requestedOutputs: ['images'], requestedUrl: `${BASE}/images/rich#${++seq}`, nowMs: NOW,
}).attempt_id;

const fileOf = (rel) => fs.readFileSync(path.join(root, rel));
const linesOf = (rel) => fileOf(rel).toString('utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

try {
  // ══ A. 참조 모으기 ══════════════════════════════════════════
  {
    const html = (await fetchSafely(`${BASE}/images/rich`, { fixtureAllow: ALLOW })).body.toString('utf8');
    const f = extractImageRefs(html, `${BASE}/images/rich`);

    ok('A1-sources-covered',
      f.counts.from_src === 10 && f.counts.from_srcset === 2 && f.counts.from_source === 2 && f.counts.from_og === 1,
      `img.src ${f.counts.from_src}(주소 없는 것 하나 포함) · img.srcset ${f.counts.from_srcset}`
      + ` · picture source ${f.counts.from_source} · og:image ${f.counts.from_og} · 참조 모두 ${f.counts.references}개`);

    const dup = f.images.find((r) => r.url === `${BASE}/img/ok/p1.png`);
    ok('A2-duplicate-is-one-row',
      dup.references.length === 2 && dup.references.map((x) => x.alt).join('·') === '첫째·첫째를 다시'
      && f.images.filter((r) => r.url === dup.url).length === 1,
      `같은 주소 두 번 → 줄 하나에 참조 ${dup.references.length}개 (${dup.references.map((x) => x.alt).join('·')})`);

    const srcsetRow = f.images.find((r) => r.url === `${BASE}/img/ok/p2@2x.png`);
    ok('A3-srcset-parsed',
      srcsetRow && srcsetRow.references[0].from === 'img.srcset'
      && f.images.some((r) => r.url === `${BASE}/img/ok/p3-wide.webp`),
      `srcset 의 두 배 판과 picture 의 넓은 판을 따로 잡는다`);

    const og = f.images.find((r) => r.url === `${BASE}/img/ok/og.png`);
    ok('A4-og-image',
      og && og.references[0].from === 'og:image' && og.references[0].where === 'head',
      `대표 그림을 ${og.references[0].from} 로 잡는다`);

    ok('A5-data-uri-and-no-src',
      f.counts.data_uri === 1 && f.counts.no_src === 1,
      `문서 안에 든 그림 ${f.counts.data_uri}개 · 주소 없는 img ${f.counts.no_src}개 — 버리지 않고 줄로 남긴다`);

    ok('A6-no-meaning-filter',
      f.images.some((r) => r.references.some((x) => x.width === '60')) && f.counts.unique === 11,
      `크기·이름으로 거르지 않는다 · 서로 다른 주소 ${f.counts.unique}개`);

    ok('A7-srcset-parser',
      JSON.stringify(parseSrcset('a.png 1x, b.png 2x')) === '["a.png","b.png"]'
      && JSON.stringify(parseSrcset('  c.png 300w ,d.png 600w ')) === '["c.png","d.png"]'
      && JSON.stringify(parseSrcset('data:image/gif;base64,AAA= 1x, e.png 2x')) === '["data:image/gif;base64,AAA=","e.png"]',
      'data: 안의 쉼표에 속지 않는다');
  }

  // ══ B. 내려받기 ═════════════════════════════════════════════
  let rich = null;
  {
    const attemptId = newAttempt();
    const html = (await fetchSafely(`${BASE}/images/rich`, { fixtureAllow: ALLOW })).body.toString('utf8');
    rich = await collectImages(db, {
      root, attemptId, html, pageUrl: `${BASE}/images/rich`,
      fetchOptions: { fixtureAllow: ALLOW }, nowMs: NOW,
    });
    const rows = linesOf(rich.manifest.path);
    const good = rows.filter((r) => r.ok);
    const byUrl = (u) => rows.find((r) => r.url === `${BASE}${u}`);

    ok('B1-partial-not-total',
      rich.counts.downloaded === 8 && rich.counts.failed === 3 && good.length === 8,
      `받은 것 ${rich.counts.downloaded} · 못 받은 것 ${rich.counts.failed} — 셋이 실패해도 여덟은 남는다`);

    ok('B2-warning-is-partial',
      rich.warnings.includes('image_fetch_partial') && !rich.warnings.includes('image_fetch_none'),
      `경고 ${rich.warnings.join('·')}`);

    ok('B3-404',
      byUrl('/img/fail/p6.png').ok === false && byUrl('/img/fail/p6.png').reason === 'http_error'
      && byUrl('/img/fail/p6.png').http_status === 404,
      `${byUrl('/img/fail/p6.png').reason} · 상태 ${byUrl('/img/fail/p6.png').http_status}`);

    ok('B4-wrong-mime',
      byUrl('/img/wrong-mime/p5.png').ok === false && byUrl('/img/wrong-mime/p5.png').reason === 'not_an_image'
      && byUrl('/img/wrong-mime/p5.png').declared_mime === 'text/html'
      && byUrl('/img/wrong-mime/p5.png').sniffed_mime === null
      && byUrl('/img/wrong-mime/p5.png').path === null,
      `머리는 ${byUrl('/img/wrong-mime/p5.png').declared_mime} 이고 바이트는 그림이 아니다 → 저장하지 않는다`);

    ok('B5-too-large',
      byUrl('/img/large/p7.png').ok === false && byUrl('/img/large/p7.png').reason === 'too_large'
      && byUrl('/img/large/p7.png').path === null,
      `3MB 그림이 ${byUrl('/img/large/p7.png').reason} 로 걸리고 파일은 안 남는다`);

    const red = byUrl('/img/redirect/p4.png');
    ok('B6-redirected-image',
      red.ok === true && red.redirected === true && red.final_url === `${BASE}/img/ok/p1.png`
      && red.url === `${BASE}/img/redirect/p4.png`,
      `요청 ${red.url.replace(BASE, '')} → 도착 ${red.final_url.replace(BASE, '')} · 둘 다 적는다`);

    ok('B7-mime-recorded',
      good.every((r) => r.declared_mime === 'image/png' && r.sniffed_mime === 'image/png' && r.mime_mismatch === false),
      `받은 ${good.length}장 모두 머리와 바이트가 같은 형식이라고 말한다`);

    ok('B8-data-uri-not-downloaded',
      rows.find((r) => r.reason === 'data_uri')?.path === null
      && rows.find((r) => r.reason === 'no_src')?.url === null,
      '문서 안에 든 그림은 받지 않는다 — 바이트는 이미 dom.html.gz 에 있다');
  }

  // ══ C. 완료 조건 — 줄·파일·장부가 1:1 ══════════════════════
  {
    const rows = linesOf(rich.manifest.path);
    const good = rows.filter((r) => r.ok);
    const dir = path.join(root, path.dirname(rich.manifest.path), 'images');
    const files = fs.readdirSync(dir).sort();
    const imageRows = artifactsOf(db, linesOf(rich.manifest.path)[0] ? null : null);

    const dbImages = db.prepare("SELECT path, byte_size, sha256 FROM artifacts WHERE kind = 'image' ORDER BY path").all();
    const mismatched = good.filter((r) => {
      const abs = path.join(root, r.path);
      return !fs.existsSync(abs) || fs.statSync(abs).size !== r.byte_size || sha(fs.readFileSync(abs)) !== r.sha256;
    });
    const notInDb = good.filter((r) => !dbImages.some((d) => d.path === r.path && d.sha256 === r.sha256 && d.byte_size === r.byte_size));

    ok('C1-one-to-one',
      good.length === files.length && good.length === dbImages.length
      && mismatched.length === 0 && notInDb.length === 0,
      `성공 줄 ${good.length} · 실제 파일 ${files.length} · 장부 ${dbImages.length} · 지문 어긋남 ${mismatched.length}`);

    ok('C2-failed-rows-have-no-file',
      rows.filter((r) => !r.ok).every((r) => r.path === null && r.sha256 === null)
      && files.every((f) => good.some((r) => r.path.endsWith(`/${f}`))),
      `못 받은 줄에는 경로가 없고, 폴더의 ${files.length}개 파일은 모두 성공 줄이 가리킨다`);

    ok('C3-names-are-stable',
      files.every((f) => /^i\d{3}-[0-9a-f]{8}\.(png|jpg|gif|webp|bin)$/.test(f)),
      `파일 이름이 자리·주소지문으로 정해진다: ${files.slice(0, 3).join(', ')}…`);

    const v = verifyArtifacts(db, root);
    ok('C4-ledger-clean',
      v.checked === v.ok && v.orphans.length === 0 && v.incomplete.length === 0 && v.sha_mismatch.length === 0,
      `장부 ${v.checked}줄 전부 파일과 일치 · 고아 ${v.orphans.length} · 만들다 만 것 ${v.incomplete.length}`);
  }

  // ══ D. 상한과 예약 ══════════════════════════════════════════
  {
    const attemptId = newAttempt();
    const html = (await fetchSafely(`${BASE}/images/rich`, { fixtureAllow: ALLOW })).body.toString('utf8');
    const capped = await collectImages(db, {
      root, attemptId, html, pageUrl: `${BASE}/images/rich`,
      fetchOptions: { fixtureAllow: ALLOW }, maxImages: 3, nowMs: NOW,
    });
    const rows = linesOf(capped.manifest.path);
    ok('D1-max-images',
      capped.counts.over_limit === 8 && capped.counts.downloaded === 3 && capped.counts.failed === 0
      && rows.length === 13 && capped.warnings.join() === 'images_over_limit',
      `상한 3장 → 받은 것 ${capped.counts.downloaded} · 안 시도한 ${capped.counts.over_limit}개도 줄로는 남는다`
      + ` (전체 ${rows.length}줄) · 경고는 ${capped.warnings.join('·')} 뿐 — 못 받은 것과 안 시도한 것을 섞지 않는다`);

    // 내려받기마다 감싼 함수가 불렸는가 — #28 이 여기에 예약을 끼운다
    const calls = [];
    const counting = async (u, o) => { calls.push(u); return fetchSafely(u, o); };
    const attempt2 = newAttempt();
    await collectImages(db, {
      root, attemptId: attempt2, html, pageUrl: `${BASE}/images/rich`,
      fetchImage: counting, fetchOptions: { fixtureAllow: ALLOW }, nowMs: NOW,
    });
    ok('D2-one-call-per-unique-image',
      calls.length === 11 && new Set(calls).size === 11,
      `서로 다른 주소 ${new Set(calls).size}개에 요청 ${calls.length}번 — 중복은 한 번만 받는다`);
  }

  // ══ E. collect 버튼 쪽에서 ══════════════════════════════════
  {
    const attemptId = newAttempt();
    const r = await collectHttp(db, {
      root, attemptId, url: `${BASE}/images/rich`, outputs: ['images'],
      fetchOptions: { fixtureAllow: ALLOW }, nowMs: NOW,
    });
    const asJson = JSON.stringify(r);
    ok('E1-images-as-an-output',
      r.ok && r.produced.join() === 'images' && r.outputs.images.downloaded === 8
      && r.warnings.includes('image_fetch_partial'),
      `images 만 요청 → 받은 것 ${r.outputs.images.downloaded} · 경고 ${r.warnings.join('·')}`);
    ok('E2-no-content-in-response',
      !asJson.includes('data:image') && !asJson.includes('<img') && asJson.length < 1200,
      `응답 ${asJson.length}바이트에 원문이 없다 — 개수와 경로뿐`);

    const dir = path.dirname(path.join(root, r.outputs.images.path));
    ok('E3-only-requested',
      fs.readdirSync(dir).sort().join() === 'images,images.jsonl',
      `images 만 요청했으니 ${fs.readdirSync(dir).sort().join('·')} 뿐 — text·dom 은 없다`);
  }

  // ══ F. 조각 함수 ════════════════════════════════════════════
  {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
    ok('F1-sniff',
      sniffImageMime(png) === 'image/png'
      && sniffImageMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0])) === 'image/jpeg'
      && sniffImageMime(Buffer.from('GIF89a')) === 'image/gif'
      && sniffImageMime(Buffer.from('RIFF    WEBPVP8 ')) === 'image/webp'
      && sniffImageMime(Buffer.from('<svg xmlns="x">')) === 'image/svg+xml'
      && sniffImageMime(Buffer.from('<!doctype html>')) === null,
      'PNG·JPEG·GIF·WEBP·SVG 를 바이트로 알아보고 HTML 은 아니라고 한다');
    ok('F2-no-global-fetch', fetchAttempts === 0, `fetch 시도 ${fetchAttempts}회`);
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
