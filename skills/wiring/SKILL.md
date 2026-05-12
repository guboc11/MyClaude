---
name: wiring
description: >
  프로젝트의 UI → Hook → API → Handler → DB 전체 연결 상태를 앱별·페이지별로 점검하는 스킬.
  각 레이어가 제대로 배선되어 있는지, 어디서 끊기는지를 한눈에 보여준다.
  Use this skill ONLY when the user explicitly invokes /wiring. Do not auto-trigger.
---

# Wiring — 프로젝트 배선 점검 스킬

## 왜 이 스킬이 필요한가

프로젝트가 커지면 "이 UI가 어떤 hook을 쓰고, 어떤 API를 호출하고, 백엔드에서 어디까지 구현되어 있는지"를
한눈에 파악하기 어렵다. 이 스킬은 전체 레이어의 연결 상태를 앱별·페이지별로 시각화해서
어디가 연결되어 있고, 어디서 끊기는지를 즉시 보여준다.

## 출력 구조

### 앱 단위 구분

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 앱 이름
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

각 앱 아래에 세 섹션을 둔다:

1. **라우팅** — 어떤 경로가 어떤 페이지로 연결되는지
2. **페이지 간 이동** — 사용자 행위(버튼, 클릭)로 어떤 페이지에서 어떤 페이지로 이동하는지
3. **페이지 상세** — 각 페이지의 컴포넌트 + 데이터 플로우

### 라우팅 — 포맷 규칙

**이 규칙을 반드시 따른다. 다른 형태로 그리지 않는다.**

- 경로와 페이지명 사이에 `──→` 를 사용한다 (단순 `→` 금지)
- 모든 경로의 `──→` 시작 위치를 가장 긴 경로 기준으로 정렬한다
- 리다이렉트는 `/ ───────────────────→ /target (리다이렉트)` 형태로 첫 줄에 배치
- 레이아웃으로 묶이는 라우트는 `┐│┘` 로 그룹 표시하고, `┘` 옆에 레이아웃명을 쓴다
- 레이아웃 내 부가 설명이 있으면 `│` 옆에 괄호로 표시 (예: `│ (하단 탭)`)

```
라우팅
  / ───────────────────→ /login (리다이렉트)
  /login ──────────────→ LoginPage
  /my-wedding ─────────→ MyWeddingPage        ┐
  /weddings ───────────→ WeddingListPage       │ MainLayout
  /qr ─────────────────→ QrPage                │ (하단 탭)
  /settings ───────────→ SettingsPage          ┘
  /invitation/create ──→ InvitationCreatePage
  /invitation/edit/:id → InvitationEditPage
```

### 페이지 간 이동

```
페이지 간 이동
  PageA → "버튼 텍스트" → PageB
  PageA → SomeCard 클릭 → PageC
```

미구현된 이동이면 💬 표시:
```
  PageA → "로그인하고 입장하기" → 💬 다른앱 리다이렉트 (미구현)
```

### 페이지 상세 — 박스 형태

각 페이지는 왼쪽 벽만 있는 박스로 감싼다. 오른쪽 벽은 쓰지 않는다 (한글/영문 혼합 시 정렬 깨짐 방지).

```
┌──────────────────────────────────────
│ PageName  /route/path
│
│  Components
│    ComponentA
│    ComponentB
│
│  Data flows
│    ✅ useHookName → ✅ METHOD /api/path → HandlerName → QueryName → table_name
│    ✅ useHookName → 💬 METHOD /api/path (stub)
│    💬 FeatureName (백엔드 미호출) → ✅ METHOD /api/path → HandlerName → QueryName → table_name
│
└──────────────────────────────────────
```

placeholder 페이지는 간결하게:
```
┌──────────────────────────────────────
│ PageName  /route/path
│
│  💬 placeholder — "구현 예정"
│
└──────────────────────────────────────
```

### 상태 표시 규칙

**아이콘은 두 곳에만 붙인다**: hook 맨 앞, API endpoint 맨 앞.
- `✅` — 구현되어 동작함
- `💬` — 미구현, stub, 또는 연동 안 됨

**구현된 노드는 이름만 쓴다.** 문제 있는 노드만 괄호로 상태를 명시한다:
- `(stub)` — 백엔드 501 stub
- `(백엔드 미호출)` — 백엔드는 있는데 프론트에서 호출 안 함
- `(placeholder)` — 페이지 껍데기만 존재
- `(미구현)` — 코드 자체가 없음

### 데이터 플로우 체인

한 줄에 하나의 데이터 흐름을 쭉 이어 쓴다. 체인 형태는 감지된 스택에 따라 달라진다 (흐름 0단계 참조).

체인에서 끊기는 지점 이후는 생략한다:
```
✅ useGuestbook → 💬 GET /lounges/{id}/guestbook (stub)
```

한 hook이 여러 API를 호출하면 여러 줄로 쓴다:
```
✅ useSaveInvitation (step1) → ✅ POST /weddings → CreateWedding → InsertWedding → v3_weddings
✅ useSaveInvitation (step2) → ✅ PATCH /weddings/{id}/invitation → UpdateInvitation → UpdateInvitation → v3_invitations
```

### UI 없는 엔드포인트

