# trellis-kit

A conservative overlay for the task-state evidence loop. It installs the
manifest-listed workflow, task scripts, skills, and agent prompts into an
existing Trellis project. It never creates `tasks/`, `workspace/`, or runtime
state, and it never deletes files.

```bash
python trellis-kit/apply.py --target /path/to/project --dry-run
python trellis-kit/apply.py --target /path/to/project --force
python trellis-kit/apply.py --target /path/to/project --agent-only --platform claude-code --platform codex
```

`overlay/` is the self-contained copy of every managed file. The desktop
client bundles `trellis-kit/` and applies it automatically after `trellis init`
and after agent-only initialization; new projects therefore get the Board
workflow without a manual post-step. `apply.py` defaults to `overlay/` as its
source, so it also works when only the kit directory is present.

After changing a managed workflow/skill/agent/script file in the repository,
regenerate the overlay before committing:

```bash
python trellis-kit/build_overlay.py
```

`platforms/registry.json` records the seven supported platforms
(claude-code, codex, opencode, pi, omp, antigravity, dsh) with their capability
and path differences. Platform-specific files are copied only when that
platform is selected; shared skills are copied once; unsupported platform
directories are not created.

Existing projects can be upgraded with:

```bash
python trellis-kit/apply.py --target /path/to/project --force --platform <id>
```
