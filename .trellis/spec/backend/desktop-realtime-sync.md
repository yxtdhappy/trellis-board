# 桌面任务快照同步

## 1. Scope / Trigger

- 修改 `packages/shared/task-snapshot.js`、`packages/shared/remote-identity.js`、
  `packages/desktop/src-tauri/src/agent/{task_sync,task_command,task_control,onboarding}.rs`、`packages/server/team/task-space-*.js`、
  `packages/server/team/task-snapshot-service.js`、`packages/server/team/task-command-service.js`、
  `packages/server/team/sync-agent-service.js`、团队同步 API/SSE、`sync_*` schema 或看板内同步确认弹窗
  （`packages/web/src/desktop/LiveSyncControlDialog.tsx`）时必须遵循本文。
- 单机 watcher 与团队客户端 watcher 继续复用 `packages/shared/trellis-watcher.js` 的事件归一化；团队客户端
  只监听 `.trellis/tasks/**`。
- Team Agent 链路只同步活动任务；`.trellis/tasks/archive/**` 不进入客户端扫描、watcher、cursor、
  pending、冲突或上传。
- Team 服务端只对归档执行按 taskSpace 隔离的只读 Git 导入；不 checkout、不 commit、不 push，
  只读取目标分支的 `.trellis/tasks/archive/**`，不创建项目工作副本。
- 项目源码、`.trellis/scripts`、`spec`、`config.yaml`、`workflow.md`、`agents`、workspace 和本机
  编码 Agent 目录仍只由客户端使用。

## 2. Signatures

### Agent HTTP

```text
POST   /api/agent/task-spaces/preflight
POST   /api/agent/task-spaces/resolve
POST   /api/agent/task-spaces/attach
POST   /api/agent/task-spaces/:taskSpaceId/detach
GET    /api/agent/task-spaces/:taskSpaceId/snapshot?afterRevision=N
GET    /api/agent/task-spaces/:taskSpaceId/files?taskDir=...
POST   /api/agent/task-spaces/:taskSpaceId/preflight
POST   /api/agent/task-spaces/:taskSpaceId/changes
PUT    /api/agent/task-spaces/:taskSpaceId/cursor
GET    /api/agent/task-spaces/:taskSpaceId/conflicts
POST   /api/agent/task-spaces/:taskSpaceId/conflicts/:conflictId/resolve
GET    /api/agent/tasks/:executionTaskKey
POST   /api/agent/tasks/:executionTaskKey/claim
POST   /api/agent/tasks/:executionTaskKey/heartbeat
POST   /api/agent/tasks/:executionTaskKey/release
POST   /api/agent/tasks/:executionTaskKey/handoff-ack
GET    /api/agent/events
POST   /api/agent/commands/:commandId/start
POST   /api/agent/commands/:commandId/result
```

`POST /api/agent/commands` 旧长轮询固定返回 `410 AGENT_LONG_POLL_REMOVED`。Agent 协议版本为 `3`，
旧协议返回 `426`。

### Web HTTP

```text
GET  /api/tasks/query?[taskSpaceId=...][&projectIds=...][&branch=...]
GET  /api/task-spaces/:taskSpaceId/assignees
GET  /api/task-spaces/:taskSpaceId/listeners
POST /api/tasks
POST /api/tasks/assign
GET  /api/task-operations?taskSpaceId=...
GET  /api/task-operations/:id
POST /api/task-operations/:id/retry
POST /api/task-operations/:id/cancel
```

创建和改派成功先持久化任务、归属或待交付记录并返回 `202 + operation`，目标 Agent 离线时也允许排队；
目标用户上线并建立目标 taskSpace binding 后再领取命令。

Team Board 查询行必须携带 `materializationState`、`controlTaskVersion`、`handoffState`、
`leaseStatus`、`leaseExpiresAt`、`previousAssigneeUserId` 和身份冲突标记。`leaseStatus/leaseExpiresAt`
取该任务最新租约，不能只依赖 `sync_task.lease_id`，因为租约过期或释放时该指针会被清空。
`claim`、`lease release` 和 `handoff-ack` 改变控制面后必须推进查询版本并发布 `tasks.changed`；
Board 仍通过普通 REST 查询刷新，不从 SSE 接收任务正文。

Web 端 Team 模式创建/改派不要求当前 taskSpace 有在线监听，只在任务空间停用或账号只读时提前阻止；
最终写权限仍由服务端校验。`pending_delivery`、`claimed`、`lease_expired`、`version_stale`、
`migration_conflict`、改派和 handoff 状态必须显示为可读控制状态。正文尚未 materialize 时，
任务详情只展示服务端元数据和控制状态，禁止请求 `/api/task`、渲染产物或依赖分析；standalone
或没有控制字段的旧 Team 数据保持正文可用兼容。

`taskSpaceId` 可选：指定时查询单分支；缺省或 `all` 时按当前 `teamId` 和可选 `projectIds` 查询所有可读
taskSpace。服务端使用 `taskSpaces.listReadable()` 生成项目/任务空间集合并校验显式 projectIds。
ETag、缓存键和游标绑定用户、团队、项目/taskSpace 集合哈希、规范化 filters、query revision 和查询日；
分页以 `last_activity_at/archived_at + taskSpaceId + taskKey` 稳定排序。
`branch` 为可选单值子串筛选，trim 后大小写不敏感匹配，`%`、`_` 等字符按字面处理。
分支匹配使用与前端一致的 Unicode 小写语义，不能直接依赖 SQLite 内置 `lower()`，它只折叠 ASCII。
归档查询（`archived=true`）不使用全局 query revision，而是绑定独立归档域版本
`app_meta.archiveQueryRevision`：只有索引里归档行新增、修改、删除或归档标记翻转才推进，活跃任务同步不再
改变归档查询的 ETag、缓存键和游标。`/api/team/status` 同时返回 `queryRevision` 与 `archiveRevision`，
`statusEtag` 覆盖两者；不新增 SSE 事件名。

### SQLite v15

新模式只使用以下表；旧 `project_live_*`、`team_project`、`git_operation`、`git_credential`
等表保留但不读写：

- `sync_project`、`sync_project_team_access`、`sync_project_member`
- `sync_task_space`、`sync_task_space_file`、`sync_task_space_batch`
- `sync_active_agent`、`sync_agent_binding`、`sync_agent_cursor`
- `sync_task_index`、`sync_task_index_tag`、`sync_task_space_scan_cache`
- `sync_task_merge_evidence`
- `sync_task_assignment`
- `sync_task_command`
- `sync_conflict`、`sync_conflict_backup`、`sync_file_audit`
- `sync_archive_file`、`sync_archive_file_history`、`sync_archive_git_credential`
- `sync_archive_snapshot`
- `sync_archive_sync_config`、`sync_archive_sync_state`、`sync_archive_sync_log`

v12 在 `sync_agent_binding` 上增加 `is_listening`、`listener_reported_at`、`last_listener_at`，
并在 `sync_task_space` 上增加 `retired_at`、`retired_by_user_id`、`retired_reason` 和
`sync_task_space_retired(project_id, retired_at, status)` 索引。在线监听必须同时满足 binding 已批准、
最近监听报告和设备心跳未过期、账号当前 active Agent、项目与 taskSpace 均 active 且
`retired_at IS NULL`。旧 v10 binding 缺少监听报告时派生为 `unknown_legacy`，不得伪造在线。

`retired_at` 是唯一的弃用标记；历史 `status=disabled` 且 `retired_at IS NULL` 仍表示技术停用，
不得自动按弃用处理。

v12 在 `sync_project` 上增加 `baseline_branch`，并增加 `sync_task_merge_evidence` 与
`sync_task_space_file(task_space_id, task_id, deleted)` 索引。新项目首次接入的分支成为基线；
旧库优先选择最早创建的活动 taskSpace，时间相同按 ID 稳定排序。项目 public 返回
`baselineBranch`，taskSpace public 返回 `isBaseline`。

v14 增加独立归档事实源和双 revision。`sync_task_space_file` 只保存活动任务；归档正文进入
`sync_archive_file`，由服务端按分支 HEAD 导入。`sync_task_space.revision/indexed_revision`
只表示活动 Agent 数据，`archive_revision/archive_indexed_revision` 只表示 Git 归档；
`sync_task_space_scan_cache.indexed_archive_revision` 参与 Board cache current 判定。
v13 -> v14 在 `VACUUM INTO` 备份后把旧归档行复制为 `blob_oid='legacy'` 的只读缓存，并从
Agent 文件表、pending conflict 和客户端 cursor 迁移路径中移除归档。首次 Git 成功导入前旧归档
仍可读，成功后由 Git 快照替换。

v15 把 Git 归档导入结果保存为不可变本地快照。`sync_archive_snapshot` 记录来源 HEAD、
active 标记、存储根、文件数、字节数和 manifest 摘要；`sync_task_space` 保存 active/candidate
快照指针；`sync_archive_file` 只保存当前候选/active 的文件元数据、SHA-256、MIME、
`storage_key` 和文本摘要投影，不再写入正文；`sync_archive_file_history` 保存被替换但仍需供
旧 Board fileId 访问的不可变映射。导入不得退役 active，候选只在索引事务成功时原子激活。
v14 legacy `content_text` 保留为只读回退。

v16 增加 `sync_task` 权威任务与 `sync_task_lease` 写租约；`sync_task` 同时保存 materialization、
handoff 来源清理状态、目标 materialization revision 和 manifest 摘要。已有任务的普通上传必须携带
`taskVersion`、`leaseToken` 和 `observedBranchName`；未知本地任务的首次上传仍可由认证用户建立
权威记录并返回一次性 lease。归档、改派、非负责人、版本落后和租约无效均失败关闭。

### 服务与 SSE

```text
createTaskSpaceService({ db, config, backupService })
createTaskSnapshotService({ db, taskSpaces, onRevisionCommitted })
createTaskCommandService({ db, taskSpaces, agents, events })
createSyncAgentService({ db, config, events })
createTaskSnapshotBackupService({ db, databaseFile, logger })
createAgentEventStream({ db, commands, logger })
createArchiveGitSyncService({ db, config, dataDir, taskSpaceIndex, snapshots, logger })
```

