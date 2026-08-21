# web-search MCP — 매뉴얼

사이트를 정해진 경계 안에서 훑어 **목록의 카드**와 **상세 페이지**를 모으는 도구다.
검색 엔진이 아니다. "무엇이든 찾아 준다"가 아니라 "정한 범위를 빠짐없이, 두 번 안 세고 모은다"가 목적이다.

- 계획서: `_PLAN/2026-08-11-web-search-mcp/PLAN.md` (dibang 저장소)
- 도구 자리: `/Users/taewonpark/.claude/tools/web-search/`
- 게이트 합격 기록: `tests/gate4-report.md`

## 이 도구가 하는 일 / 안 하는 일

| 한다 | 안 한다 |
|---|---|
| robots·사이트맵·내부 링크로 주소 찾기 | 검색어로 웹 전체 뒤지기 |
| 경계(도메인·경로·상한) 안에서만 큐에 넣기 | 경계 밖으로 알아서 넘어가기 |
| curl → Jina → 헤드리스 → 실제 크롬으로 단계 올리기 | 로그인 뚫기, CAPTCHA 풀기 |
| 목록 화면에서 카드 잘라 저장(안정 ID + 잘린 그림) | 사이트가 안 보여 준 값 추측하기 |
| 무엇이 왜 빠졌는지 근거로 남기기 | 조용히 잘라 놓고 "다 봤다" 하기 |

## 어떻게 붙어 있나

user scope(`~/.claude.json`)에 등록돼 있다. 어느 프로젝트에서 열든 도구가 보인다.

```
type=stdio  command=node
args=["/Users/taewonpark/.claude/tools/web-search/server.mjs"]
env={ WEBSEARCH_DEPS_DIR: "/Users/taewonpark/Github/WORK/GoraeUniverse/dibang" }
```

- `WEBSEARCH_DEPS_DIR` — jsdom·playwright가 이 도구 폴더가 아니라 dibang의 `node_modules`에 있어서 가리킨다.
  라이브러리를 어디서 찾을지만 정하는 값이다.
- `CLAUDE_PROJECT_DIR`은 **일부러 안 박았다.** 산출물은 도구를 부른 프로젝트에 남아야 한다.

**산출물 자리**: `<부른 프로젝트>/.claude/web-search/`
- `<크롤이름>/` — `policy.json`(경계), `state.json`(장부), `events.jsonl`(이력),
  `manifests/<url_id>/`(가져온 증거·캡처·카드 그림), `reports/cycle-N.md`, `snapshots/N/`
- `global/pace/` — 도메인별 속도 장부. 크롤이 여럿이어도 한 사이트를 두드리는 속도는 하나다.

## 도구 22개 — 인자와 돌아오는 값

돌아오는 값은 모두 **짧은 글**이다. 웹 본문은 절대 안 올라오고, `discover` 가 찾은 주소 무더기도
개수와 보고서 경로로만 돌아온다(그게 곧 컨텍스트 비용이다). 긴 것은 파일에 쓰고 경로만 준다.
예외는 `lease` 다 — 맡긴 주소와 표(`lease_token`)는 워커가 일하려면 손에 쥐어야 하니 목록으로 준다.

### 크롤 만들기·경계

| 도구 | 필수 | 선택 | 성공하면 | 대기·거절이면 |
|---|---|---|---|---|
| `crawl_new` | `crawl` | `seeds`, `policy` | `크롤 생성: 이름` + mode·씨앗 수(중복 수)·크롤 폴더 경로 | 경계 밖 씨앗·mode 충돌·이미 있는 이름이면 오류로 거절하고 **반쪽 폴더를 안 남긴다** |
| `update_policy` | `crawl`, `patch`, `who`, `reason` | 없음 | 바뀐 키와 사유, 세워 뒀던 후보 중 큐로 돌아간 수와 남은 수, 검토 내림 여부 | 고정 키·좁히는 방향·범위 밖·빈 `patch`·`who`/`reason` 빈 값이면 오류 |
| `crawl_list` | 없음 | 없음 | `크롤 N개:` + 이름 목록 + 저장 뿌리 경로 | 없으면 `크롤이 없습니다.` + 경로 |

