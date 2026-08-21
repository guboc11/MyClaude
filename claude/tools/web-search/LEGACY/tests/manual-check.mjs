#!/usr/bin/env node
// 매뉴얼 대조 — MANUAL.md 의 도구 표가 server.mjs 의 실제 inputSchema 와 어긋나지 않는지 본다.
// 실행: node tests/manual-check.mjs
//
// 왜 시험으로 두나: 도구를 하나 더 붙이거나 인자를 하나 늘리면 문서가 조용히 낡는다.
// 낡은 매뉴얼은 없는 매뉴얼보다 나쁘다 — 워커가 그대로 믿고 잘못 부른다.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, '..', 'server.mjs');
const MANUAL = path.join(HERE, '..', 'MANUAL.md');

const results = [];
const check = (no, name, pass, detail = '') => {
  results.push({ no, name, pass, detail });
  console.log(`${pass ? 'O' : 'X'}  ${no}. ${name}${detail ? `\n      ${detail}` : ''}`);
};

// ---- 서버에서 진짜 스키마를 받아온다 (문서에서 베끼지 않는다) ----
const tools = await new Promise((resolve, reject) => {
  const p = spawn('node', [SERVER], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, CLAUDE_PROJECT_DIR: '/tmp' } });
  let buf = ''; let done = false;
  const timer = setTimeout(() => { if (!done) { p.kill('SIGTERM'); reject(new Error('서버 무응답')); } }, 20000);
  p.stdout.on('data', (d) => {
    buf += d; let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      try {
        const m = JSON.parse(line);
        if (m.id === 2) { done = true; clearTimeout(timer); p.stdin.end(); p.kill('SIGTERM'); resolve(m.result.tools); }
      } catch {}
    }
  });
  p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n');
  p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n');
});

const manual = fs.readFileSync(MANUAL, 'utf8');
const lines = manual.split('\n');

// 도구 표는 "## 도구 22개 …" 절 안에만 있다. 다른 절(문제 해결 표 등)의 백틱 행을
// 도구로 오인하면 없는 도구를 봤다고 거짓 실패한다.
const secStart = lines.findIndex((l) => l.startsWith('## 도구 22개'));
if (secStart < 0) { console.log('X  도구 표 절을 찾지 못했습니다'); process.exit(1); }
const secEnd = lines.findIndex((l, i) => i > secStart && l.startsWith('## '));
const toolSection = lines.slice(secStart, secEnd < 0 ? lines.length : secEnd);

// 도구 행: "| `이름` | 필수 | 선택 | 성공 | 대기·거절 |"
const rowOf = (name) => toolSection.find((l) => l.startsWith(`| \`${name}\` |`));
const cells = (row) => row.split('|').slice(1, -1).map((c) => c.trim());

// ---- M1. 22개 이름이 모두 표에 있다 ----
{
  const missing = tools.map((t) => t.name).filter((n) => !rowOf(n));
  check('M1', `도구 ${tools.length}개가 모두 표에 있다`, missing.length === 0,
    missing.length ? `빠짐: ${missing.join(', ')}` : `${tools.map((t) => t.name).length}개 확인`);
}

// ---- M2. 표에 없는 도구를 지어내지 않았다 ----
{
  const real = new Set(tools.map((t) => t.name));
  const rows = toolSection.filter((l) => /^\| `[a-z_]+` \|/.test(l)).map((l) => l.match(/^\| `([a-z_]+)`/)[1]);
  const ghosts = [...new Set(rows.filter((n) => !real.has(n)))];
  check('M2', '표에 없는 도구를 지어내지 않았다', ghosts.length === 0,
    ghosts.length ? `없는 도구: ${ghosts.join(', ')}` : `표 행 ${rows.length}개 전부 실재`);
}

// ---- M3. 필수 인자가 그 도구 행의 "필수" 칸에 다 있다 ----
{
  const bad = [];
  for (const t of tools) {
    const row = rowOf(t.name); if (!row) continue;
    const req = t.inputSchema.required || [];
    const cell = cells(row)[1] || '';
    const miss = req.filter((k) => !cell.includes(`\`${k}\``));
    if (miss.length) bad.push(`${t.name}: ${miss.join(',')}`);
    // 필수가 없는 도구는 "없음" 이라고 적혀 있어야 한다(빈칸으로 두면 빠뜨린 것과 구분이 안 된다)
    if (!req.length && !/없음/.test(cell)) bad.push(`${t.name}: 필수 없음을 안 적음`);
  }
  check('M3', '필수 인자가 도구별 필수 칸에 빠짐없이 있다', bad.length === 0,
    bad.length ? bad.join(' / ') : `${tools.length}개 도구 대조 완료`);
}

// ---- M4. 선택 인자도 그 도구 행의 "선택" 칸에 다 있다 ----
{
  const bad = [];
  for (const t of tools) {
    const row = rowOf(t.name); if (!row) continue;
    const req = new Set(t.inputSchema.required || []);
    const opt = Object.keys(t.inputSchema.properties || {}).filter((k) => !req.has(k));
    const cell = cells(row)[2] || '';
    const miss = opt.filter((k) => !cell.includes(`\`${k}\``));
    if (miss.length) bad.push(`${t.name}: ${miss.join(',')}`);
    if (!opt.length && !/없음/.test(cell)) bad.push(`${t.name}: 선택 없음을 안 적음`);
  }
  check('M4', '선택 인자가 도구별 선택 칸에 빠짐없이 있다', bad.length === 0,
    bad.length ? bad.join(' / ') : `${tools.length}개 도구 대조 완료`);
}

