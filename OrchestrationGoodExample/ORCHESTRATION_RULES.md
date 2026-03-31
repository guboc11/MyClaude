# Orchestration Rules

ORCHESTRATION.md의 원칙과 구조를 실행하기 위한 구체적 규칙.

## 기준 디렉터리

모든 경로는 모노레포 루트(`/Users/taewonpark/Github/WORK/GoraeUniverse/web-mobile-application/`) 기준.
- 메모리북 코드: `apps/web-app/src/pages/host/memorybook/`
- 리서치: `apps/web-app/src/pages/host/memorybook/v{N}/research/`

## 싸이클 폴더 구조

각 싸이클은 `v{N}/` 폴더 아래에 모든 산출물을 관리한다.

```
v{N}/
├── research/
│   ├── REFERENCES.md
│   ├── {리서치 주제}.md
│   ├── INSIGHTS.md
│   └── CONCLUSION.md
├── DESIGN.md
├── PLAN.md
├── MemoryBookV{N}.tsx
└── REVIEW.md
```

## 구현 기술

- React 웹 컴포넌트 (TSX)
- 모든 싸이클: 단일 페이지(스크롤) 구성

### 필수 구성 요소

1. **표지** — 웨딩메모리북의 첫 화면
2. **MEC 디스플레이 프리뷰** — 공통 컴포넌트(`DisplayWeddingMemoryBook`) 단순 import
3. **하객 메시지 + 하객 사진** — 메시지와 사진(최대 30장)이 따로 나열되는 것이 아니라, 함께 조화롭게 어우러지도록 구성
4. **아름다움 증폭 요소** — 애니메이션, 레이아웃, 배경 등 감성 품질을 끌어올리는 디테일

### 모바일 스크롤 규칙

웨딩메모리북은 모바일 우선 단일 페이지 스크롤 구성이므로, 터치 스크롤을 방해하는 CSS를 사용하지 않는다.

- **`overflow: hidden` 금지 (섹션·컨테이너 레벨)**: 모바일에서 `overflow: hidden`은 스크롤 컨테이너를 생성하여 터치 스크롤이 해당 영역에 "끼이는" 현상을 유발한다. 이미지 클리핑, 애니메이션 영역 제한 등이 필요할 경우 `overflow: clip`을 사용한다. (`overflow: clip`은 시각적으로 동일하게 클리핑하면서 스크롤 컨테이너를 생성하지 않는다.)
- **예외**: 소형 요소(아바타, 썸네일 등 고정 크기 요소)의 `overflow: hidden`은 허용. `borderRadius`와 함께 이미지를 원형/라운드로 클리핑하는 패턴은 스크롤 트래핑을 유발하지 않는다.
- **`position: fixed` 전체 뷰포트 오버레이**: `pointer-events: none` 필수. `width: 100vw` 대신 `width: 100%` 권장 (모바일 스크롤바 너비로 인한 가로 오버플로우 방지).

## 에이전트 투입 구성

| 단계 | 모델 | 최대 수 | 비고 |
|------|------|---------|------|
| research (리서치 수행) | Sonnet | 5기 | 병렬 리서치 |
| research (취합) | Opus | 1기 | INSIGHTS.md, CONCLUSION.md 작성 |
| planning (DESIGN.md, PLAN.md) | Opus | 1기 | |
| dev (구현) | Sonnet | 3기 | 병렬 처리 시 최대 3기 |
| 단계별 리뷰 | Opus | 1기 | research, planning, dev 각 리뷰 |
| 최종 통합 리뷰 | Opus | 1기 | |

## Seed 공급

각 싸이클의 seed는 독립적으로 결정한다. 이전 싸이클에 종속되지 않는다.
- 오케스트레이터가 매 싸이클마다 seed를 지정한다.
- 이전 싸이클에서 사용한 무드·레퍼런스와의 중복은 지양하되, 싸이클이 늘어날수록 겹침은 불가피하므로 허용한다.
- 비슷해 보이더라도 결과물이 아름답고 예쁘면 된다. 다양성은 수단이지 목적이 아니다.

## Phase 전환 조건

### idle → research
- 조건: `currentCycle < maxCycles`
- 행동: `currentCycle++`, `currentPhase = "research"`, `currentVersion = "v{currentCycle}"`, `v{N}/research/` 폴더 생성
- seed 입력: 오케스트레이터가 독립적으로 지정

