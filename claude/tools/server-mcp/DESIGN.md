# 세트 기반 로컬 서버 운영 — DESIGN

작성 맥락: 멀티 에이전트(매니저 1 + 에이전트 N)가 같은 레포에서 동시에 로컬 서버를 띄우며 생긴 충돌을 구조적으로 없애기 위한 설계. 1페이지 요약은 [SUMMARY.md](SUMMARY.md).

---

## 1. 배경·문제

### 1.1 관측된 사고
- **2026-07-11 22:45** — 다른 세션이 `scripts/use-env.sh local`을 실행하자 `apps/{api,dibang-wedding,guest-web}/.env` 심볼릭이 전부 `.env.localhost`로 바뀌었고, Vite가 `.env` 변경을 감지해 매니저의 :5200이 로컬 Supabase(127.0.0.1:54321)로 핫리로드 → Google OAuth가 로컬엔 없어 실패.
- **같은 날 admin 401** — :8082 API가 부팅 시점 env를 메모리에 고정한 채 오래 떠 있어 위임 검증이 실패. 재시작으로 해결.

### 1.2 근본 원인 (전역 공유 상태)
1. **`.env` 심볼릭 1개를 모든 세션이 공유** — 한 세션의 환경 전환이 전원에게 전파.
2. **`vite.config`의 strictPort 고정 포트** — 앱당 서버 하나만 가능 → 세트 다중화 불가.
3. **프로세스가 부팅 env를 메모리에 고정** — 공유 API/FE는 동시에 한 env만 표현 가능.

→ 세트를 여러 개 병렬로 두려면 이 세 전역 상태를 **세트별 파라미터**로 바꿔야 한다.

---

## 2. 목표 / 비목표

**목표**
- 매니저 1 + 에이전트 N, **최대 ~5 세트 동시 안정 운영**.
- 세트마다 독립 env(local/dev/prod) — 서로 안 밟음.
- 로컬 DB는 **공유 1개가 기본**, 스키마 격리 필요 브랜치만 **on-demand 격리 DB**.
- 매니저가 **전체 현황**(세트·소유자·env·데이터소스·URL·포트·pid)을 한눈에.
- 세트 서버 기동·추적을 **서버관리 MCP**가 소유 → `run in background` 규칙을 세트 서버 한정 은퇴.

**비목표**
- 클라우드/CI 오케스트레이션, 프로덕션 배포(render.yaml) 변경.
- 기본값으로 세트별 데이터 격리 — 공유 local = 공유 데이터가 기본, 격리는 opt-in.
- ui-catalogue(컴포넌트 카탈로그)·invitation-shell(OG 서버)의 세트화 — 세트 대상 아님.

---

## 3. 핵심 개념 — 세트(Set)

세트 = **{ 번호 K, 소유자 owner, env, DB 타깃, 포트 블록 }** 로 정의되는 논리 묶음. 그 아래 **작업에 필요한 앱만** 기동한다(무조건 다 켜기 아님).

| | 세트0 (매니저) | 세트1..N (에이전트) |
|---|---|---|
| 소유자 | 매니저(사람) | `CMUX_SURFACE_ID` |
| 구성 | dibang·guest·landing·**admin**·api | dibang·guest·landing·api (필요분만) |
| 수명 | 항상 켜둠(기준) | 작업 단위 |
| env 기본 | 매니저가 결정(local/dev/prod) | local (매니저 요청 시 dev/prod) |

---

## 4. 포트 배분 규칙

- 블록 base = `5200 + K*100`.
- 블록 내 **고정 오프셋**:

| 오프셋 | 앱 |
|---|---|
| +0 | dibang-wedding |
| +1 | guest-web |
| +2 | landing |
| +3 | admin (세트0만) |
| +80 | api |

- 세트별 실제 포트:

