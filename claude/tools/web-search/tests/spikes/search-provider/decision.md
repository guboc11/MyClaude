# 무키 검색 공급자 — 결정

작성: 2026-08-12 · 태스크 `2026-08-12-web-search-MCP-v2-rebuild#6`
근거 계획: `_PLAN/2026-08-11-web-search-mcp/PLAN.md` 4-3(search 버튼), 7-1(검색 공급자 게이트), 10 게이트 0·5
증거 목록과 지문: [candidates.json](candidates.json) · 실행 기록: [results/probe.json](results/probe.json)

## 결정

**직접 `search` 버튼은 미완료로 남긴다.** 확정할 공급자가 없다.

에이전트가 자기 `WebSearch` 로 얻은 결과를 `add_urls` 로 workspace 에 넣는 길은 그대로 유지한다.
후보 사이트 찾기는 그 경로로 계속 할 수 있다. 다만 그것은 에이전트가 하는 일이고, MCP 안에
검색 기능이 생긴 것이 아니다.

불안정한 스크래핑을 정상 기능으로 표시하지 않는다. 이용 조건이 불명확한 것을 "된다"로 적으면
그 문장이 나중에 근거로 쓰인다.

## 조사한 아홉 곳

| 후보 | 무키 | 기능 | robots | 공식 조건 | 판정 |
|---|---|---|---|---|---|
| DuckDuckGo HTML | 예 | 일반 웹 결과 | 허용 | **불명확** | reject |
| DuckDuckGo Lite | 예 | 일반 웹 결과 | 허용 | **불명확** | reject |
| Bing 공개 RSS | 예 | 일반 웹 결과 | **금지** | **금지** | reject |
| Mojeek | 예 | 일반 웹 결과 | **금지** | — | reject |
| Marginalia | 예 | 일반 웹 결과 | **금지** | — | reject |
| Startpage | 예 | 일반 웹 결과 | **금지** | — | reject |
| SearXNG (searx.be) | 예 | 일반 웹 결과 | **사람 확인 화면** | — | reject |
| DuckDuckGo Instant Answer | 예 | **즉답(불일치)** | **금지** | — | reject |
| Common Crawl 색인 | 예 | **URL 색인(불일치)** | **금지** | — | reject |

살아남은 후보: **0**.

### 갈래별 탈락 사유

**robots 가 검색 경로를 명시적으로 막은 여섯 곳.** Bing 은 `User-agent: *` 아래 61행에
`Disallow: /search` 가 있고 RSS 형식도 그 경로 아래다
([www.bing.com.txt](artifacts/robots/www.bing.com.txt)). Mojeek 은 `Disallow: /search`
([www.mojeek.com.txt](artifacts/robots/www.mojeek.com.txt)), Marginalia 도 `Disallow: /search`
([marginalia-followed.txt](artifacts/robots/marginalia-followed.txt) — `search.marginalia.nu` 는
302 로 `marginalia-search.com` 에 넘긴다, [search.marginalia.nu.txt](artifacts/robots/search.marginalia.nu.txt)),
Startpage 는 검색이 사는 `/sp/` 와 `/do/` 를 막는다
([www.startpage.com.txt](artifacts/robots/www.startpage.com.txt)).
`api.duckduckgo.com` 은 `Disallow: /` 로 전체를 막고
([api.duckduckgo.com.txt](artifacts/robots/api.duckduckgo.com.txt)),
`index.commoncrawl.org` 도 몇몇 파일만 빼고 전체를 막는다
([index.commoncrawl.org.txt](artifacts/robots/index.commoncrawl.org.txt)).

**사람 확인 화면이 뜬 한 곳.** searx.be 는 `robots.txt` 자리에서조차 `text/html` 11,354바이트가
오고 내용이 "Verifying your browser…" 다. `noscript` 는 `/antibot/captcha` 로 보낸다
([searx.be.txt](artifacts/robots/searx.be.txt)). 우회는 금지 사항이라 여기서 멈춘다.
제3자 인스턴스라 이용 조건도 운영자마다 다르다.

**기능이 애초에 다른 두 곳.** DuckDuckGo Instant Answer API 는 이름은 API 지만 돌려주는 것이
요약·정의·공식 사이트 같은 즉답이고, 순위가 매겨진 일반 웹 결과 목록이 아니다. Common Crawl 색인은
검색어로 순위를 매겨 주는 공급자가 아니라 이미 아는 URL 이 크롤에 있는지 찾아보는 색인이다.
둘 다 응답이 정상으로 와도 `search` 버튼이 필요로 하는 자료가 아니다 — robots 와 별개의 탈락 사유다.

**공식 조건에서 걸린 세 곳.** 여기가 실질적인 갈림길이었다.

DuckDuckGo 의 html·lite 엔드포인트는 robots 가 `Allow: /` 이고
([html.duckduckgo.com.txt](artifacts/robots/html.duckduckgo.com.txt),
[lite.duckduckgo.com.txt](artifacts/robots/lite.duckduckgo.com.txt))
식별 UA 로도 실제 결과가 나왔다 — html 쪽은 result 앵커 30개에 스니펫 10개로 제목·URL·설명이
다 채워진다([ddg-html.txt](artifacts/probe/ddg-html.txt)). 그런데 Acceptable Use Policy 에
이런 조항이 있다([duckduckgo-acceptable-use-v2.html](artifacts/tos/duckduckgo-acceptable-use-v2.html)).

