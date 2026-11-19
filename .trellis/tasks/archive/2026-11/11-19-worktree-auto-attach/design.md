# worktree 自动接入与懒显示 — 技术设计

## 1. 范围与边界

实现 PRD `11-19-worktree-auto-attach`：客户端发现 linked worktree，记录 baseline，只监听该
worktree 中 baseline 之后新增的活动任务；首次出现候选时自动接入为独立分支 taskSpace，只上传
候选任务，成功后才显示分支。分支显示后按活动任务动态维持可见性：worktree 删除立即隐藏；全部
任务归档且服务端归档同步清除 active 后隐藏；新任务出现后重新显示。

不做：源分支 taskSpace 合并、origin 模型、`set-branch` 校正、服务端 schema/API 变更、自动创建/
删除 worktree、自动解绑、Git hook、补发现客户端关闭期间创建的任务。

核心原则：发现和候选阶段都在本地隐藏完成；自动接入复用现有 `inspect_project → preflight →
attach`；接入成功后仍走现有 `TaskSync` 上传链路，但只对 tracked 任务放行。

## 2. 架构总览

```text
git worktree add
  -> <common_dir>/worktrees 事件
  -> WorktreeDiscovery（git worktree list --porcelain）
  -> 记录 baselineHead + baselineTaskDirs
  -> 安装该 worktree 的轻量 .trellis watcher（隐藏）
  -> 新增活动任务且 branch == worktree branch
  -> 自动 attach（safe，无确认）
  -> 只上传 tracked 候选任务
  -> 首次上传成功 -> 分支 visible
  -> 现有 binding/watcher/命令/归档链路
  -> 可见性重算：本地活动任务 + 服务端 active 计数
  -> worktree 删除 -> hidden_missing
  -> 本地活动 0 + 服务端 active 0 -> hidden_empty
```

失败：`error` 状态保留候选，分支隐藏，非阻塞错误 + 重试；不重复创建 binding/taskSpace。

## 3. 客户端模块

新增 `packages/desktop/src-tauri/src/agent/worktree/`：

- `registry.rs`：`worktree-registry.json` schema 1、原子写、状态机。
- `discovery.rs`：`git worktree list` reconcile、baseline、活动任务扫描、候选判定、
  team/developer 解析。
- `watch.rs`：`<common_dir>/worktrees` 与 `<worktree>/.trellis/tasks` watcher、250ms 去抖。
- `visibility.rs`：服务端 active 查询、可见性状态计算。
- `mod.rs`：`WorktreeService`、自动 attach、safe 首次同步、tracked 上传、重试、状态导出。
- 单测内联在各文件 `#[cfg(test)] mod tests`；不新增独立 `events.rs`。

根文件保持 `mod`、常量、`WorktreeService` 和重导出；单文件 ≤1200 行，根文件 ≤500 行。

## 4. Git 能力

`packages/desktop/src-tauri/src/agent/git.rs`：

- 新增 `GitOperation::WorktreeList` → `git worktree list --porcelain`，同步 `ALL`/`as_str`。
- `worktree_list(repo_path, hooks_dir) -> Vec<WorktreeEntry>`，解析：
  `worktree`、`HEAD`、`branch refs/heads/<name>`/`detached`、`bare`、`locked`、`prunable`。
- 复用 `ls_tree` 获取 baseline 的 `.trellis/tasks` 目录集合；复用 `resolve_git_dir`/`commondir`。

## 5. 注册表与状态机

文件：`<data>/agent/worktree-registry.json`，schema 1，原子写（临时文件 + rename）。

```json
{
  "schemaVersion": 1,
  "entries": {
    "C:/.../repo-task": {
      "path": "C:/.../repo-task",
      "branchName": "task/foo",
      "commonDir": "C:/.../repo/.git",
      "baselineHead": "...",
      "baselineTaskDirs": [".trellis/tasks/11-19-existing"],
      "baselineInitialized": true,
      "status": "discovered|waiting_branch|attaching|pending_upload|attached|error|stale",
      "autoManaged": true,
      "visibility": "hidden|visible|hidden_empty|hidden_missing",
      "archiveSyncPending": false,
      "activeTaskCount": 0,
      "serverActiveTaskCount": 0,
      "taskSpaceId": null,
      "trackedTaskDirs": [],
      "pendingTaskDirs": [],
      "firstUploadCompleted": false,
      "lastError": null,
      "lastVisibilityError": null,
      "lastVisibilityAt": "...",
      "attempts": 0,
      "nextRetryAt": 0
    }
  }
}
```

