# 架构与运行时

## 模块职责

| 模块 | 职责 |
| --- | --- |
| [apps/server/config.js](../../../apps/server/config.js) | 跨平台运行数据根、SQLite 路径、团队监听与公开地址配置 |
| [apps/server/data-migration.js](../../../apps/server/data-migration.js) | 从旧源码 `data/` 迁移运行数据并重写受管项目路径 |
| [apps/server/database.js](../../../apps/server/database.js) | `node:sqlite` 连接、PRAGMA、顺序迁移到 schema v12、事务辅助 |
| [apps/server/repositories.js](../../../apps/server/repositories.js) | standalone 白名单增删、ID 生成和路径规范化 |
| [apps/server/loader.js](../../../apps/server/loader.js) | 扫描任务、读取证据、推导阶段和父子关系 |
| [apps/server/scan-worker.js](../../../apps/server/scan-worker.js) | standalone Worker Thread 扫描与增量任务刷新 |
| [apps/server/watcher.js](../../../apps/server/watcher.js) | standalone 仓库 watcher；团队服务端不使用 |
| [packages/shared/trellis-watcher.js](../../../packages/shared/trellis-watcher.js) | 单机与桌面客户端共用的任务/workspace 监听见 |
| [packages/shared/task-snapshot.js](../../../packages/shared/task-snapshot.js) | tasks-only 路径、LF 摘要、任务目录分组和首次差异分类 |
| [packages/shared/remote-identity.js](../../../packages/shared/remote-identity.js) | Git 远端规范化和任务空间身份输入 |
| [apps/server/team/task-space-service.js](../../../apps/server/team/task-space-service.js) | 全局项目、分支任务空间、团队访问、成员和 Agent binding |
| [apps/server/team/task-snapshot-service.js](../../../apps/server/team/task-snapshot-service.js) | tasks 快照、文件级 CAS、revision、游标、冲突和审计 |
| [apps/server/team/task-space-index.js](../../../apps/server/team/task-space-index.js) | 从持久化快照物化临时任务目录并生成 taskSpace 索引 |
| [apps/server/team/task-command-service.js](../../../apps/server/team/task-command-service.js) | Web 创建/改派命令、在线 Agent 检查、租约、重试和完成门禁 |
| [apps/server/team/sync-agent-service.js](../../../apps/server/team/sync-agent-service.js) | Agent 注册/鉴权、单账号活动槽和设备替换 |
| [apps/server/team/agent-event-stream.js](../../../apps/server/team/agent-event-stream.js) | Agent SSE 命令与撤销通知 |
| [apps/server/team/task-snapshot-backup.js](../../../apps/server/team/task-snapshot-backup.js) | 每日 SQLite `VACUUM INTO` 快照和 7 份保留策略 |
| [apps/server/team/gitless-board-service.js](../../../apps/server/team/gitless-board-service.js) | Team Board 查询、任务详情、计划写入和权限投影 |
| [apps/server/team/http.js](../../../apps/server/team/http.js) | Team HTTP 装配、路由、生命周期和 Session/Agent 鉴权 |

## 依赖方向

```text
standalone:
apps/server/index.js
  -> database / loader / persistence / actions / repositories / watcher
  -> execution-store / execution-projection

apps/server/scan-worker.js
  -> database / loader / metadata / repositories

team:
apps/server/team/http.js
  -> task-space-service
  -> task-snapshot-service
  -> task-space-index -> loader + sync_task_space_file
  -> task-command-service -> task-space-service + sync-agent-service
  -> gitless-board-service -> task-space-index + execution stores
  -> agent-event-stream / board-events

desktop Agent（apps/desktop/src-tauri/src/agent/）:
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
  -> apps/server/scan-worker.js
  -> apps/server/loader.js
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
- 服务端只持久化 `.trellis/tasks/**`。`scripts`、`spec`、`config.yaml`、`workflow.md`、`agents`、
  workspace、`.developer` 和本机编码 Agent 目录不属于 Team 同步协议。
- Team Board 的创建/改派不直接写项目文件。Web 只创建 `sync_task_command`；目标用户唯一在线 Agent
  在本地执行 `task.py create` 或原子修改 `task.json.assignee`，再通过同一 CAS 链上传。
- `sync_active_agent` 保证一个账号同一时刻只有一个有效 Agent。新设备生效会撤销旧设备 binding、
  取消旧命令并关闭旧 SSE。

## Team 快照投影

[apps/server/team/task-space-index.js](../../../apps/server/team/task-space-index.js) 对每个 taskSpace 串行投影：

1. 在系统临时目录创建空根，所有业务 Git 工作区之外；
2. 从 `sync_task_space_file` 读取当前 revision 的非删除文件；
3. 只写 `.trellis/tasks/**`；
4. 以 taskSpace 的 branch、project member developer ID 和显式 workspace-unavailable 上下文调用
   `scanRepository()`；
5. 原子替换 `sync_task_index`、标签和 `sync_task_space_scan_cache`；
6. 更新 `indexed_revision`，再发布 Board `tasks.changed` 和 Agent `task.changed`。

同 taskSpace 最多一个物化在途。期间新 revision 合并为下一轮最新快照，旧结果不得覆盖新 revision。
投影失败保留已提交快照和上一份一致 Board，按指数退避重试；恢复成功后 Board 自动对齐。

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
`apps/server/index.js`、`createTeamRuntime()` 或 CLI 顶层触发。

## 日志

- 主入口创建 `createServerLogger({ dataDir })`，standalone 和 team runtime 接收同一个 logger。
- 文件固定为 `<dataDir>/logs/server.log`；文件格式为 `<ISO-8601> <LEVEL> <message>`。
- 日志调用不等待磁盘 I/O；使用有界异步批次并在写入前统一脱敏。
- 当前文件上限 5 MiB，保留当前文件加 4 个历史文件；失败时控制台告警一次并停用文件 sink。
- Team 日志不得记录任务正文、Agent 凭证、Cookie、Git 凭据、本地仓库绝对路径或冲突双方完整内容。

## 子进程与异步边界

- SQLite 使用同步 `DatabaseSync`；多行业务写入必须在 `BEGIN IMMEDIATE` 事务内完成。
- Standalone 的外部 `task.py` 使用 `spawn()` 参数数组，不启用 shell，并设置 `PYTHONUTF8=1`。
- 桌面 Agent 的 `task.py`、Git 检查、Trellis 初始化和 Git 子进程都在客户端执行。
- Team 服务端不因任务同步或命令投递启动 Git/Python 子进程；Agent 命令通过 SSE 和 HTTP 结果协议完成。
- 子进程超时后必须等待进程树退出再 reject；超时、错误和输出摘要必须脱敏。
- HTTP 主线程不得执行完整仓库扫描、递归目录复制或大文件解析；Team 投影放在索引 Worker/异步队列。

## 配置与常量

- `DATABASE_SCHEMA_VERSION` 当前为 `12`。v11 -> v12 为 `sync_task_space` 幂等补
  `retired_at`、`retired_by_user_id`、`retired_reason` 和 `sync_task_space_retired` 索引；
  v10 -> v11 的 binding 监听字段迁移仍按原入口顺序执行，不删除旧表和历史文件。
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
