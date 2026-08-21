#!/usr/bin/env node
// reminder-mcp 훅 — UserPromptSubmit마다 실행 (설계: 같은 폴더 DESIGN.md).
// 자기 세션에 켜진 리마인드가 있으면 stdout으로 출력한다 (출력 = 컨텍스트 주입).
// 없으면 아무것도 출력하지 않는다 (침묵 = 영향 없음).
//
// 이 파일은 홈(~/.claude/tools/)과 프로젝트(<프로젝트>/.claude/tools/) 어디에 두어도
// 동작이 같도록 작성한다 — 두 사본은 항상 바이트 동일하게 유지한다.
//   · 루트: stdin JSON의 cwd (Claude Code가 알려주는 그 세션의 프로젝트 위치).
//   · 우선순위: 내가 프로젝트 사본이면 주입 담당. 내가 글로벌(홈) 사본인데
//     그 프로젝트가 자기 훅을 배선해뒀으면 침묵한다(양보) — 이중 주입 방지.
//     글로벌 사본은 "자기 훅이 없는 프로젝트"를 커버하는 안전망이다.
//
// 절대 조건: 이 스크립트는 모든 세션 매 턴에 실행된다.
//   1. 어떤 경우에도 exit 0 — 리마인드가 깨져도 사용자 메시지를 막으면 안 된다.
//   2. 켜진 게 없으면 출력 0바이트 — 남의 세션에 흔적을 남기지 않는다.
//   3. 에러는 stderr로만 — stderr는 컨텍스트에 주입되지 않는다.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// cwd를 못 얻으면 파일 위치 역산으로 폴백 (.claude/tools/reminder-mcp/ → 3단계 위).
const FALLBACK_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

let ROOT = FALLBACK_ROOT;
let SID = null;
try {
  const d = JSON.parse(fs.readFileSync(0, 'utf8'));      // 훅 입력 JSON 전부
  if (typeof d.cwd === 'string' && d.cwd) ROOT = d.cwd;
  SID = d.session_id;
} catch (e) {
  process.stderr.write(`[reminder-hook] ${e.message}\n`);
}

// 우선순위 판별 — 실행 시점의 자기 위치(import.meta.url)로 역할을 가른다.
// 내용이 같아도 위치는 다르므로, 사본마다 코드를 다르게 둘 필요가 없다.
try {
  const self = fs.realpathSync(fileURLToPath(import.meta.url));
  const projectCopy = path.join(ROOT, '.claude', 'tools', 'reminder-mcp', 'hook.mjs');
  const isProjectCopy = fs.existsSync(projectCopy) && fs.realpathSync(projectCopy) === self;
  if (!isProjectCopy) {
    const projSettings = path.join(ROOT, '.claude', 'settings.json');
    if (fs.existsSync(projSettings)
      && fs.readFileSync(projSettings, 'utf8').includes('reminder-mcp/hook.mjs')) {
      process.exit(0);                                   // 프로젝트 훅이 있다 — 양보
    }
  }
} catch { /* 판별 실패 시 그냥 진행 — 주입 누락이 중복보다 위험하다 */ }

const REMINDERS = path.join(ROOT, '.claude', 'mcp-reminders');

// 참조 해석. 깨진 참조는 침묵하는 대신 명시 문구를 주입한다 —
// "켜져 있다고 믿는데 안 나가는 상태"가 침묵보다 위험하다 (DESIGN.md 실패 방침).
// fromLabel: 프리셋 안에서 다시 @label: 이 나오면 따라가지 않는다 (루프 차단).
function resolveBody(body, fromLabel = false) {
  const t = String(body).trim();
  if (t.startsWith('@label:')) {
    const label = t.slice('@label:'.length).trim();
    if (fromLabel) return `(프리셋 안의 @label: 참조는 따라가지 않습니다: ${label})`;
    const p = path.join(REMINDERS, 'labels', `${label}.md`);
    if (!fs.existsSync(p)) return `(프리셋을 찾을 수 없음: ${label})`;
    return resolveBody(fs.readFileSync(p, 'utf8'), true); // 프리셋이 @파일이면 그것까지 푼다
  }
  if (t.startsWith('@')) {
    const rel = t.slice(1).trim();
    const p = path.resolve(ROOT, rel);
    if (!fs.existsSync(p)) return `(참조 파일을 찾을 수 없음: ${rel})`;
    return fs.readFileSync(p, 'utf8').trim();            // 매 턴 새로 읽는다 — 수정 즉시 반영
  }
  return t;
}

// 같은 이름이 always 와 세션 양쪽에 있으면 한 번만 낸다 (always 가 먼저라 그쪽이 이긴다).
const emitted = new Set();
function emitDir(dir) {
  if (!fs.existsSync(dir)) return;
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.md')).sort()) {
    const name = f.replace(/\.md$/, '');
    if (emitted.has(name)) continue;
    emitted.add(name);
    const body = resolveBody(fs.readFileSync(path.join(dir, f), 'utf8'));
    process.stdout.write(`[REMINDER:${name}] ${body}\n`);
  }
}

try {
  // 영구 리마인드는 세션을 가리지 않으므로 session_id 를 못 얻어도 나간다.
  emitDir(path.join(REMINDERS, 'always'));

  if (SID && !String(SID).includes('/') && !String(SID).includes('\\')) {
    emitDir(path.join(REMINDERS, 'sessions', String(SID)));
  }
} catch (e) {
  process.stderr.write(`[reminder-hook] ${e.message}\n`);
}
process.exit(0);
