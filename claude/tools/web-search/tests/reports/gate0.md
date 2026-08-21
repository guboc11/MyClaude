# 게이트 0 — 기술 결정과 실패 재현 검증

판정: **PASS** (7항목 전부) · 실행: 2026-08-12 · Node v22.21.0
태스크: `2026-08-12-web-search-MCP-v2-rebuild#7` · 근거 계획: `_PLAN/2026-08-11-web-search-mcp/PLAN.md` 10단계 게이트 0

기계 판독 결과: [gate0.json](gate0.json)

## 한 번에 다시 돌리는 법

```
node tests/gate0.mjs           # 전부 실행하고 판정 (exit 0 이면 통과)
node tests/gate0.mjs --json    # 같은 결과를 JSON 으로
```

하위 시험을 자식 프로세스로 돌려 **실제 종료 코드**를 받고, 산출물 JSON 에서 핵심 수치를 직접 읽어
대조한다. 자식이 "PASS" 라고 찍었다는 것만으로 통과시키지 않는다. 기준선의 집계 해시는 저장된
숫자를 믿지 않고 이 자리에서 파일을 다시 읽어 계산한다. 네트워크는 부르지 않는다 — `fetch` 를
던지도록 바꿔 두고 호출 횟수를 세며, 0회를 별도 항목으로 판정한다.

## 항목별 판정

| 항목 | 내용 | 결과 |
|---|---|---|
| G0-1 | #1 frozen 기준선 불변 | PASS |
| G0-2 | #2 계약 시험이 예상된 RED 로만 실패 | PASS |
| G0-3 | #3 함수 단위 판정과 금지 import 0 | PASS |
| G0-4 | #4 네 거짓 성공을 로컬에서 재현 | PASS |
| G0-5 | #5 내장 SQLite 가 공유 장부로 충분 | PASS |
| G0-6 | #6 direct search 미완료 결정이 근거와 함께 명시 | PASS |
| G0-7 | 게이트 0 자체가 네트워크를 부르지 않음 | PASS |

### G0-1 — frozen 기준선 불변

`baseline --verify` exit 0. LEGACY 36개 파일의 집계 해시가 기준선 값과 일치하고, 기존 수집 데이터
1,365개의 내용 집계도 일치한다. 두 값 모두 이 게이트가 파일을 다시 읽어 계산한 것이다.

    LEGACY 집계        e1b55fbfd1ebafc5e0bfa980d828d2c0754a50e07624ca26e12cf35cf2d79215
    기존 데이터 내용 집계  222a96c1bcea20e7450243e19305a488e33c334d1bcc135c61607348c7732e8f

### G0-2 — 계약 시험이 예상된 RED 로만 실패

`--red-state` exit 0, 본시험 exit 1. 공개 도구 0개, 없는 도구 정확히 10개, 초과 0개. 실패 26건의
원인이 `tool_missing` 과 `tools_list_mismatch` 둘뿐이고, 부정 시험 6개는 모두 통과한다.

**이것을 제품 기능 GREEN 으로 읽으면 안 된다.** 계약이 고정됐다는 뜻이지 버튼이 동작한다는 뜻이
아니다. 지금 공개 도구는 0개다. 계약이 실제로 위반을 잡는다는 것은 #2 에서 대조 서버 둘로 따로
보였다 — 계약을 지키는 스텁은 채점 38건 전부 통과, 위반 열둘을 심은 스텁은 15건 실패.

### G0-3 — 함수 단위 판정과 금지 import

`verify` exit 0, `--scan` exit 0. 감사 표 87행이고 판정 분포는 reuse-as-is 26 · copy-and-rewrite 23 ·
reject 38. 대상 심볼 76개가 빠짐없이 표에 있고 세 판정 외의 값은 0이다.

금지 import 검사 범위는 `server.mjs` 와 `lib/**/*.mjs` 다. **지금 0건인 것은 지켰다는 뜻이 아니라
검사할 새 코드가 아직 없다는 뜻이다** — `lib/` 는 #8 에서 처음 생기고, 실질 검사는 게이트 1(#15)부터
매 게이트에서 다시 돈다.

### G0-4 — 네 거짓 성공을 로컬에서 재현

`verify` exit 0. 네 사례가 회귀 이름으로 고정됐고 네트워크 0회로 재현된다.

