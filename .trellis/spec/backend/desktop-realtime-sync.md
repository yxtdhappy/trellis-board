# 桌面任务快照同步

## 1. Scope / Trigger

- 修改 `packages/shared/task-snapshot.js`、`packages/shared/remote-identity.js`、
  `apps/desktop/src-tauri/src/agent/{task_sync,task_command,onboarding}.rs`、`apps/server/team/task-space-*.js`、
  `apps/server/team/task-snapshot-service.js`、`apps/server/team/task-command-service.js`、
  `apps/server/team/sync-agent-service.js`、团队同步 API/SSE、`sync_*` schema 或桌面控制窗口时必须遵循本文。
- 单机 watcher 与团队客户端 watcher 继续复用 `packages/shared/trellis-watcher.js` 的事件归一化；团队客户端
  只监听 `.trellis/tasks/**`。
- Team 服务端不 clone、fetch、commit 或 push 项目 Git，不创建项目工作副本，也不读取 Git 凭据。
- 项目 Git 只由客户端使用，负责源码、`.trellis/scripts`、`spec`、`config.yaml`、`workflow.md`、
  `agents`、workspace 和本机编码 Agent 目录的一致性；Team Board 只同步任务目录。

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

创建和改派成功入队返回 `202 + operation`。目标 Agent 离线或未绑定时在创建操作项前拒绝。

`taskSpaceId` 可选：指定时查询单分支；缺省或 `all` 时按当前 `teamId` 和可选 `projectIds` 查询所有可读
taskSpace。服务端使用 `taskSpaces.listReadable()` 生成项目/任务空间集合并校验显式 projectIds。
ETag、缓存键和游标绑定用户、团队、项目/taskSpace 集合哈希、规范化 filters、query revision 和查询日；
分页以 `last_activity_at/archived_at + taskSpaceId + taskKey` 稳定排序。
`branch` 为可选单值子串筛选，trim 后大小写不敏感匹配，`%`、`_` 等字符按字面处理。
分支匹配使用与前端一致的 Unicode 小写语义，不能直接依赖 SQLite 内置 `lower()`，它只折叠 ASCII。

### SQLite v12

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

### 服务与 SSE

```text
createTaskSpaceService({ db, config, backupService })
createTaskSnapshotService({ db, taskSpaces, onRevisionCommitted })
createTaskCommandService({ db, taskSpaces, agents, events })
createSyncAgentService({ db, config, events })
createTaskSnapshotBackupService({ db, databaseFile, logger })
createAgentEventStream({ db, commands, logger })
```

Agent SSE 事件为 `command.available`、`agent.revoked`、`task.changed`、`cursor.invalidated`。
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
- 服务端信任已认证 Agent 上报的 origin 字符串，不访问 Git 远端证明其存在；Agent 必须先验证
  所选目录是仓库根、origin 可规范化、当前分支合法。

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

- 只接受 `.trellis/tasks/<task-dir>/<file>` 和
  `.trellis/tasks/archive/<YYYY-MM>/<task-dir>/<file>`。
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
- 同一批最多涉及一个完整任务目录，或一次同 task ID 的活动目录到归档目录移动；移动前后都必须保留
  `task.json` 和稳定 `id`。
- 成功且有变化的批次只增加 taskSpace revision 一次，并写 `sync_file_audit`；无变化批次不增加 revision。
- 删除保留 `deleted=1` 墓碑供增量拉取；full snapshot 不返回墓碑。

### revision、cursor 与本地应用

- 首次接入使用 `afterRevision=0` 获取当前完整快照；已接入客户端重启从本地 cursor 增量拉取。
- 只有本地完整应用后才推进本地 cursor，再上报 `PUT cursor`；服务端 cursor 使用
  `MAX(existing, incoming)` 防止回退。
- 客户端 cursor v3 额外保存每个已同步文件的服务端摘要。增量上传的 `baseSha256` 必须来自
  上次成功应用或上传后的本地基线，不能在提交前临时读取服务端最新摘要来充当基线，否则会
  绕过离线并发冲突。
