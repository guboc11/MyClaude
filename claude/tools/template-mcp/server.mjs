#!/usr/bin/env node
// template-mcp — 규칙 폴더의 정의·생성·묶기 MCP stdio 서버 (무의존)
//
// 구조 (설계: _PLAN/2026-07-31-template-mcp/PLAN.md):
//   .claude/templates/{name}/          ← template 정의 폴더 (진실원)
//     config.json                      ← folder · item_pattern · tags · index
//     README.md                        ← 대상 폴더 README의 원본 (전문)
//     stubs/                           ← 항목 생성 시 깔아줄 뼈대 파일들
//
// 고정 규칙 (엔진에 박힘 — config로 못 바꿈):
//   - 날짜는 시스템 오늘. 항목은 폴더 루트에 생성, 월 묶기(pack)는 매월 5일 이후 명시 호출로만.
//   - 이동은 git mv 개별 경로. README·INDEX 밖의 기존 파일은 절대 건드리지 않는다.
//   - 자동 실행 없음 — cron·타이머·훅 코드 금지. 전부 요청 처리기.
//
// 조항 파서는 onboarding-mcp의 판별 규칙을 그대로 이식 (읽는 쪽과 같은 문법):
//   첫 헤더=제목 / `definition`=예약 주소 / `숫자(-숫자)*`=번호 조항 / 그 외=무주소 헤더 /
//   코드 블록 안 #은 헤더 아님 / 섹션 범위 = 다음 같거나 얕은 급 헤더 직전.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const log = (...a) => process.stderr.write(`[template-mcp] ${a.join(' ')}\n`);

function projectDir() {
  return process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

// ── template 정의 로드 ────────────────────────────────────────

const REQUIRED_KEYS = ['folder', 'item_pattern'];

function templatesRoot() {
  return path.join(projectDir(), '.claude', 'templates');
}

function loadTemplate(name) {
  if (!name) throw new Error('name이 필요합니다 — 정의 폴더 목록은 template_list로.');
  const dir = path.join(templatesRoot(), name);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    const names = listTemplateNames().join(', ') || '(없음)';
    throw new Error(`정의 폴더 없음: ${dir}\n등록된 template: ${names}`);
  }
  const configPath = path.join(dir, 'config.json');
  if (!fs.existsSync(configPath)) throw new Error(`config.json 없음: ${configPath}`);
  let config;
  try { config = JSON.parse(fs.readFileSync(configPath, 'utf8')); }
  catch (e) { throw new Error(`config.json 파싱 실패: ${e.message}`); }
  const missing = REQUIRED_KEYS.filter((k) => !(k in config));
  if (missing.length) throw new Error(`config 필수키 누락: ${missing.join(', ')}`);
  const readmePath = path.join(dir, 'README.md');
  if (!fs.existsSync(readmePath)) throw new Error(`정의 README.md 없음: ${readmePath}`);
  const target = path.join(projectDir(), config.folder);
  return { name, dir, config, readmePath, stubsDir: path.join(dir, 'stubs'), target };
}

function listTemplateNames() {
  const root = templatesRoot();
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

// ── 조항 파서 (onboarding-mcp 이식 — 같은 판별 규칙) ──────────

// 반환: { title, lines, sections: [{ addr, level, title, start, end }], headers }
// headers는 제목·무주소 헤더 포함 전체 목록 — 조항 연산의 위치 계산용 (판별 규칙은 불변).
function parseDoc(text) {
  const lines = text.split('\n');
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
    let addr = null, name = text;
    if (text === 'definition') { addr = 'definition'; name = '(기본 섹션)'; }
    else {
      const nm = /^(\d+(?:-\d+)*)(?:\s+(.*))?$/.exec(text);
      if (nm) { addr = nm[1]; name = nm[2] || ''; }
    }
    if (addr === null) continue;
    let end = lines.length;
    for (let k = h + 1; k < headers.length; k++) {
      if (headers[k].level <= level) { end = headers[k].line; break; }
    }
    sections.push({ addr, level, title: name, start: line, end });
  }
  return { title, lines, sections, headers };
}

