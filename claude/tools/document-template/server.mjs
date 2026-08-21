#!/usr/bin/env node
// document-template — 규칙 폴더의 문서·README·INDEX를 관리하는 MCP stdio 서버.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as lib from './lib.mjs';

const SERVER_DIR = path.dirname(new URL(import.meta.url).pathname);
const SHAPES_DIR = path.join(SERVER_DIR, 'shapes');
const BASE_REQUIRED_CONFIG = ['shape', 'index'];
let shapeImportNonce = 0;
export const SHAPE_CONTRACT = Object.freeze({
  arrayFields: Object.freeze(['requires', 'optional']),
  functions: Object.freeze([
    Object.freeze({ name: 'nameItem', params: Object.freeze(['ctx', 'input']), returns: '{ item }', effect: '순수 함수', empty: 'throw' }),
    Object.freeze({ name: 'validateName', params: Object.freeze(['ctx', 'name']), returns: '{ ok, reason? }', effect: '순수 함수', empty: 'invalid' }),
    Object.freeze({ name: 'create', params: Object.freeze(['ctx', 'input']), returns: '{ item, dir, entry, made }', effect: '파일시스템 함수', empty: 'throw' }),
    Object.freeze({ name: 'scan', params: Object.freeze(['ctx']), returns: 'Item[]', effect: '파일시스템 함수', empty: 'throw' }),
    Object.freeze({ name: 'tidy', params: Object.freeze(['ctx']), returns: '{ moved }', effect: '파일시스템 함수 · 지원하지 않으면 export를 지운다', empty: 'throw' }),
  ]),
});

const SHAPE_FUNCTIONS = SHAPE_CONTRACT.functions.map(({ name }) => name);

export function projectDir() {
  return path.resolve(process.env.CLAUDE_PROJECT_DIR || process.cwd());
}

export function definitionsRoot(repo = projectDir()) {
  return path.join(repo, '.claude', 'mcp-document-template');
}

export function shapeRegistryFile(repo = projectDir()) {
  return path.join(definitionsRoot(repo), 'shapes.json');
}

