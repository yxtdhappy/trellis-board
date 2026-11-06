# 客户端与服务端事件通道技术设计

## 1. 边界与目标

- 服务端 → Agent/桌面客户端建立 **SSE** 单向通道：`GET /api/agent/events`。客户端 → 服务端仍用现有 HTTP POST（心跳、命令结果、任务读取）。
- 事件在服务端先落库（`agent_event`），再推送给在线连接；连接断开后按 `(agent, team)` 游标补发。
- 事件必须带团队作用域；一个 Agent 在一个团队内一条连接，多团队时客户端按团队各建一条连接，游标互不影响。
- 任务事件携带**完整任务快照**（`task.json` + PRD 正文等），超过 256 KB 时改发 `task.snapshot_required`，不截断后冒充完整。
- `POST /api/agent/commands` 长轮询删除并返回 `410 AGENT_LONG_POLL_REMOVED`；命令改由 SSE `command` 事件承载；`POST /api/agent/commands/:id/result` 保留。

## 2. Schema

保持 `DATABASE_SCHEMA_VERSION = 6`，在 `SCHEMA_V6_SQL` 中**增量**新增事件表（`CREATE TABLE IF NOT EXISTS`）。已合并的 v6 库打开时会由 `ensureV6Schema()` 补建新表，无需重建库，也不需要 v7。

```sql
CREATE TABLE IF NOT EXISTS agent_event (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id TEXT NOT NULL REFERENCES team(id) ON DELETE CASCADE,
  project_id TEXT,
  type TEXT NOT NULL,
  target_agent_id TEXT REFERENCES agent_device(id) ON DELETE CASCADE,
  target_user_id TEXT REFERENCES user_account(id) ON DELETE CASCADE,
  task_id TEXT,
  task_version TEXT,
  dedupe_key TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE UNIQUE INDEX agent_event_dedupe ON agent_event(team_id, dedupe_key);
CREATE INDEX agent_event_stream ON agent_event(team_id, target_agent_id, id);
CREATE INDEX agent_event_expiry ON agent_event(expires_at);
```

- `id` 全局单调（`AUTOINCREMENT`），团队内顺序由 `id` 保证；每 `(agent, team)` 游标记录该 Agent 在该团队已消费到的全局 id，禁止用单游标跨团队推进。
- **扇出写入**：每条逻辑事件在发布时按目标 Agent 各写一行，`target_agent_id` 精确指向接收设备，`target_user_id` 保留审计语义。这样 replay 查询只按 `target_agent_id + team_id + id` 过滤，不存在跨团队/跨项目泄漏路径。
- `dedupe_key` 由调用方提供稳定键（如 `task.created:<executionTaskKey>:<taskVersion>`），写入时追加 `:agent:<agentId>`；`INSERT OR IGNORE` 保证同一逻辑事件对同一 Agent 只落一次。
- 保留窗口 `EVENT_RETENTION_MS = 7 天`；发布/建流时清理过期行。

## 3. 事件类型与目标

| type | 目标 | 说明 |
| --- | --- | --- |
| `task.created` | 项目内 `approved` 绑定的 Agent | 服务端 Git 写入成功后 |
| `task.assigned` | 被指派人 + 项目 `lead` 对应的 Agent | 只定向，不广播 |
| `task.updated` | 项目内 `approved` 绑定的 Agent | 索引刷新检测到 `taskVersion` 变化 |
| `task.cancelled` | 项目内 `approved` 绑定的 Agent | 索引刷新检测到任务被删除或归档 |
| `task.snapshot_required` | 与原任务事件相同的目标 | 快照超限降级 |
| `sync.required` | 项目内 `approved` 绑定的 Agent | 要求 `fetch` + `ff-only` |
| `command` | 单个 Agent | 现有 `sync_branch` / `refresh_status` |
| `agent.revoked` | 单个 Agent | 发送后服务端主动关闭该设备所有流 |
| `resync.required` | 单个 Agent | 游标超出保留窗口或请求的 id 不在服务端日志内 |
| `server.shutdown` | 所有在线连接 | 优雅关闭 |

任务事件目标是项目内绑定且 `agent_device.status='active'`、`agent_project_binding.sync_status='approved'` 的设备；`task.assigned` 再按 `assigned_user_id` 和 `project_member.role='lead'` 过滤。没有任何目标时事件只落库，不推送。

## 4. 任务快照

`buildTaskSnapshot()` 从权威工作副本读取，不拼接前端数据：

```js
{
  teamId, projectId, projectName,
  taskKey, executionTaskKey, relativeDir,
  taskVersion, changedAt,
  title, description, status, priority,
  assigneeDevId, assigneeUserId,
  tags: [], blockedBy: [], blocks: [],
  parentTaskKey, childTaskKeys, archived,
  artifacts: { prd, design, implement } // 原始 Markdown 字符串，不含绝对路径
}
```

- 上限 `MAX_EVENT_PAYLOAD_BYTES = 256 * 1024`，按 `JSON.stringify(payload)` 的 UTF-8 字节数计算。
- 超限时把事件 `type` 改为 `task.snapshot_required`，payload 只保留 `{ teamId, projectId, taskKey, executionTaskKey, taskVersion, originalType }`；不截断 `artifacts`。
- 事件数据不包含凭据、token、绝对路径；日志只记录事件 id/type/team/project，不记录正文。

