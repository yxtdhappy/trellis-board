# 让 agent 全程维护 Trellis 任务元数据（workflow + skills）

## Goal

建立一套以 agent 为执行主体的 Trellis 任务状态维护流程：从 create/planning 到 start、implement、check、commit、finish/archive，agent 在每个阶段自动写入并校验 `task.json` 与任务产物；人只做 review、授权和例外决策，不做补救性编辑。看板保持只读投影，不通过看板交互、服务端写回或人工补数据来修复任务状态。所有接入仓库共享同一套 workflow / skills / agent prompts / 模板脚本。

## Background（摘要）

- R35860：`task.py start` 已把 status 改为 `in_progress`，但改动只在工作区；`git pull --rebase` / stash pop 冲突后 stash 被 drop，task.json 回到 `planning`，看板从「实现」退回「待放行」。
- R35862：task.json 从未进入 `in_progress`，看板一直按 `review` 推导。
- R35868：代码提交 `f0125af` 已存在，但 `task.json.commit` 为空 8 小时，看板无法进入检查/收尾。
- Trellis 0.6.17 没有把提交号写回 `task.json` 的命令/步骤；`set-meta` 只写 `meta`，`archive` 不写 `commit`。
- 前端/后端任务没有统一类型与证据口径；前端常用浏览器/截图验收，后端常用 check-report。

> 完整事故时间线、证据与逐条决策见 `prd-details.md`。

## 决策记录（摘要）

D1–D16 的完整理由、备选与影响见 `prd-details.md`；本文的 R1–R9 已按这些决策收敛。核心结论：创建时只显式选择 `work_type`，`task_type` 由 agent 在实现前判断/询问用户确认后写入；只在 start/archive 持久化；complex start bookkeeping commit；事件日志；set-commit/verify/doctor；前端证据分层；面板/插件三入口写同一 `work_type`；看板只读。

## Requirements

### R1：定义 agent 全程维护的状态契约

明确“阶段 → 执行者 → 写什么 → 用什么命令/产物 → 什么 gate 通过”的单一契约，写入项目 spec 和 `trellis-task-state` skill：

| 阶段 | 执行者 | 写入内容 | 命令/产物 | 通过条件 |
|---|---|---|---|---|
| create / planning | 主会话 agent | `task.json`、`work_type`、`task_type`（可后置）、`prd.md`、按需 `design.md`/`implement.md`、manifests | `task.py create --work-type <backend/frontend/fullstack/research/docs>`、`task.py set-task-type <simple/complex/research>`、`task.py set-work-type`、`task.py validate` | `work_type` 已标记；`task_type` 在 start 前由 agent 判断/用户确认；planning review 通过 |
| start | 主会话 agent | `status=in_progress` | `task.py start` + 持久化 | `task.py verify` 通过，状态已持久化 |
| implement | implement 子代理 | 代码 + 复杂任务写 `implementation-report.md`；轻量任务返回结构化报告（不强制落盘） | 子代理报告；主会话按任务层级落盘 | 复杂任务报告覆盖改动；轻量任务有 commit/验收等证据 |
| check | check 子代理 | 修复 + 复杂后端写 `check-report.md`；复杂前端写 E2E/视觉证据或 check-report；轻量任务记录验证结果（不强制文件） | 子代理报告；主会话按任务层级落盘；前端证据 `set-evidence` | 复杂后端报告含验证命令/结果，或验收勾选；复杂前端 E2E/视觉 + owner 确认或 check-report；轻量任务至少一项证据 |
| commit | 主会话 agent | 代码提交、顶层 `commit`、可选 `pr_url`、前端证据 | `git commit` → `task.py set-commit` / `set-pr`；前端 `set-evidence` | `task.py verify` 通过 |
| finish / archive | 主会话 agent | 归档、`status=completed`、journal | `task.py verify --strict` → finish-work → archive | 按任务层级校验通过；无未记录证据 |
| resume / 异常 | 主会话 agent | 修复/恢复状态 | `task.py doctor` | 状态与最新证据一致 |

