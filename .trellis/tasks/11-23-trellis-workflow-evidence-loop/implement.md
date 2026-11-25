# 实施计划：Trellis 工作流证据闭环 + 面板/插件任务类型

## 0. 当前状态

- 任务：`11-23-trellis-workflow-evidence-loop`，`status=in_progress`，`task_type=complex`，`work_type=fullstack`；用户已 review 并说“开始实施吧”。
- 复杂任务前置产物 `prd.md` + `design.md` + `implement.md` 已齐备；`task.py validate` 通过。
- 阶段 0/1/1b/2/3/4 的核心代码与文档已落地，尚未提交；阶段 5（trellis-kit 发行层）已有最小 overlay；阶段 6（统一验证/回归）已完成核心验证，见文末“验证结果”。
- 按用户要求“直到任务实施完成，后面统一验证”，实现期间不逐步跑测试/编译；完成后再统一验证。
- 工作区包含前序未提交的平台适配/心跳/onboarding 改动，本任务不负责，不回滚。

## 1. 目标

1. 让 agent 在任务生命周期内自动维护 `task.json` 的 status、commit、证据，不再依赖人工补数据或看板交互。
2. 在 start/archive 等安全点持久化状态，避免 stash/rebase 后状态回退且无记录。
3. 用 `task_type + work_type` 的分层证据矩阵，让 simple 任务不被报告门槛误伤，复杂任务和前端任务有足够证据。
4. 把同一套规则落到 workflow、skills、agent prompts、Trellis 脚本和跨平台发行层。
5. 把“前端/后端/全栈/研究/文档”任务类型接入看板创建表单、插件创建入口和插件任务读取，三个入口写出同一顶层字段。

## 2. 非目标

- 不新增看板阶段、泳道、状态机或写回通道；看板仍是只读投影。
- 不自动提交每一次 `task.json` 变化；只在 start/archive 等边界持久化。
- 不强制 simple 任务生成 design/implement/报告；不强制普通前端任务写 check-report。
- 不从 design/implement 有无反推 `task_type`/`work_type`；不在面板/插件创建时静默默认 backend。
- 不迁移存量任务；旧任务只 warning。
- 不在本任务实现 worktree 重复任务合并；另开看板任务。

## 3. 实施阶段

### 阶段 0：文档与契约（已完成）

- [x] `prd.md`：D1–D16、R1–R9、Acceptance/Non-goals/Risks/Open Questions。
- [x] `design.md`：数据契约、证据矩阵、CLI、start/verify/doctor/archive、workflow/skills、平台适配、§7.3 面板/插件入口、测试与实施顺序。
- [x] `implement.md`：本文件。
- [x] 用户 review 三份文档；确认本任务标签；确认 Open Questions 中仍需拍板的项。
- 验证：`python ./.trellis/scripts/task.py validate .trellis/tasks/11-23-trellis-workflow-evidence-loop`（通过）。

### 阶段 1：CLI 与 schema 基础（已完成，待统一验证）

目标：`task.py` 成为唯一写入通道，所有新字段/证据都有命令。

1. `task.py create`
   - 新增 `--task-type simple|complex|research`、`--work-type backend|frontend|fullstack|research|docs`（已落地）。
   - 新任务漏传暂不拒绝（看板/插件尚未传 task_type）；`--meta task_type=...` 不作为入口。
   - `task_store.py` 写顶层 `task_type`/`work_type`，保留 `dev_type` 不动（已落地）。
2. 标签修改
   - `task.py set-task-type <task> <type>`、`set-work-type <task> <type> [--check-report-required]`。
   - 只允许 start 前；start 后必须 `--force --reason` 并写 `status_reset`/`label_changed` 事件。
   - `--check-report-required` 写 `meta.frontend_check_report_required=true`。
3. 证据命令
   - `set-commit`：7–40 位 hex/HEAD，解析为完整 hash；默认 `git rev-parse --verify <hash>^{commit}`；对象不存在默认失败，`--allow-missing-object` 才写 `meta.commit_object_present=false`；顶层 `commit` + `meta.commits`；`--persist` 生成只含任务文件的 bookkeeping commit。
   - `set-pr`：只写顶层 `pr_url`，校验 http(s)。
   - `set-evidence`：`--type e2e|visual|manual --artifact <path-or-url> --commit <hash> [--confirmed-by]`，写 `meta.frontend_evidence`。
   - `set-meta`：拒绝 `status`/`commit`/`pr_url`/`completedAt`/`work_type`/`task_type` 等保留键，提示专用命令。
