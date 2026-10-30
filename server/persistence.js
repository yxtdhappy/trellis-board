import { getDefaultDatabase, withTransaction } from "./database.js";

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export function createPersistenceStore({ db = getDefaultDatabase() } = {}) {
  function writeScanCacheRow(board, schemaVersion) {
    const savedAt = new Date().toISOString();
    db.prepare(`
      INSERT INTO scan_cache(id, schema_version, saved_at, board_json)
      VALUES (1, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        schema_version = excluded.schema_version,
        saved_at = excluded.saved_at,
        board_json = excluded.board_json
    `).run(schemaVersion, savedAt, JSON.stringify(board));
    return { schemaVersion, savedAt };
  }

  return {
    readScanCache(schemaVersion) {
      const row = db.prepare(`
        SELECT schema_version, board_json
        FROM scan_cache
        WHERE id = 1
      `).get();
      if (!row || row.schema_version !== schemaVersion) return null;
      const board = parseJson(row.board_json);
      return board && typeof board === "object" && !Array.isArray(board) ? board : null;
    },

    writeScanCache(board, schemaVersion, { beforeCommit } = {}) {
      if (!Number.isInteger(schemaVersion)) {
        throw new Error("扫描缓存 schemaVersion 必须是整数");
      }
      if (beforeCommit !== undefined && typeof beforeCommit !== "function") {
        throw new Error("扫描前写入钩子必须是函数");
      }
      if (!beforeCommit) return writeScanCacheRow(board, schemaVersion);
      const result = withTransaction(db, () => {
        // 先写事件，再以扫描缓存作为同一事务的最后提交标记。
        const beforeCommitResult = beforeCommit();
        return {
          beforeCommitResult,
          saved: writeScanCacheRow(board, schemaVersion)
        };
      });
      return {
        ...result.saved,
        beforeCommitResult: result.beforeCommitResult
      };
    },

    readBoardState() {
      const state = {};
      const rows = db.prepare("SELECT key, value_json FROM board_state").all();
      for (const row of rows) {
        try {
          state[row.key] = JSON.parse(row.value_json);
        } catch {
          // 损坏的单个状态字段视为不存在，其他状态仍可返回。
        }
      }
      return state;
    },

    writeBoardState(patch) {
      if (!patch || Array.isArray(patch) || typeof patch !== "object") {
        throw new Error("看板状态必须是对象");
      }
      const updatedAt = new Date().toISOString();
      withTransaction(db, () => {
        const upsert = db.prepare(`
          INSERT INTO board_state(key, value_json, updated_at)
          VALUES (?, ?, ?)
          ON CONFLICT(key) DO UPDATE SET
            value_json = excluded.value_json,
            updated_at = excluded.updated_at
        `);
        for (const [key, value] of Object.entries(patch)) {
          const valueJson = JSON.stringify(value);
          if (valueJson === undefined) continue;
          upsert.run(key, valueJson, updatedAt);
        }
      });
    }
  };
}