function inside(base, candidate, label) {
  const relative = path.relative(path.resolve(base), path.resolve(candidate));
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} 경로가 허용된 자리 밖입니다: ${candidate}`);
  }
  return relative;
}

export function listDefinitionNames(repo = projectDir()) {
  const root = definitionsRoot(repo);
  if (!fs.existsSync(root)) return [];
  const names = [];

  function visit(dir) {
    if (fs.existsSync(path.join(dir, 'config.json'))) {
      names.push(path.relative(root, dir).split(path.sep).join('/'));
      return;
    }
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) visit(path.join(dir, entry.name));
    }
  }

  visit(root);
  return names.sort();
}

function readConfig(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (cause) {
    throw new Error(`config.json 파싱 실패: ${cause.message}`);
  }
}

function validateIndexConfig(index, file) {
  if (!index || typeof index !== 'object' || Array.isArray(index)) {
    throw new Error(`config 필수키 누락: index (${file})`);
  }
  const missing = ['file', 'section', 'row'].filter((key) => !index[key]);
  if (missing.length) throw new Error(`config index 필수키 누락: ${missing.join(', ')} (${file})`);
}

function validatePlaceholderContexts(config, file) {
  if (/\{(?:item|entry|month)\}/.test(String(config.item_pattern ?? ''))) {
    throw new Error(`item_pattern에서 쓸 수 없는 자리표시가 있습니다: item, entry, month (${file})`);
  }
}

export function readShapeRegistry(repo = projectDir()) {
  const file = shapeRegistryFile(repo);
  if (!fs.existsSync(file)) throw new Error(`shape 장부 없음: ${file}`);
  let registry;
  try {
    registry = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (cause) {
    throw new Error(`shapes.json 파싱 실패: ${cause.message}`);
  }
  if (!registry || !Array.isArray(registry.shapes)) {
    throw new Error(`shapes.json의 shapes는 배열이어야 합니다: ${file}`);
  }
  const names = new Set();
  for (const entry of registry.shapes) {
    if (!entry || typeof entry.name !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(String(entry.registered_at))) {
      throw new Error(`shape 장부 항목에 name과 registered_at(YYYY-MM-DD)이 필요합니다: ${file}`);
    }
    lib.assertSafeSegment(entry.name);
    if (names.has(entry.name)) throw new Error(`shape 장부에 중복 이름이 있습니다: ${entry.name}`);
    names.add(entry.name);
  }
  return registry;
}

function writeShapeRegistry(registry, repo = projectDir()) {
  fs.writeFileSync(shapeRegistryFile(repo), `${JSON.stringify(registry, null, 2)}\n`);
}

export function validateShapeModule(module, expectedName, config) {
  if (!module?.shape || typeof module.shape !== 'object') {
    throw new Error(`shape 선언이 없습니다: ${expectedName}`);
  }
  if (module.shape.name !== expectedName) {
    throw new Error(`shape 이름 불일치: config=${expectedName}, export=${module.shape.name || '(없음)'}`);
  }
  for (const field of SHAPE_CONTRACT.arrayFields) {
    if (!Array.isArray(module.shape[field])) throw new Error(`shape.${field}는 배열이어야 합니다: ${expectedName}`);
    if (module.shape[field].some((value) => typeof value !== 'string')) {
      throw new Error(`shape.${field}의 값은 문자열이어야 합니다: ${expectedName}`);
    }
  }
  if (config != null) {
    const missing = module.shape.requires.filter((key) => !(key in config));
    if (missing.length) throw new Error(`shape config 필수키 누락: ${missing.join(', ')} (${expectedName})`);
  }
  for (const name of SHAPE_FUNCTIONS) {
    if (name in module && typeof module[name] !== 'function') {
      throw new Error(`shape export가 함수가 아닙니다: ${expectedName}.${name}`);
    }
  }
  return module;
}

async function loadShapeFile(name, { shapesDir = SHAPES_DIR, fresh = false } = {}) {
  const file = path.join(shapesDir, `${lib.assertSafeSegment(name)}.mjs`);
  inside(shapesDir, file, 'shape');
  if (!fs.existsSync(file)) throw new Error(`shape 파일 없음: ${file}`);
  const baseUrl = pathToFileURL(file).href;
  const url = fresh ? `${baseUrl}?shape-register=${shapeImportNonce += 1}` : baseUrl;
  return { file, module: await import(url) };
}

export async function importShape(name, config, { repo = projectDir(), shapesDir = SHAPES_DIR } = {}) {
  const registry = readShapeRegistry(repo);
  if (!registry.shapes.some((entry) => entry.name === name)) {
    throw new Error(`등록되지 않은 형식입니다: ${name} — shape_register(${name}) 먼저.`);
  }
  const { module } = await loadShapeFile(name, { shapesDir });
  return validateShapeModule(module, name, config);
}

export async function toolShapeNew({ name, depth, item_pattern }, { shapesDir = SHAPES_DIR } = {}) {
  const { writeShapeSkeleton } = await import('./scaffold-shape.mjs');
  const file = writeShapeSkeleton({ name, depth, itemPattern: item_pattern }, shapesDir);
  return [
    `shape_new(${name}) 완료`,
    `- 생성: ${file}`,
    '- 등록 전: 가운데 구현을 채운 뒤 shape_register를 호출합니다.',
  ].join('\n');
}

export async function toolShapeRegister({ name }, { repo = projectDir(), shapesDir = SHAPES_DIR } = {}) {
  const { assertShapeImplementationComplete } = await import('./scaffold-shape.mjs');
  const { file, module } = await loadShapeFile(name, { shapesDir, fresh: true });
  assertShapeImplementationComplete(fs.readFileSync(file, 'utf8'), name);
  validateShapeModule(module, name);

  const registry = readShapeRegistry(repo);
  const registered = registry.shapes.find((entry) => entry.name === name);
  if (!registered) {
    registry.shapes.push({ name, registered_at: lib.todayKst() });
    registry.shapes.sort((left, right) => left.name.localeCompare(right.name));
    writeShapeRegistry(registry, repo);
  }
  return [
    `shape_register(${name}) 완료`,
    `- 검사: ${file}`,
    `- 장부: ${shapeRegistryFile(repo)}`,
    `- 결과: ${registered ? '재검사 완료' : '신규 등재'}`,
  ].join('\n');
}

export function shapeFunction(definition, name) {
  const fn = definition.shapeModule?.[name];
  if (typeof fn !== 'function') {
    throw new Error(`이 폴더에는 없는 동작입니다: ${definition.name} — ${name}`);
  }
  return fn;
}

export async function loadDefinition(name, { withShape = true, repo = projectDir(), shapesDir = SHAPES_DIR } = {}) {
  if (!name || !String(name).trim()) {
    throw new Error('name이 필요합니다 — 정의 목록은 template_list로 봅니다.');
  }
  const normalized = String(name).replaceAll('\\', '/').replace(/^\/+|\/+$/g, '');
  const root = definitionsRoot(repo);
  const defDir = path.resolve(root, normalized);
  const target = path.resolve(repo, normalized);
  inside(root, defDir, '정의');
  inside(repo, target, '대상');

  if (!fs.existsSync(defDir) || !fs.statSync(defDir).isDirectory()) {
    const names = listDefinitionNames(repo).join(', ') || '(없음)';
    throw new Error(`정의 폴더 없음: ${defDir}\n등록된 document-template: ${names}`);
  }
  const configPath = path.join(defDir, 'config.json');
  if (!fs.existsSync(configPath)) throw new Error(`config.json 없음: ${configPath}`);
  const config = readConfig(configPath);
  const missing = BASE_REQUIRED_CONFIG.filter((key) => !(key in config));
  if (missing.length) throw new Error(`config 필수키 누락: ${missing.join(', ')} (${configPath})`);
  if ('folder' in config || 'insert' in config) {
    throw new Error(`폐기된 config 키가 있습니다: ${['folder', 'insert'].filter((key) => key in config).join(', ')}`);
  }
  validateIndexConfig(config.index, configPath);
  validatePlaceholderContexts(config, configPath);

  const readmePath = path.join(defDir, 'README.md');
  if (!fs.existsSync(readmePath)) throw new Error(`정의 README.md 없음: ${readmePath}`);
  const shapeModule = withShape ? await importShape(config.shape, config, { repo, shapesDir }) : null;
  return {
    name: normalized,
    repo,
    target,
    defDir,
    readmePath,
    stubsDir: path.join(defDir, 'stubs'),
    config,
    shapeModule,
    ctx: {
      repo,
      target,
      defDir,
      stubsDir: path.join(defDir, 'stubs'),
      config,
      today: lib.todayKst(),
      lib,
    },
  };
}

function targetFile(definition, relative, label) {
  const file = path.resolve(definition.target, relative);
  inside(definition.target, file, label);
  return file;
}

function indexFile(definition) {
  return targetFile(definition, definition.config.index.file, 'INDEX');
}

function validateItems(value, shapeName) {
  if (!Array.isArray(value)) throw new Error(`scan 반환값은 배열이어야 합니다: ${shapeName}`);
  for (const item of value) {
    if (!item || typeof item.name !== 'string' || typeof item.path !== 'string') {
      throw new Error(`scan 항목에 name과 path가 필요합니다: ${shapeName}`);
    }
  }
  return value;
}

export async function toolRegister({ name }) {
  const definition = await loadDefinition(name, { withShape: false });
  const source = fs.readFileSync(definition.readmePath, 'utf8');
  const existed = fs.existsSync(definition.target);
  fs.mkdirSync(definition.target, { recursive: true });
  fs.writeFileSync(path.join(definition.target, 'README.md'), source);

  const index = indexFile(definition);
  let indexResult = '기존 INDEX 보존';
  if (!fs.existsSync(index)) {
    const title = path.basename(definition.name) || definition.name;
    const section = lib.hasVars(definition.config.index.section) ? '' : `\n${definition.config.index.section}`;
    fs.writeFileSync(index, `# ${title} — 차례\n${section}\n`);
    indexResult = `${definition.config.index.file} 뼈대 생성`;
  }
  return [
    `template_register(${definition.name}) 완료`,
    `- 대상: ${definition.name}/ (${existed ? '기존 폴더' : '새 폴더'})`,
    '- README.md 재생성',
    `- ${indexResult}`,
  ].join('\n');
}