Agent SSE 事件为 `command`、`control.changed`、`agent.revoked`、`task.changed`、
`cursor.invalidated`。
Board SSE 继续只发送 `tasks.changed`，页面收到后重新查询 REST 快照，不通过 SSE 传输任务正文。

- `task.changed.revision` 必须是非负安全整数。服务端按 taskSpace 在内存中保存最后已广播 revision，
  相同或更旧 revision 不重复广播；该状态不持久化，服务重启后的客户端重连补偿仍负责一致性。
- 客户端仅在首次同步已完成、没有 initial review、没有 pending upload，且事件 revision 不新于本地
  cursor revision 时短路并返回 `{ skipped: true, reason: "REVISION_CURRENT" }`；其余情况必须按
  原路径拉取。

## 3. Contracts

### 项目与任务空间身份

- 项目身份是规范化 Git 远端：HTTPS/SSH/scp 的协议、userinfo、默认端口、末尾 `/` 和 `.git`
  差异归一；`remote_identity_hash` 全局唯一。
- 同步空间身份是 `canonicalRemoteIdentity + branchName`，即
  `sync_task_space UNIQUE(project_id, branch_name)`。
- 同一仓库不同分支拥有独立 project taskSpace、revision、cursor、命令、冲突和索引。
- 默认任务查询、计数、负责人筛选、分页和 Board 项目计数共用基线去重条件：基线 taskSpace 的
  `sync_task_index` 已有同一项目稳定 task ID 时，来源 taskSpace 旧副本不返回。显式 taskSpace
  快照接口仍保留来源数据；查询行用 `sourceBranchName` 暴露证据中的来源分支。
- 同一 Agent 的同一 `localRepoKey` 只能有一个 approved binding。切换分支必须显式替换旧 binding；
  旧 taskSpace、任务数据和其他设备 binding 不删除。需要同时同步多个分支时，每个分支使用独立 Git worktree。
- 活动任务同步信任已认证 Agent 上报的 origin 字符串，不访问 Git 远端证明其存在；Agent 必须先验证
  所选目录是仓库根、origin 可规范化、当前分支合法。归档同步例外：服务端使用管理页按
  `scheme + host + port` 配置的只读凭据，只 fetch 对应 taskSpace 分支的归档对象。

### 单账号单 Agent

- `sync_active_agent(user_id PRIMARY KEY, agent_id UNIQUE)` 决定账号唯一有效 Agent。
- 新设备生效时，同一事务撤销旧设备、旧 binding，取消旧 pending/delivered/running 命令，替换活动槽，
  再向旧 Agent 发布 `agent.revoked` 并关闭 SSE。
- 账号级项目权限保留；旧设备本地仓库绝对路径和 binding 不迁移。新设备必须手动选择本地仓库。
- 只有 active Agent、approved binding、active project/taskSpace 和可写项目成员可上传快照或领取命令。
- `attach` 在同一事务中撤销当前 Agent 使用相同 `localRepoKey` 的其他 binding，取消其
  `pending/delivered/running` 命令，并返回 `replacedBindings` 供客户端更新本地状态。

### 监听与主动解绑

- 新 Agent 心跳保持协议 v3，并可选携带 `listenerReportVersion=1` 与最多 64 个去重后的
  `listeningTaskSpaceIds`。该数组是当前真实监听集合的完整快照，空数组表示没有监听；
  未携带字段的旧 Agent 只更新设备心跳，不修改 binding 监听状态。
- 客户端每次心跳前重新读取配置并校验真实 Git 分支，排除 `detachPending`、非 approved、
  门禁错误或已撤销 binding；服务端在同一事务更新全部 approved binding 的报告时间，并只对
  上报集合设置 `is_listening=1`。
- 客户端本地绑定集合真实变化或一次任务同步结束（`finish_binding_sync`）后必须唤醒心跳循环
  立即上报，不得等 15s 周期；唤醒只提前下一次心跳，成功仍重置周期，失败保持指数退避。
- 服务端同一事务前后比较 approved 且 `is_listening=1` 的 taskSpace 集合，只有集合不同才发布
  看板变更事件；重复心跳和旧客户端心跳不得重复发布。
- taskSpace 监听状态固定按 `disabled -> online -> unassociated -> unknown_legacy -> inactive`
  派生。`unassociated` 表示 approved binding 已为零；`inactive` 表示仍有 approved binding
  但当前无人监听。
- `POST /api/agent/task-spaces/:taskSpaceId/detach` 只允许当前 active Agent 撤销自身的
  `localRepoKey` binding。事务内写 `revoked`、`is_listening=0`，取消该 binding 的
  `pending/delivered/running` 命令、删除服务端 cursor 并只写一次解绑审计；重复调用幂等，
  不删除 taskSpace、任务、冲突或历史。
- 客户端主动解绑必须先原子写 `detachPending=true`，立即停止 watcher、上传、补同步和命令执行；
  服务端成功后才删除本地 binding 与该 taskSpace 的 cursor 全量状态。网络失败保留待确认状态，
  后续心跳重试；非重试权限或仓库错误保留真实原因，不得伪报成功。

### 路径与内容

- Agent HTTP 只接受 `.trellis/tasks/<task-dir>/<file>`；任何
  `.trellis/tasks/archive/**` 路径返回 `409 ARCHIVE_SYNC_SERVER_MANAGED`，不做部分写入。
- 服务端 Git 导入器只接受
  `.trellis/tasks/archive/<YYYY-MM>/<task-dir>/<file>`，月份必须是 `01` 到 `12`。
- 拒绝绝对路径、反斜杠、NUL、`.`/`..`、符号链接、非白名单扩展名和非 UTF-8 内容。
- 允许 `.json/.jsonl/.md/.txt/.yaml/.yml`；单文件不超过 1 MiB，单批正文不超过
  64 MiB / 1024 文件。JSON 请求和 Agent 大响应使用编码后 96 MiB 硬运输上限，运输上限
  不参与业务写入；超过 96 MiB 即使解码后正文不超过 64 MiB 也返回 413。
- 全 taskSpace 扫描和按任务目录分组不是单个上传批次，聚合结果可以超过 64 MiB / 1024 文件；
  客户端只在写 pending 或重试 pending 的实际文件数组上校验批次上限。
- 客户端和服务端都用 `normalizeSnapshotText()` 去除 BOM 并把 CRLF/CR 转为 LF，再用
  `snapshotSha256()` 计算摘要；客户端必须用 fatal UTF-8 解码，服务端必须拒绝
  `sha256` 与规范化内容不一致、`baseSha256` 非法或格式错误的记录。
- 服务端每秒最多接受每个 Agent/taskSpace 5 个批次。
- 客户端必须主动遵守服务端批次上限：同一 taskSpace 的上传请求完整结束后至少等待 260ms
  才可开始下一批；收到 `429 RATE_LIMITED` 时最多重试 2 次，且必须复用原
  `batchId/clientSequence/files`。不得一次 bootstrap 连续裸发几十个任务批次。

### 原子批次与 CAS

`POST changes` 请求：

```json
{
  "batchId": "uuid",
  "clientSequence": 12,
  "observedBranchName": "main",
  "taskVersion": 3,
  "leaseToken": "<claim 返回的 token>",
  "mergeEvidence": {
    "version": 1,
    "type": "tracked-in-head",
    "taskId": "task-a",
    "taskDir": ".trellis/tasks/task-a",
    "trackedPath": ".trellis/tasks/task-a/task.json",
    "sourceBranch": "dev1",
    "baselineBranch": "dev",
    "headCommit": "<40 或 64 位小写 SHA>"
  },
  "files": [
    {
      "path": ".trellis/tasks/example/task.json",
      "content": "{\"id\":\"example\"}\n",
      "sha256": "...",
      "baseSha256": "..."
    }
  ]
}
```

- Agent 必须在每次实际请求发出前读取真实 Git 分支并上报 `observedBranchName`。HTTP 层缺失时返回
  `400 BRANCH_OBSERVATION_REQUIRED`；服务端还必须校验它同时等于 taskSpace 和 approved binding 的
  `branchName`，否则返回 `400 BRANCH_TASK_SPACE_MISMATCH`。
- `observedBranchName` 不进入 `sync_task_space_batch.request_sha256`。升级前持久化的 pending batch
  重试时可补上该字段，但仍必须复用原 `batchId/clientSequence/files`。
- 服务端已存在权威任务时，`taskVersion` 与 `leaseToken` 是必填 fencing 字段；pending 重试可重新
  claim/heartbeat 获取新 token，但不能改变原 `batchId/clientSequence/files/mergeEvidence`。
- 客户端把 claim 响应中的 taskVersion、lease token/expiry 保存到
  `%LOCALAPPDATA%\TrellisBoard\data\agent\task-control-state.json`。重启后 pending batch 先从该状态
  恢复租约并 heartbeat；租约失效再重新 claim。
- 冲突处理 `overwrite-server` 与普通上传使用相同分支上报和校验，不能绕过门禁。
- `baseSha256=null` 表示客户端认为路径不存在；64 位摘要表示基于的服务端当前内容。
- 服务端在 `BEGIN IMMEDIATE` 中逐文件比较当前摘要；任一不一致整批拒绝，不写入部分任务。
- `mergeEvidence` 可选；存在时进入请求摘要。同一请求的
  `batchId + clientSequence + files + mergeEvidence` 摘要幂等重放返回原 revision，同 `batchId`
  不同摘要拒绝。pending batch 必须持久化原证据并原样重放。
- 基线 taskSpace 首次接纳 `task.json.branch != baselineBranch` 的任务必须携带
  `tracked-in-head` 证据。服务端只验证身份、binding、taskSpace、项目基线、任务 ID、目录和分支一致，
  不运行 Git；证据是受信基线 Agent 的声明。缺少证据返回 `409 TASK_MERGE_EVIDENCE_REQUIRED`，
  不匹配返回 `409 TASK_MERGE_EVIDENCE_INVALID`。
- 基线已有同一稳定任务 ID 时不要求重复证据。来源 taskSpace 在基线接管后新增、修改、移动或删除
  该任务返回 `409 TASK_OWNED_BY_BASELINE`，旧快照和审计保留。
