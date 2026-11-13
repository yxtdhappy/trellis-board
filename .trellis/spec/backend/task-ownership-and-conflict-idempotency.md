# 任务级分支归属与冲突幂等

## 1. Scope / Trigger

- Trigger：修改任务快照 watcher、首次/增量同步、pending batch、冲突、任务归属 API、
  `task.py set-branch` 或历史冲突清理时。
- `binding.branchName == observedBranchName` 只证明绑定分支与真实检出分支一致；它不能证明
  `.trellis/tasks` 下每个任务都属于该分支。任务同步必须再做任务级归属门禁。
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
    { "taskSpaceId": "space-main", "branchName": "main" }
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
- 归属判定必须发生在批次预占前。watcher、pull dirty、bootstrap、deferred、命令上传和冲突覆盖都复用
  同一门禁；`_uploadBatch()` 重试 pending 时不得改写已持久化 files，否则同一 `batchId` 会变成不同请求摘要。
- 混合目录中只有全部任务都可安全独立处理时才部分放行；出现未知目录、归属暂停或可能的归档移动时整批暂停。
- 服务端 `validateCompleteTaskGroups()` 在 CAS 前校验合并且新增目录的 `task.json.branch`：
  缺失返回 `TASK_OWNERSHIP_REQUIRED`，不等于 taskSpace 分支返回 `TASK_OWNERSHIP_MISMATCH`。
  拒绝时不得写文件、递增 revision、创建 batch 或 conflict；删除墓碑不因本地已无 task.json 被误拦截。
- 同一 `(taskSpaceId, agentId, taskIdentity)` 的 pending conflict 只能有一行。新冲突更新 files、
  serverRevision、clientSequence 和 batchId，保持原 conflict ID；历史 `task_id=NULL` 通过 taskDir 兜底并可回填。
- `listConflicts()` 对历史重复行按 Agent + task 身份折叠，只返回每组最新 pending，排序必须有稳定
  tie-breaker，不能先把全部重复正文加载到内存。
- Agent 收到冲突后在 cursor 写 `conflictBlocked`；watcher、pull、SSE、重启和 pending retry 在用户
  `use-server` 或成功 `overwrite-server` 前不得自动重试。`save-local-copy` 不解除 pending。
- `ownershipPending`/`conflictBlocked` 的清理必须在 cursor 锁内单次读改写；本地已删除或移动的目录
  不能永久残留待确认状态。
- 清理脚本允许重复运行：remove taskSpace 仍为 `active` 时走原有“墓碑重复目录并停用”路径；
  remove 已经 `disabled` 时，只有在显式传入 `--cleanup-conflicts`、
  `--disable-remove-task-space` 且 `filesToDelete=0` 时，才允许 conflict-only apply。
  不得为了让脚本通过而临时把已停用 taskSpace 重新置为 `active`，remove revision 也不得因此递增。

## 4. Validation & Error Matrix

| 条件 | 结果 |
| --- | --- |
| binding 分支与真实 Git 分支不一致 | 现有 `BRANCH_MISMATCH`，不上传 |
| 任务 branch 明确为其他分支 | `TASK_BRANCH_OTHER`，本地保留，不上传，不创建 conflict |
| 任务 branch 为空且服务端/项目主张唯一 | 自动写 `task.json.branch` 后继续判定 |
| 多个 taskSpace 给出多个非空 task branch | 单次 `task_ownership_review`，cursor 记 fingerprint |
| 同一 fingerprint 再次被 watcher/重启发现 | 不再自动提示，不上传 |
| 服务端收到空 task branch | `409 TASK_OWNERSHIP_REQUIRED`，整批不写 |
| 服务端收到错误 task branch | `409 TASK_OWNERSHIP_MISMATCH`，整批不写 |
| pending batch 文件字节保持不变 | 按原 batchId/clientSequence/files 重放 |
| 用户改归属导致 pending 文件会变化 | 不原地改写 pending；失败关闭并等待显式处理 |
| 现有 pending conflict | 返回稳定 conflictId，不新增同类行 |
| 同一任务跨不同 Agent 冲突 | 每个 Agent 保留独立 pending，便于定位来源 |

## 5. Good / Base / Bad Cases

- Good：main binding 发现本地任务 `branch=codex/feature-a`，暂停该目录；当前分支其他任务仍可独立同步。
- Good：空 branch 的任务只在服务端一个 claim 指向 feature-a 时自动补齐；main 下暂停，切到 feature worktree 后恢复。
- Good：同一 Agent 连续十次 CAS 冲突只更新一条 pending，conflict ID 稳定，列表只返回一条。
- Base：全部任务 branch 与 binding 相同且无 pending，正常按任务目录 CAS 上传。
- Base：旧 cursor 没有 `ownershipPending/conflictBlocked`，按空对象读取。
- Bad：只校验 Git HEAD 后监听整棵 tasks，会把其他分支残留目录写进当前 taskSpace。
- Bad：冲突后每个 watcher 事件都新增行，历史列表把 1000+ 记录一次返回，Agent 响应超过 1 MiB。
- Bad：pending 重试前用最新本地 branch 改写 batch files，却复用原 batchId，破坏幂等摘要。

## 6. Tests Required

- `task-snapshot.test.js`：task id/branch 解析、空/非法/非字符串 branch、归档目录。
- `team-task-snapshot.test.js`：ownership API 身份隔离、空/错误 branch 整批拒绝、稳定 conflict ID、
  历史重复列表折叠、不同 Agent 隔离。
- `team-gitless-http.test.js`：新 ownership 路由鉴权、200 ID 上限和不泄漏任务正文。
- `apps/desktop/src-tauri/src/agent/task_sync.rs` 内单元测试：watcher/pull/pending/bootstrap/deferred/command/overwrite
  全部经过归属门禁；唯一归属自动补齐；歧义只提示一次；其他分支任务不调用上传；pending 字节不变；
  conflictBlocked 在重启后保持、解决后清除。
- `task-space-duplicate-cleanup.test.js`：默认 dry-run 零写入、VACUUM INTO 备份、只墓碑重复目录、
  每组只保留最新 pending、显式 disabled、状态/revision 漂移拒绝，以及“旧 taskSpace 已 disabled
  且没有重复文件时仍可幂等清理 conflict”。

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
})
```

服务端再对完整 task 目录校验 `task.json.branch == taskSpace.branchName`，形成无法绕过的第二道边界。
