#!/usr/bin/env node
// docs-explorer-mcp — 무의존성 MCP stdio 서버 (레포 md의 헤더 단위 탐색·조회)
//
// 문서 문법 (파서 계약):
//   - 문서의 첫 헤더            = 제목 (주소 없음, list에 문서명으로만 표시)
//   - `# definition`                  = 기본 섹션 (문서 진입점, 예약 주소 "definition")
//   - 첫 헤더를 뺀 모든 헤더      = 도구가 순서·깊이로 매긴 계층 주소
//   - `# definition`              = 기본 섹션 (예약 주소 "definition")
//   - 섹션 범위 = 해당 헤더 ~ 다음 "같거나 얕은 급" 헤더 직전  → 부모 조회 = 서브트리 통째
//   - 코드 블록(``` ```) 안의 #은 헤더가 아님
//
// 동작 원칙: 조회 시점 실시간 파싱(캐시 없음) · 읽기 전용 · 로그는 stderr로.
// path 해석: 절대경로 그대로 / 상대경로는 CLAUDE_PROJECT_DIR > cwd 기준 / 폴더면 그 안의 README.md.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const log = (...a) => process.stderr.write(`[docs-explorer] ${a.join(' ')}\n`);
const HEADER_RE = /^(#{1,6})\s+(.+?)\s*$/;

function projectDir() {
  return process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

const FALLBACK_SKIP_DIRS = new Set(['.git', 'node_modules']);
const SEARCH_ALIASES_PATH = '.claude/tools/docs-explorer-mcp/ALIASES.md';
const TRACKING_STATUSES = new Set(['tracked', 'untracked', 'ignored']);

function repoRelative(root, file) {
  return path.relative(root, file).split(path.sep).join('/');
}

function isFenceLine(line) {
  let i = 0;
  while (i < line.length) {
    const code = line.charCodeAt(i);
    if (code !== 9 && code !== 12 && code !== 13 && code !== 32) break;
    i += 1;
  }
  return line.startsWith('```', i);
}

function walkMarkdownPaths(root) {
  const out = [];
  const pending = [root];
  while (pending.length > 0) {
    const dir = pending.pop();
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!FALLBACK_SKIP_DIRS.has(entry.name)) pending.push(full);
        continue;
      }
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) out.push(repoRelative(root, full));
    }
  }
  return out.sort();
}

function isNodeModulesPath(relativePath) {
  return relativePath.split('/').includes('node_modules');
}

