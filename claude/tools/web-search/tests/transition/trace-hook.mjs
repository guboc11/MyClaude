// 모듈 해석 훅 — 서버가 **실제로 불러온** 파일을 한 줄씩 적는다.
//
// lsof 로는 안 된다. Node 는 모듈을 읽고 바로 닫아서, 실행 중에 열려 있는 .mjs 가 하나도 없다.
// "옛 구현을 안 부른다" 를 실행 중에 확인하려면 부르는 순간을 잡아야 한다.

import fs from 'node:fs';

let out = null;

export function initialize(data) {
  out = data?.out ?? null;
}

export async function resolve(specifier, context, next) {
  const result = await next(specifier, context);
  if (out && typeof result.url === 'string' && result.url.startsWith('file:')) {
    try { fs.appendFileSync(out, `${result.url}\n`); } catch { /* 적는 데 실패해도 서버를 세우지 않는다 */ }
  }
  return result;
}
