# Implementation Plan: Worktree 分支标识与服务端差异化归档同步

## Ordered Checklist

### Step 1: Server DB Schema v19 迁移
- [ ] 新增 `packages/server/database-sql/v19.js`，定义 `sync_task_space.is_worktree INTEGER NOT NULL DEFAULT 0`
- [ ] 更新 `packages/server/database-sql/index.js` 升级 `DATABASE_SCHEMA_VERSION = 19` 并导出 v19 定义
- [ ] 更新 `packages/server/database-migrations.js` 新增 `ensureV19Schema(db)`
- [ ] 更新 `packages/server/database.js` 允许版本 19 并调用 `ensureV19Schema(db)`
- [ ] 更新相关数据库测试断言（`database.test.js`、`database-v10.test.js`、`plugin-store.test.js`）并新增 v18 -> v19 迁移用例

### Step 2: Server TaskSpace Attach、Detach 自动弃用与 View 支持 `isWorktree`
- [ ] 更新 `packages/server/team/task-space/shared.js`：`insertTaskSpace` 支持 `is_worktree`；新增 `updateTaskSpaceWorktree` 与重置 `sync_archive_sync_state` 的 SQL 语句
- [ ] 更新 `packages/server/team/task-space/attach.js`：解析 `input.isWorktree`，实现基线分支保护、新建写入、普通分支升级回 `0`、存量 worktree 补标 `1`（清除归档错误并触发回调）、以及已弃用 worktree 同名重建时的自动恢复（`restoreTaskSpace`）
- [ ] 更新 `packages/server/team/task-space/bindings.js`：`detachAgent` 在 `is_worktree = 1` 且最后一个 `approved` 绑定解绑时自动弃用任务空间（`retireTaskSpace` + 审计日志）
- [ ] 更新 `packages/server/team/task-space/view.js`：`taskSpacePublic` 输出 `isWorktree`
- [ ] 在 `packages/server/team/http.js`（或服务装配处）将 `onTaskSpaceWorktreeMarked` 连接到 `archiveGitSync.clearBackoff` 与 `taskSpaceIndex.enqueue`
- [ ] 在 `packages/server/test/team-task-spaces.test.js` 补充用例：worktree attach/补标/升级、最后一个绑定 detach 自动弃用、同名重建自动恢复、普通分支 detach 不自动弃用

### Step 3: Server Archive Git Sync 差异化处理
- [ ] 更新 `packages/server/team/archive-git-sync.js`：
  - `activeTaskSpaces` 默认过滤 `is_worktree = 0`，`overview()` / `listLogs()` 使用 `includeWorktree: true`
  - `runNow(taskSpaceId)` 对 `is_worktree = 1` 返回 409 `WORKTREE_ARCHIVE_SYNC_SKIPPED`
  - `overview()` 对 `is_worktree = 1` 返回 `isWorktree: true`、`status: 'worktree_skipped'`、`lastError: null`、`nextAttemptAt: null`
  - 暴露 `clearBackoff(taskSpaceId)`
- [ ] 在 `packages/server/test/archive-git-sync.test.js` 新增用例：worktree 跳过定时/全量同步、单空间拒绝、overview 状态为 `worktree_skipped`

### Step 4: Server 控制面 `sync_task` 收敛
- [ ] 更新 `packages/server/team/task-index/index-write.js`：向 `reconcileProjection` 传入 `isWorktree: Boolean(latest.is_worktree)`
- [ ] 更新 `packages/server/team/task-control/projection.js`：`isWorktree === true` 时收敛已物化但不在活跃投影中的 `sync_task` 行（保留 `pending`/`claimed` 不误杀）
- [ ] 在 `packages/server/test/team-task-control.test.js`（或新增测试）验证：worktree 任务删除后 `sync_task` 自动归档、`pending`/`claimed` 不被误归档、普通分支不受影响、存量补标后触发重索引收敛

### Step 5: Desktop Agent 打标与存量自愈
- [ ] 更新 `packages/desktop/src-tauri/src/agent/store.rs`：`AgentBinding` 新增 `#[serde(default)] pub is_worktree: bool`
- [ ] 更新 `packages/desktop/src-tauri/src/agent/onboarding.rs`：`AttachOptions.is_worktree`、请求体 `"isWorktree"`、`AttachedTaskSpace.is_worktree`
- [ ] 更新 `packages/desktop/src-tauri/src/agent/association.rs`：传入 `is_worktree: false`
- [ ] 更新 `packages/desktop/src-tauri/src/agent/worktree/mod.rs`：`attach` 传入 `is_worktree: true`，并在 `reconcile_inner` 增加存量未打标 worktree 的幂等补标逻辑
- [ ] 补充 Rust 单元测试（`cargo test`）

### Step 6: Web 管理端展示
- [ ] 更新 `packages/web/src/api/admin/types.ts`、`readers.ts`：`ArchiveTaskSpaceSync.isWorktree`
- [ ] 更新 `packages/web/src/features/admin/archive-sync-format.ts`、`packages/web/src/lib/admin-shared.ts`：新增 `worktree_skipped: 'Worktree · 免归档同步'` 及其 neutral tone
- [ ] 更新 `packages/web/src/features/admin/ArchiveSyncTaskSpaceRow.tsx`：worktree 行展示“Worktree · 免归档同步”，隐藏“立即同步”按钮与无效报错
- [ ] 补充前端单测并执行类型检查与 lint

### Step 7: API E2E 验证与全量检查
- [ ] 按 `trellis-api-e2e` 对本地后端执行一轮 API E2E 验证（attach worktree -> archive-sync overview/runNow -> 删除任务收敛 `/api/agent/task-spaces/:id/tasks`），并输出 `{TASK_DIR}/api-e2e-report.md`
- [ ] 运行全量相关测试、类型检查、格式化与 lint，编写 `{TASK_DIR}/check-report.md`

## Validation Commands

- Server tests: `npm --workspace @trellis-board/server test`（及针对性运行 `node --test packages/server/test/archive-git-sync.test.js packages/server/test/team-task-control.test.js packages/server/test/database.test.js packages/server/test/database-v10.test.js packages/server/test/team-task-spaces.test.js`）
- Desktop Rust tests: `cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml`
- Web typecheck & tests: `npm --workspace @trellis-board/web run typecheck` && `npm --workspace @trellis-board/web test`
- Format & Lint: Prettier + ESLint on changed files

## Risky Files & Rollback Points

- `packages/server/database.js` / `database-migrations.js`：Schema v19 升级需确保 v18 -> v19 迁移幂等且 `backupBeforeUpgrade` 正常。
- `packages/server/team/task-control/projection.js`：必须严格限定 `isWorktree === true && row.materialization_state === 'materialized'`，避免影响普通分支或误杀待物化任务。
- `packages/desktop/src-tauri/src/agent/worktree/mod.rs`：存量补标需走退避重试且仅在 `!binding.is_worktree` 时触发一次，避免死循环请求服务端。
