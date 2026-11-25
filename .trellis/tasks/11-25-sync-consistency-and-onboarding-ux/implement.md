# 实施计划：客户端任务同步一致性修复与接入弹窗优化

## 实施步骤

1. **服务端预检对齐活跃租约口径（R4）**
   - 修改 `packages/server/team/task-space/shared.js` 的 `preflightFiles` 查询，增加他机活跃租约排除条件。
   - 修改 `packages/server/team/task-space/access.js` 的 `preflight(userId, input, options)` 与 `packages/server/team/http/routes/agent.js` 透传 `agentId`。
   - 在 `packages/server/test/team-task-spaces.test.js` / `packages/server/test/team-gitless-http.test.js` 补充活跃租约（同设备保留、他设备排除、过期租约保留）单测。

2. **桌面端运行态 `TaskSync` 复用与锁串行化（R1）**
   - 在 `packages/desktop/src-tauri/src/agent_service.rs` 抽取运行态 `TaskSync` 复用与串行锁调用逻辑，覆盖 `decide_live_change`、`resolve_initial_sync`、`sync_deferred_tasks`、`set_task_ownership`、`download_task`、`reopen_conflicts`。

3. **桌面端同步核心补齐（R2、R3、R6）**
   - 修改 `packages/desktop/src-tauri/src/agent/task_sync/local_files.rs`：`download_task` 先标记 `readonly_task_dirs` 与 `suppressed` 再落盘，失败时回滚。
   - 修改 `packages/desktop/src-tauri/src/agent/task_sync/pull.rs`：`after_revision == 0` 分支补齐 `gate_local_only_differences` 与 `readonly_dirs` 过滤。
   - 修改 `packages/desktop/src-tauri/src/agent/task_sync/conflict.rs`：`overwrite-server` 推进 `cursor.revision` 到服务端返回版本，`use-server` 与 `overwrite-server` 同步调用 `write_server_cursor`。
   - 在 `packages/desktop/src-tauri/src/agent/task_sync/tests/` 补充对应 Rust 单元测试。

4. **Web 端接入弹窗纯 `serverOnly` 交互优化（R5）**
   - 修改 `packages/web/src/features/board/dialogs/ProjectOnboardingDialog.tsx` 区分 `serverOnlySync` 与 `needsDifferenceReview`。
   - 更新并补充 `packages/web` 对应单测。

5. **全量验证与规范更新**
   - 运行格式化与全量验证门禁：
     - `npx oxfmt --check .`
     - `cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml`
     - `yarn test`
     - `yarn --cwd packages/web lint`
     - `yarn build`
   - 核对 `.trellis/spec/backend/desktop-realtime-sync.md` 等 spec 是否需要同步补充约束。
