# File & Naming Conventions

## Folder Names

Use lowercase kebab-case. Names must be self-explanatory:

```
✓ .orchestra/workspace/current-cycle/research/competitor-analysis.md
✗ .orchestra/workspace/cc/res/ca.md

✓ .orchestra/org/departments/engineering/teams/team-frontend/
✗ .orchestra/org/deps/eng/t1/
```

## File Names

Markdown files: `lowercase-kebab-case.md`
JSON files: `snake_case.json`
Python files: `snake_case.py`
Log files: `descriptive-name.log`

Every file name should tell you what's inside without opening it.

## Variable Names (Python)

Follow PEP 8:
- Functions and variables: `snake_case`
- Classes: `PascalCase`
- Constants: `UPPER_SNAKE_CASE`
- Private: `_leading_underscore`

## Agent IDs

Format: `{dept}-{role}-{number}`

```
analysis-head-01          # Analysis department head
research-lead-02          # Research team 2 lead
engineering-member-03     # Engineering member #3
engineering-intern-05     # Engineering intern #5
director-staff-07         # Director's Sonnet assistant #7
audit-lead-04             # Audit team 4 lead
```

## Task IDs

Format: `{phase}-{dept}-{number}`

```
c003-analysis-01          # Cycle 3, analysis task 1
c003-eng-05               # Cycle 3, engineering task 5
c003-review-code-02       # Cycle 3, code review task 2
audit-005-security-01     # Audit at cycle 5, security task 1
```

## Completion Markers

Every task writes a `COMPLETE.md` file in its output directory when done:

```markdown
# Task Complete

- **Task ID**: c003-eng-05
- **Agent**: engineering-member-03
- **Completed At**: 2026-03-18T23:45:00
- **Duration**: 4m 32s

## Summary
[1-3 sentences: what was done]

## Output Files
- feature-impl.md — Implementation notes
- (code changes committed directly to project)

## Issues
[Any problems encountered, or "None"]
```

The orchestrator watches for these files to know when tasks are done.

## Language Rules

### Who writes in what language

| Role | Internal docs | Final reports |
|------|--------------|---------------|
| Director | Korean | Korean |
| Department Head | Korean | Korean |
| Team Lead | Flexible (Korean or English) | Korean (when reporting to Dept Head) |
| Member (Sonnet) | Flexible | Flexible |
| Intern (Haiku) | Flexible | N/A (no reports) |

### Code and comments

- **Code**: Follow the project's existing language conventions
- **Code comments**: English
- **UI-facing text**: The project's target language (auto-detected from codebase)
- **Git commits**: English

### UI text golden rule

**UI text must read like a human wrote it.** Not like AI generated it.

How to achieve this:
1. Research real services in the same domain
2. Look at how they phrase things — button labels, error messages, empty states, onboarding copy
3. Use natural, conversational Korean (or whatever the project language is)
4. Avoid: overly formal phrases, repetitive patterns, generic placeholder text
5. Test: read it out loud. Does it sound like a real app? Or does it sound like ChatGPT?

## Production-Ready Code & Mock Data Strategy

All code must be written as if launching to real users tomorrow.
Mock data is allowed ONLY through the adapter pattern — never inline.

### Data Adapter Pattern

```
Application Code → DataAdapter (interface/abstract)
                       ├── RealAdapter    (Supabase, API, etc.)
                       └── MockAdapter    (development/demo only)
```

**Rules:**

1. **Application code never imports mock data directly.**
   Components call `getWeddings()`, not `import { mockWeddings } from '@/mocks'`.

2. **Adapter selection via environment variable:**
   ```
   DATA_SOURCE=real    → RealAdapter (production)
   DATA_SOURCE=mock    → MockAdapter (development/demo)
   ```
   Default is `real`. Mock is opt-in, never opt-out.

3. **Mock data lives in isolation:**
   ```
   lib/adapters/
   ├── interface.ts       # Abstract interface (what every adapter implements)
   ├── real/              # Production adapters (Supabase queries, API calls)
   └── mock/              # Mock adapters + mock data (only loaded when DATA_SOURCE=mock)
   ```
   The `mock/` folder can be excluded from production builds entirely.

4. **Mock data must be realistic:**
   Real-looking names (not "Test User 1"), realistic amounts, plausible dates.
   Someone demoing the app should not be embarrassed by obviously fake data.

5. **No mock shortcuts in UI:**
   Loading states, error states, empty states — all must work properly
   regardless of whether data is real or mock. No `{data || "loading..."}` hacks.

6. **Feature flags for incomplete features:**
   If a feature isn't ready for production, use a feature flag to hide it.
   Don't leave half-built UI visible with "coming soon" placeholders.
   ```
   FEATURE_QR_ENVELOPE=true    → show QR envelope feature
   FEATURE_QR_ENVELOPE=false   → feature doesn't exist in the UI
   ```

### Build Configuration

Production build must:
- Tree-shake mock adapters out (not included in bundle)
- Have zero references to mock data in production output
- Pass all type checks without mock data present
- Work with `DATA_SOURCE=real` by default

## Report Formats

### Director Report (director-report.md)

Written in Korean. Detailed. For the Director Opus to review across cycles.

```markdown
# 사이클 N 보고서

## 요약
[3-5문장: 이번 사이클에서 무엇을 했고 어떤 결과가 나왔는지]

## 부서별 결과

### 분석부
[주요 발견사항]

### 리서치부
[핵심 인사이트]

### 기획부
[이번 사이클 계획 요약]

### 개발부
[구현 내용, 변경 파일, 커밋]

### 리뷰부
[리뷰 점수, 주요 이슈]

### QA부
[테스트 결과, 발견된 버그]

## 지표
- 전체 점수: X/10
- 빌드: 성공/실패
- 테스트: X/Y passed
- 기술 부채: 증가/감소/유지

## 미해결 사항
[다음 사이클에서 다뤄야 할 것들]

## 다음 사이클 방향 제안
[Director의 판단]
```