// ── 도구: template_register ───────────────────────────────────

function toolRegister({ name }) {
  const t = loadTemplate(name);
  const defReadme = fs.readFileSync(t.readmePath, 'utf8');
  const out = [];

  if (!fs.existsSync(t.target)) {
    // 창설: 폴더 + README + (index 설정이 있으면) INDEX 뼈대
    fs.mkdirSync(t.target, { recursive: true });
    fs.writeFileSync(path.join(t.target, 'README.md'), defReadme);
    out.push(`창설: ${t.config.folder}/ + README.md`);
    if (t.config.index) {
      const indexPath = path.join(t.target, t.config.index.file);
      if (!fs.existsSync(indexPath)) {
        const doc = parseDoc(defReadme);
        const heading = doc.title || t.config.folder;
        fs.writeFileSync(indexPath, `# ${heading} — 차례\n\n${t.config.index.section}\n`);
        out.push(`창설: ${t.config.folder}/${t.config.index.file} (뼈대)`);
      }
    }
  } else {
    // 재생성: README만 정의본으로 교체. INDEX·기존 파일은 건드리지 않는다.
    const targetReadmePath = path.join(t.target, 'README.md');
    const before = fs.existsSync(targetReadmePath) ? fs.readFileSync(targetReadmePath, 'utf8') : null;
    fs.writeFileSync(targetReadmePath, defReadme);
    if (before === null) out.push(`README 신설: ${t.config.folder}/README.md (폴더는 기존)`);
    else if (before === defReadme) out.push(`README 재생성: 정의본과 동일 (diff 0)`);
    else out.push(`README 재생성: 변경됨 (이전 ${before.split('\n').length}줄 → 새 ${defReadme.split('\n').length}줄) — git diff로 확인 권장`);
  }
  return `template_register(${name}) 완료\n- 대상: ${t.target}\n- ${out.join('\n- ')}`;
}

// ── 도구: template_add ────────────────────────────────────────

function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// 루트의 날짜 접두 항목 중 "직전 달 이하"인 것 (pack 대상 = 미묶음)
function unpackedItems(t) {
  if (!fs.existsSync(t.target)) return [];
  const nowMonth = today().slice(0, 7);
  return fs.readdirSync(t.target, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^\d{4}-\d{2}-\d{2}-/.test(e.name))
    .map((e) => e.name)
    .filter((n) => n.slice(0, 7) < nowMonth)
    .sort();
}

function fillVars(text, vars) {
  return text.replace(/\{(item|date|title|tag|summary|TAG)\}/g, (_, k) => vars[k] ?? '');
}

