#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Task Management Script.

Usage:
    python task.py create "<title>" --description "<desc>" --work-type backend|frontend|fullstack|research|docs [--task-type simple|complex|research] [--slug <name>] [--assignee <dev>] [--priority P0|P1|P2|P3] [--parent <dir>] [--package <pkg>] [--no-start] [--force]
    python task.py add-context <dir> <file> <path> [reason] # Add jsonl entry
    python task.py validate <dir>              # Validate jsonl files
    python task.py list-context <dir>          # List jsonl entries
    python task.py start <dir> [--commit-state|--no-commit-state [--force-degraded --reason <why>]] [--push] [--force]
                                                # Set active task, record current branch/status
    python task.py current [--source] [--json] # Show active task
    python task.py finish                      # Clear active task
    python task.py set-branch <dir> <branch>   # Set git branch
    python task.py set-base-branch <dir> <branch>  # Set PR target branch
    python task.py set-scope <dir> <scope>     # Set scope for PR title
    python task.py set-meta <dir> <key> <value>  # Set a task metadata key
    python task.py set-task-type <dir> simple|complex|research
    python task.py set-work-type <dir> backend|frontend|fullstack|research|docs [--check-report-required]
    python task.py set-commit <dir> <hash|HEAD> [--allow-missing-object] [--persist]
    python task.py set-pr <dir> <url>
    python task.py set-evidence <dir> --type e2e|visual|manual --artifact <path-or-url> [--commit <hash>]
    python task.py set-check-override <dir> --by <who> --reason <why> [--commit <hash>]
    python task.py verify <dir> [--strict] [--json]  # Check evidence without writing
    python task.py doctor <dir> [--fix] [--json]     # Repair safe state inconsistencies
    python task.py archive <dir> [--planning-only] [--no-commit]
    python task.py rename <dir> <new-slug> [--dry-run]  # Rename task + references
    python task.py archive <task-dir> [--skip-branch-validation]  # Archive completed task
    python task.py list                        # List active tasks
    python task.py list-archive [month]        # List archived tasks
    python task.py add-subtask <parent-dir> <child-dir>     # Link child to parent
    python task.py remove-subtask <parent-dir> <child-dir>  # Unlink child from parent
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from common.log import Colors, colored
from common.paths import (
    DEVELOPER_HINT,
    DIR_WORKFLOW,
    DIR_TASKS,
    FILE_TASK_JSON,
    get_repo_root,
    get_developer,
    get_tasks_dir,
    get_current_task,
)
from common.active_task import (
    clear_active_task,
    resolve_active_task,
    resolve_context_key,
    set_active_task,
)
from common.git import current_branch_name, run_git
from common.io import (
    describe_json_read_failure,
    read_json_checked,
    write_json,
)
from common.safe_commit import safe_git_add
from common.task_utils import resolve_task_dir, run_task_hooks
from common.tasks import iter_active_tasks, children_progress
from common.state_events import append_state_event, read_state_events

# Import command handlers from split modules (also re-exports for plan.py compatibility)
from common.task_store import (
    TASK_TYPE_IDS,
    WORK_TYPE_IDS,
    has_unresolved_degradation,
    cmd_create,
    cmd_rename,
    cmd_archive,
    cmd_set_branch,
    cmd_set_base_branch,
    cmd_set_scope,
    cmd_set_meta,
    cmd_set_task_type,
    cmd_set_work_type,
    cmd_set_commit,
    cmd_set_pr,
    cmd_set_evidence,
    cmd_set_check_override,
    cmd_verify,
    cmd_doctor,
    cmd_add_subtask,
    cmd_remove_subtask,
)
from common.task_context import (
    cmd_add_context,
    cmd_validate,
    cmd_list_context,
    curated_entry_count,
)


# =============================================================================
# Command: start / finish
# =============================================================================

def _record_start_state(
    task_json_path: Path,
    repo_root: Path,
    label: str = "",
) -> None:
    """Move a freshly started task to in_progress and record its branch.

    Both updates share one read/write: the status flip from planning, and the
    checked-out branch when `branch` is still empty. Recording at start is what
    keeps `branch` trustworthy at archive time — a task whose branch is only
    ever set by hand tends to reach archive with `branch: null`.

    Tolerant on purpose — a broken task.json does not fail `start`, because the
    session pointer is the point of the command. But the read overwrites the
    file it just read, so no failure may be silent: without a message the
    absent status line looks like the task simply was not in planning.
    """
    data, reason = read_json_checked(task_json_path)
    if data is None:
        problem, hint = describe_json_read_failure(task_json_path, reason)
        print(
            colored(f"Warning: {problem}; task.json not updated.", Colors.YELLOW),
            file=sys.stderr,
        )
        print(hint, file=sys.stderr)
        return

    applied: list[str] = []
    old_status = data.get("status")

    if old_status == "planning":
        data["status"] = "in_progress"
        applied.append(f"✓ Status: planning → in_progress{label}")

    # Only fill an empty field: an explicit `set-branch` must survive a later
    # `start` (re-starting a task after a checkout is a normal thing to do).
    base_branch_conflict: str | None = None
    if not data.get("branch"):
        branch = current_branch_name(repo_root)
        if branch:
            data["branch"] = branch
            applied.append(f"✓ Branch recorded: {branch}{label}")
            if branch == data.get("base_branch"):
                base_branch_conflict = branch
        else:
            print(
                colored(
                    "Note: no checked-out branch (detached HEAD, or not a git "
                    "repository); task branch not recorded.",
                    Colors.YELLOW,
                ),
                file=sys.stderr,
            )

    if not applied:
        return

    if not write_json(task_json_path, data):
        print(
            colored(
                f"Warning: Failed to write {task_json_path}; "
                "status and branch are unchanged.",
                Colors.YELLOW,
            ),
            file=sys.stderr,
        )
        return

    for line in applied:
        print(colored(line, Colors.GREEN))

    if old_status != data.get("status"):
        append_state_event(
            task_json_path.parent,
            "status_transition",
            from_status=old_status,
            to_status=data.get("status"),
            actor=data.get("assignee"),
            reason="task.py start",
        )

    if base_branch_conflict:
        # Recorded anyway — the value is true, it just cannot describe a PR.
        # Archive refuses this shape, so say so now rather than at the gate.
        print(
            colored(
                f"Warning: '{base_branch_conflict}' is also this task's base_branch; "
                "a PR cannot target its own branch, and archive will refuse it.",
                Colors.YELLOW,
            ),
            file=sys.stderr,
        )
        print(
            f"Once you branch off, run: python {DIR_WORKFLOW}/scripts/task.py "
            "set-branch <task> <feature-branch>",
            file=sys.stderr,
        )


