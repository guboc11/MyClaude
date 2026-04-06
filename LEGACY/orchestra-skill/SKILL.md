---
name: orchestra
description: >
  Set up an autonomous multi-agent development orchestration system for any project.
  Creates a full organizational structure (departments, teams, personas), a Python orchestrator,
  and file-based communication infrastructure that enables continuous autonomous development cycles.
  Use this skill when the user wants to: set up autonomous development, create an AI development team,
  run overnight development loops, orchestrate multiple agents for a project, automate build-review-research cycles,
  or mentions "orchestra", "orchestration", "autonomous dev", "agent team", "development loop", or "overnight coding".
  Also trigger when the user says things like "build while I sleep", "set up agents to work on this",
  or "I want continuous development on this project."
---

# Orchestra — Autonomous Multi-Agent Development Orchestrator

You are setting up an autonomous development system that organizes AI agents into a company-like structure.
Agents research, plan, build, review, and improve a project in continuous cycles — indefinitely.

This is not a simple script runner. This is a system where agents **think, doubt, research real services,
learn from real users, record findings, and make the project genuinely better** with each cycle.

---

## How This Skill Works

When invoked, you will:

1. **Analyze the current project** — understand tech stack, codebase structure, current state
2. **Interview the user** — confirm goals, constraints, scale preferences
3. **Generate the `.orchestra/` infrastructure** — folders, configs, personas, Python orchestrator
4. **Verify the setup** — dry-run validation
5. **Hand off** — the user runs `python .orchestra/orchestrator.py` and it goes

Read the reference files in this skill's directory for detailed specifications:

- `references/org-structure.md` — Department hierarchy, personas, role boundaries
- `references/cycle-flow.md` — Cycle phases, handoffs, parallel execution rules
- `references/orchestrator-design.md` — Python orchestrator architecture, queue, rate limiting
- `references/conventions.md` — File naming, folder structure, language rules, report formats

---

## Step 1: Project Analysis

Before generating anything, deeply understand the project:

```bash
# Understand the codebase
find . -name '*.tsx' -o -name '*.ts' -o -name '*.py' -o -name '*.js' | head -50
find . -name 'package.json' -o -name 'requirements.txt' -o -name 'Cargo.toml' | head -10
cat package.json 2>/dev/null | head -30
ls -la
```

Identify:
- **Tech stack** (languages, frameworks)
- **Package manager** — auto-detect from lock files:
  - `pnpm-lock.yaml` → pnpm (default if ambiguous)
  - `yarn.lock` → yarn
  - `package-lock.json` → npm
  - `bun.lockb` → bun
  - Write to `config.yaml` → `project.package_manager`
  - All agents use this for build/install/test commands
- **Project structure** (monorepo? single app? microservices?)
- **Current state** (prototype? production? how many pages/endpoints?)
- **What exists vs what's missing** (auth? DB? tests? CI?)

Record your analysis. This informs how you configure departments and personas.

## Step 2: User Interview