- `clientSequence` 在同一 Agent/taskSpace 内必须严格递增。
- 同一批最多涉及一个完整活动任务目录。活动目录移动到归档目录时，Agent 只提交旧活动路径的删除
  墓碑；不得提交新归档路径，归档正文由下一次服务端 Git 导入产生。
- 成功且有变化的批次只增加 taskSpace revision 一次，并写 `sync_file_audit`；无变化批次不增加 revision。
- 删除保留 `deleted=1` 墓碑供增量拉取；full snapshot 不返回墓碑。
- 服务端索引使用进程内 warm 基线做目录级增量物化；同一 taskSpace 的 enqueue 与详情兜底共享
  single-flight。扫描期间出现新 revision 时只丢弃旧派生候选，已提交文件和审计不回滚；最终
  `indexed_revision` 必须通过事务内 revision 复核追到最新快照。
- 服务重启没有 warm 基线时允许一次 full 重建，期间保留上一份一致 Board cache。只退出并重开桌面
  客户端不会重启服务端，因此不得触发服务端第二次全量任务扫描。

### revision、cursor 与本地应用

- 首次接入使用 `afterRevision=0` 获取当前完整快照；已接入客户端重启从本地 cursor 增量拉取。
- 只有本地完整应用后才推进本地 cursor，再上报 `PUT cursor`；服务端 cursor 使用
  `MAX(existing, incoming)` 防止回退。
- 客户端 cursor v3 额外保存每个已同步文件的服务端摘要。增量上传的 `baseSha256` 必须来自
  上次成功应用或上传后的本地基线，不能在提交前临时读取服务端最新摘要来充当基线，否则会
  绕过离线并发冲突。
- `write_cursor` 只在 revision、sequence、baselines、deferred、ownershipPending、conflictBlocked、
  readonlyTaskDirs 或 pending 发生实际变化时更新 `updatedAt` 并原子替换文件；缺失 pending upload 的重复 revision、
  相同 patch 或只刷新时间的调用不得重写 `live-cursors.json`。
- 目录级 `fetch_directory` 失败分三类：`403`/`TASK_WRITE_FORBIDDEN` 写 `readonlyTaskDirs` 并跳过该目录
  （不中断整次 pull、不上传、不写 baselines，目录消失或控件 assignee 变回本人时解除）；`TASK_ARCHIVED`/
  `ARCHIVE_SYNC_SERVER_MANAGED`/`404` 直接跳过；其余错误必须经 `with_task_dir` 注入 `details.taskDir`
  再上抛，日志与 `task_sync_error` 事件同时携带 `errorCode`/`serverCode`。
- 服务端明确返回 `TASK_ARCHIVED` 或 `ARCHIVE_SYNC_SERVER_MANAGED` 时，客户端除执行既有
  `cleanup_archived_residue`（仅当归档副本存在且内容摘要一致才删除本地活跃残留）外，还必须在同一次
  目录上传返回前用一个 `task_dir_removals` cursor patch 批量移除这些目录的 baselines（按
  `{taskDir}/` 前缀匹配文件路径）和 deferred。否则已移入 archive 的目录仍留在 cursor 基线里，
  每轮 pull 都把它判为 dirty，upload 反复收到 409，`pull_tracking` 无法应用快照、已应用 revision 停滞。
  该 patch 只清理本地同步状态：不删除本地文件内容，不清理 `ownershipPending`/`pendingRejected`
  （服务端摘要删除仍由 `cleanup_missing_ownership_inbox` 负责），也不改动 `conflictBlocked`/
  `readonlyTaskDirs`。只有清理后本地活跃目录确实不存在时才移除基线；本地仍留有内容（例如归档副本缺失
  或内容不一致）时保留基线，行为与修复前一致，由用户处理残留。
- 每次拉取前先比较本地任务目录与 cursor 基线：本地有未上传变化时先走 CAS 上传；上传成功后再
  拉取新 revision，发生冲突时停止应用远端目录。首次接入选择“仅同步无冲突项”或“暂不处理”
  跳过的本地目录作为延后状态持久化，用户再次修改前不得自动上传；延后目录随后被服务端修改时
  重新要求确认，不能覆盖本地。
- 正常 pull 使用 cursor 基线与本次增量合并后的 `snapshot_baselines`：只有延后指纹仍等于本地
  完整任务状态、本地文件非空，且该任务目录的服务端基线在路径集合和每个 SHA256 上完全一致时，
  才删除 deferred 并跳过 dirty 上传。服务端基线与延后指纹仍一致但本地已变化时，沿用原逻辑删除
  旧 deferred 并按 cursor 基线判断 dirty；本地任务目录缺失或为空、服务端缺文件、摘要不同或
  基线不完整时保留 deferred，进入现有受保护审查路径。
- 进程启动或 binding 首次进入运行集合时复用现有 pull，即使服务端 revision 未变化、快照文件
  为空也执行一次上述比较；同一进程后续 heartbeat 使用原有绑定集合短路，不重复扫描任务正文。
  `list_local_associations` 的 3 秒展示轮询不得承担收敛扫描。
- 只有因本地、deferred 指纹和合并服务端基线完全一致而收敛的任务，才不得在同一次
  `pull_and_report` 的基线任务补交中自动上传；本地状态变化导致的 deferred 移除仍走原有
  基线补交逻辑，其他既有候选也保留原行为。
- `list_local_associations` 可以把当前 taskSpace 的延后目录只读投影为
  `deferredCount/deferredTaskDirs`；缺失或损坏的 cursor 按 0 处理，不能阻断关联列表。
- 延后任务的实际内容只能通过用户显式触发的补同步命令上传；与服务端已知基线完全一致时的
  deferred 自动清除不算上传，不写 pending、不推进 revision。补同步必须校验 approved、
  非只读 binding，复用同一 taskSpace 串行队列、限流、pending batch 和文件级 CAS；网络失败
  必须向调用方抛错，冲突必须进入现有 `task_file_conflict` 确认链路。
- Agent 在首次同步、增量 pull、上传、watcher 触发、pending retry、延后补同步、服务端目录实际写入
  以及冲突覆盖前都必须重新读取本地真实分支。分支不匹配时失败关闭：不写任务目录、不上传、不推进
  cursor、不补发 pending，并把 `BRANCH_MISMATCH` 投影到项目栏；切回绑定分支后才可恢复。
  该绑定在暂停期间不进入运行集合：不拉取、不监听任务文件、心跳不上报在线监听，`pull_task_space`
  返回 `skipped/BINDING_INACTIVE`。分支守卫错误只按“进入暂停”的状态边沿发一次非模态
  `task_sync_notice`，不得每轮心跳重复弹窗；切回绑定分支恢复后再次进入暂停才可再次提示。
  边沿判断必须读取刚持久化的 `last_error_code`，通知由 `assert_binding_branch` 自己发射，
  不能依赖某个调用方（ownership 校验、事件 pull、心跳选择等共享同一守卫）；心跳写入的
  `BINDING_BRANCH_MISMATCH` 也视为已暂停状态，避免错误码交替导致重复提醒。
- 普通同分支任务不得读取 HEAD tree。只有当前 binding 是项目基线且遇到来源分支不同的任务时，才允许
  一次 `git rev-parse --verify HEAD^{commit}`；同一 HEAD 下执行一次
  `git ls-tree -r --name-only <HEAD> -- .trellis`，多项任务共享 HashSet。普通 watcher、普通上传、
  同分支任务和同 HEAD 后续判断都不得重复 `ls-tree`。
- 进程内 HEAD tree 缓存键为 binding、真实分支和完整 HEAD SHA；跨进程复用只允许读取
  `ownership-index.json` 中 HEAD/ref 指纹未变的 tracked paths。指纹变化或直接读取失败时必须按上述
  规则重新精确校验。只有精确的 `<taskDir>/task.json` 在 HEAD tree 中才生成证据。仅工作区存在、
  仅从服务端拉取或任务目录未提交均保持暂停。
- ProjectRail 的归属展示投影允许按 binding 缓存 15 秒，但缓存只能避免重复计算，不能放宽上传门禁。
  投影只枚举 `.trellis/tasks/**` 的目录和文件元数据，并读取各任务根部的 `task.json` 取得
  `branch`；不得读取、UTF-8 解码、规范化或哈希 `prd.md`、报告、JSONL 等其他任务正文。
  真实上传、冲突覆盖、延后补同步和 HEAD 证据生成仍必须执行完整文件读取、摘要与精确校验。
- ProjectRail 可跨进程复用 `<agent data>/ownership-index.json`。索引 schema 为 `3`，按 `localId`
  保存 taskSpace/repo/branch/baseline 身份、HEAD/ref 与 Git index 指纹、当前 HEAD 的
  `task.json` tracked paths、任务目录及 `task.json` 的 size/mtime/摘要/`id`/`branch`、paused 和
  localDirs、每个支持任务文件的相对路径/size/mtime/摘要、文件缓存完整性，以及当前脏任务目录；
  不得保存任务正文。索引命中时允许先返回只读投影，后台再增量校验；runtime 未 ready 时也只读
  该文件，不回退到全任务正文扫描。
- 运行中的 Agent `TaskSync` 是索引唯一写者，临时 `TaskSync` 只读。稳定启动先用一次
  `git status --porcelain=v1 --untracked-files=all -- .trellis/tasks` 取得脏任务目录，再与索引中的
  上次脏目录取并集；干净目录不递归枚举，只扫描该并集。任意任务文件的 size/mtime 均未变化时，
  启动 pull 不得重新读取正文或计算摘要；`task.json` 同时复用 `id/branch`。HEAD/ref 指纹未变时
  不得执行 `git ls-tree`，指纹变化时每仓库最多一次；rename/copy 或状态失败时回退全量扫描。
  启动期 ownership 增量校验与 pull 必须由同一后台链串行执行，不能让 ownership worker 与完整快照
  扫描同时运行。写盘使用原子替换，schema/binding/路径/符号链接/大小或条目上限校验失败时回退现有
  权威扫描；任何上传、pull、merge、冲突覆盖和 ownership 写操作都不得使用该展示缓存短路。
