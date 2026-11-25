# Implementation Report

## Scope

将用户级 `wit-api-e2e` 固化为 Trellis 内置技能 `trellis-api-e2e`，由 `trellis-kit` 随项目初始化分发到各 agent 平台；并在后端任务流程中增加软性的本机 API E2E 步骤。

## Changes

### Skill source

- 新增 `.agents/skills/trellis-api-e2e/`，14 个文件。
- `SKILL.md` frontmatter：`name: trellis-api-e2e`。
- 技能正文、references、scripts 注释中的 `wit-api-e2e` 已替换；脚本文件名保持 `api-e2e-*`。
- `references/local-forwarding-proxy.md` 的用户主目录绝对路径改为技能相对路径，避免项目安装后仍调用用户级旧技能。
- 当前项目 Claude 副本：`.claude/skills/trellis-api-e2e/`（14 个文件）。

### Distribution

- `trellis-kit/manifest.json`：新增目录型组件 `trellis-api-e2e-skill`（`kind: skill`、`directory: true`），版本 `0.2.0 → 0.3.0`。
- `trellis-kit/apply.py`：
  - 新增 `copy_tree()`，复用 `copy_file` 的 dry-run/force/冲突/去重语义。
  - `--agent-only` 允许 `kind: skill`。
  - 平台循环按 `platforms/registry.json` 的 `paths.skills` 复制完整目录；共享 `.agents/skills` 的 codex/pi/dsh 不重复。
- `trellis-kit/build_overlay.py`：目录组件用 `copytree(..., dirs_exist_ok=True)` 同步到 overlay。
- `trellis-kit/overlay/.agents/skills/trellis-api-e2e/`：14 个文件。
- `trellis-kit/README.md`：补充目录技能、平台落点和报告说明。

### Workflow / skills

- `.trellis/workflow.md`：Phase 2.2 新增 2.2.1 Backend API E2E；`[workflow-state:planning]`、`[workflow-state:in_progress]` 及 inline 变体增加提示。
- `.agents/skills/trellis-check/SKILL.md`、`.claude/skills/trellis-check/SKILL.md`：Step 4 增加 Backend API E2E 检查项。
- `.agents/skills/trellis-finish-work/SKILL.md`、`.claude/commands/trellis/finish-work.md`：证据门增加 `api-e2e-report.md` 提醒，明确不是 `task.py verify` 硬失败。
- overlay 对应文件由 `build_overlay.py` 同步。

## Verification

- 技能文件数：agent-only / claude-code / opencode / omp / antigravity 各 14；codex/pi/dsh 共享 `.agents/skills` 14，平台目录无重复。
- 技能自测：Bash 14/14，PowerShell 12/12。
- `apply.py` dry-run 不写文件；冲突检测与 `--force` 覆盖通过。
- `trellis-api-e2e` 目录内无 `wit-api-e2e` 残留。
- `trellis-kit/overlay/.agents/skills/trellis-api-e2e` 与源目录一致（14）。
- workflow（仓库+overlay）、check、finish-work 均包含 `api-e2e-report.md` 文案。
- `git diff -- .trellis/scripts/task.py .trellis/scripts/common/task_store.py` 为空。
- `task.py validate` 通过（implement/check 各 5 条）。

## Not changed

- 未修改 `task.py` / `task_store.py` 的 verify 门禁。
- 未新增 `project_type` / `api_e2e_required` 等 task.json 字段。
- 未把 API E2E 变成 archive 硬门禁。
- 未运行真实 API E2E；本任务无服务端接口行为改动，`api-e2e-report.md` 记录为“不适用 + 原因 + 技能自测证据”。

## Known limits

- 技能安装依赖项目执行 `trellis-kit/apply.py`；桌面客户端初始化会自动执行，手工项目需按 README 补装。
- 目录复制从不删除目标端已有文件；技能源删除文件时，目标端旧文件会残留。
- 平台路径来自 registry；某平台缺少 `paths.skills` 时跳过并记录，不回退 `.claude`。