## 5. SSE 协议

请求：

```
GET /api/agent/events?teamId=<team>
Authorization: Bearer <agent credential>
Last-Event-ID: <last consumed event id>   (可选)
```

- `teamId` 省略时按 `eventCursorTeam()` 解析第一个可用团队（兼容现有 `event-cursor` 接口）。显式 `teamId` 必须是 Agent 用户所属、且该 Agent 在该团队至少有一条未撤销绑定的启用团队。
- 响应头：`content-type: text/event-stream; charset=utf-8`、`cache-control: no-store`、`connection: keep-alive`、`x-accel-buffering: no`；先写 `retry: 3000`。
- 帧格式：`id: <event id>`、`event: <type>`、`data: <JSON>`，空行分隔；`data` 为 `{ id, teamId, type, projectId, taskId, taskVersion, createdAt, payload }`。
- 心跳：每 15 秒发送注释帧 `: heartbeat`。连接期间不发送 `Content-Length`，不启用 gzip。
- 单 Agent 最多 4 条并发流；超出返回 `429 RATE_LIMITED`（`details.retryAfterMs = 5000`）。
- 慢消费者：单流一次最多从数据库取 50 条，`response.write()` 返回 `false` 时停止并等待 `drain`；超过 20 秒仍不 drain 则结束该连接。事件仍在数据库保留，客户端按 `Last-Event-ID` 重连补发；服务端不为慢连接堆积内存。不同 Agent/团队连接互不阻塞。
- `agent.revoked` / `server.shutdown` 帧发送后结束连接。

## 6. 游标与补发

- 建流起点：`Last-Event-ID` 优先；缺失时读 `agent_event_cursor(agent_id, team_id)`；都没有从 0 开始。
- 过期判定：该团队保留窗口内 `MIN(id)` 为 `minId`、`MAX(id)` 为 `maxId`。`requested > maxId` 或 `requested + 1 < minId` 视为游标过期/未知，先插入一条定向 `resync.required` 事件（payload 带 `requestedLastEventId`、`reason`），从该事件开始推送；不重放已清理事件。
- 正常补发：`SELECT * FROM agent_event WHERE team_id=? AND target_agent_id=? AND id > ? AND expires_at > ? ORDER BY id LIMIT 50`。
- 每批发送后 upsert `agent_event_cursor`；重复事件由客户端按 id 去重，服务端按 `dedupe_key` 去重。

## 7. 命令通道迁移

- `agent_command` 表、租约（5 分钟）、`MAX_FAILURES=3`、结果回执全部保留。
- 事件服务每 5 秒（仅对在线 Agent/团队）扫描 `pending` 且绑定/项目可用的命令，插入 `command` 事件（dedupe `command:<id>:<attempts>`），再推流。绑定批准时立即触发一次。
- 流发送 `command` 事件前调用 `beginCommandDelivery(agentId, commandId)`：恢复过期租约、校验仍是 `pending`、写 `delivered/attempts/lease_expires_at`；命令已不在 `pending` 则跳过该帧但推进游标。
- 租约过期后 `recoverExpiredLeases()` 把命令退回 `pending` 或标 `failed`；退回时 `attempts` 增加，下一次扫描用新的 dedupe key 重新发事件。
- Agent 收到 `command` 后仍走现有 `_runCommand` 与 `submitCommandResult`；`sync_branch` 成功会更新绑定状态。

## 8. Agent 消费

- 心跳响应绑定项新增 `teamId`；Agent 以绑定中的团队集合为每个团队维护一条 SSE 连接。
- `agent/api.js` 新增 `streamEvents()`：原生 `http/https` 增量解析 SSE，支持 `signal`、60 秒无数据超时、401/403 → `AUTH_REVOKED`、410 → `AGENT_OUTDATED`、429 尊重 `Retry-After`。
- `agent/index.js` 用 `_eventLoop()` / `_teamEventLoop(teamId)` 替换 `_commandLoop`；断线重连指数退避 1s → 30s（±20% 抖动），401/403 停止，不做忙等。
- 游标持久化到 `%LOCALAPPDATA%\TrellisBoardAgent\event-cursors.json`（`ConfigStore.readEventCursors/writeEventCursors`），进程重启后继续使用。
- 任务事件落盘到 Agent 根目录 `events/<teamId>/<projectId>/<sha256(executionTaskKey)>.json`，限制在 Agent 数据根内；按 `taskVersion` 幂等：同版本忽略、低版本丢弃、高版本覆盖。不写 workspace，不操作 Git 索引。
- `sync.required` 触发对应绑定 `syncRepository`；`resync.required` 把该团队缓存标为 stale 并对绑定执行 `inspectRepository`；`agent.revoked` 停止进程；`server.shutdown` 让连接自然结束并按退避重连。

## 9. 兼容与关闭

- 旧 Agent 请求 `/api/agent/commands` 得到 `410` + `AGENT_LONG_POLL_REMOVED`；`/result` 不受影响。
- `stop()` 顺序：`agentEvents.close()`（发 `server.shutdown` 并结束流）→ `agentService.close()` → 关 HTTP server。
- standalone 模式不创建事件服务，行为不变。