> Frame, inline link, or similarly display any portion of the services within another service

MCP 가 검색 결과 목록을 다른 제품 안으로 들여오는 일이 바로 그 모양이다. 같은 문서에
"Sell or resell any portion of the services" 와 "Interfere with or disrupt the integrity or
performance of the services" 도 있다. 자동 접근을 딱 집어 금지하지도, 허용하지도 않았다 —
**불명확**이다. 더구나 공개 문서가 없는 내부 엔드포인트라 프로그램 접근을 허용한다는 기술 문서도 없다.
Terms of Service 원문은 [duckduckgo-terms.html](artifacts/tos/duckduckgo-terms.html) 에 있고,
처음 받은 [duckduckgo-acceptable-use.html](artifacts/tos/duckduckgo-acceptable-use.html) 은
자바스크립트 넘김 페이지라 본문이 없어 v2 를 다시 받았다.

Bing 공개 RSS 는 기능만 보면 후보 중 가장 좋았다. `<item>` 10개에 제목·링크·설명이 모두 있고
한국어 결과까지 섞여 나왔다([bing-rss.txt](artifacts/probe/bing-rss.txt)). 그러나 Microsoft
Services Agreement 에 이 문장이 있다
([microsoft-services-agreement.html](artifacts/tos/microsoft-services-agreement.html)).

> Don't circumvent any restrictions on access to, usage, or availability of the Services
> (e.g., attempting to "jailbreak" an AI system or impermissible scraping).

robots 의 `Disallow: /search` 가 곧 그 접근 제한이다. 제한을 우회해 자동으로 두드리는 것은
위 조항에 걸린다.

## 어떻게 쟀는가

**판정에 쓴 UA 는 하나다.**

    WebSearchMCP-Spike/2.0 (+automated evaluation; no browser emulation)

브라우저로 가장하지 않았고 연락처를 지어내지도 않았다. 가장한 채 통과한 결과는 채택 근거가 될 수
없기 때문이다 — 이 UA 로 막히면 그것이 blocked 다. 처음 robots 를 모을 때 Chrome 140 UA 를 썼는데,
그것은 예비 조회였고 **어떤 판정 근거로도 쓰지 않았다.** 판정 대상이 된 세 후보는 식별 UA 로 다시 쟀다.

**50개 검색어 corpus 는 돌리지 않았다.** 거기까지 간 후보가 없다. 이용 조건이나 robots 로 이미
걸러진 곳을 50번 더 두드리는 것은 남의 서비스에 부담만 준다. 계획서의 "5개 언어 50개 검색어" 는
살아남은 후보를 재는 기준이지, 탈락한 곳에도 채워야 하는 절차가 아니다.

**보낸 요청.** 예비 robots 8건, 식별 UA probe·terms 6건, 추가 terms 3건. 도메인마다 4초 간격을
두고 총 1분 미만이다. 병렬로 두드리지 않았다. 원문은 전부 `artifacts/` 에 남겼다 — robots 10개,
probe 응답 3개, 이용 조건 문서 4개로 모두 17개다. robots 가 열이 된 것은 marginalia 에서
302 응답과 따라간 곳의 robots 를 둘 다 남겼기 때문이다.

## 한계와 잠금

- **`search` 는 제품 기능으로 아직 없다.** MCP 가 검색어를 받아 결과를 돌려주는 버튼은 만들지 않는다.
  공개 도구 목록에 이름은 남지만, 구현이 없는 상태이거나 "미완료" 를 반환하는 상태로 둔다.
  이 결정은 `_PLAN` 4-3 의 "0단계에서 무키 환경으로 안정적인 방식을 찾지 못하면 임시 스크래핑을
  정상 기능으로 꾸미지 않는다" 와 같은 결론이다.
- **`#36`·`#37`·`#38` 은 착수할 수 없다.** 각각 확정 공급자 adapter, search 실행·원문 artifact 연결,
  게이트 5 실전 검증이다. 확정 공급자가 없으므로 셋 다 선행 조건을 못 갖췄다. 게이트 5 와 전체
  개발 완료(`#49`)도 이 항목을 통과로 적으면 안 된다.
- **게이트 0(`#7`)은 이 결정으로 넘어갈 수 있다.** 게이트 0 의 요구는 "공급자 하나 확정 **또는**
  direct search 미완료 결정이 근거 수치와 함께 명시" 이고, 후자를 이 문서가 근거와 함께 채운다.
- **이 판정은 2026-08-12 시점이다.** robots 와 이용 조건은 바뀐다. 나중에 다시 볼 때는
  `verify.mjs` 로 보존 증거가 그대로인지 먼저 확인하고, 새로 재려면 그때 다시 요청해야 한다.
  이 문서의 수치는 그날 실제로 받은 응답에서 나온 것이지 기억이 아니다.

## 다시 확인하는 법

```
node tests/spikes/search-provider/verify.mjs
```

보존한 증거를 검사한다. 네트워크를 다시 부르지 않는다 — 검증기가 바깥을 다시 두드리면 그때그때
결과가 달라져 "그날 무엇을 봤는가" 를 확인할 수 없기 때문이다.
