# 分支弃用生命周期与安全移除实施计划

## 1. 实施前检查

- 读取 `.trellis/spec/backend/desktop-realtime-sync.md`、`http-and-filesystem.md`、`scanning-and-persistence.md`。
- 读取 `.trellis/spec/frontend/index.md`、`rendering-and-state.md`、`quality-guidelines.md`。
- 读取 `.trellis/spec/guides/cross-layer-thinking-guide.md`、`.trellis/spec/guides/code-reuse-thinking-guide.md`。
- 重新确认工作区已有改动，保留无关文件和用户已有修改。
- 本任务不自动启动，不执行 `task.py start`，等待用户批准计划。

## 2. 数据库与领域模型

- [x] 将 `DATABASE_SCHEMA_VERSION` 升到 `12`。
- [x] 在 `sync_task_space` 增加 `retired_at`、`retired_by_user_id`、`retired_reason`。
- [x] 增加 `sync_task_space_retired` 索引。
- [x] 新增幂等 `ensureV12Schema()`，处理 v11 旧表补列。
- [x] 更新升级备份名称为 `board.sqlite.pre-v12.*`。
- [x] 更新 `taskSpacePublic()`、`projectPublic()` 和 `listTaskSpaces()` 的字段投影。
- [x] 保持现有 `disabled` 语义，不把历史 disabled 自动转为 retired。

## 3. taskSpace 生命周期服务

在 `apps/server/team/task-space-service.js`：

- [x] 增加统一 `canManageTaskSpace(actor, projectId, taskSpaceId)` 权限检查（复用 `manageContext()`）。
- [x] 增加 `retireTaskSpace()`：幂等设置退役元数据、disabling、清监听、取消命令、写审计。
- [x] 增加 `restoreTaskSpace()`：只恢复 retired 项、清元数据、保持 binding 监听为 0。
- [x] 增加 `purgeTaskSpace()`：校验确认字符串、生成摘要、严格备份、事务删除、写全局审计。
- [x] 让 `listReadable()` 排除 retired；`listStatusReadable()` 排除 retired 但保留历史 disabled。
- [x] 让 `listAll()` 返回全部 taskSpace 摘要，供管理台使用。
- [x] 让 `resolve()`、`preflight()`、`attach()` 和 `authorizeTaskSpace()` 拒绝 retired。
- [x] 在 `heartbeat` 返回中把 retired/disabled taskSpace 标记为不可同步，并保留 `BINDING_UNKNOWN` 路径。

## 4. 备份与事件

- [x] 扩展 `task-snapshot-backup.js`，提供严格的 `backupNowOrThrow()`；现有自动备份的容错行为保持不变。
- [x] 在 Team runtime 创建 taskSpace service 时注入备份服务。
- [x] 物理清除成功后刷新 `taskSpaceIndex` 查询 revision。
- [x] 物理清除和生命周期变化成功后广播 Board `tasks.changed`；不通过 SSE 传输任务正文。
- [x] 审计动作固定为 `task_space_retired`、`task_space_restored`、`task_space_purged`。

## 5. HTTP 管理接口

在 `apps/server/team/http.js` 的 projects 路由增加：

- [x] `GET /api/projects/:projectId/task-spaces`
- [x] `POST /api/projects/:projectId/task-spaces/:taskSpaceId/retire`
- [x] `POST /api/projects/:projectId/task-spaces/:taskSpaceId/restore`
- [x] `DELETE /api/projects/:projectId/task-spaces/:taskSpaceId`

- [x] DELETE 请求体校验 `{ confirmation: branchName }`，不匹配返回 400。
- [x] 项目负责人、团队管理员和系统管理员通过现有项目权限访问。
- [x] 普通成员、跨项目和不存在 taskSpace 统一返回不可操作错误。
- [x] 操作成功后返回任务数、文件数、监听数、备份文件名和最终状态。

## 6. Web 管理台

