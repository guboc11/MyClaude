// workspace 경로와 이름 — 밖으로 나가지 못하게 막는 자리.
//
// 계획서 3-1(경로와 이름)·5-3(자료 연결 안전).
// 여기서 통과한 경로만 나머지 코드가 쓴다. 검사와 실제 쓰기가 갈라지면 검사가 무의미해지므로,
// 경로를 만드는 함수와 검사하는 함수를 한 파일에 둔다.

import fs from 'node:fs';
import path from 'node:path';

export const WORKSPACE_PARENT = path.join('.claude', 'mcp-web-search');

// 날짜는 만든 사람이 사는 시간대 기준이라야 폴더 이름이 직관적이다.
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const TOPIC_MAX = 64;

export class PathError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PathError';
    this.code = code;
  }
}

const fail = (code, message) => { throw new PathError(code, message); };

/** 생성일(KST) YYYY-MM-DD. */
export function todayKst(nowMs = Date.now()) {
  return new Date(nowMs + KST_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * topic 을 kebab-case 로 다듬는다.
 *
 * 대소문자·공백·밑줄은 조용히 다듬지만, 경로로 읽힐 수 있는 것은 다듬지 않고 거절한다.
 * '../etc' 를 'etc' 로 고쳐 주면 부른 쪽은 자기가 무엇을 요청했는지 모른 채 다른 곳에 쓰게 된다.
 */
export function normalizeTopic(input) {
  if (typeof input !== 'string') fail('topic_type', 'topic 은 문자열이어야 합니다');
  const raw = input.trim();
  if (!raw) fail('topic_empty', 'topic 이 비었습니다');
  if (raw.length > TOPIC_MAX) fail('topic_too_long', `topic 은 ${TOPIC_MAX}자 이하여야 합니다 (받은 길이 ${raw.length})`);
  // 절대경로를 구분자보다 먼저 본다. '/etc/passwd' 를 "구분자가 있다" 고만 말하면 진단이 흐려진다.
  if (path.isAbsolute(raw) || /^[a-zA-Z]:/.test(raw)) fail('topic_absolute', 'topic 에 절대경로를 쓸 수 없습니다');
  if (/[/\\]/.test(raw)) fail('topic_separator', 'topic 에 경로 구분자를 쓸 수 없습니다');
  if (raw.includes('\0')) fail('topic_nul', 'topic 에 NUL 을 쓸 수 없습니다');
  if (raw.includes('..')) fail('topic_dotdot', 'topic 에 .. 를 쓸 수 없습니다');
  if (raw.startsWith('.')) fail('topic_dotfile', 'topic 은 . 으로 시작할 수 없습니다');
  if (!/^[A-Za-z0-9 _-]+$/.test(raw)) fail('topic_charset', 'topic 은 영문·숫자·공백·밑줄·붙임표만 쓸 수 있습니다');

  const kebab = raw.toLowerCase().replace(/[\s_]+/g, '-').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '');
  if (!kebab) fail('topic_empty', 'topic 을 다듬고 나니 아무것도 남지 않았습니다');
  return kebab;
}

/** workspace_id = {KST 생성일}-{kebab topic}. 폴더 이름과 같다. */
export function makeWorkspaceId(topic, { nowMs = Date.now() } = {}) {
  return `${todayKst(nowMs)}-${normalizeTopic(topic)}`;
}

const WORKSPACE_ID_RE = /^\d{4}-\d{2}-\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** 바깥에서 받은 workspace 이름은 만든 것과 같은 모양인지 다시 본다. */
export function assertWorkspaceId(id) {
  if (typeof id !== 'string' || !WORKSPACE_ID_RE.test(id)) {
    fail('workspace_id_shape', `workspace 이름 모양이 아닙니다: ${String(id).slice(0, 60)}`);
  }
  return id;
}

// ── 경로 담기 ─────────────────────────────────────────────────

/** 존재하는 가장 깊은 조상까지 심볼릭 링크를 풀고, 나머지는 그대로 붙인다. */
function realpathDeepest(target) {
  let cur = path.resolve(target);
  const tail = [];
  for (;;) {
    try { return path.join(fs.realpathSync(cur), ...tail); } catch { /* 없으면 한 칸 올라간다 */ }
    const parent = path.dirname(cur);
    if (parent === cur) return path.resolve(target);   // 뿌리까지 없다
    tail.unshift(path.basename(cur));
    cur = parent;
  }
}

/**
 * target 이 root 안에 있는지 실제 경로로 확인한다.
 * 아직 없는 경로도 다룬다 — 존재하는 조상까지 링크를 풀어 보고 나머지를 붙인다.
 */
export function isInside(root, target) {
  const realRoot = realpathDeepest(root);
  const realTarget = realpathDeepest(target);
  return realTarget === realRoot || realTarget.startsWith(realRoot + path.sep);
}

/**
 * root 아래의 경로를 만든다. 밖으로 나가면 거절한다.
 * 조각에 절대경로·..·구분자가 섞여 들어오는 것도 여기서 막는다.
 */
export function resolveInside(root, ...segments) {
  for (const s of segments) {
    if (typeof s !== 'string' || !s) fail('segment_empty', '경로 조각이 비었습니다');
    if (s.includes('\0')) fail('segment_nul', '경로 조각에 NUL 을 쓸 수 없습니다');
    if (path.isAbsolute(s)) fail('segment_absolute', `경로 조각에 절대경로를 쓸 수 없습니다: ${s.slice(0, 60)}`);
    if (s.split(/[/\\]/).includes('..')) fail('segment_dotdot', `경로 조각에 .. 를 쓸 수 없습니다: ${s.slice(0, 60)}`);
  }
  const target = path.resolve(root, ...segments);
  if (!isInside(root, target)) {
    fail('escapes_workspace', `workspace 밖을 가리킵니다: ${target.slice(0, 120)}`);
  }
  return target;
}

// ── workspace 자리 ────────────────────────────────────────────

/** 이 프로젝트의 workspace 들이 사는 폴더. 프로젝트 밖이면 거절한다. */
export function workspaceParent(projectRoot) {
  if (!projectRoot || !path.isAbsolute(projectRoot)) {
    fail('project_root', `프로젝트 뿌리는 절대경로여야 합니다: ${String(projectRoot).slice(0, 80)}`);
  }
  const parent = path.resolve(projectRoot, WORKSPACE_PARENT);
  if (!isInside(projectRoot, parent)) {
    fail('parent_escapes_project', 'workspace 폴더가 프로젝트 밖을 가리킵니다(심볼릭 링크 확인)');
  }
  return parent;
}

/** workspace 뿌리 경로. 존재 여부는 보지 않는다. */
export function workspaceRoot(projectRoot, workspaceId) {
  assertWorkspaceId(workspaceId);
  return resolveInside(workspaceParent(projectRoot), workspaceId);
}

/** 같은 이름이 이미 있으면 거절한다. 덮어쓰지 않는다. */
export function assertNoCollision(projectRoot, workspaceId) {
  const root = workspaceRoot(projectRoot, workspaceId);
  if (fs.existsSync(root)) fail('workspace_exists', `같은 이름의 workspace 가 이미 있습니다: ${workspaceId}`);
  return root;
}

/** 이미 있어야 하는 workspace 를 연다. */
export function requireWorkspace(projectRoot, workspaceId) {
  const root = workspaceRoot(projectRoot, workspaceId);
  if (!fs.existsSync(root)) fail('workspace_missing', `workspace 가 없습니다: ${workspaceId}`);
  if (!fs.statSync(root).isDirectory()) fail('workspace_not_dir', `workspace 자리가 폴더가 아닙니다: ${workspaceId}`);
  return root;
}

/** workspace 안의 고정 자리들. 모두 뿌리 안이라는 것을 확인한 경로다. */
export function workspacePaths(root) {
  const at = (...s) => resolveInside(root, ...s);
  return {
    root,
    brief: at('brief.md'),
    db: at('workspace.db'),
    readme: at('README.md'),
    artifacts: at('artifacts'),
    search: at('artifacts', 'search'),
    maps: at('artifacts', 'maps'),
    pages: at('artifacts', 'pages'),
    exports: at('exports'),
    logs: at('logs'),
  };
}

/** 한 항목·한 시도의 산출물 자리. item_id·attempt_id 를 경로에 넣어 되짚을 수 있게 한다. */
export function attemptDir(root, itemId, attemptId) {
  for (const [name, v] of [['item_id', itemId], ['attempt_id', attemptId]]) {
    if (typeof v !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(v)) {
      fail('id_shape', `${name} 모양이 아닙니다: ${String(v).slice(0, 60)}`);
    }
  }
  return resolveInside(root, 'artifacts', 'pages', itemId, attemptId);
}

/** workspace 안에서 읽어도 되는 입력 파일인지. add_urls 의 파일 입력이 쓴다. */
export function resolveInputFile(root, relOrAbs) {
  if (typeof relOrAbs !== 'string' || !relOrAbs) fail('input_path_empty', '입력 파일 경로가 비었습니다');
  const target = path.isAbsolute(relOrAbs) ? path.resolve(relOrAbs) : path.resolve(root, relOrAbs);
  if (!isInside(root, target)) fail('input_outside_workspace', 'workspace 밖 파일은 읽지 않습니다');
  if (!fs.existsSync(target)) fail('input_missing', '입력 파일이 없습니다');
  const st = fs.lstatSync(target);
  if (st.isSymbolicLink()) fail('input_symlink', '심볼릭 링크는 입력으로 받지 않습니다');
  if (!st.isFile()) fail('input_not_file', '일반 파일이 아닙니다');
  return target;
}
