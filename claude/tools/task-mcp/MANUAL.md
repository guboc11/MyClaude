# task-mcp — 매뉴얼

## 이름

**task-mcp** — 파일 기반 태스크 관리. 태스크 1개 = JSON 파일 1개, 그룹 1개 = 폴더 1개.
그 위에 **캠페인** 한 층이 있어 여러 그룹과 여러 계획서·조사를 하나의 큰 일로 묶는다.

## 저장 자리

```
.claude/tasks/{날짜-주제}/                     캠페인에 안 속한 그룹
└── task-{번호}-{status}-[태그]-{제목}.json

.claude/campaigns/{주제}/                      캠페인 (날짜 접두 없음)
├── main-context/
│   ├── README.md      이 일이 무엇이고 무엇은 안 하는지        [사람이 관리]
│   ├── INDEX.md       문서 차례                                [도구가 관리]
│   ├── NOTES.md       던져두는 자리, 시간순                    [도구가 이어붙임]
│   └── {주제}.md      규칙·도메인 지식·조사 정리               [도구가 만들고 본문은 사람]
├── plans.md           _PLAN 계획서 경로들
├── researches.md      _RESEARCH 조사 경로들
└── {날짜-주제}/       캠페인 소속 그룹 — 형식은 위와 같다
```

프로젝트 경로는 `CLAUDE_PROJECT_DIR`, 없으면 현재 폴더.
상태가 바뀌면 파일 이름도 함께 바뀐다(`task-2-pending….json` → `task-2-in_progress….json`).
완료 항목은 지우지 않고 쌓는다.

## 언제 캠페인을 만드나

여러 태스크 그룹과 여러 계획서·조사가 딸리는 일일 때. 단발이면 그냥 그룹(`task_add`)으로 충분하다.
그룹 안에서는 태스크 설명 한 줄이면 맥락이 서지만, 몇 달을 가는 일은 왜 이렇게 하기로 했는지가
대화에만 남고 다음 세션으로 넘어가지 않는다. 캠페인은 그 맥락을 담는 자리다.

## 두 걸음 사용법

1. `campaign_list` 로 무슨 캠페인이 도는지 보고 이름을 고른다
2. `campaign_read` 로 그 캠페인을 펼친다 — **새 세션은 이것 하나만 읽고 일을 이어갈 수 있어야 한다**

태스크부터 집었다면 `task_list`·`task_get` 출력 맨 위의 "이 그룹은 캠페인 …소속" 한 줄이
맥락으로 가는 길을 알려준다. 캠페인에 안 속한 그룹에는 그 줄이 붙지 않는다.

## 도구

### 태스크

| 도구 | 하는 일 |
|---|---|
| `task_add(group, content, tag?, description?, activeForm?, campaign?)` | 태스크 1개 추가. 그룹이 없으면 만든다. `campaign`을 주면 그 캠페인 아래에 만든다 |
| `task_update(group_id, number, status?/tag?/content?/description?/activeForm?)` | 하나 이상 바꾼다. status·tag·content가 바뀌면 파일 이름도 바뀐다 |
| `task_get(group_id, number)` | 긴 설명까지 전부 조회 |
| `task_list(group_id?, all?)` | 기본은 자기 패널(owner) 것만. `all:true`면 다른 패널 것까지 |

- `group`은 넓게 잡는다(그 폴더에 여러 태스크가 쌓인다). 세부는 `tag`·`content`·`description`에.
- `group_id`는 언제나 **폴더 이름 하나**다. 캠페인 아래에 있어도 경로가 아니라 이름으로 부른다.
- 같은 그룹 이름이 두 자리에 생기려 하면 **만들 때 거부한다.** 한 이름이 두 자리에 살면 목록에서
  한쪽이 조용히 가려지기 때문이다. 오류문이 어느 자리에 이미 있는지 알려주니 다른 주제로 바꾼다.
- `owner`는 만든 패널(`CMUX_SURFACE_ID`)로 자동 기록된다 — 패널끼리 섞이지 않게 하는 장치다.

### 캠페인

| 도구 | 하는 일 |
|---|---|
| `campaign_add(name, about)` | 캠페인을 만든다. `about`이 README 머리말이 된다 |
| `campaign_read(name, full?)` | 펼친다. 기본은 머리말 + 차례 + 계획서·조사 건수 + 진행 중인 그룹. `full:true`면 계획서·조사 목록 전문과 끝난 그룹까지 |
| `campaign_note(name, text, doc?)` | 맥락에 이어붙인다. `doc` 없으면 `NOTES.md`, 주면 그 주제 문서(없으면 만들고 차례에 등재) |
| `campaign_plan(name, path, summary?)` | `_PLAN` 계획서 경로를 매단다 |
| `campaign_research(name, path, summary?)` | `_RESEARCH` 조사 경로를 매단다 |
| `campaign_list()` | 캠페인 목록 — 상태 · 그룹 수 · 남은 태스크 수 |

## 지켜야 할 것

**도구는 만들기와 이어붙이기까지만 한다.** 다듬기·옮기기·지우기는 사람이 한다.
무엇이 한 주제인지는 판단이라 도구가 알아서 하면 안 된다.

- `NOTES.md`는 임시로 쌓는 자리다. 대화 중 "이거 중요하다" 싶은 것을 일단 던져두고,
  한 주제로 뭉치면 그때 사람이 시켜서 주제 문서로 옮긴다. 그래서 차례에 올리지 않고,
  차례 정합 검사에서도 빠진다(경보가 소음이 되면 진짜 어긋남을 놓친다).
- **계획서·조사 원본은 `_PLAN`·`_RESEARCH`에 두고 여기엔 경로만 적는다.** 사본은 반드시 원본과 어긋난다.
- `README.md`는 사람이 관리한다. 도구는 만들 때 말고는 건드리지 않는다.
  **캠페인이 끝나면 README 머리말의 `상태:` 줄을 고쳐 적는다** — 폴더 이름에는 상태를 넣지 않는다.
  이름이 바뀌면 그 이름으로 적어둔 참조가 전부 어긋나기 때문이다.
- 차례(`INDEX.md`)는 도구가 채운다. 손으로 문서를 만들면 `campaign_read`가 어긋남을 알리되
  **자동으로 고치지는 않는다.** 빠진 게 실수인지 일부러인지 도구는 알 수 없다.
- 맥락 파일은 여러 패널이 동시에 쓴다. 그래서 이어붙이기만 하고 고쳐쓰기를 하지 않는다.

## 이 도구가 안 보이는 환경

MCP 등록이 없는 환경에서는 `node .claude/tools/mcp-call.mjs task <도구> 'JSON'` 으로 부른다.
사용법은 `.claude/tools/mcp-call.MANUAL.md`.

## 설계

`_PLAN/2026-08-01-task-mcp-campaign-layer/PLAN.md` (캠페인 층).
