# 服务端团队隔离

## Goal

在现有 team 模式上引入“团队（team / tenant）”边界：同一 Board 部署内可以服务多个互不可见的团队，一个用户可以加入多个团队并在会话内切换活动团队；账号、项目、任务、看板、保存视图、Agent、审计与运行状态都按活动团队隔离。

## Dependencies

- 无前置子任务；本任务是 `11-05-user-registration`、`11-05-client-server-push` 的前置。
- 现有 `11-03-team-core-service` 仍是 `in_progress`，修改 `server/team/*` 与 `server/database.js` 前需确认其工作区状态，避免覆盖。

## Current State（仓库事实）

- 数据库当前是 schema v5（`server/database.js:15`）；`team_project`（`server/database.js:195`）只有 `repository_id`、全局唯一的 `workspace_key` 和 Git 同步字段，没有 `team_id`。
- `project_member`（`server/database.js:214`）是“项目 + 用户 + 角色”；权限判断 `server/team/permissions.js` 的 `authorizeProject()`、`listAuthorizedProjects()`、`readableProjectIds()` 都只查项目成员，没有团队维度。
- `user_account`（`server/database.js:160`）只有全局 `system_admin`，没有团队归属；`user_session` 也没有 `active_team_id`。
- `audit_event`（`server/database.js:269`）只有 `project_id`，没有 `team_id`；`agent_device`（`server/database.js:321`）只关联 `user_id`；`agent_pairing_code` 同样没有团队字段。当前设备是用户级资源，不是团队级资源。
- 看板、跨项目查询、保存视图、WIP、事件和任务索引都按“当前用户可见项目”过滤（`server/team/board.js:293`、`server/team/task-index.js:528`），但没有团队过滤层；`team_task_index`、`team_task_index_tag`、`user_board_state`、`task_assignment` 都以项目/用户为键，没有 team 维度。
- 插件机制已存在（DB v5 的 `plugin_state`、`plugin_run`、`plugin_audit`），但 team 模式明确不加载插件：`server/team/http.js:1028` 对插件端点返回空列表或 404；本任务不涉及插件数据隔离，standalone 插件行为不受影响。
- 当前前端已有管理页（`web/src/pages/admin/AdminPage.tsx:14` 的页签：项目协作、用户账号、项目接入、Agent 设备、系统审计），但没有团队页签、团队切换器；用户页创建账号时也不支持团队分配。
- 当前只有单部署单团队语义：一个用户能看到自己加入的所有项目，项目之间没有团队分组。
- 现有测试集中在 `tests/team-core.test.js`、`tests/team-web.test.js`、`tests/team-release.test.js`，没有团队隔离相关测试。

## In Scope

- 新增 `team` 实体（id、名称、slug、状态、创建时间）与 `team_member`（团队 + 用户 + 团队角色）；目标 schema 升到 v6，当前 v5 的插件表保持独立。
- **团队只能由管理员创建和配置**：只有系统管理员可以创建、重命名、停用团队，以及分配/移除团队的项目和成员；普通用户和团队普通成员不能创建团队、不能自助加入/退出团队。
- 用户与团队是多对多关系：一个用户可以加入多个团队；首版在 `user_session` 上增加 `active_team_id`，或使用等价的会话级活动团队指针。切换团队不重新登录，只切换活动团队并刷新缓存。
- 提供团队 API：`GET /api/teams`（只读；普通用户返回管理员已分配的团队，系统管理员返回全部团队）、`POST /api/auth/team`（在可访问团队之间切换活动团队）；团队创建/配置/成员分配接口全部在系统管理员权限下，例如 `POST /api/admin/teams`、`PATCH /api/admin/teams/:id`、`PUT /api/admin/users/:id/teams`。前端提供团队切换器和管理员团队管理页。
- `team_project` 增加 `team_id`；`workspace_key` 唯一约束从全局唯一改为“团队内唯一”，不同团队可以使用相同目录名。
- 所有读写入口增加团队作用域，并以会话的活动团队为默认过滤条件：
  - `/api/board`、`/api/tasks/query`、`/api/task`、`/api/assignments`、`/api/team/*`
  - 保存视图、WIP、阶段/计划/标签/依赖/事件等 `user_board_state` 与 `task_*` 查询
  - Agent 配对、设备列表、命令、项目绑定、事件游标（设备仍属于用户；配对、绑定、命令与事件按团队作用域校验）
  - 审计列表与导出
