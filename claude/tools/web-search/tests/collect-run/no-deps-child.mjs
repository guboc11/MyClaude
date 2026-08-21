#!/usr/bin/env node
// playwright 가 **정말로 없는** 자리에서 browser 모드를 시켜 본다.
//
//   node tests/collect-run/no-deps-child.mjs <fixture-base> <sandbox>
//
// 왜 자식 프로세스인가: resolvePlaywright 는 depsDir → CLAUDE_PROJECT_DIR → cwd → 도구 폴더 순으로
// 찾는다. 부모 시험이 가짜 depsDir 만 건네고 나머지를 그대로 두면, 환경에 CLAUDE_PROJECT_DIR 가
// 있는 자리에서는 playwright 가 **발견되어** 정작 재려던 "없을 때의 정직한 실패" 가 안 일어난다.
// (2026-08-12 게이트 3 독립 재검증에서 실제로 났다 — 환경에 따라 통과했다 깨졌다 했다.)
//
// 그래서 조건을 믿지 않고 만든다. 부모가 CLAUDE_PROJECT_DIR·WEBSEARCH_DEPS_DIR 를 지우고
// node_modules 가 없는 임시 폴더에서 이 파일을 띄운다.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createDb } from '../../lib/db.mjs';
import { FIXTURE_FLAG, parseFixtureAllow } from '../../lib/fixture-allow.mjs';
import { addUrls } from '../../lib/items.mjs';
import { nextBatch } from '../../lib/lease.mjs';
import { runCollect } from '../../lib/collect/index.mjs';
import { getAttempt } from '../../lib/attempts.mjs';
import { resolvePlaywright } from '../../lib/collect/browser.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const [BASE, SANDBOX] = process.argv.slice(2);
const NOW = 1_700_000_000_000;

// 이 자리에서 playwright 가 정말 안 잡히는지부터 확인한다. 잡히면 이 시험은 성립하지 않는다.
let reachable = null;
try { reachable = resolvePlaywright({}).from; } catch { reachable = null; }

const root = path.join(SANDBOX, 'nodeps-ws');
fs.mkdirSync(root, { recursive: true });
const db = createDb(root, path.join(root, 'workspace.db'), {
  workspaceId: '2026-08-12-nodeps', projectRoot: SANDBOX, briefPath: path.join(root, 'brief.md'), nowMs: NOW,
});
addUrls(db, [{ url: `${BASE}/static/normal`, line: 1 }], { source_kind: 'seed', source_value: 'manual', nowMs: NOW });
const lease = nextBatch(db, root, { workerId: 'nodeps', count: 1, leaseMinutes: 60, nowMs: NOW });

const port = Number(new URL(BASE).port);
const r = await runCollect(db, {
  root, leaseId: lease.lease_id, mode: 'browser', outputs: ['screenshot'],
  pacePath: path.join(root, 'pace.db'), paceOpts: { min_interval_ms: 1, jitter_ms: 0, retry_backoff_ms: 1 },
  fetchOptions: { fixtureAllow: parseFixtureAllow([`${FIXTURE_FLAG}=127.0.0.1:${port}`]) },
  nowMs: NOW,
});
const idx = fs.readFileSync(path.join(root, r.index_path), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const line = idx[0];

const attemptDir = path.join(root, 'artifacts', 'pages', String(line.item_id), line.attempt_id);
const files = fs.existsSync(attemptDir) ? fs.readdirSync(attemptDir).sort() : [];

process.stdout.write(`${JSON.stringify({
  playwright_reachable: reachable,
  cwd: process.cwd(),
  has_project_env: process.env.CLAUDE_PROJECT_DIR !== undefined,
  succeeded: r.succeeded,
  failed: r.failed,
  error: line.error,
  produced: line.produced,
  collector: getAttempt(db, line.attempt_id).collector,
  // 요약과 산출물을 갈라 센다. 실패한 실행에도 **요약은 남아야 하고**(#23), 산출물은 없어야 한다.
  files_in_attempt: files,
  artifact_files: files.filter((f) => f !== 'manifest.json'),
  artifact_rows: db.prepare('SELECT COUNT(*) AS n FROM artifacts WHERE attempt_id = ?').get(line.attempt_id).n,
  has_manifest: files.includes('manifest.json'),
}, null, 2)}\n`);
db.close();
void HERE;
