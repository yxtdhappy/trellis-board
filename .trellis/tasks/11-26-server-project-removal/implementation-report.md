# 实施报告

## 状态

实现与自动化测试已完成。未提交、未推送、未归档。

## 改动

- `packages/server/team/http/routes/admin.js`
  - 新增 `DELETE /api/admin/projects/:projectId`。
  - 路由要求系统管理员，调用项目删除服务，成功后递增查询版本并发布 Board SSE。
- `packages/server/team/task-space/lifecycle.js`
  - 新增 `purgeProject()`。
  - 服务层再次校验系统管理员权限和精确项目名称。
  - 删除前强制备份，事务内重新校验项目、统计摘要、写 `project_purged` 审计并删除项目。
  - 删除提交后调用既有清理钩子，清理异常不回滚已提交删除。
- `packages/server/team/task-space/shared.js`
  - 增加项目删除身份、摘要和删除 SQL。
- `packages/server/team/task-space-service.js`
  - 暴露 `purgeProject()`。
- `packages/server/team/task-snapshot-backup.js`
  - 默认及硬上限调整为 5 份，超过后按时间排序删除最早备份。
- `packages/server/test/team-task-spaces.test.js`
  - 覆盖非系统管理员、团队管理员、项目负责人、错误确认、备份不可用、备份失败、并发名称变化、成功级联删除、审计保留、清理失败和项目隔离。
- `packages/server/test/team-gitless-http.test.js`
  - 覆盖未登录、无管理员权限、错误确认不新增备份、管理员成功删除、响应脱敏、审计、索引版本和其他项目保留。
- `packages/server/test/team-task-snapshot.test.js`
  - 覆盖即使用户传入更大 retention，备份仍最多保留 5 份。
- `.trellis/tasks/11-26-server-project-removal/implement.md`
  - 勾选已完成的实施步骤；API E2E 保持未勾选，由主会话执行。

## 关键决策

- 仅系统管理员可以永久删除项目；路由和服务层双重防护。
- 项目名称逐字匹配，不做 trim 兼容。
- 备份、审计和删除复用现有分支移除模式。
- 项目删除依赖 SQLite 外键级联，没有新增数据库 schema 或迁移。
- 备份保留数量允许调用方设置更小值，但任何情况下不能超过 5 份。
- API 成功响应仅返回备份 basename，不返回服务端绝对路径。

## 验证

- `node --test packages/server/test/team-task-snapshot.test.js`
  - 23 通过，0 失败。
- `node --test packages/server/test/team-task-spaces.test.js`
  - 19 通过，0 失败。
- `node --test packages/server/test/team-gitless-http.test.js`
  - 5 通过，0 失败。
- `yarn test`
  - 793 通过，2 跳过，0 失败。
- `node --check` 检查全部改动的 JS 文件，全部通过。
- `git diff --check` 检查本次文件，无空白错误。
- IDEA MCP 静态检查未返回错误或警告；该工具响应带 `more: true`，不作为单独验收依据。

## 未验证与风险

- 本机真实 HTTP API E2E 已由主会话在独立检查后完成；结果见 `api-e2e-report.md`，14 个 HTTP
  步骤通过，后端错误日志增量均为 0。
- 项目删除后的归档快照物理清理由既有启动清理兜底，服务级测试验证了回调触发和异常隔离，但未在真实数据目录验证文件级清理。
- 本次未执行构建；项目当前没有对应构建步骤。
