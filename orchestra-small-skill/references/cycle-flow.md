# Cycle Flow

> **Core Philosophy**: Slow but certain. Real-world references enforced. One cycle = one feature completed.

## Overview

```
┌─── Cycle N ──────────────────────────────────────────────────────────────────┐
│                                                                               │
│  Analysis → Research → [RESEARCH GATE] → Planning → Task Breakdown            │
│                                                           │                   │
│                                                           ↓                   │
│                                                      Engineering               │
│                                                           │                   │
│                                                     Review → QA               │
│                                                           │                   │
│                                                        Wrapup                 │
│                                                                               │
│  Every 3rd cycle: Audit runs IN PARALLEL with the main cycle                 │
│                                                                               │
└───────────────────────────────────────────────────────────────────────────────┘
```

**Sequential order**:
```
Analysis → Research → [RESEARCH GATE] → Planning → Task Breakdown → Engineering → Review → QA → Wrapup
```

---

## Research Gate (핵심 신규 개념)

**What it is**: A mandatory checkpoint between Research and Planning.
The Director (Opus) runs this alone, reviewing the Research team's output before Engineering can begin.

**Purpose**: Prevent "AI consensus direction" — two or more AI agents agreeing on an approach without any real-world validation. Every feature direction must be grounded in reality.

### Pass Conditions (ALL must be satisfied)

- [ ] At least **3 real-world service references** (with URLs) implementing the same or similar feature
- [ ] For each reference, a specific statement of **"what pattern/approach we will adopt from this"**
- [ ] The technical approach is validated by actual production use cases (not theoretical)
- [ ] UI/UX direction is based on real user feedback, reviews, or documented user behavior

### Gate Decision

**If PASS**: Director records decision in `research-gate-result.md` with justification → Planning proceeds.

**If FAIL**: Research phase re-executes. The Director documents exactly what was missing.
Failure reasons include:
- References are documentation pages, not real deployed services
- "We'll adopt good UX practices" without specific pattern citation
- Technical choice is not backed by a production case study
- UI direction is purely AI-generated intuition

> **Rule**: "AI agents agreed this was the best approach" is NOT a valid reason to pass the gate.

### Gate Output File
Written to `.orchestra/workspace/current-cycle/research/`:
```
research-gate-result.md     # PASS or FAIL, Director's detailed reasoning, retry count
```

---

## Phase Details

### Phase 1: Analysis (현황 분석)

**Purpose**: Understand the current state of the project before doing anything else.

**Team**: 1 team, 3–5 Sonnet agents (parallelized tasks within team)

**First action (every phase)**:
Read `.orchestra/admin-directives/DIRECTIVES.md`.
Check the "전체" section and your phase's section for unchecked directives.
Incorporate actionable directives; write questions for ambiguous ones.

