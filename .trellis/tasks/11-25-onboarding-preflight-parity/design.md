# 技术设计：对齐本地项目接入预检与首次同步口径并在弹窗展示差异明细（含僵尸监听与冲突覆盖修复）

## 1. 架构与模块边界

- **服务端预检查询层**（`packages/server/team/task-space/shared.js`、`packages/server/team/task-space/access.js`）：
  - `taskSpaces.preflight(userId, input)` 属于接入前无绑定只读预检，不要求调用方已存在 `sync_agent_binding`，因此不引入对 `task-control-service` 的绑定依赖或循环引用，直接在 `task-space/shared.js` 预编译针对 `sync_task` 与 `sync_task_space_file` 的只读查询，对齐 `task-control` 的可见性与遗留目录规则。
- **服务端冲突层**（`packages/server/team/snapshot/shared.js`、`packages/server/team/snapshot/conflicts.js`）：
  - `pendingConflicts` 关联 `sync_task` 补充可读 `task_title`；`resolveConflict("overwrite-server")` 向 `applyChangesInternal` 透传 `taskVersion` 与 `leaseToken`。
- **桌面端 Rust 预检编排层**（`packages/desktop/src-tauri/src/main.rs` -> `agent_service.rs` -> `agent/association.rs`）：
  - Tauri 命令与 `agent_service` 透传经过 `validate_developer_id` 校验的 `developer_id`。
  - `agent/association.rs` 直接复用 `agent/task_sync` 导出的共享纯过滤函数，保证预检与 `pull_initial_sync` 单一来源。
- **桌面端 Rust 运行时与冲突同步层**（`agent/runtime.rs`、`agent_service.rs`、`agent/task_sync/{watch,upload,conflict,ownership_inbox}.rs`）：
  - 通过 `watch_shutdown` + `Weak<TaskSync>` + 同步 `watch` 锁彻底消除重启残留 watcher。
  - 通过共享 `acquire_upload_fence` 辅助与运行态 `TaskSync` 复用，保证冲突覆盖携带有效写栅栏并与内存游标/控制状态保持一致。
- **Web 前端弹窗与状态层**（`packages/web/src/features/board/dialogs/*`、`packages/web/src/components/layout/ProjectRail.tsx`）：
  - 仅扩展 `project-onboarding-types.ts`、`project-onboarding-normalize.ts`、`ProjectOnboardingDialog.tsx` 与 `ProjectRail.tsx` 的展示和归一化逻辑；遵守 `component-reuse.md` 分层与原语规范，不新增全局状态库或新 IPC 命令。

---

## 2. 数据流与接口契约

### 2.1 服务端：`POST /api/agent/task-spaces/preflight`

1. **SQL 查询定义**（`packages/server/team/task-space/shared.js`）：
   - `preflightFiles`（仅返回当前用户可见的活跃任务文件及 `task.json` 文本供提取轻量元数据）：
     ```sql
     SELECT f.relative_path, f.sha256, f.task_id, f.task_dir,
            CASE WHEN f.relative_path = f.task_dir || '/task.json' THEN f.content_text ELSE NULL END AS task_json_text
     FROM sync_task_space_file f
     JOIN sync_task t
       ON t.task_space_id = f.task_space_id
      AND t.task_id = f.task_id
      AND t.assignee_user_id = ?
      AND t.archived = 0
     WHERE f.task_space_id = ? AND f.deleted = 0
       AND f.task_dir NOT LIKE '.trellis/tasks/archive/%'
       AND f.relative_path NOT LIKE '.trellis/tasks/archive/%'
     ORDER BY f.task_dir, f.relative_path
     ```
   - `preflightHiddenTasks`（当前任务空间内已归档或非本人负责的任务目录）：
     ```sql
     SELECT relative_dir, archived
     FROM sync_task
     WHERE task_space_id = ?
       AND (archived = 1 OR assignee_user_id IS NULL OR assignee_user_id <> ?)
     ```
   - `preflightLegacyTaskDirs`（存在活文件但缺少 `sync_task` 行的目录，与 `assertReadable` 的 `readLegacyTaskFile -> 403` 语义对齐）：
     ```sql
     SELECT DISTINCT f.task_dir
     FROM sync_task_space_file f
     WHERE f.task_space_id = ? AND f.deleted = 0
       AND f.task_dir NOT LIKE '.trellis/tasks/archive/%'
       AND NOT EXISTS (
         SELECT 1 FROM sync_task t
         WHERE t.task_space_id = f.task_space_id AND t.task_id = f.task_id
       )
     ```