| 사례 | 옛 잘못 | 지금 고정된 기대 |
|---|---|---|
| `R-FALSE-200-ERROR` | 상태 200 오류 화면을 MCP 가 invalid 로 확정 | 수집은 success, warning 과 review_required 만 남기고 판정은 에이전트 |
| `R-FALSE-REDIRECT-MISMATCH` | 요청과 다른 곳에 도착했는데 정상 수집 | `requested_equals_final: false` 와 redirected warning |
| `R-FALSE-CARDS-ZERO` | 보이는 카드 18장인데 저장 0장 | core 는 카드를 세지 않고 DOM·캡처 원본만 보존 |
| `R-FALSE-COMPLETE-UNVISITED` | 미방문 링크 112개인데 complete | `workspace_drained` 만 말하고 112를 그대로 보존 |

D 의 112는 `events.jsonl` 의 `links_seen` 합(8+8+8+8+80)과 `case.json` 의 값이 둘 다 112로 맞는다.

### G0-5 — 내장 SQLite 가 공유 장부로 충분

`run-all` exit 0. workspace 는 10프로세스가 200행을 넣어 고유키 200, 강제 종료 2건 뒤
`integrity_check = ok`, 미커밋 0, 잔존 잠금 0. 전역 pace 는 정확한 경로
`~/.claude/tools/web-search/runtime/pace.db` 에서 서로 다른 프로젝트 20곳의 프로세스가 60건을
예약해 중복 0, 간격 위반 0, 강제 종료 2건 뒤 무결성 ok, 영구 잠금 0.

시험이 헛돌지 않는다는 대조도 함께 통과한다 — transaction 을 빼면 같은 조건에서 중복이 39건
나오고, `foreign_keys` 를 끄면 없는 부모의 자식 행이 그대로 들어간다.

**한계**: `node:sqlite` 는 Node v22.21.0 에서 아직 실험 기능이라 실행마다
`ExperimentalWarning: SQLite is an experimental feature and might change at any time` 이 뜬다.
이번 통과는 이 환경에서 지금 동작한다는 뜻이지 API 가 그대로 남는다는 보장이 아니다. 구현에는
Node 최소 버전 확인을 넣고, import 실패나 동작 변화를 조용히 넘기지 말고 명시적 오류로 드러내야 한다.

### G0-6 — direct search 는 미완료 결정으로 통과

`verify` exit 0. 후보 9곳이 모두 탈락했고 살아남은 후보는 0이다. 보존한 증거는 17개(robots 10 ·
probe 3 · 이용 조건 4)이고 크기와 지문이 모두 일치한다. 50개 검색어 corpus 는 실행하지 않았다 —
거기까지 간 후보가 없고, 이미 걸러진 곳을 더 두드리는 것은 남의 서비스에 부담만 주기 때문이다.

게이트 0 의 요구는 "공급자 하나 확정 **또는** direct search 미완료 결정 명시" 이고, 후자를
[decision.md](../spikes/search-provider/decision.md) 가 근거와 함께 채운다. 결정의 알맹이는 넷이다.