### 주소 찾기·넣기

| 도구 | 필수 | 선택 | 성공하면 | 대기·거절이면 |
|---|---|---|---|---|
| `discover` | `crawl`, `origin` | `skip_sitemaps`, `sitemap_seeds`, `refresh`, `worker` | `발견 N · 중복 M · 네트워크 K회`, 사이트맵 방문 수, lastmod 새것/바뀐것/그대로, 사라짐·다시 나타남, 보고서 경로 | 속도 예약에 걸리면 `아직 안 끝났습니다 — N초 뒤 같은 호출로 이어 부르세요`(진행 보존). 남이 같은 origin을 돌고 있으면 `already_running`으로 아무것도 안 건드림. 사이트맵 깊이 상한이면 `경계에서 멈췄습니다(needs_boundary_review)`. 이미 끝낸 회차면 네트워크 0회로 지난 결과 + `refresh: true` 안내 |
| `add_urls` | `crawl`, `urls` | `kind`, `via`, `from_url_id`, `depth`, `discovered_by`, `base` | `추가 N · 중복 M · 거절 K (사유)` | 거절 사유가 그대로 붙는다 — `denied_domain`, `external_hop_exceeded`, `unknown_parent`, 상한류(`path_shape_cap` 등)는 버리지 않고 후보로 세워 둠 |
| `normalize` | `url` | `base` | 정규화된 주소, `id=`, `domain=`, 지운 파라미터 | 주소가 아니면 오류 |

### 빌리고·열고·반납하기

| 도구 | 필수 | 선택 | 성공하면 | 대기·거절이면 |
|---|---|---|---|---|
| `lease` | `crawl` | `n`, `worker` | `N건 임대 (대기 M 남음)` + 건마다 `url_id kind url`과 `token=` | 빌려줄 게 없으면 `빌려줄 것이 없습니다. (대기 0)` |
| `fetch` | `crawl`, `lease_token` | `url`, `url_id`, `kind`, `max_tier` | 쪽 판정·추출 상태·시각 상태, `status`, 쓰인 단(tier), 카드 수/표시 수, 증거·부정·flags, 캡처와 manifest 경로 | 표가 없거나 남의 것이면 `거절: <사유> (네트워크 0회)`. 속도 예약이면 `대기 N초` + `이어갈 곳: <다음 단>`, 같은 표로 다시 부르면 끝낸 단은 다시 안 두드린다 |
| `report` | `crawl`, `items` | `report_id` | `report <id> — 반영 N · 거절 M` (+거절한 `url_id(사유)`) | 같은 `report_id`면 `이미 반영된 report 입니다(멱등)`. 표가 회수됐으면 그 건이 `stale_lease_token`으로 거절 |

### 보기·판정

| 도구 | 필수 | 선택 | 성공하면 | 대기·거절이면 |
|---|---|---|---|---|
| `status` | `crawl` | 없음 | 판 번호·mode·전체 수, 상태별 수, **완료판정과 사유**, 막힘, 같아 보이는 묶음·쪽 묶음, 안 들인 것, 사람 확인 대기, 세워 둔 후보와 경계 검토(상한·늘어난 형태), 카드 수와 표시 수 대조, 자주 나온 도메인·낱말, 빈칸 표, 회차 | 없는 이름이면 `그런 크롤이 없습니다.` + 있는 크롤 목록 |
| `evidence` | `crawl`, `what` | `limit` | `what=excluded` 안 들인 것과 사유·근거·만난 횟수 / `content_groups` 같아 보이는 묶음 / `page_series` 쪽 묶음과 마름·빈 구간 / 그 밖은 경계 검토 요약 | 해당 근거가 없으면 `…없습니다` 한 줄 |
| `cycle_report` | `crawl`, `who`, `reason` | 없음 | `N회차 보고서를 썼습니다 → 경로`와 다음 회차 번호 | 장부가 그대로면 새 회차를 안 열고 `지난 보고서: 경로` |
| `snapshot` | `crawl` | `who`, `reason`, `force`, `list` | `고정판 #N 떴습니다 — 카드 N장 · 잘린 그림 M개`, 장부 판 번호와 지문, 폴더 경로. `list: true`면 뜬 고정판 목록 | 완료가 아닌데 `force` 없으면 오류. 뜬 게 없으면 `뜬 고정판이 없습니다.` |
| `wake_details` | `crawl`, `card_ids`, `who`, `reason` | 없음 | `깨움 N건 / 요청 M건` | 상세 주소가 없거나 이미 처리된 카드는 `건너뜀: 사유 n건`, 경계에 걸리면 `경계에서 거절 K건`과 사유 |

