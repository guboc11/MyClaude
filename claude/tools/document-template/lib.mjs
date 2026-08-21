import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ADDRESS_RE = /^\d+(?:-\d+)*$/;
const NUMBERED_HEADER_RE = /^(\d+(?:-\d+)*)(?:\s+(.*))?$/;
const PLACEHOLDER_RE = /\{(item|date|title|tag|TAG|summary|entry|month)\}/g;
const PLACEHOLDER_TEST_RE = /\{(?:item|date|title|tag|TAG|summary|entry|month)\}/;

export function parseReadme(text) {
  const lines = String(text).split('\n');
  const headers = [];
  let inFence = false;
  let title = null;

  for (let line = 0; line < lines.length; line += 1) {
    const value = lines[line];
    if (/^```/.test(value.trim())) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(value);
    if (match) headers.push({ level: match[1].length, text: match[2], line });
  }

  const sections = [];
  for (let index = 0; index < headers.length; index += 1) {
    const { level, text: heading, line } = headers[index];
    if (title === null) {
      title = heading;
      continue;
    }

    let addr = null;
    let name = heading;
    if (heading === 'definition') {
      addr = 'definition';
      name = '(기본 섹션)';
    } else {
      const match = NUMBERED_HEADER_RE.exec(heading);
      if (match) {
        addr = match[1];
        name = match[2] || '';
      }
    }
    if (addr === null) continue;

    let end = lines.length;
    for (let next = index + 1; next < headers.length; next += 1) {
      if (headers[next].level <= level) {
        end = headers[next].line;
        break;
      }
    }
    sections.push({ addr, level, title: name, start: line, end });
  }

  return { title, lines, sections, headers };
}

export function readReadmeClause(text, addr) {
  const doc = parseReadme(text);
  const section = doc.sections.find((candidate) => candidate.addr === String(addr));
  if (!section) throw new Error(`없는 주소: ${addr}`);
  return doc.lines.slice(section.start, section.end).join('\n').trim();
}

export function classifyReadmeAddr(addr) {
  if (!addr || !String(addr).trim()) {
    throw new Error('addr이 필요합니다 — "definition" / 번호("2-3") / 무주소 헤더 텍스트.');
  }
  const value = String(addr).trim();
  if (value === 'definition') return { kind: 'definition', addr: value };
  if (ADDRESS_RE.test(value)) return { kind: 'number', addr: value };
  return { kind: 'plain', addr: value };
}

function readmeHeader({ kind, addr }, title) {
  if (kind === 'definition') return '# definition';
  if (kind === 'number') return `${'#'.repeat(addr.split('-').length)} ${addr}${title ? ` ${title}` : ''}`;
  return `## ${addr}`;
}

function ownRange(doc, startLine) {
  return doc.headers.find((header) => header.line > startLine)?.line ?? doc.lines.length;
}

function headerLine(doc, clause) {
  if (clause.kind === 'plain') {
    return doc.headers.slice(1).find((header) => header.text === clause.addr)?.line ?? -1;
  }
  return doc.sections.find((section) => section.addr === clause.addr)?.start ?? -1;
}

export function setReadmeClause(text, addr, title, body) {
  const doc = parseReadme(text);
  const clause = classifyReadmeAddr(addr);
  const block = [readmeHeader(clause, title), '', ...(body ? String(body).split('\n') : [])];
  while (block.at(-1) === '') block.pop();

  const at = headerLine(doc, clause);
  if (at !== -1) {
    const end = ownRange(doc, at);
    doc.lines.splice(at, end - at, ...block, '');
    return {
      text: doc.lines.join('\n'),
      message: `교체: ${clause.addr} (자기 본문 ${end - at}줄 → ${block.length}줄, 하위 조항 보존)`,
    };
  }

  let insertAt;
  let where;
  if (clause.kind === 'number' && clause.addr.includes('-')) {
    const parent = clause.addr.split('-').slice(0, -1).join('-');
    const parentSection = doc.sections.find((section) => section.addr === parent);
    if (!parentSection) throw new Error(`부모 조항 없음: ${parent} — 먼저 만들거나 최상위 번호를 쓰세요.`);
    insertAt = parentSection.end;
    where = `${parent} 서브트리 끝`;
  } else if (clause.kind === 'definition') {
    insertAt = doc.sections[0]?.start ?? doc.lines.length;
    where = '첫 조항 앞';
  } else {
    insertAt = doc.lines.length;
    where = '문서 끝';
  }
  while (insertAt > 0 && doc.lines[insertAt - 1].trim() === '') insertAt -= 1;
  doc.lines.splice(insertAt, 0, '', ...block);
  return {
    text: doc.lines.join('\n'),
    message: `추가: ${clause.addr} (${where}, ${block.length}줄)`,
  };
}

export function removeReadmeClause(text, addr) {
  const doc = parseReadme(text);
  const clause = classifyReadmeAddr(addr);
  const at = headerLine(doc, clause);
  if (at === -1) throw new Error(`없는 주소: ${clause.addr}`);

  let end;
  let children = [];
  if (clause.kind === 'plain') {
    end = ownRange(doc, at);
  } else {
    const section = doc.sections.find((candidate) => candidate.addr === clause.addr);
    end = section.end;
    children = doc.sections
      .filter((candidate) => candidate.addr !== clause.addr && candidate.addr.startsWith(`${clause.addr}-`))
      .map((candidate) => candidate.addr);
  }

  const removedLines = end - at;
  doc.lines.splice(at, removedLines);
  while (doc.lines[at] === '' && doc.lines[at - 1] === '') doc.lines.splice(at, 1);
  const childNote = children.length
    ? ` — 하위 조항 ${children.length}개 포함 제거: ${children.join(', ')}`
    : ' — 하위 조항 없음';
  return {
    text: doc.lines.join('\n'),
    message: `제거: ${clause.addr} (${removedLines}줄)${childNote}`,
  };
}

export function todayKst(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const value = Object.fromEntries(parts.map(({ type, value: part }) => [type, part]));
  return `${value.year}-${value.month}-${value.day}`;
}

export function fillVars(pattern, vars = {}) {
  const values = {
    ...vars,
    tag: vars.tag ?? '',
    TAG: String(vars.tag ?? vars.TAG ?? '').toUpperCase(),
    summary: vars.summary || vars.title || '',
  };
  return String(pattern).replace(PLACEHOLDER_RE, (_, key) => values[key] ?? '');
}

export function hasVars(pattern) {
  return PLACEHOLDER_TEST_RE.test(String(pattern));
}

export function validateSafeSegment(name) {
  const value = String(name ?? '');
  if (!value) return { ok: false, reason: '이름이 비어 있습니다.' };
  if (value !== value.trim()) return { ok: false, reason: `이름 앞뒤에 공백이 있습니다: "${value}"` };
  if (/[\\/\x00-\x1f\x7f]/.test(value)) return { ok: false, reason: `이름에 경로 구분자나 제어문자가 있습니다: "${value}"` };
  if (value === '.' || value === '..' || value.includes('..')) return { ok: false, reason: `이름에 상위 이동이 있습니다: "${value}"` };
  return { ok: true };
}

export function assertSafeSegment(name) {
  const result = validateSafeSegment(name);
  if (!result.ok) throw new Error(result.reason);
  return String(name);
}

export function readLines(file) {
  return fs.readFileSync(file, 'utf8').split('\n');
}

function indexSection(text, heading) {
  const lines = String(text).split('\n');
  const start = lines.findIndex((line) => line.trim() === String(heading).trim());
  if (start === -1) throw new Error(`INDEX에 섹션 없음: "${heading}"`);

  const header = /^(#{1,6})\s+/.exec(lines[start].trim());
  let end = lines.length;
  if (header) {
    for (let line = start + 1; line < lines.length; line += 1) {
      const next = /^(#{1,6})\s+/.exec(lines[line].trim());
      if (next && next[1].length <= header[1].length) {
        end = line;
        break;
      }
    }
  }
  return { lines, start, end };
}

export function insertIndexRow(text, heading, row, { createSection = false } = {}) {
  let section;
  try {
    section = indexSection(text, heading);
  } catch (cause) {
    if (!createSection) throw cause;
    const header = /^(#{1,6})\s+/.exec(String(heading).trim());
    if (!header) throw new Error(`동적 INDEX 섹션은 Markdown 헤더여야 합니다: "${heading}"`);
    const lines = String(text).split('\n');
    const sameLevel = new RegExp(`^#{${header[1].length}}\\s+`);
    let insertAt = lines.findIndex((line) => sameLevel.test(line.trim()));
    if (insertAt === -1) {
      insertAt = lines.length;
      while (insertAt > 0 && lines[insertAt - 1] === '') insertAt -= 1;
      if (insertAt > 0) lines.splice(insertAt, 0, '');
      insertAt = lines.length;
    }
    lines.splice(insertAt, 0, String(heading).trim(), '', String(row), '');
    return lines.join('\n');
  }
  let insertAt = section.start + 1;
  while (insertAt < section.end && section.lines[insertAt].trim() === '') insertAt += 1;
  section.lines.splice(insertAt, 0, String(row));
  return section.lines.join('\n');
}

export function readIndexLinks(text, heading) {
  const { lines, start, end } = indexSection(text, heading);
  const links = [];
  for (let line = start + 1; line < end; line += 1) {
    for (const match of lines[line].matchAll(/\[([^\]]+)]\(([^)]+)\)/g)) {
      links.push({ name: match[1], target: match[2].replace(/^\.\//, ''), line: line + 1 });
    }
  }
  return links;
}

export function compareIndex(items, text, heading) {
  const headings = hasVars(heading)
    ? [...new Set(items.map((item) => fillVars(heading, {
        item: item.name,
        entry: item.entry,
        month: item.month,
        date: /^\d{4}-\d{2}-\d{2}/.exec(item.name)?.[0] ?? '',
      })))]
    : [heading];
  const links = headings.flatMap((resolved) => readIndexLinks(text, resolved));
  const belongsTo = (item, target) => {
    const itemPath = String(item.path).replace(/^\.\//, '').replace(/\/$/, '');
    const entry = item.entry ? String(item.entry).replace(/^\.\//, '') : null;
    const linked = String(target).replace(/\/$/, '');
    return linked === itemPath || linked === entry || linked.startsWith(`${itemPath}/`);
  };
  const matchedItems = items.filter((item) => links.some((link) => belongsTo(item, link.target)));
  return {
    matched: matchedItems.map((item) => item.path),
    missing: items.filter((item) => !matchedItems.includes(item)).map((item) => item.path),
    stale: links.filter((link) => !items.some((item) => belongsTo(item, link.target))).map((link) => link.target),
    links,
  };
}

export function updateIndexPaths(text, moved) {
  let result = String(text);
  for (const { from, to } of moved) {
    const source = String(from).replace(/^\.\//, '');
    const target = String(to).replace(/^\.\//, '');
    result = result.replaceAll(`](./${source}`, `](./${target}`);
    result = result.replaceAll(`](${source}`, `](${target}`);
  }
  return result;
}

function repoRelative(repo, file) {
  const relative = path.relative(path.resolve(repo), path.resolve(file));
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`저장소 안의 서로 다른 경로가 필요합니다: ${file}`);
  }
  return relative;
}

function isGitTracked(repo, relative) {
  try {
    execFileSync('git', ['-C', repo, 'rev-parse', '--is-inside-work-tree'], { stdio: 'ignore' });
    execFileSync('git', ['-C', repo, 'ls-files', '--error-unmatch', relative], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function gitMove(repo, from, to) {
  const source = path.resolve(from);
  const target = path.resolve(to);
  const sourceRelative = repoRelative(repo, source);
  const targetRelative = repoRelative(repo, target);
  if (!fs.existsSync(source)) throw new Error(`옮길 경로가 없습니다: ${sourceRelative}`);
  if (fs.existsSync(target)) throw new Error(`목적지가 이미 있습니다: ${targetRelative}`);

  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tracked = isGitTracked(repo, sourceRelative);
  if (tracked) {
    execFileSync('git', ['-C', repo, 'mv', '--', sourceRelative, targetRelative], { encoding: 'utf8' });
  } else {
    fs.renameSync(source, target);
  }
  return { from: sourceRelative, to: targetRelative, tracked };
}
