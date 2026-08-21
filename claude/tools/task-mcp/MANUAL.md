# task-mcp — 매뉴얼

파일 기반으로 캠페인, 태스크 그룹, 태스크, 그룹 노트와 계획서를 관리하는 MCP 서버다.
태스크·노트·계획서는 한 건이 파일 한 장이고, 그룹은 `GROUP.json`을 가진 폴더 한 개다.

프로젝트 경로는 `CLAUDE_PROJECT_DIR`, 없으면 현재 폴더다. 실제 프로젝트 장부를 건드리지 않는
테스트에서는 `CLAUDE_PROJECT_DIR`을 임시 폴더로 지정한다.

## 호출 방법

정식 MCP 연결이 보이면 도구 이름으로 직접 호출한다. 코덱스처럼 레포의 `.mcp.json`이 연결되지
않는 환경에서는 레포 루트에서 `mcp-call`을 쓴다.

```sh
# 프로젝트 사본의 도구 목록
node .claude/tools/mcp-call.mjs .claude/tools/task-mcp/server.mjs --tools

# 프로젝트 사본 호출
node .claude/tools/mcp-call.mjs .claude/tools/task-mcp/server.mjs task_list '{"all":true}'

# 전역 사본 호출 — 프로젝트 사본을 개발하는 동안 장부를 안전하게 갱신할 때
node .claude/tools/mcp-call.mjs ~/.claude/tools/task-mcp/server.mjs task_get '{"group_id":"2026-08-16-topic","number":1}'
```

JSON 따옴표 처리가 어려운 셸에서는 인자를 파일에 쓰고 `@args.json`으로 넘긴다. 호출기 자체의
형식과 종료 코드는 `.claude/tools/mcp-call.MANUAL.md`를 따른다.

## 저장 구조

```text
.claude/campaigns/{YYYY-MM-DD}-{캠페인}/
├── campaign-context/
│   ├── MAIN_CONTEXT.md
│   ├── INDEX.md
│   ├── notes/
│   │   └── note-{N}-{제목}.md
│   └── {주제}/
│       └── note-{N}-{제목}.md
├── researches/
│   └── {YYYY-MM-DD}-{주제}/
└── {YYYY-MM-DD}-{그룹}/
    ├── GROUP.json
    ├── task-{N}-{status}-[태그]-{제목}.json
    ├── notes/
    │   └── note-{N}-{제목}.md
    └── plans/
        └── plan-{N}-{제목}.md

.claude/mcp-task/{YYYY-MM-DD}-{그룹}/
├── GROUP.json
├── task-{N}-{status}-[태그]-{제목}.json
├── notes/
└── plans/
```

캠페인에 속하지 않은 새 그룹은 `.claude/mcp-task`에, 캠페인 소속 그룹은 예전처럼 해당 캠페인
바로 아래에 산다. 어느 자리든 `group_id`는 경로가 아니라 날짜까지 포함한 폴더 이름 하나다.

옛 `.claude/tasks`는 읽기 호환 자리다. 읽기 도구는 새·옛 독립 그룹을 함께 보되 어떤 파일도
만들지 않는다. 옛 독립 그룹을 수정하면 `GROUP.json`, 태스크, `NOTES.md`, `notes/`, `plans/`와
그 밖의 파일을 그룹 단위로 `.claude/mcp-task`에 복사한 뒤 새 사본만 바꾼다. 옛 tree는 그대로
둔다. 같은 `group_id`가 두 실물 뿌리에 있으면 새 자리를 우선하고 임의로 합치지 않는다.

이 레포의 실물 이동 뒤에는 실행 중인 옛 서버도 같은 장부에 쓰도록 `.claude/tasks -> mcp-task`
상대 symlink를 유지한다. 아직 이동하지 않은 다른 레포에서는 옛 실물 그룹을 처음 수정할 때 위
승격 규칙이 실제로 동작한다. `.claude/campaigns`와 캠페인 아래 그룹 경로는 바뀌지 않는다.

### 이름 규칙

새 캠페인, 그룹, 리서치 폴더에는 도구가 KST 오늘 날짜 `YYYY-MM-DD-`를 붙인다. 호출자는 날짜를
뺀 주제만 넘긴다. 입력 앞에 날짜가 하나 이상 연속되어 있으면 전부 떼고 오늘 날짜를 붙이며,
응답 첫 줄에 뗀 날짜를 모두 알린다.

캠페인 바로 아래의 `campaign-context`, `main-context`, `researches`는 태스크 그룹이 아닌 예약
폴더다. 세 이름은 그룹 생성에 쓸 수 없고 `groupPath`, `listGroupIds`, `campaignGroupIds`에서 모두
제외된다.