function gitMarkdownList(root, gitCommand, args, run) {
  return run(gitCommand, ['ls-files', '-z', ...args], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

function listedMarkdownPaths(result) {
  return result.stdout.split('\0').filter((relativePath) => (
    relativePath
    && relativePath.toLowerCase().endsWith('.md')
    && !isNodeModulesPath(relativePath)
  ));
}

// git 추적·미추적·.claude 무시 md를 한 카탈로그로 모은다.
// git이 없거나 저장소가 아니면 Node 순회로 내려가 서버가 죽지 않는다.
function collectMarkdownEntries(root = projectDir(), {
  gitCommand = 'git',
  run = spawnSync,
} = {}) {
  const tracked = gitMarkdownList(root, gitCommand, ['--', '*.md'], run);
  if (tracked.error || tracked.status !== 0) {
    return walkMarkdownPaths(root).map((relativePath) => ({ path: relativePath, trackingStatus: 'untracked' }));
  }

  const untracked = gitMarkdownList(root, gitCommand, ['--others', '--exclude-standard', '--', '*.md'], run);
  const ignored = gitMarkdownList(root, gitCommand, ['--others', '--ignored', '--exclude-standard', '--', '.claude'], run);
  if (untracked.error || untracked.status !== 0 || ignored.error || ignored.status !== 0) {
    return walkMarkdownPaths(root).map((relativePath) => ({ path: relativePath, trackingStatus: 'untracked' }));
  }

  const entries = new Map();
  const add = (paths, trackingStatus) => {
    for (const relativePath of paths) {
      const file = path.join(root, ...relativePath.split('/'));
      if (!fs.existsSync(file)) continue; // 개명 중 index에만 남은 옛 경로는 읽을 문서가 아니다.
      if (!entries.has(relativePath)) entries.set(relativePath, { path: relativePath, trackingStatus });
    }
  };
  add(listedMarkdownPaths(tracked), 'tracked');
  add(listedMarkdownPaths(untracked), 'untracked');
  add(listedMarkdownPaths(ignored).filter((relativePath) => relativePath.startsWith('.claude/')), 'ignored');
  return [...entries.values()].sort((a, b) => a.path.localeCompare(b.path));
}

// 기존 호출처 호환: 바깥에는 계속 경로 배열을 돌려준다.
function collectMarkdownPaths(root = projectDir(), options = {}) {
  return collectMarkdownEntries(root, options).map((entry) => entry.path);
}

function normalizeMarkdownEntries(entries) {
  const normalized = new Map();
  for (const entry of entries) {
    let record;
    if (typeof entry === 'string') {
      record = { path: entry, trackingStatus: 'tracked' };
    } else {
      const trackingStatus = TRACKING_STATUSES.has(entry?.trackingStatus) ? entry.trackingStatus : 'tracked';
      record = { path: String(entry?.path || ''), trackingStatus };
    }
    if (record.path && !isNodeModulesPath(record.path) && !normalized.has(record.path)) {
      normalized.set(record.path, record);
    }
  }
  return [...normalized.values()];
}

function loadLayerIndexes(root, markdownPaths) {
  const indexes = new Map();
  for (const indexPath of markdownPaths.filter((file) => /^_[^/]+\/INDEX\.md$/.test(file))) {
    const layer = indexPath.slice(0, indexPath.indexOf('/'));
    const source = fs.readFileSync(path.join(root, ...indexPath.split('/')), 'utf8');
    const exact = new Set();
    const directories = new Set();
    for (const match of source.matchAll(/\]\(\s*<?([^\s)>]+)>?(?:\s+[^)]*)?\)/g)) {
      let target = match[1].split(/[?#]/, 1)[0];
      if (!target || target.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
      try { target = decodeURIComponent(target); } catch { /* 원문 경로로 계속 판정 */ }
      const resolved = path.posix.normalize(path.posix.join(layer, target));
      if (resolved !== layer && !resolved.startsWith(`${layer}/`)) continue;
      exact.add(resolved);
      const linkedDirectory = target.endsWith('/') ? resolved : path.posix.dirname(resolved);
      if (linkedDirectory !== layer) directories.add(linkedDirectory);
    }
    indexes.set(layer, { exact, directories });
  }
  return indexes;
}

function indexStatusForPath(relativePath, layerIndexes) {
  const slash = relativePath.indexOf('/');
  if (slash === -1) return '해당 없음';
  const layer = relativePath.slice(0, slash);
  const index = layerIndexes.get(layer);
  if (!index) return '해당 없음';
  const fileName = path.posix.basename(relativePath).toLowerCase();
  if (fileName === 'index.md' || fileName === 'readme.md') return '해당 없음';
  if (index.exact.has(relativePath)) return '등재';
  for (const directory of index.directories) {
    if (relativePath.startsWith(`${directory}/`)) return '등재';
  }
  return '미등재';
}

function makeDocumentRecord(root, relativePath, parsed, stat, indexStatus = '해당 없음', trackingStatus = 'tracked') {
  const folder = path.posix.dirname(relativePath);
  return {
    path: relativePath,
    folder: folder === '.' ? '' : folder,
    fileName: path.posix.basename(relativePath),
    title: parsed.title,
    lineCount: parsed.lineCount,
    headerCount: parsed.headerCount,
    fencedHeaderCount: parsed.fencedHeaderCount,
    sectionCount: parsed.sectionCount,
    createdAt: stat.birthtime.toISOString(),
    modifiedAt: stat.mtime.toISOString(),
    indexStatus,
    trackingStatus,
    sections: parsed.sections,
  };
}

// 수집·파싱 층의 고정 경계. 나중에 SQLite로 바꿔도 도구 층은 이 레코드만 받는다.
function collectDocuments(root = projectDir(), options = {}) {
  const markdownEntries = collectMarkdownEntries(root, options);
  const markdownPaths = markdownEntries.map((entry) => entry.path);
  const layerIndexes = loadLayerIndexes(root, markdownPaths);
  return markdownEntries.map(({ path: relativePath, trackingStatus }) => {
    const file = path.join(root, ...relativePath.split('/'));
    return makeDocumentRecord(
      root,
      relativePath,
      parseDoc(file),
      fs.statSync(file),
      indexStatusForPath(relativePath, layerIndexes),
      trackingStatus,
    );
  });
}

// 관할 주제 자동 발견 — 프로젝트 루트의 `_*` 폴더 중 README.md를 가진 것.
// 등록 절차 없음: 폴더에 README를 만들면 그 순간 주제가 된다 (주제명 = 폴더명에서 `_` 제거).
function discoverTopics() {
  const root = projectDir();
  const out = collectDocuments(root)
    .filter((doc) => /^_[^/]+\/README\.md$/.test(doc.path))
    .map((doc) => ({
      topic: doc.folder.replace(/^_+/, ''),
      folder: doc.folder,
      file: path.join(root, ...doc.path.split('/')),
      title: doc.title,
    }));
  return out.sort((a, b) => a.topic.localeCompare(b.topic));
}

// doc 인자 해석: ① 주제명("audit") ② 절대경로 ③ 상대경로(프로젝트 루트 기준). 폴더면 README.md.
function resolveDoc(p) {
  if (!p) throw new Error('doc이 필요합니다 — 주제명(예: "audit") 또는 경로. 경로 지도는 map 도구로.');
  const topics = discoverTopics();
  const hit = topics.find((t) => t.topic === p);
  if (hit) return hit.file;
  let full = path.isAbsolute(p) ? p : path.join(projectDir(), p);
  if (fs.existsSync(full) && fs.statSync(full).isDirectory()) full = path.join(full, 'README.md');
  if (!fs.existsSync(full)) {
    const names = topics.map((t) => t.topic).join(', ') || '(없음)';
    throw new Error(`문서를 찾을 수 없음: ${full}\n등록된 주제: ${names}`);
  }
  return full;
}

// ── 파싱 ──────────────────────────────────────────────────────

// 반환: DocumentRecord의 문서 내용 부분. 첫 헤더만 제목이고 나머지 모든 헤더는 주소를 가진다.
function parseDoc(file, source) {
  const lines = (source ?? fs.readFileSync(file, 'utf8')).split('\n');
  if (lines.at(-1) === '') lines.pop();
  let inFence = false;
  let fencedHeaderCount = 0;
  let title = null;
  let titleLine = -1;
  const headers = []; // 모든 헤더 { level, text, line }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isFenceLine(line)) { inFence = !inFence; continue; }
    const m = HEADER_RE.exec(line);
    if (!m) continue;
    if (inFence) { fencedHeaderCount += 1; continue; }
    headers.push({ level: m[1].length, text: m[2], line: i });
  }
  const sections = [];
  const stack = [];
  const siblingCounts = new Map();
  for (let h = 0; h < headers.length; h++) {
    const { level, text, line } = headers[h];
    if (title === null) { title = text; titleLine = line; continue; } // 첫 헤더 = 문서 제목
    while (stack.length > 0 && stack.at(-1).level >= level) stack.pop();
    const parent = stack.at(-1) || null;
    let address, name = text;
    if (text === 'definition') {
      address = 'definition';
      name = '(기본 섹션)';
    } else {
      const parentAddress = parent?.address || '';
      const sibling = (siblingCounts.get(parentAddress) || 0) + 1;
      siblingCounts.set(parentAddress, sibling);
      address = parentAddress ? `${parentAddress}-${sibling}` : String(sibling);
      const writtenNumber = /^(\d+(?:-\d+)*)(?:\s+(.*))?$/.exec(text);
      if (writtenNumber) name = writtenNumber[2] || '';
    }
    // 서브트리 끝 = 다음 "같거나 얕은 급" 헤더
    let end = lines.length;
    for (let k = h + 1; k < headers.length; k++) {
      if (headers[k].level <= level) { end = headers[k].line; break; }
    }
    const section = {
      address,
      level,
      depth: address.split('-').length - 1,
      title: name,
      startLine: line + 1,
      endLine: end,
      lineCount: end - line,
    };
    sections.push(section);
    stack.push(section);
  }
  return {
    title: title || path.basename(file),
    lines,
    lineCount: lines.length,
    headerCount: headers.length,
    fencedHeaderCount,
    titleLine,
    sectionCount: sections.length,
    sections,
  };
}

// ── 도구 구현 ─────────────────────────────────────────────────

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

function formatOutline(file, doc) {
  const root = projectDir();
  const relative = repoRelative(root, file);
  const displayPath = relative.startsWith('../') ? file : relative;
  const stat = fs.statSync(file);
  const out = [
    doc.title,
    `${displayPath}  ${doc.lineCount}줄  ${doc.sectionCount}절  생성 ${formatDate(stat.birthtime)} · 수정 ${formatDate(stat.mtime)}`,
    '',
  ];
  for (const s of doc.sections) {
    out.push(`${'  '.repeat(s.depth)}- ${s.address}${s.title ? ` ${s.title}` : ''}  ${s.lineCount}줄`);
  }
  return out.join('\n');
}

// 결과 문서들의 git 정보는 반드시 한 프로세스에 몰아 읽는다.
function loadGitMetadata(paths, {
  root = projectDir(),
  gitCommand = 'git',
  run = spawnSync,
} = {}) {
  const uniquePaths = [...new Set(paths.map(String))];
  const metadata = new Map(uniquePaths.map((file) => [file, { gitDate: null, revisionCount: 0 }]));
  if (uniquePaths.length === 0) return metadata;

  const result = run(gitCommand, [
    'log', '--format=%x1e%aI', '--name-only', '-z', '--', ...uniquePaths,
  ], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    const reason = result.error?.message || result.stderr?.trim() || `종료 코드 ${result.status}`;
    throw new Error(`git 정보를 읽을 수 없습니다: ${reason}`);
  }

  for (const block of result.stdout.split('\x1e').slice(1)) {
    const [date, ...rawNames] = block.split('\0');
    const names = new Set(rawNames.map((name) => name.replace(/^\n/, '')).filter(Boolean));
    for (const name of names) {
      const current = metadata.get(name);
      if (!current) continue;
      if (current.gitDate == null) current.gitDate = date;
      current.revisionCount += 1;
    }
  }
  return metadata;
}

function attachGitMetadata(documents, metadata) {
  return documents.map((doc) => metadata.has(doc.path) ? { ...doc, ...metadata.get(doc.path) } : doc);
}

function attachTrackedGitMetadata(documents, loadGit = loadGitMetadata) {
  const paths = documents
    .filter((doc) => doc.trackingStatus === 'tracked')
    .map((doc) => doc.path);
  if (paths.length === 0) return documents;
  return attachGitMetadata(documents, loadGit(paths));
}

function gitDateBounds(args) {
  return {
    gitFrom: parseSearchDate(args.gitFrom, false),
    gitTo: parseSearchDate(args.gitTo, true),
  };
}

function hasGitDateBounds(bounds) {
  return bounds.gitFrom != null || bounds.gitTo != null;
}

function inGitDateBounds(doc, bounds) {
  if (!hasGitDateBounds(bounds)) return true;
  if (!doc.gitDate) return false;
  const timestamp = Date.parse(doc.gitDate);
  return !(
    (bounds.gitFrom != null && timestamp < bounds.gitFrom)
    || (bounds.gitTo != null && timestamp > bounds.gitTo)
  );
}

const MAP_EXPAND_LIMIT = 5;
const MAP_SECOND_LEVEL_FOLDER_LIMIT = 12;
const MAP_SORT_ALIASES = new Map([
  ['alphabetical', 'alphabetical'],
  ['alpha', 'alphabetical'],
  ['modified', 'modified'],
  ['mtime', 'modified'],
  ['created', 'created'],
  ['birthtime', 'created'],
  ['lines', 'lines'],
  ['sections', 'sections'],
  ['git', 'git'],
]);

function normalizeMapPath(value) {
  if (value == null || String(value).trim() === '') return '';
  const normalized = path.posix.normalize(String(value).replaceAll('\\', '/').replace(/^\.\/+/, '').replace(/\/+$/, ''));
  if (path.posix.isAbsolute(normalized) || normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`레포 안의 상대 폴더 경로가 필요합니다: ${value}`);
  }
  return normalized === '.' ? '' : normalized;
}