### 도메인 프로필

| 도구 | 필수 | 선택 | 성공하면 | 대기·거절이면 |
|---|---|---|---|---|
| `profile_status` | `crawl`, `domain` | 없음 | `status=`와 목록 패턴 수, 전이 이력(언제·무엇에서 무엇으로·누가·왜) | 없으면 `제안된 프로필이 없습니다: 도메인` |
| `confirm_profile` | `crawl`, `domain`, `who`, `reason` | 없음 | `도메인: <이전> → confirmed (by 누구)`와 파일 경로 | 대상이 없거나 `who`/`reason`이 비면 오류 |
| `override_profile` | `crawl`, `domain`, `selectors`, `who`, `reason` | 없음 | `도메인: <이전> → manual_override (by 누구)`와 파일 경로 | 같음. 일반 규칙이 두 번 이상 실패한 도메인에만 쓴다 |

### 속도·잠금

| 도구 | 필수 | 선택 | 성공하면 | 대기·거절이면 |
|---|---|---|---|---|
| `pace_reserve` | `domain` | `min_interval_ms`, `jitter_ms`, `daily_cap` | `예약됨 도메인 — 다음 간격 Nms, 오늘 M건` | `대기 N초 (사유)` — 확인이 아니라 예약이라 두 쪽이 같은 틈으로 못 나간다 |
| `pace_record` | `domain` | `blocked`, `failed` | `도메인 — block_score=N, sleep_until=…` | 차단 낌새가 쌓이면 그 도메인을 재운다 |
| `pace_peek` | `domain` | 없음 | `도메인 — 오늘 N건, 대기 M초, block_score=K` | 없음(읽기만) |
| `lock_status` | `crawl` | 없음 | `잠금 있음 — pid, 경과, 만료됨, pid살아있음`과 판정 | 없으면 `잠금 없음(유휴)` |
| `repair_lock` | `crawl` | 없음 | 푼 결과와 이전 주인(pid·instance·경과) | 잠금이 없으면 `잠금이 없습니다.` |

## 상태 어휘 — 축이 셋이다

**축을 섞으면 안 된다.** 아래 셋은 서로 다른 질문에 대한 답이고, 하나가 다른 하나를 대신하지 못한다.

- `page_validity` — **쪽이 제대로 열렸나**: `content_validated`(본문 근거로 확인) /
  `needs_visual_review`(글로는 판단 못 해 사람이 눈으로 봐야 함) / `invalid`(잘못된 쪽)
- `visual` — **눈으로 확인했나**: `visual_validated`(캡처를 떠서 확인) / `visual_unverified`(안 떴거나 못 봄)
- `extraction` — **뽑을 것을 다 뽑았나**: `complete` / `incomplete`

쪽이 제대로 열렸어도 카드 추출은 미완일 수 있고, 캡처를 떴다고 해서 쪽이 유효해지지도 않는다.
`status`의 완료 판정은 세 축을 따로 본다.

**URL 상태**(`lib/store.mjs`의 `URL_STATES`, 닫힌 12개):

