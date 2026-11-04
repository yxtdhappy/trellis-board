# 核心服务技术设计

## 责任边界

本子任务拥有团队模式的服务端状态、认证授权、数据库迁移、受管 Git 写入、审计、团队看板 API 和 Agent 服务端协议。它不实现浏览器交互和 Windows Agent 进程。

## 与现有服务的集成

- `server/index.js` 在启动时读取 `TRELLIS_BOARD_MODE`；standalone 走现有路由，team 在现有静态资源和看板路由前增加认证、团队路由和统一错误映射。
- `server/database.js` 负责 v4 迁移和团队查询；所有多行写使用现有 `withTransaction()`。
- `server/actions.js` 保留 standalone 本机行为；把输入校验和 `task.py` 参数构造抽成可复用的纯函数，团队模式在受管工作副本中调用同一契约。
- `server/loader.js`、`server/scan-worker.js` 和 `server/task-location.js` 继续拥有扫描、任务身份和路径校验；团队层只选择扫描根和过滤结果。
- `server/config.js` 新增团队环境变量；team 模式不调用本机文件夹选择器。
- standalone 绑定非回环地址时拒绝启动；team 必须配置合法 public URL，非回环生产地址只接受 HTTPS 和安全 Cookie。
- team 模式忽略 `data/repos.json` 和默认 `D:/wit/...` 配置，`getRepositories()` 只返回已启用的 `team_project` 受管副本。
- team 模式不启动现有本机文件 watcher；由定时 fetch、成功任务写和管理员手动刷新触发项目重扫。

## 模块

| 文件 | 职责 |
| --- | --- |
| `server/team/auth.js` | scrypt、登录、Cookie、会话和登录限速 |
| `server/team/permissions.js` | 系统能力与项目 `lead/member/read_only` 的唯一授权入口 |
| `server/team/audit.js` | 只追加审计事件 |
| `server/team/projects.js` | 项目、成员、developer ID 和脚本工具链摘要 |
| `server/team/git-manager.js` | 工作副本、锁、fetch、commit、push、恢复 |
| `server/team/task-writes.js` | 创建、委派、幂等、版本校验和发布状态 |
| `server/team/assignments.js` | 待接受/已接受状态 |
| `server/team/agents.js` | 配对、凭证、心跳和命令 |
| `server/team/task-index.js` | 扫描结果规范化、原子换版和跨项目查询 |
| `server/team/board.js` | 单项目授权、分组投影和分页响应 |
| `server/team/http.js` | 路由、JSON/Origin 校验和错误码 |

## 数据与迁移

