// manage-env lib — 파서·상수의 단일 원천. sync.mjs · check.mjs · docs.mjs · server.mjs 가 공유한다.
// 불변 원칙: 여기 함수들은 값을 반환값 안에서만 다룬다 — 절대 출력(console)하지 않는다.

import fs from 'node:fs';
import path from 'node:path';

export const SYNC_APPS = ['api', 'dibang-wedding', 'guest-web'];
export const ALL_APPS = ['api', 'invitation-shell', 'dibang-wedding', 'guest-web', 'admin'];
export const ENVS = ['localhost', 'dev', 'prod'];
export const KEY_RE = /^[A-Z_][A-Z0-9_]*(@[a-z-]+)?$/;

export const SCHEMA_FILE = {
  api: 'apps/api/server/config.go',
  'invitation-shell': 'apps/invitation-shell/config.go',
  'dibang-wedding': 'apps/dibang-wedding/src/env.ts',
  'guest-web': 'apps/guest-web/src/env.ts',
  admin: 'apps/admin/src/env.ts',
};

// Render 서비스명 → 앱 (landing 은 env 없음 → null)
export const SERVICE_APP = {
  'dibang-wedding-dev': 'dibang-wedding',
  'dibang-guest-web-dev': 'guest-web',
  'dibang-api-dev': 'api',
  'dibang-invitation-shell-dev': 'invitation-shell',
  'dibang-landing-dev': null,
  'dibang-wedding': 'dibang-wedding',
  'dibang-guest-web': 'guest-web',
  'dibang-api': 'api',
  'dibang-invitation-shell': 'invitation-shell',
  'dibang-landing': null,
};

/** 레포 루트 확인 — .claude/env 가 있어야 한다. 없으면 throw. */
export function assertRepoRoot(repo) {
  if (!fs.existsSync(path.join(repo, '.claude', 'env'))) {
    throw new Error('.claude/env 가 없는 위치입니다 — 레포 루트에서 실행하세요.');
  }
}

/** KEY=값 텍스트 파싱 (첫 등장 우선, 주석·빈 줄 무시). 값은 Map 안에서만. */
export function parseEnvText(text) {
  const m = new Map();
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq);
    if (!KEY_RE.test(key)) continue;
    if (!m.has(key)) m.set(key, line.slice(eq + 1));
  }
  return m;
}

/** KEY=값 파일 파싱 — parseEnvText 의 파일 입구. */
export function parseEnvFile(p) {
  if (!fs.existsSync(p)) return new Map();
  return parseEnvText(fs.readFileSync(p, 'utf8'));
}

/** 앱의 분배 명세 = .env.example 키 목록 (순서 보존) */
export function exampleKeys(repo, app) {
  return [...parseEnvFile(path.join(repo, 'apps', app, '.env.example')).keys()];
}

