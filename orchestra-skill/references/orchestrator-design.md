# Python Orchestrator Architecture

## Overview

The orchestrator is a single Python process that manages the entire system.
It uses `asyncio` with `subprocess` for clean process management.

```
orchestrator.py
    │
    ├── Reads config.yaml
    ├── Reads cycle_state.json (resume if exists)
    ├── Starts the cycle state machine
    │
    └── For each phase:
        ├── Creates task assignments (files)
        ├── Submits tasks to job queue
        ├── Job queue spawns claude -p processes (up to max_concurrent)
        ├── Monitors completion markers
        ├── Collects outputs
        ├── Advances to next phase
        └── Handles 429s, errors, shutdown signals
```

## Core Components

### 1. orchestrator.py (Entry Point)

```python
"""
Usage:
    python .orchestra/orchestrator.py             # Start
    python .orchestra/orchestrator.py --stop      # Graceful shutdown
    python .orchestra/orchestrator.py --kill      # Immediate shutdown
    python .orchestra/orchestrator.py --resume    # Resume after interruption
    python .orchestra/orchestrator.py --status    # Show current state
"""
```

Responsibilities:
- Parse CLI args
- Load config
- Initialize components (queue, rate limiter, cycle manager)
- Run the main loop
- Handle signals (SIGINT, SIGTERM → graceful shutdown)

### 2. cycle_manager.py (State Machine)

Manages the cycle lifecycle:

```python
PHASES = [
    "analysis",
    "research",
    "planning",
    "task_breakdown",  # Director splits plan into concrete engineering tasks
    "engineering",
    "review",          # Runs after Engineering. Sequential with QA.
    "qa",              # Runs after Review. Sequential with Review.
    "wrapup",          # Director generates reports, archives cycle
]

# Standard phases use a 3-step execution sequence.
# Engineering uses a 2-step sequence (tasks pre-loaded from task_breakdown, no initial Dept Head).
# Single-step phases (task_breakdown, wrapup) use one pass.
STANDARD_PHASES = {"analysis", "research", "planning", "review", "qa"}
TWO_STEP_PHASES = {"engineering"}
PHASE_STEPS = ["DEPT_HEAD_INITIAL", "MEMBERS", "DEPT_HEAD_COMPLETION"]
#   DEPT_HEAD_INITIAL:    Dept Head (Opus) spawned → reads directives → writes task files
#   MEMBERS:              Task files read → Team Leads + Members spawned → execute tasks
#   DEPT_HEAD_COMPLETION: Dept Head re-spawned → reads all outputs → writes {phase}-complete.md
# Engineering skips DEPT_HEAD_INITIAL — tasks arrive from task_breakdown phase.
# Its steps are: MEMBERS → DEPT_HEAD_COMPLETION only.

class CycleManager:
    cycle_number: int
    current_phase: str
    current_phase_step: str  # "DEPT_HEAD_INITIAL" | "MEMBERS" | "DEPT_HEAD_COMPLETION" | "SINGLE"
    phase_tasks: dict[str, list[Task]]
    completed_tasks: dict[str, list[str]]
    failed_tasks: dict[str, list[FailedTask]]  # [FIX BUG-1]
    graceful_shutdown_requested: bool           # [FIX BUG-9]

    def advance_phase(self) -> str | None:
        """Move to next phase. Resets current_phase_step based on the incoming phase type:
        - STANDARD_PHASES (analysis, research, planning, review, qa) → "DEPT_HEAD_INITIAL"
        - TWO_STEP_PHASES (engineering)                              → "MEMBERS"
        - Single-step phases (task_breakdown, wrapup)                → "SINGLE"
        Returns None if cycle is complete (all phases done)."""

    def advance_phase_step(self) -> bool:
        """Advance to next step within the current phase.
        Returns True if the phase is fully complete (all steps done).
        Standard phases:   DEPT_HEAD_INITIAL → MEMBERS → DEPT_HEAD_COMPLETION → done.
        Engineering:       MEMBERS → DEPT_HEAD_COMPLETION → done.  (skips DEPT_HEAD_INITIAL)
        Single-step phases (task_breakdown, wrapup): always returns True."""

    def get_pending_tasks(self) -> list[Task]:
        """Return task list for the current phase AND step.

        Standard phases (analysis / research / planning / review / qa):
          DEPT_HEAD_INITIAL    → [dept_head_task(mode="initial")]
              Dept Head reads admin directives + prior outputs, writes task files to
              workspace/{phase}/tasks/
          MEMBERS              → file_bus.read_task_files(self.current_phase)
              Reads every task-*.md written by Dept Head; spawns Team Leads + Members
          DEPT_HEAD_COMPLETION → [dept_head_task(mode="completion")]
              Dept Head reads all member outputs, writes {phase}-complete.md

        task_breakdown:
          SINGLE → [director_task()]
              Director reads sprint-plan.md + feature-spec.md, writes task-eng-{NN}.md
              files to workspace/task_breakdown/tasks/

        engineering (TWO_STEP_PHASES — skips DEPT_HEAD_INITIAL):
          MEMBERS            → returns tasks pre-loaded by phase transition hook
              (scan_task_breakdown() → load_phase_tasks("engineering", tasks)
               runs before this phase starts. get_pending_tasks() returns
               phase_tasks["engineering"] from the preloaded cache.)
          DEPT_HEAD_COMPLETION → [dept_head_task(mode="completion")]
              Dept Head (Opus) reads all Sonnet outputs, checks for conflicts/gaps,
              writes engineering-complete.md with convergence summary.

        wrapup:
          SINGLE → [director_task()]
              Director generates director-report.md, commissions admin-report.html,
              archives cycle workspace
        """

    def mark_task_complete(self, task_id: str):
        """Mark a task as done, check if phase is complete."""

    def mark_task_failed(self, task_id: str, error: str):  # [FIX BUG-1]
        """Mark a task as failed. Log error. Don't block cycle progression.
        Failed tasks are recorded in cycle state and included in reports."""

    def is_phase_complete(self) -> bool:
        """Returns True if all tasks in the current phase are done or failed.

        Failure threshold (applies when total_count >= 3):
        If failed_count / total_count > 0.30, the phase is NOT marked complete.
        Instead:
          1. Re-queue all failed tasks once more (append error context to their prompt)
          2. If the retry round ALSO exceeds 30% failure rate, log as critical and
             force-complete the phase — don't block the cycle indefinitely.

        For small phases (total_count < 3 — e.g. task_breakdown, wrapup),
        any single failure triggers one retry but does not invoke the threshold logic."""

    # All state writes go through _state_lock to prevent concurrent JSON corruption
    _state_lock: asyncio.Lock

    def save_state(self):
        """Persist to cycle_state.json for resume. Acquires _state_lock."""

    def save_task_state(self, task_id: str):
        """Persist individual task completion immediately (not just on phase transition).
        Acquires _state_lock. This prevents both re-execution on resume AND JSON corruption
        from concurrent writes when multiple agents finish simultaneously."""

    def load_state(self) -> bool:
        """Load from cycle_state.json. Returns True if state exists.

        [FIX BUG-4] On load, any task with status "running" is reclassified to
        "interrupted". These tasks were in-flight when the process died and their
        completion is unknown — they must be re-executed from scratch.

        After reclassification, interrupted tasks appear as pending in
        get_pending_tasks() and will be re-submitted when the orchestrator resumes.
        This prevents both duplicate execution (task finished but state not saved)
        and silent gaps (task never actually completed)."""

    def load_phase_tasks(self, phase: str, tasks: list[Task]):
        """Preload a task list into phase_tasks[phase] before the phase starts.
        Used by the engineering phase transition hook to inject task_breakdown output.
        Must be called BEFORE get_pending_tasks() for that phase is invoked.
        Persists to cycle_state.json immediately via save_state()."""

    def should_audit(self) -> bool:
        """True if cycle_number % audit.every_n_cycles == 0."""

    def is_graceful_shutdown(self) -> bool:  # [FIX BUG-9]
        """Check if graceful shutdown was requested.
        If True, finish current cycle then exit."""

    def start_new_cycle(self) -> None:
        """Increment cycle number and reset all phase state for the next cycle.
        Called by the orchestrator after wrapup-complete.md is confirmed written.

        Resets:
        - cycle_number += 1
        - current_phase → PHASES[0] ("analysis")
        - current_phase_step → "DEPT_HEAD_INITIAL"
          (analysis is a STANDARD_PHASE — first step is always DEPT_HEAD_INITIAL,
           NOT "SINGLE" and NOT "MEMBERS")
        - phase_tasks → {}
        - completed_tasks → {}
        - failed_tasks → {}

        Persists immediately via save_state() so a crash between wrapup and
        the next analysis phase resumes at the correct new cycle number,
        not the just-completed one."""
```

