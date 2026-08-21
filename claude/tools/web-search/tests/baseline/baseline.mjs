#!/usr/bin/env node
// web-search v2 재구성 기준선 — 생성과 검증을 같은 코드로 수행한다.
//
//   node tests/baseline/baseline.mjs --write  --project <프로젝트 경로>
//   node tests/baseline/baseline.mjs --verify --project <프로젝트 경로>   대조 (기본)
//   node tests/baseline/baseline.mjs --write --force --project <프로젝트 경로>  다시 기록
//
// frozen 영역(LEGACY, 기존 수집 데이터)이 바뀌면 --verify 는 실패한다.
// current 영역(새 코드 자리, MCP 등록·handshake)의 변화는 실패가 아니라 표시만 한다.

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOL_ROOT = path.resolve(HERE, '..', '..');
const BASELINE_PATH = path.join(HERE, 'baseline.json');
const HASH_ALGO = 'sha256';

// 집계 해시 알고리즘: 상대경로를 바이트 순(LC_ALL=C sort)으로 정렬한 뒤
// `${파일해시}  ${상대경로}\n` (공백 두 칸, shasum 출력 형식) 을 이어 붙여 sha256 한다.
const AGGREGATE_SPEC =
  'sha256( concat( sorted_by_bytes(relpath) → `${sha256(file)}  ${relpath}\\n` ) )';

const byteOrder = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));

function walkFiles(root) {
  const out = [];
  if (!fs.existsSync(root)) return out;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(abs);
      else if (entry.isFile()) out.push(path.relative(root, abs));
    }
  }
  return out.sort(byteOrder);
}

function sha256File(abs) {
  return createHash(HASH_ALGO).update(fs.readFileSync(abs)).digest('hex');
}

function sha256Text(text) {
  return createHash(HASH_ALGO).update(text, 'utf8').digest('hex');
}

// 내용까지 읽어 파일별 지문을 남긴다. 파일 수가 적은 LEGACY 전용.
function contentCensus(root) {
  const rels = walkFiles(root);
  const files = {};
  let bytes = 0;
  let lines = '';
  for (const rel of rels) {
    const abs = path.join(root, rel);
    const stat = fs.statSync(abs);
    const hash = sha256File(abs);
    files[rel] = { bytes: stat.size, sha256: hash };
    bytes += stat.size;
    lines += `${hash}  ${rel}\n`;
  }
  return { exists: fs.existsSync(root), file_count: rels.length, total_bytes: bytes, aggregate_sha256: sha256Text(lines), files };
}

// 파일이 많아 개별 해시는 저장하지 않지만, 내용 집계 해시는 LEGACY 와 같은 방식으로 계산한다.
// 크기·mtime 목록 지문만으로는 크기와 시각을 보존한 내용 변경을 잡지 못하기 때문이다.
function inventoryCensus(root) {
  if (!fs.existsSync(root)) {
    return { exists: false, file_count: 0, total_bytes: 0, content_aggregate_sha256: null, inventory_sha256: null, top_entries: [] };
  }
  const rels = walkFiles(root);
  let bytes = 0;
  let metaLines = '';
  let contentLines = '';
  for (const rel of rels) {
    const abs = path.join(root, rel);
    const stat = fs.statSync(abs);
    bytes += stat.size;
    metaLines += `${stat.size} ${Math.trunc(stat.mtimeMs)} ${rel}\n`;
    contentLines += `${sha256File(abs)}  ${rel}\n`;
  }
  const top = fs.readdirSync(root, { withFileTypes: true })
    .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
    .sort(byteOrder);
  return {
    exists: true,
    file_count: rels.length,
    total_bytes: bytes,
    content_aggregate_sha256: sha256Text(contentLines),
    inventory_sha256: sha256Text(metaLines),
    top_entries: top,
  };
}

// MCP 등록값. env 는 이름만 남기고 값은 절대 기록하지 않는다.
function registration() {
  const p = path.join(os.homedir(), '.claude.json');
  if (!fs.existsSync(p)) return { config_found: false };
  const entry = (JSON.parse(fs.readFileSync(p, 'utf8')).mcpServers || {})['web-search'];
  if (!entry) return { config_found: true, registered: false };
  return {
    config_found: true,
    registered: true,
    command: entry.command,
    args: entry.args || [],
    env_keys: Object.keys(entry.env || {}).sort(byteOrder),
    entrypoint_exists: (entry.args || []).some((a) => typeof a === 'string' && a.endsWith('.mjs') && fs.existsSync(a)),
  };
}

