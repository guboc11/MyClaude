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

산출물은 일회성 화면 덤프가 아니라 **날짜별 스냅샷**이다. 그러므로 도출(집합 연산)은
모델의 자유 추론이 아니라 결정적 절차로 계산한다 (아래 "흐름 3단계: 검증" 참조).

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
│    ComponentA → ✅ useHookName → ✅ METHOD /api/path → HandlerName → QueryName → [DB] table_name
│    ComponentB → ✅ useHookName → 💬 METHOD /api/path (stub)
│    PageName → 💬 FeatureName (백엔드 미호출) → ✅ METHOD /api/path → HandlerName → QueryName → [DB] table_name
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
- `(SDK 미경유)` — 백엔드를 호출하긴 하나 SDK가 아닌 raw fetch로 우회
- `(placeholder)` — 페이지 껍데기만 존재
- `(미구현)` — 코드 자체가 없음

### 데이터 플로우 체인

한 줄에 하나의 데이터 흐름을 **컴포넌트에서 시작**해 쭉 이어 쓴다:
`Component → ✅ useHook → ✅ METHOD /path → Handler → Query → [DB] table`
체인 형태는 감지된 스택에 따라 달라진다 (흐름 1단계 참조).

규칙:
- **시작 노드는 컴포넌트**(아이콘 없음 — UI 노드). hook을 실제 호출하는 *가장 가까운* 컴포넌트를 쓴다(페이지가 직접 호출하면 페이지명). 같은 hook을 여러 컴포넌트가 부르면 줄을 나눠 각각 쓴다.
- **`[DB]`는 체인 마지막 테이블 직전**에 붙인다. endpoint 이후 ~ `[DB]` 직전 구간이 곧 핸들러·서비스 백엔드 구현체다. raw SQL이 여러 테이블이면 `[DB] tA / tB / tC`.
- **아이콘은 hook·endpoint 앞 2곳에만**(✅/💬). 컴포넌트·`[DB]`·테이블은 텍스트 노드라 아이콘을 붙이지 않는다.

체인에서 끊기는 지점 이후는 생략한다:
```
GuestbookList → ✅ useGuestbook → 💬 GET /lounges/{id}/guestbook (stub)
```

한 hook이 여러 API를 호출하면 여러 줄로 쓴다:
```
EditPanel → ✅ useSaveInvitation (step1) → ✅ POST /weddings → CreateWedding → InsertWedding → [DB] v3_weddings
EditPanel → ✅ useSaveInvitation (step2) → ✅ PATCH /weddings/{id}/invitation → UpdateInvitation → UpdateInvitation → [DB] v3_invitations
```

### UI 없는 엔드포인트

어떤 페이지에도 연결되지 않은 API 엔드포인트는 마지막에 별도 섹션으로 모은다.
**이 섹션은 산문 추측으로 만들지 않는다.** "흐름 3단계: 검증"의 결정적 집합 연산(⑥⑦)으로만 계산한다.
이 섹션은 UI 미연결이라 **Component 시작 노드가 없다** — endpoint부터 적고 `[DB]`는 동일하게 붙인다.

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 UI 없음 — 백엔드만 존재하거나 양쪽 미구현
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  리소스 그룹명
    ✅ METHOD /path → HandlerName → QueryName → [DB] table
    💬 METHOD /path (stub)
```

데드 hook(정의만 있고 어디서도 import 안 됨)과 비계약 raw 엔드포인트(opId 없음)는
별도 하위 섹션으로 분리한다:
```
  데드 hook (정의만, 미import — 호출로 치지 않음)
    useGuestbook → (참조 opId) ListGuestbookEntries

  비계약 엔드포인트 (opId 없음, 집합차 비대상)
    💬 POST /uploads (raw fetch, SDK·계약 외)
