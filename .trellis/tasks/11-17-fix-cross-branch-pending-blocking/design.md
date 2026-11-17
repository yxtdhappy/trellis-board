# 活动任务同步一致性与项目级待归属收件箱设计

## 1. 目标与边界

本设计同时修复两条相关链路：

1. Agent 上传 pending 不能阻塞同 taskSpace 的其他活动任务，上传应答不能冒充本地已经应用的
   revision。
2. 无法确定分支归属的活动任务必须由服务端 Board 在项目级持续展示，但该展示只保存有界摘要，
   不复制任务正文，也不把任务伪装成任何分支 taskSpace 的任务。

必须保持的不变量：

- pending batch 是不可变请求快照，重放时只能复用原
  `batchId/clientSequence/files/mergeEvidence`。
- `cursor.revision` 只表示“本地已经完整应用的最高服务端 revision”。
- 服务端不接收 `task.json.branch=null` 的任务正文到任何分支 taskSpace。
- 待归属摘要不属于 taskSpace，不参与 ownership、merge evidence、CAS、普通分支统计和归档。
- 内容冲突不允许通过“用服务端最新摘要当 base”自动覆盖本地或远端。

不在本设计内：

- Web 端直接修改 `task.json.branch` 或下发跨分支归属命令。
- 自动删除本地任务、自动挑选有歧义的分支。
- 归档 Git 同步、详情全文镜像和附件镜像。

## 2. 根因与边界

### 2.1 pending 队头阻塞

当前 [task_sync.rs](../../../packages/desktop/src-tauri/src/agent/task_sync.rs) 的
`upload_directories()` 在重试 pending 后，只要返回 `skipped=true` 就直接退出。
同时 `upload_batch()` 在发请求前重新读取当前本地 `task.json.branch`，并与 pending 中的快照比较；
这会把“原样重放”变成“用当前文件重新判定批次”。

修复必须区分：

- **新批次**：生成批次前执行完整 ownership 分类和必要校验。
- **pending 重放**：不重新判定原批次内容，只补 `observedBranchName` 后原样发送。

### 2.2 revision 跳跃

上传成功后服务端返回新 revision，但该 revision 可能包含本客户端尚未应用的他人变更。
当前客户端把这个返回值写入 cursor，下一次 pull 从错误位置开始，形成 revision 墓碑。

上传成功只更新：

- `sequence`
- 已确认文件 `baselines`
- pending 状态

不得更新：

- `cursor.revision`

### 2.3 服务端没有待归属通道

- 服务端快照写入明确拒绝空分支任务：
  [task-snapshot-service.js](../../../packages/server/team/task-snapshot-service.js)。
- 普通任务查询按 taskSpace 集合读取索引，索引分支来自 taskSpace，而不是待归属状态：
  [task-space-index.js](../../../packages/server/team/task-space-index.js)。
- Board UI 只在分支 taskSpace 和现有本地关联状态中展示任务，没有项目级摘要通道。

因此不能把空分支任务塞进任意 taskSpace 后“临时显示”。必须增加项目级摘要收件箱。

当前 v16 已新增 `sync_task` / `sync_task_lease` 任务控制面，它只承接真正进入某个分支
taskSpace 的任务，并负责任务版本、认领、写租约和 handoff。待归属摘要没有 taskSpace、
没有 assignee/lease，也不允许调用上传控制面，因此必须使用独立摘要表；不能把摘要写入
`sync_task`，也不能从摘要绕过 `claim/lease/taskVersion` 后直接写正文。

## 3. Agent 同步状态机

### 3.1 cursor v3 兼容扩展

`Cursor` 增加向后兼容字段：

```json
{
  "revision": 412,
  "revisionGuardVersion": 1,
  "pendingRejected": {
    ".trellis/tasks/example": {
      "batchId": "<uuid>",
      "clientSequence": 123,
      "reason": "TASK_MERGE_EVIDENCE_REQUIRED",
      "createdAt": "<ISO>",
      "blockedAt": "<ISO>"
    }
  }
}
```

- 缺失 `revisionGuardVersion` 按 0 读取。
- `pendingRejected` 只保留有上限、可诊断的摘要，不保存被明确拒绝批次的完整 `files`。
- 同一 taskDir 新拒绝覆盖旧摘要；最多保留最近 50 项，按 `blockedAt` 淘汰。
- 任务成功同步、重新进入可同步 ownership，或用户明确处理归属时可删除对应摘要。
- 现有 `ownershipPending` 继续保存 taskDir → fingerprint，用于本地归属审查去重。

### 3.2 pending 重放结果

