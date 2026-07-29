#!/usr/bin/env node
// server-mcp — 무의존성 MCP stdio 서버 (세트 기반 로컬 개발 서버 오케스트레이션)
//
// 세트 = { 번호 K, env, 포트 블록 } 로 정의되는 로컬 서버 묶음. 필요한 앱만 기동.
//   - 포트: base = 5200 + K*100. 오프셋 dibang+0 / guest+1 / landing+2 / admin+3 / api+80.
//   - env(local/dev/prod)·주소는 "런치 시점 주입"으로 고정 (전역 .env 심볼릭 무시, 주입이 우선).
//   - 장부: <project>/.claude/server-sets/set-{K}/{app}.json  (앱 1개 = 파일 1개)
//   - owner = 세트를 만든 패널(CMUX_SURFACE_ID). set_status 기본은 자기 owner 것만.
// 설계: _architecture/local-server-orchestration/DESIGN.md
// stdout에는 JSON-RPC만, 로그는 stderr로.

import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn, execSync } from 'node:child_process';

const OWNER = process.env.CMUX_SURFACE_ID || '';
const log = (...a) => process.stderr.write(`[server-mcp] ${a.join(' ')}\n`);
const now = () => new Date().toISOString();

// ---- 경로 ----
function projectDir() { return process.env.CLAUDE_PROJECT_DIR || process.cwd(); }
function setsRoot() { return path.join(projectDir(), '.claude', 'server-sets'); }
function setDir(K) { return path.join(setsRoot(), `set-${K}`); }
function appLedgerPath(K, app) { return path.join(setDir(K), `${app}.json`); }
function appLogPath(K, app) { return path.join(setDir(K), `${app}.log`); }
// 소스 트리 루트: 명시 경로(워크트리 등)가 있으면 그것, 없으면 프로젝트 기본(메인 체크아웃).
// 장부는 항상 setsRoot()=projectDir() 한 곳에 모이고, 소스 트리만 이 root로 분기한다.
function resolveSrcRoot(root) {
  if (!root) return projectDir();
  // 상대경로는 projectDir()(메인 체크아웃) 기준으로 해석 — MCP 프로세스의 cwd(워크트리일 수 있음)에
  // 의존하지 않게. 절대경로면 path.resolve가 base를 무시하므로 그대로 쓰인다.
  const abs = path.resolve(projectDir(), root);
  if (!fs.existsSync(path.join(abs, 'apps'))) throw new Error(`root에 apps/ 없음: ${abs}`);
  return abs;
}

// ---- 세트 모델 ----
// 앱별 포트 오프셋 + 실행 종류.
const APPS = {
  'dibang-wedding': { offset: 0, kind: 'fe' },
  'guest-web': { offset: 1, kind: 'fe' },
  'landing': { offset: 2, kind: 'fe' },
  'admin': { offset: 3, kind: 'fe' }, // 세트0 전용(런타임 토글). Phase2에서 3그룹 주입 완성.
  'api': { offset: 80, kind: 'api' },
};
const FE_APPS = ['dibang-wedding', 'guest-web', 'landing'];
// env(사용자 표기) -> .env 파일 접미사 / go -env 값
const ENV_SUFFIX = { local: 'localhost', dev: 'dev', prod: 'prod' };

// 세트 0~7 = 5200~5699. 6000번대는 prototype playground 예약 대역(6100+N×10)이라 건너뛰고,
// 세트 8~17 = 7000~7999. 18+는 8000번대(api 8080·invitation-shell 8090)와 충돌하므로 금지.
function basePort(K) {
  const n = Number(K);
  return n <= 7 ? 5200 + n * 100 : 7000 + (n - 8) * 100;
}
function appPort(K, app) {
  if (!(app in APPS)) throw new Error(`알 수 없는 앱: ${app}`);
  return basePort(K) + APPS[app].offset;
}
function defaultApps(K) {
  return Number(K) === 0
    ? ['dibang-wedding', 'guest-web', 'landing', 'admin', 'api']
    : ['dibang-wedding', 'guest-web', 'landing', 'api'];
}

