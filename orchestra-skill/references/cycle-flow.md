# Cycle Flow

## Overview

```
┌─── Cycle N ─────────────────────────────────────────────────────┐
│                                                                  │
│  Analysis → Research → Planning → Engineering → Review → QA      │
│      │                                                    │      │
│      │                                                    ↓      │
│      │                                                 Wrapup    │
│      │                                                           │
│      └──────────────── loop back ────────────────────┘           │
│                                                                  │
│  Every 5th cycle: Audit runs IN PARALLEL with the main cycle    │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

## Phase Details

### Phase 1: Analysis (현황 분석)

**Purpose**: Understand the current state of the project before doing anything else.

**Department**: Analysis (현황분석부)

**Input**: The actual codebase, previous cycle's review feedback, knowledge base

**First action (every phase, every department):**
Read `.orchestra/admin-directives/DIRECTIVES.md`.
Check the "전체" section and your department's section for unchecked directives.
If actionable now, incorporate into this phase's work. If not, leave for the right phase.
If ambiguous, write a question in the "질문" section.

**Tasks** (can be parallelized across teams):
- Codebase structure scan (file tree, page count, component inventory)
- **Tech debt score measurement** (see below)
- Build health check (run project's build command, test suite, linter)
- Gap analysis (what exists vs. what's needed for production)
- Previous cycle review feedback analysis (what needs fixing?)
- Knowledge base review (what did we learn in previous cycles?)

**Tech Debt Score (의무 산출물)**:
Run these commands and aggregate into `tech-debt-score.json`:
```bash
# TODO/FIXME/HACK/XXX count
grep -r "TODO\|FIXME\|HACK\|XXX" --include="*.ts" --include="*.tsx" -l | wc -l

# TypeScript 'any' usage
grep -r ": any\|as any\|<any>" --include="*.ts" --include="*.tsx" | wc -l

# Type errors
npx tsc --noEmit 2>&1 | grep "error TS" | wc -l

# Build warnings
$PACKAGE_MANAGER build 2>&1 | grep -i "warning" | wc -l

# Oversized files (500+ lines)
find . -name "*.ts" -o -name "*.tsx" | xargs wc -l | awk '$1 >= 500 {print}' | wc -l

# Linter errors/warnings
npx eslint . --ext .ts,.tsx --format json 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(sum(r['errorCount']+r['warningCount'] for r in d))"

