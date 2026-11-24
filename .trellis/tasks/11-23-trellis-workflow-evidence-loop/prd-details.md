# PRD 详细材料：背景、决策、R5 与风险

> 本文是 `prd.md` 的附录；核心内容以 `prd.md` 为准。

## Background

R35860/R35862/R35868 事故暴露的是 Trellis 流程本身没有把“维护任务文件”交给 agent，而不是看板缺少一个修复按钮：

- R35860：15:30:47 `task.py start` 把 `status` 改为 `in_progress`，但该改动一直未提交；20:22–20:25 处理 `git pull --rebase` 时，保存该改动的 stash 在 pop 冲突后被 drop，20:25:04 文件回退为 `planning`，看板回到「待放行」。
- R35862：从未执行 `task.py start`，`task.json` 始终 `planning`；代码提交 `afc4cd4` 存在，但看板不反推 git，任务一直停在「待放行」。
- R35868：13:41 `start`、14:34 提交 `f0125af`，但顶层 `commit` 一直为空，直到 23:03 才人工补写。

当前 Trellis 的缺口：

- `.trellis/workflow.md:600-650` Phase 3.4 只提交代码，没有“提交后写回 `task.json.commit`”的步骤。
- `.agents/skills/trellis-finish-work/SKILL.md:8` 明确代码提交不在这里做；`:32` 把 `.trellis/tasks/` 排除在脏文件检查之外；`:60-65` 的 `--commit` 传给 `add_session.py`，只写 workspace journal。
- `.trellis/scripts/common/task_store.py:1351-1352` 归档只写 `status=completed`/`completedAt`；`:1920-1924` `set-meta` 只写 `meta[key]`；`:545` 模板只有 `"commit": None`，没有写入者。
- `.trellis/scripts/task.py:112-114` `start` 只在 planning 时改 `in_progress`；`task.py` 没有 `set-commit` 子命令；`archive --help` 只有 `--no-commit` 与 `--skip-branch-validation`。
- `.trellis/agents/implement.md:32`、`.claude/agents/trellis-implement.md:47` 禁止 implement 子代理 `git commit`；check 子代理同样禁止（`.trellis/agents/check.md:34`）；主会话拥有提交权，但提交后没有回写任务状态的职责。
- 看板把顶层 `commit` 作为实现完成证据（`packages/server/loader-stage.js:151-156`、`:291-294`；`packages/server/execution-projection.js:162` 把「工作提交 commit」列入 `dodMissing`），但生产端没有对应命令。
- `task.py start` 写入的 `status` 是未提交的本地文件，而工作流又把 `.trellis/tasks/` 排除在常规提交之外；一次 stash/rebase 就能让状态回退，且没有 `verify`/`doctor` 发现。

为什么不在看板侧修：

- 看板是只读投影，`.trellis/spec/guides/cross-layer-thinking-guide.md:60` 明确禁止前端 `setStage` 或 `PUT /api/tasks/stage`；加“改状态/改 commit”的交互会制造第二套状态来源，掩盖 agent 没有维护任务文件的事实。
- 问题跨所有接入仓库；在看板补一次，只解决一个表面，其他仓库的 agent 仍然不会写 `commit`、不会在状态回退时恢复。
- 人工在看板上点一下，等于把“agent 应该自动维护 Trellis 文件”退化成“人定期巡检并补救”，与目标相反。
- 看板现有证据检查已经能显示缺口；真正缺的是生产端：workflow 没有要求、skills 没有步骤、scripts 没有命令、agent prompts 没有职责。

核心原则：

1. **Agent 是 Trellis 文件的生产者和维护者**；人只 review 和授权。
2. **主会话是 `task.json` 的唯一写入者**；implement/check 子代理写各自阶段报告，不抢写状态/commit。
3. **`task.py` 是唯一受支持的写入通道**；正常流程不手改 JSON。
4. **每个阶段都有 verify gate**；缺失证据不能静默进入下一阶段。
5. **状态变更必须在安全点持久化**；不能只存在于未提交的工作区。
6. **看板只读**；看板不新增修复交互。