def _record_start_degraded(task_json_path: Path, reason: str) -> None:
    """Record an explicit, auditable start-state degradation."""
    append_state_event(
        task_json_path.parent,
        "state_persist_degraded",
        from_status="in_progress",
        to_status="in_progress",
        reason=reason,
    )


def _record_start_committed(task_json_path: Path) -> None:
    """Record that start state is being persisted in a bookkeeping commit."""
    append_state_event(
        task_json_path.parent,
        "state_committed",
        from_status="in_progress",
        to_status="in_progress",
        reason="task.py start --commit-state",
    )


def _persist_start_state(
    task_json_path: Path,
    repo_root: Path,
    *,
    label: str = "",
    force_degraded: bool,
    degraded_reason: str,
    commit_state: bool,
    push: bool,
) -> int:
    """Update task.json/state log on start and optionally make the bookkeeping commit."""
    if not task_json_path.is_file():
        return 0
    _record_start_state(task_json_path, repo_root, label)
    if force_degraded:
        _record_start_degraded(task_json_path, degraded_reason)
    if commit_state:
        events = read_state_events(task_json_path.parent)
        has_committed = any(event.get("event") == "state_committed" for event in events)
        last_failed = bool(events and events[-1].get("event") == "state_commit_failed")
        if not has_committed or has_unresolved_degradation(events) or last_failed:
            _record_start_committed(task_json_path)
        ok, reason = _commit_start_state(task_json_path, repo_root, push)
        if not ok:
            print(colored(f"Error: {reason}", Colors.RED), file=sys.stderr)
            print(
                "task.json keeps in_progress; fix git and re-run "
                "`task.py start <task> --commit-state`.",
                file=sys.stderr,
            )
            return 3
    run_task_hooks("after_start", task_json_path, repo_root)
    return 0


def _git_path(repo_root: Path, name: str) -> Path | None:
    """Resolve a git metadata path (worktree-safe)."""
    rc, out, _ = run_git(["rev-parse", "--git-path", name], cwd=repo_root)
    if rc != 0 or not out.strip():
        return None
    path = Path(out.strip())
    return path if path.is_absolute() else repo_root / path


def _start_preflight(repo_root: Path, task_json_path: Path) -> tuple[bool, str]:
    """Refuse a bookkeeping commit when git cannot safely make one."""
    rc, out, _ = run_git(["rev-parse", "--is-inside-work-tree"], cwd=repo_root)
    if rc != 0 or out.strip() != "true":
        return False, "not inside a git work tree"

    for marker, label in (
        ("rebase-merge", "rebase in progress"),
        ("rebase-apply", "rebase in progress"),
        ("MERGE_HEAD", "merge in progress"),
        ("CHERRY_PICK_HEAD", "cherry-pick in progress"),
    ):
        marker_path = _git_path(repo_root, marker)
        if marker_path is not None and marker_path.exists():
            return False, label

    try:
        rel = task_json_path.relative_to(repo_root).as_posix()
    except ValueError:
        return False, "task path is outside the repository"
    rc, _, _ = run_git(["check-ignore", "-q", rel], cwd=repo_root)
    if rc == 0:
        return False, f"task path is git-ignored: {rel}"
    if rc not in (0, 1):
        return False, "could not check whether the task path is git-ignored"

    rc, _, err = run_git(["var", "GIT_AUTHOR_IDENT"], cwd=repo_root)
    if rc != 0:
        return False, f"git identity is not configured: {err.strip() or 'GIT_AUTHOR_IDENT failed'}"
    return True, ""


def _start_commit_mode(args: argparse.Namespace, data: dict) -> bool:
    if getattr(args, "no_commit_state", False):
        return False
    if getattr(args, "commit_state", False):
        return True
    return data.get("task_type") == "complex"


