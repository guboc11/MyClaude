# WORK_CONTEXT.md — orchestra-small-skill 작업 컨텍스트

> **compaction 대비 온보딩 파일.** 이 파일을 읽으면 지금 무슨 작업을 하는지 즉시 파악할 수 있어야 한다.

---

## 이 작업이 뭔가

`guboc11/MyClaude` 레포의 `openclaw-1` 브랜치에 `orchestra-small-skill/` 폴더를 만드는 작업.
기존 `orchestra-skill/`의 축소판으로, 더 현실적이고 안전한 자율 개발 오케스트레이션 스킬.

PR 목표: `openclaw-1` → `main` (guboc11/MyClaude)

---

## 워크스페이스 경로

```
/home/twclaw/.openclaw/workspace/MyClaude/
├── orchestra-skill/          # 원본 (건드리지 말 것)
└── orchestra-small-skill/    # 우리가 만드는 것
    ├── WORK_CONTEXT.md       # 이 파일
    ├── SKILL.md              # S1이 담당
    └── references/
        ├── file-ownership.md       # S2가 담당
        ├── cycle-flow.md           # S3이 담당
        ├── org-structure.md        # S4가 담당
        ├── orchestrator-design.md  # S4가 담당
        └── conventions.md          # S5가 담당 (+ 전체 리뷰)
```

---

## 핵심 설계 방향 (반드시 따를 것)

### 1. 느리지만 확실한 기능 개발
- 사이클 1개 = 기능 1개만 완성
- 미완성 기능은 절대 커밋하지 않음
- 빌드 + 테스트 통과 후에만 다음 사이클

### 2. 현실 참조 강제 (Research Gate)
- Research 단계에서 **실제 서비스 레퍼런스 URL + 구체적 근거** 없으면 Engineering 진입 불가
- "AI끼리 합의"로 방향 잡는 것 금지
- 인터넷에 있는 실제 검증된 UI/UX/기술을 참고해서 구현

### 3. 파일 소유권 시스템 (File Ownership)
- 각 Engineering 태스크는 "내가 수정할 파일 목록"을 선언
- Director(Opus)가 태스크 분배 시 파일 겹침 검사
- 겹치면 태스크 병합 또는 순차 실행으로 전환
- 병렬 에이전트 간 git conflict 원천 차단

### 4. 스케일 축소
- 동시 에이전트 최대 8개 (원본: 30개)
- 부서당 팀 1개 (원본: 2-3개)
- Haiku 제거
- 감사: 3사이클마다, 소규모

---

## 원본 orchestra-skill과의 차이 요약

| 항목 | 원본 | small |
|------|------|-------|
| 동시 에이전트 | 최대 30 | 최대 8 |
| 부서당 팀 | 2-3 | 1 |
| Haiku 인턴 | 사용 | 제거 |
| 파일 충돌 대책 | 없음 | File Ownership 시스템 |
| Research 강제 | 선택적 | Research Gate (필수) |
| 사이클 목표 | 여러 기능 | 기능 1개 완성 |
| 감사 주기 | 5사이클 | 3사이클 |

---

## 각 Sonnet의 담당과 산출물

| 에이전트 | 담당 파일 | 핵심 내용 |
|---------|----------|----------|
| S1 | `SKILL.md` | 스킬 진입점, 설치 절차, 핵심 원칙 |
| S2 | `references/file-ownership.md` | 파일 소유권 선언 포맷, 충돌 감지 로직 |
| S3 | `references/cycle-flow.md` | 사이클 흐름, Research Gate, 단계별 규칙 |
| S4 | `references/org-structure.md` + `orchestrator-design.md` | 조직 구조 + Python 오케스트레이터 |
| S5 | `references/conventions.md` + 전체 교차 검토 | 규칙 정리 + 모순/구멍 수정 |

---

## 작업 규칙

1. 파일 작성 전 이 파일 반드시 읽기
2. 원본 `orchestra-skill/`의 좋은 부분은 채택, 나쁜 부분은 개선
3. 원본 파일 수정 금지
4. 작업 완료 후 WORK_CONTEXT.md 하단 "완료 현황" 업데이트
5. 영어로 작성 (파일 내용). 주석과 보고는 한국어 가능.

---

## 완료 현황

- [x] 레포 클론 + 브랜치 생성 (openclaw-1)
- [x] WORK_CONTEXT.md 생성
- [x] S1: SKILL.md
- [x] S2: file-ownership.md
- [x] S3: cycle-flow.md
- [x] S4: org-structure.md + orchestrator-design.md
- [ ] S5: conventions.md + 교차 검토 완료
- [ ] 최종 PR 생성
