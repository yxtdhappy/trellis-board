# 实施清单

> 分支：`main`（base_branch `team-board`），起点 `d9d2e64`。用户确认后再开工；不自动 commit/push。

## E1 基线确认
- [ ] `git -C D:/wit/trellis-board status --short` 记录工作区已有改动（onboarding、trellis_cli、前端等），**保持原状不碰**。
- [ ] `grep -n "HEARTBEAT_INTERVAL\|RETRY_BASE\|RETRY_MAX" packages/desktop/src-tauri/src/agent/runtime.rs` 确认常量位置未漂移（应为 runtime.rs:22-24）。
- [ ] 读 `.trellis/spec/desktop/tauri-commands/index.md` 的日志与模块大小规范。

## E2 引入 `HeartbeatPolicy`（runtime.rs）
- [ ] 定义 `pub(crate) struct HeartbeatPolicy { interval, retry_base, retry_max, binding_sync_timeout, round_timeout }` 与 `Default`（15s / 1s / 60s / 30s / 60s，与原常量一一对应）。
- [ ] `AgentRuntime` 持有 `policy: HeartbeatPolicy`，`new()` 用 `Default`；测试用结构体更新语法覆盖单字段。
- [ ] 删除旧的三处 `const`，改引用 `self.policy.*`（避免两套真值）。

## E3 有界等待助手
- [ ] 在 `agent/rt.rs` 增加 `pub(crate) async fn bounded<F: Future>(limit: Duration, label: &str, future: F) -> Option<F::Output>`，超时返回 `None` 并 `logging::warn`。
- [ ] 单测：`bounded(50ms, "x", sleep(5s))` 在 ≤200ms 内返回 `None`；`bounded(1s, "x", ready(7))` 返回 `Some(7)`。

## E4 重排 `heartbeat_once`（runtime.rs:191-243）
- [ ] 保留 `retry_pending_detachments()`；其后直接 `store.read_config(false)` → `task_sync.active_bindings()` → POST 心跳 → `parse_heartbeat_response`。
- [ ] 心跳成功后再 `apply_heartbeat_response`（原 `store.update_config` 合并逻辑）与 `update_bindings_bounded(merged.bindings)`。
- [ ] `update_bindings_bounded` = `bounded(self.policy.binding_sync_timeout, "心跳前的绑定同步", self.task_sync.update_bindings(bindings))`，失败只记日志。
- [ ] 确认不再调用第一次 `update_bindings(config.bindings)`；在代码注释说明“缓存由 `prepare_startup_bindings` 预热，新绑定最多晚一轮上报”。

## E5 循环加固（runtime.rs:138-189）
- [ ] `tokio::time::timeout(self.policy.round_timeout, self.heartbeat_once())` 包整轮，四个分支按 design §3.3 实现。
- [ ] 认证分支保持 `write_state("error", Some(&error), Some("AUTH_REVOKED"))` + `stop()` + `break` 不变。
- [ ] 非认证错误：`logging::warn` 带 `error.code`/`error.message`，写状态，探活，指数退避。
- [ ] 超时分支：`logging::warn("心跳单轮超过 60 秒未完成，已放弃本轮")`，写状态，`delay=retry_base`、`next_delay=interval`。
- [ ] 成功分支：若上轮失败则 `logging::info("心跳恢复：上报 N 个监听任务空间")` 并 `write_state("running", None, None)`；清 `last_heartbeat_error`。
- [ ] 新增字段 `last_heartbeat_error: AtomicBool`（避免每 15s 刷 info 日志）。

## E6 测试（新增 `src/agent/runtime_tests.rs` + `#[cfg(test)] #[path = "runtime_tests.rs"] mod tests;`）
- [ ] 不用 `src/agent/runtime/tests.rs`：目录化会触发「根文件 ≤500 行」（spec §291-304），`runtime.rs` 现有 770 行；`#[path]` 旁挂与 crate 根 `main.rs` 的先例一致。
- [ ] mock HTTP：参考 `src/agent/device/tests.rs:347-420` 的 `TcpListener` 手写实现，路由 `/api/agent/heartbeat`（计数 + 200）、`/api/agent/task-spaces/*/changes`（接受连接后不写响应，模拟挂起）、`/api/health`。
- [ ] `heartbeat_survives_hanging_task_sync`：`HeartbeatPolicy{ interval:20ms, binding_sync_timeout:50ms, round_timeout:120ms, .. }`，断言 2s 内 heartbeat 收到 ≥2 次。
- [ ] `heartbeat_round_times_out_without_stopping_loop`：让 `heartbeat_once` 卡在挂起的同步上，断言 ≥2 轮且 runtime 未 stop。
- [ ] `auth_error_still_stops_runtime`：返回 401 `AGENT_AUTH_REQUIRED`，断言状态为 `AUTH_REVOKED` 且循环结束。
- [ ] `recovery_writes_running_state`：先失败一轮再成功，断言 `runtime.json` 最终 `status=running` 且日志出现「心跳恢复」。
- [ ] 测试不得依赖真实时钟等待 >2s；必要时全部走注入的 policy。