状态机（接入生命周期与可见性分开）：

```text
discovered -> waiting_branch -> attaching -> pending_upload -> attached
     |              |               |              |
     +--------------+---------------+--------------> error -> attaching (retry)
所有未绑定状态 -> stale（worktree 删除/prune）

attached:
  本地活动任务 > 0 -> visibility=visible
  本地活动任务 = 0, 服务端 active > 0 -> visibility=visible, archiveSyncPending=true
  本地活动任务 = 0, 服务端 active = 0 -> visibility=hidden_empty
  worktree 路径消失/已 prune -> visibility=hidden_missing
  服务端查询失败 -> 保持上次 visibility，记录 lastVisibilityError
```

- `trackedTaskDirs`：允许该自动接入 binding 同步的任务目录；接入时先写入候选以避免 watcher
  上传 baseline，`firstUploadCompleted=true` 后才允许显示分支。
- 只允许一个 entry 处理中；重复事件合并。
- 不保存任务正文、origin 或源分支。

## 6. 发现与基线

- 新增 `agent/worktree/watch.rs`：监听每个 approved binding 的 `<common_dir>/worktrees`（非递归）
  和每个已登记 worktree 的 `.trellis/tasks`（递归）；250ms 去抖后 `reconcile`。
- 15s 低频轮询兜底；watcher 与轮询共用 `refresh_lock`，single-flight。
- reconcile：
  - 新路径：登记 `discovered`，记录 `baselineHead` 和 baseline 任务目录集合；
    启动时发现的已存在 worktree 同样登记并取当前 HEAD 作为 baseline。
  - 已登记：更新 HEAD/branch；已绑定路径重新计算 `visibility`，不因重新出现而跳过归档/active 规则。
  - 不存在/`prunable`：`stale`；未接入的清理 watcher，已接入保留 binding。
- 主工作树、bare 仓库不登记；同一路径只登记一次。
- 每个 worktree 的 `.trellis/tasks` watcher 只触发 reconcile，不上传、不写 cursor。

## 7. 候选判定

对每个未接入的 worktree：

1. 读取 `.trellis/tasks` 下的活动任务目录（不读 `archive/**`）。
2. 候选条件：
   - 目录不在 `baselineTaskDirs`；
   - `task.json` 可解析、`id` 非空；
   - `task.json.branch == worktreeBranch`。
3. `branch` 为空 → `waiting_branch`，继续监听；`task.py start` 写入后再判定。
4. `branch` 为其他分支 → 忽略。
5. 候选目录写入 `candidateTaskDirs`；首次出现触发自动接入（去抖）。
6. 候选目录消失/归档 → 移除候选；若从未接入，不产生 taskSpace。

初始扫描等待 `.trellis/tasks` 连续两次稳定（目录集合 + task.json 摘要），避免 checkout 未完成。

## 8. 自动接入

### 8.1 参数来源

- team/project：发现该 worktree 的源 binding（`binding.team_id`、`binding.project_id`）；
  没有源 binding 不登记该 worktree。
- developer ID：优先 `.trellis/.developer`（worktree 没有时回退主 checkout）；已存在的项目成员
  可以省略。缺失且服务端要求时，接入失败进入 `error`。
- 路径/分支：worktree 根和当前 HEAD 分支；接入前重新执行 `inspect_project`。
- 首次同步模式：固定 `safe`。
- 推送检查：自动接入不额外要求 `requirePushed`；依赖 `inspect_project`/服务端 attach 校验。
  项目确实要求推送时由 attach 返回错误，进入 `error`，不强行接入。

### 8.2 流程

0. 若该路径已有 approved binding：
   - 手工 binding（registry 未记录自动管理，或 taskSpaceId 不一致）：标记 `autoManaged=false`，
     跳过自动 attach/tracked 过滤/自动可见性，保持现有手工行为；不重复创建 binding/taskSpace。
   - 本服务曾自动接入且 taskSpaceId 一致：保持 `autoManaged=true`，继续 tracked 上传与可见性重算，
     避免每次 reconcile 降级为手工。
1. 校验 worktree 仍在 `git worktree list` 中、分支未变、`.trellis/tasks` 存在、非 sparse。
2. 调用现有 onboarding：
   - `inspect_project_with`；
   - `preflight`（team/taskSpace 权限）；
   - `attach_project_with`（创建/复用分支 taskSpace 与 binding）。
3. 成功：写 registry `status=pending_upload`、`taskSpaceId`、`trackedTaskDirs=candidateTaskDirs`；
   调用 `TaskSync.update_bindings`。
