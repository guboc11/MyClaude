# server-mcp 사용 가이드

멀티 에이전트가 로컬 서버를 서로 안 밟게 띄우는 도구. 설계 근거는 [DESIGN.md](DESIGN.md), 요약은 [SUMMARY.md](SUMMARY.md). 이 문서는 **실사용 매뉴얼**.

> 도구는 user 스코프로 등록됨(`claude mcp list` → `server: … ✔ Connected`). **새 세션부터** `mcp__server__*`로 호출된다(이 하네스는 MCP 도구가 지연 로드라, 처음 쓸 때 스키마를 한 번 불러오는 절차가 있을 수 있다).

---

## 1. 30초 요약
- 서버를 **세트**로 묶어 띄운다. 세트 K → 포트 **`5200 + K×100`** 블록.
- 블록 내 자리: **dibang +0 / guest +1 / landing +2 / admin +3 / api +80**.
  - 예) 세트3 = dibang 5300 · guest 5301 · landing 5302 · api 5380.
- **세트0 = 매니저(대표)**, 세트1+ = 에이전트. env·주소는 띄우는 순간 주입 → 세트끼리 격리.

## 2. 빠른 시작

```jsonc
// 에이전트: local로 필요한 앱만 (세트1)
set_up { "set": 1, "env": "local", "apps": ["guest-web", "api"] }

// 지금 전체 현황 보기 (매니저 조망)
set_status { "all": true }

// 환경 갈아끼우기 (그 세트만 재기동)
set_env { "set": 1, "env": "prod" }

// 로그 / 종료
set_logs { "set": 1, "app": "api", "tail": 40 }
set_down { "set": 1 }
```

- **apps 생략** 시 기본: 세트0 = dibang·guest·landing·admin·api / 그 외 = dibang·guest·landing·api.
- **env 생략** 시 기본: 세트0 = `prod`(확인용), 그 외 = `local`.
- **미리보기**: `set_up { "set": 0, "dry_run": true }` — 안 띄우고 계산된 포트·주입값만 반환.

## 3. 도구 레퍼런스

| 도구 | 인자 | 설명 |
|---|---|---|
| `set_up` | `set`, `apps?`, `env?`(local\|dev\|prod), `db_branch?`, `dry_run?` | 세트 서버 기동(주입·로그·장부 기록) |
| `set_down` | `set`, `apps?` | 종료·장부 정리 |
| `set_status` | `set?`, `all?`, `prune?` | 현황판(●up ◐starting ○dead). `all`=전 패널, `prune`=죽은 항목 정리 |
| `set_logs` | `set`, `app`, `tail?` | 서버 로그 tail |
| `set_env` | `set`, `env` | 세트 env 전환(재기동) |
| `set_db_branch` | `set?`, `name`, `drop?` | 로컬 DB 격리 브랜치(아래) |

## 4. env·데이터 소스
- `local` → 공유 로컬 Supabase(54321) + 공유 postgres(54322). 여러 local 세트가 **같은 데이터** 공유.
- `prod`/`dev` → 원격 Supabase. (dev는 이전 보류 상태 — [[project_env_dev_on_hold]].)
- **주입이 전역 `.env` 심볼릭을 이긴다.** 그래서 세트2=prod·세트3=local 동시 가능. `use-env.sh`(전역 전환)와 무관.

### 4-1. admin 링크 규칙 (2026-07-15 개정 — 축 분리)
- **토글(PROD/LOCAL/DEV) = 데이터 소스, 링크 = 화면 위치.** 두 축을 섞지 않는다.
- PROD 토글: 데이터(API)는 세트0 api(:5280, prod DB), **링크(게스트 플로우·디스플레이·공유 링크)는 `.env`의 실제 배포 URL**.
- 배포 링크 옆에 **`[로컬 :52xx]` 병기 링크**가 붙는다 — server-mcp 런치 시 주입되는 `VITE_SET_GUEST_BASE_URL`(admin이 뜬 세트의 guest-web) 기반. 공유는 배포 링크 복사, 로컬 검증은 병기 링크 클릭.
- 전역 `.env`로 직접 띄운 admin에는 SET 주입이 없어 병기 링크가 안 보인다(정상).
- server.mjs 수정 후에는 **MCP 재연결(/mcp) → 해당 앱 재기동**을 해야 새 주입이 반영된다(장기 실행 프로세스).

## 5. DB 스키마 격리 (branch)
스키마가 갈리는 브랜치를 병렬 테스트할 때(예: A는 칼럼 추가, B는 삭제):

```jsonc
set_db_branch { "set": 1, "name": "feat_x" }   // 로컬 DB를 branch_feat_x 로 복제 + set1 api를 그 DB로
// ... 그 브랜치 DB에만 스키마 변경 적용 ...
set_db_branch { "name": "feat_x", "drop": true } // 정리
```
- 로컬 postgres(54322)를 **통째 복제** → **로그인 계정·사진은 공유**(auth/storage 복제 스냅샷 + 공유 볼륨), **테이블 스키마만 독립**.
- 로컬 전용. prod/dev와 무관.

## 6. 안전 규칙 (필독)
- **라이브(매니저) 세트를 kill·전환하지 않는다.** 남의 세트를 만지지 말 것 — `set_status`로 소유자(@) 확인.
- 검증·실험은 **비어 있는 포트 블록**에서(예: 54xx 이상). 매니저가 쓰는 저번호 블록 회피.
- 종료는 반드시 `set_down`으로(포트·장부 함께 정리). 죽은 채 남은 건 `set_status { "prune": true }`.

## 7. 트러블슈팅
- **`● up`이 아니라 `◐ starting`으로 오래 머문다** → `set_logs`로 부팅 로그 확인(포트 충돌·DB 연결 실패 등).
- **api가 `database "…" does not exist`** → 격리 DB 이름은 `branch_<name>`. `set_db_branch`로 먼저 생성했는지 확인.
- **`set_db_branch`가 복제 실패** → 로컬 Supabase 미기동일 수 있음(`supabase status`). 클론은 `supabase_db_*` 컨테이너 내부 PG 도구로 수행(호스트 pg_dump 버전 불일치 회피).
- **도구가 안 보임** → 새 세션인지 확인(등록은 새 세션부터 적용). `claude mcp list`로 `server ✔ Connected` 확인.

## 8. 저장 위치
- 코드: `~/.claude/tools/server-mcp/server.mjs`
- 현황 장부: `<repo>/.claude/mcp-server/set-{K}/{app}.json` (gitignore)
- 로그: `<repo>/.claude/mcp-server/set-{K}/{app}.log`