| 结果 | pending | cursor | 当前次其他任务 |
| --- | --- | --- | --- |
| 2xx 或幂等重放成功 | 清除 | 更新 sequence/baselines，不推进 revision | 继续 |
| 明确 ownership/证据拒绝 | 清除 | 写 ownershipPending 或 pendingRejected | 继续 |
| `TASK_FILE_CONFLICT` | 清除 | 进入现有 conflictBlocked | 停止并弹确认 |
| `TASK_OWNED_BY_BASELINE` | 清除 | 标记 baseline owned | 跳过该任务，继续其他任务 |
| 网络失败、超时、429 重试耗尽、未知失败 | 保留原批次 | 不猜测已提交 | 停止该 taskSpace |

明确拒绝集合：

```text
TASK_OWNERSHIP_REQUIRED
TASK_OWNERSHIP_MISMATCH
TASK_MERGE_EVIDENCE_REQUIRED
TASK_MERGE_EVIDENCE_INVALID
TASK_OWNED_BY_BASELINE
```

### 3.3 pending 原样重放

`upload_persisted_batch()` 首次发送前执行 ownership 分类；`retry_pending_batch()` 不再调用
`resolve_task_ownership()`，也不把当前本地文件与持久化 pending 比较。

发送循环只允许改变：

- 每次实际请求重新观测的 `observedBranchName`
- 服务端要求恢复的更高 `clientSequence`

其他字段必须保持 pending 原值。`clientSequence` 恢复后同步更新持久化 pending 中的序列，
避免下一次重启再次使用旧序列。

### 3.4 revision 只由 pull 推进

- `upload_batch()` 成功后写入 `cursor.revision` 的原值，不写入响应 revision。
- `write_server_cursor()` 只在完整 pull/apply 成功后调用。
- `upload_directories()` 返回中区分：
  - `revision`: 已应用 revision
  - `committedRevision`: 本次最后一次上传得到、但尚未应用的 revision
- SSE 的 `should_pull_for_event()` 继续使用 cursor 的已应用 revision。

### 3.5 旧 cursor 一次性修复

新增常量：

```text
REVISION_GUARD_VERSION = 1
```

已经完成首次同步但 `revisionGuardVersion < 1` 时，在重放 pending 之后执行一次
`repair_revision_guard()`：

1. 以 `afterRevision=0` 获取完整服务端快照。
2. 完整读取本地活动任务并与服务端按稳定 task ID 分类。
3. `server-only`：本地不存在该任务目录时下载并原子写入。
4. `local-only`：通过现有 ownership 门禁；
   可同步则上传，空分支则发布待归属摘要，其他分支则暂停。
5. `content-conflict/move-delete/invalid`：不覆盖任一侧，写入 `deferred` 并进入现有差异确认。
6. 重新获取一次完整快照，确认非 deferred 目录已收敛。
7. 用验证后的快照摘要重建 `baselines`，推进到验证快照 revision，并写入
   `revisionGuardVersion=1`。

安全原则：

- 不删除任何本地活动任务。
- 不把服务端完整快照摘要直接当成冲突目录的新 CAS 基线。
- 远端删除与本地残留无法可靠区分时，local-only 任务重新上传，允许恢复远端曾删除的任务。
- 修复中途失败时保持 guard=0 和原 pending；下次启动重试整次修复。
- 新 binding 完成首次同步后直接写入当前 guard 版本，不额外执行修复。

### 3.6 本地关联状态投影

`device.rs` 的 `LocalAssociation` 扩展为只读投影：

```text
pendingUploadCount
pendingUploadTaskDirs
pendingRejectedCount
pendingRejectedTaskDirs
conflictPendingCount
conflictPendingTaskDirs
```

数据只来自 cursor：

- `pending` 投影为上传重试状态；
- `pendingRejected` 投影为服务端拒绝待处理；
- `ownershipPending` 继续投影为待确认归属；
- `conflictBlocked` 投影为冲突待处理。

ProjectRail 展示优先级保持“错误/绑定失效 > 冲突 > 服务端拒绝 > 待确认归属 > 上传重试 >
正常”，不能把 pending 永远显示成“同步正常”。这些字段只做状态展示，不放宽实际上传门禁。

## 4. 服务端项目级待归属收件箱

### 4.1 数据模型

SQLite 从 v16 升到 v17，新增摘要表：

```sql
CREATE TABLE sync_task_ownership_inbox (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES sync_project(id) ON DELETE CASCADE,
  source_task_space_id TEXT NOT NULL REFERENCES sync_task_space(id) ON DELETE CASCADE,
  source_agent_id TEXT NOT NULL REFERENCES agent_device(id) ON DELETE CASCADE,
  source_user_id TEXT NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL,
  task_dir TEXT NOT NULL,
  title TEXT NOT NULL,
  reason TEXT NOT NULL,
  source_branch_name TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(source_task_space_id, source_agent_id, task_id)
);
```

索引：

