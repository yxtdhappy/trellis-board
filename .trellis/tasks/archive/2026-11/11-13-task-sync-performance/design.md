# Agent 任务同步性能优化设计

## 1. 范围与原则

本设计只处理“相同或更旧 revision 的重复通知产生的无效工作”。真实 revision 变化后的同步算法保持现状。

修复顺序遵循最小改动：

1. 服务端不再重复广播同 revision。
2. 客户端在进入完整 `pull` 前用 revision 短路。
3. 游标写入层拒绝无实际变化的 patch。
4. 自动化测试和真实 0.3 Rust Agent 测量闭环验证。

不在本轮改游标存储结构。只有前三项完成后真实新 revision 工作仍高，才另开增量扫描任务。

## 2. 当前数据流

```text
task snapshot committed
  -> task-space-index projection
  -> createAgentEventStream.notifyTaskSpaceChanged(taskSpaceId, revision)
  -> Agent SSE "task.changed"
  -> AgentRuntime._handle_event
  -> TaskSync.pull_and_report
  -> pull
  -> fetch_snapshot
  -> local_sync_state(None)
  -> read_local_task_snapshot_files(None)
  -> write_cursor
  -> write_atomic(live-cursors.json)
```

重复通知即使 revision 不变，也会走完整链路。

## 3. 服务端设计

### 3.1 状态

在 `createAgentEventStream` 内维护：

```text
lastTaskRevisionByTaskSpace: Map<taskSpaceId, number>
```

不持久化。服务端重启后，在线 Agent 重连会通过现有绑定拉取补齐。

### 3.2 通知规则

`notifyTaskSpaceChanged(taskSpaceId, revision)`：

- revision 必须是安全非负整数。
- 若 `revision <= lastTaskRevisionByTaskSpace.get(taskSpaceId)`，直接返回。
- 否则先更新 map，再向所有在线 approved binding 发送一次事件。

这避免同一投影反复完成或旧投影晚到时产生重复/乱序广播。

### 3.3 兼容性

- SSE payload 保持 `type=task.changed`、`taskSpaceId`、`revision` 不变。
- 不新增 API、数据库表或配置项。
- 客户端首次连接、重连和 `resync.required` 的补偿路径不依赖这一内存 map。

## 4. 客户端设计

### 4.1 事件解析

`AgentRuntime` 从 `task.changed` payload 读取可选 `revision`，调用带 revision 的任务同步入口：

```text
pull_and_report(taskSpaceId, Some(revision))
```

事件缺少 revision 时仍按旧行为拉取。

### 4.2 revision 短路

在 `TaskSync` 增加纯判定：

```text
should_pull_for_event(
  initialSyncCompleted,
  cursorRevision,
  eventRevision,
  hasPendingUpload
) -> bool
```

返回 false 的条件：

- 首次同步已完成；
- 不处于 initial review；
- 没有 pending upload；
- eventRevision 存在；
- `eventRevision <= cursorRevision`。

短路时返回结构化结果，例如：

```json
{
  "skipped": true,
  "reason": "REVISION_CURRENT",
  "revision": 10
}
```

不调用 `fetch_snapshot`、`local_sync_state`、`read_local_task_snapshot_files` 或 `write_cursor`。

### 4.3 revision 读取

避免为了判断 revision 深拷贝完整 cursor：

- 增加只读的 `cursor_revision(taskSpaceId)`，直接读取现有缓存 state 的数值字段。
- 或在 `TaskSync` 内缓存每 taskSpace 的 revision，所有 `write_cursor` 和首次读取后同步更新。
- 缓存允许暂时偏旧，因此最坏结果是多一次安全拉取；不得偏新，否则可能漏同步。

实现时选择改动更小且测试更容易的一种；优先直接读取现有 `cursor_state`。

### 4.4 pending 例外

存在 `cursor.pending` 时必须继续现有 retry 流程。即使事件 revision 不新，也不能跳过待上传批次。

本地文件变化仍由 notify watcher 独立触发上传，不依赖远端 `task.changed`。

## 5. 游标写入设计

将 patch 应用逻辑与落盘判断拆开：

```text
apply_cursor_patch(entry, patch) -> changed: bool
```

比较字段：

- revision
- sequence
- baselines
- deferred
- ownershipPending
- conflictBlocked
- pending

只有 `changed=true` 才：

1. 更新 `updatedAt`；
2. 序列化完整 state；
3. 原子替换游标文件；
4. 更新内存缓存。

`updatedAt` 语义调整为“最后一次实际状态变化时间”，不再是“最后一次调用 write_cursor 的时间”。

## 6. 测试设计

### 服务端

新增 `agent-event-stream` 单元测试：

- 相同 revision 只发送一次。
- 旧 revision 被忽略。
- 新 revision 正常发送。
- 多 taskSpace 去重互不影响。

### 客户端

纯函数测试：

- same/older revision + no pending -> skip。
- newer revision -> pull。
- initial sync -> pull。
- pending upload -> pull。
- missing revision -> pull。

游标测试：

- identical patch 不写文件。
- revision、sequence、baselines、deferred、pending 等任一变化会写文件。

### 真实构建

在 0.3 Rust Agent 上执行：

1. 构造 10 分钟重复同 revision 事件压力。
2. 记录任务空间 GET 次数、Agent CPU、读/写字节和游标 mtime 修改次数。
3. 发送一个新 revision，确认只拉取一次且本地文件、baseline、revision 全部更新。
4. 校验首次同步、pending retry、冲突和分支不一致路径。

## 7. 风险与回滚

主要风险是错误跳过本应重试的 pending upload。通过 pending 例外和专项测试规避。

第二风险是服务端内存去重状态在重启后丢失。该状态只抑制重复广播，不承担一致性恢复；客户端重连全量拉取仍是权威补偿。

回滚可以按层独立进行：

- 先移除客户端 revision 短路。
- 再恢复服务端广播。
- 游标无变化保护可单独保留，因为它不改变持久化 schema。

## 8. 后续优化

若真实新 revision 场景仍显示高 CPU/I/O，再评估：

- 按 taskSpace 分片 cursor 文件；
- cursor 迁移 SQLite；
- 本地任务 mtime/hash 索引；
- 只扫描服务端变化目录并使用 watcher dirty set。

这些改动不作为本任务 MVP 的前置条件。
