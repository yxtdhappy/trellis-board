# Design 详细材料：verify、锁、面板/插件、平台、测试与文件清单

> 本文是 `design.md` 的附录；核心内容以 `design.md` 为准。

### 6.3 `verify` 检查项

| id | 条件 | 默认 | `--strict` | `--fix` |
|---|---|---|---|---|
| `task_json` | JSON 可解析、必填字段存在 | fail | fail | 不自动重建 |
| `task_type` | 缺失/非法 | legacy warning / fail | fail | 只推断，不写顶层 |
| `complex_artifacts` | complex 缺 design/implement | fail | fail | 不自动生成 |
| `status_persisted` | 工作区 in_progress，HEAD 不是 | complex fail；simple/research 有 `start_intent` 则 warning，无事件则 fail | complex fail | 可重建 bookkeeping commit |
| `status_regression` | HEAD in_progress，工作区 planning，无 `status_reset` | fail | fail | 从 HEAD 恢复 |
| `commit_required` | complex 缺顶层 commit | fail | fail | 不自动 |
| `commit_object` | hash 对象不存在 | warning | fail | 不自动 |
| `commit_reachable` | 对象存在但不在当前分支 | warning | fail | 不自动 |
| `check_evidence` | complex 无 check-report/验收（backend）；complex 无 check-report 且无有效前端证据（frontend）；fullstack 任一端缺失 | decision (exit 4) | decision | 授权写 override |
| `frontend_evidence` | `work_type=frontend/fullstack`：`meta.frontend_evidence` 缺失、commit 不匹配、type=manual 用于 complex、或 visual/e2e 无确认/artifact；`meta.frontend_check_report_required=true` 但无 check-report | fail（complex）；warning（simple） | fail | 不自动生成，提示 `set-evidence`/`check-report` |
| `check_override` | override.commit ≠ task.commit 或授权人非法 | warning | fail | 清除失效 override |
| `check_binding` | complex independent check-report 未绑定；`meta.check_binding.commit` ≠ task.commit；报告哈希变化；绑定 scope 的 commit tree 与 stamp 不一致 | fail | fail | 重新 `stamp-check`/`set-commit` |
| `meta_commit_trap` | `meta.commit` 有值但顶层 `commit` 为空 | fail | fail | 迁移到顶层 |
| `uncommitted_task_json` | task.json 有未提交修改 | warning | fail | 不自动提交 |
| `event_log` | JSONL 损坏/最后意图冲突 | warning | fail | 只报告 |

**Check 树绑定（方案 B）**：check 阶段不要求 commit hash。`stamp-check` 在 check 完成后记录 `base` + `scope` + `diff`（临时 index 对 worktree 的 scoped 指纹）；工作提交后 `set-commit` 用 `git ls-tree` 对 `base..HEAD` 同一 scope 计算指纹，与 `diff` 不一致时拒绝写 commit。绑定写入 `meta.check_binding`，`verify` 还校验 check-report 文件哈希，防止绑定后改报告。只对 complex independent 强制；simple/inline 不强制。

`needs_user_decision` 的交互流程：

```text
$ task.py verify <task>
[decision] complex 任务没有 check-report，也没有验收勾选。
是否授权无产物通过 check？(y/N)
$ task.py verify <task> --authorize-no-evidence --by yuhaojie --reason "口头确认已验证"
→ 写 meta.check_override {authorizedBy, reason, at, commit}
→ 重新 verify，同一 commit 通过
```

非交互环境没有 `--authorize-no-evidence` 时 exit 4，不自动通过。

### 6.6 锁、原子写与 git 安全

- 锁：`.trellis/.runtime/locks/<task-id>.lock`，`os.open(O_CREAT|O_EXCL)` 写入 pid/时间；超过 10 分钟视为 stale，允许 `doctor --fix --force-lock`。Windows 用 `msvcrt.locking`，POSIX 用 `fcntl`，不引入新依赖。
- 原子写：同目录临时文件 + `os.replace`；保留 2 空格 JSON 缩进和末尾换行，避免无意义 diff。
- stage 白名单：只允许 `task.json`、`.state-events.jsonl`、当前任务目录内的报告；禁止 `git add -A`/`.trellis` 全目录。
- 提交前用 `git diff --cached --name-only` 断言只有白名单路径；否则拒绝提交。
- 禁止在 rebase/merge/cherry-pick 中写状态；预检失败直接返回，不产生半状态。
- 不自动 `git checkout --`、不自动 `reset --hard`、不自动 drop stash。