## 决策记录（2026-11-24）

| 编号 | 决策 | 结论 |
|---|---|---|
| D1 | start commit 落点与 push | 跟随任务工作分支；默认不 push；团队可见时显式 `--push`；复杂任务由 workflow 决定；worktree 自动发现沿用看板现有能力，“重复任务以源分支为准”当前未实现，另开看板任务 |
| D2 | 任务生命周期 | 本期不扩 status；放弃任务用 `meta.abandoned` + archive；`cancelled`/`reopen` 另开任务 |
| D3 | commit 语义 | 顶层 `commit` = 最终主提交；`meta.commits` 记录历史；`set-pr` 记录 PR；squash/rebase 后 finish 前更新；跨仓库各仓库只记录自己的 commit，不聚合；`set-commit` 默认校验对象存在，浅克隆/跨仓库用 `--allow-missing-object`；`verify` 默认 warning、strict 阻断 |
| D4 | 多人/assignee | 第二个 `start` 默认拒绝，仅 `--force` 允许；assignee 为空用 git user；同一任务只允许 assignee |
| D5 | 冲突裁决 | 远端 completed/archived 优先停止；远端 planning + 本地 start 保留 in_progress；双方 start 由 owner 决定；不做自动 merge driver |
| D6 | 任务类型标签 | 新任务在 create 时显式标记 `task_type=simple/complex/research`，标签是唯一判定依据；complex 缺 design/implement 在 start/verify 阻断；simple 可选生成 design/implement，仍按 simple、不降级、不报错；存量任务无标签按 legacy 推断并 warning，不迁移 |
| D7 | check 证据（backend） | complex backend：check-report 或任一验收勾选；两者都无时中断并明确询问用户；授权后写 `meta.check_override`（授权人限 assignee/owner、原因、时间、绑定 commit）才通过；同一 commit 只问一次，commit 变化后失效重问；子代理不能授权；非交互 exit 4；frontend 证据规则见 D14 |
| D8 | 失败策略 | fail-closed：bookkeeping commit 失败不进入实现、不回滚 planning、不自动降级；只有显式 `--no-commit-state` 降级 |
| D9 | 批量修复 | `task.py verify --all --fix` / `doctor --all --fix` 自动修安全项；不安全项只报告并阻断 |
| D10 | 分发 | trellis-board 维护版本化 Trellis 发行层（模板/脚本/skills/prompts/manifest）；看板初始化后应用；优先 overlay，fork 仅作后续评估；各平台兼容；存量任务不迁移 |
| D11 | 事件日志 | `.trellis/tasks/<task>/.state-events.jsonl`，schemaVersion 1，append-only；记录 start/reset/state_commit_failed/check_override/archive；随任务目录归档；默认提交，敏感字段脱敏 |
| D12 | schema/兼容 | `task_type`/`work_type` 新任务必填、存量可缺失；`meta.commits`/`state_persisted`/`meta.check_override`/`meta.frontend_evidence`/`meta.frontend_check_report_required` 可选；存量任务不迁移；看板忽略未知字段；`set-commit` 默认校验对象存在，`verify` 对对象缺失/不可达默认 warning、strict 阻断 |
| D13 | 平台适配 | `trellis-kit` 以平台 `capabilities + paths + formats` 声明为唯一事实源，不按平台名硬编码；首批覆盖 claude/codex/opencode/pi/omp/antigravity/dsh，其他平台走通用 fallback；首次 init 与 `--agent-only` 共用同一适配层；只写平台支持的目录/格式，不创建不支持的空目录；多平台可同时安装 |
| D14 | 工作类型与前端证据 | 新增顶层 `work_type=backend/frontend/fullstack/research/docs`，create 时必填，与只表复杂度的 `task_type` 正交；前端证据以浏览器 E2E、截图/预览、owner 确认为一等证据；`check-report` 不是前端硬门槛，普通 simple 前端不要求；complex 前端只勾一个验收项不足以通过，必须 E2E/视觉证据 + owner 确认，或 check-report；共享组件/设计系统/路由/状态/可访问性/性能敏感改动要求结构化 check-report |
| D15 | 标签判定责任 | `task_type`/`work_type` 由 agent 在 create 前提议并说明理由，用户确认一次；用户明确说“按建议”可记为 `user-delegated`；面板/插件中用户主动选择视为 `user-explicit`；复制/子任务继承父任务标签只作为提议；`meta.label_source` 记录 `user-explicit`/`agent-proposed-user-confirmed`/`user-delegated`/`copied-from-parent`/`legacy`；不允许静默猜成 simple/backend |
| D16 | 面板与插件创建入口 | 看板“创建任务并派发”表单新增必填“任务类型”下拉（backend/frontend/fullstack/research/docs），随 create 全链路写顶层 `work_type`；插件 `ctx.tasks.create` 接受 `workType`，插件任务 DTO 返回 `workType`；WitOps 只把“前端开发/后端开发”明确映射为 frontend/backend，其他分类留空由用户选；插件创建对话框默认选中当前工作项映射值；看板表单接受 `defaultWorkType`（插件上下文/URL），没有值时保持空，不静默默认 backend；批量混合类型不猜 |


