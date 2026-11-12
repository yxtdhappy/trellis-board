# 修复同一仓库跨分支任务串写

## Goal

保证一个本地 Git 工作目录在任一时间只同步当前真实分支对应的任务空间，阻止任务被上传、拉取或重试到其他分支，并提供存量重复任务的安全清理路径。

## Background

- 当前本机 Agent 配置把同一个本地仓库 `localRepoKey` 同时绑定到 `codex/server-gitless-task-sync` 和 `main` 两个任务空间。
- 桌面关联流程 [project-onboarding.js](../../../agent/project-onboarding.js:441) 只按 `taskSpaceId` 替换旧绑定，没有排除相同 `localRepoKey`。
- 配置校验 [config-store.js](../../../agent/config-store.js:155) 只禁止同一任务空间重复，不禁止同一仓库绑定多个任务空间。
- 任务快照监听和上传按 `taskSpaceId` 分别注册同一目录；[task-snapshot-sync.js](../../../agent/task-snapshot-sync.js:267) 会为两个绑定各创建一次 watcher，导致一次本地变更双写。
- 任务快照拉取和上传路径没有检查本地真实 Git 分支：[task-snapshot-sync.js](../../../agent/task-snapshot-sync.js:746)、[task-snapshot-sync.js](../../../agent/task-snapshot-sync.js:1066)。
- Git 仓库同步已经具备分支不匹配拒绝逻辑：[git-sync.js](../../../agent/git-sync.js:536)，但任务快照同步未复用该安全边界。
- `agent/live-sync.js` 是未被当前 Team runtime 导入的遗留模块；当前实际双写链路是 tasks-only 任务快照 watcher、增量拉取和 pending retry。
- 当前数据中两个任务空间存在 5 个重复活动任务；同一任务文件已被记录为在相近时间分别上传到两个任务空间。

## Requirements

### R1 单仓库单任务空间

- 同一 Agent 的同一 `localRepoKey` 只能存在一个有效任务空间绑定。
- 新建或切换分支绑定不得静默保留旧分支绑定并产生双写。
- 配置加载必须识别历史双绑定并阻止双 watcher；所有新配置写入、桌面关联、CLI bind 和服务端心跳更新必须严格收敛到单 binding。
- 桌面端关联新分支时必须先展示旧、新分支和任务空间，用户确认后原子替换本机旧绑定。
- 服务端在同一事务中撤销该 Agent 使用相同 `localRepoKey` 的旧任务空间 binding，保留旧任务空间、任务数据和其他设备绑定。
- 同一 Git 仓库的多个分支需要同时同步时，必须使用独立 Git worktree；每个 worktree 只能绑定其当前分支。

### R2 同步前分支门禁

- 每次任务快照上传、拉取、首次同步、延后任务补同步、pending batch 重试和 watcher 触发的上传前，都必须读取本地真实分支。
- 本地真实分支必须与 `binding.branchName` 完全一致；未匹配时整次操作失败关闭，不写本地文件、不上传服务端、不推进 cursor。
- 分支门禁必须覆盖服务端事件触发的拉取，不能只在启动或绑定创建时检查一次。
- 不自动执行 `git checkout`、`git switch` 或任何分支变更。

### R3 分支不匹配状态

- 分支不匹配时，相关绑定进入明确的可恢复暂停状态，并展示实际分支、期望分支和处理方式。
- 暂停期间不得消费或补发旧分支的 pending 上传队列。
- 用户切回期望分支后重新校验成功，绑定才可恢复同步；必要时重新拉取服务端增量，不能直接假定本地状态仍收敛。
- 运行错误必须通过现有控制事件、运行状态或项目状态传递到桌面 UI，不能只写日志。

### R4 按任务空间和分支路由

- 同步身份必须包含 `projectId + branchName + taskSpaceId`，不能只用 `projectId` 判断当前同步目标。
- 任务快照上传继续使用 `taskSpaceId`，并必须携带 `observedBranchName`；服务端校验它与任务空间及绑定分支一致，作为第二道防线。
- 任务快照 watcher、队列、cursor 和状态必须按 `taskSpaceId` 隔离，不能因 `projectId` 相同而互相覆盖。

### R5 存量重复数据清理

- 提供可审计的识别和清理流程，找出同一项目跨任务空间重复的任务目录、文件、revision 和审计来源。
- 清理前先停止错误绑定同步并校验真实分支，避免删除后立即被重新上传。
- 默认先 dry-run 输出待清理任务；实际删除存量数据必须单独获得用户授权。
- 清理不得影响保留任务空间中的任务、归档目录、无关项目或 Git 工作区源码。

## Acceptance Criteria

- [x] 同一 `localRepoKey` 再次关联另一分支时，系统不会生成两个同时 approved 的本地任务空间绑定。
- [x] 当前仓库位于非绑定分支时，快照上传、快照拉取、pending 重试、延后补同步和 watcher 触发的上传均被拒绝，且任务文件、cursor 和服务端 revision 不变。
- [x] 分支不匹配状态能在桌面 UI 代码中看到实际分支与期望分支，并给出“切回分支”或“重新关联当前分支”的明确处理入口。
- [x] 分支校验失败后，即使服务端持续发送 `task.changed` 或定时重试触发，也不会把任务写入错误分支。
- [x] 用户从错误分支切回绑定分支后，系统重新校验并恢复同步；恢复过程不会补写暂停前属于其他分支的变更。
- [x] 同一 Git 仓库的两个 worktree 会生成不同 `localRepoKey`，可分别绑定两个分支，watcher、cursor、pending 和状态按 taskSpace 隔离。
- [x] 服务端拒绝缺失、非法或与任务空间/绑定分支不一致的 `observedBranchName`。
- [x] 配置迁移或启动校验能识别现有双绑定，进入暂停状态并提供可执行修复提示，不发生自动覆盖。
- [ ] 现有 5 个重复任务的清理流程支持 dry-run，并在获得单独授权后只删除旧分支上的错误副本。
- [ ] 自动化测试覆盖：错分支上传、错分支拉取、pending 重试、服务端事件、桌面关联切换分支、双绑定迁移、双 worktree 正常同步和存量清理 dry-run；真实 Tauri/安装包验收仍待重启后执行。

## Out of Scope

- 不自动切换或合并 Git 分支。
- 不改变 Git 源码同步的现有职责，也不让服务端 clone、fetch 或读取项目 Git。
- 不把冲突任务内容自动合并。
- 不修改或删除未被当前 Team runtime 使用的 `agent/live-sync.js` 遗留模块。
- 不在未经单独授权时删除当前数据库中的存量任务。

## Decisions

- 用户已确认：同一仓库关联新分支时，在明确展示旧、新分支差异并获得确认后，自动替换本机旧绑定。
- 替换不修改 Git 分支，不删除旧任务空间，也不影响其他设备对旧分支的绑定；仅撤销当前 Agent 上使用相同 `localRepoKey` 的旧 binding，并停止本机旧 watcher。
- 服务端 attach 是替换操作的服务端事实来源；客户端必须按服务端返回的 `replacedBindings` 原子更新本地配置。
- attach 和本地配置写入不是同一事务。若 attach 成功而本地写入失败，保留服务端成功状态，并通过幂等重试 attach/配置收敛恢复，不恢复旧绑定。