- 投影 TTL 到期时只复核真实分支和完整 HEAD；HEAD 未变化时刷新 TTL 并复用现有目录/暂停集合，
  不得重新枚举任务目录或执行 `ls-tree`。watcher 收到该 taskSpace 的 tasks 事件、binding 变化、
  HEAD 变化，或实际 `task.changed` pull 写入本地任务目录后才失效；失效必须递增代际，旧代际的
  慢速计算结果不得回写缓存，避免失效后重新出现 15 秒陈旧状态。
- 桌面 HTTP 客户端访问回环、RFC1918 私网、链路本地地址、IPv6 ULA/link-local 或 `.local`
  主机时必须绕过系统代理。公网域名继续遵循系统代理；内网业务域名即使解析到私网 IP，当前也不会
  根据 DNS 结果自动绕过，部署时必须显式配置 `NO_PROXY`，后续可增加
  `proxyMode=auto|system|direct` 的显式配置。
- SSE 重连和事件触发的补拉只能遍历运行时激活的 binding。未激活 taskSpace 返回
  `{ skipped: true, reason: "BINDING_INACTIVE" }`，不能按未知 binding 抛异常；所有
  fire-and-forget 补拉必须处理 rejection，单个 taskSpace 失败只能记日志，不能终止 Agent 进程。
- 客户端以完整任务目录为原子单位：先在同卷临时目录写 `next`，把原目录 rename 为 `previous`，
  再 rename `next` 到目标；失败时恢复原目录。
- 服务端 revision 应用后的 watcher 事件按 `(absolutePath, sha256)` 抑制；只有内容仍匹配才吞掉事件，
  真实后续编辑必须重新上传。
- 同步队列按 taskSpace 串行。网络响应丢失时 cursor 中保留原 pending batch，重试复用原 `batchId`，
  不生成第二个 revision。
- 常驻 Agent 与控制 Sidecar 是不同进程，`AgentTaskSnapshotSync` 不得永久缓存
  `live-cursors.json`；每次预占批次和提交游标都必须在 `.live-cursors.lock` 内重新读取并原子写回。
- 新批次在锁内先持久化 pending，再发网络请求。已有 pending 时优先按原
  `batchId/clientSequence/files` 重放；迟到响应只有同时匹配 pending 的批次和序号时才能清除它，
  较旧响应不得覆盖较新文件的基线。
- 服务端继续拒绝非递增 `clientSequence`，并在 `409 CONFLICT` 的
  `details` 返回 `previousSequence/requiredClientSequence`。客户端只可按明确返回值自动修正一次
  pending 序号并复用原批次；第二次冲突或非法提示继续交给正常错误处理。
- 中断后恢复 `bootstrap` 时，只有服务端已有任务全部为 `same` 且其余差异均为 `local-only`
  才允许继续上传剩余本地任务。上传结束后必须重新获取 full snapshot；只有全部收敛为 `same`
  才能写 cursor 和 `initialSyncCompleted=true`，否则重新进入差异审查。
- snapshot 缺少 `controls` 时按旧服务端兼容路径处理；字段存在时，即使为空也是权威控制面。
  客户端只落地 `materialized/claimed/pending_delivery`，且落盘前必须 claim。creator 的
  `handoff_materialized` 以及 `archived/reassigned` 不得触发服务端正文写入。
- `archived/reassigned` 只保留本地数据、释放已知失效 lease、记录控制状态并停止 watcher 上传；
  归档正文仍由服务端只读 Git 导入收敛。
- `handoff_materialized + source_cleanup_pending` 只进入 creator 本地清理通道。客户端先验证真实目录、
  服务端执行身份、cursor baseline、完整文件集合摘要和 Git `??` 状态；超过 100,000 文件或 64 MiB
  规范化文本时 ACK `conflict/backup_too_large`。符合条件时把完整目录复制到
  `live-backups/<taskSpaceId>/handoff-<manifestSha256前16位小写hex>`。备份包含
  `handoff-manifest.json`、来源 taskSpace、materialized revision、文件数、字节数和创建时间；
  写入后必须回读验证 manifest 摘要、完整文件集合、逐文件摘要和规范化大小；复制失败必须删除本次新建的
  不完整目标。`cleaned` ACK 必须先持久化为 pending，删除成功后再发送。
- 任一内容、归属或 Git 状态不一致时不得删除正文，ACK `conflict`。dirty/tracked 副本保留；ACK
  网络失败和进程重启只保留持久 pending，由后续控制同步或事件短路路径继续重试。控制面
  `leaseHeldByOtherUser=true` 时 ACK `conflict/lease_active`，服务端也可能返回
  `409 HANDOFF_LEASE_HELD`。重试 `cleaned` 前必须重新验证完整备份，缺失时改为 `conflict/missing`，
  本地检查异常时改为 `conflict/unknown`。删除前再次校验来源摘要和真实分支，并通过
  `.trellis/.agent-handoff-cleanup-<uuid>` 原子改名后再清理；遗留暂存目录由后续同步收敛。
- 本地 `ackState/outcome/reason/backupId/manifestSha256/fileCount/totalBytes` 属于**单个物化
  轮次**，轮次标识取控制面 `materializedAt`（缺失时回退 `materializedRevision`）。同一
  `executionTaskKey` 再次收到 `source_cleanup_pending` 且轮次标识变化时，必须先丢弃上一轮 ACK
  终态（重置为 pending、空 outcome、清空备份字段与通知去重状态），再执行完整清理；只有同一
  轮次内才允许 pending 重试与 done 幂等。旧状态文件缺少轮次字段时，遇到携带轮次标识的控制必须
  按新一轮自愈。两轮内容完全相同时允许复用内容寻址的 `handoff-<sha16>` 备份，不重复复制。
- `task_handoff` 不进入 `ControlHub`，不聚焦或激活窗口。Board 通过独立
  `handoff-control-changed` 事件和 `handoff_notice_pending` 命令读取状态。通知去重键由
  `executionTaskKey + handoffState + outcome` 组成，同一任务进入 conflict、cleaned 等不同阶段时仍可
  各提示一次。Board 可见时使用 Sonner；隐藏或最小化时仅在 WebView 暴露 Web Notification API 且权限
  已授予时尝试系统通知，API、权限或安全上下文不可用时降级为持久页内状态并在恢复可见后补提示。
  冲突状态持续显示非模态页内提示；固定页内状态只展示冲突和处理中项。

服务端 `POST /api/agent/tasks/:executionTaskKey/handoff-ack` 的 `cleaned` 必须包含合法
`backupId`、64 位 manifest SHA-256、正文件数和正总字节数；冲突 reason 只接受固定白名单。
已完成终态的重复 ACK 只有在全部审计元数据一致时才幂等成功，否则返回
`409 HANDOFF_ACK_MISMATCH`。租约字段只暴露布尔值，不返回租约令牌或其他客户端标识。

### 首次接入预检

首次接入必须分成“只读预检”和“明确接入”两个阶段。客户端先调用无 taskSpace ID 的
`POST /api/agent/task-spaces/preflight`，请求只包含规范化前的远端、分支和团队。服务端仅按当前
Agent 账号和团队访问权限读取项目、taskSpace、revision 与任务文件元数据，不建立 project、
taskSpace、binding 或 cursor，也不返回任务正文。返回结果按稳定 task ID 分类：

```json
{
  "status": "new | branch_new | access_required | unavailable | existing",
  "revision": 12,
  "tasks": [
    {
      "taskId": "task-id",
      "taskDir": ".trellis/tasks/task-id",
      "files": [{ "path": ".trellis/tasks/task-id/task.json", "sha256": "..." }]
    }
  ]
}
```

`new`、`branch_new`、`access_required` 和 `unavailable` 不返回任何任务元数据。只有 `existing`
且项目、taskSpace 均可用时才返回任务分组；客户端使用这些元数据与本地文件摘要分类：

- `same`
- `local-only`
- `server-only`
- `content-conflict`
- `move-delete-conflict`
- `invalid`

界面提供三个入口：

- 暂不接入：只关闭向导并清除待接入路径，不调用 attach，不写本地 binding/cursor，不写服务端。
- 仅同步无冲突项：只下载 `server-only`，跳过本地独有、冲突和移动删除争议，不上传本地内容。
- 查看并处理差异：按任务目录统一选择服务端、本地、保存副本或跳过，不能写半个任务。

服务端没有快照时返回 `new` 或 `branch_new`。用户确认接入后使用内部 `bootstrap` 模式，把空
服务端任务空间初始化为当前本地任务快照；只有这种情况允许首次上传本地任务。若预检到接入之间
其他客户端已经写入服务端任务，`bootstrap` 必须转为差异审查，不能盲目覆盖。

只有用户明确选择“仅同步无冲突项”或“查看并处理差异”后才调用 attach。新 binding 持久化
`initialSyncMode=bootstrap|safe|review` 和 `initialSyncCompleted=false`：

- `safe` 只应用服务端独有任务，不上传本地独有内容；
- `review` 有差异时只展示审查事件，不安装 watcher、不读写任务目录、不推进 cursor；
- 双方一致时直接完成，不显示空审查窗口；
- 完成后写 `initialSyncCompleted=true`，再启动 tasks watcher 和正常增量同步。

`initial_sync_review` 事件每次内容变化都必须唤起主窗口并弹出同步确认弹窗
（`agent_service::publish_control` → `focus_main_window`），
不受“每进程只自动聚焦一次”限制；否则审查未确认时 binding 永远停留在 `syncing`，主界面只剩
“正在同步已有任务”。主窗口通过 `live_control_show`（`agent_service::show_pending_control`）手动
唤起待处理事件，无待处理返回 `false`；`list_local_associations` 把
`binding.initialReviewPending` 投影为 `initialReviewPending`，供项目栏展示“等待确认任务差异”。

首次同步的差异分类只处理活动任务。服务端 snapshot、preflight 和目录读取均过滤归档；客户端
在分组和读取正文前过滤归档。归档不出现在 initial review、业务分支过滤或 bootstrap 二次校验中，
由 Board 查询读取服务端 Git 导入索引。

不得在 attach 后通过删除 binding 来实现“暂不接入”。服务端不提供该补偿接口。

### 冲突