### 7.3 面板/插件创建入口

创建入口只负责采集用户能判断的“任务类型（`work_type`）”，不询问 `task_type`；`task_type` 由 agent 在后续 planning 中根据实际范围判断并 `set-task-type`。所有入口最终调用 `task.py create --work-type`，由 `task_store.py` 写顶层 `work_type`；缺 `task_type` 时记 `meta.task_type_pending=true`。插件只从前端/后端分类映射 `work_type`，不映射 `task_type`。

| 入口 | 默认值 | 提交路径 |
|---|---|---|
| 看板 `CreateTaskDialog` | `defaultWorkType`（URL/插件上下文）；无合法值则为空并必选 | `onCreate({workType})` → `useBoard` → `POST /api/tasks` → `taskCommands.enqueue` → Rust `create_task` → `task.py create --work-type` |
| 插件 `ctx.tasks.create` | 调用方传入可选 `workType`；无值则空 | `task-service.create` → `actions.createTask` → `task.py create --work-type` |
| WitOps 创建对话框 | 当前工作项分类映射：前端开发→frontend、后端开发→backend；其他分类空 | `witops.dispatch.task.create`/`dispatchItems` → `dispatch.createOne` → `ctx.tasks.create({workType})` |

规则：

- 看板/插件表单的 `workType` 为空时禁止提交；非法值在客户端、`actions.createTask`、`task-command-service.enqueue`、Rust `create_task`、`task.py` 五层都拒绝，错误信息包含合法枚举。
- `defaultWorkType` 只接受 `WORK_TYPE_IDS`；非法值按空处理并提示，不回落 backend。
- `taskType` 在创建链路中可选：actions/team/Rust 仅在提供时校验并追加 `--task-type`；不提供时 `task_store` 写 `task_type: null` + `meta.task_type_pending=true`，由 agent 后续 `task.py set-task-type` 清除 pending。
- 插件 DTO `toTaskDto` 返回 `workType: task.work_type ?? null` 与 `taskType: task.task_type ?? null`；插件页读取当前任务类型时不再从 `meta` 猜。
- WitOps 批量创建：所有待创建工作项映射到同一 `work_type` 才默认选中；混合或无法映射时为空，用户在对话框中必须选择。
- 面板创建的任务 `meta.label_source=user-explicit`；插件映射默认值也视为用户可见选择，若用户未改选仍记 `user-explicit`，并在 `meta.label_default_from=witops-category` 记录来源。
- 本任务只新增字段和入口，不改看板阶段推导、泳道、状态机或任务 DTO 的既有字段语义。

实现文件：

