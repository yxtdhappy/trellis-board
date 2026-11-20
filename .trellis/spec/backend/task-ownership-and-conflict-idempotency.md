# 任务级分支归属与冲突幂等

## 1. Scope / Trigger

- Trigger：修改任务快照 watcher、首次/增量同步、pending batch、冲突、任务归属 API、
  `task.py set-branch` 或历史冲突清理时。
- `binding.branchName == observedBranchName` 只证明绑定分支与真实检出分支一致；它不能证明
  `.trellis/tasks` 下每个任务都属于该分支。任务同步必须再做任务级归属门禁。
- 项目另有固定 `baselineBranch`。`task.json.branch` 只表示来源分支；任务进入基线 `HEAD` 并经基线
  taskSpace 接纳后，有效归属才变为基线分支。
- 事故背景：feature 分支任务的未跟踪目录残留在 main 工作区，旧实现把整棵 tasks 当作 main 任务上传；
  CAS 冲突后 watcher/retry 反复上传，服务端每次都新增 pending conflict，最终超过 Agent 1 MiB 响应上限。

## 2. Signatures

```text
POST /api/agent/task-spaces/:taskSpaceId/task-ownership
```

请求：

```json
{
  "taskIds": ["task-a", "task-b"]
}
```

响应：

```json
{
  "projectTaskSpaces": [
    { "taskSpaceId": "space-main", "branchName": "main", "isBaseline": true }
  ],
  "tasks": [
    {
      "taskId": "task-a",
      "claims": [
        {
          "taskSpaceId": "space-main",
          "branchName": "main",
          "taskBranch": "codex/feature-a"
        }
      ]
    }
  ]
}
```

第一次把来源分支任务写入基线 taskSpace 时，`POST /changes` 可携带：

```json
{
  "mergeEvidence": {
    "version": 1,
    "type": "tracked-in-head",
    "taskId": "task-a",
    "taskDir": ".trellis/tasks/task-a",
    "trackedPath": ".trellis/tasks/task-a/task.json",
    "sourceBranch": "dev1",
    "baselineBranch": "dev",
    "headCommit": "<40 或 64 位小写 SHA>"
  }
}
```

Agent 公共 facade：

```text
AgentTaskSnapshotSync.listTaskOwnership(taskSpaceId)
AgentTaskSnapshotSync.setTaskOwnership(taskSpaceId, decisions)
```

cursor 兼容字段：

```json
{
  "ownershipPending": {
    ".trellis/tasks/task-a": { "fingerprint": "<sha256>", "reason": "TASK_OWNERSHIP_REQUIRED" }
  },
  "conflictBlocked": {
    ".trellis/tasks/task-a": { "conflictId": "<stable-id>" }
  }
}
```

## 3. Contracts

- `groupTaskSnapshotFiles()` 从 `task.json.id` 和 `task.json.branch` 生成 `taskId/taskBranch`；
  空、非法和非字符串 branch 都按未归属处理。
- 本地明确 branch 与 binding 相同才可同步；明确为其他分支时暂停。空 branch 只有在服务端 claim
  或项目唯一 taskSpace 能给出唯一分支时才自动 `task.py set-branch`，多个明确 claim 必须批量确认。
- 当前 binding 不是项目基线时，错分支任务继续按 `TASK_BRANCH_OTHER` 暂停；是基线时，Agent 读取一次
  当前完整 HEAD，仅当精确的 `<taskDir>/task.json` 存在于该 HEAD 时生成 `tracked-in-head` 证据。
  同分支任务不得读取 Git tree。
- Git tree 只按 `binding + 真实分支 + 完整 HEAD SHA` 缓存在进程内。每次候选判断允许一次
  `git rev-parse --verify HEAD^{commit}`；HEAD 未变直接查 HashSet，首次或变化时才执行一次
  `git ls-tree -r --name-only <HEAD> -- .trellis`。进程重启后允许重扫一次。
