#!/usr/bin/env node
// reminder-mcp — 무의존성 MCP stdio 서버 (세션별 리마인드 점등·소등)
//
// 설계: 같은 폴더 DESIGN.md
//
// 짝: hook.mjs (UserPromptSubmit). 서버는 파일을 놓고, 훅이 매 턴 그것을 읽어 주입한다.
//     서버와 훅은 서로를 부르지 않는다 — 폴더 규칙 하나만 공유한다.
//
// 세션 id는 에이전트가 넘기지 않는다. 서버가 CLAUDE_CODE_SESSION_ID로 채운다.
//   손으로 넘기게 하면 남의 세션에 꽂는 실수가 가능해지고, 서버가 채우면 그 실수가 불가능하다.
//
// 저장 (한 장 = 한 파일. 여러 프로세스가 한 JSON을 같이 고치는 상황을 만들지 않는다):
//   .claude/reminders/labels/{label}.md              프리셋 (프로젝트 공용)
//   .claude/reminders/sessions/{session_id}/{name}.md  점등 상태 (켜기=생성, 끄기=삭제)
//
// stdout에는 JSON-RPC만, 로그는 stderr로.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const log = (...a) => process.stderr.write(`[reminder-mcp] ${a.join(' ')}\n`);

function projectDir() {
  return process.env.CLAUDE_PROJECT_DIR || process.cwd();
}
function remindersRoot() {
  return path.join(projectDir(), '.claude', 'reminders');
}
function labelsDir() {
  return path.join(remindersRoot(), 'labels');
}
function groupsDir() {
  return path.join(remindersRoot(), 'groups');
}
// 세션을 가리지 않고 항상 나가는 리마인드. 이 도구의 격리(켜지 않은 세션은 조용) 밖에 있다.
function alwaysDir() {
  return path.join(remindersRoot(), 'always');
}

// 세션 id가 없으면 켜지도 끄지도 못한다. 조용히 넘어가면 "켠 줄 알았는데 안 켜진" 상태가 되므로
// 정직하게 실패시킨다 (hook.mjs가 참조 깨짐을 침묵 대신 명시 출력하는 것과 같은 방침).
function sessionId() {
  const sid = process.env.CLAUDE_CODE_SESSION_ID;
  if (!sid) {
    throw new Error(
      'CLAUDE_CODE_SESSION_ID 가 없어 어느 세션인지 알 수 없습니다. 리마인드를 켜지 않았습니다.\n' +
      '(이 서버는 Claude Code가 띄운 세션 안에서만 동작합니다.)'
    );
  }
  if (String(sid).includes('/') || String(sid).includes('\\')) {
    throw new Error(`세션 id에 경로 문자가 있습니다: ${sid}`);
  }
  return String(sid);
}
function sessionDir() {
  return path.join(remindersRoot(), 'sessions', sessionId());
}

// 파일명이 되므로 경로 문자를 막는다. 이름은 사용자가 알아볼 수 있게 원문을 최대한 살린다.
function safeName(s, fallback) {
  const t = String(s ?? '').trim().replace(/[\\/]/g, '-').replace(/\.md$/i, '');
  return t || fallback;
}

// 프리셋·그룹 이름은 영문 소문자 + 숫자 + 하이픈만 (DESIGN.md '이름 규칙').
// 파일명이자 도구 인자이자 [REMINDER:이름] 표시라, 경로·인코딩 문제의 여지를 처음부터 없앤다.
const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
function checkName(s, what = '이름') {
  const t = String(s ?? '').trim();
  if (!NAME_RE.test(t)) {
    throw new Error(
      `${what}은 영문 소문자·숫자·하이픈만 씁니다: ${JSON.stringify(s ?? '')}\n` +
      '  좋은 예: codegraph, db-rules, coding'
    );
  }
  return t;
}

function listMd(dir) {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
  } catch { return []; }
}
function listLabels() {
  return listMd(labelsDir()).map((f) => f.replace(/\.md$/, ''));
}
function listGroups() {
  return listMd(groupsDir()).map((f) => f.replace(/\.md$/, ''));
}
function listAlways() {
  return listMd(alwaysDir()).map((f) => f.replace(/\.md$/, ''));
}

