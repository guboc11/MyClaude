# 게이트 3 — 산출물 다섯 종·교차 연결·중간 종료

판정: **PASS** (12항목) · 실행: 2026-08-12 · Node v22.21.0 · chromium 148.0.7778.96
재실행 확인: 두 가지 부름 방식(프로젝트에서 직접 / 도구 폴더 + `CLAUDE_PROJECT_DIR`)으로 각각
게이트 0·1·2·3 을 **연속 2회** 돌려 여덟 번 모두 exit 0
태스크: `2026-08-12-web-search-MCP-v2-rebuild#32` · 근거 계획: `_PLAN/2026-08-11-web-search-mcp/PLAN.md` 게이트 3

기계 판독 결과: [gate3.json](gate3.json) · 앞 게이트: [gate2.md](gate2.md)

## 한 번에 다시 돌리는 법

```
cd <playwright 가 있는 프로젝트> && node ~/.claude/tools/web-search/tests/gate3.mjs
node tests/gate3.mjs --json
```

**playwright 가 있는 자리에서 돌려야 한다.** 브라우저 수집(#29·#30)이 게이트 3 의 범위이기 때문이다.
못 찾으면 G3-2 가 **건너뛰지 않고 실패한다** — 게이트가 환경 때문에 조용히 헐거워지면 그 게이트는
없는 것과 같다. 도구 폴더에서 돌린 실행에서 실제로 이 항목만 FAIL 하는 것을 확인했다.

구성 시험은 자식 프로세스로 돌려 실제 종료 코드를 받고, 통합 확인은 임시 git 프로젝트에
**진짜 MCP 서버를 stdio 자식으로 띄워 버튼으로만** 한다.

## 이번에 선 것

| 태스크 | 만든 것 |
|---|---|
| #22 | `tests/fixtures/server.mjs`·`manifest.json` — 여덟 종류 로컬 사이트와 계약 |
| #23 | `lib/attempts.mjs`·`lib/artifacts.mjs` — 원자적 저장과 요약 |
| #24 | `lib/pace.mjs` — 전역 예약식 속도 제한 |
| #25 | `lib/http.mjs`·`lib/robots.mjs` — 목적지 검사·연결 고정·상한 |
| #26 | `lib/collect/{html,extract-text,extract-links,http}.mjs` — text·dom·links |
| #27 | `lib/collect/{extract-images,images}.mjs` — 그림 참조와 내려받기 |
| #28 | `lib/collect/index.mjs`·`collect` 버튼 — 임대·예약·상태 전환 |
| #29 | `lib/collect/browser.mjs` — 렌더 DOM·전체 캡처 |
| #30 | `lib/collect/browser-images.mjs` — currentSrc·CSS 배경·실제 응답 |
| #31 | `lib/errors.mjs` — 관찰·실패 낱말과 status 연결 |

공개 버튼은 일곱이다: `workspace_new`, `add_urls`, `next`, `collect`, `report`, `retry`, `status`.
남은 셋은 `search`·`map_domain`·`export` 다.

## 항목별 판정

| 항목 | 내용 | 결과 |
|---|---|---|
| G3-1 | 수집 계층 구성 시험 8묶음 260항목 | PASS |
| G3-2 | 브라우저 구성 시험 2묶음 52항목 | PASS |
| G3-3 | fixture 8종에서 요청하지 않은 산출물 0 | PASS |
| G3-4 | screenshot+http 는 네트워크 전에 거절 | PASS |
| G3-5 | 원문은 파일에만 · MCP 응답 4KB 이내 | PASS |
| G3-6 | 요청·최종 URL 과 상태·경고 대조 | PASS |
| G3-7 | 수집 도중 강제 종료 — 만들다 만 것이 artifact 로 안 보임 | PASS |
| G3-8 | 이미지 manifest 와 실제 파일·지문 전수 일치 | PASS |
| G3-9 | 무작위 30개 item 에서 URL·자료 교차 연결 0 | PASS |
| G3-10 | LEGACY 불변 · 금지 import 0 | PASS |
| G3-11 | 게이트 자체가 127.0.0.1 밖으로 나가지 않음 | PASS |
| G3-12 | 이 게이트가 낸 관찰이 모두 낱말표에 있음 | PASS |

### 실제 수치

**구성 시험 312항목.** fixture 18 · artifacts 48 · pace 36 · network 35 · collect-http 43 · images 26 ·
collect-run 29 · diagnostics 25 = 260, 여기에 browser 31 · browser-images 21 = 52 를 더한다.

**요청한 것만 만든다.** 여덟 종류에 각각 다른 조합을 시켜(`text` 하나부터 `text·dom·links` 셋까지)
실행 폴더의 파일 목록을 하나하나 셌다. 시킨 것과 정확히 같고, 안 시킨 `screenshot.png` 는 어디에도 없다.

**응답 최대 399바이트.** 상한 4,096 의 10% 다. 여덟 응답 어디에도 `<html`·본문 조각이 없다.
원문은 파일에만 있다.

**대조표.** 리다이렉트는 `/redirect/one → /redirect/arrived` 에 `redirected`, 상태 200 오류 화면은
`error_page_text_detected` 만(그리고 판정은 success), 404 는 `http_error_status`, 그림 일부 실패는
`image_fetch_partial` 에 partial. 여섯 자리가 모두 기대대로이고, 모든 줄에 요청 URL 과 최종 URL 이 있다.

**교차 연결 0.** 서로 다른 30개 쪽(`/unique/1`~`/unique/30`)을 한 임대로 수집했다. 각 항목의
`text.txt` 에 **제 표지만** 있고 남의 표지는 0건, 링크 장부는 제 다음 쪽을 가리키고, 요약 경로도
`artifacts/pages/<제 item_id>/` 아래다.

**그림 전수 대조.** manifest 의 성공 줄 10개를 실제 파일·크기·지문·장부 줄과 하나하나 맞췄다.
실패 줄에 경로가 붙은 것은 0건이다.

**강제 종료.** `/hang/body`(머리만 주고 본문을 안 끝내는 쪽)를 받는 도중에 서버를 SIGKILL 했다.
다시 열어 보니 도중에 끊긴 실행 1건이 열린 채로 남아 있고, 장부에 든 임시 파일 0 · 없는 파일 0 ·
지문 어긋남 0 · 고아 0 이다.

## 만드는 동안 실제로 걸린 것

**강제 종료 시험이 헛돌고 있었다.** 처음에는 12MB 쪽(`/long/huge`)을 받는 도중에 끊으려 했는데,
루프백으로 12MB 는 900ms 안에 끝나 버려 SIGKILL 이 **수집이 다 끝난 뒤에** 떨어졌다. 그래도 항목은
PASS 했다 — 아무 일도 없었으니 어긋난 것도 없었기 때문이다. 통과했지만 아무것도 증명하지 못한
시험이었다. 확실히 도중에 있게 되는 쪽(`/hang/body`)으로 바꾸고, **"도중에 끊긴 실행이 1건 이상"**
을 판정 조건에 넣었다. 그 조건이 없으면 이 항목은 언제든 다시 헛돌 수 있다.

**잘린 그림 하나가 도메인 전체를 60초 세웠다.** `/img/truncated/*` 가 소켓을 끊자 pace 가 물러남
60초를 걸었고, 다음 항목이 그만큼 기다리다 게이트의 응답 대기 시간을 넘겼다. 물러남 자체는 옳다 —
상대가 응답을 끊었으면 잠시 물러나는 것이 맞다. 문제는 **그 폭을 정할 문이 없었다**는 것이다.
`--pace-retry-backoff-ms` 를 더해 다른 두 pace 설정과 같은 자리(argv 전용, 버튼 입력 불가)에 두었다.
아울러 기다린 시간이 보이도록 `waited_ms` 를 색인 줄에 남겼다 — 오래 걸린 이유가 상대 서버인지
우리 정책인지 갈라 볼 수 있어야 한다.

**게이트가 검사 대상을 지웠다.** G3-10 이 `baseline.mjs --check` 를 불렀는데 그런 깃발은 없었다.
그때 baseline.mjs 는 `--verify` 가 아니면 무엇이든 "기록" 으로 받아, 얼려 둔 기준선을 조용히 덮어썼다.
`--project` 도 안 줘서 프로젝트가 도구 폴더로 잡혔고, 그 자리엔 `.claude/web-search` 가 없으니
**기존 수집 데이터가 `exists: false · 0개` 로 얼어붙었다.** 덮어쓰기는 언제나 성공하니 게이트는
PASS 를 냈다 — 검사하는 척하며 검사 대상을 지운 것이다. 다음 게이트 0 실행에서 드러났다.

데이터는 무사했다. 다시 재니 1,365개 · 60,810,131바이트로 #1 의 기록과 정확히 같다. 고친 것은 셋이다:
baseline.mjs 가 **모르는 깃발을 거절하고**(뿌리 원인은 "모르면 쓰기" 라는 기본값이었다), 기록은
`--write` 로 명시해야 하며 이미 있으면 `--force` 까지 필요하고, G3-10 은 `--verify --project` 로 부른다.
자세한 것은 [tests/baseline/README.md](../baseline/README.md) 의 사고 기록에 있다.

**시험이 조건을 만들지 않고 믿었다.** 독립 재검증에서 `tests/collect-run/verify.mjs` 가 환경에 따라
통과했다 깨졌다 했다. B2 는 "playwright 가 없으면 정직하게 실패한다" 를 재려고 가짜 `depsDir` 를
건넸는데, `resolvePlaywright` 는 `depsDir → CLAUDE_PROJECT_DIR → cwd → 도구 폴더` 순으로 찾는다.
**나머지 세 길을 안 막았다.** 환경에 `CLAUDE_PROJECT_DIR` 가 있는 자리에서는 playwright 가 발견되어
browser 모드가 실제로 돌았고, 실패를 기대하던 줄이 `null.stage` 로 터졌다.

감독관은 상태 누적을 의심했지만 재현해 보니 아니었다 — `CLAUDE_PROJECT_DIR` 유무만으로 결정적으로
갈렸다(없으면 통과, 있으면 크래시). 조건을 믿는 대신 **만들도록** 고쳤다:
`tests/collect-run/no-deps-child.mjs` 를 node_modules 가 없는 임시 폴더에서, 그 두 환경변수를 지운 채
자식 프로세스로 띄운다. 자식이 먼저 "여기서 playwright 가 정말 안 잡힌다" 를 확인하고, 그 위에서만
판정한다. 고치는 김에 기대값도 바로잡았다 — 실패한 실행에도 **요약은 남아야 하고**(#23) 산출물만
없어야 하는데, 처음에는 폴더가 통째로 비어 있기를 기대했다.

곁가지로 같은 부류의 잠재 결함을 하나 닫았다. `loadChromium` 이 첫 성공을 하나만 기억해서,
나중에 다른 `depsDir` 를 줘도 조용히 앞의 것을 썼다 — "어디 것을 썼나" 에 코드가 거짓을 말할 수
있었다. 찾은 자리별로 기억하게 바꿨다.

## 앞 태스크에서 고친 것

**요약의 `produced_outputs` 가 `missing_outputs` 와 다른 말을 쓰고 있었다.** 요청한 산출물 이름이
아니라 artifact 종류를 늘어놓아, 그림 아홉 장이 `image` 아홉 개로 나왔다. 그러면 "무엇을 만들고
무엇이 빠졌나" 를 견줄 수가 없다. 둘 다 요청한 이름으로 말하게 고쳤다(낱낱의 파일은 `artifacts`
목록에 이미 다 있다).

**시점에 못 박힌 시험 셋을 불변식으로 바꿨다.** "브라우저에 images 는 아직 없다"(#30 이 깨뜨림),
"경고 0건"으로 "판정 안 함"을 갈음한 둘(#31 이 정당한 관찰을 더하자 깨짐). 게이트 2 뒤에 겪은
G1-13 과 같은 함정이라, 이번에는 대용 대신 뜻을 직접 적었다 — 판정 칸 다섯 종이 없는 것,
선언한 산출물만 만드는 것.

## 지금 알려진 한계

- **브라우저 모드는 연결 대상 IP 를 고정하지 못한다.** 요청마다 목적지 검사와 속도 예약은 하지만
  검사 뒤 연결 직전의 DNS 변화(rebinding)는 막지 못한다. 그래서 브라우저 결과에는 성공해도
  `browser_no_pinned_connection` 이 붙고, 도구 설명과 버튼 응답에도 같은 문장이 실린다.
- **브라우저 수집은 부른 프로젝트에 playwright 가 있어야 한다.** 도구 폴더에는 `package.json` 도
  `node_modules` 도 없다. 없으면 `deps/playwright_not_found` 로 실패하고 어디를 찾아봤는지 말한다 —
  조용히 http 로 갈아타지 않는다. 최종 보고의 명시 항목이다.
- **TLS 는 인증서 검증까지 실측하지 못했다.** 로컬 fixture 가 평문 HTTP 라 handshake 실패 경로만
  코드에 있다. 인증서 이름 검증은 Node 기본 동작에 맡기며 `lookup` 만 갈아 끼워 그 동작을 살렸는데,
  **그렇게 설계했다는 것이지 측정했다는 뜻은 아니다.**
- **`search`·`map_domain`·`export` 셋이 없다.** 계약 시험은 그 셋에서만 실패한다.
  `search` 는 무키 공급자를 못 찾아 미완료로 남는다([decision.md](../spikes/search-provider/decision.md)).
- **물러남이 걸리면 collect 한 번이 길어진다.** 기본 물러남 1분, 천장 5분, 한 항목의 기다림 상한
  2분이다. 그보다 길면 그 항목만 `pace/queue_too_long` 으로 실패하고 나머지는 계속 간다.
- **`node:sqlite` 는 실험 기능이다.** 최소 버전은 확인하지만 API 안정성은 보장하지 못한다.

## 다음

게이트 3 전 항목 PASS 이므로 #33 부터 진행한다. robots·sitemap 파서와 `map_domain` 을 만들고
게이트 4 에서 발견 범위와 비재귀를 검증한다.
