# 架构与运行时

## 模块职责

| 模块 | 职责 |
| --- | --- |
| [packages/server/config.js](../../../packages/server/config.js) | 跨平台运行数据根、SQLite 路径、团队监听与公开地址配置 |
| [packages/server/data-migration.js](../../../packages/server/data-migration.js) | 从旧源码 `data/` 迁移运行数据并重写受管项目路径 |
| [packages/server/database.js](../../../packages/server/database.js) | `node:sqlite` 连接、PRAGMA、顺序迁移到 schema v16、事务辅助 |
| [packages/server/repositories.js](../../../packages/server/repositories.js) | 仓库白名单增删、ID 生成和路径规范化（Team 插件任务服务与历史数据） |
| [packages/server/loader.js](../../../packages/server/loader.js) | 扫描任务、读取证据、推导阶段和父子关系 |
| [packages/server/scan-worker.js](../../../packages/server/scan-worker.js) | 历史 Worker Thread 扫描核心；standalone 已移除，Team 不调用 |
| [packages/server/watcher.js](../../../packages/server/watcher.js) | 历史仓库 watcher；standalone 已移除，Team 不调用 |
| [packages/shared/trellis-watcher.js](../../../packages/shared/trellis-watcher.js) | 桌面客户端任务/workspace 监听 |
| [packages/shared/task-snapshot.js](../../../packages/shared/task-snapshot.js) | tasks-only 路径、LF 摘要、任务目录分组和首次差异分类 |
| [packages/shared/remote-identity.js](../../../packages/shared/remote-identity.js) | Git 远端规范化和任务空间身份输入 |
| [packages/server/team/task-space-service.js](../../../packages/server/team/task-space-service.js) | 全局项目、分支任务空间、团队访问、成员和 Agent binding |
| [packages/server/team/task-snapshot-service.js](../../../packages/server/team/task-snapshot-service.js) | tasks 快照、文件级 CAS、revision、游标、冲突和审计 |
| [packages/server/team/task-space-index.js](../../../packages/server/team/task-space-index.js) | 从持久化快照物化临时任务目录并生成 taskSpace 索引 |
| [packages/server/team/archive-local-snapshot.js](../../../packages/server/team/archive-local-snapshot.js) | 归档完整文件的内容寻址本地快照、原子发布、下载校验和清理 |
| [packages/server/team/archive-git-{store,sync,credentials}.js](../../../packages/server/team/archive-git-sync.js) | 服务端只读归档 Git 导入、按来源凭据隔离和失败日志 |
| [packages/server/team/task-command-service.js](../../../packages/server/team/task-command-service.js) | Web 创建/改派命令、目标用户 pending 队列、在线投递、租约、重试和完成门禁 |
| [packages/server/team/sync-agent-service.js](../../../packages/server/team/sync-agent-service.js) | Agent 注册/鉴权、单账号活动槽和设备替换 |
| [packages/server/team/agent-event-stream.js](../../../packages/server/team/agent-event-stream.js) | Agent SSE 命令与撤销通知 |
| [packages/server/team/task-snapshot-backup.js](../../../packages/server/team/task-snapshot-backup.js) | 每日 SQLite `VACUUM INTO` 快照和 7 份保留策略 |
| [packages/server/team/gitless-board-service.js](../../../packages/server/team/gitless-board-service.js) | Team Board 查询、任务详情、计划写入和权限投影 |
| [packages/server/team/http.js](../../../packages/server/team/http.js) | Team HTTP 装配、路由、生命周期和 Session/Agent 鉴权 |

## 依赖方向

```text
team:
packages/server/index.js
  -> team/runtime.js -> team/http.js
  -> task-space-service
  -> task-snapshot-service
  -> task-space-index -> loader + sync_task_space_file
  -> archive-git-sync -> archive-git-store + archive-git-credentials + archive-local-snapshot
  -> task-command-service -> task-space-service + sync-agent-service
  -> gitless-board-service -> task-space-index + execution stores
  -> agent-event-stream / board-events

desktop Agent（packages/desktop/src-tauri/src/agent/）:
task_sync.rs
  -> packages/shared/task-snapshot.js + packages/shared/trellis-watcher.js + http.rs
task_command.rs
  -> git.rs + 项目 task.py + task_sync.rs
onboarding.rs
  -> git.rs + 安装包内 Trellis runtime + http.rs
```