// 실제 stdio handshake. initialize → tools/list → tools/call 을 보내고 응답을 읽는다.
function handshake(serverPath) {
  return new Promise((resolve) => {
    const child = spawn('node', [serverPath], { stdio: ['pipe', 'pipe', 'pipe'] });
    const replies = new Map();
    let buffer = '';
    let stderr = '';

    const finish = () => {
      child.kill('SIGTERM');
      const init = replies.get(1)?.result;
      const list = replies.get(2)?.result;
      const call = replies.get(3)?.result;
      resolve({
        server_name: init?.serverInfo?.name ?? null,
        server_version: init?.serverInfo?.version ?? null,
        protocol_version: init?.protocolVersion ?? null,
        tool_count: Array.isArray(list?.tools) ? list.tools.length : null,
        tool_names: Array.isArray(list?.tools) ? list.tools.map((t) => t.name).sort(byteOrder) : null,
        tools_call_is_error: call?.isError ?? null,
        stderr_empty: stderr.trim() === '',
      });
    };

    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let i;
      while ((i = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, i).trim();
        buffer = buffer.slice(i + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id != null) replies.set(msg.id, msg);
        } catch { /* 형식이 아닌 줄은 무시하고 stderr 로 판단한다 */ }
        if (replies.has(3)) return finish();
      }
    });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', () => resolve({ spawn_failed: true }));

    const send = (o) => child.stdin.write(`${JSON.stringify(o)}\n`);
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'baseline', version: '1' } } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'workspace_new', arguments: {} } });
    setTimeout(finish, 8000).unref();
  });
}

async function measure(projectRoot) {
  const legacyRoot = path.join(TOOL_ROOT, 'LEGACY');
  // LEGACY 는 frozen 에서 따로 센다. baseline.json 은 이 스크립트가 만드는 산출물이라 뺀다.
  const skip = [`LEGACY${path.sep}`, path.join('tests', 'baseline', 'baseline.json')];
  const rootFiles = walkFiles(TOOL_ROOT).filter((r) => !skip.some((s) => r === s || r.startsWith(s)));

  return {
    frozen: {
      legacy: { path: legacyRoot, ...contentCensus(legacyRoot) },
      existing_crawl_data: {
        path: path.join(projectRoot, '.claude', 'web-search'),
        ...inventoryCensus(path.join(projectRoot, '.claude', 'web-search')),
      },
      read_only_boundary: {
        statement: 'LEGACY 와 기존 .claude/web-search 는 읽기 전용이다. 변환·삭제·이동하지 않는다.',
        applies_to: [legacyRoot, path.join(projectRoot, '.claude', 'web-search')],
        allowed: ['읽기', '해시 계산'],
        forbidden: ['수정', '삭제', '이동', '형식 변환', '새 workspace 로 자동 이관'],
      },
    },
    current: {
      tool_root: { path: TOOL_ROOT, files: rootFiles, sha256: Object.fromEntries(rootFiles.map((r) => [r, sha256File(path.join(TOOL_ROOT, r))])) },
      registration: registration(),
      handshake: await handshake(path.join(TOOL_ROOT, 'server.mjs')),
      new_workspace_root: (() => {
        const p = path.join(projectRoot, '.claude', 'websearch-workspace');
        return { path: p, exists: fs.existsSync(p) };
      })(),
    },
  };
}

function diff(expected, actual, trail = '') {
  const out = [];
  const keys = new Set([...Object.keys(expected || {}), ...Object.keys(actual || {})]);
  for (const key of keys) {
    const e = expected?.[key];
    const a = actual?.[key];
    const where = trail ? `${trail}.${key}` : key;
    const plain = (v) => v === null || typeof v !== 'object';
    if (plain(e) || plain(a)) {
      if (JSON.stringify(e) !== JSON.stringify(a)) out.push(`${where}: 기준 ${JSON.stringify(e)} → 현재 ${JSON.stringify(a)}`);
    } else {
      out.push(...diff(e, a, where));
    }
  }
  return out;
}

const args = process.argv.slice(2);