State file (`cycle_state.json`):
```json
{
    "cycle_number": 3,
    "current_phase": "engineering",
    "current_phase_step": "MEMBERS",
    "phase_tasks": {
        "engineering": [
            {"id": "eng-01", "status": "complete", "agent": "sonnet", "output": "..."},
            {"id": "eng-02", "status": "running", "agent": "sonnet", "started_at": "..."},
            {"id": "eng-03", "status": "pending"},
            {"id": "eng-04", "status": "failed", "error": "build failed after 2 retries"}
        ]
    },
    "audit_running": false,
    "graceful_shutdown_requested": false,
    "started_at": "2026-03-18T22:00:00",
    "last_updated": "2026-03-18T23:45:00"
}
```

### 3. job_queue.py (Priority Queue)

```python
class Priority(Enum):
    OPUS = 1       # Highest — decision makers don't wait
    SONNET = 2     # Workers
    HAIKU = 3      # Interns — fill gaps

class Job:
    id: str
    priority: Priority
    model: str             # "opus" / "sonnet" / "haiku" (mapped to real ID by agent_runner)
    prompt: str            # Full prompt including onboarding
    output_dir: str        # Where to write results
    completion_marker: str # File path that signals "done"
    allowed_tools: str     # --allowedTools value
    max_turns: int         # --max-turns value
    retry_count: int = 0   # [FIX BUG-2] Number of retries so far

class JobQueue:
    max_concurrent: int
    active_jobs: dict[str, subprocess.Popen]
    pending: PriorityQueue[Job]

    async def submit(self, job: Job):
        """Add job to queue. If a job with the same id is already active or pending,
        this is a no-op (idempotent). Prevents duplicate execution when the same task
        is retried due to can_submit() capacity limits."""

    async def run(self):
        """Main loop: dequeue and spawn until empty or shutdown."""

    async def wait_for_all(self):
        """Block until all active jobs complete."""

    async def drain(self, timeout: int = 60):
        """Wait for active jobs to finish, up to timeout seconds."""

    def adjust_concurrency(self, success: bool):
        """Adaptive concurrency: raise on success, lower on 429."""
```

### Helper: create_job()

