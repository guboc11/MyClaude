// export — 다음 역할이 읽을 **작은** 결과 파일.
//
// 계획서 4-9. 지키는 것은 넷이다.
//   (1) 원본을 복사하지 않는다. 화면·본문·DOM 은 있던 자리에 그대로 두고 **경로만** 적는다.
//   (2) 되짚을 수 있어야 한다. 어느 줄에서도 item_id 로 장부에, 경로로 파일에 닿는다.
//   (3) 거른 조건을 그대로 돌려준다. 무엇을 걸러 몇 줄이 남았는지 모르면 0줄이 "없다" 인지
//       "잘못 걸렀다" 인지 알 수 없다.
//   (4) 모르는 조건은 0줄이 아니라 **오류**다. 오타 하나가 "아무것도 없네" 로 읽히면 안 된다.
//
// 판정을 해석하지 않는다. label 을 보고 줄을 지우거나 순위를 매기지 않는다 — 거르고 적을 뿐이다.
// 기존 export 를 덮어쓰지 않는다. 내보낼 때마다 새 파일이고, 지난 것은 그대로 남는다.

import fs from 'node:fs';
import path from 'node:path';
import { atomicWrite } from './artifacts.mjs';
import { SOURCE_KINDS, WORK_STATES } from './schema.mjs';
import { workspacePaths } from './paths.mjs';

export class ExportError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ExportError';
    this.code = code;
  }
}
const fail = (code, message) => { throw new ExportError(code, message); };

export const EXPORT_FORMATS = Object.freeze(['jsonl', 'csv']);

/**
 * 내보낼 수 있는 칸. 여기 없는 이름은 조용히 무시하지 않고 거절한다 —
 * 오타 난 칸이 빠진 채로 나가면, 받는 쪽은 그 칸이 원래 비어 있는 줄 안다.
 */
export const EXPORT_FIELDS = Object.freeze([
  'item_id', 'canonical_url', 'original_url', 'domain',
  'work_state', 'review_required', 'collected_at', 'created_at', 'updated_at',
  'source_kinds', 'sources',
  'labels', 'judgment_count', 'judgments',
  'warning_codes', 'error_codes',
  'attempt_ids', 'manifest_paths', 'artifact_paths',
]);

/** 아무것도 안 고르면 이만큼. 되짚을 자리(item_id·경로)가 늘 들어 있다. */
export const DEFAULT_FIELDS = Object.freeze([
  'item_id', 'canonical_url', 'domain', 'work_state', 'labels', 'judgment_count', 'sources', 'manifest_paths',
]);

/** 되짚기의 닻. 무엇을 고르든 이 칸은 빠지지 않는다. */
const ANCHOR = 'item_id';

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const stamp = (nowMs) => new Date(nowMs + KST_OFFSET_MS).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);

// ── 거르기 ────────────────────────────────────────────────────

/**
 * 쉼표로 여러 값을 받는 조건과 통째로 한 값인 조건이 갈린다.
 *
 * state·domain·warning 은 값 자체에 쉼표가 들어갈 수 없다(상태 이름·도메인·오류 코드).
 * 그래서 쉼표를 "또" 로 읽어도 안전하다.
 * label 과 source 의 값은 사람이 쓴 글이라 쉼표가 들어간다 — "수제 청첩장, 서울" 같은 검색어를
 * 둘로 쪼개면 아무것도 못 찾고 0줄이 된다. 그쪽은 통째로 한 값으로 본다.
 */
const asList = (v) => String(v).split(',').map((s) => s.trim()).filter(Boolean);
const asOne = (v) => String(v).trim();

/**
 * 조건을 SQL 조각으로 바꾼다. 모르는 값은 여기서 걸러 오류로 만든다.
 * @returns {{where:string[], params:any[], summary:object}}
 */
