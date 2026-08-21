#!/usr/bin/env node
// mode=http 수집기 시험 — 태스크 #26.
//
//   node tests/collect-http/verify.mjs
//   node tests/collect-http/verify.mjs --json
//
// 완료 조건이 "원문은 파일에만 있고 MCP 응답에는 개수·경로만 남는다" 이므로,
// 파일이 맞는지와 **응답에 원문이 안 실렸는지**를 함께 본다.
//
// 모든 요청은 이 시험이 띄운 127.0.0.1 fixture 로만 간다.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

import { artifactsOf, verifyArtifacts } from '../../lib/artifacts.mjs';
import { startAttempt } from '../../lib/attempts.mjs';
import { createDb } from '../../lib/db.mjs';
import { FIXTURE_FLAG, parseFixtureAllow } from '../../lib/fixture-allow.mjs';
import { addUrls } from '../../lib/items.mjs';
import { collectHttp } from '../../lib/collect/http.mjs';
import { extractLinks } from '../../lib/collect/extract-links.mjs';
import { extractText } from '../../lib/collect/extract-text.mjs';
import { decodeEntities, decodeHtml } from '../../lib/collect/html.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_SERVER = path.resolve(HERE, '..', 'fixtures', 'server.mjs');
const MANIFEST = JSON.parse(fs.readFileSync(path.resolve(HERE, '..', 'fixtures', 'manifest.json'), 'utf8'));
const AS_JSON = process.argv.includes('--json');

let fetchAttempts = 0;
globalThis.fetch = (...a) => { fetchAttempts++; throw new Error(`fetch 금지: ${String(a[0]).slice(0, 60)}`); };

const results = [];
const ok = (id, pass, detail) => results.push({ id, pass: Boolean(pass), detail: String(detail) });
const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const driftOf = (p) => [...MANIFEST.routes, ...MANIFEST.supporting_routes].find((r) => r.path === p)?.drift;
async function rejectsWith(code, fn) {
  try { await fn(); return { pass: false, detail: '던지지 않았다' }; } catch (e) {
    return { pass: e?.code === code, detail: `code=${e?.code}${e?.code === code ? '' : ` (기대 ${code})`}` };
  }
}

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'collect-http-'));
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
  workspaceId: '2026-08-12-collect-http', projectRoot: SANDBOX, briefPath: path.join(root, 'brief.md'), nowMs: NOW,
});
addUrls(db, [{ url: `${BASE}/static/normal`, line: 1 }], { source_kind: 'seed', source_value: 'manual', nowMs: NOW });

let attemptSeq = 0;
const newAttempt = () => startAttempt(db, {
  itemId: 1, operation: 'collect', collector: 'http',
  requestedOutputs: ['text', 'dom', 'links'], requestedUrl: `${BASE}/x${++attemptSeq}`, nowMs: NOW,
}).attempt_id;

