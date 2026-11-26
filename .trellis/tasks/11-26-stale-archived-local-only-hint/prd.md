# PRD：修复已归档任务接入误报仅本地及分支更新后提示不消除

## Goal

解决本地分支落后于远端最新分支时，已在远端归档的任务在接入项目时被误报为「仅本地存在」、并在接入后持续在左侧项目区域展示未同步提示且更新分支后永不消除的问题，保证接入预检准确、状态机自愈收敛。

## Confirmed Facts

- 远端通过 Git 归档同步拉取的归档任务写入 `sync_archive_file` 表（由 `sync_task_space.archive_snapshot_id` 标识当前活跃归档快照，历史兼容 `snapshot_id IS NULL`），不一定在 `sync_task` 中存在 `archived = 1` 记录。
- 服务端 `preflight`（[packages/server/team/task-space/access.js:356-378](packages/server/team/task-space/access.js)、[shared.js:137-142](packages/server/team/task-space/shared.js)）与 `assertReadable`（[packages/server/team/task-control/views.js:77-96](packages/server/team/task-control/views.js)、[shared.js:327-331](packages/server/team/task-control/shared.js)）及 `assertUploadAllowed`（[uploads.js:53-70](packages/server/team/task-control/uploads.js)）在判断任务是否已归档时，仅查询了 `sync_task`，遗漏了 `sync_archive_file`。
- 桌面端 `local_sync_state_from_groups`（[packages/desktop/src-tauri/src/agent/task_sync/cursor.rs:90-105](packages/desktop/src-tauri/src/agent/task_sync/cursor.rs)）遇到 `cursor.deferred` 中的目录在本地已消失（`local_state.is_empty()`）时无条件保留，未区分「服务端存在基线需防误删」与「服务端无基线的 local-only 任务已从本地消失」。
- 桌面端 `prunable_task_directories`（[packages/desktop/src-tauri/src/agent/task_sync/upload.rs:1034-1055](packages/desktop/src-tauri/src/agent/task_sync/upload.rs)）仅检查 `cursor.baselines`，未检查 `cursor.deferred`，导致文件监听在本地归档/删除后也无法清理陈旧的 `deferred` 记录。
- 左侧项目区域（[packages/web/src/components/layout/project-rail/association.ts:282-291](packages/web/src/components/layout/project-rail/association.ts)）直接根据 `association.deferredCount > 0` 展示 `已关联 · N 个本地任务未同步`，而 `write_cursor` 变更后会主动触发 `notify_state_changed()` 刷新前端状态。

## Requirements

### R1：服务端归档识别覆盖 `sync_archive_file`

1. **预检接口 `preflight`**：`archivedTaskBasenames` 必须同时包含 `sync_task`（`archived = 1`）以及当前任务空间活跃归档快照下 `sync_archive_file` 中的归档任务目录名（basename）。
2. **目录读取接口 `assertReadable`**：当 `sync_task` 中不存在该活跃目录时，除检查 `sync_task` 的 `archived = 1` 外，还必须检查当前活跃归档快照下 `sync_archive_file` 是否存在同名归档目录；命中时返回 `409 TASK_ARCHIVED`。
3. **上传准入接口 `assertUploadAllowed`**：当新上传目录在 `sync_task` 中不存在但已在 `sync_archive_file` 当前活跃归档快照中存在同名归档目录时，拒绝上传并返回 `409 TASK_ARCHIVED`，防止滞后分支复活已归档任务。

### R2：桌面端在本地目录消失且服务端无基线时自动清理 `cursor.deferred`

1. **`local_sync_state_from_groups`（pull / 状态对账路径）**：
   - 当 `task_dir` 存在于 `cursor.deferred` 且 `local_state.is_empty()` 时：
     - 若 `server_baselines` 或 `cursor_baselines` 中仍存在该 `task_dir` 的基线，**保持现有保护逻辑**（继续保留在 `next_deferred`，不作为 dirty 删除上传，兼容 `missing_local_directory_keeps_deferred_protected`）。
     - 若 `server_baselines` 与 `cursor_baselines` 中**均不存在**该 `task_dir`，说明该任务原本仅在本地存在且现在本地也已消失（如更新分支归档或本地删除），应从 `next_deferred` 中移除该 `task_dir`（且不加入 `dirty`）。
2. **`prunable_task_directories`（watcher / `upload_dirty` 路径）**：
   - 当服务端目录不存在（404，`server_files.is_empty()`）且本地活跃目录也不存在（`!existing_local_dirs.contains(task_dir)`）时，若该 `task_dir` 存在于 `cursor.baselines` **或** `cursor.deferred` 中，均应纳入可清理列表并调用 `remove_task_dir_cursor_state` 清除。
3. **状态通知**：`deferred` 被清理并写回 cursor 后，通过现有 `write_cursor` → `notify_state_changed()` 机制刷新前端，左侧项目区域的「N 个本地任务未同步」提示自动消除。

## Acceptance Criteria

- [ ] **AC1（预检不误报）**：当远端最新分支的归档任务仅存在于 `sync_archive_file`（`sync_task` 无记录）时，滞后本地分支执行项目预检，`preflight.archivedTaskBasenames` 包含该任务 basename，客户端 `differences` 中不将其列为 `local-only`，`counts.localOnly` 不包含该任务。
- [ ] **AC2（首同步与上传拦截）**：针对仅存在于 `sync_archive_file` 的已归档任务，服务端目录读取接口（`assertReadable`）和上传校验（`assertUploadAllowed`）均返回 `409 TASK_ARCHIVED`；桌面端 `gate_local_only_differences` 能将其剔除，不会写入 `cursor.deferred`。
- [ ] **AC3（更新分支后提示自动消除）**：当某个仅本地任务已经处于 `cursor.deferred`（`server_baselines` 与 `cursor_baselines` 均无该任务）时，更新分支或删除本地活跃任务目录后，无论是通过 `pull` 对账还是文件监听触发 `upload_dirty`，该条目都会从 `cursor.deferred` 自动清除，且不会产生误删上传；`deferredCount` 归零后左侧项目区域提示消失。
- [ ] **AC4（保留既有防误删保护）**：当 `cursor.deferred` 中的任务在服务端/cursor 基线中仍存在，但本地目录临时缺失时，`local_sync_state_from_groups` 仍保持 `deferred` 保护且不将其判为 `dirty`（既有单测 `missing_local_directory_keeps_deferred_protected` 继续通过）。
- [ ] **AC5（自动化测试与检查）**：服务端与桌面端补充对应单元测试/集成测试并通过，代码格式化与 lint/typecheck/cargo test 全绿。

## Out of Scope

- 不修改前端 `ProjectRail` 的展示文案或 UI 布局（左侧提示由 `deferredCount` 驱动，数据源收敛后 UI 自动消除）。
- 不修改 Git 归档同步本身（`archive-git-sync.js`）的表结构或写入流程。
- 不对非活跃/已淘汰的历史归档快照（非 `archive_snapshot_id` 且非旧库 `NULL` 快照）做泛化匹配。
