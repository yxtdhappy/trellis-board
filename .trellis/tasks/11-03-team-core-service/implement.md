# 核心服务实施计划

## 前置

- 阅读父 `prd.md`、`design.md` 和本任务 `prd.md`、`design.md`。
- 先核对 `server/database.js` 当前 schema、`server/index.js` 路由边界和 `server/actions.js` 的 `task.py` 参数；不假设既有实现比父设计更完整。
- 不引入第三方运行时依赖，不启用团队模式公开监听，不执行破坏性 Git 操作。

## 步骤

1. **契约与 fixture**
   - 固定错误码、Agent 协议版本、`expectedTaskVersion` 和幂等结果结构。
   - 建立临时 Git 裸仓库、项目工作副本和测试账号 fixture。

2. **schema v4**
   - 在 `server/database.js` 增加 v3 -> v4 迁移、索引、`project_scan_cache`、`team_task_index`、标签索引和备份；新增 `server/team/task-index.js` 负责原子换版与查询。
   - 先写迁移/回滚测试，再实现团队存储查询。

3. **认证、会话、RBAC**
   - 新增 `server/team/auth.js`、`permissions.js`、`audit.js`。
   - 新增 `server/team/cli.js` 的本机首个管理员初始化，密码使用隐藏输入并复用认证模块。
   - 接入团队 HTTP 中间层；standalone 路径保持原样。
   - 覆盖密码、Cookie、Origin、CSRF 边界和权限矩阵测试。

4. **项目与成员**
   - 新项目以 UUID 创建 `repositories` 行；升级现有项目保留原 ID 并保留其扩展数据。两种项目都生成独立 `workspace_key` 并克隆到 `data/projects/<workspace_key>`，先进入 `provisioning` 并计算 scripts 摘要；批准前不执行仓库脚本、不覆盖旧 `repositories.path`。
   - 管理员确认摘要后运行 hooks 预检、写入首个 `lead`、切换 `repositories.path` 并转 `current`；实现 `needs_repair` 的管理员 repair 入口。
   - 复用 `repositories` 和 `resolveTaskLocation()`；禁止把绝对路径返回浏览器。

5. **Git manager**
   - 实现项目锁、受限远端/分支校验、fetch/ff-only、整个 `.trellis/scripts` 树摘要、hooks 拒绝、commit、push、非快进重试和 `pending_push` 恢复。
   - 100 个项目的定期 fetch 使用抖动、60 秒最小间隔和最多 4 个并发，避免定时器同时启动全部子进程。
   - 所有 Git 子进程使用固定参数、hooks/autocrlf 禁用、OpenSSH 非交互、超时和脱敏输出；merge 使用 `--no-overwrite-ignore`。
   - 用真实临时 Git 仓库验证，不以 mock 代替核心 push 路径。

6. **任务创建与委派**
   - 抽取 `server/actions.js` 可复用参数/校验，不改变 standalone 行为。
   - 分支校验使用 `refs/heads/<branch>` 形式并拒绝 `HEAD`/`@{-n}`；新建任务在提交前规范化为 `branch=<sync_branch>`、`base_branch=null`，并验证现有 `task.py start/archive` 不误报分支自引用。
   - 实现幂等、版本冲突、push 成功后 assignment 和看板刷新。

7. **接受与团队看板**
   - 实现 pending/accepted、当前负责人接受、重新委派重置。
   - 团队模式复用 loader/worker 扫描受管副本；成功扫描后原子替换该项目的 `team_task_index`，供跨项目筛选和 `/api/tasks/query` 稳定游标使用。
   - `/api/board` 强制 `projectId` 并返回单项目分组投影；`/api/tasks/query` 返回跨授权项目的扁平任务行。两者默认 100/最大 200 条、服务端筛选和 ETag。
   - `queryRevision` 随索引或项目可见性事务递增；游标用进程内临时 AES-GCM 密钥绑定用户、项目集、筛选、版本和 10 分钟期限，失效返回可恢复的 409。
   - 隔离保存视图、WIP 和撤销范围；给旧阶段/计划字段/标签/依赖写接口加统一项目授权和审计。
   - 影响筛选的旧扩展写在同一事务中刷新索引；跨项目依赖刷新两个项目，失败整体回滚。
   - team 模式完全绕过 `data/repos.json`，只使用 `team_project` 指定的受管工作副本。

8. **Agent 服务端 API**
   - 配对、凭证哈希、心跳、长轮询、命令租约/重投、幂等结果和撤销。
   - 为 Agent 子任务提供稳定协议和可复制的本地 E2E fixture。

9. **增量刷新**
   - 记录项目 branch SHA、`boardVersion` 与 Trellis 内容键，仅在任务相关内容变化或服务端写入成功后重扫该项目；HTTP 读取继续使用最近缓存。

10. **统一验证**
   - 完成全部代码后统一运行 `npm test` 和新增 JavaScript 的 `node --check`。
   - 启动 standalone 与 team 两种模式做真实 HTTP 验证；检查敏感值未出现在响应、日志和数据库中。

## 完成门槛

- [ ] schema v4 与备份/回滚测试通过。
- [ ] 四类角色权限矩阵与未登录/跨项目拒绝通过。
- [ ] 任务创建和委派只有 push 成功后成功。
- [ ] 并发冲突、幂等重放、push 失败恢复有自动测试。
- [ ] commit trailer 可按操作 ID 找回并补齐“已推送但数据库未更新”的恢复状态。
- [ ] 脚本树摘要变化或存在 lifecycle hooks 时不会执行仓库脚本。
- [ ] 项目只在摘要批准且 hooks 预检通过后启用，`needs_repair` 不能由普通刷新绕过。
- [ ] 个人看板状态不跨账号覆盖，撤销不跨账号；旧任务扩展写接口无未授权入口。
- [ ] standalone 全量回归通过。
- [ ] Agent/Web 可依赖的 API 契约已记录并由真实请求验证。
- [ ] 400 账号、200 在线、100 项目、10,000 任务和 400 Agent 连接容量基线通过，项目分页不串数据。
- [ ] 跨项目查询权限、内置/保存视图、搜索/阶段/优先级/标签/负责人/截止/阻断、自然日、加密游标和 ETag 测试通过。
