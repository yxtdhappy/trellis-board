# 多团队认证、查询与设备授权分析

## 现有问题链

### Session

- `server/team/auth.js` 的 `createSession()` 使用 `firstActiveTeamForUser()` 自动写入活动团队。
- `readSession()` 根据 `active_team_id` 返回单个 `activeTeamId`、`teamRole` 和 `team`。
- `resolveActiveTeam()` 在团队成员变化后会自动替换为另一个团队，仍然维持单团队身份模型。

### 项目与任务

- `server/team/permissions.js` 的 `findProjectAccess()` 要求项目团队等于 `actor.activeTeamId`。
- `listAuthorizedProjects()` 按活动团队过滤项目。
- `server/team/projects.js` 的 `listReadable()` 在非系统管理员且无活动团队时返回空集合。
- `server/team/task-index.js` 的 ETag、查询缓存键和游标绑定包含 `actor.activeTeamId`。

### 保存视图与 WIP

- `server/team/board.js` 的 `teamScope()` 直接返回 `actor.activeTeamId || ""`。
- `execution-store.listSavedViews/createSavedView/updateSavedView/deleteSavedView` 接受团队 ID，但当前调用方只传活动团队。
- `user_board_state` 主键已经支持 `(user_id, team_id, key)`，其中 `team_id=''` 可表示全局作用域。
- `saved_view.team_id` 可为空，现有系统管理员全局视图已经使用 `null`。

### 设备与 Agent

- `agent_device` 没有团队字段。
- `agent_project_binding` 每个项目单独保存 `team_id`。
- `upsertHeartbeatBinding()` 已经通过 `projectId` 查找项目和 `team_member`，具备多团队绑定能力。
- `AgentRuntime` 已经按每个 approved binding 的 `teamId` 建立独立事件流。
- 真正阻塞多团队的是：
  - 桌面令牌签发时记录 `actor.activeTeamId`。
  - 配对码要求活动团队。
  - 管理台设备列表和撤销使用 `actor.activeTeamId`。

### 管理台

- `runtimeProject()` 使用单一 `actor.teamRole` 计算全部项目能力。
- `requireTeamAdmin()` 要求活动团队。
- `/api/admin/users`、`/api/admin/agents`、`/api/admin/audit` 使用活动团队确定范围。

## 可复用能力

- `team_member` 是团队成员关系事实源。
- `project_member` 继续表示项目级角色。
- `agent_project_binding.team_id` 已按项目团队隔离。
- Agent 多团队事件循环无需重构。
- 保存视图与 WIP 现有 schema 足以支持全局和团队作用域，无需数据库迁移。

## 已确认产品决策

- 默认任务看板聚合全部授权团队。
- 团队筛选只改变展示，不改变登录身份。
- 保存视图和 WIP 按团队独立；“全部团队”另有独立全局配置。
- 设备绑定用户与设备，项目绑定按项目团队授权。

## 主要修改面

- `server/team/auth.js`
- `server/team/teams.js`
- `server/team/permissions.js`
- `server/team/projects.js`
- `server/team/task-index.js`
- `server/team/board.js`
- `server/team/http.js`
- `server/team/agents.js`
- `server/team/desktop-auth.js`
- `server/execution-store.js`
- `web/src/hooks/useBoard.ts`
- `web/src/api/board.ts`
- `web/src/api/admin.ts`
- `web/src/features/admin/TeamSwitcher.tsx`
- `web/src/features/board/*`
- `web/src/lib/team-client.js`
- `tests/team-isolation.test.js`
- `tests/team-core.test.js`
- `tests/desktop-device-auth.test.js`