```python
# Maps model short names to Priority enum values
MODEL_PRIORITY = {
    "opus":   Priority.OPUS,
    "sonnet": Priority.SONNET,
    "haiku":  Priority.HAIKU,
}

def create_job(task: Task, config: Config) -> Job:
    """Convert a Task (from get_pending_tasks / read_task_files) into a Job for the queue.

    Deterministic mapping: job.id == task.id. This is critical — the pending_tasks
    retry loop and JobQueue.submit() idempotency both depend on this.

    Args:
        task: Task object with id, model, phase, prompt_context, output_dir fields
        config: Config for looking up model settings

    Returns:
        Job ready for queue.submit()
    """
    model = task.model  # "opus" / "sonnet" / "haiku"
    return Job(
        id=task.id,                                    # deterministic — same task always same job id
        priority=MODEL_PRIORITY[model],                # KeyError here → invalid model in task, fail fast
        model=model,
        prompt=build_agent_prompt(task, config),        # see below
        output_dir=task.output_dir,
        completion_marker=f"{task.output_dir}/COMPLETE.md",
        allowed_tools=ALLOWED_TOOLS[model],
        max_turns=MAX_TURNS[model],
        retry_count=0,
    )

def build_agent_prompt(task: Task, config: Config) -> str:
    """Build the full prompt for an agent, including onboarding + persona + task assignment.

    Structure:
      1. Onboarding file content (opus-onboarding.md / sonnet-onboarding.md / haiku-onboarding.md)
      2. Persona file content (LEAD.md / MEMBER.md / INTERN.md)
      3. Task assignment (objective, context files, output dir)

    The prompt is assembled from file contents, NOT file paths — the spawned claude -p
    process does not inherit the orchestrator's file access context.
    """
    onboarding = read_file(f".orchestra/org/onboarding/{model}-onboarding.md")
    persona = read_file(task.persona_file)  # e.g. ".orchestra/org/departments/engineering/teams/team-01/MEMBER.md"
    task_content = read_file(task.assignment_file)  # e.g. workspace task file

    return f"{onboarding}\n\n---\n\n{persona}\n\n---\n\n{task_content}"
```

### 4. agent_runner.py (Process Spawner)

```python
# [FIX BUG-4] Model name to actual Claude CLI model ID mapping
MODEL_MAP = {
    "opus":   "claude-opus-4-6",
    "sonnet": "claude-sonnet-4-6",
    "haiku":  "claude-haiku-4-5",
}

class AgentRunner:
    async def run_agent(self, job: Job) -> AgentResult:
        """
        Spawn a claude -p process and wait for completion.

        Returns AgentResult with:
        - exit_code
        - stdout (captured)
        - stderr (captured)
        - duration_seconds
        - rate_limited (True if 429 detected in output)
        """

    def resolve_model(self, short_name: str) -> str:  # [FIX BUG-4]
        """Map short name ('opus') to real model ID ('claude-opus-4-6').
        Raises ValueError if unknown model name."""
        if short_name not in MODEL_MAP:
            raise ValueError(f"Unknown model: {short_name}. Valid: {list(MODEL_MAP.keys())}")
        return MODEL_MAP[short_name]
```

**Prompt delivery via stdin pipe** (not shell arg — avoids OS ARG_MAX limit):
```python
real_model_id = self.resolve_model(job.model)

# Write prompt to temp file for logging/debugging
prompt_file = Path(f".orchestra/logs/agents/{job.id}-prompt.txt")
prompt_file.parent.mkdir(parents=True, exist_ok=True)
prompt_file.write_text(job.prompt, encoding="utf-8")

# Pass prompt via stdin pipe — NOT as shell argument, NOT via $(cat ...)
# create_subprocess_exec does NOT invoke a shell, so $(cat) would be literal text.
# Instead, pipe the prompt content directly to claude's stdin.
proc = await asyncio.create_subprocess_exec(
    "claude", "-p", "-",                   # "-" tells claude to read prompt from stdin
    "--model", real_model_id,
    "--max-turns", str(job.max_turns),
    "--allowedTools", job.allowed_tools,
    stdin=asyncio.subprocess.PIPE,
    stdout=asyncio.subprocess.PIPE,
    stderr=asyncio.subprocess.PIPE,
)

# Feed prompt via stdin, then close stdin to signal EOF
proc.stdin.write(job.prompt.encode("utf-8"))
await proc.stdin.drain()
proc.stdin.close()

# NOTE: If `claude -p -` (stdin) is not supported, fall back to:
#   proc = await asyncio.create_subprocess_shell(
#       f'claude -p "$(cat {prompt_file})" --model {real_model_id} ...',
#       stdout=asyncio.subprocess.PIPE,
#       stderr=asyncio.subprocess.PIPE,
#   )
```

**Heartbeat-based stall detection** (reads BOTH stdout and stderr to prevent pipe deadlock):
```python
STALL_THRESHOLD = 1800  # 30 minutes of complete silence = stall
last_activity_time = time.time()
stdout_chunks = []
stderr_chunks = []
last_stderr_len = 0

async def drain_stderr():
    """Continuously drain stderr to prevent pipe buffer from filling up and blocking the process."""
    while True:
        chunk = await proc.stderr.read(4096)
        if not chunk:
            break
        stderr_chunks.append(chunk)

# Start stderr drainer as a concurrent task so it never blocks
stderr_task = asyncio.create_task(drain_stderr())

# Read stdout with heartbeat checking
while True:
    try:
        chunk = await asyncio.wait_for(proc.stdout.read(4096), timeout=60)
        if not chunk:
            break  # stdout closed = process finishing
        stdout_chunks.append(chunk)
        last_activity_time = time.time()
    except asyncio.TimeoutError:
        # Check if stderr had NEW activity since last check (counts as heartbeat)
        current_stderr_len = len(stderr_chunks)
        if current_stderr_len > last_stderr_len:
            last_activity_time = time.time()
            last_stderr_len = current_stderr_len

        if time.time() - last_activity_time > STALL_THRESHOLD:
            log.warning(f"Agent {job.id} stalled ({STALL_THRESHOLD}s no output). Killing.")
            proc.kill()
            await stderr_task  # Clean up
            return AgentResult(exit_code=-1, rate_limited=False,
                             stderr="Killed: no output for 30 minutes (stall detected)")
        continue

await stderr_task  # Ensure stderr is fully drained
stdout = b"".join(stdout_chunks)
stderr = b"".join(stderr_chunks)
```