### R5：补齐 Trellis 脚本与模板能力

- 扩展 `task.py create`：新增 `--task-type simple|complex|research` 与 `--work-type backend|frontend|fullstack|research|docs`（新任务都必填；漏传拒绝创建，交互式流程强制询问）；写入顶层 `task_type`/`work_type`。新增 `task.py set-task-type <task> <type>` 与 `task.py set-work-type <task> <type> [--check-report-required]`：只允许 start 前修改；start 后必须 `--force` + `--reason`，写事件；`--check-report-required` 写 `meta.frontend_check_report_required=true`，用于共享组件/设计系统/路由/状态/可访问性/性能敏感前端任务。
- 新增 `task.py set-commit <task> <hash> [--allow-missing-object] [--persist]`：只写顶层 `commit`（默认最终主提交），支持 7–40 位十六进制或 `HEAD`；用 `git rev-parse --verify <hash>^{commit}` 校验对象存在；对象不存在默认失败，`--allow-missing-object` 才写并记 `meta.commit_object_present=false`；`meta.commits` 追加历史；`--persist` 可选生成 bookkeeping commit；幂等、保留其他字段、写事件。
- 新增 `task.py set-pr <task> <url>`：只写顶层 `pr_url`，校验 http(s)，不调 API，幂等。
- 新增 `task.py set-evidence <task> --type e2e|visual|manual --artifact <path-or-url> --commit <hash> [--confirmed-by <assignee|owner>] [--note <text>]`：只用于前端/全栈证据，写 `meta.frontend_evidence = {type, artifact, commit, confirmedBy, note, at}`；`artifact` 必填（截图路径、预览 URL、E2E 报告路径/URL），`commit` 必须是当前顶层 commit 或可解析对象；`confirmedBy` 为空时记 `unconfirmed`，复杂前端不算通过；同一任务保留最新一条并追加事件。
- 新增 `task.py verify <task> [--strict]`：检查 status、`task_type`、`work_type`、顶层 commit、按 `task_type + work_type` 要求的证据（research 豁免 commit/报告；simple 至少一项 commit/验收/报告/completed；complex 后端为 commit 且 check-report/验收至少一项；complex 前端为 commit 且（`meta.frontend_evidence` 的 E2E/视觉证据 + owner 确认，或 check-report），只勾一个验收项不算；fullstack 同时要求后端与前端证据；证据都无时进入 `needs_user_decision`，交互式明确询问，用户授权后写 `meta.check_override` 才通过；非交互返回 exit 4）；`meta.check_override` 只允许 assignee/owner 通过显式 `--by` 授权，必须绑定当前 commit，commit 变化后失效并重新询问；子代理不能授权；无 `task_type`/`work_type` 的存量任务按 legacy 推断并 warning；检查 commit 对象存在/是否可从当前分支到达（缺失/不可达 warning，strict 失败）；`--strict` 在 finish/archive 前阻断。
- 新增 `task.py doctor <task>`：检测状态回退、`task_type`/`work_type` 缺失或与产物明显不一致、代码任务缺失 commit、复杂任务缺失验收/check-report、复杂前端缺失 E2E/视觉证据或 owner 确认、`meta.commit` 陷阱、commit 对象缺失；能安全恢复的恢复，不能恢复的询问；`doctor --all --fix` 只自动修安全项。
- 新增 `task.py verify --all --fix`：批量巡检；安全项（状态回退、`meta.commit` 迁移、可重建的 bookkeeping commit）自动修，不安全项只报告并阻断。
- 修改 `task.py set-meta`：拒绝 `status`/`commit`/`pr_url` 等保留键，提示使用专用命令，避免“写进 meta 但没人读”的陷阱。
- 修改 `task.py archive`：默认要求与 `task_type + work_type` 匹配的证据（simple 至少一项；complex 后端为 commit + check 证据或 `meta.check_override`；complex 前端为 commit + 前端证据/check-report/override；fullstack 两端都要），research 用 `--planning-only` 豁免；无 `task_type`/`work_type` 的存量任务按 legacy 规则；`--no-commit` 仍表示跳过归档 git commit，不等同于证据豁免；归档时写 `status=completed`/`completedAt`。
- 事件日志：`.trellis/tasks/<task>/.state-events.jsonl`，schemaVersion 1，append-only，记录 start/reset/state_commit_failed/check_override/evidence/archive；随任务目录归档；默认提交到仓库，敏感字段脱敏；日志损坏时只报告，不自动重建。
- 设计状态持久化：复杂任务默认 `task.py start` 后由主会话提交仅含任务文件的 bookkeeping commit；轻量任务默认写本地事件记录并由 `verify`/`doctor` 兜底，也可 `--commit-state` 强制提交。避免再次出现“stash drop 后无记录”。
- `task.py start --commit-state` 的失败语义（必须实现，不能静默降级）：
  1. **预检**：确认是 git 仓库、没有进行中的 rebase/merge/cherry-pick、任务路径未被 `.gitignore` 忽略、git identity 可用；预检失败直接返回非零，**不写 status**。
  2. **写入与提交**：写 `task.json` + 事件 intent → 只 stage 任务文件（pathspec 限定，不带上用户已暂存的其他改动）→ bookkeeping commit（默认 `--no-verify`，仅跳过 pre-commit/commit-msg；代码提交仍走正常钩子）。事件中的 commit hash 可由 `git log -1 -- <task.json>` 解析，避免“提交后再写 hash 导致自引用”。
  3. **提交失败**：保留 `task.json`/事件文件，事件追加 `state_commit_failed` + stderr；`start` 返回非零（exit 3）；**不自动回滚为 planning，也不自动降级**；workflow 停在 start gate，`verify` 报 `state_not_persisted`；`doctor --fix` 重试。
  4. **显式降级**：只有调用方传 `--no-commit-state` 才允许只写事件；事件标记 `degraded=true`；`verify --strict` 对 complex 仍阻断，除非用户再次显式确认。
  5. **幂等**：`nothing to commit` 且 HEAD 中任务文件已经是 `in_progress` → 视为成功；否则按失败处理。
  6. **不自动绕过**：签名失败、identity 失败、index.lock、权限/磁盘错误都按失败返回；`--no-verify` 只用于 bookkeeping commit 的钩子，不掩盖 git 层错误。
