# 多团队任务看板技术设计

## 1. 目标与边界

目标是把“当前活动团队”从认证与授权模型中移除，改为每次请求依据 `team_member` 实时计算可用团队，并让用户默认看到全部授权团队的数据。

本次同时确定：

- 默认视图为“全部团队”聚合看板。
- 团队筛选只改变展示范围，不改变 Session 身份。
- 保存视图和 WIP 按团队独立；“全部团队”使用独立全局作用域。
- 设备凭证仍绑定“用户 + 设备”，项目绑定通过项目所属团队授权。

不做：

- 账号密码直连 sidecar。
- 删除管理员配对码兜底。
- 跨团队角色合并或自动提权。
- 数据库后端替换和多实例部署。

## 2. 当前事实

- `server/team/auth.js` 登录时自动写入第一个团队到 `user_session.active_team_id`。
- `server/team/permissions.js` 的项目授权和可读项目集合依赖 `actor.activeTeamId`。
- `server/team/task-index.js` 的 ETag、查询缓存键和游标绑定包含 `actor.activeTeamId`。
- `server/team/projects.js` 和 `server/team/agents.js` 在列表与设备操作中依赖单一活动团队。
- `saved_view.team_id` 已支持团队或空值；`user_board_state` 已支持团队 ID 或空字符串。
- `agent_device` 本身没有团队字段；`agent_project_binding.team_id` 已按项目所属团队保存。
- 当前 Agent 事件循环已经按绑定所属团队建立多个事件流，不需要重新设计为单设备单团队。

## 3. 目标认证模型

### 3.1 Session

Session 只保存用户会话，不再决定授权团队。

`readSession()` 每次请求返回：

```js
{
  sessionId,
  expiresAt,
  user,
  teams: [
    { id, name, slug, role, status }
  ]
}
```

约束：

- `teams` 只包含 `team.status = 'active'` 且存在 `team_member` 记录的关系。
- `activeTeamId`、`activeTeam`、`teamRole` 作为兼容字段保留时只能返回 `null`，不得参与授权。
- `createSession()` 继续写 `active_team_id = NULL`，不调用 `firstActiveTeamForUser()`。
- `POST /api/auth/team` 不再切换身份，返回 `410 ACTIVE_TEAM_REMOVED`。
- `user_session.active_team_id` 保留为废弃列，不删除，避免无必要的 schema 迁移。

### 3.2 Actor

HTTP 层把 Session 转换为 Actor：

```js
{
  userId,
  sessionId,
  systemAdmin,
  teams,
  user,
  expiresAt
}
```

新增统一的团队成员判断函数，例如：

```js
teamRole(actor, teamId)
assertTeamAccess(actor, teamId, role = null)
```

团队成员变更后，新请求读取新的 `team_member` 数据，因此权限立即生效。

## 4. 项目授权

### 4.1 单项目授权

`readProjectAccess()` 同时读取项目所属团队和当前用户在该团队的成员角色：

```text
team_project p
JOIN team t
LEFT JOIN team_member tm
  ON tm.team_id = p.team_id AND tm.user_id = actor.userId
```

规则：

- 非系统管理员必须存在有效团队成员关系。
- 团队管理员获得该团队所有项目的管理能力。
- 普通成员仍必须存在 `project_member` 记录才能访问项目。
- 访问已停用团队或已移除团队统一返回 404，避免泄露项目存在性。
- 系统管理员仍可访问全部有效团队。

### 4.2 可读项目集合

`listAuthorizedProjects(actor)` 返回所有团队成员关系覆盖的项目：

- 系统管理员：全部有效团队中的可见项目。
- 团队管理员：该用户担任管理员的团队的全部可见项目。
- 普通成员：该用户有 `project_member` 记录的团队项目。

每个项目返回：

```js
{
  id,
  teamId,
  teamName,
  role,
  syncStatus,
  ...
}
```

前端项目栏和项目选择器直接使用该集合，不再请求“当前团队项目”。

## 5. 任务查询与团队筛选

### 5.1 API

`GET /api/tasks/query` 新增可选 `teamId`：

```text
teamId 缺省或 all -> 全部授权团队
teamId 有效团队    -> 仅该团队
teamId 无权限      -> 403
```

处理顺序：

1. 从实时团队成员关系解析 `teamId`。
2. 计算本次可读项目集合。
3. 若同时提供 `projectIds`，必须全部属于可读集合和目标团队。
4. 使用最终 `projectIds` 查询 `team_task_index`。

### 5.2 团队标识

查询 SQL 同时读取：

```text
p.team_id
t.name AS team_name
```

列表任务新增：

```js
{
  teamId,
  teamName
}
```

任务卡片、注意力队列、团队视角表格都必须显示所属团队。详情接口继续以 `projectId` 推导团队，并校验成员角色。

### 5.3 ETag、缓存和游标

从 ETag、查询缓存键和游标绑定中移除 `actor.activeTeamId`，改为包含：

