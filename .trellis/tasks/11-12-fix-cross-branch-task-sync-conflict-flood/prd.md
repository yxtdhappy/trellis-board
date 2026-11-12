# 修复跨分支任务误同步与冲突记录膨胀

## Goal

按真实检出分支限制任务同步范围，避免残留任务目录串写；将冲突收敛为每个 Agent 和任务唯一的待处理状态，并提供旧任务空间与重复冲突的安全清理。

## Background / Confirmed Facts

- 当前仓库实际检出 `main`；本机存在旧分支
  `codex/server-gitless-task-sync` 和 `main` 两个历史 binding，运行时只应激活与真实分支匹配的
  `main` binding（taskSpace `a8d34d0e-54af-4041-bb2c-4507665c7abe`）。
- 现有分支选择只发生在 binding/taskSpace 层。任务 watcher 仍监听整个 `.trellis/tasks`，
  [task_sync.rs](../../../apps/desktop/src-tauri/src/agent/task_sync.rs) 未按任务自身的分支归属过滤。
- 事故任务 `rust-desktop-agent-single-exe` 的本地目录是未跟踪目录；`main` 服务端版本记录
  `task.json.branch=codex/rust-desktop-agent-single-exe`，但数据实际写入 `main` taskSpace。
- 本地旧版与该任务在 `main` 服务端的更新版本持续发生 CAS 冲突。服务端每次冲突都新增一条
  `sync_conflict`，截至本轮盘点已超过 1193 条，且记录仍在增长。
- 冲突响应已经超过 Agent 默认 1 MiB JSON 上限，导致查看差异和冲突处理链路失败。
- 旧分支 taskSpace `75984cbd-ed47-4389-bddf-2efbce07f275` 有 68 个任务、452 个文件；
  `main` taskSpace 有 74 个任务、482 个文件。旧分支没有独占 task ID，63 个任务内容一致，
  5 个任务版本不同；旧数据需先备份再清理。
- `.trellis/spec/backend/desktop-realtime-sync.md` 已要求同一 Agent 的同一本地仓库只保留一个
  approved binding，切换分支替换 binding，多分支同时同步使用独立 worktree。
- 新建 Trellis 任务默认 `branch` 为空；仅凭目录存在不能证明任务属于当前分支。

## Requirements

- R1 本地任务同步必须同时满足“binding 对应真实检出分支”和“任务归属当前 taskSpace”两个条件。
- R2 任务 `branch` 明确等于当前分支时允许同步；明确属于其他分支时不得上传、不得写远端目录，
  并向用户展示可理解的分支归属冲突状态。
- R3 任务变为待处理冲突后，同一 Agent/taskSpace/task 在用户解决或显式重试前不得继续自动上传。
- R4 服务端对同一 Agent/taskSpace/task 只保留一个 pending conflict；重复检测更新该状态而不是新增记录。
- R5 冲突列表接口不得因历史重复数据突破 Agent 默认响应上限；历史重复冲突需要安全、可审计地收敛。
- R6 旧分支 taskSpace 与历史重复冲突必须支持 dry-run 预览、数据库备份和可恢复清理；禁止无预览直接删除。
- R7 清理旧 taskSpace 时保留 `main` taskSpace、任务审计和必要备份；默认采用停用而不是物理删除。
- R8 修复必须覆盖 watcher、增量 pull、pending retry、首次同步和显式补同步等所有上传路径，防止绕过门禁。
- R9 分支归属交互必须遵循“能唯一推断时不询问、存在歧义时一次性批量确认”，普通同步不得对每个任务
  重复弹窗。

## Confirmed Ownership Interaction

- 项目只有一个可用 taskSpace，或任务在服务端只存在于一个 taskSpace 时，直接采用该分支归属，
  不显示选择框；本地 `branch` 为空的任务在确认归属后补齐。
- 项目有多个 taskSpace 时，Web“创建任务”继续使用现有“共享分支任务空间”选择器：
  [CreateTaskDialog.tsx](../../../apps/web/src/features/board/dialogs/CreateTaskDialog.tsx)。
  只有一个可选 taskSpace 时隐藏选择器并自动选中；多个时默认当前选中的 taskSpace，没有选择时
  优先当前本地 binding，最后回退到列表首项。
- 本地未归属任务只在首次发现时集中展示一次，列出任务名、本地目录、服务端已有 taskSpace 和建议归属。
  用户可选择“归属当前分支”“标记属于其他分支但仅暂停”或“暂不处理”，并支持批量应用。
- 明确属于其他分支的任务不重复弹窗；在项目栏显示“N 个任务因分支不匹配暂停”，点击后重新打开
  归属列表。切回对应分支或打开独立 worktree 后自动恢复。
- 用户选择结果必须持久化：本地任务写入 `task.json.branch`，服务端快照同步该字段；后续 watcher、
  SSE、重启和冲突恢复都复用该结果。
- 任务已同时存在于多个 taskSpace 时，不允许自动合并；用户明确选择目标 taskSpace，其他副本由
  单独的重复数据清理流程处理。
- “暂不处理”只记录当前任务目录指纹，不写 `task.json.branch`；任务内容变化或用户点击项目栏待处理
  数量时才重新进入归属列表，不自动逐任务弹窗。
- 用户选择“其他分支”时只能从当前项目可见的有效 taskSpace 分支中选择；“暂不处理”用于处理不存在、
  已停用或暂时无法确认的归属。

## Acceptance Criteria

- [ ] AC1 当前检出 `main` 时，`branch` 为其他分支的任务不会触发 `main` taskSpace 上传或新增冲突。
- [ ] AC2 切到独立 feature worktree 且激活对应 binding 后，该分支任务可以正常同步。
- [ ] AC3 已有 pending conflict 时，重复 watcher、SSE、拉取和 Agent 重启不会新增同任务冲突记录。
- [ ] AC4 冲突列表和历史数据清理后，接口响应低于 1 MiB，查看差异和冲突处理可以正常使用。
- [ ] AC5 清理工具默认 dry-run；执行前生成数据库备份，只停用指定旧 taskSpace，不删除 `main` 数据。
- [ ] AC6 自动测试覆盖分支归属不匹配、空分支策略、冲突重试抑制、服务端冲突去重和 dry-run 清理拒绝条件。
- [ ] AC7 单分支项目不显示分支归属选择；多分支项目的本地任务只在归属有歧义时首次批量询问。
- [ ] AC8 明确归入其他分支或选择“暂不处理”的任务不会因 watcher、重试或重启再次自动上传。
- [ ] AC9 服务端在边界上拒绝 `task.json.branch` 与 taskSpace 分支不一致的写入，不能只依赖客户端过滤。
- [ ] AC10 旧 `codex/server-gitless-task-sync` taskSpace 最终为 `disabled`，重复冲突标记为
  `resolved`，数据库备份和清理前后审计结果可追溯。

## Notes

- 2026-11-13：代码实现已完成；按用户要求本轮跳过所有测试用例，未执行 `npm test`、Node 测试、
  Web 构建、Rust/Tauri 编译或真实浏览器验收。
- 2026-11-13：生产数据库清理工具已实现，但未对远端 `4317` 数据库执行 dry-run 或 apply；
  正式清理仍需停机、备份和单独执行。

## Out of Scope

- 不自动合并不同分支上的任务内容。
- 不自动删除 Git 分支、旧任务快照或审计事件。
- 不把不同分支任务默认合并成一张任务卡；Board 继续按 taskSpace 展示并在聚合视图独立统计。
- 不物理删除旧 taskSpace，除非后续有单独、明确的数据销毁需求。
