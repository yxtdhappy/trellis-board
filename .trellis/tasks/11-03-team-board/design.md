# 团队版架构设计

## 1. 总体架构

```text
公司 Git 远端（每个项目接入时约定的共享分支）
        ↑ fetch / ff-only pull
        ↓ commit / push
服务端项目工作副本（每个逻辑项目一份）
        ↓ 现有 loader / scan-worker 扫描
团队服务 SQLite + 内存看板缓存
        ↓ 登录、RBAC、审计、任务接受状态
原生 Web 看板

Windows Agent（每台开发机）
        ↓ 绑定项目与本地仓库
        ↓ fetch + ff-only pull 配置分支
本地开发仓库
```

团队任务只来自服务端项目工作副本；Agent 仅负责设备身份、本地分支同步和状态上报。

## 2. 运行模式与兼容

新增显式运行模式：

- `TRELLIS_BOARD_MODE=standalone`：默认值，保持现有本机扫描、`127.0.0.1:4317`、无登录行为。
- `TRELLIS_BOARD_MODE=team`：启用账号、RBAC、服务端 Git 项目副本、审计、Agent 和团队 API。

团队模式配置：

- `TRELLIS_TEAM_BIND_HOST`：默认 `127.0.0.1`，生产环境通过反向代理提供 HTTPS。
- `TRELLIS_TEAM_PORT`：默认 `4317`。
- `TRELLIS_TEAM_PUBLIC_URL`：用于 Origin 校验和安全 Cookie 判断的固定外部地址。
- `TRELLIS_TEAM_SESSION_TTL_MS`：默认 12 小时。
- `TRELLIS_TEAM_AGENT_STALE_MS`：默认 60 秒。
- `TRELLIS_TEAM_GIT_POLL_MS`：服务端项目定期 fetch 间隔，默认 60 秒。
- `TRELLIS_TEAM_COOKIE_SECURE`：HTTPS 部署时必须为 `true`。
- `TRELLIS_TEAM_TRUST_PROXY`：默认 `false`；仅在服务端口只允许可信反向代理访问时开启，用于读取 `X-Forwarded-For`。
- `TRELLIS_TEAM_ALLOW_LOCAL_GIT_REMOTES`：默认 `false`；仅回环测试的临时裸仓库可开启，生产必须关闭。

服务端不得把回环监听自动改为公网。standalone 只绑定回环；team 必须提供有效 `TRELLIS_TEAM_PUBLIC_URL`，非回环地址必须 HTTPS，TLS 由受控反向代理终止；`TRELLIS_TEAM_COOKIE_SECURE=false` 仅限本机测试。

## 3. 模块边界

继续使用原生 Node.js 24、原生 HTTP、`node:sqlite` 和现有 Worker，不引入 Web 框架、ORM 或运行时依赖。

| 模块 | 职责 |
| --- | --- |
| `server/team/auth.js` | 密码、登录、会话、Cookie、CSRF 边界 |
| `server/team/permissions.js` | 系统管理员与项目角色的唯一授权函数 |
| `server/team/audit.js` | 只追加审计事件 |
| `server/team/projects.js` | 团队项目、成员、同步分支和 Git 配置 |
| `server/team/git-manager.js` | 项目工作副本、拉取、串行写、提交、推送和冲突处理 |
| `server/team/assignments.js` | 待接受/已接受状态和任务事件 |
| `server/team/agents.js` | Agent 注册、凭证、心跳、命令和状态 |
| `server/team/board.js` | 按当前用户过滤项目并按权限投影看板 |
| `server/team/http.js` | 团队模式路由与统一错误映射 |
| `server/team/cli.js` | 仅本机运行的首个管理员初始化、诊断和运维命令 |
| `agent/index.js` | Windows Agent 主循环 |
| `agent/cli.js` | 配对、选择仓库、绑定、状态和本地诊断命令 |
| `agent/git-sync.js` | 白名单 Git fetch/ff-only 同步 |
| `agent/credential-store.js` | DPAPI 加密凭证和受限 ACL 文件 |

现有 `server/loader.js`、`server/scan-worker.js`、`server/execution-store.js`、`server/task-location.js` 继续作为扫描、阶段、扩展数据和路径安全的所有者。团队模块不得复制这些规则。

## 4. 数据模型

数据库从 schema v3 升级到 v4。升级前创建 v3 快照；所有新表在同一事务内创建。现有表不删除，单机模式继续使用。

### 4.1 账号与会话