def _commit_start_state(
    task_json_path: Path,
    repo_root: Path,
    push: bool,
) -> tuple[bool, str]:
    """Commit only task.json + the state-event log, then optionally push."""
    rel = task_json_path.relative_to(repo_root).as_posix()
    paths = [rel]
    events_path = task_json_path.parent / ".state-events.jsonl"
    if events_path.is_file():
        paths.append(events_path.relative_to(repo_root).as_posix())

    ok, _, add_err = safe_git_add(paths, repo_root)
    if not ok:
        append_state_event(
            task_json_path.parent,
            "state_commit_failed",
            from_status="in_progress",
            to_status="in_progress",
            reason=f"git add failed: {add_err.strip()}",
        )
        return False, f"could not stage {', '.join(paths)}: {add_err.strip()}"

    rc, _, commit_err = run_git(
        [
            "commit",
            "--no-verify",
            "-m",
            f"chore(task): start {task_json_path.parent.name}",
            "--",
            *paths,
        ],
        cwd=repo_root,
    )
    if rc != 0:
        lowered = commit_err.lower()
        if "nothing to commit" in lowered or "no changes added" in lowered:
            pass
        else:
            append_state_event(
                task_json_path.parent,
                "state_commit_failed",
                from_status="in_progress",
                to_status="in_progress",
                reason=f"git commit failed: {commit_err.strip()}",
            )
            return False, f"bookkeeping commit failed: {commit_err.strip()}"

    if push:
        rc, _, push_err = run_git(["push"], cwd=repo_root)
        if rc != 0:
            return False, f"git push failed: {push_err.strip()}"
    return True, ""


def cmd_start(args: argparse.Namespace) -> int:
    """Set active task."""
    repo_root = get_repo_root()
    task_input = args.dir

    if not task_input:
        print(colored("Error: task directory or name required", Colors.RED))
        return 1

    # Resolve task directory (supports task name, relative path, or absolute path)
    full_path = resolve_task_dir(task_input, repo_root)

    if full_path is None:
        # resolve_task_dir already named the exact reason on stderr. A second,
        # generic line on stdout would split one diagnosis across two streams
        # and bury the specific message.
        return 1

    if not full_path.is_dir():
        print(colored(f"Error: Task not found: {task_input}", Colors.RED))
        print("Hint: Use task name (e.g., 'my-task') or full path (e.g., '.trellis/tasks/01-31-my-task')")
        return 1

    # Explicit complex tasks must have both planning artifacts before start.
    # Legacy tasks with no task_type stay on the old inferred behavior.
    task_json_for_gate = full_path / FILE_TASK_JSON
    start_data: dict = {}
    if task_json_for_gate.is_file():
        loaded_start_data, _ = read_json_checked(task_json_for_gate)
        if isinstance(loaded_start_data, dict):
            start_data = loaded_start_data
        if start_data.get("task_type") == "complex":
            missing = [
                name for name in ("design.md", "implement.md")
                if not (full_path / name).is_file()
            ]
            if missing:
                print(
                    colored(
                        f"Error: complex task is missing {', '.join(missing)}.",
                        Colors.RED,
                    )
                )
                print("Add the missing planning artifact(s) before task.py start.")
                return 1
        if not start_data.get("task_type"):
            print(
                colored(
                    "Warning: task complexity is not set; classify it with "
                    "`task.py set-task-type <task> simple|complex|research`.",
                    Colors.YELLOW,
                )
            )

    no_commit_state = getattr(args, "no_commit_state", False)
    force_degraded = getattr(args, "force_degraded", False)
    degraded_reason = (getattr(args, "reason", None) or "").strip()
    if force_degraded and not no_commit_state:
        print(
            colored(
                "Error: --force-degraded only applies to --no-commit-state.",
                Colors.RED,
            )
        )
        return 1
    if force_degraded and not degraded_reason:
        print(
            colored(
                "Error: --force-degraded requires --reason \"<why>\".",
                Colors.RED,
            )
        )
        return 1
    if (
        no_commit_state
        and start_data.get("task_type") == "complex"
        and not force_degraded
    ):
        print(
            colored(
                "Error: complex task start must persist its in_progress state.",
                Colors.RED,
            )
        )
        print(
            "Git is unavailable or unsafe? Re-run with --no-commit-state "
            "--force-degraded --reason \"<why>\"; verify/archive will refuse "
            "the task until the degradation is resolved.",
            file=sys.stderr,
        )
        return 1

    commit_state = _start_commit_mode(args, start_data)
    if getattr(args, "push", False) and not commit_state:
        print(
            colored(
                "Error: --push requires a bookkeeping commit; use --commit-state "
                "or omit --no-commit-state for a complex task.",
                Colors.RED,
            )
        )
        return 1
    if commit_state:
        ok, reason = _start_preflight(repo_root, task_json_for_gate)
        if not ok:
            print(colored(f"Error: cannot persist start state: {reason}", Colors.RED))
            print(
                "The task was not started. Fix the git state and retry, or pass "
                "--no-commit-state to record only the event log.",
                file=sys.stderr,
            )
            return 1

    # Context-manifest gate (#573): a seeded-but-uncurated implement/check
    # manifest means every sub-agent dispatched for this task runs with zero
    # spec context, and nothing downstream surfaces that to the main session.
    # An absent manifest is not gated — create seeds the files only on
    # sub-agent-capable platforms, so absence means no sub-agent reads them.
    if not getattr(args, "allow_empty_context", False):
        empty_manifests = [
            name
            for name in ("implement.jsonl", "check.jsonl")
            if curated_entry_count(full_path / name) == 0
        ]
        if empty_manifests:
            print(colored(
                f"Error: {' and '.join(empty_manifests)} "
                f"{'has' if len(empty_manifests) == 1 else 'have'} no curated entries",
                Colors.RED,
            ))
            print("Sub-agents (implement/check) would run with zero spec context.")
            print(f"  Curate:  python .trellis/scripts/task.py add-context {task_input} implement <path> \"<why>\"")
            print(f"  Verify:  python .trellis/scripts/task.py validate {task_input}")
            print("  Intentionally empty? Re-run start with --allow-empty-context")
            return 1

    # Convert to relative path for storage. repo_root is resolved because
    # full_path already is (resolve_task_dir only returns paths inside the
    # resolved root), so an unresolved repo_root would mismatch under a
    # symlink (e.g. /tmp on macOS) and reject a perfectly normal task.
    try:
        task_dir = full_path.relative_to(repo_root.resolve()).as_posix()
    except ValueError:
        # resolve_task_dir already refused everything outside the repo, so
        # this is unreachable in practice. Refuse rather than fall back to
        # str(full_path) — that fallback (a lexical relative_to() paired with
        # an absolute-path fallback) is exactly the pattern that let a `..`
        # ref escape into storage before this fix.
        print(colored(f"Error: Task not found: {task_input}", Colors.RED))
        print("Hint: Use task name (e.g., 'my-task') or full path (e.g., '.trellis/tasks/01-31-my-task')")
        return 1

    task_json_path = full_path / FILE_TASK_JSON

    if not resolve_context_key():
        # Degraded mode: no session identity available.
        # Hook didn't inject TRELLIS_CONTEXT_ID (common on Windows + Claude Code,
        # --continue resume path, fork distribution, hooks disabled, etc.). Skip
        # per-session pointer write; AI continues based on conversation context.
        print(colored(
            "ℹ Session identity not available; active-task pointer not persisted "
            "this session (degraded mode). AI continues based on conversation context.",
            Colors.YELLOW,
        ))
        print(colored(
            "Hint: run inside an AI IDE/session that exposes session identity, "
            "or set TRELLIS_CONTEXT_ID before running task.py start.",
            Colors.YELLOW,
        ))

        # Still flip task.json status: planning → in_progress so downstream phases proceed.
        return _persist_start_state(
            task_json_path,
            repo_root,
            label=" (degraded)",
            force_degraded=force_degraded,
            degraded_reason=degraded_reason,
            commit_state=commit_state,
            push=getattr(args, "push", False),
        )

    active = set_active_task(task_dir, repo_root)
    if active:
        print(colored(f"✓ Current task set to: {task_dir}", Colors.GREEN))
        print(f"Source: {active.source}")

        rc = _persist_start_state(
            task_json_path,
            repo_root,
            force_degraded=force_degraded,
            degraded_reason=degraded_reason,
            commit_state=commit_state,
            push=getattr(args, "push", False),
        )
        if rc != 0:
            return rc

        print()
        print(colored("The hook will now inject context from this task's jsonl files.", Colors.BLUE))
        return 0
    else:
        print(colored("Error: Failed to set current task", Colors.RED))
        return 1


