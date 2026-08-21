#!/usr/bin/env node
// task-mcp — 무의존성 MCP stdio 서버 (프로젝트별 파일 기반 태스크)
//
// 저장: <project>/.claude/mcp-task/{YYYY-MM-DD}-{slug(group)}/task-{number}-{status}.json
//   - 태스크 1개 = JSON 파일 1개. status를 파일명·내용 양쪽에 기록(파일 트리로 한눈에 파악).
//   - 상태 변경 시 파일을 rename (task-2-pending.json -> task-2-in_progress.json).
//   - 완료 항목도 지우지 않고 누적.
// project 경로: CLAUDE_PROJECT_DIR > process.cwd()
// stdout에는 JSON-RPC만, 로그는 stderr로.

import { GROUP_STATUSES, STATUSES, projectDir } from './lib.mjs';
import {
  toolGroupAdd,
  toolGroupGet,
  toolGroupList,
  toolGroupUpdate,
} from './tools/group.mjs';
import {
  toolGroupNoteAdd,
  toolGroupNoteGet,
  toolGroupNoteList,
  toolGroupNoteUpdate,
} from './tools/note.mjs';
import {
  PLAN_SECTION_KEYS,
  toolGroupPlanAdd,
  toolGroupPlanGet,
  toolGroupPlanList,
  toolGroupPlanUpdate,
} from './tools/plan.mjs';
import {
  toolAdd,
  toolGet,
  toolList,
  toolNext,
  toolUpdate,
} from './tools/task.mjs';
import {
  toolCampaignAdd,
  toolCampaignList,
  toolCampaignNote,
  toolCampaignRead,
  toolCampaignResearch,
} from './tools/campaign.mjs';

const log = (...a) => process.stderr.write(`[task-mcp] ${a.join(' ')}\n`);

const PERSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string', description: '표시할 이름' },
    surface: { type: 'string', description: 'cmux surface 연락처' },
  },
  required: ['name', 'surface'],
};

