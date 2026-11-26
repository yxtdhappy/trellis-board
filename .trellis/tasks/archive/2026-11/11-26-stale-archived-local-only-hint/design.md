# 技术设计：已归档任务接入误报及 `deferred` 残留自愈

## 1. 架构与修改边界

本次修复涉及两个包，不改动数据库 Schema 和前端组件，保持前后端既有协议兼容：

| 包 | 模块 / 文件 | 职责 |
|---|---|---|
| `packages/server` | `team/task-space/shared.js`, `team/task-space/access.js` | `preflight` 汇总 `archivedTaskBasenames` 时补充查询当前活跃归档快照的 `sync_archive_file` |
| `packages/server` | `team/task-control/shared.js`, `team/task-control/views.js`, `team/task-control/uploads.js` | `assertReadable` 与 `assertUploadAllowed` 判断同名已归档任务时补充查询当前活跃归档快照的 `sync_archive_file` |
| `packages/desktop` | `src-tauri/src/agent/task_sync/cursor.rs` | `local_sync_state_from_groups` 在 `local_state.is_empty()` 且两端均无基线时移除 `deferred` |
| `packages/desktop` | `src-tauri/src/agent/task_sync/upload.rs` | `prunable_task_directories` 同时检查 `cursor.baselines` 与 `cursor.deferred` |

## 2. 服务端设计

### 2.1 活跃归档快照查询口径

与 `packages/server/team/task-space-index.js:294-300, 368-370` 保持一致：
一个任务空间当前生效的归档快照 ID 为 `COALESCE(s.archive_candidate_snapshot_id, s.archive_snapshot_id)`（或与 `readFileMetadata` 相同，常规以 `s.archive_snapshot_id` 为主；注意 `archive_candidate_snapshot_id` 仅在发布中短暂非空，最终会切到 `archive_snapshot_id`）。为避免读写口径漂移，使用：

```sql
SELECT DISTINCT f.task_dir
FROM sync_archive_file f
JOIN sync_task_space s ON s.id = f.task_space_id
WHERE f.task_space_id = ?
  AND (
    f.snapshot_id = COALESCE(s.archive_candidate_snapshot_id, s.archive_snapshot_id)
    OR (
      COALESCE(s.archive_candidate_snapshot_id, s.archive_snapshot_id) IS NULL
      AND f.snapshot_id IS NULL
    )
  )
```

### 2.2 `preflight` 归档目录名补充

- 在 `packages/server/team/task-space/shared.js` 新增语句 `preflightArchivedDirs`（按上述 SQL 查询当前任务空间的归档 `task_dir`）。
- 在 `packages/server/team/task-space/access.js` 的 `preflight` 中遍历 `preflightArchivedDirs.all(resolved.taskSpace.id)`：
  - 将 `dir` 加入 `hiddenTaskDirSet`（可选，保持一致）；
  - 提取末段 `basename = dir.split('/').filter(Boolean).pop()`，加入 `archivedBasenameSet`。
- 返回结构不变，仍为 `{ hiddenTaskDirs, archivedTaskBasenames }`，客户端 `association.rs` 无需改动即可自动过滤。

### 2.3 `assertReadable` 与 `assertUploadAllowed` 归档拦截

- 在 `packages/server/team/task-control/shared.js` 中扩展归档按 basename 查询（或新增 `readArchivedFileByBasename`）：
  ```sql
  SELECT 1
  FROM sync_archive_file f
  JOIN sync_task_space s ON s.id = f.task_space_id
  WHERE f.task_space_id = ?
    AND (
      f.snapshot_id = COALESCE(s.archive_candidate_snapshot_id, s.archive_snapshot_id)
      OR (
        COALESCE(s.archive_candidate_snapshot_id, s.archive_snapshot_id) IS NULL
        AND f.snapshot_id IS NULL
      )
    )
    AND f.task_dir LIKE ? ESCAPE '\'
  LIMIT 1
  ```