- 服务端不执行 Git。证据是已批准基线 Agent 的受信声明，不是服务端独立证明；服务端只校验 active
  Agent、approved binding、`observedBranchName`、binding、taskSpace、项目基线、任务 ID、目录、
  `task.json` 来源分支和证据结构一致。
- 归属判定必须发生在批次预占前。watcher、pull dirty、bootstrap、deferred、命令上传和冲突覆盖都复用
  同一门禁；`_uploadBatch()` 重试 pending 时不得改写已持久化 files，否则同一 `batchId` 会变成不同请求摘要。
- 混合目录中只有全部任务都可安全独立处理时才部分放行；出现未知目录、归属暂停或可能的归档移动时整批暂停。
- 服务端 `validateCompleteTaskGroups()` 先校验完整任务身份和来源分支，再按目标 taskSpace 做归属判定：
  基线首次接纳来源不同任务缺少证据返回 `TASK_MERGE_EVIDENCE_REQUIRED`；证据字段不匹配返回
  `TASK_MERGE_EVIDENCE_INVALID`；非基线 taskSpace 收到已被基线接管的同一稳定任务 ID 返回
  `TASK_OWNED_BY_BASELINE`。拒绝时不得写文件、证据、审计、batch 或 conflict，也不得递增 revision。
- 基线已有同一稳定任务 ID 时，普通上传不要求重复证据。普通同分支任务也不要求证据；证据只在
  基线首次接纳来源不同任务时生效。
- 证据与快照、首次写入审计在同一事务提交。文件内容本来就一致时允许写入证据并返回 `noop=true`，
  不增加 revision。
- 同一 `(taskSpaceId, agentId, taskIdentity)` 的 pending conflict 只能有一行。新冲突更新 files、
  serverRevision、clientSequence 和 batchId，保持原 conflict ID；历史 `task_id=NULL` 通过 taskDir 兜底并可回填。
- `listConflicts()` 对历史重复行按 Agent + task 身份折叠，只返回每组最新 pending，排序必须有稳定
  tie-breaker，不能先把全部重复正文加载到内存。
- Agent 收到冲突后在 cursor 写 `conflictBlocked`；watcher、pull、SSE、重启和 pending retry 在用户
  `use-server` 或成功 `overwrite-server` 前不得自动重试。`save-local-copy` 不解除 pending。
- `ownershipPending`/`conflictBlocked` 的清理必须在 cursor 锁内单次读改写；本地已删除或移动的目录
  不能永久残留待确认状态。
- 冲突状态必须可重新暴露：`live_conflicts_show` 拉服务端 `/conflicts`，只对 `fetch_directory` 返回 200
  且文件非空的冲突重建 `task_file_conflict` 控制事件；服务端列表已不含的目录一律清 `conflict_blocked`，
  目录已 404 的死冲突直接按 `use-server` 收敛，不留残影。
- 任务归档必须在同一事务把该任务 pending `sync_conflict` 置 `resolved`，`listConflicts()` 追加
  “排除已归档任务”的防御过滤；否则用户已归档的冲突会永久 pending。
- `assertReadable` 活跃路径未命中时按 basename 反解归档行并返回 `409 TASK_ARCHIVED`，不得用 legacy
  403 文案掩盖“任务已归档”；只有确实存在 legacy 活行时才返回 403。
- 清理脚本允许重复运行：remove taskSpace 仍为 `active` 时走原有“墓碑重复目录并停用”路径；
  remove 已经 `disabled` 时，只有在显式传入 `--cleanup-conflicts`、
  `--disable-remove-task-space` 且 `filesToDelete=0` 时，才允许 conflict-only apply。
  不得为了让脚本通过而临时把已停用 taskSpace 重新置为 `active`，remove revision 也不得因此递增。

## 4. Validation & Error Matrix

