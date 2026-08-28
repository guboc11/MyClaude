# watch-worker MANUAL

워커 패널 감시 스크립트입니다. 매니저가 임무를 투입한 패널을 지켜보다가, 상태가 갈리는
순간 그 갈래 이름과 함께 종료해 매니저를 깨웁니다. 설계 경위와 검증 계획 전문은
`.claude/plans/2026-08-28-watch-worker/PLAN.md`, 신설 경위는
`_CHANGE_CHRONICLE/2026-08/2026-08-28-watch-worker-tool.md` 에 있습니다.

## 쓰는 법

```bash
# 투입 → 착수 확인(매뉴얼 3-4) 뒤에, 백그라운드로 한 줄:
.claude/tools/watch-worker/watch.sh --surface 102
```

- 반드시 **착수 확인 뒤에** 겁니다. 순서를 어기면 씹힌 지시를 감시가 stuck-input 으로
  잡아 주긴 하지만, 착수 확인이 1차 방어입니다.
- 패널당 감시 하나. surface 번호는 매 세션 `cmux tree --all` 로 확인합니다.
- 선택 인자: `--interval 20`(주기 초) · `--deep-min 5`(깊은 점검 간격 분) ·
  `--timeout-min 90`(상한 분) · `--double-gap 5`(이중 읽기 간격 초).

## 결과 읽는 법 — 마지막 줄 한 줄

`WATCH_RESULT: <갈래> surface=<번호> elapsed=<분>m`

| 갈래 | 뜻 | 매니저의 행동 |
|---|---|---|
| `done` (코드 0) | 턴 완료 증거(과거형 소요 줄+빈 프롬프트) 또는 compact 완료 | 수확 (매뉴얼 3-6) |
| `blocked` (10) | 권한 대화 상자가 떠 있음 | 화면 보고 승인·거부 개입 |
| `capacity` (11) | 모델 용량 오류 | 재전송 절차 (매뉴얼 4-5 결) |
| `stuck-input` (12) | 유휴인데 입력창에 지시문 잔존 | Enter 이중 재전송 (매뉴얼 4-5) |
| `no-panel` (13) | 화면 읽기 3회 연속 실패 | 패널 생사·번호 확인 |
| `unknown` (14) | 상태표 어디에도 안 걸림 (멈춘 화면 포함) | 눈으로 확인 |
| `timeout` (15) | 상한 시간까지 계속 작업 중 | 패널 조사 (진짜 장기 작업인지, 속고 있는지) |

`done` 판정이 존재 증거 기반이라 예전의 「유휴 재확인 60초 대기」는 없습니다. 판정은
설계상 느슨합니다 — 일찍 깨우면 화면 한 번 보고 다시 걸면 되고, 놓친 것은 5분 주기
깊은 점검과 상한이 줍습니다.

## 판정이 보는 것 (요약)

- **작업 중**: `esc to interrupt` / `Working (` + **이중 읽기**로 경과 카운터 전진 확인
  (낡은 화면·출력물 속 마커에 안 속게).
- **완료**: 클로드 `✻ <동사> for <시간>` 꼴 + 빈 `❯` / codex `Worked for <시간>` +
  입력 힌트. 동사는 CLI가 무작위로 골라서(비ASCII 포함) 골격으로만 매칭합니다.
- 전체 상태표·우선순위는 `watch.sh` 머리의 상수 구획과 PLAN 4-3이 원천입니다.

## 자가 시험

```bash
.claude/tools/watch-worker/test.sh          # fixtures 전수 + 리듬 4종 — 전부 통과해야 함
.claude/tools/watch-worker/watch.sh --classify-file <화면텍스트>   # 한 장 판정 디버깅
```

fixtures 는 2026-08-28 실물 화면(작업 중·완료·씹힘·compact)과 바이너리 원문 기반 구성
(권한 물음·용량 오류)입니다. 판별 로직을 고치면 test.sh 부터 다시 돌립니다.

## 판 고정 — CLI 업데이트 시 재검증

상태표 문구는 추출 시점의 판(claude 2.1.250 · codex 0.147.0)에 고정돼 있습니다.
CLI 업데이트를 인지하면 아래를 재실행해 각 grep 이 1 이상인지 확인하고, 0이 나오면
상태표를 갱신할 때까지 그 CLI 종류의 판정은 timeout 안전핀에만 기대는 것으로 간주합니다.

```bash
F=$(readlink -f $(which claude))
strings "$F" | grep -c "esc to interrupt"
strings "$F" | grep -c "Do you want to"
B=$(readlink -f $(which codex 2>/dev/null) 2>/dev/null); [ -x "$B" ] || B=$HOME/.local/bin/codex
strings "$B" | grep -cE "Worked for |Ask Codex to do anything|is at capacity|Context compacted"
```

## 한계 (알고 쓰기)

1. **codex 씹힌 입력**은 `to queue message` 문구가 있을 때만 확정합니다. codex 유휴
   입력창의 잔존 텍스트는 자리 표시 문구와 화면상 구분이 어려워, 못 가르면 unknown 으로
   깨웁니다. 씹힘의 1차 방어는 여전히 착수 확인입니다.
2. 매니저 세션이 재시작되면 감시도 함께 죽습니다. 그 구멍의 담당은 재진입 첫 스캔
   (패널 매니징 매뉴얼 6-3)입니다.
3. 한 패널에 감시를 겹쳐 걸어도 막지 않습니다 — 해는 중복 알림뿐입니다.
4. Claude Code 훅·codex notify 연동(당사자가 완료를 직접 알리는 방식)은 관리자 결정으로
   보류된 다음 단계 후보입니다.
