# Design: Worktree 分支标识与服务端差异化归档同步

## 1. 架构与边界

本次改动跨越三层，但数据流单向清晰：

```
Desktop Agent (Rust)
  WorktreeService::attach (is_worktree = true)
  Association::associate_project (is_worktree = false)
        │  POST /api/agent/task-spaces/attach { ..., isWorktree }
        ▼
Server (Node.js + SQLite v19)
  sync_task_space.is_worktree (0 | 1)
   ├── archive-git-sync.js: 跳过 is_worktree=1 的远端拉取；overview 映射为 worktree_skipped
   ├── task-index/index-write.js -> task-control/projection.js:
   │     is_worktree=1 时，将已物化但活跃快照已消失的 sync_task 收敛为 archived=1
   └── task-space/view.js: 输出 isWorktree 字段
        │  GET /api/admin/archive-sync & GET /api/agent/task-spaces/:id/tasks
        ▼
Web UI & Desktop Visibility
  admin.html 归档同步页: 展示 "Worktree · 免归档同步"（无同步按钮、无报错）
  Desktop WorktreeService::update_visibility: server_active_task_count 归零 -> 解除 "等待归档同步"
```

## 2. 数据库设计与迁移（Schema v18 -> v19）

- 新增 [v19.js](file:///C:/projects/trellis-board/packages/server/database-sql/v19.js)：
  - `SCHEMA_V19_TASK_SPACE_COLUMNS = [['is_worktree', 'INTEGER NOT NULL DEFAULT 0']]`
- 更新 [index.js](file:///C:/projects/trellis-board/packages/server/database-sql/index.js)：
  - `DATABASE_SCHEMA_VERSION = 19`
  - 导出 `SCHEMA_V19_TASK_SPACE_COLUMNS` / `SCHEMA_V19_SQL`
- 更新 [database-migrations.js](file:///C:/projects/trellis-board/packages/server/database-migrations.js)：
  - 新增 `ensureV19Schema(db)`：通过 `hasColumn(db, 'sync_task_space', 'is_worktree')` 幂等执行 `ALTER TABLE sync_task_space ADD COLUMN is_worktree INTEGER NOT NULL DEFAULT 0`。
- 更新 [database.js](file:///C:/projects/trellis-board/packages/server/database.js)：
  - 允许的版本数组新增 `19`；事务内调用 `ensureV19Schema(db)`。

## 3. 接口与数据契约

### 3.1 `POST /api/agent/task-spaces/attach`
- 请求体新增可选字段：`isWorktree?: boolean`（缺省 `false`）。
- 服务端 [attach.js](file:///C:/projects/trellis-board/packages/server/team/task-space/attach.js) 规则：
  - `const requestedWorktree = input.isWorktree === true`
  - `const isBaseline = Boolean(project.baseline_branch && branchName === project.baseline_branch)`
  - `const desiredWorktree = requestedWorktree && !isBaseline ? 1 : 0`
  - 新建 `sync_task_space`：直接写入 `is_worktree = desiredWorktree`。
  - 复用已有 `sync_task_space`：
    - 若 `desiredWorktree === 0 && Number(taskSpace.is_worktree) === 1`：更新 `is_worktree = 0`（普通仓库接管同一分支，恢复归档同步）。
    - 若 `desiredWorktree === 1 && Number(taskSpace.is_worktree) === 0`：检查 `sync_archive_sync_state.last_success_at` 是否为 `NULL`（从未成功同步过远端归档）；若为 `NULL`，更新 `is_worktree = 1`，并将 `sync_archive_sync_state` 中该空间的 `status = 'idle', last_error = NULL` 重置，同时在事务外触发 `onTaskSpaceWorktreeMarked(taskSpace.id)`（清理 `archiveGitSync` 退避并入队一次 `taskSpaceIndex.enqueue(taskSpace.id)`，使存量幽灵 `sync_task` 立刻收敛）。
- 响应体 `taskSpace`（[view.js](file:///C:/projects/trellis-board/packages/server/team/task-space/view.js)）：新增 `isWorktree: Boolean(row.is_worktree)`。

### 3.2 `GET /api/admin/archive-sync` 与 `POST /api/admin/archive-sync/run`
- [archive-git-sync.js](file:///C:/projects/trellis-board/packages/server/team/archive-git-sync.js)：
  - `activeTaskSpaces(taskSpaceId, { includeWorktree = false } = {})`：
    - 调度 `runDueTaskSpaces()`、`tick()`、全量 `runNow(null)`、凭据测试 `testCredential` 默认 `includeWorktree: false`（SQL 条件追加 `AND COALESCE(s.is_worktree, 0) = 0`）。
    - `overview()` 与 `listLogs()` 使用 `includeWorktree: true`。
    - `runNow(taskSpaceId)` 当指定 `taskSpaceId` 时，若该空间 `is_worktree === 1`，抛出 `teamError(409, 'WORKTREE_ARCHIVE_SYNC_SKIPPED', 'Worktree 分支免远端归档同步')`。
  - `overview()` 对 `is_worktree === 1` 的空间返回：
    ```js
    {
      ...baseFields,
      isWorktree: true,
      status: 'worktree_skipped',
      lastError: null,
      nextAttemptAt: null,
    }
    ```
  - 暴露 `clearBackoff(taskSpaceId)` 供 `attach` 补打标时清理内存中的重试退避。

### 3.3 控制面 `sync_task` 收敛（[projection.js](file:///C:/projects/trellis-board/packages/server/team/task-control/projection.js)）
- [index-write.js](file:///C:/projects/trellis-board/packages/server/team/task-index/index-write.js) 调用 `taskControl?.reconcileProjection` 时新增参数 `isWorktree: Boolean(latest.is_worktree)`。
- 在 `reconcileProjection({ taskSpaceId, projectId, tasks: taskList, isWorktree = false })` 末尾：
  - 若 `isWorktree` 为 `true`：
    - 构造 `activeExecutionKeys`：所有 `authoritativeTasks` 中 `!task.archived` 的 `executionTaskKey`。
    - 查询该 `taskSpaceId` 下所有 `sync_task` 行（`statements.readSpaceTasks.all(taskSpaceId)`）。
    - 对满足以下全部条件的行执行归档收敛：
      1. `!row.archived`
      2. `row.materialization_state === 'materialized'`
      3. `!activeExecutionKeys.has(row.execution_task_key)`
    - 执行：
      - `statements.archiveProjectionTask.run(row.task_key, row.relative_dir, timestamp, timestamp, row.execution_task_key)`
      - `leases.revokeLeases(row.execution_task_key, timestamp)`
      - `statements.resolveArchivedConflicts.run(timestamp, taskSpaceId, row.relative_dir, row.task_id)`
- **为什么安全**：
  - `pending` / `claimed` 状态的任务尚未物化到本地磁盘，天然不在 `activeExecutionKeys` 中，通过 `materialization_state === 'materialized'` 守卫严格保护。
  - 若后续该 worktree 上又重建/恢复了同名任务，任务会重新出现在活跃快照中；且若同一任务已合入基线分支（`dev`），基线分支的归档同步会正常拥有其完整归档记录。

### 3.4 Worktree 删除解绑自动弃用与同名重建恢复（[bindings.js](file:///C:/projects/trellis-board/packages/server/team/task-space/bindings.js) & [attach.js](file:///C:/projects/trellis-board/packages/server/team/task-space/attach.js)）
- **`POST /api/agent/task-spaces/:id/detach`（`bindings.js:detachAgent`）**：
  - 在 `statements.revokeBinding.run(timestamp, binding.id)` 之后，检查：
    - `Number(taskSpace.is_worktree) === 1`
    - `taskSpace.branch_name !== project.baseline_branch`
    - `!taskSpace.retired_at && taskSpace.status === 'active'`
    - `Number(statements.approvedBindingCount.get(spaceId).count || 0) === 0`
  - 满足全部条件时，在同一事务内自动弃用该任务空间：
    - `statements.retireTaskSpace.run(timestamp, userId, 'worktree 本地已删除并解绑', timestamp, spaceId, project.id)`
    - `statements.cancelCommandsForTaskSpace.run(timestamp, spaceId)`
    - 写入审计事件 `action: 'task_space_retired'`（`detail.autoRetiredWorktree = true`）。
  - 返回值中补充 `taskSpaceRetired: true`（向后兼容，客户端忽略未知字段）。
- **`POST /api/agent/task-spaces/attach`（`attach.js:attach`）**：
  - 当命中已有的 `taskSpace` 且 `taskSpace.retired_at` 非空时：
    - 若 `Number(taskSpace.is_worktree) === 1 && project.status === 'active'`（此前是 worktree 分支自动或手动弃用），自动调用 `statements.restoreTaskSpace.run(timestamp, taskSpace.id, project.id)` 恢复为 `status = 'active', retired_at = NULL`，并按本次请求的 `desiredWorktree` 更新 `is_worktree`，写入 `task_space_restored` 审计事件；
    - 否则（普通分支被管理员手动停用/弃用）仍按原逻辑抛出 409 `PROJECT_NOT_READY`。

## 4. 客户端改动（`packages/desktop`）

1. [store.rs](file:///C:/projects/trellis-board/packages/desktop/src-tauri/src/agent/store.rs)：`AgentBinding` 新增 `#[serde(default)] pub is_worktree: bool`。
2. [onboarding.rs](file:///C:/projects/trellis-board/packages/desktop/src-tauri/src/agent/onboarding.rs)：
   - `AttachOptions` 新增 `pub is_worktree: bool`。
   - `attach_project` 请求体增加 `"isWorktree": options.is_worktree`，写入 `AgentBinding.is_worktree = options.is_worktree`（或以服务端返回 `attached.task_space.is_worktree` 为准）。
   - `AttachedTaskSpace` 新增 `#[serde(default)] pub is_worktree: bool`。
3. [association.rs](file:///C:/projects/trellis-board/packages/desktop/src-tauri/src/agent/association.rs)：调用 `attach_project` 传入 `is_worktree: false`。
4. [worktree/mod.rs](file:///C:/projects/trellis-board/packages/desktop/src-tauri/src/agent/worktree/mod.rs)：
   - `WorktreeService::attach` 传入 `is_worktree: true`。
   - 存量自愈：在 `reconcile_inner` 处理已存在的 `approved` 绑定（`entry.auto_managed && same_space`）时，若 `!binding.is_worktree && now >= entry.next_retry_at`，调用轻量补标 helper（向 `POST /api/agent/task-spaces/attach` 携带 `isWorktree: true`），成功后将 `binding.is_worktree = true` 持久化到 `config.json`（失败则走普通退避，不影响现有同步）。

## 5. 前端展示改动（`packages/web`）

1. [types.ts](file:///C:/projects/trellis-board/packages/web/src/api/admin/types.ts) & [readers.ts](file:///C:/projects/trellis-board/packages/web/src/api/admin/readers.ts)：`ArchiveTaskSpaceSync` 新增 `isWorktree: boolean`。
2. [archive-sync-format.ts](file:///C:/projects/trellis-board/packages/web/src/features/admin/archive-sync-format.ts)：`STATUS_LABELS` 新增 `worktree_skipped: 'Worktree · 免归档同步'`。
3. [admin-shared.ts](file:///C:/projects/trellis-board/packages/web/src/lib/admin-shared.ts)：确认 `statusTone('worktree_skipped')` 映射为 `'neutral'`。
4. [ArchiveSyncTaskSpaceRow.tsx](file:///C:/projects/trellis-board/packages/web/src/features/admin/ArchiveSyncTaskSpaceRow.tsx)：
   - `taskSpace.isWorktree` 为 `true` 时：隐藏“立即同步”按钮；状态 Pill 显示 `Worktree · 免归档同步`；隐藏凭据状态缺失提示及无意义的 `Commit`/`下次自动尝试` 行（仅保留简洁说明“Worktree 分支一般不推送远端，归档随基线分支同步”）。

## 6. 兼容性与回滚

- **旧客户端连新服务端**：`isWorktree` 缺省视为 `false`，行为与旧版 100% 兼容。
- **新客户端连旧服务端**：旧服务端忽略未知 JSON 字段 `isWorktree`，响应缺省 `isWorktree` 由 Rust `#[serde(default)]` 反序列化为 `false`，不报错。
- **回滚**：SQLite v19 仅新增带默认值的列 `sync_task_space.is_worktree`，升级前已有 `backupBeforeUpgrade` 自动备份，可无损回退代码版本。