function toolAdd({ name, title, tag, summary }) {
  const t = loadTemplate(name);
  if (!fs.existsSync(t.target)) throw new Error(`대상 폴더 없음: ${t.target} — 먼저 template_register(${name})로 창설.`);
  if (!title) throw new Error('title이 필요합니다 (kebab-case 영문).');
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(title)) {
    throw new Error(`title이 kebab-case가 아닙니다: "${title}" — 소문자 영문·숫자·하이픈만 (예: "storage-path-consistency").`);
  }
  const needsTag = t.config.item_pattern.includes('{TAG}');
  const tags = Array.isArray(t.config.tags) ? t.config.tags : [];
  if (needsTag) {
    if (!tag) throw new Error(`tag가 필요합니다 — 어휘: ${tags.join(', ')}`);
    if (!tags.includes(tag)) throw new Error(`tag가 어휘 밖입니다: "${tag}" — 허용: ${tags.join(', ')}`);
  } else if (tag) {
    throw new Error(`이 template은 tag를 쓰지 않습니다 (item_pattern에 {TAG} 없음).`);
  }

  const date = today(); // 고정 규칙: 시스템 오늘 — 입력으로 못 바꾼다
  const vars = { date, title, tag: tag || '', TAG: tag || '', summary: summary || title };
  const item = fillVars(t.config.item_pattern, vars);
  vars.item = item;
  const itemDir = path.join(t.target, item);
  if (fs.existsSync(itemDir)) throw new Error(`동명 항목이 이미 있습니다: ${t.config.folder}/${item}`);

  // 항목 폴더 + 스텁 (README·INDEX 밖은 이 항목 폴더 안만 만든다)
  fs.mkdirSync(itemDir, { recursive: true });
  const made = [];
  if (fs.existsSync(t.stubsDir)) {
    for (const f of fs.readdirSync(t.stubsDir)) {
      const src = path.join(t.stubsDir, f);
      if (!fs.statSync(src).isFile()) continue;
      fs.writeFileSync(path.join(itemDir, f), fillVars(fs.readFileSync(src, 'utf8'), vars));
      made.push(f);
    }
  }

  // INDEX 등재 — section 헤더 아래 첫 행으로 삽입 (최신이 위)
  let indexed = '(index 설정 없음 — 등재 생략)';
  if (t.config.index) {
    const indexPath = path.join(t.target, t.config.index.file);
    if (!fs.existsSync(indexPath)) throw new Error(`INDEX 없음: ${indexPath} — register로 뼈대부터.`);
    const lines = fs.readFileSync(indexPath, 'utf8').split('\n');
    const at = lines.findIndex((l) => l.trim() === t.config.index.section);
    if (at === -1) throw new Error(`INDEX에 섹션 없음: "${t.config.index.section}" (${indexPath})`);
    let insertAt = at + 1;
    while (insertAt < lines.length && lines[insertAt].trim() === '') insertAt++;
    lines.splice(insertAt, 0, fillVars(t.config.index.row, vars));
    fs.writeFileSync(indexPath, lines.join('\n'));
    indexed = `${t.config.index.file}에 등재`;
  }

  const pending = unpackedItems(t);
  const notice = pending.length
    ? `\n! 미묶음 ${pending.length}건 (직전 달 이하): ${pending.join(', ')} — 묶으려면 template_pack(${name}) 명시 호출 (매월 5일 이후)`
    : '';
  return `template_add(${name}) 완료\n- 생성: ${t.config.folder}/${item}/ (스텁: ${made.join(', ') || '없음'})\n- ${indexed}${notice}`;
}

// ── 도구: template_pack · template_list ───────────────────────

function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
}

function isGitTracked(root, relPath) {
  try {
    git(root, ['rev-parse', '--is-inside-work-tree']);
    git(root, ['ls-files', '--error-unmatch', relPath]);
    return true;
  } catch { return false; }
}

