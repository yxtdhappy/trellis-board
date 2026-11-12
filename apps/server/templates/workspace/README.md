# Workspace template assets

`workspace-template.zip` and `manifest.json` are the server-distributed Trellis
workspace scaffold. They were generated from the `trellis` CLI `0.6.16` product
of:

```bash
trellis init -y --opencode --codex -u template-user
```

The generated `.trellis/.developer`, `.trellis/workspace` and task content were
removed before archiving. The archive also drops `__pycache__`, `*.pyc` and the
empty `.trellis/tasks/` directory so clients never receive interpreter caches.
`manifest.json` records the archive SHA-256, version, default tools
(`.opencode`, `.agents`) and optional tools (`.codex`).

## Version differences

- `templateVersion` and `projectVersion` both record `0.6.16`: the archive is
  the product of the `0.6.16` CLI, and the client expands the archive as-is.
- The project baseline is `0.6.17`. The board does not ship a `0.6.17` CLI
  archive, so the template keeps the older scaffold version and the client
  records it in `.trellis/.template-hashes.json` instead of pretending the
  result matches `0.6.17`.
- `version` (`0.6.16-template-2`) is the board template revision. It changes for
  every archive rewrite, even when the upstream Trellis version does not.

## Updating

1. Unpack the archive, remove local state (`.trellis/.developer`,
   `.trellis/workspace`, task content), caches and empty task directories.
2. Rebuild the archive with a stable entry order and bump
   `template-manifest.json` and `manifest.json` `version`.
3. Recompute `sha256`, `bytes`, `entryCount`, `fileCount` and `files` from the
   new archive.
4. `server/team/workspace-templates.js` verifies the archive hash and every
   per-file hash against `manifest.json` at load time; a mismatch refuses to
   serve either resource.

Clients cache archives per team by SHA-256 and must not receive a silently
mutated package under the same version.