// ---- .env 파싱 (KEY=VALUE, 주석/따옴표/export 처리) ----
function parseEnvFile(file) {
  const out = {};
  let txt;
  try { txt = fs.readFileSync(file, 'utf8'); } catch { return out; }
  for (let line of txt.split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice(7);
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

// ---- 주입 계산 ----
// FE: .env.<env>의 VITE_* 를 베이스로, 포트연동/상호참조 키만 세트 포트로 오버라이드.
// admin은 예외(크로스-env 콘솔): 단일 .env에 LOCAL/DEV/PROD 3그룹 보관(use-env.sh 제외, 런타임 토글).
//   → 매니저 결정 '정적 관례 매핑'으로 그룹 URL 고정 주입(아래 admin 블록 참조). env 인자 무관.
function computeFeEnv(K, app, env, root = projectDir()) {
  const url = (a) => `http://localhost:${appPort(K, a)}`;
  if (app === 'admin') {
    // 정적 관례 매핑(매니저 결정 2026-07-14, 링크 병기로 개정 2026-07-15):
    //   축 분리 — 토글 = 데이터 소스, 링크 = 화면 위치.
    //   PROD → API만 set0 api(:5280, prod DB) 주입. 링크 키(GUEST/DIBANG)는 .env의
    //          배포 URL 통과 — "PROD 토글 = 진짜 배포 링크". (이전: 링크까지 set0로 덮어
    //          admin에 localhost 링크가 노출되는 혼란 → 제거.)
    //   LOCAL → set1 블록(api 5380 / dibang 5300 / guest 5301)
    //   DEV  → .env 그대로(주입 안 함) — dev Supabase 이전 보류라 배선 대상 없음(편차, DESIGN §9 명시).
    //   SET  → admin이 뜬 세트 K의 로컬 FE 주소. FE가 배포 링크 옆에 [로컬 :52xx]를 병기하는 용도
    //          (server-mcp 런치에서만 존재 — 전역 .env 실행 시엔 병기 링크 미노출).
    //   Supabase(VITE_{ENV}_SUPABASE_*)는 그룹별 .env 값 유지. env 인자와 무관(관례 고정).
    //   대상 세트가 안 떠 있으면 연결 실패로 자연 강등(옛 8080/8082 미기동 때와 동일).
    const parsed = parseEnvFile(path.join(root, 'apps', 'admin', '.env'));
    const base = {};
    for (const [k, v] of Object.entries(parsed)) if (k.startsWith('VITE_')) base[k] = v;
    const at = (setNo, a) => `http://localhost:${appPort(setNo, a)}`;
    return {
      ...base,
      VITE_PROD_API_BASE_URL: at(0, 'api'),
      // VITE_PROD_{GUEST,DIBANG}_BASE_URL : 주입 안 함(.env의 배포 URL 통과)
      VITE_LOCAL_API_BASE_URL: at(1, 'api'),
      VITE_LOCAL_DIBANG_BASE_URL: at(1, 'dibang-wedding'),
      VITE_LOCAL_GUEST_BASE_URL: at(1, 'guest-web'),
      // VITE_DEV_* : 주입 안 함(.env 유지)
      VITE_SET_GUEST_BASE_URL: at(K, 'guest-web'), // 배포 링크 옆 [로컬] 병기용
    };
  }
  const suffix = ENV_SUFFIX[env];
  const parsed = parseEnvFile(path.join(root, 'apps', app, `.env.${suffix}`));
  const base = {};
  for (const [k, v] of Object.entries(parsed)) if (k.startsWith('VITE_')) base[k] = v;
  const override = { VITE_API_BASE_URL: url('api') };
  if (app === 'dibang-wedding') {
    override.VITE_GUEST_WEB_URL = url('guest-web');
    override.VITE_SITE_URL = url('dibang-wedding');
  } else if (app === 'guest-web') {
    override.VITE_DIBANG_URL = url('dibang-wedding');
    override.VITE_BASE_URL = url('guest-web');
  }
  return { ...base, ...override };
}
// 세트의 모든 FE origin (CORS 허용용). launch 여부와 무관하게 세트가 쓸 수 있는 전부.
function setOrigins(K) {
  const apps = FE_APPS.concat(Number(K) === 0 ? ['admin'] : []);
  const origins = apps.map((a) => `http://localhost:${appPort(K, a)}`);
  // admin은 세트0에만 뜨지만(관례) LOCAL 토글 시 세트1 api(:5380)를 호출한다(computeFeEnv at(1,'api')).
  // 그래서 모든 세트 api가 세트0 admin origin(:5203)을 허용해야 그 크로스 콜의 CORS가 통과한다.
  const admin0 = `http://localhost:${appPort(0, 'admin')}`;
  if (!origins.includes(admin0)) origins.push(admin0);
  return origins.join(',');
}
// API: -env <suffix>로 .env.<suffix> 로드(godotenv), 세트 고유값만 process env로 오버라이드.
function computeApiEnv(K, env, dbTarget) {
  const inj = {
    PORT: String(appPort(K, 'api')),
    ALLOWED_ORIGINS: setOrigins(K), // env=prod의 prod도메인 제한을 세트 localhost로 덮음
  };
  if (dbTarget && dbTarget.startsWith('branch:')) {
    // 실제 DB명은 branch_<name> (set_db_branch가 붙이는 prefix와 일치해야 함).
    const name = dbTarget.slice('branch:'.length).replace(/[^a-zA-Z0-9_]/g, '_');
    inj.DATABASE_URL = `postgresql://postgres:postgres@127.0.0.1:54322/branch_${name}?default_query_exec_mode=simple_protocol`;
  }
  return inj;
}

// ---- 실행 커맨드 ----
function launchSpec(K, app, env, dbTarget, root = projectDir()) {
  const port = appPort(K, app);
  if (APPS[app].kind === 'fe') {
    return {
      cmd: 'pnpm', args: ['exec', 'vite', '--port', String(port), '--strictPort'],
      cwd: path.join(root, 'apps', app),
      env: { ...process.env, ...computeFeEnv(K, app, env, root) },
      port,
    };
  }
  // api
  return {
    cmd: 'go', args: ['run', '.', '-env', ENV_SUFFIX[env]],
    cwd: path.join(root, 'apps', 'api'),
    env: { ...process.env, ...computeApiEnv(K, env, dbTarget) },
    port,
  };
}

// ---- 프로세스 생명주기 ----
function portListening(port, cb) {
  // Vite는 ::1(IPv6), Go는 IPv4-mapped 등 바인딩이 제각각 → 두 스택 모두 확인.
  let settled = false;
  const done = (v) => { if (!settled) { settled = true; cb(v); } };
  const tryHost = (host, next) => {
    const sock = net.connect({ host, port, timeout: 400 });
    sock.on('connect', () => { try { sock.destroy(); } catch {} done(true); });
    sock.on('error', () => { try { sock.destroy(); } catch {} next(); });
    sock.on('timeout', () => { try { sock.destroy(); } catch {} next(); });
  };
  tryHost('127.0.0.1', () => tryHost('::1', () => done(false)));
}
function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}
function killTree(pid) {
  if (!pid) return;
  // detached 로 띄운 자식은 그룹 리더 → 음수 pid로 그룹 전체 종료.
  try { process.kill(-pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch {} }
}
function spawnDetached(spec, logPath) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const out = fs.openSync(logPath, 'a');
  fs.writeSync(out, `\n===== ${now()} launch: ${spec.cmd} ${spec.args.join(' ')} (cwd=${spec.cwd}) =====\n`);
  const child = spawn(spec.cmd, spec.args, {
    cwd: spec.cwd, env: spec.env, detached: true, stdio: ['ignore', out, out],
  });
  child.unref();
  return child.pid;
}

// ---- 로컬 Supabase 보장 (task 7) ----
function localSupabaseUp() {
  return new Promise((res) => portListening(54322, res)); // Postgres 포트로 판정
}
async function ensureLocalSupabase() {
  if (await localSupabaseUp()) return { started: false, ok: true };
  log('local supabase 미기동 → supabase start (시간 걸릴 수 있음)');
  try {
    execSync('supabase start', { cwd: projectDir(), stdio: 'ignore', timeout: 180000 });
    return { started: true, ok: await localSupabaseUp() };
  } catch (e) {
    return { started: false, ok: false, error: e.message };
  }
}

// ---- 장부 R/W ----
function writeLedger(rec) {
  fs.mkdirSync(setDir(rec.set), { recursive: true });
  const tmp = appLedgerPath(rec.set, rec.app) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(rec, null, 2) + '\n');
  fs.renameSync(tmp, appLedgerPath(rec.set, rec.app));
}
function readLedger(K, app) {
  try { return JSON.parse(fs.readFileSync(appLedgerPath(K, app), 'utf8')); } catch { return null; }
}
function listSetNumbers() {
  try {
    return fs.readdirSync(setsRoot(), { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^set-\d+$/.test(d.name))
      .map((d) => Number(d.name.slice(4)))
      .sort((a, b) => a - b);
  } catch { return []; }
}
function readSetRecords(K) {
  const dir = setDir(K);
  let files;
  try { files = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try { out.push(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))); } catch {}
  }
  return out.sort((a, b) => APPS[a.app]?.offset - APPS[b.app]?.offset);
}
function removeLedger(K, app) {
  try { fs.unlinkSync(appLedgerPath(K, app)); } catch {}
}