**No hard timeout.** Tasks run as long as they're producing output on either stdout or stderr.
If BOTH go completely silent for 30 minutes (`STALL_THRESHOLD`), the process is assumed frozen
and killed. This prevents deadlock from network stalls without cutting short active tasks.

**Why both pipes matter:** If only stdout is read, stderr's 64KB buffer fills up → the process
blocks on stderr write → stdout also stops → heartbeat falsely detects stall → healthy agent killed.

After completion:
- Log output to `.orchestra/logs/agents/{job.id}.log`
- Check for 429 errors in output → report to rate limiter
- Check for completion marker file → report to cycle manager
- If no completion marker but exit code 0 → warn but don't fail
- **Save task state immediately** after each task completes

### 5. rate_limiter.py (Adaptive Rate Control)

```python
class RateLimiter:
    models: dict[str, ModelLimits]  # Per-model tracking

    def record_success(self, model: str):
        """Record a successful completion."""

    def record_429(self, model: str, retry_after: int | None):
        """Record a rate limit hit. Pause that model's jobs."""

    def can_submit(self, model: str) -> bool:
        """Check if we can submit a new job for this model."""

    async def wait_if_needed(self, model: str):
        """Block until the model is available again."""

    def get_current_concurrency(self) -> int:
        """Current adaptive max_concurrent value."""
```

Adaptive logic:
```python
# On success
consecutive_success[model] += 1
consecutive_429[model] = 0
if consecutive_success[model] >= config.adaptive_concurrency.increase_after_n_success:
    max_concurrent = min(max_concurrent + 1, config.adaptive_concurrency.max)
    consecutive_success[model] = 0

# On 429 — drop by 1, not to minimum. Gentle backoff.
consecutive_429[model] += 1
consecutive_success[model] = 0
if consecutive_429[model] >= config.adaptive_concurrency.decrease_after_n_429:
    max_concurrent = max(max_concurrent - 1, config.adaptive_concurrency.min)
    consecutive_429[model] = 0
    log.info(f"Concurrency decreased to {max_concurrent} due to 429s on {model}")

# Per-model pause — wait for retry_after, then resume at (current - 1) concurrency
if retry_after:
    model_paused_until[model] = time.time() + retry_after
else:
    model_paused_until[model] = time.time() + 60  # Default 60s backoff
```

### 6. file_bus.py (Inter-Agent Communication)

All communication between agents is through files. The file bus manages this:

```python
class FileBus:
    workspace: Path  # .orchestra/workspace/current-cycle/

    def write_task(self, dept: str, task_id: str, content: dict) -> Path:
        """Write a task assignment file for an agent."""

    def write_handoff(self, from_dept: str, filename: str, content: str) -> Path:
        """Write a file to the handoff directory for cross-department use."""

    def read_department_output(self, dept: str) -> list[Path]:
        """List all output files from a department."""

    def check_completion(self, dept: str, task_id: str) -> bool:
        """Check if a completion marker exists for a task."""

    def archive_cycle(self, cycle_number: int):
        """Move current-cycle/ to archive/cycle-{N}/ for the next cycle."""

    def read_task_files(self, phase: str, cycle_number: int) -> list[Task]:
        """Read task assignment files written by a Dept Head for the given phase.
        Scans workspace/current-cycle/{phase}/tasks/task-*.md
        Parses each file for: task_id, assigned role (lead/member/intern), objective.
        Returns a list of Task objects ready to be submitted to the job queue.
        Returns [] if the directory doesn't exist or contains no task files — callers
        must handle empty list gracefully (log warning, don't crash).

        CRITICAL — Task ID must include cycle number (same rule as scan_task_breakdown):
            nn = file.stem.split("-")[-1]   # "task-01" → "01"
            task_id = f"c{cycle_number:03d}-{phase}-{nn}"  # "c003-analysis-01"
        This prevents cross-cycle ID collision in JobQueue._completed.
        See conventions.md Task IDs section."""

    def scan_task_breakdown(self, cycle_number: int) -> list[Task]:
        """Read engineering task files produced during the task_breakdown phase.
        Scans workspace/current-cycle/task_breakdown/tasks/task-eng-*.md
        Each file becomes one Engineering Task (model=sonnet, single agent per task).

        CRITICAL — Task ID must include cycle number:
            # file.stem = "task-eng-05" → extract number "05"
            nn = file.stem.split("-")[-1]   # "05"
            task_id = f"c{cycle_number:03d}-eng-{nn}"  # "c003-eng-05"
        This prevents cross-cycle ID collision in JobQueue._completed.
        Without the cycle prefix, tasks from cycle N are silently deduplicated
        in cycle N+1 because JobQueue treats them as already-completed jobs.

        Returns [] if no files found — Engineering phase will complete immediately
        with a warning logged. This is intentional: if Director wrote no tasks,
        there is nothing to engineer this cycle."""
```

