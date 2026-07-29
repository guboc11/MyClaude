#!/usr/bin/env node
// prototype-mcp — 무의존성 MCP stdio 서버 (프로토타입 생명주기: 생성·서버·현황·마무리)
//
// 관할: _PROTOTYPES/(판정 기록) + apps/playground/src/prototypes/(실행 코드) — 두 폴더는 같은 이름의 짝.
// 규칙 원천은 _PROTOTYPES/README.md(헌장) 한 곳 — proto_new가 실시간 파싱해 응답에 동봉한다(생성 시점 규칙 주입).
//
// 포트: 메인 체크아웃 6100, 워크트리 N번 6100+N×10. 6000 자체는 Chrome이 X11 예약 포트로 차단해 쓰지 않는다.
// 장부: 메인 체크아웃의 .claude/proto-servers/ledger.json — 전 체크아웃 공유(포트 충돌 방지). git 제외.
// 안전: 다른 체크아웃의 서버는 건드리지 않는다. 시안 삭제 기능은 만들지 않는다(헌장 2-3 — 처분은 사용자 판단).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { execSync, spawn } from 'node:child_process';

const log = (...a) => process.stderr.write(`[prototype-mcp] ${a.join(' ')}\n`);

const BASE_PORT = 6100;
const PORT_STEP = 10;

// ── 경로 ──────────────────────────────────────────────────────

function root() {
  return process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

// 메인 체크아웃 루트 — 워크트리에서도 장부를 한 곳에 모으기 위한 기준점.
function mainRoot() {
  const out = execSync('git rev-parse --git-common-dir', { cwd: root(), encoding: 'utf8' }).trim();
  return path.dirname(path.resolve(root(), out));
}

const P = {
  docs: () => path.join(root(), '_PROTOTYPES'),
  routes: () => path.join(root(), 'apps', 'playground', 'src', 'prototypes'),
  playground: () => path.join(root(), 'apps', 'playground'),
  ledgerDir: () => path.join(mainRoot(), '.claude', 'proto-servers'),
  ledger: () => path.join(P.ledgerDir(), 'ledger.json'),
  logs: () => path.join(P.ledgerDir(), 'logs'),
};

// ── 장부 ──────────────────────────────────────────────────────

function loadLedger() {
  try { return JSON.parse(fs.readFileSync(P.ledger(), 'utf8')); } catch { return { checkouts: {}, servers: {} }; }
}
function saveLedger(ledger) {
  fs.mkdirSync(P.ledgerDir(), { recursive: true });
  fs.writeFileSync(P.ledger(), JSON.stringify(ledger, null, 2) + '\n');
}

// 체크아웃 번호: 메인=0 고정. 워크트리는 첫 할당 시 빈 번호 중 최소값(1+)을 받아 영구 기록.
function myNumber(ledger) {
  const me = root();
  if (me === mainRoot()) return 0;
  if (ledger.checkouts[me] != null) return ledger.checkouts[me];
  const used = new Set(Object.values(ledger.checkouts));
  let n = 1;
  while (used.has(n)) n++;
  ledger.checkouts[me] = n;
  return n;
}

const portOf = (n) => BASE_PORT + n * PORT_STEP;

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// vite는 macOS에서 ::1(IPv6)에만 리슨하기도 한다 — 두 주소 모두 찔러본다
function portInUseOn(host, port) {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host, port, timeout: 400 });
    sock.on('connect', () => { sock.destroy(); resolve(true); });
    sock.on('error', () => resolve(false));
    sock.on('timeout', () => { sock.destroy(); resolve(false); });
  });
}
async function portInUse(port) {
  const [v4, v6] = await Promise.all([portInUseOn('127.0.0.1', port), portInUseOn('::1', port)]);
  return v4 || v6;
}

// up/down 직렬화 — 동시 호출이 포트 검사·장부를 경쟁하지 않게 한 줄로 세운다
let opLock = Promise.resolve();
function serialized(fn) {
  return (...args) => {
    const run = opLock.then(() => fn(...args));
    opLock = run.catch(() => {});
    return run;
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 같은 네트워크의 다른 기기(폰 등)에서 접속할 LAN IPv4 주소
function lanIP() {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces || []) {
      if (i.family === 'IPv4' && !i.internal) return i.address;
    }
  }
  return null;
}

// ── 헌장·문서 파싱 (온보딩 MCP와 같은 문법 계약) ──────────────

function parseDoc(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  let inFence = false;
  let title = null;
  const headers = [];
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
    if (title === null) { title = text; continue; }
    let addr = null;
    if (text === 'definition') addr = 'definition';
    else {
      const nm = /^(\d+(?:-\d+)*)(?:\s+(.*))?$/.exec(text);
      if (nm) addr = nm[1];
    }
    if (addr === null) continue;
    let end = lines.length;
    for (let k = h + 1; k < headers.length; k++) {
      if (headers[k].level <= level) { end = headers[k].line; break; }
    }
    sections.push({ addr, start: line, end });
  }
  return { title, lines, sections };
}

function charterSection(addr) {
  const file = path.join(P.docs(), 'README.md');
  const doc = parseDoc(file);
  const s = doc.sections.find((x) => x.addr === addr);
  if (!s) return `(헌장에서 ${addr} 조항을 찾지 못함 — ${file} 확인)`;
  return doc.lines.slice(s.start, s.end).join('\n').trim();
}

// CLAUDE.md의 "## 디자인 시스템" 절 발췌 (색·radius·타이포·폰트 기준)
function designSystemExcerpt() {
  const file = path.join(root(), 'CLAUDE.md');
  let lines;
  try { lines = fs.readFileSync(file, 'utf8').split('\n'); } catch { return '(CLAUDE.md 없음)'; }
  const start = lines.findIndex((l) => /^##\s+디자인 시스템/.test(l));
  if (start === -1) return '(CLAUDE.md에 디자인 시스템 절 없음)';
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start, end).join('\n').trim();
}

// SUMMARY.md의 "## {절}" 본문 — 기입 여부 판정용. "("로 시작하는 본문은 템플릿 잔재로 본다.
function summarySection(md, name) {
  const re = new RegExp(`^## ${name}\\s*$`, 'm');
  const m = re.exec(md);
  if (!m) return null;
  const rest = md.slice(m.index + m[0].length);
  const next = /^## /m.exec(rest);
  return (next ? rest.slice(0, next.index) : rest).trim();
}
const isFilled = (body) => !!body && !body.startsWith('(');

// ── 도구: proto_new ───────────────────────────────────────────

function todayKST() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
}

// 폼팩터 태그 — 닫힌 집합. 시안 1개 = 질문 1개 = 폼팩터 1개 (이름이 곧 선언).
// 추가는 개정 관문(실증·기존 태그와 배타 증명·팀 합의)을 거친다.
const FORM_TAGS = ['MOBILE', 'TABLET', 'DESKTOP', 'RESPONSIVE'];