// ---- 렌더 ----
async function renderSet(K, showOwner) {
  const recs = readSetRecords(K);
  if (!recs.length) return `set-${K}: (비어 있음)`;
  const env = recs[0].env;
  const own = showOwner && recs[0].owner ? `  @${String(recs[0].owner).slice(0, 8)}` : '';
  // 소스 트리가 메인 체크아웃과 다르면(워크트리) basename 병기 — "장부엔 없는데 포트 점유" 혼선 방지.
  const src = recs[0].root && path.resolve(recs[0].root) !== projectDir() ? `  src=${path.basename(recs[0].root)}` : '';
  const lines = [];
  for (const r of recs) {
    const alive = pidAlive(r.pid);
    const listening = await new Promise((res) => portListening(r.port, res));
    const st = alive && listening ? 'up' : alive ? 'starting?' : 'dead';
    const mark = st === 'up' ? '●' : st === 'dead' ? '○' : '◐';
    lines.push(`    ${mark} ${r.app.padEnd(15)} :${r.port}  ${st.padEnd(9)} pid=${r.pid}  ${r.url}`);
  }
  return `  set-${K} [env=${env}] db=${recs[0].dbTarget}${src}${own}\n${lines.join('\n')}`;
}

// ---- tool 구현 ----
async function toolSetUp({ set, apps, env, db_branch, dry_run, root }) {
  if (set == null) throw new Error('set(세트 번호)은 필수입니다.');
  const K = Number(set);
  if (!Number.isInteger(K) || K < 0 || K > 17) throw new Error('set은 0~17 정수 — 0~7은 5200~5699, 8~17은 7000~7999 (6000번대는 prototype playground 예약이라 건너뜀, 18+는 8000번대 api·invitation-shell과 충돌).');
  env = env || (K === 0 ? 'prod' : 'local'); // 세트0 기본 prod(확인용), 그외 local
  if (!(env in ENV_SUFFIX)) throw new Error(`env는 local|dev|prod 중 하나. 받은 값: ${env}`);
  let list = apps && apps.length ? apps : defaultApps(K);
  for (const a of list) if (!(a in APPS)) throw new Error(`알 수 없는 앱: ${a}`);

  const dbTarget = db_branch ? `branch:${db_branch}` : (env === 'local' ? 'shared' : env);
  const srcRoot = resolveSrcRoot(root); // 워크트리 경로 주어지면 그 트리에서 기동

  // dry_run: 실제 기동/장부/Supabase 없이 계산된 포트·주입 계획만 반환(set0 비파괴 검증용).
  if (dry_run) {
    const lines = [`(dry-run) set-${K} [env=${env}] db=${dbTarget} — 계획만, 기동 안 함`];
    for (const app of list) {
      const port = appPort(K, app);
      if (app === 'api') {
        const inj = computeApiEnv(K, env, dbTarget);
        lines.push(`  ${app.padEnd(15)} :${port}  go run . -env ${ENV_SUFFIX[env]}`);
        lines.push(`      PORT=${inj.PORT}  ALLOWED_ORIGINS=${inj.ALLOWED_ORIGINS}${inj.DATABASE_URL ? '  DATABASE_URL=…/branch_' + dbTarget.slice('branch:'.length) : ''}`);
      } else {
        const fe = computeFeEnv(K, app, env, srcRoot);
        const shown = Object.entries(fe).filter(([k]) => !/ANON_KEY/.test(k)).sort();
        lines.push(`  ${app.padEnd(15)} :${port}  vite  (주입 ${shown.length}키, ANON_KEY 마스킹)`);
        for (const [k, v] of shown) lines.push(`      ${k}=${v}`);
      }
    }
    return lines.join('\n');
  }

  // 로컬 Supabase 필요 시 보장 (local + api 포함)
  let sbNote = '';
  if ((env === 'local' || (dbTarget && dbTarget.startsWith('branch:'))) && list.includes('api')) {
    const r = await ensureLocalSupabase();
    if (!r.ok) sbNote = `\n⚠ 로컬 Supabase 미가동(${r.error || 'start 실패'}) — api가 DB 연결 실패할 수 있음.`;
    else if (r.started) sbNote = '\n(로컬 Supabase 새로 기동함)';
  }

  const started = [];
  const skipped = [];
  for (const app of list) {
    const port = appPort(K, app);
    // 이미 우리 장부에 살아있으면 스킵
    const existing = readLedger(K, app);
    if (existing && pidAlive(existing.pid)) { skipped.push(`${app}(이미 실행중 pid=${existing.pid})`); continue; }
    // 남이 그 포트를 쓰면 에러성 스킵
    const busy = await new Promise((res) => portListening(port, res));
    if (busy) { skipped.push(`${app}(:${port} 이미 점유 — 다른 프로세스)`); continue; }
    let pid;
    try {
      const spec = launchSpec(K, app, env, dbTarget, srcRoot);
      pid = spawnDetached(spec, appLogPath(K, app));
    } catch (e) { skipped.push(`${app}(기동실패: ${e.message})`); continue; }
    writeLedger({
      set: K, owner: OWNER, app, env, dbTarget, root: srcRoot,
      port, url: `http://localhost:${port}`,
      pid, logPath: path.relative(projectDir(), appLogPath(K, app)),
      startedAt: now(), status: 'starting',
    });
    started.push(`${app}:${port}`);
  }
  const head = `set-${K} [env=${env}] db=${dbTarget} — 기동: ${started.join(', ') || '(없음)'}${skipped.length ? `\n  스킵: ${skipped.join(', ')}` : ''}${sbNote}`;
  return `${head}\n\n${await renderSet(K, false)}\n\n(현황: set_status / 로그: set_logs{set:${K},app} / 종료: set_down{set:${K}})`;
}

