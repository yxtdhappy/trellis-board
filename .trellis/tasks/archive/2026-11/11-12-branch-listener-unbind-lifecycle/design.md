# 分支监听状态与主动解绑生命周期设计

> 架构迁移说明：本设计初稿基于旧 Node sidecar；当前实施基线为 `main@87346c3`，
> 桌面 Agent 已迁移到 `apps/desktop/src-tauri/src/agent`。Node sidecar / CLI
> 描述只代表历史迁移来源，当前权威实现以 Rust Agent、Tauri 命令和 Web 五态 UI 为准。

## 1. 目标与不变量

本设计把“关联”和“正在监听”拆成两个独立事实：

- `binding.sync_status = approved` 表示客户端保留以后继续同步该 taskSpace 的资格。
- `binding.is_listening = 1` 且心跳未过期，表示该客户端当前真实检出并监听该分支。
- 客户端切换到其他 Git 分支只停止监听，不撤销 binding。
- 用户主动执行“不再同步此分支”才撤销当前 Agent 的 binding。
- 服务端是 binding 撤销、命令取消、cursor 清理和审计的最终提交方。
- 撤销 binding 不删除 taskSpace、任务、冲突、审计或 Git 分支。
- 所有客户端都主动解绑后，`approvedBindingCount = 0`，因此必然没有在线监听；此时显示“无客户端关联”，不是全局停用 taskSpace。

旧客户端没有监听上报能力时，服务端只能返回 `unknown_legacy`，不能把设备心跳当成监听。

## 2. 状态模型

| 条件 | `listenerState` | 展示 |
| --- | --- | --- |
| taskSpace 或项目已停用 | `disabled` | 中性“已停用” |
| `onlineListenerCount > 0` | `online` | 正常，显示“在线监听 N / 已关联 M” |
| 无 approved binding | `unassociated` | 红色“无客户端关联” |
| 有 approved binding，但没有任何 binding 上报过监听协议 | `unknown_legacy` | 黄色“旧客户端，监听状态未知” |
| 有 approved binding，至少一个客户端上报过监听协议，但当前无在线监听 | `inactive` | 黄色“当前未激活，关联保留” |

派生状态使用以下优先级，避免同一分支同时落多个标签：

```text
disabled -> online -> unassociated -> unknown_legacy -> inactive
```

`inactive` 不是废弃结论。它只表示当前无人监听，可能只是所有客户端切到了其他分支、桌面客户端未运行或设备离线。

## 3. 数据库

### 3.1 Schema v11

`DATABASE_SCHEMA_VERSION` 升到 `11`，给 `sync_agent_binding` 增加：

| 字段 | 语义 |
| --- | --- |
| `is_listening INTEGER NOT NULL DEFAULT 0` | 最近一次监听报告中的激活状态 |
| `listener_reported_at TEXT` | 最近一次收到该 binding 所属 Agent 的监听协议心跳时间 |
| `last_listener_at TEXT` | 最后一次确认该 binding 正在监听的时间 |

增加索引：

```sql
CREATE INDEX IF NOT EXISTS sync_agent_binding_listener
  ON sync_agent_binding(task_space_id, sync_status, is_listening);
```

`is_listening` 只是最近报告值。在线计算还必须检查 `listener_reported_at` 和设备 `last_seen_at` 是否在统一超时阈值内，避免崩溃或断网后永久保持在线。

### 3.2 迁移

现有 `CREATE TABLE IF NOT EXISTS` 不会给旧表补列，因此 v11 必须显式迁移：

1. 在事务前用现有 `VACUUM INTO` 机制备份 v10 数据库。
2. 在 `BEGIN IMMEDIATE` 中通过 `PRAGMA table_info(sync_agent_binding)` 判断列是否存在，再执行 `ALTER TABLE ... ADD COLUMN`。
3. 新库直接包含三列；v6-v10 旧库保留全部已有数据，被迁移的 binding 默认 `is_listening=0`，监听时间保持 `NULL`。
4. 迁移和索引创建幂等；重复启动、失败回滚和大于 v11 的数据库拒绝行为必须有测试。

