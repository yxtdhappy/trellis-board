# 团队隔离实施计划

## 顺序

1. **Schema v6**（`server/database.js`）
   - `DATABASE_SCHEMA_VERSION = 6`；新库一次创建全部表。
   - 删除 v1-v5 顺序升级分支与迁移前备份；非 v6 库直接拒绝并提示重建。
   - 修改 `team_project`、`saved_view`、`user_board_state`、`audit_event`、`agent_*` DDL；新增 `team`、`team_member`、`agent_event_cursor`。
   - 校验：`node --test tests/database.test.js`（重写为新 schema 断言）。
2. **团队实体与会话切换**（新增 `server/team/teams.js`，修改 `auth.js`）
   - 团队 CRUD、成员整体替换、活动团队切换、移除成员清理。
   - `readSession`/`publicUser` 带 `activeTeamId`；登录时自动选第一个可用团队；`createUser` 支持 `teams`。
3. **权限与查询边界**（`permissions.js`、`projects.js`、`task-index.js`、`board.js`）
   - 统一 `listAuthorizedProjects` / `authorizeProject`；系统管理员跨团队可读；团队管理员本团队可管理。
   - 看板、任务查询、保存视图、WIP、委派、缓存、ETag/游标全部带活动团队。
4. **审计与 Agent**（`audit.js`、`agents.js`、`assignments.js`、`task-writes.js`）
   - 审计自动推导/过滤 `team_id`；配对码、绑定写团队；心跳校验团队成员；事件游标 `(agent, team)`。
   - 团队成员移除时清理项目成员/绑定/命令。
5. **HTTP API**（`server/team/http.js`）
   - 新增 `/api/teams`、`/api/auth/team`、`/api/admin/teams*`、`/api/admin/users/:id/teams`、Agent 事件游标。
   - 调整管理端点权限：团队管理员可管理本团队项目/Agent/审计。
6. **前端**
   - `web/src/api/admin.ts`/`board.ts` 增加团队类型与 API。
   - `AdminPage` 新增团队页签；`TopBar`/管理页增加团队切换器。
   - `npm ci --prefix web && npm run build`。
7. **测试**
   - 新 `tests/team-isolation.test.js`：全新库 v6、跨团队 404/403、workspace_key 团队内唯一、活动团队切换、审计/Agent 事件隔离、成员/绑定失效、游标。
   - 更新 `tests/team-core.test.js` 夹具（团队、成员、活动团队）；更新 `tests/database.test.js`、`tests/plugin-store.test.js` 的 schema 断言。
8. **检查与提交**
   - `npm test`（记录 plugin-docs 两条基线失败）；`npm run build`；`git diff --check`。
   - 按 `trellis-check` 清单自检后提交到 `codex/11-05-team-isolation`；任务保持 `in_progress`。

## 验证命令

```bash
node --test tests/database.test.js tests/plugin-store.test.js
node --test tests/team-core.test.js tests/team-isolation.test.js
npm test
npm ci --prefix web && npm run build
git diff --check
```

## 评审门

- 所有跨团队读取必须能在 SQL 里看到 `team_id` 或“团队过滤后的项目 ID 集合”约束。
- 不允许前端隐藏代替服务端校验。
- 不允许保留 v5 兼容分支、默认团队回填或迁移脚本。
- 不修改无关任务、不归档、不合并。