async function toolSetDown({ set, apps }) {
  if (set == null) throw new Error('set은 필수입니다.');
  const K = Number(set);
  const list = apps && apps.length ? apps : readSetRecords(K).map((r) => r.app);
  const killed = [];
  for (const app of list) {
    const rec = readLedger(K, app);
    if (rec) { killTree(rec.pid); removeLedger(K, app); killed.push(`${app}(pid=${rec.pid})`); }
  }
  // 세트 폴더가 비면 제거
  try { if (!readSetRecords(K).length) fs.rmSync(setDir(K), { recursive: true, force: true }); } catch {}
  return `set-${K} 종료: ${killed.join(', ') || '(장부에 항목 없음)'}`;
}

async function toolSetStatus({ set, all, prune }) {
  const mineOnly = !all;
  const nums = set != null ? [Number(set)] : listSetNumbers();
  let pruned = 0;
  if (prune) {
    // 죽은(pid dead) 내 owner 항목을 장부에서 정리 — 장부↔실프로세스 동기화(고아 방지).
    for (const K of listSetNumbers()) {
      for (const r of readSetRecords(K)) {
        if (!pidAlive(r.pid) && (r.owner || '') === OWNER) { removeLedger(K, r.app); pruned++; }
      }
      try { if (!readSetRecords(K).length) fs.rmSync(setDir(K), { recursive: true, force: true }); } catch {}
    }
  }
  const blocks = [];
  for (const K of nums) {
    const recs = readSetRecords(K);
    if (!recs.length) continue;
    if (mineOnly && (recs[0].owner || '') !== OWNER) continue;
    blocks.push(await renderSet(K, !!all));
  }
  const foot = prune ? `\n(prune: 죽은 항목 ${pruned}건 정리)` : '';
  if (!blocks.length) return (mineOnly ? '내 세트 없음 (다른 패널 것 보려면 all:true).' : '떠 있는 세트 없음. set_up으로 시작.') + foot;
  return `현황판 (● up / ◐ starting / ○ dead)\n${blocks.join('\n')}${foot}`;
}

