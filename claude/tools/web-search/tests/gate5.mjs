#!/usr/bin/env node
// 게이트 5 — direct search 최종 판정.
//
//   node tests/gate5.mjs          전부 실행하고 판정
//   node tests/gate5.mjs --json
//
// **이 게이트는 통과할 수 없다.** 재려는 기능이 없기 때문이다.
// #6 에서 무키 공급자 아홉 곳을 실측했고 살아남은 곳이 0 이라, `search` 버튼은 만들지 않기로
// 했다(tests/spikes/search-provider/decision.md). 그러니 "5개 언어 50개 검색어" 를 돌릴
// 대상 자체가 없다.
//
// 그래서 여기서 재는 것은 두 가지다.
//   1. **없는 것을 없다고 말하는가** — 있는 척, 빈 결과로 꾸미기, 반쯤 만든 것 숨기기가 없는가
//   2. **대신 가기로 한 길이 실제로 도는가** — 에이전트 WebSearch → add_urls 로 넣은 URL 이
//      어느 검색어에서 나왔는지 되짚어지는가. 그리고 그 길이 못 하는 것은 무엇인가
//
// 종료 코드가 셋이다. 헷갈리지 않게 적어 둔다.
//   0  전부 통과 (이 게이트에서는 나올 수 없다 — 막힌 항목이 늘 있다)
//   1  거짓말을 찾았다. 없는 기능을 있는 척했거나 대체 경로가 깨졌다 — 진짜 결함이다
//   2  거짓말은 없고, 재려던 기능이 없어 판정할 수 없다 — 이 게이트의 정상 결과다
//
// 네트워크는 부르지 않는다. add_urls 는 URL 을 넣기만 하고 방문하지 않으므로 fixture 서버도
// 필요 없다. 게이트가 정말 밖에 안 나갔는지는 fetch 를 세어 확인한다.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { openDb } from '../lib/db.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOL_ROOT = path.resolve(HERE, '..');
const MCP_SERVER = path.join(TOOL_ROOT, 'server.mjs');
const SPIKE = path.join(HERE, 'spikes', 'search-provider');
const AS_JSON = process.argv.includes('--json');

const results = [];
/** 재서 맞고 틀림을 가릴 수 있는 항목. */
const check = (id, title, pass, detail) => results.push({ id, title, kind: 'check', pass: Boolean(pass), detail: String(detail) });
/** 재려는 대상이 없어 판정 자체가 안 되는 항목. 통과로도 실패로도 적지 않는다. */
const blocked = (id, title, detail) => results.push({ id, title, kind: 'blocked', pass: null, detail: String(detail) });
/** 재기는 했는데 어느 쪽이 맞는지 사람이 정해야 하는 항목. 숫자를 적어 두고 넘긴다. */
const open = (id, title, detail) => results.push({ id, title, kind: 'open', pass: null, detail: String(detail) });

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'gate5-'));
process.on('exit', () => { try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* 이미 없으면 그만 */ } });

// 게이트가 바깥을 두드리지 않는지 세어 둔다.
const contacted = new Set();
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  contacted.add(new URL(typeof input === 'string' ? input : input.url).host);
  return realFetch(input, init);
};