function buildFilter(db, f = {}) {
  const where = [];
  const params = [];
  const summary = {};

  if (f.filter_state !== undefined && f.filter_state !== null && f.filter_state !== '') {
    const states = asList(f.filter_state);
    const unknown = states.filter((s) => !WORK_STATES.includes(s));
    if (unknown.length) fail('unknown_state', `모르는 상태입니다: ${unknown.join('·')} (${WORK_STATES.join('·')} 중에서 고르세요)`);
    where.push(`i.work_state IN (${states.map(() => '?').join(',')})`);
    params.push(...states);
    summary.state = states;
  }

  if (f.filter_domain !== undefined && f.filter_domain !== null && f.filter_domain !== '') {
    const domains = asList(f.filter_domain);
    where.push(`i.domain IN (${domains.map(() => '?').join(',')})`);
    params.push(...domains);
    summary.domain = domains;
  }

  if (f.filter_label !== undefined && f.filter_label !== null && f.filter_label !== '') {
    const label = asOne(f.filter_label);
    where.push('EXISTS (SELECT 1 FROM judgments j WHERE j.item_id = i.item_id AND j.label = ?)');
    params.push(label);
    summary.label = label;
  }

  if (f.filter_source !== undefined && f.filter_source !== null && f.filter_source !== '') {
    // "kind" 또는 "kind:값". 앞의 것은 갈래만, 뒤의 것은 그 갈래의 그 값까지 본다.
    const spec = asOne(f.filter_source);
    const at = spec.indexOf(':');
    const kind = at === -1 ? spec : spec.slice(0, at);
    if (!SOURCE_KINDS.includes(kind)) fail('unknown_source', `모르는 출처 갈래입니다: ${kind} (${SOURCE_KINDS.join('·')} 중에서 고르세요)`);
    const value = at === -1 ? null : spec.slice(at + 1);
    where.push(value === null
      ? 'EXISTS (SELECT 1 FROM sources s WHERE s.item_id = i.item_id AND s.source_kind = ?)'
      : 'EXISTS (SELECT 1 FROM sources s WHERE s.item_id = i.item_id AND s.source_kind = ? AND s.source_value = ?)');
    params.push(kind);
    if (value !== null) params.push(value);
    summary.source = spec;
  }

  if (f.filter_warning !== undefined && f.filter_warning !== null && f.filter_warning !== '') {
    const codes = asList(f.filter_warning);
    // 경고는 attempts 의 배열 칸에 있다. json_each 로 펴서 본다.
    where.push(`EXISTS (SELECT 1 FROM attempts a, json_each(a.warning_codes) w
                         WHERE a.item_id = i.item_id AND a.warning_codes IS NOT NULL
                           AND w.value IN (${codes.map(() => '?').join(',')}))`);
    params.push(...codes);
    summary.warning = codes;
  }

  return { where, params, summary };
}

// ── 줄 만들기 ─────────────────────────────────────────────────

/** 한 item 의 값들. 필요한 칸만 나중에 골라 낸다. */
function rowsFor(db, where, params) {
  const sql = `SELECT i.item_id, i.original_url, i.canonical_url, i.domain, i.work_state,
                      i.review_required, i.collected_at, i.created_at, i.updated_at
                 FROM items i
                ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                ORDER BY i.item_id`;
  const items = db.prepare(sql).all(...params);
  if (items.length === 0) return [];

  const sources = db.prepare('SELECT item_id, source_kind, source_value FROM sources ORDER BY source_id');
  const judgments = db.prepare('SELECT item_id, worker_id, label, confidence, note, evidence_artifact_ids FROM judgments ORDER BY judgment_id');
  const attempts = db.prepare(`SELECT attempt_id, item_id, operation, result, warning_codes, error_code
                                 FROM attempts WHERE item_id IS NOT NULL ORDER BY started_at, attempt_id`);
  const artifacts = db.prepare(`SELECT a.path, t.item_id FROM artifacts a
                                  JOIN attempts t ON t.attempt_id = a.attempt_id
                                 WHERE t.item_id IS NOT NULL ORDER BY a.artifact_id`);

  const group = (rows) => {
    const m = new Map();
    for (const r of rows) {
      if (!m.has(r.item_id)) m.set(r.item_id, []);
      m.get(r.item_id).push(r);
    }
    return m;
  };
  const bySource = group(sources.all());
  const byJudgment = group(judgments.all());
  const byAttempt = group(attempts.all());
  const byArtifact = group(artifacts.all());

  return items.map((i) => {
    const src = bySource.get(i.item_id) ?? [];
    const jud = byJudgment.get(i.item_id) ?? [];
    const att = byAttempt.get(i.item_id) ?? [];
    const art = byArtifact.get(i.item_id) ?? [];
    const warnings = new Set();
    for (const a of att) {
      if (!a.warning_codes) continue;
      for (const w of JSON.parse(a.warning_codes)) warnings.add(w);
    }
    return {
      item_id: i.item_id,
      canonical_url: i.canonical_url,
      original_url: i.original_url,
      domain: i.domain,
      work_state: i.work_state,
      review_required: i.review_required === 1,
      collected_at: i.collected_at,
      created_at: i.created_at,
      updated_at: i.updated_at,
      source_kinds: [...new Set(src.map((s) => s.source_kind))],
      sources: src.map((s) => `${s.source_kind}:${s.source_value}`),
      // 라벨은 **모두** 낸다. 갈린 판정 중 하나를 골라 주지 않는다.
      labels: jud.filter((j) => j.label !== null).map((j) => j.label),
      judgment_count: jud.length,
      judgments: jud.map((j) => ({
        worker_id: j.worker_id, label: j.label, confidence: j.confidence,
        note: j.note, evidence_artifact_ids: JSON.parse(j.evidence_artifact_ids),
      })),
      warning_codes: [...warnings].sort(),
      error_codes: [...new Set(att.filter((a) => a.error_code).map((a) => a.error_code))].sort(),
      attempt_ids: att.map((a) => a.attempt_id),
      // 원본으로 가는 길. 파일을 옮겨 오지 않고 자리만 알려 준다.
      manifest_paths: att.filter((a) => a.operation === 'collect').map((a) => `artifacts/pages/${a.item_id}/${a.attempt_id}/manifest.json`),
      artifact_paths: art.map((a) => a.path),
    };
  });
}