`config.js` 不反向导入业务模块。`database.js` 是 SQLite schema 和迁移的唯一所有者。业务模块不绕过
`database.js` 的连接、事务和迁移入口。`loader.js` 是可复用扫描核心；Worker、详情接口和 Team 快照
投影都复用它，不在 HTTP 路由另写阶段推导。

## Team 活动任务与归档运行时

Team runtime 的事实链拆成两条：

```text
本地 Git 仓库 A .trellis/tasks/**
  -> Agent watcher（排除 archive）+ 完整活动任务目录 CAS
  -> sync_task_space_file / batch / audit
  -> taskSpaceIndex 在系统临时目录写入活动任务快照
  -> scanRepository()
  -> sync_task_index + Board SSE

本地 Git 仓库 B <-- snapshot/cursor/SSE -- 同一 taskSpace

远端分支 archive/**
  -> 后台 scheduler -> 只读 fetch + object read
  -> staging 本地完整快照 -> 原子发布 heads/<head>
  -> 候选 snapshot + 不可变历史 fileId + archive revision
  -> same taskSpaceIndex 读取候选
  -> 同一事务激活 snapshot + 归档索引 + Board tasks.changed
    （不触发 Agent task.changed）
```

关键边界：

- 活动任务链路不执行项目 Git clone、fetch、commit、push，不持有项目凭据；归档链路只对
  `.trellis/tasks/archive/**` 执行后台只读 fetch/object 读取，不 checkout、不 commit、不 push，
  不创建 `data/projects/**` 工作副本。
- 项目身份是 Agent 自报并校验格式的规范化 Git 远端；活动任务同步不让服务端访问远端。归档同步
  只使用管理页按 `scheme + host + port` 配置的只读凭据，不能使用客户端凭据。
- 任务空间键是“规范化远端 + 分支”。同一远端不同分支 revision、cursor、命令和索引完全隔离。
- 项目保存固定 `baseline_branch`。已合入任务的合入事实由绑定基线 taskSpace 的已批准 Agent 读取本地
  Git `HEAD` 后上报 `tracked-in-head` 证据；服务端只校验声明结构、身份和任务目录，不执行 Git，
  因而该证据属于受信 Agent 声明而非服务端独立证明。
- 基线 taskSpace 首次接纳来源不同任务后，来源 taskSpace 的同一稳定任务 ID 转为只读历史副本。
  默认 Board 查询以基线副本优先并隐藏来源重复项，旧快照、冲突和审计不删除。
- 活动任务服务端只持久化 `.trellis/tasks/<task-dir>/**`。归档 Git 导入保存
  `.trellis/tasks/archive/**` 中的全部普通文件到本地内容寻址快照，SQLite 只保存元数据和
  文本搜索投影，不读取源码、scripts、spec、config、workflow、agents、workspace、
  `.developer` 或本机编码 Agent 目录。
- Team Board 的创建/改派不直接写项目文件。Web 先创建权威任务/改派状态和按 `target_user_id`
  保存的 `sync_task_command`；目标用户离线时保持 pending，唯一在线 Agent 出现后在本地执行
  `task.py create` 或原子修改 `task.json.assignee`，再通过同一 CAS 链上传。
- `sync_active_agent` 保证一个账号同一时刻只有一个有效 Agent。新设备生效会撤销旧设备 binding、
  取消旧命令并关闭旧 SSE。

## Team 快照投影

[packages/server/team/task-space-index.js](../../../packages/server/team/task-space-index.js) 对每个 taskSpace
串行投影，并保存可丢弃的 `ProjectionState`：上次成功 revision、未变化任务完整事实、目录指纹、
稳定 project/workspace 成员、Board/详情投影、人工阶段指纹和最近一次指标。内存中有状态时直接复用；
进程启动后从 `sync_task_space_scan_cache.projection_state_json` 恢复同一结构并继续增量投影。
状态版本不兼容、JSON 损坏、字段校验失败或 revision 未对齐时才全量扫描重建。