2. **元数据提取与响应整形**（`packages/server/team/task-space/access.js`）：
   - 对 `task_json_text` 仅安全解析一次 JSON，提取 `title`（非空 trim 字符串）和 `taskBranch`（`parsed.branch` 非空 trim 字符串）；**严禁将 `content` / `content_text` 放入响应**。
   - 收集 `hiddenTaskDirs`（去重排序，包含：非本人活跃任务的 `relative_dir`、已归档任务的 `relative_dir`、legacy 活跃目录 `task_dir`）以及 `archivedTaskBasenames`（已归档记录 `relative_dir` 的末段目录名，去重排序）。
   - 当 `resolved.status !== 'existing'` 或不可用（`access_required` / `unavailable` / `new` / `branch_new`）时，返回 `tasks: []`、`hiddenTaskDirs: []`、`archivedTaskBasenames: []`。

### 2.2 桌面端 Rust：`preflight_pending_project` 与 `association::run_preflight`

1. **命令参数透传**：
   - `main.rs::preflight_pending_project` 保留 `let developer_id = validate_developer_id(&developer_id)?;`，传入 `agent_service::preflight_project(&app, &path.to_string_lossy(), &team_id, &developer_id, require_pushed).await`。
   - `agent_service::preflight_project` 与 `association::preflight_desktop_project` 新增 `developer_id: &str`。
   - 在 `association::run_preflight` 中，有效开发者 ID 解析顺序为：`developer_id.trim()` 非空优先；为空时回退 `worktree::developer_id(repo_path, &config, &local.inspected.remote_identity_key).await`。
2. **提取并复用 `task_sync` 纯函数**：
   - `task_sync/ownership_filter.rs`：提取 `pub(crate) fn group_owned_by_developer(group: &SnapshotGroup, owner_id: &str) -> bool`（从 `group.files` 中 `task.json` 提取 `task_owner`，为空返回 `true`，否则 `eq_ignore_ascii_case(owner_id)`）。`TaskSync::owns_task_dir` 与 `association.rs` 共用此函数。
   - `task_sync/initial_sync.rs`：提取 `pub(crate) fn retain_server_groups_for_branch_initial_sync(branch_name: &str, local_groups: &[SnapshotGroup], groups: &mut Vec<SnapshotGroup>)`，原 `retain_server_groups_for_initial_sync` 委托给它。
   - `task_sync/snapshot.rs`：将 `task_title` 提升为 `pub(crate) use snapshot::task_title` 供 `association.rs` 复用，避免重复解析 `task.json`。
3. **预检过滤与差异构建流水线**（`association::run_preflight`）：
   - `access_required` / `unavailable`：直接返回空 `differences: []` 与零计数（不泄露本地/远端快照结构）。
   - 全状态（包含 `new`、`branch_new`、`existing`）：
     1. 读取本地文件并分组 `local_groups`，经 `filter_owned_local_groups(local_groups, owner_id.as_deref())` 过滤非本人任务。
     2. `normalize_server_task_groups(payload.get("tasks"))` 除现有字段外解析 `taskBranch` 到 `SnapshotGroup.task_branch`，并构建 `server_titles: HashMap<String, String>`（按 `task_dir` 存非空 `title`，不改动 `SnapshotGroup` 结构体）。
     3. 对服务端分组执行 `task_sync::retain_server_groups_for_branch_initial_sync(&local.inspected.branch_name, &local_groups, &mut server_groups)`。
     4. 执行 `task_sync::classify_task_snapshots(&local_groups, &server_groups)`。
     5. 从 `payload.get("hiddenTaskDirs")` 与 `payload.get("archivedTaskBasenames")` 构造隐藏集，过滤 `DiffKind::LocalOnly` 中精确命中 `hiddenTaskDirs` 或末段目录名命中 `archivedTaskBasenames` 的项。
     6. `difference_to_json(difference, &server_titles)` 增加顶层 `"title"` 字段（优先 `task_sync::task_title(local)`，回退 `server_titles.get(&server.task_dir)`），并在 `local` / `server` 保持现有结构兼容。

### 2.3 Web 前端：`ProjectOnboardingDialog` 与 `ProjectRail`

1. **类型与归一化**（`project-onboarding-types.ts`、`project-onboarding-normalize.ts`）：
   - `SnapshotDifference` 增加 `title: string | null`、`localTaskDir: string | null`、`serverTaskDir: string | null`。
   - `Association` 增加 `initialReviewPending: boolean`；`normalizeAssociation` 读取 `row.initialReviewPending === true`。
   - `normalizePreflight` 提取 `title`（`item.title` -> `item.local?.title` -> `item.server?.title`）、`localTaskDir`（`item.local?.taskDir`）、`serverTaskDir`（`item.server?.taskDir`）。
   - 在 `project-onboarding-normalize.ts` 导出纯映射 helper：`preflightDifferenceLabel(type)` 与 `preflightDifferenceTone(type)`（复用 `StatusPill` tone 类型，遵循 `component-reuse.md`，不写死颜色类）。
