#!/usr/bin/env node
// manage-env docs — 서비스별 환경변수 안내 문서 생성기
// 설계: .claude/plans/2026-07-30-manage-env-mcp/PLAN.md §7 3단계
//
// 불변 원칙: 값을 문서에 한 글자도 싣지 않는다 — 키 이름·경로·절차만.
//   (코드 주석 원문도 값·포트가 섞일 수 있어 통째로 옮기지 않고, 상세는 스키마 파일 경로로 안내한다)
//
// 재료: render.yaml(서비스·선언·분류) + 코드 스키마(필수 여부) + guide.yaml(설명·얻는 곳·스샷·주의)
// 산출: .claude/mcp-manage-env/docs/{서비스명}.md × 배포 서비스, local.md, README.md
//
// 실행: 레포 루트에서  node ~/.claude/tools/manage-env/docs.mjs
//       (MCP env_sync 가 분배 후 자동 실행하는 것이 최종 형태 — 4단계에서 연결)

import fs from 'node:fs';
import path from 'node:path';
import { SERVICE_APP, SCHEMA_FILE, assertRepoRoot, schema as libSchema, parseGuide as libParseGuide, parseRenderYaml as libParseRenderYaml } from './lib.mjs';

const REPO = process.cwd();
try { assertRepoRoot(REPO); } catch (e) { console.error(`[manage-env] ${e.message}`); process.exit(1); }
const OUT = path.join(REPO, '.claude/mcp-manage-env/docs');



function schema(app) { return libSchema(REPO, app); }

function parseGuide() { return libParseGuide(REPO); }

function parseRenderYaml() { return libParseRenderYaml(REPO); }

const guide = parseGuide();
const services = parseRenderYaml();
fs.mkdirSync(OUT, { recursive: true });

const AUTOGEN = '<!-- 자동 생성: manage-env docs — 손 편집 금지. 원천: render.yaml · 코드 스키마 · guide.yaml -->';

function screenshotLine(g) {
  if (!g?.screenshot) return '';
  const p = path.join(REPO, '.claude/mcp-manage-env/screenshots', g.screenshot);
  const exists = fs.existsSync(p);
  return exists
    ? `\n  ![얻는 곳](../screenshots/${g.screenshot})`
    : `\n  (스샷 예정: \`screenshots/${g.screenshot}\` — 캡처 시 값이 찍힌 부분은 가릴 것)`;
}

function keySection(k, meta, cls, envName, app) {
  const g = guide.get(k);
  const deployRequired = g?.deploy_required === 'true';
  const badge = [
    meta?.required ? '필수'
      : deployRequired ? `선택(부팅${meta?.hasDefault ? '·코드 기본값' : ''}) · 배포 필수`
      : meta?.hasDefault ? '선택(코드 기본값 있음)' : '선택',
    g?.sensitive === 'true' ? '시크릿' : '공개',
    cls === 'value' ? 'render.yaml value:' : 'Render 대시보드 입력',
  ].join(' · ');
  const lines = [
    `### ${k}`,
    `\`${badge}\``,
    '',
    `- **무엇**: ${g?.description || '(guide.yaml 에 항목 없음)'}`,
    `- **얻는 곳**: ${g?.obtain || '(미기재)'}${screenshotLine(g)}`,
    '- **값을 바꿀 때**:',
    `  1. \`.claude/mcp-manage-env/${envName}.env\` 에서 이 키 줄을 직접 수정 (에디터로 연다 — Claude 에게 값을 불러주지 않는다)`,
    `  2. 레포 루트에서 \`node ~/.claude/tools/manage-env/sync.mjs ${envName}\` 실행 → \`apps/${app}/.env.${envName}\` 재생성`,
    cls === 'value'
      ? '  3. 배포 반영: `render.yaml` 해당 서비스의 이 키 `value:` 를 같은 값으로 갱신하고 커밋 (파일이 배포의 원천, 푸시되면 자동 재배포)'
      : `  3. 배포 반영: Render 대시보드 → 이 서비스 → Environment 에서 이 키에 직접 입력·저장 (저장하면 자동 재배포. 시크릿은 파일·대화에 싣지 않는다)`,
    `  4. 정합 검사: \`node ~/.claude/tools/manage-env/check.mjs\` 로 어긋남 없는지 확인`,
    `  5. 동작 확인: Render 대시보드 → 이 서비스 → Logs 에서 재배포 후 부팅·연결 오류가 없는지 본다. 로컬로 돌던 server-mcp 세트는 재기동해야 새 값을 받는다`,
  ];
  if (deployRequired) {
    lines.push('- **배포 필수**: 스키마상 선택(부팅은 됨)이지만 배포 환경에선 서비스 온전성에 필수 — 빠지면 조용히 기능이 죽는다');
  }
  if (g?.note) lines.push(`- **주의**: ${g.note}`);
  return lines.join('\n');
}

let generated = [];