4. 事件日志
   - 新增 `common/state_events.py`：`.trellis/tasks/<task>/.state-events.jsonl`，schemaVersion 1，append-only；记录 start/reset/state_commit_failed/commit_recorded/check_override/evidence/archive。
   - 原子追加、失败可见；归档时随任务目录移动。

验证：
- 单元测试：create 枚举/漏传、set-commit 对象存在/缺失/短 hash/HEAD、set-pr、set-evidence、set-meta 保留键、事件追加。
- 临时仓库跑 `create --task-type complex --work-type frontend`，断言 task.json 字段与 `task.py validate`。

### 阶段 1b：看板/插件创建入口（已完成，待统一验证）

目标：用户在看板或插件创建任务时显式选择 `task_type` 与 `work_type`；插件能读取并默认带回当前任务类型（`work_type`）。

1. 共享枚举（已落地）
   - `packages/shared/task-types.js` / `.d.ts`：`simple|complex|research` 枚举、标签、`isTaskType`/`taskTypeLabel`（新增）。
   - `packages/shared/work-types.js` / `.d.ts`：五个枚举、中文标签、`isWorkType`/`workTypeLabel`。
2. 看板表单
   - `CreateTaskDialog.tsx`：新增必填“任务类型（work_type）”下拉；`workType` 为空阻止提交；payload 增加 `workType`；`defaultWorkType` 合法时默认选中，非法值按空并提示；不出现任务复杂度（已落地）。
3. 看板默认值
   - `BoardPage.tsx`：从插件上下文或 URL 参数 `taskType`/`workType` 读取合法值，传给 `CreateTaskDialog`；无值不猜。
   - `useBoard.ts`：确认 `createTask` payload 原样透传 `workType`，不丢字段。
4. 服务端
   - `actions.js`：校验 `taskType`/`workType`，追加 `--task-type`/`--work-type`（已落地）。
   - `task-command-service.js`：`create_task` 校验并写 payload（已落地）。
   - `routes/tasks.js`：`POST /api/tasks` 已把 body 交给 `enqueue`，确认 `workType` 不被白名单过滤。
5. Rust agent
   - `task_command.rs`：读取 `taskType`/`workType`、校验枚举、追加 `--task-type`/`--work-type`（已落地）；补 `create_task` 测试：合法、非法、缺省。
6. 插件任务服务
   - `task-service.js`：`create` 透传 `taskType`/`workType` 到 `actions.createTask`；`toTaskDto` 返回 `taskType: task.task_type ?? null`、`workType: task.work_type ?? null`。
   - `plugins/witops-core/index.js`：`task.create` 参数增加 `taskType`/`workType`。
   - `plugins/witops-core/dispatch.js`：`createTaskRecord` 把 `draft.taskType`/`draft.workType` 或分类映射传给 `ctx.tasks.create`。
   - `plugins/witops-core/mapper.js`：新增 `workTypeForCategory()`；只映射前端开发→frontend、后端开发→backend，其他返回空。
7. WitOps 对话框
   - `panel/index.html`：新增“任务类型”下拉（按平台/请选择/前端/后端/全栈/研究/文档）。
   - `panel/app.js`：打开时按当前单条工作项分类映射默认选中；批量混合类型或无法映射时为空；确认时读取并传给 `dispatchItems`/`/dispatch`。
   - 确认文案显示所选类型；非法值不提交。
8. 写入标签来源
   - 面板/插件创建时写 `meta.label_source=user-explicit`；插件映射默认值额外写 `meta.label_default_from=witops-category`。
   - 不改看板阶段/泳道/API。

验证：
- 看板：未选任务类型（work_type）不能提交；表单不出现任务复杂度；选 frontend 后 task.json 顶层 `work_type=frontend`、`task_type` 为空且 `meta.task_type_pending=true`；`defaultWorkType` 合法时默认选中；非法值不回落。
- 插件：WitOps 前端/后端分类默认值正确；其他分类为空；批量混合为空；DTO 能读回 `taskType`/`workType`；`taskType` 不在面板选择，由 agent 后续分类。
- CLI/HTTP/agent 三条路径写出的字段一致。

### 阶段 2：start 持久化与失败语义（已完成，待统一验证）

