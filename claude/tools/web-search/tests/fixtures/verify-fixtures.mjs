#!/usr/bin/env node
// 로컬 fixture 자기검사 — 태스크 #22 의 완료 조건.
//
//   node tests/fixtures/verify-fixtures.mjs              전부 검사 (exit 0 이면 통과)
//   node tests/fixtures/verify-fixtures.mjs --json
//   node tests/fixtures/verify-fixtures.mjs --write-drift  잰 값을 manifest 의 drift 에 채운다
//
// 두 갈래를 본다.
//   (가) 여덟 종류가 결정적으로 재현되는가 — manifest 의 손으로 적은 기대값과 실제 응답을 대조한다.
//        기대 수(링크·그림)는 manifest 에 사람이 적고, 실제 수는 여기서 HTML 을 따로 센다.
//        두 수가 따로 만들어졌다는 것이 요점이다. 한쪽이 다른 쪽을 계산해 주면 시험이 빈다.
//   (나) 운영 안전 규칙이 그대로인가 — 루프백으로 나가는 문이 argv 하나뿐이고,
//        MCP 입력·workspace·환경변수로는 열리지 않는가.
//
// 이 시험은 자기가 띄운 127.0.0.1 자식 서버 말고는 어디에도 나가지 않는다. 마지막에 그것도 확인한다.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { FIXTURE_FLAG, FixtureAllowError, isFixtureAllowed, parseFixtureAllow } from '../../lib/fixture-allow.mjs';
import { checkTarget } from '../../lib/network-policy.mjs';
import { TOOL_SCHEMAS } from '../../lib/tool-schemas.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOL_ROOT = path.resolve(HERE, '..', '..');
const SERVER = path.join(HERE, 'server.mjs');
const MANIFEST = path.join(HERE, 'manifest.json');

const WRITE_DRIFT = process.argv.includes('--write-drift');
const AS_JSON = process.argv.includes('--json');
const SMOKE = process.argv.includes('--smoke');

const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));

// ── 밖으로 나가지 않는지 지켜본다 ──────────────────────────────
const contacted = new Set();
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const u = new URL(typeof input === 'string' ? input : input.url);
  contacted.add(u.host);
  return realFetch(input, init);
};

// ── 판정 모으기 ───────────────────────────────────────────────
const results = [];
const add = (id, title, pass, detail) => results.push({ id, title, pass: Boolean(pass), detail: String(detail) });
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

// ── HTML 세기 — manifest 와 독립된 셈 ─────────────────────────

/** script·style·주석을 지운다. 사람 눈에 마크업으로 보이는 것만 남긴다. */
const strip = (html) => html
  .replace(/<!--[\s\S]*?-->/g, ' ')
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ');

const countLinks = (html) => (strip(html).match(/<a\b[^>]*\shref\s*=/gi) || []).length;
const countImages = (html) => (strip(html).match(/<img\b[^>]*\ssrc\s*=/gi) || []).length;
const titleOf = (html) => (html.match(/<title>([\s\S]*?)<\/title>/i) || [null, ''])[1].trim();

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' };
const textOf = (html) => strip(html)
  .replace(/<[^>]+>/g, ' ')
  .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (m) => ENTITIES[m])
  .replace(/\s+/g, ' ')
  .trim();

// ── 서버 하나 띄우기 ──────────────────────────────────────────

function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`서버가 5초 안에 안 떴다: ${err.slice(0, 300)}`)); }, 5000);
    child.stderr.on('data', (d) => { err += d; });
    child.stdout.on('data', (d) => {
      out += d;
      const line = out.split('\n')[0];
      if (out.includes('\n') && line.startsWith('http://')) {
        clearTimeout(timer);
        resolve({ child, base: line.trim() });
      }
    });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`서버가 바로 끝났다 (code=${code}) ${err.slice(0, 300)}`)); });
  });
}

const stopServer = (child) => new Promise((resolve) => {
  child.on('exit', resolve);
  child.kill('SIGTERM');
  setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 1500);
});

// ── 한 프로세스에서 모든 라우트를 한 번씩만 받아 둔다 ──────────
// /slow/2s 처럼 느린 곳을 검사마다 다시 부르면 시험이 쓸데없이 길어진다.

const GENERIC_SKIP = new Set(['/hang/headers', '/hang/body', '/status/429-then-200']);

