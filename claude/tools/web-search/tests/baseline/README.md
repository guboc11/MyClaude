# web-search v2 재구성 기준선 — #1 보고서

작성: 2026-08-12 · 태스크 `2026-08-12-web-search-MCP-v2-rebuild#1`
계획: `dibang/_PLAN/2026-08-11-web-search-mcp/PLAN.md` 0·9·13절

재구성을 시작하는 시점의 코드·등록·데이터 경계를 사실로 고정한다. 이후 어떤 변경이 새 코드이고
어떤 것이 레거시 침범인지 한 명령으로 갈라 보기 위한 기준점이다.

## 한 명령 요약

```
node tests/baseline/baseline.mjs --verify --project <프로젝트 경로>
```

`frozen`(LEGACY, 기존 수집 데이터)이 한 바이트라도 바뀌면 FAIL 하고 종료 코드 1을 낸다.
양쪽 모두 파일 내용을 실제로 읽어 집계 SHA-256 을 내므로, 크기와 mtime 을 보존한 내용 변경도 잡는다.
`current`(새 코드 자리, MCP 등록·handshake)의 변화는 INFO 로만 찍고 실패시키지 않는다 —
새 코드가 자라는 것은 정상이기 때문이다.

## 이번 실측값 (2026-08-12T05:33:42.913Z, Node v22.21.0)

**frozen — LEGACY** `~/.claude/tools/web-search/LEGACY`
36개 파일 · 703,767바이트 · 집계 SHA-256 `e1b55fbfd1ebafc5e0bfa980d828d2c0754a50e07624ca26e12cf35cf2d79215`
구성은 field 4, fixtures 1, lib 18, tests 11, LEGACY 루트 2(MANUAL.md·server.mjs)다.
lib 18개는 .mjs 16개에 `crop_cards.py`와 `__pycache__/crop_cards.cpython-312.pyc`를 더한 수다.
파일별 SHA-256은 `baseline.json`의 `measured.frozen.legacy.files`에 있다.

집계 알고리즘: 상대경로를 바이트 순으로 정렬한 뒤 `${파일SHA256}  ${상대경로}\n`(공백 두 칸,
shasum 출력 형식)을 이어 붙여 SHA-256 한다. 스크립트 없이도 같은 값이 나온다.

```
cd ~/.claude/tools/web-search/LEGACY \
  && fd -H -I -t f . --strip-cwd-prefix | LC_ALL=C sort | tr '\n' '\0' \
  | xargs -0 shasum -a 256 | shasum -a 256
```

**frozen — 기존 수집 데이터** `<프로젝트>/.claude/web-search`
1,365개 파일 · 60,810,131바이트
내용 집계 SHA-256 `222a96c1bcea20e7450243e19305a488e33c334d1bcc135c61607348c7732e8f`
목록 지문 `cafce985a6fe79b364aebe49eae84799e708ef4fb2e88bdb9ff9db0127bf18e5`
내용 집계는 LEGACY 와 같은 알고리즘이다. 파일이 1,365개라 개별 해시는 저장하지 않고 집계 하나만 둔다.
목록 지문은 `${크기} ${mtime_ms} ${상대경로}` 줄을 정렬·연결한 값으로, 내용이 같아도 메타데이터가
움직이면 함께 잡히도록 보조로 남긴다. `.gitignore:70`의 `.claude/web-search/`로 git 에서 제외된다.

**current — 도구 루트** `MANUAL.md`, `server.mjs`, `tests/baseline/README.md`,
`tests/baseline/baseline.mjs` 네 개다. `baseline.json`은 이 스크립트의 산출물이라 목록에서 뺀다.

**current — MCP 등록** `~/.claude.json` user scope 에 있고 `node <도구경로>/server.mjs`,
env 키는 `WEBSEARCH_DEPS_DIR` 하나다(값은 기록하지 않는다). 진입점 파일은 실재한다.

**current — 실제 handshake** initialize → tools/list → tools/call 을 stdio 로 보낸 결과
`web-search@2.0.0-pre`, protocol `2025-06-18`, **공개 도구 0개**, tools/call 은 isError,
stderr 는 비어 있다. 도구 0개는 코드를 읽어 추정한 값이 아니라 실제 응답이다.

**current — 새 workspace** `<프로젝트>/.claude/websearch-workspace` 는 아직 없다.

## 읽기 전용 경계

`LEGACY/`와 `<프로젝트>/.claude/web-search/`는 읽기와 해시 계산만 한다.
수정·삭제·이동·형식 변환·새 workspace 로의 자동 이관을 모두 금지한다.
이 경계는 `baseline.json`의 `measured.frozen.read_only_boundary`에 기계 판독 가능한 형태로도 들어 있다.

## 재현 명령