- [x] 更新 `apps/web/src/api/admin.ts` 的 taskSpace 类型和 API 函数。
- [x] 更新 `apps/web/src/hooks/useAdminProjects.ts`，选择项目时加载 task-space 摘要。
- [x] 更新 `apps/web/src/features/admin/ProjectsTab.tsx`，增加“分支管理”面板。
- [x] 已弃用和活跃/技术停用分支分组显示；每行提供对应恢复、弃用、移除动作。
- [x] 移除分支使用专用确认弹层：第一次展示影响摘要，第二次最终确认；提交中禁用按钮，失败保留弹层。
- [x] 管理台刷新后重新读取服务端状态；不在前端本地伪造删除结果。
- [x] 保持普通 Board 项目栏和任务选择器不显示 retired 分支。

## 7. 测试

- [x] `apps/server/test/database.test.js`、`database-v10.test.js`：v12 schema、v11 升级、重复启动、备份名、旧 disabled 保留。
- [x] `apps/server/test/team-task-spaces.test.js`：弃用/恢复幂等、权限、跨项目拒绝、retired 不出现在普通列表。
- [x] 新增或扩展 taskSpace 生命周期测试：直接移除 active、级联计数、备份失败不删除、全局审计保留。
- [x] `apps/server/test/team-gitless-http.test.js`：四个管理路由、确认字符串、普通成员拒绝、删除后查询不返回。
- [x] `apps/server/test/team-agent-slot.test.js`：retired heartbeat 为不可同步，purge 后为 `BINDING_UNKNOWN`。
- [x] Web 侧由生产构建和真实页面验收验证 TypeScript 与管理面板。
- [x] 真实浏览器：管理员弃用后普通页面消失，管理台仍可见；移除二次确认后任务和分支消失；另一项目不受影响。
- [ ] 真实桌面客户端：弃用后 watcher 停止，移除后本地关联显示失效，不继续上传。
  - 本任务没有修改桌面客户端管理入口；Agent 心跳、删除后 `BINDING_UNKNOWN` 和 watcher 停止由自动测试覆盖。
  - 本轮未启动真实 Tauri 客户端做 watcher 运行中删除验收，报告中保留为验证缺口。

## 8. 验证命令

最终所有开发完成后只在收尾阶段执行一次构建，不做逐阶段编译：

```powershell
npm test
npm run build
```

聚焦测试先在实现阶段执行：

```powershell
node --test apps/server/test/database.test.js apps/server/test/database-v10.test.js
node --test apps/server/test/team-task-spaces.test.js apps/server/test/team-gitless-http.test.js apps/server/test/team-agent-slot.test.js
```

最终执行结果：

- `npm test`：445 项，444 通过、1 跳过、0 失败。
- `npm run build`：通过；保留既有 500 kB chunk warning。
- `npm run build:desktop`：通过；保留既有 `theme-init.js` 非 module 提示。
- 真实浏览器 E2E：通过临时 Team 服务、临时 SQLite 和 E2E 前缀数据完成。

## 9. 风险与回滚点

| 风险 | 处理 |
| --- | --- |
| schema 升级失败 | 保留 `pre-v12` 快照，事务回滚；禁止旧程序直接打开 v12 |
| 备份失败仍删除 | 严格备份接口抛错，删除前中止 |
| 误删 active 分支 | 前端二次确认 + 服务端分支名确认 + 事务内复核 |
| 历史 disabled 被误判 | `retired_at` 独立表示弃用，不按 status 批量处理 |
| 删除后 Board 仍显示 | 提交后刷新 query revision 并广播 Board 变化 |
| 客户端继续写已删除 taskSpace | heartbeat 返回 disabled/BINDING_UNKNOWN，现有 Agent 停止 active watcher |

回滚顺序：

1. 停止 Team 服务。
2. 恢复本次 `pre-v12` 数据库快照及 WAL/SHM 备份。
3. 回退代码版本。
4. 启动服务，运行 `/api/health`、普通项目查询和管理台项目读取。