async function snapshot(base) {
  const paths = [
    ...manifest.routes.map((r) => r.path),
    ...manifest.supporting_routes.map((r) => r.path),
  ].filter((p) => !GENERIC_SKIP.has(p));

  const map = new Map();
  for (const p of paths) {
    const started = Date.now();
    const res = await fetch(base + p, { redirect: 'manual' });
    const body = Buffer.from(await res.arrayBuffer());
    map.set(p, {
      status: res.status,
      location: res.headers.get('location'),
      contentType: res.headers.get('content-type'),
      retryAfter: res.headers.get('retry-after'),
      body,
      html: body.toString('utf8'),
      elapsed: Date.now() - started,
    });
  }
  return map;
}

/** 받아 둔 응답만 걸어 최종 도착지를 찾는다. 고리는 10홉에서 끊는다. */
function follow(map, start) {
  let at = start;
  let hops = 0;
  const seen = new Set();
  while (hops < 10) {
    const r = map.get(at);
    if (!r) return { final: null, hops, reason: 'not_captured' };
    if (r.status < 300 || r.status >= 400 || !r.location) return { final: at, hops, reason: null };
    if (seen.has(at)) return { final: null, hops, reason: 'loop' };
    seen.add(at);
    at = r.location;
    hops++;
  }
  return { final: null, hops, reason: 'too_many_hops' };
}

// ── 서버 단독 smoke ───────────────────────────────────────────
// 기대값 대조 없이 "서버가 뜨고 모든 라우트가 응답한다" 만 빠르게 본다.
// fixture 를 손댄 직후, 전체 자기검사를 돌리기 전에 쓰는 자리다.

async function smoke() {
  const { child, base } = await startServer();
  const paths = [
    ...manifest.routes.map((r) => r.path),
    ...manifest.supporting_routes.map((r) => r.path),
    ...Object.keys(manifest.control_routes).filter((k) => k.startsWith('/')),
  ];
  const lines = [];
  let bad = 0;
  for (const p of paths) {
    const hanging = p.startsWith('/hang/');
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), hanging ? 400 : 6000);
    try {
      const url = p === '/status/429-then-200' ? `${base}${p}?key=smoke` : base + p;
      const res = await fetch(url, { redirect: 'manual', signal: ac.signal });
      const body = Buffer.from(await res.arrayBuffer());
      if (hanging) { bad++; lines.push(`FAIL  ${p} — 멈춰야 하는데 응답했다`); }
      else lines.push(`ok    ${p} ${res.status} ${body.length}B`);
    } catch (e) {
      if (hanging) lines.push(`ok    ${p} (예상대로 안 끝남)`);
      else { bad++; lines.push(`FAIL  ${p} — ${e.name}`); }
    }
    clearTimeout(t);
  }
  await fetch(base + '/control/release-hangs').catch(() => {});
  await stopServer(child);
  process.stdout.write(`${lines.join('\n')}\n\n${bad === 0 ? 'PASS' : 'FAIL'} — smoke ${paths.length - bad}/${paths.length} · ${base}\n`);
  process.exit(bad === 0 ? 0 : 1);
}

// ── 검사 ──────────────────────────────────────────────────────

