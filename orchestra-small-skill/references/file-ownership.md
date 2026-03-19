# File Ownership System

## Overview

### Why It's Needed

In the Engineering phase, multiple Sonnet agents work in parallel on independent tasks.
Without coordination, two agents may attempt to modify the same file simultaneously — resulting in git merge conflicts, overwritten code, or inconsistent state.

**The problem scenario:**
```
Task c003-eng-01 → modifies src/components/Button.tsx (line 42: add variant prop)
Task c003-eng-02 → modifies src/components/Button.tsx (line 38: rename className)
→ git conflict on the same file from two parallel commits
```

### Solution: File Ownership Declaration

Before Engineering phase begins, each task declares which files it will modify.
The Director (Opus) runs a conflict check across all tasks before distributing them.
Tasks with overlapping file ownership cannot run in parallel — they must be merged or sequenced.

**Effect**: Parallel git conflicts are structurally impossible. If two tasks would touch the same file, the conflict is caught at planning time, not at commit time.

---

## Task File Ownership Declaration Format

Every Engineering task file (`task-eng-XX.md`) **must** include a `File Ownership` section.
This is not optional. Tasks without this section will not be dispatched.

```markdown
## File Ownership

### Exclusively Owned (this task is the only one that may modify these files)
- src/components/Button.tsx
- src/styles/button.css
- src/components/__tests__/Button.test.tsx

### Read-Only Reference (may read, must not modify)
- src/types/index.ts
- src/utils/cn.ts
```

### Rules for Declaring Ownership

1. **Exclusively Owned** — list every file this task will create or modify.
   If you're not sure whether you'll touch a file, list it anyway (conservative is safe).

2. **Read-Only Reference** — list files you'll read but not modify.
   This helps the Director understand dependencies without creating conflicts.

3. **New files** — files that don't exist yet do not need to be declared.
   A brand-new file cannot conflict with another agent's changes.

4. **Test files** — automatically owned by whoever owns the source file.
   If you own `src/components/Button.tsx`, you own `src/components/__tests__/Button.test.tsx` too.
   No separate declaration needed.

### Full Task File Example

```markdown
# Task: Add variant prop to Button component

- **ID**: task-eng-01
- **Depends on**: none
- **Estimated complexity**: low

## File Ownership

### Exclusively Owned
- src/components/Button.tsx
- src/styles/button.css

### Read-Only Reference
- src/types/index.ts
- src/components/Icon.tsx

## Objective
Add a `variant` prop to the Button component supporting: primary, secondary, ghost.

## Files to Touch
- src/components/Button.tsx — add variant prop and conditional className logic
- src/styles/button.css — add .btn-primary, .btn-secondary, .btn-ghost styles

## Acceptance Criteria
- [ ] Button renders correctly for all three variants
- [ ] Existing Button usages (no variant prop) still work (default = primary)
- [ ] Storybook story updated with all variants
- [ ] Unit tests pass

## Context
Read these before starting:
- .orchestra/workspace/current-cycle/planning/design-spec.md
- .orchestra/workspace/current-cycle/planning/feature-spec.md
```

---

## Director's Conflict Check Algorithm

Before distributing tasks to Engineering agents, the Director (Opus) runs a conflict check.
This is a mandatory step between Task Breakdown and Engineering dispatch.

### Pseudocode

```python
def check_ownership_conflicts(tasks: list[Task]) -> ConflictReport:
    # Step 1: Collect all Exclusively Owned files across all tasks
    ownership_map = {}  # file_path -> [task_id, ...]

    for task in tasks:
        for file_path in task.exclusively_owned:
            if file_path not in ownership_map:
                ownership_map[file_path] = []
            ownership_map[file_path].append(task.id)

    # Step 2: Find conflicts (any file claimed by more than one task)
    conflicts = []
    for file_path, claiming_tasks in ownership_map.items():
        if len(claiming_tasks) > 1:
            conflicts.append(Conflict(
                file=file_path,
                tasks=claiming_tasks
            ))

    return ConflictReport(conflicts=conflicts)


def resolve_conflicts(conflicts: ConflictReport, tasks: list[Task]) -> ExecutionPlan:
    if not conflicts:
        return ExecutionPlan(parallel=tasks, sequential=[])

    for conflict in conflicts:
        # Choose resolution strategy:
        resolution = choose_resolution(conflict, tasks)

        if resolution == "MERGE":
            # (a) Merge conflicting tasks into one larger task
            merged = merge_tasks(conflict.tasks)
            tasks = [t for t in tasks if t.id not in conflict.tasks] + [merged]

        elif resolution == "SEQUENCE":
            # (b) Keep tasks separate, run them one after the other
            # (safer than merge when tasks are logically independent)
            plan.mark_sequential(conflict.tasks)

        elif resolution == "REFACTOR":
            # (c) File is too tightly coupled — request file split before continuing
            raise RefactorRequired(
                message=f"{conflict.file} is claimed by {len(conflict.tasks)} tasks. "
                        f"Split this file into smaller units before proceeding.",
                file=conflict.file
            )

    return plan
```

### Resolution Strategy Selection Guide

| Situation | Recommended Resolution |
|-----------|------------------------|
| Two tasks modify different parts of the same small file | (b) Sequential |
| Two tasks are deeply related and share most of their logic | (a) Merge |
| A shared file is being modified by 3+ tasks | (c) Refactor — the file is too central |
| Tasks are in different domains but share a utility file | Move utility to Read-Only; each task adds only its own helper |

### When to Block Engineering Entirely

If a conflict cannot be resolved by merge, sequencing, or refactoring guidance, the Director must:
1. Write a `conflict-block.md` in `workspace/current-cycle/engineering/`
2. Report back to the operator / Admin with a clear description of the conflict
3. Do not begin Engineering until the conflict is resolved

