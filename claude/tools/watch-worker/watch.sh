#!/bin/bash
# watch-worker — cmux 워커 패널 감시 스크립트
#
# 설계·검증 계획: .claude/plans/2026-08-28-watch-worker/PLAN.md
# 사용법·상태표·판 결박 절차: 같은 폴더 MANUAL.md
# 판정 문구의 원문 근거: claude 2.1.250 · codex 0.147.0 바이너리 strings 실측 (PLAN 3장)
#
# 호출:  watch.sh --surface 102 [--interval 20] [--deep-min 5] [--timeout-min 90] [--double-gap 5]
# 자가 시험:  watch.sh --classify-file <화면 텍스트 파일>
# 시험용 화면 주입:  --screen-cmd '<명령>'  (명령이 줄 수 하나를 인자로 받아 화면을 출력)
set -u
export LC_ALL=en_US.UTF-8

# ── 상수: 판정 골격 ─────────────────────────────────────────────
MARKER_RE='esc to interrupt|Working \('          # 작업 중 (두 CLI 공통 원문)
DONE_CLAUDE_RE='(✻|⏺) [[:alpha:]]+ for [0-9]+[hms]'  # 예: "✻ Cooked for 14m 11s" — 동사는 무작위(Sautéed 처럼 비ASCII 포함)라 골격만
DONE_CODEX_RE='Worked for [0-9]+[hms]'           # codex 는 단일 고정 문자열
IDLE_CLAUDE_RE='^[[:space:]]*❯[[:space:]]*$'     # 빈 입력 프롬프트
IDLE_CODEX_RE='Ask Codex to do anything|› Implement \{feature\}'
BLOCKED_RE='Do you want to'                      # 권한 대화 4종의 공통 접두 (원문)
CAPACITY_RE='is at capacity'                     # 용량 오류 변형 2종의 공통부 (원문)
COMPACTED_RE='Context compacted'                 # compact 완료 (원문)
STUCK_CLAUDE_RE='^[[:space:]]*❯[[:space:]]+[^[:space:]]'   # ❯ 뒤에 내용 잔존
STUCK_CODEX_RE='to queue message'                # codex 입력 대기열 (원문)
LINES_NORMAL=10                                  # 낡은 스크롤백 오염 한도(12줄) 안
LINES_DEEP=25

# ── 기본값 ──────────────────────────────────────────────────────
SURFACE="" INTERVAL=20 DEEP_MIN=5 TIMEOUT_MIN=90 DOUBLE_GAP=5
TIMEOUT_SEC="" SCREEN_CMD="" CLASSIFY_FILE=""

while [ $# -gt 0 ]; do
  case "$1" in
    --surface)       SURFACE="$2"; shift 2 ;;
    --interval)      INTERVAL="$2"; shift 2 ;;
    --deep-min)      DEEP_MIN="$2"; shift 2 ;;
    --timeout-min)   TIMEOUT_MIN="$2"; shift 2 ;;
    --timeout-sec)   TIMEOUT_SEC="$2"; shift 2 ;;   # 시험용 (분 단위보다 우선)
    --double-gap)    DOUBLE_GAP="$2"; shift 2 ;;
    --screen-cmd)    SCREEN_CMD="$2"; shift 2 ;;    # 시험용 화면 주입
    --classify-file) CLASSIFY_FILE="$2"; shift 2 ;;
    *) echo "알 수 없는 인자: $1" >&2; exit 2 ;;
  esac
done
[ -z "$TIMEOUT_SEC" ] && TIMEOUT_SEC=$((TIMEOUT_MIN * 60))
DEEP_EVERY=$(( (DEEP_MIN * 60) / INTERVAL )); [ "$DEEP_EVERY" -lt 1 ] && DEEP_EVERY=1

# ── 화면 읽기 ───────────────────────────────────────────────────
read_screen() { # $1 = 줄 수
  if [ -n "$SCREEN_CMD" ]; then
    eval "$SCREEN_CMD $1" 2>/dev/null
  else
    cmux read-screen --surface "surface:$SURFACE" --scrollback --lines "$1" 2>/dev/null
  fi
}