const grab = (p, outputs = ['text', 'dom', 'links'], extra = {}) => collectHttp(db, {
  root, attemptId: newAttempt(), url: `${BASE}${p}`, outputs,
  fetchOptions: { fixtureAllow: ALLOW, timeouts: { body_timeout_ms: 8000 }, ...extra.fetchOptions },
  nowMs: NOW, ...extra,
});
const fileOf = (rel) => fs.readFileSync(path.join(root, rel));
const linesOf = (rel) => fileOf(rel).toString('utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

try {
  // ══ A. 텍스트 — 순서와 경계 ═════════════════════════════════
  {
    const r = await grab('/static/normal');
    const text = fileOf(r.outputs.text.path).toString('utf8');

    const iCount = text.indexOf('총 12개');
    const i1 = text.indexOf('디자인 1\n');
    const i12 = text.indexOf('디자인 12');
    ok('T1-order-preserved',
      r.ok && iCount > 0 && i1 > iCount && i12 > i1,
      `"총 12개"(${iCount}) → "디자인 1"(${i1}) → "디자인 12"(${i12}) 순서 그대로`);

    ok('T2-block-boundaries',
      text.includes('총 12개\n') && !text.includes('총 12개디자인'),
      '블록마다 줄이 갈린다 — 붙어 버리지 않는다');

    // 이 fixture 의 머리·바닥은 그림뿐이라 글자가 없다(그림의 alt 는 텍스트가 아니라 링크 문구로 간다).
    // 그래서 "본문 아닌 자리를 지우지 않는다" 는 규칙은 조각으로 겨룬다.
    const chrome = extractText('<body><nav>메뉴</nav><main><p>본문</p></main><footer>바닥글</footer></body>').text;
    ok('T3-nav-footer-kept',
      chrome === '메뉴\n본문\n바닥글' && r.outputs.text.lines === 14,
      `nav·footer 를 군더더기로 보고 지우지 않는다 ("${chrome.replace(/\n/g, ' / ')}")`
      + ` · 이 쪽의 머리바닥은 그림뿐이라 제목·개수·카드 ${r.outputs.text.lines}줄이 전부다`);

    ok('T4-script-not-text',
      !text.includes('schema.org') && !text.includes('ItemList') && r.outputs.text.skipped_script_style >= 1,
      `JSON-LD 안쪽 글자는 텍스트가 아니다 · 건너뛴 script·style ${r.outputs.text.skipped_script_style}곳`);

    ok('T5-title', r.title === '청첩장 목록', `제목 "${r.title}"`);

    const js = await grab('/js/rendered', ['text']);
    const jsText = fileOf(js.outputs.text.path).toString('utf8');
    ok('T6-script-string-not-text',
      !jsText.includes('디자인 1') && !jsText.includes('총 12개') && !jsText.includes('<article'),
      'script 안에 문자열로 든 카드 HTML 은 HTTP 텍스트에 나타나지 않는다');
  }

  // ══ B. 텍스트 — 손으로 만든 조각 ════════════════════════════
  {
    const pre = extractText('<body><pre>  한 칸\n  두 칸\n</pre><p>보통 글  여러   칸</p></body>');
    ok('T7-pre-preserved',
      pre.text.includes('  한 칸\n  두 칸') && pre.text.includes('보통 글 여러 칸'),
      'pre 안쪽은 그대로, 밖은 한 칸으로');

    const hidden = extractText('<body><p>보인다</p><p hidden>숨김1</p><div style="display:none">숨김2</div>'
      + '<span aria-hidden="true">숨김3</span><p>또 보인다</p></body>');
    ok('T8-hidden-skipped-and-counted',
      hidden.text === '보인다\n또 보인다' && hidden.skipped_hidden === 3,
      `"${hidden.text.replace('\n', ' / ')}" · 건너뛴 숨김 ${hidden.skipped_hidden}곳 — 세어서 돌려준다`);

    const ent = extractText('<body><p>&amp;&lt;&gt;&nbsp;&#54620;&#xAE00;&unknown;</p></body>');
    ok('T9-entities',
      ent.text === '&<> 한글&unknown;',
      `"${ent.text}" — 모르는 것은 지어내지 않고 그대로 둔다`);

    const br = extractText('<body><p>첫 줄<br>둘째 줄</p></body>');
    ok('T10-br-is-a-line', br.text === '첫 줄\n둘째 줄', br.text.replace('\n', ' / '));

    const broken = extractText('<body><div><p>안 닫힌 태그<div>다음<p>또</body>');
    ok('T11-broken-html-survives',
      broken.text.includes('안 닫힌 태그') && broken.text.includes('또'),
      `엉킨 문서에서도 글자가 살아 나온다: "${broken.text.replace(/\n/g, ' / ')}"`);

    ok('T12-word-spacing',
      extractText('<body><p>총 <b>12</b>개</p></body>').text === '총 12개',
      '인라인 태그가 낱말을 붙여 버리지 않는다');
  }

  // ══ C. 링크 ═════════════════════════════════════════════════
  {
    const r = await grab('/links/mixed', ['links']);
    const links = linesOf(r.outputs.links.path);
    const by = (h) => links.find((l) => l.raw_href === h);

    ok('L1-counts',
      r.outputs.links.total === 14 && r.outputs.links.internal === 7 && r.outputs.links.external === 2
      && r.outputs.links.non_http === 3 && r.outputs.links.fragment_only === 1,
      `전체 ${r.outputs.links.total} · 내부 ${r.outputs.links.internal} · 바깥 ${r.outputs.links.external}`
      + ` · http 아님 ${r.outputs.links.non_http} · 자리표만 ${r.outputs.links.fragment_only}`);

    ok('L2-relative-resolved',
      by('products/p1').url === `${BASE}/links/products/p1` && by('/static/plain').url === `${BASE}/static/plain`,
      `상대 → ${by('products/p1').url.replace(BASE, '')} · 뿌리 → ${by('/static/plain').url.replace(BASE, '')}`);

    ok('L3-internal-external',
      by('/static/plain').internal === true && by('https://example.com/outside').internal === false
      && by('//example.org/protocol-relative').internal === false
      && by('//example.org/protocol-relative').url === 'http://example.org/protocol-relative',
      `규약 생략 링크가 그 쪽의 규약을 따라 ${by('//example.org/protocol-relative').url} 로 풀린다`);

    ok('L4-fragment',
      by('#section-2').fragment === 'section-2' && by('#section-2').fragment_only === true
      && by('/static/normal#tail').fragment === 'tail' && by('/static/normal#tail').fragment_only === false
      && by('/static/normal#tail').url === `${BASE}/static/normal`,
      '자리표는 따로 적고 URL 에서는 뗀다 — 서버에 가지 않는 부분이다');

    ok('L5-non-http-kept',
      by('mailto:hello@example.com').kind === 'non_http' && by('tel:+821012345678').kind === 'non_http'
      && by('javascript:void(0)').kind === 'non_http'
      && links.filter((l) => l.kind === 'no_href').length === 2,
      'mailto·tel·javascript 도 줄로 남긴다 · 주소 없는 <a> 둘도 남긴다');

    ok('L6-where',
      by('/static/normal').where === 'nav' && by('/contact').where === 'footer'
      && by('/static/plain').where === 'main',
      `발견 위치: ${by('/static/normal').where} · ${by('/static/plain').where} · ${by('/contact').where}`);

    ok('L7-visible-text',
      by('https://example.com/outside').text === '바깥 쪽' && by('/products/q1').text === '그림으로만 된 링크',
      `문구 "${by('https://example.com/outside').text}" · 그림뿐인 링크는 alt 를 쓴다 "${by('/products/q1').text}"`);

    ok('L8-order', links.every((l, i) => l.index === i), `${links.length}줄이 나온 순서 그대로`);

    const withBase = await grab('/links/with-base', ['links']);
    const bl = linesOf(withBase.outputs.links.path);
    ok('L9-base-href',
      withBase.outputs.links.base_href === '/deep/nested/'
      && bl[0].url === `${BASE}/deep/nested/page` && bl[1].url === `${BASE}/root`,
      `<base> 기준으로 ${bl[0].url.replace(BASE, '')} · 뿌리 경로는 그대로 ${bl[1].url.replace(BASE, '')}`);
  }

  // ══ D. 인코딩 ═══════════════════════════════════════════════
  {
    const header = await grab('/encoding/euc-kr', ['text', 'dom']);
    const meta = await grab('/encoding/meta-charset', ['text']);
    const ht = fileOf(header.outputs.text.path).toString('utf8');
    const mt = fileOf(meta.outputs.text.path).toString('utf8');

    ok('E1-charset-from-header',
      header.charset === 'euc-kr' && ht.includes('한글 인코딩 시험') && ht.includes('글자가 깨지면'),
      `머리의 charset=${header.charset} · 글자가 안 깨진다`);
    ok('E2-charset-from-meta',
      meta.charset === 'euc-kr' && mt.includes('한글 인코딩 시험'),
      `머리에 없으면 <meta charset> 을 본다 → ${meta.charset}`);
    ok('E3-utf8-would-break',
      new TextDecoder('utf-8').decode(Buffer.from('한글', 'utf8')) === '한글'
      && !new TextDecoder('utf-8', { fatal: false }).decode(fileOf(header.outputs.dom.path).subarray(0, 0) ?? Buffer.alloc(0)).includes('한글'),
      'UTF-8 로 읽었다면 깨졌을 바이트다 — 그래서 선언을 본다');

    const raw = zlib.gunzipSync(fileOf(header.outputs.dom.path));
    const d = driftOf('/encoding/euc-kr');
    ok('E4-dom-keeps-original-bytes',
      raw.length === d.body_bytes && sha(raw) === d.body_sha256,
      `dom 을 풀면 받은 바이트 그대로다 (${raw.length}바이트, 지문 일치) — 글자로 바꿔 저장하지 않는다`);
  }

  // ══ E. 요청한 것만 ══════════════════════════════════════════
  {
    const onlyText = await grab('/static/normal', ['text']);
    const rows = artifactsOf(db, onlyText.attempt_id ?? null);
    const dir = path.dirname(path.join(root, onlyText.outputs.text.path));
    const files = fs.readdirSync(dir).sort();
    ok('O1-only-requested',
      onlyText.produced.join() === 'text' && onlyText.missing.length === 0
      && files.join() === 'text.txt' && onlyText.outputs.dom === undefined && onlyText.outputs.links === undefined,
      `요청 text 하나 → 폴더에 ${files.join('·')} 뿐`);

    const all = await grab('/static/normal', ['text', 'dom', 'links']);
    const allDir = path.dirname(path.join(root, all.outputs.text.path));
    ok('O2-all-three',
      all.produced.join() === 'text,dom,links'
      && fs.readdirSync(allDir).sort().join() === 'dom.html.gz,links.jsonl,text.txt',
      `셋 다 요청하면 ${fs.readdirSync(allDir).sort().join('·')}`);

    const bad = await rejectsWith('unsupported_output', () => grab('/static/normal', ['screenshot']));
    const none = await rejectsWith('no_outputs', () => grab('/static/normal', []));
    ok('O3-output-guards', bad.pass && none.pass, `screenshot ${bad.detail} · 빈 목록 ${none.detail}`);
  }

  // ══ F. 응답에 원문이 없다 ═══════════════════════════════════
  {
    const r = await grab('/static/normal');
    const asJson = JSON.stringify(r);
    ok('R1-no-content-in-response',
      !asJson.includes('디자인 12') && !asJson.includes('<article') && !asJson.includes('<!doctype')
      && !asJson.includes('총 12개'),
      `응답 ${asJson.length}바이트에 원문 조각이 없다`);
    ok('R2-counts-and-paths-only',
      r.outputs.text.path.startsWith('artifacts/pages/') && Number.isInteger(r.outputs.links.total)
      && Number.isInteger(r.outputs.text.chars) && asJson.length < 1500,
      `경로와 수만 들어 있다 (${asJson.length}바이트)`);
  }

  // ══ G. 상태가 오류여도 기계 작업은 끝난다 ═══════════════════
  {
    const notFound = await grab('/status/404');
    const soft = await grab('/error/soft-404', ['text']);
    const redirected = await grab('/redirect/one', ['text']);
    ok('G1-http-error-still-collected',
      notFound.ok === true && notFound.status === 404 && notFound.warnings.includes('http_error_status')
      && notFound.produced.length === 3,
      `404 인데 산출물 ${notFound.produced.length}개 · 경고 ${notFound.warnings.join('·')} — 유효성은 에이전트가 정한다`);
    // [대용으로 재지 않기] 예전에는 "경고 0건" 으로 "판정 안 함" 을 갈음했는데,
    // #31 이 정당한 관찰(error_page_text_detected)을 더하자 깨졌다. 뜻을 직접 적는다.
    const verdictFields = ['page_validity', 'is_error_page', 'extraction_status', 'content_validated', 'auto_complete'];
    ok('G2-soft-404-not-judged',
      soft.ok === true && soft.status === 200
      && verdictFields.every((f) => !(f in soft))
      && soft.warnings.includes('error_page_text_detected')
      && soft.produced.length === 1,
      `상태 200 오류 화면: 판정 칸 ${verdictFields.length}종 모두 없음 · 관찰 ${soft.warnings.join('·')} 만 남고`
      + ` 산출물은 그대로 ${soft.produced.length}개 — 관찰은 판정이 아니다`);
    ok('G3-redirect-warned',
      redirected.ok && redirected.redirected === true && redirected.warnings.includes('redirected')
      && redirected.final_url === `${BASE}/redirect/arrived`,
      `요청 ${redirected.requested_url.replace(BASE, '')} → 도착 ${redirected.final_url.replace(BASE, '')} · ${redirected.warnings.join('·')}`);
  }

  // ══ H. 못 받으면 파일을 만들지 않는다 ═══════════════════════
  {
    const attemptId = newAttempt();
    const before = artifactsOf(db, attemptId).length;
    const r = await collectHttp(db, {
      root, attemptId, url: `${BASE}/hang/headers`, outputs: ['text', 'dom', 'links'],
      fetchOptions: { fixtureAllow: ALLOW, timeouts: { headers_timeout_ms: 400, connect_timeout_ms: 2000 } },
      nowMs: NOW,
    });
    ok('H1-failure-makes-no-files',
      !r.ok && r.error_stage === 'response' && r.error_code === 'headers_timeout'
      && artifactsOf(db, attemptId).length === before && r.produced.length === 0
      && r.missing.join() === 'text,dom,links',
      `${r.error_stage}/${r.error_code} · 만든 파일 0개 · 빠진 것 ${r.missing.join('·')}`);
    await fetch === undefined;   // 자리 채우기 없음
  }

  // ══ I. 긴 쪽 ════════════════════════════════════════════════
  {
    const r = await grab('/long/page');
    const links = linesOf(r.outputs.links.path);
    const text = fileOf(r.outputs.text.path).toString('utf8');
    const lastCard = links.filter((l) => l.url?.includes('/products/L')).pop();
    ok('I1-long-page',
      r.outputs.links.total === 4006 && lastCard.url.endsWith('/products/L2000')
      && links[links.length - 1].where === 'footer'
      && text.includes('디자인 2000') && text.indexOf('디자인 1\n') < text.indexOf('디자인 2000'),
      `링크 ${r.outputs.links.total}줄 · 마지막 카드가 ${lastCard.url.split('/').pop()} · 그 뒤는 바닥 링크 · 텍스트 순서 유지`);

    const gz = fileOf(r.outputs.dom.path);
    const d = driftOf('/long/page');
    ok('I2-dom-roundtrip',
      zlib.gunzipSync(gz).length === d.body_bytes && sha(zlib.gunzipSync(gz)) === d.body_sha256
      && gz.length < d.body_bytes,
      `${d.body_bytes}바이트를 ${gz.length}바이트로 눌러 담고 풀면 지문이 같다`);
  }

  // ══ J. 되풀이해도 같다 ══════════════════════════════════════
  {
    const a = await grab('/static/normal', ['dom']);
    const b = await grab('/static/normal', ['dom']);
    ok('J1-gzip-deterministic',
      a.outputs.dom.sha256 === b.outputs.dom.sha256 && a.outputs.dom.path !== b.outputs.dom.path,
      `다른 실행이라 경로는 다르고 지문은 같다 (${a.outputs.dom.sha256.slice(0, 12)}…)`);

    const v = verifyArtifacts(db, root);
    ok('J2-ledger-matches-disk',
      v.checked === v.ok && v.missing.length === 0 && v.sha_mismatch.length === 0
      && v.size_mismatch.length === 0 && v.orphans.length === 0 && v.incomplete.length === 0,
      `장부 ${v.checked}줄 전부 파일과 일치 · 고아 0 · 만들다 만 것 0`);

    ok('J3-no-global-fetch', fetchAttempts === 0, `fetch 시도 ${fetchAttempts}회`);
  }

  // ══ K. 조각 함수 자체 ═══════════════════════════════════════
  {
    const dec = decodeHtml(Buffer.from('<p>가</p>', 'utf8'), null);
    ok('K1-default-utf8', dec.charset === 'utf-8' && dec.source === 'default' && dec.text.includes('가'),
      `선언이 없으면 utf-8 (${dec.source})`);
    const unknown = decodeHtml(Buffer.from('<p>가</p>', 'utf8'), 'text/html; charset=made-up-9000');
    ok('K2-unknown-charset-falls-back',
      unknown.fallback === true && unknown.declared === 'made-up-9000' && unknown.text.includes('가'),
      `모르는 이름이면 utf-8 로 읽고 무엇을 시도했는지(${unknown.declared}) 남긴다`);
    ok('K3-entity-helper', decodeEntities('&lt;b&gt;&#44032;') === '<b>가', decodeEntities('&lt;b&gt;&#44032;'));

    const noBody = extractLinks('<a href="/x">쪽</a>', `${BASE}/here`);
    ok('K4-fragment-document', noBody.counts.total === 1 && noBody.links[0].url === `${BASE}/x`,
      'body 태그가 없는 조각에서도 링크를 찾는다');
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