## E7 验证
- [ ] `cargo fmt --manifest-path packages/desktop/src-tauri/Cargo.toml -- --check`（如仓库启用）。
- [ ] `cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml`（**整个任务只跑这一轮编译+测试**）。
- [ ] `cargo clippy --manifest-path packages/desktop/src-tauri/Cargo.toml --all-targets -- -D warnings`（若 CI 要求）。
- [ ] 手工：按 design §6 的四步做一次“杀服务端 → 重启 → 观察恢复”，把 `last_seen_at` 前后值与日志片段贴进 `research/verification.md`。

## E8 文档与交付
- [ ] 在 `.trellis/spec/desktop/tauri-commands/index.md` 补一节「心跳与在线状态」：心跳不得被同步阻塞、单轮 60s 上限、失败/恢复必须记日志、服务端 60s 判离线。
- [ ] 汇总改动 `git diff --stat`，请用户确认后提交（提交信息建议 `fix(desktop): keep heartbeat loop alive across server restarts`）。
- [ ] 出包 0.4.62 portable，并说明“未升级客户端仍会复发”。

## 完成判据
PRD 的 6 条 Acceptance Criteria 全部勾选；`research/verification.md` 含现场前后对比；spec 已更新。

## 进展（2026-11-24 17:20）

- E2–E6 代码已完成：
  - 新增 `packages/desktop/src-tauri/src/agent/heartbeat.rs`（`HeartbeatPolicy`、`RoundOutcome::classify/next_delays`、`bounded`、6 个单测）。
  - `runtime.rs`：`heartbeat_once` 改为「先发心跳、后同步」；新增 `update_bindings_bounded`；循环加 60s 整轮超时、失败/超时/恢复日志、恢复时写回 `running`。
  - `agent/mod.rs` 注册 `pub(crate) mod heartbeat;`；spec 已补「心跳循环与在线状态」场景。
- **验证受阻**：本机没有 Rust 工具链（`cargo`/`rustc` 均不在 PATH，`~/.cargo` 不存在），无法本地 `cargo test`。仓库的构建走 `.github/workflows/windows.yml`（GitHub Actions，windows-latest）。
- E7/E8 的编译与手工验收待定：需要 CI 跑一次或本机装 rustup 后再补。

## 进展（2026-11-24 19:55）：第二故障模式

0.4.63 上线后现场又复现一次：`runtime.json` 在 `2026-11-24T11:04:41.162Z` 变成 `stopped`，此后心跳完全停止，直到用户手动重启客户端才恢复（`11:38:39.440Z` 回到 `running`）。说明“心跳卡死”修好之后，仍有第二条路径会把整个运行时停掉，而且停止后没有任何自愈机制。

改动：

- `agent/runtime.rs`：`stop(reason: &str)` 记录「Agent 运行时停止：{reason}」；新增 `is_stopped()`；认证失败三处与 `agent.revoked` 一处带上原因。
- `agent_service.rs`：新增 `user_stopped` 标志与 `stop_with_reason`；`stop_runtime(reason)` 区分“用户主动停止”；`start()` 在暂停时记日志；`start_runtime()` 成功后清除 `user_stopped`；`register()` 里起 30s 看门狗，发现运行时已停且非用户主动停止就自动拉起（最多连续 10 次）。
- `bin/trellis-agent.rs`：命令行退出时传原因。
- spec「心跳循环与在线状态」补两条契约与两行行为矩阵。

验收路径：升级后关闭服务端再启动，`desktop.log` 应出现「Agent 运行时停止：…」并在 30s 内出现「检测到后台同步已停止，正在自动恢复」。

## 进展（2026-11-24 20:15）：真正的触发点

0.4.64 装上后复现，日志终于给出停止原因：

```
12:11:51.204Z INFO Agent 运行时停止：设备被服务端吊销
12:12:09.812Z WARN 检测到后台同步已停止，正在自动恢复
```

但库里 `agent_device.status='active'`、`revoked_at` 为空——设备根本没被吊销。原因是服务端 `packages/server/team/agent-event-stream.js:166` 的 `close()`：优雅关闭时对每个在线 agent 调 `endAgent()`，而 `endAgent()` 会广播 `agent.revoked`（文案“账号已在其他设备登录或被管理员撤销”）。**每次关服务端，所有客户端都被告知“你被吊销了”**，然后按设计的认证失败语义永久停止。

同时看门狗 12:12:09 的拉起没生效：`runtime.json` 停在 stopped，`last_seen_at` 卡在 12:11:47，但 12:13:03 又出现 ownership 扫描——说明 `AgentRuntime::start` 卡在 `prepare_startup_bindings`（在心跳循环启动之前，且无超时）。

本轮改动：

- 服务端 `close()`：只 `clearInterval` + `response.end()`，不再发 `agent.revoked`。
- 客户端 `handle_frame("agent.revoked")`：不再直接 `stop()`，改为 warn + `heartbeat_wake.notify_one()` 复验；真吊销会在心跳拿到 401 后走认证失败分支。
- `AgentRuntime` 新增 `auth_failed` 标记与 `is_auth_failed()`；认证失败的停止不再被看门狗反复拉起。
- `AgentRuntime::start`：`prepare_startup_bindings` 移到独立任务里，事件循环与心跳循环先启动，预热卡住不再挡住心跳。
- `store.write_state` 失败时写 warn（此前静默丢弃，导致按文件判断状态会误判）。
- `agent_service`：启动开始/完成/重复启动跳过都落日志；看门狗区分“认证失败不重试”与“最多 10 次”。