---

## Ownership Registry File

Once the Director completes conflict checking and resolution, it writes the Ownership Registry.
This is the authoritative source of truth for the entire Engineering phase.

**Location**: `workspace/current-cycle/engineering/ownership-registry.json`

**Format**:
```json
{
  "cycle": 3,
  "generated_at": "2025-01-15T09:00:00Z",
  "tasks": {
    "c003-eng-01": {
      "exclusive": [
        "src/components/Button.tsx",
        "src/styles/button.css"
      ],
      "readonly": [
        "src/types/index.ts"
      ],
      "execution_mode": "parallel"
    },
    "c003-eng-02": {
      "exclusive": [
        "src/components/Modal.tsx",
        "src/components/Modal.css"
      ],
      "readonly": [
        "src/types/index.ts",
        "src/utils/focusTrap.ts"
      ],
      "execution_mode": "parallel"
    },
    "c003-eng-03": {
      "exclusive": [
        "src/pages/HomePage.tsx"
      ],
      "readonly": [
        "src/components/Button.tsx",
        "src/components/Modal.tsx"
      ],
      "execution_mode": "sequential",
      "depends_on": ["c003-eng-01", "c003-eng-02"]
    }
  },
  "conflicts": [],
  "resolved_conflicts": [
    {
      "file": "src/pages/HomePage.tsx",
      "original_claimants": ["c003-eng-01", "c003-eng-03"],
      "resolution": "sequential",
      "note": "HomePage task moved to sequential after Button completes"
    }
  ]
}
```

### Registry Fields

| Field | Description |
|-------|-------------|
| `cycle` | Current cycle number (matches the active cycle) |
| `generated_at` | ISO timestamp when Director wrote the registry |
| `tasks[id].exclusive` | Files only this task may modify |
| `tasks[id].readonly` | Files this task reads but won't modify |
| `tasks[id].execution_mode` | `"parallel"` or `"sequential"` |
| `tasks[id].depends_on` | Task IDs that must complete before this one starts |
| `conflicts` | Unresolved conflicts (must be empty before Engineering starts) |
| `resolved_conflicts` | Audit trail of conflicts that were detected and resolved |

---

## Runtime Enforcement Rules

### 1. Registry Must Exist Before Engineering Starts

The orchestrator checks for `ownership-registry.json` before spawning any Engineering agent.

```
if not exists("workspace/current-cycle/engineering/ownership-registry.json"):
    raise EngineeringBlockedError("ownership-registry.json not found. Run Task Breakdown first.")
```

### 2. Unresolved Conflicts Block Parallel Execution

```
if registry["conflicts"] != []:
    log("Unresolved conflicts detected. Switching all tasks to sequential mode.")
    run_all_sequential(registry["tasks"])
```

Sequential fallback is always safe. It's slower, but it will not produce git conflicts.

### 3. Agent Modifies a File Not in Its Ownership Declaration

If an Engineering agent's commit touches a file not listed in its `exclusive` ownership:
1. The orchestrator detects this via `git diff --name-only` post-commit
2. Issue a warning: `"Task c003-eng-01 modified src/utils/cn.ts — not declared in File Ownership."`
3. Request the agent to amend its ownership declaration before the next parallel task starts
4. If the undeclared file is already owned by another task: **rollback the commit** and re-run sequentially

### 4. Read-Only Violations

If an agent modifies a file it declared as Read-Only:
1. Flag the violation immediately
2. Roll back the change
3. The agent must either:
   - Create a new file for its additions (preferred), or
   - Claim exclusive ownership and re-run conflict check

---

## Special Cases

### New Files (Created From Scratch)

New files do not need to be declared in `File Ownership`.

A file that doesn't exist yet cannot conflict with any existing agent's changes.
The orchestrator tracks new file creation separately and verifies no two agents create the same new file path.

```
# Fine — no declaration needed:
## Objective
Create src/components/Tooltip.tsx from scratch.
```

### Shared Type Files (`types/index.ts`, `types/shared.ts`, etc.)

Common type definition files are a frequent source of conflicts because everyone needs them.

**Rule**: Shared type files must always be **Read-Only Reference**. Never Exclusively Owned.

If a task needs to add new types:
1. Create a new file: `src/types/button-types.ts`
2. Export from the new file, then re-export from `types/index.ts` in a separate, minimal PR
3. Never add types inline to the shared file during parallel Engineering

```markdown
### Read-Only Reference
- src/types/index.ts   ← always read-only; never exclusively owned
```

### Test Files

Test files are automatically co-owned with their source file.

If you own `src/components/Button.tsx`, you implicitly own:
- `src/components/__tests__/Button.test.tsx`
- `src/components/Button.spec.tsx`
- Any test file that matches the source file name

No additional declaration is needed. The orchestrator infers this automatically.

### Configuration Files (`tsconfig.json`, `package.json`, `.env.*`)

Configuration files must be treated like shared type files:
- Declare as **Read-Only Reference** in all tasks
- If a task needs to modify config, it must be the **only task in the cycle** that does so
- If multiple tasks need config changes, merge them into a single dedicated config task that runs first (sequential, before parallel tasks begin)

---

## Summary Checklist

Before Engineering phase begins, verify:

- [ ] Every `task-eng-XX.md` has a `## File Ownership` section
- [ ] `ownership-registry.json` has been generated by the Director
- [ ] `registry["conflicts"]` is empty (or all conflicts are resolved)
- [ ] Tasks with `execution_mode: "sequential"` have correct `depends_on` entries
- [ ] No shared type files appear in any task's `exclusive` list
- [ ] Configuration file changes are isolated to a dedicated task (if needed)

Only after all items above are checked may the orchestrator begin spawning Engineering agents.