- 契约要明确“谁写、谁不写”，避免主会话与子代理同时改 `task.json`。
- 契约要覆盖纯规划/研究任务（不产生代码提交）的豁免方式，不能把“无 commit”一律判失败。
- **任务类型标签（`task_type`，创建时留空，由 agent 在实现前判断/询问用户后写入，标签是唯一判定依据）**：
  - 创建表单不要求用户选择复杂度；用户此时通常无法判断。agent 在 brainstorm/start 前根据需求范围提议 simple/complex/research，不确定时询问用户确认，再执行 `task.py set-task-type`。`start` 发现未设置时提示 agent 先分类；存量任务按 legacy 处理。
  - **simple**：不要求 `design.md`/`implement.md`；证据至少一项：顶层 commit、PRD 验收勾选、`implementation-report.md`、`check-report.md`、`status=completed`；报告一律可选。简单任务可以自愿生成 `design.md`/`implement.md`，仍按 simple 处理，**不降级、不升级、不报错**。
  - **complex**：**start 前必须同时存在 `design.md` 与 `implement.md`，缺一即阻断**；证据 = 顶层 commit **且**按 `work_type` 细分：backend 为（`check-report.md` 或至少一项 PRD 验收勾选，或 D7 的用户授权）；frontend 为（E2E/视觉证据 + owner 确认，或 `check-report.md`，或 D7 授权）；fullstack 两端都要。
  - **research**：纯方案/研究，不产生代码提交；只有 `prd.md`（可含 research）；`archive --planning-only` 豁免 commit/报告。
- **工作类型标签（`work_type`，创建时必填，与 `task_type` 正交）**：
  - 取值：`backend` / `frontend` / `fullstack` / `research` / `docs`。`task_type` 决定流程重量（simple/complex/research），`work_type` 决定证据类型；二者不可互相替代，也不能用 design/implement 的有无反推。
  - **frontend**：`simple` 为 commit + 至少一项证据：PRD 验收勾选、浏览器截图/预览、E2E 通过、owner 明确确认；`complex` 必须 commit +（E2E 结果或视觉证据 + owner 确认，或 `check-report.md`）；**只勾一个验收项不足以通过 complex 前端**。普通 UI 微调不强制 `check-report.md`；改共享组件/设计系统/路由/状态管理/可访问性/性能时，必须写结构化 check-report（或其中的前端验证段）。
  - **fullstack**：同时满足 backend 与 frontend 的证据要求；两端证据可分别绑定各自 commit，`meta.commits` 记录各仓库/各端提交。
  - **backend**：沿用现有矩阵；`complex` 为 commit +（check-report 或验收勾选，或 D7 授权）。
  - **research/docs**：不要求代码 commit；`research` 用 `archive --planning-only`，`docs` 至少一项 commit/验收/报告。
  - `check-report.md` 是证据容器，不是目的；前端可以把浏览器 E2E 输出、截图路径/预览 URL、owner 确认记录在 `meta.frontend_evidence` 或 check-report 的前端验证段，二者都算结构化证据。
  - 旧任务没有 `work_type` 记 `meta.legacy_work_type="unknown"`，只 warning，沿用原 `task_type` 矩阵，不迁移；新任务漏传 `work_type` 拒绝创建。
- 新任务在 `task.py create` 时必须显式传 `--task-type simple|complex|research` 与 `--work-type backend|frontend|fullstack|research|docs`；漏传应拒绝创建（或在交互式流程中强制询问，不能默认 simple/backend）。`task.py start` 再次校验两个标签；`task.py set-task-type`/`set-work-type` 只允许在 start 前修改；start 后修改必须 `--force` 且记录原因/事件，防止为了绕过 gate 临时降级。
- 标签与产物不一致时以标签为准：simple 有 design/implement 不改变类型；complex 缺 design/implement 不因“还没写”而放行。存量任务没有 `task_type` 时按 legacy 处理：沿用旧推断（有 design/implement 视为 complex），只 warning、不迁移；可用 `set-task-type` 补标签。
- （下文 `lightweight` 与 `simple` 同义，`planning-only` 与 `research` 同义；实现时统一用 `task_type` 的取值。）
- `implement.jsonl`/`check.jsonl` 是上下文 manifest，不是阶段报告，不作为任务类型判定依据。
- 简单任务没有 design/implement/报告是正常形态；`verify` 不得因此判失败，只要求与任务类型匹配的最小证据。complex 缺 design/implement 不是正常形态，start/verify 阻断。

