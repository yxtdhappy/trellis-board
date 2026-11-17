# 当前多客户端任务同步架构证据

## 范围

本文只记录 2026-11-17 当前代码和现场数据可核实的行为，用于后续设计，不包含实施改动。

## 活动任务下发与本地写入

- `packages/desktop/src-tauri/src/agent/task_sync.rs:6687` 的
  `retain_server_groups_for_binding()` 主要过滤归档与分支，没有按任务负责人限制。
- `packages/desktop/src-tauri/src/agent/task_sync.rs:4095` 的
  `apply_server_groups()` 会把服务端活动任务组写入本地。
- `packages/desktop/src-tauri/src/agent/task_sync.rs:7252` 的
  `write_task_directory()` 通过临时目录替换目标任务目录，不执行 `git add`。
- 因此服务端活动任务同步到当前仓库后会表现为未跟踪文件。

## 活动与归档是两条链路

- `.trellis/spec/backend/desktop-realtime-sync.md:12` 明确 Team Agent 只同步活动
  任务，`.trellis/tasks/archive/**` 不进入客户端扫描、watcher、cursor、pending 或上传。
- 归档由服务端独立读取目标分支 Git 的 `.trellis/tasks/archive/**`。
- `git show --name-status` 显示两个现场任务都在实现提交中加入活动目录，随后在独立
  archive 提交中移动到 `archive/2026-11/**`：
  - `3ef736d` -> `5aefa07`：`in-window-task-sync-dialog`
  - `8f948d1` -> `d60500f`：`fix-archive-filter-listener-dev-id`

## 现场重复副本证据

- 本地活动目录全部为未跟踪文件，归档目录为已跟踪文件。
- 本地两个活动目录的 12 个文件 SHA-256 均与服务端 `sync_task_space_file` 活动快照
  完全一致。
- 服务端这些活动文件记录仍为 `deleted=0`，没有收到归档删除墓碑。
- 服务端 `sync_task_index` 同时存在两份记录：
  - `.trellis/tasks/11-17-*`，`archived=0`
  - `.trellis/tasks/archive/2026-11/11-17-*`，`archived=1`
- 服务端任务快照记录显示活动文件由另一客户端在 10:21-10:32（Asia/Shanghai）
  上传，本地文件创建时间与拉取落地时间一致。
- 本地 Git 在 14:47-14:59 已包含两个 archive 提交，但未跟踪活动副本没有被删除；
  Git fast-forward 不会清理最终树中不存在的未跟踪文件。

## 当前创建与改派命令

- `packages/server/team/task-command-service.js:113` 的 `onlineTarget()` 要求目标
  taskSpace 至少有一个在线监听客户端，并要求目标用户存在唯一在线 Agent。
- 无在线 Agent 返回 `AGENT_OFFLINE`；多个 Agent 返回 `AGENT_NOT_UNIQUE`。
- `packages/server/team/http.js:1398` 的 `/api/tasks/assign` 与 `/api/tasks` 都通过
  task command 入队，目标客户端执行后还需要上传任务文件并等待索引完成。
- 当前模型是“目标客户端必须在线并负责产生任务文件”，因此不能直接支持离线创建或
  离线委派。

## 本地 Agent 创建任务

- 本地编码 Agent 通过 Trellis `task.py create` 直接写入
  `.trellis/tasks/<task>/task.json` 及相关文档，不调用 Team `/api/tasks`。
- Team Agent 的 watcher 和快照上传路径会把本地活动任务变化上传到服务端；服务端
  当前会从快照生成任务索引，但没有独立的任务记录表，也没有把“首次由本地创建”建模
  为权威任务注册事件。
- 因此本地创建任务本身可以出现在 Board，但当前仍受全量活动快照下发、pending、
  任务身份和归档双链路问题影响。

## 委派后的本地副本

- `write_task_directory()` 直接替换任务目录，不执行 `git add`；因此旧活动副本在
  客户端本地可能是未跟踪文件。
- Git fast-forward/merge 只管理已跟踪路径，不会自动删除最终树中不存在的未跟踪
  活动副本。
- 若没有服务端所有权变更或 handoff 清理事件，创建者本地的旧副本会一直存在，直到
  用户手动清理、客户端迁移或后续同步覆盖。
- 因此委派完成清理必须以服务端 materialization 成功为依据，并通过持久化 handoff
  状态通知创建者，不能只依赖目标本地目录出现。

## 当前通知能力

- Web 已有 `packages/web/src/components/ui/sonner.tsx` 的页内 toast 能力，可用于
  Board 可见时的非阻塞提示。
- 当前 `packages/desktop/src-tauri/Cargo.toml` 没有 Tauri notification 插件依赖，
  窗口隐藏或最小化时没有现成的系统通知通道。
- 现有实时控制事件会调用 `focus_main_window`，不能复用于本任务的单向认领通知；
  handoff 通知必须走独立、无聚焦的 UI/通知通道。

## 设计含义

- 需区分完整任务内容数据面和少量控制信息面。
- 服务端可以不向所有人广播完整任务正文，但不能完全取消定向下发/按需拉取控制信息。
- Git 只能作为任务文档最终历史和数据收敛通道，不能单独提供租约、待交付命令、
  归档墓碑及旧版本防复活。