export async function toolAdd({ name, title, tag, summary }) {
  if (!title) throw new Error('title이 필요합니다.');
  const definition = await loadDefinition(name);
  const nameItem = shapeFunction(definition, 'nameItem');
  const create = shapeFunction(definition, 'create');
  const scan = shapeFunction(definition, 'scan');
  const input = { title, tag, summary };
  const named = await nameItem(definition.ctx, input);
  if (!named || typeof named.item !== 'string') throw new Error(`nameItem 반환값에 item이 없습니다: ${definition.name}`);

  const before = validateItems(await scan(definition.ctx), definition.config.shape);
  if (before.some((item) => item.name === named.item)) {
    throw new Error(`동명 항목이 이미 있습니다: ${definition.name}/${named.item}`);
  }

  const created = await create(definition.ctx, input);
  if (!created || created.item !== named.item || typeof created.entry !== 'string' || !Array.isArray(created.made)) {
    throw new Error(`create 반환값이 계약과 다릅니다: ${definition.name}`);
  }
  const index = indexFile(definition);
  if (!fs.existsSync(index)) throw new Error(`INDEX 없음: ${index} — 먼저 template_register(${definition.name}).`);
  const after = validateItems(await scan(definition.ctx), definition.config.shape);
  const createdItem = after.find((item) => item.path === created.entry || item.entry === created.entry);
  if (!createdItem) throw new Error(`생성한 항목을 scan에서 찾을 수 없습니다: ${created.entry}`);
  const indexVars = {
    item: created.item,
    entry: createdItem.entry,
    month: createdItem.month,
    date: definition.ctx.today,
    title,
    tag,
    summary,
  };
  const row = lib.fillVars(definition.config.index.row, {
    ...indexVars,
  });
  const sectionTemplate = definition.config.index.section;
  const section = lib.fillVars(sectionTemplate, indexVars);
  fs.writeFileSync(index, lib.insertIndexRow(fs.readFileSync(index, 'utf8'), section, row, {
    createSection: lib.hasVars(sectionTemplate),
  }));

  const currentMonth = definition.ctx.today.slice(0, 7);
  const pending = before.filter((item) => item.tidied === false && item.month && item.month < currentMonth);
  const notice = pending.length ? `\n! 미정리 ${pending.length}건 — template_pack(${definition.name}) 명시 호출` : '';
  return [
    `template_add(${definition.name}) 완료`,
    `- 생성: ${created.entry}`,
    `- 쓴 파일: ${created.made.join(', ') || '없음'}`,
    `- ${definition.config.index.file}에 등재${notice}`,
  ].join('\n');
}

