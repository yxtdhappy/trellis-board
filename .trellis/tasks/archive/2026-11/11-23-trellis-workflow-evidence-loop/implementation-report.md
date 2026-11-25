# Implementation Report

## 任务

- Task: `11-23-trellis-workflow-evidence-loop`
- Type: `complex` / `fullstack`
- 目标: 让 agent 全程维护 Trellis 任务元数据与证据，看板只读；把流程、技能、CLI、kit 分发和初始化链路一起闭环。

## 交付范围

### 1. 任务状态与证据契约

- `task.json` 新增顶层 `task_type` / `work_type`（创建时只强制 `work_type`，`task_type` 允许待分类）。
- `task.py` 新增：
  - `set-task-type` / `set-work-type`
  - `set-commit` / `set-pr`
  - `set-evidence` / `set-check-override`
  - `verify` / `doctor`
  - `stamp-check`
- `start` 支持 `--commit-state` / `--no-commit-state` / `--force-degraded` / `--push`：
  - complex 默认写 bookkeeping commit；
  - 禁止 complex 裸 `--no-commit-state`；
  - degraded 必须记录原因与事件；
  - 失败保留 `in_progress` 并以 exit 3 停止。
- 新增 `.state-events.jsonl` 事件日志（append-only、原子追加、归档随任务移动）。
- `verify`/`doctor` 覆盖状态回退、提交号、报告来源、前端证据、check binding；`archive` 与 finish-work 使用同一证据门。
- check-report 绑定采用“tree 指纹”方案：`stamp-check` 记录 `base/scope/diff`，`set-commit` 对同一 scope 的提交树复算并写 `meta.check_binding`，`verify` 检查 commit、scope、diff 和报告哈希。

### 2. 面板、插件与创建入口

- 看板创建任务：新增 `work_type` 必填，不再要求用户选择 `task_type`；`task_type` 由 agent 在 brainstorm/start 前判断/询问。
- 服务端、team command、Rust agent、task-service、WitOps、A2A 全链路透传 `workType` / 可选 `taskType`。
- WitOps 分类映射：前端开发→frontend、后端开发→backend；批量不猜。
- 新增 `trellis-api-e2e` 内置技能与 `api-e2e-report.md` 软门禁。

### 3. 流程、技能与 agent 边界

- `.trellis/workflow.md` 更新 start 持久化、报告、commit、finish-work、API E2E。
- 新增/更新 `trellis-task-state`、`trellis-check`、`trellis-finish-work`、`trellis-brainstorm`、`trellis-continue`。
- implement/check 子代理禁止改 `task.json`、禁止 start/set-commit/archive；主会话是唯一写入者。
- check-report 使用 `mode` / `agent` / `session` / `base` / `scope` / `diff` front matter；inline-self-check 需要 override。

### 4. 初始化分发与平台

- `trellis-kit` 增加平台 registry、目录型 skill 组件、overlay 和 `apply.py` 平台过滤。
- 桌面客户端 onboarding 在 full init / agent-only 后自动 apply kit。
- kit 内嵌进 EXE，首次使用释放到本地 runtime，支持 `TRELLIS_KIT_ROOT` 覆盖。
- 支持 claude-code / codex / opencode / pi / omp / antigravity / dsh；共享 skills 只写一份。
- OpenCode 插件迁移到 V2 `Plugin.define({ id, setup })` + `ctx.session.hook` / `ctx.tool.hook`。

## 关键提交

- `66f8372` 建立任务状态证据闭环与初始化流程分发
- `c88ac06` 桌面内嵌 trellis-kit
- `3e40ce4` OpenCode 插件迁移 V2
- `7cc05ce` 隐藏 Windows 子进程控制台
- `3a436f7` check report 绑定提交树
- `2483457` release 0.5.9

## 验证

- `python -m py_compile`：通过
- `task.py validate`：通过
- `node --test scripts/test/task-check-binding.test.js`：6/6
- `node --test scripts/test/trellis-kit.test.js`：7/7（含 manifest 全量 overlay 一致性）
- 此前全量 `node --test`：985 tests / 0 fail（26 skipped）
- GitHub Actions `45628297556`：node tests、Rust tests、desktop build、portable smoke、launch smoke 全绿
- `git diff --check`：通过（仅 CRLF 提示）

## 独立 check 后的修复

- 禁止 independent complex check-report 用手写 `commit` 绕过 `stamp-check`。
- 前端 evidence 必须绑定当前任务 commit；旧提交截图不能关闭门禁。
- `set-commit` 会把提交前创建的空 `check_override` 绑定到最终 commit。
- 实现 `verify` exit 4 与 `--authorize-no-evidence --by --reason`。
- check-report 强制 `session`；Codex check 模板不再要求写 `commit`。
- kit manifest 全量 overlay 回归测试；`build_overlay.py` 跳过无 `source` 的 feature 组件。

## 未覆盖/限制

- 平台 command/hook adapter 仍以现有 Trellis 生成为主，kit 只覆盖 skills/agents/核心脚本，不是完整的上游模板替代。
- 本任务未做真实业务 API E2E；见 `api-e2e-report.md` 的“not applicable”说明。
- 旧项目需要重新初始化或执行新版 `apply.py` 才能获得新流程。
- 看板仍只读，未新增阶段/泳道/交互。

## 结论

实现完成，测试与 CI 通过；可进入独立 check 与归档。