# ── 판별부: 화면 텍스트 → 상태 이름 ─────────────────────────────
# $1 = 화면, $2 = allow_working (yes 면 작업 중 후보 반환)
# 대조 순서: 작업 중 > 권한 물음 > 용량 > compact 완료 > 씹힌 입력 > 완료 > 모름
# (씹힌 입력을 완료보다 먼저 두는 이유: codex 대기열 화면은 유휴 힌트와 대기열
#  문구를 함께 보일 수 있어, 완료를 먼저 대조하면 씹힘이 완료로 뭉개진다.)
classify() {
  local screen="$1" allow_working="$2"
  if [ "$allow_working" = yes ] && grep -qE "$MARKER_RE" <<<"$screen"; then
    echo working; return
  fi
  grep -qE  "$BLOCKED_RE"   <<<"$screen" && { echo blocked; return; }
  grep -qE  "$CAPACITY_RE"  <<<"$screen" && { echo capacity; return; }
  if grep -qE "$COMPACTED_RE" <<<"$screen"; then echo done; return; fi
  if grep -qE "$STUCK_CLAUDE_RE" <<<"$screen"; then echo stuck-input; return; fi
  if grep -qE "$STUCK_CODEX_RE" <<<"$screen" && ! grep -qE "$MARKER_RE" <<<"$screen"; then
    echo stuck-input; return
  fi
  if grep -qE "$DONE_CLAUDE_RE" <<<"$screen" && grep -qE "$IDLE_CLAUDE_RE" <<<"$screen"; then
    echo done; return
  fi
  if grep -qE "$DONE_CODEX_RE" <<<"$screen" && grep -qE "$IDLE_CODEX_RE" <<<"$screen"; then
    echo done; return
  fi
  echo unknown
}

# 작업 중 마커 줄에서 경과 시간 문자열을 뽑는다 (이중 읽기 비교용)
elapsed_token() { # $1 = 화면
  grep -E "$MARKER_RE" <<<"$1" | grep -oE '[0-9]+m? ?[0-9]*s' | head -1
}

# ── 자가 시험 모드 ──────────────────────────────────────────────
if [ -n "$CLASSIFY_FILE" ]; then
  content=$(cat "$CLASSIFY_FILE")
  echo "CLASSIFY: $(classify "$content" yes)"
  exit 0
fi

[ -z "$SURFACE" ] && { echo "사용법: watch.sh --surface <번호>" >&2; exit 2; }

# ── 종료 ────────────────────────────────────────────────────────
START=$(date +%s)
finish() { # $1 = 상태
  local mins=$(( ($(date +%s) - START) / 60 ))
  echo "WATCH_RESULT: $1 surface=$SURFACE elapsed=${mins}m"
  case "$1" in
    done) exit 0 ;; blocked) exit 10 ;; capacity) exit 11 ;;
    stuck-input) exit 12 ;; no-panel) exit 13 ;; unknown) exit 14 ;;
    timeout) exit 15 ;; *) exit 14 ;;
  esac
}

log_note() { # 상태가 바뀔 때만 한 줄
  if [ "$1" != "${LAST_NOTE:-}" ]; then
    echo "[$(date +%H:%M:%S)] surface=$SURFACE $1"
    LAST_NOTE="$1"
  fi
}

# ── 리듬 ────────────────────────────────────────────────────────
FAIL=0; CYCLE=0; LAST_NOTE=""
while :; do
  CYCLE=$((CYCLE + 1))
  LINES=$LINES_NORMAL
  [ $((CYCLE % DEEP_EVERY)) -eq 0 ] && LINES=$LINES_DEEP

  S1=$(read_screen "$LINES")
  if [ -z "$S1" ]; then
    FAIL=$((FAIL + 1)); [ "$FAIL" -ge 3 ] && finish no-panel
    sleep "$INTERVAL"; continue
  fi
  FAIL=0

  STATE=$(classify "$S1" yes)
  if [ "$STATE" = working ]; then
    # 이중 읽기 — 낡은 화면·출력물 속 마커에 속지 않기 위한 확정 절차
    sleep "$DOUBLE_GAP"
    S2=$(read_screen "$LINES")
    T1=$(elapsed_token "$S1"); T2=$(elapsed_token "$S2")
    if [ -n "$T1" ] && [ -n "$T2" ] && [ "$T1" != "$T2" ]; then
      log_note "working ($T1 -> $T2)"
    elif [ "$S1" != "$S2" ]; then
      log_note "working (screen changing)"
    else
      # 마커는 있는데 화면이 완전히 멈춤 — 작업 중 배제 후 재대조
      STATE=$(classify "$S1" no)
      [ "$STATE" = working ] && STATE=unknown
      finish "$STATE"
    fi
  else
    finish "$STATE"
  fi

  NOW=$(date +%s)
  [ $((NOW - START)) -ge "$TIMEOUT_SEC" ] && finish timeout
  sleep "$INTERVAL"
done
