# 桌面实时任务同步

## 1. Scope / Trigger

- 修改 `shared/trellis-watcher.js`、`agent/live-sync.js`、`server/team/live-sync.js`、
  实时同步 API/SSE、`project_live_*` schema、桌面控制窗口或责任人确认时必须遵循本文。
- 单机 watcher 与团队客户端 watcher 必须复用同一目录过滤和事件归一化实现。
- 团队服务端不得监听自己的 `.trellis` 工作副本；团队实时内容只由已关联客户端上报。

## 2. Signatures

```text
POST /api/agent/live-changes/preflight
POST /api/agent/live-changes
GET  /api/agent/live-files?projectId&afterRevision
PUT  /api/agent/live-cursor
GET  /api/team/live-revision?teamId
GET  /api/board/events

AgentLiveSync({
  store,
  loadContext,
  logger,
  emitControl,
  watch?,
  debounceMs?
})

createLiveSyncService({
  db,
  taskIndex,
  agentEvents,
  now?,
  logger?
})

taskIndex.materializeLiveProject(project, rows, revision)
```

SQLite v7：

- `project_live_revision(project_id, revision, updated_at)`
- `project_live_file(project_id, relative_path, revision, sha256, content_text, deleted, ...)`
- `project_live_batch(batch_id, project_id, agent_id, user_id, revision, request_sha256, ...)`
- `agent_live_cursor(agent_id, project_id, revision, updated_at)`
- `team_task_index.live_revision` 非 0 表示该行由实时覆盖层投影。

SSE：Agent 事件流为 `live.changed`、`task.live.overridden`；Board 事件流为轻量
`tasks.changed`，只通知页面重新查询 REST 快照。

## 3. Contracts

- 文件路径以 `.trellis/` 开头，只允许 `.developer`、`tasks/**`、`workspace/**`。
- 首版只接受 `.json/.jsonl/.md/.txt/.yaml/.yml`；内容必须是规范 UTF-8。
- 单文件 ≤1 MiB、单批次 ≤8 MiB / 64 文件；同一 Agent+项目每秒最多 5 批。
- `batchId` 在 `(agent_id, project_id)` 内幂等；重试必须返回同一 revision，不同内容复用同一
  `batchId` 返回 `IDEMPOTENCY_CONFLICT`。
- 同一 Agent、同一项目的 `clientSequence` 必须单调递增；同一文件收到不高于已存来源序号的批次时
  跳过该文件。整批都被跳过时不得增加 revision、重投影或广播。`clientSequence` 属于幂等请求摘要，
  同一 `batchId` 改序号按冲突拒绝。
- sidecar 对同一项目的 watcher 批次串行处理和上传，避免旧文件快照晚于新快照到达服务端。
- `project_live_revision` 在 `BEGIN IMMEDIATE` 事务内单调递增。后到并成功提交的同文件版本覆盖先到版本。
- 服务端存储后必须复用 `scanRepository()` 和 `taskIndex.buildBoard()` 生成任务行；不能在 API 内另写阶段推导。
- Agent watcher 批次先按项目执行一次 Git dirty 判断，只读取和上传仍存在于
  `git diff HEAD` 或未跟踪文件集合中的路径。Git 状态判断失败时保留 pending，下一次监听或
  重试继续判断；已收敛的旧 pending 在展示或上传前删除。
- 服务端实时覆盖层物化必须在团队任务索引 Worker 中执行。HTTP 请求提交实时 revision 后只调度
  投影并返回；同项目最多一个物化在途，期间的新 revision 合并为下一轮最新快照，旧 worker 结果
  不得覆盖新 revision。
- 实时物化成功后再更新 `team_task_index`、内存 Board/详情并发布 `live.changed`。内存中已有
  投影时，幂等重放不得再次物化；`ensureProject()` 在投影缺失时只调度 worker，并允许调用方先
  使用上一份 Git Board。
- 实时物化失败保留已提交 revision 和上一份一致 Board，按 1/2/4 秒、最大 30 秒退避重试。
  服务关闭时停止重试计时器并终止 worker，失败的 Promise 不得继续重试。
