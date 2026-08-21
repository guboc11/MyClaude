#!/usr/bin/env node
// notepad-mcp — 무의존성 MCP stdio 서버 (사람용 메모장)
//
// 설계 원천: .claude/tools/notepad-mcp/DESIGN.md
//
// 절대 원칙 (DESIGN §2 — 어기면 이 도구의 존재 이유가 무너진다):
//   1. 제목·키워드·태그를 만들지 않는다. 에이전트가 채우는 메타는 context 하나뿐.
//      (제목은 "이 메모는 무엇에 관한 것이다"라는 의미 주장이라, 사용자 말 위에 해석을 덮어쓴다)
//   2. 표시 없는 텍스트는 절대 클로드가 쓴 것이 아니다. 클로드가 쓴 덩어리엔 반드시 구분선.
//   3. 발췌를 복사하지 않는다. transcript + lines 참조만 둔다.
//   4. 삭제 없음. 수정·삭제 도구를 만들지 않는다 (md 파일이라 사람이 직접 고친다).
//      note_append 는 붙이기지 고치기가 아니다 — 이미 적힌 줄에는 손대지 못한다.
//   5. 구분선은 ASCII 하이픈 20개. 박스 문자(─)·## 헤딩 금지 (사람이 직접 칠 수 있어야 한다).
//
// 저장 (둘 다 gitignore 대상):
//   날짜 노트  {repo}/.claude/mcp-notepad/{YYYY-MM}/{YYYY-MM-DD-HHMM}.md   그 순간을 찍고 끝난다
//   주제 노트  {repo}/.claude/mcp-notepad/{YYYY-MM-DD}-{주제}.md            줄이 계속 쌓인다 (루트, 하위 폴더 없음)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const log = (...a) => process.stderr.write(`[notepad-mcp] ${a.join(' ')}\n`);

// 구분선: 하이픈 20개. 사용자가 직접 편집할 때 키보드로 칠 수 있어야 한다.
const BAR = '-'.repeat(20);

// frontmatter 네 칸 고정. 값이 비어도 칸은 사라지지 않는다 (DESIGN §3-2).
const META_KEYS = ['created', 'context', 'transcript', 'lines'];

// ── 경로 ──────────────────────────────────────────────────────