// 이 도구의 사용 모델 — 처음 쓰는 에이전트에게 생성 시점마다 주입된다
function frameworkIntro() {
  return [
    '■ 프로토타이핑 프레임워크 (이 도구의 사용 모델)',
    '- 시안 1개 = 질문 1개 = 폼팩터 1개. 시안은 판정을 얻기 위한 도구다.',
    '- 답은 계단으로 얻는다:',
    '  ①설계서 기록 — proto_spec_write로 주제·화면 단위 기록. 기록할 때마다 반환된 평범판을 인간에게 보여주고',
    '    "더 자세히 반영할 것 없나요?" 확인을 반복한다. 인간이 "진행"이라 답하면 proto_spec_confirm으로 승인을 기록한다',
    '    — 승인 기록 없이는 스토리보드가 열리지 않는다 (묻지 않고 confirm = 거짓 기록)',
    '  ②스토리보드 — 정지화면 컷으로 레이아웃 판정 (스테이트는 아직 없다)',
    '  ③티키타카 — 스크린샷 보고→인간 판정→수정. 수정사항은 설계서에도 역반영',
    '  ④본편 구현 — 인간 승인 후 proto_build 버튼으로 시작. 태스크 기반, 데이터만 가짜·동작은 진짜(2-5)',
    '  ⑤판정·결말 기록 — 시안은 쌓인다',
    '- 역할 분담: 정형 작업은 MCP 버튼이, 내용물은 에이전트가, 판정은 인간이 한다.',
    '- 인간의 요청이 두루뭉술하면("프로토타입 하나 말아줘") 시작 전에 인간에게 확인한다:',
    '  ①무엇을 확인하려는 시안인가(질문) ②폼팩터는? (모바일/태블릿/데스크톱/반응형) ③어느 페이지·상태들을 볼까',
  ].join('\n');
}

function toolNew({ name, form, goal }) {
  if (!form) {
    throw new Error([
      'form(폼팩터 태그)이 필요하다 — 시안은 폼팩터 1개에 고정된다: MOBILE | TABLET | DESKTOP | RESPONSIVE.',
      '인간의 요청에 폼팩터가 없었다면 추측하지 말고 지금 물어라: "어떤 프레임으로 볼까요 — 모바일/태블릿/데스크톱/반응형?"',
      '확인 목표(goal)도 함께 합의하면 좋다 — 시안은 하나의 질문에 답하는 도구다.',
    ].join('\n'));
  }
  const tag = String(form).toUpperCase();
  if (!FORM_TAGS.includes(tag)) {
    throw new Error(`form은 ${FORM_TAGS.join('|')} 중 하나 — 받은 값: ${form}. RESPONSIVE는 "폭에 적응하는 레이아웃 자체가 질문"일 때만.`);
  }
  if (!name || !/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(name)) {
    throw new Error('name은 kebab-case(영소문자·숫자·하이픈, 영문 시작)여야 한다. 날짜·태그는 자동으로 붙는다. 예: "ledger-compact"');
  }
  const id = `${todayKST()}-${tag}-${name}`;
  const docDir = path.join(P.docs(), id);
  const routeDir = path.join(P.routes(), id);
  if (fs.existsSync(docDir) || fs.existsSync(routeDir)) {
    throw new Error(`이미 존재하는 시안: ${id} — 다른 이름을 쓰거나 기존 폴더를 확인할 것 (기존 파일은 건드리지 않는다)`);
  }

  fs.mkdirSync(docDir, { recursive: true });
  fs.writeFileSync(path.join(docDir, 'SUMMARY.md'), [
    `# ${id}`,
    '',
    `폼팩터: ${tag}`,
    '',
    '## 확인 목표',
    '',
    goal || '(무엇을 확인하려는 시안인가 — 시작할 때 적는다. 헌장 2-2)',
    '',
    `실행 코드: \`apps/playground/src/prototypes/${id}/\``,
    '',
    '## 판정',
    '',
    '(간다 / 안 간다 / 조건부 — 확인 결과를 적는다)',
    '',
    '## 결말',
    '',
    '(프로토타입 구현이 어떻게 마무리됐는지 — 최종 판정·확인된 것·남긴 것. 본체 반영 여부는 별개 후속이라 결말을 막지 않는다)',
    '',
  ].join('\n'));

  fs.mkdirSync(routeDir, { recursive: true });
  // 홈 목록 정렬용 생성 시각 — 같은 날짜에도 최신 시안이 맨 위로
  fs.writeFileSync(path.join(routeDir, 'meta.json'), JSON.stringify({ created: new Date().toISOString() }, null, 2) + '\n');
  fs.writeFileSync(path.join(routeDir, 'index.tsx'), [
    `// ${id} — 확인 목표: _PROTOTYPES/${id}/SUMMARY.md`,
    '',
    'export default function Prototype() {',
    '  return (',
    '    <main className="min-h-screen bg-lng-surface font-seed text-lng-ink">',
    '      <div className="mx-auto max-w-xl px-6 py-12">',
    `        <p className="text-[13px] font-medium text-lng-muted">${id}</p>`,
    '        <h1 className="mt-1 text-[28px] font-bold">시안 제목</h1>',
    '        {/* 여기서부터 시안 — @gorae/ui 컴포넌트·lng-* 토큰·본체 라이브러리를 그대로 쓴다 */}',
    '      </div>',
    '    </main>',
    '  )',
    '}',
    '',
  ].join('\n'));

  const indexFile = path.join(P.docs(), 'INDEX.md');
  if (fs.existsSync(indexFile)) {
    let idx = fs.readFileSync(indexFile, 'utf8');
    if (!idx.endsWith('\n')) idx += '\n';
    idx += `- [${id}](./${id}/) — ${goal || '(확인 목표 미기입)'}\n`;
    fs.writeFileSync(indexFile, idx);
  }

  return [
    frameworkIntro(),
    '',
    '■ 생성 완료',
    `- 판정 기록: _PROTOTYPES/${id}/SUMMARY.md — 확인 목표부터 채운다`,
    `- 실행 코드: apps/playground/src/prototypes/${id}/index.tsx`,
    '- INDEX.md 등재 완료',
    `- 실행: proto_up 후 /${id} 라우트 (홈 목록에 자동 등장)`,
    '- 다음 순서: ①proto_spec_write로 설계서 기록(인간과 합의 반복) → ②proto_board·proto_frame 스토리보드 → ③판정 → ④proto_build',
    '',
    '■ 시작 전 필독 — 코드 컨벤션 4문서 전부 (헌장 시작하는 법 3)',
    '- _CODE_CONVENTION/FRONTEND_STRUCTURE.md',
    '- _CODE_CONVENTION/STATE_MANAGEMENT.md',
    '- _CODE_CONVENTION/UI_TRANSITIONS.md',
    '- _CODE_CONVENTION/data-fetching.md',
    '',
    '■ 금지사항',
    '- 임의 hex 색 금지 — lng-* 토큰만 쓴다',
    '- 이모지 아이콘 금지',
    '- @gorae/ui에 있는 프리미티브(Button·Input·Modal 등)를 자체 구현하지 않는다',
    '',
    '■ 헌장 definition (_PROTOTYPES/README.md)',
    charterSection('definition'),
    '',
    '■ 헌장 규칙 (2장 전문)',
    charterSection('2'),
    '',
    '■ 디자인 시스템 (CLAUDE.md 발췌)',
    designSystemExcerpt(),
  ].join('\n');
}

