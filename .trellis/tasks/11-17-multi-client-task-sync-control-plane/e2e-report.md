# 多客户端任务同步控制面 E2E 报告

## 环境与版本生效

- 日期：2026-11-18，Asia/Shanghai。
- 桌面客户端：PID 40996，`TrellisBoard_0.4.37_x64-portable`，基于本地提交 `60abf1c`
  工作区构建；服务端重启后 SSE 于 08:58:21 自动重连，心跳持续返回 200。
- 创建验证服务端：PID 46044，08:51:10 启动，监听 `0.0.0.0:4317`；启动日志包含
  `Trellis Team Board 已启动`，stderr 为空。
- 清理后恢复服务端：PID 43360，08:57:28 启动，监听 `0.0.0.0:4317`，stderr 为空。
- Board：`http://192.168.65.27:4317/`，Chrome DevTools MCP。
- 客户端日志：`%LOCALAPPDATA%\TrellisBoard\data\logs\desktop.log`。
- 服务端日志：`%LOCALAPPDATA%\TrellisBoard\server\logs\server.1.log`。
- 数据库：`%LOCALAPPDATA%\TrellisBoard\server\board.sqlite`。

## 本轮修复

1. Agent SSE 标准 command 位于 `payload.command`。服务端兼容期同时发送顶层
   `command`，Rust 客户端优先读取嵌套字段并回退旧字段。
2. `control.changed` 只表达控制面失效；新客户端收到后拉取控制状态，旧客户端安全忽略。
3. 负责人等权威字段进入任务索引指纹，内容 revision 不变时也能刷新 Board 负责人。
4. 内容上传不再提前写 `source_cleanup_pending`；`create_task` 成功后固定为 `none`，
   只有 `assign_task` 完成索引校验后才进入来源副本清理。
5. 命令完成后推进 Board 查询 revision 并广播 `control.changed`，避免创建者等待无关任务变化。

## 创建链路

测试数据：

```text
taskId: e2e-create-control-fixed-20261118
executionTaskKey: a8d34d0e-54af-4041-bb2c-4507665c7abe::e2e-create-control-fixed-20261118
commandId: 1adfbfcd-e97e-4ed6-9dd7-f0b25ea4df3b
```

操作与证据：

1. 在 Board 创建并派发给 `yhj`，项目 `trellis-board`，taskSpace `main`。
2. 客户端 `POST /api/agent/commands/{commandId}/start` 返回 200。
3. 客户端 `POST /api/agent/tasks/{executionTaskKey}/claim` 返回 200。
4. 本地生成 4 个任务文件，客户端 `POST /api/agent/task-spaces/{taskSpaceId}/changes`
   返回 200，revision 从 540 推进到 541。
5. 客户端 `POST /api/agent/commands/{commandId}/result` 返回 200。
6. Board 操作显示“已完成”，说明为“任务文件已同步并由服务端索引成功”；任务卡显示
   “任务已落地”，不再显示“等待来源副本清理”。
7. 服务端投影日志：revision 541 提交，`changedTaskCount=1`、`changedIndexCount=1`，
   无异常堆栈。

数据库核验：

```text
command.status                         = succeeded
sync_task.materialization_state         = materialized
sync_task.materialized_revision         = 541
sync_task.created_by_user_id            = 03bccc67-f8b8-4053-8c66-ad8a03c3d1ae
sync_task.assignee_user_id              = 39590d0e-9a73-4647-bc88-13bde92eac4f
sync_task.handoff_state                 = none
sync_task_index.assignee_user_id        = 39590d0e-9a73-4647-bc88-13bde92eac4f
sync_task_index.assignee_dev_id         = yhj
```

结论：`create_task` 跨用户创建成功，不再误入来源副本清理。

## 删除与清理

1. 本地探针目录先移动到可恢复临时备份，Git 状态为 `??`，未删除正文。
2. watcher 提交 4 条 `deleted=1` 墓碑，revision 推进到 542。
3. Board 刷新后不再出现探针，进行中数量从 11 回到 10。
4. `sync_task_index` 在墓碑提交后无探针记录。
5. 清理前生成独立数据库备份：
   `%LOCALAPPDATA%\TrellisBoard\server\backups\board.sqlite.pre-e2e-probe-cleanup.2026-11-18T00-56-30Z`，
   79,753,216 字节。
6. 单事务按 3 个完整 executionTaskKey / taskId 清理：
   - 3 个 `sync_task`；
   - 6 个 `sync_task_lease`；
   - 4 个 `sync_task_command`；
   - 12 个 `sync_task_space_file` 墓碑；
   - 34 个 `sync_file_audit`；
   - 10 个 `sync_task_space_batch`。
7. 清理后复核任务、租约、命令、文件、索引、文件审计计数全部为 0；taskSpace
   `revision=indexed_revision=542`，`archive_revision=archive_indexed_revision=7`。
8. 三个探针正文保留在 `%TEMP%\trellis-board-e2e-probe-backup-20261118-082800` 与
   `%TEMP%\trellis-board-e2e-probe-backup-20261118-085517`，可恢复。

## 自动化验证

```text
node --test packages/server/test/team-task-commands.test.js \
  packages/server/test/team-task-control.test.js \
  packages/server/test/agent-event-stream.test.js \
  packages/server/test/team-task-index-v10.test.js

46 passed / 0 failed / 0 skipped
```

- IDEA MCP 对 `runtime.rs` 错误级检查无错误。
- `git diff --check` 通过。
- 当前 Windows 环境无 `cargo`/`rustc`，Rust 测试与桌面构建由 GitHub `windows.yml`
  真实验证。

## 未覆盖边界

- 当前只有 `yhj` 一个真实桌面客户端，无法完成第二账号的完整 `assign_task` handoff、
  目标 materialization 和创建者自动清理通知。
- Windows 隐藏/最小化系统通知未完成第二账号真机验收。
- 真实 Git 归档后的干净副本自动备份删除、dirty/Git tracked 副本保留仍需双客户端
  taskSpace 验证。
- 旧客户端只验证了未知事件默认忽略的源码分支；当前构建的客户端已包含
  `control.changed` 处理器，但本轮没有第二账号触发完整 handoff。