어떤 페이지에도 연결되지 않은 API 엔드포인트는 마지막에 별도 섹션으로 모은다.

**수집 알고리즘:**
1. **전체 엔드포인트 목록 추출** — OpenAPI spec(`api-contract.yaml`), 라우터 정의, 또는 자동생성 인터페이스(server.gen.go, route 파일 등)에서 수집
2. **프론트에서 호출 중인 엔드포인트 수집** — 1단계 rg 결과에서 import된 SDK 함수 / fetch URL / hook 내부 호출을 추출
3. **1에서 2를 빼면 UI 미연결 엔드포인트**

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 UI 없음 — 백엔드만 존재하거나 양쪽 미구현
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  리소스 그룹명
    ✅ METHOD /path → HandlerName → QueryName → table
    💬 METHOD /path (stub)
```

## 흐름

### 0단계: 스택 감지

프로젝트의 기술 스택을 파악하여 이후 단계에서 사용할 패턴과 체인 구조를 결정한다.
아래 파일의 존재 여부로 판별한다:

| 감지 대상 | 판별 파일 | 스택 |
|-----------|----------|------|
| Go 백엔드 | `go.mod` | Go (Chi, net/http 등) |
| TS 백엔드 | `apps/api/**/*.ts` 또는 `server/**/*.ts` | Node/Express/Fastify |
| Next.js | `next.config.*` | Next.js (풀스택, 파일시스템 라우팅) |
| sqlc | `sqlc.yaml` 또는 `sqlc.json` | sqlc → Go 타입 안전 쿼리 |
| Prisma | `prisma/schema.prisma` | Prisma ORM |
| Drizzle | `drizzle.config.*` | Drizzle ORM |

**스택별 rg 패턴:**

Go 백엔드:
```bash
rg "^func \(s \*Server\)" apps/api/server/handler_*.go   # 구현된 핸들러
rg "notImplemented" apps/api/server/server.go              # stub 목록
rg "^func \(q \*Queries\)" apps/api/db/                    # sqlc 쿼리
```

TS 백엔드:
```bash
rg "export.*(handler|router|controller)" --glob "**/*.ts" apps/api/  # 핸들러
rg "TODO|not.?implemented|501" --glob "**/*.ts" apps/api/             # stub
rg "prisma\.\w+\.(find|create|update|delete)" --glob "**/*.ts"       # Prisma 쿼리
```

Next.js:
```bash
fd "page\.tsx$" app/                              # App Router 페이지
fd "route\.ts$" app/                              # API Route Handlers
rg "export.*(GET|POST|PUT|PATCH|DELETE)" --glob "**/route.ts"  # API 핸들러
```

**스택별 체인 구조:**

- **React + Go + sqlc**: `hook → endpoint → handler → query → table`
- **React + TS API + Prisma**: `hook → endpoint → handler → prisma.model.method → table`
- **Next.js App Router**: `component → server action / route handler → prisma → table`
- **Next.js Pages Router**: `hook → API route → handler → prisma → table`

**공통 프론트엔드 패턴 (스택 무관):**
```bash
fd "Page\.tsx$" apps/ src/                           # 페이지 파일
rg "Route.*path=|<Route" --glob "**/App.tsx"         # React Router 라우트
rg "^import" --glob "**/pages/*.tsx"                 # 페이지별 import
```

### 1단계: rg/fd로 대상 좁히기

0단계에서 결정된 패턴으로 rg/fd 명령을 실행하여 관련 파일과 줄 번호를 수집한다.
이 단계의 목적은 "어떤 파일을 읽어야 하는지"를 빠르게 파악하는 것이다.

### 2단계: 필요한 파일만 Read로 체인 조립

1단계에서 좁혀진 파일만 Read로 열어, hook → endpoint → handler → query → table 체인을 조립한다.
rg 결과만으로 체인이 이어지면 Read하지 않고, 안 이어지면 Read한다.

예: rg로 `import { useGuestbook }` 을 찾았으면, `useGuestbook.ts`를 Read해서 내부에서 어떤 API를 호출하는지 확인한다.

### 3단계: 출력

앱 → 라우팅 → 페이지 간 이동 → 페이지 상세 박스 → UI 없는 엔드포인트 순서로 출력한다.

### 대규모 프로젝트 분리

앱이 3개 이상이거나 페이지가 총 15개 이상이면, 앱별로 서브에이전트를 분리하여 병렬 실행한다.
각 서브에이전트가 자기 앱의 라우팅 + 페이지 상세를 출력하고,
메인이 결과를 합쳐서 "UI 없는 엔드포인트" 섹션을 붙인다.

## 하지 말 것

- **추측하지 않는다.** 실제 코드를 읽고 확인한 것만 출력한다. import가 있으면 연결된 것이고, 없으면 없는 것이다.
- **개선 제안을 하지 않는다.** 이 스킬은 현재 상태를 보여주는 것이 목적이다. "~하면 좋겠다"는 쓰지 않는다.
- **코드를 수정하지 않는다.** 읽기 전용 스킬이다.
- **박스 오른쪽 벽을 쓰지 않는다.** 한글/영문 혼합 시 정렬이 깨진다.
- **라우팅 포맷을 임의로 바꾸지 않는다.** 위 라우팅 포맷 규칙을 정확히 따른다.