def cmd_finish(args: argparse.Namespace) -> int:
    """Clear active task."""
    repo_root = get_repo_root()
    active = clear_active_task(repo_root)
    current = active.task_path

    if not current:
        print(colored("No current task set", Colors.YELLOW))
        return 0

    # Resolve task.json path before clearing
    task_json_path = repo_root / current / FILE_TASK_JSON

    print(colored(f"✓ Cleared current task (was: {current})", Colors.GREEN))
    print(f"Source: {active.source}")

    if task_json_path.is_file():
        run_task_hooks("after_finish", task_json_path, repo_root)
    return 0


def cmd_current(args: argparse.Namespace) -> int:
    """Show active task."""
    repo_root = get_repo_root()
    active = resolve_active_task(repo_root)

    if getattr(args, "json", False):
        task_obj = None
        read_error = None
        if active.task_path:
            task_json_path = repo_root / active.task_path / FILE_TASK_JSON
            data, reason = read_json_checked(task_json_path)
            if data is None:
                # Without this, a corrupt task.json emits null for every field
                # — indistinguishable from a task whose fields really are null.
                problem, hint = describe_json_read_failure(task_json_path, reason)
                read_error = {
                    "file": str(task_json_path),
                    "reason": reason,
                    "message": f"{problem}. {hint}",
                }
                data = {}
            task_obj = {
                "dir": active.task_path,
                "id": data.get("id") or data.get("name"),
                "title": data.get("title"),
                "status": data.get("status"),
                "parent": data.get("parent"),
                "children": data.get("children", []),
                "branch": data.get("branch"),
                "base_branch": data.get("base_branch"),
            }
        payload = {
            "current_task": task_obj,
            "source": active.source,
            "stale": active.stale,
        }
        # Only present when the read failed, so the healthy shape is unchanged.
        if read_error:
            payload["error"] = read_error
        print(json.dumps(payload, ensure_ascii=False))
        return 0 if active.task_path else 1

    if args.source:
        print(f"Current task: {active.task_path or '(none)'}")
        print(f"Source: {active.source}")
        if active.stale:
            print("State: stale")
        return 0 if active.task_path else 1

    if active.task_path:
        print(active.task_path)
        return 0

    return 1


