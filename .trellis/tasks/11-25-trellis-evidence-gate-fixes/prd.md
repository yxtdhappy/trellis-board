# 修复 trellis-kit 与任务状态证据门 3 处 P1 缺陷及项目接入 AGENTS.md 规则同步

## 1. 背景与目标

在 `origin/main`（`fcba232 / 0.5.1`）合入任务状态证据闭环与 `trellis-kit` 分发能力后，代码审查发现了 3 处影响客户端新接入项目及任务生命周期闭环的 P1 缺陷，同时需要补齐项目接入时 `AGENTS.md` 的工作流优先规则同步：

1. **`trellis-task-state/SKILL.md` 分发源仍为旧版**：新版内容仅存在于未被 `manifest.json` / `apply.py` 引用的 `trellis-kit/overlay/.claude/skills/trellis-task-state/SKILL.md`，而实际分发给所有 7 个平台的源路径 `.agents/skills/trellis-task-state/SKILL.md` 及 `trellis-kit/overlay/.agents/skills/trellis-task-state/SKILL.md` 仍为旧版。
2. **`state_persist_degraded` 写入后永久锁死 `verify --strict` 与 `archive`**：`_verify_task` 用 `any(...)` 扫描整个 append-only 的 `.state-events.jsonl`，且重新执行 `start --commit-state` 不会写入解除事件，导致触发过降级启动的复杂任务无法正常归档。
3. **未分类任务（`task_type_pending: true`）绕过 `archive` 证据门**：新流程下创建任务默认不传 `--task-type`（写入 `meta.task_type_pending = true`），若 agent 漏调 `set-task-type`，`_verify_task` 和 `cmd_archive` 会将其视为 `legacy` 历史任务直接放行。
4. **项目接入时未同步 `Trellis Workflow 优先规则` 到项目 `AGENTS.md`**：目前该段规则仅存在于用户全局 `GEMINI.md`，新项目通过 `trellis init` + `trellis-kit` 接入时，项目根目录 `AGENTS.md` 仅有上游 `trellis init` 生成的英文说明，缺少 Phase 1.4 PRD 评审关卡、任务目录提交范围及 Journal 记录范围等强约束。

**核心目标**：在 `trellis-kit/`（客户端接入项目时 `apply.py --force` 实际执行与覆盖目标项目的分发源）以及本仓库对应的 `.trellis/`、`.agents/skills/`、`AGENTS.md` 同步完成上述 4 项改进，保证两处一致并补齐可重复执行的自动化验证。

---

## 2. 范围与需求细节

### 需求 1：同步 `trellis-task-state/SKILL.md` 分发源并清理冗余配置
- 将新版 `trellis-task-state/SKILL.md`（包含仅 `--work-type` 创建、`set-task-type` 后置、复杂任务禁止裸 `--no-commit-state`、`## Evidence source` 章节）同步写入：
  - `.agents/skills/trellis-task-state/SKILL.md`
  - `trellis-kit/overlay/.agents/skills/trellis-task-state/SKILL.md`
- 删除未被 `manifest.json` / `apply.py` 引用的死目录 `trellis-kit/overlay/.claude/skills/`（3 个冗余副本）。
- 清理 `trellis-kit/manifest.json` 中针对 `claude-code` 重复声明的 3 条 `SKILL.md` 组件（`apply.py` 末尾的平台循环已自动将全部 6 个 `SKILL.md` 复制到 `.claude/skills/`）。

### 需求 2：允许 `state_persist_degraded` 通过重新持久化解除
- 同步修改 `.trellis/scripts/task.py` 与 `trellis-kit/overlay/.trellis/scripts/task.py`：
  - 在 `cmd_start` 中当 `commit_state` 为真、准备执行 `_commit_start_state` 之前，向 `.state-events.jsonl` 追加 `state_committed` 事件，使其随本次 bookkeeping commit 一并提交，不产生未提交脏文件；若提交失败，`_commit_start_state` 仍会追加 `state_commit_failed` 触发阻断。
- 同步修改 `.trellis/scripts/common/task_store.py` 与 `trellis-kit/overlay/.trellis/scripts/common/task_store.py`：
  - `_verify_task` 不再对 `state_persist_degraded` 使用全历史 `any(...)`，改为比较最后一次 `state_persist_degraded` 与最后一次 `state_committed` 的事件顺序：仅当降级之后尚未持久化时才报告 `state_persist_degraded`。
  - 修正提示文案，移除未实际执行的 `or doctor --fix` 误导指引，明确指引执行 `task.py start <task> --commit-state`。

### 需求 3：阻断未分类任务（`task_type_pending`）绕过证据门
- 同步修改 `.trellis/scripts/common/task_store.py` 与 `trellis-kit/overlay/.trellis/scripts/common/task_store.py`：
  - 新增 `_is_task_type_pending(data)` 判定：`task_type` 为空且满足 `meta.task_type_pending` 为真或 `work_type` 非空。
  - 在 `_verify_task` 中，当 `_is_task_type_pending(data)` 为真时产出 `error` 级别的 `task_type_pending` finding，提示执行 `task.py set-task-type <task> simple|complex|research`。
  - 在 `cmd_archive` 中，将证据门条件扩展为 `data.get("task_type") in {"simple", "complex"} or _is_task_type_pending(data)`。
  - 保持向后兼容：真正的历史无标签任务（`task_type`、`work_type`、`meta.task_type_pending` 均为空）仍维持原有放行行为；`--planning-only` 归档分支保持优先。

