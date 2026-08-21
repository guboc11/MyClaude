// add_urls 의 입력 읽기 — 배열·JSONL·CSV 를 한 모양으로 만든다.
//
// 계획서 4-2. 긴 원문을 MCP 응답으로 주고받지 않는다. 파일은 workspace 안에서만 읽고,
// 깨진 줄은 버리지 않고 줄 번호와 사유로 센다 — "몇 줄이 왜 안 들어갔는지" 를 말할 수 있어야 한다.
//
// 여기서는 정규화도 중복 판정도 하지 않는다. 그건 #13 이 한 곳에서 한다 —
// 입력 방식이 달라도 같은 길로 들어가야 하기 때문이다.

import fs from 'node:fs';
import { resolveInputFile } from './paths.mjs';

export const MAX_FILE_BYTES = 32 * 1024 * 1024;
export const MAX_LINES = 200_000;
export const MAX_URLS_INLINE = 10_000;

export class ImportError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ImportError';
    this.code = code;
  }
}
const fail = (code, message) => { throw new ImportError(code, message); };

const URL_HEADERS = ['url', 'canonical_url', 'link', 'href', 'address'];

function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else quoted = false;
      } else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  if (quoted) return null;      // 따옴표가 안 닫힌 줄
  out.push(cur);
  return out.map((s) => s.trim());
}

function readTextFile(root, relOrAbs) {
  const abs = resolveInputFile(root, relOrAbs);
  const bytes = fs.statSync(abs).size;
  if (bytes > MAX_FILE_BYTES) fail('file_too_large', `입력 파일이 ${bytes}바이트로 상한 ${MAX_FILE_BYTES} 을 넘습니다`);
  return { abs, bytes, text: fs.readFileSync(abs, 'utf8') };
}

/** JSONL 한 줄에서 URL 을 꺼낸다. 문자열 한 줄도 받는다. */
function urlFromJsonl(line) {
  const trimmed = line.trim();
  if (!trimmed) return { skip: true };
  if (!trimmed.startsWith('{') && !trimmed.startsWith('"') && !trimmed.startsWith('[')) {
    return { url: trimmed };                       // 그냥 주소만 적힌 줄
  }
  let v;
  try { v = JSON.parse(trimmed); } catch (e) { return { reason: `json_parse: ${e.message.slice(0, 60)}` }; }
  if (typeof v === 'string') return { url: v };
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    for (const k of URL_HEADERS) if (typeof v[k] === 'string' && v[k].trim()) return { url: v[k].trim() };
    return { reason: `url 필드가 없습니다 (${URL_HEADERS.join('·')} 중 하나가 필요)` };
  }
  return { reason: '객체나 문자열이 아닙니다' };
}

/**
 * 입력을 공통 레코드로 만든다.
 * @returns {{received:number, records:{url:string, line:number|null}[], rejected:{line:number|null, reason:string}[], source:{kind:string, detail:object}}}
 */
export function parseInput(root, { urls, file } = {}) {
  const hasUrls = Array.isArray(urls);
  const hasFile = typeof file === 'string' && file !== '';
  if (hasUrls && hasFile) fail('both_inputs', 'urls 와 file 중 하나만 주세요');
  if (!hasUrls && !hasFile) fail('no_input', 'urls 나 file 중 하나는 있어야 합니다');

  const records = [];
  const rejected = [];

  if (hasUrls) {
    if (urls.length > MAX_URLS_INLINE) {
      fail('too_many_inline', `한 번에 넣을 수 있는 URL 은 ${MAX_URLS_INLINE}개까지입니다 (받은 ${urls.length}개). 많으면 파일로 주세요.`);
    }
    urls.forEach((u, i) => {
      if (typeof u !== 'string' || !u.trim()) rejected.push({ line: i + 1, reason: '빈 값이거나 문자열이 아닙니다' });
      else records.push({ url: u.trim(), line: i + 1 });
    });
    return { received: urls.length, records, rejected, source: { kind: 'inline', detail: { count: urls.length } } };
  }

  const { abs, bytes, text } = readTextFile(root, file);
  const lines = text.split('\n');
  if (lines.length > MAX_LINES) fail('too_many_lines', `줄 수가 ${lines.length}로 상한 ${MAX_LINES} 을 넘습니다`);

  const isCsv = /\.csv$/i.test(abs);
  if (!isCsv) {
    let received = 0;
    lines.forEach((line, i) => {
      const r = urlFromJsonl(line);
      if (r.skip) return;
      received++;
      if (r.url) records.push({ url: r.url, line: i + 1 });
      else rejected.push({ line: i + 1, reason: r.reason });
    });
    return { received, records, rejected, source: { kind: 'jsonl', detail: { path: abs, bytes } } };
  }

  // CSV — 머리글이 있어야 하고 URL 열이 어느 것인지 분명해야 한다.
  const headerLine = lines.find((l) => l.trim() !== '');
  if (headerLine === undefined) return { received: 0, records, rejected, source: { kind: 'csv', detail: { path: abs, bytes, empty: true } } };
  const header = splitCsvLine(headerLine);
  if (!header) fail('csv_header_unparsable', '머리글의 따옴표가 닫히지 않았습니다');
  const urlCol = header.findIndex((h) => URL_HEADERS.includes(h.toLowerCase()));
  if (urlCol === -1) {
    fail('csv_no_url_column', `머리글에 URL 열이 없습니다 (${URL_HEADERS.join('·')} 중 하나가 필요, 받은 머리글: ${header.join(', ').slice(0, 80)})`);
  }

  let received = 0;
  const start = lines.indexOf(headerLine) + 1;
  for (let i = start; i < lines.length; i++) {
    const raw = lines[i];
    if (raw.trim() === '') continue;
    received++;
    const cells = splitCsvLine(raw);
    if (!cells) { rejected.push({ line: i + 1, reason: '따옴표가 닫히지 않았습니다' }); continue; }
    if (cells.length !== header.length) { rejected.push({ line: i + 1, reason: `칸 수가 머리글과 다릅니다 (${cells.length} ≠ ${header.length})` }); continue; }
    const v = cells[urlCol];
    if (!v) { rejected.push({ line: i + 1, reason: 'URL 칸이 비었습니다' }); continue; }
    records.push({ url: v, line: i + 1 });
  }
  return { received, records, rejected, source: { kind: 'csv', detail: { path: abs, bytes, url_column: header[urlCol] } } };
}

/** 거절 사유를 대표 몇 가지로 줄인다. 응답에 원문을 통째로 싣지 않기 위해서다. */
export function summarizeRejections(rejected, topN = 5) {
  const byReason = new Map();
  for (const r of rejected) {
    const key = r.reason.replace(/\d+/g, 'N').slice(0, 60);
    const cur = byReason.get(key) ?? { reason: key, count: 0, first_line: r.line };
    cur.count++;
    byReason.set(key, cur);
  }
  return [...byReason.values()].sort((a, b) => b.count - a.count).slice(0, topN);
}