- 实时物化的临时目录必须位于所有业务 Git 工作区之外，不能依赖接入项目配置 `.gitignore` 或服务端 Git 全局排除规则。
- 物化扫描只从临时目录读取 `.trellis` 内容，Git HEAD 与分支元数据仍从未修改的业务工作区读取。
- 幂等批次重放且内存中已有项目实时投影时，不得再次执行全量物化。
- 定时 Git 脏检查使用目录级未跟踪扫描，不能展开每个未跟踪文件；不得通过修改接入项目 `.gitignore` 降低扫描成本。
- 实时投影只给实际受覆盖文件影响的任务设置 `live_revision`；只有 `.trellis/.developer`、
  `.trellis/workspace/**` 或无法映射到具体任务的项目级覆盖才标记整个项目。
- 接收方先备份冲突文件，再临时写、fsync、原子 rename；全部成功后推进 `agent_live_cursor`。
- 冲突 manifest 文件明细记录路径、`taskKey`、文件自身 revision、摘要和
  `changeType=content|line-endings`；只有规范 UTF-8 且除 LF/CRLF 外完全相同才标记
  `line-endings`，该分类不改变备份和覆盖顺序。
- `remote_overwrite` 控制事件的 `taskKeys`、`files` 和 `fileCount` 只来自真实冲突文件；
  新增 `conflicts` 文件明细，同时保留旧字段兼容。事件中的全局 revision 不得替代文件自身 revision。
- 远端写入用 `(absolutePath, sha256)` 抑制 watcher 自触发；摘要变化时必须照常上传。
- Git 扫描后逐文件比较摘要；同路径一致或两边都已删除时删除覆盖行。仍有覆盖行时必须重新投影。
- 任务从普通目录移动到归档目录时，用归档目标和任务索引定位同名任务文件。目标内容一致时删除旧覆盖；
  内容不同且目标没有覆盖时迁移到归档路径，不能继续生成活动任务副本。
- `read_only` binding 可以拉取和落盘，但 preflight/upload 返回 403。
- 每个 approved binding 在进程启动或绑定签名变化时先执行 `afterRevision=0` 的 full pull，
  再补传关联前已存在的本地变化；初始化与 watcher 批次共用项目串行队列。
- 首次补传候选来自 `git diff --name-only -z HEAD -- .trellis` 与
  `git ls-files --others --exclude-standard -z -- .trellis`，并单独检查被忽略但存在的
  `.trellis/.developer`；与 full pull 摘要一致的路径不得重复上传。
- binding 的 `liveSyncStatus` 取值为 `pending|syncing|ready|error`。初始化、运行期上传和
  pending 冲刷共用该状态；初始化仍失败时，其他 pending 上传成功不能把项目误写为 `ready`。
- 初始化与 pending 冲刷重试必须单飞；同一绑定已有重试进行中时，后续触发复用同一 Promise。
- 非责任人确认返回 409 `ASSIGNEE_CONFIRMATION_REQUIRED`；继续保留责任人，接管形成新的实时 revision，
  原责任人通过 `task.live.overridden` 收到通知。
- 原责任人通知不能依赖其是否绑定 Agent。每次覆盖同时写入 `target_agent_id=NULL` 的用户级事件，
  `/api/team/live-revision` 只向当前登录、当前可读项目和指定团队范围内的目标用户返回最近通知；
  Board 按事件 ID 去重并显示警告。
- Board 通过同源 `GET /api/board/events` 接收 `tasks.changed`，收到事件后复用
  `/api/tasks/query` 的筛选、分页、ETag 和项目权限校验；SSE 不传输任务正文。
- `/api/team/live-revision` 保留为兼容接口，但 Board 只在 SSE 建连、任务变更、页面聚焦或恢复可见时
  按需查询，不再每 750ms 常态轮询。
- 桌面控制窗口在进程生命周期内只自动显示和聚焦第一次事件。用户点击系统 X 或
  “稍后处理”只隐藏窗口并抑制后续自动聚焦，不删除 `pending-live` 文件；运行时在内存队列中
  保留该事件。托盘“处理实时确认”是用户主动恢复隐藏窗口的入口。
