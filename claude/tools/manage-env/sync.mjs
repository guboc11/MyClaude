#!/usr/bin/env node
// manage-env sync — 값 파일(.claude/env/{환경}.env) → apps/*/.env.{환경} 분배 생성기
// 설계: .claude/plans/2026-07-30-manage-env-mcp/PLAN.md §5 / 파서·상수는 lib.mjs 공유(중복 금지)
//
// 불변 원칙: 값을 표준 출력·표준 에러에 절대 찍지 않는다 — 키 이름·파일 경로·개수만.
//
// 규칙:
//   1. 앱별 apps/{앱}/.env.example 의 키 목록·순서가 분배 명세 (매핑 파일을 따로 만들지 않는다).
//   2. 값 파일 표기: KEY=값 (공유) / KEY@앱=값 (그 앱에만). 찾는 순서: KEY@앱 → KEY.
//   3. 값 없는 필수 키(config.go required · env.ts 비 optional)면 키 이름만 찍고 실패(exit 1).
//      값 없는 선택 키는 경고 후 생략.
//   4. 출력 순서는 항상 .env.example 순서.
//   5. 대상 앱: api · dibang-wedding · guest-web
//      (admin=런타임 토글, invitation-shell=Render env 전용, cmd/*=자체 cmdConfig — 1단계 제외, PLAN §9)
//
// 실행: 레포 루트에서  node ~/.claude/tools/manage-env/sync.mjs [localhost|dev|prod|all]

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SYNC_APPS, ENVS, assertRepoRoot, parseEnvFile, parseEnvText, exampleKeys, schema, canonicalSort, parseGuideSections } from './lib.mjs';

const REPO = process.cwd();
try { assertRepoRoot(REPO); } catch (e) { console.error(`[manage-env] ${e.message}`); process.exit(1); }

// ── 값 파일 정렬 재작성 (canonical = guide.yaml 순서) ─────────────────────────
// 값 파일에 쓰기가 들어가는 유일한 지점 — 무손실 가드가 본체다:
// 재작성 조립 결과의 파싱 맵(키→값)이 원본과 완전히 같지 않으면 절대 쓰지 않는다.
// 주석 방침: 머리 주석·섹션 제목은 아래 템플릿이 관리. 사람 글은 guide.yaml 담당이므로
// 템플릿 밖 주석 줄이 보이면 정렬을 건너뛰고 줄 위치만 보고한다 (메모를 조용히 버리지 않기).

