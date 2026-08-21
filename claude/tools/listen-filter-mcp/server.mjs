#!/usr/bin/env node
// listen-filter-mcp — 단방향 주입 파이프라인 (무의존성 MCP stdio 서버)
//
// 계획서: _PLAN/2026-08-01-listen-filter-mcp/PLAN.md
//
// 얼개: 사용자가 Listen 패널 여럿에 번갈아 쏟아붓는다 → Listen은 답하지 않고 받아 적는다
//       → batcher가 주기로 inbox를 잘라 배치를 찍는다 → Filter가 대기줄을 비울 때까지 벼린다
//       → 최종안 draft.md 한 편이 계속 좋아진다.
//
// 이 파일의 규율은 프롬프트가 아니라 **도구 모양**에 있다:
//   - Listen 쪽에는 읽는 수단이 없다 (draft도 남의 발화도 배치도 못 본다)
//   - Filter 쪽에는 inbox를 건드릴 수단이 없다 (얼린 배치만 본다)
//   - 어느 도구에도 삭제가 없다 — 이동만 있다 (inbox → queue → archive)
//
// 저장: <project>/.claude/listen/{주제}/
// project 경로: CLAUDE_PROJECT_DIR > process.cwd()
// stdout에는 JSON-RPC만, 로그는 stderr로.
//
// 실행본은 레포 사본 하나뿐이다 — 홈(~/.claude/tools/) 사본을 만들지 않는다.
// (2026-08-01 실측: notepad-mcp·task-mcp의 홈 사본이 레포본과 어긋나 사고가 났다)

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const DEFAULT_TOPIC = 'default';
const DEFAULT_INTERVAL_SEC = 300; // 5분 — 말의 호흡에 맞춘 기본값(계획서 §6 쟁점 1)
const TAKEN_STALE_MS = 30 * 60 * 1000; // 처리 중 표시가 이보다 오래되면 죽은 것으로 보고 다시 준다

const log = (...a) => process.stderr.write(`[listen-filter] ${a.join(' ')}\n`);

// ---- 경로 ----
function projectDir() {
  return process.env.CLAUDE_PROJECT_DIR || process.cwd();
}
function topicDir(topic) {
  return path.join(projectDir(), '.claude', 'mcp-listen-filter', safeName(topic || DEFAULT_TOPIC));
}
const inboxDir = (t) => path.join(topicDir(t), 'inbox');
const queueDir = (t) => path.join(topicDir(t), 'queue');
const archiveDir = (t) => path.join(topicDir(t), 'archive');
const historyDir = (t) => path.join(topicDir(t), 'draft.history');
const draftPath = (t) => path.join(topicDir(t), 'draft.md');
const ledgerPath = (t) => path.join(topicDir(t), 'ledger.md');
const batcherPath = (t) => path.join(topicDir(t), 'batcher.json');

function safeName(s) {
  return String(s ?? '').replace(/[\\/]/g, '').trim() || DEFAULT_TOPIC;
}
function ensureTopic(topic) {
  const t = safeName(topic || DEFAULT_TOPIC);
  for (const d of [inboxDir(t), queueDir(t), archiveDir(t), historyDir(t)]) {
    fs.mkdirSync(d, { recursive: true });
  }
  if (!fs.existsSync(draftPath(t))) fs.writeFileSync(draftPath(t), '');
  if (!fs.existsSync(ledgerPath(t))) {
    fs.writeFileSync(ledgerPath(t), `# ${t} — 판 이력\n\n판마다 한 줄: 어느 배치를 처리했나 / 무엇을 왜 바꿨나 / 뺀 것과 사유.\n\n`);
  }
  if (!fs.existsSync(batcherPath(t))) {
    fs.writeFileSync(batcherPath(t), JSON.stringify({ on: false, interval: DEFAULT_INTERVAL_SEC, lastCutAt: null }, null, 2) + '\n');
  }
  return t;
}

// ---- 시각 (KST 고정 — UTC로 찍혀 날짜가 어긋난 사고가 있었다) ----
function nowIso() { return new Date().toISOString(); }
function kst() {
  return new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' }); // "2026-08-02 01:23:45"
}
function fileStamp() {
  // 정렬 가능한 파일명용. 콜론은 파일명에 못 쓰므로 하이픈.
  return kst().replace(' ', 'T').replace(/:/g, '-');
}

