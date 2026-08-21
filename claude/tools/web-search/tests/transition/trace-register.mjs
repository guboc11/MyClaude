// 훅을 다는 자리. 서버를 `node --import <이 파일> server.mjs` 로 띄우면
// 그 프로세스가 불러오는 모듈이 WEBSEARCH_TRACE_OUT 파일에 쌓인다.
import { register } from 'node:module';

register('./trace-hook.mjs', import.meta.url, { data: { out: process.env.WEBSEARCH_TRACE_OUT ?? null } });