### R2：把状态维护写进 workflow

更新 `.trellis/workflow.md`，让 agent 按流程执行时“不得不”维护任务文件：

- Phase 1 创建/规划：`task.py create` 必须显式带 `--task-type simple|complex|research`；complex 在进入 start 前补齐 `design.md` 与 `implement.md`；simple 可选生成，research 按纯规划处理。
- Phase 1.4：`task.py start` 前确认 `work_type` 已设置、`task_type` 已由 agent 判断/用户确认（未设置时提示先 `set-task-type`，存量任务按 legacy），再做 complex 产物校验；start 后增加状态持久化步骤；复杂任务默认启动 bookkeeping commit，简单任务默认写事件日志（也可 `--commit-state` 强制提交），随后运行 `task.py verify`；不允许只改工作区文件就进入实现。
- Phase 2.1：dispatch implement 子代理时，复杂任务要求产出 `implementation-report.md`；轻量任务只要求返回结构化报告（改动、验证命令/结果），不强制落盘；主会话按层级确认证据。
- Phase 2.2：dispatch check 子代理时按 `task_type + work_type` 要求证据：复杂后端要求 `check-report.md` 或勾选验收项；复杂前端要求 E2E/视觉证据 + owner 确认，或 `check-report.md`，只勾一个验收项不算；轻量任务只要求执行验证并在提交信息/PRD 中记录结果，不强制报告。
- Phase 3.3：spec 更新与任务证据一起纳入本次任务，不留下“以后补”的孤立文档。
- Phase 3.4：在现有分批提交步骤后增加第 8 步“记录提交”：对每个任务运行 `task.py set-commit <task> <hash>`（多个提交时记录最终/主提交），有 PR 时 `set-pr`；`work_type=frontend/fullstack` 时再运行 `set-evidence` 记录 E2E/截图 + 确认人；随后 `task.py verify`。提交计划中必须把 `task.json` 的状态/证据变更一起纳入，不能只提交代码。
- Phase 3.5：把 `/finish-work` 前置为 `task.py verify --strict`；校验失败先修复，不得直接归档。
- 更新 workflow 的 Phase Index / breadcrumb / 提醒文案，让 agent 在每个阶段都能看到“维护任务文件”的要求。
- 明确 `.trellis/tasks/` 的持久化策略：复杂任务在 start 时做 bookkeeping commit；轻量任务至少写事件日志并由 verify/doctor 兜底；不允许状态只存在于未提交工作区且无任何记录。

### R3：加强 skills，让 agent 有可执行步骤

- 新增 `trellis-task-state` skill：把 R1 的契约、每阶段命令、校验命令、常见失败处理写成 agent 可直接执行的 checklist；在 create/start/implement/check/commit/finish 边界调用；create 时只确定 `work_type`，`task_type` 在 brainstorm/start 前由 agent 判断、不确定时问用户，再 `set-task-type`；不允许把复杂度判断推给创建表单。
- 更新 `trellis-brainstorm`/`trellis-start` skill：在需求澄清阶段就询问或判定 simple/complex/research 与 backend/frontend/fullstack/research/docs，并解释类型与工作类型的证据差异；complex 未补齐 design/implement 不得进入 start。
- 更新 `trellis-check` skill：复杂后端任务在检查完成后写 `check-report.md`；复杂前端要求 E2E/视觉证据 + owner 确认或 check-report，不能只勾一个验收项；轻量任务记录验证结果（写在提交信息或 PRD 验收项即可），不强制报告；明确 check 子代理不写 `task.json` 的 status/commit，由主会话统一写。
- 更新 `trellis-finish-work` skill：归档前运行 `task.py verify --strict`；按 `task_type + work_type` 检查证据，轻量任务不因缺报告失败，复杂任务缺 commit/验收/check-report/前端证据时停止并给出修复命令；只有纯规划/研究任务允许显式 `--planning-only` 豁免。
- 更新 `trellis-continue` skill：恢复会话时运行 `task.py doctor`，检测状态回退、代码任务缺失 commit、复杂任务缺失验收/check-report、复杂前端缺失 E2E/视觉证据，并给出修复/恢复路径。
- 更新 `trellis-start` skill：复杂任务 start 后立即做 bookkeeping commit 并 verify；轻量任务至少写事件日志并 verify，避免“启动了但状态只在工作区”。
- 同步更新 `.claude/commands/trellis/*` 以及 `.codex`/其他平台的等价入口，避免只有 Claude 生效。
- skills 中的命令必须是真实可执行的 `task.py` 子命令，不能只写“记得更新 task.json”。

