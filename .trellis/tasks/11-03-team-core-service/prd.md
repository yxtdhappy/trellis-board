# 实现团队版核心服务

## Goal

在不破坏现有单机模式的前提下，实现团队模式所需的认证、固定角色授权、审计、服务端 Git 工作副本、任务创建/委派和团队看板 API。

## Dependencies

- 依赖父任务 `11-03-team-board` 的 `prd.md` 和 `design.md`。
- 本子任务先冻结团队 API、schema 和任务身份契约，供 Agent 与 Web 子任务实现。

## In Scope

- 新增 `TRELLIS_BOARD_MODE=standalone|team`；standalone 保持现有行为。
- 团队模式显式配置公开 URL、Cookie 安全和是否信任反向代理；默认不信任转发头。
- SQLite schema v3 -> v4，升级前备份，新增账号、会话、登录限制、团队项目、项目成员、Agent、任务接受、审计、Git 操作和跨项目任务索引表。
- 自建账号、scrypt 密码哈希、可撤销会话、管理员用户管理和首次登录强制修改临时密码。
- 仅通过服务器本机 CLI 创建首个系统管理员，不暴露首次注册路由。
- 固定四类角色和统一权限函数；系统管理员不自动获得项目写权限。
- 项目成员到 Trellis developer ID 的映射、字符限制与 workspace 直接子目录校验。
- 服务端项目工作副本、绑定分支 fetch/ff-only 同步、项目级串行锁和受控 Git 提交/推送。
- 经管理员批准 `.trellis/scripts` 工具链摘要且无 lifecycle hooks 的 `task.py create --no-start`，以及 `task.json.assignee` 原子更新。
- 幂等键、`expectedTaskVersion`、推送失败保留操作记录和最多 3 次安全重试。
- 任务待接受/已接受状态、审计、单项目分组看板 API 和跨项目扁平查询 API。
- 按账号隔离的保存视图、WIP 上限和撤销范围；共享任务扩展写入统一 RBAC 与审计。
- Agent 注册、心跳、命令拉取和结果提交的服务端契约。

## Out of Scope

- Windows Agent 的本地实现和安装程序。
- 团队 Web 页面和交互。
- 每任务分支、worktree、审批流、评论、通知和 SSO。
- 外部数据库、消息队列和多实例部署。

## Acceptance Criteria

- [ ] standalone 模式原有自动测试通过，默认监听和现有 API 不改变。
- [ ] v3 数据库升级成功，备份存在；升级失败不产生半迁移数据库。
- [ ] 登录、会话撤销、账号禁用、Origin 校验和密码策略测试通过。
- [ ] 团队 HTML/API 响应带正确 CSP、`nosniff`、防 framing、`no-store` 头；脚本不使用内联或第三方来源。
- [ ] 四类角色权限矩阵由单一权限函数执行，跨项目访问和只读写操作返回 403。
- [ ] 负责人必须映射 developer ID 且 workspace 存在；无效负责人无文件写入。
- [ ] 新项目先进入 `provisioning`，摘要确认和首个负责人写入成功后原子转为 `current`；未批准项目不进入看板且不能写任务。
- [ ] 升级现有 repository 时保留 `repositories.id`，受管目录使用独立 `workspace_key`，既有任务扩展数据仍按原 `taskKey`/`executionTaskKey` 可见。
- [ ] `.trellis/scripts` 摘要变化或存在 lifecycle hooks 时服务端拒绝执行，并留下可诊断错误和审计。
- [ ] 创建/委派只有在 push 成功后返回成功；失败返回稳定错误码和操作 ID。
- [ ] 新任务写入 `branch=<sync_branch>`、`base_branch=null`，`task.py start/archive` 不再把共享分支判为自引用。
- [ ] 分支校验拒绝 `HEAD`、`@{-1}`、前导 `-` 和 refspec 字符，不把 reflog 表达式当字面分支名。
- [ ] 两个并发写同一任务时一个成功、一个 409，远端不丢提交。
- [ ] 团队看板只返回当前用户有权访问的项目，旧缓存携带 `stale`、`updatedAt` 和 `syncError`。
- [ ] 跨项目 `/api/tasks/query` 只使用授权项目；显式越权项目 ID 整体 403，无项目用户返回空页，再基于完整索引筛选、稳定分页和 `ETag`。
- [ ] 跨项目游标加密绑定当前用户、授权项目、筛选和索引版本；伪造、过期、越权复用或换版均返回可恢复的 409。
- [ ] 内置今日焦点、阻断已解除和自定义保存视图筛选在跨项目查询中语义一致；自然日变化会更新 `queryDay` 和 `ETag`。
- [ ] 单项目团队 `/api/board` 缺少 `projectId` 或无界 `limit` 时拒绝；项目摘要与分组任务分页分离。
- [ ] 项目扫描和旧扩展写都在同一事务中刷新 `team_task_index`，失败时保留上一版；跨项目依赖刷新两端，`queryRevision` 只在可见索引提交后递增。
- [ ] 两个账号的个人视图/WIP 互不覆盖，撤销只能作用于本人操作；人工阶段、计划字段、标签和依赖写操作均授权并审计。
- [ ] 所有敏感值不进入响应、日志、审计正文或 SQLite 明文。
- [ ] 400 账号、200 在线会话、100 项目、10,000 任务快照和 400 Agent 连接的容量基线可重复执行，不出现跨项目数据或写锁级联。
