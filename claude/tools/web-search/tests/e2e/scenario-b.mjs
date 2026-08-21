#!/usr/bin/env node
// 시나리오 B 진행기 — 태스크 #45. 한 도메인을 깊게.
//
// 버튼만 부른다. 손잡이는 mcp-client.mjs 하나를 함께 쓴다(시나리오 A 와 같은 것).
//
//   node tests/e2e/scenario-b.mjs seed    --project <dir> --domain <host> --entry <url> --state <json>
//   node tests/e2e/scenario-b.mjs lease   --state <json> --worker w1 --count 60
//   node tests/e2e/scenario-b.mjs collect --state <json> --worker w1 --mode http --outputs text,dom
//   node tests/e2e/scenario-b.mjs digest  --state <json> --out <json>
//   node tests/e2e/scenario-b.mjs judge   --state <json> --worker w1 --rule <json> --digest <json>
//   node tests/e2e/scenario-b.mjs retry   --state <json> --items 1,2,3 --reason "..."
//   node tests/e2e/scenario-b.mjs export  --state <json>
//   node tests/e2e/scenario-b.mjs status  --state <json>
//
// 시나리오 A 와 다른 점은 셋이다: 출발이 검색이 아니라 map_domain 이고, 산출물을 목적에 따라
// 갈라 시키고, 실패한 것만 골라 다시 돌린다.

import fs from 'node:fs';
import path from 'node:path';
import { die, flagOf, readJson, say, startMcp, writeJson } from './mcp-client.mjs';

const argv = process.argv.slice(2);
const phase = argv[0];
const flag = flagOf(argv);

const collectPath = (statePath, worker) =>
  path.join(path.dirname(statePath), `${path.basename(statePath, '.json')}.collect-${worker}.json`);

const BRIEF = (domain) => `# ${domain} 한 도메인 깊게 보기

## 무엇을 하려는가
한 판매 사이트가 **실제로 무엇을 어떻게 파는지**를, 그 사이트 안에서 확인한 범위만큼 모은다.
카드 종류·가격·주문 방법이 어디에 어떻게 적혀 있는지 보려는 것이다.

## 어디까지가 이 조사의 범위인가
- robots 가 알려 준 sitemap 과 대표 페이지, 그리고 이미 모아 둔 링크 목록에서 나온 주소까지.
- 지도에 없는 주소는 "없는 것" 이 아니라 **우리가 안 본 것**이다. 지도의 미확인 범위에 적힌다.

## 산출물은 목적에 따라 나눈다
- 목록·안내 쪽: text + dom (무엇이 적혀 있는지, 구조가 어떤지)
- 상품 쪽 표본: text + images (무엇을 파는지 그림까지)
- 대표 몇 장: screenshot (사람이 눈으로 확인할 것)

## 판정 이름표
목록 · 상품 · 안내 · 정책 · 기타 · 확인 필요
사람이 붙인다. 기계는 붙이지 않는다.
`;

