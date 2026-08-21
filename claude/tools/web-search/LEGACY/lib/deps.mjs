// web-search — 실행 의존성 찾기
//
// playwright·jsdom 은 이 도구 폴더가 아니라 어느 프로젝트의 node_modules 에 있다.
// 그런데 "산출물을 어디에 쌓나"(CLAUDE_PROJECT_DIR)와 "라이브러리가 어디 있나"는 다른 문제다.
// 시험은 임시 폴더를 프로젝트로 삼으므로 그쪽에는 node_modules 가 없다.
// 그래서 후보를 순서대로 훑는다.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function candidates() {
  const out = [];
  if (process.env.WEBSEARCH_DEPS_DIR) out.push(process.env.WEBSEARCH_DEPS_DIR);
  if (process.env.CLAUDE_PROJECT_DIR) out.push(process.env.CLAUDE_PROJECT_DIR);
  out.push(process.cwd());
  out.push(HERE);                       // 도구 폴더 자체에 깔았을 경우
  return out;
}

const cache = new Map();

/** 후보 폴더들에서 모듈을 찾는다. 못 찾으면 어디를 봤는지 알려주는 오류를 던진다. */
export function requireDep(name) {
  if (cache.has(name)) return cache.get(name);
  const tried = [];
  for (const dir of candidates()) {
    const pkg = path.join(dir, 'package.json');
    if (!fs.existsSync(pkg)) { tried.push(`${dir}(package.json 없음)`); continue; }
    try {
      const mod = createRequire(pkg)(name);
      cache.set(name, mod);
      return mod;
    } catch (e) {
      tried.push(`${dir}(${e.code || 'fail'})`);
    }
  }
  throw new Error(`모듈을 찾지 못했습니다: ${name}\n찾아본 곳: ${tried.join(' / ')}\n`
    + `WEBSEARCH_DEPS_DIR 로 node_modules 가 있는 폴더를 지정하세요.`);
}
