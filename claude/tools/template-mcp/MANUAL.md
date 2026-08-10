# template(MCP) — 매뉴얼

## 이름

**template** — 규칙 폴더의 정의·항목 생성·월 묶기·README 조항 개정을 맡는 MCP

## 형식

```
template_register      (name)
template_add           (name, title, tag?, summary?)
template_pack          (name)
template_list          ()
template_clause_set    (name, addr, title?, body?)
template_clause_remove (name, addr)
```

## 설명

날짜 접두로 반복 생산되는 규칙 폴더(_AUDIT·_RESEARCH·_E2E·_PLAN)를 template 정의 하나로
통째 관리한다. 엔진은 프로젝트를 모르고, 정의는 `.claude/templates/{name}/`에 산다(커밋, 팀 공유).
설계·합의 전문: `_PLAN/2026-07-31-template-mcp/PLAN.md`.

고정 규칙 (엔진에 박힘 — 정의로 못 바꿈):

- **날짜는 시스템 오늘** — 입력 인자 자체가 없어 명명 위반이 원천 차단된다.
- **항목은 폴더 루트에 생성**(바로 보이게), **매월 5일 이후 `template_pack` 명시 호출로만**
  지난달 이하를 `{YYYY-MM}/` 월 폴더로 묶는다. 1~4일에는 직전 달 유예.
- **자동 실행 없음** — cron·타이머·훅 발동 코드가 없다. 전부 호출형.
  `template_add`는 미묶음이 있으면 알림만 한다.
- 이동은 추적 항목이면 `git mv` 개별 경로(이력 보존), 미추적이면 파일 이동.
- README·INDEX 밖의 기존 파일은 절대 건드리지 않는다.
- 번호 이력·결번 관리 없음 — 번호는 쓰는 쪽 책임, "번호 개편은 인용처와 함께 갱신" 관례가 담당.

## 정의 폴더 구조

```
.claude/templates/{name}/
  config.json     # folder · item_pattern · tags · index
  README.md       # 대상 폴더 README의 원본 (진실원 — 개정은 clause 도구로만)
  stubs/          # 항목 생성 시 깔아줄 뼈대 (치환 변수: {item} {date} {title} {tag} {summary})
```

config.json 필드:

| 필드 | 예 | 설명 |
|---|---|---|
| folder | `"_AUDIT"` | 대상 폴더 (프로젝트 루트 기준, 중첩 경로 허용) |
| item_pattern | `"{date}-{TAG}-{title}"` | 항목 폴더 이름 틀. `{TAG}` 있으면 tag 필수 |
| tags | `["SWEEP","PROBE"]` | 태그 어휘 (닫힌 집합). 태그 없는 폴더는 `[]` |
| index | `{file, section, row, insert}` 또는 `null` | INDEX 등재 방식. row 치환 변수 동일 |

## 도구

### template_register(name)

정의를 대상 폴더에 반영한다. 폴더가 없으면 **창설**(폴더+README+INDEX 뼈대),
있으면 README만 정의본으로 재생성(INDEX·기존 파일 무접촉). README가 생기는 순간
onboarding MCP 주제로 자동 편입된다(발견 규약).

### template_add(name, title, tag?, summary?)

항목을 틀대로 생성한다 — 오늘 날짜, 태그 어휘·kebab-case 검증, 동명 거부,
stubs 복사(치환), INDEX 등재(최신 위). 끝에 미묶음 현황을 알려준다(실행은 안 함).

### template_pack(name)

지난달 이하의 루트 항목을 월 폴더로 묶는다. 5일 미만이면 직전 달 유예,
미묶음 0건이면 거부. INDEX의 항목 링크도 월 폴더 경로로 갱신. 멱등.

### template_list()

등록 template 목록 + 폴더별 미묶음 현황.

### template_clause_set(name, addr, title?, body?) / template_clause_remove(name, addr)

README 개정의 유일한 경로. addr 3형 — `definition`(예약) / 번호(`2-3`, 급=깊이,
새 하위는 부모 필수) / 무주소 헤더 텍스트. set은 없으면 추가(최상위·무주소는 문서 끝,
하위는 부모 서브트리 끝), 있으면 **자기 본문만 교체**(하위 조항 보존). remove는 번호 조항이면
하위까지 통째 제거(출력에 명시). 정의 폴더와 대상 폴더 README를 동시 갱신한다.
파서는 onboarding과 같은 판별 규칙 — 쓰는 쪽과 읽는 쪽의 문법이 한 몸.

## 진단 (에러 메시지)

| 메시지 | 원인 |
|---|---|
| `정의 폴더 없음: ...` + 등록 목록 | name 오타·미등록 |
| `config 필수키 누락: ...` | folder·item_pattern 없음 |
| `tag가 어휘 밖입니다 / tag가 필요합니다` | tags 닫힌 집합 위반 |
| `title이 kebab-case가 아닙니다` | 소문자 영문·숫자·하이픈만 |
| `동명 항목이 이미 있습니다` | 같은 날짜·제목 재생성 |
| `미묶음 0건 — 묶을 항목이 없습니다` | pack 대상 없음 (유예 중이면 사유 병기) |
| `부모 조항 없음: ...` | 하위 번호 신규인데 부모 부재 |
| `없는 주소: ...` | remove·set 대상 부재 |
| `register 전입니다 — 대상 README 없음` | clause 도구를 register보다 먼저 호출 |

## 파일

| 경로 | 역할 |
|---|---|
| `.claude/tools/template-mcp/server.mjs` | 서버 본체 (무의존 stdio) |
| `.claude/tools/template-mcp/MANUAL.md` | 이 문서 |
| `.claude/templates/{name}/` | template 정의 (audit·research·e2e·plan 등록됨) |

## 설치

`.mcp.json`에 등록됨 (프로젝트 스코프, 상대경로):

```json
"template": { "type": "stdio", "command": "node", "args": [".claude/tools/template-mcp/server.mjs"] }
```

도구 노출은 등록 후 **새 세션부터**. 서버 코드 수정 후에는 MCP 재연결(/mcp) 필요.

## 예시

```
template_add("audit", "storage-path-recheck", tag="SWEEP", summary="스토리지 경로 재감사")
→ _AUDIT/2026-08-02-SWEEP-storage-path-recheck/ 생성 + INDEX 등재 + "미묶음 6건" 알림

template_pack("audit")            ← 8월 5일 이후: 7월 항목들을 2026-07/로
template_clause_set("plan", "2-4", title="부속 로그", body="...")   ← README 조항 추가
template_clause_remove("research", "2-2")   ← 하위 없으면 그 조항만 제거
```