const TOOLS = [
  {
    name: 'task_group_add',
    description: '태스크 그룹 폴더와 GROUP.json을 만든다. 이름의 날짜는 도구가 KST 기준으로 붙이며 worker를 생략하면 호출 패널, manager를 생략하면 null을 기록한다.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        topic: { type: 'string', description: '날짜를 빼고 넘기는 그룹 주제' },
        campaign: { type: 'string', description: '소속 캠페인 이름(선택)' },
        about: { type: 'string', description: '그룹이 하는 일 설명(선택)' },
        title: { type: 'string', description: '대시보드 표시 제목(선택)' },
        worker: PERSON_SCHEMA,
        manager: PERSON_SCHEMA,
      },
      required: ['topic'],
    },
  },
  {
    name: 'task_group_update',
    description: '그룹 제목·설명·상태·워커·매니저를 하나 이상 바꾼다. GROUP.json 없는 옛 그룹은 이 도구를 명시 호출했을 때만 GROUP.json을 만든다.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        group_id: { type: 'string', description: '그룹 폴더 이름' },
        title: { type: 'string', description: '대시보드 표시 제목(선택)' },
        about: { type: 'string', description: '그룹 설명(선택)' },
        status: { type: 'string', enum: GROUP_STATUSES, description: '그룹 상태(선택)' },
        worker: PERSON_SCHEMA,
        manager: PERSON_SCHEMA,
      },
      required: ['group_id'],
    },
  },
  {
    name: 'task_group_get',
    description: '그룹 정보와 태스크·노트·계획서 목록을 읽는다. GROUP.json 없는 옛 그룹도 파일을 만들지 않고 읽는다.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: { group_id: { type: 'string', description: '그룹 폴더 이름' } },
      required: ['group_id'],
    },
  },
  {
    name: 'task_group_list',
    description: '그룹을 워커·매니저·진행 상태·다음 태스크·노트·계획서와 함께 대시보드로 보여준다.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        campaign: { type: 'string', description: '특정 캠페인 소속 그룹만 볼 때(선택)' },
        all: { type: 'boolean', description: 'true면 완료 그룹까지 포함' },
      },
    },
  },
  {
    name: 'task_group_note_add',
    description: '그룹 notes/ 아래에 앞머리가 있는 노트 파일 한 장을 만들고 다음 번호를 돌려준다.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        group_id: { type: 'string', description: '태스크 그룹 폴더 이름' },
        title: { type: 'string', description: '노트 제목' },
        body: { type: 'string', description: '노트 본문' },
      },
      required: ['group_id', 'title', 'body'],
    },
  },
  {
    name: 'task_group_note_update',
    description: '그룹 노트의 제목이나 본문을 바꾼다. body는 기본 교체하며 append:true면 기존 본문 아래에 이어붙인다.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        group_id: { type: 'string', description: '태스크 그룹 폴더 이름' },
        number: { type: 'integer', description: '노트 번호' },
        title: { type: 'string', description: '새 제목(선택)' },
        body: { type: 'string', description: '교체하거나 이어붙일 본문(선택)' },
        append: { type: 'boolean', description: 'true면 body를 기존 본문 아래에 이어붙임' },
      },
      required: ['group_id', 'number'],
    },
  },
  {
    name: 'task_group_note_get',
    description: '그룹 노트 한 장의 앞머리와 본문 전문을 읽는다.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        group_id: { type: 'string', description: '태스크 그룹 폴더 이름' },
        number: { type: 'integer', description: '노트 번호' },
      },
      required: ['group_id', 'number'],
    },
  },
  {
    name: 'task_group_note_list',
    description: '그룹 노트의 번호·제목·작성자·생성/수정 시각을 보여준다. 옛 NOTES.md는 맨 위에 읽기 전용으로 표시한다.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        group_id: { type: 'string', description: '태스크 그룹 폴더 이름' },
      },
      required: ['group_id'],
    },
  },
  {
    name: 'task_group_plan_add',
    description: '그룹 plans/ 아래에 왜·스펙·합의·단계·검증·미결 여섯 고정 칸과 빈칸 표시가 있는 계획서를 만든다.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        group_id: { type: 'string', description: '태스크 그룹 폴더 이름' },
        title: { type: 'string', description: '계획서 제목' },
      },
      required: ['group_id', 'title'],
    },
  },
  {
    name: 'task_group_plan_update',
    description: '계획서의 여섯 고정 칸 중 section으로 지정한 한 칸만 교체하거나 그 칸 안에서 이어붙인다.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        group_id: { type: 'string', description: '태스크 그룹 폴더 이름' },
        number: { type: 'integer', description: '계획서 번호' },
        section: { type: 'string', enum: PLAN_SECTION_KEYS, description: '수정할 고정 칸' },
        body: { type: 'string', description: '지정한 칸에 넣을 본문' },
        append: { type: 'boolean', description: 'true면 지정한 칸의 기존 본문 아래에만 이어붙임' },
      },
      required: ['group_id', 'number', 'section', 'body'],
    },
  },
  {
    name: 'task_group_plan_get',
    description: '계획서 전문 뒤에 안 채운 칸의 개수와 이름을 붙여 보여준다.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        group_id: { type: 'string', description: '태스크 그룹 폴더 이름' },
        number: { type: 'integer', description: '계획서 번호' },
      },
      required: ['group_id', 'number'],
    },
  },
  {
    name: 'task_group_plan_list',
    description: '그룹 계획서의 번호·제목·안 채운 칸 수를 보여준다.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        group_id: { type: 'string', description: '태스크 그룹 폴더 이름' },
      },
      required: ['group_id'],
    },
  },
  {
    name: 'task_add',
    description: '기존 태스크 그룹에 새 태스크 1개를 파일로 추가한다. owner는 생성 패널, assignee 기본값은 그룹 worker.surface이며 옛 그룹은 호출 패널이다.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        group_id: { type: 'string', description: 'task_group_add가 돌려준 그룹 폴더 이름' },
        content: { type: 'string', description: '한 줄 제목(목록·파일명에 표시). 짧게.' },
        tag: { type: 'string', description: '분류 태그(선택, 짧게). 파일명·목록에 [태그]로 표시. 예: backend, ui, bug' },
        description: { type: 'string', description: '긴 상세 설명(선택). 목록엔 안 뜨고 task_get으로 조회. 길이 제한 없음.' },
        activeForm: { type: 'string', description: '진행 중 표시용 현재진행형 라벨(선택)' },
        instruction: { type: 'string', description: '태스크 수행 지시(선택)' },
        depends_on: { type: 'array', items: { type: 'integer' }, description: '먼저 완료되어야 할 태스크 번호들(선택)' },
        priority: { type: 'integer', description: '우선순위. 클수록 task_next가 먼저 선택(선택, 기본 0)' },
        assignee: { type: 'string', description: '할 사람의 surface 연락처(선택)' },
      },
      required: ['group_id', 'content'],
    },
  },
  {
    name: 'task_update',
    description: '기존 태스크의 상태·내용·지시·선행 태스크·우선순위·담당자를 하나 이상 바꾼다. status·tag·content가 바뀌면 파일명도 바꾼다.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        group_id: { type: 'string', description: 'task_add가 돌려준 그룹 폴더명(예: 2026-07-08-auth-flow)' },
        number: { type: 'integer', description: '태스크 번호' },
        status: { type: 'string', enum: STATUSES, description: '상태 변경(선택)' },
        tag: { type: 'string', description: '태그 갱신(선택)' },
        description: { type: 'string', description: '긴 상세 설명 갱신(선택)' },
        content: { type: 'string', description: '한 줄 제목 갱신(선택)' },
        activeForm: { type: 'string', description: '현재진행형 라벨 갱신(선택)' },
        instruction: { type: 'string', description: '태스크 수행 지시 갱신(선택)' },
        depends_on: { type: 'array', items: { type: 'integer' }, description: '선행 태스크 번호 배열 갱신(선택)' },
        priority: { type: 'integer', description: '우선순위 갱신(선택)' },
        assignee: { type: 'string', description: '할 사람의 surface 연락처 갱신(선택)' },
      },
      required: ['group_id', 'number'],
    },
  },
  {
    name: 'task_get',
    description: '태스크 1개의 전체 내용과 instruction·depends_on·priority·owner·assignee를 조회한다.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        group_id: { type: 'string', description: '그룹 폴더명' },
        number: { type: 'integer', description: '태스크 번호' },
      },
      required: ['group_id', 'number'],
    },
  },
  {
    name: 'task_list',
    description: '태스크 목록을 렌더한다. group_id를 주면 그 그룹 전체, 생략하면 내 assignee 것만, all:true면 모든 그룹의 전체를 보여준다.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        group_id: { type: 'string', description: '특정 그룹만 볼 때(선택)' },
        all: { type: 'boolean', description: 'true면 다른 패널 것 포함 전체. 기본 false=내 것만(패널 격리).' },
      },
    },
  },
  {
    name: 'task_next',
    description: '그룹의 다음 태스크를 집는다. 진행 중 태스크 우선, 그다음 선행 태스크가 완료된 pending 중 priority 내림차순·number 오름차순이며 선택 즉시 in_progress로 바꾼다.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        group_id: { type: 'string', description: '태스크 그룹 폴더 이름' },
      },
      required: ['group_id'],
    },
  },
  {
    name: 'campaign_add',
    description: '캠페인을 새 구조로 만든다. 이름 앞 날짜는 연속된 것을 모두 떼고 KST 오늘 날짜를 붙이며 campaign-context와 researches 예약 폴더를 준비한다.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        name: { type: 'string', description: '날짜를 빼고 넘기는 캠페인 주제' },
        about: { type: 'string', description: 'MAIN_CONTEXT 머리말이 될 설명 — 무엇을 왜 하는 일이고 무엇은 안 할지' },
      },
      required: ['name'],
    },
  },
  {
    name: 'campaign_read',
    description: '캠페인을 MAIN_CONTEXT, 주제 폴더 차례, 어긋남, 리서치 폴더, 태스크 그룹 순서로 펼친다. 옛 main-context와 plans.md·researches.md도 읽기 전용으로 보여준다.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        name: { type: 'string', description: '캠페인 이름' },
        full: { type: 'boolean', description: 'true면 옛 연결 목록과 끝난 그룹까지 전부. 기본 false.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'campaign_note',
    description: 'campaign-context 아래에 앞머리가 있는 노트 한 장을 만든다. topic이 있으면 그 주제 폴더를 만들고 INDEX.md에 폴더를 한 번만 등재하며, 없으면 notes/에 둔다.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        name: { type: 'string', description: '캠페인 이름' },
        title: { type: 'string', description: '노트 제목' },
        text: { type: 'string', description: '적을 내용' },
        topic: { type: 'string', description: '컨텍스트 주제 폴더 이름(선택). 없으면 notes/' },
      },
      required: ['name', 'title', 'text'],
    },
  },
  {
    name: 'campaign_research',
    description: '캠페인의 researches/ 아래에 KST 날짜가 붙은 리서치 폴더만 만들고 경로를 돌려준다. 안은 채우지 않는다.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        name: { type: 'string', description: '캠페인 이름' },
        topic: { type: 'string', description: '날짜를 빼고 넘기는 리서치 주제' },
      },
      required: ['name', 'topic'],
    },
  },
  {
    name: 'campaign_list',
    description: '캠페인 목록과 각각의 상태·그룹 수·남은 태스크 수. 여기서 이름을 고른 뒤 campaign_read로 펼치는 두 걸음이 사용법이다.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  },
];