- `write_cursor` 只在 revision、sequence、baselines、deferred、ownershipPending、conflictBlocked
  或 pending 发生实际变化时更新 `updatedAt` 并原子替换文件；缺失 pending upload 的重复 revision、
  相同 patch 或只刷新时间的调用不得重写 `live-cursors.json`。
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
- ProjectRail 可跨进程复用 `<agent data>/ownership-index.json`。索引 schema 为 `2`，按 `localId`
  保存 taskSpace/repo/branch/baseline 身份、HEAD/ref 与 Git index 指纹、当前 HEAD 的
  `task.json` tracked paths、任务目录及 `task.json` 的 size/mtime/摘要/`id`/`branch`、paused 和
  localDirs，以及每个支持任务文件的相对路径、size/mtime/摘要；不得保存任务正文。索引命中时允许
  先返回只读投影，后台再增量校验；runtime 未 ready 时也只读该文件，不回退到全任务正文扫描。
- 运行中的 Agent `TaskSync` 是索引唯一写者，临时 `TaskSync` 只读。任意任务文件的 size/mtime 均未
  变化时，启动 pull 不得重新读取正文或计算摘要；`task.json` 同时复用 `id/branch`。HEAD/ref 指纹
  未变时不得执行 `git ls-tree`，指纹变化时每仓库最多一次。
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

- `create_task` 和 `assign_task` 只允许投递给目标用户唯一在线 Agent。
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

- v10/v11 -> v12 升级前使用 `VACUUM INTO` 写入 `backups/board.sqlite.pre-v12.*`；更早版本按
  原顺序迁移，最终备份名使用当前目标版本。
- Team runtime 启动时和每 24 小时写入
  `backups/board.sqlite.snapshot.<UTC timestamp>`，保留最近 7 份。
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
| ownership 索引 schema/binding/路径/符号链接/大小/条目数无效 | 拒绝该索引，回退权威冷扫描，不沿用旧 ownership |
| HEAD/ref 指纹与持久索引一致 | 复用 tracked paths，不执行 `git ls-tree` |
| 任一任务文件 size/mtime 与持久索引一致 | 启动 dirty 检测复用摘要、不读取正文；写操作仍实时读取真实内容 |
| 启动同步尚未完成 | heartbeat 保活但该 binding 不进入监听集合；命令等待，watcher 事件暂存到串行链收尾 |
| 基线首次收到来源不同任务但无证据 | `409 TASK_MERGE_EVIDENCE_REQUIRED`，不写快照 |
| 证据版本、类型、HEAD SHA、任务 ID、目录、路径或分支不匹配 | `400/409`，整批不写 |
| 来源 taskSpace 写入已由基线接管的稳定任务 ID | `409 TASK_OWNED_BY_BASELINE`，旧快照不变 |
| taskSpace 没有在线监听 | 创建/改派在写 operation 前返回 `409 TASK_SPACE_NO_ONLINE_LISTENER` |
| 目标用户无在线 Agent、无 approved binding、非项目写成员 | 创建操作项前 `409`，返回用户、项目、分支和下一步 |
| 路径越界、反斜杠、非白名单扩展名、符号链接、非 UTF-8 | 整批拒绝，任务快照不变 |
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
- Good：A 把任务从活动目录移动到归档目录，一个批次包含旧目录删除和新目录写入；B 不会恢复旧活动路径。
- Good：dev 基线首次看到 `dev1` 任务且其在 dev HEAD 中，一次 tree 扫描后携带证据写入；来源 dev1
  旧快照保留但不再出现在默认任务查询。
- Good：同一 HEAD 下 17 个已合入任务只执行一次 `git ls-tree`，每个任务分别附自己的证据。
- Good：5 个关联的 ProjectRail 在 3 秒刷新时复用 15 秒归属投影；过期后只扫描任务元数据和
  `task.json.branch`，不读取约 6000 个任务正文文件。
- Good：正常重启命中 `ownership-index.json`，ProjectRail 先恢复 5 个关联；后台只枚举文件元数据，
  未变化任务文件不读取正文，未变化 `task.json` 不解析，未变化 HEAD 不启动 `git ls-tree`。
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
- Bad：服务端为验证证据执行项目 Git/Python 子进程，重新引入工作副本和凭据边界。
- Bad：以“后到覆盖先到”写同一任务文件，会静默丢更新；服务端必须使用文件级 CAS。
- Bad：收到 watcher 后只按路径抑制，不校验新摘要，会吞掉远端应用后紧接发生的真实本地编辑。
- Bad：服务端在 HTTP 请求栈里 clone/fetch 或扫描项目 Git，会重新引入两套事实源和长时间阻塞。
- Bad：命令失败时提前插入正式任务卡或修改负责人，会让 Board 显示未实际落盘的状态。
- Bad：为了覆盖任意 JSON 转义最坏膨胀，把 96 MiB 运输硬上限提高到数百 MiB；这会放大单请求
  内存占用和拒绝服务风险。64 MiB 是正常文本任务目标，运输表示仍必须受 96 MiB 约束。

