---
name: orchestra-small
description: >
  Set up a lean, disciplined multi-agent development orchestration system for any project.
  Designed for reliability over speed: one feature per cycle, mandatory real-world research,
  and file-based ownership to prevent git conflicts between parallel agents.
  Use this skill when the user wants autonomous development with a smaller, controlled agent team
  (max 8 concurrent agents), when the original orchestra skill feels too large or risky,
  or when they prioritize correctness and conflict-free commits over raw throughput.
  Trigger when the user says "small orchestra", "safe autonomous dev", "controlled agent loop",
  "no haiku", "8 agents max", or "one feature at a time" — or when they've tried the full
  orchestra and want a more disciplined setup.
---

# Orchestra Small — Lean Autonomous Development Orchestrator

A disciplined, small-scale alternative to the full Orchestra skill.
Same idea — AI agents working in continuous development cycles — but with **fewer agents,
stricter rules, and safety mechanisms** the original lacks.

This is for teams (or individuals) who want autonomous development to be **slow but correct**,
not fast and chaotic.

---

## Why This Exists (vs. the Original Orchestra)

The original `orchestra-skill` optimizes for throughput: 30 concurrent agents, multiple teams
per department, Haiku interns for cheap parallelism.

This skill optimizes for **reliability**:

### Core Philosophy

**1. Slow but Certain**
Each cycle completes exactly one feature. A feature is done only when:
- Build passes
- Tests pass
- Review is clean
- Code is committed

If a cycle ends without meeting all four, that feature is either fixed or reverted — never
left in a half-done state. The next cycle begins fresh.

**2. Real-World Research Required (Research Gate)**
Before any Engineering work begins, the Research phase must produce:
- At least one real external URL (not an AI hallucination)
- A specific, concrete reference (a UI pattern, an API spec, a competing product)

If Research cannot produce this, the cycle stops and the Director reassigns the goal.
"AI consensus" is not a valid research output.

**3. File Ownership (No Surprise Conflicts)**
Every Engineering task must declare its file list before starting.
The Director checks for overlaps. Overlapping tasks are merged or serialized.
Parallel agents never touch the same file. Git conflicts become structurally impossible.

---

## How This Skill Works

Install proceeds in 7 steps. Each step references one or more files in `references/`:

| Step | What Happens | Key Reference |
|------|-------------|---------------|
| 1 | Analyze the codebase | _(in-skill analysis)_ |
| 2 | Interview the user | _(guided questions below)_ |
| 3 | Generate `.orchestra/` folder structure | `references/org-structure.md` |
| 4 | Generate Python orchestrator | `references/orchestrator-design.md` |
| 5 | Generate personas (Opus + Sonnet only) | `references/org-structure.md` |
| 6 | Verify setup with dry run | `references/cycle-flow.md` |
| 7 | Hand off to user | _(instructions below)_ |

Additional reference files:
- `references/file-ownership.md` — File ownership declaration format and conflict-check logic
- `references/cycle-flow.md` — Full cycle phases, Research Gate rules, handoff formats
- `references/conventions.md` — File naming, folder structure, report formats, language rules

---

## Step 1: Project Analysis

Before generating anything, understand the project deeply.

```bash
# Scan codebase structure
find . -name '*.tsx' -o -name '*.ts' -o -name '*.py' -o -name '*.js' | head -50
find . -name 'package.json' -o -name 'requirements.txt' -o -name 'Cargo.toml' | head -10
cat package.json 2>/dev/null | head -30
ls -la
```

Identify:
- **Tech stack** — languages, frameworks, test runners
- **Package manager** — auto-detect from lock files:
  - `pnpm-lock.yaml` → pnpm
  - `yarn.lock` → yarn
  - `package-lock.json` → npm
  - `bun.lockb` → bun
  - Record in `config.yaml` → `project.package_manager`; all agents use this
- **Project structure** — monorepo? single app? microservices?
- **Current state** — prototype? production? what exists vs. what's missing?
- **Current branch** — if on `main`/`master`, the orchestrator must branch out immediately

Record findings. They determine how departments and personas are configured.

---

