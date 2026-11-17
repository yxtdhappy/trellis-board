# 架构与运行时

## 模块职责

| 模块 | 职责 |
| --- | --- |
| [packages/server/config.js](../../../packages/server/config.js) | 跨平台运行数据根、SQLite 路径、团队监听与公开地址配置 |
| [packages/server/data-migration.js](../../../packages/server/data-migration.js) | 从旧源码 `data/` 迁移运行数据并重写受管项目路径 |
| [packages/server/database.js](../../../packages/server/database.js) | `node:sqlite` 连接、PRAGMA、顺序迁移到 schema v12、事务辅助 |
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

## Team 无 Git 运行时

Team runtime 的事实链只有客户端任务快照：

```text
本地 Git 仓库 A .trellis/tasks/**
  -> Agent watcher + 完整任务目录 CAS
  -> sync_task_space_file / batch / audit
  -> taskSpaceIndex 在系统临时目录写入 tasks-only 快照
  -> scanRepository()
  -> sync_task_index + Board SSE

本地 Git 仓库 B <-- snapshot/cursor/SSE -- 同一 taskSpace
```

关键边界：

- 服务端不执行项目 Git clone、fetch、commit、push，不持有项目凭据，不创建
  `data/projects/**` 工作副本。
- 项目身份是 Agent 自报并校验格式的规范化 Git 远端；服务端不访问远端证明仓库存在。
- 任务空间键是“规范化远端 + 分支”。同一远端不同分支 revision、cursor、命令和索引完全隔离。
- 项目保存固定 `baseline_branch`。已合入任务的合入事实由绑定基线 taskSpace 的已批准 Agent 读取本地
  Git `HEAD` 后上报 `tracked-in-head` 证据；服务端只校验声明结构、身份和任务目录，不执行 Git，
  因而该证据属于受信 Agent 声明而非服务端独立证明。
- 基线 taskSpace 首次接纳来源不同任务后，来源 taskSpace 的同一稳定任务 ID 转为只读历史副本。
  默认 Board 查询以基线副本优先并隐藏来源重复项，旧快照、冲突和审计不删除。
- 服务端只持久化 `.trellis/tasks/**`。`scripts`、`spec`、`config.yaml`、`workflow.md`、`agents`、
  workspace、`.developer` 和本机编码 Agent 目录不属于 Team 同步协议。
- Team Board 的创建/改派不直接写项目文件。Web 只创建 `sync_task_command`；目标用户唯一在线 Agent
  在本地执行 `task.py create` 或原子修改 `task.json.assignee`，再通过同一 CAS 链上传。
- `sync_active_agent` 保证一个账号同一时刻只有一个有效 Agent。新设备生效会撤销旧设备 binding、
  取消旧命令并关闭旧 SSE。

## Team 快照投影

[packages/server/team/task-space-index.js](../../../packages/server/team/task-space-index.js) 对每个 taskSpace
串行投影，并在进程内保存可丢弃的 `ProjectionState`：上次成功 revision、未变化任务完整事实、目录
指纹、稳定 project/workspace 成员、Board/详情投影、人工阶段指纹和最近一次指标。内存状态不是业务
事实源；服务重启后第一次投影允许全量扫描重建。

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

冷启动仍需要一次 full 扫描，成本随任务空间规模增长；正常单任务 warm 更新只承担全量轻量元数据
读取、一个任务目录解析和必要的全局关系重算。

Team 扫描不读取 Git 元数据、workspace 会话、`.developer`、scripts、spec、config 或 workflow。
`workspace` 显示“服务端不判定”，不能伪造 journal 完成状态。

## 启动与关闭

Standalone 启动：

1. 准备跨平台运行数据根，打开 `board.sqlite` 并顺序迁移到 schema v12；
2. 固定监听 `0.0.0.0:4317`，端口可通过 `PORT` 调整；
3. 启动白名单仓库 watcher；
4. 异步触发初始扫描。

Team 启动：

1. 打开同一个 schema v12，但禁止导入本机默认仓库或旧 JSON；
2. 装配 `taskSpaces`、`taskSnapshots`、`taskSpaceIndex`、`taskCommands`、`agentService`、
   `agentEvents`、`boardEvents` 和 `taskSnapshotBackups`；
3. 不装配 `git-manager`、Git 凭据、项目 clone、Git 定时刷新或旧实时覆盖层；
4. HTTP 监听成功后启动每日数据库快照备份。

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
- Team 服务端不因任务同步或命令投递启动 Git/Python 子进程；Agent 命令通过 SSE 和 HTTP 结果协议完成。
- 子进程超时后必须等待进程树退出再 reject；超时、错误和输出摘要必须脱敏。
- HTTP 主线程不得执行完整仓库扫描、递归目录复制或大文件解析；Team 投影放在索引 Worker/异步队列。

## 配置与常量

- `DATABASE_SCHEMA_VERSION` 当前为 `12`。v10 -> v11 为 `sync_agent_binding` 幂等补监听字段和索引；
  v11 -> v12 为 `sync_task_space` 补 retired 字段和索引，为 `sync_project` 补 `baseline_branch`，
  创建 `sync_task_merge_evidence` 和 task ID 索引，并按最早活动 taskSpace 回填基线。
  迁移不删除旧表和历史文件。
- `SCAN_SCHEMA_VERSION` 当前为 `11`；Board 输出结构不兼容时同步递增。
- `AGENT_PROTOCOL_VERSION` 当前为 `3`；命令 payload 和 Agent 事件都按 v3 校验。
- 在线 Agent 的 `last_seen_at` 窗口固定为 60 秒。
- standalone 默认接受本地 `file://` 远端；team 默认拒绝，必须显式设置
  `TRELLIS_BOARD_ALLOW_LOCAL_GIT_REMOTES=true`。
- Team 服务启动配置包括 `TRELLIS_BOARD_MODE`、`TRELLIS_BOARD_DATA_DIR`、`PORT` 和上述远端开关。
- Team 模式没有 Git 轮询间隔、项目工作副本路径或 Git 凭据密钥依赖。

## 反模式

- 在 Team 服务端重新 clone/fetch 项目 Git，或用 Git 文件覆盖任务快照。
- 在 HTTP 路由中同步递归扫描任务或等待整个 taskSpace 投影完成。
- 把 Team tasks-only 同步扩回 workspace、`.developer`、scripts、spec 或 Agent 适配目录。
- 绕过 `task-space-service` 直接按团队复制项目或 taskSpace。
- 绕过 `task-snapshot-service` 直接写 `sync_task_space_file` 或静默后写覆盖。
- 在 Web 请求线程直接运行 `task.py`、改 `task.json` 或 commit/push。
- 用路径和时间抑制 watcher，却不校验应用后文件摘要。
- 在模块导入阶段启动监听器、Worker、定时备份或端口。