4. 等待 initial sync（safe）完成；超时或未完成时 `status=error`，保留候选，下一次退避时调用
   `TaskSync.sync_task_spaces` 重试首次同步，不重复 attach；完成后只上传 `trackedTaskDirs` 中的候选任务。
5. 首次上传成功：`status=attached`、`visibility=visible`；ProjectRail/Board 显示分支。
6. 失败：`status=error`，记录 `lastError`、`attempts`；保留候选；按指数退避重试
   （30s/60s/120s/300s），或人工刷新触发；不重复创建 binding/taskSpace。

### 8.3 上传过滤

自动接入的 binding 与普通 binding 共用 `TaskSync`，但增加 tracked 任务 allowlist：

- 仅对 `autoManaged=true` 的 binding 应用过滤；已存在的手工 binding 不改变。
- `AgentBinding.trackedTaskDirs` 作为 allowlist；`TaskSync.upload_dirty` 在非空时只保留其中路径。
  `WorktreeService` 在接入/上传成功后写回 config，重启不丢失。
- 首次接入只允许 `trackedTaskDirs` 中的候选任务上传；baseline 继承任务、同分支旧任务、其他目录
  一律不进入首次上传批次。
- 接入后的正常同步允许“非 baseline、`task.json.branch == worktreeBranch` 的新活动任务”进入，
  并把它加入 `trackedTaskDirs`。这样隐藏分支中新任务仍可上传并恢复 visible；baseline 任务即使
  被修改也不上传。
- 候选任务首次上传使用现有 `upload_directories`（或 `sync_deferred_tasks` 的受控子集），
  不批量上传 safe 产生的 deferred。
- 上传成功后 cursor/baseline 正常推进；后续 tracked 任务的修改继续同步。
- 用户手工修改 tracked 之外的目录不会被自动上传；避免违反“只关注新增”。

## 9. 懒显示、可见性与归档

### 9.1 状态

- `status` 表示接入生命周期（`attached` 表示首次上传成功），`visibility` 单独控制页面显示：
  `hidden`、`visible`、`hidden_empty`、`hidden_missing`。
- 未出现候选的 worktree：ProjectRail/Board 不显示分支；注册表隐藏。
- `error`/`pending_upload`：ProjectRail 可显示一条非阻塞状态（路径、分支、错误、重试按钮），
  但不把分支加入正常项目/Board 列表。
- `attached` 且 `visibility=visible`：分支进入现有 ProjectRail/Board；后续按普通分支展示。
- `hidden_empty`：分支无活动任务，ProjectRail/Board 活动视图不显示；binding/taskSpace 保留。
- `hidden_missing`：worktree 已删除/prune，立即隐藏；binding 标记 `stale`，不自动解绑。
- `archiveSyncPending=true`：分支仍 visible，但显示“等待归档提交推送/服务端归档同步”状态。

### 9.2 数据源

- 本地活动任务：扫描 `<worktree>/.trellis/tasks/**/task.json`，排除 `archive/**`，要求
  `task.json.branch == worktreeBranch` 且 `id` 非空；统计活动任务目录，不读取任务正文。
- 服务端 active：调用现有
  `GET /api/agent/task-spaces/{taskSpaceId}/tasks`（`AgentHttp::request_json`）；该接口只返回
  `sync_task.archived=0` 的任务，计数即 active 数。不新增服务端接口/字段。
- worktree 是否存在：以最近一次 `git worktree list --porcelain` reconcile 为准。
- 查询失败（网络/权限/服务端错误）：保留上一次 `visibility`，写 `lastVisibilityError`，不因
  不确定而隐藏。
- 客户端不上传 archive、不删除服务端 active；active 删除由服务端归档同步的现有
  `purgeArchivedTaskFiles` 完成。

### 9.3 计算规则

```text
if worktree missing/prunable:
    visibility = hidden_missing; status = stale
elif !firstUploadCompleted or trackedTaskDirs empty:
    visibility = hidden
elif localActive > 0:
    visibility = visible; archiveSyncPending = false
elif serverActive > 0:
    visibility = visible; archiveSyncPending = true
elif serverActive == 0:
    visibility = hidden_empty; archiveSyncPending = false
else (query failed):
    keep previous visibility; lastVisibilityError = ...
```

