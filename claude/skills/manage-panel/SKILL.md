---
name: manage-panel
description: 워커 패널이 생성한 태스크를 매니저 패널이 끝까지 매니징하는 스킬. 인자로 워커 패널 이름을 받는다 (예 /manage-panel WORKER2: Conversation MCP 개발). Use this skill ONLY when the user explicitly invokes /manage-panel. Do not auto-trigger.
---

$ARGUMENTS 패널이 생성한 모든 태스크를 의도에 어긋나지 않게
꼼꼼히 완수할 수 있도록 끝까지 매니징해줘.

## 핵심 — 워커가 결정을 물어올 때

1. 전체 맥락·프로젝트 규칙·사용자의 의도·사용자의 대화 패턴을 분석해서
   결정할 수 있으면 매니저가 결정한다. 사용자에게 묻지 않는다.
2. 진짜 결정 못 할 경우: "사용자라면 이렇게 선택할 거야"를 생각해
   **임시로** 판단하고 진행시킨다. 이 건은 따로 메모해둔다.
3. 태스크 전부 완수한 뒤 최종 보고에서 모아서 승인을 구한다:
   "저희끼리 프로젝트 맥락과 사용자의 결정 이력을 최대한 분석했는데도
   결정하지 못한 부분입니다. 이러이러한 후보 중 사용자께서 이렇게
   판단하실 것 같아 이렇게 진행했습니다. 괜찮을까요?"

## 운영

- 착수 전: cmux tree로 surface 확인, 태스크 JSON owner로 소유 그룹 전수 확인
- 지시: cmux send 후 별도 호출로 send-key Enter. 게이트에서만 멈추게 하고
  보고엔 실제 출력을 붙이게 한다
- 감시: Monitor 주 감지 + ScheduleWakeup 270초 안전망을 한 쌍으로 건다.
  오판은 양쪽 다 복구가 싸다(헛깸=확인 턴 하나, 놓침=안전망이 받음) —
  감지는 단순하게 두고, 판단은 깨어난 매니저가 화면을 직접 보고 한다.
  1. Monitor — 5초 간격으로 cmux read-screen을 읽어 멈춤을 감지하면
     한 줄 출력하고 스스로 종료하는 스크립트를 건다:

     ```bash
     miss=0
     while true; do
       s=$(cmux read-screen --surface surface:N 2>&1) || { echo "cmux 실패"; exit 1; }
       if echo "$s" | grep -qE "esc to interrupt|… \([0-9]"; then miss=0
       else miss=$((miss+1)); [ $miss -ge 3 ] && { echo "워커 멈춤"; exit 0; }
       fi
       sleep 5
     done
     ```

     - 작업 중 신호 = 상태줄 `esc to interrupt` 또는 라이브 스피너 `… (18s`.
       턴이 끝나면 같은 자리가 `✳ Cooked for 38s`처럼 과거형 for로 바뀐다
       (동사는 매번 다름 — Cooked/Brewed/Worked… 동사 매칭 금지)
     - 3회 연속(≈15초) 신호 없음일 때만 멈춤 판정 — 상태줄이 캡처 밖이거나
       턴 사이 공백인 순간의 헛깸 빈도를 줄이는 용도. 그 이상 정밀화는 과설계
     - cmux 실패도 한 줄 내고 종료 — 조용히 죽는 상태를 만들지 않는다
  2. 같은 턴에 ScheduleWakeup 270초를 건다 (안전망)
  3. Monitor가 먼저 잡으면 → 검증·다음 지시 → 다음 사이클의 Monitor와
     ScheduleWakeup 270초를 다시 건다. ScheduleWakeup은 재호출이 이전 예약을
     교체하므로 안전망 리셋에 별도 해제가 필요 없다
  4. 안전망이 먼저 돌면 → 수동 확인. 워커가 아직 작업 중이면 Monitor는
     그대로 두고 ScheduleWakeup만 다시 건다. Monitor가 죽어 있으면
     TaskStop으로 정리한 뒤 새로 건다 — Monitor를 쌓지 않는다
  5. 둘 다 돌아도 무해 — 각자 깨어나 상태를 보고 판단할 뿐이다
  매 턴 끝에 다음 wakeup 시각을 사용자에게 명시한다
- 판정: 워커 말을 믿지 말고 직접 재실행해 검증. 판정 후 다음 지시는
  바로 보낸다 — 워커를 세워두지 않는다
- 금지: 커밋·푸시, 임의 /compact, 다른 패널 산출물 접촉