- 按父设计创建 v4 表，并为 `project_member(user_id)`、`agent_device(user_id)`、`task_assignment(assigned_user_id,state)`、`audit_event(project_id,occurred_at)`、`agent_command(agent_id,status,created_at)` 建索引。
- 迁移前使用 SQLite 一致备份（`VACUUM INTO` 或等价 backup API）生成不覆盖既有文件的 `data/board.sqlite.v3-backup-<timestamp>`，并对备份执行完整性检查；不能直接复制可能仍有 WAL 内容的主文件。迁移事务失败时不替换当前文件。
- `team_project` 与现有 `repositories` 通过 ID 一一对应；只有显式启用团队模式的项目才创建团队行，并使用 `project_scan_cache(project_id,schema_version,scanned_content_key,scanned_branch_sha,saved_at,board_json)` 保存项目投影。
- 跨项目查询使用规范化索引：`team_task_index(project_id,task_key,execution_task_key,relative_dir,title,search_text,archived,priority,derived_stage,assignee_dev_id,assignee_user_id,due_date,last_activity_at,is_blocked,is_unblocked_ready,attention_flags_json,group_key,group_role,task_version,board_version,updated_at,PRIMARY KEY(project_id,task_key))` 与 `team_task_index_tag(project_id,task_key,tag_key,PRIMARY KEY(project_id,task_key,tag_key))`。
- `team_task_index` 为 `(assignee_user_id,archived)`、`(derived_stage,archived,last_activity_at)`、`(priority,archived,last_activity_at)`、`(due_date,archived,last_activity_at)` 和 `(last_activity_at,task_key)` 建索引；标签表为 `(tag_key,project_id,task_key)` 建索引。10,000 行是上限基线，不为任意组合预建索引。
- 项目扫描成功后在事务中先删除该项目旧索引，再批量插入新索引和标签；索引或用户项目可见性变化才递增 `app_meta.queryRevision`。扫描或索引写入失败时回滚并继续使用上一版，项目禁用后立即从授权范围排除。
- 人工阶段、计划字段/标签、依赖及其撤销等不改变 Git 文件的旧扩展写，必须在同一数据库事务内同步刷新受影响项目的索引；跨项目依赖同时刷新两端项目。任一索引刷新失败则整个写操作回滚，成功后只递增一次 `queryRevision`。
- 项目成员角色或 developer ID 变化会改变负责人映射，必须原子重建该项目索引并递增 `queryRevision`；移除成员权限则先收窄可见范围再返回错误或空页。
- `team_project.remote_identity_hash` 在接入时按归一化远端身份计算；Agent 绑定只上报同类哈希，服务端比较哈希，不保存开发者本地绝对路径。
- 从零新建团队项目时使用服务端生成的 UUID 作为 `repositories.id`；升级现有项目时保留原 ID 以延续任务扩展数据。两种路径都另生成安全 UUID `workspace_key`，受管目录固定为 `data/projects/<workspace_key>`；项目只在管理员显式批准后切换 `repositories.path`，不自动批量导入。
- `project_member.trellis_dev_id` 在 `lead/member` 角色下必填，并与项目内其他成员唯一。
- 修改或移除 developer ID 不回写已有任务；旧 `assignee` 在下次扫描时按“负责人无效”处理，等待重新委派。
- `git_operation.idempotency_key` 唯一；服务重启后扫描 `pending_push` 并按原锁顺序恢复，不能重复创建任务。
- 项目存在 `pending_push` 时，新写请求先在同一项目锁内恢复该操作；仍无法推送则拒绝新写并返回 503，避免叠加本地提交。
- 每次提交追加 `Trellis-Operation: <git_operation.id>` trailer；若数据库状态落后于 Git，按该 trailer 在远端分支对账并补齐 `pushed/applied`。
- 新增 `user_board_state(user_id,key,value_json,updated_at)`；`saved_view` 增加 `owner_user_id`，`task_event` 增加 `actor_user_id`。只做加法迁移，旧单机行继续兼容。

## 认证与授权