- `firstUploadCompleted` 在首批候选任务上传成功前阻止分支显示；仅写入 allowlist 不算成功。
- `localActive` 包含该分支所有未归档活动任务，不只 tracked 候选；避免继承任务仍活动时误隐藏。
- `hidden_empty` 需要服务端 active 为 0，即归档同步已处理；本地归档但未推送时服务端仍有
  active，状态为 visible + pending。
- worktree 删除优先于服务端计数：即使服务端仍有 active，也隐藏分支。

### 9.4 重算触发与并发

- 本地任务目录变化（含 `task.py archive` 移动目录）、binding 同步完成、服务端 snapshot/SSE
  的 active 删除、ProjectRail 打开/刷新、`refresh_worktree_discovery`。
- `attached` 条目低频 reconcile（建议 60s）；`hidden_empty`/`archiveSyncPending` 必须继续
  reconcile，才能在新任务或其他客户端 active 出现时恢复显示。
- 同一 worktree 的 visibility 重算 single-flight；用本地任务代次/时间戳防止旧的服务端查询结果
  覆盖更新的本地状态。
- 只在本地 active 为 0 或定时 reconcile 时查询服务端，避免每次文件变化都请求。

### 9.5 UI 过滤

- `WorktreeStatusView` 增加 `visibility`、`archiveSyncPending`、`activeTaskCount`、
  `serverActiveTaskCount`、`lastVisibilityError`。
- 前端按 `taskSpaceId` 建立 `autoManaged=true` 的 worktree 分支映射；ProjectRail/Board 活动
  视图过滤 `visibility != visible` 的自动接入 taskSpace。手工分支/`autoManaged=false` 不在
  映射中，不受影响。
- `archiveSyncPending` 的分支保持显示，附非阻塞提示；`hidden_empty`/`hidden_missing` 不显示，
  但诊断/状态接口仍返回。
- 归档视图保留历史数据；本需求只隐藏项目/活动视图中的分支，不删除归档任务。
- `WorktreeService` 复用 `state_sink`（`desktop-state-changed` 的 `associations` topic）；
  前端收到后同时调用 `list_local_associations` 与 `list_worktree_status`。
- 无确认弹窗；重试/刷新是唯一人工操作。

### 9.6 重新显示与 worktree 删除/重建

- `hidden_empty` 保留 binding watcher；新活动任务（非 baseline、branch 匹配）加入
  `trackedTaskDirs` 并正常上传，`localActive > 0` 后恢复 visible。首次接入的“首次上传成功
  才显示”不适用于已接入分支的后续任务。
- worktree 删除：`hidden_missing`，立即从活动视图移除；保留 binding/taskSpace/归档，提示可解绑；
  不自动解绑、不删服务端数据。
- worktree 删除后重建同一路径/分支：重新走 discovery；若旧 binding 仍存在，恢复后重新计算
  visibility；若已解绑，按新 worktree 记录 baseline 后重新自动接入。不自动迁移 `repo_path`。

## 10. Tauri 命令与权限

新增命令（只对当前 Board 窗口放行，必须 `ensure_board_caller`）：

- `list_worktree_status() -> WorktreeStatusView[]`（隐藏候选/错误/可见状态）
- `retry_worktree_auto_attach(key)`（`taskSpaceId` 或 worktree 路径）
- `refresh_worktree_discovery() -> WorktreeStatusView[]`

权限：

- `allow-list-worktree-status`
- `allow-retry-worktree-auto-attach`
- `allow-refresh-worktree-discovery`

同时加入 `permissions/desktop.toml` 的 `commands.allow` 和
`capabilities/board-local-association.json` 的 `permissions`。

`WorktreeStatusView`：`path`、`branchName`、`taskSpaceId`、`autoManaged`、`status`、`visibility`、
`archiveSyncPending`、`activeTaskCount`、`serverActiveTaskCount`、`lastError`、
`lastVisibilityError`、`lastVisibilityAt`。

## 11. 删除、移动、失联

- 未接入 worktree 删除/prune：移除 registry、baseline、轻量 watcher；无服务端副作用。
- 已接入 worktree 删除/prune/路径消失：`status=stale`、`visibility=hidden_missing`，立即从
  ProjectRail/Board 活动视图隐藏；保留 binding 并提示可解绑；不自动解绑、不删服务端
  taskSpace/任务/冲突/审计。config binding 保留，但暂时从 `TaskSync` 活动集合移除，
  避免对缺失路径执行 Git；同路径重新出现并重置 baseline 后恢复同步。
- `worktree move`/`repair`：更新发现注册表路径；已绑定 binding 的 `repo_path` 不自动迁移，
  需用户重新接入/解绑；现有分支守卫会暂停。
