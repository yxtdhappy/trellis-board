# 已冻结的团队版契约

## 产品边界

- 服务端为每个逻辑项目维护一份受管 Git 工作副本，绑定项目接入时显式约定的共享分支，不设全局默认分支。
- 新项目用 UUID 创建 `repositories` 行，升级现有项目保留原 ID；两者都另生成 `workspace_key` 并克隆到 `data/projects/<workspace_key>`，先保持 `provisioning`。管理员确认整个 `.trellis/scripts` 树摘要并通过 hooks 预检后才指定首个负责人并转 `current`。
- 项目远端和 `sync_branch` 创建后不可原地修改；配置错误时停用旧项目并重新接入。
- 所有任务创建和负责人修改在服务端完成；成功返回前必须 commit + push。
- 每个任务不建独立分支或 worktree。
- 新团队任务把共享分支写入 `task.json.branch`，并把 `base_branch` 置为 `null`；共享分支本身存放在 `team_project.sync_branch`，避免现有归档校验把 branch/base_branch 相同判为自引用。
- 项目负责人和项目成员都能创建任务、委派给项目内任意有效成员；只读成员不能写。
- Windows Agent 只同步共享分支和上报状态，不拥有任务写权限。
- 团队看板默认跨授权项目混合查看任务，但跨项目结果来自服务端 `team_task_index` 的分页扁平查询；完整父子分组在单项目看板读取。
- 跨项目查询先与当前用户的项目权限求交集，再执行搜索和筛选；稳定游标携带 `queryRevision`，索引换版后旧游标返回 409。

## 身份

- 系统账号通过 `project_member.trellis_dev_id` 映射到项目内 developer ID。
- 任务负责人的 developer ID 必须在项目内唯一，且 `.trellis/workspace/<developer-id>` 已存在。
- 有效负责人必须同时是启用账号、项目写成员、已映射 developer ID，且 workspace 是仓库内普通直接子目录。
- 任务位置仍使用 `relativeDir`，团队状态仍使用 `executionTaskKey`。

## 写入与版本

- 项目写操作按项目串行。
- 现有任务写入必须携带 `expectedTaskVersion = SHA-256(task.json 原始字节)`。
- 幂等键唯一；成功后重放返回原结果，不重复 commit。
- Git 非快进最多安全重试 3 次；禁止 force push、任意 refspec 和用户任意 Git 参数，远端只由管理员在接入时配置。
- 提交主题固定为 `trellis(team): <operation_type> <operation_id>`，最后一行固定 `Trellis-Operation: <operation_id>` trailer；不从标题/描述拼接提交信息。
- push 失败时返回操作 ID，任务不进入待接受；`pending_push` 可由后台恢复。已改变工作副本的操作不得直接标为不可恢复的 `failed`。
- `needs_repair` 只能由系统管理员在人工处理后调用 repair，按 trailer 对清本地/远端状态；普通刷新不能清除。
- 服务端 merge 使用 `--ff-only --no-overwrite-ignore FETCH_HEAD`；Git 固定禁用 hooks、autocrlf、fsmonitor、签名和交互凭据弹窗，并有硬超时。

## 安全

- 自建账号、scrypt 密码、可撤销服务端会话；Agent 使用独立可撤销 Bearer 凭证。
- 所有浏览器状态变更请求校验 Origin 和 JSON Content-Type；Agent 使用独立 Bearer，不套用 Cookie/Origin。
- 执行前校验管理员批准的全部 `.trellis/scripts` 树摘要；存在 lifecycle hooks 时拒绝任务写入；子进程使用最小环境和 `shell:false`。
- 分支必须非空、不以 `-` 或 `refs/` 开头、不是 `HEAD`/`FETCH_HEAD`/`ORIG_HEAD`/`MERGE_HEAD`/`@`，并通过 `git check-ref-format refs/heads/<branch>`；禁止 `check-ref-format --branch` 的 reflog 展开。
- Git 远端只接受 HTTPS、`ssh://` 或 SCP SSH；测试实例才允许 `file:`。URL 禁止密码、token、query、fragment，clone 参数前使用 `--`。
- 任务文件必须是 `.trellis/tasks` 内普通文件；`task.json` 上限 1 MiB、单个 Markdown 上限 2 MiB，符号链接/重解析点逃逸和超限内容不进入看板缓存。
- 密码、会话令牌、Agent 凭证、Git 凭证不得进入 SQLite 明文、日志、审计正文和前端。

## Agent

- Windows Agent 只领取 `sync_branch`/`refresh_status`，要求 `origin` 匹配项目远端身份，拒绝 sparse checkout，且不发送完整本地路径。
- Agent 报告 `localRepoKey` 和 `remoteIdentityKey` 哈希；服务端项目保存 `remote_identity_hash`。
- 同步前要求分支匹配、工作区 clean、local ahead 为 0；只执行 fetch 和 `merge --ff-only --no-overwrite-ignore FETCH_HEAD`，不 stash/reset/checkout/rebase/push。
- 命令领取使用租约；超时重投，结果幂等，连续 3 次失败停止自动投递。Agent 状态命令 30 秒、fetch/merge 各 180 秒超时。

## 兼容

- `TRELLIS_BOARD_MODE=standalone` 为默认；team 显式启用。
- 数据库 v3 -> v4，升级前备份，现有单机和扩展数据继续可用。
- Agent 首版仅 Windows；服务端单实例 Node + SQLite WAL，目标 400 账号、200 在线、100 项目、10,000 快照。
- 项目扫描缓存使用 `.trellis/tasks`、`.trellis/workspace`、`.trellis/config.yaml` 的内容键；普通代码提交不触发全量重扫。
- 每个项目的分组投影和跨项目索引在同一扫描流程中生成；索引提交失败时保留旧版，不以部分任务冒充完整结果。