```
# 기준선 검증 (frozen 변화 시 exit 1)
node tests/baseline/baseline.mjs --verify --project <프로젝트 경로>

# LEGACY 파일 수·집계 해시 독립 대조
fd -H -I -t f . ~/.claude/tools/web-search/LEGACY | wc -l
cd ~/.claude/tools/web-search/LEGACY && fd -H -I -t f . --strip-cwd-prefix \
  | LC_ALL=C sort | tr '\n' '\0' | xargs -0 shasum -a 256 | shasum -a 256

# 기존 수집 데이터 수·바이트 독립 대조 (반드시 -H -I)
fd -H -I -t f . <프로젝트>/.claude/web-search | wc -l
fd -H -I -t f . <프로젝트>/.claude/web-search -x stat -f%z {} | awk '{s+=$1} END {print s}'

# 기존 수집 데이터 내용 집계 독립 대조 (LEGACY 와 같은 알고리즘)
cd <프로젝트>/.claude/web-search && fd -H -I -t f . --strip-cwd-prefix \
  | LC_ALL=C sort | tr '\n' '\0' | xargs -0 shasum -a 256 | shasum -a 256

# 구문 검사 — 이 도구에는 패키지·빌드 정의가 없어 이것이 빌드성 검증이다
node --check tests/baseline/baseline.mjs
```

## 작업 중 바로잡은 것

**fd 기본 옵션의 비교 오류.** 처음 `fd -t f .`로 센 1,360개·60,791,178바이트는 `.gitignore:19`의
`*.log`에 걸린 `kr-*/worker.log` 5개(합 18,953바이트)를 빠뜨린 값이었다. 스크립트는 무시 규칙과
무관하게 전부 세므로 1,365개·60,810,131바이트가 맞다. 데이터가 변한 것이 아니라 세는 법이 달랐다.
이 경로를 fd 로 대조할 때는 `-H -I`를 반드시 붙인다.

**codegraph 초기화 되돌림.** 재사용 후보를 찾으려고 `codegraph init`을 도구 폴더에서 실행해
`.codegraph/`를 만들었다. 기준선 대상 경로에 새 인프라를 만든 것이라 `codegraph uninit --force`로
제거했고 `fd -H '^\.codegraph$'` 0건을 확인했다. LEGACY 36개와 기존 수집 데이터는 그대로다.

**codegraph 외부 경로 한계.** codegraph 는 `init`으로 대상 폴더에 `.codegraph/`를 만들어야 인덱싱한다.
초기화 없이 외부 도구 경로를 인덱싱할 수는 없고, 이 폴더는 기준선 대상이라 초기화하지 않는다.
따라서 재사용 후보 확인은 rg 로 했다. 기존 해시 사용처는 LEGACY 내부의 내용 지문 세 곳
(`field/worker.mjs:173`, `field/smoke-assert.mjs:27`, `tests/gate3.mjs:400·672`)뿐이고
기준선 생성기나 집계 유틸은 도구 폴더에도 저장소에도 없었다. 그래서 새로 만들었다.

## 남은 경고

`<프로젝트>/.claude/websearch-workspace/`에 git 무시 규칙이 없다(`git check-ignore` 종료 코드 1).
지금은 폴더가 없어 문제가 드러나지 않지만, workspace 를 처음 만드는 순간 스크린샷·DOM·DB 가
git 에 노출된다. 규칙 추가와 검증은 #10 의 생성 전 확인과 #15 의 게이트 항목에서 다룬다.
이 태스크에서는 사실로 기록만 하고 `.gitignore`를 고치지 않았다.


## 2026-08-12 사고 — 검사가 검사 대상을 지웠다

게이트 3 의 G3-10 이 `baseline.mjs --check` 를 불렀다. **그런 깃발은 없다.** 그때 baseline.mjs 는
`--verify` 가 아니면 무엇이든 "기록" 으로 떨어지게 돼 있어서, 얼려 둔 기준선을 조용히 덮어썼다.
게다가 `--project` 를 안 줘서 프로젝트가 도구 폴더로 잡혔고, 그 자리에는 `.claude/web-search` 가
없으므로 **기존 수집 데이터가 `exists: false · 0개 · 집계 null` 로 얼어붙었다.**

덮어쓰기는 언제나 성공하니 게이트는 PASS 를 냈다. 검사를 하는 척하면서 검사 대상을 지운 것이다.
다음 게이트 0 실행에서 `--verify` 가 실패하며 드러났다.

**데이터는 무사했다.** 다시 재어 보니 1,365개 · 60,810,131바이트로 #1 이 적어 둔 수치와 정확히 같다.
LEGACY 도 36개 · 703,767바이트 그대로다. 지워진 것은 기록이지 자료가 아니었다.

고친 것 셋.

- `baseline.mjs` 가 **모르는 깃발을 거절한다**(exit 2). "모르면 쓰기" 라는 기본값이 사고의 뿌리였다.
- 기록 모드는 이제 `--write` 로 명시해야 하고, 기준선이 이미 있으면 `--force` 까지 있어야 덮어쓴다.
- G3-10 은 `--verify --project <프로젝트>` 로 부른다. 부르는 쪽도 뜻을 분명히 적는다.

기준선은 올바른 프로젝트로 다시 기록했다(`--write --force --project <dibang>`). 지금 값은
2026-08-12 에 다시 잰 것이지만, #1 이 남긴 수치와 한 바이트도 다르지 않다는 것을 대조로 확인했다.
