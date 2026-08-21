# LEGACY 재사용 감사 — 함수 단위 판정

작성: 2026-08-12 · 태스크 `2026-08-12-web-search-MCP-v2-rebuild#3`
근거: `_PLAN/2026-08-11-web-search-mcp/PLAN.md` 9-1·9-2·9-3, 제품 의도 9·10절
금지 목록: [forbidden-imports.json](forbidden-imports.json) · 기준선: [README.md](README.md)

파일 통째로 살리거나 버리지 않는다. 심볼 하나하나에 판정을 붙이고 근거 줄을 적는다.
판정은 셋뿐이다.

- **reuse-as-is** — 새 계약에서 하는 일이 같다. 코드를 그대로 옮긴다.
- **copy-and-rewrite** — 알맹이는 쓸 만하지만 v2 계약과 어긋나는 부분이 있어 고쳐 옮긴다.
- **reject** — 새 core 가 하지 않기로 한 일이다. 옮기지 않는다.

**판정과 무관하게 runtime 에서 LEGACY 를 import 하는 것은 0이어야 한다.** reuse-as-is 도
"그 파일을 불러 쓴다"가 아니라 "그 코드를 새 위치에 옮겨 적는다"는 뜻이다.

## 요약

아래 수치는 손으로 센 것이 아니라 `verify-reuse-audit.mjs` 가 표를 읽어 낸 값이다.

| 파일 | 심볼 | reuse-as-is | copy-and-rewrite | reject |
|---|---:|---:|---:|---:|
| lib/url.mjs | 7 | 5 | 2 | 0 |
| lib/text.mjs | 7 | 0 | 2 | 5 |
| lib/pace.mjs | 14 | 4 | 5 | 5 |
| lib/browser.mjs | 11 | 6 | 3 | 2 |
| lib/discover.mjs | 37 | 10 | 2 | 25 |
| tests/gate1.mjs (임대·경합·pace) | 11 | 1 | 9 | 1 |
| **합계** | **87** | **26** | **23** | **38** |

가장 중요한 결론 셋.

1. **사이트맵 파서와 URL 정규화는 거의 그대로 살아남는다.** `sitemapRoot` 는 200으로 온 오류
   HTML 을 "항목 0개짜리 사이트맵"으로 삼키지 않게 막는 함수로, 1차의 거짓 성공을 실제로 막아 준
   몇 안 되는 코드다(`lib/discover.mjs:53-58` 주석에 그 사고가 적혀 있다).
2. **`discover()` 한 함수가 버려지는 코드의 대부분이다.** 385줄 안에서 임대·수집·판정·자동 추가·
   완료 선언을 모두 한다. v2 는 이 일을 `map_domain`·`next`·`collect`·`report` 네 버튼으로 쪼갠다.
3. **임대 시험은 거의 다 살린다.** 특히 `BARRIER`(`tests/gate1.mjs:78`)는 그대로 가져간다 —
   이 배리어가 없으면 잠금을 완전히 꺼도 경합 시험이 통과한다고 주석에 실측이 적혀 있다.

## lib/url.mjs

