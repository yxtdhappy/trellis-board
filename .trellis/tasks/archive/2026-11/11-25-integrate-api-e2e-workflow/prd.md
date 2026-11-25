# 将 trellis-api-e2e 内置为 Trellis 自带技能并接入后端任务流程

## Goal

把用户级 `wit-api-e2e` 固化为 Trellis 内置技能 `trellis-api-e2e`，由 trellis-kit 随项目初始化分发；并让后端代码任务在编码和代码级验证完成后跑一轮接口级 E2E，产出 `api-e2e-report.md`。保持宽松：不新增项目类型字段，不改 `task.py verify` 的硬门禁，不增加新状态机。

## Background

- `11-23-trellis-workflow-evidence-loop` 已把 Trellis 流程改造成 `task_type`（simple/complex/research）+ `work_type`（backend/frontend/fullstack/research/docs）的模型；backend complex 的证据要求目前是 `check-report.md` 或验收勾选，没有接口 E2E。
- 用户级 `wit-api-e2e` 已是一个完整技能（14 个文件：SKILL、4 个 references、6 个 scripts、3 个 self-test），但只存在于用户级 skills，项目初始化不会安装。
- `trellis-kit` 是项目初始化的分发层：桌面端在 `trellis init` 后自动应用 `.trellis/workflow.md`、技能和脚本。当前 `apply.py` 只按组件做单文件复制，且平台循环只复制 `SKILL.md`，多文件技能会被截断。
- `.trellis/workflow.md` 的 Phase 2 目前只有 Implement / Quality check / Rollback；`[workflow-state:in_progress]` 也没有接口 E2E 提示。
- 用户已明确采用宽松方案：初始化自带技能，流程中要求后端代码任务跑一轮并生成报告；不做项目类型推断，不新增复杂判断。

## Requirements

### R1. trellis-kit 安装完整技能

> “Trellis 自带技能”在本任务中定义为：技能源进入仓库 `.agents/skills/trellis-api-e2e/`，并由 trellis-kit 随每个项目初始化安装到对应平台 skills 目录；不修改上游 `@mindfoldhq/trellis` npm 包。

- 在仓库 `.agents/skills/trellis-api-e2e/` 增加技能源（从已加固的用户级 `wit-api-e2e` 复制并重命名，14 个文件），作为 kit 的单一来源。
- `trellis-kit/manifest.json` 增加一个目录型技能组件（`kind: "skill"`，`directory: true`，source/target 均为 `.agents/skills/trellis-api-e2e`）。
- `apply.py` 支持整目录复制：
  - 组件循环遇到 `directory: true` 时复制目录内所有文件，而不是只复制 `SKILL.md`。
  - `--agent-only` 允许 `kind: "skill"`。
  - 选择平台时，目录技能复制到每个非共享平台的 skills 根目录；共享 `.agents/skills` 的平台不重复复制。
  - 目标根目录必须读取 `trellis-kit/platforms/registry.json` 的 `paths.skills`，不能硬编码 `.claude`。
  - 七平台目标：`claude-code` → `.claude/skills`；`opencode` → `.opencode/skills`；`omp` → `.omp/skills`；`antigravity` → `.agent/skills`；`codex`/`pi`/`dsh` → 共享 `.agents/skills`，不重复复制。
  - 未选择的平台不创建目录；平台缺少 `paths.skills` 时记录并跳过，不回退 `.claude`。
  - 保留现有 `--dry-run`、`--force`、冲突检测和“从不删除”语义。
- `build_overlay.py` 支持目录型组件，把 `.agents/skills/trellis-api-e2e/` 整体同步到 `trellis-kit/overlay/.agents/skills/trellis-api-e2e/`。

### R2. 新项目初始化即包含流程要求

- `trellis-kit/overlay/.trellis/workflow.md` 与仓库 `.trellis/workflow.md` 同步包含 R3 的流程要求。
- 新项目 `trellis init` 后，kit 自动安装 `trellis-api-e2e`，无需用户再手动复制技能。
- 已有项目可以运行 `python trellis-kit/apply.py --target <repo> --force --platform <id>` 补装；文档说明这一点。

### R3. 后端代码任务的软性 API E2E 步骤

- 在 `.trellis/workflow.md` Phase 2.2 下增加子项：后端代码任务（`work_type=backend`；`fullstack` 中改到后端接口的部分同理）在编码和代码级验证完成后、提交前，跑一轮本机 `trellis-api-e2e`，并在任务根生成 `{TASK_DIR}/api-e2e-report.md`。
- 在 `[workflow-state:planning]` 和 `[workflow-state:in_progress]` 增加一行提示，保证每个回合都能看到；措辞明确这是流程要求，不是 `task.py verify` 的失败项。
- 不新增 `project_type`、`api_e2e_required` 或任何 task.json 字段；没有后端接口改动时，在报告中记录“不适用”及原因即可，不阻塞任务。
- 不自动执行 E2E 脚本，不访问真实后端/真实 token；由 agent 按 `trellis-api-e2e` 的规则在本机执行。

### R4. 质量检查和收尾提醒

