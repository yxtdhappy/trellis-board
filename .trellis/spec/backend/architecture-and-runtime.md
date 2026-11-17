# 架构与运行时

## 模块职责

| 模块 | 职责 |
| --- | --- |
| [packages/server/config.js](../../../packages/server/config.js) | 跨平台运行数据根、SQLite 路径、团队监听与公开地址配置 |
| [packages/server/data-migration.js](../../../packages/server/data-migration.js) | 从旧源码 `data/` 迁移运行数据并重写受管项目路径 |
| [packages/server/database.js](../../../packages/server/database.js) | `node:sqlite` 连接、PRAGMA、顺序迁移到 schema v14、事务辅助 |
| [packages/server/repositories.js](../../../packages/server/repositories.js) | standalone 白名单增删、ID 生成和路径规范化 |
| [packages/server/loader.js](../../../packages/server/loader.js) | 扫描任务、读取证据、推导阶段和父子关系 |
| [packages/server/scan-worker.js](../../../packages/server/scan-worker.js) | standalone Worker Thread 扫描与增量任务刷新 |
| [packages/server/watcher.js](../../../packages/server/watcher.js) | standalone 仓库 watcher；团队服务端不使用 |
| [packages/shared/trellis-watcher.js](../../../packages/shared/trellis-watcher.js) | 单机与桌面客户端共用的任务/workspace 监听见 |
| [packages/shared/task-snapshot.js](../../../packages/shared/task-snapshot.js) | tasks-only 路径、LF 摘要、任务目录分组和首次差异分类 |
| [packages/shared/remote-identity.js](../../../packages/shared/remote-identity.js) | Git 远端规范化和任务空间身份输入 |
| [packages/server/team/task-space-service.js](../../../packages/server/team/task-space-service.js) | 全局项目、分支任务空间、团队访问、成员和 Agent binding |
| [packages/server/team/task-snapshot-service.js](../../../packages/server/team/task-snapshot-service.js) | tasks 快照、文件级 CAS、revision、游标、冲突和审计 |
| [packages/server/team/task-space-index.js](../../../packages/server/team/task-space-index.js) | 从持久化快照物化临时任务目录并生成 taskSpace 索引 |
| [packages/server/team/archive-git-{store,sync,credentials}.js](../../../packages/server/team/archive-git-sync.js) | 服务端只读归档 Git 导入、按来源凭据隔离和失败日志 |
| [packages/server/team/task-command-service.js](../../../packages/server/team/task-command-service.js) | Web 创建/改派命令、在线 Agent 检查、租约、重试和完成门禁 |
| [packages/server/team/sync-agent-service.js](../../../packages/server/team/sync-agent-service.js) | Agent 注册/鉴权、单账号活动槽和设备替换 |
| [packages/server/team/agent-event-stream.js](../../../packages/server/team/agent-event-stream.js) | Agent SSE 命令与撤销通知 |
| [packages/server/team/task-snapshot-backup.js](../../../packages/server/team/task-snapshot-backup.js) | 每日 SQLite `VACUUM INTO` 快照和 7 份保留策略 |
| [packages/server/team/gitless-board-service.js](../../../packages/server/team/gitless-board-service.js) | Team Board 查询、任务详情、计划写入和权限投影 |
| [packages/server/team/http.js](../../../packages/server/team/http.js) | Team HTTP 装配、路由、生命周期和 Session/Agent 鉴权 |

## 依赖方向

```text
standalone:
packages/server/index.js
  -> database / loader / persistence / actions / repositories / watcher
  -> execution-store / execution-projection

packages/server/scan-worker.js
  -> database / loader / metadata / repositories

team:
packages/server/team/http.js
  -> task-space-service
  -> task-snapshot-service
  -> task-space-index -> loader + sync_task_space_file
  -> archive-git-sync -> archive-git-store + archive-git-credentials
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

## Standalone 运行时

单机模式继续读取 SQLite `repositories` 白名单中的本机仓库：

```text
.trellis/tasks + workspace + task.json evidence
  -> packages/server/scan-worker.js
  -> packages/server/loader.js
  -> scan_cache + execution tables
  -> /api/board + /api/task
