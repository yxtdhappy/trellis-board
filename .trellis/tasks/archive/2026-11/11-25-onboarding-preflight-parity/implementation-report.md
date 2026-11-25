# 实施报告：对齐本地项目接入预检与首次同步口径并在弹窗展示差异明细

## 变更文件

### 服务端（Node.js）
- `packages/server/team/task-space/shared.js`：`preflightFiles` 关联 `sync_task` 按 `assignee_user_id = ? AND archived = 0` 过滤并排除 `.trellis/tasks/archive/%`，新增 `preflightHiddenTasks` 与 `preflightLegacyTaskDirs`。
- `packages/server/team/task-space/access.js`：`preflight()` 提取轻量 `title` 与 `taskBranch`（不返回任何 `content`），输出 `hiddenTaskDirs` 与 `archivedTaskBasenames`。
- `packages/server/team/snapshot/shared.js`：`pendingConflicts` 关联 `sync_task` 查询 `task_title`。
- `packages/server/team/snapshot/conflicts.js`：`listConflicts()` 输出 `taskTitle`；`resolveConflict("overwrite-server")` 向 `applyChangesInternal` 透传 `taskVersion` 与 `leaseToken`。
- `packages/server/test/team-task-spaces.test.js`、`packages/server/test/team-gitless-http.test.js`、`packages/server/test/team-task-snapshot.test.js`：补充预检过滤/隐藏目录/元数据和冲突标题与写栅栏透传单测。

### 桌面端（Rust / Tauri）
- `packages/desktop/src-tauri/src/main.rs`、`packages/desktop/src-tauri/src/agent_service.rs`：`preflight_pending_project` → `preflight_project` → `preflight_desktop_project` 透传 `developer_id`；`decide_live_change` 优先复用运行中 `AgentRuntime` 的 `TaskSync`（经 `task_space_sync_lock` 串行执行）。
- `packages/desktop/src-tauri/src/agent/association.rs`：复用 `group_owned_by_developer` 与 `retain_server_groups_for_branch_initial_sync`，剔除命中 `hiddenTaskDirs`/`archivedTaskBasenames` 的 `LocalOnly` 差异，并在 `difference_to_json` 输出 `title`。
- `packages/desktop/src-tauri/src/agent/task_sync/ownership_filter.rs`、`initial_sync.rs`、`snapshot.rs`、`task_sync.rs`、`bindings.rs`：抽取并导出共享过滤/标题 helper，增加 `has_binding` 与 `pub(crate) task_space_sync_lock`。
- `packages/desktop/src-tauri/src/agent/runtime.rs`、`task_sync.rs`、`task_sync/watch.rs`、`task_sync/ownership.rs`：`TaskSync.watch` 改用 `std::sync::Mutex`、`watch_loop` 改用 `Weak<TaskSync>` + `watch_shutdown`，`TaskSync::stop()` 由 `AgentRuntime::stop()` 与 `Drop` 调用。
- `packages/desktop/src-tauri/src/agent/task_sync/upload.rs`、`conflict.rs`、`ownership_inbox.rs`：抽取 `acquire_upload_fence`、`persist_upload_control_response`、`mark_files_suppressed` 供 `overwrite-server` 复用；补齐 `reopen_conflicts` 与 `conflict_summary` 的多级标题回退。
- `packages/desktop/src-tauri/src/agent/association/tests.rs`、`task_sync/tests/{support,bindings_watch,handoff_and_errors,ownership_inbox,pull_and_startup}.rs`：补充预检过滤、watcher 停止释放/防双传、冲突写栅栏覆盖与标题回退单测。

### Web 前端 & Spec
- `packages/web/src/features/board/dialogs/project-onboarding-types.ts`、`project-onboarding-normalize.ts`、`ProjectOnboardingDialog.tsx`：扩展 `SnapshotDifference` 与 `Association`，增加 `preflightDifferenceLabel`/`preflightDifferenceTone`，在接入弹窗差异/异常区块展示限高可滚动差异明细列表。
- `packages/web/src/components/layout/ProjectRail.tsx`：根据 `initialReviewPending` 区分接入提示 toast 文案。
- `packages/web/test/onboarding-probe.test.js`：补充 `normalizePreflight`、`normalizeAssociation` 与标签/tone 映射单测。
- `.trellis/spec/backend/{task-ownership-and-conflict-idempotency,desktop-realtime-sync,desktop-agent-runtime}.md`：沉淀预检一致性、watcher 生命周期与冲突写栅栏契约。

## 验证命令与结果
- `cargo clippy --manifest-path packages/desktop/src-tauri/Cargo.toml --all-targets -- -D warnings`：通过（0 warnings）。
- `cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml`：421 passed, 0 failed。
- `yarn test`：749 tests, 742 passed, 7 pre-existing environment skips, 0 failed。
- `yarn build`（`tsc -b && vite build`）：通过。
- `node --test packages/web/test/onboarding-probe.test.js`：6 passed, 0 failed。
- `npx oxfmt --check <changed js/ts/tsx files>`：通过。
