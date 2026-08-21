#!/usr/bin/env node
// web-search MCP — 공유 workspace 에서 여러 에이전트가 나눠 쓰는 웹 조사 작업대.
//
// 버튼 하나는 한 가지 일만 한다. 의미 판정은 하지 않는다 — 사실을 모으고 파일로 남길 뿐이다.
// 계약 원본은 tests/contracts/fixtures/public-tools.json 이고 계약 시험이 이 서버와 대조한다.
//
// 아직 구현되지 않은 버튼은 tools/list 에 내지 않는다. 있는 척하면 에이전트가 부르고 실패한다.

import path from 'node:path';
import { BROWSER_CAPABILITY } from './lib/collect/browser.mjs';
import { runCollect } from './lib/collect/index.mjs';
import { pacedFetcher } from './lib/collect/index.mjs';
import { runMap } from './lib/map/index.mjs';
import { openPace } from './lib/pace.mjs';
import { openDb } from './lib/db.mjs';
import { runExport } from './lib/export.mjs';
import { FIXTURE_ALLOW } from './lib/fixture-allow.mjs';
import { parseInput } from './lib/import.mjs';
import { addUrls } from './lib/items.mjs';
import { leaseHealth, nextBatch } from './lib/lease.mjs';
import { requireWorkspace, workspacePaths } from './lib/paths.mjs';
import { submitReport } from './lib/report.mjs';
import { retryItems } from './lib/retry.mjs';
import { statusOf, statusLine } from './lib/status.mjs';
import { TOOL_SCHEMAS } from './lib/tool-schemas.mjs';
import { createWorkspace } from './lib/workspace.mjs';

const SERVER_NAME = 'web-search';
const SERVER_VERSION = '2.0.0-dev';
const MAX_RESPONSE_BYTES = 4096;

// ── 실행 설정 — argv 에서만 온다 ──────────────────────────────
// 정중함의 정도는 운영자가 정한다. 버튼 입력으로는 못 바꾼다 —
// 에이전트가 "빨리 하려고" 간격을 풀 수 있으면 그 규칙은 없는 것과 같다.
function argvValue(flag) {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`${flag}=`));
  return hit === undefined ? null : hit.slice(flag.length + 1);
}
const PACE_DB_PATH = argvValue('--pace-db');
// playwright 는 이 도구 폴더가 아니라 부른 프로젝트에 있다. 어디서 찾을지 알려 주는 자리.
//
// [이 하나만 환경변수도 받는다] 나머지 설정이 argv 전용인 이유는 "버튼 입력으로 정중함을
// 못 바꾸게" 하기 위해서다. 이것은 정중함 손잡이가 아니라 **의존성이 어디 있는지**이고,
// MCP 등록(~/.claude.json)에 이미 WEBSEARCH_DEPS_DIR 로 적혀 있었는데 서버가 그걸 안 읽고
// 있었다(2026-08-12 #48 에서 발견). 등록이 말한 자리를 서버가 무시하면 그 등록은 거짓말이 된다.
const DEPS_DIR = argvValue('--deps-dir') ?? process.env.WEBSEARCH_DEPS_DIR ?? null;
const PACE_OPTS = Object.freeze({
  min_interval_ms: argvValue('--pace-min-interval-ms') === null ? undefined : Number(argvValue('--pace-min-interval-ms')),
  jitter_ms: argvValue('--pace-jitter-ms') === null ? undefined : Number(argvValue('--pace-jitter-ms')),
  // 실패 뒤 얼마나 물러날지. 기본은 1분이고 천장은 5분이다(lib/pace.mjs).
  // 잘린 응답 하나가 그 도메인의 다음 요청을 1분 세우는 것이 기본 정중함이라, 시험처럼 빨리
  // 돌려야 하는 자리에서는 이 문으로 줄인다. 버튼 입력으로는 못 바꾼다.
  retry_backoff_ms: argvValue('--pace-retry-backoff-ms') === null ? undefined : Number(argvValue('--pace-retry-backoff-ms')),
});

function projectRoot() {
  const p = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  return path.resolve(p);
}