### R4：把职责写进 agent prompts

更新所有平台的 implement/check agent prompts：

- `.claude/agents/trellis-implement.md`、`.trellis/agents/implement.md`、`.codex/agents/trellis-implement.toml`（如存在）：
  - 复杂任务实现完成后写 `implementation-report.md`；轻量任务返回结构化报告（改动文件、关键决策、验证命令与结果），由主会话决定是否落盘；
  - 复杂任务的报告必须包含改动文件、关键决策、验证命令与结果；
  - 不修改 `task.json` 的 `status`/`commit`/`pr_url`；不执行 git commit/push/merge。
- `.claude/agents/trellis-check.md`、`.trellis/agents/check.md`、`.codex/agents/trellis-check.toml`（如存在）：
  - 复杂后端任务检查完成后写 `check-report.md`；复杂前端任务记录浏览器 E2E、截图/预览、响应式/可访问性检查与 owner 确认，或写 check-report；轻量任务记录验证结果（提交信息或 PRD 验收项），不强制文件；
  - 复杂任务的报告必须包含检查范围、发现的问题、修复项、lint/typecheck/test 结果；前端报告还要包含浏览器/E2E、截图或预览、响应式/可访问性检查结果；
  - 不修改 `task.json` 的 `status`/`commit`/`pr_url`；不执行 git commit/push/merge。
- 主会话 prompt/workflow：create 时负责写入并校验 `work_type`；在 brainstorm/start 前判断 `task_type`，不确定时询问用户并 `set-task-type`；代码提交后负责 `set-commit`/`set-pr`，finish 前负责 `verify`；任何阶段发现任务文件缺失，先修复再继续。
- 在 agent prompt 中写清“单一写入者”矩阵，避免子代理和主会话互相覆盖。

### R5：补齐 Trellis 脚本与模板能力（摘要）

- create 增加 `--task-type`/`--work-type`；set-task-type/set-work-type、set-commit、set-pr、set-evidence、verify、doctor、reset。
- start 增加 `--commit-state`/`--no-commit-state`/`--push`，失败 fail-closed，事件日志可恢复。
- archive 先 verify；research 用 `--planning-only`；set-meta 拒绝保留键。
- 详细算法、退出码、事件 schema、锁与故障语义见 `design.md` 与 `prd-details.md`。

### R6：把改进做成可分发、可升级的 Trellis 发行层

- 以 trellis-board 为规范源，维护版本化发行层 `trellis-kit`：脚本、agents、skills、commands、平台文件 + `manifest.json`（版本、校验和、目标平台）。自带 `overlay/`，不依赖 board 源码树。
- 看板项目初始化：kit 随客户端打包；full init 与 agent-only 都在 `trellis init` 后自动 apply，缺 kit 视为初始化失败。初始化只装模板/脚本，不改阶段推导、泳道或看板 API。
- 维护路径：**已选 Overlay**——保留上游 `@mindfoldhq/trellis@0.6.17` 做 init，发行层覆盖我们的 scripts/skills/prompts/模板；风险是上游 `trellis update` 覆盖，需要 manifest/校验和/冲突检测。
  - **Fork** 仅作为后续评估：若 overlay 无法覆盖 init/update 的内部行为，再 fork 上游（AGPL-3.0-only），需法务确认分发义务并建立发布/合并流程。本期不 fork、不把上游代码并入桌面安装包。