| 文件 | 改动 |
|---|---|
| `packages/shared/task-types.js` / `.d.ts`（新） | `simple|complex|research` 枚举、标签、`isTaskType`/`taskTypeLabel`；web/server 共用，创建入口不展示 |
| `packages/shared/work-types.js` / `.d.ts`（新） | `backend|frontend|fullstack|research|docs` 枚举、标签、`isWorkType`/`workTypeLabel`；web/server 共用 |
| `packages/web/src/features/board/dialogs/CreateTaskDialog.tsx` | 任务类型（work_type）必填下拉、`defaultWorkType`、payload、空值校验；不出现任务复杂度 |
| `packages/web/src/pages/board/BoardPage.tsx` | 从插件上下文/URL 读取合法 `defaultWorkType` 并传给对话框 |
| `packages/web/src/hooks/useBoard.ts` | 透传 `workType`（`taskType` 可选） |
| `packages/server/actions.js` | 必填校验 `workType`；`taskType` 可选校验，条件追加 `--work-type`/`--task-type` |
| `packages/server/team/task-command-service.js` | `create_task` 校验并写入 payload；`taskType` 可选 |
| `packages/server/team/http/routes/tasks.js` | 透传 `taskType`/`workType`（无需单独校验，enqueue 统一校验） |
| `packages/desktop/src-tauri/src/agent/task_command.rs` | 读取/校验 `workType`、条件追加 `--work-type`；`taskType` 可选 |
| `.trellis/scripts/task.py` / `common/task_store.py` | `--work-type` 必填、`--task-type` 可选、枚举校验、顶层字段与 `task_type_pending` |
| `packages/server/plugins/task-service.js` | `create` 透传 `taskType`/`workType`，`toTaskDto` 返回二者 |
| `plugins/witops-core/dispatch.js` / `index.js` | 分类映射、`task.create` 参数、`ctx.tasks.create({workType,taskType?})` |
| `plugins/witops-core/panel/index.html` / `app.js` | 创建对话框新增任务类型（work_type）下拉、默认值、提交参数；不出现任务复杂度 |
| `plugins/witops-core/mapper.js` | `workTypeFromCategory()` 纯函数 |


### 8.4 平台适配契约（首次 init 与 agent-only 共用）

`platforms/registry.json` 每个平台至少声明：

```json
{
  "id": "codex",
  "aliases": ["codex"],
  "configRoot": ".codex",
  "capabilities": {
    "skills": true, "commands": false, "agents": true,
    "workflows": false, "hooks": true, "settings": true
  },
  "paths": {
    "sharedSkills": ".agents/skills",
    "skills": ".codex/skills",
    "agents": ".codex/agents",
    "hooks": ".codex/hooks",
    "settings": ".codex/config.toml"
  },
  "formats": {"agents": "toml", "hooks": "python+json", "settings": "toml"},
  "cmdRefPrefix": "$",
  "supportsPythonHooks": true,
  "agentOnlySupported": true
}
```

首批平台的差异（路径以 0.6.17 实际 configurator 为准）：

| 平台 | 根 | skills | commands | agents | hooks | settings |
|---|---|---|---|---|---|---|
| claude-code | `.claude` | `.claude/skills` | `.claude/commands/trellis/*.md` | `.claude/agents/*.md` | `.claude/hooks/*` | `.claude/settings.json` |
| codex | `.codex` | `.agents/skills`（共享） | —（skill 入口 `$`） | `.codex/agents/*.toml` | `.codex/hooks/*` + `.codex/hooks.json` | `.codex/config.toml` |
| opencode | `.opencode` | `.opencode/skills` | `.opencode/commands/trellis/*.md` | — | — | — |
| pi | `.pi` | `.agents/skills`（共享） | `.pi/prompts/trellis-*.md` | `.pi/agents/*.md` | `.pi/extensions/trellis/index.ts`（extension hooks） | `.pi/settings.json`（adapter 声明） |
| omp | `.omp` | `.omp/skills` | `.omp/commands/trellis-*.md` | `.omp/agents/*.md` | `.omp/extensions/trellis/index.ts` | — |
| antigravity | `.agent` | `.agent/skills` | `.agent/workflows/*.md` | — | — | — |
| dsh | `.dsh` | `.agents/skills` + `.dsh/skills` | —（commands-as-skills） | — | — | `.dsh/DSH.md`（operator guide） |

规则：