1. `task.py start`
   - 前置校验 `task_type`/`work_type`；complex 缺 design/implement 阻断；legacy 只 warning。
   - `--commit-state`（complex 默认）/`--no-commit-state`（显式降级）/`--push`/`--force`。
   - 预检 git 仓库、无 rebase/merge/cherry-pick、任务路径未被 ignore、identity 可用；预检失败不写 status。
   - 写 task.json + 事件 intent → 只 stage task.json 与 `.state-events.jsonl` → `git commit --no-verify`（仅 bookkeeping）。
   - 失败返回非零（exit 3），保留文件与 `state_commit_failed` 事件；不回滚 planning、不自动降级；`verify` 报 `state_not_persisted`；`doctor --fix` 重试。
   - 幂等：nothing to commit 且 HEAD 已是 in_progress → 成功。
2. 并发/拉取
   - 第二个 start 默认拒绝，`--force` 才允许；assignee 为空用 git user。
   - `doctor --reconcile`：本地 start + 远端 planning → 保留；远端 completed/archived → 停止；双方 start → owner 决策。
   - 默认不 push；`--push` 显式开启；文档写明未 push 状态团队不可见。
3. 锁
   - 新增 `common/task_lock.py`：`.trellis/.runtime/locks/<task>.lock`；Windows/POSIX 可用；stale lock 可恢复。
   - task.json 原子写（temp + `os.replace`），保留 JSON 格式。

验证：故障注入 index.lock、hook 拒绝、rebase 中、任务目录被 ignore、identity/签名失败、nothing-to-commit；断言 exit code、状态、事件、doctor 恢复。

### 阶段 3：verify / doctor / archive（已完成，待统一验证）

1. `task.py verify <task> [--strict]`
   - 检查 status、标签、顶层 commit、commit 对象存在/可达、按 `task_type + work_type` 的证据矩阵、`meta.commit` 陷阱、未持久化状态。
   - complex 前端缺 E2E/视觉 + owner 确认或 check-report → `needs_user_decision`（exit 4）；用户授权写 `meta.check_override`，绑定当前 commit，commit 变化失效。
   - legacy 任务按旧矩阵 + warning。
2. `task.py doctor <task>` / `doctor --all --fix`
   - 检测状态回退、标签缺失/不一致、commit 缺失、证据缺失、`meta.commit` 陷阱。
   - 安全项自动修；不安全项只报告；`--dry-run` 默认。
3. `task.py archive`
   - 先 `verify --strict`；失败拒绝；research 用 `--planning-only`；非 research 传 `--planning-only` 拒绝；`--no-commit` 仍只表示跳过归档 git commit。
   - archive 写 `status=completed`/`completedAt`，清理 active 指针。

验证：矩阵测试（simple/complex × backend/frontend/fullstack/research/docs）；override 绑定/失效；doctor 安全修复；archive 阻断与豁免。

### 阶段 4：workflow / skills / agent prompts（已完成，待统一验证）

1. `.trellis/workflow.md`：Phase 1 创建带标签；1.4 start 校验+持久化+verify；2.1/2.2 按类型产出报告/证据；3.4 提交后 `set-commit`/`set-pr`/`set-evidence`+verify；3.5 `verify --strict`。
2. 新增 `.agents/skills/trellis-task-state/SKILL.md`：契约、命令表、每阶段 checklist、失败处理、单一写入者。
3. 更新 `trellis-brainstorm`/`start`/`check`/`finish-work`/`continue`：标签提议+用户确认、前端证据、override 询问、finish 前 verify、continue 时 doctor。
4. 更新 `.trellis/agents/{implement,check}.md`、`.claude/agents/trellis-*.md`、`.codex/agents/*`：子代理不写 status/commit/pr_url，不执行 git commit；报告职责。
5. 同步 `.claude/commands/trellis/*` 与各平台入口；不出现“记得更新 task.json”这类不可执行文案。

验证：文档测试/命令存在性检查；用临时任务走一遍 create→start→implement→check→commit→finish→archive，不手改 JSON。

### 阶段 5：trellis-kit 发行层与看板初始化（自动 apply 已接入）

1. `trellis-kit/`：manifest、`platforms/registry.json`、自包含 `overlay/`、`build_overlay.py`、`apply.py`；平台特定文件按 manifest `platform` 过滤。
2. 首批 7 平台：claude-code/codex/opencode/pi/omp/antigravity/dsh；能力声明 `capabilities + paths + formats`；共享 `.agents/skills` 只写一份；不创建平台不支持的目录；无平台选择时不落 `.agents`/`.claude`/`.codex`。
3. 看板初始化：`trellis-kit` 作为 Tauri resource 随客户端打包；`onboarding.initialize_project` 在 full init 与 agent-only 之后调用 `apply.py --target <repo> --platform ... --force`；缺 kit 时初始化失败（`TRELLIS_KIT_APPLY_FAILED`）。
4. `apply.py` 默认从 `overlay/` 读取，bundle 不依赖 board 源码树；`--dry-run`/`--force`/`--agent-only` 保留；成功写 `.trellis/.kit-version`。
5. 存量任务不迁移；先 trellis-board 试点，再 mdp-backend-service 等。

