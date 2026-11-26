# 根因调研：滞后分支已归档任务接入误报「仅本地存在」及更新分支后提示不消除

## 1. 现象复现路径

1. 远端最新分支中任务 `11-XX-foo` 已归档（移至 `.trellis/tasks/archive/<YYYY-MM>/11-XX-foo`），服务端通过 Git 归档同步将归档文件写入 `sync_archive_file`（可能没有对应的 `sync_task.archived = 1` 记录）。
2. 本地分支落后，工作区仍保留未归档目录 `.trellis/tasks/11-XX-foo`。
3. 客户端接入本地项目：
   - **预检弹窗**：提示存在 1 个「仅本地存在 / 可上传任务」。
   - **接入后（如 `safe` 模式）**：该任务进入 `cursor.deferred`，左侧项目区域持续展示 `已关联 · 1 个本地任务未同步`（[packages/web/src/components/layout/project-rail/association.ts:282-291](packages/web/src/components/layout/project-rail/association.ts)）。
4. 用户在本地 `git pull` 更新分支后，`.trellis/tasks/11-XX-foo` 已被归档/移出活跃目录，但左侧项目区域的提示始终不会消除。

## 2. 根因链（代码证据）

### 根因 A：服务端归档判定遗漏 `sync_archive_file`

服务端通过 Git 归档同步（`packages/server/team/archive-git-sync.js`）拉取的归档任务只写入 `sync_archive_file` 表（通过 `sync_task_space.archive_snapshot_id` 指向当前活跃归档快照，旧数据可能为 `snapshot_id IS NULL`），**不会自动在 `sync_task` 表生成 `archived = 1` 记录**。

以下三处服务端检查均只查询了 `sync_task`：

1. **预检接口 `preflight`**
   - [packages/server/team/task-space/access.js:356-378](packages/server/team/task-space/access.js)
   - [packages/server/team/task-space/shared.js:137-142](packages/server/team/task-space/shared.js)
   - `preflightHiddenTasks` 仅查询 `sync_task WHERE task_space_id = ? AND (archived = 1 OR ...)`，未查询 `sync_archive_file`。因此 `archivedTaskBasenames` 不包含仅存在于 `sync_archive_file` 的已归档任务名。
   - 桌面端 [packages/desktop/src-tauri/src/agent/association.rs:273-289](packages/desktop/src-tauri/src/agent/association.rs) 依赖 `archivedTaskBasenames` 过滤 `DiffKind::LocalOnly`，漏过滤导致预检误报。

2. **目录读取接口 `assertReadable`（桌面端 `fetch_directory`）**
   - [packages/server/team/task-control/views.js:77-96](packages/server/team/task-control/views.js)
   - [packages/server/team/task-control/shared.js:327-331](packages/server/team/task-control/shared.js)
   - `readArchivedTaskByBasename` 仅查 `sync_task WHERE archived = 1 AND relative_dir LIKE ?`，未查 `sync_archive_file`。
   - 桌面端首次同步和拉取时的归属闸门 `gate_local_only_differences`（[packages/desktop/src-tauri/src/agent/task_sync/initial_sync.rs:445-487](packages/desktop/src-tauri/src/agent/task_sync/initial_sync.rs)）调用 `fetch_directory` 后收到 `404` 而非 `409 TASK_ARCHIVED`，未能剔除该已归档任务，使其在 `safe` 模式下落入 `cursor.deferred`。

3. **上传准入接口 `assertUploadAllowed`**
   - [packages/server/team/task-control/uploads.js:53-70](packages/server/team/task-control/uploads.js)
   - 当 `sync_task` 无记录时，未检查 `sync_archive_file` 是否已有同名归档目录；若旧客户端/滞后分支尝试上传该任务，可能会把已归档任务复活为活跃任务。

### 根因 B：桌面端 `local_sync_state_from_groups` 在本地目录消失且服务端无基线时不清理 `deferred`

- [packages/desktop/src-tauri/src/agent/task_sync/cursor.rs:90-105](packages/desktop/src-tauri/src/agent/task_sync/cursor.rs)：
  ```rust
  if let Some(deferred_state) = cursor.deferred.get(&task_dir) {
      if local_state.is_empty() {
          continue;
      }
      ...
  }
  ```
- 原先的保护逻辑（单测 `missing_local_directory_keeps_deferred_protected`，[packages/desktop/src-tauri/src/agent/task_sync/tests/pull_and_startup.rs:716-731](packages/desktop/src-tauri/src/agent/task_sync/tests/pull_and_startup.rs)）针对的是**服务端基线/cursor 基线中仍存在该任务**，而本地目录临时缺失的场景，避免将缺失误判为删除上传到服务端。
- 当任务原本是 `local-only`（`server_baselines` 与 `cursor_baselines` 中均无该 `task_dir`），本地更新分支后该活跃任务目录已不存在（`local_state.is_empty()`），两端均无该活跃任务，继续 `continue` 会导致 `task_dir` 永远滞留在 `cursor.deferred`，左侧项目区域的「N 个本地任务未同步」提示永不消除。

### 根因 C：桌面端 `prunable_task_directories` 未纳入 `cursor.deferred`

- [packages/desktop/src-tauri/src/agent/task_sync/upload.rs:202-220](packages/desktop/src-tauri/src/agent/task_sync/upload.rs)
- [packages/desktop/src-tauri/src/agent/task_sync/upload.rs:1034-1055](packages/desktop/src-tauri/src/agent/task_sync/upload.rs)
- 当本地 `git pull` 删除/移走 `.trellis/tasks/<slug>` 触发文件监听 `upload_dirty` 时，`upload_directories` 收到服务端 404 且确认本地目录不存在，调用 `prunable_task_directories` 清理陈旧 cursor 状态；但该函数仅检查 `cursor.baselines`，未检查 `cursor.deferred`，导致仅在 `cursor.deferred` 中的条目不会被清理。
- `write_cursor`（[packages/desktop/src-tauri/src/agent/task_sync/cursor.rs:430](packages/desktop/src-tauri/src/agent/task_sync/cursor.rs)）已会在写入后调用 `self.notify_state_changed()`，只要 `deferred` 成功收敛写回 cursor，前端左侧项目区域即可及时刷新。

## 3. 相关规范与参考

- `packages/server/team/task-space-index.js:287-303, 368-370`：`sync_archive_file` 读取当前活跃归档快照的约定（`snapshot_id = s.archive_snapshot_id OR (s.archive_snapshot_id IS NULL AND f.snapshot_id IS NULL)`）。
- 需关注 `packages/server` 和 `packages/desktop` 相关 spec 与回归测试。