每次成功 revision 的投影流程：

1. 读取 `sync_task_space_file` 的轻量元数据，不读取 `content_text`；按完整任务目录计算稳定指纹。
2. 没有可信基线、`indexed_revision` 未对齐或缓存不完整时执行 full：读取全部活动正文，在系统临时
   目录只写 `.trellis/tasks/**` 并调用 `scanRepository()`。
3. 有可信 warm 基线时执行 incremental：只读取和扫描新增、修改、删除或移动的任务目录，其余任务
   直接复用内存事实。归档时间取快照文件行的 `updated_at`，不能取临时物化文件 mtime。
4. 无论 full 还是 incremental，都用当前全部任务重新计算父子关系、身份冲突、人工阶段、风险、
   WIP 和执行投影；`project.members` 必须由稳定 `workspaceMembers` 加当前全部任务参与者重算。
5. 在单个 `BEGIN IMMEDIATE` 中重新读取 taskSpace，校验目标 revision、retired/status 和人工阶段
   指纹；只对新增或字段变化的 `sync_task_index` 行 UPSERT，删除消失行，并只重建受影响任务的标签。
   Board cache、assignment 投影和 `indexed_revision` 与索引写入同事务提交。
6. 提交成功后发布 query revision、Board `tasks.changed` 和 Agent `task.changed`，再替换内存状态。

同一 taskSpace 的 `enqueue()` 与 `ensureMaterialized()` 共用 single-flight。扫描期间出现新 revision
时，旧候选整体 superseded，不写索引、缓存或 `indexed_revision`；下一轮直接收敛到最新 revision。
同 revision 的人工阶段变化只重做全任务关系和执行投影，不重新读取任务正文。投影失败保留最后一份
一致 Board，按指数退避重试；恢复成功后 Board 自动对齐。

服务启动会在后台预热未停用的 project/taskSpace。已持久化 warm 状态且 revision 对齐时预热为 no-op；
落后 revision 只扫描变化任务。只有升级后的首次运行、缓存缺失或校验失败才需要一次 full 扫描，
成本随任务空间规模增长。正常单任务 warm 更新只承担全量轻量元数据读取、一个任务目录解析和必要的
全局关系重算。

Team 扫描不读取 Git 元数据、workspace 会话、`.developer`、scripts、spec、config 或 workflow。
`workspace` 显示“服务端不判定”，不能伪造 journal 完成状态。

## Scenario: 归档 Git 导入的路径与传输边界

### 1. Scope / Trigger

- Trigger：服务端归档只读 Git 导入涉及远端 transport、批量对象读取、完整本地快照、任务路径安全
  和 Agent/Board 读取隔离。
- 目标：同步阶段允许远端 Git；同步结束后详情、搜索和附件下载只使用 SQLite 与本地快照，
  不得隐式回源远端。

### 2. Signatures

- 批量对象预取：

```text
git -c fetch.negotiationAlgorithm=noop fetch origin \
  --no-tags --no-write-fetch-head --recurse-submodules=no \
  --filter=blob:none --stdin
```

- stdin：每行一个缺失 blob OID。
- 本地对象读取：`git cat-file --batch`，且环境固定 `GIT_NO_LAZY_FETCH=1`。
- 快照存储：`createArchiveSnapshotStore({ db, dataDir, databaseFile, logger })`。
- 路径规范化：

```js
normalizeSnapshotPath(value, { allowUnsupportedExtension = false })
taskDirectoryFromPath(value, { allowUnsupportedExtension = false })
```

### 3. Contracts

