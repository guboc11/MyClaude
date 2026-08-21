// workspace.db 연결 계층.
//
// 계획서 3-3. 연결마다 WAL·foreign_keys·busy_timeout 을 건다 — foreign_keys 는 연결 단위 설정이라
// 한 번 켠다고 다음 연결에 따라오지 않는다. 여기서 열지 않은 연결은 그 보호를 못 받는다.
//
// node:sqlite 는 Node v22 에서 아직 실험 기능이다(#5 실측). 그래서 최소 버전을 확인하고,
// import 실패를 조용히 넘기지 않는다.

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DDL, SCHEMA_VERSION, initialMeta } from './schema.mjs';
import { isInside } from './paths.mjs';

const MIN_NODE_MAJOR = 22;
const MIN_NODE_MINOR = 5;      // node:sqlite 가 처음 들어온 자리
const BUSY_TIMEOUT_MS = 5000;

export class DbError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DbError';
    this.code = code;
  }
}
const fail = (code, message) => { throw new DbError(code, message); };

/** 이 Node 에서 내장 SQLite 를 쓸 수 있는지. 못 쓰면 조용히 넘기지 않고 세워 둔다. */
export function assertRuntimeSupported() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < MIN_NODE_MAJOR || (major === MIN_NODE_MAJOR && minor < MIN_NODE_MINOR)) {
    fail('node_too_old', `내장 SQLite 에는 Node ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR} 이상이 필요합니다 (현재 ${process.versions.node})`);
  }
  return { node: process.versions.node, experimental: true };
}

/**
 * 연결 하나에 거는 설정.
 *
 * [순서가 중요하다] busy_timeout 을 **가장 먼저** 건다. journal_mode 를 먼저 걸면 그 문장 자체가
 * 잠금을 잡는데, 그 시점엔 기다릴 시간이 0이라 열 개가 동시에 열 때 한 명이 예외로 죽는다.
 * 2026-08-12 게이트 0 에서 일꾼 하나가 이렇게 말없이 사라졌다(9/10). 셈이 맞아떨어져서
 * 한참 다른 원인을 짚었다.
 */
export function applyPragmas(db, { foreignKeys = true } = {}) {
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  const mode = db.prepare('PRAGMA journal_mode = WAL').get().journal_mode;
  if (foreignKeys) db.exec('PRAGMA foreign_keys = ON');
  if (mode !== 'wal') fail('wal_unavailable', `WAL 을 켜지 못했습니다 (journal_mode=${mode})`);
  if (foreignKeys && db.prepare('PRAGMA foreign_keys').get().foreign_keys !== 1) fail('fk_unavailable', '외래키를 켜지 못했습니다');
  return db;
}

/** DB 파일이 workspace 안에 있는지. 밖의 DB 를 열어 주지 않는다. */
function assertDbInside(root, dbPath) {
  if (!isInside(root, dbPath)) fail('db_outside_workspace', 'workspace 밖의 DB 는 열지 않습니다');
}

/** 새 workspace.db 를 만든다. 이미 있으면 거절한다 — 덮어쓰지 않는다. */
export function createDb(root, dbPath, meta) {
  assertRuntimeSupported();
  assertDbInside(root, dbPath);
  if (fs.existsSync(dbPath)) fail('db_exists', `이미 DB 가 있습니다: ${path.basename(dbPath)}`);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = applyPragmas(new DatabaseSync(dbPath));
  try {
    db.exec('BEGIN IMMEDIATE');
    db.exec(DDL);
    const put = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)');
    for (const [k, v] of initialMeta(meta)) put.run(k, v);
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* 이미 풀렸으면 그만 */ }
    db.close();
    throw e;
  }
  return db;
}

/** 있는 DB 를 연다. schema_version 이 이 코드가 아는 것과 다르면 거절한다. */
export function openDb(root, dbPath) {
  assertRuntimeSupported();
  assertDbInside(root, dbPath);
  if (!fs.existsSync(dbPath)) fail('db_missing', 'workspace.db 가 없습니다');

  const db = applyPragmas(new DatabaseSync(dbPath));
  let version;
  try {
    version = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value;
  } catch {
    db.close();
    fail('db_unreadable', 'workspace.db 를 읽을 수 없습니다 (meta 표가 없거나 손상)');
  }
  if (version === undefined) { db.close(); fail('schema_missing', 'schema_version 이 없습니다'); }
  const n = Number(version);
  if (!Number.isInteger(n)) { db.close(); fail('schema_unreadable', `schema_version 이 수가 아닙니다: ${version}`); }
  if (n > SCHEMA_VERSION) {
    db.close();
    fail('schema_too_new', `이 DB 는 더 새 스키마입니다 (DB ${n} > 코드 ${SCHEMA_VERSION}). 코드를 올리세요.`);
  }
  if (n < SCHEMA_VERSION) {
    db.close();
    // 조용히 낮춰 쓰면 없는 열을 읽거나 제약 없이 쓰게 된다.
    fail('schema_too_old', `이 DB 는 옛 스키마입니다 (DB ${n} < 코드 ${SCHEMA_VERSION}). 마이그레이션 없이 열지 않습니다.`);
  }
  return db;
}

/**
 * transaction 안에서 fn 을 돌린다. 예외가 나면 되돌린다.
 *
 * 연결을 여기서 닫지 않는다 — 부른 쪽이 여러 번 쓰기 때문이다. 대신 withDb 가 닫는다.
 */
export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn(db);
    db.exec('COMMIT');
    return out;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* 연결이 이미 죽었으면 그만 */ }
    throw e;
  }
}

/** 열고 쓰고 반드시 닫는다. 예외가 나도 닫는다. */
export function withDb(root, dbPath, fn) {
  const db = openDb(root, dbPath);
  try { return fn(db); } finally { db.close(); }
}

/** meta 를 통째로 읽는다. */
export function readMeta(db) {
  return Object.fromEntries(db.prepare('SELECT key, value FROM meta').all().map((r) => [r.key, r.value]));
}

/** 무결성 검사. 손상을 정상으로 꾸미지 않는다. */
export function integrityCheck(db) {
  return db.prepare('PRAGMA integrity_check').get().integrity_check;
}