### research → research 리뷰
- 조건: REFERENCES.md, 최소 1개 이상의 개별 리서치 파일({주제}.md), INSIGHTS.md, CONCLUSION.md가 모두 존재
- 리뷰 기준:
  - 주제에 대한 소스를 충분히 수집했는가 (양과 질)
  - 같은 컨셉의 소스만 반복 수집하지 않았는가: 주제와 방향성은 일관되어야 하지만, 같은 컨셉의 소스만 계속 모으면 비슷한 인사이트만 쌓인다. 컨셉이 같다는 것은 세부 업종까지 같은 것을 말한다 — 예를 들어 모바일청첩장 업체 A, B, C는 같은 컨셉이지만, 모바일청첩장 업체와 결혼식장, 스튜디오, 헤어메이크업은 서로 다른 컨셉이다. 같은 컨셉은 2~3개면 충분하고, 이후에는 목적에 부합하는 다른 컨셉의 소스를 찾아야 한다. 
  - 결혼 관련 업체에서 더 볼 게 없다면, 디자인 레퍼런스를 위해 건축, 패션, 에디토리얼 등 전혀 다른 영역도 과감히 봐야 한다. 어디서 찾든 상관없다 — 중요한 것은 이번 싸이클의 목적에 맞는 인사이트를 얻을 수 있느냐다.
  - 이전 싸이클과 너무 겹치는 소스가 많지 않은가
  - '형식적인 리서치'가 아니라 다른 사람이 봐도 '진짜 리서치'를 했다고 느낄 수 있는가
- 통과: `currentPhase = "planning"`
- 미달: 리서치 보완 후 재리뷰 (최대 2회, 초과 시 버전 전체 스킵)

### planning → planning 리뷰
- 조건: DESIGN.md, PLAN.md가 모두 존재
- 리뷰 기준:
  - DESIGN.md: 리서치 CONCLUSION.md와의 연결성, 감성 방향의 명확성
  - PLAN.md: 수치·레이아웃·컬러·타이포그래피가 구체적으로 명시되었는가, PLAN.md만 보고 구현 가능한 수준인가
  - DESIGN.md ↔ PLAN.md 일관성: PLAN.md가 DESIGN.md의 방향을 충실히 구체화했는가
- 통과: `currentPhase = "dev"`
- 미달: 기획 보완 후 재리뷰 (최대 2회, 초과 시 버전 전체 스킵)

### dev → dev 리뷰
- 조건: `v{N}/MemoryBookV{N}.tsx` 파일이 존재
- 리뷰 절차:
  1. **빌드 실행 필수**: `pnpm build`를 실행하여 빌드가 성공하는지 확인한다. 빌드 에러가 있으면 에러를 수정한 뒤 재빌드하여 통과시킨다. 빌드 통과 없이 리뷰를 통과시키지 않는다.
  2. **코드 리뷰**: PLAN.md 대비 구현 충실도, DESIGN.md의 감성 방향이 구현에서 체감되는가
- 통과: `currentPhase = "review"`
- 미달: 구현 수정 후 재리뷰 (최대 2회, 초과 시 버전 전체 스킵)

### review (최종 통합 리뷰) → done
- DESIGN.md·PLAN.md·구현물을 종합 평가
- 평가 차원 (각 5점 척도):
  - 감성 품질: "이걸 받은 신랑·신부가 감동할 수 있는가"
  - DESIGN.md 대비 충실도: 기획 의도가 구현에 반영되었는가
  - 이전 버전과의 차별성: 구조·무드·타이포그래피·인터랙션 중 최소 두 축이 다른가
- 감성 품질 3점 미만: 수정 필요. 수정 후 재평가 (최대 1회).
- REVIEW.md 작성: 최종 통합 리뷰 phase에서 생성. 평가 점수·피드백·다음 버전 제안을 포함.
- 행동:
  1. `completedVersions`에 현재 버전 추가
  2. `usedReferences`에 이번 리서치의 레퍼런스 추가
  3. `usedMoods`에 이번 버전의 무드 추가
  4. `suggestions`에 리뷰의 "다음 버전 제안" 추가
  5. `currentPhase = "idle"`, `phaseRetryCount = 0`

### done → idle
- `currentCycle >= maxCycles`: 루프 종료, 사용자에게 전체 요약 보고
- `currentCycle < maxCycles`: 사용자에게 이번 싸이클 결과 보고. 사용자는 이 시점에서 루프 종료/방향 수정/계속 진행을 지시할 수 있다.

## 다양성 규칙

