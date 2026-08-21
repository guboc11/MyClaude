# reminder-mcp — 설계

> 2026-07-29 대화에서 확정. 구현 전 설계 문서.

## 한 줄 정의

특정 세션에 리마인드를 등록해두면, 그 세션의 매 사용자 메시지마다
UserPromptSubmit 훅이 그 문구를 컨텍스트에 주입한다.

## 배경 (왜 이 구조인가)

- 훅 등록은 프로젝트 단위라 "이 세션에만 훅"은 불가능하다.
  대신 훅은 모든 세션에서 돌되, 자기 세션에 켜진 리마인드가 없으면 침묵한다.
  출력이 없으면 컨텍스트에 아무것도 안 들어간다 = 꺼진 세션은 영향 없음.
- 세션 구분 근거 (실측 완료):
  - MCP 서버는 `CLAUDE_CODE_SESSION_ID` 환경변수로 자기 세션 id를 안다.
    이 값이 transcript 파일명과 일치함을 확인했다.
  - 훅은 stdin JSON으로 `session_id`를 받는다 (Claude Code 바이너리 내장 훅 문서에서 확인).
  - 남은 확인 1건: 위 두 값이 같은 값인지 구현 후 실측 대조. (같은 세션 id 체계라 사실상 확실)
- 에이전트는 세션 id를 넘기지 않는다. 서버가 채운다.
  손으로 넘기면 남의 세션에 꽂는 실수가 가능해지고, 서버가 채우면 그 실수가 불가능하다.

## 부품 2개

| 파일 | 역할 |
|---|---|
| `.claude/tools/reminder-mcp/server.mjs` | MCP 서버. 리마인드를 넣고 빼는 손잡이 |
| `.claude/tools/reminder-mcp/hook.mjs` | 훅 스크립트. 매 턴 자기 세션 것만 출력 |

## 도구 6개

| 도구 | 인자 | 하는 일 |
|---|---|---|
| `reminder_on` | `label` \| `text` \| `file` \| `group` 중 정확히 1개 | 이 세션에 점등 |
| `reminder_off` | `name?` | 소등. 생략하면 켜진 목록만 보여줌 |
| `reminder_set` | `label` + (`text` \| `file`), `remove?` | 프리셋 등록·수정·삭제 (프로젝트 공용) |
| `reminder_group` | `name` + (`add?` \| `remove?` \| `delete?`) | 그룹 생성·편집·삭제 (프로젝트 공용) |
| `reminder_always` | `label` \| `text` \| `file` \| `group` \| `off?` | **모든 세션에** 영구 점등·소등 |
| `reminder_list` | `all?` | 영구 + 이 세션 + 프리셋 + 그룹 목록 |

### label / text / file / group 구분

인자 이름 자체가 구분이다. 넷 중 정확히 하나만 받는다.
0개 또는 2개 이상이면 에러로 튕기고, 에러 문구에 네 형태의 예시를 그대로 보여준다.

```
reminder_on{label: "lint"}                               → 프리셋 켜기
reminder_on{text: "빌드 전에 lint 먼저"}                  → 즉석 문구 켜기
reminder_on{file: "_CRAFT_GUIDE/DB_MIGRATIONS.md"}   → 파일 참조 켜기
reminder_on{group: "coding"}                             → 그룹 통째로 켜기
```

- `label`: 등록에 없으면 켜지 않고, 있는 프리셋 목록을 에러에 붙여 돌려준다.
- `file`: 매 턴 훅이 그 파일을 새로 읽는다. 파일을 고치면 다음 턴부터 반영.
- `text`: 준 문구 그대로.
- `group`: 그룹에 든 프리셋들을 한꺼번에 켠다 (아래 절).

## 이름 규칙

프리셋·그룹 이름은 **영문 소문자 + 숫자 + 하이픈**만 쓴다 (`codegraph`, `db-rules`, `coding`).
파일명이자 도구 인자이자 `[REMINDER:이름]` 표시에 그대로 쓰이므로, 경로·인코딩 문제가
생길 여지를 처음부터 없앤다. 규칙에 어긋나면 저장하지 않고 튕긴다.

## 저장 (한 장 = 한 파일)