function normalizeMapSort(value) {
  const requested = value == null ? 'alphabetical' : String(value).toLowerCase();
  const sort = MAP_SORT_ALIASES.get(requested);
  if (!sort) throw new Error('sort는 alphabetical, modified, created, lines, sections, git 중 하나여야 합니다');
  return sort;
}

function maxIso(documents, field) {
  return documents.reduce((latest, doc) => (doc[field] || '') > latest ? doc[field] : latest, '');
}

function mapEntries(documents, folderPath) {
  const prefix = folderPath ? `${folderPath}/` : '';
  const scoped = documents.filter((doc) => doc.path.startsWith(prefix));
  if (folderPath && scoped.length === 0) throw new Error(`md가 있는 폴더를 찾을 수 없음: ${folderPath}`);

  const folders = new Map();
  const entries = [];
  for (const doc of scoped) {
    const remainder = doc.path.slice(prefix.length);
    const slash = remainder.indexOf('/');
    if (slash === -1) {
      entries.push({ ...doc, type: 'document', name: doc.fileName, documentCount: 1 });
      continue;
    }
    const name = remainder.slice(0, slash);
    if (!folders.has(name)) folders.set(name, []);
    folders.get(name).push(doc);
  }

  for (const [name, children] of folders) {
    const childPath = folderPath ? `${folderPath}/${name}` : name;
    const readme = children.find((doc) => doc.path === `${childPath}/README.md`);
    entries.push({
      type: 'folder',
      name,
      path: childPath,
      title: readme?.title || '',
      documentCount: children.length,
      lineCount: children.reduce((sum, doc) => sum + doc.lineCount, 0),
      sectionCount: children.reduce((sum, doc) => sum + doc.sectionCount, 0),
      createdAt: maxIso(children, 'createdAt'),
      modifiedAt: maxIso(children, 'modifiedAt'),
      gitDate: maxIso(children, 'gitDate'),
    });
  }
  return entries;
}

function compareMapEntries(sort) {
  const alphabetical = (a, b) => a.name.localeCompare(b.name);
  if (sort === 'modified') return (a, b) => b.modifiedAt.localeCompare(a.modifiedAt) || alphabetical(a, b);
  if (sort === 'created') return (a, b) => b.createdAt.localeCompare(a.createdAt) || alphabetical(a, b);
  if (sort === 'lines') return (a, b) => b.lineCount - a.lineCount || alphabetical(a, b);
  if (sort === 'sections') return (a, b) => b.sectionCount - a.sectionCount || alphabetical(a, b);
  if (sort === 'git') return (a, b) => (b.gitDate || '').localeCompare(a.gitDate || '') || alphabetical(a, b);
  return alphabetical;
}

function folderSortValue(entry, sort) {
  if (sort === 'modified') return `  수정 ${formatDate(new Date(entry.modifiedAt))}`;
  if (sort === 'created') return `  생성 ${formatDate(new Date(entry.createdAt))}`;
  if (sort === 'lines') return `  ${entry.lineCount}줄`;
  if (sort === 'sections') return `  ${entry.sectionCount}절`;
  if (sort === 'git') return `  커밋 ${entry.gitDate ? formatDate(new Date(entry.gitDate)) : '없음'}`;
  return '';
}

function gitMetadataSuffix(entry) {
  if (!Object.hasOwn(entry, 'revisionCount')) return '';
  return ` · 커밋 ${entry.gitDate ? formatDate(new Date(entry.gitDate)) : '없음'} · ${entry.revisionCount}회`;
}

function indexStatusSuffix(entry) {
  return ` · INDEX ${entry.indexStatus}`;
}

function trackingStatusSuffix(entry) {
  if (entry.trackingStatus === 'ignored') return ' · Git 추적 안 됨 (무시됨)';
  if (entry.trackingStatus === 'untracked') return ' · Git 추적 안 됨 (미추적)';
  return '';
}

function renderMapFolderLine(entry, sort, depth) {
  const indent = '  '.repeat(depth);
  return `${indent}- ${entry.name}/  ${entry.documentCount}개${folderSortValue(entry, sort)}${entry.title ? ` — ${entry.title}` : ''}`;
}