验证：apply 幂等/冲突/`--dry-run`；7 平台只落各自目录；`--agent-only` 不写任务目录；onboarding 缺 kit 失败可读；Rust 代码需在有 cargo 的环境编译。

### 阶段 6：测试、回归与试点（核心验证已通过）

1. 单元测试：`task_store`/`verify`/`doctor`/`state_events`/`task_lock`/`work-types`。
2. 集成测试：临时 git 仓库完整流程、故障注入、拉取/并发、override、archive。
3. 回归：R35860/R35862/R35868 数据跑 verify/set-commit/archive；看板 `derived_stage` 进入 check；看板阶段代码不改。
4. 面板/插件回归：看板创建三种类型、默认值、非法值；WitOps 分类映射/批量混合；插件 DTO 读取。
5. 试点：trellis-board → mdp-backend-service；记录升级 checklist。

## 4. 文件清单

### 4.1 已落地（未提交）

```text
packages/shared/work-types.js / .d.ts                         (new)
packages/web/src/features/board/dialogs/CreateTaskDialog.tsx  (下拉/校验/payload/defaultWorkType)
packages/web/src/pages/board/BoardPage.tsx                     (URL 默认值)
packages/server/plugins/task-service.js                        (create/DTO/meta)
packages/server/actions.js                                     (校验/--work-type)
packages/server/team/task-command-service.js                   (payload)
packages/desktop/src-tauri/src/agent/task_command.rs            (读取/校验/透传)
plugins/witops-core/*                                          (分类映射/对话框/透传/测试)
.trellis/scripts/task.py                                       (task_type/标签/commit/pr/evidence/verify/doctor/archive)
.trellis/scripts/common/task_store.py                          (schema/命令/verify/doctor/archive gate)
.trellis/scripts/common/state_events.py                        (new)
.trellis/workflow.md / .trellis/agents/{implement,check}.md
.agents/skills/trellis-task-state/SKILL.md                     (new)
.agents/skills/trellis-{brainstorm,continue,finish-work}/SKILL.md
.claude/commands/trellis/finish-work.md
.claude/agents/trellis-{implement,check}.md
.codex/agents/trellis-{implement,check}.toml
.trellis/spec/guides/{index,task-state-contract}.md
trellis-kit/**                                                 (new)
```

### 4.2 未落地 / 后续

```text
trellis-kit/adapters/**             （平台 command/hook 生成器尚未实现，目前只有 registry + copy-only apply）
.trellis/scripts/common/task_lock.py（并发写锁未实现；当前依赖单会话 + git 预检）
verify --all / doctor --all         （单任务 verify/doctor 已实现）
R35860/862/868 历史任务回归         （未在本仓库执行）
```

## 5. 测试矩阵（最低要求）

| 场景 | 期望 |
|---|---|
| create 漏 `--work-type`（新任务） | 拒绝；存量任务只 warning |
| create `--work-type=frontend` | task.json 顶层 frontend；validate 通过 |
| 看板未选类型 | 表单阻止，不发请求 |
| 看板 `defaultWorkType=backend` | 表单默认选中后端 |
| 看板非法默认值 | 空 + 提示，不回落 backend |
| 插件前端开发分类 | 默认 frontend；DTO 读回 frontend |
| 插件后端开发分类 | 默认 backend |
| 插件其他分类/批量混合 | 空，用户必须选择 |
| 非法 `workType` 走 HTTP/agent | enqueue/Rust/task.py 任一层拒绝 |
| simple 无 design/implement/报告，有 commit | verify/archive 通过 |
| complex 缺 design/implement | start/verify 阻断 |
| complex 前端只有 commit + 一个验收勾选 | 阻断；补 E2E/视觉 + owner 确认或 check-report 后通过 |
| frontend check-report-required 只有 visual/e2e | 阻断 |
| complex 后端无 check-report/验收 | exit 4，询问；授权后写 override |
| override 后 commit 变化 | 失效，重新询问 |
| start bookkeeping 失败（index.lock/hook/rebase/ignore/identity） | exit 3，状态不丢，verify 报 state_not_persisted，doctor 可修 |
| 远端只改其他文件 / 同文件不同字段 / 远端 completed / 双方 start | 保留/冲突可见/不复活 |
| research 无 commit | `--planning-only` 归档通过 |
| archive 非 research 传 `--planning-only` | 拒绝 |
| R35860/R35862/R35868 | 不手改 JSON 完成 verify/set-commit/archive；derived_stage=check |

