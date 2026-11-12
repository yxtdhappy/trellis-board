# Implementation

## M1 合并 main

- `git merge --no-ff origin/main`。
- 解冲突：modify/delete 全部 `git rm`；`main.rs` 手工合并；`TaskCard.tsx` 取 main。
- 校验：`git grep -n "sidecar" -- desktop/src-tauri/src desktop/ui` 无残留代码引用；前端 `invoke(` 命令名与 `generate_handler!` 一致。

## M2 分支隔离（`d58b021`）

1. `agent/git.rs`：`assert_repository_branch`。
2. `agent/store.rs`：`assert_repository_bindings_converged` + `save_config`/`update_config` 传入 previous。
3. `agent/task_sync.rs`：`BRANCH_GUARD_ERROR_CODES`、`select_bindings`、`assert_binding_branch`、守卫错误持久化与清除、上传 `observedBranchName`、`BINDING_INACTIVE` 语义。
4. `agent/runtime.rs` / `agent/task_command.rs`：不覆盖守卫错误。
5. `agent/onboarding.rs`：`attach_project` 按 `local_repo_key` 去重。

## M3 游标串行化（`0fd2dc0`）

1. `agent/store.rs`：`lock_file` 抽出、`AgentPaths::task_cursor_lock_file`（`.live-cursors.lock`）、`lock_task_cursors`。
2. `agent/task_sync.rs`：`write_cursor` 先拿文件锁再重读磁盘合并；`required_client_sequence` 解析 `details.requiredClientSequence`，同批次改写 pending 序号后重试一次。

## M4 deferred 补同步（`80647fc`）

1. `agent/task_sync.rs::sync_deferred_tasks`。
2. `agent/device.rs::read_local_associations` 增加 deferred 字段。
3. `agent_service.rs`：`LocalAssociation` 字段 + `sync_deferred_tasks`。
4. `main.rs`：命令 + 注册；permissions/capabilities（合并已带入）。

## M5 锁恢复与托盘同步（`86bd1db` + `0caf270`）

1. `agent_service.rs`：`sync_action`、托盘同步菜单项与标签刷新（运行中「暂停同步」/暂停后「恢复同步」）。
2. `main.rs`：托盘 `sync` 菜单项接 `sync_action`。
3. `agent/runtime.rs`：SSE 重连后重新应用绑定并捕获错误（`事件流恢复后同步任务空间失败`）；心跳不覆盖分支守卫错误。
4. 不移植 `force_restart`：进程内 Agent 无子进程与 `agent.lock`，等效操作就是 `restart()`；理由写入 spec 与 README。

## M6 验证与收尾

- `cargo fmt --all`、`cargo check --all-targets`、`cargo clippy --all-targets`（0 error）、`cargo test --bins` 87 passed、`npm test` 454 tests / 449 pass / 0 fail / 5 skipped（345s）、`npm run build`、`cargo build --release`。
- `target/release` 仅 `trellis-board-client.exe`（7,740,416 字节），无 sidecar/Node 产物。
- 更新 `.trellis/spec/backend/desktop-agent-runtime.md` 与 `desktop/README.md` 记录新不变量。

## 4. 联调验证（2026-11-12，本地 Team 服务端 4317）

| 场景 | 操作 | 结果 |
| --- | --- | --- |
| 分支守卫 | clone 切到 `guard-smoke2` 后修改任务文件 | 服务端 revision 不变；绑定 `lastErrorCode=BRANCH_MISMATCH`、`liveSyncError` 写明实际分支；日志一条 `任务空间同步失败` |
| 守卫恢复 | 切回绑定分支后再次修改 | revision 71，`liveSyncStatus=ready`，错误清空 |
| deferred 补同步 | safe 模式首次同步 + 本地新增任务目录 | `cursor.deferred` 记录 2 个文件；`sync_deferred_tasks` 返回 `syncedCount=1`，服务端 revision 72、两个文件落库，deferred 清空 |
| 409 序号恢复 | 服务端批次序号抬到 9.7e12 后修改任务 | 日志 `上传序号落后于服务端，改用 9700000000001 重试`；重试成功 revision 73，cursor 序号同步 |
| 冷启动 | 双击 release exe | 环境门直连登录页；4s 内写 `agent/runtime.json`，心跳 15s 一次 |

联调期间发现并修复的缺陷：

1. `agent/task_sync.rs` watcher 只在 `initialSyncCompleted` 已完成时建立，首次接入当天不再监听本地改动 → 改为「所有可写绑定都建 watcher，flush 时再判 `initialSyncCompleted`」。
2. `agent/http.rs::map_server_error` 只读 `payload.message`，而 Team 错误体是 `{error, code, details}` → 用户看到「服务端返回 HTTP 409」；改为优先 `error`。