function renderMapEntries(documents, folderPath, sort, depth = 0) {
  const entries = mapEntries(documents, folderPath).sort(compareMapEntries(sort));
  const out = [];
  for (const entry of entries) {
    const indent = '  '.repeat(depth);
    if (entry.type === 'document') {
      out.push(`${indent}- ${entry.name} — ${entry.title}  ${entry.lineCount}줄  ${entry.sectionCount}절  생성 ${formatDate(new Date(entry.createdAt))} · 수정 ${formatDate(new Date(entry.modifiedAt))}${indexStatusSuffix(entry)}${trackingStatusSuffix(entry)}${gitMetadataSuffix(entry)}`);
      continue;
    }
    out.push(renderMapFolderLine(entry, sort, depth));
    if (entry.documentCount <= MAP_EXPAND_LIMIT) {
      out.push(...renderMapEntries(documents, entry.path, sort, depth + 1));
    } else if (depth === 0) {
      const childFolders = mapEntries(documents, entry.path)
        .filter((child) => child.type === 'folder')
        .sort(compareMapEntries(sort));
      if (childFolders.length <= MAP_SECOND_LEVEL_FOLDER_LIMIT) {
        out.push(...childFolders.map((child) => renderMapFolderLine(child, sort, depth + 1)));
      }
    }
  }
  return out;
}

function visibleMapDocumentPaths(documents, folderPath) {
  const paths = [];
  for (const entry of mapEntries(documents, folderPath)) {
    if (entry.type === 'document') paths.push(entry.path);
    else if (entry.documentCount <= MAP_EXPAND_LIMIT) paths.push(...visibleMapDocumentPaths(documents, entry.path));
  }
  return paths;
}

function toolMap(args = {}) {
  const folderPath = normalizeMapPath(args.path);
  const sort = normalizeMapSort(args.sort);
  const bounds = gitDateBounds(args);
  const needsAllGit = sort === 'git' || hasGitDateBounds(bounds);
  let documents = collectDocuments(projectDir());
  if (needsAllGit) {
    documents = attachTrackedGitMetadata(documents);
    documents = documents.filter((doc) => inGitDateBounds(doc, bounds));
  } else if (args.git === true) {
    const visiblePaths = new Set(visibleMapDocumentPaths(documents, folderPath));
    const visibleDocuments = documents.filter((doc) => visiblePaths.has(doc.path));
    const withGit = new Map(attachTrackedGitMetadata(visibleDocuments).map((doc) => [doc.path, doc]));
    documents = documents.map((doc) => withGit.get(doc.path) || doc);
  }
  const displayPath = folderPath ? `${folderPath}/` : '/';
  const out = [`레포 md 지도: ${displayPath} (정렬: ${sort})`, ''];
  out.push(...renderMapEntries(documents, folderPath, sort));
  return out.join('\n');
}

function toolOutline({ doc: p }) {
  const file = resolveDoc(p);
  return formatOutline(file, parseDoc(file));
}