- 启动时解析 `TRELLIS_TEAM_PUBLIC_URL` 并要求无 userinfo、query、hash 和非根路径；仅回环测试允许 `http`，其他地址必须 `https`。
- team 请求校验 `Host` 与 `TRELLIS_TEAM_PUBLIC_URL` 的主机和端口一致，反向代理必须保留外部 Host；不匹配直接拒绝，避免 Host/DNS rebinding 绕过同源边界。
- 登录名限制为 3-64 位 ASCII 字母、数字、点、下划线、单中划线并规范化为小写；显示名单独保存，不影响登录身份。
- 密码最少 12 个字符、UTF-8 最多 1024 字节，使用 `crypto.scrypt`（N=32768、r=8、p=1、`maxmem=64 MiB`）和每账号独立随机盐；比较使用 `timingSafeEqual`，全进程最多并发 4 次派生。
- 不存在或禁用账号仍执行一次固定成本 scrypt，避免用响应时间枚举用户名；成功登录清除该用户名失败计数。
- 会话令牌为 32 字节以上随机值，数据库只存 SHA-256；Cookie 为 `HttpOnly; SameSite=Strict; Path=/`，HTTPS 下加 `Secure`。
- 登录和改密后签发新会话令牌并撤销旧令牌；不从 URL、查询参数或请求体读取会话令牌。
- 认证请求读取会话但不刷新绝对过期时间；`last_seen_at` 最多每 5 分钟更新一次，避免 200 个在线用户轮询造成无意义的 SQLite 写放大。
- 定期删除已过期或已撤销超过 24 小时的 `user_session`；审计事件保留，不依赖会话行作为历史事实。
- 管理员重置密码时用至少 18 字节随机值生成一次性临时密码并设置 `must_change_password`；首次登录只允许访问改密、会话和退出接口，改密成功撤销该账号其他会话。
- team 模式没有公开首次注册；`server/team/cli.js` 在服务器本机以隐藏输入创建首个 `system_admin`，复用同一密码哈希模块，并在无有效管理员时拒绝普通启动提示先初始化。
- 禁用用户或撤销 `system_admin` 时必须保留至少一名有效系统管理员；任何用户禁用、项目成员移除、角色降级或 developer ID 变更也不得让已启用项目失去最后一名有效 `lead`。账号不做硬删除，这些检查与写入在同一事务内完成，避免并发绕过。
- 所有浏览器状态变更请求（包括登录、退出和改密）强制 JSON Content-Type，并校验 `Origin === TRELLIS_TEAM_PUBLIC_URL`；Agent API 改用 Bearer 认证，不套用 Cookie/Origin 规则。
- JSON 请求体默认限制为 64 KiB，超限返回 413；MVP 不接受文件上传。
- 登录限速默认按用户名和 TCP 对端地址统计；只有 `TRELLIS_TEAM_TRUST_PROXY=true` 且可信代理独占上游时才读取 `X-Forwarded-For` 首个合法地址。
- `login_attempt` 定期删除 24 小时前记录，避免未知用户名尝试无限增长。
- 所有团队页面响应设置 CSP：`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`，同时设置 `X-Content-Type-Options: nosniff` 和 `Referrer-Policy: same-origin`。`style-src` 的 `unsafe-inline` 是兼容现有动态宽度和内联表格对齐的例外；脚本仍禁止内联。
- 已认证页面和团队 API 返回 `Cache-Control: no-store`，避免浏览器或代理缓存任务数据。
- 静态文件路径改为基于 `path.relative()` 的包含校验，不接受绝对路径、`..` 或目录外 realpath；仅服务白名单扩展名，现有前缀 `startsWith` 判断不能作为团队模式安全边界。
- `permissions.js` 暴露 `canManageSystem()` 与 `authorizeProject(actor, projectId, capability)`；路由、SQL 和前端不得复制角色判断。
- 系统管理员能力与项目业务写权限分开计算。
- 系统管理员可执行项目成员恢复，但不能移除最后一名有效项目负责人。
- 审计查询使用同一权限入口：系统管理员可查全局，项目负责人可查本项目，普通成员只能读取任务事件。
- 团队模式禁用全局 `/api/board/refresh` 和 `/api/repositories*` 本机管理接口；项目刷新走授权的 `/api/projects/:id/refresh`。
- 进程收到停止信号时停止接收新写请求、结束 Agent 长轮询、等待当前项目操作结束，再关闭 Worker 和 SQLite；未完成 Git 操作保留到下次恢复。
- 启动顺序固定为配置校验、schema 迁移、首个管理员检查、Git 操作恢复、Worker 初始化、开始监听；恢复失败的项目以 `needs_repair` 启动但禁止写入。

## 受管 Git 工作副本

