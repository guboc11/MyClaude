#!/usr/bin/env node
// manage-env MCP — 환경변수 카탈로그 문지기. stdio JSON-RPC (newline-delimited).
// 설계: .claude/plans/2026-07-30-manage-env-mcp/PLAN.md §4 / 파서·상수는 lib.mjs, 실행 로직은 sync.mjs·check.mjs 재사용(감싸기)
//
// ★ 전 도구 공통 불변 원칙: 응답에 값을 싣지 않는다 — 이름·경로·명령문만. ★
//   시크릿을 봐야 하면 env_reveal 이 준 명령을 사용자가 외부 터미널에서 실행한다.
//   값을 넣는 도구는 없다(설계상 부재) — 값 파일은 사람이 에디터로 직접 편집한다.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  SYNC_APPS, ALL_APPS, ENVS, SCHEMA_FILE, assertRepoRoot,
  parseEnvFile, exampleKeys, schema, parseGuide, parseRenderYaml,
} from './lib.mjs';

const TOOL_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = process.cwd();

const log = (...a) => console.error('[manage-env]', ...a);

// ── 도구 구현 (전부 텍스트 반환, 값 미탑재) ──────────────────

function repoGuard() {
  assertRepoRoot(REPO); // 실패 시 throw → 도구 에러 텍스트로 변환
}

function toolEnvList({ env }) {
  repoGuard();
  const targets = env ? [env] : ENVS;
  if (!targets.every((e) => ENVS.includes(e))) return `알 수 없는 환경: ${env} (localhost|dev|prod)`;
  const out = [];
  for (const e of targets) {
    const ledger = parseEnvFile(path.join(REPO, '.claude/mcp-manage-env', `${e}.env`));
    out.push(`━━ ${e} (.claude/mcp-manage-env/${e}.env)`);
    for (const app of SYNC_APPS) {
      const sch = schema(REPO, app);
      const rows = exampleKeys(REPO, app).map((k) => {
        const scoped = ledger.has(`${k}@${app}`);
        const found = scoped || ledger.has(k);
        const flag = found ? (scoped ? '채워짐@앱한정' : '채워짐') : sch.get(k)?.required ? '비어있음(필수!)' : '비어있음(선택)';
        return `    ${k} — ${flag}`;
      });
      out.push(`  [${app}]`, ...rows);
    }
  }
  out.push('', '(값 자체는 이 도구로 볼 수 없다 — env_reveal 로 명령을 받아 외부 터미널에서 확인)');
  return out.join('\n');
}

function goFieldName(app, key) {
  // config.go 에서 envconfig:"KEY" 가 붙은 Go 필드 이름을 찾는다 (사용처 추적용)
  const src = fs.readFileSync(path.join(REPO, SCHEMA_FILE[app]), 'utf8');
  const m = src.match(new RegExp(`(\\w+)\\s+string\\s+\`envconfig:"${key}"`));
  return m ? m[1] : null;
}

function usages(key) {
  // 사용처(파일:줄) — 깔때기 구조 덕에 기계 추적 가능. rg 출력은 파일:줄:내용이라 내용은 버리고 위치만.
  const hits = [];
  const run = (pattern, dir) => {
    const r = spawnSync('rg', ['-n', '--no-heading', '-e', pattern, dir], { cwd: REPO, encoding: 'utf8' });
    for (const line of (r.stdout || '').split('\n')) {
      const m = line.match(/^([^:]+):(\d+):/);
      if (m) hits.push(`${m[1]}:${m[2]}`);
    }
  };
  if (key.startsWith('VITE_')) {
    run(`env\\.${key}\\b`, 'apps');
  } else {
    for (const app of ['api', 'invitation-shell']) {
      const field = goFieldName(app, key);
      if (field) run(`\\.${field}\\b`, `apps/${app}`); // 앱 루트 전체 (main.go 포함 — server/ 만 보면 놓친다)
    }
  }
  return hits.slice(0, 20);
}