1. **能力驱动**：adapter 只生成 `capabilities` 为 true 的资产；为 false 的项写入 manifest 的 `skipped[]`（含平台、能力、原因），不创建空目录，不报“安装成功”。
2. **共享 skills 只写一份**：codex/pi/dsh 使用 `.agents/skills`；同一 skill 不重复写到平台私有目录，避免 Trellis #447 的重复/冲突 skill。
3. **无 hooks 的平台**：claude/codex/pi/omp 有 hooks 或 extension hooks；opencode/antigravity/dsh 没有项目级 hook，`start` 必须保留为 command/skill/workflow 入口，不能假设 hook 会注入。
4. **无 subagent 的平台**：opencode/antigravity/dsh 不生成 agents 目录；implement/check 由主会话或等价命令完成，prompt 不引用不存在的 subagent。
5. **格式差异**：md/toml/json/yaml/ts 由 adapter 渲染；settings 只做保守 merge（保留未知键），没有 settings 文件的平台（omp）不创建。
6. **检测**：优先读 `.trellis/.template-hashes.json` 的 Trellis-owned 模板 hash 和显式 `--platform`，不因目录存在就自动启用；目录存在但未托管时提示 `--adopt`。
7. **多平台**：一次 init 可安装多个平台；共享文件只写一次，平台专属文件分别写；`manifest.files[]` 记录 `platform` 和 sha，`.kit-state.json` 按平台记录。
8. **首次 init**：`trellis-kit init --platform ...` 先调用上游 `trellis init` 的对应 flag，再 apply overlay/adapters；失败时保留上游已生成文件并报告，不假装整体成功。
9. **agent-only**：`trellis-kit init --agent-only --platform ...` 只安装平台资产（skills/commands/agents/workflows/hooks/settings），不创建/改写 `.trellis/tasks`、workspace、journal；`.trellis` 不存在时只安装最小核心脚本，不创建任务。两种 init 共用同一 adapter/validator。
10. **验证**：`trellis-kit doctor --platforms` 输出每个平台的 `supported/skipped/unsupported`；测试矩阵覆盖 7 个首批平台的目录、格式、hook/subagent 有无、agent-only、重复执行幂等、不创建不支持目录。
11. **看板 UI 收口**：`packages/shared/trellis-agent-tools.js` 保留全量 `TRELLIS_AGENT_TOOLS` 用于检测/向后兼容，新增 `TRELLIS_SUPPORTED_AGENT_TOOL_IDS` + `TRELLIS_VISIBLE_AGENT_TOOLS`（固定 7 个）；`AgentToolSelector`、`ProjectOnboardingDialog`、`AgentQuickInitDialog` 只使用 visible 列表；Rust `normalize_agent_tools` 对非 7 个 ID 返回 `COMMAND_INVALID`。其他平台不渲染、不可选，已有项目里的旧平台痕迹仍可被检测但不展示。


### 9.2 集成测试（临时 git 仓库）

1. complex 全流程：create → design/implement → start（bookkeeping commit）→ set-commit → verify → archive；断言 task.json、事件、git log。
2. simple 无 design/implement/报告：commit 后 verify/archive 通过；额外生成 design/implement 仍通过，不改 task_type。
2.1. simple frontend：commit + 截图/预览 + owner 确认，无 check-report 通过；只有 commit 无视觉证据时按 simple 最低证据仍可通过（与当前矩阵一致）。
2.2. complex frontend：commit + 只勾一个验收项 → verify 阻断；补 `set-evidence --type visual --artifact ... --confirmed-by ...` 或 check-report 后通过；`type=manual` 不足以通过 complex。
2.3. fullstack：只满足后端或只满足前端证据 → 阻断；两端都满足才通过。
2.4. 新任务 create 漏 `--work-type` 被拒；存量任务无 `work_type` 只 warning，按旧矩阵通过。
2.5. `set-work-type --check-report-required` 后，complex frontend 只有 visual/e2e 证据没有 check-report → 阻断；simple frontend 只 warning。
2.6. 看板创建：未选任务类型（work_type）→ 表单阻止；表单不出现任务复杂度；选 frontend → task.json 顶层 `work_type=frontend`，`task_type` 为空且 `meta.task_type_pending=true`；`defaultWorkType` 合法时默认选中；传入非法值 → 空且提示；不出现静默 backend。
2.7. 插件创建：`ctx.tasks.create({workType:'frontend'})` → task.json 与 DTO 的 `work_type=frontend`、`task_type` 为空/待分类；WitOps 前端开发默认 frontend、后端开发默认 backend、其他分类为空；批量混合分类 → 对话框不默认选 `workType`；非法值被 actions/enqueue/Rust/task.py 任一层拒绝。
3. research：无 commit，`archive --planning-only` 通过；非 research 传 `--planning-only` 被拒。
4. create 漏 `--task-type` 被拒；legacy 任务只 warning。
5. 故障注入：stash drop / rebase 回退、index.lock、hook 拒绝、rebase 中、任务目录被 ignore、identity/签名失败、nothing-to-commit 幂等；断言 exit code、状态不丢、doctor 可修。
6. 拉取：远端只改其他文件、同文件不同字段、远端 completed、双方 start；断言 start commit 保留/冲突可见/reconcile 不复活。
7. commit 对象：短 hash、HEAD、不存在、存在但不可达；`--allow-missing-object` 的 warning/strict。
8. overlay：apply 幂等、冲突检测、`--dry-run`、版本不匹配、`.kit-state.json`。