// ── 버튼 ──────────────────────────────────────────────────────
// 여기 있는 것만 부를 수 있다. 스키마는 열 개 모두 있지만 handler 는 하나씩 붙는다.

/** workspace 를 열고 쓰고 반드시 닫는다. 여는 자리를 한 곳으로 모은다. */
function inWorkspace(name, fn) {
  const root = requireWorkspace(projectRoot(), name);
  const db = openDb(root, workspacePaths(root).db);
  try { return fn(db, root); } finally { db.close(); }
}

/** 같은 것을 기다리는 판. 수집은 네트워크를 타므로 열어 둔 채 기다렸다가 닫는다. */
async function inWorkspaceAsync(name, fn) {
  const root = requireWorkspace(projectRoot(), name);
  const db = openDb(root, workspacePaths(root).db);
  try { return await fn(db, root); } finally { db.close(); }
}

const HANDLERS = {
  workspace_new(args) {
    const r = createWorkspace(projectRoot(), { topic: args.topic, brief: args.brief });
    return {
      text: `workspace ${r.workspace_id} 를 만들었습니다`
        + (r.gitignore.added_line ? ' · .gitignore 에 무시 규칙을 넣었습니다' : '')
        + (r.gitignore.git_repo === false ? ' · git 저장소가 아니라 무시 확인은 건너뛰었습니다' : ''),
      structuredContent: {
        workspace_id: r.workspace_id,
        workspace_path: r.workspace_path,
        brief_path: r.brief_path,
      },
    };
  },

  add_urls(args) {
    return inWorkspace(args.workspace, (db, root) => {
      const parsed = parseInput(root, { urls: args.urls, file: args.file });
      const r = addUrls(db, parsed.records, {
        source_kind: args.source_kind,
        source_value: args.source_value,
      });
      // 입력 원문을 되돌려주지 않는다. 받은 수·결과와 대표 사유만 낸다.
      const received = parsed.received;
      const rejected = r.rejected + parsed.rejected.length;
      const reasons = [...r.reject_reasons];
      for (const p of parsed.rejected.slice(0, 3)) reasons.push({ reason: p.reason.slice(0, 60), count: 1, first_line: p.line });
      return {
        text: `받은 것 ${received} · 새로 ${r.added} · 중복 ${r.duplicates} · 거절 ${rejected}`
          + (reasons.length ? ` · 대표 사유 ${reasons[0].reason}` : ''),
        structuredContent: {
          received,
          added: r.added,
          duplicates: r.duplicates,
          rejected,
          reject_reasons: reasons.slice(0, 5),
        },
      };
    });
  },

  next(args) {
    return inWorkspace(args.workspace, (db, root) => {
      const r = nextBatch(db, root, {
        workerId: args.worker_id,
        count: args.count ?? undefined,
        leaseMinutes: args.lease_minutes ?? undefined,
      });
      return {
        // 주소 목록은 파일로 준다. 응답에는 경로와 수만 담는다.
        text: r.leased === 0
          ? '빌릴 항목이 없습니다. 대기 중인 것이 없다는 뜻이지 조사가 끝났다는 뜻은 아닙니다.'
          : `${r.leased}건을 빌렸습니다 · 목록 ${r.work_file}`,
        structuredContent: {
          lease_id: r.lease_id, expires_at: r.expires_at, work_file: r.work_file, leased: r.leased,
        },
      };
    });
  },

  report(args) {
    return inWorkspace(args.workspace, (db, root) => {
      // 계약이 "judgments 또는 file" 이라 둘 다 그대로 넘긴다. 어느 쪽만 왔는지는 report 가 가린다.
      const r = submitReport(db, root, {
        leaseId: args.lease_id, workerId: args.worker_id, judgments: args.judgments, file: args.file,
      });
      const why = r.reject_reasons.map((x) => `${x.reason}×${x.count}`).join(', ');
      return {
        text: `반영 ${r.accepted} · 거절 ${r.rejected}${r.duplicate ? ' (같은 report 라 다시 반영하지 않음)' : ''}${why ? ` · ${why}` : ''}`,
        structuredContent: { accepted: r.accepted, rejected: r.rejected, done: r.done },
      };
    });
  },

  async map_domain(args) {
    return inWorkspaceAsync(args.workspace, async (db, root) => {
      const pace = openPace(PACE_DB_PATH ? { dbPath: PACE_DB_PATH } : {});
      try {
        const workspaceId = db.prepare("SELECT value FROM meta WHERE key = 'workspace_id'").get()?.value ?? 'unknown';
        // 지도도 네트워크로 나간다. 수집과 같은 문(예약·목적지 검사)을 쓴다.
        const fetchPage = pacedFetcher(pace, {
          holder: workspaceId, paceOpts: PACE_OPTS, fetchOptions: { fixtureAllow: FIXTURE_ALLOW },
        });
        // fetchOptions 도 함께 준다. runMap 은 실행을 열기 **전에** 스스로 목적지를 한 번 보는데,
        // 그때 쓰는 것이 이 값이다. fetchPage 만 넘기면 그 검사가 허용 목록을 못 봐서
        // 시험 fixture 로는 한 발짝도 못 나간다.
        const fetchOptions = { fixtureAllow: FIXTURE_ALLOW };
        const r = await runMap(db, { root, domain: args.domain, url: args.url, fetchPage, fetchOptions });
        const failedSources = r.sources.filter((s) => s.state === 'failed' || s.state === 'unreadable').length;
        return {
          text: `지도 — 발견 ${r.discovered} · 새 URL ${r.new_urls} · 출처 ${r.sources.length}곳`
            + (failedSources ? ` (못 읽은 곳 ${failedSources})` : '')
            + (r.limits.hit.length ? ` · 상한 도달 ${r.limits.hit.join('·')}` : '')
            + ` · 발견한 곳을 자동으로 방문하지 않았습니다(모두 queued)`,
          structuredContent: {
            sources: r.sources,
            discovered: r.discovered,
            new_urls: r.new_urls,
            map_path: r.map_path,
            limits: r.limits,
            needs_review: r.needs_review,
          },
        };
      } finally { pace.close(); }
    });
  },

  async collect(args) {
    return inWorkspaceAsync(args.workspace, async (db, root) => {
      const r = await runCollect(db, {
        root, leaseId: args.lease_id, mode: args.mode, outputs: args.outputs,
        // 루프백 허용 목록도 속도 정책도 argv 에서만 온다. 버튼 입력으로는 못 켠다.
        fetchOptions: { fixtureAllow: FIXTURE_ALLOW },
        pacePath: PACE_DB_PATH ?? undefined,
        paceOpts: PACE_OPTS,
        depsDir: DEPS_DIR,
      });
      const warned = Object.entries(r.warnings).map(([k, n]) => `${k} ${n}`).join(' · ');
      // 브라우저 모드로 돌았으면 보증 범위를 응답에 적는다. http 와 같은 수준으로 읽히면 안 된다.
      const capability = args.mode === 'browser' ? ` — ${BROWSER_CAPABILITY}` : '';
      return {
        text: `수집 끝 — 성공 ${r.succeeded} · 부분 ${r.partial} · 실패 ${r.failed}`
          + (warned ? ` · 관찰 ${warned}` : '')
          + ` · report 대기 ${r.awaiting_report}건${capability}`,
        structuredContent: {
          succeeded: r.succeeded,
          partial: r.partial,
          failed: r.failed,
          warnings: r.warnings,
          index_path: r.index_path,
          awaiting_report: r.awaiting_report,
        },
      };
    });
  },

  retry(args) {
    return inWorkspace(args.workspace, (db) => {
      const r = retryItems(db, { itemIds: args.item_ids, reason: args.reason });
      const why = r.reject_reasons.map((x) => `${x.reason}×${x.count}`).join(', ');
      return {
        text: `다시 대기 ${r.requeued} · 거절 ${r.rejected}${why ? ` · ${why}` : ''} · 이전 증거는 그대로 둡니다`,
        structuredContent: { requeued: r.requeued, rejected: r.rejected },
      };
    });
  },

  export(args) {
    return inWorkspaceAsync(args.workspace, async (db, root) => {
      const r = await runExport(db, root, {
        format: args.format, fields: args.fields,
        filter_state: args.filter_state, filter_label: args.filter_label, filter_domain: args.filter_domain,
        filter_source: args.filter_source, filter_warning: args.filter_warning,
      });
      const applied = Object.entries(r.filter_summary)
        .filter(([k]) => ['state', 'label', 'domain', 'source', 'warning'].includes(k))
        .map(([k, v]) => `${k}=${[].concat(v).join(',')}`).join(' · ');
      return {
        // 0줄이어도 무엇을 걸렀는지 같이 말한다. 조건 없이 0줄인 것과 걸러서 0줄인 것은 다르다.
        text: `${r.rows}줄 · ${r.path}${applied ? ` · 조건 ${applied}` : ' · 조건 없음'}`
          + ` (전체 ${r.filter_summary.total_items}줄 중) · 원본은 복사하지 않고 경로만 담았습니다`,
        structuredContent: { rows: r.rows, path: r.path, filter_summary: r.filter_summary },
      };
    });
  },

  status(args) {
    return inWorkspace(args.workspace, (db) => {
      const s = statusOf(db);
      return { text: statusLine(s, leaseHealth(db)), structuredContent: s };
    });
  },
};