async function main() {
  if (SMOKE) return smoke();
  const first = await startServer();
  const base = first.base;
  const port = Number(new URL(base).port);

  // F1 — 뜨는 자리
  add('F1', '서버가 127.0.0.1 에만 묶여서 뜬다',
    new URL(base).hostname === '127.0.0.1' && port > 0, `base=${base}`);

  // F2 — 여덟 종류가 다 있고 그 라우트가 표에 실재한다
  {
    const known = new Set(manifest.routes.map((r) => r.path));
    const missing = manifest.kinds.flatMap((k) => k.routes.filter((p) => !known.has(p)));
    const orphan = manifest.routes.filter((r) => !manifest.kinds.some((k) => k.id === r.kind)).map((r) => r.path);
    add('F2', '여덟 종류가 모두 있고 종류가 가리키는 라우트가 표에 있다',
      manifest.kinds.length === 8 && missing.length === 0 && orphan.length === 0,
      `종류 ${manifest.kinds.length} · 표에 없는 라우트 ${missing.length} · 종류 없는 라우트 ${orphan.length}`);
  }

  const snap = await snapshot(base);

  // F3 — 상태·최종 경로
  {
    const bad = [];
    for (const r of manifest.routes) {
      if (GENERIC_SKIP.has(r.path)) continue;
      const got = snap.get(r.path);
      const e = r.expect;
      if (e.status !== undefined && got.status !== e.status) bad.push(`${r.path} 상태 ${got.status}≠${e.status}`);
      if (e.location !== undefined && got.location !== e.location) bad.push(`${r.path} location ${got.location}≠${e.location}`);
      if (e.content_type !== undefined && got.contentType !== e.content_type) bad.push(`${r.path} 형식 ${got.contentType}≠${e.content_type}`);
      if (e.retry_after !== undefined && got.retryAfter !== e.retry_after) bad.push(`${r.path} retry-after ${got.retryAfter}≠${e.retry_after}`);
    }
    add('F3', '라우트마다 기대한 상태·location·형식이 나온다', bad.length === 0,
      bad.length ? bad.slice(0, 5).join(' / ') : `${manifest.routes.length - GENERIC_SKIP.size}개 라우트 일치`);
  }

  // F4 — 링크·그림 수를 따로 세어 대조
  {
    const bad = [];
    let checked = 0;
    for (const r of [...manifest.routes, ...manifest.supporting_routes]) {
      if (GENERIC_SKIP.has(r.path)) continue;
      const e = r.expect;
      if (e.links === undefined) continue;
      const got = snap.get(r.path);
      const links = countLinks(got.html);
      const images = countImages(got.html);
      checked++;
      if (links !== e.links) bad.push(`${r.path} 링크 ${links}≠${e.links}`);
      if (images !== e.images) bad.push(`${r.path} 그림 ${images}≠${e.images}`);
    }
    add('F4', '링크·그림 수가 manifest 에 적은 수와 같다', bad.length === 0,
      bad.length ? bad.slice(0, 6).join(' / ') : `${checked}개 라우트에서 일치`);
  }

  // F5 — 제목과 텍스트 표지
  {
    const bad = [];
    for (const r of [...manifest.routes, ...manifest.supporting_routes]) {
      if (GENERIC_SKIP.has(r.path)) continue;
      const e = r.expect;
      const got = snap.get(r.path);
      if (e.title !== undefined && titleOf(got.html) !== e.title) bad.push(`${r.path} 제목 "${titleOf(got.html)}"≠"${e.title}"`);
      const text = e.text_contains || e.text_not_contains ? textOf(got.html) : '';
      for (const needle of e.text_contains || []) if (!text.includes(needle)) bad.push(`${r.path} 에 "${needle}" 없음`);
      for (const needle of e.text_not_contains || []) if (text.includes(needle)) bad.push(`${r.path} 에 "${needle}" 있음`);
    }
    add('F5', '제목과 본문 표지가 기대와 같다', bad.length === 0,
      bad.length ? bad.slice(0, 5).join(' / ') : '제목·표지 전부 일치');
  }

  // F6 — 리다이렉트 홉과 최종 도착지
  {
    const bad = [];
    for (const r of manifest.routes.filter((x) => x.kind === 'redirect' && x.expect.hops !== undefined)) {
      const f = follow(snap, r.path);
      if (f.final !== r.expect.final_path) bad.push(`${r.path} 도착 ${f.final}≠${r.expect.final_path}`);
      if (f.hops !== r.expect.hops) bad.push(`${r.path} 홉 ${f.hops}≠${r.expect.hops}`);
    }
    const loop = follow(snap, '/redirect/loop');
    if (loop.final !== null || loop.reason !== 'loop') bad.push(`/redirect/loop 이 고리로 안 잡힘 (${loop.reason})`);
    add('F6', '리다이렉트 홉 수·도착지가 맞고 고리는 고리로 잡힌다', bad.length === 0,
      bad.length ? bad.join(' / ') : '체인 3·1홉·301·오류행 확인 · loop 는 고리로 검출');
  }

  // F7 — 429 두 번 뒤 200. key 를 새로 쓰므로 앞선 실행과 섞이지 않는다.
  let flakyDrift = null;
  {
    const key = 'verify-fixtures-run';
    const seq = [];
    for (let i = 0; i < 3; i++) {
      const res = await fetch(`${base}/status/429-then-200?key=${key}`, { redirect: 'manual' });
      const body = Buffer.from(await res.arrayBuffer());
      seq.push({ status: res.status, retryAfter: res.headers.get('retry-after'), body });
    }
    const want = manifest.routes.find((r) => r.path === '/status/429-then-200').expect.sequence;
    const bad = [];
    want.forEach((w, i) => {
      if (seq[i].status !== w.status) bad.push(`${i + 1}번째 상태 ${seq[i].status}≠${w.status}`);
      if (w.retry_after !== undefined && seq[i].retryAfter !== w.retry_after) bad.push(`${i + 1}번째 retry-after 어긋남`);
      const html = seq[i].body.toString('utf8');
      if (w.links !== undefined && countLinks(html) !== w.links) bad.push(`${i + 1}번째 링크 ${countLinks(html)}≠${w.links}`);
      if (w.images !== undefined && countImages(html) !== w.images) bad.push(`${i + 1}번째 그림 ${countImages(html)}≠${w.images}`);
      for (const needle of w.text_contains || []) if (!textOf(html).includes(needle)) bad.push(`${i + 1}번째에 "${needle}" 없음`);
    });
    flakyDrift = { body: seq[2].body, html: seq[2].body.toString('utf8') };
    add('F7', '같은 key 로 429·429·200 차례가 나온다', bad.length === 0,
      bad.length ? bad.join(' / ') : `상태 ${seq.map((s) => s.status).join('·')}`);
  }

  // F8 — 멈추는 라우트. 스스로 끊지 않으면 안 끝난다.
  let hangBodyDrift = null;
  {
    const detail = [];
    let pass = true;

    // 머리조차 안 온다 → fetch 자체가 끝나지 않는다
    {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 700);
      let arrived = false;
      try { await fetch(base + '/hang/headers', { signal: ac.signal, redirect: 'manual' }); arrived = true; }
      catch { /* 끊어서 끝난 것이 정상 */ }
      clearTimeout(t);
      if (arrived) { pass = false; detail.push('/hang/headers 가 응답을 줬다'); }
      else detail.push('/hang/headers 머리 없음');
    }

    // 머리는 오고 본문이 안 끝난다
    {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 700);
      let status = null;
      let finished = false;
      // 끊긴 뒤에도 "어디까지 왔었는지" 는 남아야 한다. 도착한 조각을 밖에 모은다 —
      // 안에서만 모으면 예외가 나는 순간 받다 만 본문이 통째로 사라져 감시 밖이 된다.
      const chunks = [];
      try {
        const res = await fetch(base + '/hang/body', { signal: ac.signal, redirect: 'manual' });
        status = res.status;
        for await (const c of res.body) chunks.push(Buffer.from(c));
        finished = true;
      } catch { /* 끊어서 끝난 것이 정상 */ }
      const partial = chunks.length ? Buffer.concat(chunks) : null;
      clearTimeout(t);
      if (status !== 200) { pass = false; detail.push(`/hang/body 상태 ${status}`); }
      if (finished) { pass = false; detail.push('/hang/body 본문이 끝났다'); }
      else detail.push('/hang/body 머리 200 · 본문 안 끝남');
      hangBodyDrift = partial;
    }

    const released = await (await fetch(base + '/control/release-hangs')).text();
    detail.push(`남은 홀딩 ${released}개 정리`);
    add('F8', '멈추는 라우트가 스스로 끝나지 않는다', pass, detail.join(' · '));
  }

  // F9 — 느린 라우트가 실제로 느리다
  {
    const r = manifest.routes.find((x) => x.path === '/slow/2s');
    const got = snap.get('/slow/2s');
    add('F9', '느린 라우트가 기대한 시간만큼 걸린다',
      got.status === 200 && got.elapsed >= r.expect.min_elapsed_ms,
      `${got.elapsed}ms (기대 ${r.expect.min_elapsed_ms}ms 이상)`);
  }

  // F10 — 그림 일부 실패
  {
    const d = manifest.routes.find((x) => x.path === '/images/partial').images_detail;
    const html = snap.get('/images/partial').html;
    const srcs = [...strip(html).matchAll(/<img\b[^>]*\ssrc\s*=\s*"([^"]+)"/gi)].map((m) => m[1]);
    const counts = { ok: 0, not_found: 0, truncated: 0, other: 0 };
    for (const src of srcs) {
      try {
        const res = await fetch(base + src);
        const buf = Buffer.from(await res.arrayBuffer());
        if (res.status === 404) counts.not_found++;
        else if (res.status === 200 && buf.length === Number(res.headers.get('content-length'))) counts.ok++;
        else counts.other++;
      } catch {
        counts.truncated++;   // 받다 만 것은 소켓이 끊겨 예외로 온다
      }
    }
    const pass = srcs.length === d.declared_in_main + d.declared_in_chrome
      && counts.ok === d.ok && counts.not_found === d.not_found && counts.truncated === d.truncated && counts.other === 0;
    add('F10', '선언된 그림 14장 중 10장 성공·3장 404·1장 잘림', pass,
      `선언 ${srcs.length} · 성공 ${counts.ok} · 404 ${counts.not_found} · 잘림 ${counts.truncated} · 그 밖 ${counts.other}`);
  }

  // F11 — 매우 긴 쪽
  {
    const r = manifest.routes.find((x) => x.path === '/long/huge');
    const huge = snap.get('/long/huge');
    const long = snap.get('/long/page');
    const okHuge = huge.body.length >= r.expect.min_body_bytes;
    const okLong = countLinks(long.html) === 4006 && countImages(long.html) === 2006;
    add('F11', '아주 긴 쪽이 크기·링크 수 기대를 채운다', okHuge && okLong,
      `huge ${(huge.body.length / 1048576).toFixed(2)}MB (기대 ${(r.expect.min_body_bytes / 1048576).toFixed(0)}MB 이상) · long 링크 ${countLinks(long.html)}·그림 ${countImages(long.html)}`);
  }

  // F12 — 결정성. 같은 프로세스에서 두 번, 그리고 포트가 다른 새 프로세스에서 한 번.
  {
    const again = await snapshot(base);
    const second = await startServer();
    const other = await snapshot(second.base);
    const otherPort = Number(new URL(second.base).port);
    await stopServer(second.child);

    const bad = [];
    for (const [p, v] of snap) {
      if (sha256(v.body) !== sha256(again.get(p).body)) bad.push(`${p} 같은 프로세스에서 달라짐`);
      if (sha256(v.body) !== sha256(other.get(p).body)) bad.push(`${p} 다른 포트에서 달라짐`);
    }
    add('F12', '같은 프로세스·다른 포트에서 같은 바이트가 나온다', bad.length === 0 && otherPort !== port,
      bad.length ? bad.slice(0, 5).join(' / ') : `${snap.size}개 라우트 · 포트 ${port} 와 ${otherPort} 의 지문 동일`);
  }

  // F13 — drift. 잰 값과 manifest 가 같은가(또는 --write-drift 로 채운다).
  // [범위] 받침 라우트까지 본다. 여덟 종류만 지키면 /about 의 글이 조용히 바뀌어도 아무도 모른다
  // (2026-08-12 음성 대조에서 실제로 안 잡혔다).
  {
    const drifted = [...manifest.routes, ...manifest.supporting_routes];
    const measured = new Map();
    for (const r of drifted) {
      let body = null;
      if (r.path === '/status/429-then-200') body = flakyDrift.body;
      else if (r.path === '/hang/body') body = hangBodyDrift;
      else if (r.path === '/hang/headers') body = null;
      else body = snap.get(r.path).body;
      measured.set(r.path, body === null
        ? { body_bytes: null, body_sha256: null, text_bytes: null }
        : {
          body_bytes: body.length,
          body_sha256: sha256(body),
          text_bytes: Buffer.byteLength(textOf(body.toString('utf8')), 'utf8'),
        });
    }

    if (WRITE_DRIFT) {
      const raw = fs.readFileSync(MANIFEST, 'utf8');
      const blocks = raw.match(/"drift": \{[^}]*\}/g) || [];
      if (blocks.length !== drifted.length) {
        add('F13', 'drift 를 채운다', false, `drift 블록 ${blocks.length}개인데 라우트는 ${drifted.length}개다 — 손으로 맞춰야 한다`);
      } else {
        let i = 0;
        const next = raw.replace(/"drift": \{[^}]*\}/g, () => {
          const r = drifted[i++];
          const merged = { ...r.drift, ...measured.get(r.path) };
          const inner = Object.entries(merged).map(([k, v]) => `"${k}": ${JSON.stringify(v)}`).join(', ');
          return `"drift": { ${inner} }`;
        });
        fs.writeFileSync(MANIFEST, next);
        add('F13', 'drift 를 잰 값으로 채웠다', true, `${blocks.length}개 블록 갱신 — 다시 실행해 대조하십시오`);
      }
    } else {
      const bad = [];
      let filled = 0;
      for (const r of drifted) {
        const m = measured.get(r.path);
        const w = r.drift;
        if (w.body_bytes === null && w.body_sha256 === null) continue;   // 아직 안 채운 자리
        filled++;
        if (m.body_bytes !== w.body_bytes) bad.push(`${r.path} 크기 ${m.body_bytes}≠${w.body_bytes}`);
        if (m.body_sha256 !== w.body_sha256) bad.push(`${r.path} 지문 어긋남`);
        if (m.text_bytes !== w.text_bytes) bad.push(`${r.path} 텍스트 ${m.text_bytes}≠${w.text_bytes}`);
      }
      add('F13', '잰 크기·지문·텍스트가 manifest 의 drift 와 같다', bad.length === 0 && filled > 0,
        bad.length ? bad.slice(0, 5).join(' / ') : `${filled}개 라우트 대조 (--write-drift 로 채운 값)`);
    }
  }

  // F14 — 서버 쪽 요청 기록. 수집기의 자기 보고가 아니라 맞은 쪽의 셈이다.
  {
    const hits = await (await fetch(base + '/control/hits')).json();
    const hasStatic = (hits['/static/normal'] || 0) >= 2;      // snapshot 을 두 번 돌렸다
    const hangSeen = (hits['/hang/headers'] || 0) === 1;        // 딱 한 번 두드렸다
    const noControl = !Object.keys(hits).some((k) => k.startsWith('/control/'));
    await fetch(base + '/control/reset');
    const after = await (await fetch(base + '/control/hits')).json();
    add('F14', '서버가 경로별 요청 수를 세고 되돌릴 수 있다',
      hasStatic && hangSeen && noControl && Object.keys(after).length === 0,
      `/static/normal ${hits['/static/normal']} · /hang/headers ${hits['/hang/headers']} · control 은 세지 않음 ${noControl} · reset 뒤 ${Object.keys(after).length}개`);
  }

  await stopServer(first.child);

  // ── (나) 시험 전용 문 ────────────────────────────────────────

  // F15 — 목록 만들기
  {
    const bad = [];
    const empty = parseFixtureAllow([]);
    if (empty.length !== 0) bad.push('플래그가 없는데 목록이 비지 않았다');

    const one = parseFixtureAllow([`${FIXTURE_FLAG}=127.0.0.1:5599`]);
    if (one.length !== 1 || one[0].host !== '127.0.0.1' || one[0].port !== 5599) bad.push('한 줄 파싱 실패');

    const two = parseFixtureAllow([`${FIXTURE_FLAG}=127.0.0.1:1`, `${FIXTURE_FLAG}=[::1]:2`, `${FIXTURE_FLAG}=127.0.0.1:1`]);
    if (two.length !== 2) bad.push(`같은 값 두 번이 ${two.length}줄이 됐다`);

    // 얼려 뒀으니 늘릴 수 없다
    let frozen = false;
    try { one.push({ host: '10.0.0.1', port: 80 }); } catch { frozen = true; }
    if (!frozen) bad.push('목록에 더 넣을 수 있다');

    const rejects = [
      ['10.0.0.5:80', 'not_loopback'],
      ['192.168.0.1:8080', 'not_loopback'],
      ['203.0.113.7:443', 'not_loopback'],
      ['localhost:5599', 'not_host_port'],
      ['127.0.0.1', 'not_host_port'],
      ['127.0.0.1:0', 'bad_port'],
      ['127.0.0.1:70000', 'bad_port'],
      ['127.0.0.1:999999', 'not_host_port'],
      ['', 'empty_value'],
    ];
    for (const [value, code] of rejects) {
      try {
        parseFixtureAllow([`${FIXTURE_FLAG}=${value}`]);
        bad.push(`"${value}" 가 통과했다`);
      } catch (e) {
        if (!(e instanceof FixtureAllowError) || e.code !== code) bad.push(`"${value}" 거절 사유 ${e.code}≠${code}`);
      }
    }
    // 값 없이 플래그만 준 경우
    try { parseFixtureAllow([FIXTURE_FLAG]); bad.push('값 없는 플래그가 통과했다'); }
    catch (e) { if (e.code !== 'missing_value') bad.push(`값 없는 플래그 사유 ${e.code}`); }

    add('F15', '허용 목록은 루프백+포트만 받고 그 밖은 전부 거절한다', bad.length === 0,
      bad.length ? bad.slice(0, 4).join(' / ') : `거절 사례 ${rejects.length + 1}종 확인 · 목록은 얼어 있음`);
  }

  // F16 — 판정. 목록이 없으면 루프백은 언제나 막힌다.
  {
    const allow = parseFixtureAllow([`${FIXTURE_FLAG}=127.0.0.1:${port}`]);
    const bad = [];

    const closed = await checkTarget(`http://127.0.0.1:${port}/static/normal`);
    if (closed.allow || closed.reason !== 'ip_loopback' || closed.fixture !== false) bad.push(`목록 없이 통과: ${closed.reason}`);

    const opened = await checkTarget(`http://127.0.0.1:${port}/static/normal`, { fixtureAllow: allow });
    if (!opened.allow || opened.fixture !== true || opened.addresses.join() !== '127.0.0.1') bad.push('목록이 있는데 안 열렸다');

    const otherPort = await checkTarget(`http://127.0.0.1:${port + 1}/x`, { fixtureAllow: allow });
    if (otherPort.allow) bad.push('포트가 다른데 열렸다');

    const otherHost = await checkTarget('http://10.0.0.5/x', { fixtureAllow: allow });
    if (otherHost.allow) bad.push('사설 주소가 열렸다');

    const byName = await checkTarget('http://localhost/x', { fixtureAllow: allow });
    if (byName.allow || byName.reason !== 'hostname_localhost') bad.push('이름으로 열렸다');

    // 이름으로도 부를 수 있지만, 풀린 주소가 **전부** 목록에 그 포트로 있어야 한다.
    // (Host 머리가 이름 그대로 나가는지 보려면 이름 경로가 필요하다 — #25 가 그것을 겨룬다.)
    const namedRight = await checkTarget(`http://named.example:${port}/x`, {
      fixtureAllow: allow, resolver: async () => ['127.0.0.1'],
    });
    if (!namedRight.allow || namedRight.fixture !== true) bad.push('목록에 있는 곳을 이름으로 부르니 막혔다');

    // 포트가 다르면 이름으로도 안 열린다 — DNS 가 새로 허락하는 것은 없다
    const namedWrongPort = await checkTarget('http://named.example/x', {
      fixtureAllow: allow, resolver: async () => ['127.0.0.1'],
    });
    if (namedWrongPort.allow) bad.push('이름으로 부르니 포트 검사가 사라졌다');

    // 목록 밖 주소가 하나라도 섞이면 통째로 거절
    const mixed = await checkTarget(`http://mixed.example:${port}/x`, {
      fixtureAllow: allow, resolver: async () => ['127.0.0.1', '10.0.0.5'],
    });
    if (mixed.allow) bad.push('목록 밖 주소가 섞였는데 열렸다');

    if (isFixtureAllowed('127.0.0.1', port + 1, allow)) bad.push('isFixtureAllowed 가 포트를 안 본다');

    add('F16', '루프백은 목록에 정확히 있는 host·port 에만 열린다', bad.length === 0,
      bad.length ? bad.join(' / ') : '목록 없음·다른 포트·사설·이름·DNS 루프백 모두 거절');
  }

  // F17 — MCP 입력·workspace·환경변수로는 못 켠다
  {
    const bad = [];

    // (a) 이 파일에 argv 말고 다른 입구가 없다.
    //     주석은 지우고 본다 — 이 파일의 주석은 "process.env 를 읽지 않는다"고 적어 두었고,
    //     그 문장이 위반으로 잡히면 규칙을 설명하는 일이 곧 위반이 된다.
    const src = fs.readFileSync(path.join(TOOL_ROOT, 'lib', 'fixture-allow.mjs'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/^[ \t]*\/\/.*$/gm, ' ');
    if (/process\.env/.test(src)) bad.push('fixture-allow 가 환경변수를 읽는다');
    if (/readFile|readFileSync|createReadStream|import\s*\(/.test(src)) bad.push('fixture-allow 가 파일을 읽는다');
    const processUses = [...src.matchAll(/process\.(\w+)/g)].map((m) => m[1]);
    if (processUses.some((u) => u !== 'argv')) bad.push(`fixture-allow 가 process.${processUses.find((u) => u !== 'argv')} 를 쓴다`);

    // (b) 버튼 입력에 이 문을 여는 칸이 없다.
    //     글자를 훑지 않고 스키마 객체의 칸 이름을 전부 걷는다 — 주석에 'fixtures/public-tools.json'
    //     같은 경로가 적혀 있는 것과 진짜 입력 칸이 생긴 것은 다른 일이다.
    const propNames = [];
    const walk = (node) => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (!node || typeof node !== 'object') return;
      for (const [k, v] of Object.entries(node)) {
        if (k === 'properties' && v && typeof v === 'object') propNames.push(...Object.keys(v));
        walk(v);
      }
    };
    walk(TOOL_SCHEMAS);
    const suspicious = propNames.filter((n) => /fixture|allow_host|loopback|localhost|127\.0\.0\.1/i.test(n));
    if (suspicious.length) bad.push(`버튼 입력에 ${suspicious.join('·')} 칸이 있다`);

    // (c) 환경변수를 아무리 세워도 목록은 비어 있다 — 자식 프로세스로 실제 확인
    const probe = `import { FIXTURE_ALLOW } from ${JSON.stringify(path.join(TOOL_ROOT, 'lib', 'fixture-allow.mjs'))};`
      + `process.stdout.write(String(FIXTURE_ALLOW.length));`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', probe], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        WEB_SEARCH_FIXTURE_ALLOW: '127.0.0.1:5599',
        WEB_SEARCH_ALLOW_FIXTURE_HOST: '127.0.0.1:5599',
        ALLOW_FIXTURE_HOST: '127.0.0.1:5599',
      },
    });
    const said = await new Promise((resolve) => {
      let out = '';
      child.stdout.on('data', (d) => { out += d; });
      child.on('exit', () => resolve(out.trim()));
    });
    if (said !== '0') bad.push(`환경변수만으로 목록이 ${said}줄이 됐다`);

    // (d) 버튼 입력처럼 생긴 문자열이 argv 에 섞여도 목록은 비어 있다
    const noise = parseFixtureAllow(['--json', '{"fixture_allow":"127.0.0.1:5599"}', 'allow-fixture-host=127.0.0.1:5599']);
    if (noise.length !== 0) bad.push('플래그가 아닌 문자열이 목록에 들어갔다');

    add('F17', '환경변수·버튼 입력·비슷한 문자열로는 문이 안 열린다', bad.length === 0,
      bad.length ? bad.join(' / ') : 'argv 외 입구 없음 · 스키마에 칸 없음 · 환경변수 3종 무효 · 비슷한 문자열 무효');
  }

  // F18 — 이 시험이 자기 자식 말고 어디에도 안 나갔다
  {
    const outside = [...contacted].filter((h) => !h.startsWith('127.0.0.1:'));
    add('F18', '이 시험은 127.0.0.1 자식 서버 밖으로 나가지 않았다', outside.length === 0,
      `접촉한 곳 ${[...contacted].join(', ')}`);
  }
}

// ── 실행 ──────────────────────────────────────────────────────

main().then(() => {
  const failed = results.filter((r) => !r.pass);
  if (AS_JSON) {
    process.stdout.write(`${JSON.stringify({ pass: failed.length === 0, total: results.length, failed: failed.length, results }, null, 2)}\n`);
  } else {
    for (const r of results) process.stdout.write(`${r.pass ? 'PASS' : 'FAIL'}  ${r.id}  ${r.title}\n        ${r.detail}\n`);
    process.stdout.write(`\n${failed.length === 0 ? 'PASS' : 'FAIL'} — ${results.length - failed.length}/${results.length}\n`);
  }
  process.exit(failed.length === 0 ? 0 : 1);
}).catch((e) => {
  process.stderr.write(`시험이 예외로 끝났습니다: ${e.stack}\n`);
  process.exit(2);
});