// ── 도구: proto_up / proto_down ───────────────────────────────

async function toolUp() {
  const ledger = loadLedger();
  const n = myNumber(ledger);
  const port = portOf(n);
  const me = root();

  const cur = ledger.servers[n];
  if (cur && alive(cur.pid)) {
    if (cur.checkout === me) {
      return `이미 동작 중 — ${cur.urls?.local || `http://localhost:${cur.port}`}${cur.urls?.network ? ` · ${cur.urls.network}` : ''} (pid ${cur.pid}, N${n})`;
    }
    throw new Error(`N${n} 자리를 다른 체크아웃(${cur.checkout})의 서버(pid ${cur.pid})가 쓰는 중 — 남의 서버는 건드리지 않는다`);
  }
  if (await portInUse(port)) {
    throw new Error(`포트 ${port}이 장부 밖 프로세스에 점유됨 — \`lsof -nP -i :${port}\`로 확인 후 정리하고 다시 시도`);
  }

  // .npmrc node-linker=hoisted — 의존성이 루트 node_modules로 호이스트되므로 앱 → 루트 순서로 찾는다
  const viteBin = [
    path.join(P.playground(), 'node_modules', '.bin', 'vite'),
    path.join(root(), 'node_modules', '.bin', 'vite'),
  ].find((p) => fs.existsSync(p));
  if (!viteBin) throw new Error(`vite 실행 파일 없음 (앱·루트 node_modules/.bin 모두) — 이 체크아웃에서 pnpm install 먼저`);

  fs.mkdirSync(P.logs(), { recursive: true });
  const logFile = path.join(P.logs(), `n${n}-${port}.log`);
  const fd = fs.openSync(logFile, 'a');
  // --host: 같은 네트워크 기기(폰 등)에서도 시안을 확인할 수 있게 LAN에 연다
  const child = spawn(viteBin, ['--port', String(port), '--strictPort', '--host'], {
    cwd: P.playground(),
    detached: true,
    stdio: ['ignore', fd, fd],
  });
  child.unref();
  fs.closeSync(fd);

  const ip = lanIP();
  const urls = { local: `http://localhost:${port}`, network: ip ? `http://${ip}:${port}` : null };
  ledger.servers[n] = { port, pid: child.pid, checkout: me, startedAt: new Date().toISOString(), urls };
  saveLedger(ledger);

  for (let i = 0; i < 40; i++) {
    await sleep(200);
    if (await portInUse(port)) {
      return [
        `기동 완료 — N${n} (pid ${child.pid})`,
        `- local:   ${urls.local}`,
        urls.network ? `- network: ${urls.network} (같은 와이파이 기기에서 접속)` : '- network: (LAN IP 미검출)',
        `- 로그: ${logFile}`,
      ].join('\n');
    }
    if (!alive(child.pid)) break;
  }
  // 실패 판정 — 살아 있으면 고아가 되지 않게 거둔다
  if (alive(child.pid)) { try { process.kill(-child.pid, 'SIGTERM'); } catch { try { process.kill(child.pid, 'SIGTERM'); } catch { /* 이미 죽음 */ } } }
  delete ledger.servers[n];
  saveLedger(ledger);
  let tail = '';
  try { tail = fs.readFileSync(logFile, 'utf8').split('\n').slice(-8).join('\n'); } catch { /* 로그 없으면 생략 */ }
  throw new Error(`기동 실패 (pid ${child.pid}) — 로그 끝부분:\n${tail}`);
}

async function toolDown() {
  const ledger = loadLedger();
  const n = myNumber(ledger);
  const cur = ledger.servers[n];
  if (!cur) return `내 자리(N${n})에 떠 있는 서버 없음`;
  if (cur.checkout !== root()) throw new Error(`N${n}의 서버는 다른 체크아웃(${cur.checkout}) 소유 — 건드리지 않는다`);
  if (alive(cur.pid)) {
    try { process.kill(-cur.pid, 'SIGTERM'); } catch { try { process.kill(cur.pid, 'SIGTERM'); } catch { /* 이미 죽음 */ } }
    await sleep(500);
    if (alive(cur.pid)) { try { process.kill(-cur.pid, 'SIGKILL'); } catch { /* 그룹 없음 */ } }
  }
  delete ledger.servers[n];
  saveLedger(ledger);
  return `종료 완료 — N${n} (port ${cur.port}, pid ${cur.pid}) 장부 정리됨`;
}

// ── 도구: proto_status ────────────────────────────────────────