CAS 失败返回 `409 TASK_FILE_CONFLICT`，包含 `conflictId`、任务名、路径、服务端 revision、
最后修改人、设备、时间、客户端基线、服务端当前摘要和可执行建议。普通界面先显示可读信息，
技术摘要放在次级详情。

处理动作：

- 查看差异：本地读取本地目录和服务端目录，逐文件返回内容差异。
- `use-server`：先备份本地完整目录，再用服务端目录原子替换。
- `overwrite-server`：重新核对冲突后摘要，保存服务端旧内容与新内容到 `sync_conflict_backup`，
  写新 revision 和审计，并标记冲突已解决。
- `save-local-copy`：复制本地完整目录到客户端备份，不改变服务端任务快照。

第一版不自动合并 Markdown、JSON 或 JSONL。

### 创建与改派命令

- `create_task` 和 `assign_task` 先按 `target_user_id` 写入 pending 命令，不要求目标 Agent 在线。
  只有目标用户存在唯一在线 Agent 且 approved binding 指向当前 taskSpace 时才投递；离线期间命令
  和权威任务/改派状态继续保留。
- Agent 收到 `command.available` 后先 `POST /commands/:id/start` 获取 `running` 租约；同一命令状态为
  `running` 时不并发执行。
- `delivered` 租约默认 5 分钟，`running` 租约默认 30 分钟；过期后恢复 `pending`。
- 创建操作调用目标仓库的 `.trellis/scripts/task.py create ... --no-start`，只允许新增目标任务目录。
- 改派只改目标 `task.json.assignee`；只保护该任务目录，其他源码或任务允许 dirty。
- 两种命令都拒绝仓库根、origin、分支不一致，存在 merge/rebase/cherry-pick/revert，或目标路径 dirty。
- 命令成功后必须先走同一 CAS 上传。`complete(status=succeeded)` 还要求 taskSpace 已索引到结果 revision、
  task 身份匹配；改派还要求索引中的负责人已更新，否则返回可重试的 `COMMAND_WAITING_INDEX`。
- 失败命令可用同一 command ID 和幂等键重试；成功或取消后不能重试。正式任务只在快照投影后出现。

### 首次项目接入与推送确认

- 客户端只接受 Git 仓库根；已有 `.trellis/tasks` 时直接预检，不重复初始化。
- 缺少 `.trellis` 或 `tasks` 时，客户端使用安装包内固定 Trellis runtime 执行初始化，Agent 工具只影响
  当前设备，可后续追加。
- 新初始化仓库不自动 commit/push。`checkInitialPush()` 先确认 `.trellis` 已进入 HEAD 且相关路径干净，
  再用 `git ls-remote origin refs/heads/<branch>` 比较本地 HEAD。
- 仓库预检必须返回 `hasCommittedTrellis`（由 `git ls-tree -r --name-only HEAD -- .trellis` 得出）。
  本地已有 `.trellis` 但 HEAD 中没有该目录时，首次推送门禁在接入向导关闭后重新打开仍必须保持；
  已从 Git 检出且 `.trellis` 已在 HEAD 的既有项目不得被误判为首次初始化。
- 只有新建 `.trellis` 或 `.trellis/tasks` 时才要求首次 push 确认；已有任务树仅追加本机 Codex、
  OpenCode、Pi 等 Agent 工具时，不把本机工具配置作为任务接入的推送门禁。
- 状态区分 `waiting_commit`、`waiting_push`、`branch_missing`、`remote_ahead`、`diverged`、
  `unable_to_verify`、`ready`；网络不可达不得显示为“未推送”。

### 备份

- v13 -> v14 / v14 -> v15 升级前使用 `VACUUM INTO` 写入当前目标版本的
  `backups/board.sqlite.pre-v15.*`；更早版本按
  原顺序迁移，最终备份名使用当前目标版本。
- Team runtime 启动时和每 24 小时写入
  `backups/board.sqlite.snapshot.<UTC timestamp>`，保留最近 7 份。
- 这些受管数据库备份仍可能引用 `archive-snapshots/**`；归档快照清理必须同时读取当前数据库的
  active/candidate/历史 fileId 引用和全部保留备份中的 `sync_archive_snapshot.storage_root`，
  备份轮换前不得删除对应目录。
- 每日容错备份失败只记结构化告警，不阻塞 HTTP、快照提交或 SSE；管理员移除分支使用的严格备份
  失败必须中止删除，不写删除审计。
- 客户端冲突备份位于
  `%LOCALAPPDATA%\TrellisBoard\data\agent\live-backups\<taskSpaceId>\<backupId>`。

## 4. Validation & Error Matrix

| 条件 | 结果 |
| --- | --- |
| Agent 非 active slot、binding 未批准、项目/任务空间停用 | `401/403`，不读写快照 |
| Agent 未上报 `observedBranchName` | `400 BRANCH_OBSERVATION_REQUIRED`，不写快照 |
| 上报分支与 taskSpace/binding 不一致 | `400 BRANCH_TASK_SPACE_MISMATCH`，不写快照 |
| 本地真实分支与 binding 不一致 | Agent 暂停该 binding，不写文件、不上传、不推进 cursor |
| 已有权威任务上传缺少 `taskVersion` | `409 TASK_VERSION_REQUIRED`，不写快照 |
| 已有权威任务上传缺少或使用错误 lease | `409 TASK_LEASE_REQUIRED/TASK_LEASE_INVALID`，不写快照 |
| 本地 taskVersion 落后或负责人已改派/任务已归档 | `409 TASK_VERSION_STALE/TASK_WRITE_FORBIDDEN/TASK_ARCHIVED`，本地副本保留 |
| ownership 索引 schema/binding/路径/符号链接/大小/条目数无效 | 拒绝该索引，回退权威冷扫描，不沿用旧 ownership |
| HEAD/ref 指纹与持久索引一致 | 复用 tracked paths，不执行 `git ls-tree` |
| 任务目录不在 Git 脏目录并集中 | 不递归枚举该目录，直接复用持久摘要；写操作仍实时读取真实内容 |
| 任务目录在 Git 脏目录并集中 | 只重扫该目录，按 size/mtime 精确复用或重算文件摘要 |
| handoff 本地目录干净、Agent 管理且全部为 Git `??` | 先写完整备份和 manifest，再持久化 cleaned ACK 并删除活动目录 |
| handoff 目录 dirty、Git tracked、baseline/Git 状态不确定 | 不删除本地正文，ACK `conflict` 并保留页内状态 |
| handoff 文件数超过 100,000 或规范化文本超过 64 MiB | ACK `conflict/backup_too_large`，保留本地正文 |
| 其他客户端仍持有有效任务租约 | 控制面 `leaseHeldByOtherUser=true`，ACK `conflict/lease_active`；服务端拒绝 cleaned 时返回 `409 HANDOFF_LEASE_HELD` |
| cleaned ACK 重试时备份缺失、非目录、身份或摘要不一致 | 改为 `conflict/missing`，不得报告 cleaned |
| handoff 本地目录包含符号链接、特殊文件或读取失败 | 不删除正文，收敛为 `conflict/unknown`，不中断其他任务同步 |
| 已完成 handoff 的重复 ACK 元数据不一致 | `409 HANDOFF_ACK_MISMATCH`，不改写首次审计 |
| handoff ACK 网络失败 | 本地 ACK 状态保持 pending；后续同步或重启重试，不阻塞 Board |
| 启动同步尚未完成（`initial_sync_completed == false`）或 `detachPending` | heartbeat 保活但该 binding 不进入监听集合；命令等待，watcher 事件暂存到串行链收尾 |
| 首次同步已完成、但其后有增量拉取/补拉/被取消的启动同步仍在进行 | 仍算在线监听；`active_bindings()` 只按 `initial_sync_completed && !detach_pending` 判定，`syncing_task_spaces` 不参与 |
| 基线首次收到来源不同任务但无证据 | `409 TASK_MERGE_EVIDENCE_REQUIRED`，不写快照 |
| 证据版本、类型、HEAD SHA、任务 ID、目录、路径或分支不匹配 | `400/409`，整批不写 |
| 来源 taskSpace 写入已由基线接管的稳定任务 ID | `409 TASK_OWNED_BY_BASELINE`，旧快照不变 |
| taskSpace 没有在线监听 | 创建/改派仍返回 `202 + operation`，任务或改派先显示待交付 |
| 目标用户可写但无在线 Agent 或 approved binding | 创建操作项并保留 pending 命令，客户端上线后再投递 |
| 目标用户不是项目 lead/member 或没有 developer ID | `ASSIGNEE_NOT_WRITABLE`，不生成任务或命令 |
| 路径越界、反斜杠、非白名单扩展名、符号链接、非 UTF-8 | 整批拒绝，任务快照不变 |
| Agent 批次包含 `.trellis/tasks/archive/**` | `409 ARCHIVE_SYNC_SERVER_MANAGED`，整批拒绝 |
| 归档 Git 凭据来源不匹配或无 SSH 凭据 | 该来源失败并写脱敏日志，不复用其他 host/port 凭据 |
| Git 归档导入、索引投影失败 | 保留上次成功归档和 Board cache，更新尝试时间并写对应阶段日志 |
| 单文件、单批、文件数超限 | 拒绝，任务快照不变 |
| JSON 编码请求或大响应超过 96 MiB | `413 BODY_TOO_LARGE`，不读取为业务批次、不写快照 |
| 同一 `batchId` 不同请求摘要 | `409` |
| `clientSequence` 不递增 | `409` |
| 任一 `baseSha256` 不一致 | `409 TASK_FILE_CONFLICT`，同批全部不写 |
| 任务目录缺 `task.json`、缺稳定 ID、移动前后 ID 不同 | `409`，整批拒绝 |
| 无变化批次 | `200 noop=true`，revision 不增加 |
| 服务端重复广播相同或更旧 `task.changed.revision` | 不再广播，不改变 taskSpace 快照 |
| Agent 已同步且无 pending upload，收到相同或更旧 revision | 短路，不 GET 快照、不扫描任务目录、不写 cursor |
| Agent cursor patch 与当前 revision/sequence/baselines/deferred/pending 等状态相同 | 不更新 `updatedAt`，不写 `live-cursors.json` |
| 延后目录指纹、本地完整任务和合并后的服务端基线完全一致且本地非空 | 仅收敛 deferred，不进入 dirty、不上传、不推进服务端 revision |
| 延后目录与本地一致但本地任务目录缺失/为空，或服务端缺文件、摘要不同、基线不完整 | 保留 deferred，继续受保护审查 |
| 投影尚未追上成功 revision 或负责人尚未更新 | `409 COMMAND_WAITING_INDEX`，可重试结果 |
| Agent 租约过期 | 状态恢复 `pending`，可安全重投 |
| 每日数据库备份失败 | 记录告警，服务继续运行 |
| 旧 `/api/agent/live-*`、Git 凭据、probe、refresh、repair、git-operation 路由 | `404` |

