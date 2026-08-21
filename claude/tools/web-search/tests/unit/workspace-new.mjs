#!/usr/bin/env node
// workspace_new 단위 시험 — 만들어지는 것과 만들어지면 안 되는 것.
//
//   node tests/unit/workspace-new.mjs

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createWorkspace, ensureGitIgnored, WorkspaceError } from '../../lib/workspace.mjs';
import { PathError, WORKSPACE_PARENT } from '../../lib/paths.mjs';
import { SCHEMA_VERSION } from '../../lib/schema.mjs';

const results = [];
const ok = (id, pass, detail) => results.push({ id, pass, detail });
function throwsWith(code, fn) {
  try { fn(); return { pass: false, detail: '던지지 않았다' }; } catch (e) {
    if (!(e instanceof WorkspaceError) && !(e instanceof PathError)) return { pass: false, detail: `뜻밖의 오류: ${e.message.slice(0, 90)}` };
    return { pass: e.code === code, detail: `code=${e.code}${e.code === code ? '' : ` (기대 ${code})`}` };
  }
}

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-new-'));
process.on('exit', () => { try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* 이미 없으면 그만 */ } });

const gitRepo = path.join(sandbox, 'repo');
fs.mkdirSync(gitRepo, { recursive: true });
execFileSync('git', ['init', '-q', '.'], { cwd: gitRepo });
const plain = path.join(sandbox, 'plain');
fs.mkdirSync(plain, { recursive: true });

const NOW = Date.parse('2026-08-12T01:00:00Z');

// ── 정상 생성 ─────────────────────────────────────────────────

const made = createWorkspace(gitRepo, { topic: 'Global Wedding Sites', brief: '전 세계 결혼식 후보 사이트 찾기', nowMs: NOW });
{
  ok('W1-id', made.workspace_id === '2026-08-12-global-wedding-sites', made.workspace_id);
  ok('W2-path', made.workspace_path === path.join(gitRepo, WORKSPACE_PARENT, made.workspace_id), made.workspace_path);

  const want = ['README.md', 'artifacts', 'brief.md', 'exports', 'logs', 'workspace.db'];
  const got = fs.readdirSync(made.workspace_path).sort();
  ok('W3-layout', JSON.stringify(got) === JSON.stringify(want), got.join(', '));

  const sub = fs.readdirSync(path.join(made.workspace_path, 'artifacts')).sort();
  ok('W4-artifact-dirs', JSON.stringify(sub) === JSON.stringify(['maps', 'pages', 'search']), sub.join(', '));

  const brief = fs.readFileSync(made.brief_path, 'utf8');
  ok('W5-brief', brief.includes('전 세계 결혼식 후보 사이트 찾기') && brief.includes('포함·제외 기준'), `${brief.length}자`);

  const db = new DatabaseSync(path.join(made.workspace_path, 'workspace.db'));
  const meta = Object.fromEntries(db.prepare('SELECT key, value FROM meta').all().map((r) => [r.key, r.value]));
  db.close();
  ok('W6-meta', meta.workspace_id === made.workspace_id && meta.project_root === gitRepo && meta.brief_path === made.brief_path
    && meta.schema_version === String(SCHEMA_VERSION),
    `schema_version=${meta.schema_version} · brief_path 가 최종 자리로 적혔다`);
}

// ── git 무시 규칙 ─────────────────────────────────────────────