- 禁止使用 `git fetch-pack --stdin <https-url>`：Windows Git 的 `fetch-pack` 不为 HTTPS URL 选择 `remote-https`，会报 `protocol 'https' is not supported`。
- 必须先在 bare cache 中配置 `remote.origin.url`，再执行高层 `git fetch origin ... --stdin`；该命令支持 HTTP/HTTPS、SSH 和 file transport，并能把多个 OID 合并进一个 pack。
- prefetch 和 `cat-file` 都保持 `GIT_NO_LAZY_FETCH=1`。网络对象只允许由同步阶段的显式批量 fetch 获取，`cat-file` 不得触发逐对象懒加载。
- `allowUnsupportedExtension` 只允许合法归档路径跳过扩展名白名单；NUL、反斜杠、绝对路径、`.`/`..`、空段和越出 `.trellis/tasks` 的路径仍必须拒绝。
- 必须先校验归档目录结构，再导入文件；不能因为文件是 `.png/.ps1` 等附件就绕过月份、任务目录和归档根路径校验。
- archive tree 中的全部普通文件都写入 staging。符号链接、子模块和非普通 Git 条目继续使本次导入失败。
- SQLite `sync_archive_file` 只保存 SHA-256、Git OID、大小、MIME、来源 HEAD、`storage_key`
  和文本摘要；正文位于 `archive-snapshots/<taskSpaceId>/heads/<head>/files/<sha256>`。
- `content_text` 停止写入。无本地快照的 v14 legacy 行仍可按只读正文回退；下一次成功同步后切换。
- 新快照完整发布后先写候选和 `archive_candidate_snapshot_id`，不得在导入事务退役当前
  `archive_snapshot_id`。索引事务重新校验候选指针，并在同一事务中退役旧 active、激活候选、
  写 Board/索引和 `archive_indexed_revision`；任一阶段失败保留上一份 active 快照、Board、
  revision 和旧 fileId 下载。

### 4. Validation & Error Matrix

| 条件 | 结果 |
| --- | --- |
| HTTPS/SSH/file 远端批量获取缺失 blob | 使用高层 `git fetch origin --stdin`，一次请求可包含多个 OID |
| 调用 `fetch-pack <https-url>` | 视为实现错误，不得进入发布 |
| `cat-file` 遇到本地缺失对象 | `GIT_NO_LAZY_FETCH=1` 使其失败，不能请求远端 |
| 合法路径中的普通附件文件 | 写入本地快照并返回元数据，不按扩展名过滤 |
| 非法路径即使扩展名不在白名单 | 拒绝并记录失败，不能靠跳过绕过路径校验 |
| 符号链接/子模块/非普通 blob | 返回不支持的 Git 条目错误 |
| 单文件或总大小超限 | 整次归档发布失败，保留上一份成功归档 |
| 读取时本地文件缺失或哈希不匹配 | `503 ARCHIVE_LOCAL_FILE_UNAVAILABLE`，请求不得运行 Git 或回源 |

### 5. Good/Base/Bad Cases

- Good：GitHub HTTPS 归档一次 `fetch origin --stdin` 拉取全部缺失 OID，随后物化快照；断网和重启后仍可读取 Board 与附件。
- Base：归档同时含 `task.json`、`prd.md`、`screenshot.png`；三者都进入本地快照，SQLite 正文列为空。
- Bad：每个 blob 单独执行 `cat-file` 触发 promisor fetch，导致数百次 HTTPS 请求。
- Bad：为了跳过 PNG 而先跳过路径安全检查，导致 `../secret.png` 也被忽略而非报错。

### 6. Tests Required

- `archive-git-store.test.js` 断言 fetch 参数包含 `fetch origin` 和 `--stdin`，不包含 `fetch-pack` 或远端 URL。
- 断言 fetch 与 cat-file 子进程环境都有 `GIT_NO_LAZY_FETCH=1`。
- 一次 stdin 包含多个 OID，并验证 PNG、脚本、Excel、class 和 pen 文件都进入快照 cache。
- shared 路径测试覆盖合法 PNG 与带 PNG 扩展名的 `..`、反斜杠、绝对路径、NUL 和越界路径。
- 服务端测试覆盖月份非法的附件路径，确认附件导入不能绕过归档目录和路径校验。
- `archive-local-snapshot.test.js` 覆盖发布失败、候选/active 引用保护、重启、备份引用、清理和损坏检测。
- HTTP 测试覆盖 401/403/404、固定响应头和本地文件缺失 503。
- 真实 E2E 至少覆盖一个 HTTPS 和一个 SSH 来源，确认同步后断网读取和重启读取都没有新远端连接。

