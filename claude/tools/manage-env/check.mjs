#!/usr/bin/env node
// manage-env check — 4원천 대조 순수 검증기. 아무 파일도 쓰지 않는다.
// 설계: .claude/plans/2026-07-30-manage-env-mcp/PLAN.md §7 2단계 / 파서·상수는 lib.mjs 공유(중복 금지)
//
// 불변 원칙: 값을 출력에 절대 찍지 않는다 — 키 이름·앱 이름·서비스 이름·파일 이름만.
//
// 대조 항목:
//   A. 코드 스키마 ↔ .env.example  (5앱. guide.yaml 의 example_exempt 키는 "example 에 없음" 방향 예외)
//   B. 필수 키의 값 존재            (sync 대상 3앱 × localhost/dev/prod, KEY@앱 → KEY 순서로 탐색)
//   C. 필수 키의 render.yaml 선언   (배포 서비스 8개 — landing 은 env 없음)
//   D. render.yaml dev/prod 정합    (같은 앱의 dev·prod 서비스 간 선언 목록·공개/시크릿 분류 일치)
//   F. guide.yaml ↔ render.yaml    (sensitive 분류 ↔ value:/sync:false, 선언 키의 guide 항목 존재)
//   E. 값 파일 고아 키              (어느 sync 대상 앱 .env.example 에도 없는 키)
//   G. dev↔prod 대칭성             (값 파일 키 집합 비교 — 한쪽에만 있으면 어긋남.
//                                    localhost 제외: 로컬만의 키·부재는 정당. parity_exempt 키는 예외)
//   B'. 배포 필수                   (guide.yaml deploy_required 키 — dev·prod 값 존재 + render.yaml 선언.
//                                    "부팅엔 선택, 서비스엔 필수"의 두 번째 층. 2026-07-30 카카오 REST 키 사고)
//
// 실행: 레포 루트에서  node ~/.claude/tools/manage-env/check.mjs

import { SYNC_APPS, ALL_APPS, ENVS, SERVICE_APP, assertRepoRoot, parseEnvFile, schema, parseGuide, parseRenderYaml, canonicalSort } from './lib.mjs';
import path from 'node:path';

const REPO = process.cwd();
try { assertRepoRoot(REPO); } catch (e) { console.error(`[manage-env] ${e.message}`); process.exit(1); }