`task_group_list`는 태스크 파일이나 `GROUP.json`이 있는 폴더만 그룹으로 표시한다. 이름을 미리
등록하지 않은 캠페인 자료 폴더도 두 알맹이가 모두 없으면 목록에 섞이지 않는다. 반대로
`task_group_add`로 만든 빈 그룹은 태스크가 0개여도 `GROUP.json`이 있으므로 계속 표시된다.

## 레코드 4종

### `GROUP.json`

```json
{
  "id": "2026-08-16-task-mcp-overhaul",
  "title": "task MCP 개편",
  "about": "그룹 설명",
  "status": "pending",
  "campaign": "2026-08-16-project-remodel",
  "worker": { "name": "WRKR3", "surface": "surface:90" },
  "manager": { "name": "MNGR3", "surface": "surface:87" },
  "created_at": "…",
  "updated_at": "…"
}
```

`status`는 `pending | in_progress | done`이다. 새 그룹은 `pending`이고 첫 `task_next`가 태스크를
집을 때 `in_progress`가 된다. `campaign`은 독립 그룹이면 `null`이다. `worker`를 생략하면 호출
패널, `manager`를 생략하면 `null`이다.

### 태스크 JSON

주요 칸은 `number`, `content`, `tag`, `description`, `activeForm`, `status`, `owner`, `assignee`,
`instruction`, `depends_on`, `priority`, `group_id`, `created_at`, `updated_at`이다.

- `owner`: 태스크를 만든 패널. 생성 이력이며 목록 필터로 쓰지 않는다.
- `assignee`: 태스크를 수행할 패널. 새 그룹에서는 기본값이 `worker.surface`, `GROUP.json`이 없는
  옛 그룹에서는 호출 패널이다.
- `depends_on`: 먼저 `completed`여야 하는 태스크 번호 배열.
- `priority`: 큰 값이 `task_next`에서 먼저 선택된다.
- `status`: `pending | in_progress | completed`. 바뀌면 JSON 내용과 파일 이름이 함께 바뀐다.

`task_list(group_id)`는 그 그룹 전부, 인자 없는 `task_list()`는 내 `assignee` 항목만 보여준다.
`task_list({all:true})`는 모든 그룹의 전체 태스크를 보여준다.

### 그룹 노트

`notes/note-{N}-{제목}.md` 한 장에 노트 한 건을 저장한다. 앞머리에는 `number`, `title`,
`author`, `created_at`, `updated_at`이 있다. 제목을 바꾸면 파일명과 앞머리가 함께 바뀐다.
본문 수정은 기본 교체이고 `append:true`일 때만 기존 본문 아래에 이어붙인다.

### 그룹 계획서

`plans/plan-{N}-{제목}.md` 한 장은 아래 여섯 칸을 고정 순서로 가진다.

| 칸 | `section` | 내용 |
|---|---|---|
| 왜 | `why` | 문제와 배경 |
| 스펙 | `spec` | 입출력과 계약 |
| 합의 | `agreement` | 정한 것과 하지 않을 것 |
| 단계 | `steps` | 구현 순서 |
| 검증 | `verification` | 게이트와 통과 조건 |
| 미결 | `open` | 아직 정하지 못한 것 |

새 계획서는 여섯 칸 모두 `<!-- 비어 있음 -->`으로 시작한다. `get`은 안 채운 칸의 개수와 이름을,
`list`는 계획서별 빈칸 수를 보여준다. 갱신은 `section`으로 지정한 한 칸만 허용한다. 문서 전체를
받는 인자가 없는 이유는 틀 밖 쓰기로 제목이나 빈칸 표시가 무너지면 누락된 스펙을 셀 수 없기
때문이다. `append:true`도 지정한 칸 안에서만 이어붙인다.

## 도구 22개

`?`는 선택 인자다. 아래 이름과 인자 순서는 `--tools` 출력과 같다.

### 그룹 4개

| 도구 | 역할 |
|---|---|
| `task_group_add(topic, campaign?, about?, title?, worker?, manager?)` | 폴더와 `GROUP.json`을 만들고 `group_id`를 돌려준다 |
| `task_group_update(group_id, title?, about?, status?, worker?, manager?)` | 그룹 칸 하나 이상을 바꾼다. `GROUP.json` 없는 그룹의 레코드 생성은 이 명시 호출에서만 한다 |
| `task_group_get(group_id)` | 그룹 정보와 태스크·노트·계획서 목록을 읽는다 |
| `task_group_list(campaign?, all?)` | 워커·매니저·상태·다음 태스크·문서 건수 대시보드를 보여준다 |