- 设备模型：`agent_device` 保持用户级，不强行改成团队级；同一用户的设备可以绑定其已加入团队的项目。绑定记录或绑定校验必须带 `team_id`（或通过 `team_project.team_id` 强制校验），用户被移出团队后该团队的项目绑定失效；事件游标仍按 `(agent, team)` 分团队维护。
- 权限模型：
  - 系统管理员：创建/配置/停用团队，分配每个用户的团队与团队角色；**可直接读取所有团队的业务数据**（看板、项目、任务、审计、Agent），无需先切换活动团队；跨团队写操作必须以目标团队为上下文并留审计。
  - 团队管理员：只管理本团队的项目——项目设置、项目角色、项目审计；不能创建/重命名/停用团队，不能创建账号，不能修改团队成员分配（这些仅系统管理员可做）。
  - 团队普通成员：只能在管理员已分配的团队之间切换活动团队，只能看到当前团队和已加入项目。
  - 项目角色 `lead/member/read_only` 保持不变，但必须先通过团队边界。
- 管理员配置每个用户的团队：创建用户时可一次分配多个团队，之后可在用户详情中增加/移除团队；用户自己不能修改团队归属，只能在已分配团队之间切换。
- 项目成员必须来自该项目的团队成员：新增/修改 `project_member` 前校验 `team_member`；不能把非本团队用户加入项目。移除用户团队时，必须同时拒绝或清理其在团队项目中的成员关系，避免遗留跨团队访问。
- 跨团队访问一律按“不存在”处理（404）或 403，不泄露团队/项目是否存在；批量接口中显式越权 ID 整体拒绝；切换活动团队时必须校验当前用户确实是目标团队成员。
- 团队级缓存与索引：`project_scan_cache`、`team_task_index` 查询必须带团队过滤；跨团队任务不得出现在分页、`ETag` 或游标中；事件游标按 `(agent, team)` 分团队维护。
- 团队审计：`audit_event` 增加 `team_id`，所有审计写入必须带目标团队；无项目的全局事件允许 `team_id` 为空，但必须可追溯到操作者与目标。
- 全新库设计（不做旧数据迁移）：
  - 当前 `DATABASE_SCHEMA_VERSION = 5`；本任务把目标 schema 升到 v6，新增 `team`、`team_member` 及 `team_project.team_id`、`audit_event.team_id` 等字段。
  - 系统尚未上线，不实现 v5 → v6 数据迁移、默认团队回填或旧库兼容层。
  - 开发/测试环境的旧 `data/board.sqlite` 可直接删除重建；升级说明必须写明“重建库”，避免误以为存在迁移脚本。
  - 现有 v5 插件表与 standalone 模式保持不变；team 模式仍按 `server/team/http.js:1028` 禁用插件。
  - `schema_version` 只用于新建库的版本标记与后续演进，不承担本次旧库升级。
- 管理界面：在 `web/src/pages/admin/AdminPage.tsx` 现有页签中新增“团队”页签，提供团队列表、创建团队、团队详情、成员分配入口，全部仅系统管理员可见/可用；现有项目/用户/Agent/审计页签在团队模式下按活动团队过滤。

## Out of Scope

- 跨团队共享项目、项目迁移/转让、跨团队任务依赖。
- 旧数据库迁移与兼容（v5 及更早）；系统未上线，首版只支持全新初始化。
- 每个团队独立数据库或独立进程。
- 团队级配额、计费、资源限额。
- 细粒度自定义角色（只保留系统管理员/团队管理员/项目三角色）。
- 邮箱域名自动加入团队。

## 已确认决策（2026-11-05）

