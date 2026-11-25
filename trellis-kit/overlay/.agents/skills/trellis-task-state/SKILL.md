---
name: trellis-task-state
description: "Maintains task.json through task.py at lifecycle boundaries: create labels, start persistence, commit/PR evidence, verification, and safe repair. Use whenever a task changes status, records a commit, or finishes; never hand-edit task.json."
---

# Task State

`task.py` is the only writer for `task.json`. The main session owns state-changing commands; implement/check sub-agents only write their reports.

## Labels at creation

```bash
python ./.trellis/scripts/task.py create "<title>" --description "<what>" \
  --work-type backend|frontend|fullstack|research|docs
```

- `work_type` is the only label required at create; do not ask the user to choose complexity up front.
- After planning exposes the scope, decide `task_type` and persist it with `task.py set-task-type <task> <type>`; if genuinely ambiguous, ask one question with your recommendation. Never silently guess.
- `task_type` is a process commitment: `complex` requires `design.md` + `implement.md`.
- `work_type` is the surface: `frontend`, `backend`, `fullstack`, `research`, `docs`.
- Shared UI/design-system work is still `frontend`; force a check-report with `set-work-type ... --check-report-required`.

## Start

```bash
python ./.trellis/scripts/task.py start <task-dir>
```

- Complex tasks create a task-only bookkeeping commit by default; simple/research record the event log only.
- `--commit-state` forces the commit; `--push` pushes it.
- Complex tasks cannot use bare `--no-commit-state`. If git makes a commit impossible, use `--no-commit-state --force-degraded --reason "<why>"`; that writes `state_persist_degraded`, and `verify --strict` / archive refuse it.
- Exit 3 means the status was written but the bookkeeping commit failed: stop, fix git, then `doctor --fix` or re-run start.

## Evidence

```bash
python ./.trellis/scripts/task.py stamp-check <task-dir> --scope <path[,path]> [--base <hash>]
python ./.trellis/scripts/task.py set-commit <task-dir> <hash|HEAD> [--persist]
python ./.trellis/scripts/task.py set-pr <task-dir> <url>
python ./.trellis/scripts/task.py set-evidence <task-dir> --type e2e|visual|manual --artifact <path-or-url> [--commit <hash>]
python ./.trellis/scripts/task.py set-check-override <task-dir> --by <who> --reason <why> [--commit <hash>]
```

- Run `stamp-check` after the check agent reports and before the work commit. It records `base` + `scope` + `diff` (the exact worktree slice checked).
- `set-commit` writes the top-level `commit`, appends to `meta.commits`, and binds the stamped report in `meta.check_binding`; it refuses if the commit tree differs from the checked slice.
- Do this after the final work commit, before finish-work.
- `set-meta` refuses reserved top-level keys; use the dedicated commands.

## Evidence source

- Complex tasks need both `implementation-report.md` and `check-report.md` (or `meta.check_override` for check evidence).
- `check-report.md` must start with front matter: `mode: independent|inline-self-check`, `agent`, `session`; `stamp-check` adds `base`/`scope`/`diff`.
- `mode: independent` cannot name `main-session` as the agent.
- `mode: inline-self-check` is accepted only with `meta.check_override` (owner confirmation), because the main session is checking its own work.

## Verify and repair

```bash
python ./.trellis/scripts/task.py verify <task-dir> [--strict]
python ./.trellis/scripts/task.py verify <task-dir> --strict \
  --authorize-no-evidence --by <owner> --reason "why the missing check artifact is acceptable"
python ./.trellis/scripts/task.py doctor <task-dir> --fix
```

- `verify` is read-only by default. Exit 1 = errors, 2 = warnings, 4 = complex task needs an owner decision because check evidence is missing.
- `--authorize-no-evidence` records `meta.check_override` (bound to the current commit) and then re-runs the check. It does not bypass missing implementation reports, unbound check reports, or state regressions.
- `doctor --fix` only repairs unambiguous cases: event log says in_progress while task.json says planning; `meta.commit` migrated to top-level.
- Do not archive past a failing `verify --strict`.

## Boundaries

- Do not hand-edit `task.json` fields: use `set-task-type`, `set-work-type`, `set-commit`, `set-pr`, `set-branch`, `set-base-branch`.
- Do not commit every status edit; only start/archive are state transitions.
- Implement/check sub-agents must not run `task.py start`, `set-commit`, or `archive`; the main session does.