# =============================================================================
# Command: list
# =============================================================================

def _display_status(t, all_statuses: dict) -> str:
    """Return the status label to show for a task in `list` output.

    A parent task's stored status stays "planning" until someone runs
    `task.py start` on the parent directly, even while its children are
    actively being worked — a misleading label for anyone scanning the
    list (#399 item 3). Show "active" instead when at least one child is
    past planning; the stored status.json value is left untouched.
    """
    if t.status == "planning" and t.children:
        child_in_flight = any(
            all_statuses.get(c) not in (None, "planning") for c in t.children
        )
        if child_in_flight:
            return "active"
    return t.status


def cmd_list(args: argparse.Namespace) -> int:
    """List active tasks."""
    repo_root = get_repo_root()
    tasks_dir = get_tasks_dir(repo_root)
    current_task = get_current_task(repo_root)
    developer = get_developer(repo_root)
    filter_mine = args.mine
    filter_status = args.status
    as_json = getattr(args, "json", False)

    # Single pass: collect all tasks via shared iterator
    all_tasks = {t.dir_name: t for t in iter_active_tasks(tasks_dir)}
    all_statuses = {name: t.status for name, t in all_tasks.items()}

    if as_json:
        if filter_mine and not developer:
            print(
                json.dumps({"error": "No developer set", "hint": DEVELOPER_HINT}),
                file=sys.stderr,
            )
            return 1

        items = []
        for dir_name in sorted(all_tasks.keys()):
            t = all_tasks[dir_name]
            if filter_mine and (t.assignee or "-") != developer:
                continue
            if filter_status and t.status != filter_status:
                continue
            items.append({
                "dir": f"{DIR_WORKFLOW}/{DIR_TASKS}/{dir_name}",
                "id": t.raw.get("id") or dir_name,
                "title": t.title,
                "status": t.status,
                "display_status": _display_status(t, all_statuses),
                "priority": t.priority,
                "assignee": t.assignee or None,
                "parent": t.parent,
                "children": list(t.children),
                "package": t.package,
            })
        print(json.dumps({"tasks": items}, ensure_ascii=False))
        return 0

    if filter_mine:
        if not developer:
            print(colored("Error: No developer set. Run init_developer.py first", Colors.RED), file=sys.stderr)
            print(DEVELOPER_HINT, file=sys.stderr)
            return 1
        print(colored(f"My tasks (assignee: {developer}):", Colors.BLUE))
    else:
        print(colored("All active tasks:", Colors.BLUE))
    print()

    # Display tasks hierarchically
    count = 0

    def _print_task(dir_name: str, indent: int = 0) -> None:
        nonlocal count
        t = all_tasks[dir_name]

        # Apply --mine filter
        if filter_mine and (t.assignee or "-") != developer:
            return

        # Apply --status filter
        if filter_status and t.status != filter_status:
            return

        relative_path = f"{DIR_WORKFLOW}/{DIR_TASKS}/{dir_name}"
        marker = ""
        if relative_path == current_task:
            marker = f" {colored('<- current', Colors.GREEN)}"

        # Children progress
        progress = children_progress(t.children, all_statuses)
        status_label = _display_status(t, all_statuses)

        # Package tag
        pkg_tag = f" @{t.package}" if t.package else ""

        prefix = "  " * indent + "  - "

        if filter_mine:
            print(f"{prefix}{dir_name}/ ({status_label}){pkg_tag}{progress}{marker}")
        else:
            print(f"{prefix}{dir_name}/ ({status_label}){pkg_tag}{progress} [{colored(t.assignee or '-', Colors.CYAN)}]{marker}")
        count += 1

        # Print children indented
        for child_name in t.children:
            if child_name in all_tasks:
                _print_task(child_name, indent + 1)

    # Display only top-level tasks: those without a parent, plus orphans
    # whose recorded parent is not (or no longer) in the active set — a
    # dangling parent ref must still render flat instead of disappearing.
    for dir_name in sorted(all_tasks.keys()):
        parent = all_tasks[dir_name].parent
        if not parent or parent not in all_tasks:
            _print_task(dir_name)

    if count == 0:
        if filter_mine:
            print("  (no tasks assigned to you)")
        else:
            print("  (no active tasks)")

    print()
    print(f"Total: {count} task(s)")
    return 0


# =============================================================================
# Command: list-archive
# =============================================================================

def cmd_list_archive(args: argparse.Namespace) -> int:
    """List archived tasks."""
    repo_root = get_repo_root()
    tasks_dir = get_tasks_dir(repo_root)
    archive_dir = tasks_dir / "archive"
    month = args.month

    print(colored("Archived tasks:", Colors.BLUE))
    print()

    if month:
        month_dir = archive_dir / month
        if month_dir.is_dir():
            print(f"[{month}]")
            for d in sorted(month_dir.iterdir()):
                if d.is_dir():
                    print(f"  - {d.name}/")
        else:
            print(f"  No archives for {month}")
    else:
        if archive_dir.is_dir():
            for month_dir in sorted(archive_dir.iterdir()):
                if month_dir.is_dir():
                    month_name = month_dir.name
                    count = sum(1 for d in month_dir.iterdir() if d.is_dir())
                    print(f"[{month_name}] - {count} task(s)")

    return 0