| 세트 | 블록 | dibang | guest | landing | admin | api |
|---|---|---|---|---|---|---|
| 0 (매니저) | 52xx | 5200 | 5201 | 5202 | 5203 | 5280 |
| 1 | 53xx | 5300 | 5301 | 5302 | — | 5380 |
| 2 | 54xx | 5400 | 5401 | 5402 | — | 5480 |
| 3 | 55xx | 5500 | 5501 | 5502 | — | 5580 |
| 4 | 56xx | 5600 | 5601 | 5602 | — | 5680 |

- **충돌 분석**: 4자리 블록 5200~5699 vs 로컬 Supabase(api 54321 / db 54322 / shadow 54320 / pooler 54329 / studio 54323 — 모두 5자리) vs invitation-shell 8090 → **겹침 없음**. (예: 세트2 블록 5400~5499 ≠ 54321.)
- **세트 대역 (server.mjs에서 강제, 2026-07-24)**: 세트 0~7 = 5200~5699, 세트 8~17 = **7000~7999** — 6000번대는 **prototype playground 예약 대역**(6100+N×10, dibang prototype-mcp — 6000 자체는 Chrome X11 차단으로 미사용)이라 건너뛴다. 18+는 8000번대(api 8080·invitation-shell 8090)와 충돌하므로 금지. 두 체계의 대역 경계가 이 줄의 단일 원천이다.
- **API를 블록 안(+80)에** 둬서 "**53xx 보이면 세트1 전부**"의 가시성 확보. (현행 api 8080~8082는 세트0의 5280으로 이관; 아래 §9 admin 정합 참고.)
- 포트 지정: FE는 `vite --port <블록포트> --strictPort`(CLI가 config 고정 포트를 오버라이드), API는 `PORT=<블록포트>`.

---

## 5. env·주소 주입 규칙 (핵심 메커니즘)

전역 `.env` 심볼릭을 쓰지 않고 **런치 시점 process env 주입**으로 세트별 값을 고정한다. FE·API 둘 다 **주입값이 `.env`보다 우선**함을 실측 확정:
- Vite: `VITE_SUPABASE_URL=<sentinel>`로 띄우니 `/src/env.ts`가 sentinel을 서빙(=`.env.prod` 무시).
- Go: `PORT`/`DATABASE_URL` 주입이 godotenv 로드값을 이김(:8099 프로브).

주입값은 `import.meta.env`(FE) / `os` env(API)로 흘러 기존 스키마(`src/env.ts` Zod, `server.LoadConfig`)를 그대로 통과 → **ENV 관리 룰·ESLint·forbidigo 위반 없음**.

### 5.1 주입 매트릭스 (앱별)

런처가 (세트 K, env)로부터 계산해 주입.