## 6. Tests Required

- `packages/shared/test/shared-remote-identity.test.js`：HTTPS/SSH/scp 归一、端口、非法协议和分支。
- `packages/shared/test/task-snapshot.test.js`：路径边界、LF 摘要、任务目录分组、1024/1025 文件、
  64 MiB/64 MiB+1 字节、移动和六类差异。
- `apps/server/test/database-v10.test.js`：新旧表并存、升级备份、旧数据保留和重复启动。
- `apps/server/test/team-task-spaces.test.js`：全局唯一、owner/invite、同远端不同分支隔离，以及切换分支只撤销
  当前 Agent 的旧 binding、保留旧 taskSpace 和其他设备 binding。
- `apps/server/test/team-task-snapshot.test.js`：首次写入、CAS 冲突、整批回滚、幂等、删除墓碑、覆盖备份、
  非法/不一致 `observedBranchName`，以及升级前 pending batch 补字段重放。
- `apps/server/test/team-task-index-v10.test.js`：tasks-only 物化、归档移动、revision 隔离、不读取 Git/workspace。
- `apps/server/test/team-agent-slot.test.js`、`team-task-spaces.test.js`：监听快照、空集合、旧客户端、
  超时、五态聚合、监听详情权限和主动解绑幂等；另覆盖新设备踢下线、旧 SSE 关闭和旧命令取消。
- `apps/server/test/team-task-commands.test.js`：在线目标、命令状态机、租约恢复、索引等待、重试和取消。
- `apps/server/test/agent-event-stream.test.js`：同一 taskSpace 的 `10, 10, 9, 11` 只广播 10 和 11，
  不同 taskSpace 独立去重，非法 revision 不广播。
- 双客户端实时对齐（两个真实 Agent 的 HTTP 快照 + SSE、CAS 并发、离线拒绝）随 Node Agent 删除而
  不再有自动化测试；发布前由 Windows 客户端 E2E 覆盖，服务端行为由 `team-task-snapshot`、
  `team-agent-slot`、`team-gitless-http` 三条测试约束。
- `apps/server/test/team-gitless-http.test.js`：新路由可用，旧 Git/live 路由 404，Team 启动不访问 Git 工作副本。
- `apps/server/test/team-gitless-http.test.js` 还必须断言：超过旧 9 MiB 的合法 Agent 批次可写入；
  Content-Length 超过 96 MiB 返回 `413 BODY_TOO_LARGE`；普通 JSON 仍为 64 KiB；缺少
  `observedBranchName` 返回 `400 BRANCH_OBSERVATION_REQUIRED`。
- `apps/server/test/team-release.test.js`：服务端仓库无工作副本，命令成功前不生成正式任务。
- `apps/desktop/src-tauri/src/agent/{onboarding,task_sync,task_command,git,protocol}.rs` 的 `mod tests`：
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
- `apps/desktop/src-tauri/src/agent/{store,credential,http,control}.rs`：配置原子写与双绑定拒绝、
  DPAPI 往返、SSE 分帧、控制事件去重与过期；代理绕过需覆盖回环、私网、链路本地、IPv6
  ULA/link-local、`.local` 和公网域名。
- `apps/desktop/src-tauri/src/agent/{runtime,task_sync,detach,store}.rs`：真实监听集合、
  `detachPending` 排除、失败重试和成功后 cursor 清理；另覆盖相同/旧 revision 短路、首次同步和
  pending upload 例外、相同 cursor patch 不落盘。
- Tauri command、capability 与 permission 的装配由 `cargo test`/桌面构建和真实客户端 E2E 验证，
  不用 Node 测试读取 Rust/TOML 源码做正则断言。
- `apps/server/test/task-space-duplicate-cleanup.test.js`：默认 dry-run、只墓碑指定旧 taskSpace、不动归档、
  `VACUUM INTO` 备份、内容差异和缺少稳定 ID 时拒绝自动清理。

Windows 发布前仍需两个真实安装客户端完成登录、本地项目初始化、首次推送、任务同步、并发冲突、
命令投递、换设备踢下线和归档重启验收；Node 测试不能替代该 E2E。

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
