#!/usr/bin/env python3
"""Apply the trellis-kit overlay to a Trellis project.

This is intentionally conservative: it copies only manifest-listed files, never
creates tasks/workspace/runtime directories, and never deletes anything. Run
with --dry-run first.

The default source is the self-contained `overlay/` directory, so the kit works
when bundled with the desktop client without the board source tree.
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path

KIT_ROOT = Path(__file__).resolve().parent
DEFAULT_SOURCE = KIT_ROOT / "overlay"
SNIPPET_PATH = KIT_ROOT / "snippets" / "agents-workflow-rules.md"
BOARD_BLOCK_START = "<!-- TRELLIS-BOARD:START -->"
BOARD_BLOCK_END = "<!-- TRELLIS-BOARD:END -->"
WORKFLOW_RULES_HEADING = "## Trellis Workflow 优先规则"


def sync_agents_workflow_rules(
    target: Path,
    snippet_path: Path,
    *,
    agent_only: bool,
    dry_run: bool,
    force: bool,
) -> tuple[int, int, int]:
    """Ensure target/AGENTS.md carries the managed TRELLIS-BOARD workflow rules block."""
    agents_path = target / "AGENTS.md"
    if agent_only and not agents_path.exists():
        return 0, 0, 0
    if not snippet_path.is_file():
        print(f"missing snippet: {snippet_path}", file=sys.stderr)
        return 0, 0, 1

    block = snippet_path.read_text(encoding="utf-8").replace("\r\n", "\n").strip()
    if not (block.startswith(BOARD_BLOCK_START) and block.endswith(BOARD_BLOCK_END)):
        print(f"invalid snippet markers: {snippet_path}", file=sys.stderr)
        return 0, 0, 1

    if not agents_path.exists():
        print(f"{'would write' if dry_run else 'write'}: {agents_path}")
        if not dry_run:
            with agents_path.open("w", encoding="utf-8", newline="\n") as handle:
                handle.write(block + "\n")
        return 1, 0, 0

    raw = agents_path.read_text(encoding="utf-8")
    newline = "\r\n" if "\r\n" in raw else "\n"
    existing = raw.replace("\r\n", "\n")

    start_idx = existing.find(BOARD_BLOCK_START)
    end_idx = existing.find(BOARD_BLOCK_END, start_idx) if start_idx != -1 else -1
    if start_idx != -1 and end_idx != -1:
        current_block = existing[start_idx : end_idx + len(BOARD_BLOCK_END)]
        if current_block == block:
            return 0, 1, 0
        if not force:
            print(f"conflict: {agents_path} differs; re-run with --force", file=sys.stderr)
            return 0, 0, 1
        updated = existing[:start_idx] + block + existing[end_idx + len(BOARD_BLOCK_END) :]
        if not updated.endswith("\n"):
            updated += "\n"
    elif BOARD_BLOCK_START in existing or BOARD_BLOCK_END in existing:
        print(f"malformed TRELLIS-BOARD markers in {agents_path}", file=sys.stderr)
        return 0, 0, 1
    else:
        if any(line.strip() == WORKFLOW_RULES_HEADING for line in existing.splitlines()):
            return 0, 1, 0
        trimmed = existing.rstrip()
        updated = f"{trimmed}\n\n{block}\n" if trimmed else f"{block}\n"

    print(f"{'would update' if dry_run else 'update'}: {agents_path}")
    if not dry_run:
        rendered = updated.replace("\n", newline)
        with agents_path.open("w", encoding="utf-8", newline="") as handle:
            handle.write(rendered)
    return 1, 0, 0


def load_json(path: Path) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise SystemExit(f"cannot read {path}: {exc}") from exc
    if not isinstance(data, dict):
        raise SystemExit(f"{path}: expected a JSON object")
    return data


def feature_components(manifest: dict) -> dict[str, dict]:
    return {
        component["id"]: component
        for component in manifest.get("components", [])
        if component.get("kind") == "feature" and isinstance(component.get("id"), str)
    }


def validate_feature_requests(requested: list[str], features: dict[str, dict]) -> int:
    if not requested:
        return 0
    missing = [feature_id for feature_id in requested if feature_id not in features]
    if missing:
        available = ", ".join(sorted(features)) or "(none)"
        print(
            f"unknown feature(s): {', '.join(missing)}; available: {available}",
            file=sys.stderr,
        )
        return 1
    for feature_id in requested:
        descriptor = features[feature_id].get("descriptor")
        if not isinstance(descriptor, str) or not descriptor:
            print(f"feature {feature_id}: missing descriptor", file=sys.stderr)
            return 1
        descriptor_path = (KIT_ROOT / descriptor).resolve()
        try:
            descriptor_path.relative_to(KIT_ROOT)
        except ValueError:
            print(f"feature {feature_id}: descriptor escapes kit root", file=sys.stderr)
            return 1
        if not descriptor_path.is_file():
            print(f"feature {feature_id}: missing descriptor {descriptor_path}", file=sys.stderr)
            return 1
        data = load_json(descriptor_path)
        if data.get("id") != feature_id:
            print(f"feature {feature_id}: descriptor id mismatch", file=sys.stderr)
            return 1
    return 0


def load_existing_features(marker: Path) -> list[str]:
    if not marker.is_file():
        return []
    try:
        data = json.loads(marker.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        print(f"warning: cannot read {marker}: {exc}", file=sys.stderr)
        return []
    if not isinstance(data, dict):
        return []
    values = data.get("features")
    if not isinstance(values, list):
        return []
    return [value for value in values if isinstance(value, str) and value]


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
    parser.add_argument("--source", default=str(DEFAULT_SOURCE), help="Overlay source root")
    parser.add_argument("--platform", action="append", default=[], help="Platform id (repeatable)")
    parser.add_argument("--agent-only", action="store_true", help="Install agent assets only; never create task dirs")
    parser.add_argument("--dry-run", action="store_true", help="Print actions without writing")
    parser.add_argument("--force", action="store_true", help="Overwrite existing files")
    parser.add_argument(
        "--feature",
        action="append",
        default=[],
        help="Enable an optional feature (repeatable); features are recorded, not copied",
    )
    args = parser.parse_args()

    source = Path(args.source).resolve()
    target = Path(args.target).resolve()
    manifest = load_json(KIT_ROOT / "manifest.json")
    features = feature_components(manifest)
    if args.agent_only and args.feature:
        print("--feature cannot be used with --agent-only", file=sys.stderr)
        return 1
    rc = validate_feature_requests(args.feature, features)
    if rc:
        return rc
    if args.dry_run:
        for feature_id in args.feature:
            print(f"feature: {feature_id} -> {features[feature_id]['descriptor']}")
    registry = load_json(KIT_ROOT / manifest.get("platformsFile", "platforms/registry.json"))
    platforms = selected_platforms(registry, args.platform)
    platform_configs = registry.get("platforms", {})

    forbidden = [target / rel for rel in manifest.get("agentOnly", {}).get("forbiddenPaths", [])]
    if args.agent_only:
        for path in forbidden:
            if path.exists():
                print(f"note: agent-only leaves existing {path} untouched", file=sys.stderr)

    copied = skipped = 0
    written: set[Path] = set()

    def copy_file(src: Path, dst: Path) -> int:
        nonlocal copied, skipped
        if dst in written:
            return 0
        if not src.is_file():
            print(f"missing source: {src}", file=sys.stderr)
            return 1
        if dst.exists() and not args.force and dst.read_bytes() == src.read_bytes():
            skipped += 1
            written.add(dst)
            return 0
        if dst.exists() and not args.force:
            print(f"conflict: {dst} differs; re-run with --force", file=sys.stderr)
            return 1
        print(f"{'would copy' if args.dry_run else 'copy'}: {src} -> {dst}")
        if not args.dry_run:
            dst.parent.mkdir(parents=True, exist_ok=True)
            try:
                shutil.copy2(src, dst)
            except OSError as exc:
                print(f"copy failed: {src} -> {dst}: {exc}", file=sys.stderr)
                return 1
        copied += 1
        written.add(dst)
        return 0

    def copy_tree(src_dir: Path, dst_dir: Path) -> int:
        if not src_dir.is_dir():
            print(f"missing source directory: {src_dir}", file=sys.stderr)
            return 1
        for src in sorted(p for p in src_dir.rglob("*") if p.is_file()):
            rc = copy_file(src, dst_dir / src.relative_to(src_dir))
            if rc:
                return rc
        return 0

    shared_skills = any(
        platform_configs.get(platform_id, {}).get("sharedSkills") == ".agents/skills"
        for platform_id in platforms
    )

    for component in manifest.get("components", []):
        kind = component.get("kind", "core")
        if kind == "feature":
            continue
        required_platform = component.get("platform")
        if required_platform and required_platform not in platforms:
            continue
        if platforms and not shared_skills and component.get("target", "").startswith(".agents/skills/"):
            continue
        if args.agent_only and kind not in ("core", "agent", "platform", "skill"):
            continue
        if component.get("directory"):
            rc = copy_tree(source / component["source"], target / component["target"])
        else:
            rc = copy_file(source / component["source"], target / component["target"])
        if rc:
            return rc

    # Every selected platform that does not share `.agents/skills` gets its own
    # skill copies, even when another selected platform does share them.
    if platforms:
        skill_sources = [
            c for c in manifest.get("components", [])
            if c.get("source", "").endswith("/SKILL.md")
            and not c.get("platform")
        ]
        directory_skills = [
            c for c in manifest.get("components", [])
            if c.get("directory") and c.get("kind") == "skill" and not c.get("platform")
        ]
        for platform_id in platforms:
            config = platform_configs[platform_id]
            if config.get("sharedSkills") == ".agents/skills":
                continue
            skill_root = config.get("paths", {}).get("skills")
            if not skill_root:
                print(
                    f"skip platform {platform_id}: registry has no paths.skills",
                    file=sys.stderr,
                )
                continue
            for component in skill_sources:
                name = component["source"].split("/")[-2]
                rc = copy_file(source / component["source"], target / skill_root / name / "SKILL.md")
                if rc:
                    return rc
            for component in directory_skills:
                name = Path(component["source"]).name
                rc = copy_tree(source / component["source"], target / skill_root / name)
                if rc:
                    return rc

    delta_copied, delta_skipped, rc = sync_agents_workflow_rules(
        target,
        SNIPPET_PATH,
        agent_only=args.agent_only,
        dry_run=args.dry_run,
        force=args.force,
    )
    if rc:
        return rc
    copied += delta_copied
    skipped += delta_skipped

    if not args.dry_run:
        marker = target / ".trellis" / ".kit-version"
        existing_features = load_existing_features(marker)
        enabled_features = sorted({*existing_features, *args.feature})
        marker.parent.mkdir(parents=True, exist_ok=True)
        with marker.open("w", encoding="utf-8", newline="\n") as handle:
            handle.write(
                json.dumps(
                    {
                        "version": manifest.get("version"),
                        "platforms": platforms,
                        "agentOnly": args.agent_only,
                        "features": enabled_features,
                    },
                    ensure_ascii=False,
                    indent=2,
                )
                + "\n"
            )

    print(f"done: {copied} copied, {skipped} unchanged")
    return 0


if __name__ == "__main__":
    sys.exit(main())
