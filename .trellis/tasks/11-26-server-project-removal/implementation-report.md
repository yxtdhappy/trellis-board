# 实施报告

## 状态

服务端删除能力、Web 系统管理员删除入口和自动化验证已实现。真实浏览器页面验收尚未执行；
未提交、未推送、未归档。

## 改动

### 服务端

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
  - 覆盖权限、确认、备份失败、并发名称变化、级联删除、审计保留、清理失败和项目隔离。
- `packages/server/test/team-gitless-http.test.js`
  - 覆盖鉴权、错误确认、响应脱敏、审计、索引版本和 HTTP 契约。
- `packages/server/test/team-task-snapshot.test.js`
  - 覆盖备份最多保留 5 份。

### Web

- `packages/web/src/api/admin/project-teams.ts`
  - 新增 `purgeProject(projectId, confirmation)`，调用项目删除接口。
- `packages/web/src/api/admin/types.ts`
  - 新增 `PurgeProjectResult`。
- `packages/web/src/api/admin/readers.ts`
  - 归一化删除响应及摘要字段。
- `packages/web/src/api/admin.ts`
  - 统一导出 `purgeProject()`，组件不直接请求接口。
- `packages/web/src/hooks/useAdminProjects.ts`
  - 新增 `purgeProject()`；成功后清空当前选择、过滤 stale runtime project 并重新加载管理项目。
- `packages/web/src/features/admin/ProjectRemovalDialog.tsx`
  - 新增两阶段危险确认弹窗：先展示删除范围，再要求输入完整项目名称。
  - 名称不完全匹配时禁止提交；失败保留弹窗、输入和错误；成功后重置并关闭。
  - 明确真实 Git 仓库、客户端本地 `.trellis/tasks` 和账号不会被删除。
- `packages/web/src/features/admin/ProjectsTab.tsx`
  - 只在 `systemAdmin && selectedProject` 时显示危险样式“移除项目”按钮。
  - 接入 `ProjectRemovalDialog`，保留现有账号选择器未提交改动。

### 规范与任务制品

- `.trellis/spec/frontend/rendering-and-state.md`
  - 增加管理台项目永久移除的触发条件、契约、错误矩阵、测试要求和正反例。
- `.trellis/tasks/11-26-server-project-removal/prd.md`
- `.trellis/tasks/11-26-server-project-removal/design.md`
- `.trellis/tasks/11-26-server-project-removal/implement.md`
- `.trellis/tasks/11-26-server-project-removal/research/current-project-removal.md`
  - 将任务范围从仅服务端扩展为系统管理员专用 Web 入口，并记录 Web 删除契约。

## 关键决策

- 仅系统管理员可以永久删除项目；HTTP 路由和服务层双重防护。
- 项目名称逐字匹配，不做 trim 兼容。
- Web 入口显示条件是 `systemAdmin`，不能单独使用 `isAdmin`，避免团队管理员看到入口。
- 删除成功只以服务端响应为准，再从管理项目列表刷新；已删 ID 从 stale runtime 合并结果中过滤。
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
- `node --test packages/web/test/team-web.test.js`
  - 27 通过，0 失败。
- `yarn build`
  - TypeScript 和 Vite 构建通过。
- `yarn workspace @trellis-board/web lint`
  - 退出码 0；无 error，只有工作区既有 warning。
- `yarn oxfmt`
  - 本任务改动文件已完成格式化。
- `git diff --check`
  - 无空白错误；仅 `check.jsonl`、`implement.jsonl` 的 CRLF 提示。
- `yarn test`
  - 全量汇总：793 通过，2 跳过，1 失败。
  - 唯一失败是 `packages/server/test/team-release.test.js`：完整并发运行时，测试结束后仍有异步数据库活动并报
    `database is not open`。
  - 该文件单独运行 `node --test packages/server/test/team-release.test.js` 为 1 通过、0 失败；三次完整复跑均
    只在该测试隔离问题上失败，本次服务端新增删除测试和其他测试均通过。

## 未验证与风险

- 真实浏览器验收未执行，AC12 至 AC16 保持未勾选：系统管理员可见按钮、两阶段弹窗、名称不匹配禁用、
  成功删除后关闭/清空/刷新、团队管理员不可见、浅色/深色和窄屏不溢出。
- 当前生产页面尚未部署本次 Web 改动；`production-page-e2e-report.md` 记录的是此前仅服务端版本，
  因此其中“没有删除按钮”的 UI 结论不代表本次完成后的构建。
- 本次成功删除、备份、级联、审计保留和项目隔离已有本机真实 HTTP API E2E，见
  `api-e2e-report.md`；未在生产环境使用真实项目名执行成功删除。
- 项目删除后的归档快照物理清理由既有启动清理兜底；服务级测试验证了回调触发和异常隔离，但未在真实数据目录
  验证文件级清理。
- 全量 `yarn test` 仍受上述既有测试隔离问题影响，需由后续独立检查判断是否另开修复任务。