- 平台适配（硬要求）：一份源模板按平台能力生成入口，不能只覆盖 Claude/Codex。
  - 首批平台：claude、codex、opencode、pi、omp、antigravity、dsh；其他已由上游 `trellis init` 支持的平台走通用 fallback，未识别平台只生成 shared `.agents/skills` + 文档。
  - 每个 adapter 必须声明：`configRoot`、`capabilities`（skills/commands/agents/workflows/hooks/settings）、各能力的 `path`、文件格式（md/toml/json/yaml/ts）、`cmdRefPrefix`、是否支持 Python hooks、是否共享 `.agents/skills`、是否支持 subagent。
  - 复刻上游 `AI_TOOLS` 的能力语义（`supportsAgentSkills`、`hasHooks`、`hasPythonHooks`、`agentCapable`、`extraManagedPaths`），但由 `trellis-kit` 自己维护 registry，避免依赖上游内部文件；平台差异只影响 adapter，不影响脚本/skill 源文件。
  - `trellis-kit init --platform claude,codex,...` 是首次 init 的统一入口：先调用上游 `trellis init` 的对应 flag，再应用 kit overlay 和平台入口。
  - `trellis-kit init --agent-only --platform ...` 只安装 agent 平台资产（skills/commands/agents/workflows/hooks），不创建/改写 tasks、workspace、journal；若 `.trellis` 不存在，先安装最小核心脚本，但不创建任务。
  - 两种 init 必须共用同一 adapter/校验器；能力不支持的项写入 manifest 的 `skipped` 并给出原因，不创建空目录、不静默假装成功。
  - 多平台可同时安装；共享 `.agents/skills` 只写一份，平台专属 commands/agents 分别生成；重复执行幂等，冲突走 `--check/--force/--adopt`。
  - 看板侧同时收口：初始化项目对话框和 Agent-only 对话框只渲染上述 7 个平台；其余平台即使上游 SDK 支持也不展示、不可选；后端 `normalize_agent_tools` 拒绝非 7 个 ID；共享全量工具表只保留给“检测已有 Agent / 向后兼容”，不作为页面选项。
  - 测试矩阵至少覆盖 7 个首批平台的“目录/文件格式/hook 有无/subagent 有无/agent-only 模式”，并验证不创建平台不支持的目录。
- 存量任务不迁移：新字段可选，`verify` 对旧任务给 warning；只在新任务/试点仓库启用新流程。
- 选择 trellis-board 自身先试点，再升级 mdp-backend-service；给出所有接入仓库（trellis-board、mdp-backend-service、mdp-backend-web、mdp-management-web、mdp-report-service）的升级步骤与验收命令；不做静默批量改写。
- 记录 `trellis update` 覆盖风险、如何保留本地定制、升级后如何复核。

### R7：回归验证

- 在临时仓库/临时任务中跑完整 agent 流程：create → planning → start → implement → check → commit → set-commit → finish → archive；每一步断言 `task.json` 与证据符合契约，全程不手改 JSON。
- 分层流程回归：
  - complex 任务：design/implement + 报告/验收 + commit，完整流程通过；
  - simple 任务：只有 prd.md，不生成 design/implement/报告，有 commit 或验收勾选即通过；
  - simple 任务额外生成 design/implement：仍按 simple 通过，不被改判 complex、不报“多生成”错误；
  - research 任务：无 commit/报告，`--planning-only` 归档通过；
  - create 漏传 `--task-type` 被拒绝；存量任务无标签只 warning。
- 故障注入：
  - 模拟 stash drop / rebase 把 `status` 回退到 planning，确认 `task.py verify`/`doctor` 能发现并恢复或阻断；
  - 模拟提交后不写 commit，确认 `finish-work` 在归档前阻断；
  - 模拟纯规划任务无 commit，确认 `--planning-only` 豁免生效且不误报；
  - 模拟 complex 子代理未写报告，确认主会话会补齐/退回；模拟 lightweight 子代理未写报告，确认不误报；
  - 模拟 bookkeeping commit 失败（index.lock、hook 拒绝、rebase 中、任务目录被 ignore、identity/签名失败），确认 `start` 返回非零、不进入实现、`verify` 报 `state_not_persisted`、`doctor --fix` 可重试；
  - 模拟 `nothing to commit` 但 HEAD 已是 in_progress，确认幂等成功；
  - 模拟远端只改其他文件，本地 start commit 未 push，`pull --rebase` 后 commit 保留、不丢；
  - 模拟远端改同一 `task.json` 的不同字段，确认可 clean replay/auto-merge，状态仍为 in_progress；
  - 模拟远端把同一任务改为 completed/archived，确认 rebase 冲突后 `doctor --reconcile` 停止并询问，不复活；
  - 模拟两人同时 start 同一任务，确认第二个 start 警告/阻断，push 冲突不被静默覆盖。