{
  ok('W7-gitignore-added', made.gitignore.git_repo === true && made.gitignore.ignored === true && made.gitignore.added_line === true,
    `규칙 ${made.gitignore.rule}`);

  const status = execFileSync('git', ['status', '--porcelain'], { cwd: gitRepo, encoding: 'utf8' });
  const exposed = status.split('\n').filter((l) => l.includes('websearch-workspace'));
  ok('W8-not-in-git-status', exposed.length === 0, `git status 에 workspace 줄 ${exposed.length}개`);

  // 두 번째 workspace 는 규칙이 이미 있으니 더하지 않는다
  const again = createWorkspace(gitRepo, { topic: 'second topic', brief: '둘째', nowMs: NOW });
  ok('W9-gitignore-not-duplicated', again.gitignore.ignored === true && again.gitignore.added_line === false,
    `added_line=${again.gitignore.added_line}`);
  const lines = fs.readFileSync(path.join(gitRepo, '.gitignore'), 'utf8').split('\n').filter((l) => l.trim() === '.claude/websearch-workspace/');
  ok('W10-single-rule-line', lines.length === 1, `무시 규칙 줄 ${lines.length}개`);
}

// ── git 저장소가 아닐 때 ──────────────────────────────────────

{
  const r = ensureGitIgnored(plain);
  ok('W11-non-git-recorded', r.git_repo === false && r.ignored === null && !!r.note, r.note);
  const w = createWorkspace(plain, { topic: 'plain topic', brief: '저장소 아님', nowMs: NOW });
  ok('W12-non-git-still-creates', fs.existsSync(path.join(w.workspace_path, 'workspace.db')), w.workspace_path);
}

// ── 거절 ──────────────────────────────────────────────────────

{
  const collide = throwsWith('workspace_exists', () => createWorkspace(gitRepo, { topic: 'Global Wedding Sites', brief: 'x', nowMs: NOW }));
  ok('W13-collision', collide.pass, collide.detail);

  const emptyBrief = throwsWith('brief_empty', () => createWorkspace(gitRepo, { topic: 'brief empty', brief: '   ', nowMs: NOW }));
  ok('W14-empty-brief', emptyBrief.pass, emptyBrief.detail);

  const badTopic = throwsWith('topic_separator', () => createWorkspace(gitRepo, { topic: 'a/b', brief: 'x', nowMs: NOW }));
  ok('W15-bad-topic', badTopic.pass, badTopic.detail);

  // 거절된 것들이 폴더를 남기지 않았는가
  const parent = path.join(gitRepo, WORKSPACE_PARENT);
  const dirs = fs.readdirSync(parent).sort();
  ok('W16-no-partial-dirs', JSON.stringify(dirs) === JSON.stringify(['2026-08-12-global-wedding-sites', '2026-08-12-second-topic']),
    dirs.join(', '));
  ok('W17-no-staging-left', dirs.every((d) => !d.startsWith('.staging-')), '임시 폴더 없음');
}

// ── 절반만 만들어진 것을 정상으로 내놓지 않는가 ───────────────

{
  const half = path.join(sandbox, 'half');
  fs.mkdirSync(half, { recursive: true });
  // DB 를 만들 수 없게 막는다 — 그 자리에 폴더를 놓아 createDb 가 실패하게 한다.
  // (여기서는 staging 안이라 미리 만들 수 없으므로, brief 를 못 쓰게 읽기 전용 부모로 대신한다.)
  const parent = path.join(half, WORKSPACE_PARENT);
  fs.mkdirSync(parent, { recursive: true });
  fs.chmodSync(parent, 0o500);          // 쓰기 금지 → staging 생성이 실패해야 한다
  let threw = false;
  try { createWorkspace(half, { topic: 'blocked', brief: 'x', nowMs: NOW }); } catch { threw = true; }
  fs.chmodSync(parent, 0o700);
  const left = fs.readdirSync(parent);
  ok('W18-failure-leaves-nothing', threw && left.length === 0, `던졌다=${threw} · 남은 항목 ${left.length}개`);
}

// ── 출력 ──────────────────────────────────────────────────────

for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.id} — ${r.detail}`);
const failed = results.filter((r) => !r.pass);
console.log(failed.length === 0 ? `PASS  workspace_new 단위 시험 ${results.length}항목 통과` : `FAIL  ${failed.length}건`);
process.exit(failed.length === 0 ? 0 : 1);
