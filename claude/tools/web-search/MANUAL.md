# web-search MCP — 매뉴얼

여러 에이전트가 **한 작업대**를 나눠 쓰며 웹을 조사하는 도구다.

기계가 하는 일과 사람이 하는 일이 갈려 있다. 기계는 주소를 다듬고, 겹친 것을 하나로 묶고,
어디서 나왔는지 적고, 일감을 나눠 주고, 파일로 남기고, 남의 서버를 천천히 두드린다.
**무엇이 쓸 만한지는 정하지 않는다** — 그건 에이전트가 `report` 로 말한다.

- 등록 진입점: `~/.claude/tools/web-search/server.mjs`
- 작업대 자리: `<프로젝트>/.claude/mcp-web-search/<workspace_id>/` (gitignore 됨)
- 속도 장부: `~/.claude/tools/web-search/runtime/pace.db` (프로젝트 밖, 모두가 함께 쓴다)

## 버튼 아홉

| 버튼 | 한 가지 일 | 안 하는 것 |
|---|---|---|
| `workspace_new` | 작업대를 만들고 brief 를 놓는다 | 아무것도 찾지 않는다 |
| `add_urls` | 주소를 명부에 넣는다 | 방문하지 않는다 |
| `map_domain` | robots·sitemap·대표 페이지로 **확인한 범위만** 지도로 만든다 | 찾은 곳을 따라가지 않는다 |
| `next` | 대기 중인 항목을 한 워커에게 겹치지 않게 빌려준다 | 무엇부터 볼지 정해 주지 않는다 |
| `collect` | 임대한 항목에서 **시킨 산출물만** 받는다 | 방식을 알아서 바꾸지 않는다 |
| `report` | 판정을 저장하고 done 으로 넘기고 임대를 푼다 | label 을 해석하지 않는다 |
| `retry` | 항목을 다시 대기로 돌린다 | 앞의 증거를 지우지 않는다 |
| `export` | 거른 결과를 작은 파일로 낸다 | 원본을 복사하지 않는다 |
| `status` | 기계 상태와 문제를 짧게 보여준다 | **조사가 끝났다고 말하지 않는다** |

없는 버튼이 하나 있다 — **`search`**. 계약에는 열 번째로 적혀 있지만 만들지 않았다.
키 없이 쓸 수 있는 검색 공급자 아홉 곳을 실측했는데 이용 조건이나 robots 로 전부 걸렀다
([tests/spikes/search-panel 결정](tests/spikes/search-provider/decision.md) ·
[게이트 5](tests/reports/gate5.md)). 그래서 목록에도 내지 않는다 — 있는 척하면 에이전트가
부르고 실패한다. 부르면 오류로 막고 대신 갈 길을 알려 준다.

**검색은 이렇게 한다.** 에이전트가 자기 `WebSearch` 로 찾고, 나온 주소를
`add_urls(source_kind="search", source_value=검색어)` 로 넣는다. 그러면 item 마다 어느 검색어에서
나왔는지 남는다. 남지 않는 것: 순위·제목·설명 원문·언어.

## 흔한 한 바퀴

```
workspace_new(topic, brief)                     → workspace_id
add_urls(workspace, source_kind, source_value, urls|file)
                                                 → 받은 수·새로·중복·거절
map_domain(workspace, domain|url)                → 발견 수·지도 파일·미확인 범위   (도메인을 팔 때만)
next(workspace, worker_id, count, lease_minutes) → lease_id·work_file
collect(workspace, lease_id, mode, outputs)      → 성공·부분·실패·색인 파일
   ↓ 색인과 요약(manifest)을 열어 본문을 읽고 판단한다
report(workspace, lease_id, worker_id, judgments|file)
                                                 → 반영·거절
export(workspace, format, fields, filter_*)      → 줄 수·파일 경로·거른 조건
status(workspace)                                → 열두 칸
```

`collect` 의 `outputs` 는 **목적에 따라 고른다.** 글이 필요하면 `text`, 구조가 필요하면 `dom`,
어디로 이어지는지가 필요하면 `links`, 무엇을 파는지 그림으로 봐야 하면 `images`,
사람이 눈으로 확인해야 하면 `screenshot`(browser 모드에서만).

`mode` 는 둘이다. `http` 는 검사한 IP 로 연결을 고정한다. `browser` 는 자바스크립트로 그리는
쪽을 볼 수 있지만 연결 고정이 없고, 그 사실이 결과마다 `browser_no_pinned_connection` 경고로 남는다.
브라우저를 쓰려면 **부른 프로젝트에** playwright 가 있어야 한다 — 이 도구 폴더에는 없다.
등록에 `WEBSEARCH_DEPS_DIR` 로 그 프로젝트를 적어 두면 그곳에서 찾는다.

## 판정을 반납할 때

판정 한 줄에 다섯 칸이 다 있어야 한다: `item_id` · `label` · `confidence` ·
`evidence_artifact_ids` · `note`.

- **근거 번호는 요약에서 가져온다.** `collect` 가 돌려준 색인의 `manifest` 를 열면
  `artifacts[].artifact_id` 가 있다. 그 번호가 그 item 것이 아니거나 파일이 바뀌었으면 거절된다.
