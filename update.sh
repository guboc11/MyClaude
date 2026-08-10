#!/usr/bin/env bash
# update.sh — ~/.claude/ → 레포(claude/) 수집. 홈에서 고친 것을 레포로 가져온다.
#
# 원칙:
#   1. --delete 로 미러링한다 — 홈에서 지운 것은 레포에서도 지워져 좀비가 안 남는다.
#      위험하지 않은 이유: 도착지가 git 워킹트리라 커밋 전에 diff 로 전부 보인다.
#   2. skills 는 manifest.sh 의 제외 목록(외부 사본·심볼릭)을 빼고 자작만 수집한다.
#   3. 커밋·푸시는 하지 않는다 — 마지막에 git status 를 보여주고 사람이 확정한다.
#   4. --dry-run 이면 무엇이 수집·삭제될지만 보여주고 아무것도 바꾸지 않는다.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$HOME/.claude"
DEST="$REPO_DIR/claude"
# shellcheck source=manifest.sh
source "$REPO_DIR/manifest.sh"

DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1

# usage.jsonl·*.log = 도구가 남기는 실행 기록 (머신 상태) — 코드가 아니므로 수집하지 않는다.
# node_modules = package.json 으로 복원되는 설치물 — 레포에 넣지 않는다 (md-convert 의 marked 등).
RSYNC_FLAGS=(-a --delete --exclude .DS_Store --exclude usage.jsonl --exclude '*.log' --exclude node_modules)
if [ "$DRY" = 1 ]; then
  RSYNC_FLAGS+=(-n -v)
  echo "── dry-run: 실제로는 아무것도 바꾸지 않습니다 ──"
else
  mkdir -p "$DEST"
fi

SKILL_EXCLUDE_FLAGS=()
for e in "${SKILL_EXCLUDES[@]}"; do
  SKILL_EXCLUDE_FLAGS+=(--exclude "/$e")
done

echo "== 수집: $SRC → $DEST =="
for t in "${TARGETS[@]}"; do
  if [ -d "$SRC/$t" ]; then
    if [ "$t" = "skills" ]; then
      rsync "${RSYNC_FLAGS[@]}" "${SKILL_EXCLUDE_FLAGS[@]}" "$SRC/$t/" "$DEST/$t/"
    else
      rsync "${RSYNC_FLAGS[@]}" "$SRC/$t/" "$DEST/$t/"
    fi
  elif [ -f "$SRC/$t" ]; then
    rsync "${RSYNC_FLAGS[@]}" "$SRC/$t" "$DEST/$t"
  else
    echo "  (건너뜀 — 홈에 없음: $t)"
  fi
done

echo
if [ "$DRY" = 1 ]; then
  echo "dry-run 끝. 실제 수집은 ./update.sh"
else
  echo "== 수집 결과 (git) =="
  git -C "$REPO_DIR" status --short
  echo
  echo "diff 를 확인한 뒤 직접 커밋하세요. 이 스크립트는 커밋하지 않습니다."
fi
