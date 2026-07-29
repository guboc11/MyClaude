#!/usr/bin/env node
// onboarding-mcp — 무의존성 MCP stdio 서버 (폴더 README 규칙의 조항 단위 조회)
//
// 문서 문법 (파서 계약):
//   - 문서의 첫 헤더            = 제목 (주소 없음, list에 문서명으로만 표시)
//   - `# definition`                  = 기본 섹션 (온보딩 진입점, 예약 주소 "definition")
//   - `# 1` `## 1-1` `### 1-1-1` = 번호 조항 (하이픈 계층 주소)
//   - 그 외 헤더(예: `## 시작하는 법`) = 부모 섹션의 본문 일부 (주소 없음)
//   - 섹션 범위 = 해당 헤더 ~ 다음 "같거나 얕은 급" 헤더 직전  → 부모 조회 = 서브트리 통째
//   - 코드 블록(``` ```) 안의 #은 헤더가 아님
//
// 동작 원칙: 조회 시점 실시간 파싱(캐시 없음) · 읽기 전용 · 로그는 stderr로.
// path 해석: 절대경로 그대로 / 상대경로는 CLAUDE_PROJECT_DIR > cwd 기준 / 폴더면 그 안의 README.md.

import fs from 'node:fs';
import path from 'node:path';

const log = (...a) => process.stderr.write(`[onboarding-mcp] ${a.join(' ')}\n`);

function projectDir() {
  return process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

// 관할 주제 자동 발견 — 프로젝트 루트의 `_*` 폴더 중 README.md를 가진 것.
// 등록 절차 없음: 폴더에 README를 만들면 그 순간 주제가 된다 (주제명 = 폴더명에서 `_` 제거).
function discoverTopics() {
  const root = projectDir();
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (!e.isDirectory() || !e.name.startsWith('_')) continue;
    const file = path.join(root, e.name, 'README.md');
    if (!fs.existsSync(file)) continue;
    let title = e.name;
    try { title = parseDoc(file).title; } catch { /* 파싱 실패해도 목록엔 노출 */ }
    out.push({ topic: e.name.replace(/^_+/, ''), folder: e.name, file, title });
  }
  return out.sort((a, b) => a.topic.localeCompare(b.topic));
}

// doc 인자 해석: ① 주제명("audit") ② 절대경로 ③ 상대경로(프로젝트 루트 기준). 폴더면 README.md.
function resolveDoc(p) {
  if (!p) throw new Error('doc이 필요합니다 — 주제명(예: "audit") 또는 경로. 주제 목록은 topics 도구로.');
  const topics = discoverTopics();
  const hit = topics.find((t) => t.topic === p);
  if (hit) return hit.file;
  let full = path.isAbsolute(p) ? p : path.join(projectDir(), p);
  if (fs.existsSync(full) && fs.statSync(full).isDirectory()) full = path.join(full, 'README.md');
  if (!fs.existsSync(full)) {
    const names = topics.map((t) => t.topic).join(', ') || '(없음)';
    throw new Error(`문서를 찾을 수 없음: ${full}\n등록된 주제: ${names}`);
  }
  return full;
}

// ── 파싱 ──────────────────────────────────────────────────────

// 반환: { title, lines, sections: [{ addr|null, level, title, start }] }
// sections는 주소가 있는 것(definition·번호)만 담는다. 제목·무주소 헤더는 범위 계산에만 쓰인다.
function parseDoc(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  let inFence = false;
  let title = null;
  const headers = []; // 모든 헤더 { level, text, line }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^```/.test(line.trim())) { inFence = !inFence; continue; }
    if (inFence) continue;
    const m = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    headers.push({ level: m[1].length, text: m[2], line: i });
  }
  const sections = [];
  for (let h = 0; h < headers.length; h++) {
    const { level, text, line } = headers[h];
    if (title === null) { title = text; continue; } // 첫 헤더 = 문서 제목
    let addr = null, name = text;
    if (text === 'definition') { addr = 'definition'; name = '(기본 섹션)'; }
    else {
      const nm = /^(\d+(?:-\d+)*)(?:\s+(.*))?$/.exec(text);
      if (nm) { addr = nm[1]; name = nm[2] || ''; }
    }
    if (addr === null) continue; // 무주소 헤더 → 부모 본문의 일부
    // 서브트리 끝 = 다음 "같거나 얕은 급" 헤더 (무주소 헤더도 급이 얕으면 경계가 된다)
    let end = lines.length;
    for (let k = h + 1; k < headers.length; k++) {
      if (headers[k].level <= level) { end = headers[k].line; break; }
    }
    sections.push({ addr, level, title: name, start: line, end });
  }
  return { title: title || path.basename(file), lines, sections };
}

// ── 도구 구현 ─────────────────────────────────────────────────

function fmtTree(doc) {
  const out = [`문서: ${doc.title}`];
  for (const s of doc.sections) {
    const depth = s.addr === 'definition' ? 0 : s.addr.split('-').length - 1;
    out.push(`${'  '.repeat(depth)}- ${s.addr}${s.title ? ` ${s.title}` : ''}`);
  }
  return out.join('\n');
}

function toolTopics() {
  const topics = discoverTopics();
  if (topics.length === 0) {
    return `관할 주제 없음 (프로젝트: ${projectDir()})\n프로젝트 루트의 _폴더에 README.md를 만들면 자동 등록된다.`;
  }
  const out = [`관할 주제 (프로젝트: ${projectDir()}):`];
  for (const t of topics) out.push(`- ${t.topic}  (${t.folder}/) — ${t.title}`);
  return out.join('\n');
}