### 7. Wrong vs Correct

Wrong：

```js
spawn('git', ['fetch-pack', '--stdin', remoteUrl])
```

Correct：

```js
spawn('git', [
  'fetch',
  'origin',
  '--no-tags',
  '--no-write-fetch-head',
  '--recurse-submodules=no',
  '--filter=blob:none',
  '--stdin',
])
```

## 启动与关闭

Standalone 启动：

1. 准备跨平台运行数据根，打开 `board.sqlite` 并顺序迁移到 schema v16；
2. 固定监听 `0.0.0.0:4317`，端口可通过 `PORT` 调整；
3. 启动白名单仓库 watcher；
4. 异步触发初始扫描。

Team 启动：

1. 打开同一个 schema v16，但禁止导入本机默认仓库或旧 JSON；
2. 装配 `taskSpaces`、`taskSnapshots`、`taskSpaceIndex`、`taskCommands`、`agentService`、
   `agentEvents`、`boardEvents`、`taskSnapshotBackups` 和 `archiveGitSync`；
3. 不装配旧 `git-manager`、工作副本、项目 clone、Git commit/push 或旧实时覆盖层（旧 Git 栈与旧实时
   覆盖层文件已删除，不要再引入同名模块）；只启动归档只读 Git 定时导入；
4. HTTP 监听成功后启动每日数据库快照备份和归档同步调度；
5. 主入口在后台对全部未停用 taskSpace 调用 `taskSpaceIndex.warmActive()`，预热失败只记录警告，
   不阻塞端口监听或 HTTP 请求。

关闭顺序为停止新请求、关闭 Board/Agent SSE、停止备份定时器、关闭 HTTP server、关闭索引 Worker，
最后关闭 SQLite 连接。`SIGINT`/`SIGTERM` 还必须在 runtime 停止后等待 logger `close()`。

测试导入 `loader`、`task-space-service` 等模块时不能意外监听端口；端口生命周期只在
`packages/server/index.js`、`createTeamRuntime()` 或 CLI 顶层触发。

## 日志

- 主入口创建 `createServerLogger({ dataDir })`，Team runtime 接收同一个 logger。
- 实现是 `pino` + `pino-roll`，写入 `<dataDir>/logs/server.<n>.log`，每行一个 JSON 对象
  （`level` 数值、`time` ISO-8601、`msg` 已脱敏的自由文本）；文件名序号由 pino-roll 维护，
  不再有固定的 `server.log`。
- 日志调用不等待磁盘 I/O；启动探测期与磁盘阻塞期的记录先排队（上限 1000 条）再补写。
- 单文件上限 5 MiB，`limit.count` 传 `maxFiles - 1`（不含活动文件）；失败时控制台告警一次并停用文件 sink。
- `close()` 必须等待 SonicBoom 的 `close` 事件，`flush()` 早于文件打开完成不代表落盘。
- Team 日志不得记录任务正文、Agent 凭证、Cookie、Git 凭据、本地仓库绝对路径或冲突双方完整内容。

## 子进程与异步边界

- SQLite 使用同步 `DatabaseSync`；多行业务写入必须在 `BEGIN IMMEDIATE` 事务内完成。
- 服务端外部 `task.py`（插件任务服务）使用 `spawn()` 参数数组，不启用 shell，并设置 `PYTHONUTF8=1`。
- 桌面 Agent 的 `task.py`、Git 检查、Trellis 初始化和 Git 子进程都在客户端执行。
- 活动任务同步和命令投递不启动 Git/Python 子进程；Agent 命令通过 SSE 和 HTTP 结果协议完成。
  归档 scheduler 是唯一例外，只允许启动隔离 Git 进程读取 archive 对象，不能写入项目或活动快照。
- 子进程超时后必须等待进程树退出再 reject；超时、错误和输出摘要必须脱敏。
- HTTP 主线程不得执行完整仓库扫描、递归目录复制或大文件解析；Team 投影放在索引 Worker/异步队列。

