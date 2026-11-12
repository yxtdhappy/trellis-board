# Design

## 1. 合并步骤

1. `git merge origin/main`（no-ff）。
2. 冲突按类型处理：
   - modify/delete（`desktop/sidecar/{main,desktop-device}.js`、`src/sidecar.rs`、`tests/desktop-*.test.js`、`.trellis/spec/backend/desktop-sidecar-packaging.md`）：保持删除（`git rm`），语义转由 R2 移植。
   - `desktop/src-tauri/src/main.rs`：保留本分支的进程内命令实现，吸收 main 新增的命令/权限（`sync_deferred_tasks`、托盘同步项）。
   - `web/src/features/board/TaskCard.tsx`：取 main 版本（本分支未改动语义）。
3. 合并后核对前端调用的每一个 `invoke` 命令名都存在于 `generate_handler!`（main 新增了 `sync_deferred_tasks`）。

## 2. 移植映射

### 2.1 分支隔离（`d58b021`）

- `agent/git.rs` 新增 `pub async fn assert_repository_branch(repo: &Path, hooks: &Path, branch: &str) -> AgentResult<String>`：`show_toplevel` → 校验分支语法 → `current_branch`；空分支 → `DETACHED_HEAD`；不相等 → `BRANCH_MISMATCH`（「本地当前分支为 X，绑定分支为 Y」）；返回实际分支名。
- `agent/store.rs` 的 `save_config`/`update_config` 增加 `assert_repository_bindings_converged(bindings, previous)`: 同一 `local_repo_key` 下 approved 绑定 >1 且集合与旧配置不同 → `CONFIG_INVALID`（「同一本地仓库只能绑定一个任务空间；需要并行同步多个分支时请使用独立 Git worktree」）；旧配置已存在双绑定时放行（升级兼容）。
- `agent/task_sync.rs`：
  - `pub const BRANCH_GUARD_ERROR_CODES: [&str; 7]`（`BRANCH_MISMATCH`、`BRANCH_INVALID`、`DETACHED_HEAD`、`GIT_FAILED`、`NOT_GIT_REPOSITORY`、`REPO_NOT_FOUND`、`REPO_PATH_INVALID`）。
  - `update_bindings` 改为先 `select_bindings(bindings)`：按 `local_repo_key` 分组；单绑定直接激活；多绑定逐个 `assert_binding_branch`，唯一匹配者激活，全部失败则发 `task_sync_error` 并跳过该仓库，多个匹配则持久化 `CONFIG_INVALID` 并对每个绑定发事件。
  - `assert_binding_branch(&binding)`：调用 `git::assert_repository_branch`，成功时清除该绑定的分支守卫错误（`live_sync_status` 回到 `ready` 或 `syncing`），失败且属于守卫错误码时持久化到 config 并返回错误。
  - 所有上传/拉取入口（`sync_task_directories*`、`upload_dirty`、`pull_task_space`、`resolve_initial_sync`、`decide_conflict`）在操作前 `assert_binding_branch`，上传体附加 `observedBranchName`。
  - 未知 taskSpace → `pull_task_space` 返回 `{"skipped":true,"reason":"BINDING_INACTIVE"}`（不再抛错），其余显式操作返回 `BINDING_UNKNOWN`。
- `agent/runtime.rs` 心跳合并与 `task_command.rs` 的结果回写：若已有 `last_error_code` 属于守卫错误码，保留本地值，不被服务端 `errorCode`/健康检查覆盖。
- `agent/onboarding.rs` 的 `attach_project`：替换同 `task_space_id` 或同 `local_repo_key` 的既有绑定。

### 2.2 游标串行化与序列恢复（`0fd2dc0`）

