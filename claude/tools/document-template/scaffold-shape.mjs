#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SHAPE_CONTRACT } from './server.mjs';

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SHAPES_DIR = path.join(SERVER_DIR, 'shapes');
const SHAPE_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const INCOMPLETE_SHAPE_MARKER = '구현이 비어 있습니다';

function jsString(value) {
  const inner = JSON.stringify(String(value)).slice(1, -1)
    .replaceAll("'", "\\'")
    .replaceAll('\\"', '"');
  return `'${inner}'`;
}

function validateInput({ name, depth, itemPattern } = {}) {
  if (!SHAPE_NAME_RE.test(String(name ?? ''))) {
    throw new Error('shape 이름은 kebab-case 영문 소문자·숫자·하이픈으로 씁니다.');
  }
  if (!String(depth ?? '').trim()) throw new Error('depth가 필요합니다.');
  if (!String(itemPattern ?? '').trim()) throw new Error('item-pattern이 필요합니다.');
}

function renderFunction(contract) {
  const params = contract.params.join(', ');
  const unused = contract.params.map((param) => `  void ${param};`).join('\n');
  const body = contract.empty === 'invalid'
    ? `  return { ok: false, reason: \`\${shape.name} validateName ${INCOMPLETE_SHAPE_MARKER} — 깊이: \${ITEM_DEPTH}; 이름 규칙: \${ITEM_PATTERN}.\` };`
    : `  throw new Error(\`\${shape.name} ${contract.name} ${INCOMPLETE_SHAPE_MARKER} — 깊이: \${ITEM_DEPTH}; 이름 규칙: \${ITEM_PATTERN}.\`);`;
  return [
    '/**',
    ` * ${contract.effect}`,
    ` * 계약 반환: ${contract.returns}`,
    ' */',
    `export function ${contract.name}(${params}) {`,
    unused,
    body,
    '}',
  ].join('\n');
}

export function renderShapeSkeleton(input) {
  validateInput(input);
  const { name, depth, itemPattern } = input;
  const functions = SHAPE_CONTRACT.functions.map(renderFunction).join('\n\n');
  return [
    '// document-template shape 뼈대.',
    '// TODO: 가운데 구현을 채우고, 지원하지 않는 함수는 해당 export 전체를 지운다.',
    '',
    'export const shape = {',
    `  name: ${jsString(name)},`,
    "  requires: ['item_pattern'],",
    '  optional: [],',
    '};',
    '',
    '// 생성자가 정한 구현 기준. 완성할 때 config.item_pattern과 일치시킨다.',
    `const ITEM_DEPTH = ${jsString(depth)};`,
    `const ITEM_PATTERN = ${jsString(itemPattern)};`,
    '',
    functions,
    '',
  ].join('\n');
}

export function writeShapeSkeleton(input, shapesDir = DEFAULT_SHAPES_DIR) {
  validateInput(input);
  const file = path.join(shapesDir, `${input.name}.mjs`);
  if (fs.existsSync(file)) throw new Error(`shape 파일이 이미 있습니다: ${file}`);
  fs.writeFileSync(file, renderShapeSkeleton(input), { flag: 'wx' });
  return file;
}

export function assertShapeImplementationComplete(source, name) {
  if (String(source).includes(INCOMPLETE_SHAPE_MARKER)) {
    throw new Error(`shape 구현이 비어 있습니다: ${name}`);
  }
}

function parseArgs(argv) {
  const values = {};
  const keys = new Map([
    ['--name', 'name'],
    ['--depth', 'depth'],
    ['--item-pattern', 'itemPattern'],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!keys.has(arg)) throw new Error(`알 수 없는 인자입니다: ${arg}`);
    const value = argv[index + 1];
    if (value == null || value.startsWith('--')) throw new Error(`${arg} 값이 필요합니다.`);
    values[keys.get(arg)] = value;
    index += 1;
  }
  return values;
}

export function main(argv = process.argv.slice(2)) {
  if (argv.includes('--help')) {
    process.stdout.write('사용법: node scaffold-shape.mjs --name <kebab-case> --depth <항목 경로> --item-pattern <이름 규칙>\n');
    return null;
  }
  const file = writeShapeSkeleton(parseArgs(argv));
  process.stdout.write(`shape 뼈대 생성: ${file}\n`);
  return file;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    main();
  } catch (cause) {
    process.stderr.write(`Error: ${cause.message}\n`);
    process.exitCode = 1;
  }
}
