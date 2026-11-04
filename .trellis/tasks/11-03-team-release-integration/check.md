# 发布与集成检查报告

## 结论

本地发布候选的代码、迁移、Git/Agent/Web E2E 和容量门槛均通过。当前执行环境的安全策略拒绝真实注册 Windows 计划任务，因此目标 Windows 用户机器上的安装、登录启动和卸载仍需在发布前补一次人工验收。

## 已通过

- `npm test`：150 项通过，0 失败。
- `node --test agent/test/*.test.js`：22 项通过，0 失败。
- 79 个 JavaScript 文件执行 `node --check`，全部通过。
- `npm run capacity`：400 账号、200 Web 会话、100 项目、10,000 任务、400 Agent、600 条持久连接。
- 容量请求全部成功，SQLite 无锁冲突；最终复核 Web 状态 p95 70.21ms、任务查询 p95 67.83ms、Agent 心跳 p95 24.20ms。
- 两份独立 v3 数据库升级到 v4，项目 ID、阶段、标签和依赖保留，时间戳备份可恢复。
- 注入迁移失败后主库保持 v3，备份完整且通过 SQLite 完整性检查。
- 真实临时 Git 远端完成创建、委派、push、接受和 Windows Agent ff-only 同步。
- 旧任务版本返回 409；远端 hook 拒绝进入 `pending_push`；恢复后 retry 成功，未强推。
- Chrome DevTools 完成首次强制改密、团队看板、用户创建、项目接入、Agent 管理、审计和 820px 响应式检查。
- Agent 分发 zip 包含固定 Node 24，未包含凭证、数据库、测试或开发机绝对路径。
- standalone 与 team 生产入口均真实启动成功；team 空库必须先通过 CLI 创建首管理员。

## 待目标机验收

- 在执行环境策略允许的干净 Windows 用户配置中执行 `service install`、确认登录启动、完成一次真实同步，再执行 `service uninstall`。
- 向公司真实环境发布、连接真实 Git 远端和创建真实账号不在本次本地验收范围内。