// 그룹 파일 = 프리셋 이름 한 줄에 하나. 빈 줄은 버린다.
function readGroup(name) {
  const p = path.join(groupsDir(), `${name}.md`);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
}
function writeGroup(name, members) {
  fs.mkdirSync(groupsDir(), { recursive: true });
  fs.writeFileSync(path.join(groupsDir(), `${name}.md`), members.join('\n') + '\n');
}
function asList(v) {
  return (Array.isArray(v) ? v : [v]).map((x) => String(x ?? '').trim()).filter(Boolean);
}
function listOn() {
  return listMd(sessionDir()).map((f) => f.replace(/\.md$/, ''));
}

// 다른 세션 것까지 훑는다 (reminder_list{all:true}).
// 기본이 아닌 이유: 이 도구의 기본 단위는 "내 세션"이고, 전체 조망은 예외적 필요다.
function listAllSessions() {
  const base = path.join(remindersRoot(), 'sessions');
  let dirs;
  try {
    dirs = fs.readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  } catch { return []; }
  return dirs.map((sid) => ({ sid, names: listMd(path.join(base, sid)).map((f) => f.replace(/\.md$/, '')) }));
}

function firstLine(text, max = 60) {
  const t = String(text).trim().split('\n')[0];
  return t.length > max ? t.slice(0, max) + '…' : t;
}

// ── 도구 ──────────────────────────────────────────────────────

const ON_USAGE = [
  'reminder_on 은 label · text · file · group 중 정확히 하나만 받습니다.',
  '  reminder_on{label: "lint"}                              프리셋 켜기',
  '  reminder_on{text: "빌드 전에 lint 먼저"}                 즉석 문구 켜기',
  '  reminder_on{file: "_CODE_CONVENTION/DB_MIGRATIONS.md"}  파일 참조 켜기 (매 턴 새로 읽음)',
  '  reminder_on{group: "coding"}                            그룹에 든 프리셋 통째로 켜기',
].join('\n');

