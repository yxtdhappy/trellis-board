# 团队隔离技术设计

## 1. 边界与目标

- 一个 Board 部署内存在多个 `team`；`team` 是租户边界，所有业务数据（项目、任务索引、委派、审计、Agent 绑定）最终都能追溯到唯一 `team_id`。
- 一个账号可属于多个团队（`team_member` 多对多）；`user_session.active_team_id` 是会话级活动团队指针。切换活动团队只更新会话，不重新登录。
- 系统管理员可跨团队读取；跨团队写操作必须由目标对象（项目/团队）确定团队并写团队审计。团队管理员只管理本团队项目；团队普通成员只看活动团队内已加入项目。
- 不做 v5 → v6 数据迁移。`DATABASE_SCHEMA_VERSION = 6`；发现已存在的非 v6 库直接拒绝启动并提示删除 `data/board.sqlite` 重建。

## 2. 数据模型（v6）

新增/修改（全部在 `server/database.js` 的新库 DDL 中）：

| 表 | 变化 |
| --- | --- |
| `team` | 新增：`id`、`name`、`slug UNIQUE`、`status(active/disabled)`、时间戳 |
| `team_member` | 新增：`(team_id, user_id)` 主键、`role(admin/member)`、时间戳；`user_id` 索引 |
| `user_session` | 新增 `active_team_id REFERENCES team(id)` |
| `team_project` | 新增 `team_id NOT NULL`；`workspace_key` 改为 `UNIQUE(team_id, workspace_key)`；团队索引 |
| `saved_view` | 已有 `owner_user_id`；新增 `team_id`；查询按 `(owner_user_id, team_id)` |
| `user_board_state` | 主键改为 `(user_id, team_id, key)`；`team_id NOT NULL DEFAULT ''`（系统管理员“全部团队”上下文用空串） |
| `audit_event` | 新增 `team_id`；`(team_id, occurred_at, id)` 索引 |
| `agent_pairing_code` | 新增 `team_id NOT NULL`：配对码在创建时绑定团队 |
| `agent_project_binding` | 新增 `team_id NOT NULL`；绑定随项目团队；`(team_id, sync_status)` 索引 |
| `agent_event_cursor` | 新增：`(agent_id, team_id)` 主键、`last_event_id`、`updated_at`，禁止单游标跨团队 |

`task_assignment`、`project_scan_cache`、`team_task_index`、`task_*` 仍以 `project_id`/`execution_task_key` 为键；项目归属唯一团队，因此不需要重复列 `team_id`，但所有读取必须先通过团队过滤后的项目 ID 集合。

## 3. 查询层隔离

核心原则：**先算可见项目集合，再查项目派生数据**。新增 `server/team/teams.js` 作为团队实体/成员/活动团队的唯一所有者；`permissions.js` 统一注入团队边界，HTTP 处理器不做零散判断。

- `readActor()` 返回 `activeTeamId`、`teamRole`（活动团队成员角色）。
- `listAuthorizedProjects(actor)`：
  - 系统管理员：有活动团队时只列该团队，否则列全部启用团队的项目；
  - 活动团队成员：`project.team_id = activeTeamId`，团队管理员看全团队项目，普通成员只看 `project_member` 项目；
  - 无活动团队/非成员：空集。
- `authorizeProject()`：项目不存在、团队不匹配、非团队成员、团队停用一律对非系统管理员返回 404（不泄露存在性）；系统管理员跨团队可读，写操作仍校验项目可写状态。
- `readableProjectIds()` 的结果直接驱动 `/api/tasks/query`、看板、委派、缓存；`task-index` 的 ETag/游标/查询缓存绑定 `activeTeamId`（系统管理员无活动团队时为 `null`），复用其他团队游标返回 `CURSOR_INVALID`。
- 保存视图/WIP：`execution-store` 的 saved view 查询与 `user_board_state` 都带 `(userId, teamId)`；系统管理员无活动团队时，saved view 用 `NULL`（列可空），WIP 用空串（列 NOT NULL）。
- 审计：`appendAuditEvent()` 若未显式给 `teamId` 则从 `projectId` 推导；`listAuditEvents()` 支持 `teamId` 过滤。无项目全局事件允许 `team_id = NULL`。
- Agent：设备保持用户级；配对码、绑定带团队。心跳绑定校验用户仍是项目团队成员且团队启用；移除团队成员时清理团队项目绑定、项目成员、保存视图、看板状态与事件游标。事件游标按 `(agent_id, team_id)` 存储。团队管理员撤销设备时只撤销本团队绑定。

## 4. API

| 方法与路径 | 权限 | 说明 |
| --- | --- | --- |
| `GET /api/teams` | 登录用户 | 系统管理员返回全部团队；其他返回已分配团队；含 `activeTeamId`、角色、成员/项目数 |
| `POST /api/auth/team` | 登录用户 | `{ teamId }` 切换活动团队；非成员 403；系统管理员可切到任意启用团队 |
| `POST /api/admin/teams` | 系统管理员 | 创建团队 |
| `PATCH /api/admin/teams/:id` | 系统管理员 | 改名/改 slug/停用；停用时清理会话活动团队 |
| `GET /api/admin/teams/:id` | 系统管理员 | 团队详情 + 成员列表 |
| `PUT /api/admin/users/:id/teams` | 系统管理员 | 整体替换用户团队与团队角色；移除时清理项目成员与 Agent 绑定 |
| `GET /api/admin/users` | 系统管理员 | 返回用户及其团队归属 |
| `POST /api/admin/users` | 系统管理员 | 支持 `teams: [{teamId, role}]` 一次性分配 |
| `GET /api/admin/projects` | 系统管理员/团队管理员 | 系统管理员全部；团队管理员仅本团队 |
| `POST /api/admin/projects` | 系统管理员/目标团队管理员 | 系统管理员必须带 `teamId`；团队管理员默认活动团队，伪造其他团队 403 |
| `POST /api/admin/projects/:id/(approve\|repair\|disable)` | 系统管理员/项目团队管理员 | 服务层校验目标团队 |
| `GET /api/admin/agents` | 系统管理员/团队管理员 | 团队管理员只看到绑定到本团队项目的设备 |
| `GET /api/admin/audit?teamId=` | 系统管理员/团队管理员 | 团队管理员强制活动团队；系统管理员可按 teamId 过滤 |
| `POST /api/team/pairing-codes` | 活动团队成员 | 配对码绑定活动团队 |
| `GET/PUT /api/agent/event-cursor` | Agent 凭证 | 按 `(agent, team)` 读写游标；校验设备用户属于该团队 |

错误语义：跨团队访问统一 404；伪造活动团队 403；目标成员不属于团队 400；批量接口包含越权项目 ID 整体 403；游标失效 409 + `recoverable`。

## 5. 管理员 UI

- `AdminPage` 新增“团队”页签（仅系统管理员）：团队列表、创建、启用/停用、成员分配。
- 管理页头部和看板 `TopBar` 增加团队切换器；切换后重新拉取 runtime 与看板。
- 现有用户/项目/Agent/审计页签继续调用原接口，服务端按活动团队过滤，不在前端做安全判断。

## 6. 兼容与回滚

- standalone 仍用同一个 `database.js`，新库自动是 v6；现有业务表不变，插件表不变，team 模式仍禁用插件。
- 旧开发库不迁移：打开非 v6 库抛错，提示删除 `data/board.sqlite`。README/任务说明必须写明“重建库”。
- 回滚：删除本次分支代码 + 删除 `data/board.sqlite` 重建；没有需要回退的数据迁移。
