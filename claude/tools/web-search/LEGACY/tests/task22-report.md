# 태스크 22 — 실전 한 바퀴 (국내 6 + 세 유형 3)

- 날짜: 2026-08-11 (후속 회차 2026-08-12)
- 도구: user scope MCP `web-search`, 워커는 `field/worker.mjs`(MCP 자식 1개·크롤 1개)
- 실행: `field/launch.mjs`. 크롤마다 `mode=exhaustive`, `allow_domains=[씨앗 도메인]`,
  `external_hop_max=2`, 간격 10초±5초, 목표 개수·페이지 예산·시간 예산 **없음**
- 워커 규칙: `discover` 완주 → `lease` → `fetch` → `report`.
  상세(`detail`)는 열지 않고 `known_deferred`, 목록은 열고, 종류 모를 것은 연다.

## 1. 아홉 크롤의 실제 시작 증거

| 크롤 | seed | 역할 | 워커 PID / MCP PID | 종료 |
|---|---|---|---|---|
| kr-deardeer | https://deardeer.kr/ | 국내 · 사이트맵 138 기준점 | 19620/19624 → 재개 44475 | 1: TDZ → 재개 0 |
| kr-barunson | https://mcard.barunsoncard.com/ | 국내 · 302 우회 확인 | 19927 | 0 |
| kr-theirmood | https://theirmood.com/ | 국내 · 소규모 | 20287 | 0 |
| kr-itscard | https://itscard.co.kr/ | 국내 | 20686/20690 → 재개 44479 | 1: TDZ → 재개 0 |
| kr-bojagi | https://bojagicard.com/ | 국내 · JS/Jina 관찰 대상 | 21017 → 재개 | 1: TDZ → 재개 0 |
| kr-salondeletter | https://salondeletter.com/ | 국내 | 21332/21336 → 재개 44487 | 1: TDZ → 재개 0 |
| ex-paperlesspost | https://www.paperlesspost.com/ | JS/Jina 경로 후보 | 21586 | 0 |
| ex-optimalprint | https://www.optimalprint.com/ | 언어·지역 리다이렉트 | 21833/21837 | 0 |
| ex-minted | https://www.minted.com/ | Cloudflare 차단형 | 22048/22056 | 0 |

크롤마다 `run-meta.json`(PID·시각·종료 코드·셈), `mcp-log.jsonl`(도구·인자·응답 원문),
`reports/cycle-1.md`, `state.json`·`events.jsonl` 이 남아 있다.

### 추가 3곳의 역할은 실측으로 정했다

2026-08-11 사전 실측(`probe-2026-08-11/probe-roles.json`):

- **paperlesspost** — `curl 406` · **무키 Jina 403** · `headless 200` 카드 48.
  **Jina 성공 사례가 아니다.** 브라우저가 있어야 열리는 JS 목록이라는 뜻이며,
  무키 Jina 가 6곳 중 4곳에서 403 이었다는 사실이 태스크 24 키 판단의 근거다.
- **optimalprint** — `/` → **`/en`** 리다이렉트 실측(`flags: redirected`), curl 403 → headless 200.
- **minted** — curl 403 · Jina 403 뒤 전역 pace 가 **10,800초 휴면**. 차단형.
- 탈락: zola(경로 404), papier·rosemood(리다이렉트 없음).
- **bojagicard** 의 역할은 "curl 에서 끝남" 이 아니라 **국내 JS/Jina 관찰 대상**이다.
  이번에도 무키 Jina 는 403 이었고 최종 tier 는 curl 이었다.

## 2. 1회차 결과

| 크롤 | 완료 판정 | 발견 | listing 연 것 | detail 재움 | unknown 연 것 | 카드 | 막힘 |
|---|---|---|---|---|---|---|---|
| kr-deardeer | paused_incomplete | 207 | 2 | 0 | 0 | 0 | domain_sleeping |
| kr-barunson | paused_incomplete | 75 | 1 | 0 | **69** | 0 | 없음 |
| kr-theirmood | paused_incomplete | 63 | 2 | 0 | 0 | 0 | domain_sleeping |
| kr-itscard | paused_incomplete | 100 | 45 | 0 | 38 | 0 | domain_sleeping |
| kr-bojagi | complete | 5 | 0 | 0 | 0 | 0 | 없음 |
| kr-salondeletter | paused_incomplete | 10 | 1 | 0 | 4 | 0 | domain_sleeping |
| ex-paperlesspost | paused_incomplete | 16,268 | 1 | 0 | 0 | 0 | needs_boundary_review |
| ex-optimalprint | paused_incomplete | 2 | 0 | 0 | 0 | 0 | domain_sleeping(10,800초) |
| ex-minted | paused_incomplete | 2 | 0 | 0 | 0 | 0 | domain_sleeping(9,221초) |

## 3. 이번 회차 관찰 네 항목

### (1) 사이트맵에 제품 아닌 것이 얼마나 섞이는가

| 도메인 | 사이트맵에서 들어온 수 | 그중 목록·상세가 아닌 것 |
|---|---|---|
| deardeer.kr | 138 | **67 (49%)** |
| theirmood.com | 11 | 8 |
| salondeletter.com | 5 | 4 |
| paperlesspost.com | 16,260 | **15,783 (97%)** |
| barunson · itscard · bojagi · optimalprint · minted | 0 | — (사이트맵을 못 읽었거나 없음) |