- **拉取与并发语义**（团队共享 task.json 时必须明确）：
  - 本地 `start` 是**未 push 的 commit** 时，`git pull --rebase` 会把它重放到远端提交之上；远端没改同一 `task.json` → clean replay，状态保留；远端改了同一文件 → rebase 冲突，必须显式解决，不得自动丢弃本地 `in_progress`。
  - `task.py doctor --reconcile`（或 verify 的修复指引）读取事件日志与当前 `task.json`：本地已 start、远端仍 planning → 保留 `in_progress`；远端已 completed/archived → 优先停止并询问，不得复活；双方都 start → 要求 owner 决策。禁止手改 JSON 合并状态；不做自动 merge driver。
  - **默认不 push**：start commit 只保证本地不丢，不保证别人能看到；需要团队实时可见时显式 `--push`（或首个工作提交时 push），复杂任务由 workflow 决定；否则明确接受“远端仍显示 planning”的可见性延迟。
  - **同一任务只允许 assignee 推进**：第二个 `start` 默认拒绝（非零），只有显式 `--force` 才允许；assignee 为空时用 git user 填充；git 文件本身不提供分布式锁，不能阻止两人同时开始，只能检测和阻断。
  - 避免批量重写/格式化 `task.json`；其他任务的文件变更不应触碰当前任务文件，减少同文件冲突面。