回滚应用版本时必须恢复迁移前的 `board.sqlite.pre-v11.*` 备份，禁止让 v10 程序直接打开 v11 数据库。

## 4. Agent 心跳协议

### 4.1 协议字段

保持 `AGENT_PROTOCOL_VERSION = 3`，增加可选的监听子协议，避免把旧 Agent 整体判为不兼容：

```json
{
  "listenerReportVersion": 1,
  "listeningTaskSpaceIds": ["space-a", "space-b"]
}
```

语义：

- 有 `listenerReportVersion=1` 时，`listeningTaskSpaceIds` 是该 Agent 当前监听集合的完整权威快照；空数组表示当前没有任何监听。
- 字段缺失时按旧客户端处理，不修改任何 binding 的监听状态。
- 新 Agent 遇到旧服务端时，未知字段被忽略，既有同步和命令链路不受影响；但项目栏无法得到精确监听汇总，应显示“服务端需升级”。

### 4.2 客户端计算真实监听集合

当前单 binding 快速路径不会重新检查真实 Git 分支，必须修正：

- 每次心跳前重新读取配置，并排除 `detachPending=true`、非 approved、已撤销或分支不匹配的 binding。
- 对同一 `localRepoKey` 的多个 binding 仍按现有规则选择唯一真实分支；同时在多个 worktree 中绑定不同仓库路径时，各自独立监听。
- 只有通过真实 `HEAD` 分支校验的 binding 才进入 Rust `TaskSync` 和心跳集合。
- 选中集合变化时才重建 watcher；仅分支名重新校验通过且集合未变时，不反复 pull 或重建 watcher。
- 服务端心跳返回空 binding 列表或全部 binding 被撤销时，也要更新本地实时监听为空，不能被现有“空响应提前返回”逻辑跳过。

`heartbeat_payload()` 在调用前统一刷新监听集合，确保发送的是当前真实状态。

### 4.3 服务端更新规则

`heartbeat()` 在设备级心跳之外执行同一事务内的监听状态更新：

1. 校验 `listenerReportVersion` 只能为 `1`，`listeningTaskSpaceIds` 是去重后的安全 ID 数组，最多 64 个。
2. 有监听子协议时，对该 Agent 的全部 approved binding 写入 `listener_reported_at = heartbeatAt`。
3. `listeningTaskSpaceIds` 内的 binding 写入 `is_listening=1`，同时更新 `last_listener_at=heartbeatAt`。
4. 不在集合内的 binding 写入 `is_listening=0`，不覆盖 `last_listener_at`。
5. 传入未知或不属于当前 Agent approved binding 的 taskSpace ID 时拒绝整次监听报告，避免客户端状态与配置静默分叉。
6. 旧客户端不携带监听子协议时只更新设备心跳，不伪造监听时间。

撤销 binding、替换设备、替换同仓库分支和全局停用项目时，必须同时写入 `is_listening=0`；历史 `last_listener_at` 保留。

## 5. 在线判断与状态投影

统一在线条件为：

```text
binding.sync_status = approved
AND binding.is_listening = 1
AND binding.listener_reported_at >= staleCutoff
AND agent.last_seen_at >= staleCutoff
AND taskSpace.status = active
AND project.status = active
AND agent 是账号当前 active Agent
```

`onlineAgentForTaskSpace()`、项目 Agent 汇总、负责人候选的 `online` 字段和前端创建/改派门禁全部使用该语义。

`taskSpacePublic()` 增加：

```json
{
  "approvedBindingCount": 3,
  "onlineListenerCount": 1,
  "listenerReportedBindingCount": 3,
  "lastListenerAt": "2026-11-13T08:00:00.000Z",
  "listenerState": "online"
}
```

`approvedBindingCount` 只统计 approved，不把 pending/rejected/revoked 算作已关联。状态聚合在列表查询中批量完成，避免每个 taskSpace 单独查询。

### 监听详情

新增按需接口：

```text
GET /api/task-spaces/:taskSpaceId/listeners
```

只允许现有 taskSpace `canManage` 权限用户读取，返回：