- 服务端以 `data/projects/<workspace_key>` 作为项目工作副本；首次接入由管理员显式初始化，不在扫描阶段自动克隆。
- 项目采用两阶段接入：创建时克隆到最终目录、校验仓库/分支/`.trellis` 并计算 scripts 摘要，状态为 `provisioning`；管理员确认返回的摘要后，服务端才执行已批准 scripts 中的配置解析与 hooks 预检，通过后再提交初始 `lead` 并转为 `current`。未批准项目不开放成员、看板或写入口，批准前也不执行仓库内脚本。
- 已启用项目 fetch 后发现 scripts 摘要变化时转为 `stale` 并禁止任务写；同一 approve 接口在管理员核对新摘要、hooks 预检通过后更新批准值并恢复 `current`。
- approve 请求携带管理员看到的摘要，服务端必须重新计算并逐字相等后才进入 hooks 预检；不能信任客户端直接提交的批准值。
- 每个项目一个进程内 Promise 链锁；单实例部署下保证 fetch、merge、任务写、commit 和 push 串行。
- `sync_branch` 创建后只读；项目配置更新不得修改远端或分支。需要更换时停用旧项目并重新接入，避免已有任务的 branch 元数据与项目不一致。
- 项目禁用时停止定时 fetch 和写入口，撤销全部绑定并取消未完成命令；不删除远端和受管副本。
- 重新启用已禁用项目前必须验证工作副本、批准工具链和至少一名有效 `lead`；原 Agent 绑定不会恢复。
- `needs_repair` 不能由普通刷新直接清除；系统管理员执行项目 repair，服务端重新校验工作区、远端分支、operation trailer 和待恢复操作，安全时转回 `pending_push` 并继续恢复，否则保持阻塞并记录审计。
- Git 子进程使用参数数组、`shell:false`、`GIT_TERMINAL_PROMPT=0`、`GCM_INTERACTIVE=Never` 和受控环境；命令输出进入脱敏诊断，不记录凭证。
- 所有子进程有硬超时并终止其进程树：本地 Git 检查 30 秒、`task.py` 120 秒、fetch/push 180 秒；超时视为该 Git 操作失败，不能永久占住项目锁。
- `sync_branch` 必须非空、不以 `-` 或 `refs/` 开头、不是 `HEAD`/`FETCH_HEAD`/`ORIG_HEAD`/`MERGE_HEAD`/`@`，并通过 `git check-ref-format refs/heads/<branch>`；不得使用会展开 `@{-n}` 的 `check-ref-format --branch`。所有可能把用户路径当作参数的 Git 命令在路径前使用 `--`，不拼接 refspec。
- 所有 Git 命令固定用 `-c core.hooksPath=<空目录>`、`-c core.autocrlf=false` 和 `-c http.sslVerify=true`，状态检查再设 `-c core.fsmonitor=false`，提交时设 `-c commit.gpgsign=false`；配置只来自固定参数，不读取项目提供的自定义命令。
- SSH 依赖服务账号已配置的密钥/agent，以非交互模式运行；主机指纹必须预先信任，认证缺失立即失败。
- SSH 子进程固定使用 OpenSSH 的 `-o BatchMode=yes -o StrictHostKeyChecking=yes`，不读取项目自定义 `core.sshCommand`，也不接受首次连接时交互确认主机指纹。
- Git 子进程从显式 allowlist 构造环境，清除 `GIT_CONFIG_*`、`GIT_DIR`、`GIT_WORK_TREE`、`GIT_INDEX_FILE`、`GIT_OBJECT_DIRECTORY`、`GIT_ALTERNATE_OBJECT_DIRECTORIES`、`GIT_SSH_COMMAND`、`GIT_ASKPASS`、`GIT_SSL_NO_VERIFY` 等继承变量，再写入固定 `GIT_SSH_COMMAND` 和非交互凭据设置。
- 生产远端只接受 SSH/HTTPS；`file:` 或本地目录仅在 `TRELLIS_TEAM_ALLOW_LOCAL_GIT_REMOTES=true` 且公开 URL 为回环地址的隔离测试实例中允许，启动和项目接入各校验一次。
- fetch 后只允许 `merge --ff-only --no-overwrite-ignore FETCH_HEAD`；本地 drift、ignored 文件将被覆盖或 merge 失败时立即阻塞项目写入并标记 stale。
- 写前要求工作区干净；写后若在 commit 前失败，只按操作记录的精确路径清理本次未提交改动，无法证明归属时标记 `needs_repair` 并停止后续写。
- `task.py create` 返回后核对 `git status --porcelain` 只包含本次新任务目录；出现任何额外路径时不得猜测归属，项目转 `needs_repair` 并保留现场。
- 执行 `task.py` 前比对管理员批准的全部 `.trellis/scripts` 树摘要，并解析 `.trellis/config.yaml`；任何 lifecycle `hooks` 都拒绝执行。脚本子进程不继承服务端敏感环境，使用 `python -B` 禁止生成缓存。
- 工具链摘要覆盖 scripts 树内所有普通文件，按相对路径、文件大小和内容 SHA-256 排序计算；发现符号链接/重解析点、`__pycache__` 或 `.pyc/.pyo` 时直接拒绝。Python 统一使用 `-B`，确保执行源码且不生成缓存。
- 项目扫描读取任务目录和已知文本文件前检查 realpath、重解析点和文件大小；`.trellis`、`tasks`、`workspace`、`scripts` 根也必须是仓库内真实目录。`task.json` 上限 1 MiB、其他单个文本工件上限 2 MiB，任何逃出 `.trellis/tasks` 或超限的任务内容都不进入看板缓存。
- hooks 预检通过固定 `python -I -B -c` 命令和绝对 scripts 路径调用同一配置解析器，读取所有 lifecycle 事件，不使用 `PYTHONPATH`；解析方式必须与 `task.py` 实际读取一致。
- commit 使用固定服务身份和结构化提交信息，主题固定为 `trellis(team): <operation_type> <operation_id>`，不拼接用户标题/描述；只暂存本次任务目录或指定 `task.json`，最后一行固定 `Trellis-Operation: <operation_id>` trailer。
- push 非快进时仅允许基于刚 fetch 的分支 rebase 本次提交，最多 3 次；不得 force push。

