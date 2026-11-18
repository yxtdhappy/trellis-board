# 待归属收件箱删除契约调研

## 结论

当前问题不是 watcher 没有发现目录删除，而是删除意图无法稳定传到服务端：

- 客户端先清 cursor，再计算 previous/current 差集；
- 目录已删除时无法读取 `task.json.id`；
- basename fallback 与真实 task ID 不一致；
- 服务端 delete 只按 task ID 匹配；
- `pendingRejected` 没有随待归属摘要一起清理。

最小完整修复以 `taskDir` 作为客户端到服务端的安全删除身份，并继续使用 Agent、taskSpace、project
做来源隔离。现有 cursor 两份状态作为重试账本，不新增 schema。

> 后续工作区已切换到模块化版本。下文单体 `task_sync.rs` 的行号是调研当时证据；最终实现位于
> `task_sync/ownership_inbox.rs`、`cursor.rs`、`watch.rs`、`ownership.rs` 和 `sync_api.rs`。

## 已确认事实

### 客户端清除顺序丢失删除意图

- `list_task_ownership()` 在
  `packages/desktop/src-tauri/src/agent/task_sync.rs:7779`
  调用 `clear_ownership_pending()`，之后才调用 `sync_ownership_inbox()`。
- `resolve_task_ownership()` 在
  `packages/desktop/src-tauri/src/agent/task_sync.rs:6357-6382`
  同样先清 ownership，再生成 inbox diff。
- `sync_ownership_inbox()` 的 delete 只在
  `packages/desktop/src-tauri/src/agent/task_sync.rs:6097-6122`
  从 previous 中存在、current 中不存在的目录生成。

因此必须先保存候选、完成远端删除，再清 cursor。

### task.json 删除后无法恢复稳定 ID

- `read_ownership_inbox_task_id()` 位于
  `packages/desktop/src-tauri/src/agent/task_sync.rs:6142-6150`，读取目标 `task.json`。
- 文件已删除时读取失败，当前代码在
  `packages/desktop/src-tauri/src/agent/task_sync.rs:6112`
  使用 taskDir basename。

这是不可靠的推断，不应继续使用。

### 服务端删除匹配键

- `normalizeDelete()` 位于
  `packages/server/team/task-ownership-inbox.js:87-95`，当前强制要求 `taskId + taskDir`。
- 路由内 delete 位于
  `packages/server/team/task-ownership-inbox.js:251-258`，
  条件为 `source_task_space_id + source_agent_id + task_id`。
- 公共删除 helper 位于
  `packages/server/team/task-ownership-inbox.js:171-181`，
  按 `project_id + task_id` 删除，不包含 taskDir。

新契约应只把 taskDir 当删除身份，taskId 仅兼容旧请求。

### 两份 cursor 状态

- `Cursor.ownership_pending` 和 `Cursor.pending_rejected` 分别位于
  `packages/desktop/src-tauri/src/agent/task_sync.rs:1088-1089`。
- `cursor_from_entry()` 在
  `packages/desktop/src-tauri/src/agent/task_sync.rs:1126-1170`
  解析并过滤归档状态。
- `device.rs:889-895` 把 `pendingRejected` 和 `conflictBlocked` 投影到 ProjectRail。

同一删除任务必须是两份状态联合判断，并一次 cursor patch 清理。

### 根目录缺失保护

- `read_local_task_snapshot_files()` 在
  `packages/desktop/src-tauri/src/agent/task_sync.rs:11013-11024`
  对 `.trellis` 或 `.trellis/tasks` 的 NotFound 返回空数组。
- 空数组不能直接解释为“所有任务已删除”。
- 安全清理必须直接验证父目录状态，并只对 cursor 候选逐项 stat。

### 启动和 watcher 触发

- watcher 删除事件在
  `packages/desktop/src-tauri/src/agent/task_sync.rs:5082-5107`
  合并后先 `upload_dirty()`，再排队 ownership validation。
- 启动时 `sync_task_spaces()` 在
  `packages/desktop/src-tauri/src/agent/task_sync.rs:3408-3411`
  完成 pull 后调用 `validate_ownership_binding()`。
- ownership worker 在
  `packages/desktop/src-tauri/src/agent/task_sync.rs:4519-4548`
  串行处理 taskSpace。

复用这两个现有入口即可覆盖即时 watcher、启动、watcher 丢事件的重试；不需要增加新后台循环。

## 相关规范约束

- `.trellis/spec/backend/task-ownership-and-conflict-idempotency.md`
  - 收件箱摘要不保存正文；
  - upsert/delete 必须幂等；
  - 正常任务快照接受时在同一事务删除摘要；
  - 本地删除目录不能永久残留待确认状态。
- `.trellis/spec/backend/desktop-realtime-sync.md`
  - `taskDir` 是跨客户端稳定身份；
  - 日志不得包含 repoPath；
  - 只有完整应用成功后才推进状态；
  - 临时不可访问和失败必须失败关闭。
- `.trellis/spec/backend/desktop-task-path-resolution.md`
  - 使用 `resolve_task_dir_under()` 做词法路径校验；
  - symlink、异常组件失败关闭；
  - 目标目录不存在是合法协议状态，但必须基于明确 NotFound。

## 测试落点

- 服务端：`packages/server/test/task-ownership-inbox.test.js`
  - taskDir-only delete、ID 不一致、来源隔离、幂等、非法输入。
- 客户端：`packages/desktop/src-tauri/src/agent/task_sync.rs` 内 `mod tests`
  - mock API 捕获 delete 请求；
  - 网络失败保留 cursor；
  - 根目录缺失不清状态；
  - 单目录 NotFound 成功清理两份状态；
  - symlink/异常类型失败关闭。
- 真实 E2E：
  - 目录 basename 与 taskId 不同；
  - 删除后 5 秒内收件箱/cursor/UI 全部归零；
  - 重启不复活；
  - 离线失败后恢复连接自动收敛。

## 未采用方案

- 从目录名解析日期前缀还原 taskId：依赖非稳定命名规则。
- 全仓递归扫描寻找旧 ID：删除后正文已不存在。
- 新 deletion queue：现有两份 cursor 状态已满足持久重试。
- 宽限期：用户已明确选择立即清理。