| 대상 | 심볼 | 판정 | 이유(근거 줄) | 새 위치 후보 | 회귀 시험 |
|---|---|---|---|---|---|
| `lib/url.mjs:11` | `DEFAULT_DROP_PARAMS` | reuse-as-is | 추적 파라미터 목록. v2 게이트 1의 "추적 파라미터는 합친다"와 그대로 맞는다 | `lib/url.mjs` | R-URL-1 |
| `lib/url.mjs:25` | `SORTING_PARAMS` | reuse-as-is | 정렬 파라미터를 기본 제거하지 않는 판단(L22-24). 지우면 목록이 통째로 한 칸이 된다 | `lib/url.mjs` | R-URL-3 |
| `lib/url.mjs:29` | `DEFAULT_KEEP_PARAMS` | reuse-as-is | 기능성 파라미터 보존 목록. 게이트 1의 "기능성 파라미터는 보존"과 직결 | `lib/url.mjs` | R-URL-2 |
| `lib/url.mjs:34` | `stripDefaultPort` | reuse-as-is | 기본 포트 제거. 부수효과 없음 | `lib/url.mjs` | R-URL-4 |
| `lib/url.mjs:43` | `normalizeUrl` | copy-and-rewrite | 정규화 자체는 맞지만 URL 의 사용자명·비밀번호를 걸러내지 않는다. `new URL()` 이 보존하고 `u.toString()`(L91)이 그대로 내보내 자격정보가 장부에 박힌다. PLAN 5-4 는 이를 거절하라고 한다. 반환도 `{url,id}` 대신 `canonical_url` 계약에 맞춰야 한다 | `lib/url.mjs` | R-URL-1, R-URL-2, R-URL-5 |
| `lib/url.mjs:95` | `urlId` | copy-and-rewrite | sha256 앞 20자. v2 는 `canonical_url` 이 유일성의 열쇠이고 `item_id` 는 DB 가 준다. 파생 id 를 중복 판정에 쓰면 안 되고, 경로 이름표로만 남긴다 | `lib/artifacts.mjs` | R-URL-6 |
| `lib/url.mjs:108` | `sameHostIgnoringWww` | reuse-as-is | 이름이 하는 일을 정확히 말한다(L99-107). 등록 도메인 판정으로 착각하지 않게 주석까지 함께 옮긴다 | `lib/url.mjs` | R-URL-7 |

## lib/text.mjs

| 대상 | 심볼 | 판정 | 이유(근거 줄) | 새 위치 후보 | 회귀 시험 |
|---|---|---|---|---|---|
| `lib/text.mjs:8` | `visibleText` | copy-and-rewrite | 주석·script·style 을 빼는 것은 맞다. 그러나 `\s+`를 한 칸으로 뭉개(L13) 줄과 문단 경계가 사라진다. PLAN 4-6 의 text 산출물은 "보이는 텍스트를 순서대로" 남기고 "주 내용을 추측해 삭제하지 않음"이라 블록 경계를 살려야 한다 | `lib/collect/text.mjs` | R-TEXT-1 |
| `lib/text.mjs:19` | `JINA_MARK` | reject | Jina Reader 머리말 표식. 무키 Jina 는 core 에서 내렸다(PLAN 9-2, 실전 17회 전부 403) | — | R-FORBID-1 |
| `lib/text.mjs:20` | `JINA_HEAD_LINE` | reject | 같음 | — | R-FORBID-1 |
| `lib/text.mjs:22` | `stripJinaHeader` | reject | 같음 | — | R-FORBID-1 |
| `lib/text.mjs:33` | `STOP` | reject | 낱말 세기 전용 불용어. v2 버튼 어디에도 낱말 세기가 없다 | — | R-FORBID-1 |
| `lib/text.mjs:44` | `termCounts` | reject | 낱말 빈도는 의미 분석이고 core 밖 레시피 몫이다(제품 의도 6-5) | — | R-FORBID-1 |
| `lib/text.mjs:57` | `canonicalContent` | copy-and-rewrite | 지문 표준형이라는 발상은 살린다. 다만 markdown 분기(L58)가 Jina 전제이고, v2 artifact 지문은 저장한 바이트 그대로 SHA-256 을 뜬다(PLAN 5-3) | `lib/artifacts.mjs` | R-ARTIFACT-1 |

## lib/pace.mjs