```
.claude/mcp-reminders/
  labels/{label}.md                    프리셋. 내용이 곧 문구, 파일 참조는 "@경로" 한 줄
  groups/{group}.md                    그룹. 프리셋 이름을 줄마다 하나씩
  always/{name}.md                     영구 점등. 세션을 가리지 않고 항상 나감
  sessions/{session_id}/{name}.md      점등 상태. 켜기=생성, 끄기=삭제
```

세션 파일 내용 규칙:

| 켠 방식 | 저장 내용 |
|---|---|
| `text` | 문구 그대로 |
| `file` | `@경로` 한 줄 |
| `label` | `@label:이름` 한 줄 (프리셋을 나중에 고치면 다음 턴부터 반영) |
| `group` | 저장 안 됨 — 켜는 순간 프리셋별 `@label:이름` 파일 여러 장으로 펼쳐진다 |

## 그룹 (2026-07-29 추가)

여러 프리셋을 한 번에 켜기 위한 **메타데이터**다. 프리셋 이름의 목록일 뿐,
그 자체가 주입되는 내용은 갖지 않는다.

`groups/coding.md`:

```
codegraph
lint
db-rules
```

### 핵심: 훅은 그룹을 모른다

`reminder_on{group}` 은 그룹 파일을 읽어 **프리셋 수만큼 세션 파일을 만든다.**
각 파일 내용은 `@label:codegraph` 로, 개별로 켠 것과 완전히 같다.
그래서 `hook.mjs` 는 한 줄도 바뀌지 않는다. 그룹이라는 개념은 서버에서 끝난다.

```
reminder_on{group:"coding"}
  → sessions/{sid}/codegraph.md   "@label:codegraph"
  → sessions/{sid}/lint.md        "@label:lint"
  → sessions/{sid}/db-rules.md    "@label:db-rules"

켰습니다 — coding (3개)
  codegraph, lint, db-rules
```

### reminder_group(name, add?, remove?, delete?)

| 인자 | 하는 일 |
|---|---|
| `name` 만 | 그 그룹 내용 보기. 없으면 있는 그룹 목록을 붙여 에러 |
| `add` | 프리셋 추가. 그룹이 없으면 그때 만든다. 문자열 또는 배열 |
| `remove` | 프리셋 빼기. 문자열 또는 배열 |
| `delete: true` | 그룹 삭제. 켜둔 세션의 점등 파일은 건드리지 않는다 |

`add`·`remove` 를 동시에 주면 튕긴다. 한 번에 한 가지만 한다.

### 검사 두 가지

**`add` 할 때 그 프리셋이 실제로 있는지 본다.** 없으면 있는 프리셋 목록을 붙여 튕긴다.
오타로 죽은 이름이 그룹에 들어가 앉는 것을 막는다.

**`on{group}` 할 때 사라진 프리셋이 있으면 있는 것만 켜고 응답에 알린다.**
전부 실패시키지 않는 이유는 나머지가 멀쩡하기 때문이다. 앵커 실패와 달리
부분 성공이 손상을 남기지 않는다.

```
켰습니다 — coding (2개)
  codegraph, lint
  건너뜀: db-rules (프리셋이 없습니다)
```

### 안 만드는 것

**그룹 통째로 끄기.** 켜는 순간 개별 파일로 펼쳐지므로 "이것이 그 그룹이었다"는 흔적이
남지 않는다. 흔적을 남기려면 파일명이나 내용에 출처를 적어야 하는데, 그러면 개별로 켠
것과 형태가 달라져 훅까지 영향이 간다. **훅을 안 건드린다**는 이 설계의 이점이
그룹 소등 편의보다 크다고 판단했다. 끄는 것은 `reminder_off` 로 하나씩.

한 장 = 한 파일인 이유: 서로 다른 프로세스(다른 MCP·다른 세션)가 한 JSON을
같이 고치면 동시 쓰기로 항목이 소리 없이 사라지거나 반쯤 쓰인 파일이 남는다.
파일 단위로 나누면 만든 쪽만 건드리고 훅은 읽기만 하므로 충돌 자체가 없다.

## 훅 동작

