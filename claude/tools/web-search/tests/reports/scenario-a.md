# 시나리오 A — 전 세계 결혼식 후보 사이트

판정: **완료** · 실행: 2026-08-12 · Node v22.21.0 · 실제 인터넷
태스크: `2026-08-12-web-search-MCP-v2-rebuild#44` · 근거 계획: `_PLAN/2026-08-11-web-search-mcp/PLAN.md` 7단계

workspace: `.claude/websearch-workspace/2026-08-12-wedding-candidates-worldwide` (dibang 레포, gitignore 됨)
진행기: [tests/e2e/scenario-a.mjs](../e2e/scenario-a.mjs) · 검색 결과 입력: [scenario-a-input.json](../e2e/scenario-a-input.json)

## 한 일

워커(에이전트)가 자기 `WebSearch` 로 **22개 검색어**를 돌려 URL 107개를 얻고, 그것을 `add_urls` 로
넣은 다음, 워커 셋이 나눠 빌려 **브라우저로 화면과 본문을 받고**, 사람이 이름표를 붙여 반납하고,
업체만 골라 내보냈다. 여기까지 **버튼만 썼다** — 진행기가 부르는 것은 MCP 버튼뿐이고,
그 파일의 import 는 `child_process` · `fs` · `path` 셋뿐이다.

`search` 버튼은 없다. 무키 공급자가 하나도 없어 만들지 않았고([gate5.md](gate5.md)),
그 대신 확정된 경로 — 에이전트의 `WebSearch` 결과를 `add_urls` 에
`source_kind="search"`, `source_value=검색어` 로 넣는 길 — 을 그대로 썼다.

```
node tests/e2e/scenario-a.mjs seed    --project <프로젝트> --input tests/e2e/scenario-a-input.json --state <state.json>
node tests/e2e/scenario-a.mjs lease   --state <state.json> --worker w1 --count 50
node tests/e2e/scenario-a.mjs collect --state <state.json> --worker w1
node tests/e2e/scenario-a.mjs digest  --state <state.json> --out <digest.json>
node tests/e2e/scenario-a.mjs judge   --state <state.json> --worker w1 --decisions <decisions.json> --digest <digest.json>
node tests/e2e/scenario-a.mjs export  --state <state.json>
```

## 실제 수치

| 잰 것 | 값 |
|---|---|
| 검색어 | 22개 (5개 언어 ko·en·ja·es·fr / 6개 나라) |
| 받은 URL · item | 107 → **105** (중복 2 · 거절 0) · 도메인 101곳 |
| 출처 줄 | 107 (같은 URL 이 두 검색어에서 나오면 둘 다 남는다) |
| 워커 | 3명 (50 · 50 · 5로 나눠 빌림, 겹침 0) |
| 수집 실행 | 113회 — 성공 69 · 부분 28 · 실패 13(항목으로는 8) |
| 산출물 | **196개 · 149.4MB** (화면 97장 148MB · 본문 99개 1.2MB) |
| 판정 | 97줄 (라벨 있음 77 · 확인 필요 20) |
| 이름표 | 업체 63 · 마켓 6 · 블로그 3 · 언론 2 · 무관 3 · 확인 필요 20 · 판정 없음(수집 실패) 8 |
| 장부 대 파일 | 196줄 검사 **196개 일치** · 고아 0 · 만들다 만 것 0 · 요약 없는 실행 0 |

오류 13건: `navigate/goto_failed` 9 · `dns/dns_ENOTFOUND` 2 · `browser/browser_failed` 2.
관찰 190건: `browser_no_pinned_connection` 110(브라우저 모드면 늘 붙는다) · `scroll_limit_reached` 30 ·
`redirected` 20 · `http_error_status` 17 · `screenshot_truncated` 13 · `subresource_blocked` 9 ·
`blocked_page_suspected` 7 · `empty_text` 4.

### 나라별 이름표

| 나라 | 업체 | 마켓 | 언론·블로그 | 무관 | 판정 없음 |
|---|---|---|---|---|---|
| 프랑스 | 17 | 1 | 1 | 0 | 2 |
| 스페인 | 16 | 0 | 0 | 0 | 5 |
| 미국·영국 | 12 | 2 | 0 | 1 | 9 |
| 대한민국 | 11 | 1 | 3 | 1 | 6 |
| 일본 | 6 | 2 | 1 | 1 | 5 |
| 이탈리아 | 1 | 0 | 0 | 0 | 1 |

### 되짚기 표본

무작위 다섯 건(7 · 49 · 77 · 86 · 102)에서 **검색어 → item → 실행 → 산출물 → 판정 근거**가
끊기지 않았고, 파일 열 개의 크기와 지문이 장부와 모두 같았다. item 49 는 검색어 두 개에서
나와 출처가 둘 다 남아 있고, item 102 는 실행이 `failed → success` 로 둘인데 판정의 근거가
성공한 쪽 산출물을 가리킨다.

