# 实施计划：对齐本地项目接入预检与首次同步口径并在弹窗展示差异明细（含僵尸监听与冲突覆盖修复）

## 1. 有序实施清单

### Phase A：服务端（预检口径 + 冲突覆盖透传与标题）
1. **接入预检可见性、归档与元数据**：
   - 修改 `packages/server/team/task-space/shared.js`：更新 `preflightFiles` SQL（JOIN `sync_task` 过滤 `assignee_user_id = ? AND archived = 0`、排除 `.trellis/tasks/archive/%`、带出 `task_json_text`），新增 `preflightHiddenTasks` 与 `preflightLegacyTaskDirs`。
   - 修改 `packages/server/team/task-space/access.js`：在 `preflight(userId, input)` 中提取 `title` 与 `taskBranch`（严禁返回 `content`），返回 `hiddenTaskDirs` 与 `archivedTaskBasenames`；非 `existing` 状态返回空数组。
   - 更新并补充 `packages/server/test/team-task-spaces.test.js`、`packages/server/test/team-gitless-http.test.js`：补齐夹具所需 `sync_task` 行，并覆盖他人任务、已归档任务、archive 路径、无 `sync_task` 的 legacy 目录、`title`/`taskBranch`、零写库与零正文泄露。
2. **冲突覆盖写栅栏透传与列表标题**：
   - 修改 `packages/server/team/snapshot/shared.js`：`pendingConflicts` 关联 `sync_task` 查询 `task_title`。
   - 修改 `packages/server/team/snapshot/conflicts.js`：`listConflicts` 输出 `taskTitle`；`resolveConflict("overwrite-server")` 向 `applyChangesInternal` 透传 `taskVersion` 与 `leaseToken`。
   - 在 `packages/server/test/team-task-snapshot.test.js` 补充带真实 `taskControl` 的 `resolveConflict("overwrite-server")` 测试（携带 `taskVersion`/`leaseToken` 成功、缺失仍被 409 拒绝）以及 `listConflicts` 返回 `taskTitle` 的断言。

### Phase B：桌面端 Rust — 接入预检口径对齐
1. 导出共享纯过滤函数：
   - `packages/desktop/src-tauri/src/agent/task_sync/ownership_filter.rs`：提取 `pub(crate) fn group_owned_by_developer(group: &SnapshotGroup, owner_id: &str) -> bool`。
   - `packages/desktop/src-tauri/src/agent/task_sync/initial_sync.rs`：提取 `pub(crate) fn retain_server_groups_for_branch_initial_sync(branch_name: &str, local_groups: &[SnapshotGroup], groups: &mut Vec<SnapshotGroup>)`。
   - `packages/desktop/src-tauri/src/agent/task_sync.rs`：重导出上述 helper 与 `snapshot::task_title`。
2. 透传 `developer_id`：
   - `packages/desktop/src-tauri/src/main.rs::preflight_pending_project`
   - `packages/desktop/src-tauri/src/agent_service.rs::preflight_project`
   - `packages/desktop/src-tauri/src/agent/association.rs::preflight_desktop_project` / `run_preflight`
3. 补齐 `packages/desktop/src-tauri/src/agent/association.rs` 过滤与差异结构：
   - 本地分组按 `developer_id`（空则回退 `worktree::developer_id`）过滤他人任务；
   - `normalize_server_task_groups` 解析 `taskBranch` 与 `server_titles`；
   - 调用 `retain_server_groups_for_branch_initial_sync` 过滤服务端分组；
   - 在 `classify_task_snapshots` 后剔除命中 `hiddenTaskDirs` 或 `archivedTaskBasenames` 的 `LocalOnly` 项；
   - `difference_to_json` 输出 `title`。
4. 在 `packages/desktop/src-tauri/src/agent/association/tests.rs` 补充单元测试覆盖上述过滤、fail open、`title` 与各预检状态。

### Phase C：桌面端 Rust — 僵尸监听消除、冲突覆盖写栅栏与标题回退
1. **消除 `TaskSync` `Arc` 循环引用与重启残留 watcher**：
   - 修改 `packages/desktop/src-tauri/src/agent/task_sync.rs`：新增 `watch_shutdown: tokio::sync::watch::Sender<bool>`，将 `watch` 改为 `std::sync::Mutex<WatchState>`，实现 `pub fn stop(&self)` 并在 `Drop` 中调用 `self.stop()`。
   - 修改 `packages/desktop/src-tauri/src/agent/task_sync/watch.rs`：`rebuild_watchers` 检查 `watch_shutdown` 防竞态并传递 `Arc::downgrade(self)` 与 `shutdown` receiver；`watch_loop` 用 `Weak<TaskSync>` + `tokio::select!` 监听退出信号并在无事件期间不保留强引用。
   - 修改 `packages/desktop/src-tauri/src/agent/runtime.rs`：`AgentRuntime::stop` 调用 `self.task_sync.stop()`；新增 `task_sync_arc(&self) -> Arc<TaskSync>`。
   - 适配 `packages/desktop/src-tauri/src/agent/task_sync/tests/pull_and_startup.rs` 中 `watch_loop` 调用点，并新增单测验证 `stop()` 后 `watch_loop` 退出、`Arc` 可归零触发 `Drop`，以及重建 `TaskSync` 后文件修改仅触发新实例不双传。
