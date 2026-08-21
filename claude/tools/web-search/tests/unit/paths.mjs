#!/usr/bin/env node
// lib/paths.mjs 단위 시험 — 허용된 경로만 나오고 밖에는 아무것도 안 생기는지 본다.
//
//   node tests/unit/paths.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PathError, todayKst, normalizeTopic, makeWorkspaceId, assertWorkspaceId,
  isInside, resolveInside, workspaceParent, workspaceRoot, assertNoCollision,
  requireWorkspace, workspacePaths, attemptDir, resolveInputFile, WORKSPACE_PARENT,
} from '../../lib/paths.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const results = [];
const ok = (id, pass, detail) => results.push({ id, pass, detail });

// 던지는지 보고, 던졌다면 code 까지 맞는지 본다.
function throwsWith(code, fn) {
  try { fn(); return { pass: false, detail: '던지지 않았다' }; } catch (e) {
    if (!(e instanceof PathError)) return { pass: false, detail: `PathError 가 아니다: ${e.message}` };
    return { pass: e.code === code, detail: `code=${e.code}${e.code === code ? '' : ` (기대 ${code})`}` };
  }
}

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'paths-unit-'));
const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'paths-outside-'));
const cleanup = () => {
  for (const d of [sandbox, outside]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* 이미 없으면 그만 */ } }
};
process.on('exit', cleanup);

const PROJECT = path.join(sandbox, 'project');
fs.mkdirSync(path.join(PROJECT, WORKSPACE_PARENT), { recursive: true });

// ── 날짜와 이름 ───────────────────────────────────────────────

{
  // 2026-08-12 15:00 UTC → KST 로는 다음 날 자정
  const utcLateNight = Date.parse('2026-08-12T15:30:00Z');
  ok('P1-kst-date', todayKst(utcLateNight) === '2026-08-13',
    `UTC 08-12 15:30 → KST ${todayKst(utcLateNight)}`);
}
{
  const cases = [
    ['global-wedding-sites', 'global-wedding-sites'],
    ['Global Wedding Sites', 'global-wedding-sites'],
    ['  spaced__topic  ', 'spaced-topic'],
    ['a--b', 'a-b'],
    ['-lead-and-trail-', 'lead-and-trail'],
  ];
  const bad = cases.filter(([input, want]) => normalizeTopic(input) !== want)
    .map(([i, w]) => `${i} → ${normalizeTopic(i)} (기대 ${w})`);
  ok('P2-topic-normalize', bad.length === 0, bad.length ? bad.join(', ') : `표본 ${cases.length}개 모두 기대대로`);
}
{
  const bad = [
    ['topic_empty', ''],
    ['topic_empty', '   '],
    ['topic_separator', 'a/b'],
    ['topic_separator', 'a\\b'],
    ['topic_dotdot', '..'],
    ['topic_dotdot', 'a..b'],
    ['topic_dotfile', '.hidden'],
    ['topic_absolute', '/etc/passwd'],
    ['topic_charset', '한글주제'],
    ['topic_charset', 'a;b'],
    ['topic_too_long', 'x'.repeat(65)],
  ];
  const fails = bad.map(([code, input]) => ({ input, ...throwsWith(code, () => normalizeTopic(input)) }))
    .filter((r) => !r.pass);
  ok('P3-topic-rejects', fails.length === 0,
    fails.length ? fails.map((f) => `"${f.input}": ${f.detail}`).join(' / ') : `위험한 topic ${bad.length}종 모두 거절`);
}
{
  const id = makeWorkspaceId('Global Wedding Sites', { nowMs: Date.parse('2026-08-12T01:00:00Z') });
  ok('P4-workspace-id', id === '2026-08-12-global-wedding-sites', id);
  const shape = throwsWith('workspace_id_shape', () => assertWorkspaceId('not-a-workspace'));
  ok('P5-workspace-id-shape', shape.pass && assertWorkspaceId(id) === id, shape.detail);
}

// ── 담기 ──────────────────────────────────────────────────────

{
  const root = path.join(sandbox, 'root');
  fs.mkdirSync(root, { recursive: true });
  const inside = resolveInside(root, 'artifacts', 'pages');
  ok('P6-resolve-inside', inside === path.join(root, 'artifacts', 'pages'), inside);

  const cases = [
    ['segment_absolute', ['/etc/passwd']],
    ['segment_dotdot', ['..', 'escape']],
    ['segment_dotdot', ['artifacts/../../escape']],
    ['segment_empty', ['']],
  ];
  const fails = cases.map(([code, segs]) => ({ segs: segs.join('|'), ...throwsWith(code, () => resolveInside(root, ...segs)) }))
    .filter((r) => !r.pass);
  ok('P7-traversal-rejected', fails.length === 0,
    fails.length ? fails.map((f) => `[${f.segs}]: ${f.detail}`).join(' / ') : `traversal 표본 ${cases.length}종 거절`);
}

// ── 심볼릭 링크로 빠져나가기 ──────────────────────────────────