### 그룹 노트 4개

| 도구 | 역할 |
|---|---|
| `task_group_note_add(group_id, title, body)` | 다음 번호로 노트 한 장을 만든다 |
| `task_group_note_update(group_id, number, title?, body?, append?)` | 제목이나 본문을 바꾼다 |
| `task_group_note_get(group_id, number)` | 노트 전문을 읽는다 |
| `task_group_note_list(group_id)` | 번호·제목·작성자·시각 목록을 보여준다 |

### 그룹 계획서 4개

| 도구 | 역할 |
|---|---|
| `task_group_plan_add(group_id, title)` | 여섯 고정 칸이 있는 계획서를 만든다 |
| `task_group_plan_update(group_id, number, section, body, append?)` | 지정한 한 칸만 교체하거나 이어붙인다 |
| `task_group_plan_get(group_id, number)` | 전문과 안 채운 칸 목록을 읽는다 |
| `task_group_plan_list(group_id)` | 번호·제목·빈칸 수 목록을 보여준다 |

### 태스크 5개

| 도구 | 역할 |
|---|---|
| `task_add(group_id, content, tag?, description?, activeForm?, instruction?, depends_on?, priority?, assignee?)` | 기존 그룹에 태스크 한 건을 추가한다 |
| `task_update(group_id, number, status?, tag?, description?, content?, activeForm?, instruction?, depends_on?, priority?, assignee?)` | 태스크 칸 하나 이상을 바꾼다 |
| `task_get(group_id, number)` | 지시·선행·우선순위·생성자·담당자를 포함한 전문을 읽는다 |
| `task_list(group_id?, all?)` | 그룹 전체, 내 담당 태스크, 또는 전체 태스크를 조건에 따라 보여준다 |
| `task_next(group_id)` | 규칙에 따라 다음 태스크를 집고 즉시 진행 중으로 바꾼다 |

### 캠페인 5개

| 도구 | 역할 |
|---|---|
| `campaign_add(name, about?)` | 날짜가 붙은 캠페인과 새 저장 구조를 만든다 |
| `campaign_read(name, full?)` | 캠페인을 맥락·차례·리서치·그룹 순서로 펼친다 |
| `campaign_note(name, title, text, topic?)` | 호출마다 노트 한 장을 만든다. `topic`이 있으면 주제 폴더를 INDEX에 한 번 등재한다 |
| `campaign_research(name, topic)` | 날짜가 붙은 빈 리서치 폴더만 만들고 경로를 돌려준다 |
| `campaign_list()` | 상태·그룹 수·남은 태스크 수가 있는 캠페인 목록을 보여준다 |

## `task_next` 선택 순서

1. 그룹에 `in_progress` 태스크가 있으면 그것을 그대로 돌려준다.
2. 없으면 `pending` 중 `depends_on`이 모두 `completed`인 것만 남긴다.
3. `priority` 내림차순, 그다음 `number` 오름차순으로 첫 항목을 고른다.
4. 선택 즉시 파일 이름과 레코드 상태를 `in_progress`로 바꾸고, 필요하면 그룹 상태도 올린다.
5. `description`과 `instruction`을 포함한 태스크 전문을 돌려준다.

`assignee`는 이 선택에 쓰지 않는다. 그룹에는 워커가 하나라는 전제다. 남은 태스크가 없을 때와
선행 태스크가 끝나지 않아 전부 막혔을 때는 서로 다른 메시지를 내고, 막힌 경우 기다리는 번호를
표시한다.

두 프로세스가 같은 pending 파일을 골라도 파일 이름 변경에 먼저 성공한 한쪽만 상태를 쓴다.
늦은 쪽은 오류를 내지 않고 처음부터 다시 읽어 이미 `in_progress`가 된 같은 태스크를 돌려준다.
별도 잠금 파일은 만들지 않는다.

옛 독립 그룹에서 pending 태스크를 고를 때는 그룹 전체를 새 뿌리로 승격한 뒤 1단계부터 다시
읽는다. 이미 진행 중인 태스크를 돌려주거나 완료·선행 차단 메시지만 내는 호출은 승격하지 않는다.

## 캠페인 사용 흐름

1. `campaign_list`에서 이름과 상태를 본다.
2. `campaign_read`로 `MAIN_CONTEXT` 본문 → 주제 폴더 차례 → 차례와 실물 어긋남 → 리서치 폴더
   → 태스크 그룹 순서로 펼친다. 각 그룹에는 노트·계획서 건수가 붙는다.
