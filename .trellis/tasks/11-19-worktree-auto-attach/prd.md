# worktree 自动接入与懒显示

## Goal

客户端自动发现已绑定仓库的 linked Git worktree，并在**不弹确认框**的情况下，只监听该 worktree
中新增的未归档任务；首次发现这样的任务时，自动把 worktree 当前分支接入为独立分支 taskSpace，
只上传触发接入的新任务。接入并上传成功后才把该分支显示到 ProjectRail/Board；继承任务、已有任务
和客户端关闭期间创建的任务都不触发。分支显示后，只有在其中仍有活动任务时保持可见；worktree
被删除，或其中所有任务都已归档且服务端归档同步删除了 active 记录后，客户端项目页面不再显示该
worktree 分支，但保留 binding 和 taskSpace。

## Background

- 当前接入流程要求用户手工选择目录并确认；worktree 创建后不会出现在 Board。
- 现有模型支持同一仓库不同分支使用独立 taskSpace；每个 worktree 绑定自己的分支即可，无需
  服务端新模型。
- 用户选择“自动接入 + 懒显示”：
  - 不需要确认；
  - 只关注 worktree 中新增的未归档任务；
  - 只有监听到新任务时才把对应 worktree 分支显示到客户端页面。
- “新增”按方案 A 定义：客户端观察到 worktree 时记录基线；基线之后新增的活动任务才算候选。
  客户端关闭期间创建的任务不触发自动接入。

## Confirmed Decisions

- 自动接入，不弹确认框；发现/候选阶段只在本地维护隐藏状态。
- 每个 worktree 仍使用独立分支 taskSpace；不合并到源分支，不新增服务端 origin 模型。
- 只跟踪 baseline 之后新增的活动任务；从基线继承的已跟踪任务、既有任务修改不触发。
- 候选任务必须满足 `task.json.branch == worktree 当前分支`；分支为空时等待 `task.py start`，
  不自动修改任务文件。
- 接入默认首次同步 `safe`；接入成功后显式上传触发接入的候选任务，避免继承任务批量上传。
- 分支只在“自动接入成功 + 触发任务首次上传成功”后显示；失败时保持隐藏并显示非阻塞错误。
- 分支可见性是动态的：存在活动任务时显示；worktree 删除时立即隐藏；全部任务归档且服务端
  active 记录已被归档同步清除后隐藏。隐藏不删除 binding/taskSpace，也不自动解绑。
- 归档 active 删除继续由服务端归档同步的现有 `purgeArchivedTaskFiles` 完成；客户端不传
  archive、不主动删除服务端 active。归档未推送/未同步时保持可见并提示等待。
- 分支重新出现新的活动任务时再次显示；隐藏期间保留的 binding 继续接收任务变化。
- 不新增服务端表、协议字段或索引字段。
- 不自动创建/删除/移动 worktree，不安装 Git hook，不修改 Trellis 脚本。

## Confirmed Facts

- 客户端只监听 approved binding 的 `<repo_path>/.trellis` 和 Git 元数据；没有监听
  `<common_dir>/worktrees`。
- 客户端 Git 白名单没有 `worktree` 子命令；需要新增 `git worktree list --porcelain`。
- linked worktree 的 `.git` 是文件；客户端已有 `resolve_git_dir`/`commondir` 解析。
- `local_repo_key = sha256(canonical repo path)`；不同 worktree 路径不同，可分别绑定。
- 服务端 taskSpace = `remote identity + branchName`；同一项目可有多个 taskSpace。
- 现有接入流程 `inspect_project` / `preflight` / `attach` 要求：目录是仓库根、当前分支合法、
  未启用 sparse checkout、有 `.trellis/tasks`、按需检查推送状态。
- `attach` 需要 team ID；项目首次接入还需要 Trellis developer ID；已存在的项目成员可省略
  developer ID。发现来源是已绑定仓库，因此源 binding 能提供 team/project。
- 首次同步模式 `safe` 只拉服务端、把本地差异 deferred；不会批量上传继承任务。
- 任务同步、归档、命令、冲突、分支守卫全部按 binding/taskSpace 工作；本任务不改变这些契约。
- 服务端归档同步默认启用（`enabled=1`，`interval_seconds=300`）；导入 archive 后调用
  `purgeArchivedTaskFiles` 对 active 记录写墓碑并递增 revision，客户端可经 snapshot/SSE 或
  `GET /api/agent/task-spaces/:id/tasks` 观察到 active 清空。
- `task.py archive` 把任务移到 `.trellis/tasks/archive/<YYYY-MM>/` 并在开启时自动提交；客户端
  不负责推送归档提交。
- `git worktree add` 会触发 `post-checkout`，`--no-checkout` 不触发；删除 worktree 没有 hook。

## Requirements

### R1 发现与基线

- 监听 `<common_dir>/worktrees`（非递归）的创建、删除和重命名；去抖后执行
  `git worktree list --porcelain`，以 Git 输出为准 reconcile。