const ledgerHeader = (envName) => [
  `# .claude/env/${envName}.env — ${envName} 환경 값의 단일 원천 (gitignore, 커밋 금지)`,
  `# 편집은 이 파일에서만. 앱 폴더의 .env.${envName} 는 manage-env sync 가 만드는 생성물.`,
  `# 표기: KEY=값 (공유 — example 에 이 키를 둔 모든 앱에 분배) / KEY@앱=값 (그 앱에만)`,
  `# 순서: guide.yaml(canonical) — sync 가 자동 정렬. 사람 메모는 이 파일이 아니라 guide.yaml 에.`,
];
const COMMENT_ALLOW = [/^# \.claude\/env\//, /^# 유래:/, /^# 편집/, /^# 표기:/, /^# 순서:/, /^# ─/, /^#\s*$/];

/** 한 환경의 값 파일을 canonical 순서로 재작성. 반환: true=정상(재작성 또는 변경 없음/건너뜀), false=가드 실패. */
function reorderLedger(envName) {
  const p = path.join(REPO, '.claude/env', `${envName}.env`);
  if (!fs.existsSync(p)) return true;
  const raw = fs.readFileSync(p, 'utf8');

  // 템플릿 밖 주석 → 정렬 건너뜀 (분배는 계속 — 사람 메모 보존이 우선)
  const strangers = [];
  raw.split('\n').forEach((line, i) => {
    const t = line.trim();
    if (t.startsWith('#') && !COMMENT_ALLOW.some((re) => re.test(t))) strangers.push(i + 1);
  });
  if (strangers.length) {
    console.error(`[정렬 건너뜀] .claude/env/${envName}.env — 템플릿 밖 주석 발견 (줄: ${strangers.join(', ')}). 사람 메모는 guide.yaml 로 옮긴 뒤 다시 실행하세요.`);
    return true; // 분배는 원본 그대로 진행
  }

  const original = parseEnvText(raw);
  const orderedKeys = canonicalSort(REPO, [...original.keys()]);
  // 검증용 훼손 주입 지점 — 게이트에서 "가드가 실제로 막는가"를 증명하기 위한 시험 전용 플래그
  const dropKey = process.env.MANAGE_ENV_TEST_DROP_KEY;
  const emitKeys = dropKey ? orderedKeys.filter((k) => k !== dropKey) : orderedKeys;

  const lines = ledgerHeader(envName);
  const placed = new Set();
  for (const sec of parseGuideSections(REPO)) {
    const secKeys = emitKeys.filter((k) => !placed.has(k) && sec.keys.includes(k.split('@')[0]));
    if (!secKeys.length) continue;
    lines.push('', `# ── ${sec.title} ──`);
    for (const k of secKeys) { lines.push(`${k}=${original.get(k)}`); placed.add(k); }
  }
  const rest = emitKeys.filter((k) => !placed.has(k));
  if (rest.length) {
    lines.push('', '# ── 기타 (guide.yaml 미등재 — check E·F항 확인) ──');
    for (const k of rest) lines.push(`${k}=${original.get(k)}`);
  }
  const assembled = lines.join('\n') + '\n';

  // ★ 무손실 가드 — 전후 파싱 맵 완전 동일 아니면 쓰지 않는다 ★
  const reparsed = parseEnvText(assembled);
  const diff = [];
  for (const k of original.keys()) {
    if (!reparsed.has(k)) diff.push(`${k}(소실)`);
    else if (reparsed.get(k) !== original.get(k)) diff.push(`${k}(값 변형)`);
  }
  for (const k of reparsed.keys()) if (!original.has(k)) diff.push(`${k}(발생)`);
  if (diff.length) {
    console.error(`[정렬 실패] .claude/env/${envName}.env — 무손실 가드: 재작성 결과가 원본과 다름 (${diff.join(', ')}). 쓰지 않음.`);
    return false;
  }

  if (assembled === raw) {
    console.log(`[정렬] .claude/env/${envName}.env — 변경 없음`);
    return true;
  }
  const bakDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manage-env-reorder-'));
  fs.copyFileSync(p, path.join(bakDir, `${envName}.env`));
  fs.writeFileSync(p, assembled);
  console.log(`[정렬] .claude/env/${envName}.env — ${original.size}개 키 canonical 재정렬 (백업: ${bakDir})`);
  return true;
}

/** 한 환경을 분배한다. 성공 여부를 돌려준다. */
export function sync(envName) {
  const ledger = parseEnvFile(path.join(REPO, '.claude/env', `${envName}.env`));
  let ok = true;
  for (const app of SYNC_APPS) {
    const keys = exampleKeys(REPO, app);
    const sch = schema(REPO, app);
    const lines = [];
    const missingRequired = [];
    const skippedOptional = [];
    for (const k of keys) {
      const v = ledger.has(`${k}@${app}`) ? ledger.get(`${k}@${app}`)
              : ledger.has(k) ? ledger.get(k)
              : undefined;
      if (v !== undefined) lines.push(`${k}=${v}`);
      else if (sch.get(k)?.required) missingRequired.push(k);
      else skippedOptional.push(k);
    }
    if (missingRequired.length) {
      console.error(`[실패] apps/${app}/.env.${envName} — 필수 키 값 없음: ${missingRequired.join(', ')}`);
      ok = false;
      continue; // 실패한 앱의 파일은 건드리지 않는다
    }
    const header =
      `# 생성됨: manage-env sync (${envName}) — 직접 편집 금지\n` +
      `# 값 수정은 .claude/env/${envName}.env 에서 하고 sync 를 다시 실행한다. 키 목록·순서 = .env.example\n`;
    fs.writeFileSync(path.join(REPO, 'apps', app, `.env.${envName}`), header + lines.join('\n') + '\n');
    const skipNote = skippedOptional.length ? `  (값 없는 선택 키 생략: ${skippedOptional.join(', ')})` : '';
    console.log(`[생성] apps/${app}/.env.${envName} — ${lines.length}개 키${skipNote}`);
  }
  return ok;
}

const arg = process.argv[2] || 'all';
const targets = arg === 'all' ? ENVS : [arg];
if (!targets.every((e) => ENVS.includes(e))) {
  console.error(`[manage-env] 알 수 없는 환경: ${arg} (localhost|dev|prod|all)`);
  process.exit(1);
}
let allOk = true;
for (const e of targets) {
  allOk = reorderLedger(e) && allOk; // 정렬 먼저 (가드 실패 시에도 분배는 원본 맵으로 무해하게 진행)
  allOk = sync(e) && allOk;
}
process.exit(allOk ? 0 : 1);
