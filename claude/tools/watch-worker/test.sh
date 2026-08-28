#!/bin/bash
# watch-worker 자가 시험 — 판별부(fixtures 전수) + 리듬(화면 주입 시퀀스)
# 게이트 기준: PLAN 5-1(전수 일치) · 5-2(이중 읽기) · 5-3의 오프라인 대응분
#
# fixtures 이름 규약: <기대상태>--<설명>.txt  (기대상태 = classify 출력과 동일 문자열)
# 권한 물음·용량 오류·씹힌 입력 표본은 포크·다른 세션과의 패널 충돌을 피해
# 바이너리 원문(PLAN 3장) 기반으로 구성했고, 나머지는 2026-08-28 실물 화면이다.
set -u
cd "$(dirname "$0")"
WATCH=./watch.sh
PASS=0; FAIL=0

say_fail() { echo "  ✗ $1"; FAIL=$((FAIL + 1)); }
say_pass() { PASS=$((PASS + 1)); }

echo "== 1. 판별부 — fixtures 전수 대조 =="
for f in fixtures/*.txt; do
  base=$(basename "$f" .txt)
  expected="${base%%--*}"
  got=$("$WATCH" --classify-file "$f" | sed 's/^CLASSIFY: //')
  if [ "$got" = "$expected" ]; then say_pass; else say_fail "$base: 기대 $expected, 실제 $got"; fi
done

# ── 리듬 시험 준비: 화면 주입 제공기 ───────────────────────────
# 호출마다 다음 화면 파일을 내놓는다 (마지막 화면에서 멈춤).
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
cat > "$TMP/provider.sh" <<'EOF'
#!/bin/bash
# 호출마다 다음 화면을 내놓는다. loop 파일이 있으면 처음으로 되감고, 없으면 마지막에 멈춘다.
dir="$(dirname "$0")"
n=$(cat "$dir/n")
if [ -f "$dir/s$((n + 1)).txt" ]; then echo $((n + 1)) > "$dir/n"
elif [ -f "$dir/loop" ]; then echo 1 > "$dir/n"
fi
cat "$dir/s$n.txt"
EOF
chmod +x "$TMP/provider.sh"

reset_seq() { echo 1 > "$TMP/n"; rm -f "$TMP"/s*.txt "$TMP/loop"; }

run_watch() { # 화면 시퀀스가 준비된 상태에서 감시를 돌리고 마지막 줄을 반환
  "$WATCH" --surface 999 --screen-cmd "$TMP/provider.sh" \
    --interval 1 --double-gap 1 --timeout-sec "${1:-60}" 2>/dev/null | tail -1
}

echo "== 2. 리듬 — 작업 중(카운터 전진) 뒤 완료 =="
reset_seq
sed 's/36s/36s/' fixtures/working--codex.txt > "$TMP/s1.txt"
sed 's/36s/41s/' fixtures/working--codex.txt > "$TMP/s2.txt"
cp fixtures/done--codex-worked.txt "$TMP/s3.txt"
r=$(run_watch)
case "$r" in WATCH_RESULT:\ done*) say_pass ;; *) say_fail "busy→done: $r" ;; esac

echo "== 3. 리듬 — 마커는 있는데 화면이 완전히 멈춤 =="
reset_seq
cp fixtures/working--codex.txt "$TMP/s1.txt"   # s2 없음 → 같은 화면 반복
r=$(run_watch)
case "$r" in WATCH_RESULT:\ unknown*) say_pass ;; *) say_fail "frozen: $r" ;; esac

echo "== 4. 리듬 — 계속 작업 중이면 상한에서 끊김 =="
reset_seq
sed 's/36s/1s/'  fixtures/working--codex.txt > "$TMP/s1.txt"
sed 's/36s/9s/'  fixtures/working--codex.txt > "$TMP/s2.txt"
touch "$TMP/loop"   # 두 화면을 계속 오가게 해 「영원히 작업 중」을 흉내 낸다
r=$(run_watch 3)
case "$r" in WATCH_RESULT:\ timeout*) say_pass ;; *) say_fail "timeout: $r" ;; esac

echo "== 5. 리듬 — 읽기 3회 실패는 no-panel =="
r=$("$WATCH" --surface 999 --screen-cmd "true" --interval 1 --double-gap 1 --timeout-sec 60 2>/dev/null | tail -1)
case "$r" in WATCH_RESULT:\ no-panel*) say_pass ;; *) say_fail "no-panel: $r" ;; esac

echo
echo "결과: 통과 $PASS · 실패 $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
