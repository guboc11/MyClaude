// workspace 만들기.
//
// 계획서 3-2(폴더 구조)·4-1(workspace_new).
// 절반만 만들어진 폴더를 정상 workspace 로 내놓지 않는다 — 임시 이름으로 다 만든 뒤 한 번에 옮긴다.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createDb } from './db.mjs';
import {
  assertNoCollision, makeWorkspaceId, workspaceParent, workspacePaths, WORKSPACE_PARENT,
} from './paths.mjs';

const IGNORE_LINE = '.claude/mcp-web-search/';

export class WorkspaceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'WorkspaceError';
    this.code = code;
  }
}
const fail = (code, message) => { throw new WorkspaceError(code, message); };

function git(projectRoot, args) {
  try {
    return { ok: true, out: execFileSync('git', args, { cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() };
  } catch (e) {
    return { ok: false, status: e.status ?? null, out: (e.stdout || '').toString().trim() };
  }
}

/**
 * workspace 산출물이 git 에 섞이지 않는지 만들기 **전에** 확인한다.
 *
 * 파일에 그 문자열이 있는지 눈으로 보는 것으로 대신하지 않는다 — 실제로 무시되는지는
 * git 만 안다(앞의 규칙이 뒤집을 수도 있다). 규칙이 없으면 여기서 한 줄 더하고 다시 확인한다.
 */
export function ensureGitIgnored(projectRoot) {
  const inside = git(projectRoot, ['rev-parse', '--is-inside-work-tree']);
  if (!inside.ok || inside.out !== 'true') {
    return { git_repo: false, ignored: null, added_line: false, note: 'git 저장소가 아니라 확인을 건너뛴다' };
  }
  const probe = path.join(WORKSPACE_PARENT, 'probe');
  let check = git(projectRoot, ['check-ignore', '-v', probe]);
  if (check.ok) return { git_repo: true, ignored: true, added_line: false, rule: check.out };

  const ignoreFile = path.join(projectRoot, '.gitignore');
  const current = fs.existsSync(ignoreFile) ? fs.readFileSync(ignoreFile, 'utf8') : '';
  if (!current.split('\n').some((l) => l.trim() === IGNORE_LINE)) {
    const sep = current === '' || current.endsWith('\n') ? '' : '\n';
    fs.appendFileSync(ignoreFile, `${sep}${IGNORE_LINE}\n`);
  }
  check = git(projectRoot, ['check-ignore', '-v', probe]);
  if (!check.ok) fail('gitignore_failed', '.gitignore 에 규칙을 넣었는데도 git 이 무시하지 않습니다');
  return { git_repo: true, ignored: true, added_line: true, rule: check.out };
}

const README = (id) => `# ${id}

이 폴더는 web-search MCP 의 조사 workspace 다. 사람이 손으로 고치는 자리가 아니다.

- \`brief.md\` — 조사 목적과 포함·제외 기준. 사람이 쓴다.
- \`workspace.db\` — 기계 상태의 단일 원본.
- \`artifacts/\` — 덮어쓰지 않는 실행 증거(search·maps·pages).
- \`exports/\` — 다음 역할이 읽을 작은 결과 파일.
- \`logs/\` — 항목 하나에 귀속되지 않는 장애 기록.

버튼은 \`workspace_new · add_urls · search · map_domain · next · collect · report · status · retry · export\` 열 개다.
`;

const BRIEF = (id, brief) => `# ${id}

${brief}

## 포함·제외 기준

(사람이 채운다. 여기가 비어 있으면 판정 기준이 없다는 뜻이다.)

## 원하는 산출물

(사람이 채운다.)
`;

/**
 * 새 workspace 를 만든다.
 * @returns {{workspace_id, workspace_path, brief_path, gitignore}}
 */
export function createWorkspace(projectRoot, { topic, brief, nowMs = Date.now() }) {
  if (typeof brief !== 'string' || !brief.trim()) fail('brief_empty', 'brief 가 비었습니다');

  const workspaceId = makeWorkspaceId(topic, { nowMs });
  const finalRoot = assertNoCollision(projectRoot, workspaceId);
  const gitignore = ensureGitIgnored(projectRoot);

  // 임시 이름으로 다 만든 뒤 옮긴다. 도중에 죽으면 임시 폴더만 남고 정상 workspace 로 보이지 않는다.
  const parent = workspaceParent(projectRoot);
  fs.mkdirSync(parent, { recursive: true });
  const staging = fs.mkdtempSync(path.join(parent, '.staging-'));

  try {
    const p = workspacePaths(staging);
    for (const dir of [p.artifacts, p.search, p.maps, p.pages, p.exports, p.logs]) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(p.brief, BRIEF(workspaceId, brief.trim()));
    fs.writeFileSync(p.readme, README(workspaceId));
    createDb(staging, p.db, {
      workspaceId,
      projectRoot,
      // brief 경로는 최종 자리 기준으로 적는다. 임시 이름을 장부에 남기지 않는다.
      briefPath: path.join(finalRoot, 'brief.md'),
      nowMs,
    }).close();

    fs.renameSync(staging, finalRoot);
  } catch (e) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw e;
  }

  return {
    workspace_id: workspaceId,
    workspace_path: finalRoot,
    brief_path: path.join(finalRoot, 'brief.md'),
    gitignore,
  };
}
