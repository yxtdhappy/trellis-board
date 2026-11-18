# 设计：归档后清理活跃行

## 边界与归属

- `sync_task_space_file` / `sync_file_audit` / `sync_task_space.revision` 的写入契约原本只在 `packages/server/team/task-snapshot-service.js`。
- 新增清理逻辑放在该文件，导出独立函数 `purgeArchivedTaskFiles(db, taskSpaceId, { now })`（工厂外、纯函数式依赖注入），由 `packages/server/team/archive-git-sync.js` 在归档同步成功后调用。这样不必改 `packages/server/index.js` 的装配，也让清理逻辑可单测。
- "拒绝已归档任务活跃上传"的守卫放在 `applyChangesInternal()` 事务内（同一文件），复用既有 `ARCHIVE_SYNC_SERVER_MANAGED` 错误码，不新增错误码、不改客户端协议。

## 数据流

```text
archive-git-sync.syncTaskSpace()
  ├─ snapshot.skipped（远程 HEAD 无变化）
  │    └─ purgeArchivedTaskFiles(db, taskSpaceId)
  │         needsIndex = needsIndex || purged > 0
  └─ importSnapshot() 提交后
       └─ purgeArchivedTaskFiles(db, taskSpaceId)
            needsIndex = imported.needsIndex || purged > 0
                    │
                    ├─ UPDATE sync_task_space_file (deleted=1, content_text=NULL, sha256=sha256(""))
                    ├─ INSERT sync_file_audit (operation='delete', old_sha256=原 sha, new_sha256=NULL)
                    └─ UPDATE sync_task_space SET revision=revision+1, status='indexing'
                          → 客户端增量拉取收到 tombstone → remove_task_directory()
                          → task-space-index 重建，看板只剩归档记录
```

## purgeArchivedTaskFiles 契约

```js
export function purgeArchivedTaskFiles(db, taskSpaceId, { now = () => new Date() } = {})
// → { purged: number, revision: number }
```

1. 读 `sync_task_space`：不存在 / `status='disabled'` / `retired_at` 非空 → 直接返回 `{ purged: 0, revision: 当前值 }`（停用空间不写）。
2. 从归档行反解活跃目录：
   ```js
   const ARCHIVE_DIR = /^\.trellis\/tasks\/archive\/\d{4}-(?:0[1-9]|1[0-2])\/([^/]+)$/
   function activeTaskDirOf(archiveDir) {
     const match = ARCHIVE_DIR.exec(String(archiveDir || '').trim())
     return match ? `.trellis/tasks/${match[1]}` : null
   }
   ```
   取 `SELECT DISTINCT task_dir FROM sync_archive_file WHERE task_space_id = ?` 映射成活跃目录集合（过滤 `null`）。
3. 选出待删行：
   ```sql
   SELECT f.relative_path, f.sha256, f.task_id, f.task_dir
   FROM sync_task_space_file f
   WHERE f.task_space_id = ?
     AND f.deleted = 0
     AND f.task_dir IN (/* 第 2 步的活跃目录，参数化占位符 */)
   ORDER BY f.relative_path
   ```
   - **按目录名对位，不按 `task_id`**：`task.json` 的 `id` 是 slug（`task_store.py:529`），同一 slug 在不同日期可重名（`id` 不唯一，`--slug` 可复用）；目录名 `${MM-DD}-${slug}` 在创建时校验"当前目录不存在且归档中不存在同名目录"（`task_store.py:463-471`），是唯一可对位的身份。
   - 不用 `sync_archive_file.task_id`（它只在 `task.json` 行非空，见 `archive-git-store.js:710-716`），也就不受部分行 `task_id = NULL` 影响。
4. 无匹配行 → 返回 `{ purged: 0, revision }`，**不递增 revision、不写审计**（幂等，也避免无改动时无谓索引重建）。
5. 有匹配行：`revision = 当前 revision + 1`，`timestamp = now().toISOString()`；逐行
   - `UPDATE sync_task_space_file SET deleted = 1, content_text = NULL, sha256 = ?, revision = ?, updated_at = ? WHERE task_space_id = ? AND relative_path = ? AND deleted = 0`
     - `sha256` 取 `snapshotSha256('')`（`e3b0c442…`），与客户端 tombstone 值一致（`task_sync.rs` 中 `snapshot_sha256("")`）。
     - 不动 `source_agent_id` / `source_user_id` / `source_client_sequence`：它们描述内容出处，删除事实由审计行记录。
   - `INSERT INTO sync_file_audit(task_space_id, relative_path, task_id, operation, old_sha256, new_sha256, revision, source_user_id, source_agent_id, occurred_at) VALUES (?, ?, ?, 'delete', ?, NULL, ?, NULL, NULL, ?)`
6. `UPDATE sync_task_space SET revision = ?, status = 'indexing', updated_at = ? WHERE id = ? AND status != 'disabled' AND retired_at IS NULL`；`changes !== 1` → 抛 `409 PROJECT_NOT_READY`「任务空间已停用」（与 `applyChangesInternal` 一致）。
7. 整个函数在 `withTransaction(db, ...)` 内执行。

## 活跃上传守卫

`applyChangesInternal()` 中，`const complete = validateCompleteTaskGroups(...)` 之后：

```js
if (files.some((file) => !file.deleted)) {
  const archivedDirs = new Set(
    db
      .prepare('SELECT DISTINCT task_dir FROM sync_archive_file WHERE task_space_id = ?')
      .all(taskSpaceId)
      .map((row) => activeTaskDirOf(row.task_dir))
      .filter(Boolean),
  )
  if (archivedDirs.has(complete.taskDir)) {
    throw teamError(409, ARCHIVE_SYNC_SERVER_MANAGED, '归档任务由服务端 Git 索引管理，不能推送活跃文件')
  }
}
```

- 只拦非删除批次；纯 `deleted:true` 批次继续放行（客户端清理残留）。
- 一个批次只承载一个任务（`validateCompleteTaskGroups` 返回单个 `complete`），用 `complete.taskDir`（`file.taskDir` 已在 `rejectArchiveGroups` 后统一）判定即可。
- 归档目录集合很小（每空间几十个），一次 `SELECT DISTINCT` 走 `sync_archive_file_task` 索引。

## 兼容与回滚

- 无 schema 变更、无迁移、无协议变更 → 回滚只需还原两个文件的代码提交；已删除的行是 `deleted=1` 的软删除，回滚后重新上传即可恢复（不含自动回补逻辑，符合"归档是权威"的语义）。
- 部署顺序不敏感：旧服务端 + 新服务端并存期间，旧服务端只表现为不清理（回到现状），无新增失败路径。
- `snapshot.skipped` 分支同样执行清理：升级后第一次同步即可修掉历史脏数据，无需等待归档 ref 变化。
- 客户端行为不变：tombstone 走既有 `deleted_dirs` → `remove_task_directory()` 路径；若本地目录有未提交改动，走既有 `pendingReview` 差异流程，不静默删除。

## 备选方案（已评估，未采用）

- **读取侧反连接屏蔽**（`fileRows` / `preflight` / `readFileMetadata` 增加 `NOT EXISTS (sync_archive_file ...)`）：不递增 revision、不重建索引，看板与客户端残留要等下次无关改动才收敛；且不阻止客户端继续把已归档任务当活跃目录上传。作为长期兜底可与本方案叠加，但不作为主修复。
- **在 `applyChangesInternal` 内清理**：清理时机取决于上传，解绑窗口内归档的删除永远不会触发，无法覆盖事故场景。