## 6. 验证命令

```bash
python ./.trellis/scripts/task.py validate .trellis/tasks/11-23-trellis-workflow-evidence-loop
python ./.trellis/scripts/task.py create "smoke" --description "smoke" --task-type complex --work-type frontend --no-start
python ./.trellis/scripts/task.py verify <task> --strict
python ./.trellis/scripts/task.py doctor <task> --dry-run
npm test --workspace @trellis-board/shared
node --test packages/server/test/*.test.js
node --test plugins/witops-core/test/*.test.js
npm run typecheck --workspace @trellis-board/web
npm run lint --workspace @trellis-board/web
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml
```

按全局规则：所有开发完成后再统一构建/编译，不每完成一个小阶段就跑一次。

### 验证结果（2026-11-24）

- `python -m py_compile .trellis/scripts/task.py .trellis/scripts/common/task_store.py .trellis/scripts/common/state_events.py`：通过。
- `python ./.trellis/scripts/task.py validate .trellis/tasks/11-23-trellis-workflow-evidence-loop`：通过（implement/check 各 4 条）。
- 临时 git 仓库冒烟：
  - complex backend：create→start（bookkeeping commit）→代码提交→set-commit --persist→check-report→verify --strict，通过。
  - simple frontend：start→set-commit→verify --strict，通过（不要求报告）。
  - complex frontend：visual evidence（confirmed_by）→verify --strict，通过；set-check-override 后仍通过；archive --no-commit 成功。
  - 冒烟发现并修复：complex frontend 的视觉证据原先无法满足 `check_evidence_missing`，现 `_has_frontend_check_evidence()` 允许 e2e，或带 `confirmed_by` 的 visual/manual。
- `node --test` 定向：plugin-real-task 2/2、WitOps 37/37、A2A 13/13、team task 36/36、shared task-types 2/2、work-types 2/2、agent-tools 5/5 通过。
- `yarn test --scope=all`：879 个测试，874 通过、3 跳过；2 个 `plugins/jenkins-ops/test/accounts-integration.test.js` 用例只在全量并行时失败，单独运行 6/6 通过，与本次改动无关（疑似并行时序 flaky）。
- `oxlint packages/web`：0 errors（仅既有 warning）；`tsc -b --noEmit`：通过。
- 本次改动文件 `oxfmt --check`：通过；全仓库 `yarn test --scope=lint` 仍被 22 个既有未格式化文件阻断（非本次改动）。
- `cargo check/test`：本机未安装 `cargo`，未能执行；Rust 改动已人工复核，建议在装有 Rust 工具链的环境补跑。

## 7. 风险与回滚

- **模板覆盖**：`.trellis/scripts` 来自 Trellis 0.6.17，`trellis update` 可能覆盖；所有脚本改动进入 `trellis-kit` overlay，并加 manifest/校验和。
- **字段分散**：`task_type`/`work_type` 跨 web/server/Rust/task.py/插件五层；任何一层漏校验都会写出非法值。测试矩阵覆盖四层拒绝。
- **插件分类映射过度**：只映射前端/后端，其他留空；批量混合不猜，避免错误默认。
- **旧任务**：不迁移；verify/doctor 只 warning；避免一次性批量改写。
- **start commit 失败**：fail-closed；不自动回滚/降级；必须提供 `--no-commit-state` 显式出口。
- **回滚**：每阶段独立提交；面板/插件改动可单独 revert；脚本改动在 overlay 中保留原版备份；不 force-push、不改写历史。

## 8. 完成定义

- [ ] 三份文档 review 通过；本任务标签由用户确认。
- [ ] `task.py create/start/set-commit/verify/doctor/archive` 均有命令与测试；不手改 task.json 可走完全流程。
- [ ] simple/complex/research × backend/frontend/fullstack/docs 证据矩阵测试通过。
- [ ] 状态持久化故障注入通过；拉取/并发场景不丢状态。
- [ ] workflow/skills/agent prompts 在 7 平台入口可用；看板只读。
- [ ] 看板/插件创建入口写出的 `work_type` 一致；默认值/非法值/批量混合行为符合 D16。
- [ ] R35860/R35862/R35868 回归通过；看板阶段代码不改。
- [ ] trellis-kit manifest/apply/平台矩阵测试通过；试点仓库升级完成。
