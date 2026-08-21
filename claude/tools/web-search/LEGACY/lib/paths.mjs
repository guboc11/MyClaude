// web-search — 저장 자리
// 계획서 _PLAN/2026-08-11-web-search-mcp/PLAN.md 2-12
//
// 산출물은 "부른 프로젝트" 안에 남는다(도구는 홈에 있어도 결과물은 프로젝트별).
// 전역 pace만 크롤 바깥에 하나 — 여러 크롤이 같은 사이트를 두드리는 속도는 하나로 관리돼야 한다.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function projectDir() {
  return process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

export function root() {
  return path.join(projectDir(), '.claude', 'web-search');
}

export function globalDir() {
  return path.join(root(), 'global');
}

export function paceFile(domain) {
  return path.join(globalDir(), 'pace', `${domainHash(domain)}.json`);
}

export function paceLockDir(domain) {
  return path.join(globalDir(), 'locks', `${domainHash(domain)}.lock`);
}

export function domainHash(domain) {
  return crypto.createHash('sha256').update(String(domain).toLowerCase()).digest('hex').slice(0, 16);
}

// [보안] 문자를 "제거"하면 "a/b" 가 조용히 "ab" 가 되어 다른 크롤을 덮어쓴다.
// 그래서 제거하지 않고 거절한다. 그리고 마지막에 실제 경로가 root() 안인지 한 번 더 확인한다.
// (2026-08-11 검수: 점 둘("..")로 crawlDir 이 프로젝트/.claude 로 이탈하는 것이 재현됨)
const NAME_MAX = 100;

export function safeName(name) {
  if (typeof name !== 'string') throw new Error(`크롤 이름은 문자열이어야 합니다: ${typeof name}`);
  const s = name.trim();
  if (!s) throw new Error('크롤 이름이 비었습니다.');
  if (s.length > NAME_MAX) throw new Error(`크롤 이름이 너무 깁니다(${s.length} > ${NAME_MAX}).`);
  if (s === '.' || s === '..') throw new Error(`크롤 이름으로 쓸 수 없습니다: "${s}"`);
  if (s.includes('/') || s.includes('\\')) throw new Error(`크롤 이름에 경로 구분자를 쓸 수 없습니다: "${s}"`);
  if (s.includes('\0')) throw new Error('크롤 이름에 널 문자를 쓸 수 없습니다.');
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(s)) throw new Error('크롤 이름에 제어문자를 쓸 수 없습니다.');
  if (s.startsWith('.')) throw new Error(`크롤 이름은 점으로 시작할 수 없습니다: "${s}"`);
  return s;
}

/** 최종 방어 — 계산된 경로가 정말 root() 안인지 확인한다. */
function assertInsideRoot(p) {
  const base = path.resolve(root());
  const target = path.resolve(p);
  if (target !== base && !target.startsWith(base + path.sep)) {
    throw new Error(`저장 자리를 벗어났습니다: ${target}`);
  }
  return target;
}

export function crawlDir(crawl) {
  return assertInsideRoot(path.join(root(), safeName(crawl)));
}

export const crawlPaths = (crawl) => {
  const d = crawlDir(crawl);
  return {
    dir: d,
    policy: path.join(d, 'policy.json'),
    seeds: path.join(d, 'seeds.jsonl'),
    events: path.join(d, 'events.jsonl'),
    state: path.join(d, 'state.json'),
    lock: path.join(d, 'locks', 'state.lock'),
    stale: path.join(d, 'locks', 'stale'),
    profiles: path.join(d, 'domain-profiles'),
    captures: path.join(d, 'captures'),
    manifests: path.join(d, 'manifests'),
    snapshots: path.join(d, 'snapshots'),
    reports: path.join(d, 'reports'),
  };
};

export function ensureCrawlDirs(crawl) {
  const p = crawlPaths(crawl);
  for (const dir of [p.dir, path.dirname(p.lock), p.stale, p.profiles, p.captures, p.manifests, p.snapshots, p.reports]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.mkdirSync(path.join(globalDir(), 'pace'), { recursive: true });
  fs.mkdirSync(path.join(globalDir(), 'locks'), { recursive: true });
  return p;
}

export function listCrawls() {
  try {
    return fs.readdirSync(root(), { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name !== 'global')
      .map((d) => d.name).sort();
  } catch { return []; }
}

// 임시 파일에 쓰고 원자적으로 이름을 바꾼다 — 쓰는 도중 죽어도 반쪽 파일이 남지 않는다.
export function writeAtomic(file, text) {
  const tmp = `${file}.tmp.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

export function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