3. 아직 어느 그룹에 둘지 모르는 글은 `campaign_note`의 `topic` 없이 `campaign-context/notes`에
   둔다. 주제가 정해졌으면 `topic`을 주어 그 주제 폴더에 새 노트를 만든다.
4. 조사가 필요하면 `campaign_research`로 자리만 만든 뒤, 개별 쓰기 도구로 내용을 채운다.

`MAIN_CONTEXT.md`는 사람이 관리한다. 캠페인이 끝나면 `상태:` 줄을 사람이 고친다. `INDEX.md`는
도구가 주제 폴더를 등재하며, 차례와 실물이 어긋나면 `campaign_read`가 알리되 자동 수정하지 않는다.

## 옛 자리 읽기

아래 옛 자리를 계속 읽되, 도구가 새로 쓰는 대상은 새 자리뿐이다.

| 옛 자리 | 새 자리 | 읽기 규칙 |
|---|---|---|
| `.claude/tasks/{그룹}` | `.claude/mcp-task/{그룹}` | 두 뿌리를 함께 읽고, 옛 그룹 수정 때 전체를 새 자리로 복사한 뒤 새 사본만 쓴다 |
| `main-context/` | `campaign-context/` | 두 자리의 차례와 맥락을 함께 읽는다 |
| `main-context/README.md` | `campaign-context/MAIN_CONTEXT.md` | 새 파일의 `상태:`를 먼저 보고, 파일이 없으면 옛 파일을 본다 |
| 평평한 `main-context/{주제}.md` | `campaign-context/{주제}/` | 옛 파일과 새 주제 폴더를 한 차례에 함께 센다 |
| 그룹의 `NOTES.md` | 그룹의 `notes/` | 옛 파일을 노트 목록 맨 위에 읽기 전용으로 표시한다 |
| 캠페인의 `plans.md`·`researches.md` | 그룹 문서와 `researches/` 폴더 | 옛 연결 줄은 보여주기만 하고 내용을 더 쌓지 않는다 |
| `GROUP.json`이 없는 그룹 | `GROUP.json`이 있는 그룹 | 폴더 이름으로 읽고, 명시적인 `task_group_update` 전에는 파일을 만들지 않는다 |

날짜가 없는 옛 캠페인 이름은 그대로 호출한다. 목록이나 전문을 읽었다는 이유로 옛 캠페인,
옛 그룹, 옛 문서를 승격하거나 고쳐 쓰지 않는다.

## 안전한 운영

- 없는 그룹에는 `task_add`가 실패한다. 먼저 `task_group_add`로 그룹을 만든다.
- 같은 `group_id`가 독립 자리와 캠페인 아래에 겹치면 새 그룹 생성을 거부한다.
- 전환용 `.claude/tasks` symlink는 옛 서버 프로세스가 모두 끝났다고 별도 확인하기 전에는 지우지 않는다.
- 실제 장부를 대상으로 호환성 검증할 때는 읽기 호출만 한다. 쓰기 테스트는 임시 프로젝트에서 한다.
- 상태 변경 뒤에도 완료 태스크를 삭제하지 않는다.
- 매뉴얼과 실제 입력 스키마가 어긋났는지는 `--tools` 출력으로 확인한다.

## 그룹은 사람이 닫는다

태스크를 다 완료해도 그룹 `status`는 저절로 안 바뀐다. 그룹을 `in_progress`로 올리는 자리는
`task_next` 하나뿐이고(`tools/task.mjs:213`), `done`으로 내리는 코드는 아예 없다.

- **끝나면 그 자리에서 닫는다.** 마지막 태스크를 완료한 뒤 `task_group_update(group_id, status: "done")`.
  라운드를 마감하는 매니저의 마지막 할 일이다.
- **중단도 `done`으로 닫는다.** 상태 값은 대기·진행 중·완료 세 가지뿐이라 「중단」이 따로 없다.
  대신 `about`에 왜 멈췄고 무엇이 남았는지 한 줄 적는다. **태스크는 손대지 않는다** —
  `5/16`이라는 숫자가 끝까지 안 갔다는 것을 증언한다.
- **되살리려면 `status`만 되돌린다.** 태스크 파일은 그대로 남아 있다.

닫지 않으면 `task_group_list`에 계속 남아서, 지금 누가 무엇을 하는지 알아보기 어려워진다.
2026-08-18에 11개를 손으로 닫았다 — 태스크를 다 끝내고도 안 닫힌 것 6개, 중간에 멈춘 것 5개.

설계의 단일 진실원천은 `.claude/plans/2026-08-16-task-mcp-overhaul/SPEC.md`다.