- `(project_id, task_id, last_seen_at DESC)`
- `(source_task_space_id, source_agent_id)`

每个来源设备和分支保留一行；同一稳定任务 ID 被多个来源发现时，项目视图聚合为一条记录，
同时展示来源分支和来源客户端数量。这样不会把某一来源的后到摘要误当成全局唯一事实。

约束：

- `title` 最多 300 个字符。
- `task_dir` 必须是 `.trellis/tasks/<task-dir>`，不含归档路径。
- `fingerprint` 必须是 64 位小写 SHA-256。
- 不保存正文、附件、Token、Cookie 或本地绝对路径。
- 摘要表不参与 `sync_task` / `sync_task_lease` 控制面，不创建任务 assignment、lease 或命令。

### 4.2 Agent 摘要同步 API

```text
PUT /api/agent/task-spaces/:taskSpaceId/ownership-inbox
```

请求：

```json
{
  "observedBranchName": "main",
  "upserts": [
    {
      "taskId": "task-a",
      "taskDir": ".trellis/tasks/task-a",
      "title": "任务 A",
      "reason": "TASK_OWNERSHIP_REQUIRED",
      "fingerprint": "<sha256>"
    }
  ],
  "deletes": [
    {
      "taskId": "task-b",
      "taskDir": ".trellis/tasks/task-b"
    }
  ]
}
```

约束：

- 复用 `bindingContext()`；必须是 active Agent、approved、非只读 binding、有效项目和 taskSpace。
- `observedBranchName` 继续通过真实分支校验。
- 单次最多 200 个 upsert/delete 变更，upsert + delete 总数同样受限。
- upsert 幂等：相同来源键更新标题、原因、指纹和 `last_seen_at`。
- delete 幂等：不存在时仍返回成功。
- 服务端从 taskSpace/project/agent 上下文补齐 project、user 和 source branch，不信任客户端自报。
- 写入成功后只发布现有轻量 Board `tasks.changed`，不推进 taskSpace revision。

客户端同步算法：

1. ownership 分类后得到当前 `ownershipPending` 目标集合。
2. 与 cursor 中上一次集合比较：新增/内容变化的 taskDir 生成 upsert，消失的 taskDir 生成 delete。
3. 每次最多发送 200 项；同一项重试使用相同内容，服务端按来源键幂等收敛。
4. 网络失败保留本地目标集合，普通任务同步继续，下次同步再次比较并重发。
5. 正常任务上传成功后，本地删除 ownershipPending，同时服务端在任务快照事务内删除摘要。

新 Agent 对旧服务端的 404/405 视为可选能力缺失：记录一次调试日志，不阻断任务同步。

### 4.3 正常任务接入时清除摘要

`applyChangesInternal()` 在成功接受带有效分支的任务后，在同一个
`BEGIN IMMEDIATE` 事务内删除该 `project_id + task_id` 的所有 inbox 来源行。

这保证：

- 正常任务快照成功后，摘要不会继续显示。
- 删除和任务索引/projection 失败时，摘要删除随事务回滚。
- 不依赖某个客户端事后发送 delete；即使来源设备离线，摘要也会被服务端收敛。

### 4.4 Web 查询 API

```text
GET /api/ownership-inbox?teamId=...&projectIds=...&limit=50&cursor=...
```

权限：

- 复用可读项目集合和团队作用域校验。
- `projectIds` 必须全部属于当前用户可读范围。
- 只返回当前用户可见项目的摘要。

响应：

```json
{
  "items": [
    {
      "projectId": "project-1",
      "projectName": "trellis-board",
      "taskId": "task-a",
      "taskDir": ".trellis/tasks/task-a",
      "title": "任务 A",
      "reason": "TASK_OWNERSHIP_REQUIRED",
      "sourceBranches": ["main"],
      "sourceClients": [
        {
          "displayName": "YHJ 的桌面端",
          "username": "yhj"
        }
      ],
      "firstSeenAt": "<ISO>",
      "lastSeenAt": "<ISO>"
    }
  ],
  "total": 1,
  "nextCursor": null
}
```

排序使用 `last_seen_at DESC + projectId + taskId` 稳定分页，不返回正文或任务详情。

### 4.5 项目计数

`boardService.status()` 按项目聚合 inbox 行，并在既有 project DTO 增加：

```text
ownershipInboxCount
```

status ETag 已对 project DTO 做哈希，因此 inbox 变化会自然改变 ETag；不增加新的全局任务
query revision，也不使普通任务查询缓存失效。

## 5. Web 入口与交互

### 5.1 左侧项目入口

[ProjectRail.tsx](../../../packages/web/src/components/layout/ProjectRail.tsx) 在展开项目后，
把待归属入口放在项目行和分支行之间：