// 프리셋 한 장을 세션에 켠다. group 점등이 이것을 여러 번 부른다.
function turnOnLabel(dir, lb) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${lb}.md`), `@label:${lb}`);
}

// 인자 넷 중 하나를 고른다. 어느 키를 채웠는지가 곧 구분이다.
function pickKind({ label, text, file, group }, usage) {
  const given = [['label', label], ['text', text], ['file', file], ['group', group]]
    .filter(([, v]) => typeof v === 'string' && v.trim());
  if (given.length !== 1) {
    const got = given.length ? given.map(([k]) => k).join(', ') : '(없음)';
    throw new Error(`${usage}\n\n받은 인자: ${got}`);
  }
  return given[0];
}

// label/text/file → 저장할 내용과 표시 이름. 점등 위치(세션 폴더 / always 폴더)와 무관하다.
function buildEntry(kind, value, name) {
  if (kind === 'label') {
    const lb = checkName(value, '프리셋 이름');
    if (!fs.existsSync(path.join(labelsDir(), `${lb}.md`))) {
      const have = listLabels();
      throw new Error(
        `등록된 프리셋이 아닙니다: "${lb}"\n` +
        `있는 프리셋: ${have.length ? have.join(', ') : '(없음)'}\n` +
        '먼저 reminder_set{label:"…", text:"…"} 으로 등록하세요.'
      );
    }
    return { body: `@label:${lb}`, itemName: lb };   // 참조로 저장 — 프리셋을 고치면 다음 턴부터 반영
  }
  if (kind === 'file') {
    const rel = String(value).trim();
    if (!fs.existsSync(path.resolve(projectDir(), rel))) {
      throw new Error(`파일이 없습니다: ${rel}\n(프로젝트 루트 기준 상대경로로 주세요.)`);
    }
    return { body: `@${rel}`, itemName: safeName(name, path.basename(rel).replace(/\.[^.]+$/, '')) };
  }
  return { body: String(value), itemName: safeName(name, 'note') };
}

// 그룹을 멤버로 펼친다. 사라진 프리셋은 건너뛰고 알린다 — 부분 성공이 손상을 남기지 않으므로.
function expandGroup(value) {
  const gp = checkName(value, '그룹 이름');
  const members = readGroup(gp);
  if (!members) {
    const have = listGroups();
    throw new Error(
      `등록된 그룹이 아닙니다: "${gp}"\n` +
      `있는 그룹: ${have.length ? have.join(', ') : '(없음)'}\n` +
      '먼저 reminder_group{name:"…", add:"…"} 으로 만드세요.'
    );
  }
  const have = listLabels();
  const on = [], skipped = [];
  for (const m of members) (have.includes(m) ? on : skipped).push(m);
  return { gp, on, skipped };
}

// 점등 = 대상 폴더에 파일 한 장. 세션이든 always든 형식이 같아서 훅은 구분할 필요가 없다.
function writeEntry(dir, itemName, body) {
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `${itemName}.md`);
  const existed = fs.existsSync(target);
  fs.writeFileSync(target, body);
  return existed;
}

function toolOn(args = {}) {
  const [kind, value] = pickKind(args, ON_USAGE);
  const dir = sessionDir();

  // 그룹은 켜는 순간 프리셋별 파일로 펼쳐진다 — 개별로 켠 것과 결과가 같아서 훅은 그룹을 모른다.
  if (kind === 'group') {
    const { gp, on, skipped } = expandGroup(value);
    for (const m of on) turnOnLabel(dir, m);
    const out = [`켰습니다 — ${gp} (${on.length}개)`, `  ${on.length ? on.join(', ') : '(없음)'}`];
    if (skipped.length) out.push(`  건너뜀: ${skipped.join(', ')} (프리셋이 없습니다)`);
    out.push('', '다음 사용자 메시지부터 매 턴 주입됩니다. 끄기는 reminder_off 로 하나씩.');
    return out.join('\n');
  }

  const { body, itemName } = buildEntry(kind, value, args.name);
  const existed = writeEntry(dir, itemName, body);

  return [
    `${existed ? '덮어썼습니다' : '켰습니다'} — [REMINDER:${itemName}]`,
    `  ${body}`,
    '',
    '다음 사용자 메시지부터 매 턴 주입됩니다. 끄기: reminder_off{name:"' + itemName + '"}',
  ].join('\n');
}

function toolOff({ name } = {}) {
  const dir = sessionDir();
  const on = listOn();
  if (!name) {
    if (!on.length) return '이 세션에 켜진 리마인드가 없습니다.';
    return [
      `이 세션에 켜진 리마인드 ${on.length}개:`,
      ...on.map((n) => `- ${n}`),
      '',
      '끄려면: reminder_off{name:"<위 이름>"}',
    ].join('\n');
  }
  const nm = safeName(name, '');
  const p = path.join(dir, `${nm}.md`);
  if (!fs.existsSync(p)) {
    throw new Error(`켜져 있지 않습니다: "${nm}"\n켜진 것: ${on.length ? on.join(', ') : '(없음)'}`);
  }
  fs.unlinkSync(p);
  try { fs.rmdirSync(dir); } catch { /* 남은 게 있으면 그대로 둔다 */ }
  return `껐습니다 — ${nm}\n다음 턴부터 주입되지 않습니다.`;
}

function toolSet({ label, text, file, remove } = {}) {
  if (!label) throw new Error('label(프리셋 이름)이 필요합니다.');
  const lb = checkName(label, '프리셋 이름');
  const dir = labelsDir();
  const p = path.join(dir, `${lb}.md`);

  if (remove) {
    if (!fs.existsSync(p)) {
      const have = listLabels();
      throw new Error(`없는 프리셋입니다: "${lb}"\n있는 프리셋: ${have.length ? have.join(', ') : '(없음)'}`);
    }
    fs.unlinkSync(p);
    return `프리셋을 지웠습니다 — ${lb}\n(이미 켜둔 세션에서는 다음 턴에 "프리셋을 찾을 수 없음"이 주입됩니다.)`;
  }

  const given = [['text', text], ['file', file]].filter(([, v]) => typeof v === 'string' && v.trim());
  if (given.length !== 1) {
    throw new Error(
      'reminder_set 은 text 또는 file 중 하나를 받습니다 (지우려면 remove:true).\n' +
      '  reminder_set{label:"lint", text:"빌드 전에 lint 먼저"}\n' +
      '  reminder_set{label:"db", file:"_CODE_CONVENTION/DB_MIGRATIONS.md"}\n' +
      `\n받은 인자: ${given.length ? given.map(([k]) => k).join(', ') : '(없음)'}`
    );
  }
  const [kind, value] = given[0];
  let body;
  if (kind === 'file') {
    const rel = String(value).trim();
    if (!fs.existsSync(path.resolve(projectDir(), rel))) {
      throw new Error(`파일이 없습니다: ${rel}\n(프로젝트 루트 기준 상대경로로 주세요.)`);
    }
    body = `@${rel}`;
  } else {
    body = String(value);
  }

  fs.mkdirSync(dir, { recursive: true });
  const existed = fs.existsSync(p);
  fs.writeFileSync(p, body);
  return `프리셋을 ${existed ? '고쳤습니다' : '등록했습니다'} — ${lb}\n  ${firstLine(body, 80)}\n\n켜기: reminder_on{label:"${lb}"}`;
}

const ALWAYS_USAGE = [
  'reminder_always 는 label · text · file · group 중 하나로 켜거나, off 로 끕니다.',
  '  reminder_always{label: "codegraph"}     프리셋을 모든 세션에 켜기',
  '  reminder_always{group: "coding"}        그룹을 모든 세션에 켜기',
  '  reminder_always{off: "codegraph"}       끄기',
  '  reminder_always{}                       지금 항상 켜져 있는 것 보기',
].join('\n');

// 영구 리마인드 — 모든 세션에 항상 나간다.
//
// reminder_on 과 인자가 거의 같은데도 별도 도구로 둔 이유: 무게가 다르다.
// reminder_on 은 내 세션에만 영향을 주지만 이쪽은 팀 전원의 모든 세션에 나간다.
// 인자 하나(always:true) 차이로 갈리면 실수로 전체에 켜질 수 있어, 도구 이름 자체를 분리했다.
function toolAlways(args = {}) {
  const { off } = args;
  const dir = alwaysDir();

  if (off) {
    const nm = safeName(off, '');
    const p = path.join(dir, `${nm}.md`);
    const have = listAlways();
    if (!fs.existsSync(p)) {
      throw new Error(`항상 켜진 목록에 없습니다: "${nm}"\n지금 켜진 것: ${have.length ? have.join(', ') : '(없음)'}`);
    }
    fs.unlinkSync(p);
    try { fs.rmdirSync(dir); } catch { /* 남은 게 있으면 그대로 둔다 */ }
    return `껐습니다 — ${nm}\n모든 세션에서 다음 턴부터 주입되지 않습니다.`;
  }

  const any = ['label', 'text', 'file', 'group'].some((k) => typeof args[k] === 'string' && args[k].trim());
  if (!any) {
    const have = listAlways();
    if (!have.length) return `항상 켜진 리마인드가 없습니다.\n\n${ALWAYS_USAGE}`;
    const out = [`모든 세션에 항상 켜진 리마인드 ${have.length}개:`];
    for (const n of have) out.push(`  - ${n}: ${firstLine(fs.readFileSync(path.join(dir, `${n}.md`), 'utf8'), 70)}`);
    out.push('', '끄려면: reminder_always{off:"<위 이름>"}');
    return out.join('\n');
  }

  const [kind, value] = pickKind(args, ALWAYS_USAGE);

  if (kind === 'group') {
    const { gp, on, skipped } = expandGroup(value);
    for (const m of on) turnOnLabel(dir, m);
    const out = [`모든 세션에 켰습니다 — ${gp} (${on.length}개)`, `  ${on.length ? on.join(', ') : '(없음)'}`];
    if (skipped.length) out.push(`  건너뜀: ${skipped.join(', ')} (프리셋이 없습니다)`);
    out.push('', '이 레포의 모든 세션에 다음 턴부터 나갑니다. 끄기: reminder_always{off:"<이름>"}');
    return out.join('\n');
  }

  const { body, itemName } = buildEntry(kind, value, args.name);
  const existed = writeEntry(dir, itemName, body);
  return [
    `${existed ? '덮어썼습니다' : '모든 세션에 켰습니다'} — [REMINDER:${itemName}]`,
    `  ${body}`,
    '',
    '이 레포의 모든 세션에 다음 턴부터 나갑니다. 끄기: reminder_always{off:"' + itemName + '"}',
  ].join('\n');
}

// 그룹 = 프리셋 이름의 목록(메타데이터). 그 자체로 주입되는 내용은 없다.
function toolGroup({ name, add, remove, delete: del } = {}) {
  if (!name) {
    const have = listGroups();
    throw new Error(
      'name(그룹 이름)이 필요합니다.\n' +
      `있는 그룹: ${have.length ? have.join(', ') : '(없음)'}`
    );
  }
  const gp = checkName(name, '그룹 이름');
  const p = path.join(groupsDir(), `${gp}.md`);
  const cur = readGroup(gp);

  if (del) {
    if (!cur) throw new Error(`없는 그룹입니다: "${gp}"\n있는 그룹: ${listGroups().join(', ') || '(없음)'}`);
    fs.unlinkSync(p);
    return `그룹을 지웠습니다 — ${gp}\n(이미 켜둔 세션의 리마인드는 그대로입니다. 그룹은 켤 때만 쓰이므로.)`;
  }

  if (add && remove) throw new Error('add 와 remove 를 한 번에 주지 마세요. 한 번에 한 가지만 합니다.');

  if (add) {
    const names = asList(add).map((n) => checkName(n, '프리셋 이름'));
    const have = listLabels();
    const missing = names.filter((n) => !have.includes(n));
    // 죽은 이름이 그룹에 앉는 것을 막는다 — 켤 때가 아니라 넣을 때 잡아야 고치기 쉽다.
    if (missing.length) {
      throw new Error(
        `없는 프리셋입니다: ${missing.join(', ')}\n` +
        `있는 프리셋: ${have.length ? have.join(', ') : '(없음)'}\n` +
        '먼저 reminder_set 으로 등록하세요.'
      );
    }
    const next = [...(cur || [])];
    const added = [];
    for (const n of names) if (!next.includes(n)) { next.push(n); added.push(n); }
    writeGroup(gp, next);
    return [
      `${cur ? '그룹에 넣었습니다' : '그룹을 만들었습니다'} — ${gp}`,
      `  추가: ${added.length ? added.join(', ') : '(이미 들어 있음)'}`,
      `  현재: ${next.join(', ')}`,
      '',
      `켜기: reminder_on{group:"${gp}"}`,
    ].join('\n');
  }

  if (remove) {
    if (!cur) throw new Error(`없는 그룹입니다: "${gp}"\n있는 그룹: ${listGroups().join(', ') || '(없음)'}`);
    const names = asList(remove);
    const next = cur.filter((m) => !names.includes(m));
    const gone = cur.filter((m) => names.includes(m));
    if (!gone.length) throw new Error(`그룹에 없습니다: ${names.join(', ')}\n현재: ${cur.join(', ') || '(비어 있음)'}`);
    writeGroup(gp, next);
    return [
      `그룹에서 뺐습니다 — ${gp}`,
      `  제거: ${gone.join(', ')}`,
      `  현재: ${next.length ? next.join(', ') : '(비어 있음)'}`,
    ].join('\n');
  }

  // 인자가 name 뿐이면 조회
  if (!cur) {
    const have = listGroups();
    throw new Error(`없는 그룹입니다: "${gp}"\n있는 그룹: ${have.length ? have.join(', ') : '(없음)'}`);
  }
  const have = listLabels();
  return [
    `[${gp}] ${cur.length}개`,
    ...cur.map((m) => `  - ${m}${have.includes(m) ? '' : '  ← 프리셋 없음'}`),
    '',
    `켜기: reminder_on{group:"${gp}"}`,
  ].join('\n');
}

function toolList({ all } = {}) {
  const out = [];
  let on = [];
  let sidNote = '';
  try {
    on = listOn();
  } catch (e) {
    sidNote = `  (${e.message.split('\n')[0]})`;
  }

  if (all) {
    const mine = process.env.CLAUDE_CODE_SESSION_ID || '';
    const sessions = listAllSessions();
    out.push(`전체 세션 (${sessions.length}개):`);
    if (!sessions.length) out.push('  (켜둔 세션 없음)');
    for (const s of sessions) {
      const tag = s.sid === mine ? ' ← 이 세션' : '';
      out.push(`  ${s.sid}${tag}`);
      out.push(`    ${s.names.length ? s.names.join(', ') : '(없음)'}`);
    }
    out.push('');
  }

  // 영구 리마인드를 맨 위에 둔다 — 격리 밖이라 잊으면 팀 전체에 계속 나간다.
  const always = listAlways();
  if (always.length) {
    out.push(`[항상] 모든 세션에 켜져 있음 ${always.length}개:`);
    for (const n of always) {
      out.push(`  - ${n}: ${firstLine(fs.readFileSync(path.join(alwaysDir(), `${n}.md`), 'utf8'), 70)}`);
    }
    out.push('');
  }

  out.push('이 세션에 켜진 리마인드:');
  if (sidNote) out.push(sidNote);
  else if (!on.length) out.push('  (없음)');
  else {
    for (const n of on) {
      const body = fs.readFileSync(path.join(sessionDir(), `${n}.md`), 'utf8');
      out.push(`  - ${n}: ${firstLine(body, 70)}`);
    }
  }

  const labels = listLabels();
  out.push('', '등록된 프리셋:');
  if (!labels.length) out.push('  (없음)');
  else {
    for (const lb of labels) {
      const body = fs.readFileSync(path.join(labelsDir(), `${lb}.md`), 'utf8');
      out.push(`  - ${lb}: ${firstLine(body, 70)}`);
    }
  }

  const groups = listGroups();
  out.push('', '등록된 그룹:');
  if (!groups.length) out.push('  (없음)');
  else for (const gp of groups) out.push(`  - ${gp}: ${(readGroup(gp) || []).join(', ') || '(비어 있음)'}`);

  return out.join('\n');
}

// ── 도구 정의 ─────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'reminder_on',
    description:
      '이 세션에 리마인드를 켠다. 다음 사용자 메시지부터 매 턴 컨텍스트에 주입된다.\n' +
      '\n' +
      'label · text · file · group 중 **정확히 하나만** 준다.\n' +
      '· label — reminder_set 으로 등록해둔 프리셋 이름. 프리셋을 나중에 고치면 다음 턴부터 반영된다.\n' +
      '· text — 즉석 문구. 그 자리에서 지어 넣을 때.\n' +
      '· file — 프로젝트 루트 기준 상대경로. 매 턴 그 파일을 새로 읽으므로 파일을 고치면 즉시 반영된다.\n' +
      '· group — reminder_group 으로 만든 그룹. 그 안의 프리셋들이 한꺼번에 켜진다.\n' +
      '\n' +
      '세션 id는 넘기지 않는다 — 서버가 채운다. 다른 세션은 이 리마인드의 영향을 받지 않는다.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        label: { type: 'string', description: '등록된 프리셋 이름. 없는 이름이면 있는 목록을 붙여 에러.' },
        text: { type: 'string', description: '즉석 문구. 준 그대로 저장된다.' },
        file: { type: 'string', description: '프로젝트 루트 기준 상대경로. 매 턴 새로 읽는다.' },
        group: { type: 'string', description: '등록된 그룹 이름. 안의 프리셋들이 개별로 펼쳐져 켜진다.' },
        name: { type: 'string', description: '표시 이름(선택). [REMINDER:이름] 에 쓰인다. label·group 은 각자의 이름을 그대로 쓴다.' },
      },
    },
  },
  {
    name: 'reminder_off',
    description:
      '이 세션의 리마인드를 끈다. 다음 턴부터 주입되지 않는다.\n' +
      'name 을 생략하면 지금 켜진 목록만 보여준다(무엇을 끌지 고를 때).',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string', description: '끌 리마인드 이름. 생략하면 켜진 목록만 반환.' },
      },
    },
  },
  {
    name: 'reminder_set',
    description:
      '프리셋을 등록·수정·삭제한다. 프리셋은 프로젝트 공용이라 세션과 무관하게 남는다.\n' +
      '자주 쓰는 리마인드를 한 번 등록해두고 reminder_on{label} 로 켰다 껐다 하는 용도.\n' +
      '\n' +
      'text 또는 file 중 하나를 준다. 지우려면 remove:true.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        label: { type: 'string', description: '프리셋 이름. 파일명이 된다.' },
        text: { type: 'string', description: '프리셋 내용(문구).' },
        file: { type: 'string', description: '프리셋 내용(파일 참조). 프로젝트 루트 기준 상대경로.' },
        remove: { type: 'boolean', description: 'true 면 그 프리셋을 삭제한다.' },
      },
      required: ['label'],
    },
  },
  {
    name: 'reminder_always',
    description:
      '**모든 세션에 항상** 나가는 영구 리마인드를 관리한다. reminder_on 과 달리 세션을 가리지 않는다.\n' +
      '\n' +
      '이 도구가 reminder_on 과 분리되어 있는 이유는 무게가 다르기 때문이다.\n' +
      'reminder_on 은 내 세션에만 영향을 주지만, 이쪽은 이 레포에서 도는 **모든 사람의 모든 세션**에 나간다.\n' +
      '팀 공통 규칙처럼 정말로 항상 필요한 것에만 쓴다.\n' +
      '\n' +
      '· label · text · file · group 중 하나를 주면 켠다 (인자 뜻은 reminder_on 과 같다).\n' +
      '· off 로 끈다.\n' +
      '· 인자 없이 부르면 지금 항상 켜져 있는 것을 보여준다.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        label: { type: 'string', description: '등록된 프리셋 이름.' },
        text: { type: 'string', description: '즉석 문구.' },
        file: { type: 'string', description: '프로젝트 루트 기준 상대경로. 매 턴 새로 읽는다.' },
        group: { type: 'string', description: '등록된 그룹 이름. 안의 프리셋들이 펼쳐져 켜진다.' },
        name: { type: 'string', description: '표시 이름(선택).' },
        off: { type: 'string', description: '끌 리마인드 이름.' },
      },
    },
  },
  {
    name: 'reminder_group',
    description:
      '그룹을 만들고 프리셋을 넣고 뺀다. 그룹은 "프리셋 이름의 목록"일 뿐이고 그 자체로 주입되는 내용은 없다.\n' +
      'reminder_on{group:"…"} 으로 켜면 안의 프리셋들이 개별로 펼쳐져 한꺼번에 켜진다.\n' +
      '\n' +
      '· name 만 주면 그 그룹 내용을 본다.\n' +
      '· add 로 프리셋을 넣는다(없는 그룹이면 그때 만들어진다). 문자열 하나 또는 배열.\n' +
      '· remove 로 뺀다. delete:true 로 그룹 자체를 지운다.\n' +
      'add 와 remove 를 동시에 주지 않는다.\n' +
      '\n' +
      '없는 프리셋을 add 하면 튕긴다 — 죽은 이름이 그룹에 앉는 것을 켤 때가 아니라 넣을 때 막는다.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string', description: '그룹 이름 (영문 소문자·숫자·하이픈).' },
        add: {
          anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
          description: '넣을 프리셋 이름. 하나 또는 여러 개.',
        },
        remove: {
          anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
          description: '뺄 프리셋 이름. 하나 또는 여러 개.',
        },
        delete: { type: 'boolean', description: 'true 면 그룹 자체를 삭제한다. 켜둔 세션의 리마인드는 그대로.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'reminder_list',
    description:
      '이 세션에 켜진 리마인드와, 등록된 프리셋·그룹 목록을 함께 보여준다.\n' +
      'all:true 를 주면 다른 세션에 무엇이 켜져 있는지까지 함께 보여준다(전체 조망).',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        all: { type: 'boolean', description: 'true 면 모든 세션의 점등 현황을 함께 보여준다. 기본 false = 이 세션만.' },
      },
    },
  },
];

const DISPATCH = {
  reminder_on: toolOn,
  reminder_off: toolOff,
  reminder_set: toolSet,
  reminder_always: toolAlways,
  reminder_group: toolGroup,
  reminder_list: toolList,
};

// ── MCP stdio (JSON-RPC 2.0, newline-delimited) ───────────────

function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }
function reply(id, result) { send({ jsonrpc: '2.0', id, result }); }
function replyErr(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }); }

function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    return reply(id, {
      protocolVersion: params?.protocolVersion || '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'reminder-mcp', version: '0.1.0' },
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

function serve() {
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
  log(`started. projectDir=${projectDir()} session=${process.env.CLAUDE_CODE_SESSION_ID || '<unset>'}`);
}

// 직접 실행일 때만 stdio 서버로 뜬다. import 하면 아래 함수들만 노출 (테스트용).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) serve();

export {
  projectDir, remindersRoot, labelsDir, groupsDir, alwaysDir, sessionId, sessionDir,
  safeName, checkName, listLabels, listGroups, listAlways, listOn, readGroup, writeGroup,
  buildEntry, expandGroup, writeEntry,
  toolOn, toolOff, toolSet, toolAlways, toolGroup, toolList, TOOLS,
};