const listedTools = () => Object.keys(HANDLERS).sort().map((name) => ({
  name,
  description: TOOL_SCHEMAS[name].description,
  inputSchema: TOOL_SCHEMAS[name].inputSchema,
  outputSchema: TOOL_SCHEMAS[name].outputSchema,
}));

// ── 입력 검사 — 스키마가 말한 것만 받는다 ─────────────────────

function validate(name, args) {
  const schema = TOOL_SCHEMAS[name].inputSchema;
  const got = args && typeof args === 'object' ? args : {};
  const known = Object.keys(schema.properties);

  for (const key of schema.required) {
    if (got[key] === undefined) return `필수 인자가 없습니다: ${key}`;
  }
  for (const key of Object.keys(got)) {
    if (!known.includes(key)) return `모르는 인자입니다: ${key}`;
  }
  for (const branchSet of [schema.anyOf].filter(Boolean)) {
    const satisfied = branchSet.some((b) => b.required.every((k) => got[k] !== undefined));
    if (!satisfied) return `${branchSet.map((b) => b.required.join('+')).join(' 또는 ')} 중 하나는 있어야 합니다`;
  }
  for (const [key, spec] of Object.entries(schema.properties)) {
    const v = got[key];
    if (v === undefined) continue;
    if (spec.enum && !spec.enum.includes(v)) return `${key} 는 ${spec.enum.join('·')} 중 하나여야 합니다`;
    if (spec.type === 'array') {
      if (!Array.isArray(v)) return `${key} 는 배열이어야 합니다`;
      const itemEnum = spec.items?.enum;
      if (itemEnum) for (const el of v) if (!itemEnum.includes(el)) return `${key} 에 쓸 수 없는 값입니다: ${String(el).slice(0, 40)}`;
    }
    if (spec.type === 'integer') {
      if (!Number.isInteger(v)) return `${key} 는 정수여야 합니다`;
      if (spec.minimum !== undefined && v < spec.minimum) return `${key} 는 ${spec.minimum} 이상이어야 합니다`;
      if (spec.maximum !== undefined && v > spec.maximum) return `${key} 는 ${spec.maximum} 이하여야 합니다`;
    }
    if (spec.type === 'string' && typeof v !== 'string') return `${key} 는 문자열이어야 합니다`;
  }
  // 조건부 계약 — mode=http 면 screenshot 을 못 받는다. 접속하기 전에 여기서 거절한다.
  for (const branch of schema.allOf ?? []) {
    const cond = branch.if;
    const hit = Object.entries(cond.properties ?? {}).every(([k, s]) => got[k] === s.const)
      && (cond.required ?? []).every((k) => got[k] !== undefined);
    if (!hit) continue;
    for (const [k, s] of Object.entries(branch.then.properties ?? {})) {
      const allowed = s.items?.enum;
      if (allowed && Array.isArray(got[k])) {
        const bad = got[k].filter((el) => !allowed.includes(el));
        if (bad.length) return `${cond.properties.mode.const} 방식에서는 ${bad.join('·')} 를 요청할 수 없습니다`;
      }
    }
  }
  return null;
}