```text
user_account(
  id, username_key UNIQUE, username, display_name,
  password_hash, password_params_json, system_admin,
  status, password_changed_at, created_at, updated_at
)

user_session(
  id, token_hash UNIQUE, user_id, created_at, last_seen_at,
  expires_at, revoked_at, ip, user_agent
)

login_attempt(
  id, username_key, ip, succeeded, occurred_at
)
```

- `system_admin` 只授予系统管理能力，不产生任何项目业务写权限。
- 密码使用 Node 内置 `crypto.scrypt`，每个密码独立随机盐，参数版本写入 `password_params_json`。
- 会话令牌使用至少 32 字节随机值，数据库只保存 SHA-256 哈希。
- 默认会话绝对有效期 12 小时；禁用账号、重置密码或显式撤销时立即失效。
- 登录失败按用户名和 IP 限速，默认 15 分钟最多 5 次失败。
- 默认使用 TCP 对端地址；只有显式信任反向代理时才读取 `X-Forwarded-For`，直接暴露端口时禁止开启。

### 4.2 团队项目

```text
team_project(
  repository_id PRIMARY KEY,
  workspace_key UNIQUE,
  remote_url,
  remote_identity_hash,
  sync_branch,
  trusted_task_toolchain_sha256,
  sync_status,
  last_fetch_at,
  last_push_at,
  last_error,
  created_at,
  updated_at
)

project_member(
  project_id, user_id,
  role CHECK(role IN ('lead','member','read_only')),
  trellis_dev_id,
  created_by, created_at, updated_at,
  PRIMARY KEY(project_id, user_id),
  UNIQUE(project_id, trellis_dev_id COLLATE NOCASE)
)

project_scan_cache(
  project_id PRIMARY KEY,
  schema_version, scanned_content_key, scanned_branch_sha, saved_at, board_json
)
```

- 复用 `repositories.id` 作为团队项目 ID，保证现有 `taskKey`、`executionTaskKey` 和扩展数据继续有效。
- 团队模式下 `repositories.path` 指向服务端受管工作副本 `data/projects/<workspace_key>/`；`workspace_key` 总是服务端生成的安全 UUID，不复用可能包含 Windows 保留名或特殊字符的旧 repository ID。
- `data/`、备份和项目副本只允许服务账号/管理员访问；静态目录不得映射。
- `remote_url` 仅接受 HTTPS、`ssh://` 或 SCP SSH；测试实例受 `TRELLIS_TEAM_ALLOW_LOCAL_GIT_REMOTES` 控制才接受 `file:`。拒绝前导 `-`，clone 仓库参数前加 `--`。
- `remote_url` 必须拒绝 URL 中的密码、已知 token、query 和 fragment；HTTPS 拒绝 userinfo，SSH 允许非秘密用户名但身份比较忽略它，认证交给受控凭据助手。
- `trellis_dev_id` 是用户在该项目 `task.json.assignee` 和 `.trellis/workspace` 中使用的 developer ID；负责人和成员必须映射，只读成员可以为空。
- developer ID 匹配 `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$` 且不能是 `.`/`..`；服务端用 realpath 确认 workspace 是 `.trellis/workspace` 的直接子目录。
- developer ID 在 Windows 上按大小写不敏感唯一；登录名保存规范化 `username_key`。
- `trusted_task_toolchain_sha256` 是系统管理员批准的项目 `.trellis/scripts` 树摘要：按相对 POSIX 路径排序，把每个普通文件的路径、大小和 SHA-256 以固定分隔编码后整体哈希，不排除任何可执行/可导入文件；拒绝符号链接/重解析点、`__pycache__` 和 `.pyc/.pyo`。Python 统一 `-B`，不生成缓存。
- 每次执行前重新计算摘要并与批准值比对，变化时阻止写入，等待管理员复核。
- lifecycle hooks 检测复用已批准 scripts 中的同一配置解析器，不另写可能与 `task.py` 行为不一致的正则解析。
- 调用 `task.py` 时拒绝以 `-` 开头的标题，所有可选值使用单参数 `--name=value` 形式，禁止 `--force`、`--parent` 和未列入白名单的 flag，防止位置参数被解释成 CLI 选项。
- `project_scan_cache` 保存单项目看板投影；team 模式不再复用 standalone 的单一全局 `scan_cache`，请求先授权项目再合并缓存。
- 跨项目查询另建 `team_task_index` 与标签索引；扫描提交时原子换版并递增 `queryRevision`，详细字段见核心服务设计。
- `team_project.sync_status` 固定为 `provisioning | current | stale | pending_push | needs_repair | disabled`；`provisioning` 尚未批准工具链，看板不展示任务，也不允许任何写操作。