| 条件 | 结果 |
| --- | --- |
| binding 分支与真实 Git 分支不一致 | 现有 `BRANCH_MISMATCH`，不上传 |
| 任务 branch 明确为其他分支 | `TASK_BRANCH_OTHER`，本地保留，不上传，不创建 conflict |
| 基线 Agent 发现错分支任务不在当前 HEAD | 继续暂停，不生成证据 |
| 基线 Agent 发现错分支任务精确路径在 HEAD | 附证据上传基线 taskSpace |
| 非基线 Agent 提交合入证据 | `409 TASK_MERGE_EVIDENCE_INVALID` |
| 基线首次收到来源不同任务但无证据 | `409 TASK_MERGE_EVIDENCE_REQUIRED` |
| 证据任务 ID、目录、路径、来源/基线分支或 HEAD SHA 不匹配 | `409 TASK_MERGE_EVIDENCE_INVALID` 或 `400 INVALID_INPUT` |
| 来源 taskSpace 新增、修改、移动或删除已由基线接管的稳定任务 ID | `409 TASK_OWNED_BY_BASELINE` |
| 任务 branch 为空且服务端/项目主张唯一 | 自动写 `task.json.branch` 后继续判定 |
| 多个 taskSpace 给出多个非空 task branch | 单次 `task_ownership_review`，cursor 记 fingerprint |
| 同一 fingerprint 再次被 watcher/重启发现 | 不再自动提示，不上传 |
| 服务端收到空 task branch | `409 TASK_OWNERSHIP_REQUIRED`，整批不写 |
| 服务端收到错误 task branch | `409 TASK_OWNERSHIP_MISMATCH`，整批不写 |
| pending batch 文件字节保持不变 | 按原 batchId/clientSequence/files 重放 |
| 用户改归属导致 pending 文件会变化 | 不原地改写 pending；失败关闭并等待显式处理 |
| 现有 pending conflict | 返回稳定 conflictId，不新增同类行 |
| 客户端目录在服务端由其他负责人持有 | `403 TASK_WRITE_FORBIDDEN` → cursor `readonlyTaskDirs`，跳过该目录，整次拉取继续 |
| 服务端任务已归档但活跃目录仍有 legacy 文件 | 按 basename 反解归档行 → `409 TASK_ARCHIVED`，客户端跳过并清理活跃副本 |
| 归档任务仍有 pending conflict | 归档事务内置 `status='resolved'`，`listConflicts()` 不再返回 |
| 项目栏点击“N 个冲突待处理”但服务端已无冲突 | `live_conflicts_show` 返回 false，清理 `conflictBlocked`，UI 提示“没有待处理的任务冲突” |
| 同一任务跨不同 Agent 冲突 | 每个 Agent 保留独立 pending，便于定位来源 |

## 5. Good / Base / Bad Cases

- Good：main binding 发现本地任务 `branch=codex/feature-a`，暂停该目录；当前分支其他任务仍可独立同步。
- Good：dev binding 发现 `branch=dev1` 的 17 个任务都在同一 dev `HEAD`，只扫描一次 tree，为每个任务
  分别附证据并写入 dev taskSpace。
- Good：dev1 taskSpace 保留已合入任务旧快照，但默认列表只显示 dev 基线副本，卡片显示
  “分支 dev · 来源 dev1”。
- Good：空 branch 的任务只在服务端一个 claim 指向 feature-a 时自动补齐；main 下暂停，切到 feature worktree 后恢复。
- Good：同一 Agent 连续十次 CAS 冲突只更新一条 pending，conflict ID 稳定，列表只返回一条。
- Base：全部任务 branch 与 binding 相同且无 pending，正常按任务目录 CAS 上传。
- Base：旧 cursor 没有 `ownershipPending/conflictBlocked`，按空对象读取。
- Bad：只校验 Git HEAD 后监听整棵 tasks，会把其他分支残留目录写进当前 taskSpace。
- Bad：把 `base_branch` 相等或工作区文件存在当成已合入证据。
- Bad：普通 watcher 事件每次执行 `git ls-tree`，或服务端为验证证据启动项目 Git/Python 子进程。
- Bad：来源 taskSpace 继续覆盖已由基线接管的同一稳定任务 ID，形成两个活跃归属。
- Bad：冲突后每个 watcher 事件都新增行，历史列表把 1000+ 记录一次返回，Agent 响应超过 1 MiB。
- Bad：pending 重试前用最新本地 branch 改写 batch files，却复用原 batchId，破坏幂等摘要。