ORCHESTRATION 원칙 2("진짜 다른 시도를 한다")를 실행하기 위한 규칙:
- 이전 버전의 `usedReferences`·`usedMoods`와의 중복은 지양한다. 단, 싸이클이 늘어날수록 겹침은 허용한다.
- planning 리뷰 시 이전 버전과의 차이를 확인하되, 비슷해 보이더라도 결과물이 더 아름다우면 통과시킨다.
- 최종 판단 기준은 다양성이 아니라 감성 품질이다.

## 에러 처리

- 단계별 리뷰 미달: 해당 단계 보완 후 재리뷰 (최대 2회)
- 2회 재리뷰 후에도 미달: **해당 버전 전체 스킵** (`currentPhase = "idle"`, `lastError` 기록). 각 단계의 산출물은 다음 단계에 종속되므로, 개별 phase만 스킵하면 이후 phase가 실행 불가능하다.
- Agent spawn 실패: `lastError`에 기록, `spawnRetryCount++`. 2회 연속 실패 시 해당 버전 전체 스킵.
- 파일 미존재 (예: DESIGN.md 없이 dev 진입): 해당 phase 재실행

## 오케스트레이터 동작 방식

오케스트레이터는 **경량 반복 머신**이다. 토큰을 최소화하고 싸이클을 최대한 많이 돌리는 것이 목표다.

### 통신 규칙
- 오케스트레이터 ↔ 에이전트 간 모든 소통은 **파일**로 한다. 오케스트레이터가 에이전트에게 대화로 답변하지 않는다.
- 에이전트에게 전달할 작업 지시, 컨텍스트, 이전 단계 산출물 경로 등은 모두 파일에 작성하고 에이전트에게 해당 파일을 읽도록 지시한다.
- 에이전트는 작업 완료 후 **짧은 완료 메시지만** 오케스트레이터에게 반환한다 (예: "research 완료. 산출물: v1/research/").
- 오케스트레이터는 완료 메시지를 받으면 산출물 파일을 직접 읽어 다음 행동을 결정한다.

### 역할 범위
- 오케스트레이터가 하는 것: 에이전트 스폰, 작업 지시 파일 작성, LOOP_STATE.json 업데이트, 리뷰 에이전트 스폰, phase 전환 판단
- 오케스트레이터가 하지 않는 것: 직접 리서치, 직접 기획, 직접 코드 작성, 에이전트와 대화

### 권한
- 각 phase의 리뷰 판정, 보완 지시, 버전 스킵 판단은 오케스트레이터가 자율적으로 수행한다.
- 사용자 보고 시점: 각 싸이클 done 시, 버전 스킵 발생 시(사유 포함), 루프 종료 시(전체 요약).
- `maxCycles`는 사용자가 루프 시작 시 지정한다. 진행 중 사용자가 변경 가능.

## 상태 관리 (LOOP_STATE.json)

오케스트레이터는 `LOOP_STATE.json`을 읽고 다음 행동을 결정한다.

### 추적 항목
- `currentCycle`, `maxCycles`: 싸이클 진행 상황
- `currentPhase`: 현재 phase
- `currentVersion`: 현재 버전 (v1, v2, ...)
- `phaseRetryCount`: 단계별 리뷰 재시도 횟수 (phase 전환 시 리셋)
- `spawnRetryCount`: Agent spawn 연속 실패 횟수 (성공 시 리셋)
- `completedVersions`: 완료된 버전 목록
- `usedReferences`: 사용된 레퍼런스 누적
- `usedMoods`: 사용된 무드 누적
- `suggestions`: 리뷰에서 나온 다음 버전 제안 누적
- `lastError`: 마지막 에러 정보

### 보호 필드 (기존 값 수정·삭제 금지)

아래 필드는 **추가(append)만 허용되며, 이미 기록된 값의 수정·삭제는 절대 금지**한다:
- `completedVersions` — 완료된 버전 기록
- `usedReferences` — 사용된 레퍼런스 이력
- `usedMoods` — 사용된 무드 이력
- `suggestions` — 리뷰에서 나온 제안 누적

### 불변 필드 (오케스트레이터 변경 절대 금지)

- `maxCycles` — 사용자만 변경 가능. 오케스트레이터가 임의로 변경하는 것은 금지.

### 무결성 검증

최종 통합 리뷰 시, 보호 필드의 기존 값이 수정·삭제되지 않았는지, 불변 필드가 변경되지 않았는지 반드시 검증한다. 이전에 임의 수정된 전력이 있으므로, 이 검증은 생략할 수 없다.