```

## 흐름 — 분석 → 표기 → 검증 → 저장

네 단계를 **순서대로** 수행한다. 각 단계는 앞 단계가 통과해야 진행한다.
단계를 섞지 않는다 — 분석·표기·검증을 한 번에 하면 정합성이 깨지고 산출물이 비재현이 된다.

---

### 1단계: 분석

#### 1-1. 스택 감지

아래 파일의 존재 여부로 판별한다:

| 감지 대상 | 판별 파일 | 스택 |
|-----------|----------|------|
| Go 백엔드 | `go.mod` | Go (Chi, net/http 등) |
| TS 백엔드 | `apps/api/**/*.ts` 또는 `server/**/*.ts` | Node/Express/Fastify |
| Next.js | `next.config.*` | Next.js (풀스택, 파일시스템 라우팅) |
| sqlc | `sqlc.yaml` 또는 `sqlc.json` | sqlc → Go 타입 안전 쿼리 |
| Prisma | `prisma/schema.prisma` | Prisma ORM |
| Drizzle | `drizzle.config.*` | Drizzle ORM |

**스택별 체인 구조:**

- **React + Go + sqlc**: `component → hook → endpoint → handler → query → [DB] table`
- **React + TS API + Prisma**: `component → hook → endpoint → handler → prisma.model.method → [DB] table`
- **Next.js App Router**: `component → server action / route handler → prisma → [DB] table`
- **Next.js Pages Router**: `component → hook → API route → handler → prisma → [DB] table`

**공통 프론트엔드 패턴 (스택 무관):**
```bash
fd "Page\.tsx$" apps/ src/                           # 페이지 파일
rg "Route.*path=|<Route" --glob "**/App.tsx"         # React Router 라우트
rg "^import" --glob "**/pages/*.tsx"                 # 페이지별 import
```

#### 1-2. rg/fd로 대상 좁히기 → 필요한 파일만 Read로 체인 조립

1-1에서 결정된 패턴으로 rg/fd를 실행해 "어떤 파일을 읽어야 하는지"를 좁힌다.
좁혀진 파일만 Read로 열어 component → hook → endpoint → handler → query → [DB] table 체인을 조립한다(컴포넌트→hook 엣지도 이때 관찰한다).
rg 결과만으로 체인이 이어지면 Read하지 않고, 안 이어지면 Read한다.
이 단계까지가 **관찰**(코드를 읽어 무엇을 호출하는지 파악)이며, LLM 판단이 필요한 유일한 영역이다.

#### 1-3. 백엔드·프론트 집합의 결정적 추출 (기계화)

도출에 쓸 두 집합을 **고정 명령**으로 추출한다. 모델이 눈으로 리스트를 만들지 않는다.
아래는 **React + Go(oapi-codegen) + sqlc** 스택 기준이다. 다른 스택은 동일 원리로 정본 추출원을 1개 고정한다.

**① 백엔드 라우트표 (정본: `server.gen.go` chi 등록 블록)**
```bash
grep -oE 'r\.(Get|Post|Put|Patch|Delete)\(options\.BaseURL\+"[^"]*", wrapper\.[A-Za-z]+\)' apps/api/server/server.gen.go \
  | sed -E 's/r\.([A-Za-z]+)\(options\.BaseURL\+"([^"]*)", wrapper\.([A-Za-z]+)\)/\1 \2 -> \3/' \
  | sort -k2
```
- 전제: oapi-codegen은 operation당 등록을 정확히 1개 방출 → chi 등록 블록 = 전체 라우트 표면.
- 완전성 교차검증(필수): 추출 opId 집합이 `grep -oE 'wrapper\.[A-Za-z]+' … | sed 's/wrapper\.//' | sort -u` 와 **완전 일치**해야 한다. 불일치 시 정규식 메서드군(Get|Post|Put|Patch|Delete) 확장 검토.

**② stub(501) 집합 (`server.go`)**
```bash
grep -oE 'notImplementedResponse\{"[A-Za-z]+"\}' apps/api/server/server.go \
  | sed -E 's/.*\{"([A-Za-z]+)"\}/\1/' | sort -u
