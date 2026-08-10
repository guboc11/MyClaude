#!/usr/bin/env node
// manage-env hook — PreToolUse: 값 파일 직접 읽기 차단 (Read·Bash)
// 설계: .claude/plans/2026-07-30-manage-env-mcp/PLAN.md §7 5단계
//
// 사정거리: Claude 의 도구 호출(Read 의 file_path, Bash 의 command 문자열)만 검사한다.
//   MCP 서버·스크립트의 내부 파일 읽기는 별도 프로세스라 애초에 훅 시야 밖 — sync/check/docs 는
//   명령 문자열에 값 파일 경로가 없으므로 자연히 통과한다.
//
// 차단 (PLAN §7 그대로):
//   - Read: .claude/env/*.env / apps/*/.env / apps/*/.env.{localhost,dev,prod}
//   - Bash: 위 경로를 내용 읽기 명령(cat·grep·rg·sed·awk·head·tail·less·more·cut·sort·uniq·
//           strings·xxd·od·source·. 등)으로 여는 경우 — env_reveal 의 grep 명령문도 Claude 가
//           실행하면 차단이 맞다 (그 명령은 사용자의 외부 터미널용).
// 허용:
//   - .env.example / .env.test.example (값 없는 명세)
//   - guide.yaml·docs (값 없음 — *.env 패턴에 안 걸림)
//   - ls 등 존재 확인, sync/check/docs 스크립트 실행
//
// 판정 출력: 차단 시 hookSpecificOutput.permissionDecision = "deny" JSON. 허용 시 무출력.

import fs from 'node:fs';

// 값 파일 경로 패턴 (절대·상대 모두 문자열 매칭)
const VALUE_FILE = /(\.claude\/env\/[^\s/'"]+\.env|apps\/[^\s/'"]+\/\.env(\.(localhost|dev|prod))?)(?=[\s'"]|$)/;
// 내용을 읽어 출력할 수 있는 명령 (단어 경계)
const READERS = /(^|[\s;|&(])(cat|grep|rg|sed|awk|head|tail|less|more|cut|sort|uniq|strings|xxd|od|source|\.)\s/;

function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }) + '\n');
  process.exit(0);
}

let raw = '';
try { raw = fs.readFileSync(0, 'utf8'); } catch { process.exit(0); }
let input;
try { input = JSON.parse(raw); } catch { process.exit(0); }

const tool = input.tool_name || '';
const ti = input.tool_input || {};

if (tool === 'Read') {
  const p = String(ti.file_path || '');
  if (p.endsWith('.env.example') || p.endsWith('.env.test.example')) process.exit(0);
  if (VALUE_FILE.test(p)) {
    deny(
      `[manage-env] 값 파일 직접 읽기 차단: ${p}\n` +
      '시크릿이 대화 맥락에 오르는 것을 막는 훅입니다 (2026-07-29 노출 사고 재발 방지).\n' +
      '대신: 상태 확인은 manage-env MCP 의 env_list, 확인 명령은 env_reveal(사용자가 외부 터미널에서 실행), 편집은 사람이 에디터로.',
    );
  }
  process.exit(0);
}

if (tool === 'Bash') {
  const cmd = String(ti.command || '');
  // .env.example 참조는 값 파일 아님 — 매칭 전에 제거해 오탐 방지
  const scrubbed = cmd.replace(/[^\s'"]*\.env\.(example|test\.example)/g, '');
  if (VALUE_FILE.test(scrubbed) && READERS.test(scrubbed)) {
    deny(
      '[manage-env] 값 파일 내용을 찍는 Bash 명령 차단.\n' +
      '값은 Claude 맥락에 올리지 않습니다. env_reveal 이 준 명령은 사용자의 외부 터미널 전용입니다.\n' +
      '대신: env_list(상태)·env_sync(분배)·env_check(정합) 를 쓰거나, 편집은 사람이 에디터로.',
    );
  }
  process.exit(0);
}

process.exit(0);