- 同任务、同责任人的 `assignment_warning` 使用稳定 key 原位替换；`remote_overwrite` 使用
  `backupId`，`assignment_overridden` 使用任务和 revision 去重，不能因 watcher 批次追加重复项。

## 4. Validation & Error Matrix

| 条件 | 结果 |
| --- | --- |
| 非 approved binding、停用团队/项目、设备撤销 | 403，拒绝上传和拉取 |
| `read_only` 或无项目写角色上传 | 403 |
| 绝对路径、`..`、NUL、非允许扩展名、符号链接 | 400，整批拒绝 |
| 非规范 UTF-8、摘要不匹配、非法 operation | 400 |
| 单文件/批次/文件数超限 | 413 |
| 每秒超过 5 批 | 429，可重试 |
| 同一 batchId 不同内容 | 409 `IDEMPOTENCY_CONFLICT` |
| 责任人确认过期、revision 变化或动作无效 | 409，重新 preflight |
| 本地写入失败 | 保留备份，不推进 cursor，停止该批次后续写入 |
| SSE 断线 | 重连 `onOpen` 时从本地 cursor 补拉 |

## 5. Good / Base / Bad Cases

- Good：A 保存未提交 `task.json`，服务端 revision+1，B 收到 `live.changed` 后备份并写入同内容，
  Board 收到 `tasks.changed` 后立即通过 REST 对齐任务快照。
- Base：远端文件与本地摘要相同，不创建备份，只推进 cursor。
- Bad：服务端 Git 扫描删除全部 `team_task_index` 后不重放 live 覆盖行，导致 Board 回退。
- Bad：仅按路径和时间抑制 watcher，吞掉远端写入后紧接着发生的真实本地编辑。
- Bad：在 `/api/agent/live-changes` 的请求栈里同步复制整个 `.trellis` 并扫描，导致心跳、
  `/api/health` 和确认请求一起排队超时。
- Good：Git merge 写回与 HEAD 一致时 Agent 直接跳过；真实未提交编辑仍进入责任人确认。

## 6. Tests Required

- `tests/watcher.test.js`：共享过滤、防抖批次、动态 rebuild 和 close。
- `tests/team-realtime-sync.test.js`：幂等、revision、路径越界、read_only、详情/单项目 Board 实时投影、
  Git 收敛、继续与接管审计、`clientSequence` 乱序防回退、精确任务标记、无 Agent 的浏览器通知，
  Worker 临时物化、请求提前返回、健康检查 `<1s`、revision 合并、失败重试，以及两个真实
  `AgentLiveSync` 经 HTTP/SSE/watcher 连续同步 20 次的 P95 ≤3 秒断言。
- `tests/desktop-realtime-apply.test.js`：冲突备份、自触发抑制、真实编辑继续上报、待确认批次、
  继续上传、一键复原、本地写回、同一项目批次串行、首次 full pull 后续传、
  `read_only` 不上传、重启幂等、重试单飞和状态恢复。
- `tests/team-events.test.js`：`live.changed` 不回发来源设备。
- `tests/desktop-package.test.js`：`live-control` capability、Rust 命令、托盘恢复、关闭抑制和
  sidecar 控制窗口接线。
- Windows E2E：两个真实客户端完成 P95 ≤3 秒、并发覆盖、备份复原、断线补偿和责任人三态确认。

## 7. Wrong vs Correct

### Wrong

```js
// 每次扫描直接覆盖索引，没有重放实时覆盖层。
taskIndex.replaceProjectIndex({ projectId, board });
```

Git 内容较旧时会把团队刚推进的任务阶段静默回退。

### Correct

```js
taskIndex.setProjectIndexedHook((projectId) => {
  liveSync.convergeGit(projectId);
});

// 仍有摘要不一致的实时覆盖行时，重新 materialize 并 skipLiveHook。
taskIndex.replaceProjectIndex({
  projectId,
  board: liveBoard,
  skipLiveHook: true
});
```