| 대상 | 심볼 | 판정 | 이유(근거 줄) | 새 위치 후보 | 회귀 시험 |
|---|---|---|---|---|---|
| `lib/pace.mjs:14` | `DEFAULTS` | copy-and-rewrite | `min_interval_ms`·`jitter_ms` 는 살린다. `daily_cap`·`block_sleep_ms`·`block_threshold` 는 PLAN 8 의 "403 한 번으로 몇 시간 자동 휴면하지 않음"과 정면으로 어긋난다 | `lib/pace.mjs` | R-PACE-2 |
| `lib/pace.mjs:24` | `nowMs` | reuse-as-is | 시각 한 곳 | `lib/pace.mjs` | R-PACE-1 |
| `lib/pace.mjs:25` | `today` | reuse-as-is | 날짜 경계. 하루 통계에만 쓴다 | `lib/pace.mjs` | R-PACE-1 |
| `lib/pace.mjs:26` | `staleDir` | reject | 하드링크 잠금 폴더 규약. v2 는 SQLite 트랜잭션으로 대체(PLAN 3-3) | — | R-FORBID-1 |
| `lib/pace.mjs:28` | `emptyRec` | copy-and-rewrite | 도메인 레코드 뼈대는 필요하다. 다만 `block_score`·`sleep_until`·`permits`·`user_agent` 필드는 pace 책임이 아니다(PLAN 8: "도메인별 다음 허용 시각 예약 하나뿐") | `lib/pace.mjs` | R-PACE-2 |
| `lib/pace.mjs:62` | `PERMIT_TTL_MS` | reject | 이름표는 Jina 두 도메인 예약 문제를 풀려고 생긴 장치(L43-61). 그 계단이 사라지면 존재 이유가 없다 | — | R-FORBID-1 |
| `lib/pace.mjs:64` | `prunePermits` | reject | 같음 | — | R-FORBID-1 |
| `lib/pace.mjs:72` | `pickUserAgent` | reject | UA 는 HTTP 전송 계층 몫이고 pace 는 시각만 다룬다. 도메인별 UA 고정은 탐지 회피 쪽으로 읽힌다 | — | R-FORBID-1 |
| `lib/pace.mjs:76` | `load` | copy-and-rewrite | 레코드 읽기 + 날짜 경계 초기화. JSON 파일에서 pace.db 행 읽기로 바꾼다 | `lib/pace.mjs` | R-PACE-3 |
| `lib/pace.mjs:91` | `withDefaults` | reuse-as-is | `undefined` 를 "지정 안 함"으로 다루는 방어(L87-90). 이게 없으면 선택 인자가 기본값을 지워 간격이 아예 안 걸린 실제 사고가 있었다 | `lib/pace.mjs` | R-PACE-4 |
| `lib/pace.mjs:97` | `reserve` | copy-and-rewrite | "잠금 안에서 다음 허용 시각을 먼저 예약"이라는 핵심(L4-5)은 v2 그대로다. 잠금을 DB 트랜잭션으로 바꾸고 permit·daily_cap·sleep 분기를 걷어낸다 | `lib/pace.mjs` | R-PACE-1, R-PACE-2 |
| `lib/pace.mjs:145` | `consume` | reject | 이름표 소비. permit 이 사라지면 함께 사라진다 | — | R-FORBID-1 |
| `lib/pace.mjs:157` | `record` | copy-and-rewrite | 실패 backoff 는 남길 수 있으나 `blocked` 누적으로 세 시간 재우는 분기(L161-166)는 뺀다. 긴 휴면은 에이전트가 정한다(PLAN 8) | `lib/pace.mjs` | R-PACE-2 |
| `lib/pace.mjs:181` | `peek` | reuse-as-is | 읽기 전용 조회. 상태를 바꾸지 않는다 | `lib/pace.mjs` | R-PACE-1 |

## lib/browser.mjs

