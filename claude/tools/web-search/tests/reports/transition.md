# 전환 — 등록 진입점을 새 core 에 잇기

판정: **PASS** (10항목) · 실행: 2026-08-12 · Node v22.21.0
태스크: `2026-08-12-web-search-MCP-v2-rebuild#48` · 근거 계획: `_PLAN/2026-08-11-web-search-mcp/PLAN.md` 8단계

기계 판독 결과: [transition.json](transition.json) · 매뉴얼: [MANUAL.md](../../MANUAL.md)

```
node tests/transition/verify.mjs --project <프로젝트>
node tests/transition/verify.mjs --project <프로젝트> --json
```

## 항목별 판정

| 항목 | 내용 | 결과 |
|---|---|---|
| T1 | 등록 진입점이 새 core 를 부른다 | PASS |
| T2 | 계약은 열이고 낸 것은 아홉 | PASS |
| T3 | 안 만든 버튼을 부르면 갈 길을 알려 준다 | PASS |
| T4 | 새 프로젝트에서 `workspace_new`→`add_urls`→`status`→`export` 가 돈다 | PASS |
| T5 | 새 프로젝트의 `.gitignore` 규칙이 한 줄 생기고 git 이 실제로 무시한다 | PASS |
| T6 | 실행 중에 옛 구현을 안 불렀다 | PASS |
| T7 | 소스에도 옛 구현 import 0 | PASS |
| T8 | 매뉴얼이 버튼을 다 적고 없는 것도 적는다 | PASS |
| T9 | 옛 자료(LEGACY·기존 수집)는 그대로다 | PASS |
| T10 | stderr 가 조용하다 | PASS |

### 실제 수치

**버튼 아홉이 나온다:** `add_urls` `collect` `export` `map_domain` `next` `report` `retry`
`status` `workspace_new`. 계약(#2)이 정한 열 중 `search` 하나가 없고, **없는 것을 목록에 내지
않는 것이 이 도구의 규율이라 아홉이 맞는 상태다.** 부르면 오류로 막고
"`add_urls` 에 `source_kind="search"` 로 넣으라" 고 알려 준다.

**빈 프로젝트에서 처음부터 끝까지.** 새로 만든 git 저장소에서 작업대를 만들고, 주소 셋(하나는
중복)을 넣어 새로 2·중복 1을 받고, status 가 전체 2를 세고, export 가 2줄을 파일로 냈다.
`.gitignore` 에 `.claude/websearch-workspace/` 가 한 줄 생겼고 git 이 실제로 무시한다.

**"옛 것을 안 부른다" 를 두 번 확인했다.** 소스에서 `lib`·`server.mjs` 의 .mjs 35개를 읽어
금지 이름 import 0건, 그리고 **실제로 띄운 프로세스가 불러온 모듈 35개를 세어** LEGACY 0개다.
둘 다 필요하다 — 소스만 보면 나중에 넣는 import 를 놓치고, 실행만 보면 안 지나간 길을 놓친다.

## 만드는 동안 실제로 걸린 것

**등록이 말한 자리를 서버가 안 읽고 있었다.** `~/.claude.json` 의 등록에
`WEBSEARCH_DEPS_DIR` 가 적혀 있는데(브라우저 수집에 필요한 playwright 가 있는 프로젝트),
서버는 `--deps-dir` 인자만 읽었다. 지금까지 브라우저 모드가 돈 것은 `CLAUDE_PROJECT_DIR`
되돌림 덕분이지 등록 덕분이 아니었다. **등록이 말한 자리를 서버가 무시하면 그 등록은 거짓말이 된다.**
이 하나만 환경변수도 받도록 고쳤다 — 나머지 설정이 argv 전용인 이유는 "버튼 입력으로 정중함을
못 바꾸게" 하기 위해서인데, 이것은 정중함 손잡이가 아니라 의존성이 어디 있는지다.

**실행 중 확인을 처음에는 `lsof` 로 하려 했다.** 0개가 나왔다. Node 는 모듈을 읽고 바로 닫아서
실행 중에 열려 있는 `.mjs` 가 하나도 없다. 열린 파일이 아니라 **부르는 순간**을 잡아야 한다 —
모듈 해석 훅(`tests/transition/trace-hook.mjs`)으로 바꿔 실제로 불러온 35개를 받았다.

**게이트 0 이 옛 경로를 단정하고 있었다.** pace spike 를 자기 폴더로 옮기자(운영 장부 오염을
막는 고침) 게이트 0 의 G0-5 가 `~/.claude/tools/web-search/runtime/pace.db` 를 기대한 채 남아
빨간불이 됐다. SUPERVISOR 가 관찰해 알려 주었다. 재려는 성질은 "그 경로에 있다" 가 아니라
**서로 다른 곳에서 온 프로세스 20개가 한 장부를 함께 쓴다**여서, 그 불변식으로 갱신했다.
G1-13 과 같은 부류의 시점 고정이 다섯 번째다.

## 청소한 것

- 운영용 `runtime/pace.db` 에 남아 있던 spike 표 둘(`spike_pace_domain`·`spike_pace_reservation`)을
  지웠다. 이제 그 장부에는 `pace_domain`·`pace_meta`·`pace_reservation` 셋뿐이다.
  오염을 만들던 자리(spike 가 운영 장부를 쓰던 것)를 먼저 고쳤으니 다시 쌓이지 않는다.
- `MANUAL.md` 를 v2 준비 안내문에서 **버튼별 매뉴얼**로 다시 썼다 — 아홉 버튼의 한 가지 일과
  안 하는 것, 흔한 한 바퀴, 판정 반납 규칙, 일이 잘못됐을 때의 증상·뜻·다음 손, 이 도구가
  안 하는 것 여덟 가지.

## 남은 것

- **작업대 세 곳이 dibang 레포 안에 있다** — 합쳐 335MB(A 151MB · B 184MB · C 360KB).
  gitignore 안이라 커밋되지 않지만 디스크에는 남아 있다. 게이트 7 의 감사 대상이라 지우지 않았다.
- **등록은 그대로 두었다.** `~/.claude.json` 을 고치지 않고 서버가 등록을 읽도록 맞췄다.