- **못 정하겠으면 `label: null` 로 반납한다.** 대신 `note` 에 왜인지 적는다.
  그래야 "보고 나서 못 정했다" 와 "아무도 안 봤다" 가 갈린다.
- **판정은 덮이지 않는다.** 다른 워커가 다른 이름표를 붙이면 두 줄이 다 남는다.
  어느 쪽이 옳은지는 사람이 볼 일이다.
- 상태 200 이어도 차단 화면·차림표만 받은 쪽이면 그건 **본 것이 아니다.**
  `blocked_page_suspected`·`http_error_status`·`thin_text` 경고가 그 자리를 알려 준다.

## 일이 잘못됐을 때

**먼저 `status` 를 본다.** 오류 갈래마다 가장 최근 한 건의 item 번호·실행 번호·요청/최종 주소·
빠진 산출물·요약 파일 자리·다시 돌릴 번호가 들어 있다. 긴 로그를 열 필요가 없다.

| 증상 | 뜻 | 다음 손 |
|---|---|---|
| `next` 가 0건 | 대기가 없거나, 남이 빌려 간 것이 아직 안 끝났다 | `status` 의 임대·만료를 본다 |
| `report` 가 `lease_expired` | 임대 시간이 지났다. 그 사이 일감은 회수됐다 | 다시 `next` 로 받아 처음부터 |
| `report` 가 `stale_lease` | 그 번호로 잡힌 항목이 없다(이미 반납했거나 회수됐다) | `status` 로 실제 상태 확인 |
| `collect` 가 `pace/queue_too_long` | 그 도메인 차례가 너무 멀다 | 나중에 다시. 워커를 늘려도 안 빨라진다 |
| `navigate/goto_failed` | 페이지가 30초 안에 안 열렸다 | `retry` 로 다시. 반복되면 `mode=http` 로 |
| 실행이 안 끝난 채 남음 | 워커가 도중에 죽었다 | 만료를 기다리면 일감이 돌아온다. 만든 파일은 남아 있다 |

**워커가 죽어도 만든 것은 남는다.** 파일을 먼저 쓰고 장부에 매달기 때문이다.
죽은 워커의 임대는 만료 전까지 남의 것이고, 만료되면 다음 `next` 가 회수해 간다.
늦게 도착한 보고는 거절되며 장부를 바꾸지 않는다.

**`retry` 는 지우지 않는다.** 새 실행이 하나 더 생기고 앞의 기록과 파일은 그대로 남는다.

## 이 도구가 안 하는 것

- **검색을 직접 하지 않는다**(위 `search` 항목).
- **몰래 따라가지 않는다.** `map_domain` 은 확인한 범위만 지도로 만들고, 찾은 곳을 방문하지 않는다.
  더 넓히려면 수집한 뒤 지도를 **다시 부른다** — 넓히는 결정은 에이전트가 한다.
- **의미를 판정하지 않는다.** 카드인지 목록인지 쓸 만한지 정하지 않는다.
- **조사 완료를 말하지 않는다.** `workspace_drained` 는 "넣은 일에 대기·임대가 없다" 는 뜻뿐이다.
- **차단을 우회하지 않는다.** CAPTCHA·로그인 세션·실제 크롬 프로필을 쓰지 않는다.
- **robots 를 무시하지 않는다.** 막힌 곳은 막혔다고 적는다.
- **사설·loopback 주소로 안 나간다.** 리다이렉트로 그쪽을 가리켜도 끊는다.
- **빠르게 하지 않는다.** 도메인마다 기본 10초 간격(흔들림 5초)을 둔다. 이 값은 운영자가
  argv 로만 바꿀 수 있고 버튼 입력으로는 못 바꾼다.

## 응답과 파일

MCP 응답은 **4KB 안**이다. 긴 것은 전부 파일로 가고 응답에는 경로와 수치만 담긴다.
`status` 는 응답이 커지면 총계는 그대로 두고 표본부터 덜어 내며, 덜어 냈다는 사실을 함께 적는다.

작업대 안의 자리:

```
brief.md                    조사 목적과 기준(사람이 쓴다)
workspace.db                기계 상태의 단일 원본
artifacts/pages/<item>/<attempt>/   화면·본문·DOM·링크·그림 + manifest.json
artifacts/maps/<attempt>/   지도
artifacts/collect/          수집 한 번의 색인
artifacts/leases/           워커가 받아 간 목록
exports/                    내보낸 결과(덮어쓰지 않는다)
```

## 다시 확인하는 법

```
node tests/gate0.mjs … gate7.mjs        게이트 여덟 (5번은 exit 2 = 잴 대상 없음이 정상)
node tests/transition/verify.mjs        등록·목록·smoke·옛 구현 미사용
node tests/contracts/public-tools.mjs   공개 계약
```

보고서는 `tests/reports/` 에 있다. 실전 세 시나리오 기록은 `scenario-a.md`·`scenario-b.md`·
`scenario-c.md` 다.