# Unused exports (if tool available)
# Duplicate code patterns
```

Output `tech-debt-score.json`:
```json
{
  "score": 72,
  "max": 100,
  "cycle": 3,
  "breakdown": {
    "todo_fixme_count": 23,
    "typescript_any_count": 8,
    "type_errors": 0,
    "build_warnings": 12,
    "oversized_files": 3,
    "lint_issues": 31,
    "unused_dependencies": 2
  },
  "trend": "declining",
  "previous_score": 78,
  "delta": -6
}
```

Score calculation:
- Start at 100
- `-1` per TODO/FIXME/HACK
- `-2` per TypeScript `any`
- `-5` per type error
- `-0.5` per build warning
- `-3` per oversized file (500+ lines)
- `-0.3` per lint issue
- Floor at 0

**Output files** (written to `.orchestra/workspace/current-cycle/analysis/`):
```
analysis-summary.md          # Department head's summary (Korean)
codebase-structure.md         # File tree + component inventory
tech-debt-score.json          # Objective tech debt measurement (MANDATORY)
tech-debt-report.md          # Detailed issues with severity ratings
build-health.md              # Build/test/lint results
gap-analysis.md              # What's missing for production
previous-feedback-review.md  # Unresolved issues from last cycle
```

**Completion signal**: Department head writes `analysis-complete.md` with key findings.

**Handoff**: Copies summary to `.orchestra/workspace/current-cycle/handoff/`

### Phase 2: Research (리서치)

**Purpose**: Investigate the best path forward based on analysis findings.
This is where agents go OUT and learn from the real world.

**Department**: Research (리서치부)

**Input**: Analysis phase outputs, knowledge base, the actual internet

**CRITICAL — Knowledge Continuity Protocol**:
Before ANY new research, agents MUST:
1. Read `.orchestra/knowledge/research/` — every file from all previous cycles
2. Identify what's already been researched and what conclusions were drawn
3. Build ON TOP of previous findings, not from scratch
4. If a previous finding is still relevant, reference it (don't re-research it)
5. Only research NEW areas or DEEPER dives into existing areas
6. Track what's been researched in `research-coverage-map.md` to prevent circular revisits

This prevents the system from going in circles — researching the same things,
reaching the same conclusions, and looping back to the same direction every few cycles.

**Tasks** (parallelized):
- **Competitor research**: Search for real services in the same domain. How do they solve the problems we found? What UX patterns do they use?
- **User research**: Search for real user feedback, complaints, reviews about similar services. What do people actually want?
- **Technical research**: For each technical decision ahead, search for best practices, common pitfalls, production setups. Read blog posts, docs, GitHub issues.
- **Design research**: Visual language, color theory, typography, layout patterns, micro-interactions, motion design. What makes premium apps FEEL premium? Find specific references with URLs and describe what to take from each.
- **Tool research**: Are there existing libraries, packages, or tools that solve our problems? Search npm, PyPI, GitHub. Don't reinvent wheels.

**Output files** (written to `.orchestra/workspace/current-cycle/research/`):
```
research-summary.md           # Department head's summary (Korean)
research-coverage-map.md      # What's been researched (this + all prev cycles) — prevents circular revisits
previous-knowledge-review.md  # What we already know and what's reusable from past cycles
competitor-analysis.md        # Real services analyzed with key takeaways
user-insights.md             # Real user feedback and pain points
technical-findings.md        # Best practices and recommended approaches
design-research.md           # Visual/UX/motion design references with specific takeaways
tool-recommendations.md      # Existing libraries/tools to use
```

**Persistent output**: Key findings also written to `.orchestra/knowledge/research/`
(numbered sequentially, accumulates across cycles)

**Completion signal**: Department head writes `research-complete.md`

**Admin requests**: If research identifies a tool/skill/MCP that would help,
write a request to `.orchestra/requests/pending/`

### Phase 3: Planning & Design (기획)

**Purpose**: Based on analysis + research, decide exactly what to build AND how it should look/feel.
Also decide whether this cycle focuses on feature development, refactoring, or a mix.

**Refactoring Rule (기술 부채 기반)**:
The Planning department MUST read `tech-debt-score.json` from the Analysis phase.
- **Score ≥ 70**: Refactoring is optional. Department head decides based on priorities.
- **Score 50–69**: At least 30% of this cycle's tasks MUST be refactoring.
- **Score < 50**: This cycle is refactoring-only. No new features until score recovers above 50.
- **Score trending down for 3+ consecutive cycles**: Mandatory refactoring cycle regardless of absolute score.

Refactoring tasks include: reducing `any` usage, splitting oversized files, resolving TODOs,
removing dead code, improving type safety, consolidating duplicated logic, updating deprecated patterns.
These are tracked separately in the sprint plan so the review can verify they were addressed.

**Department**: Planning (기획부) — includes design planning

**Input**: Analysis outputs, research outputs (especially design-research.md), knowledge base, Admin requests status

**Tasks**:
- Synthesize analysis + research into actionable plan
- Prioritize: what has the highest impact for the least risk?
- Write detailed spec for the chosen work item
- **Design spec**: Based on design research, define the visual direction — layout, spacing, color usage, typography, animation style, interaction patterns. Reference specific URLs from design-research.md.
- Define acceptance criteria (how do we know it's done — functionally AND visually?)
- Identify risks and mitigation strategies
- Self-critique: "Is this plan really the best use of this cycle?"
- **Design self-critique**: "Does this design direction feel like a real premium service? Or does it feel like a developer's afterthought?"

**Output files** (written to `.orchestra/workspace/current-cycle/planning/`):
```
sprint-plan.md               # What we're building this cycle (Korean)
                             # Must clearly label tasks as [feature] or [refactor]