## 5. Good / Base / Bad Cases

- Good：A 修改 `task.json` 并以服务端当前摘要为基线提交；revision+1，B 从 cursor 拉取后原子替换
  完整任务目录，再推进 cursor；Board 收到 `tasks.changed` 后重载 REST 快照。
- Good：A 把任务从活动目录移动到归档目录，Agent 只提交旧活动路径删除；服务端活动卡片消失，
  下一次 Git 归档导入后以 `archived=1` 出现在归档页。
- Good：dev 基线首次看到 `dev1` 任务且其在 dev HEAD 中，一次 tree 扫描后携带证据写入；来源 dev1
  旧快照保留但不再出现在默认任务查询。
- Good：同一 HEAD 下 17 个已合入任务只执行一次 `git ls-tree`，每个任务分别附自己的证据。
- Good：5 个关联的 ProjectRail 在 3 秒刷新时复用 15 秒归属投影；过期后只扫描任务元数据和
  `task.json.branch`，不读取约 6000 个任务正文文件。
- Good：正常重启命中 `ownership-index.json`，ProjectRail 先恢复 5 个关联；一次受限 `git status`
  只标出少量脏任务目录，后台不枚举干净目录，未变化任务文件不读取正文，未变化 HEAD 不启动
  `git ls-tree`。
- Good：首次接入时延后的本地任务后来已由其他 Agent 按相同文件集合和摘要写入服务端；客户端
  在启动或下一次真实 pull 中只清除 deferred，ProjectRail 恢复同步正常，不上传本地任务。
- Good：同一仓库为主分支和 feature 分支各建一个 worktree；两个 `localRepoKey` 不同，各自只监听当前分支。
- Base：本地和服务端任务目录文件集合及摘要相同，不写文件、不增加 revision。
- Base：同步请求已提交但响应丢失，客户端重启后复用 pending `batchId`，服务端返回原 revision。
- Base：投影重复上报相同 revision；服务端不重复广播，客户端即使收到也不会重复拉取或写 cursor。
- Bad：同一个 Git 工作目录先绑定 main 又保留 feature binding；watcher 会把一份本地修改双写到两个 taskSpace。
- Bad：普通 watcher 每次都执行 `git ls-tree`，把路径扫描成本放大到每个事件和每个任务。
- Bad：ProjectRail 每 3 秒或每次投影缓存过期都调用完整任务快照读取，对全部 Markdown/JSONL
  正文做 UTF-8 解码和 SHA-256；任务历史增大后会造成周期性 CPU 尖峰。
- Bad：启动 pull 与 ownership worker 同时扫描同一仓库，或 watcher 在 pull 期间直接上传；会形成
  并发 Git/文件扫描、冲突和 CPU 尖峰。watcher 事件必须暂存并由同一串行链收尾。
- Bad：把 `192.168.x.x` 等局域网服务器交给 `127.0.0.1:7897` 用户级代理；客户端会持续建立错误连接，
  表现为高 CPU、频繁重连和“同步像是没生效”。局域网 IP 必须直连。
- Bad：源分支任务在基线接管后继续写来源 taskSpace，形成两个活跃归属。
- Bad：服务端为活动任务同步或合入证据执行项目 Git/Python 子进程，重新引入工作副本和双写者。
- Bad：以“后到覆盖先到”写同一任务文件，会静默丢更新；服务端必须使用文件级 CAS。
- Bad：收到 watcher 后只按路径抑制，不校验新摘要，会吞掉远端应用后紧接发生的真实本地编辑。
- Bad：服务端在 HTTP 请求栈里 clone/fetch 或扫描项目 Git，会长时间阻塞；归档 Git 只能在后台
  scheduler 中读取 archive 路径，不能成为活动任务第二写者。
- Bad：命令失败时提前插入正式任务卡或修改负责人，会让 Board 显示未实际落盘的状态。
- Bad：为了覆盖任意 JSON 转义最坏膨胀，把 96 MiB 运输硬上限提高到数百 MiB；这会放大单请求
  内存占用和拒绝服务风险。64 MiB 是正常文本任务目标，运输表示仍必须受 96 MiB 约束。

## 6. Tests Required

- `packages/shared/test/shared-remote-identity.test.js`：HTTPS/SSH/scp 归一、端口、非法协议和分支。
- `packages/shared/test/task-snapshot.test.js`：路径边界、LF 摘要、任务目录分组、1024/1025 文件、
  64 MiB/64 MiB+1 字节、移动和六类差异。
- `packages/server/test/database-v10.test.js`：新旧表并存、升级备份、旧数据保留和重复启动。
- `packages/server/test/team-task-spaces.test.js`：全局唯一、owner/invite、同远端不同分支隔离，以及切换分支只撤销
  当前 Agent 的旧 binding、保留旧 taskSpace 和其他设备 binding。
- `packages/server/test/team-task-snapshot.test.js`：首次写入、CAS 冲突、整批回滚、幂等、删除墓碑、覆盖备份、
  非法/不一致 `observedBranchName`，以及升级前 pending batch 补字段重放。
- `packages/server/test/team-task-index-v10.test.js`：tasks-only 物化、活动/归档双 revision、
  archive-only Board 投影、不读取 Git/workspace。
- `packages/server/test/team-task-index-v10.test.js` 还必须覆盖：单任务 warm 只扫描一个目录、未变化
  索引行不更新、增量与 full Board 一致、增量参与者变化后的 `project.members`、增量重复任务 ID
  身份冲突、人工阶段同 revision 重投影、失败事务四项状态回滚及 superseded 后收敛；另覆盖
  `lease_id` 清空后仍从最新租约投影 `expired` 状态。
- `packages/server/test/team-agent-slot.test.js`、`team-task-spaces.test.js`：监听快照、空集合、旧客户端、
  超时、五态聚合、监听详情权限和主动解绑幂等；另覆盖新设备踢下线、旧 SSE 关闭和旧命令取消。
- `packages/server/test/team-task-commands.test.js`：在线目标、命令状态机、租约恢复、索引等待、重试和取消。
- `packages/server/test/agent-event-stream.test.js`：同一 taskSpace 的 `10, 10, 9, 11` 只广播 10 和 11，
  不同 taskSpace 独立去重，非法 revision 不广播。
- 双客户端实时对齐（两个真实 Agent 的 HTTP 快照 + SSE、CAS 并发、离线拒绝）随 Node Agent 删除而
  不再有自动化测试；发布前由 Windows 客户端 E2E 覆盖，服务端行为由 `team-task-snapshot`、
  `team-agent-slot`、`team-gitless-http` 三条测试约束。
- `packages/server/test/team-gitless-http.test.js`：活动 Agent 路由可用，旧 Git/live 路由 404，
  归档管理 API 仅系统管理员可用且不回显密钥。
- `packages/server/test/archive-git-{credentials,store,sync}.test.js`：凭据隔离和加密、bare 缓存、
  只读 archive 对象、失败保留、失败阶段日志、索引时间和每 taskSpace 100 条日志上限。
- `packages/server/test/team-gitless-http.test.js` 还必须断言：超过旧 9 MiB 的合法 Agent 批次可写入；
  Content-Length 超过 96 MiB 返回 `413 BODY_TOO_LARGE`；普通 JSON 仍为 64 KiB；缺少
  `observedBranchName` 返回 `400 BRANCH_OBSERVATION_REQUIRED`；离线创建的 pending 行可查询，
  claim 后 Board 行更新为 claimed 且查询版本推进。
- `packages/web/test/team-web.test.js` 覆盖离线创建/改派、pending/claimed/lease expired、
  版本落后、迁移冲突、改派、handoff、materialized、未知状态兜底和未 materialize 正文不可用。
- `packages/server/test/team-release.test.js`：服务端仓库无工作副本，命令成功前不生成正式任务。
- `packages/desktop/src-tauri/src/agent/{onboarding,task_sync,task_command,git,protocol}.rs` 的 `mod tests`：
  仓库预检、固定 CLI 初始化、推送状态、已有 `.trellis`、同 `localRepoKey` 换分支、首次/增量同步、
  cursor 文件基线、离线并发冲突、延后目录、目录移动、pending batch 重放、全量分组跨目录超过
  1024 文件、实际批次 1024/1025 与 64 MiB 边界、错分支与 detached HEAD 拒绝、基线 tree 单次扫描
  与 HEAD 变化刷新、pending evidence 原样重放和 `TASK_OWNED_BY_BASELINE` 后停止主动上传。
  延后目录还必须覆盖本地与服务端完全一致、摘要不同、服务端缺文件、本地多文件、任务目录缺失、
  空基线、同 revision 启动收敛且不触发基线补交上传、正常 pull 不产生 dirty 上传，以及重复
  heartbeat 不重复任务扫描；还要覆盖本地状态变化导致的 deferred 移除仍保留原有基线补交上传。
  必须断言归属展示投影不会解码普通任务正文，并覆盖 15 秒缓存命中、same-HEAD 只续期不重扫、
  显式失效、失效与旧计算交错时禁止回写、HEAD 变化刷新和无变化时只执行一次 `ls-tree`。
  持久索引还必须覆盖：正常重启不读未变化 `task.json`、HEAD 不变不执行 Git、单文件变化只解析
  目标项、schema/路径/超限/符号链接回退、临时 `TaskSync` 不写盘、启动 watcher 事件延后上传、
  `Notify` 多等待者不丢唤醒，以及展示缓存不能绕过真实分支门禁。
