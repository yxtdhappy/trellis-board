# 当前项目移除相关实现调研

## 结论

服务端原有停用项目但没有永久删除入口。当前任务已新增仅系统管理员可调用的 API，并扩展
系统管理员专用的 Web 管理页入口；删除复用“确认名称 + 强制备份 + 审计 + 事务删除 + 删除后清理”的模型。

## 现有行为

- `sync_project.status` 只允许 `active`、`disabled`，没有软删除字段。
- `POST /api/admin/projects/:projectId/disable` 将项目状态改为 `disabled`，停止绑定并取消项目命令，但不删除数据。
- `DELETE /api/projects/:projectId/task-spaces/:taskSpaceId` 已实现分支永久删除，要求确认分支名、强制数据库备份、写入审计、事务删除，再调用清理钩子。
- 服务端当前提供 `DELETE /api/admin/projects/:projectId`，并通过
  `createTaskSpaceService().purgeProject()` 执行。
- Web 管理端当前已增加系统管理员专用的项目移除按钮、两阶段确认弹窗与列表刷新。

## 数据关系

- 项目主表为 `sync_project`。
- 成员、团队访问、任务空间、合并证据、任务索引、任务分配、任务命令、任务和所有权收件箱等主要关联表通过外键声明 `ON DELETE CASCADE`。
- 数据库连接执行 `PRAGMA foreign_keys = ON`，因此事务内删除 `sync_project` 会触发已声明级联。
- `audit_event.project_id` 没有外键，删除项目后历史审计仍可保留。
- 任务快照备份文件名由 `board.sqlite.snapshot.<UTC timestamp>` 标识，并按文件名正序将最早备份排在前面。

## 备份现状

- `createTaskSnapshotBackupService()` 已实现备份创建和轮转。
- 当前默认保留 5 份，生产初始化没有显式覆盖。
- `prune()` 在每次成功创建新备份后删除超出保留数量的最早文件。
- 分支永久删除复用同一服务和同一保留策略。

## 可复用实现点

- 复用 `requireAdmin(actor)` 作为路由层系统管理员门禁。
- 复用 `backupNowOrThrow({ force: true })` 作为删除前备份门禁。
- 复用 `appendAuditEvent()` 写入删除前审计。
- 复用 `withTransaction()` 保证项目存在性复核、审计和删除原子提交。
- 复用 `onTaskSpacePurged` 清理钩子和 `incrementQueryRevision()` 失效任务查询缓存。
- 复用现有错误结构、状态码和脱敏摘要返回方式。

## 需要新增

- 仅管理员可访问的项目删除路由。
- `purgeProject(actor, projectId, input)` 服务方法。
- 项目数据摘要查询和项目删除 SQL。
- 删除后的任务索引版本递增和 Board SSE 通知。
- 系统管理员权限、级联删除、审计保留、备份失败和项目隔离测试。
- 备份默认保留数量从 7 调整为 5，并同步更新备份轮转测试。
