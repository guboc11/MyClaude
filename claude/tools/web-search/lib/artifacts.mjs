// artifact — 파일 하나를 안전하게 만들고 장부에 매단다.
//
// 계획서 5-3. 지켜야 하는 성질은 하나다:
// **장부에 있는 파일은 반드시 온전하게 거기 있고, 만들다 만 것은 장부에 없다.**
//
// 그래서 순서가 정해져 있다.
//   임시 이름으로 쓴다 → fsync → 크기 확인 → 원자적 rename → 다시 읽어 지문 확인 → 그제서야 장부에 넣는다
//
// 파일 먼저, 장부 나중인 이유: 중간에 죽으면 "장부에 없는 파일" 이 남는다. 그건 찾아낼 수 있다.
// 반대로 하면 "파일 없는 장부 줄" 이 남고, 그건 장부가 거짓말을 하는 것이다. 둘 중 하나를 골라야 하면
// 장부가 거짓말하지 않는 쪽이다.
//
// 만들다 만 파일은 `.part-` 로 시작한다. 장부에는 애초에 안 들어가고, 파일 목록에서도 빼고,
// 대신 verify 가 "덜 만들어진 것" 으로 따로 세어 준다 — 조용히 사라지게 두지 않는다.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { tx } from './db.mjs';
import { attemptDir, resolveInside } from './paths.mjs';
import { ARTIFACT_KINDS } from './schema.mjs';

export class ArtifactError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ArtifactError';
    this.code = code;
  }
}
const fail = (code, message) => { throw new ArtifactError(code, message); };

/** 만들다 만 파일의 이름표. 이 접두어가 붙은 것은 절대 artifact 가 아니다. */
export const TEMP_PREFIX = '.part-';

/** 이 실행의 index 파일. artifact 가 아니라 artifact 들을 가리키는 문서다. */
export const MANIFEST_NAME = 'manifest.json';

/**
 * artifact 를 **가리키는** 문서들이 사는 자리. manifest.json 과 같은 갈래다 —
 * 수집 결과물이 아니라 결과물을 찾아가는 길이라서 장부에 줄이 없고, 고아로도 세지 않는다.
 *   collect/ — 부름 한 번의 색인 (#28)
 *   leases/  — 워커가 받아 간 작업 목록 (#16)
 */
export const POINTER_DIRS = Object.freeze(['collect', 'leases']);

/** 요청한 산출물 이름과 장부의 artifact 종류를 잇는다. */
export const OUTPUT_TO_KIND = {
  screenshot: 'screenshot',
  text: 'text',
  dom: 'dom',
  links: 'link_manifest',
  images: 'image_manifest',
};

const MIME_BY_EXT = {
  '.txt': 'text/plain; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jsonl': 'application/x-ndjson; charset=utf-8',
  '.gz': 'application/gzip',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
};

const guessMime = (name) => {
  const lower = name.toLowerCase();
  if (lower.endsWith('.html.gz')) return 'application/gzip';
  return MIME_BY_EXT[path.extname(lower)] || 'application/octet-stream';
};

// ── 자리 ──────────────────────────────────────────────────────

/**
 * 이 실행의 산출물이 사는 폴더. 계획서 3-2 의 구조를 그대로 따른다.
 *   collect → artifacts/pages/<item-id>/<attempt-id>/
 *   search  → artifacts/search/<attempt-id>/
 *   map     → artifacts/maps/<attempt-id>/
 */
export function attemptStorageDir(root, attempt) {
  if (attempt.operation === 'collect') return attemptDir(root, String(attempt.item_id), attempt.attempt_id);
  const bucket = attempt.operation === 'search' ? 'search' : 'maps';
  return resolveInside(root, 'artifacts', bucket, attempt.attempt_id);
}

/** workspace 뿌리에서 본 상대 경로. 장부에는 이 모양으로 적는다 — workspace 를 옮겨도 살아 있다. */
const relOf = (root, abs) => path.relative(root, abs).split(path.sep).join('/');

const absOf = (root, rel) => resolveInside(root, ...rel.split('/'));

// ── 원자적 쓰기 ───────────────────────────────────────────────