### 4.3 Agent 与绑定

```text
agent_device(
  id, user_id, device_name, platform, agent_version, protocol_version,
  credential_hash, status, last_seen_at, last_heartbeat_json,
  created_at, revoked_at
)

agent_project_binding(
  id, agent_id, project_id, local_repo_key, local_display_name,
  branch_name, sync_status, last_synced_at, last_error,
  created_at, updated_at,
  UNIQUE(agent_id, project_id)
)

agent_command(
  id, agent_id, binding_id, command_type, payload_json,
  status, attempts, created_at, delivered_at, lease_expires_at,
  completed_at, result_json
)
```

- `local_repo_key` 是 Agent 本地路径的不可逆标识或哈希，服务端不保存完整绝对路径。
- MVP 每个 Agent 对同一项目只绑定一个本地仓库根；多克隆场景通过重新选择绑定目录处理。
- Agent 凭证只在注册响应中返回一次，服务端保存哈希；本地用 Windows DPAPI 加密保存。
- 命令类型首版只允许 `sync_branch` 和 `refresh_status`。
- 同一绑定的未领取 `sync_branch` 命令折叠为一条；Agent 离线时命令保留，凭证/绑定撤销时取消所有未完成命令。
- 命令领取必须以条件更新设置租约；租约过期后可重新投递，完全相同的完成结果重放返回成功，最多 3 次失败后进入 `failed`。
- 用户被移出项目时撤销其在该项目的 Agent 绑定并取消未完成命令；已有任务不回写 Git，只显示为“负责人无效”，待有写权限的成员重新委派；本地仓库是否仍能从 Git 读取由公司 Git 权限另行控制。

### 4.4 任务接受与审计

```text
task_assignment(
  execution_task_key PRIMARY KEY,
  assigned_user_id,
  state CHECK(state IN ('pending','accepted')),
  assigned_by, assigned_at, accepted_at,
  base_task_version, version
)

audit_event(
  id, actor_user_id, actor_agent_id, project_id,
  action, target_type, target_id, result,
  correlation_id, detail_json, occurred_at
)

git_operation(
  id, project_id, actor_user_id, operation_type,
  idempotency_key UNIQUE, request_hash, status,
  base_task_version, result_json, error_message,
  local_commit_sha, remote_commit_sha,
  created_at, updated_at
)
```

- 审计事件通过 API 只能追加，不能修改或删除。
- 幂等键重放只有在操作者、项目、操作类型和 `request_hash` 全部一致时返回原结果；参数变化或跨用户复用返回 409。
- `detail_json` 只保存结构化非敏感摘要，不保存密码、令牌、Git 凭证或完整请求体。
- 任务委派状态使用 `execution_task_key` 关联，归档后仍可追溯。
- `git_operation` 单独保存本地提交和最终远端提交 SHA，崩溃恢复不得依赖解析展示用 `result_json`。

### 4.5 个人看板状态与共享任务扩展

```text
user_board_state(
  user_id, key, value_json, updated_at,
  PRIMARY KEY(user_id, key)
)
```

- 团队模式的 WIP 上限写入 `user_board_state`，不再读写全局 `board_state`。
- `saved_view` 增加可空 `owner_user_id`；团队模式只列出、修改和删除当前账号的视图，standalone 的旧行继续兼容。
- `task_event` 增加可空 `actor_user_id`；团队撤销只选择当前账号最新未撤销的可逆事件，旧单机事件不授予跨用户撤销能力。
- `task_execution`、`task_tag`、`task_stage`、`task_dependency` 是项目共享任务扩展，团队写接口统一校验项目写角色并追加审计。
- 现有所有读取/写入扩展数据的 API 在团队模式必须经过认证、项目推导和授权；本机仓库接入、文件夹选择、直接扫描等 standalone 管理接口在团队模式返回 404/403。
- 团队模式不得读取 `data/repos.json` 中的本机默认仓库或启动文件夹选择器；项目集合只来自已启用的 `team_project`。

## 5. 服务端项目工作副本

### 5.1 接入流程

