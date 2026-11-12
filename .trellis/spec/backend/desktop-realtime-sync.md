# 桌面任务快照同步

## 1. Scope / Trigger

- 修改 `shared/task-snapshot.js`、`shared/remote-identity.js`、`agent/task-snapshot-sync.js`、
  `agent/task-command.js`、`agent/project-onboarding.js`、`server/team/task-space-*.js`、
  `server/team/task-snapshot-service.js`、`server/team/task-command-service.js`、
  `server/team/sync-agent-service.js`、团队同步 API/SSE、`sync_*` schema 或桌面控制窗口时必须遵循本文。
- 单机 watcher 与团队客户端 watcher 继续复用 `shared/trellis-watcher.js` 的事件归一化；团队客户端
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

### SQLite v10

新模式只使用以下表；旧 `project_live_*`、`team_project`、`git_operation`、`git_credential`
等表保留但不读写：

- `sync_project`、`sync_project_team_access`、`sync_project_member`
- `sync_task_space`、`sync_task_space_file`、`sync_task_space_batch`
- `sync_active_agent`、`sync_agent_binding`、`sync_agent_cursor`
- `sync_task_index`、`sync_task_index_tag`、`sync_task_space_scan_cache`
- `sync_task_assignment`
- `sync_task_command`
- `sync_conflict`、`sync_conflict_backup`、`sync_file_audit`

### 服务与 SSE

```text
createTaskSpaceService({ db, config })
createTaskSnapshotService({ db, taskSpaces, onRevisionCommitted })
createTaskCommandService({ db, taskSpaces, agents, events })
createSyncAgentService({ db, config, events })
createTaskSnapshotBackupService({ db, databaseFile, logger })
createAgentEventStream({ db, commands, logger })
```

Agent SSE 事件为 `command.available`、`agent.revoked`、`task.changed`、`cursor.invalidated`。
Board SSE 继续只发送 `tasks.changed`，页面收到后重新查询 REST 快照，不通过 SSE 传输任务正文。

## 3. Contracts

### 项目与任务空间身份

- 项目身份是规范化 Git 远端：HTTPS/SSH/scp 的协议、userinfo、默认端口、末尾 `/` 和 `.git`
  差异归一；`remote_identity_hash` 全局唯一。
- 同步空间身份是 `canonicalRemoteIdentity + branchName`，即
  `sync_task_space UNIQUE(project_id, branch_name)`。
- 同一仓库不同分支拥有独立 project taskSpace、revision、cursor、命令、冲突和索引。
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

### 路径与内容

- 只接受 `.trellis/tasks/<task-dir>/<file>` 和
  `.trellis/tasks/archive/<YYYY-MM>/<task-dir>/<file>`。
- 拒绝绝对路径、反斜杠、NUL、`.`/`..`、符号链接、非白名单扩展名和非 UTF-8 内容。
- 允许 `.json/.jsonl/.md/.txt/.yaml/.yml`；单文件不超过 1 MiB，单批正文不超过
  64 MiB / 1024 文件。JSON 请求和 Agent 大响应使用编码后 96 MiB 硬运输上限，运输上限
  不参与业务写入；超过 96 MiB 即使解码后正文不超过 64 MiB 也返回 413。
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
- 同一请求的 `batchId + clientSequence + files` 摘要幂等重放返回原 revision；同 `batchId` 不同摘要拒绝。
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
- 每次拉取前先比较本地任务目录与 cursor 基线：本地有未上传变化时先走 CAS 上传；上传成功后再
  拉取新 revision，发生冲突时停止应用远端目录。首次接入选择“仅同步无冲突项”或“暂不处理”
  跳过的本地目录作为延后状态持久化，用户再次修改前不得自动上传；延后目录随后被服务端修改时
  重新要求确认，不能覆盖本地。
- `list_local_associations` 可以把当前 taskSpace 的延后目录只读投影为
  `deferredCount/deferredTaskDirs`；缺失或损坏的 cursor 按 0 处理，不能阻断关联列表。
- 延后任务只能通过用户显式触发的补同步命令上传。补同步必须校验 approved、非只读 binding，
  复用同一 taskSpace 串行队列、限流、pending batch 和文件级 CAS；网络失败必须向调用方抛错，
  冲突必须进入现有 `task_file_conflict` 确认链路。