/** 앱 스키마: Map<키, {required, hasDefault}> — 코드에서 읽기 전용 수집. */
export function schema(repo, app) {
  const m = new Map();
  const file = SCHEMA_FILE[app];
  const src = fs.readFileSync(path.join(repo, file), 'utf8');
  if (file.endsWith('.go')) {
    for (const g of src.matchAll(/envconfig:"([A-Z0-9_]+)"([^`\n]*)/g)) {
      m.set(g[1], { required: g[2].includes('required:"true"'), hasDefault: g[2].includes('default:"') });
    }
  } else {
    for (const g of src.matchAll(/^\s*(VITE_[A-Z0-9_]+):\s*(z\..+?),?\s*$/gm)) {
      m.set(g[1], { required: !g[2].includes('.optional()'), hasDefault: false });
    }
  }
  return m;
}

/** guide.yaml 최소 파서 — 2단(키 → 한 줄 문자열 필드) 고정 형식 전용. 없으면 빈 Map. */
export function parseGuide(repo) {
  const guide = new Map();
  const p = path.join(repo, '.claude/env/guide.yaml');
  if (!fs.existsSync(p)) return guide;
  let current = null;
  for (const raw of fs.readFileSync(p, 'utf8').split('\n')) {
    const top = raw.match(/^([A-Z_][A-Z0-9_]*):\s*$/);
    if (top) { current = {}; guide.set(top[1], current); continue; }
    if (!current) continue;
    const field = raw.match(/^  ([a-z_]+):\s*(.*)$/);
    if (field) current[field[1]] = field[2].replace(/^"|"$/g, '');
  }
  return guide;
}

/** guide.yaml 의 섹션 구조: [{title, keys[]}] — 값 파일 재작성 시 같은 섹션 제목을 재생성해
 *  카탈로그와 값 파일의 시각 대응을 만든다. 섹션 밖 키는 없는 것이 현행 (있으면 '기타'로). */
export function parseGuideSections(repo) {
  const sections = [];
  const p = path.join(repo, '.claude/env/guide.yaml');
  if (!fs.existsSync(p)) return sections;
  let current = null;
  for (const raw of fs.readFileSync(p, 'utf8').split('\n')) {
    const sec = raw.match(/^# ─+(.+?)─+\s*$/);
    if (sec) { current = { title: sec[1].trim(), keys: [] }; sections.push(current); continue; }
    const top = raw.match(/^([A-Z_][A-Z0-9_]*):\s*$/);
    if (top) {
      if (!current) { current = { title: '기타', keys: [] }; sections.push(current); }
      current.keys.push(top[1]);
    }
  }
  return sections;
}

/** render.yaml 최소 파서 — 이 레포의 들여쓰기 구조(services[].name / envVars[].key) 전용.
 *  반환: Map<서비스명, Map<키, 'value'|'sync:false'>> */
export function parseRenderYaml(repo) {
  const services = new Map();
  let current = null;
  let pendingKey = null;
  for (const raw of fs.readFileSync(path.join(repo, 'render.yaml'), 'utf8').split('\n')) {
    const name = raw.match(/^    name:\s*(\S+)/);
    if (name) { current = new Map(); services.set(name[1], current); pendingKey = null; continue; }
    if (!current) continue;
    const key = raw.match(/^      - key:\s*([A-Z0-9_]+)/);
    if (key) { pendingKey = key[1]; continue; }
    if (pendingKey) {
      if (/^\s+value:/.test(raw)) { current.set(pendingKey, 'value'); pendingKey = null; }
      else if (/^\s+sync:\s*false/.test(raw)) { current.set(pendingKey, 'sync:false'); pendingKey = null; }
    }
  }
  return services;
}

/** 값 파일에서 앱 기준 값 탐색: KEY@앱 → KEY 순. 반환은 값 유무만 필요할 때 has 로. */
export function ledgerLookup(ledger, key, app) {
  if (ledger.has(`${key}@${app}`)) return { found: true, scoped: true };
  if (ledger.has(key)) return { found: true, scoped: false };
  return { found: false, scoped: false };
}

/** canonical 정렬 — 기준은 guide.yaml 의 키 등장 순서 (사람이 읽는 카탈로그와 값 파일의 한 줄 대응).
 *  guide 에 없는 키는 말미(원래 상대 순서 유지 — 어차피 E·F항이 잡음), KEY@앱 파생 키는 기본 키 바로 뒤.
 *  check(H항)와 sync(정렬 재작성)가 공유한다 — 중복 구현 금지. */
export function canonicalSort(repo, keys) {
  const canon = [...parseGuide(repo).keys()];
  const rank = new Map(canon.map((k, i) => [k, i]));
  const base = (k) => k.split('@')[0];
  return keys
    .map((k, i) => ({ k, i }))
    .sort((a, b) => {
      const ra = rank.has(base(a.k)) ? rank.get(base(a.k)) : canon.length + 1;
      const rb = rank.has(base(b.k)) ? rank.get(base(b.k)) : canon.length + 1;
      if (ra !== rb) return ra - rb;
      const da = a.k.includes('@') ? 1 : 0; // 기본 키가 파생(@앱)보다 먼저
      const db = b.k.includes('@') ? 1 : 0;
      if (da !== db) return da - db;
      return a.i - b.i; // 안정 정렬 — 원래 상대 순서 보존
    })
    .map((x) => x.k);
}
