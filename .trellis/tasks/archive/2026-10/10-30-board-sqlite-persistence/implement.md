# SQLite Persistence Implementation Plan

## 1. Add the SQLite foundation

- [ ] Add `server/database.js` with connection lifecycle, PRAGMAs, schema v1 and transaction helper.
- [ ] Add legacy JSON import guarded by `app_meta.legacy_json_imported_v1`.
- [ ] Ensure each Worker thread can open its own connection.
- [ ] Add focused tests for schema creation, migration idempotence and empty repository persistence.

Validation:

```bash
node --test tests/database.test.js
```

Rollback point:

- Remove `server/database.js` and `tests/database.test.js`; no application consumer has changed yet.

## 2. Move repository storage to SQLite

- [ ] Change `server/repositories.js` to read/write `repositories`.
- [ ] Preserve public `list/add/addMany/remove` behavior.
- [ ] Use one transaction per mutation and path uniqueness constraints.
- [ ] Move `getRepositories()` ownership out of file config and update server callers.
- [ ] Update repository tests to inspect SQLite rather than `repos.json`.

Validation:

```bash
node --test tests/repositories.test.js tests/actions.test.js
```

Rollback point:

- Restore the file-backed repository functions; existing `repos.json` remains unchanged.

## 3. Move manual stages and board state

- [ ] Change `server/metadata.js` to use `task_stage`.
- [ ] Add `server/persistence.js` for `scan_cache` and `board_state`.
- [ ] Replace JSON reads/writes in `server/index.js`.
- [ ] Preserve `SCAN_SCHEMA_VERSION` cache-miss behavior and status payload shape.
- [ ] Add tests for stage persistence and state/cache round-trips.

Validation:

```bash
node --test tests/metadata.test.js tests/persistence.test.js
```

Rollback point:

- Restore JSON-backed functions; legacy JSON files were not modified.

## 4. Runtime and compatibility cleanup

- [ ] Update `package.json` engine requirement to Node `>=24`.
- [ ] Add `data/board.sqlite`, `-wal` and `-shm` to local ignores.
- [ ] Keep the old JSON files as migration backups.
- [ ] Update README for schema path, migration behavior, backup and rollback.
- [ ] Update Trellis state-management spec with the SQLite ownership rule.

Validation:

```powershell
Get-ChildItem -Path server,public -Filter '*.js' -File -Recurse |
  ForEach-Object { node --check $_.FullName }
npm test
```

Rollback point:

- Revert documentation and engine changes; database files are local runtime data and can be archived separately.

## 5. Quality gate

- [ ] Review all callers of `getRepositories`, `getManualRecords`, cache and state.
- [ ] Verify no runtime path still writes the four legacy JSON files.
- [ ] Verify SQLite transactions cover every multi-row mutation.
- [ ] Verify no task workflow files were modified.
- [ ] Verify no unrelated user changes were staged or removed.

## 6. Restart and E2E

Default delivery mode applies. After code-level validation passes:

- [ ] Stop and wait for the user to restart the local service.
- [ ] Confirm new PID and `data/board.sqlite` creation.
- [ ] Verify `/api/health`, `/api/repositories`, `/api/board/status` and `/api/board`.
- [ ] Add a temporary E2E project, verify database rows and watcher update, then remove it through the API.
- [ ] Set and clear a manual stage using a dedicated test task, then verify database persistence.
- [ ] Verify UI list/task detail and project manager are unchanged.
- [ ] Clean E2E data and confirm legacy JSON timestamps did not change.

## Final commands

```powershell
npm test
Get-ChildItem -Path server,public -Filter '*.js' -File -Recurse |
  ForEach-Object { node --check $_.FullName }
```