- 启动时发现已存在的 worktree 也允许登记，但登记时立即记录 baseline；不会因为启动前已存在的
  任务触发接入。
- 主工作树、bare 仓库不登记；`prunable`/路径不存在的记录标记 `stale`。
- 每个发现的 worktree 记录：规范化路径、repo 根、worktree 分支、HEAD、baseline HEAD、
  baseline 任务目录集合、发现时间、状态。
- 发现阶段只维护本地隐藏注册表；不创建 binding/taskSpace，不显示分支。

### R2 新增任务候选

- 为每个已发现、未接入的 worktree 安装轻量 `.trellis/tasks` watcher（只读候选检测，不上传）。
- 候选条件全部满足：
  - 任务目录位于 `.trellis/tasks/**`，不是 `archive/**`；
  - 目录不在 baseline 任务目录集合中；
  - `task.json` 可解析、`id` 非空；
  - `task.json.branch == worktree 当前分支`。
- `task.json.branch` 为空时标记 `waiting_branch`，继续监听；`task.py start` 写入分支后再判定。
- `task.json.branch` 是其他分支时忽略，不触发接入。
- 从基线继承的已跟踪任务、已有任务的修改、归档目录不进入候选。
- 同一任务重复事件幂等；候选消失（归档/删除）时清理，不创建 taskSpace。

### R3 自动接入

- 首次出现候选时，去抖后自动执行现有 `inspect_project → preflight → attach`；不弹确认框。
- 若该 worktree 路径已有 approved binding（用户手工接入），跳过自动接入，标记
  `autoManaged=false`；不应用 tracked 过滤和自动可见性，保持现有手工行为。
- 接入参数：
  - 路径 = worktree 根；
  - 分支 = worktree 当前分支；
  - team/project 来自发现该 worktree 的源 binding；
  - developer ID 优先取项目成员/`.trellis/.developer`；已存在的项目成员可省略；
  - 首次同步模式固定 `safe`；
  - 推送检查只在项目要求时执行；失败则中止接入并保留候选。
- 接入前重新校验路径、分支、`.trellis`、sparse、权限；不信任发现时的旧状态。
- 同一 worktree 只允许一个自动接入流程；并发事件合并。
- 接入成功写 binding，进入 `pending_upload`；接入失败进入 `error`，保留候选和重试信息，
  不显示分支，不重复创建 binding/taskSpace。

### R4 首次上传与显示

- 接入成功后只上传触发接入的候选任务目录（以及期间新出现的合法候选），不批量上传 baseline
  继承任务。
- 复用现有 `upload_directories` / `sync_deferred_tasks` / cursor 链路；`safe` 初始同步产生的
  deferred 不作为本次上传依据。
- 首次上传成功后才把 worktree 分支标记 `visible`，ProjectRail/Board 显示该分支。
- 上传失败保持 `pending_upload`/`error`，分支隐藏；显示非阻塞错误并允许自动/手动重试。
- 接入成功但候选在首次上传前被删除/归档：不显示分支，记录 `no_candidate`；已创建的空
  taskSpace 不自动删除（记风险/诊断）。

### R5 懒显示、可见性与归档

- 发现但未触发候选的 worktree 不在 ProjectRail/Board 显示分支；只保留隐藏注册表和可选诊断。
- 接入失败、上传失败在 ProjectRail 显示非阻塞状态/错误，不抢焦点、不弹确认。
- 接入并首次上传成功后，分支进入 `visible`；后续任务变化沿用现有 binding 同步和分支标签展示。
- 分支可见性按以下规则动态计算，且只作用于自动接入的 worktree 分支；手工分支不变：
  - worktree 路径不存在/已 prune：立即 `hidden_missing`，即使服务端仍有 active 任务；保留
    binding 和 taskSpace，标记 `stale`，ProjectRail 不再显示该分支。
  - 本地 `.trellis/tasks` 仍有该分支的活动任务（非 archive）：`visible`。
  - 本地活动任务为 0，服务端该 taskSpace 的 active 任务仍大于 0：保持 `visible`，并标记
    `archive_sync_pending`，提示“等待归档提交推送/服务端归档同步”；不隐藏，因为 active
    记录尚未被服务端清除。
  - 本地活动任务为 0，服务端 active 为 0：`hidden_empty`，ProjectRail/Board 活动视图不再
    显示该分支。服务端 active 为 0 即视为归档同步已执行（现有
    `purgeArchivedTaskFiles` 删除 active 记录）；客户端不另外上传 archive。
  - 服务端 active 查询失败：保持上一次可见性，显示非阻塞错误，不因不确定而隐藏。
- 隐藏时保留 binding、taskSpace、归档和审计数据；不自动解绑、不删除服务端数据，不自动清理
  空 taskSpace。隐藏分支在诊断/状态接口中仍可查看。
