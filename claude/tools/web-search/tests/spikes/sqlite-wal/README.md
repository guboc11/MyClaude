# Node 내장 SQLite 실측 — workspace.db 와 전역 pace.db

작성: 2026-08-12 · 태스크 `2026-08-12-web-search-MCP-v2-rebuild#5`
근거 계획: `_PLAN/2026-08-11-web-search-mcp/PLAN.md` 3-3(저장), 8(전역 pace)

잠금 체계를 새로 발명하기 전에, 내장 `node:sqlite` 가 공유 장부로 충분한지 먼저 잰다.
**결론: 이 환경에서는 충분하다.** 두 spike 모두 통과했고, 안전 조건을 빼면 실제로 깨진다.

## 환경

| 항목 | 값 |
|---|---|
| Node | v22.21.0 |
| SQLite | 3.50.4 (`node:sqlite` 내장) |
| 별도 native 패키지 | 설치하지 않음 |
| 경고 | `ExperimentalWarning: SQLite is an experimental feature and might change at any time` |

**한계를 먼저 적는다.** `node:sqlite` 는 아직 실험 기능이라 실행마다 위 경고가 뜬다. 이번 실측이
통과했다는 것은 이 환경에서 지금 동작한다는 뜻이지, API 가 앞으로 그대로 남는다는 보장이 아니다.
구현에는 Node 최소 버전 확인을 넣고, `node:sqlite` import 실패나 동작 변화를 조용히 넘기지 말고
명시적 오류로 드러내야 한다.

## 실행

```
node tests/spikes/sqlite-wal/run-all.mjs          # 둘 다
node tests/spikes/sqlite-wal/workspace-spike.mjs  # workspace.db 만
node tests/spikes/sqlite-wal/pace-spike.mjs       # 전역 pace.db 만
```

역할을 파일로 나눴다. 부모(`*-spike.mjs`)가 스키마를 만들고 일꾼을 띄우고 과녁을 죽인다.
일꾼(`*-worker.mjs`)은 자기 일만 하고 결과를 stdout 에 JSON 한 줄로 낸다. 과녁은 같은 일꾼을
`--hold-open` 으로 띄운 것이다. 결과는 `results/workspace.json` 과 `results/pace.json` 에
따로 남는다 — 두 DB 는 목적도 경합 양상도 다르므로 한 파일에 섞지 않는다.

## workspace.db — 17항목 통과 (exit 0)

임시 폴더에 만들고 끝나면 지운다. 일꾼 10개가 각각 20행을 넣고 갱신한다.

| 확인 | 결과 |
|---|---|
| WAL·foreign_keys·busy_timeout | `journal_mode=wal` · `foreign_keys=1` · `busy_timeout=5000` |
| transaction rollback | 되돌린 뒤 남은 행 0 |
| 외래키 강제 | 없는 `item_id` 의 attempt 거절 |
| 10개 프로세스 동시 쓰기 | 행 200 = 기대 200, 고유 `canonical_url` 200 |
| 갱신·자식 행 | `leased` 200 / attempts 200 |
| SQLITE_BUSY | 0회 (busy_timeout 안에서 조용히 기다렸다) |
| transaction 중 2개 SIGKILL | 둘 다 `signal=SIGKILL` 로 종료 확인 |
| 재개방 무결성 | `integrity_check = ok` |
| 미완료 transaction | 커밋 안 된 표식 행 0 (되돌아갔다) |
| 커밋된 것 | 200행 그대로 |
| 강제 종료 뒤 쓰기 | 성공 (영구 잠금 없음) |
| `-wal`·`-shm` | 모든 연결을 닫은 뒤 남지 않음 |

## 전역 pace.db — 17항목 통과 (exit 0)

경로는 계획서 8절이 정한 그대로다.

    ~/.claude/tools/web-search/runtime/pace.db

**이 spike 전용 표다.** `spike_pace_domain`, `spike_pace_reservation` 두 개이고 이름을
`spike_` 로 시작한다. #24 가 만들 진짜 pace 계약이 아니며, 이 스키마를 그대로 쓰라는 뜻도 아니다.
`(domain, slot_index)` 에 일부러 UNIQUE 를 걸지 않았다 — 중복을 DB 제약으로 막아 버리면
transaction 이 실제로 막고 있는지 잴 수 없기 때문이다.

서로 다른 임시 프로젝트 폴더 20개를 만들고, 각 폴더를 cwd 로 삼은 프로세스 20개가 같은 순간에
같은 도메인을 예약한다. 하나당 3건씩 60건이다.

