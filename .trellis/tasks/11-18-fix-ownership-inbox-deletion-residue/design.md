# 待归属删除残留收敛设计

## 1. 目标与约束

采用立即清理。删除身份使用跨端稳定的 `taskDir`，不再依赖已经消失的 `task.json`。

必须同时满足：

- 单任务明确删除可以收敛；
- 临时不可读不会触发批量误删；
- 请求失败可以重试；
- 不新增客户端 cursor schema 版本或服务端数据库迁移；
- 不做全量任务正文扫描，不改变归档同步链路。

## 2. 当前缺陷

### 2.1 删除意图先被清掉

`list_task_ownership()` 和 `resolve_task_ownership()` 会先从 cursor 删除 `ownershipPending`，
随后 `sync_ownership_inbox()` 才用 previous/current 差集生成 delete。此时删除意图已经丢失。

### 2.2 删除 ID 不可恢复

任务目录删除后无法再读取 `task.json.id`。当前 fallback 使用目录 basename，但 Trellis 目录包含日期前缀，
不能保证等于稳定任务 ID。服务端只按 `task_id` 删除时，请求会成功返回却删除 0 行。

### 2.3 `pendingRejected` 是另一份状态

同一任务可能同时存在于：

- `ownershipPending`：待归属摘要；
- `pendingRejected`：最近一次服务端明确拒绝的本地摘要。

现有待归属清理只处理其中一份，所以客户端仍可能显示“1 个任务服务端拒绝待处理”。

## 3. 删除身份

### 服务端请求

`PUT /api/agent/task-spaces/:taskSpaceId/ownership-inbox`

新客户端删除项：

```json
{
  "deletes": [
    {
      "taskDir": ".trellis/tasks/11-18-task-a"
    }
  ]
}
```

兼容旧客户端：

```json
{
  "deletes": [
    {
      "taskId": "task-a",
      "taskDir": ".trellis/tasks/11-18-task-a"
    }
  ]
}
```

服务端规则：

- `taskDir` 必填并继续走现有路径校验；
- `taskId` 可省略；存在时仍校验格式，但不再作为唯一删除键；
- 删除条件为
  `project_id + source_task_space_id + source_agent_id + task_dir`；
- 相同来源、相同目录的多个历史 task ID 行同时删除；
- 不删除其他 Agent、项目或 taskSpace 的行。

这样即使任务 ID 已不可读、目录 basename 与 ID 不一致，也能精确删除本客户端的来源摘要。

## 4. 客户端数据流

### 4.1 重试账本复用现有 cursor

不新增删除队列。候选目录来自：

```text
ownershipPending.keys() ∪ pendingRejected.keys()
```

这两份状态只在该任务的摘要已确认收敛后一起删除，因此天然承担：

- 网络失败后的重试凭据；
- 客户端重启后的恢复依据；
- 旧版本已经清掉 `ownershipPending`、但还残留 `pendingRejected` 的兼容依据。

如果两份状态里都没有某个目录，说明本客户端没有待收敛的摘要来源，watcher 不应凭空发送删除。

### 4.2 安全判定具体目录缺失

新增一个只检查候选目录的辅助流程：

1. 读取 cursor，求出两份状态的并集；
2. 与 watcher 明确删除的 taskDir 或本轮已扫描的 localDirs 求候选；
3. 验证 `.trellis`、`.trellis/tasks` 是真实目录且不是符号链接；
4. 对每个候选使用现有 `resolve_task_dir_under()` 解析到 repo 内；
5. `NotFound` 才记为明确删除；
6. 目录仍存在、根不可读、路径异常、symlink 或未知 IO 错误都不删除，保留 cursor。

该流程不递归扫描任务正文，只 stat cursor 中少量候选目录。

### 4.3 先服务端、后本地 cursor

```text
明确缺失 taskDirs
  -> 读取当前 cursor
  -> PUT deletes[{ taskDir }]
  -> 2xx
  -> 一个 write_cursor patch 同时删除
       ownershipPending[taskDir]
       pendingRejected[taskDir]
  -> notify_state_changed
  -> ProjectRail 重新读取 associations
```

失败顺序：

```text
PUT 失败 / 网络失败 / 5xx / branch mismatch
  -> 不修改 cursor
  -> 保留两份状态
  -> 记录脱敏告警
  -> 下一次 watcher、ownership 校验或重启重试
```