## Step 2: User Interview

Ask only what's needed. Skip anything the conversation already answered.

**Required questions:**

1. **Goal**: "What single feature should the first cycle complete? (One feature only — we can plan more after.)"
2. **Stack constraints**: "Any backend/DB requirements?" (Supabase, Firebase, custom, etc.)
3. **Auth**: "Login needed? Which providers?"
4. **Subscription**: "Claude Max plan or API key?" (affects rate limiting strategy)

**Confirm the core contract:**

> "This system completes **one feature per cycle** — fully built, tested, and committed before
> moving on. Partial features are never committed. Does this match what you want?"

If the user says no (they want faster/parallel feature work), redirect them to the full
`orchestra-skill`. This skill is not the right fit.

---

## Step 3: Generate Infrastructure

Read `references/org-structure.md` for the full department and persona structure.
Read `references/conventions.md` for file naming and folder conventions.

Generate this folder structure in the project root:

```
.orchestra/
├── .gitignore                         # Exclude logs, archive, runtime state
├── config.yaml                        # Scale, concurrency, model settings
├── orchestrator.py                    # Main entry point
├── lib/
│   ├── cycle_manager.py               # Cycle state machine
│   ├── agent_runner.py                # Claude Code CLI wrapper
│   ├── job_queue.py                   # Priority queue with concurrency control
│   ├── rate_limiter.py                # Adaptive rate limit handler
│   ├── file_bus.py                    # File-based inter-agent communication
│   ├── ownership_checker.py           # File ownership conflict detection
│   └── report_generator.py            # Cycle reports (md)
│
├── state/
│   ├── cycle_state.json               # Current cycle number, phase, progress
│   ├── agent_registry.json            # Active agents and their assignments
│   ├── file_ownership.json            # Active file ownership declarations
│   └── shutdown_signal.json           # Graceful/immediate shutdown flags
│
├── org/
│   ├── DIRECTOR.md                    # Director persona (Opus)
│   ├── onboarding/
│   │   ├── opus-onboarding.md         # What every Opus reads on cold start
│   │   └── sonnet-onboarding.md       # What every Sonnet reads on cold start
│   └── departments/
│       ├── analysis/
│       │   ├── DEPARTMENT.md          # Department mission and rules
│       │   └── team-01/
│       │       ├── TEAM.md
│       │       ├── LEAD.md            # Team lead persona (Opus)
│       │       └── MEMBER.md          # Member persona (Sonnet)
│       ├── research/
│       │   └── team-01/ ...
│       ├── planning/
│       │   └── team-01/ ...
│       ├── engineering/
│       │   └── team-01/ ...
│       ├── review/
│       │   └── team-01/ ...
│       ├── qa/
│       │   └── team-01/ ...
│       └── audit/                     # Activates every 3 cycles
│           └── team-01/ ...
│
├── workspace/
│   └── current-cycle/
│       ├── analysis/
│       ├── research/
│       ├── planning/
│       ├── engineering/
│       ├── review/
│       ├── qa/
│       └── handoff/
│
├── knowledge/
│   ├── research/                      # Accumulated research findings (persist across cycles)
│   ├── decisions/                     # Architecture/design decision records
│   └── lessons-learned/
│
├── reports/
│   └── cycle-001/
│       ├── director-report.md
│       └── audit/
│
├── admin-directives/
│   ├── DIRECTIVES.md                  # Admin's live steering (edit anytime, no restart needed)
│   └── DIRECTIVE_LOG.md
│
└── logs/
    ├── orchestrator.log
    └── agents/
```

### config.yaml Template