{
  const root = path.join(sandbox, 'symroot');
  fs.mkdirSync(path.join(root, 'artifacts'), { recursive: true });
  // 하위 심볼릭 링크: artifacts/pages 가 바깥을 가리킨다
  fs.symlinkSync(outside, path.join(root, 'artifacts', 'pages'));
  const child = throwsWith('escapes_workspace', () => resolveInside(root, 'artifacts', 'pages', 'x.txt'));
  ok('P8-child-symlink-rejected', child.pass, child.detail);

  // 그 링크 자체를 가리키는 것도 밖이다
  ok('P9-symlink-itself-outside', isInside(root, path.join(root, 'artifacts', 'pages')) === false,
    `isInside=${isInside(root, path.join(root, 'artifacts', 'pages'))}`);

  // 링크를 거쳐 실제로 파일이 만들어지지 않았는지
  const before = fs.readdirSync(outside).length;
  try { resolveInside(root, 'artifacts', 'pages', 'should-not-exist.txt'); } catch { /* 거절이 정상 */ }
  ok('P10-no-outside-write', fs.readdirSync(outside).length === before,
    `바깥 폴더 항목 수 ${before} → ${fs.readdirSync(outside).length}`);
}
{
  // 상위 심볼릭 링크: 프로젝트의 .claude/websearch-workspace 가 바깥을 가리킨다
  const proj = path.join(sandbox, 'linkproj');
  fs.mkdirSync(path.join(proj, '.claude'), { recursive: true });
  fs.symlinkSync(outside, path.join(proj, WORKSPACE_PARENT));
  const parent = throwsWith('parent_escapes_project', () => workspaceParent(proj));
  ok('P11-parent-symlink-rejected', parent.pass, parent.detail);
}

// ── workspace 자리 ────────────────────────────────────────────

{
  const id = '2026-08-12-unit-topic';
  const root = workspaceRoot(PROJECT, id);
  ok('P12-workspace-root', root === path.join(PROJECT, WORKSPACE_PARENT, id), root);

  const p = workspacePaths(root);
  const wanted = ['brief', 'db', 'readme', 'artifacts', 'search', 'maps', 'pages', 'exports', 'logs'];
  const allInside = wanted.every((k) => isInside(root, p[k]));
  ok('P13-workspace-paths', allInside && p.db.endsWith('workspace.db') && p.pages.endsWith(path.join('artifacts', 'pages')),
    `${wanted.length}개 자리 모두 뿌리 안 · db=${path.basename(p.db)}`);

  // 충돌
  ok('P14-no-collision-when-absent', assertNoCollision(PROJECT, id) === root, '없을 때는 통과');
  fs.mkdirSync(root, { recursive: true });
  const collide = throwsWith('workspace_exists', () => assertNoCollision(PROJECT, id));
  ok('P15-collision-rejected', collide.pass, collide.detail);
  ok('P16-require-existing', requireWorkspace(PROJECT, id) === root, '있는 workspace 는 열린다');
  const missing = throwsWith('workspace_missing', () => requireWorkspace(PROJECT, '2026-08-12-nope'));
  ok('P17-require-missing-rejected', missing.pass, missing.detail);
}

// ── 시도 폴더와 입력 파일 ─────────────────────────────────────

{
  const root = workspaceRoot(PROJECT, '2026-08-12-unit-topic');
  const dir = attemptDir(root, 'item123', 'att456');
  ok('P18-attempt-dir', dir === path.join(root, 'artifacts', 'pages', 'item123', 'att456'), dir);
  const badId = throwsWith('id_shape', () => attemptDir(root, '../evil', 'att456'));
  ok('P19-attempt-id-shape', badId.pass, badId.detail);
}
{
  const root = workspaceRoot(PROJECT, '2026-08-12-unit-topic');
  const good = path.join(root, 'input.jsonl');
  fs.writeFileSync(good, '{"url":"https://example.com/"}\n');
  ok('P20-input-inside', resolveInputFile(root, 'input.jsonl') === good, '안쪽 파일은 읽는다');

  const outFile = path.join(outside, 'secret.jsonl');
  fs.writeFileSync(outFile, 'x');
  const out1 = throwsWith('input_outside_workspace', () => resolveInputFile(root, outFile));
  ok('P21-input-outside-rejected', out1.pass, out1.detail);
  const out2 = throwsWith('input_outside_workspace', () => resolveInputFile(root, '../../../etc/hosts'));
  ok('P22-input-traversal-rejected', out2.pass, out2.detail);

  // 바깥을 가리키는 링크는 "밖" 으로 먼저 걸린다 — 그게 진짜 이유다.
  fs.symlinkSync(outFile, path.join(root, 'link-out.jsonl'));
  const out3 = throwsWith('input_outside_workspace', () => resolveInputFile(root, 'link-out.jsonl'));
  ok('P23-symlink-to-outside-rejected', out3.pass, out3.detail);

  // 안쪽을 가리키는 링크도 입력으로 받지 않는다. 이쪽이 input_symlink 가지다.
  fs.symlinkSync(good, path.join(root, 'link-in.jsonl'));
  const out4 = throwsWith('input_symlink', () => resolveInputFile(root, 'link-in.jsonl'));
  ok('P24-symlink-to-inside-rejected', out4.pass, out4.detail);
}

// ── 바깥에 아무것도 안 생겼는가 ───────────────────────────────

ok('P25-outside-untouched', fs.readdirSync(outside).sort().join(',') === 'secret.jsonl',
  `바깥 폴더 내용: ${fs.readdirSync(outside).join(', ') || '(비어 있음)'}`);

// ── 출력 ──────────────────────────────────────────────────────

for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.id} — ${r.detail}`);
const failed = results.filter((r) => !r.pass);
console.log(failed.length === 0 ? `PASS  lib/paths.mjs 단위 시험 ${results.length}항목 통과` : `FAIL  ${failed.length}건`);
process.exit(failed.length === 0 ? 0 : 1);