1. 系统管理员选择升级一个现有 `repositories` 行，或新建逻辑项目；现有行保留原 ID 以延续任务扩展数据，新项目由服务端生成 UUID。
2. 管理员配置 Git 远端和该项目约定的已存在同步分支，不提供全局默认分支。
3. 服务端生成 `workspace_key` 并克隆到 `data/projects/<workspace_key>`，检出同步分支。
4. 服务端验证 `.trellis`、`.trellis/scripts/task.py` 和远端一致性。
5. 现有项目切换为团队项目后仍使用原 `repositories.id`，只把 `repositories.path` 指向受管副本；不自动批量导入，由管理员逐个项目确认。

项目移除只停止服务端管理，不删除 Git 远端。默认保留本地受管副本作为恢复材料，管理员显式清理时另行审计。
项目禁用立即停止 fetch/写入、撤销全部 Agent 绑定并取消未完成命令；重新启用前必须仍有有效 `lead`，且设备需要重新绑定。

### 5.2 同步

- 定期执行 `git fetch origin <sync_branch>`，再执行 `git merge --ff-only --no-overwrite-ignore FETCH_HEAD`。
- 每个项目的 fetch、merge 和任务写操作共享同一异步互斥锁。
- 受管副本必须保持干净且位于配置分支；出现本地漂移时停止自动 merge，标记项目同步错误。
- `sync_branch` 在项目创建后不可原地修改；配置错误时停用旧项目并重新接入。原因是新任务的 `branch` 已写入该分支，原地切换会让已有任务、Agent 绑定和看板投影失去一致来源。
- 服务端禁止 `git push --force`、任意 refspec 和任意远端 URL。
- Git 子进程使用参数数组、`shell:false`、非交互环境和系统凭据助手；日志只记录脱敏后的命令类别。
- SSH 使用服务账号已配置的密钥/agent 和预先信任的主机指纹；命令禁止交互，缺失凭证时立即失败而不是等待输入。
- Git 子进程环境使用显式 allowlist，清除 `GIT_CONFIG_COUNT/KEY/VALUE`、`GIT_DIR`、`GIT_WORK_TREE`、`GIT_INDEX_FILE`、`GIT_OBJECT_DIRECTORY`、`GIT_ALTERNATE_OBJECT_DIRECTORIES`、`GIT_SSH_COMMAND`、`GIT_ASKPASS`、`GIT_SSL_NO_VERIFY` 等可劫持执行或配置的变量后再设置固定值。
- 服务端 Git 命令固定带 `-c core.hooksPath=<空目录>`、`-c core.autocrlf=false`、`-c http.sslVerify=true` 和 `-c commit.gpgsign=false`，状态检查再带 `-c core.fsmonitor=false`；环境固定 `GIT_TERMINAL_PROMPT=0`、`GCM_INTERACTIVE=Never`，禁止项目副本、hooks、换行改写、TLS 降级、外部 monitor、凭据弹窗和签名提示干扰自动写入。

### 5.3 写入流程

任务写操作采用统一事务外编排：

1. 校验用户登录、项目角色、输入和 `idempotencyKey`。
2. 写入 `git_operation(status=prepared)`；同一幂等键重放返回同一操作。
3. 获取项目锁，fetch 并 ff-only 更新同步分支。
4. 对现有任务重新扫描，校验 `executionTaskKey`、归档状态、身份冲突和 `expectedTaskVersion`。
5. 校验 `.trellis/scripts` 工具链摘要、拒绝任务 lifecycle hooks，并校验负责人 developer ID 与 workspace 目录。
6. 执行白名单操作：经批准哈希的 `task.py create` 或原子更新 `task.json.assignee`。
7. 只暂存本次任务目录或 `task.json`，使用明确的服务账号身份提交；提交主题只含操作类型和 operation ID，不拼接标题/描述，并在固定 trailer 中写入 `Trellis-Operation: <git_operation.id>`。
8. 推送到配置分支；非快进时 fetch 并 rebase 任务提交，最多重试 3 次。
9. 推送成功后写入 Git 操作结果、审计和任务接受状态。
10. 触发现有看板刷新队列。

失败处理：

