#!/usr/bin/env node
// reminder-mcp 훅 — UserPromptSubmit마다 실행 (설계: 같은 폴더 DESIGN.md).
// 자기 세션에 켜진 리마인드가 있으면 stdout으로 출력한다 (출력 = 컨텍스트 주입).
// 없으면 아무것도 출력하지 않는다 (침묵 = 영향 없음).
//
// 절대 조건: 이 스크립트는 모든 세션 매 턴에 실행된다.
//   1. 어떤 경우에도 exit 0 — 리마인드가 깨져도 사용자 메시지를 막으면 안 된다.
//   2. 켜진 게 없으면 출력 0바이트 — 남의 세션에 흔적을 남기지 않는다.
//   3. 에러는 stderr로만 — stderr는 컨텍스트에 주입되지 않는다.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 프로젝트 루트 = 훅 stdin JSON의 cwd (Claude Code가 알려주는 그 세션의 프로젝트 위치).
// 이 파일은 홈(~/.claude/tools/)에 살면서 글로벌 훅으로 전 프로젝트에 걸리므로,
// 파일 위치 역산은 홈을 가리켜 틀린다 — 서버(server.mjs)의 cwd 기반 저장과 어긋난다.
// cwd를 못 얻으면 파일 위치 역산으로 폴백 (프로젝트 사본으로 돌 때의 기존 동작 유지).
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
const REMINDERS = path.join(ROOT, '.claude', 'reminders');

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