const READ_POSITIONAL_RE = /^(?:definition|\d+)(?:-\d+)*$/;
const READ_ANCHOR_RE = /^CG-\d{4}$/i;
const HTML_ANCHOR_LINE_RE = /^\s*<a\s+id=(["'])[^"']+\1\s*><\/a>\s*$/i;

function readIdKind(id) {
  if (id === 'all' || READ_POSITIONAL_RE.test(id)) return 'positional';
  if (READ_ANCHOR_RE.test(id)) return 'anchor';
  return 'header';
}

function readDisplayPath(file) {
  const relative = repoRelative(projectDir(), file);
  return relative.startsWith('../') ? file : relative;
}

function documentReadScope(file) {
  return [{ file, path: readDisplayPath(file), parsed: parseDoc(file) }];
}

function globalReadScope() {
  const root = projectDir();
  return collectDocuments(root).map((document) => ({
    file: path.join(root, ...document.path.split('/')),
    path: document.path,
    parsed: { sections: document.sections },
  }));
}

function sectionReadCandidates(scope, id, kind) {
  const lower = id.toLowerCase();
  let matches = scope.flatMap((document) => document.parsed.sections
    .filter((section) => {
      const title = section.title.toLowerCase();
      if (kind === 'anchor') return title.includes(`[${lower}]`);
      return title === lower;
    })
    .map((section) => ({ ...document, section })));
  if (matches.length === 0 && kind === 'header') {
    matches = scope.flatMap((document) => document.parsed.sections
      .filter((section) => section.title.toLowerCase().includes(lower))
      .map((section) => ({ ...document, section })));
  }
  return matches.sort((a, b) => (
    a.path.localeCompare(b.path) || a.section.address.localeCompare(b.section.address)
  ));
}

function resolveReadId(scope, id) {
  const kind = readIdKind(id);
  if (kind === 'positional') {
    const document = scope[0];
    if (id === 'all') return { id, kind, matches: [{ ...document, section: null }] };
    const section = document.parsed.sections.find((candidate) => candidate.address === id);
    return { id, kind, matches: section ? [{ ...document, section }] : [] };
  }
  return { id, kind, matches: sectionReadCandidates(scope, id, kind) };
}

function formatReadLocation(match) {
  return `${match.path} [${match.section.address}] ${match.section.title}`;
}

function formatReadCandidates(resolutions, missing, hasDoc) {
  const ambiguous = resolutions.filter((resolution) => resolution.matches.length > 1);
  const out = [];
  if (missing.length > 0) out.push(`없는 주소: ${missing.join(', ')}`);
  if (!hasDoc && missing.length > 0) {
    out.push('', '레포 전체에서 일치하는 헤더를 찾지 못했습니다.');
  }
  if (ambiguous.length > 0) {
    if (out.length > 0) out.push('');
    out.push(`복수 매칭: ${ambiguous.map((resolution) => resolution.id).join(', ')}`);
    out.push('본문을 반환하지 않음 — 아래 문서 경로·주소·헤더에서 하나를 골라 다시 호출하세요.');
    for (const resolution of ambiguous) {
      for (const match of resolution.matches) {
        out.push(`- ${formatReadLocation(match)}`);
      }
    }
  }
  return out.join('\n');
}

function readSectionEnd(lines, section) {
  if (section.endLine >= lines.length) return section.endLine;
  let cursor = section.endLine - 1;
  while (cursor >= section.startLine - 1 && lines[cursor].trim() === '') cursor -= 1;
  let end = section.endLine;
  while (cursor >= section.startLine - 1 && HTML_ANCHOR_LINE_RE.test(lines[cursor])) {
    end = cursor;
    cursor -= 1;
    while (cursor >= section.startLine - 1 && lines[cursor].trim() === '') cursor -= 1;
  }
  return end;
}

function readMatchedBlock(match) {
  const parsed = match.parsed.lines ? match.parsed : parseDoc(match.file);
  if (match.section === null) return parsed.lines.join('\n').trim();
  const endLine = readSectionEnd(parsed.lines, match.section);
  return parsed.lines.slice(match.section.startLine - 1, endLine).join('\n').trim();
}

function toolRead({ doc: p, ids }) {
  if (!Array.isArray(ids) || ids.length === 0) throw new Error('ids 배열이 필요합니다 (예: ["definition"] 또는 ["1-1","2-3"])');
  const normalizedIds = ids.map(String);
  const hasDoc = p != null && String(p) !== '';
  if (!hasDoc) {
    const positional = normalizedIds.filter((id) => readIdKind(id) === 'positional');
    if (positional.length > 0) {
      throw new Error(`위치 주소 ${positional.join(', ')} 조회에는 doc이 필요합니다`);
    }
  }

  const file = hasDoc ? resolveDoc(p) : null;
  const scope = hasDoc ? documentReadScope(file) : globalReadScope();
  const resolutions = normalizedIds.map((id) => resolveReadId(scope, id));
  const missing = resolutions.filter((resolution) => resolution.matches.length === 0).map((resolution) => resolution.id);
  const ambiguous = resolutions.some((resolution) => resolution.matches.length > 1);
  if (missing.length > 0 || ambiguous) {
    if (hasDoc && !ambiguous) {
      return `없는 주소: ${missing.join(', ')}\n\n이 문서의 목차:\n${formatOutline(file, scope[0].parsed)}`;
    }
    return formatReadCandidates(resolutions, missing, hasDoc);
  }

  const blocks = resolutions.map((resolution) => {
    const match = resolution.matches[0];
    const body = readMatchedBlock(match);
    return hasDoc ? body : `출처: ${formatReadLocation(match)}\n${body}`;
  });
  if (hasDoc) {
    usageLog(file, ids);
  } else {
    for (let index = 0; index < resolutions.length; index++) {
      usageLog(resolutions[index].matches[0].file, [ids[index]]);
    }
  }
  return blocks.join('\n\n---\n\n');
}

const SEARCH_STRENGTH = { exact: 0, folder: 1, file: 2, header: 3, body: 4 };
const SEARCH_DEFAULT_LIMIT = 20;
const SEARCH_MAX_LIMIT = 100;
const SEARCH_SORTS = new Set(['relevance', 'alphabetical', 'modified', 'created', 'lines', 'sections', 'git']);

function normalizeSearchSort(value) {
  const sort = value == null ? 'relevance' : String(value).toLowerCase();
  if (!SEARCH_SORTS.has(sort)) {
    throw new Error('sort는 relevance, alphabetical, modified, created, lines, sections, git 중 하나여야 합니다');
  }
  return sort;
}

function parseSearchDate(value, endOfDay) {
  if (value == null || value === '') return null;
  const text = String(value);
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(text)
    ? `${text}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`
    : text;
  const timestamp = Date.parse(normalized);
  if (Number.isNaN(timestamp)) throw new Error(`날짜 형식이 올바르지 않습니다: ${value}`);
  return timestamp;
}

function searchDateBounds(args) {
  return {
    createdFrom: parseSearchDate(args.createdFrom ?? args.created?.from, false),
    createdTo: parseSearchDate(args.createdTo ?? args.created?.to, true),
    modifiedFrom: parseSearchDate(args.modifiedFrom ?? args.modified?.from, false),
    modifiedTo: parseSearchDate(args.modifiedTo ?? args.modified?.to, true),
  };
}

function inSearchDateBounds(stat, bounds) {
  const created = stat.birthtimeMs;
  const modified = stat.mtimeMs;
  return !(
    (bounds.createdFrom != null && created < bounds.createdFrom)
    || (bounds.createdTo != null && created > bounds.createdTo)
    || (bounds.modifiedFrom != null && modified < bounds.modifiedFrom)
    || (bounds.modifiedTo != null && modified > bounds.modifiedTo)
  );
}

function addSearchMatch(matches, match) {
  const strength = SEARCH_STRENGTH[match.type];
  const current = matches.get(match.address);
  if (!current || strength < current.strength) {
    matches.set(match.address, { ...match, strength, snippets: match.snippet ? [match.snippet] : [] });
    return;
  }
  if (strength !== current.strength || !match.snippet || current.snippets.includes(match.snippet)) return;
  if (current.snippets.length < 2) current.snippets.push(match.snippet);
}

function documentSearchMatches(record, parsed, queryLower, lowerLines) {
  const matches = new Map();
  const folderNames = record.folder.split('/').filter(Boolean);
  const exactFolder = folderNames.find((name) => name.toLowerCase() === queryLower);
  const fileStem = record.fileName.replace(/\.md$/i, '');
  if (exactFolder || fileStem.toLowerCase() === queryLower) {
    addSearchMatch(matches, {
      address: 'all', type: 'exact', title: fileStem.toLowerCase() === queryLower ? record.fileName : exactFolder,
      lineCount: record.lineCount, startLine: -1,
    });
  }
  const matchingFolder = folderNames.find((name) => name.toLowerCase().includes(queryLower));
  if (matchingFolder) {
    addSearchMatch(matches, {
      address: 'all', type: 'folder', title: matchingFolder,
      lineCount: record.lineCount, startLine: -1,
    });
  }
  if (record.fileName.toLowerCase().includes(queryLower)) {
    addSearchMatch(matches, {
      address: 'all', type: 'file', title: record.fileName,
      lineCount: record.lineCount, startLine: -1,
    });
  }
  if (record.title.toLowerCase().includes(queryLower)) {
    addSearchMatch(matches, {
      address: 'all', type: 'header', title: record.title,
      lineCount: record.lineCount, startLine: parsed.titleLine,
    });
  }

  const sectionsByLine = new Map();
  for (const section of record.sections) {
    const headerLine = section.startLine - 1;
    sectionsByLine.set(headerLine, section);
    if (lowerLines[headerLine]?.includes(queryLower)) {
      addSearchMatch(matches, {
        address: section.address, type: 'header', title: section.title,
        lineCount: section.lineCount, startLine: headerLine,
      });
    }
  }

  const stack = [];
  for (let i = 0; i < parsed.lines.length; i++) {
    while (stack.length > 0 && i >= stack.at(-1).endLine) stack.pop();
    const starting = sectionsByLine.get(i);
    if (starting) {
      while (stack.length > 0 && stack.at(-1).level >= starting.level) stack.pop();
      stack.push(starting);
      continue;
    }
    if (i === parsed.titleLine || !lowerLines[i]?.includes(queryLower)) continue;
    const owner = stack.at(-1);
    addSearchMatch(matches, {
      address: owner?.address || 'all',
      type: 'body',
      title: owner?.title || record.title,
      lineCount: owner?.lineCount || record.lineCount,
      startLine: owner ? owner.startLine - 1 : i,
      snippet: parsed.lines[i].trim(),
    });
  }

  return [...matches.values()].sort((a, b) => a.strength - b.strength || a.startLine - b.startLine);
}

function loadSearchAliases(root) {
  const file = path.join(root, ...SEARCH_ALIASES_PATH.split('/'));
  if (!fs.existsSync(file)) return [];
  const aliases = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const match = /^\s*[-*]\s+([^#=][^=]*?)\s*=\s*(.+?)\s*$/.exec(line);
    if (!match) continue;
    const from = match[1].trim();
    const to = match[2].trim();
    if (from && to) aliases.push({ from, to, fromLower: from.toLowerCase(), toLower: to.toLowerCase() });
  }
  return aliases;
}

function searchQueries(query, aliases) {
  const queryLower = query.toLowerCase();
  const queries = [{ text: query, lower: queryLower, alias: null, inputText: query, inputLower: queryLower }];
  for (const alias of aliases) {
    if (alias.fromLower !== queryLower || alias.toLower === queryLower) continue;
    if (!queries.some((candidate) => candidate.lower === alias.toLower)) {
      queries.push({ text: alias.to, lower: alias.toLower, alias, inputText: query, inputLower: queryLower });
    }
  }
  return queries;
}

function normalizeSearchQueryInput(value) {
  if (typeof value === 'string') {
    const query = value.trim();
    if (!query) throw new Error('query가 필요합니다');
    return { inputQueries: [{ text: query, lower: query.toLowerCase() }], isArray: false };
  }
  if (!Array.isArray(value)) throw new Error('query는 문자열 또는 문자열 배열이어야 합니다');
  if (value.length === 0) throw new Error('query 배열에 검색어가 하나 이상 필요합니다');

  const inputQueries = [];
  for (const item of value) {
    if (typeof item !== 'string') throw new Error('query 배열에는 문자열만 넣을 수 있습니다');
    const text = item.trim();
    if (!text) throw new Error('query 배열에는 빈 문자열을 넣을 수 없습니다');
    const lower = text.toLowerCase();
    if (!inputQueries.some((query) => query.lower === lower)) inputQueries.push({ text, lower });
  }
  return { inputQueries, isArray: true };
}

function collectSearchResults(root, queries, scope, bounds, markdownEntries) {
  const results = [];
  const markdownPaths = markdownEntries.map((entry) => entry.path);
  const layerIndexes = loadLayerIndexes(root, markdownPaths);
  for (const { path: relativePath, trackingStatus } of markdownEntries) {
    if (scope && relativePath !== scope && !relativePath.startsWith(`${scope}/`)) continue;
    const file = path.join(root, ...relativePath.split('/'));
    const stat = fs.statSync(file);
    if (!inSearchDateBounds(stat, bounds)) continue;

    const folder = path.posix.dirname(relativePath);
    const relativeFolder = folder === '.' ? '' : folder;
    const source = fs.readFileSync(file, 'utf8');
    const sourceLower = source.toLowerCase();
    const applicableQueries = queries.filter(({ lower }) => (
      relativeFolder.toLowerCase().includes(lower)
      || path.posix.basename(relativePath).toLowerCase().includes(lower)
      || sourceLower.includes(lower)
    ));
    if (applicableQueries.length === 0) continue;

    const parsed = parseDoc(file, source);
    const lowerLines = sourceLower.split('\n');
    if (lowerLines.at(-1) === '') lowerLines.pop();
    const record = makeDocumentRecord(
      root,
      relativePath,
      parsed,
      stat,
      indexStatusForPath(relativePath, layerIndexes),
      trackingStatus,
    );
    const candidates = applicableQueries.map((candidate) => ({
      ...candidate,
      matches: documentSearchMatches(record, parsed, candidate.lower, lowerLines),
    })).filter((candidate) => candidate.matches.length > 0);
    const selectedCandidates = [];
    for (const inputLower of [...new Set(queries.map((candidate) => candidate.inputLower))]) {
      const inputCandidates = candidates.filter((candidate) => candidate.inputLower === inputLower);
      const direct = inputCandidates.find((candidate) => candidate.alias === null);
      const selected = direct
        || inputCandidates.sort((a, b) => a.matches[0].strength - b.matches[0].strength)[0];
      if (selected) selectedCandidates.push(selected);
    }
    const selected = [...selectedCandidates].sort((a, b) => (
      Number(Boolean(a.alias)) - Number(Boolean(b.alias))
      || a.matches[0].strength - b.matches[0].strength
    ))[0];
    if (selected) {
      results.push({
        ...record,
        matches: selected.matches,
        strength: selected.matches[0].strength,
        alias: selected.alias,
        aliases: selectedCandidates.map((candidate) => candidate.alias).filter(Boolean),
        matchedQueries: selectedCandidates.map((candidate) => candidate.inputText),
      });
    }
  }
  return results;
}

function compareSearchResults(sort) {
  const alphabetical = (a, b) => a.path.localeCompare(b.path);
  const modified = (a, b) => b.modifiedAt.localeCompare(a.modifiedAt) || alphabetical(a, b);
  let compare;
  if (sort === 'alphabetical') compare = alphabetical;
  else if (sort === 'modified') compare = modified;
  else if (sort === 'created') compare = (a, b) => b.createdAt.localeCompare(a.createdAt) || alphabetical(a, b);
  else if (sort === 'lines') compare = (a, b) => b.lineCount - a.lineCount || alphabetical(a, b);
  else if (sort === 'sections') compare = (a, b) => b.sectionCount - a.sectionCount || alphabetical(a, b);
  else if (sort === 'git') compare = (a, b) => (b.gitDate || '').localeCompare(a.gitDate || '') || alphabetical(a, b);
  else compare = (a, b) => a.strength - b.strength || modified(a, b);
  return (a, b) => Number(Boolean(a.alias)) - Number(Boolean(b.alias)) || compare(a, b);
}

function searchCursorFingerprint(key) {
  return createHash('sha256').update(key).digest('base64url');
}

function encodeSearchCursor(offset, key) {
  return `v1.${offset.toString(36)}.${searchCursorFingerprint(key)}`;
}

function decodeSearchCursor(cursor, key) {
  if (!cursor) return 0;
  const match = /^v1\.([0-9a-z]+)\.([A-Za-z0-9_-]{43})$/.exec(String(cursor));
  const offset = match ? Number.parseInt(match[1], 36) : Number.NaN;
  if (
    !Number.isSafeInteger(offset)
    || offset < 0
    || match[2] !== searchCursorFingerprint(key)
  ) throw new Error('cursor가 만료되었거나 현재 검색 조건과 맞지 않습니다');
  return offset;
}

function formatSearchMatch(match) {
  const labels = { exact: '정확 일치', folder: '폴더명', file: '파일명', header: '헤더', body: '본문' };
  const out = [`  [${match.address}] ${match.title}  ${match.lineCount}줄  ← ${labels[match.type]}`];
  if (match.type === 'body') {
    for (const snippet of match.snippets) out.push(`    · ${snippet}`);
  }
  return out;
}

function toolSearch(args = {}, {
  loadGit = loadGitMetadata,
  collectPaths = collectMarkdownEntries,
} = {}) {
  const { inputQueries, isArray } = normalizeSearchQueryInput(args.query);
  const query = inputQueries[0].text;
  const queryLower = isArray ? inputQueries.map((candidate) => candidate.lower) : inputQueries[0].lower;
  const root = projectDir();
  const aliases = loadSearchAliases(root);
  const queries = inputQueries.flatMap((candidate) => searchQueries(candidate.text, aliases));
  const scope = normalizeMapPath(args.scope);
  const sort = normalizeSearchSort(args.sort);
  const bounds = searchDateBounds(args);
  const gitBounds = gitDateBounds(args);
  const needsAllGit = sort === 'git' || hasGitDateBounds(gitBounds);
  const showGit = args.git === true || needsAllGit;
  const limit = args.limit == null ? SEARCH_DEFAULT_LIMIT : args.limit;
  if (!Number.isInteger(limit) || limit < 1 || limit > SEARCH_MAX_LIMIT) {
    throw new Error(`limit은 1~${SEARCH_MAX_LIMIT} 정수여야 합니다`);
  }

  const cursorKey = JSON.stringify({
    queryLower,
    expandedQueries: queries.map((candidate) => candidate.lower),
    scope,
    sort,
    bounds,
    gitBounds,
    showGit,
  });
  const offset = decodeSearchCursor(args.cursor, cursorKey);
  const markdownEntries = normalizeMarkdownEntries(collectPaths(root));
  let results = collectSearchResults(root, queries, scope, bounds, markdownEntries);
  if (needsAllGit) {
    results = attachTrackedGitMetadata(results, loadGit);
    results = results.filter((doc) => inGitDateBounds(doc, gitBounds));
  }
  results.sort(compareSearchResults(sort));
  let page = results.slice(offset, offset + limit);
  if (args.git === true && !needsAllGit) {
    page = attachTrackedGitMetadata(page, loadGit);
  }
  const first = page.length === 0 ? 0 : offset + 1;
  const last = offset + page.length;
  const queryLabel = isArray
    ? inputQueries.map((candidate) => `"${candidate.text}"`).join(' OR ')
    : `"${query}"`;
  const out = [
    `${queryLabel} 검색: ${results.length}개 문서 · ${first}-${last} 표시 (정렬: ${sort})`,
    `범위: ${scope || '전체'}`,
  ];
  for (const result of page) {
    out.push('', `${result.path} — ${result.title}  ${result.lineCount}줄  ${result.sectionCount}절`);
    out.push(`  생성 ${formatDate(new Date(result.createdAt))} · 수정 ${formatDate(new Date(result.modifiedAt))}${indexStatusSuffix(result)}${trackingStatusSuffix(result)}${showGit ? gitMetadataSuffix(result) : ''}`);
    if (isArray) {
      out.push(`  매치 검색어: ${JSON.stringify(result.matchedQueries)}`);
      for (const alias of result.aliases) out.push(`  별칭: ${alias.from} → ${alias.to}`);
    } else if (result.alias) {
      out.push(`  별칭: ${result.alias.from} → ${result.alias.to}`);
    }
    for (const match of result.matches) out.push(...formatSearchMatch(match));
  }
  if (last < results.length) out.push('', `next cursor: ${encodeSearchCursor(last, cursorKey)}`);
  return out.join('\n');
}

const HISTORY_DEFAULT_LIMIT = 5;

function loadFileHistory(relativePath, {
  root = projectDir(),
  gitCommand = 'git',
  run = spawnSync,
} = {}) {
  const result = run(gitCommand, [
    'log', '--follow', '--format=%x1e%H%x00%aI%x00%s', '--', relativePath,
  ], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    const reason = result.error?.message || result.stderr?.trim() || `종료 코드 ${result.status}`;
    throw new Error(`git 이력을 읽을 수 없습니다: ${reason}`);
  }
  return result.stdout.split('\x1e').slice(1).map((block) => {
    const [hash, date, subject = ''] = block.replace(/\n$/, '').split('\0');
    return { hash, date, subject };
  }).reverse().map((entry, index) => ({ ...entry, number: index + 1 }));
}

function parseHistoryRange(value) {
  if (value == null) return null;
  let from;
  let to;
  if (typeof value === 'string') {
    const match = /^(\d+)\.\.(\d+)$/.exec(value.trim());
    if (!match) throw new Error('range는 "시작..끝" 형식이어야 합니다 (예: "34..35")');
    from = Number(match[1]);
    to = Number(match[2]);
  } else if (typeof value === 'object') {
    from = Number(value.from);
    to = Number(value.to);
  }
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || from >= to) {
    throw new Error('range는 시작 < 끝인 양의 이력 번호여야 합니다');
  }
  return { from, to };
}

function gitDiff(relativePath, fromHash, toHash, {
  root = projectDir(),
  gitCommand = 'git',
  run = spawnSync,
} = {}) {
  const result = run(gitCommand, [
    'diff', '--no-ext-diff', '--unified=3', fromHash, toHash, '--', relativePath,
  ], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    const reason = result.error?.message || result.stderr?.trim() || `종료 코드 ${result.status}`;
    throw new Error(`git diff를 읽을 수 없습니다: ${reason}`);
  }
  return result.stdout.replace(/\n$/, '');
}

function textLineCount(text) {
  return text === '' ? 0 : text.split('\n').length;
}

function toolHistory(args = {}) {
  const file = resolveDoc(args.doc);
  const root = projectDir();
  const relativePath = repoRelative(root, file);
  if (relativePath.startsWith('../')) throw new Error('history는 현재 레포 안의 문서만 조회할 수 있습니다');
  const trackingStatus = collectMarkdownEntries(root)
    .find((entry) => entry.path === relativePath)?.trackingStatus || 'untracked';
  if (trackingStatus !== 'tracked') {
    return `${relativePath} — Git 추적 안 됨 (${trackingStatus === 'ignored' ? '무시됨' : '미추적'}) · git 이력 조회 불가`;
  }
  const entries = loadFileHistory(relativePath);
  if (entries.length === 0) return `${relativePath} — git 이력 없음`;

  const range = parseHistoryRange(args.range);
  if (range) {
    if (range.to > entries.length) throw new Error(`이력 번호 범위 초과: 최신 번호는 ${entries.length}`);
    const diff = gitDiff(relativePath, entries[range.from - 1].hash, entries[range.to - 1].hash);
    const lineCount = textLineCount(diff);
    const heading = `${relativePath} — ${range.from}..${range.to} diff ${lineCount}줄`;
    if (args.confirm !== true) {
      return `${heading}\n본문을 받으려면 같은 range에 confirm: true를 지정하세요.`;
    }
    return `${heading}\n\n${diff}`;
  }

  let limit = args.limit == null ? HISTORY_DEFAULT_LIMIT : args.limit;
  if (limit === 'all') limit = entries.length;
  if (!Number.isInteger(limit) || limit < 1) throw new Error('limit은 양의 정수 또는 "all"이어야 합니다');
  const shown = entries.slice(-limit).reverse();
  const oldest = entries[0].date.slice(0, 10);
  const newest = entries.at(-1).date.slice(0, 10);
  const out = [`${relativePath} — ${entries.length}번 고쳐짐 (${oldest} ~ ${newest})`, ''];
  for (const entry of shown) {
    out.push(`${entry.number}  ${entry.date.slice(5, 10)}  ${entry.subject}`);
  }
  if (shown.length < entries.length) out.push('', `최근 ${shown.length}건 표시 · 전체는 limit: "all"`);
  return out.join('\n');
}

function usageLog(file, ids) {
  try {
    const rec = { ts: new Date().toISOString(), doc: file, ids };
    const dir = path.join(projectDir(), '.claude', 'mcp-docs-explorer');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'usage.jsonl'), JSON.stringify(rec) + '\n');
  } catch { /* 기록 실패는 무시 — 조회 기능에 영향 주지 않기 */ }
}