- `packages/desktop/src-tauri/src/agent/{task_sync,task_control}.rs` 还必须覆盖 controls
  缺失兼容、普通本人任务选择、claim/heartbeat/release 请求、lease/taskVersion 重启恢复、
  upload 请求 fencing，以及 archived/reassigned 不落盘、不上传、不删除本地数据。
- handoff 还必须覆盖 manifest 稳定性、ACK 元数据脱敏、干净未跟踪副本备份后删除、dirty/tracked/
  baseline/branch/Git 不确定时失败关闭、100,000 文件与 64 MiB 边界、完整备份回读校验、cleaned ACK
  重启重试、备份缺失转 conflict、重复 ACK 元数据冲突、他人租约保护和通知去重不抢焦点；以及同一
  任务第二轮及后续物化轮次的 ACK 重置与重新清理（含同轮重复同步不重复清理/ACK、旧状态文件
  缺少轮次字段时的自愈）。Board 静态契约覆盖 `handoff_notice_pending`、capability 和页内提示入口。
- `packages/desktop/src-tauri/src/agent/{store,credential,http,control}.rs`：配置原子写与双绑定拒绝、
  DPAPI 往返、SSE 分帧、控制事件去重与过期；代理绕过需覆盖回环、私网、链路本地、IPv6
  ULA/link-local、`.local` 和公网域名。
- `packages/desktop/src-tauri/src/agent/{runtime,task_sync,detach,store}.rs`：真实监听集合、
  `detachPending` 排除、失败重试和成功后 cursor 清理；另覆盖相同/旧 revision 短路、首次同步和
  pending upload 例外、相同 cursor patch 不落盘。
- Tauri command、capability 与 permission 的装配由 `cargo test`/桌面构建和真实客户端 E2E 验证，
  不用 Node 测试读取 Rust/TOML 源码做正则断言。
- `packages/server/test/task-space-duplicate-cleanup.test.js`：默认 dry-run、只墓碑指定旧 taskSpace、不动归档、
  `VACUUM INTO` 备份、内容差异和缺少稳定 ID 时拒绝自动清理。

Windows 发布前仍需两个真实安装客户端完成登录、本地项目初始化、首次推送、任务同步、并发冲突、
命令投递、换设备踢下线和归档重启验收；Node 测试不能替代该 E2E。

性能 E2E 不能只按进程名判定热点。发现主进程持续高 CPU 时，先分别记录进程树总 CPU、Tauri
`main`、Tokio worker 和无名称线程；再把热点线程的指令指针映射到已加载模块。企业终端安全组件
可能向客户端注入线程，例如奇安信天擎的 `LHShield64.dll` 曾在客户机固定占用约 19 秒单核，
而 Trellis 自身线程合计约 `1%`。报告必须同时给出“总 CPU”和“Trellis 归属 CPU”，不得把注入
模块成本归因给同步代码，也不得通过绕过、卸载或篡改安全组件来满足验收。除非产品书面定义环境
豁免，否则总量目标仍按原口径判定。需要空数据根对照时使用 `TRELLIS_DESKTOP_HOME`；桌面端不存在
`TRELLIS_AGENT_ROOT` 覆盖变量。

## 7. Wrong vs Correct

### Wrong

```js
// 以路径和时间判断“这是自己刚写入的事件”。
if (recentlyAppliedPaths.has(relativePath)) return
```

远端应用后用户立刻真实编辑同一文件时，该编辑会被错误吞掉。

### Correct

```js
const expected = this.suppressed.get(absolutePath)
const current = snapshotSha256(await readFile(absolutePath, 'utf8'))
if (current === expected) return
// 摘要不同，说明是新的本地编辑，继续上传。
```

### Wrong

```js
db.prepare('UPDATE sync_task_space_file SET content_text = ? WHERE relative_path = ?')
```

没有 base 摘要校验会后写覆盖先写。

### Correct

```js
// 在同一 BEGIN IMMEDIATE 中比较每文件 baseSha256。
// 任一不一致时整批返回 TASK_FILE_CONFLICT，所有文件均不写入。
```

### Wrong

```js
for (const taskDir of localOnlyDirectories) {
  await uploadTaskSpaceChanges(taskDir)
}
```

几十个任务会在 1 秒内触发服务端第 6 批限流，中断后留下不完整的首次快照。

### Correct

```js
await runUploadWithSlot(taskSpaceId, () =>
  uploadTaskSpaceChanges(taskSpaceId, request),
)
// 请求完整结束后至少等待 260ms；429 仅复用同一 request 做有界重试。
```

### Wrong

```js
await api.uploadTaskSpaceChanges(taskSpaceId, {
  batchId,
  clientSequence,
  files,
})
```

没有在真正发出写入前复核真实分支；用户在这期间切到别的分支时，任务会继续写向旧 binding。

### Correct

```js
const observedBranchName = await assertRepositoryBranch({ repoPath, branchName, hooksDir })
await api.uploadTaskSpaceChanges(taskSpaceId, {
  batchId,
  clientSequence,
  observedBranchName,
  files,
})
```

每次真正发出写入前都重新读取真实分支；服务端再校验 taskSpace 和 binding，任何不一致都不写快照。

### Wrong

```rust
// 每个 task.changed 都直接进入完整拉取，并让 write_cursor 无条件刷新 updatedAt。
task_sync.pull_and_report(task_space_id).await;
entry.insert("updatedAt", now);
write_atomic(cursor_path, state);
```

重复投影会把同一 revision 放大成快照 GET、全量任务扫描和整文件重写。

### Correct

```rust
if !should_pull_for_event(initial_sync_completed, review_pending, cursor_revision, event_revision, has_pending) {
    return;
}
if apply_cursor_patch(&mut cursor, &patch) {
    entry.insert("updatedAt", now);
    write_atomic(cursor_path, state);
}
```

重复事件直接短路；cursor 只有在业务状态实际变化时才落盘，pending upload 仍按原路径重试。

### Wrong

```rust
if task_sync.is_none() {
    let files = read_local_task_snapshot_files(repo_path, None).await?;
    let groups = group_task_snapshot_files(&files)?;
}
```

runtime 未 ready 不等于没有持久索引。每次回退完整任务正文读取会把页面启动窗口放大成重复全仓扫描。

### Correct

```rust
if let Some(index) = load_ownership_index(&store.paths.ownership_index_file).await {
    let projection = indexed_ownership_projection(&index, binding);
    // 先返回只读 paused/localDirs，后台再按文件元数据和 HEAD 指纹增量校验。
}
// 写操作始终走 assert_binding_branch + 完整文件读取/CAS，不读取该展示投影。
```

持久投影可跨进程服务 ProjectRail；实际上传仍调用完整快照读取和精确 CAS 校验。

### Wrong

```text
HTTP_PROXY=http://127.0.0.1:7897
NO_PROXY=localhost,127.0.0.1,::1
serverUrl=http://192.168.65.27:4317
```

局域网任务服务会被错误送进用户级代理。

### Correct

```text
回环/私网/链路本地/.local -> 自动 no_proxy
公网域名 -> 系统代理
内网域名 -> 显式加入 NO_PROXY，或未来使用 proxyMode=direct
```

任务级分支归属、ownership API、冲突幂等和历史清理约束见
[任务级分支归属与冲突幂等](./task-ownership-and-conflict-idempotency.md)。

## 场景：Agent 命令完成与控制面失效事件

### 1. Scope / Trigger

- Trigger：修改 Agent command SSE、`taskControl.completeCommand()`、控制面负责人投影或
  `create_task` / `assign_task` 生命周期时。

### 2. Signatures

```text
SSE command       : { type: "command", payload: { command }, command, teamId: null }
SSE control.changed: { type: "control.changed", taskSpaceId }
taskControl.completeCommand(agent, taskSpaceId, {
  commandType, taskId, executionTaskKey, revision
})
```

### 3. Contracts

- `command` 的标准命令对象位于 `payload.command`。兼容期服务端同时提供顶层
  `command`；客户端必须先读 `payload.command`，缺失时才回退顶层字段。
- 旧客户端收到未知 `control.changed` 必须安全忽略；新客户端收到后对指定 taskSpace
  触发一次控制状态拉取，事件本身不携带任务正文。
- 内容上传只推进 materialization，不能提前写 `source_cleanup_pending`。命令结果和索引
  校验完成后，`create_task` 成功固定收敛为 `handoff_state=none`；只有跨用户的
  `assign_task` 才可进入 `source_cleanup_pending`。
- 命令完成事务提交后，服务端推进查询 revision、发布 Board `tasks.changed`，并向该
  taskSpace 的 approved bindings 广播 `control.changed`。事件丢失时仍由下一次普通同步修复。
- `sync_task_index` 的 no-op 指纹必须包含权威任务的负责人、设备、路径、标题、优先级、
  归档、materialization 和 taskVersion；内容 revision 未变化不能跳过控制面负责人刷新。

### 4. Validation & Error Matrix

| 条件 | 结果 |
| --- | --- |
| 标准 SSE `command` | 从 `payload.command` 解析并执行 |
| 只有旧顶层 `command` | 兼容解析并执行 |
| 已知事件缺少必要字段 | 忽略该事件，不阻断后续 SSE |
| 未知事件 `control.changed` 被旧客户端收到 | 客户端默认忽略，不重连 |
| `create_task` 创建者与负责人不同 | 命令成功后 `handoff_state=none` |
| `assign_task` 创建者与负责人不同 | 命令成功并等待索引后 `source_cleanup_pending` |
| 上传完成但命令结果尚未确认 | 不提前进入来源清理 |
| 内容 revision 未变但负责人变化 | 权威任务指纹变化，索引必须重投影 |

### 5. Good/Base/Bad Cases

- Good：管理员创建任务给另一在线成员，目标客户端从 `payload.command` 执行；上传 revision
  更新、索引命中后命令成功，任务负责人立即出现在 Board，handoff 保持 `none`。
- Base：旧服务端仍发送顶层 `command`，新客户端兼容执行。
- Bad：客户端只读顶层字段，命令长期停在 `delivered`，目标客户端不调用 `/start`。
- Bad：内容上传阶段仅按“创建者 ≠ 负责人”写 `source_cleanup_pending`，普通创建任务被误判为
  handoff，Board 永久显示“等待来源副本清理”。