### 需求 4：项目接入时向项目 `AGENTS.md` 同步 `Trellis Workflow 优先规则`
- 经核查 `@mindfoldhq/trellis` 源码（`init.js` 与 `claude.js` 等）：`trellis init --claude` 仅生成 `.claude/` 目录与根目录 `AGENTS.md`，不会创建或修改 `CLAUDE.md`；除不需处理的 `.dsh/DSH.md` 外，其余支持平台也均只通过根目录 `AGENTS.md` 初始化。
- 将全局 `GEMINI.md` 中的 `## Trellis Workflow 优先规则` 全文（包含“严格遵循 Trellis Workflow”、“Phase 1.4 PRD 制品显式评审关卡”、“任务目录提交范围”、“Journal 记录范围” 4 条）提取为 `trellis-kit` 托管片段（`trellis-kit/snippets/agents-workflow-rules.md`），外包独立标记块 `<!-- TRELLIS-BOARD:START -->` ... `<!-- TRELLIS-BOARD:END -->`。
- 扩展 `trellis-kit/apply.py`（客户端 `initialize_project` 必经 `apply_kit_overlay`，且可单独命令行运行）：
  - 在目标项目根目录更新或创建 `AGENTS.md`（`--agent-only` 模式下仅当 `AGENTS.md` 已存在时更新）：将托管标记块放置在 `<!-- TRELLIS:START -->...<!-- TRELLIS:END -->` 之外，保留目标仓库已有 `AGENTS.md` 内容与后续 `trellis update` 兼容性。
  - 幂等语义：不存在标记块（且无手动同名章节 `## Trellis Workflow 优先规则`）时追加；标记块内容一致时跳过（unchanged）；标记块内容不同且传入 `--force` 时原地替换标记块，未传 `--force` 时按冲突报错退出；支持 `--dry-run`。
- 同步将同一 `<!-- TRELLIS-BOARD:START -->...<!-- TRELLIS-BOARD:END -->` 规则块更新至本仓库根目录 `AGENTS.md`。

---

## 3. 非目标（Out of Scope）

- 不修改客户端 Rust 侧 `onboarding.rs` / `trellis_cli.rs` 流程（`onboarding.rs` 已在 `initialize_project` 中调用 `apply_kit_overlay` 并在 `INITIAL_COMMIT_PATHS` 中包含 `AGENTS.md`）。
- 不修改服务端 JS 业务代码与前端 UI。
- 不改动 `trellis-kit/build_overlay.py` 对 `.claude/`、`.codex/` 源目录的组织方式（本任务聚焦上述 4 项改进）。
- 实施前基于最新 `origin/main`（`fcba232`）工作，不触碰工作区中其他未跟踪任务目录（如 `11-25-configurable-app-name/`）。

---

## 4. 验收标准

1. **Skill 分发一致性**：
   - `.agents/skills/trellis-task-state/SKILL.md` 与 `trellis-kit/overlay/.agents/skills/trellis-task-state/SKILL.md` 内容完全一致且为新版（包含 `--force-degraded` 与 `## Evidence source`）。
   - `trellis-kit/overlay/.claude/skills/` 已移除；在临时目标目录运行 `python trellis-kit/apply.py --target <tmp> --force --platform claude-code` 与 `--platform codex` 均退出码 `0`，且目标目录 `.claude/skills/trellis-task-state/SKILL.md` 与 `.agents/skills/trellis-task-state/SKILL.md` 均为新版内容。
2. **`state_persist_degraded` 可恢复**：
   - 在临时 git 仓库中创建 `complex` 任务（补齐 `prd.md`/`design.md`/`implement.md`），先运行 `task.py start <task> --no-commit-state --force-degraded --reason "test"`，验证 `task.py verify <task> --strict` 返回非 0 且包含 `state_persist_degraded`。
   - 随后运行 `task.py start <task> --commit-state`，验证工作区无残留未提交的 `.state-events.jsonl` 变更，且补齐 commit/report 后 `task.py verify <task> --strict` 返回 `0`、`task.py archive <task>` 成功。
3. **未分类任务不可绕过证据门**：
   - 创建仅带 `--work-type backend`（无 `--task-type`）的新任务，验证 `task.py verify <task>` 报 `[error] task_type_pending`，`task.py archive <task>` 被拒绝并返回非 0。
   - 历史无标签任务（通过 `--allow-unlabeled` 创建，无 `task_type` 与 `work_type`）执行 `task.py archive <task>` 仍保持兼容放行。
4. **Overlay 同步性**：
   - `.trellis/scripts/task.py` 与 `trellis-kit/overlay/.trellis/scripts/task.py`、`.trellis/scripts/common/task_store.py` 与 `trellis-kit/overlay/.trellis/scripts/common/task_store.py` 逐字节一致。
5. **项目接入 `AGENTS.md` 规则同步**：
   - 目标目录已有 `trellis init` 生成的 `AGENTS.md`（及自定义内容）时，运行 `python trellis-kit/apply.py --target <tmp> --force` 后保留原有内容并在块外追加 `<!-- TRELLIS-BOARD:START -->...<!-- TRELLIS-BOARD:END -->`（包含完整 `## Trellis Workflow 优先规则` 4 条）；重复运行 `apply.py --force` 不产生重复章节；目标目录无 `AGENTS.md` 时（非 `--agent-only`）可创建仅含该托管块的 `AGENTS.md`；标记块内容过期时 `--force` 原地更新、无 `--force` 报冲突。
   - 本仓库根目录 `AGENTS.md` 包含与托管片段一致的 `<!-- TRELLIS-BOARD:START -->...<!-- TRELLIS-BOARD:END -->` 规则块。