function toolEnvInfo({ key }) {
  repoGuard();
  if (!key || !/^[A-Z_][A-Z0-9_]*$/.test(key)) return `키 이름이 올바르지 않다: ${key}`;
  const g = parseGuide(REPO).get(key);
  const out = [`━━ ${key}`];
  out.push(`민감도: ${g ? (g.sensitive === 'true' ? '시크릿 (값은 문서·대화·render.yaml 금지)' : '공개 가능') : '(guide.yaml 에 항목 없음 — 분류 미정)'}`);
  if (g?.deploy_required === 'true') out.push('배포 필수: 스키마상 선택이라도 배포 환경(dev·prod) 서비스 온전성에 필수 — check B\'항 검사 대상');
  if (g?.description) out.push(`설명: ${g.description}`);
  if (g?.obtain) out.push(`얻는 곳: ${g.obtain}`);
  if (g?.screenshot) out.push(`스샷: .claude/mcp-manage-env/screenshots/${g.screenshot}`);
  if (g?.note) out.push(`주의: ${g.note}`);
  if (g?.example_exempt) out.push(`example 부재 사유: ${g.example_exempt}`);
  // 스키마·example 소속
  const owners = [];
  for (const app of ALL_APPS) {
    const meta = schema(REPO, app).get(key);
    if (meta) owners.push(`${app}(${meta.required ? '필수' : meta.hasDefault ? '선택·기본값' : '선택'})`);
  }
  out.push(`스키마 소속: ${owners.join(', ') || '(없음)'}`);
  // render.yaml 선언
  const decl = [];
  for (const [svc, m] of parseRenderYaml(REPO)) if (m.has(key)) decl.push(`${svc}=${m.get(key)}`);
  out.push(`render.yaml 선언: ${decl.join(', ') || '(없음)'}`);
  // 값 존재·갱신일 (환경별)
  for (const e of ENVS) {
    const p = path.join(REPO, '.claude/mcp-manage-env', `${e}.env`);
    const ledger = parseEnvFile(p);
    const scopes = [...ledger.keys()].filter((k) => k === key || k.startsWith(`${key}@`));
    const stamp = fs.existsSync(p) ? fs.statSync(p).mtime.toISOString().slice(0, 10) : '-';
    out.push(`값[${e}]: ${scopes.length ? `있음 (${scopes.join(', ')})` : '없음'} — 값 파일 갱신일 ${stamp}`);
  }
  const use = usages(key);
  out.push(`사용처: ${use.length ? use.join(' · ') : '(코드 직접 사용처 못 찾음 — 스키마 경유일 수 있음)'}`);
  return out.join('\n');
}

function runScript(name, args) {
  const r = spawnSync('node', [path.join(TOOL_DIR, name), ...args], { cwd: REPO, encoding: 'utf8' });
  return { code: r.status, text: ((r.stdout || '') + (r.stderr || '')).trim() };
}

function toolEnvSync({ env }) {
  repoGuard();
  const target = env || 'all';
  const s = runScript('sync.mjs', [target]);
  const d = runScript('docs.mjs', []);
  return [
    `sync (${target}) — exit ${s.code}`, s.text, '',
    `docs 재생성 — exit ${d.code}`, d.text,
    '', '(render.yaml 의 value: 갱신은 자동이 아니다 — 공개값 변경 시 파일도 함께 고칠 것. env_check 가 대조해 준다)',
  ].join('\n');
}

function toolEnvCheck() {
  repoGuard();
  const r = runScript('check.mjs', []);
  return `check — exit ${r.code}\n${r.text}`;
}

