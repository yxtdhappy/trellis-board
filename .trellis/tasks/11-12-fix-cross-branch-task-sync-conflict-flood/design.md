# 跨分支任务归属与冲突幂等设计

## 1. 目标与边界

本次修复同时处理三个边界问题：

1. 当前 binding 只证明“绑定的 Git 分支与真实检出分支一致”，不能证明 `.trellis/tasks` 下每个任务都属于该分支。
2. 客户端所有上传入口必须使用同一个任务归属门禁，服务端还要做同样的边界校验。
3. 同一 Agent 对同一任务的重复 CAS 冲突必须复用一条 pending 状态，历史和读取路径也不能因重复记录失控。

不在本次设计中加入自动内容合并、自动删除 Git 分支、跨 taskSpace 自动搬移任务或物理删除旧快照。

## 2. 根因与修复边界

事故链路是：

```text
main binding 分支校验通过
  -> watcher 监听到整个 .trellis/tasks
  -> feature 分支遗留的未跟踪任务目录被当成 main 任务
  -> 客户端用旧基线写 main taskSpace
  -> 服务端返回 CAS 冲突
  -> 客户端每次 watcher / pull / retry 又发起同类上传
  -> 服务端每次无条件 INSERT sync_conflict
  -> 冲突列表超过 Agent 1 MiB 响应上限
```

因此仅修 watcher 不够。归属门禁必须位于“生成批次”和“真正发请求”两个位置；服务端必须校验批次里的完整 `task.json`，不能相信客户端已经过滤。

## 3. 任务归属模型

### 3.1 唯一持久事实

任务归属只以任务目录内 `task.json.branch` 为准。`base_branch` 是 PR 目标，不是同步归属，不能参与判断。

在 [packages/shared/task-snapshot.js](../../../packages/shared/task-snapshot.js) 和 Rust
[task_sync.rs](../../../apps/desktop/src-tauri/src/agent/task_sync.rs) 的任务目录分组结果中增加从 `task.json` 解析出的只读字段：

```js
{
  taskId,
  taskBranch,
  taskDir,
  files
}
```

字段只用于分类和门禁，不新增服务端文件类型或数据库列。非法、空白或非字符串 `branch` 按“未归属”处理。

### 3.2 状态与动作

| 本地 `taskBranch` | 服务端主张 | 项目分支数 | 结果 |
| --- | --- | --- | --- |
| 等于 binding 分支 | 无冲突 | 任意 | 可同步 |
| 明确为其他分支 | 无冲突 | 任意 | 暂停，不提示，不上传 |
| 空 | 当前 taskSpace 版本明确给出唯一分支 | 任意 | 自动补齐本地 `task.json.branch` 后按该分支分类 |
| 空 | 各 taskSpace 版本共同指向唯一分支 | 任意 | 自动补齐；若该分支不是当前分支则暂停 |
| 空 | 无服务端版本，项目只有一个有效 taskSpace | 1 | 自动补齐为当前分支并同步 |
| 空或非法 | 无服务端版本，或多个分支主张冲突 | 多个 | 进入一次批量归属审查 |

“服务端主张”来自两个只读来源：

- 当前 taskSpace 内该任务 `task.json.branch`；
- 新增的任务归属查询；它按稳定 task ID 返回同项目各有效 taskSpace 是否存在该任务，以及各自 taskSpace 分支和任务 `branch`。

多个来源给出多个非空分支时，不自动挑选。只有 claim 集合大小为 1 才自动补齐。

### 3.3 归属查询契约

新增 Agent 只读接口：

```text
POST /api/agent/task-spaces/:taskSpaceId/task-ownership
```

请求：

```json
{
  "taskIds": ["rust-desktop-agent-single-exe"]
}
```

响应：

```json
{
  "projectTaskSpaces": [
    { "taskSpaceId": "space-main", "branchName": "main" },
    { "taskSpaceId": "space-feature", "branchName": "codex/rust-desktop-agent-single-exe" }
  ],
  "tasks": [
    {
      "taskId": "rust-desktop-agent-single-exe",
      "claims": [
        {
          "taskSpaceId": "space-main",
          "branchName": "main",
          "taskBranch": "codex/rust-desktop-agent-single-exe"
        }
      ]
    }
  ]
}
```

约束：