```json
{
  "taskSpaceId": "space-a",
  "branchName": "feature/temp",
  "listenerState": "online",
  "approvedBindingCount": 3,
  "onlineListenerCount": 1,
  "lastListenerAt": "2026-11-13T08:00:00.000Z",
  "listeners": [
    {
      "bindingId": "binding-a",
      "userId": "user-a",
      "username": "dev-a",
      "displayName": "开发者 A",
      "deviceName": "DESKTOP-A",
      "bindingStatus": "approved",
      "online": true,
      "listenerReportedAt": "2026-11-13T08:00:00.000Z",
      "lastListenerAt": "2026-11-13T08:00:00.000Z",
      "boundAt": "2026-11-12T10:00:00.000Z"
    }
  ]
}
```

不返回 token、凭据、`localRepoKey` 或本地绝对路径。

## 6. 服务端主动解绑

新增 Agent 接口：

```text
POST /api/agent/task-spaces/:taskSpaceId/detach
```

请求：

```json
{ "localRepoKey": "<64 位 SHA-256>" }
```

服务端在 `BEGIN IMMEDIATE` 中：

1. 使用当前认证 Agent，不允许通过请求体指定其他 Agent。
2. 校验 taskSpace、项目访问和 `localRepoKey`。
3. 查找该 Agent 与 taskSpace 的唯一 binding。
4. binding 不存在或已 revoked 时返回幂等成功；不存在有效 binding 时不写重复审计。
5. binding 有效时改为 `revoked`，设置 `is_listening=0`，保留 `last_listener_at`。
6. 取消该 binding 的 `pending/delivered/running` 命令，错误文案固定为“客户端主动解除任务空间关联”。
7. 删除当前 Agent 对该 taskSpace 的服务端 cursor。
8. 仅真实状态发生变化时写 `task_space_binding_detached` 审计，记录原状态、branch、taskSpace 和发生时间。

返回：

```json
{
  "detached": true,
  "alreadyDetached": false,
  "taskSpaceId": "space-a",
  "bindingId": "binding-a"
}
```

不物理删除 binding 行。重复调用返回 `alreadyDetached=true`，不重复取消命令或写审计。

服务端没有“按分支批量硬删除 taskSpace”接口。所有客户端主动解绑后只改变聚合状态；项目或 taskSpace 全局停用仍由独立管理流程处理。

## 7. 客户端本地解绑生命周期

### 7.1 本地待确认状态

本地 binding 增加可选字段：

```json
{ "detachPending": true }
```

解绑流程：

1. 用户二次确认后，先原子写入 `detachPending=true`。
2. 运行时立即排除该 binding，停止 watcher、上传、补同步和任务命令领取。
3. 调用服务端 detach。
4. 成功或服务端明确返回无绑定后，删除本地 binding 和 `live-cursors.json` 中对应 taskSpace 状态。
5. 网络失败时保留 `detachPending`，项目栏显示“服务端解绑待确认”，下次心跳继续重试。
6. 非重试型权限/仓库不匹配错误保留本地待确认并显示具体原因，不能误报成功。

服务端失败期间，下一次新协议心跳不包含该 taskSpace，因此服务端会把它从在线监听集合移除，但 approved binding 仍保留，状态显示为 `inactive`。重试成功后才变成 `revoked`。

Rust Agent 的运行时和桌面快捷按钮必须调用同一个本地解绑函数，不能各自实现一套“只删本地配置”的逻辑。

### 7.2 桌面链路

新增 Tauri 命令：

```text
detach_local_association(task_space_id)
```

链路：

```text
ProjectRail 二次确认
  -> Tauri 校验 Board 调用方和 taskSpace ID
  -> Rust Agent mark_pending 并刷新运行时监听集合
  -> 本地标记 detachPending 并调用服务端
  -> watcher 立即按新配置停止该分支
  -> 返回 success/pending 状态
```

权限限制在现有 Board 本地关联 capability 中新增最小 allow 项，不能复用全局 shell 权限。

### 7.3 失败重试

桌面命令返回 `pending` 时显示“本地已停止同步，服务端解绑待确认”。
后台 Agent 运行时按心跳周期重试，成功后清理本地 binding 与 cursor。

## 8. 前端交互

### 项目栏