/** 부모 폴더까지 디스크에 박아 둔다. rename 은 폴더의 변경이라 폴더도 fsync 해야 살아남는다. */
function fsyncDir(dir) {
  let fd;
  try {
    fd = fs.openSync(dir, 'r');
    fs.fsyncSync(fd);
  } catch { /* 폴더 fsync 를 막는 파일 시스템이 있다. 여기서 실패해도 파일 자체는 이미 온전하다. */ }
  finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* 닫기 실패는 삼킨다 */ } }
}

const asChunks = (data) => {
  if (data === null || data === undefined) fail('no_data', '쓸 내용이 없습니다');
  if (Buffer.isBuffer(data)) return [data];
  if (typeof data === 'string') return [Buffer.from(data, 'utf8')];
  if (typeof data[Symbol.asyncIterator] === 'function' || typeof data[Symbol.iterator] === 'function') return data;
  fail('bad_data', '내용은 Buffer·문자열·조각 흐름이어야 합니다');
  return [];
};

/**
 * 임시 이름으로 다 쓴 뒤에야 최종 이름으로 옮긴다.
 * 중간에 무엇이 터져도 최종 경로에는 절반짜리 파일이 나타나지 않는다.
 *
 * @returns {{abs:string, bytes:number, sha256:string}}
 */
export async function atomicWrite(dir, name, data) {
  if (typeof name !== 'string' || !name || name.includes('/') || name.includes('\\')) {
    fail('bad_name', `파일 이름이 아닙니다: ${String(name).slice(0, 60)}`);
  }
  if (name.startsWith(TEMP_PREFIX)) fail('bad_name', `${TEMP_PREFIX} 로 시작하는 이름은 쓸 수 없습니다`);

  fs.mkdirSync(dir, { recursive: true });
  const abs = path.join(dir, name);
  const tmp = path.join(dir, `${TEMP_PREFIX}${process.pid}-${Date.now().toString(36)}-${name}`);

  const hash = createHash('sha256');
  let bytes = 0;
  let fd;
  try {
    fd = fs.openSync(tmp, 'wx', 0o600);
    for await (const chunk of asChunks(data)) {
      const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      fs.writeSync(fd, b);
      hash.update(b);
      bytes += b.length;
    }
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;

    // 쓴 만큼 실제로 들어갔는가. 여기서 어긋나면 rename 하지 않는다.
    const wrote = fs.statSync(tmp).size;
    if (wrote !== bytes) fail('short_write', `${bytes}바이트를 쓰려 했는데 ${wrote}바이트만 들어갔습니다`);

    fs.renameSync(tmp, abs);
    fsyncDir(dir);
  } catch (e) {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* 무시 */ }
    // 만들다 만 것은 치운다. 못 치워도 `.part-` 라서 artifact 로 오해되지 않는다.
    try { fs.rmSync(tmp, { force: true }); } catch { /* 무시 */ }
    throw e;
  }

  return { abs, bytes, sha256: hash.digest('hex') };
}

// ── 장부에 매달기 ─────────────────────────────────────────────

/**
 * 파일을 만들고 artifacts 에 한 줄 넣는다.
 *
 * @returns {{artifact_id:number, path:string, byte_size:number, sha256:string, mime_type:string}}
 */