2. **UI 展示**（`ProjectOnboardingDialog.tsx`、`ProjectRail.tsx`）：
   - 在 `hasDifferences` 区块和 `newSnapshot && preflight.counts.invalid > 0` 区块内，于汇总说明下方渲染紧凑可滚动明细列表（`max-h-44 overflow-y-auto`）：
     - 标题行：`difference.title || difference.taskId || difference.taskDir || '未知任务'` + `StatusPill` 展示差异类型标签；
     - 目录行：当 `localTaskDir` 与 `serverTaskDir` 并存且不一致时显示 `本地：{localTaskDir} · 服务端：{serverTaskDir}`，否则显示单个 `taskDir`（使用 `text-muted-foreground break-all`）。
   - `ProjectRail.tsx`：`onAssociated` 判断 `normalized.initialReviewPending ? '本地项目已接入，正在准备差异确认…' : '本地项目已接入团队任务空间，正在同步任务。'`。

### 2.4 `TaskSync` 生命周期与 `watch_loop` 退出契约（消除僵尸监听）

1. **`TaskSync` 停止信号与同步锁**：
   - `TaskSync` 新增字段 `watch_shutdown: tokio::sync::watch::Sender<bool>`（初始值 `false`），并将 `watch` 字段从 `tokio::sync::Mutex<WatchState>` 改为 `std::sync::Mutex<WatchState>`（确认 `watch.rs` 锁作用域内没有任何 `.await`）。
   - 新增 `pub fn stop(&self)`：
     1. 发送关闭信号 `let _ = self.watch_shutdown.send(true);`；
     2. 获取 `self.watch` 同步锁，清空 `state.watchers.clear()` 并置 `state.tx = None`；
     3. 唤醒 `self.ownership_validation_state.notify.notify_one()`，让后台校验协程尽快发现并退出。
   - `impl Drop for TaskSync` 调用 `self.stop()`（兼顾测试与直接丢弃路径）。
   - `AgentRuntime::stop(&self, reason)`（`runtime.rs:152-160`）在 `self.worktree.stop()` 后调用 `self.task_sync.stop()`。
2. **`watch.rs` 弱引用循环退出**：
   - `rebuild_watchers(self: &Arc<Self>, bindings)`：
     - 进入时先检查 `if *self.watch_shutdown.borrow() { return; }`；
     - 在本地 `Vec<RecommendedWatcher>` 构造完毕后进入 `self.watch.lock()` 同步临界区：若此时 `*self.watch_shutdown.borrow()` 已变为 `true`，直接丢弃新建 watcher 返回，防止与 `stop()` 并发竞态留下残留监听；
     - 仅在 `state.tx` 为空且未停止时 spawn：`let this = Arc::downgrade(self); let shutdown = self.watch_shutdown.subscribe(); crate::agent::rt::spawn(async move { TaskSync::watch_loop(this, rx, shutdown).await });`。
   - `watch_loop(this: Weak<TaskSync>, mut receiver: mpsc::UnboundedReceiver<WatchEvent>, mut shutdown: tokio::sync::watch::Receiver<bool>)`：
     - 外层用 `tokio::select!` 监听 `shutdown.changed()` 与 `receiver.recv()`；收到关闭信号、channel 关闭或 `*shutdown.borrow()` 为真时立即退出；
     - 防抖窗口收集事件后，处理每个 `task_space_id` / `git_changed` 前先 `let Some(sync) = this.upgrade() else { return; };` 并再次检查 `*shutdown.borrow()`；批次处理结束即显式 `drop(sync)`，确保事件空闲期间没有任何 `Arc<TaskSync>` 强引用停留在协程栈上。
   - 测试适配：`task_sync/tests/pull_and_startup.rs:173` 中调用 `watch_loop` 的测试同步更新签名（传入 `Arc::downgrade(&watcher_sync)` 与 `watch::channel(false).1`）。

### 2.5 冲突「用我的版本覆盖」写栅栏与运行态缓存一致

1. **服务端透传**（`packages/server/team/snapshot/conflicts.js:119-135`）：
   - `resolveConflict` 调用 `applyChangesInternal` 时透传 `taskVersion: input.taskVersion` 与 `leaseToken: input.leaseToken`（无 `taskControl` 的单测继续兼容；存在 `taskControl` 时走 `assertUploadAllowed` 正常校验）。