function toolList({ doc: p }) {
  const doc = parseDoc(resolveDoc(p));
  if (doc.sections.length === 0) return `${doc.title}: 주소 있는 조항이 없습니다 (definition 또는 번호 헤더 필요)`;
  return fmtTree(doc);
}

function toolRead({ doc: p, ids }) {
  if (!Array.isArray(ids) || ids.length === 0) throw new Error('ids 배열이 필요합니다 (예: ["definition"] 또는 ["1-1","2-3"])');
  const file = resolveDoc(p);
  const doc = parseDoc(file);
  const blocks = [];
  const missing = [];
  for (const id of ids) {
    if (String(id) === 'all') { blocks.push(doc.lines.join('\n').trim()); continue; } // 예약 주소: 문서 전체
    const s = doc.sections.find((x) => x.addr === String(id));
    if (!s) { missing.push(String(id)); continue; }
    blocks.push(doc.lines.slice(s.start, s.end).join('\n').trim());
  }
  if (missing.length) {
    return `없는 주소: ${missing.join(', ')}\n\n이 문서의 목차:\n${fmtTree(doc)}`;
  }
  usageLog(file, ids);
  return blocks.join('\n\n---\n\n');
}

function toolSearch({ doc: p, query }) {
  if (!query || !String(query).trim()) throw new Error('query가 필요합니다');
  const doc = parseDoc(resolveDoc(p));
  const q = String(query).toLowerCase();
  // 각 줄이 속한 "가장 깊은 주소 섹션"을 찾는다
  const hits = new Map(); // addr -> { section, lines: [] }
  for (let i = 0; i < doc.lines.length; i++) {
    if (!doc.lines[i].toLowerCase().includes(q)) continue;
    let owner = null;
    for (const s of doc.sections) {
      if (s.start <= i && i < s.end && (!owner || s.start > owner.start)) owner = s;
    }
    if (!owner) continue;
    const rec = hits.get(owner.addr) || { section: owner, lines: [] };
    if (rec.lines.length < 3) rec.lines.push(doc.lines[i].trim());
    hits.set(owner.addr, rec);
  }
  if (hits.size === 0) return `"${query}" 매칭 없음.\n\n이 문서의 목차:\n${fmtTree(doc)}`;
  const out = [`"${query}" 매칭 조항:`];
  for (const { section, lines } of hits.values()) {
    out.push(`\n[${section.addr}] ${section.title}`);
    for (const l of lines) out.push(`  · ${l}`);
  }
  return out.join('\n');
}

function usageLog(file, ids) {
  try {
    const rec = { ts: new Date().toISOString(), doc: file, ids };
    fs.appendFileSync(new URL('./usage.jsonl', import.meta.url), JSON.stringify(rec) + '\n');
  } catch { /* 기록 실패는 무시 — 조회 기능에 영향 주지 않기 */ }
}

// ── MCP 배선 ──────────────────────────────────────────────────

const DOC_DESC =
  '주제명(예: "audit" — topics 도구로 목록 확인) 또는 경로(절대/상대, 폴더면 그 안의 README.md).';

const TOOLS = [
  {
    name: 'topics',
    description:
      '관할 주제 목록 — 프로젝트 루트의 `_` 폴더 중 README.md(규칙 문서)를 가진 것들. 주제명으로 list/search/read의 doc 인자를 채운다.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list',
    description: '규칙 문서의 조항 목차를 본다. 조항 주소(definition·번호)와 제목만 반환.',
    inputSchema: {
      type: 'object',
      properties: { doc: { type: 'string', description: DOC_DESC } },
      required: ['doc'],
    },
  },
  {
    name: 'read',
    description:
      '규칙 문서의 조항을 주소로 조회한다. "definition"=기본 섹션(온보딩 진입점), "all"=문서 전체. 부모 주소(예 "2")는 하위 조항·예시까지 통째로 반환. 복수 주소 가능.',
    inputSchema: {
      type: 'object',
      properties: {
        doc: { type: 'string', description: DOC_DESC },
        ids: { type: 'array', items: { type: 'string' }, description: '조항 주소 배열. 예: ["definition"], ["1-1","2-3"]' },
      },
      required: ['doc', 'ids'],
    },
  },
  {
    name: 'search',
    description: '규칙 문서에서 키워드로 조항 위치를 찾는다 (어느 조항에 있는지 모를 때). 매칭 조항 주소와 해당 줄을 반환.',
    inputSchema: {
      type: 'object',
      properties: {
        doc: { type: 'string', description: DOC_DESC },
        query: { type: 'string', description: '검색 키워드' },
      },
      required: ['doc', 'query'],
    },
  },
];

const DISPATCH = { topics: toolTopics, list: toolList, read: toolRead, search: toolSearch };

function send(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }
function reply(id, result) { send({ jsonrpc: '2.0', id, result }); }
function replyErr(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }); }

function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    return reply(id, {
      protocolVersion: params?.protocolVersion || '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'onboarding-mcp', version: '0.1.0' },
    });
  }
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return;
  if (method === 'ping') return reply(id, {});
  if (method === 'tools/list') return reply(id, { tools: TOOLS });
  if (method === 'tools/call') {
    const fn = DISPATCH[params?.name];
    if (!fn) return reply(id, { content: [{ type: 'text', text: `알 수 없는 도구: ${params?.name}` }], isError: true });
    try {
      const text = fn(params.arguments || {});
      return reply(id, { content: [{ type: 'text', text }] });
    } catch (e) {
      return reply(id, { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true });
    }
  }
  if (id != null) return replyErr(id, -32601, `Method not found: ${method}`);
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { log('parse fail:', line.slice(0, 120)); continue; }
    try { handle(msg); } catch (e) { log('handle error:', e.message); }
  }
});
process.stdin.on('end', () => process.exit(0));
log(`started. projectDir=${projectDir()}`);