## 6. Tests Required

- `task-snapshot.test.js`：task id/branch 解析、空/非法/非字符串 branch、归档目录。
- `team-task-snapshot.test.js`：ownership API 身份隔离、空/错误 branch 整批拒绝、稳定 conflict ID、
  历史重复列表折叠、不同 Agent 隔离、基线证据接纳、no-op 证据、证据字段拒绝和来源写入门禁。
- `team-gitless-http.test.js`：新 ownership 路由鉴权、200 ID 上限和不泄漏任务正文。
- `packages/desktop/src-tauri/src/agent/task_sync.rs` 内单元测试：watcher/pull/pending/bootstrap/deferred/command/overwrite
  全部经过归属门禁；唯一归属自动补齐；歧义只提示一次；其他分支任务不调用上传；pending 字节不变；
  conflictBlocked 在重启后保持、解决后清除；HEAD 未变不重扫、pending 证据原样重放、
  `TASK_OWNED_BY_BASELINE` 后本进程停止主动上传。
- `task-space-duplicate-cleanup.test.js`：默认 dry-run 零写入、VACUUM INTO 备份、只墓碑重复目录、
  每组只保留最新 pending、显式 disabled、状态/revision 漂移拒绝，以及“旧 taskSpace 已 disabled
  且没有重复文件时仍可幂等清理 conflict”。
- `team-agent-task-readonly-api.test.js`：`GET …/tasks` 只含 `archived = 0` 且按归属过滤正文，非负责人
  可读 `GET …/tasks/:id/files`，已归档任务返回 404；`team-task-control.test.js` 覆盖归档 409、
  未知 404、legacy 403 文案、归档同事务收敛 conflict 与 `listConflicts` 过滤。
- `task_sync.rs` 单元测试：`with_task_dir` 注入与保留、错误事件同时带 `errorCode`/`serverCode`、
  `readonlyTaskDirs` 往返与 archive 剔除、403/归档分类（`AUTH_REVOKED` 不算 403）、归档副本摘要一致性。

## 7. Wrong vs Correct

### Wrong

```js
// pending 已经持久化，但重试前用最新本地内容覆盖 files。
const prepared = await prepareLatestFiles(pending.files)
await api.uploadTaskSpaceChanges(taskSpaceId, {
  batchId: pending.batchId,
  clientSequence: pending.clientSequence,
  files: prepared,
})
```

同一 batchId 的请求摘要发生变化：若上次请求已提交但响应丢失，服务端无法按幂等重放，反而会拒绝；
若上次未提交，客户端又把“重试”变成了一次新语义写入。

### Correct

```js
// 归属/自动补齐在预占前完成；pending 重试发送原始持久化文件。
const ownership = await resolveOwnershipBeforeReserve(taskDirs)
if (!ownership.syncable) return ownership.skipped
const pending = await reserveBatch(taskSpaceId, buildFilesAfterOwnership())
await api.uploadTaskSpaceChanges(taskSpaceId, {
  batchId: pending.batchId,
  clientSequence: pending.clientSequence,
  files: pending.files,
  mergeEvidence: pending.mergeEvidence,
})
```

服务端再对完整 task 目录、目标 taskSpace、项目基线和证据做统一归属门禁。只有基线首次接纳来源
不同任务时才允许 `task.json.branch != taskSpace.branchName`，且必须有匹配的 `tracked-in-head`
证据；来源 taskSpace 在基线接管后只保留只读旧快照。

## 场景：项目级待归属摘要收件箱