// 고정 규칙: 매월 5일 이후에만, 직전 달 이하의 루트 항목을 {YYYY-MM}/로.
// 5일 미만이면 직전 달은 유예(그보다 오래된 달만 대상).
function toolPack({ name }) {
  const t = loadTemplate(name);
  if (!fs.existsSync(t.target)) throw new Error(`대상 폴더 없음: ${t.target}`);
  const now = today();
  const nowMonth = now.slice(0, 7);
  const day = Number(now.slice(8, 10));
  const prev = new Date(Number(now.slice(0, 4)), Number(now.slice(5, 7)) - 2, 1);
  const prevMonth = `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}`;

  let candidates = unpackedItems(t); // 현재 달 미만 전부
  let deferred = [];
  if (day < 5) { // 직전 달 유예 — 5일 미만에는 그 전 달까지만 묶는다
    deferred = candidates.filter((n) => n.slice(0, 7) === prevMonth);
    candidates = candidates.filter((n) => n.slice(0, 7) !== prevMonth);
  }
  if (candidates.length === 0) {
    const hint = deferred.length ? ` (직전 달 ${deferred.length}건은 5일 미만 유예: ${deferred.join(', ')})` : '';
    throw new Error(`미묶음 0건 — 묶을 항목이 없습니다.${hint}`);
  }

  const moved = [];
  for (const item of candidates) {
    const month = item.slice(0, 7);
    const monthDir = path.join(t.target, month);
    fs.mkdirSync(monthDir, { recursive: true });
    const src = path.join(t.target, item);
    const dst = path.join(monthDir, item);
    const relSrc = path.relative(projectDir(), src);
    const relDst = path.relative(projectDir(), dst);
    if (isGitTracked(projectDir(), relSrc)) {
      git(projectDir(), ['mv', relSrc, relDst]); // 추적 항목은 git mv — 이력 보존(R100)
      moved.push(`${item} → ${month}/ (git mv)`);
    } else {
      fs.renameSync(src, dst); // 미추적 항목은 파일 이동 (커밋 전이라 이력 없음)
      moved.push(`${item} → ${month}/ (mv — 미추적)`);
    }
    // INDEX 경로 갱신 — 항목 링크만 월 폴더 경로로
    if (t.config.index) {
      const indexPath = path.join(t.target, t.config.index.file);
      if (fs.existsSync(indexPath)) {
        const before = fs.readFileSync(indexPath, 'utf8');
        const after = before.replaceAll(`./${item}`, `./${month}/${item}`);
        if (after !== before) fs.writeFileSync(indexPath, after);
      }
    }
  }
  const tail = deferred.length ? `\n- 유예(5일 미만, 직전 달): ${deferred.join(', ')}` : '';
  return `template_pack(${name}) 완료 — ${moved.length}건\n- ${moved.join('\n- ')}${tail}`;
}

function toolList() {
  const names = listTemplateNames();
  if (names.length === 0) return `등록된 template 없음 (${templatesRoot()})`;
  const out = [`등록 template (${templatesRoot()}):`];
  for (const n of names) {
    try {
      const t = loadTemplate(n);
      const pending = unpackedItems(t);
      const exists = fs.existsSync(t.target) ? '' : ' [대상 폴더 미창설 — register 필요]';
      const tagStr = (t.config.tags || []).join('·') || '태그 없음';
      out.push(`- ${n} → ${t.config.folder}/${exists} (${tagStr}) — 미묶음 ${pending.length}건${pending.length ? `: ${pending.join(', ')}` : ''}`);
    } catch (e) {
      out.push(`- ${n} — 정의 오류: ${e.message.split('\n')[0]}`);
    }
  }
  return out.join('\n');
}

// ── 도구: template_clause_set · template_clause_remove ────────
// README 개정의 유일한 경로 (합의 12). 주소 3형:
//   definition       → `# definition` (예약, 급 1)
//   숫자(-숫자)*     → 번호 조항 (급 = 번호 깊이, onboarding 문법과 일치)
//   그 외 텍스트     → 무주소 헤더 (급 2, 부모 본문의 일부로 읽힘)
// 번호 이력·결번·재사용 검사는 만들지 않는다 (합의 13 — 번호는 쓰는 쪽 책임).

function classifyAddr(addr) {
  if (!addr || !String(addr).trim()) throw new Error('addr이 필요합니다 — "definition" / 번호("2-3") / 무주소 헤더 텍스트.');
  const a = String(addr).trim();
  if (a === 'definition') return { kind: 'definition', a };
  if (/^\d+(-\d+)*$/.test(a)) return { kind: 'number', a };
  return { kind: 'plain', a };
}

function headerFor(cls, title) {
  if (cls.kind === 'definition') return '# definition';
  if (cls.kind === 'number') {
    const level = cls.a.split('-').length;
    return `${'#'.repeat(level)} ${cls.a}${title ? ` ${title}` : ''}`;
  }
  return `## ${cls.a}`; // 무주소 — addr 자체가 헤더 텍스트
}

// 자기 본문 범위 = 헤더 줄부터 "다음 헤더(급 무관)" 직전까지 — 하위 조항은 보존
function ownRange(doc, startLine) {
  const next = doc.headers.find((h) => h.line > startLine);
  return next ? next.line : doc.lines.length;
}