| 대상 | 심볼 | 판정 | 이유(근거 줄) | 새 위치 후보 | 회귀 시험 |
|---|---|---|---|---|---|
| `lib/browser.mjs:15` | `loadPlaywright` | copy-and-rewrite | 프로젝트 node_modules 에서 playwright 를 찾는 방식은 유지하되, LEGACY `deps.mjs` 대신 v2 자체 해석기를 쓴다 | `lib/collect/browser.mjs` | R-BROWSER-1 |
| `lib/browser.mjs:21` | `CHALLENGE_MARKS` | reuse-as-is | 차단 화면 지문 목록. v2 에서는 판정이 아니라 warning 근거로 쓴다 | `lib/collect/browser.mjs` | R-BROWSER-2 |
| `lib/browser.mjs:31` | `looksLikeChallenge` | copy-and-rewrite | 판정 함수 자체는 사실 관측이라 괜찮다. 문제는 호출부에서 `ok: !challenge`(L194)로 성공 여부를 뒤집는 것이다. v2 는 `blocked_page_suspected` warning 만 남기고 수집 성공 여부는 산출물 생성으로 판단한다 | `lib/collect/browser.mjs` | R-BROWSER-2 |
| `lib/browser.mjs:36` | `VIEWPORT` | reuse-as-is | 캡처 기준 화면 크기 | `lib/collect/browser.mjs` | R-BROWSER-3 |
| `lib/browser.mjs:38` | `DEVICE_SCALE` | reuse-as-is | 배율을 manifest 에 남겨야 자리를 되짚을 수 있다 | `lib/collect/browser.mjs` | R-BROWSER-3 |
| `lib/browser.mjs:40` | `CARD_MIN_SIDE` | reject | 카드 후보 최소 크기. 카드 인식은 core 에서 내렸다 | — | R-FORBID-1 |
| `lib/browser.mjs:42` | `CARD_MAX` | reject | 같음 | — | R-FORBID-1 |
| `lib/browser.mjs:44` | `SCROLL_MAX_STEPS` | reuse-as-is | 무한 스크롤 종료 보장(L84-89). deardeer.kr 에서 5분 이상 멈춘 실측이 근거다 | `lib/collect/browser.mjs` | R-BROWSER-4 |
| `lib/browser.mjs:45` | `SCROLL_BUDGET_MS` | reuse-as-is | 같음 | `lib/collect/browser.mjs` | R-BROWSER-4 |
| `lib/browser.mjs:47` | `SHOT_MAX_HEIGHT` | reuse-as-is | 캡처 높이 상한. v2 는 잘림을 warning 으로 남긴다(PLAN 4-6) | `lib/collect/browser.mjs` | R-BROWSER-5 |
| `lib/browser.mjs:53` | `fetchWithBrowser` | copy-and-rewrite | goto·스크롤·캡처·final_url·status·title 은 그대로 쓸 만하다. 세 군데를 걷어내야 한다 — `tier:'chrome'` 실제 크롬 분기(L61-63), `collectCards` 카드 자리 수집 블록(L145-185), `ok: !challenge` 판정(L194). 산출물도 요청한 것만 만들도록 outputs 인자를 받는다 | `lib/collect/browser.mjs` | R-BROWSER-1, R-BROWSER-2, R-BROWSER-5, R-FORBID-1 |

## lib/discover.mjs