| 묶음 | 값 | 뜻 |
|---|---|---|
| 처리 중 | `queued` | 대기줄에 있다 |
| | `leased` | 누군가 빌려 갔다(표가 살아 있다) |
| | `fetched` | 가져왔고 아직 판정 전이다 |
| 판정됨 | `content_validated` | 본문 근거로 제대로 된 쪽이라고 확인했다 |
| | `visual_validated` | 캡처를 떠서 눈으로 확인했다 |
| | `needs_visual_review` | 글로는 판단이 안 된다. 사람이 봐야 한다 |
| | `invalid` | 잘못된 쪽이다(빈 쪽·오류 쪽 등) |
| 안 여는 것 | `excluded` | 경계 밖이라 아예 안 들였다. 사유가 남는다 |
| | `needs_boundary_review` | 상한에 닿아 세워 뒀다. 버린 게 아니라 사람 판단 대기다 |
| | `known_deferred` | 있는 건 알지만 지금은 안 연다(카드의 상세 등, `wake_details`로 깨운다) |
| 못 여는 것 | `blocked` | 사이트가 막았다. 도메인을 재우고 나중에 다시 본다 |
| | `failed_permanent` | 시도 상한까지 갔고 더 안 해 본다 |

**막는 것과 안 막는 것을 구별하라 — 목록 우선 설계의 핵심이다.**

- `known_deferred`와 `excluded`는 **완료를 막지 않는다.** 앞의 것은 목록을 먼저 보려고 상세를
  일부러 재운 상태이고, 뒤의 것은 경계 밖이라 애초에 큐에 넣지 않고 사유만 남긴 것이다.
  둘 다 증거로 남아 `evidence`·`status`에서 읽히지만, 남아 있다고 해서 미완이 되지는 않는다.
- `needs_boundary_review`와 상한에 세워 둔 후보(`boundary_candidates`)는 **막는다.**
  이건 "없어서 안 나온 것"이 아니라 "우리가 아직 안 본 것"이라서 사람 판단이 필요하다.

`status`가 실제로 보는 막는 조건은 이렇다: 대기·임대(`queued`/`leased`), 막힘
(`blocked`/`needs_visual_review`/`needs_boundary_review`), 세워 둔 후보와 경계 검토 대기 도메인,
아직 다 못 훑은 origin, 사람 확인 대기, 카드 표시 수 대조 어긋남과 추출 미완, 쉬는 중인 도메인.
하나라도 남으면 `complete`가 아니라 `paused_incomplete`다.

## 링크는 어떻게 장부로 돌아오나

쪽을 하나 열면 그 쪽에 있던 링크도 함께 본 것이다. 그 발견을 버리면 "바깥 도메인 0건"이
관찰처럼 보이지만 사실은 아무도 안 본 것이다. 그래서 이렇게 흐른다.

1. `fetch` 가 그 쪽의 나가는 링크를 `manifests/<url_id>/notes/links.json` 에 남긴다.
   HTML 은 `a[href]`, Jina 마크다운은 `[글](주소)`와 맨 주소를 뽑는다(그림은 링크가 아니다).
   note 에는 **이번 표(`lease_token`)와 최종 판정(`page_validity`)** 이 함께 묶인다.
2. `report` 가 그 표를 받아들이는 **같은 원자 변경 안에서** 그 note 를 읽어 더미에 합친다.
   워커가 report 성공 뒤 따로 `add_urls` 하면, 그 사이에 죽을 때 발견이 통째로 사라진다.

**따라가는 기준은 fetch 가 남긴 판정이다** — 워커가 보낸 `state` 는 근거가 아니다.

| note 의 판정 | 어떻게 되나 |
|---|---|
| `content_validated` | 경계 판정을 거쳐 더미에 든다. 상세로 분류된 것은 처음부터 `known_deferred` |
| `invalid` | 한 칸도 안 넓힌다. 200 을 주는 오류 쪽에도 메뉴와 바닥글은 그대로라 따라가면 거짓 양성이 번진다 |
| `needs_visual_review` | 자동으로는 안 넓힌다("아직 모른다"이지 "정상"이 아니다). 링크 기록은 지우지 않고 남는다 |

`report` 응답 끝에 `링크 본 것 N · 들인 것 M` 이 붙는다. 이 둘이 다른 이유는 중요하다 —
따라가지 않은 것도 "봤다"에는 들어가야 나중에 **0건이었다**와 **아직 안 봤다**를 가를 수 있다.
따라가지 않은 경우는 장부에 `links_not_followed` 로 사유·개수와 함께 남는다.