function findHeaderLine(doc, cls) {
  if (cls.kind === 'plain') {
    const h = doc.headers.slice(1).find((x) => x.text === cls.a); // [0]=문서 제목
    return h ? h.line : -1;
  }
  const s = doc.sections.find((x) => x.addr === cls.a);
  return s ? s.start : -1;
}

function applyClauseSet(text, addr, title, body) {
  const doc = parseDoc(text);
  const cls = classifyAddr(addr);
  const block = [headerFor(cls, title), '', ...(body ? String(body).split('\n') : [])];
  while (block[block.length - 1] === '') block.pop();
  const at = findHeaderLine(doc, cls);
  const lines = doc.lines;

  if (at !== -1) { // 교체 — 자기 본문만, 하위 조항 보존
    const end = ownRange(doc, at);
    lines.splice(at, end - at, ...block, '');
    return { lines, msg: `교체: ${cls.a} (자기 본문 ${end - at}줄 → ${block.length}줄, 하위 조항 보존)` };
  }
  // 신규 — 삽입 위치 결정
  let insertAt;
  let where;
  if (cls.kind === 'number' && cls.a.includes('-')) {
    const parent = cls.a.split('-').slice(0, -1).join('-');
    const ps = doc.sections.find((x) => x.addr === parent);
    if (!ps) throw new Error(`부모 조항 없음: ${parent} — 먼저 만들거나 최상위 번호를 쓰세요.`);
    insertAt = ps.end; where = `${parent} 서브트리 끝`;
  } else if (cls.kind === 'definition') {
    const first = doc.sections[0];
    insertAt = first ? first.start : lines.length; where = '첫 조항 앞';
  } else {
    insertAt = lines.length; where = '문서 끝';
  }
  while (insertAt > 0 && lines[insertAt - 1].trim() === '') insertAt--;
  lines.splice(insertAt, 0, '', ...block);
  return { lines, msg: `추가: ${cls.a} (${where}, ${block.length}줄)` };
}

function applyClauseRemove(text, addr) {
  const doc = parseDoc(text);
  const cls = classifyAddr(addr);
  const at = findHeaderLine(doc, cls);
  if (at === -1) throw new Error(`없는 주소: ${cls.a}`);
  let end, children = [];
  if (cls.kind === 'plain') {
    end = ownRange(doc, at); // 무주소는 자기 본문만 (하위 개념 없음)
  } else {
    const s = doc.sections.find((x) => x.addr === cls.a);
    end = s.end; // 서브트리 통째
    children = doc.sections.filter((x) => x.addr !== cls.a && x.addr.startsWith(cls.a + '-')).map((x) => x.addr);
  }
  const lines = doc.lines;
  const removedLines = end - at;
  lines.splice(at, removedLines);
  while (lines[at] === '' && lines[at - 1] === '') lines.splice(at, 1); // 이중 빈 줄 정리
  const childNote = children.length ? ` — 하위 조항 ${children.length}개 포함 제거: ${children.join(', ')}` : ' — 하위 조항 없음';
  return { lines, msg: `제거: ${cls.a} (${removedLines}줄)${childNote}` };
}

// 정의본을 진실원으로 연산 → 정의 폴더·대상 폴더 README 동시 기록
function clauseOp(name, op) {
  const t = loadTemplate(name);
  const targetReadme = path.join(t.target, 'README.md');
  if (!fs.existsSync(t.target) || !fs.existsSync(targetReadme)) {
    throw new Error(`register 전입니다 — 대상 README 없음: ${targetReadme}. 먼저 template_register(${name}).`);
  }
  const defText = fs.readFileSync(t.readmePath, 'utf8');
  const tgtText = fs.readFileSync(targetReadme, 'utf8');
  const outOfSync = defText !== tgtText;
  const { lines, msg } = op(defText);
  const result = lines.join('\n');
  fs.writeFileSync(t.readmePath, result);
  fs.writeFileSync(targetReadme, result);
  const syncNote = outOfSync ? '\n! 주의: 연산 전 정의본과 대상 README가 달랐음 — 정의본 기준으로 재동기화됨' : '';
  return `${msg}\n- 갱신: ${path.relative(projectDir(), t.readmePath)} + ${path.relative(projectDir(), targetReadme)} (동일)${syncNote}`;
}

