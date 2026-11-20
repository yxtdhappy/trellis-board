# 执行计划：分支守卫降噪与非模态消息

## 0. 执行前检查

- [ ] 确认当前分支与工作区状态；本任务只改桌面 Agent、Web 消息提示与规格文档。
- [ ] 复核 `design.md` 第 3.2 节状态矩阵，确认“进入暂停才提醒”的边界。
- [ ] 不改 `task_sync_error` 现有字段与非分支守卫路径。

## 1. Rust：分支守卫边沿与 notice 事件

- [ ] `packages/desktop/src-tauri/src/agent/task_sync/bindings.rs`
  - [ ] `persist_binding_sync_error` 返回 `bool`（配置是否变化）；更新所有调用点（`bindings.rs:426`、`ownership.rs:24`、测试）。
  - [ ] `assert_binding_branch`（`task_sync/ownership.rs`）失败分支：`entered = !binding.last_error_code.is_some_and(is_branch_guard_code)`；持久化后仅当 `entered && changed` 给 `error.details` 写入 `branchGuardEntered: true`。
  - [ ] `report_binding_error`：分支守卫错误且 `branchGuardEntered` 时发 `task_sync_notice`；按 `local_repo_key + code` 在 `select_bindings` 单轮内去重；其他错误维持 `task_sync_error`。
  - [ ] `report_error`：分支守卫错误只在 `branchGuardEntered` 时发 notice，其余情况仅日志；非分支守卫错误不变。
- [ ] `packages/desktop/src-tauri/src/agent/task_sync/errors.rs`
  - [ ] 新增 `task_sync_notice_event`（`type: task_sync_notice`、`kind: branch_guard`、`taskSpaceId`、`projectName`、`branchName`、`errorCode`、`message`）。
  - [ ] 新增 `branch_guard_entered(error) -> bool` 读取 `details.branchGuardEntered`。
  - [ ] 新增给错误 details 写入 `branchGuardEntered` 的小工具（保留已有 details，如 `taskDir`）。
- [ ] `packages/desktop/src-tauri/src/agent_service.rs`
  - [ ] `publish_control`：`task_sync_notice` 直接 `app.emit("task-sync-notice", control)` 后 return；不调用 `ControlHub::push_with_change`、不调用 `focus_main_window`。
  - [ ] `task_handoff`、`initial_sync_review` 等现有分支不变。

## 2. Rust 测试

位置：`packages/desktop/src-tauri/src/agent/task_sync/tests/bindings_watch.rs`（或新建 `branch_guard_notice.rs`，挂到 `tests` mod）。

- [ ] 夹具：临时 git 仓库，`init_git_repo`，绑定分支 `main`，切到 `feature`，保存 config；用捕获 `ControlSink` 的 `TaskSync`。
- [ ] `branch_mismatch_pauses_and_notifies_once`：
  - [ ] 第一轮 `prepare_startup_bindings` 返回空；`active_bindings()` 为空；`pull_task_space()` 返回 `skipped/BINDING_INACTIVE`。
  - [ ] 捕获事件中 `task_sync_notice` 恰好 1 条，`errorCode=BRANCH_MISMATCH`，无 `task_sync_error`。
  - [ ] 从 store 重新读取 binding 再跑第二轮（模拟心跳），notice 仍为 1 条。
- [ ] `branch_guard_recovers_then_notifies_again`：切回 `main` → 绑定重新入选、`last_error_code` 清除且不发 notice；再切到 `feature` → 新增 1 条 notice。
- [ ] `switching_between_unbound_branches_does_not_renotify`：`feature-a` → `feature-b` 仍暂停但不新增 notice（状态未离开暂停）。
- [ ] `multi_binding_same_repo_notifies_once`：同仓库两个绑定同时进入暂停，单轮只 1 条 notice。
- [ ] 回归：非分支守卫错误调用 `report_error` 仍产生 `task_sync_error`（可复用现有测试模式）。

## 3. Web：非模态消息

- [ ] 新增 `packages/web/src/lib/sync-notice.js`
  - [ ] `syncNoticeView(payload)` 返回 `{ id, title, description }`；项目名/消息缺失时有稳定兜底。
- [ ] 新增 `packages/web/src/desktop/SyncNotice.tsx`
  - [ ] 仅在前端有 `listen` 时注册 `task-sync-notice`；`toast.warning`，带 `id` 去重，`duration: 10_000`。
  - [ ] 不弹 Dialog、不请求系统通知、不 focus。
- [ ] `packages/web/src/pages/board/BoardPage.tsx`
  - [ ] 在 `<HandoffNotice />` 旁挂载 `<SyncNotice />`。
- [ ] 新增 `packages/web/test/sync-notice.test.js`
  - [ ] 覆盖标题/描述/id 去重与缺字段兜底。

## 4. 规格与文档

- [ ] `.trellis/spec/backend/desktop-realtime-sync.md`：补充“分支守卫错误是持续状态，只发一次 `task_sync_notice`，不入 ControlHub，不弹窗/不抢焦点；暂停期间不 pull/upload/写本地”。
- [ ] `.trellis/spec/backend/desktop-agent-runtime.md`：控制事件章节补充 `task-sync-notice` 的路由与不 focus 规则。
- [ ] `.trellis/spec/desktop/tauri-commands/index.md`：事件签名补充 `task-sync-notice` payload，且说明它只做提示、不影响 `live_control_pending`。
- [ ] `.trellis/spec/frontend/rendering-and-state.md`（如需）：补充桌面非模态同步消息使用 sonner、不阻塞、不抢焦点。
- [ ] 更新 `implement.jsonl` / `check.jsonl` 指向上述规格（如使用子代理执行）。

## 5. 验证命令

```bash
# Rust
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml agent::task_sync
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml agent::control
cargo fmt --manifest-path packages/desktop/src-tauri/Cargo.toml --check
cargo clippy --manifest-path packages/desktop/src-tauri/Cargo.toml --all-targets -- -D warnings

# Web
yarn test
yarn workspace @trellis-board/web lint
yarn workspace @trellis-board/web build:desktop
```

（若 clippy 在本机因既有告警不可用，记录基线并只对本模块新增告警负责。）

## 6. 手工验收（桌面）

- [ ] 启动客户端，确认在 `main` 上同步正常、无消息。
- [ ] 切到 `fix/offline-assign-materialize`：
  - [ ] 约 15 秒内出现一次非模态消息；无模态框、无窗口抢焦点。
  - [ ] 项目栏 `main` 分支行显示“已暂停”。
- [ ] 不做任何操作等待 ≥45 秒：无第二条消息、无弹窗。
- [ ] 切回 `main`：项目栏恢复；无“已恢复”消息（按决策不提示）。
- [ ] 再切走：再次出现一次消息。
- [ ] 在暂停状态重启客户端：不出现启动消息，项目栏仍显示“已暂停”。
- [ ] 制造一次非分支守卫错误（如断开网络触发 pull 失败）确认原模态 `task_sync_error` 行为未变（若可安全构造）。

## 7. 回滚点

- Rust 路由改动（步骤 1）是行为切换点；只回滚 `agent_service.rs` 的 `task_sync_notice` 路由即可恢复模态弹窗（但会出现重复提醒）。
- 前端监听组件可独立回滚；无数据迁移、无 schema 变更。