- 先走现有 `bindingContext()`，只允许当前 active Agent、approved binding、可读项目和有效 taskSpace。
- 单次最多 200 个稳定 task ID，只返回 ID、分支和 taskSpace 身份，不返回任务正文。
- 只查询项目状态为 active、taskSpace 状态不为 disabled 的空间。
- 这是读接口，不创建 project、taskSpace、binding 或 cursor。

## 4. 客户端统一上传门禁

### 4.1 生成判定

在 [task_sync.rs](../../../apps/desktop/src-tauri/src/agent/task_sync.rs) 增加统一判定
`resolve_task_ownership()`：

```text
resolve_task_ownership(binding, local_groups)
```

返回：

`OwnershipResolution`，其中包含可同步任务、暂停任务、待审查任务、非法任务和项目可见任务空间。

判定函数负责分类和唯一归属补齐；`task.py set-branch`、cursor 写入和控制事件由同一同步实现执行。

### 4.2 所有入口共用

以下路径都必须在发出 `POST changes` 前经过同一门禁：

- watcher 触发的 `_uploadDirty()`；
- `_pull()` 发现的本地 dirty 目录；
- cursor 中 pending batch 的重放；
- bootstrap 的 local-only 上传；
- safe/review 首次同步中的显式上传；
- `syncTaskDirectories()` 命令成功后的上传；
- `syncDeferredTasks()` 用户显式补同步；
- 冲突 `overwrite-server` 前。

实现上把过滤放在 `_uploadDirectories()` 和 `_uploadBatch()` 两层：

- `_uploadDirectories()` 对任务目录分类，阻止 paused/review 目录进入批次；
- `_uploadBatch()` 在真正请求前重新读取 pending files 对应的任务 `task.json.branch`，防止生成批次后用户切换归属；
- 服务端仍执行最终校验，形成第二道边界。

归属判定失败不抛普通网络异常，而是返回可投影的 `skipped` 结果，避免 watcher 把可预期暂停记成同步故障。

### 4.3 自动补齐

唯一归属已确定时，使用项目 Trellis CLI 写入：

```text
task.py set-branch <taskDir> <branchName>
```

写入后用新文件内容继续本次同步，不依赖 watcher 二次触发。自动补齐只修改目标 `task.json`，不修改其他任务或源码。

### 4.4 pending 重放

- pending batch 对应的任务变为 other-branch 或 review 时，不再自动重放。
- pending 不删除，因为服务端可能已经提交但响应丢失；切回归属或用户完成审查后仍可复用原 `batchId/clientSequence/files`。
- 门禁结果必须发生在 `_uploadBatch()` 的网络调用之前，且每次重放都重新判定。

## 5. 归属审查与交互

### 5.1 cursor 状态

现有 `live-cursors.json` 的 cursor 结构增加向后兼容字段：

```json
{
  "ownershipPending": {
    ".trellis/tasks/example": {
      "fingerprint": "<taskDir files sha256 manifest>",
      "reason": "TASK_OWNERSHIP_REQUIRED"
    }
  },
  "conflictBlocked": {
    ".trellis/tasks/example": {
      "conflictId": "<stable conflict id>"
    }
  }
}
```

- fingerprint 未变化时不自动再次审查或上传。
- 任务内容变化后 fingerprint 变化，可重新进入一次审查。
- 用户选择“暂不处理”保留 fingerprint；选择当前/其他分支时写 `task.json.branch` 并清除该项。
- 不提升 cursor 版本；缺失字段按空对象归一化，旧 cursor 继续可用。

### 5.2 首次批量审查

侧车只在发现新的歧义指纹时发出一次：

```json
{
  "type": "task_ownership_review",
  "taskSpaceId": "space-main",
  "branchName": "main",
  "items": [
    {
      "taskId": "task-id",
      "taskDir": ".trellis/tasks/example",
      "title": "任务标题",
      "suggestedBranchName": null,
      "choices": [
        { "taskSpaceId": "space-main", "branchName": "main" },
        { "taskSpaceId": "space-feature", "branchName": "codex/feature" }
      ]
    }
  ]
}
```

现有 control window 增加该事件类型，整批展示，不逐任务弹窗。动作：

- `use-branch`：批量把选中任务写到指定有效分支；
- `defer`：关闭本轮审查，保留 `ownershipPending`；
- 关闭窗口等同 `defer`，不回写任务。