### 1. Scope / Trigger

- Trigger：修改空分支任务展示、Agent ownership inbox、项目 Board 计数或正常任务摘要清理时。

### 2. Signatures

- Agent：`PUT /api/agent/task-spaces/:taskSpaceId/ownership-inbox`
- Web：`GET /api/ownership-inbox?teamId=&projectIds=&limit=&cursor=`
- 项目 DTO：`ownershipInboxCount`
- 表：`sync_task_ownership_inbox`

### 3. Contracts

- 摘要收件箱只保存任务 ID、目录、标题、原因、来源 taskSpace/Agent、来源分支、fingerprint 和时间；
  不保存正文、附件、绝对路径或秘密。
- 摘要不属于任何 taskSpace，不写入 `sync_task`，不创建 assignment、lease、command，也不参与
  ownership、merge evidence、CAS 或普通分支统计。
- Agent 写入复用 active Agent、approved 非只读 binding、项目和 taskSpace 读权限，并校验
  `observedBranchName` 与服务端 taskSpace/binding 一致。
- 单次 upsert + delete 最多 200 项并整体校验；upsert/delete 必须幂等，同一稳定任务的多来源行按
  项目 + taskId 聚合展示。
- inbox delete 的目录身份固定为 `project_id + source_task_space_id + source_agent_id + task_dir`；
  `taskId` 只做旧客户端兼容和格式校验，不能作为唯一删除键，也不能从目录名反推。
- 正常任务快照被接纳时，必须在同一 `BEGIN IMMEDIATE` 事务删除该 `projectId + taskId` 的全部摘要；
  摘要删除失败时任务快照整体回滚。
- inbox 变化只发布轻量 `tasks.changed`，不推进 taskSpace revision。`status.ownershipInboxCount`
  按项目聚合稳定的 taskId 数，并进入 status ETag。

### 4. Validation & Error Matrix

| 条件 | 结果 |
| --- | --- |
| 同一来源重复 upsert | 更新摘要，保留 firstSeenAt |
| delete 目标不存在 | 成功且幂等 |
| delete 只携带 `taskDir` | 按当前项目、taskSpace、Agent 和目录精确删除 |
| delete 的 `taskId` 与目录 basename 不一致 | 仍按 `taskDir` 删除，不能返回成功但零行 |
| 父目录 `.trellis/tasks` 缺失或不可读 | 客户端不得提交批量 delete，保留 cursor |
| 客户端删除请求网络失败或服务端 5xx | 保留 `ownershipPending`/`pendingRejected`，后续重试 |
| 客户端连接不支持 inbox 的旧服务端（404/405） | 可清对应本地摘要；旧服务端不可能存在远端摘要行 |
| 单批超过 200 项 | 400，整批不写 |
| projectIds 越权 | 403 |
| 正常任务写入和摘要清理任一失败 | 两者整体回滚 |
| 旧服务端无 inbox API | Agent 标记可选能力缺失，普通同步继续 |

## 场景：枚举期归属过滤与新建/改派归属校验

### 1. Scope / Trigger

- Trigger：修改本地任务目录枚举、首次同步差异分类、增量同步 dirty 判定、归属收件箱上传、
  服务端 `POST /changes` 新建分支或 `assign_task` 命令时。
- 背景：服务端任务空间快照按负责人裁剪（`visibleTaskIds`），他人任务在客户端看来与“服务端没有”
  完全无法区分；只靠上传被拒后写 `readonlyTaskDirs`，他人任务仍会先进入差异弹窗、先被上传、
  先触发 404 探针。所有权必须在**枚举出口**就生效，而不是在失败路径上补救。

### 2. Signatures