| 앱 | 주입 키 | 값 |
|---|---|---|
| **공통(FE)** | `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` | 선택 env의 Supabase |
| | `VITE_API_BASE_URL` | `http://localhost:<블록+80>` |
| **dibang-wedding** | `VITE_GUEST_WEB_URL` | 세트 guest 포트 |
| | `VITE_SITE_URL`, `VITE_INVITATION_SHARE_URL` | 자기/공유 링크 origin |
| **guest-web** | `VITE_DIBANG_URL` | 세트 dibang 포트 |
| | `VITE_BASE_URL` | 자기 포트 |
| **landing** | (VITE 참조 없음) | 포트만 |
| **admin** (세트0) | `VITE_{LOCAL,DEV,PROD}_{API,DIBANG,GUEST}_BASE_URL`, `VITE_{...}_SUPABASE_URL/ANON`, `..._INVITATION_SHARE_BASE_URL` | 3그룹 각각을 세트0 포트로 (§9) |
| **api** | `PORT` | 블록+80 |
| | `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | `-env <name>` 또는 주입 |
| | `DATABASE_URL` | 공유 postgres 또는 branch DB (§6) |
| | **`ALLOWED_ORIGINS`** | **세트의 FE origin들** (미주입 시 CORS 차단 — 필수) |
| | `ADMIN_EMAIL`, `UPLOAD_*` | env 기본 |

### 5.2 주의: 앱 상호참조 URL
`VITE_GUEST_WEB_URL`/`VITE_DIBANG_URL`/`VITE_BASE_URL`은 소스에서 `env.X ?? 'http://localhost:52xx'` 형태의 **dev 폴백**을 가진다. 세트에서 폴백이 잘못 걸리지 않도록 **항상 세트의 실제 포트를 명시 주입**해야 한다. (`apps/dibang-wedding/src/lib/external-urls.ts`, `apps/guest-web/src/lib/config.ts` 확인됨.)

### 5.3 env → 데이터소스 매핑
- `local` → 공유 로컬 Supabase(54321) + 공유 postgres(54322) 또는 branch DB.
- `dev`/`prod` → 원격 Supabase(로컬 DB 무관).

---

## 6. DB 모델

### 6.1 공유 로컬 스택 (싱글톤)
- `supabase start`로 뜨는 풀스택(api 54321 / db 54322 / studio 54323)은 고정 포트라 **1개만**.
- 규칙: `supabase status`로 확인 → **떠 있으면 재사용, 없으면 기동**. 모든 local 세트 API의 기본 DSN = 이 공유 postgres.
- 트레이드오프: 공유 local = **공유 데이터**(한 세트의 쓰기가 다른 세트·매니저에도 보임).

### 6.2 스키마 격리 브랜치 (on-demand)
스키마가 갈라지는 브랜치(A: `a`칼럼 추가 / B: `b`칼럼 삭제) 병렬 테스트용.

이유: 도메인 테이블이 `auth.users`에 **하드 FK**로 묶여 있어(`weddings.host_id`, `profiles.user_id`, `photos.guest_user_id` 등) `public`만 별도 DB로 뗄 수 없다(PG FK는 DB 경계를 못 넘음). 따라서 **DB 전체를 형제 DB로 복제**한다.

절차:
1. 공유 postgres(54322) → 형제 DB로 복제. `pg_dump`→`psql`(활성 커넥션 있어도 가능; `CREATE DATABASE ... TEMPLATE`은 template 무접속을 요구하므로 회피).
2. 그 브랜치 DB에 스키마 변경 마이그레이션 적용.
3. 세트 API에 `DATABASE_URL=postgres://...@127.0.0.1:54322/branch_<name>` 주입 후 재기동.
4. auth·storage는 **공유 그대로** — 복제 스냅샷의 `auth.users`로 FK 만족, 사진은 텍스트 object 키로 공유 스토리지 해석.

한계: 복제는 **스냅샷** — 복제 후 신규 가입 유저는 브랜치 DB에 없음(로그인은 공유 `auth`에 기록). 브랜치 스키마 테스트는 **기존 시드 유저**로 수행. `auth`/`storage` 스키마 자체를 바꾸는 경우는 별도.

---

## 7. 서버관리 MCP 설계

task-mcp와 동일 패턴(무의존성 stdio MCP, owner 격리 재사용). 합의대로 **기동 + 현황 장부**를 둘 다 소유.

### 7.1 장부(현황판) 스키마
파일 기반: `<project>/.claude/mcp-server/set-{K}/{app}.json`
```json
{
  "set": 1,
  "owner": "<CMUX_SURFACE_ID>",
  "app": "guest-web",
  "env": "local",
  "dbTarget": "shared | branch:feat_x | dev | prod",
  "port": 5301,
  "url": "http://localhost:5301",
  "pid": 12345,
  "logPath": ".claude/mcp-server/set-1/guest-web.log",
  "startedAt": "2026-07-14T...",
  "status": "up | dead | orphan"
}
```

### 7.2 도구
| 도구 | 동작 |
|---|---|
| `set_up(set, apps[], env, owner?)` | 앱별 주입값 계산 → detached 기동(로그 파일) → 장부 기록 |
| `set_down(set, apps?)` | pid 종료 + 장부 정리 |
| `set_status(set?, all?)` | 장부 조회(기본 내 owner만, `all`=전체). 라이브 생존 확인 옵션 |
| `set_env(set, env)` | 그 세트 재기동(새 주입) |
| `set_db_branch(set, name)` | 격리 DB 복제 + 연결(그 세트 api `DATABASE_URL` 갱신 후 재기동) |
| `set_logs(set, app, tail?)` | 로그 조회 — TUI 로그 뷰 대체 |

