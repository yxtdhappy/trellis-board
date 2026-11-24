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

`platforms/registry.json` records the seven supported platform adapters
(claude-code, codex, opencode, pi, omp, antigravity, dsh) with their capability
and path differences. The overlay currently installs shared source files; a
platform adapter that generates command/hook wrappers is a later stage. Until
then, run the project's normal `trellis init`/`update` for platform scaffolding,
then apply this overlay on top.

The first application is a pilot in `trellis-board`; do not roll it across
existing task trees without a review.