## 任务写协议

### 创建

输入包含 `repositoryId`、标题、描述、优先级、负责人和 `idempotencyKey`。服务端把它规范化为 `request_hash`，并校验负责人账号已启用且具有项目写角色、developer ID、workspace、slug 唯一性、脚本树摘要和 hooks 禁用状态，设置 `TRELLIS_DEVELOPER=操作者的 trellis_dev_id`。调用 `task.py create --no-start` 时用 `--base-branch=<sync_branch>` 阻止其探测其他默认分支；提交前必须把新任务原子规范化为 `branch=<sync_branch>`、`base_branch=null`，因此最终任务文件不保留 PR base。push 成功后才写入 pending assignment 并返回任务。
- developer ID 必须匹配 `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`；realpath 后必须仍是 `.trellis/workspace` 的直接子目录，拒绝 `.`、`..`、嵌套路径和链接逃逸。
- developer ID 在项目内按大小写不敏感唯一，避免 Windows workspace 目录冲突；用户名登录同样按规范化 key 不区分大小写。
- `task.py` 子进程环境只保留 `PATH`、`SystemRoot`、`TEMP`、`TMP`、`USERPROFILE`、`LOCALAPPDATA`、`PYTHONUTF8=1`、`TRELLIS_DEVELOPER` 等运行必需项，不继承会话、Agent、Git 或服务端密钥。
- 标题不能以 `-` 开头；`--description`、`--assignee`、`--priority`、`--slug`、`--base-branch`、`--package` 均以单参数 `--name=value` 传递，固定禁用 `--force`、`--parent` 和未知 flag。

### 委派

输入包含 `executionTaskKey`、`assignee`、`expectedTaskVersion` 和 `idempotencyKey`。服务端重新解析任务位置，拒绝归档、缺失、越界、身份冲突和版本不匹配，原子更新 `task.json.assignee`，commit 并 push。成功后把 assignment 重置为 pending。