// [모르는 깃발은 쓰기가 아니다] 예전에는 `--verify` 가 아니면 무엇이든 "기록" 으로 떨어졌다.
// 그래서 있지도 않은 `--check` 를 준 게이트가 얼려 둔 기준선을 조용히 덮어썼고,
// 덮어쓴 쪽은 언제나 성공하니 게이트는 PASS 를 냈다 — 검사를 하는 척하며 검사 대상을 지운 것이다.
// (2026-08-12 게이트 3 에서 실제로 났다.)
const KNOWN_FLAGS = new Set(['--verify', '--write', '--force', '--project']);
const unknown = args.filter((a) => a.startsWith('--') && !KNOWN_FLAGS.has(a));
if (unknown.length) {
  console.error(`모르는 깃발입니다: ${unknown.join(' ')}`);
  console.error(`쓸 수 있는 것: ${[...KNOWN_FLAGS].join(' ')}`);
  console.error('  --verify  기준선과 대조한다(기본으로 이것을 쓰십시오)');
  console.error('  --write   기준선을 새로 기록한다. 이미 있으면 --force 가 함께 있어야 한다');
  process.exit(2);
}

const mode = args.includes('--write') ? 'write' : 'verify';
const projectIndex = args.indexOf('--project');
const projectRoot = projectIndex !== -1 ? path.resolve(args[projectIndex + 1]) : process.cwd();

// 얼려 둔 것을 덮어쓰는 일은 사람이 뜻을 밝혀야 한다.
if (mode === 'write' && fs.existsSync(BASELINE_PATH) && !args.includes('--force')) {
  console.error(`기준선이 이미 있습니다: ${BASELINE_PATH}`);
  console.error('덮어쓰려면 --force 를 함께 주십시오. 대조만 하려면 --verify 를 쓰십시오.');
  process.exit(2);
}

const measured = await measure(projectRoot);

if (mode === 'write') {
  const doc = {
    schema: 'web-search-v2-baseline/1',
    task: '2026-08-12-web-search-MCP-v2-rebuild#1',
    generated_at: new Date().toISOString(),
    project_root: projectRoot,
    node_version: process.version,
    hash_algorithm: HASH_ALGO,
    aggregate_algorithm: AGGREGATE_SPEC,
    content_aggregate_algorithm: AGGREGATE_SPEC, // LEGACY 와 기존 수집 데이터에 같은 방식을 쓴다
    inventory_algorithm: 'sha256( concat( sorted_by_bytes(relpath) → `${size} ${mtime_ms} ${relpath}\\n` ) )',
    measured,
  };
  fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(doc, null, 2)}\n`);
  console.log(`기준선 기록: ${BASELINE_PATH}`);
  console.log(`LEGACY ${measured.frozen.legacy.file_count}개 · ${measured.frozen.legacy.total_bytes}바이트 · 집계 ${measured.frozen.legacy.aggregate_sha256}`);
  console.log(`기존 수집 데이터 ${measured.frozen.existing_crawl_data.file_count}개 · ${measured.frozen.existing_crawl_data.total_bytes}바이트 · 내용 집계 ${measured.frozen.existing_crawl_data.content_aggregate_sha256}`);
  console.log(`handshake ${measured.current.handshake.server_name}@${measured.current.handshake.server_version} · 공개 도구 ${measured.current.handshake.tool_count}개`);
  process.exit(0);
}

if (!fs.existsSync(BASELINE_PATH)) {
  console.error(`기준선 파일이 없습니다: ${BASELINE_PATH}`);
  process.exit(2);
}
const saved = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
const frozenDiff = diff(saved.measured.frozen, measured.frozen);
const currentDiff = diff(saved.measured.current, measured.current);

console.log(`기준선 ${saved.generated_at} · 프로젝트 ${saved.project_root}`);
console.log(`[frozen] LEGACY ${measured.frozen.legacy.file_count}개 / 집계 ${measured.frozen.legacy.aggregate_sha256}`);
console.log(`[frozen] 기존 수집 데이터 ${measured.frozen.existing_crawl_data.file_count}개 / 내용 집계 ${measured.frozen.existing_crawl_data.content_aggregate_sha256}`);
console.log(frozenDiff.length === 0 ? 'PASS  frozen 영역 변화 없음 (LEGACY·기존 데이터 쓰기 0)' : 'FAIL  frozen 영역이 바뀌었습니다');
for (const line of frozenDiff) console.log(`  ${line}`);

console.log(currentDiff.length === 0 ? 'INFO  새 코드 영역 변화 없음' : `INFO  새 코드 영역 변화 ${currentDiff.length}건 (실패 아님)`);
for (const line of currentDiff) console.log(`  ${line}`);

process.exit(frozenDiff.length === 0 ? 0 : 1);
