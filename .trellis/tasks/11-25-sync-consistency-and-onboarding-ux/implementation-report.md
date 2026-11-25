# 实施报告：客户端任务同步一致性修复与接入弹窗优化

## 变更文件

### 服务端（Node.js）
- `packages/server/team/task-space/shared.js`：`preflightFiles` 查询新增 `NOT EXISTS` 过滤，在传入 `agentId` 时排除同用户其他设备持有的未过期活跃租约（`status = 'active' AND expires_at > ? AND lease.agent_id <> ?`）。
- `packages/server/team/task-space/access.js` & `packages/server/team/task-space-service.js`：`createAccess` 注入 `now` 时钟函数，`preflight(userId, input, options)` 透传可选 `agentId`，保持无参数调用兼容性。
- `packages/server/team/http/routes/agent.js`：`POST /api/agent/task-spaces/preflight` 传入 `{ agentId: agent.id }`。
- `packages/server/test/team-task-spaces.test.js`、`packages/server/test/team-gitless-http.test.js`：补充服务层预检租约口径单测与 HTTP 路由 `POST /api/agent/task-spaces/preflight` 跨设备活跃租约排除测试。

### 桌面端（Rust / Tauri）
- `packages/desktop/src-tauri/src/agent_service.rs`：提取 `select_task_sync` 与 `AgentService::lock_task_sync`，统一为 `decide_live_change`、`resolve_initial_sync`、`sync_deferred_tasks`、`set_task_ownership`、`download_task`、`reopen_conflicts` 复用运行中 `AgentRuntime` 的 `TaskSync` 并经 `task_space_sync_lock` 串行化（未运行或未绑定时回退临时实例）。
- `packages/desktop/src-tauri/src/agent/task_sync/sync_api.rs`：`set_task_ownership` 直接调用 `self.upload_directories`，避免与外层 `lock_task_sync` 重入死锁。
- `packages/desktop/src-tauri/src/agent/task_sync/local_files.rs`：`download_task` 在 `write_task_directory` 之前先登记 `readonly_task_dirs` 与 `suppressed`，落盘失败时通过 `rollback_download_guards` 回滚守卫。
- `packages/desktop/src-tauri/src/agent/task_sync/pull.rs` & `initial_sync.rs`：`pull_tracking` 的 `after_revision == 0` 兜底分支补齐 `gate_local_only_differences` 与 `readonly_dirs` 过滤；`gate_local_only_differences` 提前跳过已知 `readonly_task_dirs`。
- `packages/desktop/src-tauri/src/agent/task_sync/conflict.rs`：`use-server` 与 `overwrite-server` 完成后同步更新本地 cursor `revision` 并调用 `write_server_cursor` 上报服务端游标。
- `packages/desktop/src-tauri/src/agent_service/tests.rs`、`packages/desktop/src-tauri/src/agent/task_sync/tests/{pull_and_startup,handoff_and_errors,support}.rs`：补充 `select_task_sync` 运行态复用与串行锁单测、`download_task` 只读/抑制守卫及失败回滚单测、`pull_tracking` 零游标过滤单测、`use-server`/`overwrite-server` 游标对称性单测，并修复 `pull_and_startup.rs` 3 处 `clippy::needless_borrows_for_generic_args` 告警。

### Web 前端 & Spec
- `packages/web/src/features/board/dialogs/project-onboarding-normalize.ts` & `ProjectOnboardingDialog.tsx`：新增 `preflightPresentationMode`，在 `existing` 且仅存在 `serverOnly`（无 `localOnly`/`conflicts`/`invalid`）时渲染中性信息卡片及单一主按钮「接入并同步服务端任务」（调用 `associate('safe')`）。
- `packages/web/test/onboarding-probe.test.js`：补充 `preflightPresentationMode` 单测覆盖纯服务端任务与需确认差异场景。
- `.trellis/spec/backend/{desktop-agent-runtime,desktop-realtime-sync,task-ownership-and-conflict-idempotency}.md`：同步更新运行态复用、`download_task` 防竞态、预检租约口径、零游标过滤及冲突收尾游标契约。

## 验证命令与结果
- `cargo clippy --manifest-path packages/desktop/src-tauri/Cargo.toml --all-targets -- -D warnings`：通过（0 warnings）。
- `cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml`：427 passed, 0 failed。
- `yarn test`：762 tests, 755 passed, 7 pre-existing skips, 0 failed。
- `yarn workspace @trellis-board/web lint`：0 errors（64 条既有 warning）。
- `yarn workspace @trellis-board/web exec tsc -b`：通过。
- `yarn build` & `yarn build --target=desktop-ui`：均通过。
- `npx oxfmt --check <9 个变更 JS/TS/TSX 文件>`：通过。