# =============================================================================
# Help
# =============================================================================

def show_usage() -> None:
    """Show usage help."""
    print("""Task Management Script

Usage:
  python task.py create <title> --description <desc>  Create new task directory (both required, non-empty)
  python task.py create <title> --description <desc> --package <pkg>   Create task for a specific package
  python task.py create <title> --description <desc> --parent <dir>    Create task as child of parent
  python task.py create <title> --description <desc> --no-start        Create without making it active in this session
  python task.py add-context <dir> <jsonl> <path> [reason]  Add entry to jsonl
  python task.py validate <dir>                     Validate jsonl files
  python task.py list-context <dir>                 List jsonl entries
  python task.py start <dir>                        Set active task; records the checked-out branch when unset
  python task.py current [--source]                 Show active task
  python task.py finish                             Clear active task
  python task.py set-branch <dir> <branch>          Set git branch
  python task.py set-base-branch <dir> <branch>     Set PR target branch
  python task.py set-scope <dir> <scope>            Set scope for PR title
  python task.py set-meta <dir> <key> <value>       Set/overwrite a task metadata key
  python task.py rename <dir> <new-slug>            Rename task, identity fields and references
  python task.py archive <task-dir>                 Archive completed task
  python task.py add-subtask <parent> <child>       Link child task to parent
  python task.py remove-subtask <parent> <child>    Unlink child from parent
  python task.py list [--mine] [--status <status>] [--json]  List tasks
  python task.py list-archive [YYYY-MM]             List archived tasks

Monorepo options:
  --package <pkg>      Package name (validated against config.yaml packages)

Rename options:
  --dry-run            Print the change set without writing anything

Archive options:
  --no-commit                Skip the auto git commit after archiving
  --skip-branch-validation   Archive despite missing or self-referential branch metadata.
                             Archive normally refuses a task with no `branch` when it has a
                             `base_branch` and the repo has a remote, or with
                             `branch == base_branch`; repair those with `set-branch` /
                             `set-base-branch` instead. Use this flag only for tasks that
                             were never PR-backed. A recorded branch that was merged and
                             deleted is only a warning and needs no flag.

List options:
  --mine, -m           Show only tasks assigned to current developer
  --status, -s <s>     Filter by status (planning, in_progress, review, completed)
  --json               Output machine-readable JSON (also available on `current`)

Examples:
  python task.py create "Add login feature" --description "Email + password sign-in" --slug add-login
  python task.py create "Add login feature" --description "Email + password sign-in" --slug add-login --package cli
  python task.py create "Add login feature" --description "Email + password sign-in" --meta linear=ENG-123 --meta epic=auth
  python task.py create "Child task" --description "Session cookie handling" --slug child --parent .trellis/tasks/01-21-parent
  python task.py add-context <dir> implement .trellis/spec/cli/backend/auth.md "Auth guidelines"
  python task.py set-branch <dir> task/add-login
  python task.py start .trellis/tasks/01-21-add-login
  python task.py current --source
  python task.py finish
  python task.py rename add-login add-sso --dry-run  # Preview the change set
  python task.py rename add-login add-sso
  python task.py archive add-login
  python task.py archive add-login --skip-branch-validation  # Task never had a branch of its own
  python task.py add-subtask parent-task child-task  # Link existing tasks
  python task.py remove-subtask parent-task child-task
  python task.py list                               # List all active tasks
  python task.py list --mine                        # List my tasks only
  python task.py list --mine --status in_progress   # List my in-progress tasks
""")


# =============================================================================
# Main Entry
# =============================================================================