if (phase === 'seed') {
  const projectDir = path.resolve(flag('project') ?? die('--project 가 필요합니다'));
  const domain = flag('domain') ?? die('--domain 이 필요합니다');
  const entry = flag('entry', null);
  const statePath = flag('state') ?? die('--state 가 필요합니다');

  const mcp = startMcp(projectDir);
  await mcp.ready;
  const ws = (await mcp.tool('workspace_new', { topic: flag('topic', 'one domain deep'), brief: BRIEF(domain) })).out;
  say(`workspace ${ws.workspace_id}`);

  const mapped = (await mcp.tool('map_domain', entry ? { workspace: ws.workspace_id, url: entry } : { workspace: ws.workspace_id, domain })).out;
  const st = (await mcp.tool('status', { workspace: ws.workspace_id })).out;
  await mcp.stop();

  writeJson(statePath, {
    project: projectDir,
    domain,
    entry,
    workspace_id: ws.workspace_id,
    workspace_path: ws.workspace_path,
    map: mapped,
    leases: {},
  });
  say(`지도 — 발견 ${mapped.discovered} · 새 URL ${mapped.new_urls} · ${mapped.map_path}`);
  for (const s of mapped.sources) say(`  출처 ${s.kind} ${s.state ?? ''} ${s.url ?? ''} ${s.urls ?? ''}`.trimEnd());
  say(`미확인 범위 ${(mapped.needs_review ?? []).length}줄 · 장부 ${st.total}건(대기 ${st.queued})`);
} else if (phase === 'map') {
  // 다시 그리는 지도. 수집이 남긴 링크 목록이 네 번째 출처로 들어온다 —
  // 몰래 따라간 것이 아니라 **에이전트가 한 번 더 부른 것**이다.
  const state = readJson(flag('state'));
  const mcp = startMcp(state.project);
  await mcp.ready;
  const r = (await mcp.tool('map_domain', { workspace: state.workspace_id, domain: state.domain })).out;
  const st = (await mcp.tool('status', { workspace: state.workspace_id })).out;
  await mcp.stop();
  state.maps = [...(state.maps ?? [state.map]), r];
  writeJson(flag('state'), state);
  say(`지도 다시 — 발견 ${r.discovered} · 새 URL ${r.new_urls} · ${r.map_path}`);
  for (const s of r.sources) say(`  출처 ${s.kind} ${s.state ?? ''} ${s.files ?? ''} ${s.urls ?? ''}`.trimEnd());
  say(`장부 ${st.total}건(대기 ${st.queued} · 임대 ${st.leased} · 완료 ${st.done})`);
} else if (phase === 'lease') {
  const state = readJson(flag('state'));
  const worker = flag('worker') ?? die('--worker 가 필요합니다');
  const count = Number(flag('count', '60'));
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
  const mode = flag('mode', 'http');
  const outputs = (flag('outputs', 'text,dom')).split(',').map((s) => s.trim()).filter(Boolean);
  const lease = state.leases[worker] ?? die(`${worker} 의 임대가 없습니다`);
  const mcp = startMcp(state.project, [`--deps-dir=${state.project}`]);
  await mcp.ready;
  const t0 = Date.now();
  const r = (await mcp.tool('collect', { workspace: state.workspace_id, lease_id: lease.lease_id, mode, outputs })).out;
  await mcp.stop();
  // 워커마다 자기 파일에 적는다. 나란히 돌아도 서로 덮어쓰지 않는다.
  const prev = fs.existsSync(collectPath(flag('state'), worker)) ? readJson(collectPath(flag('state'), worker)) : { runs: [] };
  prev.runs.push({ mode, outputs, elapsed_ms: Date.now() - t0, lease_id: lease.lease_id, ...r });
  writeJson(collectPath(flag('state'), worker), prev);
  say(`${worker} 수집 끝(${mode}: ${outputs.join('+')}) — 성공 ${r.succeeded} · 부분 ${r.partial} · 실패 ${r.failed}`
    + ` · ${Math.round((Date.now() - t0) / 1000)}초`);
  say(`색인 ${r.index_path}`);
} else if (phase === 'digest') {
  const state = readJson(flag('state'));
  const root = state.workspace_path;
  const rows = [];
  for (const worker of Object.keys(state.leases)) {
    const cp = collectPath(flag('state'), worker);
    if (!fs.existsSync(cp)) continue;
    for (const run of readJson(cp).runs) {
      const lines = fs.readFileSync(path.join(root, run.index_path), 'utf8')
        .split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
      for (const line of lines) {
        const manifest = JSON.parse(fs.readFileSync(path.join(root, line.manifest), 'utf8'));
        const textArt = manifest.artifacts.find((a) => a.kind === 'text');
        const excerpt = textArt
          ? fs.readFileSync(path.join(root, textArt.path), 'utf8').replace(/\s+/g, ' ').trim().slice(0, 200)
          : '';
        rows.push({
          item_id: line.item_id,
          worker,
          run: `${run.mode}:${run.outputs.join('+')}`,
          url: line.requested_url,
          path_only: new URL(line.requested_url).pathname,
          status: line.http_status,
          result: line.result,
          error: line.error ? `${line.error.stage}/${line.error.code}` : null,
          warnings: line.warnings,
          produced: line.produced,
          evidence_artifact_ids: manifest.artifacts.map((a) => a.artifact_id),
          excerpt,
        });
      }
    }
  }
  rows.sort((a, b) => a.item_id - b.item_id);
  writeJson(flag('out') ?? die('--out 이 필요합니다'), { workspace_id: state.workspace_id, rows });
  const by = (k) => rows.filter((r) => r.result === k).length;
  say(`${rows.length}건 정리 — 성공 ${by('success')} · 부분 ${by('partial')} · 실패 ${by('failed')}`);
} else if (phase === 'judge') {
  // 규칙 파일은 사람이 쓴다. "경로가 이렇게 생겼으면 이 이름표" 라는 판단을 글로 적은 것이다.
  // 기계가 라벨을 만들어 내는 것이 아니라, 사람의 판단을 여러 건에 같은 기준으로 적용하는 자리다.
  const state = readJson(flag('state'));
  const worker = flag('worker') ?? die('--worker 가 필요합니다');
  const rule = readJson(flag('rule') ?? die('--rule 이 필요합니다'));
  const digest = readJson(flag('digest') ?? die('--digest 가 필요합니다'));
  const lease = state.leases[worker] ?? die(`${worker} 의 임대가 없습니다`);

  const labelFor = (row) => {
    for (const r of rule.rules) {
      if (new RegExp(r.path_matches).test(row.path_only)) return { label: r.label, note: r.why };
    }
    return { label: rule.fallback.label, note: rule.fallback.why };
  };

  const seen = new Set();
  const lines = [];
  const skipped = [];
  for (const row of digest.rows) {
    if (row.worker !== worker) continue;
    if (row.result === 'failed') { skipped.push({ item_id: row.item_id, why: '수집 실패' }); continue; }
    if (seen.has(row.item_id)) continue;          // 같은 item 을 두 번 반납하지 않는다
    seen.add(row.item_id);
    // 못 본 것은 못 봤다고 한다. 차단 화면도, 차림표만 받은 쪽도 마찬가지다 —
    // 주소만 보고 "상품 쪽" 이라 적으면 우리가 본 적 없는 것을 봤다고 적는 것이다.
    const cannotSee = (row.warnings ?? []).find((w) => ['blocked_page_suspected', 'http_error_status', 'thin_text', 'empty_text'].includes(w));
    const { label, note } = cannotSee
      ? { label: null, note: `${cannotSee} — 받은 것은 그 쪽의 내용이 아니다(관찰 ${(row.warnings ?? []).join('·')})` }
      : labelFor(row);
    lines.push(JSON.stringify({
      item_id: String(row.item_id),
      label,
      confidence: label === null ? null : 0.8,
      evidence_artifact_ids: row.evidence_artifact_ids.map(String),
      note: label === null ? `못 정하겠다: ${note}` : note,
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
  say(`${worker} 반납 — 판정 ${lines.length}줄 · 반영 ${r.accepted} · 거절 ${r.rejected}`
    + (skipped.length ? ` · 빼놓은 것 ${skipped.length}건(수집 실패)` : ''));
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
  const FIELDS = ['item_id', 'canonical_url', 'work_state', 'labels', 'judgments', 'sources', 'attempt_ids', 'manifest_paths', 'artifact_paths', 'warning_codes', 'error_codes'];
  const all = (await mcp.tool('export', { workspace: state.workspace_id, format: 'jsonl', fields: FIELDS })).out;
  const products = (await mcp.tool('export', {
    workspace: state.workspace_id, format: 'csv', filter_label: flag('label', '상품'),
    fields: ['item_id', 'canonical_url', 'labels', 'artifact_paths'],
  })).out;
  const failed = (await mcp.tool('export', {
    workspace: state.workspace_id, format: 'jsonl', filter_state: 'failed',
    fields: ['item_id', 'canonical_url', 'error_codes', 'attempt_ids'],
  })).out;
  const st = (await mcp.tool('status', { workspace: state.workspace_id })).out;
  await mcp.stop();
  state.exports = { all, products, failed };
  state.final_status = st;
  writeJson(flag('state'), state);
  say(`전체 ${all.rows}줄 → ${all.path}`);
  say(`분류용 ${products.rows}줄 → ${products.path}`);
  say(`실패만 ${failed.rows}줄 → ${failed.path}`);
} else if (phase === 'status') {
  const state = readJson(flag('state'));
  const mcp = startMcp(state.project);
  await mcp.ready;
  const r = await mcp.tool('status', { workspace: state.workspace_id });
  await mcp.stop();
  say(r.text);
} else {
  die('단계: seed · lease · collect · digest · judge · retry · export · status');
}