2. **客户端共享写栅栏获取**（`upload.rs`、`conflict.rs`）：
   - 从 `upload.rs::upload_batch`（`458-574`）抽取共享方法 `acquire_upload_fence(&self, binding: &AgentBinding, files: &[Value]) -> AgentResult<UploadFenceOutcome>`：
     - 解析待上传文件的 `executionTaskKey`（优先从 `task.json` 提取，缺失时通过 `persisted_control_key_for_upload` 回退）；
     - 存在 `execution_task_key` 时查询 `remote_task_control`：若控制状态不可写则清理 `pending` 并返回阻断原因；若可写则尝试 `heartbeat_remote_task`（必要时回退 `claim_remote_task`）获得 `(claimed, lease_token)`，构造 `UploadFence { task_version: claimed.task_version, lease_token }`；
     - 控制面返回 `TASK_ARCHIVED`、`TASK_WRITE_FORBIDDEN`、`TASK_LEASE_HELD`、`TASK_LEASE_INVALID`、`TASK_CONTROL_MISSING` 等非致命阻断时返回明确的 `Skipped(Value)`。
   - 抽取共享持久化辅助 `persist_upload_control_response(&self, binding: &AgentBinding, fallback_key: Option<&str>, response: &Value) -> AgentResult<()>`，统一在 `upload_batch` 与 `decide_conflict("overwrite-server")` 成功响应后落盘 `control.task`、`lease` 与 `taskVersion`。
   - `conflict.rs::decide_conflict("overwrite-server")`：
     - 在构造好 `values` 后、调用 `resolve_conflict` 前执行 `acquire_upload_fence(&binding, &values)`：若返回 `Skipped(skipped)` 则清理/保留必要状态并返回该 skipped 负载（携带可读 `message` / `reason` 避免再发出必失败的 409 请求）；若就绪且获得 `Some(fence)` 则 `fence.apply(&mut payload)` 写入 `taskVersion` 与 `leaseToken`。
     - `resolve_conflict` 成功且非 `TASK_FILE_CONFLICT` 时，调用 `persist_upload_control_response` 更新控制态，并像 `upload_batch` 一样将刚覆盖的文件摘要写入 `self.suppressed`，避免覆盖落库后立刻被本地 watcher 重复判定为 dirty。
3. **运行态 `TaskSync` 复用**（`runtime.rs`、`agent_service.rs`）：
   - `AgentRuntime` 增加 `pub(crate) fn task_sync_arc(&self) -> Arc<TaskSync>`；`AgentService` 增加 `running_task_sync(&self) -> Option<Arc<TaskSync>>`。
   - `agent_service::decide_live_change` 若发现运行中 `TaskSync` 持有目标 `task_space_id` 绑定，则直接复用它（通过 `sync_task_directories` 同款的 `task_space_sync_lock` 串行化）调用 `decide_conflict`；否则回退新建临时 `TaskSync`。

### 2.6 冲突列表任务标题透传与客户端回退

- **服务端**（`packages/server/team/snapshot/shared.js:442-460`、`conflicts.js:76-85`）：
  - `pendingConflicts` SQL `LEFT JOIN sync_task st ON st.task_space_id = c.task_space_id AND st.task_id = c.task_id AND c.task_id IS NOT NULL` 读取 `st.title AS task_title`。
  - `listConflicts` 映射增加 `taskTitle: row.task_title || null`。
- **客户端**（`ownership_inbox.rs:425-452`、`conflict.rs:462-472`）：
  - `reopen_conflicts` 保留 `parse_directory_files(&directory, task_dir)` 得到的 `files`，提取其中 `task.json` 的 `title`；事件 `taskTitle` 按 `conflict.taskTitle`（非空）-> `files` 中 `task.json.title` -> `conflict.taskId` -> `task_dir` -> `"任务"` 逐级回退。
  - `conflict.rs::conflict_summary` 按 `details.taskTitle`（非空 string）-> `details.taskId`（非空 string）-> `"任务"` 回退。

---

## 3. 兼容性、取舍与回滚

- **取舍 1**：服务端 `title` 在 `association.rs` 中以 `HashMap<String, String>` 按 `task_dir` 承载，而非修改 `SnapshotGroup` 结构体新增字段，避免牵连大量无关 Rust 测试夹具构造代码。
- **取舍 2**：不修改 `preflight` 请求体参数，服务端完全依据已认证 `agent.userId` 裁剪可见任务；客户端 `developerId` 仅用于本地归属过滤（缺失时回退 `worktree::developer_id`）。
- **取舍 3**：`TaskSync.watch` 改用 `std::sync::Mutex` 后可在同步 `stop(&self)` 与 `Drop` 中直接清空 `watchers`/`tx`，无需异步 runtime 句柄即可在任意上下文安全清理 OS 监听。
- **前后向兼容**：服务端新增响应字段与可选透传参数均为纯加法；旧服务端缺失新字段时桌面端与前端均按空值/空集合/回退标题容错降级。
- **回滚方案**：预检口径、僵尸监听生命周期、冲突写栅栏透传、冲突标题与 Web 弹窗展示各自模块边界清晰，任一部分出现回归均可在不影响数据格式的前提下独立回退。