- 校验或版本冲突：HTTP 409，未执行文件写。
- Git 同步或推送失败：HTTP 502/503，返回关联操作 ID；任务不进入待接受状态。
- 文件已写但尚未 commit 时，只清理该操作明确创建/修改且经 `git status` 确认属于本次操作的任务路径；清理失败则标记 `needs_repair` 并阻塞后续写入。
- 若服务端已产生本地提交但未推送，记录 `pending_push`，后台重试；用户界面显示“尚未发布到 Git”。
- 若数据库状态落后于 Git，可在远端配置分支按操作 trailer 找回已推送提交并补齐状态，避免重复任务。
- 自动 rebase 仍无法安全解决时停止处理，项目标记 `needs_repair`，操作保留为 `pending_push`，不强推、不删除远端提交；管理员修复项目副本后，后台恢复或同一操作的重试入口继续处理。
- `git_operation.status` 固定为 `prepared | committed | pending_push | pushed | applied | failed`；记录目标任务、本地提交 SHA 和最终远端 SHA。`needs_repair` 是项目级 `sync_status`，不是操作状态。
- `failed` 只用于尚未改变工作副本的确定性失败；任何已写文件、已提交或可能已推送的操作不得置为 `failed`，必须保留可恢复状态直到远端和数据库状态对清。
- 进程在 push 成功后、SQLite 收尾前崩溃时，恢复逻辑先确认远端分支是否已包含该提交，再补齐 assignment、审计和幂等结果，不能再次创建任务。

`expectedTaskVersion` 定义为任务 `task.json` 原始字节的 SHA-256。列表接口返回该值，写接口必须携带。版本不匹配时整体拒绝。

`.trellis/scripts` 是不可信仓库内容进入服务进程的代码执行边界。批准摘要必须覆盖 `task.py` 及其导入的 `common` 等全部脚本；`.trellis/config.yaml` 中任何 `hooks` 配置都会导致团队写入被拒绝。子进程只继承 `PATH`、临时目录和项目工作目录等最小环境，不继承数据库路径、会话密钥、Agent 凭证或 Git 凭证。

扫描和任务读取同样把 Git 内容视为不可信：仓库根下的 `.trellis`、`.trellis/tasks`、`.trellis/workspace` 和 `.trellis/scripts` 必须是仓库内的真实目录；任务目录及已知 Markdown/JSON/JSONL 报告必须是普通文件，realpath 必须留在 `.trellis/tasks`，拒绝符号链接/重解析点逃逸；`task.json` 上限 1 MiB、其他单个文本工件上限 2 MiB，超限任务跳过正文读取并在看板标记扫描错误。

`task.py create` 的 `TRELLIS_DEVELOPER` 设为操作者的项目 `trellis_dev_id`，`--assignee` 设为目标负责人，使 `task.json.creator` 表示真实发起人；Git commit author 使用独立的低权限服务身份，二者由审计关联。

## 6. 任务创建、委派与接受

- 创建任务复用 `server/actions.js` 的输入校验和 `task.py` 参数约束；团队模式只改变执行位置和 Git 发布步骤。
- 新任务的 Trellis 元数据固定为 `branch=<项目 sync_branch>`、`base_branch=null`：任务直接工作在共享分支，没有独立 PR 目标；项目实际分支由 `team_project` 管理，避免现有 `task.py archive` 把 branch/base_branch 相同视为自引用。
- 创建成功后初始化 `task_assignment.state=pending`，负责人为任务 `assignee`。
- 修改负责人必须同时更新 Git 中的 `task.json.assignee`，成功后把接受状态重置为 `pending`。
- “有效负责人”必须同时满足：项目启用、用户启用、具有项目 `lead/member` 角色、已映射 `trellis_dev_id`，且对应 `.trellis/workspace/<developer-id>` 是仓库内普通目录；任一条件失效即显示“负责人无效”。
- `POST /api/tasks/accept` 只允许当前负责人对未归档任务调用，携带 `assignmentVersion` 并以条件更新防止重复覆盖；首次创建为 1，每次重新委派递增。
- 接受只写团队 SQLite、`task_event` 和审计，不制造额外 Git 提交。
- 同一负责人重复接受为幂等成功；其他用户不能替负责人接受。
- 看板和待接受列表必须返回 `assignmentVersion`，前端不得用 `taskVersion` 代替。
- 接受后为目标用户在该项目下所有已批准 Agent 绑定创建 `sync_branch` 命令，离线设备上线后领取；单台设备失败或不兼容不回滚接受结果，各设备状态独立展示。
- 每次 fetch/扫描后按 `executionTaskKey` 对账 `task.json.assignee` 与 `task_assignment`；检测到绕过 Board 的 Git 改动时重置为 pending，并记录 Git 提交 SHA、作者和时间。
- 外部 Git 写入的 assignee 若没有项目映射或对应账号没有项目写角色，任务标记“负责人无效”且不生成待接受记录；成员必须先在项目中配置 developer ID 和写角色。

