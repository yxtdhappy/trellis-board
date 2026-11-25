# Agent 全程维护 Trellis 任务元数据：缺口与设计依据

## 1. 事故时间线（R35860/R35862/R35868）

- R35860：15:30:47 `task.py start` 把 `status` 改为 `in_progress`（顶层 `branch=dev`）；该改动一直未提交。20:22–20:25 处理 `git pull --rebase` 时，保存 in_progress 的 stash（984f899）在 pop 冲突后被 `git stash drop`，20:25:04 `task.json` 回退为 `planning`，看板 `derived_stage=review`（待放行）。
- R35862：从未执行 `task.py start`，`task.json` 始终 `planning`；代码提交 `afc4cd4` 存在，但看板不反推 git。
- R35868：13:41:15 `task.py start` → `in_progress`；14:34 提交 `f0125af`；顶层 `commit` 直到 23:03 才人工补写。
- 结论：三件事不是同一个操作失误，而是同一条流程没有“维护任务文件”的执行者、步骤和校验。

## 2. 为什么不在看板侧修

- 看板是只读投影：`.trellis/spec/guides/cross-layer-thinking-guide.md:60` 禁止前端 `setStage` 或 `PUT /api/tasks/stage`；看板已有证据提示（`packages/server/loader-stage.js:151-156`、`packages/server/execution-projection.js:162`、`ConditionChecks.tsx`、`FlowSignals.tsx`）。
- 问题跨所有接入仓库：在看板补一次只解决一个表面；其他仓库的 agent 仍然不会写 `commit`、不会在状态回退时恢复。
- 人工在看板上点一下，是把“agent 应自动维护”退化成“人定期巡检并补救”，与目标相反。
- 服务端写回会制造第二套状态来源，绕过 Trellis 的单一写入通道，掩盖 agent 没有按流程执行的事实。
- 看板可以保留为**只读验证器**：agent 写入后，看板自动反映；不新增修复交互。

## 3. 当前 agent 生命周期与写入者

| 阶段 | 当前谁做什么 | 任务文件谁写 | 缺口 |
|---|---|---|---|
| create/planning | 主会话建目录、写 prd/design/implement | 主会话 | 基本可用；缺少“证据契约” |
| start | 主会话 `task.py start` | `task.py` 改 status | 改动只在工作区，未持久化 |
| implement | implement 子代理写代码、返回报告 | 子代理不写 task.json | 复杂任务无 `implementation-report.md`；轻量任务无报告是正常形态，缺口是没有分层证据规则 |
| check | check 子代理检查/修复、返回报告 | 子代理不写 task.json | 复杂任务无 `check-report.md`；轻量任务无报告是正常形态，缺口是验收勾选/commit 未作为替代证据 |
| commit | 主会话分批 `git commit` | 主会话 | 提交后没有 `set-commit` 步骤 |
| finish/archive | 主会话 `task.py archive` | `task.py` 改 status | archive 不要求 commit；finish-work 不预检 |
| resume/异常 | 主会话凭记忆恢复 | 无 | 无 `doctor`，状态回退无法发现 |

## 4. 当前 workflow / skills / scripts / prompts 的具体缺口

### 4.1 workflow

- `.trellis/workflow.md:600-650` Phase 3.4 只有“检查脏文件 → 分组 → 提交”，没有“提交后写回任务状态”。
- Phase 3.5 只提醒 `/finish-work`，没有归档前的 `verify` gate。
- 工作流把 `.trellis/tasks/` 视为 bookkeeping 文件，但 `task.py start` 的 status 又是未提交工作区状态；没有定义“何时持久化”。
- Phase Index / breadcrumb 只提示阶段，不提示维护任务文件。

### 4.2 skills

- `trellis-check` skill：检查完只报告；复杂任务不要求写 `check-report.md`，轻量任务也没有“commit/验收即可”的替代证据规则。
- `trellis-finish-work` skill：`:8` 代码提交不在这里；`:32` 过滤 `.trellis/tasks/`；`:60-65` `--commit` 只写 journal；归档前不检查 task.json 的 commit/报告。
- `trellis-continue` skill：恢复会话时不校验任务状态，无法发现“文件被回退”。
- `trellis-start` skill：start 后不要求持久化/verify。
- 没有“任务状态维护”的专用 skill，agent 只能靠记忆或人工提示。

### 4.3 scripts

- `task.py` 没有 `set-commit`/`set-pr`/`verify`/`doctor`；`archive` 只有 `--no-commit`/`--skip-branch-validation`。
- `task_store.py:1351-1352` archive 只写 completed；`:1920-1924` `set-meta` 写 `meta[key]`，`meta.commit` 看板不读；`:545` 模板 `commit: None` 没有写入者。
- 没有事件记录/备份，状态被 stash drop 后无法从 Trellis 侧恢复。