### 6. Tests Required

- `agent-event-stream.test.js`：command 同时含 `payload.command` 与顶层 `command`；
  `control.changed` 广播到指定 taskSpace 的所有绑定 Agent。
- `team-task-control.test.js`：真实 claim + 上传后，`create_task` 完成不清理，
  `assign_task` 完成才清理。
- `team-task-commands.test.js`：命令完成推进控制事件、Board revision，并写入 materialization。
- `team-task-index-v10.test.js`：内容 revision 不变但负责人变化时索引仍刷新。
- `runtime.rs`：标准嵌套 command、旧顶层 command 均可解析；真实创建 E2E 必须验证
  `/start`、`/claim`、`/changes`、`/result`、索引和 `handoff_state=none`。

### 7. Wrong vs Correct

#### Wrong

```js
const raw = data.command
const handoffState = creatorId !== assigneeId ? 'source_cleanup_pending' : 'none'
```

#### Correct

```js
const raw = data.payload?.command ?? data.command
const handoffState =
  commandType === 'create_task'
    ? 'none'
    : commandType === 'assign_task' && creatorId !== assigneeId
      ? 'source_cleanup_pending'
      : currentHandoffState
```

## 场景：Pending 原样重放与已应用 revision

### 1. Scope / Trigger

- Trigger：修改 `task_sync.rs` 的 cursor、pending retry、上传应答、SSE 拉取或一次性 revision 修复时。

### 2. Signatures

```text
Cursor.revision        = 本地已经完整应用的最高服务端 revision
Cursor.pending         = 不可变的上传请求快照
Cursor.revisionGuardVersion = 1
Cursor.pendingRejected = taskDir -> 有界拒绝摘要
Cursor.ownershipPending + Cursor.pendingRejected = 待归属摘要删除重试账本
```

### 3. Contracts

- `pending` 重放必须原样发送 `batchId/clientSequence/files/mergeEvidence`。只有
  `observedBranchName` 和按服务端要求抬高一次 `clientSequence` 可以变化；不得用当前本地
  `task.json.branch` 在发请求前阻断旧批次。
- 明确 ownership、merge evidence 或 baseline-owned 拒绝后，清除该 pending，写
  `pendingRejected` 或现有 ownership/baseline 状态，并继续同一轮其他任务。
- 活动任务目录被明确确认不存在时，候选目录取 `ownershipPending.keys()` 与
  `pendingRejected.keys()` 的并集。只有 `.trellis`、`.trellis/tasks` 均为真实可读目录，且逐任务
  `symlink_metadata` 返回 `NotFound` 时，才能向服务端提交只含 `taskDir` 的 delete。
- 服务端确认删除或明确返回旧服务端 404/405 后，必须用一个 cursor patch 同时移除两份状态；网络、
  5xx、分支校验、父目录不可读和未知 IO 错误全部保留两份状态，等待 watcher、ownership 校验或重启重试。
- 启动时只要 `ownershipPending` 或 `pendingRejected` 非空，`pull_and_report()` 必须报告需要继续
  ownership 校验，即使服务端 revision 未变化。不能把“没有新快照”误判为“没有本地删除账本要重试”。
- 网络失败、超时、429 重试耗尽和未知失败必须保留 pending 并停止该 taskSpace，不能猜测服务端未提交。
- 上传成功只推进 `sequence`、baselines 和 pending 状态，不把响应 revision 写入
  `cursor.revision`；只有完整 pull/apply 成功后才能推进已应用 revision。
- cursor 缺少 `revisionGuardVersion` 时按 0 读取。首次运行先重放 pending，再用 full snapshot
  做一次安全对账；下载 server-only、保留并重传 local-only、内容冲突进入 deferred。
- 修复只有在完整快照验证收敛后才写 `revisionGuardVersion=1`；失败保持 0，重启继续修复。
  不得为了修复删除本地活动任务或用服务端摘要覆盖冲突目录。

### 4. Validation & Error Matrix

| 条件 | 结果 |
| --- | --- |
| pending 内容与当前本地文件不同 | 仍先原样重放 |
| 明确 ownership/evidence 拒绝 | 清 pending，写有界摘要，继续其他任务 |
| 网络错误或 5xx | 保留 pending，停止该 taskSpace |
| 待归属目录明确不存在且删除成功 | 一个 cursor patch 同时清 `ownershipPending`、`pendingRejected` |
| 待归属目录仍存在、变成文件或符号链接 | 不上报删除，保留两份 cursor 状态 |
| `.trellis`/`.trellis/tasks` 缺失、不可读或类型异常 | 失败关闭，不把空扫描结果解释为全部删除 |
| inbox delete 网络失败或 5xx | 两份 cursor 状态不变，后续触发点继续重试 |
| inbox 接口 404/405 | 标记可选能力缺失；已确认不存在目录的两份本地状态可清理 |
| 启动 revision 未变化但待归属/拒绝账本非空 | 仍执行 ownership 校验，成功后清两份账本 |
| 上传返回 revision 已越过他人变更 | `cursor.revision` 不变，下一次 pull 补齐 |
| guard<1 且 full snapshot 未收敛 | guard 保持 0，不删除本地任务 |
| guard 修复成功 | 写 verified revision 和 guard=1 |

### 5. Tests Required

- `unchanged_startup_pull_revalidates_pending_ownership_ledger`：预置相同 revision 和非空双账本，
  启动 pull 后必须发送 `PUT .../ownership-inbox`，并清空两份账本。

### 6. Wrong vs Correct

#### Wrong

```rust
revalidate || self.read_cursor(task_space_id).await.revision != revision_before
```

服务端 revision 未变化时跳过 ownership 校验，离线删除意图永远不续传。

#### Correct

```rust
let ownership_retry = !cursor_before.ownership_pending.is_empty()
    || !cursor_before.pending_rejected.is_empty();
revalidate
    || ownership_retry
    || self.read_cursor(task_space_id).await.revision != revision_before
```

## 场景：命令 revision、租约释放与归档墓碑

### 1. Scope / Trigger

- 修改 `completeCommand` 结果 revision、命令后租约、handoff 清理租约判断、归档 tombstone，
  或同 ID 本地迁移副本的 claim/上传行为时适用。

### 2. Contracts

- 上传响应 `revision` 是上传前的 taskSpace 游标，不是任务内容 revision。命令结果必须依次取
  `control.task.contentRevision`、`committedRevision`、claim 返回的 `contentRevision`；
  `completeCommand` 要求结果 revision 精确等于 `sync_task.content_revision`。
  `COMMAND_WAITING_INDEX` 是可重试状态，不能当作永久失败。
- 命令成功上传后客户端释放执行租约。服务端 handoff 清理只把
  `lease.user_id !== agent.userId && lease.user_id !== row.assignee_user_id` 的租约视为阻塞；
  负责人自己的租约不得触发 `HANDOFF_LEASE_HELD`。
- 归档同步把 `.trellis/tasks/archive/<YYYY-MM>/<name>` 导入 `sync_archive_file`，并为同名活跃目录
  写删除墓碑。`reconcileProjection` 以唯一归档任务为权威：`sync_task.relative_dir` 收敛到归档路径，
  `archived=1`，`task_version` 加一，活动索引不再展示第二份状态。
- 客户端处理 `state=archived` 时，只有本地归档副本存在且目录摘要一致才删除活跃副本；摘要不一致
  必须保留本地目录并告警。上传遇到 `TASK_ARCHIVED` 只清 pending，不写回。
- 活跃本地任务复用已归档 `task.json.id`：基线空间 claim 返回 `TASK_ARCHIVED`，非基线空间返回
  `TASK_OWNED_BY_BASELINE`；不得上传、复活归档行或删除本地正文。
- 从 Git 分支删除归档文件后，下一次归档同步删除 `sync_archive_file` 并推进
  `archive_revision`；归档墓碑由明确的运维清理删除，不能静默复活。

### 3. Validation & Error Matrix

| 条件 | 结果 |
| --- | --- |
| 命令结果使用上传响应 `revision` | `TASK_VERSION_STALE`，命令停留在 running |
| 结果 revision 精确等于内容 revision | 命令成功，控制面推进 |
| 服务端返回 `COMMAND_WAITING_INDEX` | 客户端保留重试，不标记永久失败 |
| 命令上传后未释放租约 | 来源清理可能被误判为第三方并发；必须主动释放 |
| 清理时只有负责人自己的租约 | 允许 cleaned ACK |
| 清理时存在第三方租约 | `HANDOFF_LEASE_HELD`，冲突 ACK |
| 归档副本与活跃副本摘要一致 | 删除本地活跃副本 |
| 归档副本与活跃副本摘要不同 | 保留活跃副本并告警 |
| 活跃副本复用归档 ID | claim 拒绝，不上传、不删除本地正文 |
| 归档文件从 Git 删除 | `sync_archive_file` 清空对应行，归档 revision 推进 |

### 4. Tests Required

- `team-task-control.test.js`：负责人租约允许清理、第三方租约拒绝清理。
- `team-task-index-v10.test.js`：重复 `task.json.id` 标记 `identity_conflict`；归档权威覆盖活动索引
  并把 `task_key` 收敛到归档路径。
- `team-task-commands.test.js` / `agent-event-stream.test.js`：命令 revision、控制面失效事件。
- 桌面 Rust：归档墓碑摘要不一致时保留、`TASK_ARCHIVED` 跳过上传、命令 revision 解析与租约释放。
- 真实双客户端 E2E：归档干净副本删除、脏副本保留；旧客户端离线写入被拒绝。

### 5. Wrong vs Correct

#### Wrong

```rust
let revision = upload_response["revision"].as_u64();
complete_command(revision); // 上传前空间游标，触发 TASK_VERSION_STALE
```

#### Correct

```rust
let revision = result.pointer("/control/task/contentRevision")
    .and_then(Value::as_u64)
    .or_else(|| result.get("committedRevision").and_then(Value::as_u64))
    .or(claimed_revision)
    .ok_or_else(|| protocol::err(code::HTTP_ERROR, "任务内容尚未提交"))?;
```