export async function writeArtifact(db, {
  root, attemptId, kind, name, data, mime = null, nowMs = Date.now(), subdir = null,
}) {
  if (!ARTIFACT_KINDS.includes(kind)) fail('bad_kind', `kind 는 ${ARTIFACT_KINDS.join('·')} 중 하나입니다`);

  const attempt = db.prepare('SELECT attempt_id, item_id, operation FROM attempts WHERE attempt_id = ?').get(attemptId);
  if (!attempt) fail('attempt_missing', `없는 attempt_id 입니다: ${attemptId}`);

  const baseDir = attemptStorageDir(root, attempt);
  const dir = subdir ? resolveInside(baseDir, subdir) : baseDir;
  const rel = relOf(root, path.join(dir, name));

  // 같은 자리에 두 번 쓰지 않는다. 재시도는 새 attempt 라 새 폴더를 쓴다(계획서 2-4).
  const taken = db.prepare('SELECT artifact_id FROM artifacts WHERE path = ?').get(rel);
  if (taken) fail('artifact_exists', `이미 장부에 있는 자리입니다: ${rel}`);
  if (fs.existsSync(path.join(dir, name))) fail('file_exists', `장부에 없는 파일이 이미 그 자리에 있습니다: ${rel}`);

  const { abs, bytes, sha256 } = await atomicWrite(dir, name, data);

  // 옮긴 뒤 다시 읽어 본다. 여기까지 맞아야 "만들었다" 고 말한다.
  const after = fs.statSync(abs);
  if (after.size !== bytes) fail('size_changed_after_rename', `옮긴 뒤 크기가 다릅니다: ${after.size} ≠ ${bytes}`);
  const reread = createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
  if (reread !== sha256) fail('sha_changed_after_rename', '옮긴 뒤 지문이 다릅니다');

  const mimeType = mime || guessMime(name);
  try {
    const info = tx(db, (d) => d.prepare(`
      INSERT INTO artifacts (attempt_id, kind, path, mime_type, byte_size, sha256, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(attemptId, kind, rel, mimeType, bytes, sha256, nowMs));
    return { artifact_id: Number(info.lastInsertRowid), path: rel, byte_size: bytes, sha256, mime_type: mimeType };
  } catch (e) {
    // 줄을 못 넣었으면 파일도 남기지 않는다. 남기면 아무도 안 가리키는 파일이 된다.
    try { fs.rmSync(abs, { force: true }); } catch { /* 무시 */ }
    throw e;
  }
}

/** 이 실행이 남긴 장부 줄들. */
export const artifactsOf = (db, attemptId) =>
  db.prepare('SELECT artifact_id, kind, path, mime_type, byte_size, sha256, created_at FROM artifacts WHERE attempt_id = ? ORDER BY artifact_id').all(attemptId);

// ── manifest ──────────────────────────────────────────────────

/**
 * 이 실행 한 장의 요약을 폴더에 남긴다. 계획서 5-5 가 요구하는 값이 전부 여기 있다 —
 * 긴 로그를 열지 않고도 무엇을 하려 했고 무엇이 되고 무엇이 빠졌는지 볼 수 있어야 한다.
 * manifest 자체는 artifact 가 아니다. artifact 들을 가리키는 문서다.
 */
export async function writeManifest(db, root, attemptId, { nowMs = Date.now() } = {}) {
  const a = db.prepare('SELECT * FROM attempts WHERE attempt_id = ?').get(attemptId);
  if (!a) fail('attempt_missing', `없는 attempt_id 입니다: ${attemptId}`);

  const workspaceId = db.prepare("SELECT value FROM meta WHERE key = 'workspace_id'").get()?.value ?? null;
  const rows = artifactsOf(db, attemptId);
  const requested = a.requested_outputs === null ? null : JSON.parse(a.requested_outputs);
  const producedKinds = new Set(rows.map((r) => r.kind));
  // [같은 말로 적는다] produced 와 missing 은 둘 다 **요청한 산출물 이름**으로 말해야 한다.
  // artifact 종류를 그대로 늘어놓으면 그림 아홉 장이 "image 아홉 개" 로 나와 missing 과 견줄 수 없다.
  // 낱낱의 파일은 아래 artifacts 목록에 이미 다 있다.
  const produced = requested === null
    ? [...producedKinds].sort()
    : requested.filter((o) => producedKinds.has(OUTPUT_TO_KIND[o]));
  const missing = requested === null ? [] : requested.filter((o) => !producedKinds.has(OUTPUT_TO_KIND[o]));

  const doc = {
    schema: 'web-search-v2-attempt-manifest/1',
    workspace_id: workspaceId,
    item_id: a.item_id,
    attempt_id: a.attempt_id,
    operation: a.operation,
    collector: a.collector,
    requested_url: a.requested_url,
    final_url: a.final_url,
    http_status: a.http_status,
    result: a.result,
    requested_outputs: requested,
    produced_outputs: produced,
    missing_outputs: missing,
    warning_codes: a.warning_codes === null ? [] : JSON.parse(a.warning_codes),
    error: a.error_code === null ? null
      : { stage: a.error_stage, code: a.error_code, message_short: a.error_message_short },
    // [번호도 같이 준다] report 는 판정의 근거로 artifact_id 를 요구하는데(#39), 요약에 경로만
    // 있으면 에이전트가 그 번호를 알 길이 없다 — 장부를 직접 열지 않는 한. 그러면 "근거를 대라"
    // 는 규칙이 버튼만으로는 지켜질 수 없는 규칙이 된다. 2026-08-12 시나리오 A 에서 드러났다.
    artifacts: rows.map((r) => ({
      artifact_id: r.artifact_id,
      kind: r.kind, path: r.path, mime_type: r.mime_type, byte_size: r.byte_size, sha256: r.sha256,
    })),
    // 다시 돌릴 때 무엇을 넘기면 되는지. 계획서 5-5 의 "다시 실행할 item_id".
    retry_item_id: a.item_id,
    started_at: a.started_at,
    finished_at: a.finished_at,
    written_at: nowMs,
  };

  const dir = attemptStorageDir(root, a);
  const abs = path.join(dir, MANIFEST_NAME);
  // manifest 는 실행이 끝날 때마다 다시 쓸 수 있다. 원자적 교체라 반쪽짜리가 보이지 않는다.
  fs.mkdirSync(dir, { recursive: true });
  fs.rmSync(abs, { force: true });
  const written = await atomicWrite(dir, MANIFEST_NAME, `${JSON.stringify(doc, null, 2)}\n`);
  return { path: relOf(root, written.abs), byte_size: written.bytes, missing_outputs: missing };
}

// ── 파일 쪽에서 보기 ──────────────────────────────────────────

const walk = (dir, out = []) => {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile()) out.push(p);
  }
  return out;
};

/**
 * 이 실행 폴더의 **정상** 파일들. 만들다 만 것과 manifest 는 뺀다.
 * "만들다 만 파일이 정상 artifact 로 보이지 않는다" 는 성질이 여기서 지켜진다.
 */
export function listArtifactFiles(root, attempt) {
  const dir = attemptStorageDir(root, attempt);
  return walk(dir)
    .filter((p) => !path.basename(p).startsWith(TEMP_PREFIX))
    .filter((p) => path.basename(p) !== MANIFEST_NAME)
    .map((p) => relOf(root, p))
    .sort();
}

/** 만들다 만 파일. 조용히 지우지 않고 세어서 보여 준다. */
export function incompleteFiles(root) {
  const base = path.join(root, 'artifacts');
  return walk(base)
    .filter((p) => path.basename(p).startsWith(TEMP_PREFIX))
    .map((p) => relOf(root, p))
    .sort();
}

// ── 대조 ──────────────────────────────────────────────────────

/**
 * 장부 줄 하나가 파일과 같은 말을 하는가. 근거로 쓰기 전에 확인하는 자리(#39).
 *
 * verifyArtifacts 는 workspace 전체를 훑어 보고를 만드는 함수라, 판정 한 줄을 받을 때마다
 * 부르면 항목 수만큼 전체 검사가 돈다. 여기서는 지목한 한 줄만 본다.
 *
 * @returns {{ok:boolean, reason?:string, row?:object, detail?:object}}
 */
export function checkArtifactFile(db, root, artifactId) {
  const id = Number(artifactId);
  if (!Number.isInteger(id)) return { ok: false, reason: 'evidence_type' };
  const r = db.prepare(`
    SELECT a.artifact_id, a.attempt_id, a.kind, a.path, a.byte_size, a.sha256, t.item_id
      FROM artifacts a JOIN attempts t ON t.attempt_id = a.attempt_id
     WHERE a.artifact_id = ?`).get(id);
  // 다른 workspace 의 번호를 들고 와도 여기 장부에 없으면 그만이다. DB 가 곧 workspace 경계다.
  if (!r) return { ok: false, reason: 'evidence_not_here' };

  let abs;
  try { abs = absOf(root, r.path); } catch { return { ok: false, reason: 'evidence_path_outside', row: r }; }
  if (!fs.existsSync(abs)) return { ok: false, reason: 'evidence_file_missing', row: r };
  const size = fs.statSync(abs).size;
  if (size !== r.byte_size) return { ok: false, reason: 'evidence_size_mismatch', row: r, detail: { db: r.byte_size, disk: size } };
  if (createHash('sha256').update(fs.readFileSync(abs)).digest('hex') !== r.sha256) {
    return { ok: false, reason: 'evidence_sha_mismatch', row: r };
  }
  return { ok: true, row: r };
}

/**
 * 장부와 파일이 같은 말을 하는가. #23 의 완료 조건을 그대로 재는 함수다.
 *
 * @returns {{
 *   checked:number, ok:number,
 *   missing:string[],      // 장부에 있는데 파일이 없다
 *   size_mismatch:{path,db,disk}[], sha_mismatch:string[],
 *   orphans:string[],      // 파일은 있는데 장부에 없다
 *   incomplete:string[],   // 만들다 만 파일
 *   manifest_missing:string[]  // 끝났는데 요약이 없는 실행
 * }}
 */
export function verifyArtifacts(db, root, { attemptId = null } = {}) {
  const rows = attemptId
    ? db.prepare('SELECT * FROM artifacts WHERE attempt_id = ? ORDER BY artifact_id').all(attemptId)
    : db.prepare('SELECT * FROM artifacts ORDER BY artifact_id').all();

  const missing = [];
  const sizeMismatch = [];
  const shaMismatch = [];
  let ok = 0;

  for (const r of rows) {
    let abs;
    try { abs = absOf(root, r.path); } catch { missing.push(r.path); continue; }
    if (!fs.existsSync(abs)) { missing.push(r.path); continue; }
    const size = fs.statSync(abs).size;
    if (size !== r.byte_size) { sizeMismatch.push({ path: r.path, db: r.byte_size, disk: size }); continue; }
    if (createHash('sha256').update(fs.readFileSync(abs)).digest('hex') !== r.sha256) { shaMismatch.push(r.path); continue; }
    ok++;
  }

  // 파일 쪽에서도 본다. 장부만 훑으면 "아무도 안 가리키는 파일" 을 영영 못 찾는다.
  const known = new Set(rows.map((r) => r.path));
  const all = walk(path.join(root, 'artifacts')).map((p) => relOf(root, p));
  const incomplete = all.filter((p) => path.basename(p).startsWith(TEMP_PREFIX)).sort();
  const orphans = all
    .filter((p) => !path.basename(p).startsWith(TEMP_PREFIX))
    .filter((p) => path.basename(p) !== MANIFEST_NAME)
    .filter((p) => !POINTER_DIRS.some((d) => p.startsWith(`artifacts/${d}/`)))
    .filter((p) => !known.has(p))
    .sort();

  // 끝난 실행에는 요약이 있어야 한다. 없으면 "무슨 일이 있었는지" 를 긴 로그로만 알 수 있게 되고,
  // 그것이 1차가 무너진 자리다 — 사람이 본 것과 장부가 다른데 아무도 못 알아챘다.
  const finished = attemptId
    ? db.prepare('SELECT attempt_id, item_id, operation FROM attempts WHERE attempt_id = ? AND finished_at IS NOT NULL').all(attemptId)
    : db.prepare('SELECT attempt_id, item_id, operation FROM attempts WHERE finished_at IS NOT NULL').all();
  const manifestMissing = finished
    .filter((a) => !fs.existsSync(path.join(attemptStorageDir(root, a), MANIFEST_NAME)))
    .map((a) => a.attempt_id)
    .sort();

  return {
    checked: rows.length,
    ok,
    missing,
    size_mismatch: sizeMismatch,
    sha_mismatch: shaMismatch,
    orphans: attemptId ? [] : orphans,   // 한 실행만 볼 때는 다른 실행의 파일을 고아라 부르지 않는다
    incomplete,
    manifest_missing: manifestMissing,
  };
}