### 4.4 agent prompts

- `.trellis/agents/implement.md:32`、`.claude/agents/trellis-implement.md:47` 禁止子代理 `git commit`（正确），但复杂任务没有要求它写 `implementation-report.md`；轻量任务应允许只返回报告。
- `.trellis/agents/check.md:34` 禁止子代理 commit，但复杂任务没有要求它写 `check-report.md`；轻量任务应允许只记录验证结果。
- 主会话 prompt 没有“提交后 set-commit / finish 前 verify”的职责。

### 4.5 分发

- 每个接入仓库都有自己的 `.trellis`、`.agents/skills`、`.claude/commands`、`.claude/agents` 副本；没有统一的升级清单，`trellis update` 可能覆盖本地改动。
- 只在 trellis-board 改，不会自动到达 mdp-backend-service 等仓库。

## 5. 设计原则

1. **Agent 全程维护**：任务文件是 agent 的工作产物，不是人填的表。
2. **单一写入者**：主会话写 `task.json` 的 status/commit/pr_url；implement/check 子代理只写各自报告（复杂任务落盘，轻量任务返回），避免并发覆盖。
3. **命令是唯一通道**：`task.py` 提供 set-commit/set-pr/verify/doctor；正常流程不手改 JSON。
4. **每阶段有 gate，但按任务分层**：start 后 verify；complex 任务 implement/check 后有报告或验收，lightweight 任务有 commit/验收等至少一项证据；commit 后 set-commit；finish 前 verify --strict。报告不是所有任务的通用门槛。
5. **状态可持久化/可恢复**：状态变更不能只存在于未提交工作区；至少要有 bookkeeping commit 或事件记录，`doctor` 能发现回退。
6. **看板只读**：看板不新增修复交互；它只是验证 agent 写入的结果。
7. **模板分发**：改动进入模板/升级清单，覆盖所有接入仓库。

### 5.1 任务分层与最小证据（避免简单任务误失败）
| 层级 | 判定 | 规划产物 | finish/archive 前的最小证据 | 报告 |
|---|---|---|---|---|
| planning-only | 纯规划/研究，无代码 | `prd.md`（可含 research） | `--planning-only`，无 commit 要求 | 不需要 |
| lightweight | 无 `design.md`/`implement.md` | `prd.md` | commit、验收勾选、implementation-report、check-report、completed 至少一项 | 可选 |
| complex | 有 `design.md` 或 `implement.md` | prd + design/implement | 顶层 commit 且（check-report 或至少一项验收勾选） | implementation-report 可选；check-report 或验收为必需 |

- 判定用现有产物推断，不新增必填字段；`implement.jsonl`/`check.jsonl` 是上下文 manifest，不是阶段报告，不作为 complex 依据。
- 简单任务没有 design/implement/报告是正常形态；`verify` 只要求与层级匹配的最小证据，不得因缺报告判失败。
- 该分层同时适用于 board 的 `hasImplementationEvidence`：commit、验收、报告、completed 任一即可；`verify` 对 lightweight 不应比 board 更严。

### 5.2 团队共享 task.json 的拉取/并发边界
- 场景：任务已以 planning 提交到远端；责任人本地 start 成 in_progress 但未 push；其他人提交其他文件；责任人 `git pull --rebase`。
- 当前（未提交 in_progress）：pull --rebase 会因 dirty worktree 拒绝；`--autostash` 会 stash → rebase → pop，同文件冲突时可能留在 stash；若 stash 被 drop，就回到 planning（860 的机制）。
- 新方案（start commit）：本地 commit 被 rebase 重放；远端不改同一 task.json → clean；改同一文件 → 冲突可见，不会静默丢。`doctor --reconcile` 以事件日志为准：本地 start + 远端 planning → 保留；远端 completed/archived → 停止询问；双方 start → owner 决策。
- 可见性：未 push 的 commit 团队看不到；要实时可见必须在 start 后 push，或引入共享状态服务。git 文件不是分布式锁；同一任务并发只能检测/阻断，不能阻止。
- 建议：complex 任务 start 后 push（或首个工作提交时 push）；同一任务只允许 assignee 推进；避免批量重写 task.json。

## 6. 状态持久化方案对比

| 方案 | 做法 | 优点 | 缺点 |
|---|---|---|---|
| A. start 后 bookkeeping commit | `task.py start` 后主会话只提交 `task.json`（`chore(task): start <name>`） | 状态立即进入 git，stash/rebase 不会丢；简单 | 每个任务多一个提交；需要用户接受自动提交 |
| B. 事件日志 | `task.py` 每次状态变更追加到 `.trellis/tasks/<task>/.state-events.jsonl` 或 `.trellis/.runtime/` | 不改提交历史；可审计 | 本地未跟踪文件可能丢失；新克隆无记录 |
| C. 随首个工作提交 | Phase 3.4 把 `task.json` 一起提交 | 不增加额外提交 | 从 start 到首个提交之间仍有风险窗口（860 正是如此） |
| D. verify/doctor 检测 | 定期/阶段边界比对事件记录与文件，发现回退 | 兜底 | 不能防止丢失，只能发现 |