### 7.3 프로세스 생명주기
- **detached 기동**(`child_process.spawn({detached:true, stdio: [ignore, logfd, logfd]})` + `unref()`) → 패널·MCP 재시작에도 서버 생존.
- stdout/stderr → `logPath` 파일(장부에 경로 보관).
- `set_status`가 pid 생존 확인 → 죽은/고아 항목 표시·정리.
- **가시성**: `set_status`는 TUI 백그라운드의 상위호환 — 크로스패널 + env·데이터소스·URL·세트 묶음까지.

### 7.4 owner 격리
- `set_up`이 `owner = CMUX_SURFACE_ID` 도장. `set_status` 기본은 내 세트만, `all:true`로 전체(매니저용). task-mcp의 격리 로직 재사용.

---

## 8. `run in background` 규칙 변경

- 기존: "개발 서버는 `run_in_background:true`로" (목적 = TUI 가시성).
- 변경: "**세트 서버는 서버관리 MCP로**". MCP가 더 많은 정보(env·데이터소스·URL·크로스패널)를 주므로 상위호환.
- 일회성 명령(빌드·테스트·curl 등)은 `run_in_background` 유지. → 규칙이 사라지는 게 아니라 **세트 서버에 한해 대체**.

---

## 9. admin 특수 처리 (2026-07-14 매니저 결정)

admin은 단일 env 앱이 아니라 **3-백엔드 크로스-env 콘솔**이다 — `lib/supabase.ts`가 `LOCAL/DEV/PROD` 각각 독립 Supabase 클라이언트를 만들고, `EnvContext`가 sessionStorage(`gorae-admin-selected-env`)로 브라우저에서 토글한다(env별 storageKey 분리). 따라서 "세트=단일 env"에 그대로 녹일 수 없다.

**결정: 정적 관례 매핑(static convention mapping).** admin이 어느 세트에서 뜨든 그룹→URL을 **고정 관례 포트**로 주입한다(자기 세트 포트·env 인자와 무관, 동적 조회 없음).

> **개정(2026-07-15, 링크 병기):** PROD 그룹의 **링크 키(GUEST/DIBANG)는 주입 제거** — admin에 localhost 링크가 노출되는 혼란 때문. 축 분리: **토글 = 데이터 소스, 링크 = 화면 위치**. PROD 링크는 `.env`의 배포 URL을 통과시키고, 로컬 화면은 `VITE_SET_GUEST_BASE_URL`(admin이 뜬 세트 K의 guest-web) 주입으로 배포 링크 옆 `[로컬 :52xx]` 병기 링크로 제공한다.

| admin 그룹 | 매핑 | 주입 |
|---|---|---|
| **PROD** | 데이터만 set0 | API `5280` (고정) · **GUEST/DIBANG 주입 안 함(.env 배포 URL 통과)** |
| **LOCAL** | set1 블록 | API `5380` · DIBANG `5300` · GUEST `5301` (고정) |
| **DEV** | `.env` 그대로 | **주입 안 함** ⚠ |
| **SET** | 자기 세트 K | `VITE_SET_GUEST_BASE_URL` = K의 guest-web (병기 링크용) |
| (공통) | Supabase | 그룹별 `VITE_{ENV}_SUPABASE_*`는 `.env` 값 유지 |