- `agent/store.rs`：抽出 `with_file_lock(lock_file, open_message, timeout_message, op)`（`create_new` + 30s 陈旧回收 + 40ms 轮询），`lock_config` 复用；新增 `live_cursor_lock_file`（`<root>/.live-cursors.lock`）与 `with_live_cursor_lock`。
- `agent/task_sync.rs`：
  - `next_client_sequence` 保持墙钟基线；新增 `required_client_sequence(&AgentError) -> Option<u64>`（读 `details.requiredClientSequence`，仅 `server_code == "CONFLICT"`）。
  - 上传循环：冲突且 `required > current` 时，把该值提升为本地扫描基线并重试一次（`sequence_recovered` 标志），超过 3 次仍失败 → `LOCKED`。
  - 游标写入走 `store.with_live_cursor_lock`，进程内 `cursor_write: Mutex<()>` 继续做串行化，二者叠加（跨进程安全）。

### 2.3 deferred 显式补同步（`80647fc`）

- `agent/task_sync.rs` 新增 `pub async fn sync_deferred_tasks(&self, task_space_id: &str) -> AgentResult<Value>`：只读绑定拒绝；读游标 `deferred` 键，空则返回 `{syncedCount:0, remainingCount:0, remainingTaskDirs:[], conflict:false}`；否则 `upload_directories` 后重读游标，返回 `syncedCount`（成功上传数）、`remainingTaskDirs`、`conflict`/`conflictId`。
- `agent/device.rs::read_local_associations` 读游标文件补充 `deferred_count`/`deferred_task_dirs`（仅 `.trellis/tasks/` 前缀、排序）。
- `agent_service::LocalAssociation` 增加 `deferred_count: usize`、`deferred_task_dirs: Vec<String>`（serde default）。
- `agent_service::sync_deferred_tasks(app, task_space_id)`：`TaskSync::new` + `set_bindings` → 调用上函数。
- `main.rs` 新增命令 `sync_deferred_tasks(task_space_id)`（`ensure_board_caller` + `validate_live_id`），注册进 `generate_handler!`；`permissions/desktop.toml` 与 `capabilities/board-local-association.json` 增加 `allow-sync-deferred-tasks`。

### 2.4 锁恢复与托盘同步项（`86bd1db`）

- `agent/lock.js` 的回收条件（仅 `ESRCH` 才判定死亡、unlink 前二次读锁比对 token/mtime）在进程内不直接适用：本分支不再创建 `agent.lock`。保留一条向后兼容：启动时若发现陈旧 `agent.lock`（旧 sidecar 遗留）且其中 PID 不存活，静默删除；存活则记日志不阻塞。
- `agent_service.rs` 新增 `force_restart(app)`：清 `pending` 控制队列残留、`stop_runtime` → 删除陈旧锁 → `start`；`sync_action(app)`：运行中重启、暂停中恢复、失败中强制重启。
- `main.rs` 托盘增加「同步」菜单项（id `sync`），标签随状态为「同步运行中」/「同步已暂停」/「同步已停止」，点击调用 `agent_service::sync_action`。
- `0caf270` 一并落地：`runtime.rs` 的 SSE `on_open` 只对活跃 taskSpace 拉取并捕获错误。

## 3. 数据兼容

- `client.json` 仍为 schema 3；新增字段只有 `LocalAssociation` 的展示字段，不写盘。
- 游标文件结构不变（`version`/`taskSpaces`），新增 `.live-cursors.lock` 仅在写入期间存在。
- 旧 `agent.lock`（若存在）在启动时按 PID 存活情况清理。

## 4. 验证

- 单测：`git::assert_repository_branch`（分支匹配/不匹配/detached）、`store::assert_repository_bindings_converged`、`task_sync::select_bindings`（三分支：唯一匹配/全不匹配/多匹配）、`required_client_sequence` 解析、`sync_deferred_tasks` 空游标路径、`read_local_associations` 的 deferred 字段。
- 联调：本地 Team 服务端 + 两个分支的 worktree，验证分支守卫与 `deferredTaskDirs`；构造 409 冲突验证 `requiredClientSequence` 恢复。
- 门禁：`cargo fmt/clippy/test --bins`、`npm test`、`cargo build --release` 单 exe。
