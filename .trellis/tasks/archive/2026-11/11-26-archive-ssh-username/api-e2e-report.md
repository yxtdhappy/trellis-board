# API E2E Report: 归档 SSH 用户名持久化

## Topology

- Local Node backend: `node packages/server/index.js`, PID 43244, port 4319.
- Base path: `/weint-spec-board`.
- Data root: isolated OS temporary directory, deleted after verification.
- Frontend: latest `yarn build` assets served by the same local backend.

## Evidence

| Step | Request | Response | Backend / persistence evidence | Result |
| --- | --- | --- | --- | --- |
| Login | `POST /api/auth/login` | `200` | Server initialized isolated admin; no errors in startup log | Pass |
| Temporary password change | `POST /api/auth/password` | `200` | Required first-login gate cleared | Pass |
| Create default SSH credential | `POST /api/admin/archive-sync/credentials` | `201` | SQLite row `username=git`, encrypted secret length 180, audit `archive_git_credential_created` success | Pass |
| Read back credential | `GET /api/admin/archive-sync` | `200` | Response `username=git`, origin `ssh://e2e-ssh.example.com:22` | Pass |
| Invalid SSH username | `POST /api/admin/archive-sync/credentials` | `400` | `INVALID_INPUT: SSH 用户名格式无效`, no credential created | Pass |
| Admin page | Browser `/admin.html` | Form rendered | New SSH form value `git`; edit form refilled `git`; browser console had no warnings/errors | Pass |

## Log Reading

- Startup log recorded the isolated server PID and listening URL.
- Two client `ECONNRESET` warnings appeared while the automated browser navigated/reloaded; they were connection closes without server exceptions and did not affect completed requests.
- This app does not emit one file-log line per HTTP request. The request-side application evidence is the successful audit row plus SQLite read-back.

## Cleanup

- Server process stopped.
- Isolated temporary data directory and generated admin password removed.
- No production data, credentials, or container configuration were modified.

## Production Follow-up

- Jenkins `#9-6008968a` completed successfully at 2026-11-26 14:51 +08:00.
- Production admin page showed the new SSH username field with default `git`.
- Existing `wit-ci` credential test returned `200` with the expected task space and `branchFound=true`.
- `mdp-backend-service`, `mdp-backend-web`, and `mdp-report-service` all showed successful archive sync after redeployment.
- A manual sync at 14:55 +08:00 completed without a new failure, and the admin page had no console errors.

## Unverified

- A second container recreation was not performed solely to repeat the persistence test.
