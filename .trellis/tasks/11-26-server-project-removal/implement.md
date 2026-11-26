# 项目永久移除实施计划

## 前置

- [x] 读取 `.trellis/spec/guides/cross-layer-thinking-guide.md`、`.trellis/spec/guides/code-reuse-thinking-guide.md` 和本任务 `research/current-project-removal.md`。
- [x] 实施前重新搜索 `disableProject`、`purgeTaskSpace`、`createTaskSnapshotBackupService`、`project_purged` 的所有消费者，确认没有新增冲突。
- [x] 保持现有未提交的 `11-26-project-member-account-picker` 任务目录原样。

## 实施顺序

1. [x] 调整备份默认保留数量
   - 将 `DEFAULT_RETENTION` 从 7 改为 5。
   - 将现有备份轮转测试改为“保留最近五份”，覆盖创建 7 次后只剩最新 5 份。

2. [x] 增加项目删除查询
   - 在 `packages/server/team/task-space/shared.js` 增加项目删除摘要、事务内项目身份和项目删除语句。
   - 摘要只统计远程地址、任务空间、任务、成员和团队访问数量。

3. [x] 实现项目删除服务
   - 在 `packages/server/team/task-space/lifecycle.js` 实现 `purgeProject()`。
   - 服务层强制系统管理员权限、精确名称确认、强制备份、事务复核、审计和删除。
   - 删除成功后调用现有 `onTaskSpacePurged`；清理异常不能把已提交删除报成失败。
   - 通过 `createTaskSpaceService()` 暴露该方法。

4. [x] 增加管理员 HTTP 路由
   - 在 `packages/server/team/http/routes/admin.js` 增加 `DELETE /api/admin/projects/:projectId`。
   - 路由使用 `requireAdmin(actor)`，body 为 `{ confirmation }`。
   - 成功后调用 `publishTaskControlChanged()`；失败时不发布。

5. [x] 增加服务级测试
   - 非系统管理员返回 403，且备份次数为 0。
   - 确认缺失、首尾空格或名称不一致返回 400，且不备份、不写删除审计。
   - 备份不可用或异常返回 503，项目数据保持不变。
   - 成功后项目及级联数据删除，其他项目不变，审计保留。
   - 返回摘要包含正确计数和备份 basename，不包含绝对路径。
   - 清理钩子被调用，清理失败不影响成功响应。

6. [x] 增加 HTTP 集成测试
   - 系统管理员删除返回 200 和契约字段。
   - 团队管理员和项目 `lead` 返回 403。
   - 删除后项目列表和任务查询不再返回该项目。
   - Board SSE 查询版本在成功后递增，失败时不递增。

7. [x] 执行接口 E2E
   - 使用本机最新源码、临时数据目录和独立端口启动真实 Team 后端。
   - 使用本机真实登录会话完成“创建/接入两个项目 -> 校验失败不删 -> 管理员成功删除项目 A -> 读回确认 A 消失、B 保留 -> 查审计/备份/索引 -> 清理测试数据”的闭环。
   - 每个写操作记录请求、对应后端日志和响应，区分契约级、持久化级和副作用级证据。
   - 将结论写入 `{TASK_DIR}/api-e2e-report.md`，未验证项必须明确保留。

## 验证命令

```powershell
node --test packages/server/test/team-task-snapshot.test.js
node --test packages/server/test/team-task-spaces.test.js
node --test packages/server/test/team-gitless-http.test.js
yarn test
```

- 最后一条 `yarn test` 在所有代码改动完成后执行一次。
- 不新增数据库 schema 版本或迁移；本次只增加查询和删除行为。
- 接口 E2E 使用真实 HTTP 请求而不是直接调用服务，报告先落盘再宣布通过。

## 风险文件

- `packages/server/team/task-snapshot-backup.js`：修改会影响自动备份、分支删除和项目删除，必须验证轮转排序。
- `packages/server/team/task-space/shared.js`：SQL 参数数量和项目 ID 约束必须与调用方一致。
- `packages/server/team/task-space/lifecycle.js`：事务边界、审计时机、备份失败和删除后清理是主要风险。
- `packages/server/team/http/routes/admin.js`：路由匹配不能误伤项目停用接口或子路径。

## 回滚点

- 备份保留数量可单独回滚为 7，不影响项目删除逻辑。
- 服务方法与管理员路由按两步独立提交；路由未启用前不会暴露删除入口。
- 删除依赖现有 schema 级联，不修改数据库结构，因此代码回滚不需要反向迁移。
- 若 E2E 发现级联缺失或外键失败，停止扩展手工删除 SQL，先修正 schema/迁移设计并重新评审。