function toolSetLogs({ set, app, tail }) {
  if (set == null || !app) throw new Error('set, app은 필수입니다.');
  const p = appLogPath(Number(set), app);
  let txt;
  try { txt = fs.readFileSync(p, 'utf8'); } catch { return `로그 없음: ${path.relative(projectDir(), p)}`; }
  const lines = txt.split(/\r?\n/);
  const n = tail && tail > 0 ? tail : 60;
  return `[set-${set}/${app} 로그 마지막 ${n}줄]\n${lines.slice(-n).join('\n')}`;
}

async function toolSetEnv({ set, env }) {
  if (set == null || !env) throw new Error('set, env는 필수입니다.');
  if (!(env in ENV_SUFFIX)) throw new Error(`env는 local|dev|prod 중 하나.`);
  const K = Number(set);
  const recs = readSetRecords(K);
  const apps = recs.map((r) => r.app);
  if (!apps.length) throw new Error(`set-${K}에 실행 중인 앱이 없음. set_up을 먼저.`);
  const root = recs[0].root; // 워크트리 소스면 그대로 유지해 재기동
  await toolSetDown({ set: K });
  return `env 전환 재기동 →\n${await toolSetUp({ set: K, apps, env, root })}`;
}

// 형제 DB 복제(같은 로컬 postgres 클러스터 54322). auth/storage/public 통째 복제 → 그 세트 api를 격리 DB로.
// prod/dev와 무관(로컬 전용). CREATE DATABASE TEMPLATE는 template 무접속 요구라 회피 → pg_dump|psql.
async function toolSetDbBranch({ set, name, drop }) {
  if (!name) throw new Error('name(브랜치 이름)은 필수입니다.');
  const branchDb = `branch_${String(name).replace(/[^a-zA-Z0-9_]/g, '_')}`;
  const conn = `-h 127.0.0.1 -p 54322 -U postgres`;
  const sh = (cmd) => execSync(cmd, { shell: '/bin/bash', encoding: 'utf8', env: { ...process.env, PGPASSWORD: 'postgres' } });
  if (drop) {
    sh(`dropdb ${conn} --if-exists ${branchDb}`);
    return `격리 DB ${branchDb} 삭제됨.`;
  }
  if (!(await localSupabaseUp())) throw new Error('로컬 Supabase(54322) 미기동 — 먼저 기동 필요.');
  const exists = sh(`psql ${conn} -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='${branchDb}'"`).trim();
  let note;
  if (exists === '1') note = `${branchDb} 이미 존재 → 재사용`;
  else {
    // pg_dump는 서버 버전과 일치해야 함(호스트 pg_dump 14 ≠ 서버 17) → 클론은 supabase_db 컨테이너 내부(PG17)에서.
    // --no-owner --no-privileges 로 role/권한 에러 최소화. supabase 부수 객체 에러는 무시(ON_ERROR_STOP=0).
    const container = sh(`docker ps --format '{{.Names}}' | grep '^supabase_db' | head -1`).trim();
    if (!container) throw new Error('supabase_db 컨테이너를 못 찾음 — 로컬 Supabase 기동 필요.');
    const shq = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
    const dex = (inner) => execSync(`docker exec ${container} sh -c ${shq(inner)}`, { encoding: 'utf8' });
    sh(`createdb ${conn} ${branchDb}`);
    dex(`export PGPASSWORD=postgres; pg_dump --no-owner --no-privileges -h 127.0.0.1 -U postgres -d postgres -f /tmp/${branchDb}.sql`);
    dex(`export PGPASSWORD=postgres; psql -q -v ON_ERROR_STOP=0 -h 127.0.0.1 -U postgres -d ${branchDb} -f /tmp/${branchDb}.sql; rm -f /tmp/${branchDb}.sql`);
    note = `${branchDb} 생성+복제(auth/storage/public)`;
  }
  // set 주어지면 그 세트 api를 branch로 재기동(로컬 전용 → env=local 고정, auth/storage 공유). 없으면 생성만.
  let relaunch;
  if (set != null) {
    const K = Number(set);
    const apiRec = readSetRecords(K).find((r) => r.app === 'api');
    if (apiRec) {
      await toolSetDown({ set: K, apps: ['api'] });
      await toolSetUp({ set: K, apps: ['api'], env: 'local', db_branch: name, root: apiRec.root });
      relaunch = `\nset-${K} api를 ${branchDb}로 재기동(env=local, auth/storage 공유).`;
    } else {
      relaunch = `\n(set-${K} api 미실행 — set_up{set:${K}, apps:["api"], env:"local", db_branch:"${name}"}로 연결)`;
    }
  } else {
    relaunch = `\n(생성만 — set_up{apps:["api"], env:"local", db_branch:"${name}"}로 원하는 세트에 연결)`;
  }
  return `${note}.${relaunch}`;
}