// ---- 공용 ----
function readTextOr(p, fallback = '') {
  try { return fs.readFileSync(p, 'utf8'); } catch { return fallback; }
}
function readJsonOr(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}
function writeJson(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n');
}
function listFiles(d) {
  try { return fs.readdirSync(d).filter((f) => f.endsWith('.md')).sort(); } catch { return []; }
}
function listDirs(d) {
  try {
    return fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch { return []; }
}
function panelId() {
  const s = process.env.CMUX_SURFACE_ID || '';
  return s ? s.slice(0, 4).toLowerCase() : 'anon';
}

// ---- 배치 번호 (queue·archive 전부 훑어 최대값 +1 — 재시작해도 겹치지 않는다) ----
function nextBatchNo(t) {
  const all = [...listDirs(queueDir(t)), ...listDirs(archiveDir(t))];
  const max = all.reduce((m, n) => {
    const g = n.match(/^b-(\d+)$/);
    return g ? Math.max(m, Number(g[1])) : m;
  }, 0);
  return max + 1;
}
const batchName = (n) => `b-${String(n).padStart(3, '0')}`;

// 배치 폴더는 **먼저 만든 쪽이 그 번호를 가진다.**
// recursive 없이 mkdir하면 이미 있을 때 EEXIST로 튕기므로, 그게 곧 번호 선점 신호가 된다.
// (recursive:true는 이미 있어도 조용히 성공해서 두 프로세스가 같은 번호를 나눠 갖게 된다)
function makeBatchDir(t) {
  for (let i = 0; i < 50; i++) {
    const name = batchName(nextBatchNo(t));
    const dest = path.join(queueDir(t), name);
    try { fs.mkdirSync(dest); return { name, dest }; }
    catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
  throw new Error('배치 폴더를 만들지 못했습니다(번호 선점 경합이 계속됨).');
}

// ---- 자르는 권한은 한 프로세스만 ----
// 패널마다 자기 MCP 서버 프로세스를 띄우고, 서버가 뜰 때 batcher.json의 on:true를 보고
// 타이머를 건다. 그대로 두면 패널 4개 = 타이머 4개가 되어 5분 주기가 75초로 무너진다.
// 그래서 자를 때마다 잠금 파일로 권한을 확인한다 — 쥔 프로세스만 자르고, 그 프로세스가
// 사라지면(맥박이 끊기면) 다른 프로세스가 이어받는다.
const CUTTER_ID = `${process.pid}`;
const lockPath = (t) => path.join(topicDir(t), 'batcher.lock');
function claimCutter(t, interval) {
  const cur = readJsonOr(lockPath(t), null);
  const now = Date.now();
  const stale = !cur || (now - (cur.beat || 0)) > Math.max(interval * 2500, 30000);
  if (cur && cur.id !== CUTTER_ID && !stale) return false; // 남이 쥐고 있고 살아 있다
  writeJson(lockPath(t), { id: CUTTER_ID, beat: now, beatKst: kst() });
  return true;
}

// ---- 자르기: inbox 전량을 queue/b-00N 으로 이동 ----
// 급소 — 자르는 도중에 listen_add가 들어올 수 있다. 이동 대상을 **먼저 스냅샷으로 확정**하고
// 그 목록만 옮긴다. 스냅샷 이후 들어온 파일은 inbox에 남아 다음 배치로 간다. (계획서 G2)
function cut(t, how) {
  const snapshot = listFiles(inboxDir(t)); // ← 확정 시점
  if (snapshot.length === 0) return null;

  const { name, dest } = makeBatchDir(t);

  let moved = 0;
  for (const f of snapshot) {
    const from = path.join(inboxDir(t), f);
    if (!fs.existsSync(from)) continue; // 스냅샷 이후 사라졌으면 건너뜀
    fs.renameSync(from, path.join(dest, f));
    moved += 1;
  }
  writeJson(path.join(dest, 'meta.json'), {
    batch: name, cutAt: nowIso(), cutAtKst: kst(), how, count: moved,
  });

  const st = readJsonOr(batcherPath(t), { on: false, interval: DEFAULT_INTERVAL_SEC });
  st.lastCutAt = nowIso();
  writeJson(batcherPath(t), st);

  log(`cut ${name} (${moved}건, ${how})`);
  return { name, count: moved };
}

// ---- batcher 타이머 (주제별) ----
const timers = new Map();
function startTimer(t, interval) {
  stopTimer(t);
  const h = setInterval(() => {
    try {
      // 권한을 쥔 프로세스만 자른다. flush(사람이 부르는 즉시 절단)는 이 검사를 받지 않는다.
      if (!claimCutter(t, interval)) return;
      cut(t, 'timer');
    } catch (e) { log('timer cut fail:', e.message); }
  }, interval * 1000);
  if (typeof h.unref === 'function') h.unref();
  timers.set(t, h);
}
function stopTimer(t) {
  const h = timers.get(t);
  if (h) { clearInterval(h); timers.delete(t); }
}
// 서버가 죽었다 살아나면 켜져 있던 주제의 타이머를 되살린다.
function restoreTimers() {
  const root = path.join(projectDir(), '.claude', 'mcp-listen-filter');
  for (const t of listDirs(root)) {
    const st = readJsonOr(batcherPath(t), null);
    if (st?.on) {
      startTimer(t, st.interval || DEFAULT_INTERVAL_SEC);
      log(`batcher 복구: ${t} (${st.interval}s)`);
    }
  }
}

// ================= Listen =================

function toolListenAdd({ text, note, topic }) {
  if (!text || !String(text).trim()) throw new Error('text는 필수입니다.');
  const t = ensureTopic(topic);

  // 같은 초에 둘이 써도 이름이 겹치지 않게 한다.
  let base = `${fileStamp()}-${panelId()}`;
  let file = `${base}.md`;
  let n = 2;
  while (fs.existsSync(path.join(inboxDir(t), file))) file = `${base}-${n++}.md`;

  const body =
    `---\nts: ${nowIso()}\nkst: ${kst()}\npanel: ${panelId()}\ntopic: ${t}\n---\n\n` +
    `${text}\n` +
    (note && String(note).trim() ? `\n---\n\n## 조사\n\n${note}\n` : '');

  fs.writeFileSync(path.join(inboxDir(t), file), body);
  const cnt = listFiles(inboxDir(t)).length;
  return `적었습니다 — ${file} (inbox ${cnt}건)`;
}

function toolListenFlush({ topic }) {
  const t = ensureTopic(topic);
  const r = cut(t, 'flush');
  if (!r) return `inbox가 비어 있어 자르지 않았습니다. (대기줄 ${listDirs(queueDir(t)).length}개)`;
  return `잘랐습니다 — ${r.name} (${r.count}건). 대기줄 ${listDirs(queueDir(t)).length}개.`;
}

// ================= batcher =================

function toolBatcherOn({ interval, topic }) {
  const t = ensureTopic(topic);
  const sec = Number(interval) > 0 ? Math.floor(Number(interval)) : DEFAULT_INTERVAL_SEC;
  writeJson(batcherPath(t), { on: true, interval: sec, lastCutAt: readJsonOr(batcherPath(t), {}).lastCutAt ?? null });
  writeJson(lockPath(t), { id: CUTTER_ID, beat: Date.now(), beatKst: kst() }); // 켠 쪽이 자르는 권한을 갖는다
  startTimer(t, sec);
  return `batcher 켰습니다 — 주제 "${t}", ${sec}초마다 자릅니다. (빈 inbox면 자르지 않습니다)`;
}

function toolBatcherOff({ topic }) {
  const t = ensureTopic(topic);
  const st = readJsonOr(batcherPath(t), { interval: DEFAULT_INTERVAL_SEC });
  writeJson(batcherPath(t), { ...st, on: false });
  const lk = readJsonOr(lockPath(t), null);
  if (lk?.id === CUTTER_ID) writeJson(lockPath(t), { ...lk, beat: 0 }); // 권한 내려놓기(다음 켜는 쪽이 가져간다)
  stopTimer(t);
  return `batcher 껐습니다 — 주제 "${t}". 이미 잘린 배치는 그대로입니다. (대기줄 ${listDirs(queueDir(t)).length}개)`;
}

function toolBatcherStatus({ topic }) {
  const t = ensureTopic(topic);
  const st = readJsonOr(batcherPath(t), { on: false, interval: DEFAULT_INTERVAL_SEC, lastCutAt: null });
  const q = listDirs(queueDir(t));
  return [
    `주제: ${t}`,
    `batcher: ${st.on ? `켜짐 (${st.interval}초)` : '꺼짐'}`,
    `마지막 자른 시각: ${st.lastCutAt ?? '(없음)'}`,
    `inbox: ${listFiles(inboxDir(t)).length}건`,
    `대기줄: ${q.length}개${q.length ? ` — ${q.join(', ')}` : ''}`,
    `처리 끝난 배치: ${listDirs(archiveDir(t)).length}개`,
  ].join('\n');
}

// ================= Filter =================

function toolFilterNext({ topic }) {
  const t = ensureTopic(topic);
  const q = listDirs(queueDir(t));
  if (q.length === 0) return '대기줄이 비었습니다. 새 배치가 생길 때까지 쉬면 됩니다.';

  // 가장 오래된 것부터. 이미 처리 중이면 건너뛰되, 오래된 표시는 죽은 것으로 보고 다시 준다.
  let pick = null;
  for (const name of q) {
    const metaP = path.join(queueDir(t), name, 'meta.json');
    const meta = readJsonOr(metaP, {});
    if (!meta.takenAt) { pick = { name, meta, metaP }; break; }
    if (Date.now() - new Date(meta.takenAt).getTime() > TAKEN_STALE_MS) { pick = { name, meta, metaP }; break; }
  }
  if (!pick) return `대기줄 ${q.length}개가 전부 처리 중입니다 (${q.join(', ')}). 잠시 뒤 다시 부르세요.`;

  pick.meta.takenAt = nowIso();
  pick.meta.takenBy = panelId();
  writeJson(pick.metaP, pick.meta);

  const files = listFiles(path.join(queueDir(t), pick.name));
  const utter = files.map((f, i) =>
    `### [${i + 1}] ${f}\n\n${readTextOr(path.join(queueDir(t), pick.name, f))}`).join('\n\n---\n\n');

  const draft = readTextOr(draftPath(t));
  const ledgerTail = readTextOr(ledgerPath(t)).split('\n').filter((l) => l.startsWith('- ')).slice(-5).join('\n');

  return [
    `# 배치 ${pick.name} — 발화 ${files.length}건`,
    ``,
    `> 이 배치만 본다. inbox는 볼 수 없다(얼리기 전 것은 건드리지 않는다).`,
    `> 벼린 뒤 filter_write(draft, changelog, batch:"${pick.name}") → filter_done(batch:"${pick.name}").`,
    ``,
    utter,
    ``,
    `---`,
    ``,
    `## 지금 draft.md ${draft.trim() ? '' : '(아직 비어 있음 — 이번이 첫 판)'}`,
    ``,
    draft.trim() ? draft : '(빈 문서)',
    ``,
    `---`,
    ``,
    `## 최근 판 이력`,
    ``,
    ledgerTail || '(아직 없음)',
  ].join('\n');
}

function toolFilterWrite({ draft, changelog, batch, topic }) {
  if (draft == null || !String(draft).trim()) throw new Error('draft(새 본문 전문)는 필수입니다.');
  if (!changelog || !String(changelog).trim()) {
    throw new Error('changelog는 필수입니다. **이번에 뺀 것과 왜 뺐는지**를 반드시 포함하세요 — 뺀 자국이 안 보이면 사용자에게는 "분명 말했는데 없어졌다"가 됩니다.');
  }
  if (!batch || !String(batch).trim()) throw new Error('batch(어느 배치를 처리한 결과인지)는 필수입니다 — 되짚기의 연결 고리입니다.');

  const t = ensureTopic(topic);
  const b = safeName(batch);
  const no = (b.match(/^b-(\d+)$/) || [])[1];
  const ver = no ? `v${Number(no)}` : `v${listFiles(historyDir(t)).filter((f) => f.endsWith('.md')).length + 1}`;

  const old = readTextOr(draftPath(t));
  const isFirst = !old.trim();

  // 1) 옛 판 보관 (첫 판이면 건너뜀)
  if (!isFirst) fs.writeFileSync(path.join(historyDir(t), `${ver}-prev.md`), old);

  // 2) 새 본문 — 임시 파일에 쓰고 성공하면 교체 (쓰기 실패 시 옛 draft가 남는다)
  const tmp = draftPath(t) + '.tmp';
  fs.writeFileSync(tmp, String(draft));
  fs.renameSync(tmp, draftPath(t));
  fs.writeFileSync(path.join(historyDir(t), `${ver}.md`), String(draft));

  // 3) diff (곁들이는 것 — 본문 복원은 항상 v{N}.md로 한다)
  let diffNote = '';
  if (!isFirst) {
    try {
      execFileSync('diff', ['-u', path.join(historyDir(t), `${ver}-prev.md`), path.join(historyDir(t), `${ver}.md`)],
        { encoding: 'utf8' });
      diffNote = '(차이 없음)';
    } catch (e) {
      // diff는 차이가 있으면 exit 1 — 정상이다
      fs.writeFileSync(path.join(historyDir(t), `${ver}.diff`), e.stdout || '');
      diffNote = `${ver}.diff`;
    }
  }

  // 4) ledger 한 줄
  const oneLine = String(changelog).replace(/\s*\n\s*/g, ' / ').trim();
  fs.appendFileSync(ledgerPath(t), `- **${ver}** ← ${b} · ${kst()} · ${oneLine}\n`);

  return `${ver} 기록했습니다 — draft.md 갱신 · ${isFirst ? '첫 판(옛 판 없음)' : `옛 판 ${ver}-prev.md 보관 · ${diffNote}`} · ledger 한 줄 추가.`;
}

function toolFilterDone({ batch, topic, reason }) {
  if (!batch) throw new Error('batch는 필수입니다.');
  const t = ensureTopic(topic);
  const b = safeName(batch);
  const from = path.join(queueDir(t), b);
  const to = path.join(archiveDir(t), b);

  if (!fs.existsSync(from)) {
    if (fs.existsSync(to)) return `${b}는 이미 처리 끝난 배치입니다(archive). 아무 일도 하지 않았습니다.`;
    throw new Error(`배치 "${b}"를 대기줄에서 못 찾았습니다.`);
  }

  const metaP = path.join(from, 'meta.json');
  const meta = readJsonOr(metaP, {});
  meta.doneAt = nowIso();
  meta.doneAtKst = kst();
  if (reason) meta.reason = reason; // 처리 없이 치우는 경우의 사유
  writeJson(metaP, meta);

  fs.renameSync(from, to);
  const left = listDirs(queueDir(t)).length;
  return `${b}를 archive로 옮겼습니다. 대기줄 ${left}개${left ? ' — 이어서 filter_next' : ' (비었습니다)'}.`;
}

// ================= 도구 명세 =================
// 규율은 여기 박혀 있다. Listen에 읽는 수단 없음 / Filter에 inbox 접근 수단 없음 / 어디에도 삭제 없음.

const TOPIC_PROP = { topic: { type: 'string', description: '주제(선택). 생략하면 기본 주제.' } };

const TOOLS = [
  {
    name: 'listen_add',
    description: '들은 말을 그대로 적는다 (Listen 전용). 받은 말을 inbox에 파일 하나로 저장한다.\n\n[절대 규칙] 되묻지 않는다. 다듬지 않는다. 요약하지 않는다. 맞춤법도 고치지 않는다 — 오탈자도 원문이다. 사용자의 말은 흐름이 끊기면 안 되므로, 이 도구를 부른 뒤에는 영수증 한 줄만 말하고 다음 말을 기다린다.\n\n조사한 내용이 있으면 note로 준다 — 본문과 구분선으로 분리 저장되어 원문과 섞이지 않는다.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        text: { type: 'string', description: '사용자가 한 말. 그대로.' },
        note: { type: 'string', description: '관련 조사·레퍼런스(선택). 원문과 분리해 저장된다.' },
        ...TOPIC_PROP,
      },
      required: ['text'],
    },
  },
  {
    name: 'listen_flush',
    description: '지금 여기까지 잘라 배치 하나를 찍는다 (Listen 전용). 사용자가 "여기까지 끊어줘"라고 할 때 부른다 — 주기를 기다리지 않고 한 덩어리 생각을 배치 하나로 묶는다.\n\ninbox가 비어 있으면 아무 일도 하지 않는다.',
    inputSchema: { type: 'object', additionalProperties: false, properties: { ...TOPIC_PROP } },
  },
  {
    name: 'batcher_on',
    description: '자동 자르기를 켠다. 주기마다 inbox 전량을 잘라 대기줄에 배치로 넣는다(빈 inbox면 건너뜀). 기본 300초(5분).\n\n에이전트가 "지금 얼릴까"를 판단하지 않게 하려는 장치다 — 없어도 되는 판단을 없애면 실수할 자리도 없다.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: { interval: { type: 'number', description: '자르는 주기(초). 기본 300.' }, ...TOPIC_PROP },
    },
  },
  {
    name: 'batcher_off',
    description: '자동 자르기를 끈다. 이미 잘린 배치는 그대로 대기줄에 남는다.',
    inputSchema: { type: 'object', additionalProperties: false, properties: { ...TOPIC_PROP } },
  },
  {
    name: 'batcher_status',
    description: '켜짐 여부·주기·마지막 자른 시각·inbox 건수·대기줄 길이를 본다. 대기줄이 길면 Filter가 못 따라가고 있다는 뜻이다.',
    inputSchema: { type: 'object', additionalProperties: false, properties: { ...TOPIC_PROP } },
  },
  {
    name: 'filter_next',
    description: '대기줄에서 가장 오래된 배치 하나와 지금 draft를 함께 꺼낸다 (Filter 전용). 대기줄이 비면 그 사실만 알린다.\n\n[하는 일] 요약이 아니라 재구성이다 — 흩어진 것을 연결하고, 중복은 지우고, 뒤 발화가 앞을 개선했으면 갱신하고, 논리가 어긋난 것은 걷어내고, 필요하면 주석을 단다. 산출은 항목 목록이 아니라 한 편의 글이다.\n\n[경계] 이 도구가 주는 배치만 본다. inbox를 직접 볼 수단은 없다(얼리기 전 것은 건드리지 않는다). 원본을 고치거나 지울 수단도 없다.\n\n꺼내기만 하고 옮기지 않는다 — archive 이동은 filter_done의 몫이다.',
    inputSchema: { type: 'object', additionalProperties: false, properties: { ...TOPIC_PROP } },
  },
  {
    name: 'filter_write',
    description: '최종안을 새 판으로 갈아 끼운다 (Filter 전용). 네 가지를 함께 한다 — 옛 판 보관 · 새 본문 기록 · diff 자동 생성 · ledger 한 줄.\n\n[changelog 필수] 무엇을 왜 바꿨는지, 그리고 **이번에 뺀 것과 왜 뺐는지**를 반드시 적는다. 벼리는 도구일수록 뺀 자국이 보여야 믿을 수 있다 — 조용히 걷어내면 사용자에게는 "분명 말했는데 없어졌다"가 된다.\n\n판 번호는 배치 번호와 짝이 된다(b-003 → v3). 나중에 문장 하나를 붙들고 판 → 배치 → 원본 발화까지 거슬러 갈 수 있다.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        draft: { type: 'string', description: '새 본문 전문(부분이 아니라 전체).' },
        changelog: { type: 'string', description: '무엇을 왜 바꿨나 + 뺀 것과 사유. 필수.' },
        batch: { type: 'string', description: '처리한 배치 이름(예: b-003).' },
        ...TOPIC_PROP,
      },
      required: ['draft', 'changelog', 'batch'],
    },
  },
  {
    name: 'filter_done',
    description: '처리 끝난 배치를 archive로 옮긴다 (Filter 전용). 삭제가 아니라 이동이다 — 원본은 끝까지 남는다. 두 번 불러도 안전하다.\n\nfilter_write 없이 부르는 것은 정상 흐름이 아니다. 의도적으로 넘기는 배치라면 reason에 사유를 적는다.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        batch: { type: 'string', description: '배치 이름(예: b-003).' },
        reason: { type: 'string', description: '처리 없이 넘기는 경우의 사유(선택).' },
        ...TOPIC_PROP,
      },
      required: ['batch'],
    },
  },
];

const DISPATCH = {
  listen_add: toolListenAdd,
  listen_flush: toolListenFlush,
  batcher_on: toolBatcherOn,
  batcher_off: toolBatcherOff,
  batcher_status: toolBatcherStatus,
  filter_next: toolFilterNext,
  filter_write: toolFilterWrite,
  filter_done: toolFilterDone,
};

// ---- MCP stdio (JSON-RPC 2.0, newline-delimited) ----
function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }
function reply(id, result) { send({ jsonrpc: '2.0', id, result }); }
function replyErr(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }); }

function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    return reply(id, {
      protocolVersion: params?.protocolVersion || '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'listen-filter-mcp', version: '0.1.0' },
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

try { restoreTimers(); } catch (e) { log('restoreTimers fail:', e.message); }
log(`started. projectDir=${projectDir()} (CLAUDE_PROJECT_DIR=${process.env.CLAUDE_PROJECT_DIR || '<unset>'})`);