export async function toolPack({ name }) {
  const definition = await loadDefinition(name);
  const tidy = shapeFunction(definition, 'tidy');
  const packed = await tidy(definition.ctx);
  if (!packed || !Array.isArray(packed.moved)) {
    throw new Error(`tidy 반환값에 moved 배열이 없습니다: ${definition.name}`);
  }
  for (const move of packed.moved) {
    if (!move || typeof move.from !== 'string' || typeof move.to !== 'string') {
      throw new Error(`tidy 이동 항목에 from과 to가 필요합니다: ${definition.name}`);
    }
  }

  const index = indexFile(definition);
  if (!fs.existsSync(index)) throw new Error(`INDEX 없음: ${index}`);
  if (packed.moved.length) {
    const before = fs.readFileSync(index, 'utf8');
    const after = lib.updateIndexPaths(before, packed.moved);
    if (after !== before) fs.writeFileSync(index, after);
  }
  return `template_pack(${definition.name}) 완료\n- 이동: ${packed.moved.length}건`;
}

function listShapeFileNames(shapesDir = SHAPES_DIR) {
  if (!fs.existsSync(shapesDir)) return [];
  return fs.readdirSync(shapesDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.mjs'))
    .map((entry) => entry.name.slice(0, -4))
    .sort();
}

export async function toolList(_args = {}, { repo = projectDir(), shapesDir = SHAPES_DIR } = {}) {
  const names = listDefinitionNames(repo);
  const rows = [];
  if (!names.length) {
    rows.push('등록된 document-template이 없습니다.');
  } else {
    for (const name of names) {
      try {
        const definition = await loadDefinition(name, { repo, shapesDir });
        const scan = shapeFunction(definition, 'scan');
        const items = validateItems(await scan(definition.ctx), definition.config.shape);
        const currentMonth = definition.ctx.today.slice(0, 7);
        const pending = items.filter((item) => item.tidied === false && item.month && item.month < currentMonth);
        const index = indexFile(definition);
        let indexState = 'INDEX 없음';
        if (fs.existsSync(index)) {
          const compared = lib.compareIndex(items, fs.readFileSync(index, 'utf8'), definition.config.index.section);
          indexState = `INDEX 누락 ${compared.missing.length}·잔존 ${compared.stale.length}`;
        }
        rows.push(`- ${name} — ${definition.config.shape}, 항목 ${items.length}, 미정리 ${pending.length}, ${indexState}`);
      } catch (cause) {
        rows.push(`- ${name} — Error: ${cause.message}`);
      }
    }
  }

  const registry = readShapeRegistry(repo);
  const registered = new Map(registry.shapes.map((entry) => [entry.name, entry]));
  const files = new Set(listShapeFileNames(shapesDir));
  const shapeNames = [...new Set([...registered.keys(), ...files])].sort();
  rows.push('', 'shape 현황:');
  for (const name of shapeNames) {
    if (registered.has(name) && files.has(name)) {
      rows.push(`- ${name} — 등록됨 (${registered.get(name).registered_at})`);
    } else if (registered.has(name)) {
      rows.push(`- ${name} — 장부에 있으나 파일 없음`);
    } else {
      rows.push(`- ${name} — 파일은 있으나 미등재`);
    }
  }
  return rows.join('\n');
}

async function changeReadme(name, operation) {
  const definition = await loadDefinition(name, { withShape: false });
  const targetReadme = path.join(definition.target, 'README.md');
  if (!fs.existsSync(definition.target) || !fs.existsSync(targetReadme)) {
    throw new Error(`register 전입니다 — 대상 README 없음: ${targetReadme}. 먼저 template_register(${definition.name}).`);
  }
  const source = fs.readFileSync(definition.readmePath, 'utf8');
  const outOfSync = source !== fs.readFileSync(targetReadme, 'utf8');
  const changed = operation(source);
  fs.writeFileSync(definition.readmePath, changed.text);
  fs.writeFileSync(targetReadme, changed.text);
  const note = outOfSync ? '\n! 연산 전 정의본과 대상 README가 달라 정의본 기준으로 재동기화함' : '';
  return `${changed.message}\n- 갱신: ${definition.name}/README.md + 정의 README.md${note}`;
}

export async function toolReadmeSet({ name, addr, title, body }) {
  return `readme_set(${name}) 완료\n- ${await changeReadme(name, (text) => lib.setReadmeClause(text, addr, title, body))}`;
}

export async function toolReadmeRemove({ name, addr }) {
  return `readme_remove(${name}) 완료\n- ${await changeReadme(name, (text) => lib.removeReadmeClause(text, addr))}`;
}

const NAME_PROPERTY = { type: 'string', description: '관리 대상 경로와 같은 정의 이름. 예: _AUDIT, .claude/plans' };
const TOOLS = [
  {
    name: 'shape_new',
    description: '서버의 shape 계약과 입력한 깊이·이름 규칙으로 미등록 shape 뼈대를 만든다.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '새 shape 이름. kebab-case.' },
        depth: { type: 'string', description: '항목 경로 깊이. 예: {month}/{item}.md' },
        item_pattern: { type: 'string', description: '항목 이름 규칙. 예: {date}-{title}.md' },
      },
      required: ['name', 'depth', 'item_pattern'],
    },
  },
  {
    name: 'shape_register',
    description: '구현을 채운 shape를 config 없이 검사하고 명시적으로 장부에 등재한다.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: '등록하거나 재검사할 shape 이름.' } },
      required: ['name'],
    },
  },
  {
    name: 'template_register',
    description: '정의 README를 대상에 반영하고 폴더와 INDEX 뼈대를 마련한다. shape와 무관한 동작.',
    inputSchema: { type: 'object', properties: { name: NAME_PROPERTY }, required: ['name'] },
  },
  {
    name: 'template_add',
    description: 'shape의 nameItem과 create로 항목을 만들고 INDEX 첫 행에 등재한다.',
    inputSchema: {
      type: 'object',
      properties: {
        name: NAME_PROPERTY,
        title: { type: 'string' },
        tag: { type: 'string' },
        summary: { type: 'string' },
      },
      required: ['name', 'title'],
    },
  },
  {
    name: 'template_pack',
    description: 'shape의 tidy로 오래된 항목을 정리하고 이동 결과를 INDEX에 반영한다.',
    inputSchema: { type: 'object', properties: { name: NAME_PROPERTY }, required: ['name'] },
  },
  {
    name: 'template_list',
    description: '정의별 현황과 shape 장부·파일의 일치 및 어긋남을 읽는다.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'readme_set',
    description: 'README 조항 하나를 추가하거나 교체해 정의본과 대상에 함께 반영한다.',
    inputSchema: {
      type: 'object',
      properties: {
        name: NAME_PROPERTY,
        addr: { type: 'string' },
        title: { type: 'string' },
        body: { type: 'string' },
      },
      required: ['name', 'addr'],
    },
  },
  {
    name: 'readme_remove',
    description: 'README 조항 하나를 제거해 정의본과 대상에 함께 반영한다.',
    inputSchema: {
      type: 'object',
      properties: { name: NAME_PROPERTY, addr: { type: 'string' } },
      required: ['name', 'addr'],
    },
  },
];