```js
{
  user,
  requestedTeamId,
  projectIdsHash,
  filters,
  queryRevision,
  queryDay
}
```

成员被移除后：

- 新请求的可读项目集合变化。
- 请求旧项目会被 403 拒绝。
- 请求“全部团队”会因项目集合哈希变化使旧游标返回 `CURSOR_INVALID`。
- ETag 变化，前端不会复用已移除团队的数据。

## 6. 保存视图与 WIP

### 6.1 作用域

前端 `filter.teamId`：

```text
all / 空 -> 全局作用域
team-id  -> 该团队作用域
```

服务端必须验证：

- `team-id` 是当前用户有效团队成员关系。
- `all` 只表示该用户可见的全部团队，不代表系统管理员权限。
- 系统管理员选择具体团队时也使用该团队的真实配置。

### 6.2 存储映射

- `saved_view.team_id = NULL`：全部团队全局视图。
- `saved_view.team_id = <teamId>`：团队视图。
- `user_board_state.team_id = ''`：全部团队全局 WIP。
- `user_board_state.team_id = <teamId>`：团队 WIP。

不修改数据库 schema。

### 6.3 API

```text
GET    /api/saved-views?teamId=<all|teamId>
POST   /api/saved-views { name, filter, teamId }
PUT    /api/saved-views { id, name, filter, teamId }
DELETE /api/saved-views { id, teamId }

GET /api/board/settings?teamId=<all|teamId>
PUT /api/board/settings { executionWipLimit, teamId }
```

保存视图的权限每次查询和执行时仍由任务查询接口按项目重新授权，保存视图本身不能扩大可见范围。

### 6.4 成员移除

- 移除团队成员时删除该团队作用域的保存视图和 WIP。
- 全局作用域数据保留。
- 已打开页面下一次查询不可再读取被移除团队的数据。

## 7. 前端数据流

`BoardFilters` 增加：

```ts
teamId: "all" | string
```

`useBoard`：

- 首次加载 runtime，取得全部团队及各团队角色。
- `teamId=all` 时不传团队过滤。
- 具体团队时向 `/api/tasks/query` 传 `teamId`。
- 团队变化时清空分页游标和 ETag。
- 团队变化时重新读取对应作用域的保存视图和 WIP。
- 团队模式不再依赖 `/api/board` 提供 `savedViews` 和 `settings`。

页面规则：

- 多团队用户默认 `teamId=all`。
- 单团队用户默认采用该团队的有效数据，但不必强制显示切换控件。
- 项目选择器只展示当前团队范围的项目。
- 任务行显示 `teamName · projectName`。
- “团队筛选”不调用旧 `/api/auth/team`，不刷新页面。

## 8. 管理台

团队管理员的管理能力按每个团队的 `team_member.role` 计算，不再使用单数 `actor.teamRole`。

- runtime 中的项目能力按项目所属团队计算。
- `manageProjects`、`manageAgents`、`viewSystemAudit` 表示“至少有一个可管理团队”。
- 团队管理员操作必须明确 `teamId`；多团队管理员在管理台选择管理范围。
- 系统管理员可查看全部团队，也可选择具体团队。
- 创建项目继续使用 `teamId` 指定目标团队。

## 9. 设备与 Agent

- 桌面设备令牌只绑定用户与设备，不记录活动团队。
- `enrollDesktop()` 返回兼容字段 `teamId: null`。
- Agent 顶层 `teamId` 保留为兼容字段，但不得控制项目绑定。
- `upsertHeartbeatBinding()` 继续以 `projectId` 查询项目所属团队并检查 `team_member`。
- 同一设备可以创建多个不同团队的 `agent_project_binding`。
- Agent 事件流继续按已批准绑定涉及的团队分别建立。
- 管理台设备列表和撤销操作必须显式限定 `teamId`，不得影响其他团队绑定。
- 配对码兜底可以保留其审计团队，但不得把设备或项目绑定限制在该团队。

## 10. 兼容与回滚

- 不提升数据库 schema 版本。
- `user_session.active_team_id` 和 Agent 配置顶层 `teamId` 保留为废弃兼容字段。
- 现有团队作用域保存视图和 WIP 不需要迁移。
- 回滚代码后，旧 Session 和旧数据仍可读取。
- 前后端必须同版本发布；旧前端调用 `/api/auth/team` 会收到 410。

## 11. 风险

- 权限查询容易遗漏 `team_member` 与 `project_member` 的双重校验。
- 团队筛选切换如果未清空游标，可能把不同作用域的数据拼在同一页。
- 多团队设备撤销如果沿用活动团队逻辑，可能错误撤销其他团队绑定。
- 团队模式下保存视图与 WIP 当前前端加载链不完整，需要补充独立读取接口。
- 管理台由单团队管理切换到多团队管理时，所有“当前团队”隐式语义都要改成显式 `teamId`。