Task assignment file format:
```markdown
# Task Assignment

- **Task ID**: eng-03
- **Department**: Engineering
- **Team**: team-01
- **Assigned To**: Member (Sonnet)
- **Assigned At**: 2026-03-18T23:30:00

## Objective
[What to do — derived from the sprint plan]

## Context Files
Read these before starting:
- .orchestra/workspace/current-cycle/planning/sprint-plan.md
- .orchestra/workspace/current-cycle/planning/feature-spec.md
- .orchestra/workspace/current-cycle/research/technical-findings.md

## Output
Write all results to: .orchestra/workspace/current-cycle/engineering/task-eng-03/

## Completion
When done, create: .orchestra/workspace/current-cycle/engineering/task-eng-03/COMPLETE.md
Include a brief summary of what was done.
```

### 7. report_generator.py

```python
class ReportGenerator:
    def generate_director_report(self, cycle_data: dict) -> Path:
        """
        Generate detailed markdown report for Director.
        Written in Korean. Includes all department summaries,
        key decisions, metrics, and recommendations.
        """

    def generate_admin_report(self, cycle_data: dict, screenshots: list[Path]) -> Path:
        """
        Generate HTML report for Admin.
        Written in Korean. Includes:
        - Executive summary
        - What was done this cycle
        - Screenshots of all pages
        - Key metrics (score, build status, test results)
        - Open issues and next priorities
        - Org structure diagram (if helpful)
        Clean, readable design. Not a raw dump.
        """
```

### 8. screenshot.py

```python
class ScreenshotCapture:
    async def capture_all_pages(self, base_url: str, routes: list[str]) -> list[Path]:
        """
        Use Puppeteer (npx puppeteer) or Playwright to capture screenshots.

        Detection order:
        1. Check if 'npx puppeteer' is available
        2. Check if 'npx playwright' is available
        3. If neither available, log warning and return empty list
           (admin report will be generated without screenshots — not a fatal error)
        """
```

## Phase Execution: Who Spawns Whom

[FIX BUG-6, BUG-7, BUG-8]

This is how each phase is orchestrated. The orchestrator doesn't just spawn members —
it follows a clear hierarchy for each phase.

### Standard Phase Flow (Analysis, Research, Planning, Review, QA)

```
1. Orchestrator spawns Department Head (Opus)
   - Prompt: "Read admin directives + previous outputs. Break your department's work
     into team-level tasks. Write task files to workspace/{phase}/tasks/"
   - Dept Head writes: task-01.md, task-02.md, ... + assigns team/member

2. Orchestrator reads the generated task files
   - Parses each task file for: assigned team, assigned role (lead/member/intern)

3. Orchestrator spawns Team Leads and Members per task file
   - Team Leads (Opus): coordinate their team's tasks, write team-level summaries
   - Members (Sonnet): execute individual tasks
   - Interns (Haiku): support members with file reads and URL fetches

4. Orchestrator waits for all COMPLETE.md markers

5. Orchestrator spawns Department Head again
   - Prompt: "All tasks done. Read outputs. Write {phase}-complete.md with summary."
   - This is the phase completion signal.
```

### task_breakdown Phase (between Planning and Engineering)

[FIX BUG-8] This phase converts planning outputs into concrete engineering tasks.

```
1. Orchestrator spawns Director (Opus)
   - Prompt: "Read planning/sprint-plan.md and planning/feature-spec.md.
     Break this into concrete, independent engineering tasks.
     Each task must be completable by a single Sonnet in one session.
     Write each task as a separate file to workspace/task_breakdown/tasks/
     Format: task-eng-{NN}.md with objective, files to touch, acceptance criteria."

2. Orchestrator reads generated task files from workspace/task_breakdown/tasks/
   - These become the Engineering phase's task queue

3. Director writes task_breakdown-complete.md
```

### wrapup Phase

[FIX BUG-7] This phase generates reports and archives the cycle.

```
1. Orchestrator spawns Director (Opus)
   - Prompt: "Cycle {N} is complete. Read all department outputs from
     workspace/current-cycle/. Generate:
     1. director-report.md (detailed, Korean) → .orchestra/reports/cycle-{N}/
     2. Commission admin-report.html (Korean, include screenshots if available)
     Check admin-directives/DIRECTIVES.md and mark off any completed items.
     Write wrapup-complete.md when done."

2. Orchestrator runs screenshot capture (if available)
   - Screenshots saved to .orchestra/reports/cycle-{N}/screenshots/

3. Orchestrator spawns a Sonnet to generate admin-report.html
   - Input: director-report.md + screenshots + cycle data
   - Output: polished HTML report

4. Orchestrator archives:
   - Copies workspace/current-cycle/ → workspace/archive/cycle-{N}/
   - Resets workspace/current-cycle/ for next cycle
   - Increments cycle_number in state
```

### Audit Phase (every N cycles, runs in parallel)