建议：**按任务分层采用 A/B + D 兜底**。complex 任务 `start` 后立即 bookkeeping commit（A）；lightweight 任务默认写事件记录（B），需要跨会话时用 `--commit-state` 升级为 A；所有任务由 `verify`/`doctor` 兜底（D）。这样既保护 860 这类复杂任务，也不给简单任务增加提交噪音。

**提交失败语义**：`start --commit-state` 预检 git 状态（rebase/merge、ignore、identity）；只提交任务文件；失败时保留 task.json/事件、事件记 `state_commit_failed`、返回非零、workflow 停在 start gate，不自动回滚也不静默降级；只有显式 `--no-commit-state` 才进入事件日志降级；`doctor --fix` 重试。`--no-verify` 只用于跳过 bookkeeping commit 的钩子，签名/identity/index.lock 等仍按失败处理。

## 7. 建议的改动清单

### workflow

- Phase 1.4：start → 按层级持久化（complex bookkeeping commit / lightweight 事件日志）→ `task.py verify`。
- Phase 2.1：complex implement 报告落盘 + 主会话确认；lightweight 返回报告即可。
- Phase 2.2：complex check 报告或验收勾选 + 主会话确认；lightweight 记录验证结果即可。
- Phase 3.3：spec 更新纳入任务证据。
- Phase 3.4：第 8 步 `set-commit`/`set-pr` + verify；提交计划包含 task.json 状态/证据。
- Phase 3.5：`verify --strict` → finish-work。
- breadcrumb/Phase Index 增加“维护任务文件”提示。

### skills

- 新增 `trellis-task-state`：阶段契约 + 命令 + verify + 常见失败处理。
- `trellis-check`：complex 写 `check-report.md` 或勾选验收；lightweight 记录验证结果。
- `trellis-finish-work`：`verify --strict` 按层级预检；lightweight 不因缺报告阻断，complex 缺 commit/验收/check-report 阻断。
- `trellis-continue`：`doctor` 检测/恢复；报告检查只对 complex 严格。
- `trellis-start`：按层级持久化 + verify（complex 提交，lightweight 事件日志）。
- 同步 `.claude/commands/trellis/*` 与 `.codex` 入口。

### scripts

- `task.py set-commit`、`set-pr`、`verify`、`doctor`。
- `set-meta` 拒绝保留键。
- `archive` 要求与任务层级匹配的证据（lightweight 至少一项，complex 为 commit + check 证据），`--planning-only` 豁免。
- 事件记录/备份；单测；跨平台。

### agent prompts

- implement/check（Claude、Codex、channel）：complex 写报告，lightweight 返回报告/记录验证结果；都不写 task.json 的 status/commit。
- 主会话负责 set-commit/verify。
- 单一写入者矩阵。

### 分发

- 以 trellis-board 为规范源，输出各仓库升级 checklist。
- 试点：trellis-board 自身 → mdp-backend-service → 其余仓库。
- 记录 `trellis update` 覆盖风险。

## 8. 回归样例

- 正常流（complex）：临时任务 create → planning → design/implement → start → implement → check（报告/验收）→ commit → set-commit → finish → archive；每步断言 task.json/证据。
- 正常流（lightweight）：只有 prd.md → start（事件日志）→ 代码 commit → set-commit → finish → archive；无 design/implement/报告也通过，不误报。
- 故障注入：stash drop 把 status 回退 → `doctor` 发现/恢复；提交后不 set-commit → finish-work 阻断；纯规划任务 → `--planning-only` 豁免；complex 子代理不写报告 → 主会话补齐/退回；lightweight 子代理不写报告 → 不阻断；bookkeeping commit 失败（index.lock/hook/rebase/ignore/identity）→ `start` 非零、verify 报 `state_not_persisted`、doctor 重试；`nothing to commit` 且 HEAD 已 in_progress → 幂等成功。
- 真实数据：R35860/862/868 的 task.json 复制到临时目录，按新流程执行 set-commit/verify，确认看板 `derived_stage` 进入 `check`，看板代码不改。
- 单测：task_store 的 set-commit/verify/doctor/archive。

## 9. 非原因

weishanchong 的 16:56 归档提交 48 个文件全部是新增，全部在 `.trellis/tasks/archive/2026-11/` 的 DS 任务下；16:57 merge 对 R35860/R35862 任务目录 diff 为空。他只是改变了 20:22 rebase 的基底，没有改任务文件。
