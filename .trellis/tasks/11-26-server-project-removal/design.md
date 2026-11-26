# 项目永久移除技术设计

## 边界

- 范围只包含 Team 服务端：HTTP 路由、任务空间服务、SQLite 查询与测试。
- 不新增 Web 页面、软删除状态、回收站、恢复接口或远程 Git 仓库删除。
- 现有项目停用和分支永久移除行为保持不变。

## HTTP 契约

### 删除项目

```http
DELETE /api/admin/projects/:projectId
Content-Type: application/json

{"confirmation":"项目名称"}
```

- 认证：登录会话。
- 权限：仅 `actor.systemAdmin === true`。路由使用 `requireAdmin(actor)`，服务层再次校验，防止绕过路由直接调用。
- `400 INVALID_INPUT`：确认字符串缺失、包含额外首尾空格或不等于项目名称。
- `403 FORBIDDEN`：非系统管理员。
- `404 NOT_FOUND`：项目不存在。
- `409 CONFLICT`：事务复核时项目状态变化或删除影响行数不为 1。
- `503 DATABASE_BACKUP_UNAVAILABLE`：备份服务不可用。
- `503 DATABASE_BACKUP_FAILED`：备份创建或备份轮转失败。

成功响应：

```json
{
  "purged": true,
  "projectId": "project-id",
  "projectName": "项目名称",
  "backupName": "board.sqlite.snapshot.20261126T...Z",
  "summary": {
    "remoteUrl": "https://example.com/acme/repo.git",
    "taskSpaceCount": 2,
    "taskCount": 10,
    "memberCount": 3,
    "teamAccessCount": 2
  }
}
```

不返回备份文件的绝对路径。

## 服务设计

在 `packages/server/team/task-space/lifecycle.js` 新增 `purgeProject(actor, projectId, input)`，并通过 `createTaskSpaceService()` 暴露：

1. 校验 `actor.systemAdmin`，否则抛 403。
2. 读取项目；不存在时抛 404。
3. 以类型安全方式读取 `confirmation`，要求与项目名称逐字相等；不做 trim 兼容。
4. 校验 `backupService.backupNowOrThrow` 可用，然后强制备份。
5. 在删除前读取项目删除摘要：远程地址、任务空间数、任务数、成员数、团队访问数。
6. 开启事务：
   - 重新读取项目身份，确认项目仍存在且名称与确认值一致。
   - 写入 `project_purged` 审计，包含项目摘要和备份文件名。
   - 执行 `DELETE FROM sync_project WHERE id = ?`。
   - 删除影响行数不是 1 时抛 409，事务回滚。
7. 事务提交后调用 `onTaskSpacePurged` 清理钩子；清理异常被隔离，不回滚已提交删除。
8. 返回脱敏摘要。

## 数据与级联

- 删除 `sync_project` 行依赖现有外键级联清理项目成员、团队访问、任务空间、任务索引、任务分配、任务命令、任务和所有权收件箱等数据。
- `audit_event.project_id` 没有外键，因此 `project_purged` 事件在项目删除后仍保留。
- 如果外键约束导致删除失败，数据库事务整体回滚，返回错误，不进行部分手工清理。
- 不在路由中重复实现级联 SQL。

## 路由与缓存

- 在 `packages/server/team/http/routes/admin.js` 增加 `DELETE /api/admin/projects/:projectId`。
- 路由先调用 `requireAdmin(actor)`，再读取 JSON body 并调用 `taskSpaces.purgeProject()`。
- 成功后调用现有 `publishTaskControlChanged()`：递增任务查询版本并发布 Board SSE，使其他客户端丢弃旧项目/任务数据。
- 删除操作失败时不递增查询版本。

## 备份轮转

- 将 `packages/server/team/task-snapshot-backup.js` 的默认保留数量从 7 改为 5。
- 继续使用现有 `prune()`：新备份成功创建后，按时间文件名排序删除最早的多余备份，最终最多保留 5 份。
- 自动每日备份、分支永久移除和项目永久移除共用该上限。
- 不增加配置项；当前生产初始化没有覆盖 retention，修改默认值即可生效。

## 并发与一致性

- 备份在数据库事务外创建，使用删除前数据库状态。
- 事务内再次读取项目身份，防止确认期间项目被替换或名称变化。
- 项目名称当前没有更新入口，但事务复核仍作为防御边界保留。
- 删除后的文件和缓存清理属于可重试副作用；数据库删除是唯一提交边界。

## 回滚与运维

- 数据库删除前的唯一恢复来源是删除过程中生成的 SQLite 快照备份。
- 备份最多保留 5 份，旧备份会被轮转删除；项目删除备份不提供永久归档。
- 若数据库删除已提交但清理失败，重启时的现有清理逻辑会重试，不应要求重新删除项目。
- 不提供 API 自动恢复；运维恢复需要人工使用对应备份。
