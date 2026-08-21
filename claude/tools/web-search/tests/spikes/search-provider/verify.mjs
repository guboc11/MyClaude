#!/usr/bin/env node
// 검색 공급자 조사(#6) 보존 증거 검증 — 네트워크를 다시 부르지 않는다.
//
//   node tests/spikes/search-provider/verify.mjs
//
// 바깥을 다시 두드리면 그때그때 결과가 달라져 "그날 무엇을 봤는가" 를 확인할 수 없다.
// 그래서 이 검증기는 저장된 원문과 지문, 분류의 앞뒤만 본다.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOL_ROOT = path.resolve(HERE, '..', '..', '..');

// 네트워크 차단 — 이 시험이 도는 동안 바깥으로 나가면 실패한다.
let networkAttempts = 0;
const blocked = (what) => (...a) => { networkAttempts++; throw new Error(`검증기는 네트워크를 쓰지 않는다: ${what}(${String(a[0]).slice(0, 60)})`); };
globalThis.fetch = blocked('fetch');

const results = [];
const ok = (id, pass, detail) => results.push({ id, pass, detail });
const sha256 = (p) => createHash('sha256').update(fs.readFileSync(p)).digest('hex');

const cand = JSON.parse(fs.readFileSync(path.join(HERE, 'candidates.json'), 'utf8'));
const probe = JSON.parse(fs.readFileSync(path.join(HERE, 'results', 'probe.json'), 'utf8'));
const decision = fs.readFileSync(path.join(HERE, 'decision.md'), 'utf8');

// ── 1. 증거 원문이 그대로 있는가 ──────────────────────────────

{
  const m = cand.evidence_manifest;
  const problems = [];
  for (const f of m.files) {
    const abs = path.join(HERE, f.path);
    if (!fs.existsSync(abs)) { problems.push(`${f.path}: 없음`); continue; }
    const bytes = fs.statSync(abs).size;
    if (bytes !== f.bytes) problems.push(`${f.path}: 크기 ${bytes} ≠ ${f.bytes}`);
    const h = sha256(abs);
    if (h !== f.sha256) problems.push(`${f.path}: 지문 ${h.slice(0, 12)} ≠ ${f.sha256.slice(0, 12)}`);
  }
  ok('S1-evidence-intact', problems.length === 0,
    problems.length ? problems.join(', ') : `증거 ${m.files.length}개 크기·지문 일치`);

  const kinds = m.files.reduce((acc, f) => {
    const k = f.path.split('/')[1];
    acc[k] = (acc[k] || 0) + 1;
    return acc;
  }, {});
  ok('S2-evidence-counts',
    kinds.robots === m.robots_count && kinds.probe === m.probe_count && kinds.tos === m.terms_count,
    `robots ${kinds.robots}/${m.robots_count} · probe ${kinds.probe}/${m.probe_count} · terms ${kinds.tos}/${m.terms_count}`);
}

// ── 2. 후보마다 판정과 근거가 갖춰졌는가 ──────────────────────

const VERDICTS = new Set(['reject', 'accept']);
{
  const problems = [];
  for (const c of cand.candidates) {
    if (!VERDICTS.has(c.verdict)) problems.push(`${c.id}: 판정값 ${c.verdict}`);
    if (!c.reject_reason && c.verdict === 'reject') problems.push(`${c.id}: 사유 없음`);
    if (!c.endpoint || c.keyless !== true) problems.push(`${c.id}: endpoint·무키 표기 빠짐`);
    // 근거로 든 artifact 가 실제 파일이어야 한다
    for (const ref of [c.robots?.artifact, c.probe?.artifact, c.terms?.artifact].filter(Boolean)) {
      if (!fs.existsSync(path.join(HERE, ref))) problems.push(`${c.id}: 근거 파일 없음 ${ref}`);
    }
    // 조사만 하고 근거를 하나도 안 단 후보가 없어야 한다
    const hasEvidence = c.robots || c.function || c.probe?.artifact;
    if (!hasEvidence) problems.push(`${c.id}: 근거 없음`);
  }
  ok('S3-candidate-records', problems.length === 0,
    problems.length ? problems.join(', ') : `후보 ${cand.candidates.length}곳 모두 판정·사유·근거 파일 있음`);
}

// ── 3. 분류가 서로 배타적인가, 살아남은 후보가 0인가 ──────────