## 配置与常量

- `DATABASE_SCHEMA_VERSION` 当前为 `18`。v13 -> v14 增加归档文件、凭据、同步配置/状态/失败日志表，
  增加活动/归档双 revision；v14 -> v15 增加 `sync_archive_snapshot`、
  `sync_archive_file_history`、active/candidate 指针和归档文件元数据列，
  `content_text` 保留为 legacy 只读回退；v15 -> v16 增加 `sync_task`、`sync_task_lease`，
  重建支持 `target_user_id` 的 `sync_task_command`；v17 -> v18 给
  `sync_task_ownership_inbox` 增加可空的 `assignee_user_id`、`assignee_dev_id`（按列名守卫重复执行）。
  迁移不删除旧表和历史文件。
- `SCAN_SCHEMA_VERSION` 当前为 `11`；Board 输出结构不兼容时同步递增。
- `AGENT_PROTOCOL_VERSION` 当前为 `3`；命令 payload 和 Agent 事件都按 v3 校验。
- 在线 Agent 的 `last_seen_at` 窗口固定为 60 秒。
- Team 默认拒绝本地 `file://` 远端，必须显式设置
  `TRELLIS_BOARD_ALLOW_LOCAL_GIT_REMOTES=true`。
- Team 服务启动配置包括 `TRELLIS_BOARD_MODE`、`TRELLIS_BOARD_DATA_DIR`、`PORT`、
  `TRELLIS_BOARD_BASE_PATH`（默认根路径 `""`；仓库 `.env` 默认写入 `/weint-spec-board`，`yarn dev`/`yarn test` 自动隔离来自 `.env` 的默认值）、`TRELLIS_BOARD_TRUST_PROXY`（默认 `true`）、
  `TRELLIS_BOARD_ADMIN_USERNAME`（默认 `admin`）、`TRELLIS_BOARD_ADMIN_PASSWORD`（默认 `123456!@#$%^`）
  和上述远端开关。
  - 首次启动且 `requireAdmin: true`、数据库无有效管理员时，`createTeamRuntime()` 使用 `config.initialAdmin` 自动创建系统管理员（`systemAdmin: true`、`mustChangePassword: true`）；日志仅记录 `userId`、`username`、`mustChangePassword`，严禁输出密码明文。
  - 数据库已有有效系统管理员时启动幂等跳过，不覆盖或重置已有账号密码；无有效管理员但目标用户名已被占用时直接冲突报错中止，不静默提权。
  - `.env` 文件中若密码包含 `#`（如默认值 `123456!@#$%^`），必须使用单/双引号包裹，否则 `dotenv` 会将 `#` 及后续内容截断为行内注释。
  - `config.js` 通过无副作用纯校验模块 [packages/server/team/credentials.js](../../../packages/server/team/credentials.js) 复用 `normalizeUsername` / `validatePassword`，不得反向导入依赖 `database.js` 的 `team/auth.js` 以免形成循环依赖。
- Team 归档同步默认周期 `300s`，范围 `60-86400s`；凭据主密钥和临时 SSH 认证文件位于 Team data
  directory，按来源隔离，不能跨 host/port 复用。

## 反模式

- 在 Team 活动任务链路重新 clone/fetch 项目 Git，或用 Git 文件覆盖活动任务快照；归档 Git 只能由
  后台 archive scheduler 读取 archive 路径。
- 在 HTTP 路由中同步递归扫描任务或等待整个 taskSpace 投影完成。
- 把 Team tasks-only 同步扩回 workspace、`.developer`、scripts、spec 或 Agent 适配目录。
- 绕过 `task-space-service` 直接按团队复制项目或 taskSpace。
- 绕过 `task-snapshot-service` 直接写 `sync_task_space_file` 或静默后写覆盖。
- 在 Web 请求线程直接运行 `task.py`、改 `task.json` 或 commit/push。
- 用路径和时间抑制 watcher，却不校验应用后文件摘要。
- 在模块导入阶段启动监听器、Worker、归档 Git 调度、定时备份或端口。
