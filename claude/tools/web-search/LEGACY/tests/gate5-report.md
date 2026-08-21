# 게이트 5 — 실전 대조 (사람이 센 카드 수 vs 도구가 센 수)

- 날짜: 2026-08-12
- 대상: 2026-08-11 실전 1회차가 실제로 뜬 캡처 셋
- 판정: **불합격.** 세 목록 모두 도구가 센 카드가 0장이다.

## 1. 사람이 센 수 (캡처를 직접 열어 셈)

| 도메인 | 캡처 | 사람이 센 카드 | 셈 방식 |
|---|---|---|---|
| mcard.barunsoncard.com | `kr-barunson/captures/mcard.barunsoncard.com/2026-08-11-Product-List-1-18-1-0-5-0-headless-7a2d5c61-headless.jpg` | **18** | 3열 × 6행. 왼쪽 큰 미리보기는 첫 카드와 같은 것이라 세지 않음 |
| deardeer.kr | `kr-deardeer/captures/deardeer.kr/2026-08-11-category-1-new-headless-196195d0-headless.jpg` | **60** | 4열 × 15행 |
| www.itscard.co.kr | `kr-itscard/captures/www.itscard.co.kr/2026-08-11-script-card-list-asp-headless-d24a57c5-visual.jpg` | **36** | 4열 × 9행 |

## 2. 도구가 센 수

| 도메인 | 장부 `cards` | 그 시도의 `cards` | 판정 | 추출 상태 | 카드 note 사유 |
|---|---|---|---|---|---|
| barunson | **0** | 0 | needs_visual_review | uncertain | `page_validity:needs_visual_review` |
| deardeer | **0** | 0 (표시 수 309) | needs_visual_review | uncertain | `page_validity:needs_visual_review` |
| itscard | **0** | **8** (DOM 에서는 봄) | needs_visual_review | uncertain | `page_validity:needs_visual_review` |

세 크롤의 `state.cards` 는 모두 비어 있다. **일치한 항목이 하나도 없다.**

| 도메인 | 사람 | 도구 | 차이 |
|---|---|---|---|
| barunson | 18 | 0 | -18 |
| deardeer | 60 | 0 | -60 |
| itscard | 36 | 0 | -36 |

## 3. 왜 0인가 — 원인 둘

**(가) 저장을 막는 문턱이 실전에서 늘 닫혀 있다.**
카드 note 는 `page_validity` 가 `content_validated` 일 때만 카드를 저장한다.
그런데 목록은 시각 확인을 받아야 `content_validated` 가 되고, 이번 실전에서 목록 세 쪽은
모두 `needs_visual_review` 로 끝났다. 그래서 itscard 처럼 **DOM 에서 카드 8장을 실제로 본
경우에도 저장은 0장**이 됐다. 태스크 18의 "판정이 불확실하면 카드 0장과 사유만 남긴다"는
계약은 로컬에서는 맞았지만, 실사이트에서는 모든 목록이 그 문턱에 걸린다.

**(나) DOM 카드 판정이 실제 목록을 못 알아본다.**
barunson 은 눈으로 18장이 보이는데 반복 이미지 링크 증거가 **0개**였고(`증거 []`),
deardeer 는 표시 수 309를 읽고도 카드 0개였다(`flags: scroll_capped:steps`).
itscard 만 8개를 봤는데 사람 셈 36과 크게 어긋난다.
셋 다 `curl:200 → jina:403 → headless:200` 로 브라우저까지 올라간 뒤의 결과다.

## 4. 함께 드러난 완료 판정 결함

수정 뒤 후속 회차 `kr-barunson-postfix` 는 본 링크 112개를 하나도 따라가지 않았는데
(`links_not_followed` 5건: 8·8·8·8·80) 완료 판정이 **`complete`** 로 나왔다.
"아직 모르는 쪽이라 안 따라갔다" 는 사실이 완료를 막지 않는다. 이것은 게이트 4에서 고친
"안 본 것을 없는 것으로 보고하지 않는다" 와 같은 종류의 잘못이다.

## 5. 결론

**게이트 5 불합격.** 자동 카드 추출이 실전에서 작동하지 않는다.
사람이 센 18·60·36에 대해 도구는 0·0·0을 냈고, 이 상태로는 카드 자료를 쓸 수 없다.

## 6. 다음 손질 목록 (우선순위 순)

1. **시각 확인을 받는 길을 실제로 열 것.** 지금은 목록이 `needs_visual_review` 에서 끝나
   카드 저장 문턱을 영영 못 넘는다. 캡처는 이미 뜨고 있으므로, 캡처가 있는 목록을
   사람이 확인해 `visual_validated` 로 올리는 통로(또는 캡처 기반 자동 승격 규칙)가 필요하다.
2. **불확실한 쪽에도 카드를 "잠정"으로 저장할지 결정.** 지금은 0장과 사유만 남긴다.
   태스크 18 계약을 바꾸는 일이므로 사람 결정이 필요하다(태스크 24와 함께).
3. **DOM 카드 판정 보강.** barunson 0장·itscard 8장(사람 36)은 판정기 문제다.
   실제 캡처와 저장된 본문(`body-headless.txt`)이 있으니 오프라인으로 재현해 고칠 수 있다.
4. **deardeer 의 `scroll_capped`** — 표시 수 309에 스크롤 상한이 걸렸다. 상한을 넓히거나
   쪽 나눔을 따라가야 한다.
5. **완료 판정에 `links_not_followed` 를 반영.** 본 링크를 안 따라간 채로 `complete` 가
   나오면 안 된다.

## 7. 이 판정에 쓴 근거

- 캡처 세 장(경로는 1장에 적음) — 사람이 직접 열어 셈
- 시도 기록: `kr-barunson/manifests/fdcf0c2db12d2bc76c2a/7a2d5c61.json`,
  `kr-deardeer/manifests/3326a7bf24e705bd86dc/196195d0.json`,
  `kr-itscard/manifests/cdc1638e3300883d3d47/d24a57c5.json`
- 카드 note: 같은 폴더의 `notes/cards.json` (셋 다 `why: page_validity:needs_visual_review`, `cards: 0`)
- 후속 회차: `kr-barunson-postfix/events.jsonl` 의 `links_not_followed` 5건, `run-meta.json`