```
느슨한 `rg "notImplemented"`(주석까지 매칭) 금지. 위 고정 패턴만 사용.

**③ 프론트 호출 opId (평면 grep + 네이밍 규칙)**
- 대상: 라우팅된 페이지가 import하는 배선 계층 = 각 앱 `src/hooks`, `src/queries`.
- 거기서 `@gorae/contracts`로부터 import된 식별자를 모아 opId로 정규화:
```bash
… | sed -E 's/(QueryKey|Options|Mutation|InfiniteQueryKey|InfiniteOptions)$//' \
   | perl -pe 's/^(.)/\U$1/' | sort -u
```
- 검증된 규칙: `react-query.gen.ts`는 `<camel>{QueryKey|Options|Mutation|InfiniteQueryKey|InfiniteOptions}`, `sdk.gen.ts`는 `<camel>`(접미사 없음). 공통 "접미사 제거 + 첫 글자 대문자 = operationId". 두 표면 모두 백엔드 opId 집합과 완전 일치함이 확인됨.
- **macOS 주의**: BSD `sed`는 `\U` 미지원 → 첫 글자 대문자화는 반드시 `perl -pe 's/^(.)/\U$1/'`.
- 판정 기준은 **평면 grep**(hooks·queries에 import되어 있으면 호출로 봄). 라우트→page→hook 완전 도달성 추적은 추후 확장.

**④ raw fetch (SDK 우회) 보정**
```bash
rg -n 'fetch\(' apps/*/src
```
- (2a) URL이 ①의 백엔드 라우트에 매칭 → 호출집합에 **추가**하고 출력엔 `💬 SDK 미경유` 태그.
- (2b) 매칭되는 opId 없음(예 `/uploads`) → 집합차 **비대상**, "비계약 엔드포인트(opId 없음)" 별도 노트.

**⑤ 데드 hook 보정**
- 각 hook 심볼에 대해 `rg -l '\buseX\b' apps/*/src` 결과가 **정의 파일 1개뿐**이면 데드.
- 데드 hook이 감싼 opId는 호출집합에서 **제외** → "UI 없음"에 정직하게 남는다.
- 데드 hook 자체는 "데드 hook(정의만, 미import)" 별도 섹션에 기록.

#### 1-4. 대규모 프로젝트 분리

앱이 3개 이상이거나 페이지가 총 15개 이상이면, 앱별로 서브에이전트를 분리해 병렬 실행한다.
각 서브에이전트는 자기 앱의 라우팅 + 페이지 상세를 출력하고, **마지막 줄에 반드시**
`CALLED_OPERATIONS: Op1, Op2, …` 형식으로 ③④로 추출한 호출 opId를 기계 판독 가능하게 반환한다
(산문 금지 — 메인이 합집합·집합차를 결정적으로 계산하기 위함).

---

### 2단계: 표기

위 "출력 구조"의 포맷 규칙을 적용해 앱 → 라우팅 → 페이지 간 이동 → 페이지 상세 박스를 작성한다.
이 단계는 1단계 산출(체인·집합)을 사람이 읽는 형태로 렌더링만 한다. 새 사실을 만들지 않는다.

---

### 3단계: 검증 (게이트 — 통과 못 하면 4단계 금지)

**⑥ UI 없음 = 집합차 (결정적)**
- `UI없음 = 백엔드라우트(①) − 호출집합(③ ∪ ④2a, ⑤데드 제외)`
- `comm -23 <(backend_ops|sort -u) <(called_ops|sort -u)` 같은 집합 연산으로 계산. 모델 머릿속 산수 금지.
- 각 항목이 stub집합(②)에 있으면 `💬 (stub)`, 없으면 `✅ (백엔드 구현, 프론트 미호출)`.

**⑦ 정합성 자가검증**
- `|backend| == |called ∩ backend| + |UI없음|`
- `called ⊆ backend` (호출집합에 백엔드에 없는 opId가 있으면 ③ 추출 오류)
- **불일치 → 검증 실패**: 4단계(저장) 진입을 차단하고, 출력 말미에 불일치 opId를 명시한다.
- 출력 헤더에 `라우트 N = 호출 X + 미연결 Y` 한 줄을 적어 숫자가 맞물림을 보인다.

---

### 4단계: 저장 (검증 통과 시에만)

검증(3단계)이 통과한 경우에만 산출물을 영속화한다. 통과 못 하면 저장하지 않는다.

- 저장 위치·네이밍: **`_wiring/wiring-{YYYY-MM-DD}.md`** 와 **`_wiring/wiring-{YYYY-MM-DD}.pdf`** 두 형식.
  - `{YYYY-MM-DD}`는 실행일. 두 파일 내용은 동일(.md = 본문 그대로, .pdf = 그 렌더).
  - **같은 날 재실행 충돌 규칙**: 그날 첫 산출물은 접미사 없이 `wiring-{날짜}`,
    2번째부터 `wiring-{날짜}-2`, `-3` … 로 붙인다(첫 실행에 `-1`을 붙이지 않는다 —
    기존 형제 파일·`-lg` 선례와 일관). `.md`/`.pdf`는 **동일 접미사 쌍**으로 함께 만든다.
  - 접미사 인덱스는 기계적으로 결정: `ls _wiring/wiring-{날짜}*` 를 스캔해
    이미 있는 최대 인덱스 + 1 을 쓴다(없으면 접미사 없음). 기존 파일을 덮어쓰지 않는다.
- 기존 `_wiring/` 자산과 정합: 네이밍 컨벤션 동일. PDF 생성은 `_wiring/generate-pdf.py`가 있으면 재사용,
  없으면 HTML→Chrome headless(monospace, CJK 더블폭 정렬 보존, 박스 깨짐 없게).
- 레포 루트 등 다른 위치에 저장 금지. 임시 HTML/이미지는 `/tmp` 또는 `.playwright-mcp/` 하위에만 만들고 정리한다.
- 저장 완료 후 산출물 경로를 보고한다.

## 추후 확장 (Future) — 지금은 안 하지만 폐기도 아님

- **스냅샷 간 diff**: 전회 스냅샷 대비 신규 배선 / 신규 단절 / 회귀를 산출하는 기능.
  현재 범위는 스냅샷 1장의 표현 품질에 집중하므로 **하지 않는다**. 다만 폐기가 아니라 *추후 확장*이다.
  ⑦ 자가검증을 통과한 결정적 산출물이 전제될 때 비로소 날짜별 스냅샷 diff가 의미를 가진다.
  현 시점 에이전트는 요청 없이 임의로 diff를 끼워넣지 않는다.
- **프론트 완전 도달성**: 라우트 → page import → … → hook → opId 그래프 추적.
  현재는 평면 grep(1-3 ③)으로 충분. 거짓 음성이 문제될 때 확장.

## 하지 말 것

- **추측하지 않는다.** 실제 코드를 읽고 확인한 것만 출력한다. import가 있으면 연결된 것이고, 없으면 없는 것이다.
- **개선 제안을 하지 않는다.** 이 스킬은 현재 상태를 보여주는 것이 목적이다. "~하면 좋겠다"는 쓰지 않는다.
- **소스 코드를 수정하지 않는다.** 1~3단계(분석·표기·검증)는 읽기 전용이다. 파일 생성은 오직 4단계 저장에서 `_wiring/` 산출물(.md/.pdf)에 한한다.
- **도출을 머릿속으로 계산하지 않는다.** UI 없음(⑥)·정합성(⑦)은 반드시 집합 연산 명령으로 계산한다.
- **박스 오른쪽 벽을 쓰지 않는다.** 한글/영문 혼합 시 정렬이 깨진다.
- **라우팅 포맷을 임의로 바꾸지 않는다.** 위 라우팅 포맷 규칙을 정확히 따른다.
