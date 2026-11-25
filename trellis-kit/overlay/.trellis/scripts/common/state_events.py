#!/usr/bin/env python3
"""Append-only task state event log.

The JSONL file lives inside the task directory so it moves with the task on
archive. It records intent, not authority: task.json remains the source of
truth. `task.py verify` and `doctor --reconcile` use the last event to detect
a status flip that never reached a commit.
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path


STATE_EVENTS_FILE = ".state-events.jsonl"
SCHEMA_VERSION = 1


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def append_state_event(
    task_dir: Path,
    event: str,
    *,
    from_status: str | None,
    to_status: str | None,
    actor: str | None = None,
    reason: str | None = None,
    state_commit: str | None = None,
    extra: dict | None = None,
) -> Path:
    """Append one event; never rewrite existing lines."""
    payload = {
        "schemaVersion": SCHEMA_VERSION,
        "event": event,
        "from": from_status,
        "to": to_status,
        "at": _now(),
        "actor": actor,
    }
    if reason:
        payload["reason"] = reason
    if state_commit:
        payload["state_commit"] = state_commit
    if extra:
        payload.update(extra)

    path = task_dir / STATE_EVENTS_FILE
    task_dir.mkdir(parents=True, exist_ok=True)
    line = json.dumps(payload, ensure_ascii=False, sort_keys=True) + "\n"
    with path.open("a", encoding="utf-8", newline="\n") as handle:
        handle.write(line)
        handle.flush()
        os.fsync(handle.fileno())
    return path


def read_state_events(task_dir: Path) -> list[dict]:
    """Return parsed events, ignoring a malformed trailing line."""
    path = task_dir / STATE_EVENTS_FILE
    if not path.is_file():
        return []
    events: list[dict] = []
    for raw in path.read_text(encoding="utf-8").splitlines():
        raw = raw.strip()
        if not raw:
            continue
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, dict):
            events.append(parsed)
    return events


def last_status_intent(task_dir: Path) -> str | None:
    """Return the last event's target status, if any."""
    events = read_state_events(task_dir)
    if not events:
        return None
    target = events[-1].get("to")
    return target if isinstance(target, str) else None
