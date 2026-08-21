#!/usr/bin/env node
// 시나리오 A 진행기 — 태스크 #44.
//
// 이 파일은 **MCP 버튼만 부른다.** http 요청도, playwright 도 여기 없다 —
// import 는 child_process·fs·path 뿐이고, 게이트 7 이 그 사실을 검사한다.
// 수집은 전부 collect 버튼이 하고, 이 파일은 버튼을 누르고 돌려받은 경로를 읽을 뿐이다.
//
//   node tests/e2e/scenario-a.mjs seed    --project <dir> --input <json> --state <json>
//   node tests/e2e/scenario-a.mjs lease   --state <json> --worker w1 --count 50
//   node tests/e2e/scenario-a.mjs collect --state <json> --worker w1 [--mode browser]
//   node tests/e2e/scenario-a.mjs digest  --state <json> --out <json>
//   node tests/e2e/scenario-a.mjs judge   --state <json> --worker w1 --decisions <json>
//   node tests/e2e/scenario-a.mjs export  --state <json>
//   node tests/e2e/scenario-a.mjs status  --state <json>
//
// state 파일에 workspace_id 와 임대 번호를 적어 두고 단계 사이에 넘긴다.

import fs from 'node:fs';
import path from 'node:path';
import { die, flagOf, readJson, say, startMcp, writeJson } from './mcp-client.mjs';

const argv = process.argv.slice(2);
const phase = argv[0];
const flag = flagOf(argv);

/** 워커마다 자기 수집 결과 파일. 나란히 돌아도 서로 덮어쓰지 않는다. */
const collectPath = (statePath, worker) =>
  path.join(path.dirname(statePath), `${path.basename(statePath, '.json')}.collect-${worker}.json`);

const BRIEF = `# 전 세계 결혼식 후보 사이트 찾기

## 무엇을 찾는가
결혼식 청첩장·페이퍼 아이템을 **직접 만들어 파는 곳**의 대표 페이지.

## 어디를
다섯 나라 다섯 언어로 본다 — 대한민국(ko-KR) · 미국과 영국(en-US) · 일본(ja-JP) ·
스페인(es-ES) · 프랑스(fr-FR). 이탈리아는 영어 검색어로 한 갈래만 걸쳐 본다.

## 포함
- 자기 이름으로 청첩장·페이퍼 아이템을 만들어 파는 업체
- 인쇄소·레터프레스 공방처럼 주문 제작을 받는 곳
- 모바일 청첩장 서비스

## 제외
- 여러 업체를 모아 파는 마켓·포털 (마켓)
- 기사·잡지·블로그 글 (언론·블로그)
- 결혼식과 상관없는 곳, 도구·앱·백과사전 (무관)

## 판정 이름표
업체 · 언론 · 마켓 · 블로그 · 무관 · 확인 필요
이 여섯 중 하나를 사람이 붙인다. 기계는 붙이지 않는다.

## 어떻게 찾았나
워커가 자기 WebSearch 로 22개 검색어를 돌려 얻은 결과를 add_urls 로 넣었다.
이 MCP 에는 search 버튼이 없다 — 무키 공급자가 하나도 없어 만들지 않았다.
`;

// ── 단계 ──────────────────────────────────────────────────────

