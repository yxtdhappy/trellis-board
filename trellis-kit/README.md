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
client embeds `trellis-kit/` in its executable, extracts it under
`%LOCALAPPDATA%\TrellisBoard\data\runtime\kit`, and applies it automatically after
`trellis init` and after agent-only initialization; new projects therefore get
the Board workflow without a manual post-step. `apply.py` defaults to `overlay/` as its
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

The directory skill `trellis-api-e2e` is installed as a complete 14-file skill
under the selected platform's skill root (`.claude/skills`, `.opencode/skills`,
`.omp/skills`, `.agent/skills`, or the shared `.agents/skills`). Backend code
tasks are expected to run it before commit and write
`{TASK_DIR}/api-e2e-report.md`; this is a workflow reminder, not a
`task.py verify` gate.

Existing projects can be upgraded with:

```bash
python trellis-kit/apply.py --target /path/to/project --force --platform <id>
```