- **⚠ DEV 편차(명시):** DEV 그룹은 주입하지 않고 committed `.env` 값(dev API `8081`, 배포 onrender URL, dev Supabase `cvtcog…`)을 그대로 둔다. dev Supabase가 **이전 예정 보류**([[project_env_dev_on_hold]]) 상태라 세트로 배선할 대상이 없기 때문. dev 인프라 확정 시 LOCAL/PROD와 같은 관례로 승격.
- **자연 강등:** 매핑 대상 세트(set0/set1)가 안 떠 있으면 admin의 해당 토글은 연결 실패로 자연 강등된다(옛 `8080/8082` 미기동 때와 동일 UX). admin이 그 세트를 띄우진 않는다.
- **A안(미주입 순수 콘솔) 기각 이유:** committed `.env`의 고정포트 `8080/8082` 의존은 이 인프라가 옛 방식을 대체(task 16)하는 순간 깨진다. 관례 포트로 고정하면 인프라 전환에도 admin이 살아있다.
- **포트:** admin 자체는 세트0 블록 +3 = **5203**(`--port`로 config 기본 5300 오버라이드). 단 admin의 그룹 매핑은 5203과 무관하게 위 관례로 고정.

---

## 10. 롤아웃 (단계)

> **구현 현황(2026-07-14):** Phase 1–3 완료 — 게이트 A(다중 env 병렬·주입 격리·CORS)·B(guest/landing 실서빙·set_env 전환·admin 정적매핑)·C(형제 DB 격리·공유 auth/storage) 전부 통과. Phase 4: `server-mcp` user 스코프 등록 완료 + 5세트 동시 스모크 통과. 세트0 풀 실기동 검증만 사용자 승인 대기. 구현: `~/.claude/tools/server-mcp/server.mjs`. 태스크 장부: `.claude/tasks/2026-07-14-server-mcp/`.

| Phase | 내용 | 검증 게이트 |
|---|---|---|
| 0 | 세트0을 현행 포트 근처로 정의(하위호환). `use-env.sh`는 레거시 단일 모드로 유지 | 세트0만으로 기존 동작 재현 |
| 1 | MCP 최소기능(`set_up/down/status`), local·공유 DB만 | 세트0·세트1 병렬 기동, 포트·주입 격리 확인 |
| 2 | `set_env`(dev/prod 전환), `ALLOWED_ORIGINS`·상호참조 URL 주입 완성, admin 통합 | 세트별 다른 env 동시, CORS OK, admin 토글 정합 |
| 3 | `set_db_branch`(격리 DB), `set_logs`, 고아 정리 | A/B 스키마 격리 병렬 테스트 통과 |
| 4 | `run in background` 규칙 문서 갱신, `use-env.sh` 폐기 검토 | 문서·팀 합의 |

---

## 11. 리스크·미결정

**리스크**
- **메모리**: 5세트면 Vite 인스턴스 ~15개(개당 수백 MB) → 32GB 권장. "필요한 앱만 기동"으로 완화.
- **고아 프로세스**: detached 기동이라 방치 시 유령 서버 → `set_status` 생존 확인·정리 필수.
- **MCP 무게**: 프로세스 생명주기까지 책임 → task-mcp보다 안정성 부담 큼.
- **DB 복제 스냅샷**: 복제 후 신규 유저 부재(§6.2).

**결정 (2026-07-14, 매니저)**
1. 장부·기동 = **신규 MCP `server-mcp`** (`claude mcp add server --scope user`로 등록).
2. admin 포트 = **5203 이동**.
3. API = **블록 안(+80)**.
4. 세트0 기본 env = **prod**(확인용).
5. admin 그룹 매핑 = **정적 관례 매핑**(§9): PROD→set0 / LOCAL→set1 / DEV→`.env`(dev 보류 편차).

---

## 부록: 확인된 코드 근거
- FE env 키·상호참조: `apps/dibang-wedding/src/env.ts`, `apps/guest-web/.env.localhost`, `apps/*/src/lib/*` 폴백.
- Go config 키: `apps/api/server/config.go` (`PORT`, `DATABASE_URL`, `SUPABASE_*`, `ALLOWED_ORIGINS`, `ADMIN_EMAIL`, `UPLOAD_*`).
- 포트 고정: `apps/{dibang-wedding,guest-web,landing,admin}/vite.config.ts` (strictPort).
- 로컬 Supabase 포트: `supabase/config.toml`.
- FK 결합: `supabase/migrations/*` (`references auth.users`).
- 주입 우선순위: Vite `injected-sentinel` 실측 / Go :8099 프로브 실측.