## 7. 团队看板数据流

```text
服务端 Git 工作副本
  -> loader / scan-worker
  -> 项目分组投影 + 跨项目任务索引
  -> 按当前用户项目角色过滤
  -> 分页看板响应
```

- 团队模式复用现有扫描 Worker，但使用 `project_scan_cache` 保存单项目投影；`SCAN_SCHEMA_VERSION` 因新增任务版本和团队状态而递增。
- 每 60 秒 fetch 后按 `.trellis/tasks`、`workspace`、`config.yaml` 的内容计算 `content_key`；仅代码提交前进时复用投影，内容变化或本服务写入成功才重扫。
- team 模式不启动 standalone 的本机 `.trellis` 文件 watcher；刷新由 Git fetch、服务端任务写和管理员显式操作驱动。
- 看板响应只包含用户有权访问的项目；跨项目查询使用 `team_task_index` 分页，单项目分组页读取 `project_scan_cache`。
- 项目同步状态和 Agent 状态按项目批量查询，不能在每个任务卡片内触发独立请求。
- 项目同步错误时仍可返回上次快照用于诊断，但必须携带 `stale=true`、`updatedAt` 和 `syncError`；实时统计、接受入口和写操作不可使用旧数据。
- 现有列表/详情投影边界保持不变：`/api/board` 不返回产物正文、完整事件或依赖图。
- 所有 `actor`、`created_by` 和事件来源字段由服务端从会话/Agent 派生，忽略浏览器传入的身份值。

## 8. 权限模型

授权只有一个所有者：`server/team/permissions.js`。

| 操作 | 系统管理员 | 项目负责人 | 项目成员 | 只读成员 |
| --- | --- | --- | --- | --- |
| 用户、设备、项目、系统配置管理 | 是 | 否 | 否 | 否 |
| 管理本项目成员和 Agent 绑定 | 可恢复项目负责人和设备，但不能移除最后一名负责人 | 是 | 否 | 否 |
| 创建任务、重新委派和修改 assignee | 仅获得项目角色时 | 是 | 是 | 否 |
| 查看项目 | 仅作为项目成员 | 是 | 是 | 是 |
| 接受分配给自己的任务 | 仅被分配且拥有项目写角色 | 是 | 是 | 否 |
| 查看团队审计 | 全局 | 所属项目 | 否 | 否 |

禁止在路由、前端或 SQL 中复制角色判断。路由先认证，再调用统一授权函数，再进入业务服务。

## 9. 认证与会话安全

- 登录接口使用 `POST /api/auth/login`，成功后设置 `HttpOnly; SameSite=Strict; Path=/` Cookie；HTTPS 下必须带 `Secure`。
- 浏览器会话的修改请求校验 `Origin` 必须等于 `TRELLIS_TEAM_PUBLIC_URL`，并只接受 JSON Content-Type；Agent 请求只用 Bearer 凭证，不要求浏览器 Origin。
- 登录失败使用统一错误文案，不区分账号不存在、密码错误或账号禁用。
- 密码重置由管理员执行，只生成一次性临时密码；首次登录后必须修改，改密成功立即撤销该账号其他会话。
- 会话表只保存令牌哈希；每次请求通过哈希查找未撤销、未过期的会话。
- Agent 使用独立 Bearer 凭证，不能复用用户 Cookie；用户会话不能调用 Agent API。

## 10. Windows Agent

### 10.1 注册

1. 用户在 Web 创建一次性设备配对码，有效期 10 分钟。
2. Agent 提交配对码、设备名、版本和协议版本。
3. 服务端返回一次 Agent 凭证；Agent 使用 DPAPI 加密后保存。
4. 服务端只保存凭证哈希和绑定用户。

### 10.2 项目绑定

- 用户在本机选择一个包含 `.trellis` 的本地仓库。
- Agent 将 Git 远端归一化为主机、端口和仓库路径后再比对项目配置，不直接比较 SSH/HTTPS 字符串；随后报告当前分支、HEAD 和工作区是否干净。
- 本地绝对路径只存在 Agent 配置中；服务端只保存哈希和展示名。
- 项目负责人确认绑定后 Agent 才能接收同步命令；首次批准时立即加入一条 `sync_branch`，避免错过批准前已接受的任务。

### 10.3 同步