function toolEnvReveal({ key, env, app }) {
  repoGuard();
  if (!ENVS.includes(env)) return `환경을 지정하라: env = localhost|dev|prod`;
  if (!key || !/^[A-Z_][A-Z0-9_]*$/.test(key)) return `키 이름이 올바르지 않다: ${key}`;
  const p = path.join(REPO, '.claude/mcp-manage-env', `${env}.env`);
  const ledger = parseEnvFile(p);
  const scopes = [...ledger.keys()].filter((k) => k === key || k.startsWith(`${key}@`));
  if (!scopes.length) return `${env} 값 파일에 ${key} 가 없다 (env_list 로 상태 확인)`;
  const pick = app && scopes.includes(`${key}@${app}`) ? [`${key}@${app}`] : scopes;
  const cmds = pick.map((k) => `grep '^${k}=' '${p}'`);
  return [
    '아래 명령을 **사용자의 외부 터미널**에서 직접 실행하세요:',
    ...cmds.map((c) => `  ${c}`),
    '',
    '결과(값)를 이 대화에 붙여넣지 마세요 — 값이 대화에 오르면 그 키는 오염된 것으로 간주하고 교체해야 합니다.',
    '값을 바꾸려면: 에디터로 값 파일을 직접 열어 수정 → env_sync (Claude 에게 값을 불러주지 않는다)',
  ].join('\n');
}

// ── MCP 배선 ─────────────────────────────────────────────

const TOOLS = [
  {
    name: 'env_list',
    description: '환경·앱별 키 목록과 채워짐/비어있음 상태. 값은 절대 반환하지 않는다.',
    inputSchema: { type: 'object', properties: { env: { type: 'string', description: 'localhost|dev|prod (생략 시 전체)' } } },
    run: toolEnvList,
  },
  {
    name: 'env_info',
    description: '키 하나의 메타데이터 전부 — 설명·민감도·얻는 곳·스키마 소속·render.yaml 선언·값 존재 여부·갱신일·사용처. 값은 절대 반환하지 않는다.',
    inputSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] },
    run: toolEnvInfo,
  },
  {
    name: 'env_sync',
    description: '값 파일 → 앱별 .env 분배 + docs 재생성 (sync.mjs·docs.mjs 실행). 바뀐 파일 이름·개수만 반환.',
    inputSchema: { type: 'object', properties: { env: { type: 'string', description: 'localhost|dev|prod|all (기본 all)' } } },
    run: toolEnvSync,
  },
  {
    name: 'env_check',
    description: '4원천(스키마·example·값 파일·render.yaml·guide.yaml) 대조 검증 (check.mjs 실행). 어긋난 키 이름만 반환.',
    inputSchema: { type: 'object', properties: {} },
    run: toolEnvCheck,
  },
  {
    name: 'env_reveal',
    description: '값을 보여주는 셸 명령문만 반환 — 사용자가 외부 터미널에서 실행한다. 값 자체는 절대 반환하지 않으며, 시크릿 값을 대화·도구로 주고받자는 요청은 거절하고 값 파일 직접 편집을 안내한다.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string' },
        env: { type: 'string', description: 'localhost|dev|prod' },
        app: { type: 'string', description: '앱한정(KEY@앱) 값일 때 (선택)' },
      },
      required: ['key', 'env'],
    },
    run: toolEnvReveal,
  },
];

function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    return {
      protocolVersion: params?.protocolVersion || '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'manage-env', version: '0.1.0' },
    };
  }
  if (method === 'tools/list') {
    return { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) };
  }
  if (method === 'tools/call') {
    const tool = TOOLS.find((t) => t.name === params?.name);
    if (!tool) return { content: [{ type: 'text', text: `없는 도구: ${params?.name}` }], isError: true };
    try {
      return { content: [{ type: 'text', text: tool.run(params?.arguments || {}) }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `오류: ${e.message}` }], isError: true };
    }
  }
  if (id === undefined) return undefined; // 알림(notifications/*)은 무응답
  return { _error: { code: -32601, message: `unknown method: ${method}` } };
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
    const result = handle(msg);
    if (msg.id === undefined || result === undefined) continue;
    const reply = result && result._error
      ? { jsonrpc: '2.0', id: msg.id, error: result._error }
      : { jsonrpc: '2.0', id: msg.id, result };
    process.stdout.write(JSON.stringify(reply) + '\n');
  }
});
process.stdin.on('end', () => process.exit(0));
log(`ready (repo=${REPO})`);