1. **隔离模型**：新增 `team` + `team_member`，一人多团队 + 会话内切换活动团队。
2. **旧数据迁移**：**不做迁移**。系统尚未启用，首版按最新 team 模型全新设计 schema，旧开发库直接删除重建。
3. **系统管理员跨团队可见范围**：**可直接读取所有团队数据**，无需显式切换；跨团队写操作需指定目标团队并留审计。
4. **团队创建与成员分配权限**：只有系统管理员可以创建、配置和停用团队，并分配每个用户的团队；普通用户和团队管理员都没有自助创建/加入/退出或修改成员归属的入口。

## Acceptance Criteria

- [ ] 全新数据库初始化后 `schema_version = 6`，并具备 `team`、`team_member`、`team_project.team_id`、`audit_event.team_id`；不存在旧库迁移代码、默认团队回填或 v5 兼容分支。
- [ ] 只有系统管理员可以创建/配置/停用团队和分配用户团队；普通用户调用这些接口返回 403，且前端不显示入口。
- [ ] 系统管理员可直接读取所有团队的项目、任务、审计与 Agent 列表；跨团队写操作必须指定目标团队并产生审计记录。
- [ ] 用户只能在管理员已分配的团队之间切换；不能自助加入、退出或创建团队，伪造团队 ID 返回 403。
- [ ] 一个用户加入团队 A 和团队 B 后，可在不重新登录的情况下切换活动团队；切换后看板、任务查询、保存视图、WIP、Agent 列表和审计只显示当前团队数据。
- [ ] 用户不能把活动团队切换到自己未加入的团队；伪造 `teamId`/请求头切换返回 403，且不泄露目标团队信息。
- [ ] 团队 A 的活动会话访问团队 B 的 `projectId`、`taskKey`、`savedViewId`、`agentId`、`userId` 全部失败，响应不包含 B 的名称、路径、统计或存在性信息。
- [ ] `/api/tasks/query` 的游标、`ETag`、分页总数只基于当前活动团队可见索引；伪造或复用其他团队游标返回可恢复错误。
- [ ] 同一 `workspace_key` 可存在于两个团队；同团队内重复仍被拒绝。
- [ ] 团队管理员不能看到其他团队的用户、项目、Agent、审计；系统管理员跨团队操作产生审计事件。
- [ ] Agent 项目绑定按团队校验：设备仍属于用户，同一设备可绑定该用户已加入团队的项目；用户未加入的团队项目绑定失败；用户被移出团队后对应项目绑定失效；事件游标不跨团队复用。
- [ ] 项目成员只能来自同团队成员；跨团队用户不能被加入项目；移除用户团队后，其在团队项目中的访问立即失效。
- [ ] 保存视图、WIP、个人看板状态按 `(team, user)` 隔离，两个团队的同名用户互不覆盖。
- [ ] 团队隔离覆盖 `authorizeProject()`、`listAuthorizedProjects()`、`readableProjectIds()`、看板列表、任务查询、保存视图、WIP、Agent 与审计；插件端点保持 team 模式禁用，不因团队改造被意外启用。
- [ ] 所有新增查询有团队过滤测试：至少覆盖列表、详情、写操作、批量查询、缓存读取、事件和审计。
- [ ] standalone 模式不受影响，现有测试全部通过。
- [ ] 团队权限、切换、隔离与管理员跨团队读取均有自动化测试；测试从空库建库，不依赖迁移。

## Notes

- 团队边界应在数据库查询层统一注入，而不是只在 HTTP 处理器里零散判断；否则新增入口容易漏。
- 系统尚未上线，是本任务放弃迁移的唯一依据；一旦已有生产库，后续任何 schema 变更都必须补迁移与回滚测试。
- 不要保留半套迁移代码或“默认团队”兼容分支，避免新库与旧库行为分叉。
- 不要把团队隔离实现成前端隐藏；所有 API 必须服务端强制。
- 现有 `user_account.username_key` 是全局唯一；首版保持全局唯一，避免登录歧义，团队内显示名可不同。
