# 提高任务同步批量上限设计

## 1. 目标与结论

把任务快照同步的业务批量上限从 64 文件 / 8 MiB 提升到 1024 文件 / 64 MiB，同时保留：

- 单文件 1 MiB 限制；
- 文件级 CAS；
- 整批事务和任务目录完整性；
- batchId 幂等和 clientSequence 单调；
- 每 Agent/taskSpace 每秒最多 5 批；
- 仅同步 `.trellis/tasks/**`。

当前失败批次为 `10-03-e2e-oracle`，250 文件、5,648,600 字节。提高上限后，该 pending 批次
可以按原请求重试，不需要数据迁移。

## 2. 当前实现

上限目前分散在四处：

| 位置 | 当前值 | 作用 |
| --- | --- | --- |
| `shared/task-snapshot.js` | 64 / 8 MiB | 任务快照分组和默认校验 |
| `agent/live-sync.js` | 64 / 8 MiB | 客户端实时变化分批 |
| `server/team/live-sync.js` | 64 / 8 MiB | 旧实时批次服务端校验 |
| `server/team/http.js` | 9 MiB | `/changes` 等 Agent HTTP 请求体 |

此外：

- `agent/api.js` 对完整快照、预检和单任务目录响应使用 16 MiB 上限；
- Agent 上传统一使用 30 秒默认超时；
- `agent/task-snapshot-sync.js` 把单个任务目录的全部文件持久化为一个 pending 批次；
- 服务端 `task-snapshot-service.js` 先验证原始文件数，再按任务目录执行完整性与 CAS。

## 3. 常量模型

在 `shared/task-snapshot.js` 保留唯一业务上限来源：

```js
export const TASK_SNAPSHOT_MAX_FILES = 1024
export const TASK_SNAPSHOT_MAX_FILE_BYTES = 1024 * 1024
export const TASK_SNAPSHOT_MAX_BATCH_BYTES = 64 * 1024 * 1024
```

新增传输层上限，只负责容纳 JSON 请求/响应包装：

```js
export const TASK_SNAPSHOT_MAX_TRANSPORT_BYTES = 96 * 1024 * 1024
```

约束：

- `64 MiB` 始终表示所有文件 `content` 字段解码后的 UTF-8 总字节数；
- `96 MiB` 不作为可写入任务的第二套业务上限；
- HTTP 请求/响应的 JSON 编码体必须先通过 96 MiB 硬运输边界，再由业务校验执行 64 MiB
  内容限制；两个条件都满足才可写入；
- 超过 96 MiB 的请求直接返回 413，即使解码后的正文不超过 64 MiB。不得为了覆盖反斜杠或
  控制字符的理论最坏 JSON 转义膨胀，把运输上限提高到数百 MiB；
- 单文件 1 MiB 限制不变。

96 MiB 为 1024 个文件的路径、摘要和正常文本 JSON 转义预留 32 MiB 包装空间。64 MiB 是
正常文本任务的业务目标，不是任意转义形式的无条件上限。该取舍优先限制单请求内存和
拒绝服务风险；当前真实最大批次为 5.65 MiB，远低于两个限制。

## 4. 客户端改动

### 4.1 实时分批

`agent/live-sync.js` 不再维护独立的 64/8 MiB 常量，改为导入共享业务上限。

`splitLiveBatches()` 继续按 taskSpace 内任务目录分组并串行切批，避免跨任务混合；切批条件更新为：

```text
batch.length >= TASK_SNAPSHOT_MAX_FILES
或 batch 内容总字节 + 下一个文件 > TASK_SNAPSHOT_MAX_BATCH_BYTES
```

### 4.2 初始快照 pending

`agent/task-snapshot-sync.js` 当前将单任务目录完整文件列表写入 cursor 的 `pending`。本次不拆分
已有 250 文件批次，因为：

- 新上限允许该任务一次提交；
- 保留同一 pending 的 batchId/clientSequence 可以走现有幂等重试；
- 不需要迁移本地 cursor 或服务端 revision。

