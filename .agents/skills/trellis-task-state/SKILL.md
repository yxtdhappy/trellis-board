---
name: trellis-task-state
description: "Maintains task.json through task.py at lifecycle boundaries: create labels, start persistence, commit/PR evidence, verification, and safe repair. Use whenever a task changes status, records a commit, or finishes; never hand-edit task.json."
---

# Task State

`task.py` is the only writer for `task.json`. The main session owns state-changing commands; implement/check sub-agents only write their reports.

## Labels at creation

```bash
python ./.trellis/scripts/task.py create "<title>" --description "<what>" \
  --task-type simple|complex|research \
  --work-type backend|frontend|fullstack|research|docs
```

- Propose both labels with a one-line reason; ask the user to confirm once. Never silently guess.
- `task_type` is a process commitment: `complex` requires `design.md` + `implement.md`.
- `work_type` is the surface: `frontend`, `backend`, `fullstack`, `research`, `docs`.
- Shared UI/design-system work is still `frontend`; force a check-report with `set-work-type ... --check-report-required`.

## Start

```bash
python ./.trellis/scripts/task.py start <task-dir>
```

- Complex tasks create a task-only bookkeeping commit by default; simple/research record the event log only.
- `--commit-state` forces the commit, `--no-commit-state` explicitly degrades, `--push` pushes it.
- Exit 3 means the status was written but the bookkeeping commit failed: stop, fix git, then `doctor --fix` or re-run start.

## Evidence

```bash
python ./.trellis/scripts/task.py set-commit <task-dir> <hash|HEAD> [--persist]
python ./.trellis/scripts/task.py set-pr <task-dir> <url>
python ./.trellis/scripts/task.py set-evidence <task-dir> --type e2e|visual|manual --artifact <path-or-url> [--commit <hash>]
python ./.trellis/scripts/task.py set-check-override <task-dir> --by <who> --reason <why> [--commit <hash>]
```

- `set-commit` writes the top-level `commit` read by the board and appends to `meta.commits`.
- Do this after the final work commit, before finish-work.
- `set-meta` refuses reserved top-level keys; use the dedicated commands.

## Verify and repair

```bash
python ./.trellis/scripts/task.py verify <task-dir> [--strict]
python ./.trellis/scripts/task.py doctor <task-dir> --fix
```

- `verify` is read-only. Exit 1 = errors, 2 = warnings.
- `doctor --fix` only repairs unambiguous cases: event log says in_progress while task.json says planning; `meta.commit` migrated to top-level.
- Do not archive past a failing `verify --strict`.

## Boundaries

- Do not hand-edit `task.json` fields: use `set-task-type`, `set-work-type`, `set-commit`, `set-pr`, `set-branch`, `set-base-branch`.
- Do not commit every status edit; only start/archive are state transitions.
- Implement/check sub-agents must not run `task.py start`, `set-commit`, or `archive`; the main session does.