feature-spec.md              # Detailed functional spec with acceptance criteria
refactor-spec.md             # Refactoring targets with before/after expectations (if applicable)
design-spec.md               # Visual/UX direction, layout mockup descriptions, references
architecture-notes.md        # Any architectural decisions
risk-assessment.md           # What could go wrong
self-critique.md             # Honest assessment of plan AND design weaknesses
```

**Completion signal**: Department head writes `planning-complete.md`

### Phase 3.5: Task Breakdown (태스크 분할)

**Purpose**: Convert the plan into concrete, independent engineering tasks.
Without this step, Engineering has no task queue and nothing happens.

**Executed by**: Director (Opus) — not a department, a Director-level action.

**Input**: Planning outputs (sprint-plan.md, feature-spec.md, design-spec.md)

**Process**:
1. Director reads all planning outputs
2. Breaks the sprint plan into concrete tasks, each completable by a single Sonnet in one session
3. Writes each task as a separate file

**Output files** (written to `.orchestra/workspace/current-cycle/task_breakdown/tasks/`):
```
task-eng-01.md      # Task 1: objective, files to touch, acceptance criteria
task-eng-02.md      # Task 2: ...
task-eng-03.md      # ...
breakdown-summary.md # How many tasks, dependencies, estimated complexity
```

Each task file format:
```markdown
# Task: [concise title]
- **ID**: task-eng-01 (orchestrator가 scan 시 cycle prefix 부착 → c003-eng-01)
- **Depends on**: none (or task-eng-XX)
- **Estimated complexity**: low / medium / high

## Objective
[What to build/change — specific and concrete]

## Files to Touch
[Which files will be created/modified]

## Acceptance Criteria
- [ ] [Specific condition 1]
- [ ] [Specific condition 2]