| 대상 | 심볼 | 판정 | 이유(근거 줄) | 새 위치 후보 | 회귀 시험 |
|---|---|---|---|---|---|
| `lib/discover.mjs:23` | `SITEMAP_GUESSES` | reuse-as-is | 선언이 없을 때 찔러 볼 표준 경로 셋 | `lib/map/sitemap.mjs` | R-MAP-1 |
| `lib/discover.mjs:25` | `SITEMAP_DEPTH_MAX` | reuse-as-is | index 깊이 상한. PLAN 7-2 의 상한 목록에 그대로 있다 | `lib/map/sitemap.mjs` | R-MAP-2 |
| `lib/discover.mjs:29` | `RUN_TTL_MS` | reject | 실행권 잠금 수명. v2 는 실행권 대신 임대를 쓴다 | — | R-FORBID-1 |
| `lib/discover.mjs:31` | `nowMs` | reuse-as-is | 시각 한 곳 | `lib/map/sitemap.mjs` | R-MAP-1 |
| `lib/discover.mjs:36` | `XML_ENTITIES` | reuse-as-is | XML 엔티티 표 | `lib/map/sitemap.mjs` | R-MAP-3 |
| `lib/discover.mjs:37` | `decodeXmlText` | reuse-as-is | 십진·십육진 수치 참조까지 다룬다. 순수 함수 | `lib/map/sitemap.mjs` | R-MAP-3 |
| `lib/discover.mjs:46` | `tagValues` | reuse-as-is | 태그 값 추출. 순수 함수 | `lib/map/sitemap.mjs` | R-MAP-3 |
| `lib/discover.mjs:59` | `sitemapRoot` | reuse-as-is | 뿌리 요소가 urlset·sitemapindex 가 아니면 사이트맵으로 인정하지 않는다. 200 오류 HTML 을 빈 사이트맵으로 삼키던 사고를 막은 함수(L53-58) | `lib/map/sitemap.mjs` | R-MAP-4 |
| `lib/discover.mjs:71` | `urlEntries` | reuse-as-is | loc·lastmod 추출. 순수 함수 | `lib/map/sitemap.mjs` | R-MAP-3 |
| `lib/discover.mjs:82` | `childSitemaps` | reuse-as-is | index 의 자식 목록. 순수 함수 | `lib/map/sitemap.mjs` | R-MAP-2 |
| `lib/discover.mjs:95` | `classifyKind` (재export) | reject | 목록·상세 의미 추측. PLAN 9-2 금지 목록 | — | R-FORBID-1 |
| `lib/discover.mjs:98` | `PROFILE_STATES` | reject | 사이트별 카드 규칙(domain-profile) 상태값 | — | R-FORBID-1 |
| `lib/discover.mjs:100` | `profileFile` | reject | 같음 | — | R-FORBID-1 |
| `lib/discover.mjs:103` | `readProfile` | reject | 같음 | — | R-FORBID-1 |
| `lib/discover.mjs:105` | `requireText` | reject | 프로필 전용 입력 검증기. 프로필과 함께 사라진다 | — | R-FORBID-1 |
| `lib/discover.mjs:111` | `pushHistory` | reject | 프로필 상태 전이 기록 | — | R-FORBID-1 |
| `lib/discover.mjs:116` | `proposeProfile` | reject | 관측으로 카드 선택자를 제안. 의미 자동 판단 | — | R-FORBID-1 |
| `lib/discover.mjs:139` | `pathShape` | reject | 경로 모양으로 목록·상세를 추측 | — | R-FORBID-1 |
| `lib/discover.mjs:144` | `confirmProfile` | reject | 프로필 확정 | — | R-FORBID-1 |
| `lib/discover.mjs:160` | `overrideProfile` | reject | 프로필 수동 덮어쓰기 | — | R-FORBID-1 |
| `lib/discover.mjs:184` | `canonicalOrigin` | reuse-as-is | origin 표준형. 순수 함수이고 `map_domain` 이 그대로 필요하다 | `lib/map/sitemap.mjs` | R-MAP-5 |
| `lib/discover.mjs:188` | `originKey` | copy-and-rewrite | origin 해시로 파일 이름을 만든다. v2 는 도메인을 DB 키로 쓰므로 파일 이름표 용도로만 남긴다 | `lib/artifacts.mjs` | R-MAP-5 |
| `lib/discover.mjs:189` | `progFile` | reject | 파일 기반 진행 상태. v2 는 attempts 테이블 | — | R-FORBID-1 |
| `lib/discover.mjs:195` | `snapFile` | reject | 사이트맵 스냅샷 파일 규약. v2 는 artifacts/maps | — | R-FORBID-1 |
| `lib/discover.mjs:198` | `runLockDir` | reject | 실행권 잠금 폴더 | — | R-FORBID-1 |
| `lib/discover.mjs:201` | `loadProg` | reject | 진행 상태 읽기 | — | R-FORBID-1 |
| `lib/discover.mjs:202` | `saveProg` | reject | 진행 상태 쓰기 | — | R-FORBID-1 |
| `lib/discover.mjs:203` | `clearProg` | reject | 진행 상태 삭제 | — | R-FORBID-1 |
| `lib/discover.mjs:207` | `doneFile` | reject | 끝난 회차 표시 파일. 자동 완료 판정의 저장소 | — | R-FORBID-1 |
| `lib/discover.mjs:210` | `loadDone` | reject | 같음 | — | R-FORBID-1 |
| `lib/discover.mjs:211` | `clearDone` | reject | 같음 | — | R-FORBID-1 |
| `lib/discover.mjs:213` | `emptyProg` | reject | 진행 상태 뼈대 | — | R-FORBID-1 |
| `lib/discover.mjs:237` | `discover` | reject | 385줄 안에서 임대(L319)·재큐(L322)·fetch(L336)·report(L357)·자동 addUrls(L310,L474)·완료 선언(L581)을 모두 한다. v2 는 이 일을 `map_domain`·`next`·`collect`·`report` 로 쪼갠다. 버튼 하나는 한 가지 일만 한다(PLAN 2-1) | — | R-FORBID-1 |
| `lib/discover.mjs:622` | `reuseFinished` | reject | 끝낸 회차를 자동 재사용하고 done 을 선언한다. 조사 완료 판단은 상위 에이전트 몫 | — | R-FORBID-1 |
| `lib/discover.mjs:638` | `notMyTurn` | reject | 실행권 경합 응답. 임대 계약으로 대체 | — | R-FORBID-1 |
| `lib/discover.mjs:652` | `contentSignature` | copy-and-rewrite | 지문 발상은 쓴다. 다만 공백을 뭉갠 뒤 앞 16자만 쓰므로(L653) artifact 무결성 확인에는 약하다. v2 는 저장한 바이트 전체의 SHA-256 을 쓴다 | `lib/artifacts.mjs` | R-ARTIFACT-1 |
| `lib/discover.mjs:659` | `recordContentSignature` | reject | 지문이 같으면 `suspected_duplicate_of` 를 장부에 박는다(L670). 같은 내용인지의 판단은 에이전트 몫이고, MCP 는 사실만 남긴다 | — | R-FORBID-1 |

