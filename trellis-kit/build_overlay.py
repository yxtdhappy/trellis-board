#!/usr/bin/env python3
"""Regenerate `overlay/` from the trellis-board source tree.

Run this after changing any managed workflow/skill/agent/script file, then
commit `trellis-kit/overlay` so the kit remains self-contained when bundled
with the desktop client.
"""

from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path

KIT_ROOT = Path(__file__).resolve().parent
DEFAULT_SOURCE = KIT_ROOT.parent


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", default=str(DEFAULT_SOURCE), help="trellis-board repository root")
    args = parser.parse_args()

    source = Path(args.source).resolve()
    manifest = json.loads((KIT_ROOT / "manifest.json").read_text(encoding="utf-8"))
    overlay = KIT_ROOT / "overlay"
    copied = 0
    for component in manifest.get("components", []):
        src = source / component["source"]
        dst = overlay / component["source"]
        if not src.is_file():
            raise SystemExit(f"missing source: {src}")
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)
        copied += 1
    print(f"overlay: {copied} files synced from {source}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