// ── JSON-RPC ──────────────────────────────────────────────────

const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const errorText = (id, text) => reply(id, { content: [{ type: 'text', text }], isError: true });

// 구현이 없는 버튼을 불렀을 때 덧붙일 말. 막다른 길로 두지 않고 대신 갈 길을 알려 준다.
// search 는 못 만든 것이 아니라 **안 만들기로 한 것**이다 — 무키 공급자가 하나도 남지
// 않았다(tests/spikes/search-provider/decision.md). 빈 결과로 꾸미지 않고 여기서 막는다.
const NOT_IMPLEMENTED_NOTES = {
  search: '이 MCP 는 검색을 직접 하지 않습니다. 확정할 무키 공급자가 없어 미완료로 둔 자리입니다'
    + '(근거: tests/spikes/search-provider/decision.md).'
    + ' 에이전트가 자기 WebSearch 로 얻은 URL 을 add_urls 에 source_kind="search",'
    + ' source_value=검색어 로 넣으면 어느 검색어에서 나왔는지 남습니다.',
};

async function callTool(id, params) {
  const name = params?.name;
  if (!Object.prototype.hasOwnProperty.call(HANDLERS, name)) {
    const known = Object.prototype.hasOwnProperty.call(TOOL_SCHEMAS, name);
    if (!known) return errorText(id, `알 수 없는 도구입니다: ${String(name).slice(0, 60)}`);
    const note = NOT_IMPLEMENTED_NOTES[name];
    return errorText(id, `${name} 은 아직 구현되지 않았습니다${note ? ` — ${note}` : ''}`);
  }
  const bad = validate(name, params.arguments);
  if (bad) return errorText(id, bad);

  let r;
  try {
    r = await HANDLERS[name](params.arguments ?? {});
  } catch (e) {
    return errorText(id, `${name} 실패${e.code ? ` (${e.code})` : ''}: ${String(e.message).slice(0, 300)}`);
  }

  const result = { content: [{ type: 'text', text: r.text }], structuredContent: r.structuredContent };
  const bytes = Buffer.byteLength(JSON.stringify({ jsonrpc: '2.0', id, result }), 'utf8');
  if (bytes > MAX_RESPONSE_BYTES) {
    return errorText(id, `${name} 의 응답이 ${bytes}바이트로 상한 ${MAX_RESPONSE_BYTES} 을 넘습니다. 긴 자료는 파일로 돌려줘야 합니다.`);
  }
  return reply(id, result);
}

async function handle(message) {
  const { id, method, params } = message;

  if (method === 'initialize') {
    return reply(id, {
      protocolVersion: params?.protocolVersion || '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return undefined;
  if (method === 'ping') return reply(id, {});
  if (method === 'tools/list') return reply(id, { tools: listedTools() });
  if (method === 'tools/call') return callTool(id, params);
  if (id != null) send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
  return undefined;
}

let buffer = '';
let queue = Promise.resolve();
process.stdin.setEncoding('utf8');
// 부른 쪽이 사라지면 함께 끝난다. 안 그러면 워커가 강제 종료될 때마다 서버가 하나씩 남는다.
process.stdin.on('end', () => process.exit(0));
process.stdin.on('close', () => process.exit(0));
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let newlineIndex;
  while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, newlineIndex).trim();
    buffer = buffer.slice(newlineIndex + 1);
    if (!line) continue;
    // 한 번에 하나씩 처리한다. 수집처럼 오래 걸리는 버튼이 있어도 응답 순서가 뒤바뀌지 않는다.
    queue = queue.then(async () => {
      try {
        await handle(JSON.parse(line));
      } catch (error) {
        process.stderr.write(`[web-search] invalid JSON-RPC message: ${error.message}\n`);
      }
    });
  }
});