- `trellis-check` 的检查清单增加一条：后端代码任务是否已跑 `trellis-api-e2e` 并生成 `api-e2e-report.md`；不适用时是否记录原因。
- `trellis-finish-work` 的证据门禁步骤增加提示：后端代码任务缺少报告时提示用户，但不作为 `task.py verify` 的硬失败。
- 同步仓库 `.agents`、仓库 `.claude`（存在时）与 kit overlay 中的对应文件，避免初始化后提醒缺失。

### R5. 文档与验证

- `trellis-kit/README.md` 说明目录型技能、安装内容和已有项目补装命令。
- 验证覆盖：
  - `apply.py --agent-only --dry-run` 和真实复制后，`.agents/skills/trellis-api-e2e/` 都有 14 个文件。
  - `--platform claude-code` 时 `.claude/skills/trellis-api-e2e/` 也有 14 个文件。
  - `build_overlay.py` 后 overlay 中技能目录完整，且不包含用户主目录路径。
  - `workflow.md`、`trellis-check`、`trellis-finish-work` 的文案检查通过。
  - `task.py verify` / `task.py validate` 代码路径没有改动。

## Acceptance Criteria

- [ ] `trellis-kit/manifest.json` 含 `trellis-api-e2e` 目录组件；`apply.py` 与 `build_overlay.py` 能处理目录组件，`--dry-run` 不写文件、`--force` 能覆盖冲突。
- [ ] `.agents/skills/trellis-api-e2e/SKILL.md` 的 `name` 为 `trellis-api-e2e`，技能目录内无 `wit-api-e2e` 残留引用；脚本文件名保持 `api-e2e-*`。
- [ ] 临时目标目录执行 `apply.py --agent-only` 后，`.agents/skills/trellis-api-e2e/` 文件数与源一致（14），包含 `scripts/self-test/run.sh`、`run.ps1`、`mock-server.mjs`。
- [ ] 临时目标目录执行 `apply.py --platform claude-code` 后，`.claude/skills/trellis-api-e2e/` 文件数与源一致；`opencode`/`omp`/`antigravity` 分别落到 `.opencode/skills`、`.omp/skills`、`.agent/skills`；`codex`/`pi`/`dsh` 只落共享 `.agents/skills`，平台目录不重复；未选择平台不创建目录。
- [ ] `trellis-kit/overlay/.agents/skills/trellis-api-e2e/` 由 `build_overlay.py` 生成，内容与源一致；`trellis-kit/overlay/.trellis/workflow.md` 含 R3 文案。
- [ ] `.trellis/workflow.md` 的 Phase 2 与两个 `workflow-state` 块含 R3 文案；`trellis-check`、`trellis-finish-work` 含 R4 文案。
- [ ] `git diff` 不包含 `task.py` / `task_store.py` 的验证逻辑修改；本任务不运行真实 API E2E（工具链任务，无服务端接口改动）。
- [ ] `python ./.trellis/scripts/task.py validate 11-25-integrate-api-e2e-workflow` 通过；`implement.jsonl`/`check.jsonl` 均为合法 JSON 行。

## Non-goals

- 不新增项目类型（`project_type`）或自动推断项目是否为后端项目。
- 不修改 `task.py verify`、`task_store.py` 的证据门禁，不新增 task.json 字段或状态。
- 不把 API E2E 变成必须通过才能提交/归档的硬门禁。
- 不改 `trellis-api-e2e` 的库、代理、自测逻辑；只做分发和流程接入。
- 不做 UI E2E 整合、不做 Playwright/Selenium 引入、不访问真实后端或使用真实 token。
- 不重构 trellis-kit 的其他组件，不升级无关技能。

## Risks / Constraints

- **多文件技能分发**：`apply.py` 当前只复制 `SKILL.md`，直接加 manifest 会导致脚本丢失；必须同时改 `apply.py` 和 `build_overlay.py`，否则新项目拿到的是空壳技能。
- **平台差异**：不同平台 skills 根目录和 `sharedSkills` 不同；目录复制要复用现有 `platforms/registry.json`，不能硬编码 `.claude`。
- **overlay 双份同步**：`build_overlay.py` 目前只同步 source 路径，不会自动更新 overlay 的 `.claude` 平台副本；R4 涉及的 overlay `.claude` 文件需要显式同步并在实现记录中说明。
- **报告主观性**：`api-e2e-report.md` 不进入 `task.py verify`，依赖 agent 和人工检查；本任务接受这一点，用 workflow + check/finish 提醒降低漏跑。
- **技能源漂移**：仓库内 `.agents/skills/trellis-api-e2e` 成为 kit 的单一来源；用户级技能更新后需要显式同步，不能假设自动跟随。
- **Windows/Git Bash**：路径和 `shutil` 复制需在 Windows 上验证；测试使用临时目录，避免污染仓库。

## Decisions

- 采用“初始化自带 + Phase 2 软性要求”，不做 `project_type` 推断，不改 `task.py verify`。
- 触发条件是 `work_type=backend`（以及 `fullstack` 的后端接口改动），不新增字段。
- 报告固定放任务根 `api-e2e-report.md`，与 `check-report.md` 同级；无接口改动时写“不适用 + 原因”。
- 技能源放 `.agents/skills/trellis-api-e2e`，通过 `manifest.json` 的目录型组件分发；用户级技能不再是项目初始化的依赖。

## Open Questions

无。用户已确认宽松方案、任务创建、报告路径和“不新增硬门禁”。