function startMcp(projectDir, args) {
  const child = spawn(process.execPath, [MCP_SERVER, ...args], {
    cwd: projectDir, env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buf = '';
  // 응답 상한은 서버가 스스로 지키지만, 지켰는지는 오간 줄을 직접 재서 본다.
  // 어느 부름의 답인지 갈라 재야 한다 — 상한이 걸린 자리와 안 걸린 자리가 다르기 때문이다.
  const askedBy = new Map();
  const biggest = new Map();
  const waiting = new Map();
  child.stdout.on('data', (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const bytes = Buffer.byteLength(line, 'utf8');
      try {
        const m = JSON.parse(line);
        const method = askedBy.get(m.id) ?? 'unknown';
        biggest.set(method, Math.max(biggest.get(method) ?? 0, bytes));
        if (waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
      } catch { /* 무시 */ }
    }
  });
  let id = 0;
  const call = (method, params, ms = 30_000) => new Promise((resolve, reject) => {
    const n = ++id;
    askedBy.set(n, method);
    const t = setTimeout(() => reject(new Error(`${method} 응답이 ${ms}ms 안에 안 왔다`)), ms);
    waiting.set(n, (m) => { clearTimeout(t); resolve(m); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: n, method, params })}\n`);
  });
  const ready = (async () => {
    await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'gate5', version: '1' } });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  })();
  return {
    child, ready, call,
    tool: (name, a, ms) => call('tools/call', { name, arguments: a }, ms),
    maxResponseBytes: (method) => biggest.get(method) ?? 0,
    async stop() { child.kill('SIGTERM'); await new Promise((r) => { child.on('exit', r); setTimeout(r, 1500); }); },
  };
}

// 에이전트가 자기 WebSearch 로 얻었다고 치는 결과 묶음. 5개 언어 · 검색어 10개.
// 같은 URL 이 여러 검색어에서 나오도록 일부러 겹쳐 두었다 — 출처가 다 남는지 보려는 것이다.
// 첫 묶음에는 같은 주소를 한 번 더 넣었다. 그래야 "보낸 수" 와 "검색어·URL 짝의 수" 가 갈려서,
// 장부가 짝으로 세는지 받은 줄 수로 세는지 구별된다.
// 주소는 RFC 2606 예약 도메인이라 아무도 실제로 두드리지 않는다.
const SEARCH_SETS = [
  { locale: 'ko-KR', query: '수제 청첩장 제작', urls: ['https://example.com/ko/a', 'https://example.com/shared/hub', 'https://example.net/ko/b', 'https://example.com/ko/a'] },
  { locale: 'ko-KR', query: '모바일 청첩장 문구', urls: ['https://example.com/ko/a', 'https://example.org/ko/c'] },
  { locale: 'en-US', query: 'letterpress wedding invitations', urls: ['https://example.com/en/a', 'https://example.com/shared/hub', 'https://example.net/en/b'] },
  { locale: 'en-US', query: 'wedding stationery studio', urls: ['https://example.org/en/c'] },
  { locale: 'ja-JP', query: '招待状 デザイン', urls: ['https://example.com/ja/a', 'https://example.com/shared/hub'] },
  { locale: 'ja-JP', query: '結婚式 ペーパーアイテム', urls: ['https://example.net/ja/b'] },
  { locale: 'es-ES', query: 'invitaciones de boda artesanales', urls: ['https://example.com/es/a', 'https://example.org/es/c'] },
  { locale: 'es-ES', query: 'papelería para bodas', urls: ['https://example.net/es/b'] },
  { locale: 'ar-EG', query: 'دعوات زفاف مطبوعة', urls: ['https://example.com/ar/a'] },
  { locale: 'ar-EG', query: 'بطاقات زفاف فاخرة', urls: ['https://example.net/ar/b', 'https://example.com/shared/hub'] },
];
const SENT_URLS = SEARCH_SETS.flatMap((s) => s.urls);
const UNIQUE_URLS = new Set(SENT_URLS);
const LOCALES = new Set(SEARCH_SETS.map((s) => s.locale));
const SHARED = 'https://example.com/shared/hub';
const SHARED_QUERIES = SEARCH_SETS.filter((s) => s.urls.includes(SHARED)).map((s) => s.query);

// ══ G5-1 보존 증거 검증기 ═══════════════════════════════════════
{
  const r = spawnSync(process.execPath, [path.join(SPIKE, 'verify.mjs')], { cwd: TOOL_ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const passed = (r.stdout.match(/^PASS {2}S\d+/gm) ?? []).length;
  const failedLines = (r.stdout.match(/^FAIL/gm) ?? []).length;
  check('G5-1', '#6 의 보존 증거가 그대로이고 결정과 앞뒤가 맞는다', r.status === 0 && passed >= 13 && failedLines === 0,
    `spike 검증기 exit=${r.status} · S 항목 ${passed}개 통과 · 실패 ${failedLines}`);
}

// ══ G5-2 살아남은 공급자 0 ══════════════════════════════════════
{
  const cand = JSON.parse(fs.readFileSync(path.join(SPIKE, 'candidates.json'), 'utf8'));
  const withReason = cand.candidates.filter((c) => c.verdict === 'reject' && String(c.reject_reason ?? '').trim());
  check('G5-2', '후보 전원 탈락 · 살아남은 공급자 0', cand.summary.survivors.length === 0
    && withReason.length === cand.candidates.length && cand.summary.surveyed === cand.candidates.length
    && cand.constraints.length === 4,
    `후보 ${cand.candidates.length}곳 전부 reject(사유 있음 ${withReason.length}) · 살아남은 곳 ${cand.summary.survivors.length}`
    + ` · 제약 ${cand.constraints.join('·')}`);
}

// ══ G5-5 반쯤 만든 공급자가 없다 ════════════════════════════════
// 없다고 적어 놓고 코드 어딘가에 절반쯤 살아 있으면 그게 제일 나쁘다.
{
  const libSearch = fs.existsSync(path.join(TOOL_ROOT, 'lib', 'search'));
  const grep = (pattern) => {
    const r = spawnSync('rg', ['-l', pattern, 'lib', 'server.mjs'], { cwd: TOOL_ROOT, encoding: 'utf8' });
    return (r.stdout ?? '').split('\n').map((s) => s.trim()).filter(Boolean);
  };
  // 이름만 남은 자리(스키마 상수·계약)는 괜찮다. 그 이름을 **쓰는** 코드가 있으면 안 된다.
  const NAME_ONLY = new Set(['lib/schema.mjs', 'lib/tool-schemas.mjs']);
  const providerUse = grep("'search-provider'").filter((f) => !NAME_ONLY.has(f));
  const artifactUse = grep("'search_result'").filter((f) => !NAME_ONLY.has(f));
  check('G5-5', '반쯤 만든 검색 공급자가 코드에 남아 있지 않다',
    !libSearch && providerUse.length === 0 && artifactUse.length === 0,
    `lib/search 폴더 ${libSearch ? '있음' : '없음'}`
    + ` · collector 'search-provider' 를 쓰는 파일 ${providerUse.length}개`
    + ` · artifact 'search_result' 를 쓰는 파일 ${artifactUse.length}개`
    + ` (스키마 상수 두 곳에 이름만 남아 있다)`);
}

// ══ 진짜 서버를 띄워 버튼으로만 본다 ════════════════════════════
const projectDir = path.join(SANDBOX, 'proj');
fs.mkdirSync(projectDir, { recursive: true });
spawnSync('git', ['init', '-q'], { cwd: projectDir });
const mcp = startMcp(projectDir, [`--pace-db=${path.join(projectDir, 'pace.db')}`]);
await mcp.ready;

try {
  // ══ G5-3 tools/list 에 search 가 없다 ═════════════════════════
  // [수를 못 박지 않는다] "여덟 개" 로 재면 버튼이 하나 붙는 날 이 항목이 깨진다 —
  // 그건 결함이 아니라 진도다. 재려는 것은 수가 아니라 **목록에 있는 것은 다 눌린다** 는 성질이다.
  {
    const listed = (await mcp.call('tools/list', {})).result.tools.map((t) => t.name).sort();
    const hollow = [];
    for (const name of listed) {
      const r = (await mcp.tool(name, {})).result;
      if (String(r.content?.[0]?.text ?? '').includes('아직 구현되지 않았습니다')) hollow.push(name);
    }
    check('G5-3', '구현이 없는 버튼을 도구 목록에 내지 않는다',
      !listed.includes('search') && hollow.length === 0 && listed.length > 0,
      `목록 ${listed.length}개(${listed.join(' ')}) — search 없음`
      + ` · 눌러 봤더니 "아직 구현되지 않았습니다" 로 답한 버튼 ${hollow.length}개`);
  }

  // ══ G5-4 불러도 빈 결과로 꾸미지 않는다 ═══════════════════════
  {
    const r = (await mcp.tool('search', { workspace: 'x', queries: ['수제 청첩장'] })).result;
    const text = r.content?.[0]?.text ?? '';
    const whole = JSON.stringify(r);
    check('G5-4', 'search 호출은 오류로 막고 빈 결과로 꾸미지 않으며 갈 길을 알려 준다',
      r.isError === true && r.structuredContent === undefined
      && !/queries_succeeded|new_urls/.test(whole)
      && text.includes('add_urls') && text.includes('decision.md'),
      `isError=${r.isError} · structuredContent ${r.structuredContent === undefined ? '없음' : '있음'}`
      + ` · 0건 성공으로 위장한 칸 ${/queries_succeeded|new_urls/.test(whole) ? '있음' : '없음'}`
      + ` · 안내 "${text.slice(0, 40)}…"`);
  }

  // ══ G5-6 유지하기로 한 길이 실제로 도는가 ═════════════════════
  const ws = (await mcp.tool('workspace_new', { topic: 'gate5', brief: '게이트 5 — direct search 판정' })).result.structuredContent;
  const root = path.join(projectDir, '.claude', 'websearch-workspace', ws.workspace_id);

  let firstAdded = 0;
  for (const s of SEARCH_SETS) {
    const r = (await mcp.tool('add_urls', {
      workspace: ws.workspace_id, source_kind: 'search', source_value: s.query, urls: s.urls,
    })).result.structuredContent;
    firstAdded += r.added;
  }
  {
    const db = openDb(root, path.join(root, 'workspace.db'));
    const items = db.prepare('SELECT COUNT(*) AS n FROM items').get().n;
    const searchSources = db.prepare("SELECT COUNT(*) AS n FROM sources WHERE source_kind = 'search'").get().n;
    const orphan = db.prepare(`
      SELECT COUNT(*) AS n FROM items i
       WHERE NOT EXISTS (SELECT 1 FROM sources s WHERE s.item_id = i.item_id AND s.source_kind = 'search')`).get().n;
    // 여러 검색어에서 나온 URL 하나를 골라 실제로 되짚어 본다.
    const back = db.prepare(`
      SELECT s.source_value AS q FROM sources s JOIN items i ON i.item_id = s.item_id
       WHERE i.canonical_url = ? AND s.source_kind = 'search' ORDER BY s.source_value`).all(SHARED).map((r) => r.q);
    db.close();

    const distinctPairs = new Set(SEARCH_SETS.flatMap((s) => s.urls.map((u) => `${u} ${s.query}`))).size;
    check('G5-6', '에이전트 WebSearch → add_urls 경로에서 item 마다 검색어가 되짚어진다',
      items === UNIQUE_URLS.size && firstAdded === UNIQUE_URLS.size && orphan === 0
      && searchSources === distinctPairs
      && back.length === SHARED_QUERIES.length && SHARED_QUERIES.every((q) => back.includes(q)),
      `언어 ${LOCALES.size}종 · 검색어 ${SEARCH_SETS.length}개 · 보낸 URL ${SENT_URLS.length}줄`
      + `(고유 ${UNIQUE_URLS.size} · 검색어·URL 짝 ${distinctPairs})`
      + ` → item ${items}개 · 검색어 출처 ${searchSources}줄 · 검색어 없는 item ${orphan}개`
      + ` · 겹친 URL 하나가 검색어 ${back.length}개로 되짚어진다`);
  }

  // ══ G5-7 같은 결과를 다시 넣어도 item 이 늘지 않는다 ══════════
  {
    let addedAgain = 0;
    let dupAgain = 0;
    for (const s of SEARCH_SETS) {
      const r = (await mcp.tool('add_urls', {
        workspace: ws.workspace_id, source_kind: 'search', source_value: s.query, urls: s.urls,
      })).result.structuredContent;
      addedAgain += r.added;
      dupAgain += r.duplicates;
    }
    const db = openDb(root, path.join(root, 'workspace.db'));
    const items = db.prepare('SELECT COUNT(*) AS n FROM items').get().n;
    const sources = db.prepare("SELECT COUNT(*) AS n FROM sources WHERE source_kind = 'search'").get().n;
    db.close();
    const distinctPairs = new Set(SEARCH_SETS.flatMap((s) => s.urls.map((u) => `${u} ${s.query}`))).size;
    check('G5-7', '같은 검색 결과를 반복해도 item 중복 증가 0',
      addedAgain === 0 && dupAgain === SENT_URLS.length && items === UNIQUE_URLS.size && sources === distinctPairs,
      `두 번째 실행: 새로 ${addedAgain} · 중복 ${dupAgain} · item ${items}개 그대로`
      + ` · 검색어 출처 ${sources}줄 그대로(같은 검색어·같은 URL 은 두 번 안 적는다)`);
  }

  // ══ G5-8 원문은 파일에만 · 버튼 응답은 4KB 이내 ═══════════════
  {
    const call = mcp.maxResponseBytes('tools/call');
    const list = mcp.maxResponseBytes('tools/list');
    check('G5-8', '버튼 응답이 4KB 이내', call <= 4096,
      `이번 게이트에서 오간 버튼 응답 중 가장 큰 것 ${call}바이트 (상한 4096)`);
    // 재 보니 도구 목록만 상한 밖이다. 계약 문구는 "응답 한 줄 전체" 라고 넓게 적혀 있는데,
    // 서버도 계약 시험도 상한을 버튼 응답에만 건다. 어느 쪽이 맞는지는 사람이 정할 일이다.
    if (list > 4096) {
      open('G5-O1', '도구 목록 응답이 계약 문구의 상한 밖이다',
        `tools/list 응답 ${list}바이트 > 4096. 담긴 것은 원문이 아니라 버튼 스키마이고,`
        + ' 계약 시험(C4)과 서버(callTool)는 상한을 버튼 응답에만 적용한다.'
        + ' 계약 문구를 "버튼 응답" 으로 좁힐지, 스키마 설명을 줄일지는 계약 개정 사안이라 여기서 정하지 않는다.');
    }
  }

  // ══ 판정할 수 없는 것들 ═══════════════════════════════════════
  {
    const db = openDb(root, path.join(root, 'workspace.db'));
    const searchAttempts = db.prepare("SELECT COUNT(*) AS n FROM attempts WHERE operation = 'search'").get().n;
    const searchArtifacts = db.prepare("SELECT COUNT(*) AS n FROM artifacts WHERE kind = 'search_result'").get().n;
    const sourceCols = db.prepare('PRAGMA table_info(sources)').all().map((c) => c.name);
    db.close();

    blocked('G5-B1', '5개 언어·50개 검색어 실행과 성공·진짜 0건·차단·공급자 오류 구분',
      `실행할 공급자가 0곳이라 검색을 한 번도 돌리지 못했다 — search 실행 기록 ${searchAttempts}건.`
      + ' 성공·진짜 0건·차단·공급자 오류를 가르는 일은 결과가 있어야 성립한다.');
    blocked('G5-B2', '결과마다 rank·제목·설명 원문·원문 artifact 역추적',
      `search_result artifact ${searchArtifacts}개 · sources 칸은 [${sourceCols.join(', ')}] 뿐이다.`
      + ' 되짚어지는 것은 검색어 하나(source_value)까지다. rank·제목·설명 원문은 넣을 자리가 없고,'
      + ` 이번 실행에서 보낸 locale ${LOCALES.size}종도 어디에도 안 남았다.`);
    blocked('G5-B3', '반복 실행에서 CAPTCHA·차단 빈도와 이용 조건 기록',
      '반복 실행 자체가 없다. 이용 조건은 #6 이 하루치 한 번 기록해 둔 것이 전부이고'
      + '(robots 10건·probe 3건·이용 조건 4건), 빈도는 여러 날 돌려야 나오는 수치라 이 게이트로 못 낸다.');
  }
} finally {
  await mcp.stop();
}

// ══ G5-9 게이트가 밖으로 안 나갔다 ══════════════════════════════
{
  const outside = [...contacted];
  check('G5-9', '게이트가 바깥 네트워크를 부르지 않음', outside.length === 0,
    `접촉한 곳 ${outside.join(', ') || '없음'} (add_urls 는 URL 을 넣기만 하고 방문하지 않는다)`);
}

const checks = results.filter((r) => r.kind === 'check');
const failed = checks.filter((r) => !r.pass);
const stuck = results.filter((r) => r.kind === 'blocked');
const opens = results.filter((r) => r.kind === 'open');
const verdict = failed.length ? 'FAIL' : (stuck.length ? 'BLOCKED' : 'PASS');

if (AS_JSON) {
  process.stdout.write(`${JSON.stringify({
    gate: 5, verdict, pass: verdict === 'PASS',
    checks: checks.length, failed: failed.length, blocked: stuck.length, open: opens.length, results,
  }, null, 2)}\n`);
} else {
  const TAGS = { blocked: 'BLOCK', open: 'OPEN ' };
  for (const r of results) {
    const tag = TAGS[r.kind] ?? (r.pass ? 'PASS ' : 'FAIL ');
    process.stdout.write(`${tag} ${r.id}  ${r.title}\n        ${r.detail}\n`);
  }
  process.stdout.write(`\n${verdict} — 잴 수 있는 것 ${checks.length - failed.length}/${checks.length} 통과`
    + ` · 잴 수 없는 것 ${stuck.length}건 · 사람이 정할 것 ${opens.length}건\n`);
  if (verdict === 'BLOCKED') {
    process.stdout.write('게이트 5 는 통과가 아니다. direct search 는 기능으로 없고, #38 과 #49 는 이 사실을 안고 간다.\n');
  }
}
process.exit(failed.length ? 1 : (stuck.length ? 2 : 0));