function toolClauseSet({ name, addr, title, body }) {
  return `template_clause_set(${name}) 완료\n- ${clauseOp(name, (text) => applyClauseSet(text, addr, title, body))}`;
}

function toolClauseRemove({ name, addr }) {
  return `template_clause_remove(${name}) 완료\n- ${clauseOp(name, (text) => applyClauseRemove(text, addr))}`;
}

// ── MCP 배선 (stdio JSON-RPC — 기존 도구 골격 재사용) ─────────

const TOOLS = [
  {
    name: 'template_register',
    description:
      'template 정의(.claude/templates/{name}/)를 대상 폴더에 반영한다. 폴더가 없으면 창설(폴더+README+INDEX 뼈대), 있으면 README만 정의본으로 재생성. INDEX와 기존 파일은 건드리지 않는다.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'template 이름 (.claude/templates/ 하위 폴더명)' } },
      required: ['name'],
    },
  },
  {
    name: 'template_add',
    description:
      '항목을 틀대로 생성한다 — 오늘 날짜 자동, 태그 어휘·kebab-case 검증, 스텁 복사, INDEX 등재. 미묶음(직전 달 이하)이 있으면 알림만 한다(묶기는 template_pack 명시 호출).',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'template 이름' },
        title: { type: 'string', description: '항목 제목 — kebab-case 영문 (예: "storage-path-consistency")' },
        tag: { type: 'string', description: '유형 태그 — config.tags 어휘 안에서 (패턴에 {TAG} 있을 때 필수)' },
        summary: { type: 'string', description: 'INDEX 등재용 한 줄 요약 (생략 시 title)' },
      },
      required: ['name', 'title'],
    },
  },
  {
    name: 'template_pack',
    description:
      '직전 달 이하의 루트 항목을 {YYYY-MM}/ 월 폴더로 묶는다 (명시 호출 전용 — 자동 실행 없음). 매월 1~4일에는 직전 달을 유예한다. 추적 항목은 git mv(이력 보존), 미추적은 mv. INDEX 경로도 갱신.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'template 이름' } },
      required: ['name'],
    },
  },
  {
    name: 'template_list',
    description: '등록된 template 목록과 폴더별 미묶음(직전 달 이하) 현황.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'template_clause_set',
    description:
      'README 조항을 추가·교체한다 (README 개정의 유일한 경로). addr 3형: "definition" / 번호("2-3" — 급=깊이, 새 하위는 부모 필수) / 무주소 헤더 텍스트. 교체는 자기 본문만 바꾸고 하위 조항은 보존. 정의 폴더와 대상 폴더 README를 동시 갱신.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'template 이름' },
        addr: { type: 'string', description: '조항 주소 — "definition" | "2-3" | 무주소 헤더 텍스트' },
        title: { type: 'string', description: '번호 조항의 제목 (definition·무주소에선 무시)' },
        body: { type: 'string', description: '조항 본문 텍스트 (그대로 들어감)' },
      },
      required: ['name', 'addr'],
    },
  },
  {
    name: 'template_clause_remove',
    description: 'README 조항을 제거한다. 번호 조항은 하위 조항까지 통째(출력에 명시), 무주소 헤더는 자기 본문만. 정의·대상 README 동시 갱신.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'template 이름' },
        addr: { type: 'string', description: '조항 주소' },
      },
      required: ['name', 'addr'],
    },
  },
];

const DISPATCH = {
  template_register: toolRegister,
  template_add: toolAdd,
  template_pack: toolPack,
  template_list: toolList,
  template_clause_set: toolClauseSet,
  template_clause_remove: toolClauseRemove,
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
      serverInfo: { name: 'template-mcp', version: '0.1.0' },
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