// ── 배포 서비스별 문서 ──
for (const [svc, app] of Object.entries(SERVICE_APP)) {
  const envName = svc.endsWith('-dev') ? 'dev' : 'prod';
  const declared = services.get(svc);
  const out = [`# ${svc} — 환경변수 안내`, AUTOGEN, ''];
  if (!app || !declared || declared.size === 0) {
    out.push('이 서비스는 환경변수를 쓰지 않는다 (정적 사이트, 외부 URL 은 코드 상수).');
  } else {
    const sch = schema(app);
    const dash = [...declared].filter(([, c]) => c === 'sync:false').map(([k]) => k);
    out.push(
      `앱: \`apps/${app}\` (키 명세: \`apps/${app}/.env.example\`, 스키마: \`${SCHEMA_FILE[app]}\`)`,
      '',
      '## 값이 사는 곳',
      '- `value:` 로 선언된 키 → **render.yaml 이 배포의 원천** (바꾸면 커밋 필요). 로컬 실행용 값은 `.claude/mcp-manage-env/*.env`',
      dash.length
        ? `- 대시보드 직접 입력(시크릿): ${dash.map((k) => `\`${k}\``).join(', ')} — Render 대시보드 → ${svc} → Environment`
        : '- 이 서비스는 대시보드 직접 입력 키가 없다 (전부 render.yaml `value:`)',
      '',
      '## 키별 안내',
      '',
    );
    for (const [k, cls] of declared) {
      out.push(keySection(k, sch.get(k), cls, envName, app), '');
    }
  }
  fs.writeFileSync(path.join(OUT, `${svc}.md`), out.join('\n') + '\n');
  generated.push(`${svc}.md`);
}

// ── 로컬 실행 문서 ──
const local = [
  '# 로컬 실행 — 환경변수 안내',
  AUTOGEN,
  '',
  '## 구조 (값은 한 곳에만)',
  '- 값의 단일 원천: `.claude/mcp-manage-env/localhost.env` · `dev.env` · `prod.env` (gitignore — 커밋 금지)',
  '- 앱 폴더의 `.env.localhost/.env.dev/.env.prod` 는 **생성물** — 직접 고치지 않는다',
  '- 분배: 레포 루트에서 `node ~/.claude/tools/manage-env/sync.mjs [localhost|dev|prod|all]`',
  '- 정합 검사: `node ~/.claude/tools/manage-env/check.mjs`',
  '',
  '## 값 파일 표기',
  '- `KEY=값` — 공유 값. `.env.example` 에 이 키를 둔 모든 앱에 분배된다',
  '- `KEY@앱=값` — 그 앱에만 분배 (예: 카카오 JS 키처럼 앱마다 다른 값)',
  '',
  '## 환경의 의미',
  '- `localhost.env` — 로컬 Supabase(OrbStack) 스택을 보는 실행',
  '- `dev.env` — dev Supabase 프로젝트를 보는 실행 (로컬 프로세스든 Render dev 서비스든 같은 환경)',
  '- `prod.env` — prod Supabase 프로젝트. 다룰 때 이중 확인',
  '',
  '## 시크릿 취급',
  '- 시크릿 값은 사람이 에디터로 값 파일을 직접 열어 넣는다 — Claude 대화·프롬프트에 싣지 않는다',
  '- 어떤 키가 시크릿인지는 `guide.yaml` 의 `sensitive` 가 기준',
  '- 값 파일은 gitignore 라 새 머신·새 클론에는 없다 — 팀원에게 안전한 경로(대화·레포 제외)로 인수받거나, 각 키의 서비스 문서 "얻는 곳"을 따라 대시보드에서 재조립해 만든다',
  '',
  '## 서버 세트',
  '- 멀티 에이전트 로컬 서버는 server-mcp 세트가 런치 시점에 env 를 주입한다 — 전역 파일과 무관',
  '- 전역 `.env` 심볼릭 일괄 교체(use-env.sh)는 레거시 — 사용 금지',
].join('\n') + '\n';
fs.writeFileSync(path.join(OUT, 'local.md'), local);
generated.push('local.md');

// ── 색인 ──
const readme = [
  '# 환경변수 안내 문서 (자동 생성)',
  AUTOGEN,
  '',
  '이 폴더의 문서만 보고 — Claude 에게 묻지 않고 — 값을 얻고·바꾸고·반영할 수 있는 것이 목표다.',
  '',
  '## 문서',
  '- [local.md](local.md) — 로컬 실행·값 파일 구조·분배 방법 (먼저 읽기)',
  ...Object.keys(SERVICE_APP).map((s) => `- [${s}.md](${s}.md) — Render 서비스 ${s}`),
  '',
  '## 공통 원칙',
  '- 값 수정은 언제나 `.claude/mcp-manage-env/{환경}.env` 한 곳 → `sync.mjs` 로 분배 → 배포분은 render.yaml(공개) 또는 Render 대시보드(시크릿)',
  '- 문서·guide.yaml·render.yaml 에는 시크릿 값을 싣지 않는다',
  '- admin 앱은 배포하지 않으므로 서비스 문서가 없다 (키 설명은 guide.yaml 참조)',
].join('\n') + '\n';
fs.writeFileSync(path.join(OUT, 'README.md'), readme);
generated.push('README.md');

console.log(`[docs] ${generated.length}개 문서 생성: ${generated.join(', ')}`);