```

- HTTP 主线程维护 `boardCache`、`inflightScan`、`queuedRefresh`、Worker 请求 Map 和 watcher。
- 完整仓库扫描在 Worker Thread 内执行；单任务事件可走增量刷新。
- 跨项目父子关系仍在主线程组合，不能只看单个任务结果。
- 创建任务和负责人写入由 standalone 路由调用目标仓库自己的 `task.py` 或原子写 `task.json`。

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
  -> sync_archive_file -> archive revision -> same taskSpaceIndex
  -> 归档索引 + Board tasks.changed（不触发 Agent task.changed）
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
- 活动任务服务端只持久化 `.trellis/tasks/<task-dir>/**`。归档 Git 导入另存
  `sync_archive_file`，不读取源码、scripts、spec、config、workflow、agents、workspace、
  `.developer` 或本机编码 Agent 目录。
- Team Board 的创建/改派不直接写项目文件。Web 只创建 `sync_task_command`；目标用户唯一在线 Agent
  在本地执行 `task.py create` 或原子修改 `task.json.assignee`，再通过同一 CAS 链上传。
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

- Trigger：服务端归档只读 Git 导入涉及远端 transport、批量对象读取、任务路径安全和 Agent/Board 读取隔离。
- 目标：同步阶段允许远端 Git；同步结束后所有产品读取只使用 SQLite/已导入数据，不得隐式回源远端。

### 2. Signatures

- 批量对象预取：

```text
git -c fetch.negotiationAlgorithm=noop fetch origin \
  --no-tags --no-write-fetch-head --recurse-submodules=no \
  --filter=blob:none --stdin
```

- stdin：每行一个缺失 blob OID。
- 本地对象读取：`git cat-file --batch`，且环境固定 `GIT_NO_LAZY_FETCH=1`。
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
- 必须先校验归档目录结构，再按扩展名跳过附件；不能因为文件是 `.png/.ps1` 等附件就绕过月份、任务目录和归档根路径校验。
- 当前文本归档只导入 `.json/.jsonl/.md/.txt/.yaml/.yml`。其他普通文件是附件，跳过单个文件，不使整个 taskSpace 失败；完整附件本地快照由独立后续任务定义。

### 4. Validation & Error Matrix

| 条件 | 结果 |
| --- | --- |
| HTTPS/SSH/file 远端批量获取缺失 blob | 使用高层 `git fetch origin --stdin`，一次请求可包含多个 OID |
| 调用 `fetch-pack <https-url>` | 视为实现错误，不得进入发布 |
| `cat-file` 遇到本地缺失对象 | `GIT_NO_LAZY_FETCH=1` 使其失败，不能请求远端 |
| 合法路径扩展名不在白名单 | 跳过该附件，继续读取其他支持文件 |
| 非法路径即使扩展名不在白名单 | 拒绝并记录失败，不能靠跳过绕过路径校验 |
| 符号链接/子模块/非普通 blob | 返回不支持的 Git 条目错误 |
| 单文件或总大小超限 | 整次归档发布失败，保留上一份成功归档 |

### 5. Good/Base/Bad Cases

- Good：GitHub HTTPS 归档一次 `fetch origin --stdin` 拉取全部缺失 OID，随后本地 `cat-file` 读取；Board 查询不启动 Git。
- Base：归档同时含 `task.json`、`prd.md`、`screenshot.png`；前两者导入，PNG 跳过，任务空间成功。
- Bad：每个 blob 单独执行 `cat-file` 触发 promisor fetch，导致数百次 HTTPS 请求。
- Bad：为了跳过 PNG 而先跳过路径安全检查，导致 `../secret.png` 也被忽略而非报错。

### 6. Tests Required

- `archive-git-store.test.js` 断言 fetch 参数包含 `fetch origin` 和 `--stdin`，不包含 `fetch-pack` 或远端 URL。
- 断言 fetch 与 cat-file 子进程环境都有 `GIT_NO_LAZY_FETCH=1`。
- 一次 stdin 包含多个 OID，并验证附件 blob 未进入 cache。
- shared 路径测试覆盖合法 PNG 与带 PNG 扩展名的 `..`、反斜杠、绝对路径、NUL 和越界路径。
- 服务端测试覆盖月份非法的附件路径，确认扩展名过滤不能让非法归档路径静默通过。
- 真实 E2E 至少覆盖一个 HTTPS 和一个 SSH 来源，确认 HTTPS 成功且同步后读取阶段没有新远端连接。

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

1. 准备跨平台运行数据根，打开 `board.sqlite` 并顺序迁移到 schema v14；
2. 固定监听 `0.0.0.0:4317`，端口可通过 `PORT` 调整；
3. 启动白名单仓库 watcher；
4. 异步触发初始扫描。

Team 启动：

1. 打开同一个 schema v14，但禁止导入本机默认仓库或旧 JSON；
2. 装配 `taskSpaces`、`taskSnapshots`、`taskSpaceIndex`、`taskCommands`、`agentService`、
   `agentEvents`、`boardEvents`、`taskSnapshotBackups` 和 `archiveGitSync`；
3. 不装配旧 `git-manager`、工作副本、项目 clone、Git commit/push 或旧实时覆盖层；只启动归档
   只读 Git 定时导入；
4. HTTP 监听成功后启动每日数据库快照备份和归档同步调度；
5. 主入口在后台对全部未停用 taskSpace 调用 `taskSpaceIndex.warmActive()`，预热失败只记录警告，
   不阻塞端口监听或 HTTP 请求。

关闭顺序为停止新请求、关闭 Board/Agent SSE、停止备份定时器、关闭 HTTP server、关闭索引 Worker，
最后关闭 SQLite 连接。`SIGINT`/`SIGTERM` 还必须在 runtime 停止后等待 logger `close()`。

测试导入 `loader`、`task-space-service` 等模块时不能意外监听端口；端口生命周期只在
`packages/server/index.js`、`createTeamRuntime()` 或 CLI 顶层触发。

## 日志

- 主入口创建 `createServerLogger({ dataDir })`，standalone 和 team runtime 接收同一个 logger。
- 实现是 `pino` + `pino-roll`，写入 `<dataDir>/logs/server.<n>.log`，每行一个 JSON 对象
  （`level` 数值、`time` ISO-8601、`msg` 已脱敏的自由文本）；文件名序号由 pino-roll 维护，
  不再有固定的 `server.log`。
- 日志调用不等待磁盘 I/O；启动探测期与磁盘阻塞期的记录先排队（上限 1000 条）再补写。
- 单文件上限 5 MiB，`limit.count` 传 `maxFiles - 1`（不含活动文件）；失败时控制台告警一次并停用文件 sink。
- `close()` 必须等待 SonicBoom 的 `close` 事件，`flush()` 早于文件打开完成不代表落盘。
- Team 日志不得记录任务正文、Agent 凭证、Cookie、Git 凭据、本地仓库绝对路径或冲突双方完整内容。

## 子进程与异步边界

- SQLite 使用同步 `DatabaseSync`；多行业务写入必须在 `BEGIN IMMEDIATE` 事务内完成。
- Standalone 的外部 `task.py` 使用 `spawn()` 参数数组，不启用 shell，并设置 `PYTHONUTF8=1`。
- 桌面 Agent 的 `task.py`、Git 检查、Trellis 初始化和 Git 子进程都在客户端执行。
- 活动任务同步和命令投递不启动 Git/Python 子进程；Agent 命令通过 SSE 和 HTTP 结果协议完成。
  归档 scheduler 是唯一例外，只允许启动隔离 Git 进程读取 archive 对象，不能写入项目或活动快照。
- 子进程超时后必须等待进程树退出再 reject；超时、错误和输出摘要必须脱敏。
- HTTP 主线程不得执行完整仓库扫描、递归目录复制或大文件解析；Team 投影放在索引 Worker/异步队列。

## 配置与常量

- `DATABASE_SCHEMA_VERSION` 当前为 `14`。v13 -> v14 增加归档文件、凭据、同步配置/状态/失败日志表，
  增加活动/归档双 revision，并把旧 archive 文件作为只读 legacy 缓存隔离。迁移不删除旧表和历史文件。
- `SCAN_SCHEMA_VERSION` 当前为 `11`；Board 输出结构不兼容时同步递增。
- `AGENT_PROTOCOL_VERSION` 当前为 `3`；命令 payload 和 Agent 事件都按 v3 校验。
- 在线 Agent 的 `last_seen_at` 窗口固定为 60 秒。
- standalone 默认接受本地 `file://` 远端；team 默认拒绝，必须显式设置
  `TRELLIS_BOARD_ALLOW_LOCAL_GIT_REMOTES=true`。
- Team 服务启动配置包括 `TRELLIS_BOARD_MODE`、`TRELLIS_BOARD_DATA_DIR`、`PORT` 和上述远端开关。
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