## tests/gate1.mjs — 임대 경합·만료·늦은 보고

시험은 계약을 옮기는 것이지 코드를 옮기는 것이 아니다. 저장이 파일에서 SQLite 로 바뀌므로
대부분 `copy-and-rewrite` 이고, 검사하는 성질은 그대로 간다.

| 대상 | 심볼 | 판정 | 이유(근거 줄) | 새 위치 후보 | 회귀 시험 |
|---|---|---|---|---|---|
| `tests/gate1.mjs:40` | `case1-tracking-merge` | copy-and-rewrite | 추적 파라미터만 다른 셋이 한 id 로 합쳐지는지. v2 는 id 가 아니라 `canonical_url` 로 견준다 | `tests/regress/url.mjs` | R-URL-1 |
| `tests/gate1.mjs:48` | `case2-functional-keep` | copy-and-rewrite | `goodsNo` 가 다르면 다른 항목인지. 같은 성질을 canonical_url 로 다시 쓴다 | `tests/regress/url.mjs` | R-URL-2 |
| `tests/gate1.mjs:62` | `runChild` | copy-and-rewrite | 자식 프로세스로 진짜 동시성을 만든다. `CLAUDE_PROJECT_DIR` 주입 방식(L65)까지 그대로 쓸 만하다 | `tests/regress/lease.mjs` | R-LEASE-1 |
| `tests/gate1.mjs:78` | `BARRIER` | reuse-as-is | 공통 시작 시각까지 바쁜 대기해 같은 순간에 임계 구역으로 넣는다. 이게 없으면 잠금을 완전히 꺼도 시험이 통과한다고 L75-77 에 실측이 적혀 있다. 그대로 가져간다 | `tests/regress/lease.mjs` | R-LEASE-1 |
| `tests/gate1.mjs:56` | `case3-concurrent-lease` | copy-and-rewrite | 6개 프로세스가 동시에 임대해도 중복 0. v2 는 같은 성질을 `next` 와 SQLite 트랜잭션으로 검사한다(게이트 2는 10프로세스·1,000건) | `tests/regress/lease.mjs` | R-LEASE-1 |
| `tests/gate1.mjs:112` | `case4-lease-expiry` | copy-and-rewrite | TTL 이 지나면 새 토큰으로 재배정. v2 는 `lease_expires_at` 회수로 다시 쓴다 | `tests/regress/lease.mjs` | R-LEASE-2 |
| `tests/gate1.mjs:127` | `case5-stale-report` | copy-and-rewrite | 옛 토큰의 늦은 report 가 `stale_lease_token` 으로 거절되는지. v2 report 의 lease 검사와 같은 성질 | `tests/regress/lease.mjs` | R-LEASE-3 |
| `tests/gate1.mjs:133` | `case6-idempotent-report` | copy-and-rewrite | 같은 report_id 두 번에 한 번만 반영되고 최종 상태가 첫 것으로 남는지 | `tests/regress/lease.mjs` | R-LEASE-4 |
| `tests/gate1.mjs:143` | `case7-global-pace` | copy-and-rewrite | 6개 프로세스가 동시에 예약해도 정확히 하나만 통과. v2 는 workspace 가 달라도 같은 도메인이면 유지되는지로 넓힌다(#5 pace spike) | `tests/regress/pace.mjs` | R-PACE-1 |
| `tests/gate1.mjs:163` | `case8-lock-kill-recovery` | copy-and-rewrite | 잠금 보유 프로세스를 SIGKILL 해도 회수되는지. 기제는 하드링크 잠금에서 DB 트랜잭션·만료 회수로 바뀌지만 검사하는 성질은 같다. `stale 보존` 단언은 v2 에 대응물이 없어 뺀다 | `tests/regress/lease.mjs` | R-LEASE-5 |
| `tests/gate1.mjs:203` | `case9-restart-state` | reject | 새 프로세스에서 `state.json` 을 읽어 상태가 같은지. v2 는 이중 상태를 두지 않으므로 이 형태의 시험은 성립하지 않고, DB `integrity_check` 와 재개방으로 대체한다(#5·게이트 1) | — | R-FORBID-1 |

## 회귀 시험 ID 목록

구현 태스크가 이 ID 를 그대로 달아 시험을 만든다. 아직 하나도 작성되지 않았다.

| ID | 검사할 성질 | 담당 태스크 |
|---|---|---|
| R-URL-1 | 추적 파라미터만 다른 주소가 한 canonical_url 로 합쳐진다 | #11 |
| R-URL-2 | 기능성 파라미터가 다르면 다른 항목으로 남는다 | #11 |
| R-URL-3 | 정렬 파라미터를 기본으로 지우지 않는다 | #11 |
| R-URL-4 | 기본 포트·끝 슬래시·대소문자 호스트가 정규화된다 | #11 |
| R-URL-5 | URL 의 사용자명·비밀번호가 거절된다 | #11 |
| R-URL-6 | 파생 id 가 중복 판정에 쓰이지 않는다(canonical_url 이 열쇠) | #13 |
| R-URL-7 | `www.` 만 무시하고 호스트를 견준다(등록 도메인 판정이 아니다) | #11 |
| R-TEXT-1 | text 산출물이 블록 경계를 살리고 본문을 임의로 지우지 않는다 | #26 |
| R-ARTIFACT-1 | artifact 지문이 저장한 바이트 전체의 SHA-256 과 일치한다 | #23 |
| R-PACE-1 | 여러 프로세스가 동시에 예약해도 하나만 통과하고 간격이 지켜진다 | #24 |
| R-PACE-2 | 403 한 번으로 자동 장기 휴면하지 않는다 | #24 |
| R-PACE-3 | pace 레코드가 프로세스 재시작 뒤에도 이어진다 | #24 |
| R-PACE-4 | 선택 인자의 `undefined` 가 기본값을 지우지 않는다 | #24 |
| R-BROWSER-1 | browser 모드가 요청한 산출물만 만들고 실제 크롬을 쓰지 않는다 | #29 |
| R-BROWSER-2 | 차단 화면은 warning 으로만 남고 수집 성공 판정을 뒤집지 않는다 | #29 |
| R-BROWSER-3 | manifest 에 viewport·배율이 남아 좌표를 되짚을 수 있다 | #29 |
| R-BROWSER-4 | 무한 스크롤 페이지가 상한 안에서 끝나고 상한 도달을 남긴다 | #29 |
| R-BROWSER-5 | 캡처 높이 상한 초과가 warning 으로 남는다 | #29 |
| R-MAP-1 | 선언이 없을 때 표준 사이트맵 경로를 찔러 본다 | #33 |
| R-MAP-2 | sitemap index 깊이 상한에서 멈추고 상한 도달을 남긴다 | #33 |
| R-MAP-3 | XML 엔티티·loc·lastmod 를 정확히 뽑는다 | #33 |
| R-MAP-4 | 200 으로 온 오류 HTML 을 빈 사이트맵으로 삼키지 않는다 | #33 |
| R-MAP-5 | origin 표준형이 같은 도메인을 하나로 묶는다 | #34 |
| R-LEASE-1 | 여러 프로세스가 같은 순간에 임대해도 중복 0 (배리어 포함) | #16 |
| R-LEASE-2 | 만료된 임대가 회수되어 새 토큰으로 재배정된다 | #17 |
| R-LEASE-3 | 옛 토큰의 늦은 report 가 거절된다 | #17 |
| R-LEASE-4 | 같은 report 를 두 번 보내도 한 번만 반영된다 | #18 |
| R-LEASE-5 | 강제 종료된 워커의 작업만 회수되고 나머지는 유지된다 | #17 |
| R-FORBID-1 | 새 runtime 이 LEGACY·금지 모듈·금지 토큰을 쓰지 않는다 | #7(server-only 재확인) · lib 가 생긴 뒤 #15 부터 매 게이트 |

## 검사 명령

```
# 이 감사 문서와 금지 목록의 자체 검증 (표 누락·판정값·중복·필수 금지군)
cd ~/.claude/tools/web-search && node tests/baseline/verify-reuse-audit.mjs

# 새 runtime 의 LEGACY·금지 모듈 import 검사 (rg 단독)
cd ~/.claude/tools/web-search && rg -n -g '/server.mjs' -g '/lib/**/*.mjs' \
  -e "from ['\"][^'\"]*LEGACY" \
  -e "from ['\"][^'\"]*(cards|judge|kind|pagination)\.mjs" \
  -e "domain-profiles|wake_details|crop_cards|field/(worker|launch)\.mjs" .

# 금지 토큰 검사 (forbidden-imports.json 의 목록을 그대로 사용)
cd ~/.claude/tools/web-search && node tests/baseline/verify-reuse-audit.mjs --scan
```

검사 범위는 `server.mjs` 와 `lib/**/*.mjs` 뿐이다. `LEGACY/`, `tests/`, `*.md`, `*.json` 은
금지 이름을 인용해야 하는 자리라 제외한다 — 넣으면 이 문서 자체가 위반으로 잡힌다.

**이름이 같다고 금지가 아니다.** 막는 것은 두 갈래다. 하나는 `LEGACY/` 아래의 옛 코드를 불러
쓰는 것이고, 다른 하나는 `cards`·`judge`·`kind`·`pagination`·`domain-profiles`·`wake_details`·
`field/worker`·`crop_cards` 처럼 이름 자체가 v2 에서 하지 않기로 한 일을 가리키는 경우다.
`paths.mjs`·`store.mjs`·`pace.mjs` 같은 이름은 v2 가 새로 만들어 쓴다 — #8 이 새 `lib/paths.mjs` 를,
#24 가 새 `lib/pace.mjs` 를 만들라고 한다. 위 표에서 옛 함수가 reject 여도 그 파일 이름을
v2 가 다시 쓰는 것은 위반이 아니다. 계약이 다르면 다른 코드다.

glob 앞의 슬래시는 검사 뿌리에 고정하라는 뜻이다. 빼면 `LEGACY/server.mjs` 와
`LEGACY/lib/*.mjs` 까지 걸려 감사가 자기 자신을 위반으로 센다(2026-08-12 실측으로 확인).

**지금 결과가 0건인 이유를 오해하면 안 된다.** 2026-08-12 기준 runtime 파일은 `server.mjs`
하나이고 `lib/` 는 아직 없다. 그래서 0건은 "지켰다"가 아니라 "검사할 새 코드가 아직 없다"는
뜻이다. 다시 도는 시점은 이렇다. **게이트 0(#7)은 #8 보다 앞이라** 그때도 runtime 은
`server.mjs` 뿐이고, 거기서는 server-only 기준의 위반 0 과 이 문서·규칙 파일의 자기 일관성만
다시 확인한다. `lib/` 는 #8 에서 처음 생기므로, 실질 검사는 그 뒤의 각 구현 태스크와
**게이트 1(#15)부터의 모든 게이트**에서 `full_verify` 를 다시 돌려 이뤄진다.