- 用 R35860/R35862/R35868 的真实数据做样例：agent 执行 `set-commit` 后看板 `derived_stage` 自动进入 `check`，看板代码不需要改动。
- 为 `task_store.py` 的 set-commit/verify/doctor/archive 增加单测；为 workflow/skills 增加可执行的检查脚本或文档测试。

### R8：文档与规范

- 在 `.trellis/spec/` 增加“Trellis 文件由 agent 全程维护”的规范：阶段、写入者、命令、gate、异常恢复。
- 更新项目 README/使用文档：说明看板只读、任务文件由 agent 维护、常见缺口如何由 agent 修复。
- 输出一份“新仓库接入/升级 checklist”，作为后续仓库的验收依据。

### R9：面板与插件创建入口的任务类型

- 看板 `CreateTaskDialog` 增加必填“任务类型”下拉：后端/前端/全栈/研究/文档，值为 `work_type` 的五个枚举；未选择时阻止提交，不能静默默认 backend。
- 表单 payload 增加 `workType`；`useBoard` 原样透传；服务端 HTTP 路由/团队命令/Rust agent/task.py 全链路校验并写顶层 `work_type`；任何一层收到非法值都拒绝，不做容错降级。
- 看板 `CreateTaskDialog` 接受可选 `defaultWorkType`：插件上下文或 URL 参数提供合法值时默认选中；没有值或值非法时为空，不猜测。插件打开看板创建入口时应把当前任务/工作项的类型带过来。
- 插件任务服务 `ctx.tasks.create` 接受 `workType`；`toTaskDto` 返回顶层 `work_type`，插件页能读取当前任务类型。
- WitOps 创建入口：新增“任务类型”下拉，默认取当前工作项分类的映射；只映射“前端开发→frontend”“后端开发→backend”，其他分类留空；用户可在提交前改选；批量创建时若多个工作项映射不一致，不默认选任何一个。
- 面板、插件、CLI 三个入口写出的 `task.json` 顶层 `work_type` 必须一致；`task_type` 不在创建表单中出现，由 agent 在 brainstorm/start 前判断、不确定时询问用户，再 `set-task-type`。`meta.label_source` 至少能区分面板/插件用户选择与 agent 提议；创建时未分类的任务记 `meta.task_type_pending=true`。
- 不改看板阶段推导、泳道或任务状态机；任务类型只作为创建参数和证据判定输入。

## Acceptance Criteria

