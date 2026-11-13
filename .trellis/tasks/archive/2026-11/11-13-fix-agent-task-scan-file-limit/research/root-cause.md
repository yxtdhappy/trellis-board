# 全量任务扫描误用批次上限根因

## 现场事实

- 项目：`D:\wit\mdp-backend-service`，当前分支 `dev`。
- taskSpace：`7b8d00fa-f478-4c47-a0ef-615462d5bdb5`。
- 可同步扩展名：`.json`、`.jsonl`、`.md`、`.txt`、`.yaml`、`.yml`。
- 当前总文件数：1561。
- 当前总大小：11.38 MiB。
- 最大任务目录：`archive/2026-10/10-03-e2e-oracle`，250 个文件。
- 当前 Agent pending 批次：无。
- 当前绑定：`syncStatus=approved`、`initialSyncCompleted=true`、`liveSyncStatus=ready`。

## 调用链

```text
task.changed
  -> TaskSync::pull
  -> local_sync_state
  -> local_groups(binding, None)
  -> read_local_task_snapshot_files(..., None)
  -> group_task_snapshot_files(all files)
  -> files.len() > 1024 -> error
```

`group_task_snapshot_files` 被同时用于：

1. 全 taskSpace 的本地扫描和远端快照分组。
2. 后续按任务目录构造上传文件的辅助路径。

但 1024/64 MiB 的业务含义是“单个 HTTP 上传批次”，不是“整个 taskSpace 文件总数”。函数在分组前执行总数校验，混淆了两个边界。

## 代码证据

- 全局批次常量：`apps/desktop/src-tauri/src/agent/task_sync.rs:16`
- 分组前文件数校验：`apps/desktop/src-tauri/src/agent/task_sync.rs:321`
- 全量本地扫描调用：`apps/desktop/src-tauri/src/agent/task_sync.rs:1878`
- 实际上传按任务目录构造：`apps/desktop/src-tauri/src/agent/task_sync.rs:2690`
- 新批次写 pending 后上传：`apps/desktop/src-tauri/src/agent/task_sync.rs:2852`
- 服务端实际上传批次限制：`apps/server/team/live-sync.js:324`
- 服务端预检显式使用无限总文件数：`apps/server/team/task-snapshot-service.js:208`
- 旧 Agent 真实 E2E 曾同步 1518 个文件：
  `.trellis/tasks/archive/2026-11/11-11-raise-task-snapshot-batch-limits/e2e-report.md`

## 失败语义

- 该错误不会永久标记或删除 taskSpace。
- Agent 会在后续 `task.changed`、文件监听或重启时再次尝试。
- 只要全量扫描仍超过 1024，当前版本会重复触发同一错误，实际表现为持续无法同步。
- 当前 pending 为 `null`，因此本次不是旧 pending 批次造成的持续阻塞。

## 修复边界

- 把聚合扫描与实际上传批次校验拆开。
- 全量扫描只负责路径、内容、重复项和任务目录分组。
- 1024 文件与 64 MiB 限制移动到真正写 pending 和重试 pending 的位置。
- 单个任务目录超过 1024 时仍明确失败，不在本任务中实现跨批 CAS 拆分。