export function runCheck() {
  const findings = [];
  const guide = parseGuide(REPO);

  // ── A. 스키마 ↔ example ──
  const exampleSets = {};
  for (const app of ALL_APPS) {
    const sch = schema(REPO, app);
    const ex = new Set([...parseEnvFile(path.join(REPO, 'apps', app, '.env.example')).keys()]);
    exampleSets[app] = ex;
    for (const k of sch.keys()) {
      if (ex.has(k)) continue;
      if (guide.get(k)?.example_exempt) continue; // 의도된 부재 (사유는 guide.yaml 에)
      findings.push(`A. [${app}] 스키마에 있으나 .env.example 에 없음: ${k}`);
    }
    for (const k of ex) if (!sch.has(k)) findings.push(`A. [${app}] .env.example 에 있으나 스키마에 없음: ${k}`);
  }

  // ── B. 필수 키의 값 존재 (sync 대상 3앱) ──
  for (const env of ENVS) {
    const ledger = parseEnvFile(path.join(REPO, '.claude/mcp-manage-env', `${env}.env`));
    for (const app of SYNC_APPS) {
      for (const [k, meta] of schema(REPO, app)) {
        if (!meta.required) continue;
        if (!ledger.has(`${k}@${app}`) && !ledger.has(k)) {
          findings.push(`B. [${env}/${app}] 필수 키의 값이 값 파일에 없음: ${k}`);
        }
      }
    }
  }

  // ── C·D. render.yaml ──
  const services = parseRenderYaml(REPO);
  for (const [svc, app] of Object.entries(SERVICE_APP)) {
    if (!app) continue;
    const declared = services.get(svc);
    if (!declared) { findings.push(`C. render.yaml 에 서비스가 없음: ${svc}`); continue; }
    for (const [k, meta] of schema(REPO, app)) {
      if (meta.required && !declared.has(k)) {
        findings.push(`C. [${svc}] 필수 키가 render.yaml 에 선언 안 됨: ${k}`);
      }
    }
  }
  for (const [devSvc, app] of Object.entries(SERVICE_APP)) {
    if (!devSvc.endsWith('-dev') || !app) continue;
    const prodSvc = devSvc.slice(0, -4);
    const d = services.get(devSvc);
    const p = services.get(prodSvc);
    if (!d || !p) continue;
    for (const k of new Set([...d.keys(), ...p.keys()])) {
      if (!d.has(k)) findings.push(`D. [${app}] ${k} — prod(${prodSvc})에만 선언, dev 에 없음`);
      else if (!p.has(k)) findings.push(`D. [${app}] ${k} — dev(${devSvc})에만 선언, prod 에 없음`);
      else if (d.get(k) !== p.get(k)) findings.push(`D. [${app}] ${k} — 분류 불일치: dev=${d.get(k)} / prod=${p.get(k)}`);
    }
  }

  // ── F. guide.yaml ↔ render.yaml ──
  if (guide.size > 0) {
    const fSeen = new Set();
    for (const [svc, declared] of services) {
      for (const [k, cls] of declared) {
        const g = guide.get(k);
        let msg = null;
        if (!g) msg = `F. ${k} — render.yaml(${svc})에 선언됐으나 guide.yaml 에 항목 없음`;
        else if (g.sensitive === 'true' && cls === 'value') msg = `F. ${k} — guide=시크릿인데 render.yaml(${svc})은 value: (파일에 값 노출)`;
        else if (g.sensitive === 'false' && cls === 'sync:false') msg = `F. ${k} — guide=공개인데 render.yaml(${svc})은 sync:false (대시보드 입력으로 남음)`;
        if (msg && !fSeen.has(msg)) { fSeen.add(msg); findings.push(msg); }
      }
    }
  }

  // ── E. 값 파일 고아 키 ──
  const known = new Set(SYNC_APPS.flatMap((a) => [...exampleSets[a]]));
  for (const env of ENVS) {
    for (const k of parseEnvFile(path.join(REPO, '.claude/mcp-manage-env', `${env}.env`)).keys()) {
      const base = k.split('@')[0];
      if (!known.has(base)) findings.push(`E. [${env}] 값 파일에 있으나 어느 앱 .env.example 에도 없는 키: ${k}`);
    }
  }

  // ── G. dev↔prod 대칭성 (원시 키 문자열 기준, KEY@앱 포함. localhost 제외) ──
  {
    const devKeys = new Set(parseEnvFile(path.join(REPO, '.claude/mcp-manage-env/dev.env')).keys());
    const prodKeys = new Set(parseEnvFile(path.join(REPO, '.claude/mcp-manage-env/prod.env')).keys());
    for (const k of new Set([...devKeys, ...prodKeys])) {
      if (guide.get(k.split('@')[0])?.parity_exempt) continue; // 의도된 비대칭 (사유는 guide.yaml 에)
      if (!devKeys.has(k)) findings.push(`G. ${k} — prod 에만 있음, dev 값 파일에 없음`);
      else if (!prodKeys.has(k)) findings.push(`G. ${k} — dev 에만 있음, prod 값 파일에 없음`);
    }
  }

  // ── H. 값 파일 순서 ↔ canonical(guide.yaml) — 눈 감사를 위한 순서 일관성 ──
  for (const env of ENVS) {
    const keys = [...parseEnvFile(path.join(REPO, '.claude/mcp-manage-env', `${env}.env`)).keys()];
    const sorted = canonicalSort(REPO, keys);
    if (keys.join('\n') !== sorted.join('\n')) {
      const idx = keys.findIndex((k, i) => k !== sorted[i]);
      findings.push(`H. [${env}] 값 파일 순서가 canonical(guide.yaml)과 다름 — 첫 어긋남: ${keys[idx]} (기대: ${sorted[idx]})`);
    }
  }

  // ── B'. 배포 필수 (guide.yaml deploy_required — 부팅 기준이 아닌 서비스 온전성 기준) ──
  for (const [key, g] of guide) {
    if (g.deploy_required !== 'true') continue;
    // (a) dev·prod 값 파일에 값 존재 (KEY 또는 KEY@* 아무거나)
    for (const env of ['dev', 'prod']) {
      const ledger = parseEnvFile(path.join(REPO, '.claude/mcp-manage-env', `${env}.env`));
      const has = [...ledger.keys()].some((k) => k === key || k.startsWith(`${key}@`));
      if (!has) findings.push(`B'. [${env}] 배포 필수 키 누락 (값 파일): ${key}`);
    }
    // (b) 이 키를 스키마에 가진 앱의 dev·prod Render 서비스에 선언 존재
    for (const [svc, app] of Object.entries(SERVICE_APP)) {
      if (!app) continue;
      if (!schema(REPO, app).has(key)) continue;
      const declared = services.get(svc);
      if (declared && !declared.has(key)) findings.push(`B'. [${svc}] 배포 필수 키 누락 (render.yaml 선언): ${key}`);
    }
  }
  return findings;
}

const findings = runCheck();
if (findings.length === 0) {
  console.log('어긋남 0건 — 4원천 정합.');
} else {
  console.log(`어긋남 ${findings.length}건:`);
  for (const f of findings) console.log('  ' + f);
}
process.exit(findings.length ? 1 : 0);