1. stdin JSON에서 `session_id`를 읽는다. 없으면 침묵 종료.
2. 프로젝트 루트는 스크립트 자기 위치에서 역산한다 (cwd 비의존).
3. `sessions/{session_id}/*.md`를 정렬 순서로 읽어 참조를 풀고 출력한다:
   `[REMINDER:{name}] {내용}`
4. 켜진 게 없으면 출력 없음 = 그 세션은 영향 없음.

참조 해석 (`resolveBody`):
- `@label:이름` → `labels/이름.md`를 읽어 한 번 더 푼다 (프리셋이 `@파일`이면 그것까지).
- `@경로` → 루트 기준 상대경로 파일을 매 턴 새로 읽는다.
- 그 외 → 문구 그대로.
- 루프 차단: 프리셋 안에서 다시 `@label:`이 나오면 따라가지 않고 끊는다.

실패 방침:
- 참조가 깨지면 침묵하는 대신 `(참조 파일을 찾을 수 없음: 경로)`를 주입한다.
  켜져 있다고 믿는데 안 나가는 상태가 침묵보다 위험하다.
- 어떤 경우에도 exit 0. 리마인드가 깨져도 사용자 메시지를 막으면 안 된다.
  에러는 stderr로만 (stderr는 주입되지 않는다).

훅 스크립트 전문 초안은 설계 대화에서 확정했다 — 구현 시 그대로 옮긴다.

## 등록 3곳

1. `.mcp.json` — stdio 서버 추가 (notepad와 같은 패턴):
   `"reminder": { "type": "stdio", "command": "node", "args": [".claude/tools/reminder-mcp/server.mjs"] }`
2. `.claude/settings.json` — UserPromptSubmit의 기존 codegraph echo 옆에 추가:
   `{ "type": "command", "command": "node .claude/tools/reminder-mcp/hook.mjs" }`
3. `.gitignore` — `.claude/mcp-reminders/sessions/`만 제외한다. 프리셋·그룹은 팀 공유 자료로 추적한다.

## 다른 MCP 와의 연결 (2026-07-29 결정)

- 코드·저장소를 공유하지 않는다. import도 하지 않는다. 서버끼리는 서로를 부를 수 없다.
- 그쪽 도구 응답 문구에 "이제 `reminder_on{label:"…"}`을 부르세요"를 적어,
  에이전트가 읽고 이어 부른다. 연결 규칙은 코드가 아니라 도구 응답 문구에 산다.
- 이 연결은 구조가 아니라 에이전트 행동에 의존한다. 호출이 대화에 다 보이므로
  빼먹으면 바로 드러난다는 것이 안전장치다.

## 영구 리마인드 (2026-07-29 추가)

`always/` 폴더에 놓인 것은 **세션을 가리지 않고 모든 세션에** 나간다.
훅이 세션 폴더보다 먼저 이 폴더를 읽고, `session_id` 를 못 얻어도 이쪽은 출력한다.

이것은 이 도구의 격리 원칙("켜지 않은 세션은 조용") **밖**에 있다.
그래서 두 가지 안전장치를 둔다:

- **도구를 분리한다.** `reminder_on{always:true}` 같은 인자 하나 차이로 갈리면
  실수로 팀 전체에 켜질 수 있다. `reminder_always` 라는 별도 이름을 거치게 한다.
- **`reminder_list` 맨 위에 항상 보여준다.** 켜둔 채 잊는 것이 이 기능의 주된 위험이다.

같은 이름이 `always/` 와 세션 폴더 양쪽에 있으면 한 번만 낸다(`always` 가 먼저라 이긴다).

## v1에서 뺀 것

- 만료 조건(몇 턴 뒤, 언제까지). 필요해지면 세션 파일 머리에 조건 한 줄을 얹는 식으로 확장.
- 전역(홈) 스코프. 프로젝트 스코프만. 필요가 생기면 확장.

## 구현 순서 (제안)

1. `hook.mjs` 작성 → 임시로 stdin 덤프를 남겨 `session_id` == `CLAUDE_CODE_SESSION_ID` 실측 대조
2. `server.mjs` 작성 (onboarding/task/notepad 골격 재사용, 무의존성 단일 파일)
3. 등록 3곳 반영 → reconnect
4. 실사용 검증: reminder_on(text) → 다음 턴 주입 확인 → reminder_off → 침묵 확인