## Context
Read these before starting:
- .orchestra/workspace/current-cycle/planning/feature-spec.md
- .orchestra/workspace/current-cycle/planning/design-spec.md
```

**Completion signal**: Director writes `task_breakdown-complete.md`

### Phase 4: Engineering (개발)

**Purpose**: Build what the plan says. Write real, production-quality code.

**Department**: Engineering (개발부)

**Input**: Task breakdown files from Phase 3.5 (task-eng-01.md, task-eng-02.md, ...)

**Tasks** (can be parallelized if independent):
- Implement the feature/change per spec
- Write/update tests
- Ensure build passes
- Handle error states, loading states, edge cases
- Commit with meaningful messages

**Output files** (written to `.orchestra/workspace/current-cycle/engineering/`):
```
engineering-summary.md        # What was built, files changed, decisions made
build-result.md              # Build output (pass/fail)
test-result.md               # Test output
commit-log.md                # Git commits made this cycle
```

**Rules**:
- Before deleting ANY file: `grep -r "filename" . --include="*.ts" --include="*.tsx" -l`
- Search ALL directories (app/, features/, store/, lib/, mocks/, components/)
- Every commit must build successfully
- UI text must feel human-written, not AI-generated. Reference real services.
- **Production-ready**: All code must be launchable as-is. No TODO stubs, no placeholder UI.
- **Mock data via adapter only**: Never import mock data directly in components.
  Use the DataAdapter pattern (see conventions.md). Mock is opt-in via `DATA_SOURCE=mock`.
- **Feature flags for WIP**: Unfinished features hidden behind env flags, not visible in production.
- Use project's configured package manager (`config.yaml → project.package_manager`), default pnpm.

**Completion signal**: Department head writes `engineering-complete.md`

### Phase 5: Review (리뷰)

**Purpose**: Critically evaluate what was just built. Be harsh.

**Department**: Review (리뷰부)

**Input**: Engineering outputs, the actual code diff, feature spec

**Tasks** (parallelized by review type):
- **Code review**: Type safety, duplication, naming, architecture, security
- **UX review**: User flow, error handling, loading states, accessibility
- **Spec compliance**: Does it meet all acceptance criteria?
- **Reference comparison**: How does this compare to the services researched?
- **AI-smell check**: Does any UI text sound like AI wrote it?

**Output files**:
```
review-summary.md             # Department head's verdict (Korean)
code-review.md               # Detailed code review
ux-review.md                 # UX evaluation
spec-compliance.md           # Acceptance criteria checklist
ai-smell-report.md           # Any AI-sounding text flagged
score.json                   # { "overall": 7, "code": 8, "ux": 6, ... }
```

**Completion signal**: Department head writes `review-complete.md`

### Phase 6: QA (품질 보증)

**Purpose**: Test everything. Find bugs. Verify nothing is broken.

**Department**: QA (QA부)

**Input**: Engineering outputs, review outputs

**Tasks** (parallelized):
- Run full test suite
- Manual testing of new features (via Puppeteer/agent-browser if available)
- Regression testing (did we break anything?)
- Performance check (build size, load time)
- Accessibility audit

**QA runs after Review completes. Sequential execution.**

**Output files**:
```
qa-summary.md                 # Department head's verdict (Korean)
test-results.md              # Full test output
bug-report.md                # Bugs found with reproduction steps
regression-report.md         # Anything that broke
performance-report.md        # Build size, load times
```

**Completion signal**: Department head writes `qa-complete.md`

### Phase 7: Wrapup (마무리)

**Purpose**: Generate reports, commit code, archive the cycle, prepare for next.

**Executed by**: Director (Opus) + 1 Sonnet (for HTML report)

**Input**: All department outputs from this cycle

**Process**:
1. **Director (Opus)** is spawned:
   - Reads all department outputs from workspace/current-cycle/
   - Writes `director-report.md` (detailed, Korean) → .orchestra/reports/cycle-{N}/
   - Writes key learnings to `.orchestra/knowledge/lessons-learned/`
   - Writes key decisions to `.orchestra/knowledge/decisions/`
   - Checks `admin-directives/DIRECTIVES.md` and marks off completed items
   - Writes `wrapup-director-done.md`

2. **Orchestrator** captures screenshots (if Puppeteer/Playwright available)

3. **Sonnet** is spawned to generate `admin-report.html`:
   - Input: director-report.md + screenshots + cycle data
   - Output: clean, readable HTML report in Korean → .orchestra/reports/cycle-{N}/

4. **Build gate** — MUST pass before commit:
   ```bash
   {package_manager} build 2>&1
   ```
   If build fails → skip commit, log error. Next cycle fixes it.

5. **Git commit** (on orchestra branch, NOT main) — only if build gate passed:
   ```bash
   git add -A
   git commit -m "cycle-{N}: [summary from director report]"
   ```

6. **Archive**: workspace/current-cycle/ → workspace/archive/cycle-{N}/

7. **State update**: cycle_number increments, workspace reset for next cycle

8. **Next cycle begins** immediately (back to Analysis) — unless graceful shutdown requested

**Completion signal**: `wrapup-complete.md` written by orchestrator itself (not an agent)

## Full Audit (Every 5 Cycles)

The Audit department activates every 5th cycle and runs IN PARALLEL with the ongoing main cycle.

**Audit team**: 1 Opus head, 10 Opus team leads, 10 Sonnets per team = 111 agents

**Audit checks**:
- Security vulnerabilities
- AI-sounding text (must read like a human wrote it)
- Code quality issues
- Bugs and edge cases
- Dependency vulnerabilities
- Accessibility compliance
- Performance bottlenecks

**Output**: Full audit report written to `.orchestra/reports/audit/`

**Important**: Audit findings are NOT automatically applied. They go to Admin for review.
The main cycle continues unaffected until Admin decides what to apply.

## Parallel Execution Map

```
Sequential:    Analysis → Research → Planning → Engineering
                                                    │
Parallel:                                    Review ─┤
                                             QA ─────┘
                                                    │
Post-parallel:                              Cycle Wrap-up
                                                    │
Always parallel:                     Audit (every 5th cycle)
```

## Shutdown Behavior

### Graceful Shutdown (--stop)
1. Set `shutdown_signal.json` → `{"type": "graceful"}`
2. Current cycle continues to completion
3. After cycle wrap-up (reports written), orchestrator exits
4. State is saved — can resume later

### Immediate Shutdown (--kill)
1. Set `shutdown_signal.json` → `{"type": "immediate"}`
2. Wait for currently running agent tasks to finish (max 60 sec)
3. Save current state to `cycle_state.json`
4. Exit
5. Resume picks up from the last completed task

### Resume (--resume)
1. Read `cycle_state.json`
2. Determine which phase was in progress and which tasks completed
3. Resume from the next incomplete task
4. Rate limit state is reset (fresh start on limits)