- 隐藏分支重新出现新的活动任务时再次显示：worktree 仍存在时保留的 binding watcher 继续同步；
  新任务上传后服务端 active 大于 0，可见性恢复。首次接入的“等首次上传成功才显示”规则不
  适用于已接入分支的后续任务。
- 可见性重算触发：本地任务目录变化（含 `task.py archive`）、服务端 snapshot/SSE 的 active
  删除、binding 同步完成、ProjectRail 打开/刷新、低频定时 reconcile；避免高频轮询。
- 归档提交未推送、服务端归档同步未执行或失败时，分支保持可见并提示等待；不把本地归档误判为
  服务端已完成。
- 同一 worktree 删除/重建后重新走发现与 baseline；旧 binding 的隐藏状态按路径/分支匹配处理，
  不自动迁移 `repo_path`。

### R6 删除、移动和失联

- 未接入的 worktree 被删除/prune：清理注册表、baseline 和轻量 watcher；不产生服务端数据。
- 已接入的 worktree 被删除/prune/路径消失：标记 `stale` 和 `hidden_missing`，立即从
  ProjectRail/Board 活动视图隐藏；保留 binding，提示可解绑；不自动解绑、不删除服务端
  taskSpace/任务/冲突/审计。
- worktree 移动/`git worktree repair`：按 Git 输出更新发现注册表；已绑定 binding 的 `repo_path`
  不自动迁移，需用户重新接入/解绑。
- 已绑定 worktree 删除后，现有分支守卫暂停同步，沿用现有错误展示。

### R7 幂等与安全

- 同一 worktree、同一候选的重复事件只触发一次接入/一次上传。
- 以规范化路径为主键；候选以任务目录 + 任务 ID 去重。
- 只使用 git 输出和受控路径；不信任任务文件中的路径；不执行 worktree 中的脚本。
- 不自动删除/移动用户任务；不自动解绑；不安装 hook。
- 自动接入失败不影响现有 binding 同步，只记录该 worktree 的状态。

## Acceptance Criteria

- [ ] 外部 `git worktree add` 后，客户端发现 worktree，但 ProjectRail/Board 不立即显示该分支。
- [ ] 从基线继承的已跟踪任务、已有任务修改、客户端关闭期间创建的任务不会触发自动接入。
- [ ] 在 worktree 中新建活动任务并执行 `task.py start`（`branch` 为 worktree 分支）后，客户端在
      明确时间上限内自动接入，不弹确认框。
- [ ] 自动接入创建的分支 taskSpace 对应 worktree 当前分支；只上传触发接入的候选任务，不批量
      上传继承任务。
- [ ] 首次上传成功后 ProjectRail/Board 显示该分支和任务；上传失败时分支保持隐藏并显示非阻塞错误。
- [ ] 分支内任务归档并推送后，服务端归档同步删除 active 记录；当本地该分支已无活动任务且
      服务端 active 为 0 时，ProjectRail/Board 活动视图不再显示该分支。
- [ ] 归档提交未推送或服务端归档同步未执行时，分支保持可见并显示“等待归档同步”状态，不提前隐藏。
- [ ] worktree 被删除/prune 后，即使服务端仍有 active 任务，该分支也从 ProjectRail/Board 活动
      视图隐藏；binding/taskSpace 保留，且不自动解绑或删除服务端数据。
- [ ] 隐藏分支中新建并上传活动任务后，分支重新显示；不重复创建 binding/taskSpace。
- [ ] `task.json.branch` 为空时不自动接入，等待 `task.py start` 后再触发。
- [ ] `task.json.branch` 为其他分支时不触发。
- [ ] 自动接入失败（权限/team/推送/网络）不创建重复 binding/taskSpace，保留候选并支持重试。
- [ ] 未接入 worktree 删除后不产生服务端数据；已接入 worktree 删除后标记 stale、可解绑，不自动
      删除服务端数据。
- [ ] 重复事件、启动 reconcile、手动重试不产生重复接入/重复上传。
- [ ] 已手工接入的 worktree 不会被自动接入流程重复绑定，也不会被自动可见性过滤或隐藏。
- [ ] 现有手工接入、单 worktree 同步、分支守卫、归档、命令和冲突行为无回归。

## Out of Scope

- 把 worktree 任务写入源分支 taskSpace；源分支解析、`needs_source`、`set-branch` 校正。
- 服务端 `sync_task_origin`、快照过滤、待合入/孤儿状态、命令 origin 路由。
- 客户端上传归档正文或改变服务端归档模型。
- worktree 隐藏时同步删除/停用服务端 taskSpace；本任务保留 binding/taskSpace，后续单独处理。
- 自动创建、删除、移动 Git worktree。
- 补发现客户端关闭期间创建的任务。
- 自动解绑或自动删除空 taskSpace。
- 依赖 `post-checkout` 等 Git hook 作为主检测手段。
- 修改 Trellis 脚本或 `task.json` 字段语义。
