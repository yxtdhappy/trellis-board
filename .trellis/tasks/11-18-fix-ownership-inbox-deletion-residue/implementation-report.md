# 实施报告

## 结论

最终方案已移植到模块化后的最新 `task_sync` 结构。待归属摘要删除现在只依赖稳定
`taskDir`；只有父目录可读且候选任务目录逐项明确 `NotFound` 时才删除远端摘要。远端删除
全部成功后，才通过一个 cursor patch 同时清理 `ownershipPending` 和 `pendingRejected`。

服务端已先兼容新契约；客户端删除请求不再读取已消失的 `task.json`，也不再从目录名猜任务 ID。

## 代码变更

- `packages/server/team/task-ownership-inbox.js`
  - delete 的 `taskId` 改为可选，`taskDir` 必填。
  - 删除 SQL 使用
    `project_id + source_task_space_id + source_agent_id + task_dir`。
  - 旧客户端携带 `taskId` 时继续校验格式并保持兼容。
- `packages/desktop/src-tauri/src/agent/task_sync/ownership_inbox.rs`
  - 新增统一清理流程 `cleanup_missing_ownership_inbox()`。
  - 候选目录取 `ownershipPending ∪ pendingRejected`。
  - `.trellis`、`.trellis/tasks`、目标目录均使用 `symlink_metadata` 和词法路径校验；
    根缺失/不可读、symlink、非目录、未知 IO 错误全部失败关闭。
  - deletes 只发送 `{"taskDir": ...}`，按 200 项分批；任一批失败都保留两份本地账本。
  - watcher 只检查本次事件涉及的候选目录，避免每次改动遍历全部待归属账本。
  - 普通“已归属”删除也从两份状态并集计算，不再单独遗漏 `pendingRejected`。
- `packages/desktop/src-tauri/src/agent/task_sync/cursor.rs`
  - 新增单个 patch 内的 `ownership_ledger_removals`，在 `write_cursor()` 持有写锁并重读
    最新 cursor 后，同时移除 `ownershipPending` 和 `pendingRejected`。
- `packages/desktop/src-tauri/src/agent/task_sync/watch.rs`
  - watcher 删除事件先执行安全摘要清理，再继续原有 `upload_dirty()` 墓碑流程。
- `packages/desktop/src-tauri/src/agent/task_sync/ownership.rs`
  - 启动及 watcher 后台 ownership 校验成功后执行同一清理流程。
- `packages/desktop/src-tauri/src/agent/task_sync/sync_api.rs`
  - 打开归属处理界面时先执行同一清理流程，不再先清 cursor 再丢失删除差集。
- `packages/desktop/src-tauri/src/agent/task_sync/tests/ownership_inbox.rs`
  - 覆盖 taskDir-only 请求、双账本原子清理、服务端 500 保留账本、根目录缺失失败关闭、
    旧服务端 404 兼容、禁猜 taskId、200 项分批和部分批次失败。
- `.trellis/spec/backend/task-ownership-and-conflict-idempotency.md`
  - 固化服务端 `taskDir` 删除身份和失败矩阵。
- `.trellis/spec/backend/desktop-realtime-sync.md`
  - 固化双账本、批次提交、先远端后 cursor 和重启重试契约。

## 验证结果

- `node --test packages/server/test/task-ownership-inbox.test.js`：7/7 通过。
- `node --test packages/server/test/team-gitless-http.test.js`：4/4 通过。
- `yarn oxfmt --check`：本次涉及的 3 个 JS 文件通过。
- IDEA MCP `lint_files`：所有修改的 Rust 源文件和新增测试无问题。
- `python ./.trellis/scripts/task.py validate 11-18-fix-ownership-inbox-deletion-residue`：通过。
- `git diff --check`：通过。

## 未完成/后续

- 当前机器没有 `cargo`、`rustc`、`rustup`、`rustfmt`，也未发现未加入 PATH 的 Rust 工具链，
  因此 `cargo fmt --check`、Rust 单元测试和编译不能标记为通过。
- 未生成包含本次 Rust 修改的新桌面安装包，因此未执行真实 Windows 客户端 E2E。
- 全仓 `yarn format:check` 仍被 11 个既有无关文件阻断；本次修改文件已单独格式化检查通过。
- 尚未提交、推送或归档。