if (phase === 'seed') {
  const projectDir = path.resolve(flag('project') ?? die('--project 가 필요합니다'));
  const input = readJson(flag('input') ?? die('--input 이 필요합니다'));
  const statePath = flag('state') ?? die('--state 가 필요합니다');

  const mcp = startMcp(projectDir);
  await mcp.ready;
  const ws = (await mcp.tool('workspace_new', { topic: 'wedding candidates worldwide', brief: BRIEF })).out;
  say(`workspace ${ws.workspace_id}`);

  let received = 0;
  let added = 0;
  let duplicates = 0;
  let rejected = 0;
  const perQuery = [];
  for (const q of input.queries) {
    const r = (await mcp.tool('add_urls', {
      workspace: ws.workspace_id, source_kind: 'search', source_value: q.query, urls: q.urls,
    })).out;
    received += r.received; added += r.added; duplicates += r.duplicates; rejected += r.rejected;
    perQuery.push({ locale: q.locale, country: q.country, query: q.query, ...r });
  }
  const st = (await mcp.tool('status', { workspace: ws.workspace_id })).out;
  await mcp.stop();

  writeJson(statePath, {
    project: projectDir,
    workspace_id: ws.workspace_id,
    workspace_path: ws.workspace_path,
    input: path.resolve(flag('input')),
    queries: input.queries.length,
    locales: [...new Set(input.queries.map((q) => q.locale))],
    countries: [...new Set(input.queries.map((q) => q.country))],
    seeded: { received, added, duplicates, rejected, per_query: perQuery },
    leases: {},
  });
  say(`검색어 ${input.queries.length}개 · 받은 URL ${received} · 새로 ${added} · 중복 ${duplicates} · 거절 ${rejected}`);
  say(`장부 ${st.total}건 (대기 ${st.queued})`);
} else if (phase === 'lease') {
  const state = readJson(flag('state'));
  const worker = flag('worker') ?? die('--worker 가 필요합니다');
  const count = Number(flag('count', '50'));
  const mcp = startMcp(state.project);
  await mcp.ready;
  const r = (await mcp.tool('next', { workspace: state.workspace_id, worker_id: worker, count })).out;
  await mcp.stop();
  state.leases[worker] = { lease_id: r.lease_id, leased: r.leased, work_file: r.work_file, expires_at: r.expires_at };
  writeJson(flag('state'), state);
  say(`${worker} 가 ${r.leased}건 빌렸다 · ${r.lease_id}`);
} else if (phase === 'collect') {
  const state = readJson(flag('state'));
  const worker = flag('worker') ?? die('--worker 가 필요합니다');
  const mode = flag('mode', 'browser');
  const lease = state.leases[worker] ?? die(`${worker} 의 임대가 없습니다`);
  const mcp = startMcp(state.project, [`--deps-dir=${state.project}`]);
  await mcp.ready;
  const t0 = Date.now();
  const r = (await mcp.tool('collect', {
    workspace: state.workspace_id, lease_id: lease.lease_id, mode,
    outputs: mode === 'browser' ? ['screenshot', 'text'] : ['text'],
  })).out;
  await mcp.stop();
  // [겹쳐 쓰지 않는다] 워커 셋이 나란히 돌면 공용 state 파일을 서로 덮어쓴다.
  // 각자 자기 파일에 적고, digest 가 모아 읽는다.
  writeJson(collectPath(flag('state'), worker), { worker, mode, elapsed_ms: Date.now() - t0, ...r });
  say(`${worker} 수집 끝 — 성공 ${r.succeeded} · 부분 ${r.partial} · 실패 ${r.failed} · ${Math.round((Date.now() - t0) / 1000)}초`);
  say(`색인 ${r.index_path}`);
} else if (phase === 'digest') {
  // 수집이 돌려준 색인과 요약 파일만 읽는다. 장부(DB)는 안 연다 —
  // 에이전트가 실제로 손에 쥐는 것이 이 두 가지뿐이기 때문이다.
  const state = readJson(flag('state'));
  const root = state.workspace_path;
  const rows = [];
  for (const worker of Object.keys(state.leases)) {
    const cp = collectPath(flag('state'), worker);
    if (!fs.existsSync(cp)) continue;
    const collect = readJson(cp);
    const lines = fs.readFileSync(path.join(root, collect.index_path), 'utf8')
      .split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
    for (const line of lines) {
      const manifest = JSON.parse(fs.readFileSync(path.join(root, line.manifest), 'utf8'));
      const textArt = manifest.artifacts.find((a) => a.kind === 'text');
      let excerpt = '';
      if (textArt) {
        excerpt = fs.readFileSync(path.join(root, textArt.path), 'utf8')
          .replace(/\s+/g, ' ').trim().slice(0, 220);
      }
      rows.push({
        item_id: line.item_id,
        worker,
        url: line.requested_url,
        final_url: line.final_url,
        status: line.http_status,
        result: line.result,
        error: line.error ? `${line.error.stage}/${line.error.code}` : null,
        warnings: line.warnings,
        evidence_artifact_ids: manifest.artifacts.map((a) => a.artifact_id),
        text_bytes: textArt?.byte_size ?? 0,
        excerpt,
      });
    }
  }
  rows.sort((a, b) => a.item_id - b.item_id);
  writeJson(flag('out') ?? die('--out 이 필요합니다'), { workspace_id: state.workspace_id, rows });
  say(`${rows.length}건 정리 — 성공 ${rows.filter((r) => r.result === 'success').length}`
    + ` · 부분 ${rows.filter((r) => r.result === 'partial').length}`
    + ` · 실패 ${rows.filter((r) => r.result === 'failed').length}`);
} else if (phase === 'judge') {
  // 사람(에이전트)이 정한 이름표를 판정 파일로 만들어 report 에 넘긴다.
  // 근거 artifact 번호는 요약 파일에서 그대로 가져온다 — 지어내지 않는다.
  const state = readJson(flag('state'));
  const worker = flag('worker') ?? die('--worker 가 필요합니다');
  const decisions = readJson(flag('decisions') ?? die('--decisions 가 필요합니다'));
  const digest = readJson(flag('digest') ?? die('--digest 가 필요합니다'));
  const lease = state.leases[worker] ?? die(`${worker} 의 임대가 없습니다`);

  const byItem = new Map(digest.rows.map((r) => [String(r.item_id), r]));
  const lines = [];
  const skipped = [];
  for (const [itemId, d] of Object.entries(decisions.labels ?? decisions)) {
    const row = byItem.get(String(itemId));
    if (!row) { skipped.push({ item_id: itemId, why: '요약에 없는 번호' }); continue; }
    if (row.worker !== worker) continue;                    // 다른 워커의 항목은 그 워커가 반납한다
    if (row.result === 'failed') { skipped.push({ item_id: itemId, why: '수집 실패 — 반납 대상이 아니다' }); continue; }
    const label = typeof d === 'string' ? d : d.label;
    const note = typeof d === 'string' ? `${row.url} 본문을 보고 정함` : (d.note ?? `${row.url} 본문을 보고 정함`);
    lines.push(JSON.stringify({
      item_id: String(row.item_id),
      label: label === '확인 필요' ? null : label,
      confidence: label === '확인 필요' ? null : 0.8,
      evidence_artifact_ids: row.evidence_artifact_ids.map(String),
      note: label === '확인 필요' ? `못 정하겠다: ${note}` : note,
    }));
  }
  const rel = `judgments-${worker}.jsonl`;
  fs.writeFileSync(path.join(state.workspace_path, rel), `${lines.join('\n')}\n`);

  const mcp = startMcp(state.project);
  await mcp.ready;
  const r = (await mcp.tool('report', {
    workspace: state.workspace_id, lease_id: lease.lease_id, worker_id: worker, file: rel,
  })).out;
  await mcp.stop();
  lease.report = { ...r, judgments_file: rel, lines: lines.length, skipped };
  writeJson(flag('state'), state);
  say(`${worker} 반납 — 판정 ${lines.length}줄 · 반영 ${r.accepted} · 거절 ${r.rejected}`);
  if (skipped.length) say(`빼놓은 것 ${skipped.length}건 (${[...new Set(skipped.map((s) => s.why))].join(' · ')})`);
} else if (phase === 'retry') {
  const state = readJson(flag('state'));
  const items = (flag('items') ?? die('--items 가 필요합니다')).split(',').map((s) => s.trim()).filter(Boolean);
  const mcp = startMcp(state.project);
  await mcp.ready;
  const r = (await mcp.tool('retry', {
    workspace: state.workspace_id, item_ids: items, reason: flag('reason', '다시 본다'),
  })).out;
  await mcp.stop();
  say(`다시 대기 ${r.requeued} · 거절 ${r.rejected}`);
} else if (phase === 'export') {
  const state = readJson(flag('state'));
  const mcp = startMcp(state.project);
  await mcp.ready;
  const FIELDS = ['item_id', 'canonical_url', 'domain', 'work_state', 'labels', 'judgments', 'sources', 'manifest_paths', 'artifact_paths', 'error_codes'];
  const all = (await mcp.tool('export', { workspace: state.workspace_id, format: 'jsonl', fields: FIELDS })).out;
  const vendors = (await mcp.tool('export', {
    workspace: state.workspace_id, format: 'csv', filter_label: '업체',
    fields: ['item_id', 'canonical_url', 'domain', 'labels', 'sources'],
  })).out;
  const st = (await mcp.tool('status', { workspace: state.workspace_id })).out;
  await mcp.stop();
  state.exports = { all, vendors };
  state.final_status = st;
  writeJson(flag('state'), state);
  say(`전체 ${all.rows}줄 → ${all.path}`);
  say(`업체만 ${vendors.rows}줄 → ${vendors.path}`);
} else if (phase === 'status') {
  const state = readJson(flag('state'));
  const mcp = startMcp(state.project);
  await mcp.ready;
  const r = await mcp.tool('status', { workspace: state.workspace_id });
  await mcp.stop();
  say(r.text);
  say(JSON.stringify(r.out, null, 2));
} else {
  die('단계: seed · lease · collect · digest · judge · export · status');
}