```python
async def launch_audit(config: Config, cycle_number: int, file_bus: FileBus):  # [FIX BUG-3]
    """
    Spawn the full audit department as a parallel async task.
    Runs alongside the main cycle — does not block progression.

    1. Spawn Audit Department Head (Opus)
       - Head reviews entire codebase and creates audit task assignments
    2. Spawn Team Leads + Members per task file
       - Teams cover: security, AI-smell, code quality, bugs, deps, a11y, perf
    3. Team Leads compile team reports
    4. Dept Head writes final audit-cycle-{N}.md
    5. Save to .orchestra/reports/audit/
    """
    audit_queue = JobQueue(max_concurrent=10)  # Separate queue — doesn't contend with main cycle

    # Prompt builders defined inline — avoids NameError from undefined external helpers.
    def _audit_head_prompt() -> str:
        return (
            f"You are the Audit Department Head (Opus). This is Cycle {cycle_number} full system audit.\n\n"
            f"1. Read .orchestra/org/departments/audit/DEPARTMENT.md for your mission.\n"
            f"2. Review the entire project codebase for: security vulnerabilities, AI-sounding UI text,\n"
            f"   code quality issues, bugs/edge cases, dependency vulnerabilities, a11y, performance.\n"
            f"3. Break your audit into team-level tasks. Write each as a separate file to:\n"
            f"   .orchestra/workspace/current-cycle/audit/tasks/\n"
            f"   Format: task-audit-01.md, task-audit-02.md ... (must start with 'task-' prefix for glob matching)\n"
            f"4. Write COMPLETE.md to .orchestra/workspace/current-cycle/audit/head/ when done."
        )

    def _audit_completion_prompt() -> str:
        return (
            f"You are the Audit Department Head (Opus). All Cycle {cycle_number} audit teams are done.\n\n"
            f"1. Read all team outputs from .orchestra/workspace/current-cycle/audit/\n"
            f"2. Synthesize into a final audit report with severity ratings and specific file/line refs.\n"
            f"3. Write report to: .orchestra/reports/audit/audit-cycle-{cycle_number}.md\n"
            f"4. Write COMPLETE.md to .orchestra/reports/audit/ when done.\n\n"
            f"Important: findings are NOT automatically applied. Admin reviews and decides."
        )

    # Step 1: Spawn Audit Dept Head to create team task assignments
    head_job = Job(
        id=f"audit-{cycle_number}-head",
        priority=Priority.OPUS,
        model="opus",
        prompt=_audit_head_prompt(),
        output_dir=f".orchestra/workspace/current-cycle/audit/head/",
        completion_marker=f".orchestra/workspace/current-cycle/audit/head/COMPLETE.md",
        allowed_tools=ALLOWED_TOOLS["opus"],
        max_turns=MAX_TURNS["opus"],
        retry_count=0,
    )
    await audit_queue.submit(head_job)
    await audit_queue.wait_for_all()

    # Step 2: Read task files written by Dept Head, spawn Team Leads + Members.
    # file_bus.read_task_files("audit") scans workspace/current-cycle/audit/tasks/audit-task-*.md
    # create_job() uses task.id as job.id (deterministic) — safe to call even on retry,
    # no duplicate job IDs.
    audit_tasks = file_bus.read_task_files("audit")
    if not audit_tasks:
        log.warning(f"Audit cycle {cycle_number}: Dept Head wrote no task files. Skipping member phase.")
    else:
        for task in audit_tasks:
            job = create_job(task, config)  # uses task.id as job.id — no queue_override needed
            await audit_queue.submit(job)   # audit_queue is already the target queue
        await audit_queue.wait_for_all()

    # Step 3: Spawn Dept Head again for final synthesis
    completion_job = Job(
        id=f"audit-{cycle_number}-completion",
        priority=Priority.OPUS,
        model="opus",
        prompt=_audit_completion_prompt(),
        output_dir=f".orchestra/reports/audit/",
        completion_marker=f".orchestra/reports/audit/audit-cycle-{cycle_number}.md",
        allowed_tools=ALLOWED_TOOLS["opus"],
        max_turns=MAX_TURNS["opus"],
        retry_count=0,
    )
    await audit_queue.submit(completion_job)
    await audit_queue.wait_for_all()

    log.info(f"Audit cycle {cycle_number} complete. Report: .orchestra/reports/audit/audit-cycle-{cycle_number}.md")
    # Note: audit findings are NOT automatically applied. Admin reviews and decides what to act on.
```

## Process Management

### Startup Sequence