**Tasks** (parallelized within team):
- Codebase structure scan (file tree, component inventory)
- Tech debt score measurement (mandatory)
- Build health check (build, test, lint)
- Gap analysis (what exists vs. what's needed)
- Previous cycle review feedback analysis

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

# Linter issues
npx eslint . --ext .ts,.tsx --format json 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(sum(r['errorCount']+r['warningCount'] for r in d))"
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
    "lint_issues": 31
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
codebase-structure.md         # File tree + component inventory
tech-debt-score.json          # Objective tech debt measurement (MANDATORY)
build-health.md               # Build/test/lint results
gap-analysis.md               # What's missing for production
```

**Completion signal**: Write `analysis-complete.md` with key findings.

---

### Phase 2: Research (리서치)

**Purpose**: Go out and learn from the real world. Ground the team's direction in actual deployed services, real user feedback, and verified technical approaches.

**Team**: 1 team, 3–5 Sonnet agents (parallel research tracks)

**CRITICAL — Knowledge Continuity Protocol**:
Before ANY new research, agents MUST:
1. Read `.orchestra/knowledge/research/` — every file from all previous cycles
2. Identify what's already been researched and what conclusions were drawn
3. Build ON TOP of previous findings, not from scratch
4. Reference prior findings instead of re-researching them
5. Track coverage in `research-coverage-map.md` to prevent circular revisits

**Tasks** (parallelized within team):
- **Real-world service research**: Find actual deployed services implementing the same feature. Document URLs. Screenshot or describe what they do specifically.
- **User research**: Search for real user reviews, complaints, feedback about similar services.
- **Technical research**: Best practices, production setups, common pitfalls. Read blog posts, docs, GitHub issues.
- **Design research**: Find specific UI/UX references with URLs. Describe exactly what pattern to adopt from each.
- **Tool research**: Existing libraries/packages that solve our problems. Don't reinvent wheels.

**Mandatory Output** (written to `.orchestra/workspace/current-cycle/research/`):
```
real-world-references.md      # REQUIRED for Research Gate. URLs + adopted patterns.
research-coverage-map.md      # What's been researched (this + all prev cycles)
previous-knowledge-review.md  # What we already know and what's reusable
technical-findings.md         # Best practices and recommended approaches
tool-recommendations.md       # Existing libraries/tools to use
```

**`real-world-references.md` format** (must follow exactly):
```markdown
## Reference 1
- **Service**: [Service name]
- **URL**: https://...
- **What they do**: [Specific description of the feature/pattern]
- **What we adopt**: [Specific pattern or approach we take from this]

## Reference 2
...

## Reference 3
...
```

**Persistent output**: Key findings also written to `.orchestra/knowledge/research/`
(numbered sequentially, accumulates across cycles)

**Completion signal**: Write `research-complete.md`

→ **After research-complete.md is written: Research Gate runs.**

---

### Research Gate (Director Opus — runs alone)

**Trigger**: `research-complete.md` exists in `.orchestra/workspace/current-cycle/research/`

**Executed by**: Director (Opus) — single agent, no team

**Process**:
1. Read `real-world-references.md`
2. Verify each pass condition (see top of this document)
3. Write `research-gate-result.md` with decision and full reasoning

**If FAIL**: Director marks `research-gate-result.md` with `status: FAIL` and specific deficiencies.
Orchestrator re-triggers the Research phase. The Research team reads the failure reason before retrying.

**`research-gate-result.md` format**:
```markdown
# Research Gate Result

- **Status**: PASS / FAIL
- **Cycle**: N
- **Evaluated by**: Director (Opus)
- **Retry count**: 0

## Checklist
- [x/] Real-world references ≥ 3 (with URLs): ...
- [x/] Adopted patterns explicitly stated: ...
- [x/] Production validation: ...
- [x/] UI/UX based on real user data: ...

## Decision Reasoning
[Director's detailed explanation]

## If FAIL: What's Missing
[Specific gaps the Research team must address in retry]
```

---

### Phase 3: Planning & Design (기획)

**Purpose**: Based on analysis + research, decide exactly what to build and how it should look/feel.

**Team**: 1 team, 2–3 Sonnet agents

**Prerequisite**: `research-gate-result.md` with `status: PASS` must be attached. Planning cannot start without it.

**Refactoring Rule (기술 부채 기반)**:
Read `tech-debt-score.json` from the Analysis phase.
- **Score ≥ 70**: Refactoring optional. Planning head decides based on priorities.
- **Score 50–69**: At least 30% of this cycle's tasks MUST be refactoring.
- **Score < 50**: Refactoring-only cycle. No new features until score recovers above 50.
- **Score trending down for 3+ consecutive cycles**: Mandatory refactoring cycle regardless of score.

**Tasks**:
- Synthesize analysis + research into an actionable plan
- Choose the single feature to complete this cycle (see One Feature Per Cycle rule)
- Write detailed functional + design spec
- **Design spec**: Must directly cite reference URLs from `real-world-references.md` for every major design decision. "Based on [URL], we adopt X layout because..." is required.
- Define acceptance criteria (functional AND visual)
- Self-critique the plan honestly

**Output files** (written to `.orchestra/workspace/current-cycle/planning/`):
```
sprint-plan.md               # What we're building this cycle (clearly labeled [feature] or [refactor])
feature-spec.md              # Detailed functional spec with acceptance criteria
refactor-spec.md             # Refactoring targets (if applicable)
design-spec.md               # Visual/UX direction. Must cite real-world-references.md URLs.
risk-assessment.md           # What could go wrong
self-critique.md             # Honest assessment of plan weaknesses
```

**Completion signal**: Write `planning-complete.md`

---

### Phase 3.5: Task Breakdown (태스크 분할)

**Purpose**: Convert the plan into concrete, independent Engineering tasks with declared file ownership.

**Executed by**: Director (Opus) — single agent, not a team.

**Input**: Planning outputs

**Process**:
1. Read all planning outputs
2. Break the sprint plan into concrete tasks, each completable by a single Sonnet in one session
3. For EACH task, declare a **File Ownership** section (see `file-ownership.md`)
4. Before writing task files: check all ownership declarations for conflicts
5. If conflict detected: merge tasks or convert to sequential execution
6. Deploy task files only after conflict check passes

**Output files** (written to `.orchestra/workspace/current-cycle/task_breakdown/tasks/`):
```
task-eng-01.md
task-eng-02.md
...
breakdown-summary.md         # Task count, dependencies, conflict check results
```

Each task file format:
```markdown
# Task: [concise title]
- **ID**: task-eng-01
- **Depends on**: none (or task-eng-XX)
- **Estimated complexity**: low / medium / high

## Objective
[What to build/change — specific and concrete]

## File Ownership Declaration
<!-- See file-ownership.md for format -->
### Files I Will Create
- path/to/new-file.ts

### Files I Will Modify
- path/to/existing-file.ts

### Files I Will NOT Touch
- everything else

## Acceptance Criteria
- [ ] [Specific condition 1]
- [ ] [Specific condition 2]

## Context
Read before starting:
- .orchestra/workspace/current-cycle/planning/feature-spec.md
- .orchestra/workspace/current-cycle/planning/design-spec.md
- .orchestra/workspace/current-cycle/research/real-world-references.md
```

**Completion signal**: Director writes `task_breakdown-complete.md` and `ownership-registry.json`

---

### Phase 4: Engineering (개발)

**Purpose**: Build what the plan says. Write real, production-quality code.

**Team**: Up to 5 Sonnet agents concurrently (hard limit)

**Prerequisite**: `ownership-registry.json` must exist before any Engineering agent starts.

**ownership-registry.json** is generated by Director in Phase 3.5:
```json
{
  "cycle": 3,
  "assignments": {
    "task-eng-01": ["src/components/Feature.tsx", "src/hooks/useFeature.ts"],
    "task-eng-02": ["src/api/feature.ts"],
    "task-eng-03": ["src/store/featureSlice.ts"]
  }
}
```

**File ownership enforcement**:
- Each Sonnet reads `ownership-registry.json` at start
- Each Sonnet modifies ONLY the files assigned to its task
- If a needed change falls outside owned files: stop and report to Director. Do NOT touch it.

**Tasks** (parallelized only if independent):
- Implement the feature/change per spec
- Write/update tests
- Ensure build passes
- Handle error states, loading states, edge cases
- Commit with meaningful messages

**Rules**:
- Before deleting ANY file: `grep -r "filename" . --include="*.ts" --include="*.tsx" -l`
- Every commit must build successfully
- UI text must feel human-written, not AI-generated. Reference real services.
- **Production-ready**: No TODO stubs, no placeholder UI, no half-finished flows.
- **Mock data via adapter only**: Never import mock data directly in components.
- **Feature flags for WIP**: Unfinished features hidden behind env flags, never user-visible.
- Use project's configured package manager (default: pnpm)

**Output files** (written to `.orchestra/workspace/current-cycle/engineering/`):
```
engineering-summary.md        # What was built, files changed, decisions made
build-result.md               # Build output (pass/fail)
test-result.md                # Test output
commit-log.md                 # Git commits made this cycle
```

**Completion signal**: Write `engineering-complete.md`

---

### Phase 5: Review (리뷰)

**Purpose**: Critically evaluate what was just built. Be harsh.

**Team**: 2–3 Sonnet agents (review tracks parallelized)

**Tasks**:
- **Code review**: Type safety, duplication, naming, architecture, security
- **UX review**: User flow, error handling, loading states, accessibility
- **Spec compliance**: Does it meet all acceptance criteria?
- **Reference comparison**: Compare result against `real-world-references.md`. Does it match the quality level?
- **AI-smell check**: Does any UI text or copy sound like AI wrote it?

**Output files**:
```
review-summary.md             # Verdict (Korean)
code-review.md                # Detailed code review
ux-review.md                  # UX evaluation
spec-compliance.md            # Acceptance criteria checklist
reference-comparison.md       # How the result compares to real-world references
ai-smell-report.md            # Any AI-sounding text flagged
score.json                    # { "overall": 7, "code": 8, "ux": 6, ... }
```

**Completion signal**: Write `review-complete.md`

---

### Phase 6: QA (품질 보증)

**Purpose**: Test everything. Find bugs. Verify nothing is broken.

**Team**: 2–3 Sonnet agents (parallelized)

**Runs AFTER Review completes. Sequential execution.**

**Tasks**:
- Run full test suite
- Manual testing of new features (via Puppeteer/agent-browser if available)
- Regression testing (did we break anything?)
- Performance check (build size, load time)
- Accessibility audit

**Output files**:
```
qa-summary.md                 # Verdict (Korean)
test-results.md               # Full test output
bug-report.md                 # Bugs found with reproduction steps
regression-report.md          # Anything that broke
performance-report.md         # Build size, load times
```

**Completion signal**: Write `qa-complete.md`

---

### Phase 7: Wrapup (마무리)

**Purpose**: Gate the build, commit, archive the cycle, update knowledge.

**Executed by**: Director (Opus) + 1 Sonnet (for report)

**Process**:
1. Director reads all cycle outputs
2. Writes `director-report.md` → `.orchestra/reports/cycle-{N}/`
3. Writes key learnings to `.orchestra/knowledge/lessons-learned/`
4. Writes key decisions to `.orchestra/knowledge/decisions/`
5. Marks completed directives in `DIRECTIVES.md`

6. **Build gate** — MUST pass before commit:
   ```bash
   {package_manager} build 2>&1
   ```
   If build fails → skip commit, log error. Next cycle fixes it. Do NOT commit broken code.

7. **Git commit** (on orchestra branch, NOT main) — only if build gate passed:
   ```bash
   git add -A
   git commit -m "cycle-{N}: [summary from director report]"
   ```

8. **Archive**: `workspace/current-cycle/` → `workspace/archive/cycle-{N}/`

9. **Update knowledge**: `.orchestra/knowledge/research/` with findings worth keeping

10. **State update**: Cycle number increments, workspace reset for next cycle

11. **Next cycle begins** immediately — unless graceful shutdown was requested

**Completion signal**: Orchestrator writes `wrapup-complete.md`

---

## One Feature Per Cycle Rule

**Definition of "done" for a feature**:
- [ ] All acceptance criteria from `feature-spec.md` pass (100%, no partial)
- [ ] Build succeeds with no errors
- [ ] Test suite passes with no regressions
- [ ] Feature is actually usable (no placeholder UI, no TODO stubs)
- [ ] Code is committed to the orchestra branch

**If the feature cannot be completed within one cycle**:
1. Revert all partial code for the unfinished feature (`git revert`)
2. Archive the partial work with notes in `wrapup/incomplete-feature-notes.md`
3. Next cycle starts fresh with the same feature as its goal
4. Do NOT commit half-finished features — ever

**Why**: A half-done feature is worse than no feature. It creates confusion, technical debt, and broken user experiences. The slower "one at a time" approach delivers more reliability over time.

---

## Full Audit (Every 3 Cycles)

The Audit runs every 3rd cycle IN PARALLEL with the ongoing main cycle.

**Audit team**: 1 Opus (lead) + 5 Sonnets

**Audit checks**:
- Security vulnerabilities
- AI-sounding text (UI copy must read like a human wrote it)
- Code quality issues
- Bugs and edge cases
- Dependency vulnerabilities
- Accessibility compliance
- Performance bottlenecks

**Output**: Full audit report → `.orchestra/reports/audit/`

**Important**: Audit findings are NOT automatically applied. They go to Admin for review.
The main cycle continues unaffected until Admin decides what to act on.

---

## Parallel Execution Map

```
Sequential:    Analysis → Research → [RESEARCH GATE] → Planning → Task Breakdown → Engineering
                                                                                        │
Parallel:                                                                         Review ─┤
                                                                                  QA ─────┘
                                                                                        │
Post-parallel:                                                                      Wrapup
                                                                                        │
Always parallel (every 3rd cycle):                                                   Audit
```

---

## Shutdown / Resume

### Graceful Shutdown (`--stop`)
1. Set `shutdown_signal.json` → `{"type": "graceful"}`
2. Current cycle continues to completion
3. After wrapup (reports written, commit done), orchestrator exits
4. State is saved — can resume later

### Immediate Shutdown (`--kill`)
1. Set `shutdown_signal.json` → `{"type": "immediate"}`
2. Wait for currently running agent tasks to finish (max 60 sec)
3. Save current state to `cycle_state.json`
4. Exit

### Resume (`--resume`)
1. Read `cycle_state.json`
2. Determine which phase was in progress and which tasks completed
3. Resume from the next incomplete task
4. Rate limit state is reset (fresh start on limits)