const DISPATCH = {
  shape_new: toolShapeNew,
  shape_register: toolShapeRegister,
  template_register: toolRegister,
  template_add: toolAdd,
  template_pack: toolPack,
  template_list: toolList,
  readme_set: toolReadmeSet,
  readme_remove: toolReadmeRemove,
};

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const result = (id, value) => send({ jsonrpc: '2.0', id, result: value });
const error = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

async function handle({ id, method, params }) {
  if (method === 'initialize') {
    return result(id, {
      protocolVersion: params?.protocolVersion || '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'document-template', version: '0.1.0' },
    });
  }
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return;
  if (method === 'ping') return result(id, {});
  if (method === 'tools/list') return result(id, { tools: TOOLS });
  if (method === 'tools/call') {
    const fn = DISPATCH[params?.name];
    if (!fn) return result(id, { content: [{ type: 'text', text: `알 수 없는 도구: ${params?.name}` }], isError: true });
    try {
      const text = await fn(params.arguments || {});
      return result(id, { content: [{ type: 'text', text }] });
    } catch (cause) {
      return result(id, { content: [{ type: 'text', text: `Error: ${cause.message}` }], isError: true });
    }
  }
  if (id != null) return error(id, -32601, `Method not found: ${method}`);
}

export function startServer() {
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      try {
        void handle(JSON.parse(line));
      } catch (cause) {
        error(null, -32700, cause.message);
      }
    }
  });
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) startServer();