超过 200 个明确缺失目录时沿用现有批次上限分批提交。部分批次成功、后续批次失败时不清 cursor；
下一次重试先幂等删除已在服务端消失的行，全部批次成功后再一起清理本地两份状态。

服务端 404/405 表示对应旧服务端没有 inbox 能力，因此不可能存在远端 inbox 行。此兼容场景可以清除已明确删除任务的本地摘要，并继续把能力标记为 unavailable。

## 5. 触发点

### 5.1 watcher 明确删除

`watch_loop()` 在首次同步完成、拿到 taskSpace 串行锁后：

1. 先对本次事件涉及的 taskDir 执行安全缺失判定和摘要清理；
2. 再执行原有 `upload_dirty()`，继续处理普通任务墓碑；
3. 清理失败不阻断普通删除上传，但保留 cursor 供后续重试；
4. 现有 ownership validation worker 仍会被 enqueue，形成第二次收敛机会。

先在删除路径清理摘要，是为了让收件箱和 ProjectRail 尽早消失；普通任务索引/墓碑仍按原链路完成。

### 5.2 启动与 watcher 后台校验

`validate_ownership_binding()` 已能获得最新 `local_dirs`。刷新成功后：

- 候选仍取两份 cursor 状态的并集；
- `候选 - local_dirs` 作为明确缺失目录；
- 调用同一清理流程；
- 失败只记录告警，不使整个 ownership 投影失败。

这覆盖：

- 客户端离线时删除目录；
- 客户端关闭期间删除目录；
- watcher 事件丢失；
- 上次网络删除失败后的重启重试。

### 5.3 打开归属处理界面

`list_task_ownership()` 必须先执行同一缺失清理，再处理剩余本地待归属任务。

不得继续先调用 `clear_ownership_pending()` 后计算差集。若摘要清理失败，函数应返回可读错误并保留 cursor，
不能出现“界面没有任务，但收件箱仍显示 1”的假收敛。

## 6. 常规 inbox 同步调整

`sync_ownership_inbox()` 的删除项统一改为：

```json
{
  "taskDir": ".trellis/tasks/..."
}
```

删除 `read_ownership_inbox_task_id()` 和 basename fallback。

常规任务被正常接纳时，服务端仍在 `applyChanges()` 事务中按稳定 task ID 清理摘要；本次改动不改变该保护。

## 7. 兼容与发布顺序

- 服务端先发布：新服务端同时接受只带 `taskDir` 和旧 `taskId + taskDir` 请求。
- 客户端后发布：新客户端只依赖 `taskDir`。
- 新客户端暂连旧服务端时，删除请求可能返回 400；客户端保留 cursor，不丢状态。升级服务端后重试即可收敛。
- 不新增 SQLite 表或列，不需要数据库迁移。
- 旧 `live-cursors.json` 继续使用原字段，不提升 cursor version。

## 8. 性能与安全

- watcher 路径：只检查本次事件相关的少量候选目录。
- 启动路径：复用 ownership 索引已经获得的 localDirs，不新增全仓扫描。
- 手动归属界面：复用该界面本来就会执行的扫描结果。
- 删除请求沿用现有 200 项批次上限分批提交。
- 父目录不可读时明确失败关闭，不把空结果解释为“全部删除”。
- 日志只记录 taskSpaceId、taskDir 和错误摘要，不记录 repoPath。

## 9. 放弃的方案

- 解析日期前缀还原 taskId：目录命名不是稳定 ID 协议，不能成为长期依赖。
- 增加短暂宽限期：已确认采用立即清理。
- 新增独立 deletion queue：现有两份 cursor 状态已经提供持久重试依据，增加新状态会扩大迁移面。
- 退回全量任务扫描寻找旧 ID：删除后信息已经不存在，且会放大启动成本。
- 服务端直接按 taskDir 全局删除：必须保留 agent/taskSpace/project 隔离，防止误删其他来源。

## 10. 回滚

- 服务端回滚后，新客户端删除可能暂时无法命中，但 cursor 保留，不会造成数据丢失。
- 客户端回滚后，旧客户端仍可发送带 `taskId + taskDir` 的请求，新服务端继续兼容。
- 不涉及破坏性数据迁移，无历史数据删除。