- 抽取辅助函数 `isArchivedByBasename(taskSpaceId, taskDir)`：
  - 提取 `basename` 并转义 `\`、`%`、`_`，构造 `.trellis/tasks/archive/%/${escaped}`。
  - 先查 `statements.readArchivedTaskByBasename`，未命中再查 `statements.readArchivedFileByBasename`。
- **`views.js` (`assertReadable`)**：复用 `isArchivedByBasename`，命中抛出 `teamError(409, 'TASK_ARCHIVED', '任务已归档')`。
- **`uploads.js` (`assertUploadAllowed`)**：当 `row` 不存在（即 `sync_task` 中无记录，准备按新任务上传）时，先检查 `isArchivedByBasename(taskSpaceId, complete.taskDir)`，命中抛出 `teamError(409, 'TASK_ARCHIVED', '任务已归档，拒绝旧客户端重新写回')`。

## 3. 桌面端设计

### 3.1 `cursor.rs`：`local_sync_state_from_groups`

当前逻辑（`cursor.rs:90-105`）：
```rust
if let Some(deferred_state) = cursor.deferred.get(&task_dir) {
    if local_state.is_empty() {
        continue;
    }
    ...
}
```

修改为：
```rust
if let Some(deferred_state) = cursor.deferred.get(&task_dir) {
    if local_state.is_empty() {
        let has_server_baseline = server_baselines
            .get(task_dir.as_str())
            .is_some_and(|baseline| !baseline.is_empty());
        let has_cursor_baseline = cursor_baselines
            .get(task_dir.as_str())
            .is_some_and(|baseline| !baseline.is_empty());
        if !has_server_baseline && !has_cursor_baseline {
            next_deferred.remove(&task_dir);
        }
        continue;
    }
    ...
}
```

**边界分析**：
- 场景 1（`missing_local_directory_keeps_deferred_protected`）：服务端有基线（`has_server_baseline == true`）或 cursor 有基线（`has_cursor_baseline == true`）→ 保持 `deferred`，直接 `continue`，不加入 `dirty`，防误删服务端任务。
- 场景 2（本次 bug：滞后分支 local-only 进入 `deferred`，更新分支后归档/删除）：`local_state.is_empty() == true`，且 `has_server_baseline == false && has_cursor_baseline == false` → 从 `next_deferred` 移除，并 `continue`（不进入后续 `dirty` 判定）。
- 场景 3（`pull.rs:488-498`）：检测到 `deferred != cursor.deferred` 后自动 `write_cursor`，`write_cursor` 调用 `notify_state_changed()`，前端左侧项目区域即时更新。

### 3.2 `upload.rs`：`prunable_task_directories`

当前签名（`upload.rs:1034-1055`）：
```rust
pub(super) fn prunable_task_directories(
    entries: &[(String, Option<SnapshotGroup>, Vec<SnapshotFile>)],
    baselines: &BTreeMap<String, String>,
    existing_local_dirs: &HashSet<String>,
) -> Vec<String>
```

扩展参数接收 `deferred: &BTreeMap<String, BTreeMap<String, String>>`：
- 当 `server_files.is_empty()` 且 `!existing_local_dirs.contains(task_dir)` 时，只要 `baselines` 中包含该目录前缀 **或者** `deferred.contains_key(task_dir)`，即纳入可清理列表 `dirs`。
- `upload_directories` 随后调用 `self.remove_task_dir_cursor_state(&task_space_id, &cleared_dirs)`，内部通过 `write_cursor` 删除 `deferred` 条目并触发 `notify_state_changed()`。

## 4. 兼容性与风险权衡

- **向后兼容**：服务端接口返回结构与错误码（`409 TASK_ARCHIVED`）完全复用既有契约，老客户端也能兼容。
- **防误删安全性**：`local_sync_state_from_groups` 仅在 `server_baselines` 与 `cursor_baselines` 均无该目录时才清理 `deferred`，不会放开服务端已有任务的删除上传。
- **回滚方式**：纯代码逻辑修复，无 DB 迁移，可直接回退对应 commit。