```yaml
project:
  name: ""                             # Auto-detected
  root: "."
  tech_stack: []
  package_manager: "pnpm"             # Auto-detected from lock files

orchestrator:
  max_concurrent_sessions: 6          # Small: default 6, ceiling 8
  adaptive_concurrency:
    enabled: true
    min: 2
    max: 8                            # Hard ceiling — never exceed
    start: 6
    increase_after_n_success: 10
    decrease_after_n_429: 2
  cycle_check_interval_sec: 10
  max_cycles: null                    # null = infinite
  shutdown_check_interval_sec: 5

models:
  director: "opus"
  department_head: "opus"
  team_lead: "opus"
  member: "sonnet"
  # No haiku in this configuration

scale:
  teams_per_department: 1             # One team per department (no parallel teams)
  members_per_team: 3                 # Max 3 Sonnets per team

audit:
  every_n_cycles: 3                   # More frequent than original (was 5)

cycle:
  features_per_cycle: 1              # Hard rule: exactly one feature per cycle
  require_research_gate: true        # Research Gate is mandatory, not optional
  commit_only_when_passing: true     # Build + tests must pass before any commit

language:
  final_reports: "korean"
  internal: "flexible"

timeouts:
  agent_task: null                    # No timeout — agents run until done
  rate_limit_retry_max_wait_sec: 300
```

---

## Step 4: Generate Python Orchestrator

Read `references/orchestrator-design.md` for the full architecture specification.

The orchestrator must handle:

1. **Job Queue** — Priority-based (Opus > Sonnet), max concurrency from config
2. **Agent Runner** — Spawns `claude -p --model <model> "<prompt>"` as subprocesses
3. **Cycle State Machine** — Tracks phase and task completion; reads `cycle_state.json`
4. **File Ownership Checker** — Before dispatching Engineering tasks, loads all declared
   file ownership entries from `state/file_ownership.json` and checks for conflicts.
   See `references/file-ownership.md` for the exact format and conflict resolution rules.
5. **File Bus** — All agent communication is through files, never in-memory
6. **Rate Limiter & Auth Guard** — Detects 429 with adaptive backoff; 3 consecutive 401s
   trigger graceful shutdown
7. **Research Gate Enforcer** — After Research phase completes, validates that outputs
   include at least one external URL and a concrete reference. Blocks Engineering if not.
   See `references/cycle-flow.md` for gate validation logic.
8. **Shutdown Handler** — Watches `shutdown_signal.json`
9. **Resume Logic** — Restarts mid-cycle by reading `cycle_state.json`
10. **Report Generator** — End-of-cycle markdown reports

### Agent Cold Start

Every agent invocation is a fresh `claude -p` session. Prompt structure:

```
[Read onboarding file] → [Read department/team persona] → [Declare file ownership if Engineering]
→ [Read task assignment] → [Do the work] → [Write outputs to file]
```

This eliminates auto-compact issues — no long-running sessions, no context drift.

### Agent Task Example

```python
prompt = f"""
You are {agent_role} in the {department} department.

FIRST, read these files in order:
1. {onboarding_file}        # Your role, capabilities, limits
2. {persona_file}           # Your specific persona and rules
3. {task_file}              # Your current assignment
4. {context_files}          # Relevant context from other departments

{"BEFORE starting work, declare your file ownership:" if is_engineering_task else ""}
{"Write your declaration to: .orchestra/state/file_ownership.json (append your entry)" if is_engineering_task else ""}
{"Wait for ownership confirmation from orchestrator before writing any code." if is_engineering_task else ""}

THEN do your work and write ALL outputs to: {output_dir}/

Rules:
- Write everything to files. No in-memory handoffs.
- {role_specific_rules}
"""

proc = await asyncio.create_subprocess_exec(
    "claude", "-p", "-",
    "--model", model,
    "--max-turns", "80",
    "--allowedTools", allowed_tools,
    stdin=asyncio.subprocess.PIPE,
    stdout=asyncio.subprocess.PIPE,
    stderr=asyncio.subprocess.PIPE,
)
proc.stdin.write(prompt.encode("utf-8"))
await proc.stdin.drain()
proc.stdin.close()
```

---

## Step 5: Generate Personas

Read `references/org-structure.md` for persona templates.

**Only two model tiers in this skill:**

- **Opus** — Director, Department Heads, Team Leads. Strategic, skeptical, gate-keeping.
- **Sonnet** — Members (implementers). Executes tasks, writes code, runs tests.

No Haiku in this configuration. Every agent that touches the project has enough model
capacity to reason carefully.