| 확인 | 결과 |
|---|---|
| 정확한 전역 경로 | `~/.claude/tools/web-search/runtime/pace.db` · `journal_mode=wal` |
| 서로 다른 프로젝트 | cwd 20개 |
| 예약 수 | 60건 = 기대 60건 |
| 중복 발급 | 같은 `slot_index` 0건 · 같은 `allowed_at` 0건 |
| 예약 간격 | 연속 59쌍 모두 정책값 25ms 이상, 최소 간격 25ms |
| SQLITE_BUSY | 0회 · `busy_timeout` 5,000ms · 실제 대기 최대 66~159ms, 평균 7~21ms |
| transaction 중 2개 SIGKILL | 둘 다 `signal=SIGKILL` 로 종료 확인 |
| 재개방 무결성 | `integrity_check = ok` |
| 미완료 transaction | 커밋 안 된 예약 0건 |
| 커밋된 것 | 60건 그대로 |
| 강제 종료 뒤 쓰기 | 성공 |
| 영구 잠금 | 전부 종료 뒤 `-wal`·`-shm` 0개 |

SQLITE_BUSY 가 0회인 것은 경합이 없었다는 뜻이 아니다. 실제 대기가 최대 159ms 까지 났으므로
경합은 있었고, `busy_timeout` 안에서 SQLite 가 조용히 기다렸다가 통과시킨 것이다.

반복해도 같은지 보려고 `run-all` 을 두 번 연속 돌렸다. 두 번 다 exit 0 이고 20 프로세스·60 예약·
중복 0·간격 위반 0·잔존 잠금 0 이었다.

## 안전 경계

이 spike 는 `pace.db` 에서 **자기 표(`spike_` 접두)의 행만 지운다.** 다른 표를 지우거나
`pace.db` 파일 자체를 삭제하지 않고, `runtime/` 의 다른 파일도 손대지 않는다. 매 실행이 서로
독립되도록 자기 행만 비우는 것이고, 이 경계는 `P1b-safety-boundary` 검사로 고정돼 있다 —
spike 가 만들지 않은 표가 있으면 그 표들이 그대로 남았는지 확인한다.

대조용으로 쓰는 `pace-unsafe-control.db` 는 같은 폴더에 만들었다가 실행 끝에 지운다.
임시 프로젝트 폴더와 workspace 샌드박스도 실행 끝에 지운다. 실행 뒤 남는 것은 `pace.db` 하나다.

## 시험이 헛돌지 않는다는 증거

안전 조건을 하나씩 빼고 같은 시험을 돌렸다.

- **transaction 제거** (`pace-worker.mjs --unsafe`): 60건 중 같은 `slot_index` 가 35~43건,
  간격 위반이 55~59건 나왔다. 정상 경로의 "중복 0" 이 우연이 아니라는 뜻이다.
- **`foreign_keys` 끄기**: 없는 `item_id` 의 attempt 가 그대로 들어갔다. 외래키 검사가
  실제로 무언가를 막고 있었다는 뜻이다.

## 첫 설계가 막힌 자리

처음에는 강제 종료 과녁 둘의 쓰기 transaction 을 **동시에** 열어 두려 했다. SQLite 는 쓰기
transaction 을 하나만 허용하므로 뒤엣놈이 `busy_timeout` 까지 막혔고, 그 일꾼은 아무 말도 못 한 채
부모가 영영 기다렸다 — 실행이 2분 한도를 넘겨 중단됐다(2026-08-12 실측).

고친 방식은 둘이다. 과녁을 **한 명씩** 다룬다("열림 확인 → SIGKILL → 종료 확인" 한 바퀴씩).
그리고 모든 자식 대기에 벽시계 제한(30초, 과녁은 15초)과 제한 초과 시 SIGKILL 정리를 걸었다.
영원히 멈추는 설계가 시험을 통과하지 못하게 하려는 것이다. 그때 남은 임시 폴더 하나는
접두로 정확히 골라 지웠고, 이후 실행에서는 잔존 0을 확인했다.

## 게이트 0(#7)에 넘기는 판정

- Node 내장 SQLite 로 진행한다. 별도 잠금 체계를 새로 만들지 않는다.
- 저장 계획을 다시 검토할 사유는 나오지 않았다.
- 단, 실험 기능이라는 한계와 버전 가드 필요는 위에 적은 대로 함께 넘긴다.
- `#24` 는 이 spike 의 표 이름·스키마를 계약으로 삼지 말고 새로 정한다.
