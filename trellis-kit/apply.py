#!/usr/bin/env python3
"""Apply the trellis-kit overlay to a Trellis project.

This is intentionally conservative: it copies only manifest-listed files, never
creates tasks/workspace/runtime directories, and never deletes anything. Run
with --dry-run first.
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path

KIT_ROOT = Path(__file__).resolve().parent
DEFAULT_SOURCE = KIT_ROOT.parent


def load_json(path: Path) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise SystemExit(f"cannot read {path}: {exc}") from exc
    if not isinstance(data, dict):
        raise SystemExit(f"{path}: expected a JSON object")
    return data


def selected_platforms(registry: dict, requested: list[str]) -> list[str]:
    available = registry.get("platforms", {})
    if not requested:
        return []
    missing = [name for name in requested if name not in available]
    if missing:
        raise SystemExit(f"unknown platform(s): {', '.join(missing)}")
    return requested


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target", required=True, help="Target repository root")
    parser.add_argument("--source", default=str(DEFAULT_SOURCE), help="Source repository root")
    parser.add_argument("--platform", action="append", default=[], help="Platform id (repeatable)")
    parser.add_argument("--agent-only", action="store_true", help="Install agent assets only; never create task dirs")
    parser.add_argument("--dry-run", action="store_true", help="Print actions without writing")
    parser.add_argument("--force", action="store_true", help="Overwrite existing files")
    args = parser.parse_args()

    source = Path(args.source).resolve()
    target = Path(args.target).resolve()
    manifest = load_json(KIT_ROOT / "manifest.json")
    registry = load_json(KIT_ROOT / manifest.get("platformsFile", "platforms/registry.json"))
    platforms = selected_platforms(registry, args.platform)

    forbidden = [target / rel for rel in manifest.get("agentOnly", {}).get("forbiddenPaths", [])]
    if args.agent_only:
        for path in forbidden:
            if path.exists():
                print(f"note: agent-only leaves existing {path} untouched", file=sys.stderr)

    copied = skipped = 0
    for component in manifest.get("components", []):
        kind = component.get("kind", "core")
        if args.agent_only and kind not in ("core", "agent"):
            continue
        src = source / component["source"]
        dst = target / component["target"]
        if not src.is_file():
            print(f"missing source: {src}", file=sys.stderr)
            return 1
        if dst.exists() and not args.force and dst.read_bytes() == src.read_bytes():
            skipped += 1
            continue
        if dst.exists() and not args.force:
            print(f"conflict: {dst} differs; re-run with --force", file=sys.stderr)
            return 1
        print(f"{'would copy' if args.dry_run else 'copy'}: {src} -> {dst}")
        if not args.dry_run:
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dst)
        copied += 1

    if not args.dry_run:
        marker = target / ".trellis" / ".kit-version"
        marker.parent.mkdir(parents=True, exist_ok=True)
        marker.write_text(
            json.dumps(
                {
                    "version": manifest.get("version"),
                    "platforms": platforms,
                    "agentOnly": args.agent_only,
                },
                ensure_ascii=False,
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )

    print(f"done: {copied} copied, {skipped} unchanged")
    return 0


if __name__ == "__main__":
    sys.exit(main())
