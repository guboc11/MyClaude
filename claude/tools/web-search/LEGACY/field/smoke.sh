#!/usr/bin/env bash
# 로컬 fixture 로 MCP 워커를 한 바퀴 돌려 계약을 확인한다.
#
# 파이프라인 성공을 worker 성공으로 착각하지 않도록 출력은 파일로 보내고 exit 는 wait 로 받는다.
# 프로세스 확인은 전역 패턴으로 하지 않는다 — 이 사용자의 다른 web-search MCP 가 이미 돌고 있을 수 있다.
# 이번 실행이 만든 PID 세 개(fixture · worker · worker 가 띄운 MCP)만 본다.
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
TOOL="$(cd "$HERE/.." && pwd)"
DEPS="${WEBSEARCH_DEPS_DIR:-/Users/taewonpark/Github/WORK/GoraeUniverse/dibang}"
PORT="${1:-8951}"

SB="$(mktemp -d "${TMPDIR:-/tmp}/websearch-smoke-XXXXXX")"
FIX_PID=""
W_PID=""

mcp_pid_from_meta() {
  local f="$SB/.claude/web-search/smoke/run-meta.json"
  [ -f "$f" ] && node -e 'try{process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).mcp_pid||""))}catch{}' "$f"
}

cleanup() {
  # 이번 worker 만 정리한다
  if [ -n "$W_PID" ] && kill -0 "$W_PID" 2>/dev/null; then
    kill -TERM "$W_PID" 2>/dev/null
    wait "$W_PID" 2>/dev/null
  fi
  # worker 가 남긴 정확한 MCP PID 만 확인한다. 다른 MCP 는 건드리지 않는다.
  local m; m="$(mcp_pid_from_meta)"
  if [ -n "$m" ] && kill -0 "$m" 2>/dev/null; then kill -TERM "$m" 2>/dev/null; fi
  [ -n "$FIX_PID" ] && kill "$FIX_PID" 2>/dev/null
  # 이 실행이 만든 그 폴더만 지운다
  [ -n "${SB:-}" ] && [ -d "$SB" ] && rm -rf "$SB"
}
trap cleanup EXIT INT TERM

echo "샌드박스: $SB"
node "$TOOL/fixtures/server.mjs" "$PORT" > "$SB/fixture.log" 2>&1 &
FIX_PID=$!
sleep 1
# 포트 충돌로 fixture 가 죽었는데 남의 프로세스에 붙어 도는 스모크는 무효다
if ! kill -0 "$FIX_PID" 2>/dev/null; then
  echo "fixture 가 뜨지 않았습니다 (PID $FIX_PID). 로그:"; cat "$SB/fixture.log"; exit 1
fi
echo "fixture PID $FIX_PID 살아 있음 · http://127.0.0.1:$PORT/"

# fixture 바닥글의 x.example 은 이제 경계까지 올라온다. 로컬 스모크가 진짜 바깥으로
# 나가면 안 되므로 이 자리에서만 막는다(실사이트 launcher 에는 넣지 않는다).
WEBSEARCH_DEPS_DIR="$DEPS" CLAUDE_PROJECT_DIR="$SB" \
  WS_MIN_INTERVAL_MS=300 WS_JITTER_MS=200 WS_DENY_DOMAINS=x.example \
  node "$TOOL/field/worker.mjs" smoke "http://127.0.0.1:$PORT/" > "$SB/worker.log" 2>&1 &
W_PID=$!
wait "$W_PID"
WORKER_EXIT=$?
echo "worker 실제 종료 코드: $WORKER_EXIT (PID $W_PID)"

MCP_PID="$(mcp_pid_from_meta)"
kill "$FIX_PID" 2>/dev/null; wait "$FIX_PID" 2>/dev/null

echo
echo "----- worker 로그 (끝 20줄) -----"
tail -20 "$SB/worker.log"
echo
echo "----- 판정 -----"
node "$TOOL/field/smoke-assert.mjs" "$SB" "$WORKER_EXIT"
ASSERT_EXIT=$?

echo
echo "----- 이번 실행 PID 세 개만 확인 -----"
LEFT=""
for i in 1 2 3 4 5 6 7 8 9 10; do
  LEFT=""
  for p in "$FIX_PID:fixture" "$W_PID:worker" "${MCP_PID:-}:mcp"; do
    pid="${p%%:*}"; name="${p##*:}"
    [ -z "$pid" ] && continue
    if kill -0 "$pid" 2>/dev/null; then LEFT="$LEFT $name($pid)"; fi
  done
  [ -z "$LEFT" ] && break
  sleep 0.3
done
if [ -n "$LEFT" ]; then
  echo "남은 PID:$LEFT"
  ASSERT_EXIT=1
else
  echo "fixture($FIX_PID) · worker($W_PID) · mcp(${MCP_PID:-없음}) 모두 사라짐"
fi
FIX_PID=""; W_PID=""

exit $ASSERT_EXIT