Confirm with the user (briefly — don't over-ask):

- **Goal**: "What should the end result look like? What's most important to improve?"
- **Backend**: "Any specific backend/DB requirements?" (Supabase, Firebase, custom, etc.)
- **Auth**: "Login needed? Which providers?"
- **Scale**: "Start small (5-10 concurrent agents) or go big (20-30)?"
- **Duration**: "How long will you typically run this? Overnight? Days?"
- **Subscription**: "Claude Max plan or API key?" (affects rate limiting strategy)

Skip questions the conversation already answered.

## Step 3: Generate Infrastructure

Read `references/org-structure.md` for the full org structure specification.
Read `references/conventions.md` for file naming and folder conventions.

Generate this folder structure inside the project root:

```
.orchestra/
├── .gitignore                         # Exclude logs, archive, runtime state from git
├── config.yaml                        # Scale, concurrency, model settings
├── orchestrator.py                    # Main entry point
├── lib/
│   ├── cycle_manager.py               # Cycle state machine
│   ├── agent_runner.py                # Claude Code CLI wrapper
│   ├── job_queue.py                   # Priority queue with concurrency control
│   ├── rate_limiter.py                # Adaptive rate limit handler
│   ├── file_bus.py                    # File-based inter-agent communication
│   ├── report_generator.py            # Cycle reports (md + html)
│   └── screenshot.py                  # Page screenshots via Puppeteer
│
├── state/
│   ├── cycle_state.json               # Current cycle number, phase, progress
│   ├── agent_registry.json            # Active agents and their assignments
│   └── shutdown_signal.json           # Graceful/immediate shutdown flags
│
├── org/
│   ├── DIRECTOR.md                    # Director persona (Opus)
│   ├── departments/
│   │   ├── analysis/
│   │   │   ├── DEPARTMENT.md          # Department mission, rules
│   │   │   └── teams/
│   │   │       └── team-01/
│   │   │           ├── TEAM.md        # Team focus area
│   │   │           ├── LEAD.md        # Team lead persona (Opus)
│   │   │           ├── MEMBER.md      # Member persona (Sonnet)
│   │   │           └── INTERN.md      # Intern persona (Haiku)
│   │   ├── research/
│   │   ├── planning/
│   │   ├── engineering/
│   │   ├── review/
│   │   ├── qa/
│   │   └── audit/                     # Special: activates every 5 cycles
│   └── onboarding/
│       ├── opus-onboarding.md         # What every Opus reads on cold start
│       ├── sonnet-onboarding.md       # What every Sonnet reads on cold start
│       └── haiku-onboarding.md        # What every Haiku reads on cold start
│
├── workspace/                         # Active work area (agents read/write here)
│   ├── current-cycle/
│   │   ├── analysis/                  # Analysis dept outputs
│   │   ├── research/                  # Research dept outputs
│   │   ├── planning/                  # Planning dept outputs
│   │   ├── engineering/               # Engineering dept outputs
│   │   ├── review/                    # Review dept outputs
│   │   ├── qa/                        # QA dept outputs
│   │   └── handoff/                   # Cross-department handoff files
│   └── backlog/                       # Items deferred to future cycles
│
├── knowledge/                         # Persistent across cycles
│   ├── research/                      # Accumulated research findings
│   ├── decisions/                     # Architecture/design decision records
│   └── lessons-learned/              # Post-cycle retrospective notes
│
├── reports/
│   ├── cycle-001/
│   │   ├── director-report.md         # Detailed report for Director (Korean)
│   │   ├── admin-report.html          # Final report for Admin (Korean, screenshots)
│   │   └── screenshots/
│   └── audit/
│       └── audit-cycle-005.md         # Full audit reports
│
├── requests/                          # Admin request system
│   ├── REQUEST_LOG.md
│   └── pending/                       # Pending requests from departments
│
├── admin-directives/
│   ├── DIRECTIVES.md                  # Admin's live directives (edit anytime, no restart needed)
│   └── DIRECTIVE_LOG.md               # History of processed directives
│
└── logs/
    ├── orchestrator.log               # Main orchestrator log
    ├── agents/                        # Per-agent execution logs
    └── rate-limits.log                # Rate limit events
```

### config.yaml Template

```yaml
project:
  name: ""                             # Auto-detected from package.json or folder name
  root: "."                            # Project root relative to .orchestra/
  tech_stack: []                       # Auto-detected
  package_manager: "pnpm"              # pnpm (default) | npm | yarn | bun
                                       # Auto-detect: pnpm-lock.yaml → pnpm, yarn.lock → yarn, etc.
                                       # All agents use this for install/build/test commands

orchestrator:
  max_concurrent_sessions: 15          # Starting value
  adaptive_concurrency:
    enabled: true
    min: 5                             # Floor (never go below)
    max: 30                            # Ceiling (never go above)
    start: 15                          # Begin here, adapt from this point
    increase_after_n_success: 10       # Bump +1 after N consecutive successes
    decrease_after_n_429: 2            # Drop -1 (not to min!) after N consecutive 429s
  cycle_check_interval_sec: 10         # How often to check queue
  max_cycles: null                     # null = infinite
  shutdown_check_interval_sec: 5       # How often to check for shutdown signal

models:
  director: "opus"                     # --model flag for claude -p
  department_head: "opus"
  team_lead: "opus"
  member: "sonnet"
  intern: "haiku"

scale:
  teams_per_department: 2
  members_per_team: 5
  interns_per_member: 2

audit:
  every_n_cycles: 5
  team_leads: 10
  members_per_team: 10

language:
  final_reports: "korean"              # Director + Admin reports
  internal: "flexible"                 # Team-level: use whatever's natural

timeouts:
  agent_task: null                     # No timeout — critical requirement
  rate_limit_retry_max_wait_sec: 300   # Max wait on 429 before giving up on that task
```

## Step 4: Generate Python Orchestrator

Read `references/orchestrator-design.md` for the full architecture specification.

The orchestrator must handle:

1. **Job Queue** — Priority-based (Opus > Sonnet > Haiku), max concurrency from config
2. **Agent Runner** — Spawns `claude -p --model <model> "<prompt>"` as subprocesses
3. **Cycle State Machine** — Tracks which phase the cycle is in, which tasks are done
4. **File Bus** — All agent communication is through files, never in-memory
5. **Rate Limiter & Auth Guard** — Detects 429 (rate limit) with adaptive backoff, per-model tracking. Also detects 401 (authentication failure / session expiry) — 3 consecutive 401s trigger graceful shutdown to prevent wasted compute.
6. **Shutdown Handler** — Watches `shutdown_signal.json` for graceful/immediate flags
7. **Resume Logic** — Can restart mid-cycle by reading `cycle_state.json`
8. **Report Generator** — End-of-cycle reports in md (director) and html (admin)
9. **Screenshot Capture** — Uses Puppeteer/Playwright for admin report screenshots

### Agent Cold Start (Onboarding)

Every agent invocation is a fresh `claude -p` session. The prompt must include:

```
[Read onboarding file] → [Read department/team persona] → [Read task assignment] → [Do the work] → [Write output to file]
```

This solves the auto-compact problem entirely — no long-running conversations, no context loss.

### How an Agent Task Looks

```python
prompt = f"""
You are {agent_role} in the {department} department.

FIRST, read these files to understand who you are and what's happening:
1. {onboarding_file}        # Your role, capabilities, boundaries
2. {persona_file}           # Your specific persona and rules
3. {task_file}              # Your current assignment
4. {context_files}          # Relevant context from other departments

THEN, do your work and write ALL outputs to: {output_dir}/

Remember:
- Write everything to files. Never assume the next agent can see your thoughts.
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

## Step 5: Generate Personas

Read `references/org-structure.md` for persona templates.

Personas must be:
- **Specific to the project** — not generic. An e-commerce app's engineering team thinks differently than a fintech one. Adapt personas to the domain.
- **Clear about boundaries** — what this role CAN and CANNOT do
- **Aware of the communication protocol** — where to read input, where to write output

## Step 6: Generate Admin Directives File

Create `.orchestra/admin-directives/DIRECTIVES.md` from the template in `references/conventions.md`.
This is Admin's live steering mechanism — they edit this file while cycles run.

Also create an empty `.orchestra/admin-directives/DIRECTIVE_LOG.md` for history.

## Step 7: Verify Setup

After generating everything:

1. Validate config.yaml is parseable
2. Verify all persona files reference correct paths
3. Do a dry run: spawn one agent (Haiku intern, cheapest) with a simple task (read a file and summarize it)
4. Confirm the output file was created in the right location
5. Show the user the folder structure and ask for approval

## Step 8: Hand Off

Tell the user:

```
Setup complete. To start the orchestrator:

  python .orchestra/orchestrator.py

To stop gracefully (finish current cycle):
  python .orchestra/orchestrator.py --stop

To stop immediately:
  python .orchestra/orchestrator.py --kill

To resume after interruption:
  python .orchestra/orchestrator.py --resume

Monitor progress:
  tail -f .orchestra/logs/orchestrator.log

View latest report:
  open .orchestra/reports/cycle-XXX/admin-report.html

Steer without stopping (edit this file anytime):
  .orchestra/admin-directives/DIRECTIVES.md
```

---

## Critical Design Principles

These apply to everything generated by this skill:

1. **File-based everything.** Agents never pass data in memory. Write to file → read from file.
   Even Haiku interns write their fetched content to files before anyone uses it.

2. **No timeouts.** Agent tasks run until completion. The orchestrator waits.
   If a task seems stuck, it's logged but never killed by timeout.

3. **Resumable.** Every state is on disk. Kill the process, restart it, and it picks up where it left off.

4. **Adaptive.** Concurrency adjusts to real rate limits automatically.

5. **Upgradeable.** The skill and the generated infrastructure can be improved over time.
   Config changes don't require regenerating the whole system.

6. **Human-quality output.** UI text must read like a human wrote it.
   Research real services. Reference real products. Never settle for "AI-sounding" copy.

7. **Slow and steady.** Quality over speed. One solid step per cycle beats three sloppy ones.
   The system runs indefinitely — there's no rush.

8. **Never commit to main.** At startup, if on main/master, create an `orchestra/cycle-{N}` branch.
   All commits happen on this branch. Admin merges to main when satisfied.