```text
trellis-board
  待归属任务 3
  main
  feature/archive
```

- 该入口不是 taskSpace，不进入分支选择器。
- 数量 > 0 时使用 `warning` 语义和数量徽标；数量为 0 时灰显为 0。
- “全部项目”范围只在数量 > 0 的项目行显示徽标。
- 点击入口只设置项目范围并展开待归属列表，不切到某个 taskSpace。
- 分支级现有“待确认归属”按钮继续打开本地 `TaskOwnershipDialog`；两个入口职责不同。

### 5.2 主内容警示条

[BoardPage.tsx](../../../packages/web/src/pages/board/BoardPage.tsx) 在
`ExecutionHeader` 之后、`FlowSignals/AttentionQueue/Overview/Kanban` 之前渲染
`OwnershipInboxPanel`。

- `ownershipInboxCount > 0` 时始终显示黄色警示条，不因搜索、阶段、负责人或分支筛选隐藏。
- “全部项目”显示合计数量并按项目分组；具体项目显示该项目数量。
- 点击“查看待归属任务”与点击左侧入口执行同一个展开动作。
- 展开后显示摘要列表；分页或“加载更多”只查询 inbox API，不复用普通任务分页游标。
- 没有待归属任务时警示条隐藏；左侧入口保留灰色 0 状态。
- 本次会话允许收起列表，但警示条本身不提供永久关闭；数据清零才消失。

### 5.3 状态刷新

- `tasks.changed` 到达后，`useBoard` 同时对齐 `/api/team/status` 与普通任务页；
  inbox 面板已展开时再重新拉取 inbox API。
- 项目或团队切换时清空 inbox 分页游标和旧数据，迟到响应不得覆盖新范围。
- 计数独立于列表筛选；搜索或分页为空不回写 `ownershipInboxCount=0`。

### 5.4 可访问性

- 入口使用真实 button，展开状态通过 `aria-expanded` 表示。
- 数量不只靠颜色表达，必须包含可见文本“待归属任务 N”。
- 警示条使用 `role="status"`，但不再使用自动动画或强制焦点抢占。

## 6. 失败矩阵

| 条件 | 结果 |
| --- | --- |
| pending 原样重放成功 | 清 pending，更新 sequence/baselines，不推进 revision |
| pending 明确 ownership/证据拒绝 | 清 pending，写有界摘要，继续当前其他任务 |
| pending 网络失败/超时/429 耗尽 | 保留 pending 原字节，停止该 taskSpace |
| pending 文件在当前本地已变化 | 仍先原样重放，不由当前文件阻断 |
| upload 返回 revision 已越过其他客户端变更 | cursor 保持旧已应用 revision，下一次 pull 补齐 |
| guard<1 且服务端不可达 | guard 保持 0，pending 不动，失败关闭 |
| guard 修复发现 server-only | 下载服务端任务 |
| guard 修复发现 local-only | ownership 可同步则上传；空分支进摘要收件箱 |
| guard 修复发现内容冲突 | 保留双方，进入 deferred/差异确认 |
| inbox 写入旧服务端返回 404/405 | 视为可选能力缺失，不影响活动任务同步 |
| inbox 来源 taskSpace 停用/删除 | 对应来源行随外键清理 |
| 正常任务快照成功 | 同一事务删除该项目的 inbox 摘要 |
| inbox 查询越权 projectIds | `403` |
| inbox upsert 超过 200 项或字段超限 | `400`，不部分写入 |

## 7. 兼容、迁移与回滚

- schema v16 → v17 只新增摘要表，不修改 `sync_task`、`sync_task_lease` 或现有任务表。
- 升级前沿用现有数据库备份流程；迁移重复执行必须幂等。
- 新 cursor 字段缺失按默认值读取，旧客户端仍可继续同步。
- 旧客户端不会发布待归属摘要；服务端和 Web 升级后，新客户端才会填充该视图。
- inbox API 故障不影响普通任务上传；只有摘要展示延后。
- 回滚服务端代码时保留 v17 摘要表；v16 代码不读取该表，不影响现有任务控制面。
- 回滚 Agent 代码时保留 `revisionGuardVersion=1`；旧代码把它当未知字段，不改变现有游标。

## 8. 取舍

- 摘要而不是正文镜像：牺牲 Web 端在归属前查看完整 PRD/附件的能力，换取无第二套正文、
  低带宽和没有额外 CAS 冲突。
- 项目级只读定位而不是直接归属：避免新增服务端到客户端跨分支命令协议；归属动作继续由
  已批准桌面 Agent 执行。
- 双层入口：比单入口多一块视觉空间，但主内容区和项目栏都能持续发现待归属任务。
- 旧 cursor 修复优先保留数据：可能恢复远端曾删除的本地任务，这是不可静默丢数据的已知代价。