- 为上述命令补单测；命令必须跨平台（Windows/Git Bash/PowerShell）可用。


## Risks / Constraints

- **Agent 依从性**：workflow/skills 写了步骤，agent 仍可能跳过；必须用 `verify` gate 和 finish-work 阻断兜底。
- **任务类型低报**：agent/用户可能为了省事把 complex 标成 simple；create 必填不能防住故意低报，需要 start 后改类型 `--force`+reason、verify 显示标签、review 时人工确认；不能靠产物自动改判（用户明确要求标签权威）。
- **状态持久化 vs 提交噪音**：复杂任务启动 bookkeeping commit 会增加提交数；轻量任务用事件日志则依赖本地文件。默认策略按任务分层，并允许用户显式开关。
- **bookkeeping commit 失败**：hook、index.lock、rebase/merge、identity/签名、任务目录被 ignore、磁盘/权限都可能失败；必须 fail-closed，不能静默继续；`--no-verify` 只处理钩子，不掩盖 git 错误。
- **分布式可见性**：未 push 的 start commit 只在本机可见；团队远端仍显示 planning。需要实时可见时必须在 start 后 push，或引入共享状态服务（当前非目标）。
- **同文件并发**：同一 `task.json` 被多人/自动化修改时，rebase 可能冲突；必须有 owner 约束和 `doctor --reconcile`，不能自动选择某一方。git 文件不是分布式锁，两人同时 start 只能检测/阻断，不能阻止。
- **单一写入者**：主会话与子代理都可能写任务文件；必须用矩阵和命令约束，避免并发覆盖。
- **模板分发**：各仓库的 `.trellis`/`.agents`/`.claude` 是副本；升级要可重复、可校验，且不能被 `trellis update` 静默覆盖。
- **向后兼容**：存量任务可能 `commit=null`、报告缺失；`verify` 对 planning/archived 任务要给出警告而非误阻断，lightweight 任务缺报告不视为错误。
- **跨平台**：claude/codex/opencode/pi/omp/antigravity/dsh 的 skills/commands/agents/hooks/settings 目录与格式不同，部分平台没有 hooks、commands 或 subagent；必须按 capability 生成并报告 skipped，不能假设 `.claude`/`.codex` 存在。
- **平台漂移**：上游 `AI_TOOLS`/目录规范可能随版本变化；kit registry 要带版本/测试矩阵，升级时先 `--check` 并对照上游 `trellis platforms`，避免写错目录。
- **AGPL-3.0-only**：`@mindfoldhq/trellis` 0.6.17 为 AGPL-3.0-only；fork/分发或把脚本并入桌面安装包前必须做合规评估，overlay 也可能包含 AGPL 代码。
- **worktree 重复任务**：当前看板自动接入 worktree 为独立 taskSpace，没有“源分支优先/重复任务不更新”；用户预期与现状不一致，需另开看板任务，否则同一任务可能显示两份状态。
- **check override 滥用**：`meta.check_override` 必须记录授权人/原因/时间；否则会变成“点一下通过”的橡皮图章。
- **自动修复风险**：`--fix` 只能修可证明安全的项；状态回退/有意 reset 的区分依赖事件日志，日志缺失时应只报告。
- **范围**：这是流程优化父任务；落地时按“契约/脚本”“workflow/skills”“agent prompts”“分发/回归”拆子任务，避免一次改动过大。