// ---- 도구 스키마 ----
const TOOLS = [
  {
    name: 'set_up',
    description: '세트의 서버들을 기동한다. 포트 블록: 세트 0~7=5200+K*100, 8~17=7000+(K-8)*100 (6000번대는 prototype 예약이라 건너뜀). 블록에 앱별 오프셋(dibang+0/guest+1/landing+2/admin+3/api+80). env(local|dev|prod)·주소는 런치 시점 주입으로 고정(전역 .env 무시). apps 생략 시 기본(세트0=4앱+api, 그외=3앱+api). 앱 1개=detached 프로세스 1개+로그파일, 장부(.claude/server-sets)에 기록.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        set: { type: 'integer', description: '세트 번호(0=매니저). 포트 블록 = 5200+set*100.' },
        apps: { type: 'array', items: { type: 'string' }, description: "기동할 앱들(생략 시 기본). 예: ['dibang-wedding','api']" },
        env: { type: 'string', enum: ['local', 'dev', 'prod'], description: '데이터 소스. 생략 시 세트0=prod, 그외=local.' },
        db_branch: { type: 'string', description: '(Phase3) 격리 DB 이름. 지정 시 api DATABASE_URL을 그 브랜치로.' },
        dry_run: { type: 'boolean', description: 'true면 실제 기동 없이 계산된 포트·주입 계획만 반환(비파괴 검증).' },
        root: { type: 'string', description: '소스 트리 경로(워크트리 등). 생략 시 메인 체크아웃(CLAUDE_PROJECT_DIR). 장부는 항상 메인에 모이고 record.root로 소스를 추적한다. 예: .claude/worktrees/<name>' },
      },
      required: ['set'],
    },
  },
  {
    name: 'set_down',
    description: '세트의 서버들을 종료하고 장부에서 정리한다. detached 그룹 전체 kill. apps 생략 시 세트 전체.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        set: { type: 'integer', description: '세트 번호' },
        apps: { type: 'array', items: { type: 'string' }, description: '일부만 내릴 때(선택)' },
      },
      required: ['set'],
    },
  },
  {
    name: 'set_status',
    description: '세트 현황판. 기본은 내 패널(owner) 세트만, all:true면 전체(@owner 표기, 매니저용). 각 앱의 env·데이터소스·포트·URL·pid·생존상태(● up/◐ starting/○ dead)를 보여준다.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        set: { type: 'integer', description: '특정 세트만(선택)' },
        all: { type: 'boolean', description: 'true면 다른 패널 세트 포함 전체.' },
        prune: { type: 'boolean', description: 'true면 죽은(pid dead) 내 장부 항목을 정리(고아 방지).' },
      },
    },
  },
  {
    name: 'set_logs',
    description: '세트 앱의 로그 파일 tail.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        set: { type: 'integer', description: '세트 번호' },
        app: { type: 'string', description: '앱 이름' },
        tail: { type: 'integer', description: '마지막 N줄(기본 60)' },
      },
      required: ['set', 'app'],
    },
  },
  {
    name: 'set_env',
    description: '세트를 새 env로 재기동(down→up). 실행 중이던 앱 구성을 유지한 채 데이터 소스만 전환.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        set: { type: 'integer', description: '세트 번호' },
        env: { type: 'string', enum: ['local', 'dev', 'prod'], description: '전환할 데이터 소스' },
      },
      required: ['set', 'env'],
    },
  },
  {
    name: 'set_db_branch',
    description: '로컬 postgres(54322)를 형제 DB(branch_<name>)로 복제하고 그 세트 api를 격리 DB에 연결(env=local, auth/storage 공유). prod/dev 무관·로컬 전용. drop:true면 그 격리 DB 삭제.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        set: { type: 'integer', description: '격리 DB에 연결할 세트(삭제만 할 땐 생략 가능)' },
        name: { type: 'string', description: '브랜치 이름 → branch_<name> DB' },
        drop: { type: 'boolean', description: 'true면 branch_<name> 삭제(연결 해제 후).' },
      },
      required: ['name'],
    },
  },
];
const DISPATCH = {
  set_up: toolSetUp, set_down: toolSetDown, set_status: toolSetStatus,
  set_logs: toolSetLogs, set_env: toolSetEnv, set_db_branch: toolSetDbBranch,
};

// ---- MCP stdio (JSON-RPC 2.0, newline-delimited) ----
function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }
function reply(id, result) { send({ jsonrpc: '2.0', id, result }); }
function replyErr(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }); }

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    return reply(id, {
      protocolVersion: params?.protocolVersion || '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'server-mcp', version: '0.1.0' },
    });
  }
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return;
  if (method === 'ping') return reply(id, {});
  if (method === 'tools/list') return reply(id, { tools: TOOLS });
  if (method === 'tools/call') {
    const fn = DISPATCH[params?.name];
    if (!fn) return reply(id, { content: [{ type: 'text', text: `알 수 없는 도구: ${params?.name}` }], isError: true });
    try {
      const text = await fn(params.arguments || {});
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
    Promise.resolve(handle(msg)).catch((e) => log('handle error:', e.message));
  }
});
process.stdin.on('end', () => process.exit(0));
log(`started. projectDir=${projectDir()}`);
