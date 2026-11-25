# Task State Contract

`task.json` is written only by `.trellis/scripts/task.py`. The main session owns
state-changing commands; implement/check sub-agents write reports, not metadata.

## Labels

| Field | Values | Meaning |
| --- | --- | --- |
| `task_type` | `simple` / `complex` / `research` | process commitment |
| `work_type` | `backend` / `frontend` / `fullstack` / `research` / `docs` | surface |

Both are required at `create`. `complex` requires `design.md` + `implement.md`
before `start`. A `simple` task may still have design/implement artifacts without
being upgraded. Never infer the labels from artifact presence.

## Lifecycle

Only `start` (planning → in_progress) and `archive` (→ completed) change status.
`finish` only clears the active-task pointer. Do not commit every task.json edit.

`start` for a complex task creates a task-only bookkeeping commit by default
(`task.json` + `.state-events.jsonl`). Simple/research tasks record the event log
only. Use `--commit-state` / `--no-commit-state` explicitly when needed.

## Evidence commands

```bash
task.py create ... --task-type ... --work-type ...
task.py set-task-type <task> <type> [--force --reason]
task.py set-work-type <task> <type> [--check-report-required]
task.py set-commit <task> <hash|HEAD> [--allow-missing-object] [--persist]
task.py set-pr <task> <url>
task.py set-evidence <task> --type e2e|visual|manual --artifact <path-or-url>
task.py set-check-override <task> --by <who> --reason <why> [--commit <hash>]
task.py verify <task> [--strict]
task.py doctor <task> [--fix]
task.py archive <task> [--planning-only] [--no-commit]
```

`set-meta` refuses top-level fields (`status`, `commit`, `pr_url`, `task_type`,
`work_type`, `branch`, `base_branch`, ...). Use the dedicated command.

## Evidence matrix

- `simple`: at least one of commit, checked acceptance item, implementation
  report, check report, or frontend evidence. Reports are optional.
- `complex`: `commit` plus one of check report, checked acceptance item, or a
  `meta.check_override` bound to the current commit.
- `frontend`/`fullstack` complex: also needs check report, frontend evidence
  (`e2e`/`visual`/`manual`), or an override.
- `research`: no commit; archive with `--planning-only`.
- `work_type=frontend` with `meta.frontend_check_report_required=true` always
  needs a check report.

## Event log

`.state-events.jsonl` lives in the task directory, schemaVersion 1, append-only.
It records `status_transition`, `state_commit_failed`, `commit_set`,
`evidence_set`, `check_override`, `doctor_repair`, and archive events. It moves
with the task. It is intent, not authority: `task.json` remains the source of
truth, but `verify` uses the last event to detect a status flip that never
reached disk/commit.

## Forbidden

- Hand-editing `task.json` or `.state-events.jsonl`.
- `task.py start` / `set-commit` / `archive` from implement/check sub-agents.
- Archiving past a failing `verify --strict`.
- Using `--planning-only` for a simple/complex task; use `meta.abandoned`.