### 5.3 项目栏状态与再次处理

[device.rs](../../../apps/desktop/src-tauri/src/agent/device.rs) 的关联摘要增加：

```text
ownershipPausedCount
ownershipPausedTaskDirs
ownershipPendingCount
ownershipPendingTaskDirs
```

[apps/web/src/components/layout/ProjectRail.tsx](../../../apps/web/src/components/layout/ProjectRail.tsx) 在对应分支行显示：

- 明确属于其他分支：`N 个任务因分支不匹配暂停`；
- 歧义或暂未处理：`N 个任务待确认归属`；
- 两者都有时显示总数，详情中分组展示。

点击状态打开新的 `TaskOwnershipDialog`，按需调用 Tauri：

```text
list_task_ownership(taskSpaceId)
set_task_ownership(taskSpaceId, decisions)
```

对话框支持全选、按建议分组、归属当前分支、归属其他可见分支、暂不处理。当前分支上传成功后刷新关联摘要和 Board。

### 5.4 Web 创建任务

[apps/web/src/features/board/dialogs/CreateTaskDialog.tsx](../../../apps/web/src/features/board/dialogs/CreateTaskDialog.tsx)：

- `taskSpaces.length <= 1` 时隐藏“共享分支任务空间”字段并自动选中唯一值；
- 多分支时显示选择器；
- 默认优先级为当前查询 taskSpace、当前本地 binding、列表首项；
- 没有 taskSpace 时继续阻止提交并显示明确原因。

Agent 创建命令在 [task_command.rs](../../../apps/desktop/src-tauri/src/agent/task_command.rs) 的 `task.py create --no-start` 成功后，立即执行：

```text
task.py set-branch <createdTaskDir> <binding.branchName>
```

后续首次同步直接使用明确的 `task.json.branch`，不再依赖客户端的隐式上下文。

## 6. 服务端分支边界

[apps/server/team/task-snapshot-service.js](../../../apps/server/team/task-snapshot-service.js) 的 `validateCompleteTaskGroups()` 接收当前 taskSpace 的 `branch_name`，校验合并后每个新增/更新任务目录的 `task.json.branch`：

- 空值返回 `409 TASK_OWNERSHIP_REQUIRED`；
- 与 taskSpace 分支不一致返回 `409 TASK_OWNERSHIP_MISMATCH`；
- 错误 details 只包含 task ID、任务目录、期望分支和实际分支；
- 整批不写快照、不递增 revision、不创建 CAS conflict；
- 删除墓碑不因本地已不存在的 `task.json` 被误拦截；
- 活动目录到归档目录移动仍要求两处稳定 task ID 一致，并校验新 `task.json.branch`。

该断言位于 `BEGIN IMMEDIATE` 内，和 CAS、任务完整性、revision 更新共享同一事务。普通 changes 和 `overwrite-server` 都会经过它。

## 7. 冲突幂等与读取收敛

### 7.1 服务端写入

`writeConflict()` 在事务内先查询：

```sql
SELECT *
FROM sync_conflict
WHERE task_space_id = ?
  AND created_by_agent_id = ?
  AND task_id = ?
  AND status = 'pending'
ORDER BY created_at DESC
LIMIT 1
```

存在时更新：

- `task_dir`
- `files_json`
- `server_revision`
- `client_sequence`
- `batch_id`

不存在时才插入。`id` 和首次 `created_at` 保持不变，返回同一个 `conflictId`。`task_id` 为空时不允许进入正常同步冲突，使用任务目录作为兜底身份。

查询和写冲突位于同一个 `BEGIN IMMEDIATE`，无需新增列、唯一索引或 schema 版本。

### 7.2 服务端读取

`listConflicts()` 对历史数据按
`task_space_id + created_by_agent_id + COALESCE(task_id, task_dir)` 分组，只返回每组最新一条 pending。

这保证升级后即使旧数据尚未清理，单个任务的历史 1192 条重复记录也不会再次撑爆响应。不同 Agent、不同任务仍分别返回。

### 7.3 客户端重试抑制

`_uploadBatch()` 收到 `TASK_FILE_CONFLICT` 时：