- 负责人接受任务后，服务端创建 `sync_branch` 命令。
- Agent 每 15 秒心跳，并以最长 25 秒的长轮询接收命令。
- 同步步骤固定为：

```text
验证绑定和工作区
确认当前分支 == configured-branch
确认工作区干净
git fetch origin <configured-branch>
git rev-list --left-right --count HEAD...FETCH_HEAD
要求本地领先数 == 0
git merge --ff-only --no-overwrite-ignore FETCH_HEAD
上报新 HEAD、clean 和同步时间
```

- 当前分支不匹配、工作区不干净、本地存在未推送提交、远端不可达或无法 fast-forward 时，Agent 返回可展示原因。
- Agent 不自动 checkout、stash、reset、rebase 或创建 worktree。
- Agent 版本低于服务端最小兼容版本时只上报状态，不接受命令。

### 10.4 Windows 运行

- 首版以当前登录用户的后台进程运行，通过用户级计划任务在登录后启动并异常重启。
- 用户未登录时显示离线；这与 Windows 本地仓库权限边界一致。
- 安装包和自启动脚本不包含明文凭证；卸载不删除用户仓库。

## 11. Web 界面

复用原生 HTML/CSS/ESM，不引入前端框架和构建链。

新增页面状态：

- 登录页与会话恢复。
- 默认跨项目混合分页列表、项目切换后的单项目分组看板。
- 项目成员、Agent 状态和 Git 同步状态面板。
- 系统管理员用户、项目、设备管理页。
- “待我接受”队列和任务接受按钮。
- 创建/委派任务对话框，展示目标共享分支和发布结果。
- Git 推送失败、项目过期和 Agent 本地阻塞的可操作错误提示。

所有新增服务端文本继续经过 `safe()`；Markdown 只经 `renderMarkdown()`。按钮状态必须由服务端返回的权限和同步状态驱动，不能只在前端隐藏。

## 12. API 契约

团队模式新增接口：

| 方法与路径 | 说明 |
| --- | --- |
| `POST /api/auth/login` | 用户名密码登录 |
| `POST /api/auth/logout` | 撤销当前会话 |
| `POST /api/auth/password` | 首次登录修改临时密码或用户主动改密 |
| `GET /api/auth/me` | 当前用户、系统角色和项目角色 |
| `GET /api/runtime` | 前端启动所需的模式、权限和团队开关 |
| `GET /api/team/projects` | 当前用户可见项目摘要、任务计数和 `boardVersion` |
| `GET /api/team/status` | 项目 Git、Agent、同步状态、`boardVersion`、`queryRevision` 和 `queryDay` |
| `GET /api/tasks/query?...` | 跨授权项目服务端筛选、分页和 `ETag`；返回扁平任务行 |
| `GET /api/board?projectId=<id>&limit=<n>&cursor=<c>` | 团队模式单项目分页任务；支持 `ETag`，禁止无项目全量任务 |
| `GET /api/assignments` | 待我接受/我负责的任务 |
| `POST /api/tasks/accept` | 接受任务 |
| `POST /api/projects/:id/refresh` | 负责人/管理员请求项目重新 fetch 和扫描 |
| `POST /api/git-operations/:id/retry` | 项目写成员重试仍为 `pending_push` 的操作 |
| `GET /api/git-operations/:id` | 查看本项目 Git 操作的脱敏状态与结果 |
| `/api/admin/users` | 系统管理员用户管理 |
| `/api/admin/projects` | 系统管理员项目管理 |
| `POST /api/admin/projects/:id/approve` | 系统管理员核对首次克隆的 scripts 摘要并启用项目 |
| `POST /api/admin/projects/:id/repair` | 系统管理员在人工修复后重新校验工作副本并恢复 Git 操作 |
| `/api/admin/audit` | 系统管理员全局审计 |
| `/api/projects/:id/audit` | 项目负责人项目审计 |
| `/api/projects/:id/members` | 项目成员管理 |
| `/api/projects/:id/agents` | 项目负责人 Agent 绑定管理 |
| `/api/agent/enroll` | 设备配对 |
| `/api/agent/heartbeat` | 心跳和本地同步状态 |
| `/api/agent/commands` | 长轮询白名单命令 |
| `/api/agent/commands/:id/result` | 命令结果 |

任务创建与委派仍用 `POST /api/tasks`、`/api/tasks/assign`，团队模式额外校验登录、角色、任务版本和 Git 发布结果；错误体保留中文 `error`，并加稳定 `code`。

## 13. 数据库迁移与回滚

