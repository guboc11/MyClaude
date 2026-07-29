#!/usr/bin/env bash
# install.sh — 레포(claude/) → ~/.claude/ 설치. 새 기기 복원·타인 설치용.
#
# 원칙:
#   1. 지우지 않는다 — --delete 없음. 홈에 있던 다른 파일은 절대 건드리지 않는다.
#   2. 덮어쓰는 파일은 먼저 백업한다 (~/.claude/.install-backup/{시각}/).
#   3. MCP 등록은 tools/ 폴더 이름에서 유도한다 — {이름}-mcp 폴더마다 user 스코프 등록.
#   4. --dry-run 이면 무엇이 복사·등록될지만 보여주고 아무것도 바꾸지 않는다.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$REPO_DIR/claude"
DEST="$HOME/.claude"
# shellcheck source=manifest.sh
source "$REPO_DIR/manifest.sh"

DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1

if [ ! -d "$SRC" ]; then
  echo "오류: $SRC 가 없습니다. update.sh 로 먼저 수집했는지 확인하세요." >&2
  exit 1
fi

RSYNC_FLAGS=(-a --exclude .DS_Store)
if [ "$DRY" = 1 ]; then
  RSYNC_FLAGS+=(-n -v)
  echo "── dry-run: 실제로는 아무것도 바꾸지 않습니다 ──"
else
  BACKUP_DIR="$DEST/.install-backup/$(date +%Y%m%d-%H%M%S)"
  RSYNC_FLAGS+=(--backup --backup-dir="$BACKUP_DIR")
  mkdir -p "$DEST"
fi

echo "== 1/2 파일 복사: $SRC → $DEST =="
for t in "${TARGETS[@]}"; do
  if [ -d "$SRC/$t" ]; then
    rsync "${RSYNC_FLAGS[@]}" "$SRC/$t/" "$DEST/$t/"
  elif [ -f "$SRC/$t" ]; then
    rsync "${RSYNC_FLAGS[@]}" "$SRC/$t" "$DEST/$t"
  else
    echo "  (건너뜀 — 레포에 없음: $t)"
  fi
done
if [ "$DRY" = 0 ] && [ -d "${BACKUP_DIR:-/nonexistent}" ]; then
  echo "  덮어쓴 파일 백업: $BACKUP_DIR"
fi

echo "== 2/2 MCP user 스코프 등록 (tools/{이름}-mcp 폴더에서 유도) =="
if ! command -v claude >/dev/null 2>&1; then
  echo "  claude CLI 가 없어 등록을 건너뜁니다. 설치 후 아래를 직접 실행하세요:"
  for d in "$SRC"/tools/*-mcp/; do
    name="$(basename "$d")"; name="${name%-mcp}"
    echo "    claude mcp add --scope user $name -- node ~/.claude/tools/${name}-mcp/server.mjs"
  done
else
  for d in "$SRC"/tools/*-mcp/; do
    name="$(basename "$d")"; name="${name%-mcp}"
    if claude mcp get "$name" >/dev/null 2>&1; then
      echo "  이미 등록됨: $name (건너뜀)"
    elif [ "$DRY" = 1 ]; then
      echo "  등록 예정: claude mcp add --scope user $name -- node ~/.claude/tools/${name}-mcp/server.mjs"
    else
      claude mcp add --scope user "$name" -- node "$DEST/tools/${name}-mcp/server.mjs"
    fi
  done
fi

echo
echo "완료. 훅·설정은 settings.json 복사에 포함됩니다. Claude Code 를 재시작하세요."
echo "(settings.json 에는 소유자 취향 설정이 들어 있습니다 — 원치 않으면 manifest.sh 의 TARGETS 에서 빼고 설치하세요.)"
