<!-- TRELLIS-BOARD:START -->
## Trellis Workflow 优先规则

当项目中的 `AGENTS.md` 或相关配置中包含 Trellis 相关流程说明时：

1. **严格遵循 Trellis Workflow**：
   - 必须严格按照项目中 `AGENTS.md` 及 `.trellis/workflow.md` 定义的规则与 Phase 流程使用 Trellis Workflow。
2. **Phase 1.4 PRD 制品显式评审关卡（禁止跳过 PRD 确认直接实施）**：
   - 在生成或更新 `prd.md`（及 `design.md`/`implement.md` 等规划制品）后，**必须立即终止当轮工具调用**，向用户完整汇报 PRD 的核心目标、需求细节与验收标准。
   - **用户同意创建任务（Task creation approval）绝不等于同意开始实施开发（Implementation approval）**；严禁在未获得用户对 PRD 等制品的显式确认前调用 `task.py start`，严禁编写或修改任何代码。
   - 必须等待用户明确确认 PRD 后，方可在下一轮会话中执行 `task.py start` 并进入 Phase 2 执行阶段。
3. **任务目录提交范围**：
   - 提交本次工作内容时，把当前任务的 `.trellis/tasks/<task-dir>/` 目录一并纳入同一次工作提交（`task.json`、`prd.md`、`design.md`、`implement.md`、`implement.jsonl`、`check.jsonl`、`research/` 等）。这是本项目的既有惯例，也是 `task.py archive` 自动提交能正常工作的前提。
   - 不要只提交代码/测试/spec 而把任务目录留给归档提交：任务目录未入库时，`task.py archive` 的自动提交仍会把已经移走的源路径写进 `git commit -- <pathspec>`，git 报 `error: pathspec '.trellis/tasks/<task-dir>' did not match any file(s) known to git` 并中止整笔提交（归档目录文件进入暂存区，但提交没有发生）。
   - 归档提交 `chore(task): archive <task-dir>` 只应记录 `.trellis/tasks/<task-dir>/` → `.trellis/tasks/archive/<YYYY-MM>/<task-dir>/` 的改名（diff 中形如 `{ => archive/2026-09}`）；若它把这些任务文件记成新增文件，说明上一步漏了任务目录。
   - 如果确实不想把任务目录并入工作提交，先与用户确认，再由执行者手工提交归档目录。
4. **Journal 记录范围**：
   - Trellis journal（`add_session.py` / `chore: record journal`）只为已创建 Trellis 任务的会话服务，触发链路是 work commit → `task.py archive` → journal。
   - 未创建 Trellis 任务的普通提交，不得调用 `add_session.py`，不得产生 `chore: record journal` 提交；Trellis 流程中没有“把非 Trellis 任务的提交记录到 journal”的描述。
   - journal 文件只通过脚本维护，不手工编辑。
<!-- TRELLIS-BOARD:END -->