경계 규칙을 조일 근거는 충분하다. paperlesspost 는 사이트맵 하나로 16,260건이 들어와
경로 형태 상한에 걸려 섰다(`needs_boundary_review`).

### (2) 새 외부 도메인 — **미관측**

**0건이 아니라 재지 못했다.** 1회차 코드의 `harvestLinks` 가 같은 호스트가 아닌 링크를
경계 판정에 넘기기 전에 버렸기 때문이다. 그래서 아홉 장부의 `excluded`·외부 도메인이 모두 0인데,
이것은 "바깥 링크가 없었다"가 아니라 "도구가 보기 전에 버렸다"는 뜻이다.

고친 뒤(2026-08-12) 링크는 `fetch` 가 남긴 `notes/links.json` 을 `report` 가 같은 원자 변경 안에서
경계 판정에 넘기는 길로 바뀌었다. 다시 잰 결과는 4장에 있다.

### (3) 막힌 소셜 — **미관측**

같은 이유다. 소셜 링크는 바닥글에 있고, 그 바닥글 링크가 경계 판정에 닿지 않았다.
막힌 것으로 실제 관찰된 것은 소셜이 아니라 **도메인 휴면 6곳**이다:
deardeer · theirmood · itscard · salondeletter · optimalprint · minted 이 각각 차단 낌새로 잠들었고,
minted 는 curl 403 · Jina 403 두 번으로 3시간 휴면에 들어갔다.

### (4) 목록 우선으로 줄인 요청 수 — **1회차는 절감 0**

계획은 "상세를 재우고 목록만 연다" 였는데 실제로는 **detail 재움이 아홉 곳 모두 0**이었다.
원인은 종류 판정이다. `classifyKind` 의 상세 규칙이 `/detail` 로 **끝날 때만** 맞아,
바른손의 `/Product/Detail/1188` 같은 진짜 상세가 `unknown` 이 됐고,
워커 규칙상 `unknown` 은 여는 종류라 **69쪽을 그대로 다 열었다.**

deardeer 만 상세 79건이 `detail` 로 붙었는데, 그 크롤은 휴면에 걸려 큐 200건을 열지 못했다.

## 4. 고친 것과 후속 회차

1회차에서 드러난 결함 셋을 회귀 시험(red → green)으로 고쳤다.

| 결함 | 증거 | 시험 |
|---|---|---|
| 판정 함수가 이른 반환 경로에서 죽음(`Cannot access 'cards' before initialization`) | 국내 4곳이 같은 자리에서 exit 1 | regress R11 |
| 바깥 링크를 경계 판정 전에 버림 | 아홉 장부 모두 바깥 도메인 0 | gate3 G25·G26·G27, gate4 L1~L6 |
| 상세 경로를 못 알아봄 | barunson 69쪽을 다 엶 | regress R12 |

전체 연쇄: gate1 9 · gate2 24 · regress 12 · gate3 29 · gate4 63(본 항목 5/5) · manual-check 8 ·
field smoke 9 — **모두 통과**.

### 후속 회차 `kr-barunson-postfix` (같은 조건, 새 장부)

| 항목 | 1회차 kr-barunson | 후속 kr-barunson-postfix |
|---|---|---|
| listing 연 것 | 1 | 0 |
| detail 재움 | 0 | 0 |
| unknown 연 것 | **69** | **0** |
| 링크 본 것 / 들인 것 | 잴 수 없었음(미관측) | **112 / 0** |
| 바깥 한 다리 도메인 | 미관측 | 0 |
| 완료 판정 | paused_incomplete | complete |
| 발견 총수 | 75 | 5 |

**후속 회차는 절감이 아니라 정지다.** 요청은 69 → 0 으로 줄었지만 수집도 함께 0이 됐다.
바른손의 홈과 목록 다섯 쪽이 모두 `needs_visual_review` 로 판정돼, 본 링크 112개를
하나도 따라가지 않았다(`links_not_followed` 이벤트 5건: 8·8·8·8·80).

그리고 그 상태에서 **완료 판정이 `complete` 로 나왔다.** 본 링크 112개를 안 따라갔는데
"다 봤다"고 말한 것이다. 이것은 1회차의 "바깥 링크 0건" 과 같은 종류의 잘못이다 —
안 본 것을 없는 것으로 보고한다.

## 5. 이번 회차가 남긴 결론

- 로컬 게이트를 다 통과해도 실사이트에서 세 결함이 한 번에 드러났다.
  실전 한 바퀴는 게이트의 대체가 아니라 게이트가 못 보는 자리를 비추는 도구다.
- **"0건" 과 "미관측" 을 가르는 장치가 없으면 보고가 거짓이 된다.**
  그래서 `links_seen`/`links_added` 를 나눠 세고, 따라가지 않은 것은
  `links_not_followed` 로 사유와 함께 남긴다.
- 남은 문제 두 가지는 게이트 5 보고서에 있다: **목록에서 카드가 한 장도 안 잡힌다**,
  그리고 **본 링크를 안 따라갔는데 complete 로 닫힌다**.