### Admin Report (admin-report.html)

Written in Korean. Clean HTML. For the human (Admin) to review.

Must include:
- Executive summary (what happened this cycle, in plain language)
- Screenshots of all app pages (captured via Puppeteer)
- Before/after comparisons (if applicable)
- Key metrics in a visual format (not raw numbers)
- Open issues with severity
- What's planned next

Design guidelines:
- Clean, minimal design
- System fonts (no external dependencies)
- Responsive (readable on phone too)
- Color scheme matching the project's palette
- Diagrams/charts only where genuinely helpful (don't force them)

### Audit Report (audit-cycle-NNN.md)

Written in Korean. Comprehensive.

```markdown
# 전수 감사 보고서 — 사이클 NNN

## 감사 범위
[어떤 파일/기능을 검사했는지]

## 보안
[취약점 발견 여부, 심각도]

## AI 흔적 점검
[AI가 쓴 것 같은 텍스트가 있는지 — UI, 문서, 코멘트]

## 코드 품질
[중복, 미사용 코드, 복잡도, 네이밍]

## 버그
[발견된 버그 목록, 재현 방법]

## 의존성
[취약한 패키지, 업데이트 필요 여부]

## 접근성
[키보드 네비, 스크린리더, 색상 대비]

## 성능
[번들 크기, 로드 타임, 리렌더링]

## 종합 평가
[전체 점수, 가장 시급한 개선사항 Top 5]
```

## Knowledge Base Structure

`.orchestra/knowledge/` persists across cycles. It's the system's long-term memory.

```
knowledge/
├── research/
│   ├── 001-competitor-analysis.md
│   ├── 002-backend-auth-setup.md
│   ├── 003-mobile-ux-best-practices.md
│   └── ...
├── decisions/
│   ├── 001-chose-supabase-over-firebase.md
│   ├── 002-route-structure-c-plan.md
│   └── ...
└── lessons-learned/
    ├── 001-always-grep-before-delete.md
    ├── 002-haiku-cant-summarize.md
    └── ...
```

Each file is numbered sequentially and has a descriptive name.
New agents read relevant files from here to benefit from previous cycles' work.

## Admin Directives System

Admin can steer the project **without stopping the cycle**. Edit `DIRECTIVES.md` at any time.
Agents check this file at the start of every phase and incorporate relevant directives.

### DIRECTIVES.md Template

```markdown
# Admin Directives
# Admin이 이 파일을 수정하면, 다음 스텝부터 반영됩니다. 사이클을 멈출 필요 없습니다.
# 처리된 항목은 에이전트가 체크박스를 표시합니다.

## 전체 (All Departments)
- [ ] (여기에 모든 부서에 해당하는 지시 사항 작성)

## 분석부 (Analysis)
- [ ] (분석부에 대한 지시 사항)

## 리서치부 (Research)
- [ ] (리서치부에 대한 지시 사항)

## 기획부 (Planning & Design)
- [ ] (기획부에 대한 지시 사항)

## 개발부 (Engineering)
- [ ] (개발부에 대한 지시 사항)

## 리뷰부 (Review)
- [ ] (리뷰부에 대한 지시 사항)

## QA부 (QA)
- [ ] (QA부에 대한 지시 사항)

## 감사부 (Audit)
- [ ] (감사부에 대한 지시 사항)

## 질문 (Questions from Agents)
# 에이전트가 지시 사항이 모호하거나 결정이 필요할 때 여기에 질문을 남깁니다.
# Admin이 답변을 달아주면 다음 스텝에서 반영합니다.
```

### How It Works

**Admin writes:**
```markdown
## 개발부 (Engineering)
- [ ] 로그인 페이지에서 카카오 버튼 색상을 공식 카카오 노란색(#FEE500)으로 변경
- [ ] 축의금 입력 폼에서 금액 입력 시 천 단위 콤마 자동 포맷팅 추가
```

**Agent processes and checks off:**
```markdown
## 개발부 (Engineering)
- [x] 로그인 페이지에서 카카오 버튼 색상을 공식 카카오 노란색(#FEE500)으로 변경 ✅ cycle-003 engineering
- [ ] 축의금 입력 폼에서 금액 입력 시 천 단위 콤마 자동 포맷팅 추가
```

**Agent has a question:**
```markdown
## 질문 (Questions from Agents)
- **[cycle-003 기획부]** "축의금 입력 폼에서 천 단위 콤마" → 금액 상한선이 있나요? 무제한인가요?
  - **[Admin 답변]** 최대 500만원으로 제한해줘
```

### Processing Rules

1. **Every phase start**: the active department reads `DIRECTIVES.md`
2. **"전체" section**: all departments check this every time
3. **Department-specific section**: only that department checks its section
4. **If a directive is actionable NOW**: incorporate it into current phase work
5. **If NOT actionable this phase** (e.g., engineering directive during research phase): leave it unchecked, it'll be picked up in the right phase
6. **When completed**: agent changes `- [ ]` to `- [x]` and appends `✅ cycle-NNN department`
7. **Ambiguous directives**: agent writes a question in the "질문" section instead of guessing
8. **DIRECTIVE_LOG.md**: when a directive is completed, the full entry (directive + which cycle + who did it) is copied to the log for history

### Important

- Admin can add new directives at ANY time — mid-cycle, mid-phase, doesn't matter
- Agents never delete directives. They only check them off.
- Checked-off directives stay in the file until Admin removes them
- The Questions section is bidirectional: agents ask, Admin answers, agents act on the answer next cycle