// ── 적기 ──────────────────────────────────────────────────────

const jsonlOf = (rows, fields) => rows.map((r) => JSON.stringify(Object.fromEntries(fields.map((f) => [f, r[f]])))).join('\n');

/** CSV 한 칸. RFC 4180 — 쉼표·따옴표·줄바꿈이 있으면 감싸고, 따옴표는 겹쳐 쓴다. */
export function csvCell(v) {
  let s;
  if (v === null || v === undefined) s = '';
  else if (Array.isArray(v) || (typeof v === 'object')) s = JSON.stringify(v);
  else if (typeof v === 'boolean') s = v ? 'true' : 'false';
  else s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const csvOf = (rows, fields) => [
  fields.map(csvCell).join(','),
  ...rows.map((r) => fields.map((f) => csvCell(r[f])).join(',')),
].join('\r\n');

/** 같은 이름을 덮지 않는다. 이미 있으면 -2, -3 으로 비켜 간다. */
function freeName(dir, base, ext) {
  for (let n = 1; n < 1000; n++) {
    const name = n === 1 ? `${base}.${ext}` : `${base}-${n}.${ext}`;
    if (!fs.existsSync(path.join(dir, name))) return name;
  }
  fail('too_many_exports', '같은 시각의 export 가 너무 많습니다');
  return null;
}

/**
 * 거른 결과를 exports/ 아래 새 파일로 낸다.
 *
 * @param opts { format, fields, filter_*, nowMs }
 * @returns {{rows:number, path:string, filter_summary:object}}
 */
export async function runExport(db, root, {
  format, fields, nowMs = Date.now(), ...filters
} = {}) {
  if (!EXPORT_FORMATS.includes(format)) fail('bad_format', `format 은 ${EXPORT_FORMATS.join('·')} 중 하나입니다`);

  let chosen = DEFAULT_FIELDS.slice();
  if (fields !== undefined && fields !== null) {
    if (!Array.isArray(fields)) fail('bad_fields', 'fields 는 배열이어야 합니다');
    if (fields.length === 0) fail('bad_fields', 'fields 가 비었습니다. 아예 안 주면 기본 칸으로 냅니다.');
    const unknown = fields.filter((f) => !EXPORT_FIELDS.includes(f));
    if (unknown.length) fail('unknown_field', `모르는 칸입니다: ${unknown.join('·')} (고를 수 있는 것: ${EXPORT_FIELDS.join('·')})`);
    chosen = [...new Set(fields)];
  }
  // 닻은 언제나 첫 칸이다. 되짚을 수 없는 export 는 만들지 않는다.
  if (!chosen.includes(ANCHOR)) chosen = [ANCHOR, ...chosen];

  const { where, params, summary } = buildFilter(db, filters);
  const rows = rowsFor(db, where, params);

  const dir = workspacePaths(root).exports;
  fs.mkdirSync(dir, { recursive: true });
  const name = freeName(dir, `${stamp(nowMs)}`, format);
  const body = format === 'jsonl' ? jsonlOf(rows, chosen) : csvOf(rows, chosen);
  // [줄 끝을 섞지 않는다] CSV 는 줄 사이가 CRLF 인데 마지막만 LF 로 끝내면, 엄격한 RFC 4180
  // 해석기는 그 LF 를 마지막 칸의 글자로 읽는다. 형식마다 자기 줄 끝으로 닫는다.
  const eol = format === 'csv' ? '\r\n' : '\n';
  // 0줄이어도 파일은 만든다. "안 나왔다" 와 "안 돌렸다" 는 다른 말이다.
  const written = await atomicWrite(dir, name, body.length ? `${body}${eol}` : '');
  const rel = `exports/${name}`;

  db.prepare("INSERT INTO meta (key, value) VALUES ('last_export', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(rel);

  return {
    rows: rows.length,
    path: rel,
    filter_summary: {
      ...summary,
      fields: chosen,
      format,
      // 거른 뒤 몇 줄인지와 전체가 몇 줄인지를 같이 낸다. 0줄일 때 무엇을 걸렀는지 보이게.
      matched: rows.length,
      total_items: db.prepare('SELECT COUNT(*) AS n FROM items').get().n,
      byte_size: written.bytes,
    },
  };
}