- `DATABASE_SCHEMA_VERSION` 从 3 升至 4。
- v3 -> v4 先创建不覆盖既有文件的 `data/board.sqlite.v3-backup-<timestamp>`，再在同一事务中创建团队表、索引和迁移标记。
- 对现有表只做加法迁移：创建 `user_board_state`，为 `saved_view` 增加 `owner_user_id`、为 `task_event` 增加 `actor_user_id`；不删除或重写现有行，standalone 继续使用旧语义。
- 团队项目沿用现有 repository ID；首次从单机模式切换时生成受管副本和 `team_project` 行。
- 回滚时停止服务，归档当前数据库与 `data/projects/`，切换旧代码并使用 v3 快照。不要把团队审计回写到旧 JSON，也不要删除 Git 远端任务。
- 迁移测试覆盖新库、v3 -> v4、备份、失败回滚、单机模式继续启动和团队模式首次初始化。

## 14. 容量与性能

目标：400 账号、200 Web 在线、100 项目、10,000 任务；按每用户 2 台设备模拟 400 Agent 连接。详细依据见 `research/capacity-and-board-scaling.md`。

- 单进程 SQLite WAL；项目写串行，100 个项目按 60 秒间隔、抖动和最多 4 并发 fetch。
- Web 约 3 秒轮询轻量状态；`/api/tasks/query` 返回跨项目分页扁平行，`/api/board` 返回单项目分组页，二者均使用 ETag。
- Worker 只解析变化项目；状态批量查询，stale 缓存不冒充实时数据。
- release 必须按上述连接数压测；单实例失败时停止发布并重新设计。

## 15. 测试与验收

自动测试至少覆盖：

- 密码哈希、错误登录、会话撤销、CSRF Origin 和权限矩阵。
- schema v4 迁移和回滚快照。
- 项目成员、角色和项目数据隔离。
- Git 写操作成功、推送失败、非快进重试、版本冲突、路径越界和项目锁串行。
- 创建、委派、待接受、接受、重新委派和审计。
- 跨项目查询、单项目分组、权限收窄、游标换版和旧缓存 stale。
- Agent 注册、凭证哈希、心跳、版本不兼容、命令白名单、分支不匹配和 dirty 工作区。

真实端到端至少执行：

1. 两个项目成员分别登录。
2. A 创建任务并委派给 B，服务端 commit/push 到该项目约定的共享分支。
3. B 看到待接受任务并接受。
4. B 的 Agent 在干净、分支匹配的本地仓库执行 ff-only 同步。
5. 本地 `.trellis/tasks/<task>/task.json` 可读且 assignee 为 B。
6. 制造本地未提交修改，确认 Agent 阻止同步且不丢文件。
7. 制造远端任务版本变化，确认并发写返回 409 且远端未被覆盖。

## 16. 实施拆分

| 子任务 | 交付 | 依赖 |
| --- | --- | --- |
| `team-core-service` | schema v4、认证 RBAC、审计、受管 Git 副本、任务写、接受状态、团队看板 API | 无，先固定本设计中的协议与数据契约 |
| `windows-sync-agent` | Windows Agent、DPAPI 凭证、项目绑定、心跳、ff-only 同步 | core 的 Agent API 与协议版本 |
| `team-web-console` | 登录、项目角色管理、Agent 状态、接受队列、团队看板与错误状态 | core API 稳定后并行开发 |
| `team-release-integration` | 部署、安装包、迁移、真实 E2E、容量/安全验收、文档和回滚 | 前三个子任务完成 |

父任务负责跨子任务契约、验收标准和最终集成审查；父子树不表达执行依赖，实际顺序写入每个子任务文档。

## 17. 风险与延后

- Git 推送是任务发布关键路径；远端、凭据或分支保护故障会阻止任务发布，由操作记录、重试和明确错误处理，不做静默成功。
- 共享分支每次任务写都生成提交，目标规模可接受；流量显著增长时再考虑批量提交。
- 首版 Agent 只在用户登录后运行，注销后显示离线，不支持服务账户访问个人工作区。
- 自动冲突解决、MR、审批、拒绝、通知和邮件不在 MVP。
- 工具链摘要门禁使 `.trellis/scripts` 变更成为管理员确认事件，这是阻止普通仓库写入者借服务账号执行代码的必要成本。
- 团队版前的旧任务可能仍带 `base_branch=<共享分支>`；只规范化新任务，旧任务需人工确认分支或归档处理。