**출처(`provenance`)** — 들어온 주소마다 `{via, from_url_id}` 가 배열로 남는다.
`discovered_by` 는 사람이 읽는 메모이고, 권한과 다리 수의 근거는 이쪽이다.
같은 부모가 또 알려 주면 한 줄로 두고, 다른 부모가 알려 준 것은 잃지 않는다.

발견(`discover`)도 같은 길을 쓴다. 예전에는 같은 호스트가 아니면 링크를 그 자리에서 버렸는데,
그러면 두 다리 규칙이 통째로 우회됐다. 지금은 정규화만 해서 경계 판정에 넘긴다.

## 경계(policy) 계약 — 먼저 읽을 것

크롤은 저절로 멈추지 않는다. 그래서 만들 때 경계를 박고, **박은 것은 못 바꾼다.**

- **못 바꾸는 값**: `mode`, `allow_domains`, `deny_domains`, `listing_path_patterns`,
  `detail_path_patterns`, `exclude_path_patterns`, `exclude_query_keys`, `required_words`,
  `coverage_targets`, `domain_meta`, 파라미터 처리 규칙.
  바꾸려면 **새 크롤을 만든다** — 앞뒤 결과가 다른 잣대로 모이면 안 되니까.
- **넓히기만 되는 값**: `domain_url_cap`, `path_shape_cap`, `query_combo_cap`, `faceted_cap`,
  `external_hop_max`, `sitemap_depth_max`, `lease_ttl_ms`, `max_attempts`, `block_sleep_ms` 등
- **조심하는 쪽으로만**: `min_interval_ms`·`interval_jitter_ms`는 늘리기만,
  `daily_cap`·`block_threshold`는 줄이기만
- `mode`는 `exhaustive`(전수) 또는 `pilot`(표본). pilot 결과에는 표본 표시가 붙고,
  exhaustive에는 "그만둘 조건"(budget)을 둘 수 없다 — 조건을 두면 전수가 아니다.

기본값 몇 개: 간격 10초 · 흔들림 5초 · 하루 300 · 도메인당 2000 ·
경로 형태 상한 500 · 조합 상한 200 · 걸러보기 상한 50 · 바깥 이동 2 · 임대 120초.

**상한에 걸린 주소는 버려지지 않는다.** `boundary_candidates`에 세워 두고 `status`가 사유와
늘어난 경로 형태를 보여 준다. 사람이 `update_policy`로 넓히면 세워 둔 것이 그 자리에서 큐로 돌아간다.

## 완료 판정

`status`의 `completion`은 크롤 경계 안에서만 하는 말이다. 하나라도 열려 있으면 `complete`가 아니라
`paused_incomplete`다. 막는 것들:

대기·임대 남음 / 사이트맵 미완 / 세워 둔 경계 후보 / 사람 확인 대기(`review_required`) /
재우고 있는 도메인 / 카드 추출 미완(`cards_extraction_status`가 없거나 incomplete) /
표시 수와 잡은 수 불일치.

## 워커에게 시킬 때 (그대로 복사해 쓰는 지시문)

고리는 둘이고 서로 섞이지 않는다. **`discover` 는 임대를 받지 않는다** — `lease` 뒤에 `discover` 를
붙이면 안 된다(`discover` 는 안에서 알아서 임대와 속도 예약을 거친다).