- 직접 `search` 버튼은 미완료. 불안정한 스크래핑을 정상 기능으로 표시하지 않는다.
- 에이전트가 자기 `WebSearch` 결과를 `add_urls` 로 넣는 경로는 그대로 유지한다.
- `search` 는 제품 기능으로 아직 없다.
- **#36·#37·#38 은 착수할 수 없다.** 확정 공급자 adapter, search 실행·원문 연결, 게이트 5 실전
  검증이 모두 선행 조건을 못 갖췄다. 게이트 5 와 최종 게이트(#49)에서 이 항목을 통과로 적으면 안 된다.

### G0-7 — 네트워크 0회

게이트 실행 중 `fetch` 호출 시도 0회. #6 은 그날 받아 둔 원문만 다시 읽는다. 검증기가 바깥을
다시 두드리면 결과가 그때그때 달라져 "그날 무엇을 봤는가" 를 확인할 수 없다.

## 실행 기록

| 하위 시험 | exit | 걸린 시간 |
|---|---:|---:|
| `tests/baseline/baseline.mjs --verify --project <프로젝트>` | 0 | 565ms |
| `tests/contracts/public-tools.mjs --red-state` | 0 | 115ms |
| `tests/contracts/public-tools.mjs --json` | **1** (예상된 RED) | 115ms |
| `tests/baseline/verify-reuse-audit.mjs` | 0 | 52ms |
| `tests/baseline/verify-reuse-audit.mjs --scan` | 0 | 42ms |
| `tests/fixtures/false-success/verify.mjs` | 0 | 63ms |
| `tests/spikes/sqlite-wal/run-all.mjs` | 0 | 4,081ms |
| `tests/spikes/search-provider/verify.mjs` | 0 | 47ms |

## 만드는 동안 실제로 막혔던 자리

**SQLite 시험이 2분 멈췄다.** 처음에는 강제 종료 과녁 둘의 쓰기 transaction 을 동시에 열어 두려
했다. SQLite 는 쓰기 transaction 을 하나만 허용하므로 뒤엣놈이 `busy_timeout` 까지 막혔고, 그
일꾼은 아무 말도 못 한 채 부모가 영영 기다렸다 — 실행이 2분 한도를 넘겨 중단됐다. 고친 방식은
둘이다. 과녁을 한 명씩 다룬다("열림 확인 → SIGKILL → 종료 확인" 한 바퀴씩). 그리고 모든 자식
대기에 벽시계 제한(일반 30초, 과녁 15초)과 초과 시 SIGKILL 정리를 걸어, 영원히 멈추는 설계가
시험을 통과하지 못하게 했다. 그때 남은 임시 폴더 하나는 접두로 정확히 골라 지웠고 이후 잔존 0을
확인했다. 자세한 기록은 [sqlite-wal/README.md](../spikes/sqlite-wal/README.md) 에 있다.

**간헐 실패 하나가 뒤늦게 드러났다.** 게이트 0 을 처음 닫은 뒤 독립 재검증에서 workspace 시험이
200행 대신 180행을 냈다. 원인은 일꾼이 DB 를 열 때 `busy_timeout` 을 걸기 **전에**
`PRAGMA journal_mode = WAL` 을 실행한 것이었다 — 열 개가 동시에 열면 하나가 잠금에 걸리는데 그
시점엔 기다릴 시간이 0이라 예외가 나고 그 일꾼이 말없이 죽었다. 180 = 살아남은 9명 × 20줄이다.
`busy_timeout` 을 먼저 걸도록 순서를 바꾸고, 시작 실패를 조용히 넘기지 않도록 일꾼이 `fatal` 한 줄을
남기게 했으며, 검사도 고정 수치 대신 셈 항등식(`계획 = 들어감 + 포기 + 오류`)으로 바꿨다.
고친 뒤 게이트 0 을 다섯 번 연속 돌려 모두 10/10 일꾼·200행·exit 0 이다. 자세한 경위는
[gate1.md](gate1.md) 의 "앞 게이트에서 고친 것" 에 있다.

## 지금 알려진 한계

- **공개 도구는 0개다.** 계약과 회귀 기준만 섰고 버튼은 하나도 구현되지 않았다.
- **`search` 는 미완료로 남는다.** 무키로 쓸 수 있는 공급자를 찾지 못했다. 후보 사이트 찾기는
  에이전트의 `WebSearch` → `add_urls` 로만 된다.
- **`node:sqlite` 는 실험 기능이다.** 버전 가드가 필요하다.
- **금지 import 검사는 아직 공허하다.** `lib/` 가 없어 검사 대상이 `server.mjs` 하나다.
- **#4 의 네 사례는 "옳은 결과가 무엇인지" 를 고정한 것이지 구현이 그렇게 동작한다는 증거가 아니다.**
  실제로 통과시키는 시험은 구현이 생긴 뒤 게이트 1·3에서 붙는다.
- **#2 의 응답 4KB 상한과 반환 키 검사는 도구 다섯 개에만 걸려 있다.** 나머지 다섯은 임대·수집·
  네트워크가 있어야 해서 게이트 2·3·4·5로 미뤄 뒀다.

## 다음

게이트 0 전 항목 PASS 이므로 #8 부터 진행할 수 있다. 다만 위 한계 여섯 가지는 뒤 게이트가
그대로 물려받는다 — 특히 `search` 미완료는 게이트 5와 최종 게이트에서 통과로 적으면 안 된다.