function toolStatus() {
  const out = [];

  out.push(`■ 시안 목록 (${P.docs()})`);
  let dirs = [];
  try {
    dirs = fs.readdirSync(P.docs(), { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^\d{4}-\d{2}-\d{2}-/.test(e.name))
      .map((e) => e.name)
      .sort()
      .reverse();
  } catch { /* _PROTOTYPES 없음 */ }
  if (dirs.length === 0) out.push('(날짜 접두 시안 없음)');
  for (const id of dirs) {
    const summaryFile = path.join(P.docs(), id, 'SUMMARY.md');
    let mark = 'SUMMARY 없음';
    if (fs.existsSync(summaryFile)) {
      const md = fs.readFileSync(summaryFile, 'utf8');
      const verdict = isFilled(summarySection(md, '판정'));
      const ending = isFilled(summarySection(md, '결말'));
      mark = verdict && ending ? '결말 기록됨' : verdict ? '판정만 기록(결말 미기입)' : '판정 대기';
    }
    const hasRoute = fs.existsSync(path.join(P.routes(), id));
    out.push(`- ${id} — ${mark}${hasRoute ? '' : ' / ⚠ playground 라우트 없음'}`);
  }

  out.push('');
  out.push('■ 서버 현황 (장부: ' + P.ledger() + ')');
  const ledger = loadLedger();
  const entries = Object.entries(ledger.servers);
  if (entries.length === 0) out.push('(떠 있는 서버 없음)');
  for (const [n, s] of entries) {
    const links = s.urls ? ` ${s.urls.local}${s.urls.network ? ` · ${s.urls.network}` : ''}` : '';
    out.push(`- N${n} :${s.port} pid ${s.pid} ${alive(s.pid) ? '동작 중' : '죽음(장부 잔재 — 해당 체크아웃에서 proto_down으로 정리)'}${links} — ${s.checkout}`);
  }
  return out.join('\n');
}

// 시안 이름 해석 — 폴더명 전체 또는 이름 부분(-{name} 접미 일치). done·board·frame 공용.
function resolveProtoId(name) {
  if (!name) throw new Error('name이 필요하다 — 시안 폴더명(날짜 포함) 또는 이름 부분. 목록은 proto_status로.');
  let dirs = [];
  try {
    dirs = fs.readdirSync(P.docs(), { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^\d{4}-\d{2}-\d{2}-/.test(e.name))
      .map((e) => e.name);
  } catch { /* 아래 not found로 */ }
  const hits = dirs.includes(name) ? [name] : dirs.filter((d) => d.endsWith(`-${name}`));
  if (hits.length === 0) throw new Error(`시안을 찾지 못함: ${name} — proto_status로 목록 확인`);
  if (hits.length > 1) throw new Error(`이름이 여러 시안과 일치: ${hits.join(', ')} — 날짜 포함 전체 이름으로`);
  return hits[0];
}

// ── 도구: proto_board / proto_frame (스토리보드) ──────────────
// 원칙: 정형 작업은 버튼으로 — 매니페스트(storyboard.json)는 MCP만 수정, 프레임 내용물만 에이전트가 채운다.
// 폼팩터의 단일 원천은 시안 폴더명의 태그 — 보드는 그걸 읽을 뿐, 따로 인자를 받지 않는다.

function formOfId(id) {
  const m = /^\d{4}-\d{2}-\d{2}-(MOBILE|TABLET|DESKTOP|RESPONSIVE)-/.exec(id);
  if (!m) {
    throw new Error(`시안 이름에 폼팩터 태그가 없다: ${id} — 명명 규칙은 {날짜}-{MOBILE|TABLET|DESKTOP|RESPONSIVE}-{이름} (헌장 2-1). 태그 없는 옛 시안은 스토리보드를 만들 수 없다`);
  }
  return m[1];
}

function boardPaths(id) {
  const routeDir = path.join(P.routes(), id);
  return { routeDir, manifest: path.join(routeDir, 'storyboard.json'), framesDir: path.join(routeDir, 'frames') };
}

function boardGuide(id) {
  return [
    '■ 스토리보드 절차 (레이아웃 판정을 스테이트보다 먼저)',
    '1. proto_frame으로 상태별 프레임을 쫙 깔아 놓는다 — 프레임 = 고정 상태의 정지화면, 스테이트 로직 금지',
    '   page가 주제(시나리오) 그룹 키다 — 캔버스는 주제별 행으로 보인다. 이동 선언은 links 인자(예: ["f2"])',
    '2. 프레임 내용물을 하나씩 채운다 (@gorae/ui·lng-* 토큰 그대로)',
    '   컷 간 이동 UI는 <Go to="f2"> 래퍼(import { Go } from \'../../../board/Go\')로 — 클릭하면 그 컷으로 점프. 스테이트는 여전히 금지',
    `3. proto_up 후 두 뷰로 확인: 캔버스 /${id}/board (한눈 조망) · 슬라이드 /${id}/board/play (←/→로 변화 보기)`,
    '   폼팩터는 시안 태그로 고정 — 폭 변형(좁게/기본/넓게)만 뷰 상단 토글로 본다. RESPONSIVE 시안만 전 구간 토글',
    '4. 스크린샷을 찍어 보고하고 인간 판정을 받는다 — "느낌 맞아/고쳐" 티키타카',
    '5. 판정 통과 후 SUMMARY에 판정을 기록하고 — 본편 구현은 proto_build 버튼으로 시작한다 (품질 기준·설계서·라이브러리 실황이 주입된다)',
    '주의: storyboard.json은 이 도구 계열만 수정한다(컷 편집은 proto_frame_edit/move/remove) — 손으로 편집하지 않는다',
  ].join('\n');
}

function toolBoard({ name }) {
  const id = resolveProtoId(name);
  const { routeDir, manifest, framesDir } = boardPaths(id);
  if (!fs.existsSync(routeDir)) {
    throw new Error(`playground 라우트가 없다: ${routeDir} — 이 시안은 실행 코드 짝이 없음 (proto_new로 만든 시안인지 확인)`);
  }
  const category = formOfId(id).toLowerCase(); // 폼팩터의 단일 원천 = 폴더명 태그
  if (fs.existsSync(manifest)) {
    const m = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    return [`이미 스토리보드 있음 — ${id}: ${m.frames.length}프레임, 폼팩터 ${m.device}`, '', boardGuide(id)].join('\n');
  }
  // 게이트: 설계서 먼저 + 인간 승인 기록 — 기록·합의 없이 콘티부터 그리지 않는다
  const { normal: specNormal } = specPaths(id);
  if (!fs.existsSync(specNormal) || parseDoc(specNormal).sections.length === 0) {
    throw new Error('스토리보드 불가 — 설계서가 먼저다. proto_spec_write로 주제·화면을 기록하고, 기록된 내용을 인간에게 보여주며 "더 자세히 반영할 것 없나요?" 확인을 마친 뒤 다시 proto_board');
  }
  if (!isSpecConfirmed(specNormal)) {
    throw new Error('스토리보드 불가 — 설계서에 인간 승인 기록이 없다. 평범판(proto_spec_show)을 인간에게 보여주고 "진행" 답을 받은 뒤 proto_spec_confirm으로 기록하라. 인간에게 물어보지 않고 confirm을 누르는 것은 거짓 기록이다');
  }
  fs.mkdirSync(framesDir, { recursive: true });
  const m = { device: category, nextId: 1, frames: [] };
  fs.writeFileSync(manifest, JSON.stringify(m, null, 2) + '\n');
  return [`스토리보드 시작 — ${id} (폼팩터 ${category} — 시안 태그에서 자동 결정)`, `- 매니페스트: apps/playground/src/prototypes/${id}/storyboard.json`, '', boardGuide(id)].join('\n');
}

function toolFrame({ name, page, state, position, links }) {
  const id = resolveProtoId(name);
  if (!page || !state) throw new Error('page(페이지 이름)와 state(상태 이름)가 필요하다. 예: page:"초대 목록", state:"추가 모달 열림"');
  const { manifest, framesDir } = boardPaths(id);
  if (!fs.existsSync(manifest)) throw new Error(`스토리보드가 없다 — 먼저 proto_board {name: "${id}"}`);
  const m = JSON.parse(fs.readFileSync(manifest, 'utf8'));

  const at = position == null ? m.frames.length + 1 : Number(position);
  if (!Number.isInteger(at) || at < 1 || at > m.frames.length + 1) {
    throw new Error(`position 범위 밖: ${position} — 1~${m.frames.length + 1} (생략 시 맨 끝)`);
  }

  const file = `f${m.nextId}`;
  const framePath = path.join(framesDir, `${file}.tsx`);
  if (fs.existsSync(framePath)) throw new Error(`프레임 파일이 이미 존재: ${framePath} — 매니페스트 손상 의심, storyboard.json 확인`);

  fs.mkdirSync(framesDir, { recursive: true });
  fs.writeFileSync(framePath, [
    `// ${id} 스토리보드 프레임 ${file} — ${page} / ${state}`,
    '// 고정 상태의 정지화면만 그린다 — 스테이트 로직 금지 (_PROTOTYPES/README.md 1-2)',
    '',
    'export default function Frame() {',
    '  return (',
    '    <div className="h-full w-full bg-lng-surface font-seed text-lng-ink">',
    `      {/* ${page} — ${state} 화면을 여기에 그린다 */}`,
    '    </div>',
    '  )',
    '}',
    '',
  ].join('\n'));

  const entry = { file, page, state };
  if (Array.isArray(links) && links.length > 0) {
    if (!links.every((l) => typeof l === 'string' && /^f\d+$/.test(l))) {
      throw new Error(`links는 컷 파일명 배열이어야 한다 (예: ["f2","f3"]) — 받은 값: ${JSON.stringify(links)}`);
    }
    entry.links = links;
  }
  m.frames.splice(at - 1, 0, entry);
  m.nextId += 1;
  fs.writeFileSync(manifest, JSON.stringify(m, null, 2) + '\n');

  const order = m.frames.map((f, i) => `${i + 1}.${f.file}(${f.page}—${f.state})`).join(' ');
  return [
    `프레임 추가 — ${file} @ ${at}번째: ${page} — ${state}`,
    `- 내용 채울 파일: apps/playground/src/prototypes/${id}/frames/${file}.tsx`,
    `- 현재 순서: ${order}`,
  ].join('\n');
}

// ── 도구: proto_frame_edit / move / remove (콘티 컷 편집) ─────
// 판정 전 작업 중인 컷의 편집은 허용 범위 — 시안(주제 폴더) 자체의 불가침과는 층위가 다르다.

function loadBoard(id) {
  const { manifest, framesDir } = boardPaths(id);
  if (!fs.existsSync(manifest)) throw new Error(`스토리보드가 없다 — 먼저 proto_board {name: "${id}"}`);
  return { manifest, framesDir, m: JSON.parse(fs.readFileSync(manifest, 'utf8')) };
}

function findFrame(m, file) {
  const idx = m.frames.findIndex((f) => f.file === file);
  if (idx === -1) throw new Error(`컷을 찾지 못함: ${file} — 현재 컷: ${m.frames.map((f) => f.file).join(', ') || '(없음)'}`);
  return idx;
}

function orderLine(m) {
  return m.frames.map((f, i) => `${i + 1}.${f.file}(${f.page}—${f.state})`).join(' ') || '(컷 없음)';
}

function toolFrameEdit({ name, file, page, state, links }) {
  const id = resolveProtoId(name);
  const { manifest, m } = loadBoard(id);
  const idx = findFrame(m, file);
  const f = m.frames[idx];
  if (page != null) f.page = page;
  if (state != null) f.state = state;
  if (links != null) {
    if (!Array.isArray(links) || !links.every((l) => typeof l === 'string' && /^f\d+$/.test(l))) {
      throw new Error(`links는 컷 파일명 배열 (예: ["f2"]) — 빈 배열 []이면 링크 제거`);
    }
    if (links.length === 0) delete f.links;
    else f.links = links;
  }
  fs.writeFileSync(manifest, JSON.stringify(m, null, 2) + '\n');
  return [`컷 수정 — ${file}: ${f.page} — ${f.state}${f.links ? ` (→ ${f.links.join('·')})` : ''}`, `- 현재 순서: ${orderLine(m)}`].join('\n');
}

function toolFrameMove({ name, file, position }) {
  const id = resolveProtoId(name);
  const { manifest, m } = loadBoard(id);
  const idx = findFrame(m, file);
  const at = Number(position);
  if (!Number.isInteger(at) || at < 1 || at > m.frames.length) {
    throw new Error(`position 범위 밖: ${position} — 1~${m.frames.length}`);
  }
  const [entry] = m.frames.splice(idx, 1);
  m.frames.splice(at - 1, 0, entry);
  fs.writeFileSync(manifest, JSON.stringify(m, null, 2) + '\n');
  return [`컷 이동 — ${file} → ${at}번째 (파일명은 그대로)`, `- 현재 순서: ${orderLine(m)}`].join('\n');
}

function toolFrameRemove({ name, file }) {
  const id = resolveProtoId(name);
  const { manifest, framesDir, m } = loadBoard(id);
  const idx = findFrame(m, file);
  m.frames.splice(idx, 1);
  fs.writeFileSync(manifest, JSON.stringify(m, null, 2) + '\n');
  const framePath = path.join(framesDir, `${file}.tsx`);
  if (fs.existsSync(framePath)) fs.unlinkSync(framePath);
  return [`컷 제거 — ${file} (매니페스트 줄 + 프레임 파일). 복구가 필요하면 git에서`, `- 현재 순서: ${orderLine(m)}`].join('\n');
}

// ── 도구: proto_spec_write / show (설계서 — 프로토타입 설명) ──
// 평범판 SPEC.md(인간용)와 끝판왕 SPEC_DETAIL.md(에이전트용)를 같은 조항 주소로 동기 관리한다.
// 조항 문법은 온보딩과 동일: `# 1 {주제}` / `## 1-1 {화면}`.

function specPaths(id) {
  const docDir = path.join(P.docs(), id);
  return { docDir, normal: path.join(docDir, 'SPEC.md'), detail: path.join(docDir, 'SPEC_DETAIL.md') };
}

function ensureSpecFile(file, id, kind) {
  if (fs.existsSync(file)) return;
  fs.writeFileSync(file, [
    `# ${id} — 설계서 (${kind})`,
    '',
    kind === '평범판'
      ? '인간이 읽는 설계서. 요약본이 아니다 — 흐름과 의도가 다 보이게 쓴다.'
      : '에이전트가 구현 시 참조하는 전량 디테일. 화면 절은 4필드: 레이아웃 / 요소 / 인터랙션(필수) / mock 데이터.',
    '',
  ].join('\n'));
}

// 문서에서 모든 헤더(주소 유무 무관)를 fence 인식하며 수집
function scanHeaders(lines) {
  const headers = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^```/.test(line.trim())) { inFence = !inFence; continue; }
    if (inFence) continue;
    const h = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (!h) continue;
    const nm = /^(\d+(?:-\d+)*)(?:\s+(.*))?$/.exec(h[2]);
    headers.push({ level: h[1].length, addr: nm ? nm[1] : null, title: nm ? nm[2] || '' : h[2], line: i });
  }
  return headers;
}

// 한 조항의 "자기 본문"(하위 조항 제외)을 교체하거나, 없으면 제자리에 삽입한다
function upsertSection(file, addr, title, body) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const headers = scanHeaders(lines);
  const depth = addr.split('-').length;
  const existing = headers.find((h) => h.addr === addr);
  const block = (t) => [`${'#'.repeat(depth)} ${addr} ${t}`, '', body.trim(), ''];

  if (existing) {
    let end = lines.length;
    for (const h of headers) {
      if (h.line > existing.line) { end = h.line; break; }
    }
    lines.splice(existing.line, end - existing.line, ...block(title || existing.title));
  } else {
    if (!title) throw new Error(`새 조항 ${addr}에는 title이 필요하다`);
    let insertAt = lines.length;
    if (depth > 1) {
      const parentAddr = addr.split('-').slice(0, -1).join('-');
      const parent = headers.find((h) => h.addr === parentAddr);
      if (!parent) throw new Error(`상위 조항 ${parentAddr}이 없다 — 주제부터 기록할 것 (proto_spec_show로 현황 확인)`);
      insertAt = lines.length;
      for (const h of headers) {
        if (h.line > parent.line && h.level <= depth - 1) { insertAt = h.line; break; }
      }
    }
    lines.splice(insertAt, 0, ...block(title));
  }
  fs.writeFileSync(file, lines.join('\n'));
}

// 평범판에서 주소 서브트리(하위 포함)를 뽑아 반환
function specSubtree(file, addr) {
  const doc = parseDoc(file);
  if (!addr) return doc.lines.join('\n').trim();
  const s = doc.sections.find((x) => x.addr === addr);
  if (!s) {
    const list = doc.sections.map((x) => x.addr).join(', ') || '(조항 없음)';
    throw new Error(`조항 ${addr} 없음 — 현재 조항: ${list}`);
  }
  return doc.lines.slice(s.start, s.end).join('\n').trim();
}

function toolSpecWrite({ name, address, title, normal, detail }) {
  const id = resolveProtoId(name);
  if (!normal || !detail) {
    throw new Error('normal(평범판 본문)과 detail(끝판왕 본문)이 모두 필요하다 — 두 판은 같은 주소로 함께 자란다. 끝판왕 화면 절은 4필드: 레이아웃/요소/인터랙션(필수)/mock 데이터');
  }
  const { normal: nFile, detail: dFile } = specPaths(id);
  ensureSpecFile(nFile, id, '평범판');
  ensureSpecFile(dFile, id, '끝판왕');

  let addr = address;
  if (!addr) {
    const tops = parseDoc(nFile).sections.filter((s) => !s.addr.includes('-')).map((s) => Number(s.addr));
    addr = String(tops.length ? Math.max(...tops) + 1 : 1);
  }
  if (!/^\d+(-\d+)*$/.test(addr) || addr.split('-').length > 2) {
    throw new Error(`address는 주제("1") 또는 화면("1-2") 주소 — 받은 값: ${addr}`);
  }
  const wasConfirmed = isSpecConfirmed(nFile);
  upsertSection(nFile, addr, title, normal);
  upsertSection(dFile, addr, title, detail);
  removeConfirm(nFile); // 설계서가 바뀌면 승인은 무효 — 재합의 강제

  return [
    `설계서 기록 — ${addr}${title ? ` ${title}` : ''} (평범판·끝판왕 동기)`,
    wasConfirmed ? '⚠ 기존 승인이 무효화됐다 — 다시 보여주고 재승인(proto_spec_confirm) 필요' : '',
    '',
    '■ 지금 기록된 내용(평범판) — 이걸 인간에게 그대로 보여주고 "더 자세히 반영할 것 없나요?" 확인하라',
    '  인간이 "진행"이라고 답하면 proto_spec_confirm으로 승인을 기록한다 — 승인 없이는 스토리보드가 열리지 않는다',
    '',
    specSubtree(nFile, addr.split('-')[0]),
  ].filter(Boolean).join('\n');
}

// 인간 승인 기록 — SPEC.md 제목 아래 마커 한 줄. spec_write가 다시 쓰면 자동 무효(재합의 강제).
const CONFIRM_PREFIX = '> 승인됨: ';

function isSpecConfirmed(file) {
  if (!fs.existsSync(file)) return false;
  return fs.readFileSync(file, 'utf8').split('\n').some((l) => l.startsWith(CONFIRM_PREFIX));
}

function removeConfirm(file) {
  if (!fs.existsSync(file)) return;
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => !l.startsWith(CONFIRM_PREFIX));
  fs.writeFileSync(file, lines.join('\n'));
}

function toolSpecConfirm({ name, note }) {
  const id = resolveProtoId(name);
  const { normal } = specPaths(id);
  if (!fs.existsSync(normal) || parseDoc(normal).sections.length === 0) {
    throw new Error('승인할 설계서가 없다 — proto_spec_write로 기록부터');
  }
  const lines = fs.readFileSync(normal, 'utf8').split('\n').filter((l) => !l.startsWith(CONFIRM_PREFIX));
  const marker = `${CONFIRM_PREFIX}${new Date().toISOString()}${note ? ` — ${note}` : ''}`;
  lines.splice(1, 0, '', marker); // 제목 헤더 바로 아래
  fs.writeFileSync(normal, lines.join('\n'));
  return [
    `설계서 승인 기록 — ${id}`,
    `- ${marker}`,
    '- 주의: 이 버튼은 인간이 실제로 평범판을 보고 "진행"이라고 답한 뒤에만 누른다. 승인 없이 누르는 것은 거짓 기록이다',
    '- 이후 proto_spec_write로 설계서를 고치면 승인이 자동 무효화된다 — 다시 보여주고 재승인',
  ].join('\n');
}

function toolSpecShow({ name, address }) {
  const id = resolveProtoId(name);
  const { normal } = specPaths(id);
  if (!fs.existsSync(normal)) throw new Error(`설계서가 없다 — proto_spec_write로 기록부터 (${id})`);
  return specSubtree(normal, address || null);
}

// ── 도구: proto_build (구현 버튼) ─────────────────────────────

function libraryInventory() {
  const out = [];
  for (const [label, p] of [
    ['playground', path.join(P.playground(), 'package.json')],
    ['본체(dibang-wedding)', path.join(root(), 'apps', 'dibang-wedding', 'package.json')],
  ]) {
    try {
      const pkg = JSON.parse(fs.readFileSync(p, 'utf8'));
      out.push(`- ${label}: ${Object.keys(pkg.dependencies || {}).join(', ')}`);
    } catch { out.push(`- ${label}: (package.json 읽기 실패)`); }
  }
  return out.join('\n');
}

function qualityBar() {
  return [
    '■ 본편 품질 기준 (헌장 2-5 — 데이터만 가짜, 동작은 진짜)',
    '- 버튼으로 보이는 것은 눌리면 반응하는 진짜 버튼이다. 입력으로 보이는 것은 실제로 입력된다',
    '- 모달·시트·탭·화면 전환은 실제로 열리고 닫히고 넘어간다',
    '- mock인 것은 데이터뿐 — 프로덕트에 그대로 넣어도 어색하지 않은 UI가 기준',
    '- 스토리보드 컷을 이어붙인 정지화면 묶음은 본편이 아니다 (✗ 선례: 2026-07-24 감사카드 에디터 1차 본편)',
  ].join('\n');
}

function toolBuild({ name }) {
  const id = resolveProtoId(name);
  const { normal, detail } = specPaths(id);
  if (!fs.existsSync(normal) || !fs.existsSync(detail)) {
    throw new Error(`구현 불가 — 설계서가 없다. proto_spec_write로 기록하고 인간과 합의부터 (${id})`);
  }
  if (parseDoc(normal).sections.length === 0) {
    throw new Error('구현 불가 — 설계서가 비어 있다 (조항 0). 주제·화면 기록부터');
  }
  const summaryFile = path.join(P.docs(), id, 'SUMMARY.md');
  const md = fs.existsSync(summaryFile) ? fs.readFileSync(summaryFile, 'utf8') : '';
  if (!isFilled(summarySection(md, '판정'))) {
    throw new Error('구현 불가 — 스토리보드 판정이 SUMMARY에 기록되지 않았다. 인간 판정(티키타카)을 먼저 통과할 것');
  }

  return [
    `■ 구현 개시 — ${id}`,
    '',
    qualityBar(),
    '',
    '■ 절차 (이 순서를 지켜라)',
    '1. task MCP(task_add)로 태스크부터 생성한다: 화면 단위 구현 태스크 + **인터랙션 전수 검증 태스크**(설계서 끝판왕의 인터랙션 필드 ↔ 실동작 전수 대조) + 최종 스크린샷 보고 태스크',
    '2. 태스크 순서대로 index.tsx에 구현한다 — 합의된 동작 범위는 SUMMARY·설계서가 기준',
    '3. 실제 클릭·입력으로 검증하고 스크린샷과 함께 인간에게 보고한다',
    '',
    '■ 사용 가능 라이브러리 실황 (package.json 실시간)',
    libraryInventory(),
    '',
    '■ 시작 전 필독 — 코드 컨벤션 4문서 전부',
    '- _CODE_CONVENTION/FRONTEND_STRUCTURE.md · STATE_MANAGEMENT.md · UI_TRANSITIONS.md · data-fetching.md',
    '',
    '■ 디자인 시스템 (CLAUDE.md 발췌)',
    designSystemExcerpt(),
    '',
    '■ 설계서 끝판왕 전문 (구현의 단일 기준)',
    fs.readFileSync(detail, 'utf8').trim(),
  ].join('\n');
}

// ── 도구: proto_done ──────────────────────────────────────────

function toolDone({ name }) {
  const id = resolveProtoId(name);

  const summaryFile = path.join(P.docs(), id, 'SUMMARY.md');
  if (!fs.existsSync(summaryFile)) throw new Error(`${id}에 SUMMARY.md가 없다 — 헌장 2-2(3요소)부터 채울 것`);
  const md = fs.readFileSync(summaryFile, 'utf8');
  const missing = [];
  if (!isFilled(summarySection(md, '판정'))) missing.push('판정 (간다/안 간다/조건부)');
  if (!isFilled(summarySection(md, '결말'))) missing.push('결말 (채택→어느 구현으로, 기각→왜)');
  if (missing.length > 0) {
    throw new Error(`마무리 불가 — SUMMARY.md 미기입 절: ${missing.join(', ')}\n${summaryFile}을 채운 뒤 다시 proto_done`);
  }
  return [
    `마무리 확인 — ${id}`,
    '- SUMMARY 3요소(확인 목표·판정·결말) 기록됨',
    '- 시안 폴더·playground 라우트는 그대로 쌓인다 (헌장 2-3). 처분(삭제·_ARCHIVED)은 사용자 판단 — 이 도구는 지우지 않는다',
  ].join('\n');
}

// ── MCP 배관 ──────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'proto_new',
    description: '[1단계 · 질문·폼팩터 선언] 프로토타입 시작. 시안 1개=질문 1개=폼팩터 1개 — 인간의 요청이 두루뭉술하면 호출 전에 확인 목표와 폼팩터를 인간에게 물어라. {날짜}-{태그}-{이름}으로 판정 기록(_PROTOTYPES)과 실행 코드(playground 라우트)를 짝으로 생성, INDEX 등재, 응답에 프레임워크·헌장·토큰·필독 문서 주입. 시안은 반드시 이 도구로 시작한다(수동 생성 금지).',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'kebab-case 이름 (날짜·태그 접두는 자동). 예: "ledger-compact"' },
        form: { type: 'string', description: '폼팩터 태그(필수): MOBILE|TABLET|DESKTOP|RESPONSIVE. 모르면 인간에게 묻는다' },
        goal: { type: 'string', description: '확인 목표 한 줄 (SUMMARY와 INDEX에 선기입, 선택이지만 권장 — 인간과 합의)' },
      },
      required: ['name', 'form'],
    },
  },
  {
    name: 'proto_up',
    description: '[실행] 이 체크아웃의 playground 개발 서버 기동. 포트는 메인 6100, 워크트리 N번 6100+N×10 자동 배정(장부 공유). 이미 떠 있으면 주소만 재안내.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'proto_down',
    description: '[실행] 이 체크아웃의 playground 서버 종료 + 장부 정리. 다른 체크아웃의 서버는 건드리지 않는다.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'proto_status',
    description: '[현황] 시안 목록(판정·결말 기입 여부, 라우트 짝 유무)과 전 체크아웃 playground 서버 현황.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'proto_board',
    description: '[2단계 · 레이아웃 판정 시작] 스토리보드 초기화 — 스테이트를 입히기 전, 정지화면 프레임으로 레이아웃 판정을 먼저 받는 단계. 폼팩터는 시안 이름의 태그에서 자동 결정(인자 없음). 이미 있으면 현황 재안내(멱등). 매니페스트는 이 도구 계열만 수정한다.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '시안 폴더명(날짜 포함) 또는 이름 부분' },
      },
      required: ['name'],
    },
  },
  {
    name: 'proto_frame',
    description: '[2단계 · 프레임 깔기] 스토리보드에 프레임(고정 상태 정지화면) 1개 추가 — 빈 골격 파일 생성 + 매니페스트 지정 위치 삽입. 상태별로 연달아 호출해 쫙 깔아 놓고, 에이전트는 내용물만 하나씩 채운다.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '시안 폴더명(날짜 포함) 또는 이름 부분' },
        page: { type: 'string', description: '페이지 이름. 예: "초대 목록"' },
        state: { type: 'string', description: '상태 이름. 예: "추가 모달 열림"' },
        position: { type: 'integer', description: '삽입 위치(1-기준). 생략하면 맨 끝. 중간 삽입해도 파일명은 안 바뀐다' },
        links: { type: 'array', items: { type: 'string' }, description: '이 컷에서 이동 가능한 컷 선언 (예: ["f2"]) — 캔버스 캡션에 → 표시. 실제 이동 UI는 프레임 안 <Go> 래퍼로' },
      },
      required: ['name', 'page', 'state'],
    },
  },
  {
    name: 'proto_frame_edit',
    description: '[2단계 · 컷 편집] 컷의 라벨(page·state)·links 선언 수정 — 매니페스트만 만진다(내용물 파일 불가침). links: []면 링크 제거.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '시안 이름' },
        file: { type: 'string', description: '컷 파일명 (예: "f2")' },
        page: { type: 'string', description: '새 주제 이름 (선택)' },
        state: { type: 'string', description: '새 상태 이름 (선택)' },
        links: { type: 'array', items: { type: 'string' }, description: '새 links 배열 (선택, []=제거)' },
      },
      required: ['name', 'file'],
    },
  },
  {
    name: 'proto_frame_move',
    description: '[2단계 · 컷 편집] 컷을 매니페스트 배열의 다른 위치로 이동 — 파일명은 그대로, 표시·슬라이드 순서만 바뀐다.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '시안 이름' },
        file: { type: 'string', description: '컷 파일명' },
        position: { type: 'integer', description: '이동할 위치 (1-기준)' },
      },
      required: ['name', 'file', 'position'],
    },
  },
  {
    name: 'proto_frame_remove',
    description: '[2단계 · 컷 편집] 컷 제거 — 매니페스트 줄과 프레임 파일을 지운다 (작업 중 콘티 편집 층위 — 시안 폴더 자체는 불가침). 복구는 git.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '시안 이름' },
        file: { type: 'string', description: '컷 파일명' },
      },
      required: ['name', 'file'],
    },
  },
  {
    name: 'proto_spec_write',
    description: '[1.5단계 · 설계서 기록] 프로토타입 설명을 주제("1")·화면("1-2") 조항으로 기록/수정 — 평범판(SPEC.md, 인간용)과 끝판왕(SPEC_DETAIL.md, 에이전트용)을 같은 주소로 동기. 응답에 평범판 해당부가 돌아오니 그대로 인간에게 보여주고 "더 자세히 반영할 것 없나요?" 확인을 반복하라. 스토리보드(proto_board)는 설계서 없이는 열리지 않는다.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '시안 이름' },
        address: { type: 'string', description: '조항 주소 — 주제 "1" 또는 화면 "1-2". 생략하면 새 주제 번호 자동' },
        title: { type: 'string', description: '조항 제목 (새 조항이면 필수)' },
        normal: { type: 'string', description: '평범판 본문 — 인간이 읽는 설계서 (요약 아님)' },
        detail: { type: 'string', description: '끝판왕 본문 — 화면 절은 4필드 필수: 레이아웃/요소/인터랙션/mock 데이터' },
      },
      required: ['name', 'normal', 'detail'],
    },
  },
  {
    name: 'proto_spec_confirm',
    description: '[1.5단계 · 설계서 승인 기록] 인간이 평범판을 보고 "진행"이라고 답한 뒤에만 누른다 — 승인이 SPEC.md에 타임스탬프로 기록되고, 이 기록이 있어야 proto_board가 열린다. 이후 spec_write로 설계서를 고치면 승인은 자동 무효화된다. 인간에게 물어보지 않고 누르는 것은 거짓 기록이다.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '시안 이름' },
        note: { type: 'string', description: '승인 메모 (선택 — 예: "3/3 칩 포함 승인")' },
      },
      required: ['name'],
    },
  },
  {
    name: 'proto_spec_show',
    description: '[설계서 조회] 평범판 설계서 출력 (전체 또는 조항 서브트리) — 인간에게 현재 설계서를 보여줄 때.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '시안 이름' },
        address: { type: 'string', description: '조항 주소 (선택, 생략=전체)' },
      },
      required: ['name'],
    },
  },
  {
    name: 'proto_build',
    description: '[4단계 · 구현 개시] 인간이 "구현하자"고 승인했을 때 누르는 버튼. 게이트: 설계서와 스토리보드 판정(SUMMARY) 없으면 거부. 통과 시 품질 기준(데이터만 가짜, 동작은 진짜)·설계서 끝판왕 전문·라이브러리 실황·컨벤션·태스크 기반 절차(task MCP로 태스크 생성 후 구현)를 주입한다.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: '시안 이름' } },
      required: ['name'],
    },
  },
  {
    name: 'proto_done',
    description: '[5단계 · 결말 기록] 시안 마무리 확인 — SUMMARY의 판정·결말이 실제 기입됐는지 검사. 빈칸이면 거부. 파일은 지우지 않는다(시안은 쌓인다, 처분은 사용자 판단).',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: '시안 폴더명(날짜 포함) 또는 이름 부분' } },
      required: ['name'],
    },
  },
];

const DISPATCH = {
  proto_new: toolNew,
  proto_up: serialized(toolUp),
  proto_down: serialized(toolDown),
  proto_status: toolStatus,
  proto_board: serialized(toolBoard),
  // 매니페스트·설계서를 만지는 도구는 직렬화 — 연속 호출 시 쓰기 경쟁 방지
  proto_frame: serialized(toolFrame),
  proto_frame_edit: serialized(toolFrameEdit),
  proto_frame_move: serialized(toolFrameMove),
  proto_frame_remove: serialized(toolFrameRemove),
  proto_spec_write: serialized(toolSpecWrite),
  proto_spec_confirm: serialized(toolSpecConfirm),
  proto_spec_show: toolSpecShow,
  proto_build: toolBuild,
  proto_done: toolDone,
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
      serverInfo: { name: 'prototype-mcp', version: '0.1.0' },
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
log(`started. root=${root()}`);