// ---- M5. 성공·거절 칸이 둘 다 채워져 있다 ----
// 길이로 재지 않는다 — "없음(읽기만)" 은 짧아도 답이다. 비었거나 줄표만 있으면 안 적은 것이다.
{
  const thin = [];
  const filled = (c) => !!c && c !== '-' && c !== '—';
  for (const t of tools) {
    const row = rowOf(t.name); if (!row) continue;
    const c = cells(row);
    if (!filled(c[3])) thin.push(`${t.name}: 성공 칸 빔`);
    if (!filled(c[4])) thin.push(`${t.name}: 대기·거절 칸 빔`);
  }
  check('M5', '도구마다 성공 시·대기 거절 시 돌아오는 값이 적혀 있다', thin.length === 0,
    thin.length ? thin.join(' / ') : `${tools.length}개 도구 모두 네 칸이 채워짐`);
}

// ---- M6. 워커 지시 틀 계약 ----
{
  const tmplStart = lines.findIndex((l) => l.trim().startsWith('MANUAL.md 를 먼저 Read 하라'));
  const firstOk = tmplStart >= 0;
  const body = tmplStart >= 0 ? lines.slice(tmplStart, tmplStart + 40).join('\n') : '';
  // 두 고리가 나뉘어 있고, 없는 연결(lease → discover)을 만들지 않았다
  const hasDiscoverLoop = /discover\(crawl, origin\)/.test(body) && /lease 는 부르지 않는다/.test(body);
  const hasUrlLoop = /lease\(crawl, n/.test(body) && /fetch\(crawl, url_id, lease_token/.test(body) && /report\(crawl, report_id/.test(body);
  const perSubmit = /report_id 는 제출마다 고유/.test(body);
  check('M6', '워커 틀: 첫 문장이 "MANUAL.md 를 먼저 Read 하라" 이고 두 고리가 나뉘어 있다',
    firstOk && hasDiscoverLoop && hasUrlLoop && perSubmit,
    `첫 문장=${firstOk} · 발견 고리=${hasDiscoverLoop} · URL 고리=${hasUrlLoop} · report_id 제출마다=${perSubmit}`);
}

// ---- M7. 상태 어휘가 닫힌 집합 그대로 적혀 있다 ----
// 문서가 코드보다 적게 적으면 워커가 모르는 상태를 만나고, 많게 적으면 없는 상태를 기대한다.
{
  const src = fs.readFileSync(path.join(HERE, '..', 'lib', 'store.mjs'), 'utf8');
  const block = src.match(/export const URL_STATES = \[([\s\S]*?)\];/);
  const states = block ? [...block[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]) : [];
  const missing = states.filter((s) => !manual.includes(`\`${s}\``));
  // 세 축을 나눠 적었는가
  const axes = ['content_validated', 'needs_visual_review', 'invalid',
    'visual_validated', 'visual_unverified', 'complete', 'incomplete'];
  const axisMissing = axes.filter((a) => !manual.includes(`\`${a}\``));
  const axisNamed = /page_validity/.test(manual) && /`visual`|visual —/.test(manual) && /extraction/.test(manual);
  check('M7', `URL 상태 ${states.length}개와 세 축(page_validity·visual·extraction)이 모두 적혀 있다`,
    states.length === 12 && missing.length === 0 && axisMissing.length === 0 && axisNamed,
    `코드 상태 ${states.length}개 · 문서 누락 [${missing.join(',') || '없음'}] · `
    + `축 값 누락 [${axisMissing.join(',') || '없음'}] · 축 이름 명시=${axisNamed}`);
}

// ---- M8. 무엇이 완료를 막고 무엇이 안 막는지 코드와 같게 적혀 있다 ----
// 목록 우선 설계의 핵심이라 문서가 반대로 쓰이면 워커가 "아직 멀었다" 며 헛일한다.
{
  const src = fs.readFileSync(path.join(HERE, '..', 'lib', 'store.mjs'), 'utf8');
  const cond = src.match(/const complete = ([\s\S]*?);\n/)?.[1] || '';
  // 코드 확인: excluded·known_deferred 는 완료 조건에 없고, needs_boundary_review 는 막힘에 들어 있다
  const codeNonBlocking = !/excluded|known_deferred/.test(cond);
  const codeBlocks = /needs_boundary_review/.test(src.match(/const blockers = ([\s\S]*?);\n/)?.[1] || '');

  const docNonBlocking = /`known_deferred`와 `excluded`는 \*\*완료를 막지 않는다\.\*\*/.test(manual);
  const docBlocking = /`needs_boundary_review`와 상한에 세워 둔 후보[\s\S]{0,40}\*\*막는다\.\*\*/.test(manual);
  const noOldClaim = !/`excluded`·`needs_boundary_review`·`known_deferred`는 \*\*다 본 것이 아니다/.test(manual);

  check('M8', 'known_deferred·excluded 는 안 막고 needs_boundary_review·경계 후보는 막는다고 적혀 있다',
    codeNonBlocking && codeBlocks && docNonBlocking && docBlocking && noOldClaim,
    `코드: 완료 조건에 excluded/known_deferred 없음=${codeNonBlocking} · 막힘에 needs_boundary_review 있음=${codeBlocks}\n      `
    + `문서: 안 막는다 문구=${docNonBlocking} · 막는다 문구=${docBlocking} · 옛 문장 지움=${noOldClaim}`);
}

const passed = results.filter((r) => r.pass).length;
console.log(`\n${'='.repeat(60)}`);
console.log(`매뉴얼 대조: ${passed}/${results.length} 통과`);
for (const r of results.filter((x) => !x.pass)) console.log(`  실패 ${r.no}. ${r.name} — ${r.detail}`);
process.exit(passed === results.length ? 0 : 1);