def main() -> int:
    """CLI entry point."""
    # Deprecation guard: `init-context` was removed in v0.5.0-beta.12.
    # Detect early so argparse doesn't mask the real reason with a generic
    # "invalid choice" error.
    if len(sys.argv) >= 2 and sys.argv[1] == "init-context":
        print(
            colored(
                "Error: `task.py init-context` was removed in v0.5.0-beta.12.",
                Colors.RED,
            ),
            file=sys.stderr,
        )
        print(
            "implement.jsonl / check.jsonl are now seeded on `task.py create` for",
            file=sys.stderr,
        )
        print(
            "sub-agent-capable platforms and curated by the AI during planning when needed.",
            file=sys.stderr,
        )
        print("See .trellis/workflow.md planning artifact guidance or run:", file=sys.stderr)
        print(
            "  python ./.trellis/scripts/get_context.py --mode phase --step 1",
            file=sys.stderr,
        )
        print(
            "Use `task.py add-context <dir> implement|check <path> <reason>` to append entries.",
            file=sys.stderr,
        )
        return 2

    parser = argparse.ArgumentParser(
        description="Task Management Script",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    subparsers = parser.add_subparsers(dest="command", help="Commands")

    # create
    p_create = subparsers.add_parser("create", help="Create new task")
    p_create.add_argument("title", help="Task title (required, non-empty)")
    p_create.add_argument("--slug", "-s", help="Task slug without the MM-DD date prefix")
    p_create.add_argument("--assignee", "-a", help="Assignee developer")
    p_create.add_argument("--priority", "-p", default="P2", help="Priority (P0-P3)")
    p_create.add_argument(
        "--description",
        "-d",
        help="Task description (required, non-empty — an empty one is refused at archive)",
    )
    p_create.add_argument("--parent", help="Parent task directory (establishes subtask link)")
    p_create.add_argument("--package", help="Package name for monorepo projects")
    p_create.add_argument(
        "--task-type",
        choices=TASK_TYPE_IDS,
        help="Task complexity: simple, complex, or research",
    )
    p_create.add_argument(
        "--work-type",
        choices=WORK_TYPE_IDS,
        help="Task work surface: backend, frontend, fullstack, research, or docs",
    )
    p_create.add_argument(
        "--allow-unlabeled",
        action="store_true",
        help=(
            "Legacy escape hatch: create without --task-type/--work-type. "
            "The task will be treated as legacy and verify/archive stay permissive."
        ),
    )
    p_create.add_argument(
        "--base-branch",
        help="PR target branch (overrides origin/HEAD detection and the checked-out-branch fallback)",
    )
    p_create.add_argument(
        "--meta",
        action="append",
        help="Task metadata key=value (repeatable)",
    )
    p_create.add_argument(
        "--no-start",
        action="store_true",
        help="Create the task without making it active in this session",
    )
    p_create.add_argument(
        "--force",
        action="store_true",
        help="Overwrite task.json when the task directory already exists",
    )

    # add-context
    p_add = subparsers.add_parser("add-context", help="Add context entry")
    p_add.add_argument("dir", help="Task directory")
    p_add.add_argument("file", help="JSONL file (implement|check)")
    p_add.add_argument("path", help="File path to add")
    p_add.add_argument("reason", nargs="?", help="Reason for adding")

    # validate
    p_validate = subparsers.add_parser("validate", help="Validate context files")
    p_validate.add_argument("dir", help="Task directory")

    # list-context
    p_listctx = subparsers.add_parser("list-context", help="List context entries")
    p_listctx.add_argument("dir", help="Task directory")

    # start
    p_start = subparsers.add_parser("start", help="Set active task")
    p_start.add_argument("dir", help="Task directory")
    p_start.add_argument(
        "--allow-empty-context",
        action="store_true",
        help="Start even when implement.jsonl / check.jsonl have no curated entries",
    )
    start_state = p_start.add_mutually_exclusive_group()
    start_state.add_argument(
        "--commit-state",
        action="store_true",
        help="Persist the status transition in a task-only bookkeeping commit",
    )
    start_state.add_argument(
        "--no-commit-state",
        action="store_true",
        help="Only write the event log; do not create a bookkeeping commit",
    )
    p_start.add_argument(
        "--push",
        action="store_true",
        help="Push the bookkeeping commit after creating it",
    )
    p_start.add_argument(
        "--force-degraded",
        action="store_true",
        help=(
            "Allow --no-commit-state for a complex task. The degradation is "
            "recorded and verify/archive will refuse the task."
        ),
    )
    p_start.add_argument(
        "--reason",
        help="Why the complex start state is not being committed (requires --force-degraded)",
    )
    p_start.add_argument(
        "--force",
        action="store_true",
        help="Allow starting a task that is not in planning",
    )

    # current
    p_current = subparsers.add_parser("current", help="Show active task")
    p_current.add_argument("--source", action="store_true",
                           help="Show active task source")
    p_current.add_argument("--json", action="store_true",
                           help="Output machine-readable JSON")

    # finish
    subparsers.add_parser("finish", help="Clear active task")

    # set-branch
    p_branch = subparsers.add_parser("set-branch", help="Set git branch")
    p_branch.add_argument("dir", help="Task directory")
    p_branch.add_argument("branch", help="Branch name")

    # set-base-branch
    p_base = subparsers.add_parser("set-base-branch", help="Set PR target branch")
    p_base.add_argument("dir", help="Task directory")
    p_base.add_argument("base_branch", help="Base branch name (PR target)")

    # set-scope
    p_scope = subparsers.add_parser("set-scope", help="Set scope")
    p_scope.add_argument("dir", help="Task directory")
    p_scope.add_argument("scope", help="Scope name")

    # set-meta
    p_setmeta = subparsers.add_parser("set-meta", help="Set/overwrite a task metadata key")
    p_setmeta.add_argument("dir", help="Task directory")
    p_setmeta.add_argument("key", help="Metadata key")
    p_setmeta.add_argument("value", help="Metadata value")

    # set-task-type
    p_task_type = subparsers.add_parser("set-task-type", help="Set the explicit task complexity")
    p_task_type.add_argument("dir", help="Task directory")
    p_task_type.add_argument("task_type", choices=TASK_TYPE_IDS)
    p_task_type.add_argument("--force", action="store_true", help="Allow changing after start")
    p_task_type.add_argument("--reason", help="Why the label is changing (required with --force)")

    # set-work-type
    p_work_type = subparsers.add_parser("set-work-type", help="Set the explicit work surface")
    p_work_type.add_argument("dir", help="Task directory")
    p_work_type.add_argument("work_type", choices=WORK_TYPE_IDS)
    p_work_type.add_argument("--force", action="store_true", help="Allow changing after start")
    p_work_type.add_argument("--reason", help="Why the label is changing (required with --force)")
    p_work_type.add_argument(
        "--check-report-required",
        action="store_true",
        help="Require a frontend check-report for this task",
    )

    # set-commit
    p_commit = subparsers.add_parser("set-commit", help="Record the final implementation commit")
    p_commit.add_argument("dir", help="Task directory")
    p_commit.add_argument("commit", help="Commit hash (7-40 hex) or HEAD")
    p_commit.add_argument(
        "--allow-missing-object",
        action="store_true",
        help="Record a commit that is not present locally (shallow/cross-repo)",
    )
    p_commit.add_argument(
        "--persist",
        action="store_true",
        help="Create a bookkeeping commit containing only task.json",
    )

    # set-pr
    p_pr = subparsers.add_parser("set-pr", help="Record the pull-request URL")
    p_pr.add_argument("dir", help="Task directory")
    p_pr.add_argument("url", help="PR URL (http/https)")

    # set-evidence
    p_evidence = subparsers.add_parser("set-evidence", help="Record frontend evidence")
    p_evidence.add_argument("dir", help="Task directory")
    p_evidence.add_argument("--type", choices=("e2e", "visual", "manual"), required=True)
    p_evidence.add_argument("--artifact", required=True, help="Screenshot path, preview URL, or E2E run reference")
    p_evidence.add_argument("--commit", help="Commit this evidence applies to")
    p_evidence.add_argument("--confirmed-by", help="Who confirmed the visual/manual evidence")

    # set-check-override
    p_override = subparsers.add_parser("set-check-override", help="Record an explicit check-gate authorization")
    p_override.add_argument("dir", help="Task directory")
    p_override.add_argument("--by", required=True, help="Who authorized the override")
    p_override.add_argument("--reason", required=True, help="Why the check artifact is not required")
    p_override.add_argument("--commit", help="Bind the override to this commit (defaults to task commit)")

    # verify
    p_verify = subparsers.add_parser("verify", help="Check task evidence")
    p_verify.add_argument("dir", help="Task directory")
    p_verify.add_argument("--strict", action="store_true", help="Treat warnings as errors")
    p_verify.add_argument("--json", action="store_true", help="Output JSON")

    # doctor
    p_doctor = subparsers.add_parser("doctor", help="Repair safe task-state inconsistencies")
    p_doctor.add_argument("dir", help="Task directory")
    p_doctor.add_argument("--fix", action="store_true", help="Write the repairs")
    p_doctor.add_argument("--json", action="store_true", help="Output JSON")

    # rename
    p_rename = subparsers.add_parser("rename", help="Rename task and its references")
    p_rename.add_argument("name", help="Task directory or name")
    p_rename.add_argument("new_slug", help="New slug without the MM-DD date prefix")
    p_rename.add_argument(
        "--dry-run",
        action="store_true",
        help="Print the change set without writing anything",
    )

    # archive
    p_archive = subparsers.add_parser("archive", help="Archive task")
    p_archive.add_argument("name", help="Task directory or name")
    p_archive.add_argument("--no-commit", action="store_true", help="Skip auto git commit after archive")
    p_archive.add_argument(
        "--planning-only",
        action="store_true",
        help="No-code task: mark meta.no_code/planning_only and skip the evidence gate",
    )
    p_archive.add_argument(
        "--skip-branch-validation",
        action="store_true",
        help=(
            "Archive even when branch metadata is missing or self-referential "
            "(for tasks that were never PR-backed)"
        ),
    )

    # list
    p_list = subparsers.add_parser("list", help="List tasks")
    p_list.add_argument("--mine", "-m", action="store_true", help="My tasks only")
    p_list.add_argument("--status", "-s", help="Filter by status")
    p_list.add_argument("--json", action="store_true", help="Output machine-readable JSON")

    # add-subtask
    p_addsub = subparsers.add_parser("add-subtask", help="Link child task to parent")
    p_addsub.add_argument("parent_dir", help="Parent task directory")
    p_addsub.add_argument("child_dir", help="Child task directory")

    # remove-subtask
    p_rmsub = subparsers.add_parser("remove-subtask", help="Unlink child task from parent")
    p_rmsub.add_argument("parent_dir", help="Parent task directory")
    p_rmsub.add_argument("child_dir", help="Child task directory")

    # list-archive
    p_listarch = subparsers.add_parser("list-archive", help="List archived tasks")
    p_listarch.add_argument("month", nargs="?", help="Month (YYYY-MM)")

    args = parser.parse_args()

    if not args.command:
        show_usage()
        return 1

    commands = {
        "create": cmd_create,
        "add-context": cmd_add_context,
        "validate": cmd_validate,
        "list-context": cmd_list_context,
        "start": cmd_start,
        "current": cmd_current,
        "finish": cmd_finish,
        "set-branch": cmd_set_branch,
        "set-base-branch": cmd_set_base_branch,
        "set-scope": cmd_set_scope,
        "set-meta": cmd_set_meta,
        "set-task-type": cmd_set_task_type,
        "set-work-type": cmd_set_work_type,
        "set-commit": cmd_set_commit,
        "set-pr": cmd_set_pr,
        "set-evidence": cmd_set_evidence,
        "set-check-override": cmd_set_check_override,
        "verify": cmd_verify,
        "doctor": cmd_doctor,
        "rename": cmd_rename,
        "archive": cmd_archive,
        "add-subtask": cmd_add_subtask,
        "remove-subtask": cmd_remove_subtask,
        "list": cmd_list,
        "list-archive": cmd_list_archive,
    }

    if args.command in commands:
        return commands[args.command](args)
    else:
        show_usage()
        return 1


if __name__ == "__main__":
    sys.exit(main())
