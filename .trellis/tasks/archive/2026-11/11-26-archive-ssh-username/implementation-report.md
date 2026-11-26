# Implementation Report: 归档 SSH 用户名持久化

## Changed Files

- `packages/server/team/archive-git-credentials.js`
- `packages/server/test/archive-git-credentials.test.js`
- `packages/web/src/features/admin/ArchiveSyncTab.tsx`
- `packages/web/src/features/admin/archive-sync-format.ts`
- `docs/team-operations.md`
- `.trellis/spec/backend/architecture-and-runtime.md`
- `.trellis/spec/backend/http-and-filesystem.md`
- `.trellis/spec/frontend/rendering-and-state.md`

## Decisions

- Reused `sync_archive_git_credential.username`; no schema migration.
- SSH create defaults to `git`; custom usernames allow `A-Z a-z 0-9 . _ @ + -`.
- Legacy SSH rows with null username resolve to `git` at runtime.
- SSH wrapper now passes `-o User=<quoted username>` and retains temporary key permissions, `BatchMode`, and source isolation.
- Admin form now exposes the same username for SSH and HTTPS, with SSH default/refill `git`.

## Verification

- Focused Node tests: 3/3 passed.
- Final `yarn build`: passed.
- Targeted oxfmt check on changed code: passed.
- Browser admin form: SSH create default `git`, edit refill `git`, no console warnings/errors.
- Local API E2E: create `201`, read-back `git`, SQLite persistence `git`, invalid username `400`; see `api-e2e-report.md`.
- Credential update test confirms custom usernames containing `+` and `@` persist and appear in the generated SSH wrapper.

## Open Risks

- Full `yarn test` twice had unrelated Windows concurrency failures in one test each time (`plugin-real-task` EPERM, then `team-release`); each failed file passed when rerun alone. This task's archive tests passed in both full runs.
- Repository-wide `yarn format:check` reports 32 pre-existing files outside this task; changed files pass targeted formatting.
- Production container recreation was verified after deployment with the existing `wit-ci` credential. The exposed screenshot key still requires rotation.