- 空 taskSpace：自动接入后候选在首次上传前消失时，taskSpace 可能为空；记录诊断，
  不自动删除（Out of Scope）。

## 12. 兼容与数据

- 无服务端 schema/API/协议变化。
- 客户端 `config.json` schema 3 不变；新增本地 `worktree-registry.json`，旧版本无文件视为空。
- 不修改 `.trellis/scripts`、`task.json` 字段或归档模型。
- 回滚：停止发现/隐藏 watch/删除注册表；已创建的 binding/taskSpace 按现有手工解绑流程处理。

## 13. 风险与权衡

- **自动创建 taskSpace**：首次候选会创建分支 taskSpace；若上传失败/候选消失，可能留下空分支。
  记录诊断，不自动删除。
- **自动 attach 权限失败**：team/developer/推送/权限不满足时只能报错重试，不弹确认；用户需自行
  修复项目权限。
- **严格新增语义**：baseline 在发现时固定；客户端关闭期间创建的任务不会触发（方案 A）。
- **tracked allowlist**：必须过滤正常 watcher，否则同分支旧任务/修改可能被上传；这是本设计的
  关键不变量。
- **分支为空**：等待 `task.py start`，不自动改文件；用户不 start 就不会接入。
- **watcher 数量**：每个未接入 worktree 一个轻量 watcher；需要上限和删除清理。
- **并发事件**：同一 worktree 的 attach/upload 必须串行；失败重试不能重复创建 binding。
- **归档同步延迟**：服务端默认 300s 才同步；本地归档后 active 可能仍在，分支保持 visible +
  pending，不能立即隐藏。归档提交未推送时 pending 会持续。
- **服务端 active 查询语义**：`/tasks` 只返回 active；active=0 可能是归档清理，也可能是任务被
  删除。隐藏条件以“本地无活动任务 + 服务端 active=0”为准，不依赖额外 archive 查询。
- **可见性过滤仅本客户端**：服务端 taskSpace 仍存在，其他客户端/网页可能看到空分支；本需求
  只改 ProjectRail/Board 活动视图，不删除服务端数据。服务端 taskSpace 清理另立任务。
- **继承任务阻止隐藏**：`localActive` 包含该分支所有未归档任务；baseline 继承任务未归档时分支
  保持 visible，符合“所有任务都已归档”才隐藏。
- **手工 binding 被误管**：已有 approved binding 的 worktree 必须 `autoManaged=false`，跳过
  tracked 过滤和自动隐藏，否则会改变用户手工接入行为。
- **安全**：路径来自 git 输出；接入前重新校验；不信任任务文件路径；不执行脚本。

## 14. 测试策略

- Rust：
  - porcelain 解析（普通/已有分支/detached/locked/prunable）；
  - registry 状态机、baseline、候选判定（branch 空/其他分支/继承任务/归档）；
  - 轻量 watcher 去抖、幂等、删除清理；
  - 自动 attach 成功/失败/重试/并发；
  - tracked allowlist 过滤（继承任务、同分支旧任务不上传；新任务在授权后上传）；
  - 首次候选上传、visible 时机、空 taskSpace 诊断；
  - 可见性：本地 0/服务端 0 → hidden_empty；本地 0/服务端 >0 → visible+pending；
    服务端查询失败保持上次状态；worktree 删除优先 hidden_missing；
  - 隐藏分支新任务重新 visible；手工分支不受过滤；
  - stale/移动/删除。
- Tauri：命令注册、权限/capability、`ensure_board_caller`。
- Web：
  - ProjectRail 隐藏候选、错误状态、重试；
  - 分支仅在 visible 后出现；hidden_empty/hidden_missing 过滤；pending 提示；
  - 构建/浏览器验收、深色模式。
- 真实 E2E：
  1. 创建 worktree → 不显示分支；
  2. 创建新任务 + `task.py start` → 自动接入；
  3. 只上传新任务，继承任务不上传；
  4. 首次上传成功 → 分支/任务显示；
  5. 失败（权限/网络）→ 隐藏 + 错误 + 重试；
  6. 删除 worktree → 未接入无副作用 / 已接入 stale 可解绑；
  7. `--no-checkout` 发现但不接入；
  8. 客户端关闭期间创建的任务不触发；
  9. 归档任务并推送，等待服务端归档同步 → active 清除 → 分支隐藏；
  10. 归档未推送 → 分支保持显示并提示等待；
  11. 删除 worktree → 分支立即隐藏；重建并新建任务 → 分支重新显示。