- [ ] Agent 能在不手改 `task.json` 的情况下完成一个任务的全流程；`commit` 在 finish 前自动写入，看板 `derived_stage` 进入 `check`。
- [ ] `finish-work`/`archive` 在按任务层级要求的证据缺失时阻断，并给出 agent 可执行的修复命令；纯规划任务有显式豁免。
- [ ] 状态回退（stash/rebase/手滑）能被 `task.py verify`/`doctor` 发现，并能恢复或阻断；不再依赖看板审计做唯一证据。
- [ ] complex 后端子代理产出 `implementation-report.md`/`check-report.md`（或验收勾选）；complex 前端产出 E2E/视觉证据 + owner 确认或 check-report；lightweight 任务不生成 design/implement/报告也能通过；主会话按单一写入者矩阵写 `task.json`。
- [ ] lightweight 任务只改代码并记录 commit、不写 design/implement/报告时，`verify`/`archive` 不误报；该场景有回归测试。
- [ ] bookkeeping commit 失败时 `start` 返回非零、状态不被静默留在工作区、workflow 停在 start gate；`doctor --fix` 能重试，且有故障注入测试。
- [ ] 本地 start commit 未 push 时，远端新增其他文件后 `pull --rebase` 不丢 in_progress；远端改同一 task.json 时冲突可见，`doctor --reconcile` 按规则保留/停止，不静默覆盖。
- [ ] 文档明确“未 push 状态团队不可见”和“同一任务并发无分布式锁”，并有对应的回归/演练记录。
- [ ] `set-meta` 不能写保留键；`set-commit`/`stamp-check`/`verify`/`doctor` 有单测；complex independent check-report 未 stamp 时阻断。
- [ ] 新任务 create 必须带 `work_type`；`task_type` 可空，由 agent 在 start 前判断/询问并 `set-task-type`；complex 缺 design/implement 在 start 前阻断；simple 多生成 design/implement 不降级、不报错。
- [ ] frontend simple 只改 UI 时，有 commit + 截图/预览/验收/owner 确认之一即可通过，不强制 check-report；frontend complex 只有 commit + 一个验收勾选时被阻断，补 E2E/视觉证据 + owner 确认或 check-report 后通过；fullstack 缺任一端证据被阻断；research/docs 不被前端证据规则误伤。
- [ ] 共享组件/设计系统/路由/状态/可访问性/性能敏感前端任务标记 `meta.frontend_check_report_required=true` 后，只有视觉证据/E2E 不通过，必须补 check-report 前端验证段；未标记任务不因缺 check-report 被误伤。
- [ ] complex 后端任务既无 check-report 也无验收勾选时，`verify` 中断并明确询问；complex 前端既无 `meta.frontend_evidence` 也无 check-report 时同样中断；用户授权后写 `meta.check_override` 才通过（绑定当前 commit；commit 变化后重新询问），非交互返回 exit 4。
- [ ] `verify --all --fix` 能自动修安全项（状态回退、`meta.commit` 迁移、可重建 bookkeeping commit），不安全项只报告并阻断。
- [ ] 发行层有 manifest/版本/校验和与自包含 overlay；看板 full init 和 agent-only 自动 apply，缺 kit 则失败；claude/codex/opencode/pi/omp/antigravity/dsh 七个平台按各自能力落文件，不创建不支持目录；存量任务不迁移。
- [ ] 首次 init 与 `--agent-only` 共用适配层；agent-only 不创建/改写 tasks/workspace/journal；不支持的能力在 manifest 标记 `skipped`，并有平台矩阵测试。
- [ ] 看板“初始化项目”和“Agent-only”对话框只显示 claude-code/codex/opencode/pi/omp/antigravity/dsh 七个平台；其他平台不可见、不可选；后端拒绝非七项 ID；共享全量列表仍能检测旧平台。
- [ ] 看板表单只要求 work_type；未选不能提交；不出现任务复杂度；work_type 落库一致。
- [ ] 面板/插件/CLI 三个入口对非法 `task_type`/`work_type` 都拒绝；插件任务 DTO 能返回 `taskType`/`workType`；WitOps 前端/后端分类能默认选中 `workType`，其他分类留空，批量混合类型不猜；`task_type` 一律由用户选择。
- [ ] `defaultWorkType` 有合法值时表单默认选中，无值/非法值保持空；不出现静默 backend 默认。
- [ ] workflow、skills、agent prompts 在 trellis-board 更新完成，并至少在一个其他接入仓库试点通过。
- [ ] 所有接入仓库有升级 checklist；`trellis update` 覆盖风险有说明。
- [ ] R35860/R35862/R35868 回归样例通过；看板前端/阶段推导代码不改。
- [ ] 文档与 spec 更新完成，明确“看板只读、agent 维护 Trellis 文件”。

## Non-goals

