# Worktree 分支标识与服务端差异化归档同步

## Goal

客户端自动发现并接入 Git worktree 分支时，显式向服务端标记该分支为 worktree 分支；服务端持久区分 worktree 分支与普通分支，在归档同步、控制面投影与解绑生命周期中区别对待，彻底解决未推送到远端的 worktree 分支在归档合并或本地删除后：
1. 服务端 `archive-git-sync` 持续报 `ARCHIVE_BRANCH_MISSING: Git 远端不存在该任务空间的归档分支`；
2. 服务端控制面表 `sync_task` 残留 `archived = 0` 的幽灵记录，导致客户端永久停留在“等待归档同步”状态无法自动隐藏；
3. 本地删除 worktree 自动解绑后，服务端仍保留 `active` 且无绑定的僵尸 worktree 分支，导致看板侧边栏红字提示“无客户端关联”。

## Background & Confirmed Facts

- **客户端 worktree 发现与接入**：
  - [discovery.rs](file:///C:/projects/trellis-board/packages/desktop/src-tauri/src/agent/worktree/discovery.rs#L63-L100) 通过 `git worktree list --porcelain` 识别非主工作树（`index > 0`），自动接入经 [mod.rs](file:///C:/projects/trellis-board/packages/desktop/src-tauri/src/agent/worktree/mod.rs#L473-L517) 调用 [onboarding.rs](file:///C:/projects/trellis-board/packages/desktop/src-tauri/src/agent/onboarding.rs#L893-L934) 向 `POST /api/agent/task-spaces/attach` 提交绑定，目前未携带 worktree 标识。
  - 普通主仓库接入经 [association.rs](file:///C:/projects/trellis-board/packages/desktop/src-tauri/src/agent/association.rs#L107-L122) 调用同一个 `attach_project`。
- **服务端数据与归档同步**：
  - 当前数据库 schema 版本为 `18`（[index.js](file:///C:/projects/trellis-board/packages/server/database-sql/index.js#L1)），`sync_task_space` 表（[v11.js](file:///C:/projects/trellis-board/packages/server/database-sql/v11.js#L52)）无分支类型字段。
  - [archive-git-sync.js](file:///C:/projects/trellis-board/packages/server/team/archive-git-sync.js#L90-L108) 无差别拉取所有活跃 `sync_task_space` 的远端同名分支，未 push 的 worktree 分支持续在 [archive-git-store.js](file:///C:/projects/trellis-board/packages/server/team/archive-git-store.js#L52) 抛出 `ARCHIVE_BRANCH_MISSING`。
- **控制面与客户端可见性死锁**：
  - worktree 本地归档任务后，活跃文件上报删除，`sync_task_space_file` 与 `sync_task_index` 清空（`/api/team/projects` 显示 `activeTaskCount = 0`）。
  - [projection.js](file:///C:/projects/trellis-board/packages/server/team/task-control/projection.js#L5-L77) 仅对 `board.tasks` 中存在的归档任务执行 `archiveProjectionTask`，不会收敛无远端归档同步的 `sync_task` 行。
  - 客户端 [visibility.rs](file:///C:/projects/trellis-board/packages/desktop/src-tauri/src/agent/worktree/visibility.rs#L11-L33) 轮询 `GET /api/agent/task-spaces/{id}/tasks`，服务端 [shared.js](file:///C:/projects/trellis-board/packages/server/team/snapshot/shared.js#L320-L325) 查询 `sync_task WHERE task_space_id = ? AND archived = 0` 仍返回 1 条记录，导致 [ProjectEntry.tsx](file:///C:/projects/trellis-board/packages/web/src/components/layout/project-rail/ProjectEntry.tsx#L374-L378) 永久显示“等待归档同步”。

## Requirements

### R1. 客户端接入打标与存量 worktree 自愈
- `AttachOptions` 与 `POST /api/agent/task-spaces/attach` 请求体增加 `isWorktree` 布尔字段：
  - `WorktreeService::attach` 传入 `isWorktree: true`；
  - 普通主仓库接入（`association.rs`）传入 `isWorktree: false`。
- 本地 `AgentBinding` 持久化 `is_worktree: bool`（`#[serde(default)]`，向后兼容旧配置）。
- 存量自愈：`WorktreeService::reconcile_inner` 发现已绑定且 `auto_managed == true` 的 worktree 在本地 `AgentBinding` 中 `is_worktree == false` 时，自动补发一次幂等 `attach`（携带 `isWorktree: true`）并更新本地配置，使存量卡住的 worktree 分支自动恢复。

### R2. 服务端分支类型持久化与转换规则
- 数据库升级至 Schema v19：`sync_task_space` 新增列 `is_worktree INTEGER NOT NULL DEFAULT 0`。
- `POST /api/agent/task-spaces/attach` 兼容旧客户端（缺省 `isWorktree` 视为 `false`），并执行明确的类型规则：
  - 基线分支（`branchName === project.baseline_branch`）始终为普通分支（`is_worktree = 0`）；
  - 新建非基线任务空间时按 `isWorktree` 写入 `0` 或 `1`；
  - 复用已有任务空间时：普通仓库接入（`isWorktree === false`）可将 `is_worktree` 从 `1` 升级回 `0`；worktree 接入（`isWorktree === true`）在非基线分支且该空间从未成功完成远端归档同步（`last_success_at IS NULL`）时，允许从 `0` 补标为 `1`，同时重置其残留的归档错误状态并触发一次任务空间索引刷新。
- `taskSpacePublic` DTO 增加 `isWorktree: boolean`。

### R3. 服务端归档同步差异化（方案 A）
- `archive-git-sync` 的定时调度（`runDueTaskSpaces`）与“全部立即同步”（`runNow(null)`）**完全跳过** `is_worktree = 1` 的任务空间，不发起任何远端 Git 请求，不产生 `ARCHIVE_BRANCH_MISSING` 日志或退避重试。
- 对单个 worktree 任务空间调用 `runNow(taskSpaceId)` 返回明确拒绝（409 `WORKTREE_ARCHIVE_SYNC_SKIPPED`），不排队拉取。
- `overview()` 保留返回 worktree 任务空间，附带 `isWorktree: true`，并将其归档同步状态统一呈现为 `status: 'worktree_skipped'`、`lastError: null`、`nextAttemptAt: null`。

### R4. Worktree 分支控制面 `sync_task` 自动收敛
- 仅针对 `is_worktree = 1` 的任务空间，在 `index-write.js` 调用 `taskControl.reconcileProjection` 时传入 `isWorktree: true`。
- 当该 worktree 任务空间的活跃快照中某个已物化（`materialization_state = 'materialized'`）的任务目录已不存在（例如本地归档后上报删除，且不在本次活跃投影列表内），`reconcileProjection` 自动将其 `sync_task` 行收敛为 `archived = 1`，释放活跃租约并解决挂起冲突。
- 保护边界：`materialization_state IN ('pending', 'claimed')` 的待物化任务不得被误清理；普通分支（`is_worktree = 0`）保持原有归档收敛逻辑不变。

### R5. 管理端与前端状态呈现
- `admin.html -> 归档同步`（[ArchiveSyncTaskSpaceRow.tsx](file:///C:/projects/trellis-board/packages/web/src/features/admin/ArchiveSyncTaskSpaceRow.tsx)）保留展示 worktree 分支，状态徽章显示为 **“Worktree · 免归档同步”**（中性样式，非错误态），不显示“立即同步”按钮与错误提示。
- 看板侧边栏：当 worktree 本地任务归档且服务端 `sync_task` 收敛后，客户端轮询 `server_active_task_count` 归零，自动清除“等待归档同步”并隐藏空 worktree。

### R6. Worktree 删除解绑后自动弃用与同名重建恢复
- 当客户端删除本地 worktree 并触发 `POST /api/agent/task-spaces/{id}/detach`（[bindings.js](file:///C:/projects/trellis-board/packages/server/team/task-space/bindings.js#L88-L159)）后，若该任务空间满足 `is_worktree = 1`、非基线分支、且已无剩余 `approved` 绑定（`approvedBindingCount === 0`），服务端自动将其弃用（写入 `status = 'disabled', retired_at = now, retired_reason = 'worktree_deleted'` 并记录审计事件 `task_space_retired`）。
- 自动弃用后，该 worktree 分支从看板侧边栏和 `admin.html -> 归档同步` 列表中消失，不再对本机或团队其他成员显示红字“无客户端关联”；在 `admin.html -> 项目协作 -> 分支管理` 中仍保留可追溯的已弃用记录。
- 若后续用户重新创建同名分支（无论 worktree 还是普通分支）并再次 `POST /api/agent/task-spaces/attach`，若该任务空间此前是因 worktree 解绑自动弃用（`is_worktree = 1` 且 `retired_at IS NOT NULL`），服务端自动恢复该任务空间（清空 `retired_at`、恢复 `status = 'active'`）并按新请求更新 `is_worktree`，不报 409 停用错误。
- 普通分支（`is_worktree = 0`）解绑后行为不变，仍保持 `active` 并正常提示“无客户端关联”。

## Acceptance Criteria

1. **AC1（新建 worktree 接入）**：客户端自动接入新 worktree 分支时，`POST /api/agent/task-spaces/attach` 携带 `isWorktree: true`，服务端 `sync_task_space.is_worktree = 1`，`taskSpacePublic` 返回 `isWorktree: true`。
2. **AC2（普通分支不受影响）**：普通主仓库接入分支（或任意基线分支）时，`sync_task_space.is_worktree = 0`，远端归档同步、`sync_task` 投影与解绑行为与改造前完全一致。
3. **AC3（归档同步跳过 worktree）**：`archive-git-sync` 定时任务与全量“立即同步”不会对 `is_worktree = 1` 的任务空间调用 `store.readSnapshot`，不会产生 `ARCHIVE_BRANCH_MISSING` 失败日志；单空间手动同步被明确拒绝。
4. **AC4（控制面收敛与“等待归档同步”解除）**：worktree 分支上传活跃任务后，本地归档并删除活跃目录；服务端索引完成后 `GET /api/agent/task-spaces/{id}/tasks` 返回空列表，客户端 `archive_sync_pending` 变为 `false` 且可见性转为 `hidden_empty`。
5. **AC5（待物化任务保护）**：worktree 分支上 `materialization_state` 为 `pending` 或 `claimed` 的任务，在尚未写入本地活跃快照前不会被 `reconcileProjection` 误标为 `archived = 1`。
6. **AC6（存量 worktree 自愈）**：已有 `is_worktree = 0`、此前因 `ARCHIVE_BRANCH_MISSING` 报错且 `sync_task` 残留 `archived = 0` 的存量 worktree 分支，在客户端补发 `attach(isWorktree: true)` 后，`sync_task_space.is_worktree` 更新为 `1`、归档错误状态清除、`sync_task` 收敛、客户端解除“等待归档同步”。
7. **AC7（管理端展示）**：`admin.html -> 归档同步` 中活跃的 worktree 分支显示为“Worktree · 免归档同步”，不显示错误红字，且不可点击“立即同步”。
8. **AC8（数据库迁移）**：从 Schema v18 数据库升级到 v19 无数据丢失，既有 `sync_task_space` 默认 `is_worktree = 0`，所有数据库与后端测试通过。
9. **AC9（删除 worktree 自动弃用与重建恢复）**：`is_worktree = 1` 的任务空间在最后一个绑定调用 `detach` 后自动弃用，不再出现在看板侧边栏（消除“无客户端关联”红字）及归档同步列表；若之后同名分支重新 `attach`，自动恢复为 `active` 并正常绑定；普通分支（`is_worktree = 0`）解绑后不被自动弃用。

## Out of Scope

- 不改变普通分支的远端 Git 归档同步机制，也不通过 Agent 上传 `.trellis/tasks/archive` 文件。
- 不自动删除用户本地磁盘上的 Git worktree 目录，也不自动物理删除（purge）服务端历史分支数据。
- 不新增独立的 worktree 管理页面（复用现有 `admin.html` 归档同步与分支管理视图）。