- Agent 在首次同步、增量 pull、上传、watcher 触发、pending retry、延后补同步、服务端目录实际写入
  以及冲突覆盖前都必须重新读取本地真实分支。分支不匹配时失败关闭：不写任务目录、不上传、不推进
  cursor、不补发 pending，并把 `BRANCH_MISMATCH` 投影到项目栏；切回绑定分支后才可恢复。
- 客户端以完整任务目录为原子单位：先在同卷临时目录写 `next`，把原目录 rename 为 `previous`，
  再 rename `next` 到目标；失败时恢复原目录。
- 服务端 revision 应用后的 watcher 事件按 `(absolutePath, sha256)` 抑制；只有内容仍匹配才吞掉事件，
  真实后续编辑必须重新上传。
- 同步队列按 taskSpace 串行。网络响应丢失时 cursor 中保留原 pending batch，重试复用原 `batchId`，
  不生成第二个 revision。
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

- schema 升级前使用 `VACUUM INTO` 写入 `backups/board.sqlite.pre-v10.*`。
- Team runtime 启动时和每 24 小时写入
  `backups/board.sqlite.snapshot.<UTC timestamp>`，保留最近 7 份。
- 备份失败只记结构化告警，不阻塞 HTTP、快照提交或 SSE。
- 客户端冲突备份位于
  `%LOCALAPPDATA%\TrellisBoard\data\agent\live-backups\<taskSpaceId>\<backupId>`。

## 4. Validation & Error Matrix

| 条件 | 结果 |
| --- | --- |
| Agent 非 active slot、binding 未批准、项目/任务空间停用 | `401/403`，不读写快照 |
| Agent 未上报 `observedBranchName` | `400 BRANCH_OBSERVATION_REQUIRED`，不写快照 |
| 上报分支与 taskSpace/binding 不一致 | `400 BRANCH_TASK_SPACE_MISMATCH`，不写快照 |
| 本地真实分支与 binding 不一致 | Agent 暂停该 binding，不写文件、不上传、不推进 cursor |
| 目标用户无在线 Agent、无 approved binding、非项目写成员 | 创建操作项前 `409`，返回用户、项目、分支和下一步 |
| 路径越界、反斜杠、非白名单扩展名、符号链接、非 UTF-8 | 整批拒绝，任务快照不变 |
| 单文件、单批、文件数超限 | 拒绝，任务快照不变 |
| JSON 编码请求或大响应超过 96 MiB | `413 BODY_TOO_LARGE`，不读取为业务批次、不写快照 |
| 同一 `batchId` 不同请求摘要 | `409` |
| `clientSequence` 不递增 | `409` |
| 任一 `baseSha256` 不一致 | `409 TASK_FILE_CONFLICT`，同批全部不写 |
| 任务目录缺 `task.json`、缺稳定 ID、移动前后 ID 不同 | `409`，整批拒绝 |
| 无变化批次 | `200 noop=true`，revision 不增加 |
| 投影尚未追上成功 revision 或负责人尚未更新 | `409 COMMAND_WAITING_INDEX`，可重试结果 |
| Agent 租约过期 | 状态恢复 `pending`，可安全重投 |
| 每日数据库备份失败 | 记录告警，服务继续运行 |
| 旧 `/api/agent/live-*`、Git 凭据、probe、refresh、repair、git-operation 路由 | `404` |

## 5. Good / Base / Bad Cases

- Good：A 修改 `task.json` 并以服务端当前摘要为基线提交；revision+1，B 从 cursor 拉取后原子替换
  完整任务目录，再推进 cursor；Board 收到 `tasks.changed` 后重载 REST 快照。
- Good：A 把任务从活动目录移动到归档目录，一个批次包含旧目录删除和新目录写入；B 不会恢复旧活动路径。
- Good：同一仓库为主分支和 feature 分支各建一个 worktree；两个 `localRepoKey` 不同，各自只监听当前分支。
- Base：本地和服务端任务目录文件集合及摘要相同，不写文件、不增加 revision。
- Base：同步请求已提交但响应丢失，客户端重启后复用 pending `batchId`，服务端返回原 revision。
- Bad：同一个 Git 工作目录先绑定 main 又保留 feature binding；watcher 会把一份本地修改双写到两个 taskSpace。
- Bad：以“后到覆盖先到”写同一任务文件，会静默丢更新；服务端必须使用文件级 CAS。
- Bad：收到 watcher 后只按路径抑制，不校验新摘要，会吞掉远端应用后紧接发生的真实本地编辑。
- Bad：服务端在 HTTP 请求栈里 clone/fetch 或扫描项目 Git，会重新引入两套事实源和长时间阻塞。
- Bad：命令失败时提前插入正式任务卡或修改负责人，会让 Board 显示未实际落盘的状态。
- Bad：为了覆盖任意 JSON 转义最坏膨胀，把 96 MiB 运输硬上限提高到数百 MiB；这会放大单请求
  内存占用和拒绝服务风险。64 MiB 是正常文本任务目标，运输表示仍必须受 96 MiB 约束。