## 만드는 동안 실제로 걸린 것 — 결함 둘

**1. 브라우저 모드가 진짜 사이트에서 한 장도 못 열었다.** 첫 다섯 곳(프랑스)이 전부
`navigate/goto_failed`, 30초 이동 시간 초과였다. 원인은 속도 예약을 **요청마다** 걸어 둔 것이다.
한 페이지가 그림·글꼴·스크립트로 수십 번 요청하는데 그 하나하나가 도메인 간격(기본 10초)을
기다리니, 페이지가 열리기 전에 이동이 먼저 끝난다.

게이트 3 에서는 시험용으로 간격을 1밀리초로 낮춰 돌렸다. 그래서 이 결함은 **드러날 수가 없었다** —
같은 코드가 시험에서는 늘 통과하고 실전에서는 늘 실패한다.

고친 방향: 정중함의 단위는 "그 도메인을 몇 번 찾아갔는가" 이지 "한 번 찾아가 몇 개를 받았는가" 가
아니다. 예약은 **본문 이동**에만 걸고 딸린 자원은 목적지 검사만 받게 했다.
같은 다섯 곳을 다시 돌리니 154초 전멸에서 **36초에 성공 4·부분 1·실패 0** 이 됐다.

**2. 근거를 대라는 규칙을 버튼만으로는 지킬 수 없었다.** `report` 는 판정의 근거로
`artifact_id` 를 요구하는데(#39), 수집이 돌려주는 요약(manifest)에는 경로만 있고 번호가 없었다.
장부를 직접 열지 않는 한 에이전트가 그 번호를 알 길이 없다 — 즉 **버튼만 쓰는 워커는 규칙을
지킬 수 없었다.** 요약의 artifact 줄에 `artifact_id` 를 같이 싣도록 고쳤다.

두 결함 모두 실전에서만 드러났다. 앞의 것은 시험이 조건을 실제와 다르게 만들어서, 뒤의 것은
시험이 라이브러리를 직접 불러서 — 둘 다 "버튼만으로 끝까지 가 본 적이 없어서" 였다.

## 상위 역할의 판단 — 무엇이 부족한가

이 절은 **기계가 아니라 사람(에이전트)이** export 와 status 를 보고 적는다.

- **이탈리아가 사실상 비었다.** 업체 1곳뿐이다. 영어 검색어 하나만 걸쳤으니 당연한 결과이고,
  이탈리아어 검색어(`partecipazioni matrimonio artigianali` 같은)로 한 바퀴 더 돌아야 한다.
- **미국·영국은 수보다 차단이 문제다.** 확인 필요 9건이 전부 403·로봇 확인·자바스크립트 확인
  화면이다. 큰 인쇄 회사일수록 막힌다. 이 지역의 실제 후보 수는 지금 보이는 12보다 많다.
- **일본은 통판 쪽으로 치우쳤다.** 업체 6 중 상당수가 인쇄 통판이고, 프랑스·스페인처럼
  손으로 찍는 공방(letterpress)은 이번 검색어로 걸리지 않았다. `活版印刷 招待状 工房` 쪽으로
  다시 봐야 한다.
- **한국은 모바일 청첩장에 몰려 있다.** 종이 쪽은 바른손·잇츠카드·두유프레스·밀리스트 정도이고,
  이 갈래는 나라마다 성격이 아주 다르다 — 비교하려면 종이 쪽 검색어를 더 넣어야 한다.
- **프랑스·스페인은 이번 표본으로 충분해 보인다.** 업체 17·16 이고 확인 필요 비율도 낮다.

## 지금 알려진 한계

- **차단당한 20건을 "없는 곳" 으로 세면 안 된다.** 상태 200 이어도 차단 화면이면 우리가 본 것은
  그 사이트가 아니다. 그래서 라벨을 안 붙이고 `확인 필요` 로 두었다 — 기계가 만든 `http_error_status`
  ·`blocked_page_suspected` 관찰과 별개로, 사람이 "못 봤다" 고 적은 것이다.
- **화면 갈무리가 무겁다.** 97장에 148MB, 한 장에 1.5MB 꼴이다. gitignore 안이라 커밋되지는
  않지만, 큰 조사에서는 화면을 빼고 본문만 받는 편이 낫다.
- **한 곳당 대표 페이지 한 장씩만 봤다.** 그 안쪽(가격·후기·주문 방법)은 안 봤다.
  깊게 보는 것은 시나리오 B 의 몫이다.
- **브라우저 수집에는 부른 프로젝트에 playwright 가 있어야 한다.** 이 도구 폴더에는 없다.

## 다음

`#45`(시나리오 B) — SUPERVISOR 가 지정한 `mcard.barunsoncard.com` 한 도메인을 깊게 수집한다.
