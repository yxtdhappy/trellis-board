# SQLite Persistence Design

## 1. Architecture Boundary

Trellis Board has two distinct kinds of state:

1. **Workflow truth** lives in each repository under `.trellis/tasks/**`. This remains file-based and is scanned, never mirrored as authoritative task records in SQLite.
2. **Board runtime and extension state** is owned by this application. It moves to one SQLite database:

```text
.trellis/tasks/** ──scan──> board projection ──cache──> SQLite scan_cache
                                   │
data/repos.json ───────one-time───┼──> SQLite repositories
data/task-metadata.json ─one-time──┼──> SQLite task_stage
data/board-state.json ──one-time───┴──> SQLite board_state
```

After migration, the JSON files are read-only backups. Runtime reads and writes use SQLite.

## 2. Module Ownership

- `server/config.js`
  - Application/data paths.
  - Default repositories.
  - Repository normalization.
  - No persistence writes.
- `server/database.js`
  - Opens `DatabaseSync`.
  - Applies PRAGMAs and schema migrations.
  - Provides transaction helper.
  - Performs idempotent one-time legacy JSON import.
- `server/repositories.js`
  - Repository list/addMany/remove contract.
  - Uses SQLite transactions and positions.
- `server/metadata.js`
  - Manual stage get/set contract.
  - Uses SQLite upsert.
- `server/persistence.js`
  - Scan cache and board state getters/setters.
- `server/index.js`
  - Calls persistence facade instead of reading/writing JSON.
- `server/scan-worker.js`
  - Calls repository and manual-stage facades; opens its own SQLite connection in the Worker process.

## 3. Database Contract

Database path:

```text
D:/workspace/wiki/trellis-board/data/board.sqlite
```

Schema version 1:

```sql
CREATE TABLE app_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE repositories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  path_key TEXT NOT NULL UNIQUE,
  position INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE task_stage (
  task_key TEXT PRIMARY KEY,
  stage TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE scan_cache (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  schema_version INTEGER NOT NULL,
  saved_at TEXT NOT NULL,
  board_json TEXT NOT NULL
);

CREATE TABLE board_state (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

`path_key` is the normalized unique repository path. On Windows it is lower-cased.

## 4. Initialization and Migration

Every process/thread that needs storage calls `openDatabase()`.

1. Create `data/` if needed.
2. Open one `DatabaseSync` connection per process/thread.
3. Apply:
   - `journal_mode = WAL`
   - `foreign_keys = ON`
   - `busy_timeout = 5000`
   - `synchronous = NORMAL`
4. Create schema version 1 if absent.
5. In one `BEGIN IMMEDIATE` transaction, check `app_meta.legacy_json_imported_v1`.
6. If absent:
   - Import `repos.json`; if absent import `defaultRepositories`.
   - Import `task-metadata.json`.
   - Import `scan-cache.json`.
   - Import `board-state.json`.
7. Set `legacy_json_imported_v1=1`.
8. Commit.

Malformed legacy JSON is logged and skipped. The original file remains untouched.

The marker is written even when a source file is absent. Therefore:

- An intentionally empty repository list remains empty.
- Default repositories are inserted only on first initialization.
- Deleting all projects does not trigger fallback re-import.

## 5. Transactions

`withTransaction(db, callback)` issues `BEGIN IMMEDIATE` and commits only when callback succeeds.

Repository addMany:

- Validate all inputs first.
- Insert all records in one transaction.
- Roll back the full batch on any failure.

Repository remove:

- Delete one record.
- Renumber positions in the same transaction.

Manual stage update:

- Upsert one `task_stage` row atomically.

Scan cache:

- Replace the single row with `INSERT ... ON CONFLICT(id) DO UPDATE`.

Board state:

- Upsert one key/value row per changed field.

## 6. Threading and Concurrency

`DatabaseSync` objects are not shared between the main thread and `scan-worker.js`.

- Main thread opens its own connection.
- Each Worker thread opens its own connection.
- WAL allows reads while scans/writes proceed.
- `busy_timeout=5000` handles short write contention.
- Existing refresh orchestration remains responsible for sequencing repository changes and full rescans.

## 7. Error Handling

- SQLite open, migration, or query failures are fatal. The server must not silently fall back to JSON after choosing SQLite.
- Legacy JSON parse errors are non-fatal because the files are migration inputs and backups.
- Scan cache JSON stored inside SQLite is validated on read; malformed cache is treated as a cache miss.
- Errors preserve the existing API error shape.

## 8. Compatibility and Rollback

- API payloads and frontend code do not change.
- `data/repos.example.json` remains documentation.
- Existing JSON files remain in place.
- Rollback to the pre-SQLite code can continue using the old JSON backups because this task does not modify those files after migration.
- Node engine requirement changes from `>=20` to `>=24`.

## 9. Performance and Safety

- Small repository, stage and state writes are indexed point operations.
- The board scan cache remains a serialized projection row because the existing API already consumes one complete board snapshot.
- No SQL is built from user input; all values use prepared statements.
- Repository paths are normalized before insertion and never used directly as SQL identifiers.

## 10. Tests

- Create a temporary database and assert schema/version initialization.
- Seed legacy JSON and assert one-time import.
- Re-open the database and assert no duplicate import.
- Remove all repositories and re-open; assert they stay empty.
- Force a transaction error and assert no partial repository batch.
- Verify manual stage upsert and reload.
- Verify cache schema version handling and board state round-trip.
- Run all existing tests to prove API/domain behavior is unchanged.