2. **修复冲突「用我的版本覆盖」写栅栏与运行态缓存**：
   - 修改 `packages/desktop/src-tauri/src/agent/task_sync/upload.rs`：抽取 `acquire_upload_fence` 与 `persist_upload_control_response` 供 `upload_batch` 与冲突覆盖复用。
   - 修改 `packages/desktop/src-tauri/src/agent/task_sync/conflict.rs`：`decide_conflict("overwrite-server")` 获取 `UploadFence` 并写入 `taskVersion`/`leaseToken`，覆盖成功后更新控制态与 `suppressed`；优化 `conflict_summary` 的 `taskTitle` 回退逻辑。
   - 修改 `packages/desktop/src-tauri/src/agent_service.rs`：`decide_live_change` 优先复用运行中 `AgentRuntime` 的 `TaskSync`（经 `task_space_sync_lock` 串行执行），未运行或无绑定时回退临时 `TaskSync`。
   - 在 `packages/desktop/src-tauri/src/agent/task_sync/tests/` 补充 `decide_conflict("overwrite-server")` 获取租约并提交 `taskVersion`/`leaseToken`、以及控制面阻断处理的单元测试。
3. **补齐冲突事件标题回退**：
   - 修改 `packages/desktop/src-tauri/src/agent/task_sync/ownership_inbox.rs`：`reopen_conflicts` 从已拉取目录 `files` 中读取 `task.json` 标题作为次级回退（`conflict.taskTitle -> task.json title -> taskId -> taskDir -> "任务"`），并补充 Rust 单元测试。

### Phase D：Web 前端（接入弹窗差异明细与 toast 区分）
1. 修改 `packages/web/src/features/board/dialogs/project-onboarding-types.ts` 与 `project-onboarding-normalize.ts`：扩展 `SnapshotDifference`、`Association`、`normalizePreflight`、`normalizeAssociation` 并导出差异类型文案与 `StatusPill` tone 映射纯函数。
2. 修改 `packages/web/src/features/board/dialogs/ProjectOnboardingDialog.tsx`：在 `hasDifferences` 与 `newSnapshot && preflight.counts.invalid > 0` 区块渲染限高可滚动差异明细列表。
3. 修改 `packages/web/src/components/layout/ProjectRail.tsx`：根据 `initialReviewPending` 区分接入 toast 文案。
4. 在 `packages/web/test/` 补充/扩展测试覆盖 `normalizePreflight` 与 `normalizeAssociation`。

### Phase E：Phase 3.3 Spec 更新
- 更新 `.trellis/spec/backend/task-ownership-and-conflict-idempotency.md`、`.trellis/spec/backend/desktop-realtime-sync.md` 与 `.trellis/spec/backend/desktop-agent-runtime.md`，沉淀预检一致性、重启停止 `TaskSync` 资源释放与冲突覆盖写栅栏契约。

---

## 2. 验证命令清单

```powershell
# 1. 服务端受影响测试
node --test packages/server/test/team-task-spaces.test.js packages/server/test/team-gitless-http.test.js packages/server/test/team-task-snapshot.test.js packages/server/test/team-task-control.test.js

# 2. 桌面端 Rust 测试与模块行数/内联测试守卫
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml
rg -n '^mod tests \{' packages/desktop/src-tauri/src

# 3. Web lint / 类型检查 / 构建 / 纯逻辑单测
yarn --cwd packages/web lint
yarn build
node --test packages/web/test/onboarding-probe.test.js

# 4. 前端组件复用审计（在 packages/web 下运行）
rg -n "<button[ >]" src -g '!**/components/ui/**'
rg -n "bg-(success|warning|destructive|primary)-soft" src -g '!**/components/ui/**'
rg -n "type=\"checkbox\"" src
rg -n "@base-ui/react" src -g '!**/components/ui/**'
rg -n "<table" src -g '!**/components/ui/**'
rg -n "role=\"alert\"" src -g '!**/components/ui/**'
rg -n "<select" src -g '!**/components/ui/**'
rg -n "#[0-9a-fA-F]{6}\b" src

# 5. 全仓格式化检查与全量测试
npx oxfmt --check .
yarn test
```

---

## 3. 高风险文件与回滚点

| 文件 | 风险点 | 防护与回滚策略 |
| --- | --- | --- |
| `packages/server/team/task-space/access.js` | 泄露 `content_text` 或遗漏 `sync_task` 状态边界 | 复用 `JSON.stringify(res).includes('"content"')` 断言；仅只读查询 |
| `packages/server/team/snapshot/conflicts.js` | `resolveConflict` 未正确透传或破坏现有无 `taskControl` 调用 | 仅透传可选 `taskVersion`/`leaseToken`，保留原参数兼容 |
| `packages/desktop/src-tauri/src/agent/association.rs` | 误过滤无 owner 任务或未处理 `unavailable` 状态 | 严格复用 `group_owned_by_developer`（fail open）与 `access_required`/`unavailable` 早退 |
| `packages/desktop/src-tauri/src/agent/task_sync/watch.rs` | `std::sync::Mutex` 与 `Weak` 竞态或持有强引用导致仍不释放 | 锁内无 `.await`；`rebuild_watchers` 写入前复查 `watch_shutdown`；单测验证 `Drop` 计数归零 |
| `packages/desktop/src-tauri/src/agent/task_sync/conflict.rs` | 覆盖前控制面校验拦截后错清游标或未更新 `suppressed` | 复用 `acquire_upload_fence` 与 `persist_upload_control_response`；拦截时直接返回阻断信息 |
| `packages/web/src/features/board/dialogs/ProjectOnboardingDialog.tsx` | 硬编码颜色破坏暗色模式、长列表挤掉底部按钮 | 使用 `StatusPill`/`Badge` token 类，差异列表限高 `max-h-44 overflow-y-auto` |

---

## 4. 启动前检查（Phase 1.4）

- [x] `prd.md` 已完成编写并通过 PRD Convergence Pass
- [x] `design.md` 与 `implement.md` 已完成编写
- [ ] `implement.jsonl` 与 `check.jsonl` 已包含全部相关 spec 且 `task.py validate` 通过
- [ ] 用户已审阅规划摘要并明确批准后，再执行 `task.py start`
