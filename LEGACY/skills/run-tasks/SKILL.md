---
name: run-tasks
description: >
  생성된 태스크를 규칙·컨벤션을 지키며 연속 수행하는 스킬. 완료로 바꾸기 전 의도 부합을
  검증해 거짓 완료를 막는다. 사용자가 /run-tasks를 호출하면 동작한다.
  Use this skill ONLY when the user explicitly invokes /run-tasks. Do not auto-trigger.
---

# 태스크 수행

시작 전 CLAUDE.md·프로젝트 CLAUDE.md·`_code_convention/` 관련 문서를 직접 Read. 기억에 의존하지 않는다.
각 태스크는 TaskGet으로 description·완료조건을 다시 읽고 시작한다. 태스크는 수단이고, 사용자 의도가 목적이다.

## completed로 바꾸기 직전 — 멈추고 검증한다
"됐다"는 느낌은 정지 신호다(편의 쪽으로 기운다). 아래를 통과해야만 완료로 바꾼다:
1. description을 다시 읽었는가. 내 산출물이 요구한 '바로 그것'인가, 비슷한 다른 것인가?
2. 실제 폼·화면·기능을 테스트 패널·임시방편·보조물로 대체하지 않았는가?
3. 완료를 증거(실제 파일·실제 화면 동작·재현)로 보일 수 있는가? 느낌 말고.

하나라도 '아니/모호'면 완료 금지. in_progress로 두고 다시 수행한다.

## 거짓 완료 금지
안 한 것을 했다고 하지 않는다. "이만하면 됐다"를 내 편의로 판단하지 않는다 — 완료 기준은 description이 정한다.
completed로 바꾸면 게이트 hook이 독립 검증하니, 우회하지 말고 FAIL이면 다시 읽고 다시 수행한다.

멈추지 않고 연속 수행하되 thinking 깊이를 줄이지 않는다. 위 검증을 위한 멈춤은 수행의 일부다.
