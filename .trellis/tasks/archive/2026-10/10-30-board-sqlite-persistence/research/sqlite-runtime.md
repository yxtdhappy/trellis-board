# Node SQLite Runtime Research

## Verified Environment

- Node: `v24.21.0`
- SQLite: `3.53.4`
- Import: `import { DatabaseSync } from "node:sqlite"`

Probe executed:

```js
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(":memory:");
db.exec("CREATE TABLE probe(id INTEGER PRIMARY KEY, value TEXT)");
db.prepare("INSERT INTO probe(value) VALUES (?)").run("ok");
console.log(db.prepare("SELECT sqlite_version() AS version, value FROM probe").get());
db.close();
```

Result:

```json
{"version":"3.53.4","value":"ok"}
```

No experimental warning was emitted under Node 24.

## Decision

Use built-in `node:sqlite` rather than `better-sqlite3`.

Rationale:

- No native dependency installation on Windows.
- Current host already satisfies Node 24.
- The application only needs synchronous local CRUD.
- Worker threads can each open a separate connection; connection objects are never shared.

Compatibility consequence:

- `package.json` must move from Node `>=20` to Node `>=24`.

## Legacy Data Observed

At planning time:

- `data/repos.json`: 956 bytes
- `data/task-metadata.json`: 348 bytes
- `data/scan-cache.json`: 2,384,319 bytes
- `data/board-state.json`: 1,367 bytes

The scan cache is the only large item and remains one serialized board projection row.