Personas must be:
- **Project-specific** — An e-commerce checkout flow needs different instincts than a data pipeline.
  Adapt the language and domain knowledge in each persona to the actual project.
- **Clear about boundaries** — What this role CAN do, what it CANNOT do, what it must escalate.
- **Protocol-aware** — Where to read input, where to write output, how to declare file ownership.
- **Research Gate-aware** (Research roles) — Research members must know that a report without
  a real external URL is invalid and will block the cycle.

---

## Step 6: Verify Setup

After generating everything, run a dry-run validation:

1. Parse `config.yaml` — confirm it loads without errors
2. Walk all persona files — confirm every referenced path exists
3. **Dry run**: Spawn one Sonnet member with a minimal task:
   > "Read `.orchestra/config.yaml` and write a one-sentence summary of the project name
   > and package manager to `.orchestra/workspace/current-cycle/analysis/dry-run-check.txt`."
4. Confirm the output file was created in the correct location
5. Display the folder structure to the user and ask for approval before continuing

If the dry run fails, diagnose and fix before handing off. Do not hand off a broken setup.

---

## Step 7: Hand Off

After the user approves the setup:

```
Setup complete. Your orchestra-small system is ready.

To start:
  python .orchestra/orchestrator.py

To stop gracefully (finish the current cycle first):
  echo '{"graceful": true}' > .orchestra/state/shutdown_signal.json

To stop immediately:
  echo '{"immediate": true}' > .orchestra/state/shutdown_signal.json

To resume after an interruption:
  python .orchestra/orchestrator.py --resume

Monitor live:
  tail -f .orchestra/logs/orchestrator.log

View latest cycle report:
  cat .orchestra/reports/cycle-XXX/director-report.md

Steer without stopping (edit this file anytime while running):
  .orchestra/admin-directives/DIRECTIVES.md

Remember:
- One feature per cycle. The system won't move on until it's done.
- Research Gate blocks Engineering if no real URL is found. This is intentional.
- File ownership prevents git conflicts automatically — trust the system.
- Audit runs every 3 cycles and may produce a reset recommendation.
```

---

## Critical Design Principles

These apply to everything generated by this skill. Do not compromise on any of them.

**1. One feature per cycle — no exceptions.**
The system is configured with `features_per_cycle: 1`. The Director enforces this.
If a cycle's planned feature is too large, the Director breaks it down before Engineering begins.
Partial work is never committed. Ever.

**2. Research Gate is mandatory.**
The orchestrator programmatically validates Research outputs before unlocking Engineering.
Validation requires: at least one `https://` URL from an external site, and at least one
concrete reference to a real product, pattern, or specification. Vague AI-generated
"research" that cites nothing is rejected automatically.

**3. File ownership is declared, not assumed.**
Every Engineering task writes its file list to `state/file_ownership.json` before touching
any code. The orchestrator checks for conflicts. Overlapping tasks are merged or serialized.
This is how we guarantee zero git conflicts from parallel agents.

**4. File-based everything.**
Agents never pass data in memory. Write to file → read from file. Even simple results.
This makes the system resumable, debuggable, and auditable.

**5. No timeouts on agent tasks.**
Tasks run until completion. The orchestrator logs long-running tasks but never kills them.
If something is genuinely stuck, the shutdown signal handles it gracefully.

**6. Resumable at all times.**
All state is on disk. Kill the process, restart, and it continues from the same cycle phase.
No work is ever lost due to a crash.

**7. Never commit to main/master.**
On startup, if on `main` or `master`, the orchestrator creates an `orchestra/cycle-N` branch.
All commits go to that branch. The user merges when satisfied.

**8. Build + tests must pass before commit.**
Engineering tasks that don't produce a passing build are flagged for review, not committed.
The Review and QA departments have hard authority to block commits.

**9. Audit every 3 cycles.**
The Audit department activates automatically and produces a report on code quality, test
coverage, and whether any design decisions should be revisited. Recommendations may include
a reset of the current feature plan.

**10. Fewer agents, better judgment.**
Max 8 concurrent agents. This is not a limitation — it's a constraint that forces the system
to be deliberate. Each agent matters more when there are fewer of them.