{
  const s = cand.summary;
  const all = cand.candidates.map((c) => c.id);
  const buckets = ['rejected_by_robots', 'rejected_by_captcha', 'rejected_by_function', 'rejected_by_terms'];
  const problems = [];

  // 모든 후보가 적어도 한 갈래에 들어가야 한다
  const covered = new Set(buckets.flatMap((b) => s[b] ?? []));
  const uncovered = all.filter((id) => !covered.has(id));
  if (uncovered.length) problems.push(`어느 갈래에도 없는 후보: ${uncovered.join(', ')}`);
  for (const id of covered) if (!all.includes(id)) problems.push(`후보 목록에 없는 id: ${id}`);

  // 갈래마다 그 후보의 실제 기록과 맞아야 한다 — 이름만 넣어 둔 것을 잡는다
  for (const id of s.rejected_by_robots ?? []) {
    const c = cand.candidates.find((x) => x.id === id);
    if (c?.robots?.verdict !== 'disallow') problems.push(`${id}: robots 갈래인데 robots.verdict=${c?.robots?.verdict}`);
  }
  for (const id of s.rejected_by_captcha ?? []) {
    const c = cand.candidates.find((x) => x.id === id);
    if (c?.robots?.verdict !== 'unavailable') problems.push(`${id}: captcha 갈래인데 근거가 맞지 않음`);
  }
  for (const id of s.rejected_by_function ?? []) {
    const c = cand.candidates.find((x) => x.id === id);
    if (c?.function?.verdict !== 'mismatch') problems.push(`${id}: function 갈래인데 mismatch 기록이 없음`);
  }
  for (const id of s.rejected_by_terms ?? []) {
    const c = cand.candidates.find((x) => x.id === id);
    const v = c?.terms?.verdict;
    if (!['prohibited', 'unclear-to-prohibited'].includes(v)) problems.push(`${id}: terms 갈래인데 terms.verdict=${v}`);
  }
  ok('S4-buckets-consistent', problems.length === 0,
    problems.length ? problems.join(', ') : `후보 ${all.length}곳이 네 갈래에 빠짐없이 들어가고 각 갈래가 기록과 맞는다`);

  ok('S5-no-survivors',
    (s.survivors ?? []).length === 0 && cand.candidates.every((c) => c.verdict === 'reject'),
    `살아남은 후보 ${s.survivors.length} · reject ${cand.candidates.filter((c) => c.verdict === 'reject').length}/${all.length}`);
  ok('S6-corpus-not-run', s.corpus_run === false && !!s.corpus_not_run_why,
    `50개 검색어 실행 ${s.corpus_run} · 사유 기록 ${s.corpus_not_run_why ? '있음' : '없음'}`);
}

// ── 4. 판정에 쓴 UA 와 예비 UA 구분 ───────────────────────────

{
  const ua = cand.user_agent;
  const problems = [];
  if (!/WebSearchMCP-Spike/.test(ua.used_for_verdicts)) problems.push('판정 UA 가 식별 가능한 자동화 UA 가 아님');
  if (/Mozilla|Chrome\/\d/.test(ua.used_for_verdicts)) problems.push('판정 UA 가 브라우저를 흉내 냄');
  if (!ua.earlier_chrome_ua) problems.push('예비 Chrome UA 를 쓴 사실이 기록되지 않음');
  if (probe.user_agent !== ua.used_for_verdicts) problems.push(`probe.json 의 UA 가 다름: ${probe.user_agent}`);
  ok('S7-user-agent', problems.length === 0,
    problems.length ? problems.join(', ') : `판정 UA "${ua.used_for_verdicts}" · 예비 Chrome UA 비채택 기록 있음`);
}

// ── 5. 실행 기록이 절제됐는가 ─────────────────────────────────

{
  const problems = [];
  if (!(probe.pacing?.domain_gap_ms >= 3000)) problems.push(`도메인 간격 ${probe.pacing?.domain_gap_ms}ms`);
  if (probe.requests > 20) problems.push(`요청 ${probe.requests}건은 사전 probe 치고 많다`);
  const probeSteps = probe.findings.filter((f) => f.step === 'probe');
  if (probeSteps.length !== cand.evidence_manifest.probe_count) {
    problems.push(`probe 기록 ${probeSteps.length} ≠ 저장된 probe 원문 ${cand.evidence_manifest.probe_count}`);
  }
  for (const f of probeSteps) {
    if (!f.requested || !f.final || f.status === undefined || !f.content_type) problems.push(`${f.candidate}: 요청·최종·상태·형식 중 빠진 것이 있음`);
  }
  ok('S8-probe-restraint', problems.length === 0,
    problems.length ? problems.join(', ') : `요청 ${probe.requests}건 · 도메인 간격 ${probe.pacing.domain_gap_ms}ms · 총 ${probe.total_ms}ms · probe 3건 모두 요청·최종·상태·형식 기록`);
}