```python
async def main():
    config = load_config()
    state = CycleState.load() or CycleState.new()
    queue = JobQueue(max_concurrent=config.orchestrator.adaptive_concurrency.start)  # Start at 15
    rate_limiter = RateLimiter(config)
    cycle_mgr = CycleManager(state, config)
    file_bus = FileBus(config)

    # Register signal handlers using loop.add_signal_handler() — asyncio-safe.
    # signal.signal() can fire in a separate thread and corrupt shared state.
    # asyncio.Event is thread-safe; loop.add_signal_handler() runs in the event loop.
    _shutdown_event = asyncio.Event()

    def _handle_signal():
        _shutdown_event.set()

    loop = asyncio.get_event_loop()
    loop.add_signal_handler(signal.SIGINT, _handle_signal)
    loop.add_signal_handler(signal.SIGTERM, _handle_signal)

    audit_task: asyncio.Task | None = None  # Holds current audit task handle
    consecutive_auth_failures = 0     # Tracks 401s — 3 consecutive → shutdown (메인 루프 스코프)

    while True:
        # Check asyncio-safe shutdown event AND file-based signal  [FIX BUG-9]
        if _shutdown_event.is_set():
            cycle_mgr.graceful_shutdown_requested = True

        shutdown = check_shutdown_signal()  # Reads shutdown_signal.json
        if shutdown == "immediate":
            log.info("Immediate shutdown requested. Draining active jobs...")
            await queue.drain(timeout=60)
            if audit_task and not audit_task.done():
                log.warning("Immediate shutdown: cancelling audit task.")
                audit_task.cancel()
                try:
                    await asyncio.wait_for(audit_task, timeout=10)
                except (asyncio.TimeoutError, asyncio.CancelledError):
                    pass
            cycle_mgr.save_state()
            break
        if shutdown == "graceful" or cycle_mgr.is_graceful_shutdown():
            # Continue processing current cycle but don't start a new one
            cycle_mgr.graceful_shutdown_requested = True

        # Inner loop: run all steps of the current phase in sequence.
        # Standard phases (3-step): DEPT_HEAD_INITIAL → MEMBERS → DEPT_HEAD_COMPLETION
        # Engineering (2-step):     MEMBERS → DEPT_HEAD_COMPLETION
        # Single-step phases (task_breakdown, wrapup): one pass then done.
        while True:
            tasks = cycle_mgr.get_pending_tasks()

            # Submit all pending tasks. rate_limiter.wait_if_needed() blocks on 429 pauses.
            # rate_limiter.can_submit() guards max_concurrent capacity — if at limit,
            # hold unsubmitted tasks and retry after cycle_check_interval_sec.
            # Without this retry loop, tasks silently skipped here are never re-queued
            # and the phase completes without them.
            #
            # Duplicate-submission safety: create_job() MUST use task.id as job.id
            # (deterministic mapping, NOT random UUID). This ensures that if the same
            # task object is retried in a later while-loop iteration, the resulting job
            # has the same id and the queue can deduplicate by id.
            # JobQueue.submit() must reject or no-op on duplicate job.id.
            pending_tasks = list(tasks)
            while pending_tasks:
                still_pending = []
                for task in pending_tasks:
                    model = task.model
                    await rate_limiter.wait_if_needed(model)
                    if rate_limiter.can_submit(model):
                        job = create_job(task, config)  # job.id == task.id (deterministic)
                        await queue.submit(job)
                    else:
                        still_pending.append(task)  # capacity full — retry next interval
                if still_pending:
                    await asyncio.sleep(config.orchestrator.cycle_check_interval_sec)
                pending_tasks = still_pending

            await queue.wait_for_all()

            phase_done = cycle_mgr.advance_phase_step()
            cycle_mgr.save_state()
            if phase_done:
                # Phase gate: check if enough tasks succeeded before advancing.
                # is_phase_complete() enforces the 30% failure threshold defined above.
                if not cycle_mgr.is_phase_complete():
                    # >30% failure — retry MEMBERS once with error context appended
                    log.warning(f"Phase {cycle_mgr.current_phase}: >30% failure, retrying MEMBERS")
                    cycle_mgr.reset_to_members_step()  # back to MEMBERS
                    continue  # re-run inner loop for retry round
                    # If retry round ALSO fails >30%, is_phase_complete() force-completes
                    # the phase on the second call — the cycle is not blocked indefinitely.
                break  # All steps complete — fall through to advance_phase()

        # Check if audit should run (parallel)
        # Guard: if previous audit is still running, skip this cycle's audit.
        # Overwriting the handle would orphan the previous task (zombie processes).
        if cycle_mgr.should_audit():
            if audit_task and not audit_task.done():
                log.warning("Previous audit still running — skipping this cycle's audit")
            else:
                audit_task = asyncio.create_task(launch_audit(config, cycle_mgr.cycle_number, file_bus))

        # Advance to next phase
        next_phase = cycle_mgr.advance_phase()

        # Phase transition hook: preload MEMBERS tasks before the phase starts.
        # For standard phases, DEPT_HEAD_INITIAL writes task files to disk.
        # The orchestrator must read those files and inject them into phase_tasks
        # BEFORE the MEMBERS step calls get_pending_tasks().
        # Without this hook, get_pending_tasks() returns [] for MEMBERS → no agents spawn.
        if next_phase in STANDARD_PHASES:
            member_tasks = file_bus.read_task_files(next_phase, cycle_mgr.cycle_number)
            if member_tasks:
                cycle_mgr.load_phase_tasks(next_phase, member_tasks)
            # Note: empty task list is OK — dept_head may not have written tasks yet.
            # Tasks are loaded AGAIN after DEPT_HEAD_INITIAL completes (see inner loop).

        # Phase transition hook: load task_breakdown output into engineering queue.
        # Must happen BEFORE engineering phase's get_pending_tasks() is called.
        if next_phase == "engineering":
            eng_tasks = file_bus.scan_task_breakdown(cycle_mgr.cycle_number)
            if not eng_tasks:
                log.warning("task_breakdown produced no task files — engineering phase will be empty")
            cycle_mgr.load_phase_tasks("engineering", eng_tasks)

        if next_phase is None:
            # ── Cycle complete: build gate → git commit ──
            # CRITICAL: This block MUST run the build gate and git commit.
            # Without these, all code changes made by engineering agents
            # during this cycle will remain uncommitted — effectively lost.
            # See also: "Build gate — never commit broken code" section (L995-1008).
            build_result = run(f"{config.project.package_manager} build 2>&1")
            if build_result.exit_code == 0:
                summary = cycle_mgr.get_cycle_summary()   # wrapup director의 요약 (구현 시: wrapup-director-done.md에서 첫 줄 추출)
                run("git add -A")
                run(f'git commit -m "cycle-{cycle_mgr.cycle_number}: {summary}"')
            else:
                log.error(f"Cycle {cycle_mgr.cycle_number}: build failed — skipping commit")
                # Next cycle's Analysis will pick up the broken state and fix it

            if cycle_mgr.graceful_shutdown_requested:  # [FIX BUG-9]
                # Wait for any running audit before exiting — audit takes ~40min,
                # main cycle ~20min, so audit is often still running at shutdown.
                if audit_task and not audit_task.done():
                    log.info("Graceful shutdown: waiting for audit to complete...")
                    try:
                        await asyncio.wait_for(audit_task, timeout=1800)  # 30min max
                    except asyncio.TimeoutError:
                        log.warning("Audit timed out (30min). Cancelling.")
                        audit_task.cancel()
                log.info(f"Cycle {cycle_mgr.cycle_number} complete. Graceful shutdown.")
                cycle_mgr.save_state()
                break
            cycle_mgr.start_new_cycle()

        cycle_mgr.save_state()
```

