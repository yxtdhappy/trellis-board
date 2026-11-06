# Workspace template assets

`workspace-template.zip` and `manifest.json` are the server-distributed Trellis
workspace scaffold. They were generated from the `trellis` CLI `0.6.16` product
of:

```bash
trellis init -y --opencode --codex -u template-user
```

The generated `.trellis/.developer`, `.trellis/workspace` and task content were
removed before archiving. `manifest.json` records the archive SHA-256, version,
default tools (`.opencode`, `.agents`) and optional tools (`.codex`).

`server/team/workspace-templates.js` verifies the archive hash against
`manifest.json` before serving either file. Update both files together and bump
`version` for every template change; clients cache archives by SHA-256 and must
not receive a silently mutated package under the same version.