```
MANUAL.md 를 먼저 Read 하라: /Users/taewonpark/.claude/tools/web-search/MANUAL.md
읽기 전에는 어떤 도구도 부르지 마라.

맡은 일은 둘 중 하나다. 지시받은 쪽만 한다.

[가] 도메인 발견 — 대상: origin <https://…>
1. discover(crawl, origin) 을 부른다. lease 는 부르지 않는다. discover 가 안에서 처리한다.
2. "아직 안 끝났습니다 — N초 뒤" 가 오면 그 초만큼 기다렸다가 같은 인자로 다시 부른다.
   진행은 보존되므로 처음부터 다시 시작하지 않는다. 끝날 때까지 되풀이한다.
   "경계에서 멈췄습니다" 가 오면 멈추고 사람에게 그 본문을 그대로 전한다.
3. 완주하면 status(crawl) 을 한 번 부르고 본문을 그대로 보고한다.

[나] URL 처리 — 대상: 크롤 <크롤이름> 의 대기줄 <n>건
1. lease(crawl, n, worker="<네 이름>") 로 빌린다. 표(lease_token)를 잃으면 그 건은 버린다.
2. 빌린 건마다 fetch(crawl, url_id, lease_token, kind) 로 연다.
   "대기 N초" 면 그만큼 기다렸다가 같은 표로 다시 부른다. 끝낸 단은 다시 두드리지 않는다.
   단계를 손으로 올리지 마라 — fetch 가 스스로 올린다.
3. report(crawl, report_id, items) 로 반납한다. report_id 는 제출마다 고유해야 한다
   (같은 값으로 다시 내면 멱등 처리되어 두 번 반영되지 않는다).
4. 새로 찾은 주소는 add_urls 로 넣되 via 와 from_url_id 를 반드시 준다.
   경계에서 걸리면 그게 정답이다. 우회하지 마라.
5. 끝나면 status(crawl) 한 번 부르고 본문을 그대로 보고한다. 요약하지 마라.

금지: update_policy 로 상한 넓히기, 경계 밖 도메인 직접 열기, 결과 추측해 채우기.
막히면 evidence(crawl, what="excluded") 로 사유를 읽고 사람에게 그 값을 그대로 전한다.
```

## MCP가 안 보이는 환경에서 부르기 (Codex 등)

dibang 저장소의 `mcp-call.mjs`는 그 저장소 `.mcp.json`의 이름이나 `.mjs` 경로만 푼다.
user scope 등록 이름은 못 읽으니 **server.mjs 절대경로를 인자로 준다.**

```bash
cd /Users/taewonpark/Github/WORK/GoraeUniverse/dibang
node .claude/tools/mcp-call.mjs /Users/taewonpark/.claude/tools/web-search/server.mjs --tools
node .claude/tools/mcp-call.mjs /Users/taewonpark/.claude/tools/web-search/server.mjs crawl_list
node .claude/tools/mcp-call.mjs /Users/taewonpark/.claude/tools/web-search/server.mjs normalize '{"url":"https://Example.com/a/?utm_source=x"}'
```

이 경로로 부르면 `CLAUDE_PROJECT_DIR`이 저장소 루트가 되어 산출물이 `dibang/.claude/web-search/`에 남는다.
실제로 여는 도구(`fetch`·`discover`)를 쓰려면 셸에 `WEBSEARCH_DEPS_DIR`도 넣는다
(등록 항목의 env는 Claude가 띄울 때만 붙는다).

## 막혔을 때

| 증상 | 원인·손보기 |
|---|---|
| `모듈을 찾지 못했습니다: playwright` | `WEBSEARCH_DEPS_DIR`가 안 붙었다. node_modules 있는 폴더를 가리킨다 |
| `그런 크롤이 없습니다` | 이름 오타. `crawl_list`로 확인. 없는 이름은 "빈 크롤"로 보이지 않는다 |
| `already_leased` | 남이 쥐고 있다. 임대 시간이 지나면 저절로 돌아온다 |
| `stale_lease_token` | 표가 회수된 뒤 반납했다. 다시 빌려서 처음부터 |
| 잠금이 안 풀림 | `lock_status`로 주인·PID를 본다. PID는 사는데 멎었으면 `repair_lock` |
| `paused_incomplete`가 안 풀림 | `status` 본문의 막는 항목을 그대로 읽는다. 상한이면 `update_policy`, 사람 확인이면 확인 |

## 시험

```bash
cd /Users/taewonpark/.claude/tools/web-search
WEBSEARCH_DEPS_DIR=/Users/taewonpark/Github/WORK/GoraeUniverse/dibang node tests/gate4.mjs
```

`gate1`(장부 9) · `gate2`(수집 24) · `regress`(회귀 10) · `gate3`(발견 26) · `gate4`(크롤 57).
전부 로컬 fixture만 쓰고 바깥으로 나가지 않는다.