- 不新增看板交互、看板 API 或服务端写回通道来修复任务状态/commit；看板保持只读投影。
- 不把人工巡检/人工补数据作为常规机制；正常流程不手改 `task.json`。
- 不让看板从 git log 猜测任务与提交的对应关系。
- 不自动提交每一次 `task.json` 变化；只在 start/archive 等阶段边界做最小持久化，且复杂任务与轻量任务可采用不同策略。
- 不强制 simple 任务生成 `design.md`/`implement.md` 或阶段报告；报告只作为可选证据，不是所有任务的通用门槛。
- 不强制所有前端任务写 `check-report.md`；普通 UI 微调允许用浏览器截图/预览 + owner 确认作为结构化前端证据；只有复杂前端或共享 UI/可访问性/性能敏感改动才要求 check-report。
- 不因为 `work_type=frontend` 放宽 complex 的 commit/design/implement 要求，也不因为 `work_type=backend` 忽略前端视觉验收；fullstack 两端证据都不可缺。
- 不对存量任务自动推断或写回 `work_type`；没有标签的旧任务只 warning，按原矩阵处理。
- 不按 design/implement 的额外产物自动改判 `task_type`；simple 多产物不升级，complex 缺产物不放行；存量任务不强制补标签。
- 不把 `status=in_progress` 本身当作完成证据；轻量任务仍至少需要 commit、验收勾选或报告中的一项。
- 不在 bookkeeping commit 失败时静默降级或把状态回滚为 planning；失败必须可见，降级必须显式 `--no-commit-state`。
- 不在面板/插件创建时静默默认 `work_type=backend`；不在批量混合类型时猜测；不从 design/implement 有无反推 work_type。
- 不承诺未 push 的任务状态对团队实时可见；不实现分布式锁或服务端状态库。同一任务并发靠 assignee 约束、start 检测和冲突解决，不靠 git 文件本身加锁。
- 不修改阶段推导规则、泳道映射或 `STAGE_ORDER` 语义。
- 不实现 worktree 与源分支重复任务的合并/“源分支优先显示”；当前看板把 worktree 自动接入为独立 taskSpace，这是独立看板任务。
- 不迁移存量任务；新字段可选，旧任务只 warning，不批量改写。
- 不在 AGPL 合规评估完成前 fork/分发上游 Trellis。
- 不自动修不安全的证据/状态（`--fix` 只修可证明安全、可幂等的项）。
- 不直接向上游 Trellis 仓库发补丁；如需上游化，另开任务。
- 不为单个仓库打一次性补丁；所有改动进入模板/升级清单。

## Risks / Constraints（摘要）

完整风险与缓解见 `prd-details.md`；主要风险：Trellis 模板被 `trellis update` 覆盖、字段跨五层漂移、start commit 失败、旧任务不迁移、AGPL/fork 合规、看板投影误判。

## Open Questions（未定）

D1–D14 已收敛；以下是仍需拍板或设计阶段展开的问题：

- **check override 的边界**：owner 与 assignee 冲突时谁优先；是否需要对 override 做二次确认（当前默认 assignee 或 owner 均可，记录 `--by`）。
- **meta.commits 保留策略**：保留多少条、是否去重、是否记录解析后的完整 hash。
- **短 hash / HEAD**：是否允许 7–12 位短 hash 和 `HEAD`？如果允许，事件里是否记录解析后的完整 hash？
- **失败策略的例外**：fail-closed 下，`--no-verify` 是否永远只用于 bookkeeping commit？签名/identity 失败是否允许配置绕过？
- **人工 reset/reopen**：是否新增 `task.py reset --to planning --reason` / `reopen`；`doctor` 如何区分“有意回退”和“状态丢失”；`reopen` 是否本期做。
- **事件日志隐私/保留**：`.state-events.jsonl` 是否提交到仓库；session/actor/路径是否脱敏；归档后保留多久。
- **worktree 重复任务**：当前看板自动接入 worktree 为独立 taskSpace，没有“源分支优先/重复任务不更新”的实现；是否另开看板任务。
- **fork vs overlay**：已选 overlay；fork 仅作为后续评估（上游 0.6.17 为 AGPL-3.0-only，分发需法务确认），不再作为本期实现路径。
- **试点与推广顺序**：trellis-board 自身先跑通，还是直接选 mdp-backend-service；各仓库升级窗口。
- **批量修复边界**：`--fix` 只修状态/commit 等安全项，还是也修报告/验收？哪些必须人工确认。
- **前端视觉证据的确认人**：`meta.frontend_evidence.confirmedBy` 允许 assignee、owner 还是设计负责人？三者冲突时谁优先；是否需要二次确认。
- **前端证据的存储与脱敏**：截图/录屏/预览 URL 存在任务目录、仓库外还是对象存储；保留多久；是否包含用户数据、需要脱敏/裁剪。
- **E2E 工具与最小命令**：前端任务默认用 Playwright 还是现有测试栈；没有 E2E 的项目是否允许 owner 目测确认作为等价证据；`check-report.md` 前端段的最小字段是什么。
- **legacy `work_type` 边界**：旧任务缺 `work_type` 时是否按路径推断（只 warning、不写回），还是统一 `unknown` 走原矩阵；跨仓库任务如何判定 fullstack。