- 每个分支行同时展示服务端聚合状态和当前客户端本地关联状态，二者不能互相替代。
- 服务端 `online` 显示在线监听数与已关联数。
- 服务端 `inactive` 使用黄色“当前未激活，关联保留”。
- 服务端 `unassociated` 使用红色“无客户端关联”。
- `unknown_legacy` 显示黄色“旧客户端，监听状态未知”。
- `disabled` 使用中性状态，不再叠加“无客户端关联”告警。
- 当前客户端存在 approved 关联时显示“不再同步此分支”快捷按钮；`detachPending` 时按钮禁用并显示待确认。
- 二次确认必须说明 `只影响当前客户端，不删除服务端任务和其他客户端的关联`。

普通浏览器不显示本地解绑按钮，但仍可读取服务端监听聚合。监听详情入口仅对 `canManage` 用户显示。

### 创建与改派

- `CreateTaskDialog` 选中 taskSpace 后，`onlineListenerCount=0` 时禁用“创建并派发”，并显示“请先启动并绑定该分支的客户端”。
- `TaskDetailDialog` 对当前任务 taskSpace 使用同一判断，禁用改派提交并显示相同原因。
- `unknown_legacy` 同样禁用，提示升级客户端或服务端；不能为了兼容旧客户端放宽为在线。
- 服务端 `TaskCommandService` 在创建操作项前再次校验；零监听返回稳定错误 `TASK_SPACE_NO_ONLINE_LISTENER`，有监听但目标负责人离线继续返回 `AGENT_OFFLINE`。

### 三个客户端场景

- 三个客户端都监听：`onlineListenerCount=3`、`approvedBindingCount=3`。
- 一个切换分支：该客户端心跳集合移除 taskSpace，状态变成 `2/3`，binding 保留。
- 一个主动解绑：只有该 Agent 的 binding 变 revoked，状态变成 `2/2`。
- 全部切换分支：`0/3`，`inactive`，黄色“当前未激活”。
- 全部主动解绑：`0/0`，`unassociated`，红色“无客户端关联”。

## 9. 兼容、安全与失败处理

- 新服务端保持 Agent HTTP 协议 v3；缺少监听子协议按 `unknown_legacy` 处理。
- 新 Agent 对旧服务端继续使用原心跳和同步接口。
- 所有监听 ID、localRepoKey、taskSpace ID 在 HTTP 边界做格式、数量和归属校验。
- 监听详情不跨团队，不返回凭据、路径或可重放信息。
- 心跳状态更新、binding 撤销、命令取消、cursor 删除和审计必须在事务中完成。
- 服务端广播或轮询失败不影响已提交状态；前端下一次 `/api/team/status` 读取服务端事实。
- 不因 Git 分支删除、taskSpace 无人监听或短时网络中断自动撤销 binding。

## 10. 测试策略

- 数据库：新库 v11、v6-v10 升级、备份、字段默认值、重复启动、错误版本拒绝。
- 心跳：新客户端监听列表、空数组、重复 ID、越界 ID、旧客户端、超时、设备过期。
- 状态：三客户端在线/切换/解绑、全部 inactive、全部 unassociated、legacy、disabled 优先级。
- 解绑：权限、仓库不匹配、幂等、事务回滚、命令取消、cursor 删除、只写一次审计。
- Agent：真实分支刷新、单 binding 快路径、空 active 集合、detachPending 排除、失败重试、成功后 cursor 删除。
- 命令：零监听直接拒绝且不写 `sync_task_command`；目标负责人离线保留 `AGENT_OFFLINE`。
- 桌面：Tauri 参数校验、capability、Rust 解绑返回、失败后仍停止该分支、成功清理。
- Web：ProjectRail 四类状态、确认文案、待确认按钮、创建/改派禁用原因、监听详情权限。

## 11. 非目标

- 不实现项目或 taskSpace 全局“停用/重新启用”管理界面。
- 不因解绑删除任务、冲突、审计、Git 分支或本地任务目录。
- 不自动迁移任务到其他分支。
- 不把所有离线客户端视为主动解绑。
- 不新增多实例共享数据库或分布式心跳。