### 接受

输入只接受当前负责人的 `executionTaskKey` 和 `assignmentVersion`。创建和重新委派分别递增 assignment 版本；条件更新不匹配时返回 409，同一负责人重复接受按幂等成功处理。

### 幂等与失败

- 已完成幂等键返回原始结果，不重复 commit。
- `pending_push` 返回 202 和操作 ID，不得显示为已发布。
- `POST /api/git-operations/:id/retry` 只允许项目写成员重试同一项目仍处 `prepared | committed | pending_push` 的操作；`needs_repair` 时先由管理员修复项目副本，后台定时恢复与手动重试共用同一函数。
- 创建/委派返回的操作 ID 可通过 `GET /api/git-operations/:id` 查询脱敏状态，响应不包含凭证、内部路径或原始请求体。
- 版本或授权冲突返回 409/403；Git 远端失败返回 502/503。
- 任何失败均写审计，但不把敏感请求体写入 `detail_json`。
- 操作状态固定为 `prepared | committed | pending_push | pushed | applied | failed`，保存本地/远端 SHA；`needs_repair` 属于项目 `sync_status`。`failed` 仅限尚未改变工作副本的确定性失败；崩溃恢复以远端是否包含提交为准补齐状态。

## Agent 服务端协议

- 配对码使用至少 16 字节随机值，服务端只存哈希，一次性且 10 分钟有效；配对接口按来源和配对码限速。Agent 凭证使用至少 32 字节随机值，只返回一次，服务端存 SHA-256。
- 心跳至少包含协议版本、Agent 版本、各绑定分支/HEAD/clean/错误摘要。
- 命令只允许 `sync_branch` 与 `refresh_status`；命令载荷不含任意路径或 Shell 参数。
- 同一绑定已有 pending `sync_branch` 时复用而不重复入队；绑定或 Agent 撤销时批量取消未完成命令，避免离线久后执行过期意图。
- 命令领取用条件更新写 `delivered_at` 和租约；租约过期恢复 pending，结果提交必须匹配当前 Agent/绑定，同一命令重复结果幂等，连续 3 次失败后停止自动投递。
- 命令租约默认 5 分钟；Agent 本地状态命令 30 秒、fetch/merge 各 180 秒超时，超时后上报失败而不是无限占住长轮询。
- 接受任务时对目标用户所有已批准绑定入队；绑定首次批准时也入队一次，离线设备上线后按协议兼容性领取。
- 用户被移出项目时撤销该项目下的绑定并取消命令；MVP 不尝试远程删除或锁定用户已有的本地仓库。
- Agent API 使用独立 Bearer 认证，不接受用户 Cookie；用户会话不能调用 Agent API。
- Agent 上报的设备信息、HEAD SHA、分支和错误摘要全部按不可信输入校验长度/格式，命令 ID 必须属于当前 Agent 和绑定，结果不能携带完整本地路径。

## 看板

