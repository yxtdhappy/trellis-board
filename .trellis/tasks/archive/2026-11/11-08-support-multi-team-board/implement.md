# 多团队任务看板实施计划

## 实施原则

- 先完成后端授权与查询契约，再接前端，避免前端先依赖错误数据。
- 每一阶段先跑针对性测试，全部开发完成后再执行一次最终构建。
- 不新增数据库迁移；复用现有 `saved_view.team_id`、`user_board_state.team_id` 和 `agent_project_binding.team_id`。
- 保留无关未跟踪文件，不回滚用户改动。

## 1. Session 与团队成员关系

- [x] 在 `server/team/teams.js` 增加读取用户全部有效团队成员关系的统一函数。
- [x] 修改 `server/team/auth.js`：
  - Session 创建不再自动选择第一个团队。
  - `readSession()` 每次返回实时团队成员关系。
  - 保留兼容字段并固定为 `null`。
- [x] 修改 `server/team/http.js` 的 `readActor()` 和 `runtimePayload()`。
- [x] 让 `/api/auth/team` 返回 410，并删除前端切换刷新行为。

验证：

```powershell
node --test tests/team-isolation.test.js tests/team-core.test.js
```

## 2. 项目授权

- [x] 修改 `server/team/permissions.js`：
  - 按 `project -> team_project.team_id -> team_member` 计算角色。
  - 移除 `activeTeamId` 前置。
  - 可读项目集合覆盖全部有效团队。
- [x] 修改 `server/team/projects.js`：
  - `listAll`、`listReadable` 返回跨团队项目。
  - 项目 connect 使用显式 `teamId`。
- [x] 更新 runtime 项目能力，按项目所属团队角色计算。

验证：

```powershell
node --test tests/team-isolation.test.js tests/team-core.test.js
```

## 3. 任务查询与团队标识

- [x] 修改 `server/team/task-index.js`：
  - 支持 `teamId` 过滤。
  - 查询结果增加 `teamId`、`teamName`。
  - ETag、缓存键、游标移除 `activeTeamId`，加入团队筛选和项目集合哈希。
- [x] 修改 `server/team/board.js` 和 `server/team/http.js` 的任务响应。
- [x] 修改 `web/src/lib/team-client.js`、`web/src/api/board.ts` 和任务类型转换。
- [x] 在任务卡片、注意力队列和团队视角中显示所属团队。

验证：

```powershell
node --test tests/team-isolation.test.js tests/team-core.test.js tests/team-events.test.js
```

## 4. 保存视图与 WIP

- [x] 修改 `server/execution-store.js`：全局作用域与团队作用域按明确参数查询，不按活动团队推断。
- [x] 在 `server/team/board.js` 增加作用域校验和读写。
- [x] 在 `server/team/http.js` 增加：
  - `GET /api/saved-views`
  - `GET /api/board/settings`
  - POST/PUT/DELETE 保存视图的 `teamId`
- [x] 前端在团队模式下独立加载保存视图和 WIP，不依赖 `/api/board`。
- [x] 团队切换时重置保存视图、WIP、游标和 ETag。

验证：

```powershell
node --test tests/team-isolation.test.js tests/team-core.test.js tests/execution-history.test.js
```

## 5. 前端团队筛选

- [x] `web/src/hooks/useBoard.ts` 增加 `filters.teamId`。
- [x] 将 `TeamSwitcher` 改为不提交 Session 的受控团队筛选器。
- [x] 多团队默认 `all`；单团队不强制显示切换控件。
- [x] 项目栏、项目筛选和任务查询使用当前团队范围。
- [x] 管理员页面使用独立管理范围，不复用登录身份。

验证：

```powershell
npm test
```

项目没有独立 `typecheck` 脚本；TypeScript 检查在最终一次 `npm run build` 中完成。

## 6. 设备与 Agent

- [x] `server/team/desktop-auth.js` 不再记录活动团队。
- [x] `server/team/agents.js` 的桌面设备注册返回兼容 `teamId: null`。
- [x] 项目绑定继续按项目所属团队校验成员关系。
- [x] `listDevices`、`revokeDevice` 接受显式 `teamId`。
- [x] 更新 Agent 配置与测试，证明顶层 `teamId` 不影响多团队绑定。

验证：

```powershell
node --test tests/desktop-device-auth.test.js tests/team-events.test.js tests/desktop-package.test.js
```

## 7. 管理台团队范围

- [x] 团队管理员能力按所有成员关系计算。
- [x] `/api/admin/projects`、`/api/admin/agents`、`/api/admin/audit` 明确使用 `teamId`。
- [x] 创建项目时必须指定目标团队。
- [x] 管理台团队筛选只改变管理范围，不写 Session。

验证：

```powershell
node --test tests/team-isolation.test.js tests/team-core.test.js
```

## 8. 测试补充

- [x] 双团队用户登录后直接查询到两个团队任务。
- [x] `teamId=A`、`teamId=B`、`teamId=all` 分别返回正确任务。
- [x] A/B/global 三套保存视图和 WIP 互不影响。
- [x] 直接请求未加入团队项目返回 403 或 404。
- [x] 移除团队成员后，旧游标返回 `CURSOR_INVALID`。
- [x] 同一设备绑定两个团队的项目成功；无权限项目失败。
- [x] 撤销某团队设备绑定不影响其他团队绑定。
- [x] 单团队用户行为不退化。

## 9. 最终验证

开发全部完成后只执行一次构建：

```powershell
npm test
npm run build
```

浏览器 E2E：

1. 登录双团队账号，确认默认显示全部团队。
2. 切换团队 A，确认项目、任务、保存视图和 WIP 同时切换。
3. 切换团队 B，确认不会复用 A 的偏好和游标。
4. 切回全部团队，确认恢复全局配置。
5. 直接请求其他团队项目，确认服务端拒绝。
6. 管理员移除团队成员后刷新，确认任务和团队筛选项消失。

## 回滚点

- 后端授权和查询测试通过后再开始前端改造。
- 保存视图/WIP 作用域测试通过后再接管理台。
- 最终构建或 E2E 失败时按功能块回退代码；数据库没有迁移，不需要数据回滚。