const DISPATCH = {
  task_group_add: toolGroupAdd, task_group_update: toolGroupUpdate,
  task_group_get: toolGroupGet, task_group_list: toolGroupList,
  task_group_note_add: toolGroupNoteAdd, task_group_note_update: toolGroupNoteUpdate,
  task_group_note_get: toolGroupNoteGet, task_group_note_list: toolGroupNoteList,
  task_group_plan_add: toolGroupPlanAdd, task_group_plan_update: toolGroupPlanUpdate,
  task_group_plan_get: toolGroupPlanGet, task_group_plan_list: toolGroupPlanList,
  task_add: toolAdd, task_update: toolUpdate, task_get: toolGet, task_list: toolList,
  task_next: toolNext,
  campaign_add: toolCampaignAdd, campaign_read: toolCampaignRead, campaign_note: toolCampaignNote,
  campaign_research: toolCampaignResearch, campaign_list: toolCampaignList,
};

// ---- MCP stdio (JSON-RPC 2.0, newline-delimited) ----
function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }
function reply(id, result) { send({ jsonrpc: '2.0', id, result }); }
function replyErr(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }); }

function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    return reply(id, {
      protocolVersion: params?.protocolVersion || '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'task-mcp', version: '0.1.0' },
    });
  }
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return;
  if (method === 'ping') return reply(id, {});
  if (method === 'tools/list') return reply(id, { tools: TOOLS });
  if (method === 'tools/call') {
    const fn = DISPATCH[params?.name];
    if (!fn) return reply(id, { content: [{ type: 'text', text: `알 수 없는 도구: ${params?.name}` }], isError: true });
    try {
      const text = fn(params.arguments || {});
      return reply(id, { content: [{ type: 'text', text }] });
    } catch (e) {
      return reply(id, { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true });
    }
  }
  if (id != null) return replyErr(id, -32601, `Method not found: ${method}`);
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
    try { handle(msg); } catch (e) { log('handle error:', e.message); }
  }
});
process.stdin.on('end', () => process.exit(0));
log(`started. projectDir=${projectDir()} (CLAUDE_PROJECT_DIR=${process.env.CLAUDE_PROJECT_DIR || '<unset>'})`);