以后单个任务超过 1024 文件或 64 MiB 时，仍由现有校验整批拒绝，而不是静默拆成半个任务。

### 4.3 响应和超时

`AgentApiClient` 对以下响应使用共享运输上限：

- `preflightTaskSpaceAccess`
- `fetchTaskSpaceSnapshot`
- `fetchTaskDirectory`

大任务快照上传、预检和完整快照拉取的超时从 30 秒调整到 120 秒。普通小请求继续使用默认超时。

## 5. 服务端改动

### 5.1 业务校验

`server/team/task-snapshot-service.js` 继续通过 `groupTaskSnapshotFiles()` 验证：

- `rawFiles.length` 不超过 1024；
- 内容总和不超过 64 MiB；
- 单文件不超过 1 MiB；
- 同一批最多一个任务目录或一次归档移动。

错误文案改为 64 MiB，并保持 413 + `BODY_TOO_LARGE`。

`server/team/live-sync.js` 改为导入共享常量，防止旧实时路径继续使用 64/8 MiB。

### 5.2 HTTP 边界

`server/team/http.js` 的 `MAX_LIVE_BATCH_BYTES` 改为共享运输上限 96 MiB，用于：

- attach；
- preflight；
- changes；
- conflict resolve。

普通 JSON 请求继续使用 64 KiB 上限，不因批量放宽而放宽所有接口。

### 5.3 持久化与 revision

数据库 schema 不变：

- `sync_task_space_file.content_text` 已能保存单文件最多 1 MiB；
- 单个批次仍在同一 SQLite 事务中写入；
- 成功批次只增加一次 taskSpace revision；
- 超限批次在写入前失败，不产生 batch、audit、revision 或索引变化。

## 6. 兼容与部署

- Agent 协议版本保持 3，字段结构不变。
- 先部署新服务端即可接受现有客户端发送的 250 文件 pending 批次。
- 新服务端仍兼容旧客户端的小批次行为。
- 新客户端发布后再统一使用 1024/64 MiB 主动分批和更大的响应上限。
- 旧服务端不能接受新客户端未来发送的超过 64 文件批次，因此客户端不应先于服务端升级。
- 若 Team 服务位于 Nginx 等反向代理后，代理请求体限制必须至少允许 96 MiB JSON 运输体。

## 7. 风险与取舍

- `readJsonBody()` 当前把完整请求缓冲到内存；96 MiB 运输硬上限用于约束最坏瞬时内存，
  本次不引入流式 JSON 解析，避免扩大改动面。
- 96 MiB 是传输保护，不表示允许写入 96 MiB 任务正文；业务校验始终执行 64 MiB。
- 反斜杠或控制字符较多时，JSON 包装可能使解码后不足 64 MiB 的正文超过 96 MiB。此时由
  运输层明确返回 413，不接受数百 MiB 单请求。
- 超大任务仍可能超过 64 MiB，本任务选择明确拒绝而不是部分同步。
- 不改变单文件限制，单个 Markdown/JSONL 仍不能超过 1 MiB。

## 8. 验证策略

1. 共享边界：1024/1025 文件和 64 MiB/64 MiB+1 字节。
2. HTTP 边界：旧 9 MiB 以上、96 MiB 以内的合法请求可进入业务校验；超过 96 MiB 返回 413。
3. pending 重试：250 文件批次复用原 batchId/clientSequence 并推进 revision。
4. 超限回滚：1025 文件或超过 64 MiB 不写 batch、文件和 revision。
5. 响应链路：完整快照和单任务目录可超过旧 16 MiB 上限。
6. 真实 E2E：当前 `mdp-backend-service / dev` 从 revision 26 自动恢复并完成 135 任务初始同步。

## 9. 不做

- 不自动拆分一个任务目录为多个半任务批次。
- 不自动合并超大任务或删除证据文件。
- 不修改任务内容、任务历史或 Git。
- 不升级数据库 schema。
- 不为所有 API 统一放大请求体。
