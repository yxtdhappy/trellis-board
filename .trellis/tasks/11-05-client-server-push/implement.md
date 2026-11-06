# 客户端与服务端事件通道实施计划

## 顺序

1. **事件表**（`server/database.js`）
   - 保持 `DATABASE_SCHEMA_VERSION = 6`；在 `SCHEMA_V6_SQL` 增量添加 `agent_event`、去重索引、流查询索引、过期索引。
   - 校验：`node --test tests/database.test.js`；旧 v6 内存库/已有 v6 文件可补建新表。
2. **事件服务**（新增 `server/team/agent-events.js`）
   - `createAgentEventService({ db, logger, retentionMs, now })`：发布、扇出、去重、快照构建、256 KB 降级、保留窗口清理。
   - 目标解析：项目 `approved` 绑定；`task.assigned` 再加被指派人 + 项目 lead。
   - SSE 连接注册表、单 Agent 并发上限、心跳、慢消费者 drain、游标读写、`resync.required`、关闭流。
   - 命令事件扫描：`agent_command` pending → `command` 事件（dedupe `command:<id>:<attempts>`），发送前租约。
3. **Agent 服务改造**（`server/team/agents.js`）
   - 删除 `pollCommands`、等待器与 `MAX_WAIT_MS`；保留 `COMMAND_LEASE_MS`、`MAX_FAILURES`、`recoverExpiredLeases`。
   - 新增 `beginCommandDelivery`、`listPendingCommands`、`listEventTeams`；`setBindingStatus` / `revokeDevice` 触发事件服务。
   - 心跳绑定响应带 `teamId`；撤销设备发 `agent.revoked` 并关闭连接。
4. **任务事件发布**（`server/team/task-writes.js`、`server/team/task-index.js`）
   - `applyOperation` 在 Git push + 索引刷新成功后发布 `task.created` / `task.assigned` / `sync.required`，幂等键含 `executionTaskKey + taskVersion`。
   - `replaceProjectIndexInTransaction` 比较刷新前后索引：新任务 `task.created`、`taskVersion` 变化 `task.updated`、消失或归档 `task.cancelled`；提交后发布，发布失败不回滚索引/Git。
5. **HTTP 路由**（`server/team/http.js`）
   - `GET /api/agent/events`：Bearer 鉴权、team 解析/绑定校验、`Last-Event-ID`、SSE 头、建流。
   - `POST /api/agent/commands` → `410 AGENT_LONG_POLL_REMOVED`；`/commands/:id/result` 保持；`event-cursor` 保持。
   - `errors.js` 增加 `AGENT_LONG_POLL_REMOVED`；runtime 装配事件服务与关闭顺序。
6. **Agent 客户端**（`agent/api.js`、`agent/index.js`、`agent/config-store.js`、`agent/event-cache.js`）
   - `streamEvents()` 增量解析 SSE，处理 401/403/410/429；`_eventLoop` 按团队并行连接、退避 1s→30s、持久化游标。
   - 事件处理：任务快照落盘与版本幂等、`sync.required` 同步、`command` 走现有命令处理、`agent.revoked` 停止、`resync.required` 刷新。
7. **测试**
   - 新增 `tests/team-events.test.js`：SSE 鉴权、团队隔离、assigned 定向、去重、断线补发、游标过期、256 KB、慢消费者/连接上限、`agent.revoked`、优雅关闭、长轮询 410 + result 200。
   - 新增 `agent/test/events.test.js`：SSE 解析、断线重连带 `Last-Event-ID`、游标持久化、快照版本幂等。
   - 更新 `tests/team-core.test.js`、`tests/team-isolation.test.js`、`agent/test/api.test.js`、`agent/test/runtime-cli.test.js` 中断言长轮询的用例。
8. **检查与提交**
   - `python3 .trellis/scripts/task.py validate .trellis/tasks/11-05-client-server-push`
   - `node --test tests/team-events.test.js tests/team-core.test.js tests/team-isolation.test.js agent/test/*.test.js`
   - `npm test`、`npm run build`、`git diff --check`
   - 显式路径 `git add` 提交，消息 `feat(agent): stream team-scoped task events over SSE`；任务保持 `in_progress`。

## 验证命令

```bash
python3 .trellis/scripts/task.py validate .trellis/tasks/11-05-client-server-push
node --test tests/team-events.test.js tests/database.test.js
node --test tests/team-core.test.js tests/team-isolation.test.js
node --test agent/test/*.test.js
npm test
npm run build
git diff --check
```

## 评审门

- 事件只能在发布时按 `(team, project, target agent)` 扇出；SSE 查询必须同时带 `team_id` 与 `target_agent_id`。
- 游标只能按 `(agent_id, team_id)` 推进；禁止读取其他团队游标。
- 256 KB 超限必须改发 `task.snapshot_required`，payload 不含 PRD 正文。
- 长轮询入口不存在；`/result` 回执、租约、去重仍可用。
- 发布失败不得回滚已成功的 Git 操作或索引刷新。
- 不修改其他 11-05 任务 PRD/task.json；不提交 `web/node_modules`、`public/`、密钥。
