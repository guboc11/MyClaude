#!/usr/bin/env node
// md-convert MCP — md 원본 → 인쇄용 pdf. stdio JSON-RPC (newline-delimited).
// 변환 본체는 convert.mjs 의 convertFiles 를 그대로 재사용한다 (변환 로직 중복 구현 금지).
// 골격: manage-env server.mjs 와 동일. 계획: _PLAN/2026-08-01-md-convert-mcp/PLAN.md
import { convertFiles } from './convert.mjs';

const log = (...a) => console.error('[md-convert]', ...a);

function toolConvertPdf({ files, topic, landscape }) {
  // 의존성 부재 시 convertFiles 가 설치 명령 한 줄을 담아 throw → 아래 tools/call 이 그대로 반환
  const { outDir, results } = convertFiles({ files, topic, landscape: !!landscape });
  return [
    `폴더: ${outDir}`,
    ...results.map((r) => `생성: ${r.pdf} (${(r.bytes / 1024).toFixed(1)} KB)`),
    `완료 — ${results.length}개 (원본 md는 그대로, pdf는 git 추적 제외 폴더)`,
  ].join('\n');
}

const TOOLS = [
  {
    name: 'convert_pdf',
    description:
      'md 파일들을 인쇄용 pdf로 변환한다. 원본 md는 그대로 두고 .claude/md-convert/{오늘}-{topic}/ 폴더를 만들어 파생 pdf를 쓴다. 칼럼 많은 표 문서는 landscape를 켠다. (후속 형식은 convert_html 등으로 추가 예정)',
    inputSchema: {
      type: 'object',
      properties: {
        files: {
          type: 'array', items: { type: 'string' }, minItems: 1,
          description: '변환할 md 파일 경로 목록 (레포 루트 기준 상대경로 또는 절대경로)',
        },
        topic: {
          type: 'string',
          description: '산출 폴더의 주제부 — .claude/md-convert/{오늘}-{topic}/ (kebab-case 권장)',
        },
        landscape: {
          type: 'boolean',
          description: 'A4 가로 방향으로 인쇄 (기본 false). 칼럼 많은 표 문서용',
        },
      },
      required: ['files', 'topic'],
    },
    run: toolConvertPdf,
  },
];

function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    return {
      protocolVersion: params?.protocolVersion || '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'md-convert', version: '0.1.0' },
    };
  }
  if (method === 'tools/list') {
    return { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) };
  }
  if (method === 'tools/call') {
    const tool = TOOLS.find((t) => t.name === params?.name);
    if (!tool) return { content: [{ type: 'text', text: `없는 도구: ${params?.name}` }], isError: true };
    try {
      return { content: [{ type: 'text', text: tool.run(params?.arguments || {}) }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `오류: ${e.message}` }], isError: true };
    }
  }
  if (id === undefined) return undefined; // 알림(notifications/*)은 무응답
  return { _error: { code: -32601, message: `unknown method: ${method}` } };
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { log('parse fail:', line.slice(0, 120)); continue; }
    const result = handle(msg);
    if (msg.id === undefined || result === undefined) continue;
    const reply = result && result._error
      ? { jsonrpc: '2.0', id: msg.id, error: result._error }
      : { jsonrpc: '2.0', id: msg.id, result };
    process.stdout.write(JSON.stringify(reply) + '\n');
  }
});
process.stdin.on('end', () => process.exit(0));
log('ready');