// ── MCP 배선 ──────────────────────────────────────────────────

const DOC_DESC =
  '주제명(예: "audit" — map 도구로 경로 확인) 또는 경로(절대/상대, 폴더면 그 안의 README.md).';

const TOOL_DEFINITIONS = [
  {
    name: 'map',
    description: '레포의 추적·미추적 md와 .claude 아래 무시된 md 지도를 폴더부터 훑는다. node_modules는 제외하며, 하위 문서가 5개 이하면 펼치고 초과면 접는다.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '레포 안의 폴더 경로. 생략하면 루트.' },
        sort: {
          type: 'string',
          enum: ['alphabetical', 'modified', 'created', 'lines', 'sections', 'git'],
          description: '정렬 기준. 기본 alphabetical; 날짜·수치는 내림차순.',
        },
        git: { type: 'boolean', description: '펼쳐서 반환하는 문서에 마지막 커밋 날짜와 수정 횟수를 붙인다.' },
        gitFrom: { type: 'string', description: 'git 커밋 날짜 시작(포함). 명시할 때만 git 정보를 읽는다.' },
        gitTo: { type: 'string', description: 'git 커밋 날짜 끝(포함). 명시할 때만 git 정보를 읽는다.' },
      },
    },
  },
  {
    name: 'outline',
    description: 'md 문서의 목차를 본다. 도구 주소·제목과 절마다 줄 수를 반환해 읽을 범위를 먼저 판단한다.',
    inputSchema: {
      type: 'object',
      properties: { doc: { type: 'string', description: DOC_DESC } },
      required: ['doc'],
    },
  },
  {
    name: 'read',
    description:
      '문서 절을 위치 주소·CG 앵커·헤더 문자열로 조회한다. doc을 생략하면 앵커·헤더를 레포 전체에서 찾고, 복수면 후보만 반환한다.',
    inputSchema: {
      type: 'object',
      properties: {
        doc: { type: 'string', description: `${DOC_DESC} 앵커·헤더를 전역에서 찾을 때는 생략.` },
        ids: { type: 'array', items: { type: 'string' }, description: '위치 주소·CG 앵커·헤더 문자열 배열. 예: ["definition"], ["CG-0241"], ["헤더 제목"]' },
      },
      required: ['ids'],
    },
  },
  {
    name: 'search',
    description: '레포의 추적·미추적 md와 .claude 아래 무시된 md에서 폴더명·파일명·헤더·본문을 찾고, 바로 read할 수 있는 주소를 반환한다.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          oneOf: [
            { type: 'string' },
            { type: 'array', items: { type: 'string' }, minItems: 1 },
          ],
          description: '검색 키워드 하나 또는 OR로 합칠 검색 키워드 배열.',
        },
        scope: { type: 'string', description: '레포 상대경로 범위. 생략하면 전체.' },
        createdFrom: { type: 'string', description: '생성 시각 시작(포함). ISO 날짜 또는 시각.' },
        createdTo: { type: 'string', description: '생성 시각 끝(포함). ISO 날짜 또는 시각.' },
        modifiedFrom: { type: 'string', description: '수정 시각 시작(포함). ISO 날짜 또는 시각.' },
        modifiedTo: { type: 'string', description: '수정 시각 끝(포함). ISO 날짜 또는 시각.' },
        sort: {
          type: 'string',
          enum: ['relevance', 'alphabetical', 'modified', 'created', 'lines', 'sections', 'git'],
          description: '기본 relevance는 정확 일치 > 폴더명 > 파일명 > 헤더 > 본문, 같은 강도는 최신순.',
        },
        git: { type: 'boolean', description: '반환 문서에 마지막 커밋 날짜와 수정 횟수를 붙인다.' },
        gitFrom: { type: 'string', description: 'git 커밋 날짜 시작(포함). 명시할 때만 git 정보를 읽는다.' },
        gitTo: { type: 'string', description: 'git 커밋 날짜 끝(포함). 명시할 때만 git 정보를 읽는다.' },
        limit: { type: 'integer', minimum: 1, maximum: SEARCH_MAX_LIMIT, description: '문서 상한. 기본 20, 최대 100.' },
        cursor: { type: 'string', description: '이전 결과의 next cursor.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'history',
    description: '추적된 문서의 git 수정 이력을 본다. 추적 안 된 문서는 그 상태를 알린다. 최초가 1번이며, range는 먼저 diff 줄 수만 알리고 confirm에서 본문을 반환한다.',
    inputSchema: {
      type: 'object',
      properties: {
        doc: { type: 'string', description: DOC_DESC },
        limit: { description: '최근 몇 건을 볼지. 기본 5, 전체는 "all".' },
        range: {
          oneOf: [
            { type: 'string', description: '이력 번호 구간. 예: "34..35".' },
            {
              type: 'object',
              properties: { from: { type: 'integer' }, to: { type: 'integer' } },
              required: ['from', 'to'],
            },
          ],
        },
        confirm: { type: 'boolean', description: 'range diff 본문 반환 확인. 첫 호출에서는 생략.' },
      },
      required: ['doc'],
    },
  },
];

const TOOL_ORDER = ['map', 'search', 'outline', 'read', 'history'];
const TOOLS = TOOL_ORDER.map((name) => TOOL_DEFINITIONS.find((tool) => tool.name === name));
const DISPATCH = { map: toolMap, search: toolSearch, outline: toolOutline, read: toolRead, history: toolHistory };

function send(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }
function reply(id, result) { send({ jsonrpc: '2.0', id, result }); }
function replyErr(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }); }

function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    return reply(id, {
      protocolVersion: params?.protocolVersion || '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'docs-explorer-mcp', version: '0.1.0' },
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

function startServer() {
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
  log(`started. projectDir=${projectDir()}`);
}

const entryUrl = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (entryUrl === import.meta.url) startServer();

export {
  collectDocuments,
  collectMarkdownEntries,
  collectMarkdownPaths,
  loadFileHistory,
  loadGitMetadata,
  parseDoc,
  startServer,
  toolHistory,
  toolSearch,
};