// ── 6. 결정 문서가 필요한 것을 다 적었는가 ────────────────────

{
  const need = [
    ['미완료 결정', /직접\s*`?search`?\s*버튼은 미완료/],
    ['add_urls 경로 유지', /add_urls/],
    ['식별 UA', /WebSearchMCP-Spike\/2\.0/],
    ['Chrome UA 비채택', /예비 조회였고 \*\*어떤 판정 근거로도 쓰지 않았다/],
    ['50쿼리 생략 사유', /50개 검색어 corpus 는 돌리지 않았다/],
    ['제품 기능 부재 한계', /제품 기능으로 아직 없다/],
    ['#36~#38 착수 불가', /#36`·`#37`·`#38` 은 착수할 수 없다/],
    ['스크래핑 미표시', /불안정한 스크래핑을 정상 기능으로 표시하지 않는다/],
  ];
  const missing = need.filter(([, re]) => !re.test(decision)).map(([n]) => n);
  ok('S9-decision-statements', missing.length === 0,
    missing.length ? `빠진 문장: ${missing.join(', ')}` : `필수 문구 ${need.length}개 모두 있음`);

  // 결정 문서가 건 링크가 실제 파일이어야 한다
  const links = [...decision.matchAll(/\]\((?!https?:)([^)]+)\)/g)].map((m) => m[1]);
  const dead = links.filter((l) => !fs.existsSync(path.join(HERE, l)));
  ok('S10-decision-links', dead.length === 0,
    dead.length ? `끊긴 링크: ${dead.join(', ')}` : `문서가 건 지역 링크 ${links.length}개 모두 실재`);

  // 아홉 곳이 모두 문서에 등장해야 한다. 이름 표기는 문서마다 다를 수 있으니
  // 흔들리지 않는 열쇠인 endpoint 호스트로 대조한다.
  const absent = cand.candidates.filter((c) => {
    const host = new URL(c.endpoint.replace('{query}', 'x').replace('{url}', 'x')).hostname;
    return !decision.includes(host) && !decision.includes(c.id);
  });
  ok('S11-decision-covers-all', absent.length === 0,
    absent.length ? `문서에 없는 후보: ${absent.map((c) => c.id).join(', ')}` : `후보 ${cand.candidates.length}곳이 endpoint 호스트로 모두 문서에 있음`);
}

// ── 7. frozen 기준선이 그대로인가 ─────────────────────────────

{
  const baselinePath = path.join(TOOL_ROOT, 'tests/baseline/baseline.json');
  const saved = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
  const legacyRoot = path.join(TOOL_ROOT, 'LEGACY');
  const byteOrder = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));
  const walk = (root) => {
    const out = [];
    const stack = [root];
    while (stack.length) {
      const dir = stack.pop();
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) stack.push(abs); else out.push(path.relative(root, abs));
      }
    }
    return out.sort(byteOrder);
  };
  const rels = walk(legacyRoot);
  let lines = '';
  for (const rel of rels) lines += `${sha256(path.join(legacyRoot, rel))}  ${rel}\n`;
  const agg = createHash('sha256').update(lines, 'utf8').digest('hex');
  const want = saved.measured.frozen.legacy;
  ok('S12-frozen-legacy', rels.length === want.file_count && agg === want.aggregate_sha256,
    `LEGACY ${rels.length}/${want.file_count} · 집계 ${agg === want.aggregate_sha256 ? '일치' : `불일치 ${agg.slice(0, 12)}`}`);
}

// ── 8. 네트워크 0회 ───────────────────────────────────────────

ok('S13-no-network-calls', networkAttempts === 0,
  `검증 중 네트워크 호출 시도 ${networkAttempts}회 (fetch 를 던지도록 바꿔 두고 셌다)`);

// ── 출력 ──────────────────────────────────────────────────────

for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.id} — ${r.detail}`);
const failed = results.filter((r) => !r.pass);
console.log(`후보 ${cand.candidates.length}곳 · 살아남은 후보 ${cand.summary.survivors.length} · 결정: direct search 미완료`);
console.log(failed.length === 0 ? 'PASS  보존 증거와 결정이 앞뒤가 맞는다' : `FAIL  ${failed.length}건`);
process.exit(failed.length === 0 ? 0 : 1);