```text
packages/desktop/src-tauri/src/agent/task_sync/ownership_filter.rs
TaskSync.local_owner_id(&binding) -> Option<String>
TaskSync.retain_owned_groups(&binding, groups: Vec<SnapshotGroup>) -> Vec<SnapshotGroup>
TaskSync.owns_task_dir(&binding, owner_id: &str, group: &SnapshotGroup) -> bool

packages/server/team/task-control/uploads.js
assertUploadAllowed(agent, taskSpaceId, complete, input = {}, context = { files, projectId })

packages/server/team/task-command-service.js
assertCanAssign(actor, indexed, assigneeUserId, projectId)
```

### 3. Contracts

- 归属谓词：`task.json.assignee` 非空优先，否则 `creator`；大小写不敏感比较。两侧任一为空、
  读不到 `task.json`、读不到本机 dev ID 时一律**保留**（fail open），避免误吞本人任务。
- 本机 dev ID 复用 `agent::worktree::developer_id(repo_path, config, remote_identity_key)`：
  先读 `<repo>/.trellis/.developer` 的 `name=`，再回退同 remote 主仓库，最后回退 `config.username`。
- 服务端控制行可用时优先以控制行判定：`TaskControlState::is_writable_local()`
  （`materialized|claimed|pending_delivery`）即保留，即使 `task.json` 指向他人。
- `retain_owned_groups()` 必须在 `local_groups()` / `local_metadata_groups()` 的唯一出口调用，
  使首次同步差异、增量同步 dirty/deferred、归属收件箱、冲突流程共享同一过滤；`read_only` binding
  或空分组直接短路返回，不做 Git/文件探测。
- 被过滤的目录不得上传、不得进入差异列表、不得触发 `fetch_directory` 探针、不得写
  `readonlyTaskDirs`；只允许一条 warn 日志（`跳过他人任务目录`）。
- 服务端 `assertUploadAllowed` 在**任务行不存在**时必须校验上传文档解析出的负责人：
  `tasks.resolveAssignee()` 的 `assignee.userId !== agent.userId` 返回
  `403 TASK_WRITE_FORBIDDEN`，不得建行。行已存在时的 409/租约语义不变。
- `assign_task` 只允许三种操作者：目标负责人等于操作者（自取）、当前负责人、项目 `lead`；
  其他成员返回 `403 FORBIDDEN` 且不写命令行。任务是否为当前负责人读取权威 `sync_task` 行，
  不读 `task.json`。

### 4. Validation & Error Matrix

| 条件 | 结果 |
| --- | --- |
| 本地目录 `assignee`/`creator` 都是他人 | 枚举期丢弃，不进差异、不上传、不探针 |
| 本地目录 owner 是本机 dev ID（大小写不同） | 保留，正常参与同步 |
| 本地目录无 `assignee`/`creator` | 保留（fail open） |
| 本地 `task.json` 不可读或解析失败 | 保留（fail open） |
| 无 `config.json` 或 `.trellis/.developer`，dev ID 取不到 | 全部保留，不误吞 |
| 服务端控制行为 `materialized/claimed/pending_delivery` | 保留，即使 `task.json` 指向他人 |
| 服务端无任务行、上传文档负责人是他人 | `403 TASK_WRITE_FORBIDDEN`，不建行、不写文件 |
| 服务端无任务行、上传文档无负责人 | 回退上传者，正常建行 |
| 服务端已有他人的行 | 既有 `409 TASK_WRITE_FORBIDDEN`，语义不变 |
| 非负责人、非 lead 的成员改派他人任务 | `403 FORBIDDEN`，不写命令 |
| 当前负责人或项目 lead 改派 | `202`，命令入队 |
| 普通成员改派给自己 | `202`（自取） |

### 5. Tests Required

- `src/agent/task_sync/tests/ownership_filter.rs`：他人目录被丢弃、本人 assignee/creator 保留、
  无 owner 保留、控制行可写时保留、无本地身份时全部保留。
- `team-task-control.test.js`：无任务行时他人负责人上传被拒且不写入任何行；无负责人仍可建行；
  已有他人行仍是 409。
- `team-task-commands.test.js`：自取、当前负责人、lead 改派成功；其他成员 403 且无命令行。
