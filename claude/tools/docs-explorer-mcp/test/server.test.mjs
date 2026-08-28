import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  collectDocuments,
  collectMarkdownEntries,
  collectMarkdownPaths,
  loadFileHistory,
  loadGitMetadata,
  parseDoc,
  toolHistory,
  toolSearch,
} from '../server.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const SERVER = path.join(REPO, '.claude', 'tools', 'docs-explorer-mcp', 'server.mjs');
const MCP_CALL = path.join(REPO, '.claude', 'tools', 'mcp-call.mjs');
const ALIASES_PATH = '.claude/tools/docs-explorer-mcp/ALIASES.md';
const AUDIT_DEFINITION_SHA256 = 'b916be6abf796bf4cac1923f8ad0ef3b45817f2e6cc9ad8f128778c4ebe1e93a';

function mcpCallResult(tool, args, { projectDir } = {}) {
  const argv = [MCP_CALL, SERVER, tool];
  if (args !== undefined) argv.push(JSON.stringify(args));
  return spawnSync(process.execPath, argv, {
    cwd: REPO,
    encoding: 'utf8',
    env: projectDir ? { ...process.env, CLAUDE_PROJECT_DIR: projectDir } : process.env,
    maxBuffer: 64 * 1024 * 1024,
  });
}

function mcpCall(tool, args, options) {
  const result = mcpCallResult(tool, args, options);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

function withTempMarkdown(prefix, source, run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const file = path.join(dir, 'sample.md');
  try {
    fs.writeFileSync(file, source);
    return run(file, dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function withTempProject(prefix, files, run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    for (const [relativePath, source] of Object.entries(files)) {
      const file = path.join(root, ...relativePath.split('/'));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, source);
    }
    return run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function withProjectDir(root, run) {
  const previous = process.env.CLAUDE_PROJECT_DIR;
  process.env.CLAUDE_PROJECT_DIR = root;
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = previous;
  }
}

function gitLsFilePaths(args) {
  const result = spawnSync('git', ['ls-files', '-z', ...args], {
    cwd: REPO,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.split('\0').filter(Boolean);
}

function gitMarkdownPaths() {
  return gitLsFilePaths(['--', '*.md'])
    .filter((relativePath) => fs.existsSync(path.join(REPO, ...relativePath.split('/'))));
}

function isNodeModulesPath(relativePath) {
  return relativePath.split('/').includes('node_modules');
}

function expectedMarkdownEntries() {
  const entries = new Map();
  const add = (paths, trackingStatus) => {
    for (const relativePath of paths) {
      if (!relativePath.toLowerCase().endsWith('.md') || isNodeModulesPath(relativePath)) continue;
      if (!fs.existsSync(path.join(REPO, ...relativePath.split('/')))) continue;
      if (!entries.has(relativePath)) entries.set(relativePath, { path: relativePath, trackingStatus });
    }
  };
  add(gitMarkdownPaths(), 'tracked');
  add(gitLsFilePaths(['--others', '--exclude-standard', '--', '*.md']), 'untracked');
  add(
    gitLsFilePaths(['--others', '--ignored', '--exclude-standard', '--', '.claude'])
      .filter((relativePath) => relativePath.startsWith('.claude/')),
    'ignored',
  );
  return [...entries.values()].sort((a, b) => a.path.localeCompare(b.path));
}

function expectedMarkdownPaths() {
  return expectedMarkdownEntries().map((entry) => entry.path);
}

function countRawHeaderLike(paths) {
  let count = 0;
  for (const relativePath of paths) {
    const lines = fs.readFileSync(path.join(REPO, ...relativePath.split('/')), 'utf8').split('\n');
    for (const line of lines) {
      if (/^(#{1,6})\s+(.+?)\s*$/.test(line)) count += 1;
    }
  }
  return count;
}

function isBaselineFenceLine(line) {
  let i = 0;
  while (i < line.length) {
    const code = line.charCodeAt(i);
    if (code !== 9 && code !== 12 && code !== 13 && code !== 32) break;
    i += 1;
  }
  return line.startsWith('```', i);
}

// 성능 기준선: git 목록 → 파일당 read/split 1회 → 코드블록 제외 → 헤더 추출까지만 한다.
function collectHeaderBaseline() {
  const paths = expectedMarkdownPaths();
  let headerCount = 0;
  for (const relativePath of paths) {
    const lines = fs.readFileSync(path.join(REPO, ...relativePath.split('/')), 'utf8').split('\n');
    let inFence = false;
    for (const line of lines) {
      if (isBaselineFenceLine(line)) { inFence = !inFence; continue; }
      if (!inFence && /^(#{1,6})\s+(.+?)\s*$/.test(line)) headerCount += 1;
    }
  }
  return { documentCount: paths.length, headerCount };
}

let catalog;
function documents() {
  catalog ||= collectDocuments(REPO);
  return catalog;
}

test('3-1 parser smoke: 첫 헤더를 제목으로 빼고 모든 일반 헤더에 주소를 매긴다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-parser-'));
  const file = path.join(dir, 'sample.md');
  try {
    fs.writeFileSync(file, '# 제목\n\n## 첫 절\n\n```md\n# 가짜 헤더\n```\n\n#### 건너뛴 자식\n');
    const doc = parseDoc(file);
    assert.equal(doc.title, '제목');
    assert.equal(doc.headerCount, 3);
    assert.equal(doc.fencedHeaderCount, 1);
    assert.deepEqual(doc.sections.map((section) => section.address), ['1', '1-1']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('gate A/H: 추적·미추적·.claude 무시 md 전량과 상태를 인식한다', () => {
  const expectedEntries = expectedMarkdownEntries();
  const actualEntries = collectMarkdownEntries(REPO);
  assert.deepEqual(actualEntries, expectedEntries);
  assert.deepEqual(collectMarkdownPaths(REPO), expectedEntries.map((entry) => entry.path));
  assert.ok(actualEntries.some((entry) => /^\.claude\/tools\/[^/]+\/MANUAL\.md$/.test(entry.path)));
  assert.ok(actualEntries.some((entry) => entry.trackingStatus === 'ignored'));
  assert.ok(actualEntries.every((entry) => !isNodeModulesPath(entry.path)));
  const counts = Object.groupBy(actualEntries, (entry) => entry.trackingStatus);
  console.log(`documents=${actualEntries.length}`);
  console.log(`tracking_status=tracked:${counts.tracked?.length || 0},untracked:${counts.untracked?.length || 0},ignored:${counts.ignored?.length || 0}`);
});

test('gate A: 서버 헤더와 코드블록 헤더모양 줄의 합이 원시 총계와 일치한다', () => {
  const serverHeaders = documents().reduce((sum, doc) => sum + doc.headerCount, 0);
  const fencedHeaderLike = documents().reduce((sum, doc) => sum + doc.fencedHeaderCount, 0);
  const rawHeaderLike = countRawHeaderLike(expectedMarkdownPaths());
  assert.equal(serverHeaders + fencedHeaderLike, rawHeaderLike);
  console.log(`headers=${serverHeaders}`);
  console.log(`fenced_header_like=${fencedHeaderLike}`);
  console.log(`raw_header_like=${rawHeaderLike}`);
});

test('gate A: 자체 픽스처의 9개 절과 고정 길이가 정확하다', () => {
  const sections = Array.from({ length: 9 }, (_, index) => `## 절 ${index + 1}\n본문 ${index + 1}`);
  withTempMarkdown('docs-nine-sections-', ['# 제목', ...sections].join('\n'), (file) => {
    const doc = parseDoc(file);
    assert.equal(doc.sectionCount, 9);
    assert.deepEqual(doc.sections.map((section) => section.lineCount), Array(9).fill(2));
  });
});

test('gate A: 자체 픽스처는 급과 무관하게 첫 헤더만 제목으로 제외한다', () => {
  const source = '#### 제목\n# 첫 절\n## 자식\n### 손자\n# 둘째 절';
  withTempMarkdown('docs-first-header-', source, (file) => {
    const doc = parseDoc(file);
    assert.equal(doc.headerCount, 5);
    assert.equal(doc.sectionCount, 4);
    assert.deepEqual(doc.sections.map((section) => section.address), ['1', '1-1', '1-1-1', '2']);
  });
});

test('gate A: definition은 예약 주소이고 숫자 순번을 소비하지 않는다', () => {
  const doc = parseDoc(path.join(REPO, '_AUDIT', 'README.md'));
  assert.equal(doc.sections[0].address, 'definition');
  assert.equal(doc.sections[1].address, 'definition-1');
  assert.equal(doc.sections.find((section) => section.title === '정의')?.address, '1');
});

test('gate A: git이 없으면 Node 파일 순회로 내려간다', () => {
  const paths = collectMarkdownPaths(REPO, { gitCommand: '__onboarding_missing_git__' });
  assert.ok(paths.includes('CLAUDE.md'));
  assert.ok(paths.includes('.claude/tools/docs-explorer-mcp/MANUAL.md'));
  console.log(`fallback_documents=${paths.length}`);
});

test('gate A: 전수 수집의 세 쌍 중 최소 비율은 기준선의 2배 이내다', () => {
  const pairs = [];
  for (let i = 0; i < 3; i++) {
    let startedAt = performance.now();
    const baseline = collectHeaderBaseline();
    const baselineMs = performance.now() - startedAt;

    startedAt = performance.now();
    const scanned = collectDocuments(REPO);
    const scanMs = performance.now() - startedAt;

    assert.equal(scanned.length, baseline.documentCount);
    assert.equal(scanned.reduce((sum, doc) => sum + doc.headerCount, 0), baseline.headerCount);
    pairs.push({ baselineMs, scanMs, ratio: scanMs / baselineMs });
  }

  const minRatio = Math.min(...pairs.map((pair) => pair.ratio));
  const loadAverage = os.loadavg().map((value) => value.toFixed(2)).join(',');
  const pairValues = pairs.map((pair, index) => (
    `${index + 1}:baseline=${pair.baselineMs.toFixed(1)}ms,scan=${pair.scanMs.toFixed(1)}ms,ratio=${pair.ratio.toFixed(2)}x`
  )).join(' | ');
  console.log(`scan_pairs=${pairValues}`);
  console.log(`scan_ratio_min=${minRatio.toFixed(2)}`);
  console.log(`load_average=${loadAverage}`);
  assert.ok(
    minRatio <= 2.0,
    `전수 조사 성능 초과: pairs=[${pairValues}] min_ratio=${minRatio.toFixed(2)}x load_average=${loadAverage}`,
  );
});

test('gate B: AUDIT definition stdout이 개편 전 SHA-256과 같다', () => {
  const output = mcpCall('read', { doc: 'AUDIT', ids: ['definition'] });
  const digest = createHash('sha256').update(output).digest('hex');
  assert.equal(digest, AUDIT_DEFINITION_SHA256);
  console.log(`audit_definition_sha256=${digest}`);
});

test('gate B: 복수 주소는 순서대로 이어지고 각 부모의 하위 예시를 포함한다', () => {
  const output = mcpCall('read', { doc: 'AUDIT', ids: ['2-1', '2-4'] });
  assert.ok(output.indexOf('# 2-1 명명') < output.indexOf('# 2-4 반복·보수'));
  assert.ok(output.includes('### 2-1-1 예시'));
  assert.ok(output.includes('### 2-4-1 예시'));
  assert.equal((output.match(/\n---\n/g) || []).length, 1);
});

test('gate B: all은 문서 전체를 반환한다', () => {
  const output = mcpCall('read', { doc: 'AUDIT', ids: ['all'] });
  const expected = `${fs.readFileSync(path.join(REPO, '_AUDIT', 'README.md'), 'utf8').trim()}\n`;
  assert.equal(output, expected);
});

test('gate B: 없는 주소가 섞이면 본문 없이 오류와 outline만 반환한다', () => {
  const output = mcpCall('read', { doc: 'AUDIT', ids: ['definition', '9-9'] });
  assert.ok(output.startsWith('없는 주소: 9-9'));
  assert.ok(output.includes('이 문서의 목차:'));
  assert.ok(!output.includes('코드·시스템의 현재 상태를 **조사해서 판정한 기록**의 공간.'));
});

test('gate B: 주제명·상대경로·절대경로·폴더경로가 같은 문서를 읽는다', () => {
  const readme = path.join(REPO, '_AUDIT', 'README.md');
  const docs = ['AUDIT', '_AUDIT/README.md', readme, '_AUDIT'];
  const digests = docs.map((doc) => createHash('sha256')
    .update(mcpCall('read', { doc, ids: ['definition'] }))
    .digest('hex'));
  assert.deepEqual(digests, Array(docs.length).fill(AUDIT_DEFINITION_SHA256));
});

test('gate B: 자체 픽스처 outline은 모든 절에 줄 수를 붙인다', () => {
  const source = '# 제목\n## 첫 절\n본문\n### 자식\n본문\n## 둘째 절\n본문\n### 자식\n본문';
  withTempMarkdown('docs-outline-', source, (file) => {
    const output = mcpCall('outline', { doc: file });
    const sectionLines = output.split('\n').filter((line) => /^\s*- \S+.*\s\d+줄$/.test(line));
    assert.equal(sectionLines.length, 4);
    assert.ok(output.includes(file));
    assert.ok(output.includes('- 1 첫 절'));
    assert.ok(output.includes('  - 1-1 자식'));
    console.log(`fixture_outline_sections=${sectionLines.length}`);
  });
});

test('gate B: definition을 보유한 루트 README가 모두 예약 주소로 읽힌다', () => {
  const topics = gitMarkdownPaths()
    .filter((relativePath) => /^_[^/]+\/README\.md$/.test(relativePath))
    .filter((relativePath) => parseDoc(path.join(REPO, ...relativePath.split('/')))
      .sections.some((section) => section.address === 'definition'))
    .map((relativePath) => relativePath.slice(1, relativePath.indexOf('/')));
  assert.ok(topics.length > 0);
  for (const doc of topics) {
    assert.ok(mcpCall('read', { doc, ids: ['definition'] }).startsWith('# definition\n'), doc);
  }
  console.log(`definition_topics=${topics.length}`);
});

test('gate B: CHANGE_CHRONICLE의 기존 definition 부재를 자동 보정하지 않는다', () => {
  const output = mcpCall('read', { doc: 'CHANGE_CHRONICLE', ids: ['definition'] });
  assert.ok(output.startsWith('없는 주소: definition'));
});

function readCandidateRows(output) {
  return output.split('\n').map((line) => {
    const match = /^- (.+?\.md) \[([^\]]+)\] (.+)$/.exec(line);
    return match ? { path: match[1], address: match[2], title: match[3] } : null;
  }).filter(Boolean);
}

test('gate C read: doc 없이 CG 앵커를 대소문자 무시로 찾아 원문 한 절만 반환한다', () => {
  const file = path.join(REPO, '_CRAFT_GUIDE', 'clause-reference', 'CLIENT.md');
  const parsed = parseDoc(file);
  const section = parsed.sections.find((item) => item.title.includes('[CG-0241]'));
  assert.ok(section);
  const source = `_CRAFT_GUIDE/clause-reference/CLIENT.md [${section.address}] ${section.title}`;
  const nextAnchorLine = parsed.lines.indexOf('<a id="CG-0242"></a>', section.startLine - 1);
  assert.ok(nextAnchorLine > section.startLine - 1);
  const body = parsed.lines.slice(section.startLine - 1, nextAnchorLine).join('\n').trim();
  const expected = `출처: ${source}\n${body}\n`;
  assert.equal(mcpCall('read', { ids: ['cg-0241'] }), expected);
});

test('output polish read: 전역 앵커·헤더에는 출처를 붙이고 doc 명시 출력은 그대로다', () => {
  withTempProject('docs-read-source-', {
    'guide.md': '# 안내\n\n<a id="CG-9801"></a>\n## [CG-9801] Unique Header\n고유 본문\n',
  }, (root) => {
    const source = '출처: guide.md [1] [CG-9801] Unique Header\n';
    const body = '## [CG-9801] Unique Header\n고유 본문\n';
    const anchor = mcpCall('read', { ids: ['cg-9801'] }, { projectDir: root });
    const header = mcpCall('read', { ids: ['unique header'] }, { projectDir: root });
    const explicit = mcpCall('read', { doc: 'guide.md', ids: ['unique header'] }, { projectDir: root });

    assert.equal(anchor, `${source}${body}`);
    assert.equal(header, `${source}${body}`);
    assert.equal(explicit, body);
    assert.equal(explicit.includes('출처:'), false);
  });
});

test('output polish read: 다음 절 앵커 꼬리만 빼고 그 앵커 조회와 문서 끝 앵커는 보존한다', () => {
  withTempProject('docs-read-anchor-tail-', {
    'guide.md': [
      '# 안내',
      '',
      '<a id="CG-9810"></a>',
      '## [CG-9810] First Clause',
      '첫 본문',
      '',
      '<a id="CG-9811"></a>',
      '## [CG-9811] Second Clause',
      '둘째 본문',
      '',
      '<a id="document-tail"></a>',
    ].join('\n'),
  }, (root) => {
    const first = mcpCall('read', { ids: ['CG-9810'] }, { projectDir: root });
    const second = mcpCall('read', { ids: ['CG-9811'] }, { projectDir: root });

    assert.equal(first.includes('<a id="CG-9811"></a>'), false);
    assert.ok(first.endsWith('## [CG-9810] First Clause\n첫 본문\n'));
    assert.ok(second.startsWith('출처: guide.md [2] [CG-9811] Second Clause\n'));
    assert.ok(second.includes('## [CG-9811] Second Clause\n둘째 본문'));
    assert.ok(second.includes('<a id="document-tail"></a>'));
  });
});

test('gate C read: 전역 헤더 부분일치 복수는 동적 후보 집합만 반환한다', () => {
  const expected = documents().flatMap((doc) => doc.sections
    .filter((section) => section.title.toLowerCase().includes('mcp'))
    .map((section) => ({ path: doc.path, address: section.address, title: section.title })))
    .sort((a, b) => a.path.localeCompare(b.path) || a.address.localeCompare(b.address));
  assert.ok(expected.length > 1);
  assert.equal(expected.some((candidate) => candidate.title.toLowerCase() === 'mcp'), false);

  const output = mcpCall('read', { ids: ['MCP'] });
  assert.deepEqual(readCandidateRows(output), expected);
  assert.ok(output.includes('복수 매칭'));
  assert.ok(output.includes('본문을 반환하지 않음'));
  assert.ok(!output.includes('\n---\n'));
  assert.ok(!output.includes('\n- 상태: approved'));
});

test('gate C read: doc 안 복수도 후보만 반환하고 혼합 ids 전체를 원자적으로 막는다', () => {
  const source = '# 제목\n## Unique Header\n고유 본문\n## Shared Header\n첫 본문\n## shared header\n둘째 본문';
  withTempMarkdown('docs-read-ambiguous-', source, (file) => {
    const output = mcpCall('read', { doc: file, ids: ['unique header', 'SHARED HEADER'] });
    assert.equal(readCandidateRows(output).length, 2);
    assert.ok(output.includes('복수 매칭'));
    assert.ok(!output.includes('고유 본문'));
    assert.ok(!output.includes('첫 본문'));
    assert.ok(!output.includes('둘째 본문'));
  });
});

test('gate C read: 헤더 문자열은 대소문자 무시 완전일치 뒤 부분일치한다', () => {
  const source = '# 제목\n## CamelCase Header\n본문';
  withTempMarkdown('docs-read-header-', source, (file) => {
    const exact = mcpCall('read', { doc: file, ids: ['camelcase header'] });
    const partial = mcpCall('read', { doc: file, ids: ['CASE HEAD'] });
    assert.equal(exact, '## CamelCase Header\n본문\n');
    assert.equal(partial, exact);
  });
});

test('gate C read: doc 없는 위치 주소는 헤더로 재해석하지 않고 명시적으로 거부한다', () => {
  const result = mcpCallResult('read', { ids: ['1-1'] });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /위치 주소.*doc|doc.*위치 주소/);
});

test('gate C read: 전역 0건은 본문 없이 없는 주소를 안내한다', () => {
  const id = `__docs_missing_header_${Date.now()}__`;
  const output = mcpCall('read', { ids: [id] });
  assert.ok(output.startsWith(`없는 주소: ${id}`));
  assert.ok(output.includes('레포 전체'));
  assert.ok(!output.includes('\n---\n'));
});

test('gate C read: 기존 위치 주소 stdout은 개편 전 SHA-256과 같다', () => {
  const output = mcpCall('read', { doc: 'AUDIT', ids: ['definition'] });
  assert.equal(createHash('sha256').update(output).digest('hex'), AUDIT_DEFINITION_SHA256);
});

function rootMapOrder(output) {
  return output.split('\n')
    .filter((line) => /^- \S+/.test(line))
    .map((line) => /^- (\S+?)(?:\s{2}| —)/.exec(line)?.[1])
    .filter(Boolean);
}

function catalogRootCounts() {
  const counts = new Map();
  for (const relativePath of expectedMarkdownPaths()) {
    const root = relativePath.includes('/') ? relativePath.slice(0, relativePath.indexOf('/')) : '.';
    counts.set(root, (counts.get(root) || 0) + 1);
  }
  return counts;
}

function catalogChildFolderCounts(parent, population = expectedMarkdownPaths()) {
  const prefix = `${parent}/`;
  const counts = new Map();
  for (const relativePath of population) {
    if (!relativePath.startsWith(prefix)) continue;
    const remainder = relativePath.slice(prefix.length);
    const slash = remainder.indexOf('/');
    if (slash === -1) continue;
    const child = remainder.slice(0, slash);
    counts.set(child, (counts.get(child) || 0) + 1);
  }
  return counts;
}

function mapSecondLevelFolderCounts(output, parentName) {
  const lines = output.split('\n');
  const start = lines.findIndex((line) => line.startsWith(`- ${parentName}/  `));
  assert.ok(start >= 0, `${parentName} 없음`);
  const counts = new Map();
  for (let i = start + 1; i < lines.length && !lines[i].startsWith('- '); i++) {
    const match = /^  - (.+)\/  (\d+)개(?:\s|$)/.exec(lines[i]);
    if (match) counts.set(match[1], Number(match[2]));
  }
  return counts;
}

test('gate C/H: map 루트의 모든 폴더 개수는 동적 모집단과 같고 숨김 폴더도 보인다', () => {
  const output = mcpCall('map');
  const counts = catalogRootCounts();
  for (const root of counts.keys()) {
    if (root === '.') continue;
    assert.ok(output.includes(`- ${root}/  ${counts.get(root)}개`), root);
  }
  console.log(`map_counts=_RESEARCH:${counts.get('_RESEARCH')},_AUDIT:${counts.get('_AUDIT')},_CRAFT_GUIDE:${counts.get('_CRAFT_GUIDE')},.claude:${counts.get('.claude')}`);
});

test('gate C: ASCII 표본 _CRAFT_GUIDE 개수도 git -z 모집단과 같다', () => {
  const counts = catalogRootCounts();
  const output = mcpCall('map');
  assert.ok(output.includes(`- _CRAFT_GUIDE/  ${counts.get('_CRAFT_GUIDE')}개`));
});

function rootMapBlock(output, root) {
  const start = output.indexOf(`- ${root}/`);
  assert.ok(start >= 0, `${root} 없음`);
  const end = output.indexOf('\n- ', start + 1);
  return output.slice(start, end === -1 ? undefined : end);
}

test('gate C: 자체 픽스처에서 하위 문서 5개 초과는 접고 이하는 편다', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-map-fold-'));
  try {
    for (const [folder, count] of [['folded', 6], ['expanded', 5]]) {
      fs.mkdirSync(path.join(root, folder), { recursive: true });
      for (let index = 1; index <= count; index++) {
        fs.writeFileSync(path.join(root, folder, `${index}.md`), `# ${folder} ${index}\n`);
      }
    }
    const output = mcpCall('map', undefined, { projectDir: root });
    const folded = rootMapBlock(output, 'folded');
    const expanded = rootMapBlock(output, 'expanded');
    assert.ok(folded.startsWith('- folded/  6개'));
    assert.equal(/^  - /m.test(folded), false);
    assert.ok(expanded.startsWith('- expanded/  5개'));
    assert.equal(/^  - /m.test(expanded), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('gate C: map(_RESEARCH)는 바로 아래 날짜 폴더와 하위 합산 개수를 반환한다', () => {
  const output = mcpCall('map', { path: '_RESEARCH' });
  const expected = new Map();
  for (const doc of documents().filter((item) => item.path.startsWith('_RESEARCH/'))) {
    const child = doc.path.slice('_RESEARCH/'.length).split('/')[0];
    if (child !== doc.fileName) expected.set(child, (expected.get(child) || 0) + 1);
  }
  for (const [folder, count] of expected) assert.ok(output.includes(`- ${folder}/  ${count}개`), folder);
  assert.ok([...expected.keys()].some((folder) => /^\d{4}-\d{2}$/.test(folder)));
});

test('round2 map: _RESEARCH/2026-05의 바로 아래 폴더와 합산 개수를 동적 모집단대로 펼친다', () => {
  const population = expectedMarkdownPaths();
  const expected = catalogChildFolderCounts('_RESEARCH/2026-05', population);
  const parentCount = population.filter((relativePath) => relativePath.startsWith('_RESEARCH/2026-05/')).length;
  assert.ok(expected.size > 0 && expected.size <= 12);
  assert.equal([...expected.values()].reduce((sum, count) => sum + count, 0), parentCount);

  const actual = mapSecondLevelFolderCounts(mcpCall('map', { path: '_RESEARCH' }), '2026-05');
  assert.deepEqual(actual, expected);
  console.log(`round2_map_children=${expected.size}`);
  console.log(`round2_map_parent_documents=${parentCount}`);
});

test('round2 map: 바로 아래 폴더가 12개를 넘는 경로는 2차 폴더를 접는다', () => {
  const population = expectedMarkdownPaths();
  const parents = new Set();
  for (const relativePath of population) {
    const parts = relativePath.split('/');
    for (let depth = 1; depth < parts.length - 1; depth++) {
      parents.add(parts.slice(0, depth).join('/'));
    }
  }
  const foldedParent = [...parents]
    .map((parent) => ({ parent, children: catalogChildFolderCounts(parent, population) }))
    .find(({ parent, children }) => parent.includes('/') && children.size > 12);
  assert.ok(foldedParent, '하위 폴더 12개 초과 동적 표본 없음');

  const slash = foldedParent.parent.lastIndexOf('/');
  const mapPath = foldedParent.parent.slice(0, slash);
  const parentName = foldedParent.parent.slice(slash + 1);
  const actual = mapSecondLevelFolderCounts(mcpCall('map', { path: mapPath }), parentName);
  assert.equal(actual.size, 0);
  console.log(`round2_map_folded=${foldedParent.parent}:${foldedParent.children.size}`);
});

test('gate C: 네 정렬은 서로 다르고 각 정렬키의 내림차순과 일치한다', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-map-sort-'));
  try {
    const fixtures = [
      ['beta/doc.md', '# beta'],
      ['delta/doc.md', '# delta\n1\n2\n3\n4\n5\n6\n7'],
      ['gamma/doc.md', '# gamma\n1\n2'],
      ['alpha/doc.md', '# alpha\n1\n2\n3\n4'],
    ];
    const timestampWait = new Int32Array(new SharedArrayBuffer(4));
    for (const [relativePath, source] of fixtures) {
      const file = path.join(root, ...relativePath.split('/'));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, source);
      Atomics.wait(timestampWait, 0, 0, 20);
    }
    const modifiedTimes = new Map([
      ['alpha/doc.md', '2030-01-02T00:00:00Z'],
      ['beta/doc.md', '2030-01-04T00:00:00Z'],
      ['delta/doc.md', '2030-01-01T00:00:00Z'],
      ['gamma/doc.md', '2030-01-03T00:00:00Z'],
    ]);
    for (const [relativePath, timestamp] of modifiedTimes) {
      fs.utimesSync(path.join(root, ...relativePath.split('/')), new Date(timestamp), new Date(timestamp));
    }

    const sorts = ['alphabetical', 'modified', 'created', 'lines'];
    const orders = new Map(sorts.map((sort) => [
      sort,
      rootMapOrder(mcpCall('map', { sort }, { projectDir: root })),
    ]));
    assert.equal(new Set([...orders.values()].map((order) => order.join('\0'))).size, sorts.length);

    const docs = collectDocuments(root);
    const expected = new Map();
    const names = new Set(docs.map((doc) => `${doc.path.slice(0, doc.path.indexOf('/'))}/`));
    for (const sort of sorts) {
      const values = [...names].map((name) => {
        const children = docs.filter((doc) => doc.path.startsWith(name));
        return {
          name,
          modifiedAt: children.reduce((value, doc) => doc.modifiedAt > value ? doc.modifiedAt : value, ''),
          createdAt: children.reduce((value, doc) => doc.createdAt > value ? doc.createdAt : value, ''),
          lineCount: children.reduce((sum, doc) => sum + doc.lineCount, 0),
        };
      });
      values.sort((a, b) => {
        const alpha = a.name.replace(/\/$/, '').localeCompare(b.name.replace(/\/$/, ''));
        if (sort === 'modified') return b.modifiedAt.localeCompare(a.modifiedAt) || alpha;
        if (sort === 'created') return b.createdAt.localeCompare(a.createdAt) || alpha;
        if (sort === 'lines') return b.lineCount - a.lineCount || alpha;
        return alpha;
      });
      expected.set(sort, values.map((entry) => entry.name));
      assert.deepEqual(orders.get(sort), expected.get(sort), sort);
    }
    console.log([...orders].map(([sort, order]) => `${sort}=${order.join(',')}`).join('\n'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const searchOutputCache = new Map();
function searchCall(args) {
  const key = JSON.stringify(args);
  if (!searchOutputCache.has(key)) searchOutputCache.set(key, mcpCall('search', args));
  return searchOutputCache.get(key);
}

function expectedSearchPaths(query, scope = '', population = expectedMarkdownPaths()) {
  const queryLower = query.toLowerCase();
  return population.filter((relativePath) => {
    if (scope && relativePath !== scope && !relativePath.startsWith(`${scope}/`)) return false;
    if (relativePath.toLowerCase().includes(queryLower)) return true;
    return fs.readFileSync(path.join(REPO, ...relativePath.split('/')), 'utf8').toLowerCase().includes(queryLower);
  });
}

function searchDocumentCount(output) {
  const count = Number(/검색: (\d+)개 문서/.exec(output)?.[1]);
  assert.ok(Number.isInteger(count), '검색 결과 문서 수 없음');
  return count;
}

function searchResultPaths(output) {
  return output.split('\n')
    .map((line) => /^(\S.*?\.md) — /.exec(line)?.[1])
    .filter(Boolean);
}

function searchResultMatchedQueries(output) {
  const matched = new Map();
  let currentPath = null;
  for (const line of output.split('\n')) {
    const pathMatch = /^(\S.*?\.md) — /.exec(line);
    if (pathMatch) {
      currentPath = pathMatch[1];
      continue;
    }
    const queryMatch = /^  매치 검색어: (\[.*\])$/.exec(line);
    if (currentPath && queryMatch) matched.set(currentPath, JSON.parse(queryMatch[1]));
  }
  return matched;
}

function allSearchPages(args) {
  const paths = new Set();
  const matchedQueries = new Map();
  let cursor;
  let total = null;
  do {
    const output = toolSearch({ ...args, limit: 100, ...(cursor ? { cursor } : {}) });
    const pageTotal = searchDocumentCount(output);
    total ??= pageTotal;
    assert.equal(pageTotal, total);
    for (const relativePath of searchResultPaths(output)) {
      assert.equal(paths.has(relativePath), false, `페이지 중복: ${relativePath}`);
      paths.add(relativePath);
    }
    for (const [relativePath, queries] of searchResultMatchedQueries(output)) {
      matchedQueries.set(relativePath, queries);
    }
    cursor = /^next cursor: (\S+)$/m.exec(output)?.[1];
  } while (cursor);
  assert.equal(paths.size, total);
  return { paths, matchedQueries };
}

function searchResultKeys(output) {
  const keys = [];
  let currentPath = '';
  for (const line of output.split('\n')) {
    const pathMatch = /^(\S.*\.md) — /.exec(line);
    if (pathMatch) { currentPath = pathMatch[1]; continue; }
    const addressMatch = /^  \[([^\]]+)\]/.exec(line);
    if (currentPath && addressMatch) keys.push(`${currentPath}\0${addressMatch[1]}`);
  }
  return keys;
}

test('3-4 search: 수정 날짜 조건과 줄 수 정렬을 함께 적용한다', () => {
  const population = gitMarkdownPaths();
  const modifiedFrom = new Date('2026-08-15T00:00:00').getTime();
  const modifiedTo = new Date('2026-08-15T23:59:59.999').getTime();
  const expected = expectedSearchPaths('업로드', '_CRAFT_GUIDE', population)
    .map((relativePath) => ({
      path: relativePath,
      modified: fs.statSync(path.join(REPO, ...relativePath.split('/'))).mtimeMs,
      lines: parseDoc(path.join(REPO, ...relativePath.split('/'))).lineCount,
    }))
    .filter((item) => item.modified >= modifiedFrom && item.modified <= modifiedTo)
    .sort((a, b) => b.lines - a.lines || a.path.localeCompare(b.path));
  const output = toolSearch({
    query: '업로드',
    scope: '_CRAFT_GUIDE',
    modifiedFrom: '2026-08-15',
    modifiedTo: '2026-08-15',
    sort: 'lines',
    limit: 5,
  }, { collectPaths: () => population });
  assert.equal(searchDocumentCount(output), expected.length);
  assert.deepEqual(searchResultPaths(output), expected.slice(0, 5).map((item) => item.path));
});

test('3-5 git metadata: 결과 12개를 한 git 호출로 보강한다', () => {
  const paths = expectedSearchPaths('업로드').slice(0, 12);
  let calls = 0;
  const startedAt = performance.now();
  const metadata = loadGitMetadata(paths, {
    root: REPO,
    run(command, args, options) {
      calls += 1;
      return spawnSync(command, args, options);
    },
  });
  const elapsed = performance.now() - startedAt;
  assert.equal(calls, 1);
  assert.equal(metadata.size, paths.length);
  assert.ok([...metadata.values()].some((item) => item.gitDate && item.revisionCount > 0));
  console.log(`git_metadata_paths=${paths.length}`);
  console.log(`git_metadata_calls=${calls}`);
  console.log(`git_metadata_ms=${elapsed.toFixed(1)}`);
});

test('3-5 git metadata: 기본 search는 이력 로더를 호출하지 않는다', () => {
  let calls = 0;
  const output = toolSearch(
    { query: '업로드', scope: '_CRAFT_GUIDE', limit: 2 },
    { loadGit() { calls += 1; return new Map(); } },
  );
  assert.equal(calls, 0);
  assert.ok(!output.includes(' · 커밋 '));
});

test('3-5 git metadata: 명시 search는 한 호출로 세 날짜를 나란히 표시한다', () => {
  let calls = 0;
  let requestedPaths = [];
  const output = toolSearch(
    { query: '업로드', scope: '_CRAFT_GUIDE', limit: 2, git: true },
    {
      loadGit(paths) {
        calls += 1;
        requestedPaths = paths;
        return new Map(paths.map((file) => [file, {
          gitDate: '2026-08-15T12:00:00+09:00',
          revisionCount: 7,
        }]));
      },
    },
  );
  assert.equal(calls, 1);
  assert.equal(requestedPaths.length, 2);
  assert.match(output, /생성 \d{4}-\d{2}-\d{2} · 수정 \d{4}-\d{2}-\d{2} · INDEX (?:등재|미등재|해당 없음) · 커밋 2026-08-15 · 7회/);
});

test('3-5 git metadata: map 명시 요청도 펼친 문서에 git 정보를 붙인다', () => {
  const output = mcpCall('map', { path: '_MANUALS', git: true });
  assert.match(output, /INDEX\.md[^\n]+· 커밋 \d{4}-\d{2}-\d{2} · \d+회/);
  assert.match(output, /README\.md[^\n]+· 커밋 \d{4}-\d{2}-\d{2} · \d+회/);
});

test('3-5 git metadata: git 부재는 명시 요청에서 원인을 반환한다', () => {
  assert.throws(
    () => loadGitMetadata(['CLAUDE.md'], { root: REPO, gitCommand: '__onboarding_missing_git__' }),
    /git 정보를 읽을 수 없습니다/,
  );
});

test('3-6 history: 실제 git 이력을 최초 1번부터 매겨 전체와 최근 5건을 반환한다', () => {
  const history = loadFileHistory('CLAUDE.md', { root: REPO });
  const all = mcpCall('history', { doc: 'CLAUDE.md', limit: 'all' });
  const allRows = all.split('\n').filter((line) => /^\d+  \d{2}-\d{2}  /.test(line));
  assert.equal(allRows.length, history.length);
  assert.ok(allRows[0].startsWith(`${history.length}  `));
  assert.ok(allRows.at(-1).startsWith('1  '));

  const recent = mcpCall('history', { doc: 'CLAUDE.md' });
  const recentRows = recent.split('\n').filter((line) => /^\d+  \d{2}-\d{2}  /.test(line));
  assert.equal(recentRows.length, 5);
  assert.ok(recent.includes('전체는 limit: "all"'));
  console.log(`claude_history_count=${history.length}`);
});

test('3-6 history: range는 먼저 줄 수만 알리고 confirm에서 지정 파일 diff만 반환한다', () => {
  const history = loadFileHistory('CLAUDE.md', { root: REPO });
  const range = `${history.length - 1}..${history.length}`;
  const preview = mcpCall('history', { doc: 'CLAUDE.md', range });
  const expectedLines = Number(/diff (\d+)줄/.exec(preview)?.[1]);
  assert.ok(Number.isInteger(expectedLines));
  assert.ok(preview.includes('confirm: true'));
  assert.ok(!preview.includes('diff --git'));

  const confirmed = mcpCall('history', { doc: 'CLAUDE.md', range, confirm: true });
  const returnedBody = confirmed.slice(confirmed.indexOf('\n\n') + 2);
  const diff = returnedBody.endsWith('\n') ? returnedBody.slice(0, -1) : returnedBody;
  assert.equal(diff === '' ? 0 : diff.split('\n').length, expectedLines);
  assert.match(diff, /^diff --git a\/CLAUDE\.md b\/CLAUDE\.md/m);
  assert.equal((diff.match(/^diff --git /gm) || []).length, 1);
  console.log(`history_diff_range=${range}`);
  console.log(`history_diff_lines=${expectedLines}`);
});

test('gate E: 결과 12개 git 정보는 한 호출에 몰아 붙인다', () => {
  const paths = expectedSearchPaths('업로드').slice(0, 12);
  const samples = [];
  for (let i = 0; i < 3; i++) {
    const startedAt = performance.now();
    const metadata = loadGitMetadata(paths, { root: REPO });
    samples.push(performance.now() - startedAt);
    assert.equal(metadata.size, paths.length);
  }
  const fastest = Math.min(...samples);
  console.log(`load_average=${os.loadavg().map((value) => value.toFixed(2)).join(',')}`);
  console.log(`git_batch_ms=${samples.map((elapsed) => elapsed.toFixed(1)).join(',')}`);
  console.log(`git_batch_min_ms=${fastest.toFixed(1)}`);
});

test('gate E: git 인자 없는 search는 git 메타데이터 호출 0회다', () => {
  let gitMetadataCalls = 0;
  const samples = [];
  for (let i = 0; i < 3; i++) {
    const startedAt = performance.now();
    toolSearch(
      { query: '업로드', limit: 12 },
      { loadGit() { gitMetadataCalls += 1; return new Map(); } },
    );
    samples.push(performance.now() - startedAt);
  }
  const fastest = Math.min(...samples);
  console.log(`search_ms=${samples.map((elapsed) => elapsed.toFixed(1)).join(',')}`);
  console.log(`search_min_ms=${fastest.toFixed(1)}`);
  console.log(`search_git_metadata_calls=${gitMetadataCalls}`);
  assert.equal(gitMetadataCalls, 0);
});

test('gate E: CLAUDE.md 이력은 git --follow 집계와 같고 최초가 1번이다', () => {
  const expected = spawnSync('git', ['log', '--oneline', '--follow', '--', 'CLAUDE.md'], {
    cwd: REPO,
    encoding: 'utf8',
  });
  assert.equal(expected.status, 0, expected.stderr);
  const expectedCount = expected.stdout.trim().split('\n').filter(Boolean).length;
  const output = mcpCall('history', { doc: 'CLAUDE.md', limit: 'all' });
  const rows = output.split('\n').filter((line) => /^\d+  \d{2}-\d{2}  /.test(line));
  assert.equal(rows.length, expectedCount);
  assert.ok(rows[0].startsWith(`${expectedCount}  `));
  assert.ok(rows.at(-1).startsWith('1  '));
});

test('gate E: range는 줄 수 안내 후 confirm에서 지정 구간만 반환한다', () => {
  const history = loadFileHistory('CLAUDE.md', { root: REPO });
  const range = `${history.length - 1}..${history.length}`;
  const preview = mcpCall('history', { doc: 'CLAUDE.md', range });
  const expectedLines = Number(/diff (\d+)줄/.exec(preview)?.[1]);
  assert.ok(preview.includes('confirm: true'));
  assert.ok(!preview.includes('diff --git'));

  const confirmed = mcpCall('history', { doc: 'CLAUDE.md', range, confirm: true });
  const returnedBody = confirmed.slice(confirmed.indexOf('\n\n') + 2);
  const diff = returnedBody.endsWith('\n') ? returnedBody.slice(0, -1) : returnedBody;
  assert.equal(diff === '' ? 0 : diff.split('\n').length, expectedLines);
  assert.equal((diff.match(/^diff --git /gm) || []).length, 1);
  assert.match(diff, /^diff --git a\/CLAUDE\.md b\/CLAUDE\.md/m);
});

test('gate E: 도구 목록은 map, search, outline, read, history 다섯 개다', () => {
  const result = spawnSync(process.execPath, [MCP_CALL, SERVER, '--tools'], {
    cwd: REPO,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const names = result.stdout.split('\n')
    .map((line) => /^- ([^(]+)\(/.exec(line)?.[1])
    .filter(Boolean);
  assert.deepEqual(names, ['map', 'search', 'outline', 'read', 'history']);
});

test('3-7 alias: 자체 픽스처의 직접 히트 없는 질의를 별칭으로 확장하고 사용한 별칭을 표시한다', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-alias-'));
  try {
    const aliasesFile = path.join(root, ...ALIASES_PATH.split('/'));
    fs.mkdirSync(path.dirname(aliasesFile), { recursive: true });
    fs.writeFileSync(aliasesFile, '- 파일첨부 = 업로드\n');
    const source = '# 저장 규칙\n\n## 업로드 흐름 표준\n본문\n';
    fs.writeFileSync(path.join(root, 'guide.md'), source);
    assert.equal(source.includes('파일첨부'), false);

    const output = withProjectDir(root, () => toolSearch(
      { query: '파일첨부', limit: 100 },
      { collectPaths: () => ['guide.md'] },
    ));
    assert.ok(output.includes('guide.md'));
    assert.ok(output.includes('[1] 업로드 흐름 표준'));
    assert.ok(output.includes('별칭: 파일첨부 → 업로드'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('3-7 alias: ALIASES 문서의 직접 히트는 별칭 결과보다 우선하고 별칭으로 표시하지 않는다', () => {
  withTempProject('docs-alias-priority-', {
    [ALIASES_PATH]: '- 파일첨부 = 업로드\n',
    '_GUIDE/STORAGE.md': '# 저장 규칙\n\n## 업로드 흐름\n본문\n',
  }, (root) => {
    const output = withProjectDir(root, () => toolSearch(
      { query: '파일첨부', limit: 100 },
      { collectPaths: () => [ALIASES_PATH, '_GUIDE/STORAGE.md'] },
    ));
    assert.deepEqual(searchResultPaths(output), [ALIASES_PATH, '_GUIDE/STORAGE.md']);
    const directBlock = output.slice(output.indexOf(ALIASES_PATH), output.indexOf('_GUIDE/STORAGE.md'));
    const aliasBlock = output.slice(output.indexOf('_GUIDE/STORAGE.md'));
    assert.ok(!directBlock.includes('별칭: 파일첨부 → 업로드'));
    assert.ok(aliasBlock.includes('별칭: 파일첨부 → 업로드'));
  });
});

test('3-7 index: DocumentRecord와 출력에 등재·미등재·해당 없음을 구별한다', () => {
  withTempProject('docs-index-status-', {
    '_GUIDE/INDEX.md': '# 목록\n\n- [저장 규칙](STORAGE.md)\n',
    '_GUIDE/README.md': '# 안내\n',
    '_GUIDE/STORAGE.md': '# 저장 규칙\n',
    '_GUIDE/UNLISTED.md': '# unlisted-fixture\n',
    'CLAUDE.md': '# 현관\n',
  }, (root) => {
    const byPath = new Map(collectDocuments(root).map((doc) => [doc.path, doc]));
    assert.equal(byPath.get('_GUIDE/STORAGE.md')?.indexStatus, '등재');
    assert.equal(byPath.get('_GUIDE/UNLISTED.md')?.indexStatus, '미등재');
    assert.equal(byPath.get('CLAUDE.md')?.indexStatus, '해당 없음');
    assert.equal(byPath.get('_GUIDE/INDEX.md')?.indexStatus, '해당 없음');

    const output = mcpCall('search', {
      query: 'unlisted-fixture',
      scope: '_GUIDE',
      limit: 5,
    }, { projectDir: root });
    assert.ok(output.includes('_GUIDE/UNLISTED.md'));
    assert.ok(output.includes('INDEX 미등재'));
  });
});

test('gate F: 별칭 확장과 INDEX 미등재 신호가 최종 출력에 함께 선다', () => {
  const aliasOutput = mcpCall('search', { query: '파일첨부', limit: 100 });
  assert.ok(aliasOutput.includes('_CRAFT_GUIDE/STORAGE.md'));
  assert.ok(aliasOutput.includes('별칭: 파일첨부 → 업로드'));

  const indexOutput = mcpCall('search', {
    query: '2026-08-08-mochung-card-cover',
    scope: '_PROTOTYPES',
    limit: 5,
  });
  assert.ok(indexOutput.includes('INDEX 미등재'));
});

test('gate F: 프로젝트 매뉴얼과 _MANUALS INDEX가 다섯 도구와 최신 경계를 설명한다', () => {
  const manual = fs.readFileSync(path.join(REPO, '.claude/tools/docs-explorer-mcp/MANUAL.md'), 'utf8');
  const manualsIndex = fs.readFileSync(path.join(REPO, '_MANUALS/INDEX.md'), 'utf8');
  for (const name of ['map', 'search', 'outline', 'read', 'history']) {
    assert.ok(manual.includes(name), `MANUAL에 ${name} 없음`);
    assert.ok(manualsIndex.includes(name), `_MANUALS/INDEX에 ${name} 없음`);
  }
  assert.ok(manual.includes('git ls-files'));
  assert.ok(manual.includes('INDEX 미등재'));
  assert.ok(manual.includes('--follow'));
  assert.ok(manual.includes('이름 변경'));
  assert.ok(manual.includes('출처: 경로 [주소] 헤더'));
  assert.ok(manual.includes('다음 절의 독립 `<a id="…"></a>`'));
  assert.ok(manual.includes('만료 또는 조건 불일치 오류'));
});

test('gate D/H: 전체와 scope 검색 수가 같은 동적 모집단 집계와 같고 두 자릿수 이상 준다', () => {
  const population = expectedMarkdownPaths();
  const allExpected = expectedSearchPaths('업로드', '', population);
  const scopedExpected = expectedSearchPaths('업로드', '_CRAFT_GUIDE', population);
  const all = toolSearch({ query: '업로드' }, { collectPaths: () => population });
  const scoped = toolSearch(
    { query: '업로드', scope: '_CRAFT_GUIDE', limit: 100 },
    { collectPaths: () => population },
  );
  assert.equal(searchDocumentCount(all), allExpected.length);
  assert.equal(searchDocumentCount(scoped), scopedExpected.length);
  assert.ok(
    allExpected.length - scopedExpected.length >= 10,
    `scope로 줄어든 문서가 ${allExpected.length - scopedExpected.length}개뿐임`,
  );
  console.log(`upload_documents=${allExpected.length}`);
  console.log(`upload_craft_guide_documents=${scopedExpected.length}`);
  console.log(`upload_scope_reduction=${allExpected.length - scopedExpected.length}`);
});

test('gate D: STORAGE의 헤더 매치는 본문보다 위이고 본문 전용 문서보다 먼저다', () => {
  withTempProject('docs-search-strength-', {
    '_GUIDE/STORAGE.md': '# STORAGE\n\n## 업로드 흐름 표준\n헤더 본문\n\n## 신규 업로드 기능 체크리스트\n헤더 본문\n\n## 기타\n업로드 본문\n',
    '_GUIDE/BACKEND_STRUCTURE.md': '# 백엔드 구조\n\n## 일반 절\n업로드를 본문에서만 언급합니다.\n',
  }, (root) => {
    const output = withProjectDir(root, () => toolSearch(
      { query: '업로드', scope: '_GUIDE', limit: 5 },
      { collectPaths: () => ['_GUIDE/STORAGE.md', '_GUIDE/BACKEND_STRUCTURE.md'] },
    ));
    const paths = searchResultPaths(output);
    assert.ok(paths.indexOf('_GUIDE/STORAGE.md') < paths.indexOf('_GUIDE/BACKEND_STRUCTURE.md'));
    const storage = output.slice(output.indexOf('_GUIDE/STORAGE.md'), output.indexOf('_GUIDE/BACKEND_STRUCTURE.md'));
    const firstBody = storage.indexOf('← 본문');
    assert.ok(storage.indexOf('[1] 업로드 흐름 표준') < firstBody);
    assert.ok(storage.indexOf('[2] 신규 업로드 기능 체크리스트') < firstBody);
  });
});

test('gate D: STORAGE 정확 일치는 대소문자를 무시하고 해당 검색 1위다', () => {
  withTempProject('docs-search-exact-', {
    '_GUIDE/STORAGE.md': '# 저장 규칙\n\n## 본문\n내용\n',
    '_GUIDE/STORAGE-NOTES.md': '# 저장 메모\n',
  }, (root) => {
    for (const query of ['STORAGE', 'storage']) {
      const output = mcpCall('search', { query, limit: 5 }, { projectDir: root });
      assert.equal(searchResultPaths(output)[0], '_GUIDE/STORAGE.md');
      assert.match(output, /_GUIDE\/STORAGE\.md[\s\S]*?\[all\] STORAGE\.md[^\n]*← 정확 일치/);
    }
  });
});

test('gate D: guestbook은 폴더명 매치가 최상위다', () => {
  const output = searchCall({ query: 'guestbook', limit: 5 });
  const firstPath = searchResultPaths(output)[0];
  const firstBlock = output.slice(output.indexOf(firstPath), output.indexOf('\n\n', output.indexOf(firstPath)));
  assert.ok(firstPath.includes('guestbook'));
  assert.ok(firstBlock.includes('← 폴더명'));
});

test('gate D: limit과 cursor 페이지의 경로·주소가 겹치지 않는다', () => {
  const first = searchCall({ query: '업로드', limit: 3 });
  const cursor = /^next cursor: (\S+)$/m.exec(first)?.[1];
  assert.ok(cursor);
  assert.equal(searchResultPaths(first).length, 3);

  const second = searchCall({ query: '업로드', limit: 3, cursor });
  assert.equal(searchResultPaths(second).length, 3);
  const firstKeys = new Set(searchResultKeys(first));
  const overlap = searchResultKeys(second).filter((key) => firstKeys.has(key));
  assert.deepEqual(overlap, []);
  console.log(`cursor_overlap=${overlap.length}`);
});

test('output polish search: 짧은 cursor가 새 프로세스 왕복을 보존하고 옛 형식은 만료 오류다', () => {
  const files = Object.fromEntries(Array.from({ length: 6 }, (_, index) => [
    `docs/${index + 1}.md`,
    `# 문서 ${index + 1}\n\n## cursor-fixture\n본문 ${index + 1}\n`,
  ]));
  withTempProject('docs-search-cursor-', files, (root) => {
    const args = { query: 'cursor-fixture', sort: 'alphabetical' };
    const first = mcpCall('search', { ...args, limit: 2 }, { projectDir: root });
    const cursor = /^next cursor: (\S+)$/m.exec(first)?.[1];
    assert.ok(cursor);
    assert.ok(cursor.length <= 64, `cursor가 ${cursor.length}자임`);

    const second = mcpCall('search', { ...args, limit: 2, cursor }, { projectDir: root });
    const direct = mcpCall('search', { ...args, limit: 4 }, { projectDir: root });
    assert.deepEqual(
      [...searchResultPaths(first), ...searchResultPaths(second)],
      searchResultPaths(direct),
    );

    const expired = mcpCallResult('search', { ...args, limit: 2, cursor: 'v0.1.stale' }, { projectDir: root });
    assert.equal(expired.status, 1);
    assert.match(expired.stdout, /cursor.*만료|만료.*cursor/);
  });
});

test('round2 search: 문자열 query는 직접 호출과 MCP 호출의 출력이 바이트 동일하다', () => {
  const args = { query: '업로드', scope: '_CRAFT_GUIDE', limit: 5 };
  const direct = toolSearch(args);
  const throughMcp = mcpCall('search', args);
  assert.equal(throughMcp.replace(/\n$/, ''), direct);
  assert.equal(direct.includes('매치 검색어:'), false);
  console.log(`round2_string_sha256=${createHash('sha256').update(direct).digest('hex')}`);
});

test('round2 search: query 배열은 단독 검색들의 정확한 합집합이고 문서마다 매치 검색어를 표시한다', () => {
  const queries = ['마이그레이션', 'migration'];
  const standalone = new Map(queries.map((query) => [query, allSearchPages({ query }).paths]));
  const expectedUnion = new Set(queries.flatMap((query) => [...standalone.get(query)]));
  const combined = allSearchPages({ query: queries });
  assert.deepEqual([...combined.paths].sort(), [...expectedUnion].sort());

  for (const relativePath of combined.paths) {
    const expectedQueries = queries.filter((query) => standalone.get(query).has(relativePath));
    assert.deepEqual(combined.matchedQueries.get(relativePath), expectedQueries, relativePath);
  }
  const mcpOutput = mcpCall('search', { query: queries, limit: 1 });
  assert.match(mcpOutput, /^  매치 검색어: \[.*\]$/m);
  console.log(`round2_or_documents=${combined.paths.size}`);
});

test('round2 search: 빈 문자열과 빈 배열은 명시적 오류다', () => {
  assert.throws(() => toolSearch({ query: '' }), /query/);
  assert.throws(() => toolSearch({ query: [] }), /query/);
});

test('gate H: 수집층은 임시 저장소에서도 추적·미추적·무시됨을 나누고 node_modules를 뺀다', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-tracking-'));
  try {
    fs.mkdirSync(path.join(root, '.claude', 'node_modules'), { recursive: true });
    fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(root, '.gitignore'), '.claude/\nnode_modules/\n');
    fs.writeFileSync(path.join(root, 'tracked.md'), '# tracked\n');
    fs.writeFileSync(path.join(root, 'draft.md'), '# draft\n');
    fs.writeFileSync(path.join(root, '.claude', 'ignored.md'), '# ignored\n');
    fs.writeFileSync(path.join(root, '.claude', 'node_modules', 'skip.md'), '# skip\n');
    fs.writeFileSync(path.join(root, 'node_modules', 'skip.md'), '# skip\n');
    const initialized = spawnSync('git', ['init', '-q'], { cwd: root, encoding: 'utf8' });
    assert.equal(initialized.status, 0, initialized.stderr);
    const added = spawnSync('git', ['add', '.gitignore', 'tracked.md'], { cwd: root, encoding: 'utf8' });
    assert.equal(added.status, 0, added.stderr);

    assert.deepEqual(collectMarkdownEntries(root), [
      { path: '.claude/ignored.md', trackingStatus: 'ignored' },
      { path: 'draft.md', trackingStatus: 'untracked' },
      { path: 'tracked.md', trackingStatus: 'tracked' },
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('수집층은 git index에만 남고 작업트리에서 사라진 md를 건너뛴다', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-deleted-'));
  try {
    fs.writeFileSync(path.join(root, 'kept.md'), '# kept\n');
    fs.writeFileSync(path.join(root, 'renamed-from.md'), '# old\n');
    const initialized = spawnSync('git', ['init', '-q'], { cwd: root, encoding: 'utf8' });
    assert.equal(initialized.status, 0, initialized.stderr);
    const added = spawnSync('git', ['add', 'kept.md', 'renamed-from.md'], { cwd: root, encoding: 'utf8' });
    assert.equal(added.status, 0, added.stderr);
    fs.unlinkSync(path.join(root, 'renamed-from.md'));

    assert.deepEqual(collectMarkdownEntries(root), [
      { path: 'kept.md', trackingStatus: 'tracked' },
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('gate H: 계획서와 campaigns 문서를 찾고 node_modules는 수집하지 않는다', () => {
  const entries = expectedMarkdownEntries();
  const actual = collectMarkdownEntries(REPO);
  assert.deepEqual(actual, entries);
  assert.ok(actual.every((entry) => !isNodeModulesPath(entry.path)));

  const planPath = '.claude/plans/2026-08-16-onboarding-mcp-repo-map/PLAN.md';
  const planOutput = mcpCall('search', { query: 'onboarding-mcp-repo-map', limit: 100 });
  assert.ok(planOutput.includes(planPath));

  const campaign = entries.find((entry) => (
    entry.trackingStatus === 'ignored'
    && entry.path.startsWith('.claude/campaigns/')
  ));
  assert.ok(campaign, '검색할 campaigns 무시 문서 없음');
  const query = path.posix.basename(campaign.path).replace(/\.md$/i, '');
  const campaignOutput = mcpCall('search', { query, scope: '.claude/campaigns', limit: 100 });
  assert.ok(campaignOutput.includes(campaign.path));
  console.log(`gate_h_plan=${planPath}`);
  console.log(`gate_h_campaign=${campaign.path}`);
  console.log(`gate_h_documents=${actual.length}`);
});

test('gate H: map·search·history는 무시 문서를 추적 안 됨으로 알리고 git 메타데이터를 요청하지 않는다', () => {
  const scope = '.claude/plans/2026-08-16-onboarding-mcp-repo-map';
  let metadataCalls = 0;
  const searchOutput = toolSearch(
    { query: 'onboarding-mcp-repo-map', scope, git: true, limit: 100 },
    { loadGit() { metadataCalls += 1; return new Map(); } },
  );
  assert.equal(metadataCalls, 0);
  assert.ok(searchOutput.includes('Git 추적 안 됨 (무시됨)'));

  const mapOutput = mcpCall('map', { path: scope, git: true });
  assert.ok(mapOutput.includes('Git 추적 안 됨 (무시됨)'));
  const historyOutput = toolHistory({ doc: `${scope}/PLAN.md` });
  assert.ok(historyOutput.includes('Git 추적 안 됨 (무시됨)'));
});

test('gate H: 자체 추적 픽스처의 문자열 검색 출력은 독립 구성한 기대값과 바이트가 같다', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-tracked-search-'));
  try {
    const relativePath = 'TRACKED.md';
    const file = path.join(root, relativePath);
    fs.writeFileSync(file, '# 업로드 지침\n\n## 업로드\n본문');
    const stat = fs.statSync(file);
    const created = stat.birthtime.toISOString().slice(0, 10);
    const modified = stat.mtime.toISOString().slice(0, 10);
    const expected = [
      '"업로드" 검색: 1개 문서 · 1-1 표시 (정렬: relevance)',
      '범위: 전체',
      '',
      'TRACKED.md — 업로드 지침  4줄  1절',
      `  생성 ${created} · 수정 ${modified} · INDEX 해당 없음`,
      '  [all] 업로드 지침  4줄  ← 헤더',
      '  [1] 업로드  2줄  ← 헤더',
    ].join('\n');
    const actual = withProjectDir(root, () => toolSearch(
      { query: '업로드', limit: 5 },
      { collectPaths: () => [relativePath] },
    ));
    assert.equal(actual, expected);
    const actualHash = createHash('sha256').update(actual).digest('hex');
    const expectedHash = createHash('sha256').update(expected).digest('hex');
    assert.equal(actualHash, expectedHash);
    console.log(`gate_h_fixture_string_sha256=${actualHash}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