### 9.3 回归

- 用 R35860/R35862/R35868 的真实任务数据跑 verify/set-commit/archive；看板 `derived_stage` 进入 `check`，看板代码不改。
- 在 trellis-board 先试点，再在 mdp-backend-service 试点；记录升级 checklist。


## 12. 影响文件

```text
.trellis/scripts/task.py
.trellis/scripts/common/task_store.py
.trellis/scripts/common/safe_commit.py
packages/shared/work-types.js                    (new)
packages/shared/work-types.d.ts                  (new)
packages/web/src/features/board/dialogs/CreateTaskDialog.tsx
packages/web/src/pages/board/BoardPage.tsx
packages/web/src/hooks/useBoard.ts
packages/server/actions.js
packages/server/team/task-command-service.js
packages/server/team/http/routes/tasks.js
packages/desktop/src-tauri/src/agent/task_command.rs
packages/server/plugins/task-service.js
plugins/witops-core/dispatch.js
plugins/witops-core/index.js
plugins/witops-core/mapper.js
plugins/witops-core/panel/index.html
plugins/witops-core/panel/app.js
.trellis/scripts/common/state_events.py        (new)
.trellis/scripts/common/task_lock.py           (new)
.trellis/scripts/common/verify.py              (new)
.trellis/scripts/common/doctor.py              (new)
.trellis/workflow.md
.trellis/spec/guides/task-state-contract.md    (new)
.trellis/spec/guides/index.md
.agents/skills/trellis-task-state/SKILL.md     (new)
.agents/skills/trellis-brainstorm/SKILL.md
.agents/skills/trellis-start/SKILL.md
.agents/skills/trellis-check/SKILL.md
.agents/skills/trellis-finish-work/SKILL.md
.agents/skills/trellis-continue/SKILL.md
.claude/skills/*                               (按 .agents 镜像同步)
.claude/commands/trellis/continue.md
.claude/commands/trellis/finish-work.md
.claude/agents/trellis-implement.md
.claude/agents/trellis-check.md
.trellis/agents/implement.md
.trellis/agents/check.md
.codex/agents/trellis-implement.toml
.codex/agents/trellis-check.toml
trellis-kit/manifest.json                      (new)
trellis-kit/platforms/registry.json            (new)
trellis-kit/apply.py                           (new)
trellis-kit/overlay/...                        (new)
trellis-kit/adapters/{claude-code,codex,opencode,pi,omp,antigravity,dsh,generic}/... (new)
trellis-kit/tests/platforms/...                (new)
tests/trellis/...                              (new)
packages/shared/trellis-agent-tools.js
packages/shared/trellis-agent-tools.d.ts
packages/shared/test/trellis-agent-tools.test.js
packages/web/src/features/board/dialogs/AgentToolSelector.tsx
packages/web/src/features/board/dialogs/ProjectOnboardingDialog.tsx
packages/web/src/features/board/dialogs/AgentQuickInitDialog.tsx
packages/desktop/src-tauri/src/agent/trellis_cli.rs
packages/desktop/src-tauri/src/agent/onboarding.rs
packages/desktop/src-tauri/src/agent/onboarding/tests.rs
```

不修改：`packages/web/*`、`packages/server/*`、`packages/desktop/*` 的阶段推导/泳道/看板 API；仅初始化/Agent-only 的平台选项按 7 个平台收口（发行层 init 接入除外）。