- 团队模式读取受管工作副本，沿用现有 Worker 和阶段投影；每个项目写入独立 `project_scan_cache`，不再用全局 `scan_cache` 表示团队数据。
- 记录每个项目最近扫描的 branch SHA 和 `.trellis/tasks`、`.trellis/workspace`、`.trellis/config.yaml` 内容键；普通代码提交不触发扫描，只有任务相关内容变化或本服务写入成功时才重扫该项目，避免 100 个项目的 10,000 任务集中全量扫描。
- 项目定期 fetch 使用抖动、60 秒最小间隔和最多 4 个并发，禁止 100 个项目同时启动子进程。
- 主线程按 `(project_id, content_key, scan_schema_version)` 保留最近一次解析后的项目投影并原子替换，避免 200 个在线用户轮询时反复 `JSON.parse` 同一大型缓存。
- `GET /api/team/projects` 只合并授权项目摘要和 `boardVersion`；团队 `/api/board` 必须指定一个 `projectId`，默认 100、最多 200 条并支持不透明 `cursor`、服务端筛选和 `ETag`。禁止一次返回全系统 10,000 个任务。
- `GET /api/tasks/query` 接受 `scope=all|mine`、可选 `projectIds`、`q`、`priorities`、`stages`、`tags`、`assignee`、`dueWithinDays`、`staleDays`、`blocked`、`archived`、`preset=today|unblocked-ready`、`limit` 和 `cursor`。未传 `projectIds` 时使用全部授权项目；显式传入时任一项目越权即整体 403；用户没有项目时返回空页而不是全量。
- 跨项目结果固定为扁平任务行，包含项目身份、任务身份、标题、阶段、优先级、负责人、日期、阻断/关注摘要和 `taskVersion`；完整父子分组只在单项目 `/api/board` 读取。
- 查询使用 `(COALESCE(last_activity_at,updated_at),project_id,task_key)` 的固定降序作为游标排序键；游标用进程启动时生成的临时 AES-256-GCM 密钥加密，内含用户、授权项目集合哈希、筛选哈希、`queryRevision`、`queryDay`、排序值和 10 分钟过期时间。伪造、过期、换版或重启后无效均返回 409 让客户端从第一页重取。
- `q` 最多 200 字符，先 trim/小写并对 `%`、`_` 转义后匹配 `search_text`；筛选和总数都在权限收窄后的完整索引结果上执行，默认 100、最大 200 条。
- 截止、逾期和长期未动按 `Asia/Shanghai` 计算 `queryDay`；响应 `ETag` 由用户、规范化筛选、排序、`queryRevision`、`queryDay` 和可读项目集合生成，`If-None-Match` 命中返回 304。项目 stale 状态随行或项目摘要返回，不能把旧索引标为实时。
- 契约测试至少覆盖：显式越权项目 ID 整体 403、无项目用户为空页、标签 ANY、内置视图、自然日换版、跨页无重复遗漏、游标伪造/过期、304、stale，以及旧的阶段/计划/依赖写与跨项目查询原子一致。
- WIP/保存视图从当前账号的 `user_board_state`/`saved_view` 读取；人工阶段、标签和依赖仍按授权项目读写。
- 人工阶段、计划字段、标签和依赖写入先由 `executionTaskKey` 推导项目并授权，再写共享扩展数据与审计；团队撤销只处理当前账号的 `task_event.actor_user_id`。
- 服务端从会话覆盖 `actor`、`created_by` 和事件来源，拒绝或忽略客户端自报身份。
- 项目 Git 错误时返回 `stale=true`、最后成功时间和错误摘要；写入口和接受入口在 stale 状态下禁用。
- 不在每个任务内查询 Agent 状态；按项目一次批量组装状态摘要。

## 测试

- 数据库新库、v3 -> v4、备份、迁移失败和恢复。
- scrypt、会话、过期/撤销、Origin/Content-Type、登录限速。
- 四角色 + 系统管理员的权限矩阵与跨项目访问。
- 项目锁、脚本树摘要、lifecycle hooks 拒绝、任务创建、委派、版本冲突、幂等、push 失败与恢复。
- Agent 配对/撤销、命令白名单和版本不兼容。
- 看板项目过滤、单项目分页、筛选跨页一致性、ETag、stale 标记和 standalone 回归。
- 跨项目索引原子替换、权限收窄、全部筛选组合、稳定游标、换版 409 和 304 基线。
- 400 账号、200 在线会话、100 项目、10,000 任务和 400 Agent 连接的容量/正确性基线。
- 接受任务后多设备命令扇出、单设备失败隔离和外部 Git assignee 变动对账。
- 真实 Git 临时裸仓库覆盖成功 push、非快进重试和不可恢复冲突，并验证新任务 `branch=<sync_branch>`、`base_branch=null` 时 `task.py start/archive` 不触发自引用校验。