### Error Handling

```python
# Agent task completed
if result.exit_code == 0:
    cycle_mgr.mark_task_complete(job.id)
    cycle_mgr.save_task_state(job.id)  # [FIX BUG-10] Save immediately, not just on phase transition
    rate_limiter.record_success(job.model)
    consecutive_auth_failures = 0     # Reset auth failure counter on any success

# Agent task failed (non-429)
elif result.exit_code != 0 and not result.rate_limited:
    log.warning(f"Task {job.id} failed (attempt {job.retry_count + 1}): {result.stderr[:500]}")
    # Retry once
    if job.retry_count < 1:   # [FIX BUG-2] retry_count is now a field with default 0
        job.retry_count += 1
        await queue.submit(job)
    else:
        # Log failure, don't block the cycle  [FIX BUG-1]
        cycle_mgr.mark_task_failed(job.id, result.stderr[:1000])
        cycle_mgr.save_task_state(job.id)  # [FIX BUG-10]

# Rate limited (429)
elif result.rate_limited:
    retry_after = parse_retry_after(result.stderr)
    rate_limiter.record_429(job.model, retry_after)
    # Re-queue with retry limit — prevents infinite loop on daily quota exhaustion
    if job.retry_count < 3:
        job.retry_count += 1
        await queue.submit(job)  # will wait via rate_limiter.wait_if_needed
    else:
        log.error(f"Task {job.id} rate-limited 3 times. Marking failed.")
        cycle_mgr.mark_task_failed(job.id, "Rate limited 3 times — daily quota likely exhausted")
        cycle_mgr.save_task_state(job.id)

# Authentication failure (401) — session expired or invalid API key
# Claude Max sessions expire after several hours. API keys can be revoked.
# Unlike 429 (temporary, retryable), 401 is permanent until re-authentication.
# Continuing to spawn agents after 401 wastes compute with zero chance of success.
elif "authentication_error" in result.stderr:
    log.critical(f"Task {job.id}: authentication failed (401). Triggering shutdown.")
    consecutive_auth_failures += 1
    cycle_mgr.mark_task_failed(job.id, "Authentication failed (401)")
    if consecutive_auth_failures >= 3:
        log.critical("3 consecutive auth failures — initiating graceful shutdown.")
        cycle_mgr.graceful_shutdown_requested = True
```

## Allowed Tools per Role

```python
ALLOWED_TOOLS = {
    "opus":   "Edit,Write,Bash,Read,Glob,Grep,WebSearch,WebFetch",
    "sonnet": "Edit,Write,Bash,Read,Glob,Grep,WebSearch,WebFetch",
    "haiku":  "Read,Bash,Glob,Grep,WebFetch",  # No Edit, No Write
}
```

Haiku gets Read but not Write/Edit — it can read files and fetch URLs.
**Haiku writes output via Bash** (e.g., `echo "content" > output.txt` or `cp source dest`).
This is explicitly documented in haiku-onboarding.md. [FIX BUG-5]

## Max Turns per Role

```python
MAX_TURNS = {
    "opus": 100,    # Decision makers need room to think
    "sonnet": 80,   # Workers need room to code
    "haiku": 20,    # Interns do simple things
}
```

## Git Branch Strategy

**Critical rule: never commit directly to main.**

### Branch creation (with dirty tree handling)
```python
# At orchestrator startup:
current_branch = run("git branch --show-current").strip()

if current_branch in ("main", "master"):
    branch_name = f"orchestra/cycle-{cycle_mgr.cycle_number}"
    # Handle dirty working tree — stash before branching
    status = run("git status --porcelain").strip()
    if status:
        run("git stash push -m 'orchestra-auto-stash'")
    # Check if branch already exists (e.g. on resume after restart)
    result = subprocess.run(
        ["git", "checkout", "-b", branch_name],
        capture_output=True, text=True
    )
    if result.returncode != 0:
        # Branch already exists — switch to it instead of creating
        log.info(f"Branch {branch_name} already exists, switching to it.")
        subprocess.run(["git", "checkout", branch_name], check=True)
    if status:
        run("git stash pop")
```

### .gitignore generation
At setup, generate a `.orchestra/.gitignore`:
```gitignore
# Orchestrator runtime — don't commit these
logs/
workspace/archive/
state/agent_registry.json
state/shutdown_signal.json
*.log

# Keep these in git:
# config.yaml, org/, knowledge/, reports/, admin-directives/
```

### Build gate — never commit broken code
```python
# In wrapup phase, BEFORE committing:
build_result = run(f"{config.project.package_manager} build 2>&1")
if build_exit_code != 0:
    log.error("Build failed — skipping commit for this cycle")
    # Write failure to director report but do NOT commit
    # Next cycle's Analysis will pick up the broken state and fix it
    return

# Only if build passes:
run("git add -A")
run(f'git commit -m "cycle-{cycle_number}: {summary}"')
```

### Commit timing
- **Wrapup phase only**: code is committed once per cycle, after Review + QA pass AND build succeeds
- **If build fails**: no commit. Next cycle fixes it.
- **Admin merges**: Admin manually merges the orchestra branch to main when satisfied
