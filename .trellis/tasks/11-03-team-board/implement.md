# 团队版：集成实施计划

## 执行原则

- 父任务不直接实现产品功能，负责冻结跨子任务契约、审查集成结果和最终验收。
- 只启动当前需要交付的子任务；父子目录关系不自动代表执行依赖。
- 每个子任务从父 `prd.md`、`design.md`、自身 `prd.md`、`design.md` 和 `implement.md` 开始。
- 开发过程中不反复构建；各子任务只运行必要的局部测试，全部产品改动完成后统一执行最终测试和真实 E2E。
- 保持单机模式兼容，任何团队表、字段和路由只能在 `TRELLIS_BOARD_MODE=team` 下启用。

## 子任务与顺序

### 1. `11-03-team-core-service`

交付 schema v4、认证/RBAC、审计、受管 Git 工作副本、任务创建/委派、接受状态和团队看板 API。

启动条件：无前置实现，但必须先接受父设计中的 API、表结构和任务身份契约。

完成门槛：

- 单机模式现有功能不回归。
- schema v3 -> v4 迁移和备份测试通过。
- 未登录、越权、跨项目访问、版本冲突、脚本工具链摘要变化和 lifecycle hooks 均被拒绝。
- 项目只能经过 `provisioning -> current` 的摘要批准流程启用，`needs_repair` 只能经管理员 repair 恢复。
- 任务创建和委派只有在 commit + push 成功后返回成功。

### 2. `11-03-windows-sync-agent`

交付 Windows 用户级 Agent、DPAPI 凭证、设备配对、项目绑定、心跳和共享分支 ff-only 同步。

启动条件：核心服务已冻结 Agent API、凭证格式、协议版本和错误码。

完成门槛：

- 分支不匹配、dirty、ignored 文件将被覆盖、远端不可达和凭证撤销均明确报错。
- Agent 不执行 checkout、stash、reset、rebase 或 worktree 操作。
- 完整同步后本地 `.trellis` 与远端共享分支一致。

### 3. `11-03-team-web-console`

交付登录、权限化看板、管理员页面、项目成员/设备状态、待接受队列和 Git/Agent 错误反馈。

启动条件：核心服务的认证、权限和团队 API 已可调用。

完成门槛：

- 前端只做体验层隐藏，越权仍由服务端拒绝。
- 登录、项目切换、创建/委派、接受和失败重试形成完整操作闭环。
- 1440px 桌面与 860px 以下响应式、键盘操作和控制台无错误。

### 4. `11-03-team-release-integration`

交付集成分支、部署文档、数据库迁移/回滚演练、Windows Agent 分发包、容量与安全验收。

启动条件：前三个子任务均已通过自身检查并完成归档或留下可引用的提交。

完成门槛：

- 从现有数据库副本完成一次真实升级和回滚。
- 两个项目成员完成“创建/委派 -> push -> 接受 -> Agent 同步”的真实闭环。
- 400 账号、200 在线用户、100 项目、10,000 任务和 400 Agent 连接有可重复压测记录。
- 运维手册包含配置、凭证、备份、升级、回滚和故障处置。

## 跨子任务冻结契约

- 项目标识沿用 `repositories.id`；任务路径必须经 `resolveTaskLocation()` 校验。
- `relativeDir` 用于任务位置，`executionTaskKey=${projectId}::${task.id||dirName}` 用于团队状态；两者不得互换。
- `expectedTaskVersion` 是任务 `task.json` 原始字节的 SHA-256。
- 新团队任务的 `branch` 固定为项目 `sync_branch`，`base_branch` 固定为 `null`；项目共享分支不依赖任务文件表达，客户端不能覆盖。
- 所有任务写接口统一返回成功、冲突、未授权、Git 失败和幂等重放五类结果。
- `SCAN_SCHEMA_VERSION` 只随看板投影形状变化递增；`DATABASE_SCHEMA_VERSION` 随数据库迁移递增。
- Agent 协议版本独立于 Agent 展示版本，不兼容时只允许心跳和状态上报。

## 验证策略

- 核心服务：`npm test`，新增测试覆盖 migration、auth、RBAC、Git manager、task write、audit、stale cache 和 recovery。
- Windows Agent：Node 自动测试覆盖命令白名单、路径/远端归一化、分支/dirty 判断和凭证存储接口；在 Windows 上用临时 Git 仓库做真实同步。
- Web：真实 HTTP + Chrome DevTools MCP；覆盖登录、多角色、任务写失败、接受、Agent 离线、移动端布局和控制台。
- 发布集成：一次完整 `npm test`、全部 JS `node --check`、真实服务、真实 Git 远端、Windows Agent 和目标容量压测。

## 提交与回滚边界

- 迁移与团队表结构单独提交。
- 认证/RBAC/审计单独提交。
- Git 管理器与任务写接口单独提交。
- Agent、Web、部署和验收分别提交。
- 每个可独立启动的提交必须保持 standalone 模式可运行；团队模式未完成时不得伪装为可用。
- 回滚依赖 v3 数据库快照、上一版应用目录和 Git 远端；不通过删除远端任务或强推恢复。

## 最终集成检查

- [ ] 父任务 `children` 与四个子任务 `parent` 双向一致。
- [ ] 所有子任务 `implement.jsonl`/`check.jsonl` 指向真实 spec/research/design 文档。
- [ ] 单机与团队模式在同一代码库中可显式切换。
- [ ] 任务创建、委派、接受和 Agent 同步端到端通过。
- [ ] 团队看板支持跨项目扁平分页和单项目分组页，禁止全系统任务正文广播。
- [ ] 项目 provisioning 批准、工具链重批和 `needs_repair` 恢复均经过真实验证。
- [ ] 数据库升级、回滚、备份和恢复均有真实记录。
- [ ] 无未审计的项目任务写、无强推、无凭证泄漏、无脏工作区覆盖。