## 6. Tests Required

- `tests/shared-remote-identity.test.js`：HTTPS/SSH/scp 归一、端口、非法协议和分支。
- `tests/task-snapshot.test.js`：路径边界、LF 摘要、任务目录分组、1024/1025 文件、
  64 MiB/64 MiB+1 字节、移动和六类差异。
- `tests/database-v10.test.js`：新旧表并存、升级备份、旧数据保留和重复启动。
- `tests/team-task-spaces.test.js`：全局唯一、owner/invite、同远端不同分支隔离，以及切换分支只撤销
  当前 Agent 的旧 binding、保留旧 taskSpace 和其他设备 binding。
- `tests/team-task-snapshot.test.js`：首次写入、CAS 冲突、整批回滚、幂等、删除墓碑、覆盖备份、
  非法/不一致 `observedBranchName`，以及升级前 pending batch 补字段重放。
- `tests/team-task-index-v10.test.js`：tasks-only 物化、归档移动、revision 隔离、不读取 Git/workspace。
- `tests/team-agent-slot.test.js`：新设备踢下线、旧 SSE 关闭、旧命令取消、新设备重建 binding。
- `tests/team-task-commands.test.js`：在线目标、命令状态机、租约恢复、索引等待、重试和取消。
- `tests/team-realtime-sync.test.js`：两个真实 Agent HTTP 快照 + SSE 对齐、CAS 并发和离线拒绝。
- `tests/team-gitless-http.test.js`：新路由可用，旧 Git/live 路由 404，Team 启动不访问 Git 工作副本。
- `tests/team-gitless-http.test.js` 还必须断言：超过旧 9 MiB 的合法 Agent 批次可写入；
  Content-Length 超过 96 MiB 返回 `413 BODY_TOO_LARGE`；普通 JSON 仍为 64 KiB；缺少
  `observedBranchName` 返回 `400 BRANCH_OBSERVATION_REQUIRED`。
- `tests/team-release.test.js`：服务端仓库无工作副本，命令成功前不生成正式任务。
- `tests/team-events.test.js`：Agent SSE 只包含新事件，旧事件游标和覆盖协议不存在。
- `agent/test/project-onboarding.test.js`：仓库预检、固定 CLI 初始化、推送状态、已有 `.trellis`
  和同 `localRepoKey` 切换分支时替换旧本地 binding。
- `agent/test/task-snapshot-sync.test.js`：首次/增量、cursor v3 文件基线、离线并发冲突、延后目录、
  目录移动和 pending batch 重放；还应断言上传请求不重叠、6 批滑动窗口不超过 5 批、429 最多
  重试 2 次且复用原请求、部分 bootstrap 可续传、并发 server-only 会重新进入审查，以及错分支
  上传/拉取/pending/deferred 全部失败关闭并在切回后恢复。
- `agent/test/runtime-cli.test.js`：心跳不覆盖本地分支错误；配置读取兼容历史双绑定但禁止新增。
- `agent/test/git-sync.test.js`：错分支和 detached HEAD 拒绝；同一仓库两个 worktree 生成不同
  `localRepoKey`。
- `tests/onboarding-associations.test.js`：Windows 仓库路径比较忽略大小写、斜杠方向和末尾分隔符。
- `tests/task-space-duplicate-cleanup.test.js`：默认 dry-run、只墓碑指定旧 taskSpace、不动归档、
  `VACUUM INTO` 备份、内容差异和缺少稳定 ID 时拒绝自动清理。
- `agent/test/task-command.test.js`：真实 `task.py`、负责人写入、路径级 dirty 保护、上传失败不报成功。
- `tests/desktop-realtime-apply.test.js`：首次冲突、归档移动、备份、batchId 重试。
- `tests/desktop-package.test.js`：协议 v3、Trellis runtime 资源、窄 Tauri capability 和新控制窗口命令。

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