- 在 cursor 写入该任务目录的 `conflictBlocked[conflictId]`；
- 保留本地文件，不上传，不自动重试；
- watcher、pull、SSE、Agent 重启均先检查该状态；
- 用户选择 `use-server` 或成功 `overwrite-server` 后清除；
- `save-local-copy` 不清除，因为服务端冲突仍为 pending；
- 显式补同步或新的冲突处理命令可以重新打开处理，不通过普通 watcher 自动解封。

服务端稳定 ID + 客户端抑制共同避免“记录膨胀”和“无意义重试”。

## 8. 历史数据清理

复用 [scripts/task-space-duplicate-cleanup.js](../../../scripts/task-space-duplicate-cleanup.js)，不新增平行清理脚本。

### 8.1 审计内容

dry-run 输出增加：

- 待保留 / 待停用 taskSpace；
- 重复任务数、内容相同/不同数、待墓碑文件数；
- 两个 taskSpace 各自 pending conflict 数；
- 按 Agent + task 分组后的重复组数；
- 将标记为 resolved 的重复 conflict 数；
- 将保留的每组最新 conflict ID；
- 旧 taskSpace 最终状态。

### 8.2 apply 顺序

1. 校验 remove/keep taskSpace 都属于目标项目、均 active，项目 active。
2. 校验旧 taskSpace 没有缺少稳定 ID 的待清理任务；归档任务不进入自动墓碑。
3. 内容不同时要求显式 `--allow-content-differences`，确认以 keep taskSpace 为准。
4. 停止 Board 服务并检查监听端口。
5. `VACUUM INTO` 写带时间戳的数据库备份。
6. 单事务内：
   - 对 remove taskSpace 的重复活动任务写删除墓碑和 `sync_file_audit`；
   - 删除 remove taskSpace 的旧索引与扫描缓存；
   - 将 remove taskSpace 状态写为 `disabled`；
   - 对 remove 和 keep 的 pending conflict 按组保留最新一条，其余写 `status='resolved'` 和 `resolved_at`；
   - 校验 taskSpace revision 未变化。
7. 重新以只读模式打开结果库，输出清理后计数和备份路径。

新增 CLI 开关建议：

```text
--cleanup-conflicts
--disable-remove-task-space
```

两个开关只在显式传入时生效，默认 dry-run 行为不变。正式生产清理命令必须同时传：

```text
--apply
--allow-content-differences
--cleanup-conflicts
--disable-remove-task-space
```

### 8.3 当前事故目标

正式执行时：

- project：当前 `trellis-board` 项目；
- remove：`codex/server-gitless-task-sync` 对应 taskSpace
  `75984cbd-ed47-4389-bddf-2efbce07f275`；
- keep：`main` taskSpace `a8d34d0e-54af-4041-bb2c-4507665c7abe`；
- 旧空间只停用，不物理删除文件和审计；
- `main` taskSpace 的 1193 条历史 pending 记录在同一操作中收敛。

生产数据库位于远端服务 `192.168.65.27:4317`，实际数据库路径和停机方式必须在 apply 前通过服务配置确认。不能直接拿本地 `data/board.sqlite` 代替。

## 9. 兼容、发布与回滚

- 不修改数据库 schema；旧版本客户端仍可读取新服务端，但旧客户端上传空分支任务会被新服务端拒绝，符合 fail-closed 原则。
- 新客户端仍可处理旧 cursor；新增 cursor 字段缺失时按空状态处理。
- 服务端冲突读取折叠不修改旧数据；真正历史收敛只在显式 cleanup apply 中发生。
- cleanup 前必须有 `VACUUM INTO` 备份；回滚方式是停止服务、恢复备份数据库并重启，不能手工删主 taskSpace。
- 旧 taskSpace 停用后不自动重新启用。需要恢复时使用备份或单独的运维流程。

## 10. 风险与取舍

- 自动补齐唯一归属会写本地 `task.json`，但只在没有其他合理解释时发生；多分支歧义始终交给用户。
- 服务端拒绝空分支会使未升级历史任务暂停同步，这是一次性迁移成本，换来不再跨分支污染。
- 冲突去重按 Agent 分开；同一任务被不同设备冲突时仍保留不同记录，便于定位来源。
- 不新增部分唯一索引，因为所有冲突写入都在 `BEGIN IMMEDIATE` 中串行完成；若未来出现绕过 service 的写入路径，需要补数据库约束。
- “暂不处理”只抑制自动重试，不会丢弃任务；可通过项目栏或后续内容变化再次进入处理。