function root() {
  return process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

const P = {
  notepad: () => path.join(root(), '.claude', 'mcp-notepad'),
  month: (ym) => path.join(P.notepad(), ym),
  // 주제 노트는 월 폴더에 들어가지 않고 notepad 루트에 바로 놓인다.
  topic: (name) => path.join(P.notepad(), `${name}.md`),
  projects: () => path.join(os.homedir(), '.claude', 'projects'),
};

// ── 시각·파일명 ───────────────────────────────────────────────

const pad = (n) => String(n).padStart(2, '0');

// 2026-07-28 15:44 → { ym: '2026-07', id: '2026-07-28-1544', created: '2026-07-28 15:44' }
function stamp(d = new Date()) {
  const ym = `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
  const day = `${ym}-${pad(d.getDate())}`;
  return {
    ym,
    id: `${day}-${pad(d.getHours())}${pad(d.getMinutes())}`,
    created: `${day} ${pad(d.getHours())}:${pad(d.getMinutes())}`,
  };
}

// 날짜 노트의 id 는 곧 시각이다: 2026-07-28-1544. 같은 분에 두 장이면 뒤에 -2, -3 이 붙는다.
// 여기에 안 맞으면 주제 노트({만든 날}-{주제})로 본다.
const DATE_NOTE_RE = /^\d{4}-\d{2}-\d{2}-\d{3,4}(-\d+)?$/;

function isDateNoteId(id) {
  return DATE_NOTE_RE.test(String(id));
}

// 주제 이름에서 막을 것: 경로 구분자·제어문자·파일명에 못 쓰는 글자.
// 조용히 고쳐서 만들지 않는다 — 부른 이름과 다른 파일이 생기는 쪽이 더 나쁘다.
// 그래서 앞뒤 공백도 지워주지 않고 튕긴다. 이름 안의 공백은 그대로 쓴다.
const TOPIC_BAD_RE = /[\\/:*?"<>|\x00-\x1f\x7f]/;

function safeTopic(topic) {
  const t = String(topic ?? '');
  if (!t) throw new Error('주제 이름이 비어 있습니다.');
  if (t !== t.trim()) throw new Error(`주제 이름 앞뒤에 공백이 있습니다: "${topic}"`);
  if (TOPIC_BAD_RE.test(t)) throw new Error(`주제 이름에 쓸 수 없는 글자가 있습니다: ${topic}`);
  if (t.includes('..')) throw new Error(`주제 이름에 상위 이동이 있습니다: ${topic}`);
  if (t.startsWith('.')) throw new Error(`주제 이름은 점으로 시작할 수 없습니다: ${topic}`);
  return t;
}

// 주제 노트의 실제 경로. 이름 방어를 뚫더라도 여기서 막힌다 —
// 계산된 경로는 반드시 notepad 루트의 바로 아래여야 한다.
// 읽기(note_read·note_source)도 이 문을 지나게 해서 루트 밖을 직접 열 수 없게 한다.
function topicFileOf(name) {
  const p = P.topic(safeTopic(name));
  if (path.dirname(path.resolve(p)) !== path.resolve(P.notepad())) {
    throw new Error(`주제 노트는 notepad 루트에만 있습니다: ${name}`);
  }
  return p;
}

// 날짜 노트는 월 폴더 안에, 주제 노트는 notepad 루트에 있다.
function notePathOf(id) {
  const s = String(id);
  return isDateNoteId(s) ? path.join(P.month(s.slice(0, 7)), `${s}.md`) : topicFileOf(s);
}

// {오늘}-{주제}. 날짜는 서버가 붙인다 — 만든 날로 고정이고 이후 갱신돼도 바뀌지 않는다.
// 시각은 한 번만 찍어 id 와 created 가 같은 스냅샷에서 나오게 한다.
// 두 번 부르면 자정을 사이에 두고 파일명 날짜와 created 날짜가 어긋난다.
function topicPathOf(topic, s = stamp()) {
  const id = `${s.id.slice(0, 10)}-${safeTopic(topic)}`;
  return { id, path: topicFileOf(id), created: s.created };
}

// 같은 분에 두 장이 생기면 -2, -3 … 을 붙여 충돌을 피한다.
function freshNote(d = new Date()) {
  const { ym, id, created } = stamp(d);
  fs.mkdirSync(P.month(ym), { recursive: true });
  let finalId = id;
  for (let n = 2; fs.existsSync(notePathOf(finalId)); n++) finalId = `${id}-${n}`;
  return { id: finalId, path: notePathOf(finalId), created, ym };
}

// ── frontmatter 직렬화 / 파싱 ─────────────────────────────────

// 본문은 그대로 쓴다. 끝 개행 하나만 보장할 뿐, 내용을 다듬지 않는다
// (원칙 2 — 사용자 말도 대화 인용도 한 글자 고치지 않는다).
function serializeNote(meta, body) {
  const head = META_KEYS.map((k) => `${k}: ${meta?.[k] ?? ''}`).join('\n');
  let b = String(body ?? '');
  if (b && !b.endsWith('\n')) b += '\n';
  return `---\n${head}\n---\n\n${b}`;
}

// 사람이 손으로 고친 파일도 읽는다. frontmatter가 깨져 있어도 죽지 않고 본문이라도 돌려준다.
// YAML 라이브러리를 쓰지 않는다(의존성 0) — `키: 값` 단순 파싱으로 충분하다.
function parseNote(text) {
  const meta = Object.fromEntries(META_KEYS.map((k) => [k, '']));
  let body = String(text ?? '');
  if (body.startsWith('---\n')) {
    const end = body.indexOf('\n---', 3);
    if (end !== -1) {
      for (const line of body.slice(4, end).split('\n')) {
        const i = line.indexOf(':');
        if (i === -1) continue;
        const k = line.slice(0, i).trim();
        if (META_KEYS.includes(k)) meta[k] = line.slice(i + 1).trim();
      }
      body = body
        .slice(end + 4)
        .replace(/^[^\n]*\n/, '')  // 닫는 구분자 줄의 나머지
        .replace(/^\n/, '');       // 본문 앞 빈 줄 '하나만' (더 지우면 본문이 깎인다)
    }
  }
  return { meta, body };
}

// ── 대화 기록(transcript) 위치 ────────────────────────────────

// 실측 확정 (표본 20/20 일치): cwd의 영숫자 아닌 모든 문자를 '-'로 바꾼다.
// '/'만 바꾸는 규칙은 경로에 '.'이 있으면 틀린다 (.claude/worktrees/… 사례 5건).
function projectSlug(dir) {
  return String(dir).replace(/[^a-zA-Z0-9]/g, '-');
}

function firstCwd(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(65536);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    for (const line of buf.slice(0, n).toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      try { const o = JSON.parse(line); if (o.cwd) return o.cwd; } catch { /* 잘린 줄 */ }
    }
  } catch { /* 못 읽으면 없는 것으로 */ }
  return null;
}

// 슬러그로 먼저 찾고(빠른 길), 없으면 cwd 필드로 실제 폴더를 뒤진다(안전망).
function transcriptDir() {
  const bySlug = path.join(P.projects(), projectSlug(root()));
  if (fs.existsSync(bySlug)) return bySlug;
  const base = P.projects();
  if (!fs.existsSync(base)) return null;
  for (const d of fs.readdirSync(base)) {
    const full = path.join(base, d);
    try {
      if (!fs.statSync(full).isDirectory()) continue;
      for (const f of fs.readdirSync(full)) {
        if (f.endsWith('.jsonl') && firstCwd(path.join(full, f)) === root()) return full;
      }
    } catch { /* 접근 불가 폴더는 건너뛴다 */ }
  }
  return null;
}

// 현재 세션 = CLAUDE_CODE_SESSION_ID 가 가리키는 파일. 그 외 방법을 쓰지 않는다.
//
// 처음엔 "가장 최근 수정된 jsonl"로 추정했다가 실측에서 깨졌다 — 패널 여러 개가 동시에 도는 것이
// 정상 운영 형태라, 남이 방금 쓴 파일이 잡힌다. 남의 대화를 가리키는 메모는 note_source 를 통째로
// 망가뜨리므로(발췌 대신 참조라는 설계의 뿌리), 추정 폴백을 두지 않는다.
// 세션 ID를 못 얻으면 transcript·lines 를 비운다. 빈 칸은 정직하지만 틀린 참조는 오염이다.
function currentTranscript() {
  const sid = process.env.CLAUDE_CODE_SESSION_ID;
  if (!sid) return null;
  const dir = transcriptDir();
  if (!dir) return null;
  const p = path.join(dir, `${sid}.jsonl`);
  return fs.existsSync(p) ? p : null;
}

// 시스템이 끼워 넣은 덩어리는 대화가 아니다.
function stripNoise(s) {
  return String(s ?? '')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<local-command-[^>]*>[\s\S]*?<\/local-command-[^>]*>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// 남길 것: text 블록은 그대로, tool_use 는 한 줄로 축약. 그 외(thinking·tool_result)는 자리도 남기지 않는다.
// 빈 text 블록도 버리지 않고 그대로 이어 붙인다 — 검증된 파서(parse_test5.py)와 한 글자도 어긋나면
// fixture 대조가 깨지므로 동작을 정확히 맞춘다.
function textOf(content, includeThinking = false) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const out = [];
  for (const b of content) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'text') out.push(b.text || '');
    else if (b.type === 'tool_use') out.push(`[도구: ${b.name}]`);
    else if (includeThinking && b.type === 'thinking') out.push(b.thinking || '');
  }
  return out.join('\n');
}

// jsonl 한 줄은 발언이 아니라 '사건'이다 (attachment·mode·system·file-history-snapshot·thinking 등).
// 뒤에서부터 훑어 사람이 실제로 말한 마지막 줄을 짚는다. 1부터 세는 줄 번호를 돌려준다.
function lastUserLine(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const s = lines[i].trim();
    if (!s) continue;
    let o;
    try { o = JSON.parse(s); } catch { continue; }
    if (o.isSidechain || o.type !== 'user') continue;
    const c = o.message?.content;
    if (Array.isArray(c) && c.every((b) => b?.type === 'tool_result')) continue;
    if (!stripNoise(textOf(c))) continue;
    return i + 1;
  }
  return null;
}

// created·transcript·lines는 서버가 채운다 (DESIGN §5-1).
// 에이전트는 지금 몇 번째 줄인지 모르고, 알아내려면 대화 파일을 읽어야 해서 비싸다.
function sessionInfo() {
  const file = currentTranscript();
  if (!file) {
    log('세션 대화 파일을 찾지 못했습니다 (CLAUDE_CODE_SESSION_ID 없음). transcript·lines를 비웁니다.');
    return { transcript: '', lines: '' };
  }
  const n = lastUserLine(file);
  return { transcript: path.basename(file), lines: n == null ? '' : String(n) };
}

// ── 대화 렌더링 ───────────────────────────────────────────────

// 줄 범위를 사람이 읽는 대화로 되살린다. 걸러내는 것:
//   서브에이전트(isSidechain) / user·assistant 아닌 사건줄(attachment·mode·system·snapshot 등)
//   / 도구 결과만 든 user 메시지 / system-reminder·local-command 삽입물 / 알맹이가 빈 줄
function renderConversation(file, from, to, includeThinking = false) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const out = [];
  let users = 0;
  let claudes = 0;
  for (let i = from; i <= to && i <= lines.length; i++) {
    const s = lines[i - 1];
    if (!s || !s.trim()) continue;
    let o;
    try { o = JSON.parse(s); } catch { continue; }
    if (o.isSidechain) continue;
    if (o.type !== 'user' && o.type !== 'assistant') continue;
    const c = o.message?.content;
    if (o.type === 'user' && Array.isArray(c)
      && c.every((b) => b && typeof b === 'object' && b.type === 'tool_result')) continue;
    const body = stripNoise(textOf(c, includeThinking));
    if (!body) continue;
    const who = o.type === 'user' ? '사용자' : '클로드';
    if (o.type === 'user') users++; else claudes++;
    out.push(`${BAR} ${who} (${i}줄) ${BAR}\n${body}\n\n`);
  }
  return { text: out.join(''), users, claudes };
}

// ── 도구 ──────────────────────────────────────────────────────

function relPath(p) {
  return p.startsWith(root() + '/') ? p.slice(root().length + 1) : p;
}

// 사용자가 준 텍스트를 그대로 저장한다. 제목·요약·키워드를 붙이지 않는다.
function toolNoteAdd(a) {
  const { id, path: p, created } = freshNote();
  const s = sessionInfo();
  const meta = { created, context: a.context || '', transcript: s.transcript, lines: s.lines };

  let body = String(a.body ?? '');
  if (a.agent_note) {
    const block = `${BAR} 클로드 해석 ${BAR}\n${String(a.agent_note).trim()}`;
    body = body.trim() ? `${body.replace(/\s+$/, '')}\n\n${block}` : block;
  }

  fs.writeFileSync(p, serializeNote(meta, body));
  if (!body) return `빈 메모를 만들었습니다 — ${relPath(p)}\n열어서 쓰시면 됩니다.`;
  return `적었습니다 — ${id}\n${relPath(p)}`;
}

// 줄 범위를 받아 대화를 파싱해 저장한다. 에이전트가 하는 판단은 '범위' 하나뿐이다.
function toolNoteAddConversation(a) {
  const from = Number(a.from);
  const to = Number(a.to);
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from) {
    throw new Error(`줄 범위가 올바르지 않습니다: from=${a.from} to=${a.to}`);
  }
  const file = currentTranscript();
  if (!file) throw new Error('현재 세션의 대화 파일을 찾지 못했습니다 (CLAUDE_CODE_SESSION_ID 없음).');

  const { text, users, claudes } = renderConversation(file, from, to, !!a.include_thinking);
  if (!text) throw new Error(`${from}-${to}줄에 사람이 읽는 대화가 없습니다. 범위를 확인하세요.`);

  const { id, path: p, created } = freshNote();
  const meta = { created, context: a.context || '', transcript: path.basename(file), lines: `${from}-${to}` };
  fs.writeFileSync(p, serializeNote(meta, text));
  return `적었습니다 — ${id} (사용자 ${users} · 클로드 ${claudes})\n${relPath(p)}`;
}

// 주제 노트를 새로 만든다. 날짜 노트와 달리 이름이 곧 정체라 같은 이름 둘이 생기면 안 된다.
function toolNoteNewTopic(a) {
  // id 와 created 를 같은 스냅샷에서 받는다 — 자정을 넘어도 둘이 어긋나지 않는다.
  const { id, path: p, created } = topicPathOf(a.topic);
  const s = sessionInfo();
  const meta = { created, context: a.context || '', transcript: s.transcript, lines: s.lines };
  try {
    // wx = 이미 있으면 실패. 같은 순간에 둘이 불러도 덮어쓰지 않고,
    // 그 자리에 symlink 가 놓여 있어도 EEXIST 로 튕긴다.
    fs.writeFileSync(p, serializeNote(meta, String(a.body ?? '')), { flag: 'wx' });
  } catch (e) {
    if (e.code === 'EEXIST') throw new Error(`이미 있는 주제 노트입니다: ${id}`);
    throw e;
  }
  return `만들었습니다 — ${id}\n${relPath(p)}`;
}

// 주제 노트 끝에 잇는다. 고치는 게 아니라 붙이는 것이다.
function toolNoteAppend(a) {
  const id = String(a.id ?? '').trim();
  if (!id) throw new Error('주제 노트 id 가 없습니다.');
  // 날짜 노트는 그 순간을 찍고 끝나는 것이라 나중에 덧붙이지 않는다.
  if (isDateNoteId(id)) throw new Error(`날짜 노트에는 덧붙이지 않습니다: ${id}`);

  const body = String(a.body ?? '');
  if (!body.trim()) throw new Error('붙일 내용이 없습니다.');
  // 이 도구는 한 줄만 붙인다. 줄바꿈이 들었으면 조용히 걷어내지 않고 튕긴다 —
  // body 를 받은 그대로 넣는다는 계약과, 시각을 줄 끝에 앉힌다는 형태를 둘 다 지키려면 여기서 갈라야 한다.
  if (/[\r\n]/.test(body)) {
    throw new Error('note_append 는 한 줄만 붙입니다. 줄바꿈이 든 내용은 받지 않습니다.');
  }

  const p = topicFileOf(id);
  // lstat 으로 본다 — symlink 를 따라가면 notepad 밖 파일에 덧붙게 된다.
  const st = fs.lstatSync(p, { throwIfNoEntry: false });
  if (!st) {
    throw new Error(`그런 주제 노트가 없습니다: ${id} — 새 주제는 note_new_topic 으로 만듭니다.`);
  }
  if (!st.isFile()) {
    throw new Error(`주제 노트가 아닙니다(심볼릭 링크이거나 일반 파일이 아님): ${id}`);
  }

  // 파싱해서 다시 쓰지 않는다. frontmatter 와 기존 본문의 바이트를 그대로 두고 끝에만 잇는다.
  const prev = fs.readFileSync(p, 'utf8');
  const lead = prev.length && !prev.endsWith('\n') ? '\n' : '';
  const when = stamp().created.slice(5); // '2026-08-05 09:20' → '08-05 09:20'
  fs.appendFileSync(p, `${lead}${body}  (${when})\n`);
  return `붙였습니다 — ${id}`;
}

// ── 꺼내기 ────────────────────────────────────────────────────

// 대화 메모의 첫 줄은 구분선이라 목록에 그대로 띄우면 무엇인지 알아볼 수 없다.
// 구분선을 건너뛰고 첫 실제 발언을 보여준다.
const SEP_RE = /^-{10,}\s.*\s-{10,}$/;

function firstMeaningfulLine(body) {
  for (const l of String(body).split('\n')) {
    const t = l.trim();
    if (!t || SEP_RE.test(t)) continue;
    return t;
  }
  return '(빈 메모)';
}

function cut(s, n) {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

// 파일을 읽을 때마다 새로 읽는다. 캐시하지 않는다 — 사람이 손으로 고친 것이 즉시 보여야 한다.
function readNote(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const { meta, body } = parseNote(raw);
  return { id: path.basename(file, '.md'), file, raw, meta, body };
}

// 훑을 때는 언제나 lstat 으로 본다. stat 은 링크를 따라가서, notepad 안에 걸린 symlink 하나로
// 바깥 파일이 목록·검색·읽기에 그대로 새어나온다. 링크와 비정규 파일은 조용히 건너뛴다.
function isRealFile(p) {
  const st = fs.lstatSync(p, { throwIfNoEntry: false });
  return !!st && st.isFile();
}

function isRealDir(p) {
  const st = fs.lstatSync(p, { throwIfNoEntry: false });
  return !!st && st.isDirectory();
}

function allNotes(month) {
  const base = P.notepad();
  if (!fs.existsSync(base)) return [];
  // 월 폴더도 실제 디렉터리만 — symlink 월 폴더를 따라가지 않는다.
  const months = (month ? [month] : fs.readdirSync(base)).filter((m) => isRealDir(P.month(m)));
  const out = [];
  for (const m of months) {
    for (const f of fs.readdirSync(P.month(m))) {
      if (!f.endsWith('.md')) continue;
      const full = path.join(P.month(m), f);
      if (isRealFile(full)) out.push(readNote(full));
    }
  }
  // 주제 노트는 루트에 바로 놓이므로 월 폴더만 훑으면 통째로 놓친다.
  // 월을 지정해도 주제 노트는 그대로 나온다 — 월 필터는 날짜 노트에만 걸리는 것이다.
  for (const f of fs.readdirSync(base)) {
    if (!f.endsWith('.md')) continue;
    const full = path.join(base, f);
    if (isRealFile(full)) out.push(readNote(full));
  }
  // 파일명이 곧 시각이라 이름 역순이 최근순이다.
  return out.sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

// 목록 한 건 = id(=시각) · context · 본문 첫 줄. 제목 자리에 사용자 말이 들어가는 셈이다.
// 에이전트가 요약하지 않는다 — 원문 첫 줄을 그대로 가져올 뿐이다.
function renderList(notes) {
  if (!notes.length) return '노트가 없습니다.';
  return notes
    // 같은 분 충돌로 id에 -2·-3이 붙으면 길이가 달라지므로 들여쓰기를 id 길이에 맞춘다.
    .map((n) => `${n.id}  ${cut(n.meta.context || '(정황 없음)', 60)}\n${' '.repeat(n.id.length + 2)}${cut(firstMeaningfulLine(n.body), 60)}`)
    .join('\n\n');
}

function findNote(id) {
  // notePathOf 가 이름·경로 검증(topicFileOf)을 이미 지난다. 여기서는 그 자리에 실제 파일이
  // 있는지만 lstat 으로 본다 — 있더라도 링크면 따라가지 않고 튕긴다.
  const direct = notePathOf(String(id));
  const st = fs.lstatSync(direct, { throwIfNoEntry: false });
  // lstat 은 마지막 조각만 본다. 담긴 폴더(월 폴더 또는 notepad 루트)도 실제 디렉터리인지 봐야
  // symlink 월 폴더를 지나 바깥 파일을 읽는 길이 막힌다.
  if (st && st.isFile() && isRealDir(path.dirname(direct))) return direct;
  if (st) throw new Error(`메모가 아닙니다(심볼릭 링크이거나 일반 파일이 아님): ${id}`);
  const hit = allNotes().find((n) => n.id === String(id));
  if (!hit) throw new Error(`그런 메모가 없습니다: ${id}`);
  return hit.file;
}

// 목록은 두 묶음으로 나눈다 — 주제 노트가 위, 날짜 노트가 아래.
// 한 덩어리로 두면 같은 날 주제 노트가 날짜 노트 위로 섞여 올라간다(한글이 숫자보다 뒤라서).
// allNotes 가 이미 id 역순으로 정렬해 주므로 나누기만 하면 묶음 안의 최근순은 그대로 유지된다.
function splitByKind(notes) {
  const topics = [];
  const dates = [];
  for (const n of notes) (isDateNoteId(n.id) ? dates : topics).push(n);
  return { topics, dates };
}

function toolNoteList(a) {
  const limit = Number.isInteger(a.limit) && a.limit > 0 ? a.limit : 20;
  const { topics, dates } = splitByKind(allNotes(a.month));
  if (!topics.length && !dates.length) return '노트가 없습니다.';

  // 주제 노트는 수가 적고 계속 자라는 장이라 전량 보여준다. limit 은 날짜 노트에만 건다.
  const shownDates = dates.slice(0, limit);
  const blocks = [];
  if (topics.length) blocks.push(`■ 주제 노트\n\n${renderList(topics)}`);
  if (dates.length) blocks.push(`■ 날짜 노트\n\n${renderList(shownDates)}`);
  const tail = dates.length > shownDates.length
    ? `\n\n(날짜 노트 전체 ${dates.length}장 중 ${shownDates.length}장)`
    : '';
  return blocks.join('\n\n') + tail;
}

function toolNoteRead(a) {
  const n = readNote(findNote(a.id));
  return `${relPath(n.file)}\n\n${n.raw}`;
}

// 억지 키워드를 만들지 않는 근거가 이것이다 — 본문과 원본이 곧 검색 대상이다.
function toolNoteSearch(a) {
  const q = String(a.query || '').trim();
  if (!q) throw new Error('찾을 낱말이 없습니다.');
  const limit = Number.isInteger(a.limit) && a.limit > 0 ? a.limit : 20;
  const needle = q.toLowerCase();

  const hits = allNotes().filter(
    (n) => n.body.toLowerCase().includes(needle) || (n.meta.context || '').toLowerCase().includes(needle),
  );
  // 검색은 목록과 달리 묶지 않는다 — 찾은 것을 적중 순서대로 늘어놓는 자리라 나누면 오히려 헤맨다.
  // 다만 적중이 limit 을 넘으면 머리글 숫자와 실제 표시 수가 어긋나므로 둘 다 적는다.
  const shown = hits.slice(0, limit);
  let out = hits.length
    ? `메모 ${hits.length}건${hits.length > shown.length ? ` 중 ${shown.length}건` : ''}\n\n${renderList(shown)}`
    : `메모에서 "${q}" 를 찾지 못했습니다.`;

  if (!a.deep) return out;

  // 대화 기록까지 훑는다. 히트한 파일·줄을 알려주어 그대로 note_add_conversation 으로 메모할 수 있게 한다.
  const dir = transcriptDir();
  const found = [];
  if (dir) {
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.jsonl'))) {
      const lines = fs.readFileSync(path.join(dir, f), 'utf8').split('\n');
      for (let i = 0; i < lines.length && found.length < limit; i++) {
        if (!lines[i] || !lines[i].toLowerCase().includes(needle)) continue;
        let o;
        try { o = JSON.parse(lines[i]); } catch { continue; }
        if (o.isSidechain || (o.type !== 'user' && o.type !== 'assistant')) continue;
        const body = stripNoise(textOf(o.message?.content));
        if (!body.toLowerCase().includes(needle)) continue;
        found.push(`  ${f} ${i + 1}줄  [${o.type === 'user' ? '사용자' : '클로드'}]  ${cut(body.replace(/\n/g, ' '), 70)}`);
      }
    }
  }
  out += found.length
    ? `\n\n─ 대화 기록 ${found.length}건 (note_add_conversation 으로 메모 가능) ─\n${found.join('\n')}`
    : `\n\n대화 기록에서도 찾지 못했습니다.`;
  return out;
}

// "대화 원문 찾아주는 버튼". 발췌를 복사하지 않고 참조로 둔 설계는 이 도구가 동작해야 성립한다.
function toolNoteSource(a) {
  const n = readNote(findNote(a.id));
  const { transcript, lines } = n.meta;
  if (!transcript || !lines) {
    return `${n.id} 에는 출처가 없습니다 (transcript=${JSON.stringify(transcript)} lines=${JSON.stringify(lines)}).`;
  }
  const dir = transcriptDir();
  const file = dir ? path.join(dir, transcript) : null;
  if (!file || !fs.existsSync(file)) {
    return `대화 파일을 찾을 수 없습니다: ${transcript}\n`
      + `보존 기간(cleanupPeriodDays)이 지났거나 다른 머신에서 만든 메모일 수 있습니다.`;
  }
  const m = String(lines).match(/^(\d+)(?:-(\d+))?$/);
  if (!m) return `lines 값을 읽을 수 없습니다: ${lines}`;

  const before = Number(a.before) > 0 ? Number(a.before) : 0;
  const after = Number(a.after) > 0 ? Number(a.after) : 0;
  const from = Math.max(1, Number(m[1]) - before);
  const to = Number(m[2] || m[1]) + after;

  const { text, users, claudes } = renderConversation(file, from, to, !!a.include_thinking);
  const head = `${transcript} ${from}-${to}줄  (사용자 ${users} · 클로드 ${claudes})`;
  return text ? `${head}\n\n${text}` : `${head}\n\n그 범위에 사람이 읽는 대화가 없습니다.`;
}

// ── JSON-RPC ──────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'note_add',
    description:
      '사용자가 준 텍스트를 노트에 그대로 적는다.\n'
      + '\n'
      + '[언제] "노트에 메모해줘", "이거 메모해줘", "노트에 적어줘" 라고 할 때.\n'
      + '[아닐 때] **"기억해줘" / "remember" 는 이 도구가 아니다** — 그것은 메모리 시스템(MEMORY.md) 담당이다.\n'
      + '  노트는 평소 컨텍스트를 차지하지 않고 부를 때만 꺼내는 곳이고, 메모리는 매 세션 상주하는 곳이다.\n'
      + '  "저장은 하고 싶은데 클로드가 계속 그 맥락에 사로잡히는 건 싫은 것" 이 노트의 자리다.\n'
      + '\n'
      + '[절대 규칙]\n'
      + '- **제목을 붙이지 않는다. 키워드·태그·요약을 만들지 않는다.** 그런 칸이 아예 없다.\n'
      + '  제목은 "이 메모는 무엇에 관한 것이다"라는 의미 주장이라, 사용자 말 위에 남의 해석을 덮어쓴다.\n'
      + '- body 는 사용자가 말한 그대로 넣는다. 다듬거나 요약하거나 맞춤법을 고치지 않는다.\n'
      + '- context 에는 **정황만** 적는다 — "notepad MCP 설계 대화 중" 처럼 언제 무슨 얘기 중이었는지.\n'
      + '  "무슨 뜻이다"를 적으면 안 된다. 정황은 사실이고 의미는 해석이다.\n'
      + '- agent_note 는 사용자가 **명시적으로 요청했을 때만** 채운다("네 정리도 붙여줘").\n'
      + '  요청이 없으면 비운다. 평가("좋은 생각이다")가 아니라 사실만 적는다.\n'
      + '  채우면 본문 아래 구분선을 달고 들어간다 — 표시 없는 텍스트는 절대 클로드가 쓴 것이 아니어야 한다.\n'
      + '\n'
      + '[동작] created·transcript·lines 는 서버가 채운다. 넘기지 않아도 된다.\n'
      + '  body 없이 부르면 빈 메모(빈 종이)가 만들어지고 경로만 돌아온다 — 사용자가 에디터로 직접 쓸 때.\n'
      + '\n'
      + '[저장 뒤] **영수증 한 줄만 말하고 대화를 이어간다.** 무엇을 적었는지 길게 요약하지 않는다.\n'
      + '  캡처가 대화 흐름을 끊으면 이 도구는 존재 이유를 잃는다.',
    inputSchema: {
      type: 'object',
      properties: {
        body: { type: 'string', description: '사용자가 준 텍스트. 그대로 넣는다. 없으면 빈 종이가 된다.' },
        context: { type: 'string', description: '"○○ 대화 중" 같은 정황 한 줄. 무슨 뜻인지가 아니라 언제 어디서였는지를 적는다.' },
        agent_note: { type: 'string', description: '사용자가 명시적으로 요청했을 때만 채운다. 평가가 아니라 사실만. 본문 아래 구분선을 달고 들어간다.' },
      },
    },
  },
  {
    name: 'note_add_conversation',
    description:
      '대화 줄 범위를 받아 원문을 파싱해 노트에 적는다.\n'
      + '\n'
      + '[언제] "지금까지 ○○ 얘기한 거 메모해줘" 처럼 오간 대화를 통째로 남길 때.\n'
      + '[아닐 때] 사용자가 텍스트를 직접 준 경우는 note_add 를 쓴다.\n'
      + '\n'
      + '[에이전트가 하는 판단은 범위 하나뿐이다]\n'
      + '  어디부터 어디까지 담을지만 정한다. 제목을 붙이거나 요약하는 일이 아니다.\n'
      + '  **누락보다 과잉** — 넉넉히 잡는다. 좁게 잡았어도 나중에 note_source 로 넓혀 읽을 수 있다.\n'
      + '  줄 번호는 note_search 의 deep 결과나 note_source 출력에서 얻는다.\n'
      + '\n'
      + '[동작] 서브에이전트 대화·도구 결과·시스템 삽입물은 걸러지고, 사람이 읽는 발언만\n'
      + '  "-------------------- 사용자 (381줄) --------------------" 형태로 정리된다.\n'
      + '  줄 번호를 다는 이유는 그 말이 실제로 오갔음을 되짚을 수 있어야 하기 때문이다\n'
      + '  (줄 번호 없는 덩어리 = 클로드가 새로 쓴 것).',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'integer', description: '시작 줄 번호(1부터).' },
        to: { type: 'integer', description: '끝 줄 번호(포함).' },
        context: { type: 'string', description: '"○○ 대화 중" 같은 정황 한 줄.' },
        include_thinking: { type: 'boolean', description: '클로드의 사고 과정까지 담을지. 기본 false.' },
      },
      required: ['from', 'to'],
    },
  },
  {
    name: 'note_new_topic',
    description:
      '주제 노트를 새로 만든다. 날짜 노트와 달리 한 주제로 줄이 계속 쌓이는 장이다.\n'
      + '\n'
      + '[언제] "○○ 리스트 만들자", "이건 따로 모아두자" 처럼 앞으로 계속 쌓일 자리가 필요할 때.\n'
      + '[아닐 때] 그 순간을 찍어두는 것은 note_add 다. 주제 노트는 나중에 note_append 로 이어 붙이는 자리다.\n'
      + '\n'
      + '[동작] 파일명은 서버가 {만든 날}-{주제}.md 로 짓고 notepad 루트에 둔다. 날짜를 직접 적지 않는다.\n'
      + '  이 날짜는 만든 날로 고정이다 — 나중에 줄이 붙어도 파일명은 바뀌지 않는다.\n'
      + '  같은 이름이 이미 있으면 만들지 않고 튕긴다. 이름이 곧 정체라 덮어쓰지도, 뒤에 번호를 붙이지도 않는다.\n'
      + '\n'
      + '[절대 규칙] note_add 와 같다 — 제목·요약·키워드를 만들지 않는다. body 와 context 는 받은 그대로 넣는다.\n'
      + '  주제 이름도 사용자가 부른 대로 쓴다. 한글·영문 자유.',
    inputSchema: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: '주제 이름. 날짜는 서버가 앞에 붙이므로 적지 않는다. 경로 구분자·제어문자는 쓸 수 없고, 앞뒤 공백이 있으면 튕긴다(이름 안의 공백은 쓸 수 있다).' },
        body: { type: 'string', description: '첫 내용. 그대로 넣는다. 없으면 빈 주제 노트가 된다.' },
        context: { type: 'string', description: '"○○ 대화 중" 같은 정황 한 줄.' },
      },
      required: ['topic'],
    },
  },
  {
    name: 'note_append',
    description:
      '주제 노트 끝에 한 줄 잇는다. 지금까지 없어서 파일을 직접 고쳐야 했던 자리다.\n'
      + '\n'
      + '[언제] 이미 있는 주제 노트에 항목을 더할 때. "그것도 리스트에 추가해".\n'
      + '[아닐 때] 새 주제는 note_new_topic 으로 만든다. 없는 id 를 주면 만들지 않고 튕긴다.\n'
      + '\n'
      + '[고치는 도구가 아니다] 붙이기만 한다. 기존 줄과 frontmatter 는 한 글자도 건드리지 않는다.\n'
      + '  날짜 노트에는 붙일 수 없다 — 그 순간을 찍고 끝난 것이라 뒤에 덧대지 않는다.\n'
      + '  이미 적힌 것을 고치거나 지우는 도구는 여전히 없다. 그건 사용자가 md 파일을 직접 연다.\n'
      + '\n'
      + '[한 줄짜리다] 한 번에 한 줄만 붙는다. 줄바꿈이 든 body 는 조용히 고치지 않고 튕긴다.\n'
      + '  여러 줄을 남기려면 한 줄씩 나눠 부른다.\n'
      + '\n'
      + '[동작] 붙는 줄 끝에 (MM-DD HH:MM) 으로 언제 들어왔는지 남는다. body 는 받은 그대로 넣는다.\n'
      + '\n'
      + '[저장 뒤] 영수증 한 줄만 말한다. 무엇을 붙였는지 길게 되풀이하지 않는다.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '주제 노트 id (예: 2026-08-05-표현교정). 날짜 노트 id 는 받지 않는다.' },
        body: { type: 'string', description: '붙일 텍스트 한 줄. 다듬지 않고 그대로 넣는다. 줄바꿈이 들어 있으면 튕긴다.' },
      },
      required: ['id', 'body'],
    },
  },
  {
    name: 'note_list',
    description:
      '노트를 최근순으로 훑는다. "노트 보여줘", "오늘 노트 꺼내줘" 일 때.\n'
      + '\n'
      + '한 건에 id(=시각) · 정황 · **본문 첫 줄**만 나온다. 제목이 없으므로 사용자 말 자체가 실마리다.\n'
      + '목록은 가볍게 두고 무거운 것은 골라서 펼친다(note_read / note_source). 이 두 걸음이 사용법이다.\n'
      + '\n'
      + '[꺼낸 뒤] 해석은 여기서 마음껏 한다 — 묶고 요약하고 판단해도 된다.\n'
      + '  다만 **그 해석을 파일에 저장하지 않는다.** 해석은 부를 때마다 새로 하는 것이고,\n'
      + '  파일에 박히면 나중에 다르게 볼 여지가 사라진다. 저장하려면 사용자가 명시적으로 요청해야 한다.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: '몇 장까지 볼지. 기본 20.' },
        month: { type: 'string', description: '"2026-07" 처럼 특정 달만 볼 때.' },
      },
    },
  },
  {
    name: 'note_read',
    description:
      '메모 한 장을 전문으로 읽는다. 목록에서 고른 것을 펼칠 때.\n'
      + '파일 경로도 같이 돌려주므로 사용자가 yazi·에디터로 바로 열 수 있다.\n'
      + '부를 때마다 파일을 새로 읽는다 — 사용자가 손으로 고친 내용이 즉시 반영된다.\n'
      + '(수정·삭제 도구는 없다. 그냥 md 파일이라 사용자가 직접 고치고, 한 번 적힌 것은 지우지 않는다.)',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: '메모 id (예: 2026-07-28-1544).' } },
      required: ['id'],
    },
  },
  {
    name: 'note_search',
    description:
      '노트를 낱말로 찾는다. "그때 ○○ 관련해서 뭐라고 했었지?" 일 때.\n'
      + '\n'
      + '결과가 note_list 와 **같은 형태**라, 목록에서 고르고 펼치는 두 걸음이 그대로 이어진다.\n'
      + 'deep 을 켜면 메모뿐 아니라 대화 기록 원본까지 훑는다 — 메모에 안 적힌 말도 찾을 수 있고,\n'
      + '히트한 파일·줄을 그대로 note_add_conversation 에 넘겨 뒤늦게 메모로 만들 수 있다.\n'
      + '\n'
      + '[키워드를 만들지 않는 이유] 본문과 대화 원본이 곧 검색 대상이다. 따로 키워드를 뽑아 쌓을 필요가 없고,\n'
      + '  넓게 깔면 검색이 노이즈가 되며 무엇보다 지어낸 해석이 파일에 박힌다.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '찾을 낱말.' },
        deep: { type: 'boolean', description: '대화 기록 원본까지 훑을지. 기본 false.' },
        limit: { type: 'integer', description: '최대 건수. 기본 20.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'note_source',
    description:
      '메모의 출처를 따라가 그때 대화를 되살린다. "원문 보여줘", "좀 더 위에서부터" 에 대응한다.\n'
      + '\n'
      + '메모에는 발췌를 **복사해 두지 않고** transcript·lines 참조만 둔다 — 사본은 잘라내는 순간 이미\n'
      + '한 번 가공된 것이지만 참조는 원본을 가리키기만 하기 때문이다. 그래서 원문은 이 도구로만 볼 수 있다.\n'
      + '\n'
      + 'before / after 를 키우면 앞뒤로 범위가 넓어진다. 사용자가 "더 위에서부터"라고 하면 before 를 키워 다시 부른다.\n'
      + '대화 기록이 보존 기간(cleanupPeriodDays)을 지나 사라졌거나 출처가 비어 있으면 그 사실을 알린다\n'
      + '— 조용히 빈 결과를 주지 않는다.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '메모 id.' },
        before: { type: 'integer', description: '앞으로 더 볼 줄 수. 기본 0.' },
        after: { type: 'integer', description: '뒤로 더 볼 줄 수. 기본 0.' },
        include_thinking: { type: 'boolean', description: '클로드의 사고 과정까지 볼지. 기본 false.' },
      },
      required: ['id'],
    },
  },
];

const DISPATCH = {
  note_add: toolNoteAdd,
  note_add_conversation: toolNoteAddConversation,
  note_new_topic: toolNoteNewTopic,
  note_append: toolNoteAppend,
  note_list: toolNoteList,
  note_read: toolNoteRead,
  note_search: toolNoteSearch,
  note_source: toolNoteSource,
};

function send(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }
function reply(id, result) { send({ jsonrpc: '2.0', id, result }); }
function replyErr(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }); }

function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    return reply(id, {
      protocolVersion: params?.protocolVersion || '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'notepad-mcp', version: '0.1.0' },
    });
  }
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return;
  if (method === 'ping') return reply(id, {});
  if (method === 'tools/list') return reply(id, { tools: TOOLS });
  if (method === 'tools/call') {
    const fn = DISPATCH[params?.name];
    if (!fn) return reply(id, { content: [{ type: 'text', text: `알 수 없는 도구: ${params?.name}` }], isError: true });
    return Promise.resolve()
      .then(() => fn(params.arguments || {}))
      .then((text) => reply(id, { content: [{ type: 'text', text }] }))
      .catch((e) => reply(id, { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true }));
  }
  if (id != null) return replyErr(id, -32601, `Method not found: ${method}`);
}

// 직접 실행할 때만 stdin을 문다. import 하면 함수만 쓸 수 있다(검증용).
const IS_MAIN = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (IS_MAIN) {
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
  log(`started. notepad=${P.notepad()}`);
}

export {
  BAR, META_KEYS, P, root, stamp, notePathOf, freshNote, isDateNoteId,
  serializeNote, parseNote,
  projectSlug, transcriptDir, currentTranscript, lastUserLine, sessionInfo,
  stripNoise, textOf, renderConversation,
  toolNoteAdd, toolNoteAddConversation, toolNoteNewTopic, toolNoteAppend,
  safeTopic, topicPathOf, topicFileOf,
};
