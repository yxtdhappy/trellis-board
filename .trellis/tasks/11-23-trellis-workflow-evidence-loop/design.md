# Design：Trellis 任务证据闭环（workflow + skills + task.py）

> 本文是实现设计，不重复 `prd.md` 的需求叙述。基线是 `@mindfoldhq/trellis@0.6.17` 的模板与脚本；看板是只读投影，本设计不修改阶段推导、泳道或看板 API。
>
> 设计目标：让 agent 在 create、start、implement、check、commit、finish/archive 每个边界都有可执行的写入命令和校验 gate；状态不再只存在于未提交工作区，commit 不再靠人工补写。

## 1. 设计结论

1. **任务类型显式化**：新任务在 `create` 时写顶层 `task_type=simple|complex|research`，标签是唯一判定依据；`simple` 多写 design/implement 不改变类型，`complex` 缺 design/implement 直接阻断。
2. **只在阶段边界持久化**：只有 `start`（planning→in_progress）和 `archive`（→completed）改状态；`finish` 只清 active 指针。不是每次编辑 `task.json` 都提交。
3. **复杂任务 start 做 bookkeeping commit**：只提交 `task.json` + 事件日志，不携带用户其他暂存改动；失败 fail-closed，不回滚、不自动降级。简单/研究任务默认只写事件日志，可显式 `--commit-state`。
4. **事件日志是状态意图的审计线**：`.state-events.jsonl` 记录 start/reset/state_commit_failed/check_override/archive；`task.json` 是当前状态，二者不一致时由 `verify`/`doctor` 发现。
5. **commit 由主会话在代码提交后写回**：`set-commit` 写顶层最终提交 + `meta.commits` 历史；`set-pr` 写 PR；`verify` 在 finish/archive 前检查证据与 commit 可达性。
6. **check 证据可显式授权**：complex 后端 check-report 与验收勾选都没有、或 complex 前端既无前端证据也无 check-report 时，`verify` 中断询问，用户授权后写 `meta.check_override`（绑定当前 commit），不是永久通行证。
7. **发行层用 overlay**：`trellis-kit` 覆盖 scripts/skills/prompts/模板，不 fork 上游；看板初始化后应用，存量任务不迁移。
8. **工作类型与证据类型正交**：`work_type=backend|frontend|fullstack|research|docs` 决定证据类型，`task_type` 只决定流程重量；前端把 E2E、截图/预览、owner 确认作为一等证据，`check-report` 只在复杂前端或共享 UI/可访问性/性能敏感改动时强制。

## 2. 模块与数据流

```
workflow / skills / agent prompts
        │  决定“何时调用哪个命令”
        ▼
task.py（命令解析、退出码、--json）
        │
        ├── task_store.py      读写 task.json、archive、set-meta
        ├── state_events.py    追加 .state-events.jsonl
        ├── task_lock.py       本地互斥锁
        ├── verify.py          证据/状态/commit 校验
        ├── doctor.py          恢复与 reconcile
        └── safe_commit.py     只 stage 指定任务文件
        │
        ▼
task.json + .state-events.jsonl + git commit
        │
        ▼
trellis-board（只读 loader / stage 推导，不参与写入）
```

新增模块放在 `.trellis/scripts/common/`，命令入口仍在 `.trellis/scripts/task.py`；避免把逻辑塞进 `task.py` 单文件。

## 3. 数据契约

### 3.1 `task.json` 新增字段

```json
{
  "id": "11-23-trellis-workflow-evidence-loop",
  "title": "...",
  "status": "planning",
  "task_type": "complex",
  "work_type": "fullstack",
  "commit": "efe23c492b23ec5ab14da931732658fc9c61e98b",
  "pr_url": null,
  "meta": {
    "commits": [
      {
        "hash": "efe23c492b23ec5ab14da931732658fc9c61e98b",
        "repo": "mdp-backend-service",
        "scope": "final",
        "at": "2026-11-24T08:00:00Z",
        "source": "set-commit"
      }
    ],
    "commit_object_present": true,
    "check_override": {
      "authorizedBy": "yuhaojie",
      "reason": "口头确认已验证",
      "at": "2026-11-24T08:00:00Z",
      "commit": "efe23c492b23ec5ab14da931732658fc9c61e98b"
    },
    "state_persisted": true,
    "legacy_task_type": "complex"
  }
}
```

字段语义：

| 字段 | 类型 | 写入者 | 说明 |
|---|---|---|---|
| `task_type` | `simple` / `complex` / `research` | `create`、`set-task-type` | 顶层字段，表达流程重量；存量任务可缺失 |
| `work_type` | `backend` / `frontend` / `fullstack` / `research` / `docs` | `create`、`set-work-type` | 顶层字段，表达证据类型；与 `task_type` 正交；存量任务缺失记 `unknown` |
| `commit` | string / null | `set-commit` | 最终/主提交的**完整** hash；不是 PR head，不是历史列表 |
| `pr_url` | string / null | `set-pr` | 只记录，不调 API |
| `meta.commits` | array | `set-commit` | 历史提交；按完整 hash 去重；跨仓库各记各的 |
| `meta.commit_object_present` | bool | `set-commit`、`verify` | `false` 表示用了 `--allow-missing-object` |
| `meta.check_override` | object | `verify --authorize-no-evidence` | 必须绑定当前 `commit`；commit 变化后失效 |
| `meta.frontend_evidence` | object | `set-evidence` | `{type: e2e\|visual\|manual, artifact, commit, confirmedBy, note, at}`；复杂前端通过条件见 §4.1 |
| `meta.frontend_check_report_required` | bool | `set-work-type --check-report-required` | 共享组件/设计系统/路由/状态/可访问性/性能敏感前端任务为 true；此时 complex 前端即使有视觉证据也必须有 check-report |
| `meta.state_persisted` | bool | `start`/`verify` | 可选提示，不作为唯一证据；以 git 中 `task.json` 状态为准 |
| `meta.legacy_task_type` | string | `verify`/`doctor` | 仅记录推断结果，不写顶层，避免把存量任务“迁移”成新标签 |
| `meta.abandoned` | object | 人工/`set-meta` | 本期不扩 status；放弃任务用 `meta.abandoned` + archive |

约束：

- 新任务没有 `task_type`/`work_type` 视为**创建错误**；存量任务没有 `task_type` 走 legacy 推断（有 `design.md` 或 `implement.md` → complex，否则 simple），只 warning，不写回顶层；没有 `work_type` 记 `meta.legacy_work_type="unknown"`，只 warning，沿用原 `task_type` 矩阵。
- `simple` 即使有 `design.md`/`implement.md` 也不改判；`complex` 不能因为缺产物而“先按 simple 跑”。
- `work_type` 不能从 design/implement 有无推断；新任务必须显式传，避免把前端任务误判成 backend。
- `meta.complexity`、`meta.no_code` 不作为新契约；research 的豁免用 `task_type=research` + `archive --planning-only` 表达。
- 多仓库任务不在顶层聚合多个 hash；每个仓库/每个任务记录自己的 commit，`meta.commits` 可带 `repo` 字段区分。

### 3.2 事件日志

路径：`.trellis/tasks/<task>/.state-events.jsonl`。追加写，每行一个 JSON，不重写历史。

```json
{"schema":1,"event":"start_intent","task":"11-23-...","from":"planning","to":"in_progress","task_type":"complex","actor":"yuhaojie","at":"2026-11-24T08:00:00Z","git_branch":"main","git_head":"abc1234"}
{"schema":1,"event":"state_commit_failed","error":"index.lock: File exists","at":"2026-11-24T08:00:01Z"}
{"schema":1,"event":"commit_recorded","hash":"efe23c4...","at":"2026-11-24T09:00:00Z"}
{"schema":1,"event":"check_override","by":"yuhaojie","reason":"口头确认已验证","commit":"efe23c4...","at":"2026-11-24T10:00:00Z"}
{"schema":1,"event":"status_reset","from":"in_progress","to":"planning","by":"yuhaojie","reason":"改为后续迭代","at":"2026-11-24T11:00:00Z"}
{"schema":1,"event":"archive","from":"in_progress","to":"completed","at":"2026-11-24T12:00:00Z"}
```

规则：

- `start` 在写 `task.json` **之前**先追加 `start_intent`；如果进程在两步之间崩溃，`doctor` 能根据 intent + 文件状态判断是“启动未完成”还是“状态丢失”。
- `state_commit_failed` 记录 git 失败原因；不写 `status` 回滚。
- `status_reset` 是人工/显式回退的唯一合法标记；没有该事件却从 `in_progress` 回到 `planning`，视为回退异常。
- `check_override` 必须带 `commit`；`verify` 只有在 `check_override.commit === task.commit` 时才接受。
- 事件日志随任务目录归档；默认提交到仓库；`actor` 用 git `user.name`（不写 email），`session` 只写短 id 或省略，路径写相对路径。
- 日志损坏时只报告，不自动重建；`doctor` 可以把可解析的前缀作为证据，但不能覆盖损坏行。

## 4. 任务类型、工作类型与证据矩阵

| 阶段 | simple | complex | research |
|---|---|---|---|
| create | `task_type` 必填；可无 design/implement | `task_type` 必填；start 前必须有 `design.md` + `implement.md` | `task_type` 必填；`prd.md`（可含 research） |
| start | 默认只写事件；可 `--commit-state` | 默认 bookkeeping commit；失败阻断 | 默认只写事件；可 `--commit-state` |
| implement | 代码即可；报告可选 | 代码 + `implementation-report.md` | 无代码 |
| check | 验证结果可写提交信息/PRD；报告可选 | 后端：`check-report.md` 或验收勾选；前端：E2E/视觉证据 + owner 确认，或 check-report | 无 check |
| commit | 可选；有则 `set-commit` | 必须；`set-commit` | 不需要 |
| archive | 至少一项证据；不支持 `--planning-only`（仅 research/`meta.abandoned`） | `verify --strict` + commit + check 证据/override | `--planning-only` 豁免 commit/report |

`verify` 的证据判定按 `effective_task_type()`：

```python
def effective_task_type(task):
    if task.task_type in ("simple", "complex", "research"):
        return task.task_type
    if exists(task.design_md) or exists(task.implement_md):
        return "complex"          # legacy 推断，仅 warning
    return "simple"
```

关键点：

- `simple` 的“至少一项证据”= 顶层 `commit`、任一 PRD 验收勾选、`implementation-report.md`、`check-report.md`、`status=completed` 中任意一项；`status=in_progress` 本身不算。
- `complex` 的后端 check 证据 = `check-report.md` 或任一验收勾选；前端/全栈按 §4.1 叠加 `meta.frontend_evidence`；都没有时进入 `needs_user_decision`，不是直接 fail。
- `research` 不要求 commit；`archive --planning-only` 必须显式传，且只对 `research`（或 `meta.abandoned`）开放。
- `implement.jsonl`/`check.jsonl` 是上下文 manifest，不是报告，不能作为证据。

### 4.1 工作类型 `work_type` 与前端证据

`work_type` 与 `task_type` 正交：前者回答“改哪一层、用什么证据”，后者回答“流程多重”。`verify` 先执行 `task_type` 的最小要求，再叠加 `work_type` 的证据要求。

| work_type | 典型产物 | simple 最低证据 | complex 最低证据 | check-report |
|---|---|---|---|---|
| `backend` | 服务端代码、单测/集成测试、接口/DB 变更 | commit/验收/报告/completed 任一项 | commit +（check-report 或验收勾选，或 override） | 复杂任务：check-report 或验收勾选 |
| `frontend` | UI 代码、浏览器 E2E、截图/预览、视觉走查 | commit + 至少一项：验收勾选、截图/预览、E2E、owner 确认 | commit +（E2E 结果或视觉证据 + owner 确认，或 check-report） | 普通 UI 微调不强制；共享组件/设计系统/路由/状态/可访问性/性能敏感改动必须 |
| `fullstack` | 前后端代码与两套验证 | 至少一项跨端证据 | 后端证据 + 前端证据都满足 | 按后端/前端规则分别判断 |
| `research` | 方案、调研、对比 | 无代码 commit；`archive --planning-only` | 同 simple，按研究任务处理 | 不需要 |
| `docs` | 文档、spec、说明 | commit/验收/报告任一项 | commit + 验收或报告 | 不需要 |

前端证据统一写 `meta.frontend_evidence`：

```json
{
  "type": "visual",
  "artifact": "docs/evidence/login-1440.png",
  "commit": "efe23c492b23ec5ab14da931732658fc9c61e98b",
  "confirmedBy": "yuhaojie",
  "note": "1440/1024/390 三档截图，登录/错误态通过",
  "at": "2026-11-24T10:00:00Z"
}
```

规则：

- `type=e2e`：`artifact` 是 E2E 报告路径/URL；complex 前端 `confirmedBy` 必填（assignee 或 owner），simple 可空；`commit` 必须等于顶层 `commit`。
- `type=visual`：`artifact` 是截图/预览 URL，`confirmedBy` 必填（assignee 或 owner）；只有截图没有确认不算复杂前端通过。
- `type=manual`：仅用于 simple 前端；complex 前端不得只用 manual。
- 复杂前端通过条件：`check-report.md` 存在 **或**（`meta.frontend_evidence.commit == task.commit` 且 `type in (e2e, visual)` 且 `confirmedBy` 非空）。只勾一个 PRD 验收项不满足。
- 共享组件/设计系统/路由/状态管理/可访问性/性能敏感改动：`set-work-type --check-report-required` 置 `meta.frontend_check_report_required=true`；此时除上述外还要求 `check-report.md` 的前端验证段（E2E/截图/响应式/a11y 结果）。`verify` 不能从路径自动推断“敏感”，以该显式标记为准。
- `effective_work_type()`：新任务读顶层 `work_type`；缺失返回 `unknown`，只 warning，按旧 `task_type` 矩阵，不推断、不写回。

```python
def effective_work_type(task):
    if task.work_type in ("backend", "frontend", "fullstack", "research", "docs"):
        return task.work_type
    return "unknown"  # legacy：只 warning，不推断
```

## 5. CLI 契约

### 5.1 命令面

| 命令 | 作用 | 关键参数 |
|---|---|---|
| `create` | 建任务 | `--task-type simple\|complex\|research`、`--work-type backend\|frontend\|fullstack\|research\|docs`（新任务都必填） |
| `set-task-type` | 改任务类型 | `<task> <type>`；start 后需 `--force --reason` |
| `set-work-type` | 改工作类型 | `<task> <type>`、`[--check-report-required]`；start 后需 `--force --reason` |
| `reset` | 显式回退到 planning | `<task> --to planning --reason <text>`；写 `status_reset` 事件 |
| `start` | 进入实现 | `[--commit-state\|--no-commit-state] [--push] [--force] [--json]` |
| `set-commit` | 记录最终提交 | `<task> <hash>`、`--repo <name>`、`--scope final\|followup`、`--allow-missing-object`、`--persist`、`--json` |
| `set-pr` | 记录 PR | `<task> <url>`、`--persist`、`--json` |
| `set-evidence` | 记录前端证据 | `<task> --type e2e\|visual\|manual --artifact <path-or-url> --commit <hash> [--confirmed-by <id>] [--note <text>] [--json]` |
| `verify` | 证据/状态校验 | `[<task>\|--all] [--strict] [--fix] [--json] [--authorize-no-evidence --by --reason]` |
| `doctor` | 恢复/对账 | `[<task>\|--all] [--reconcile] [--fix] [--json]` |
| `archive` | 归档 | `<task> [--planning-only] [--no-commit] [--json]` |
| `set-meta` | 自定义 meta | 拒绝保留键 |

### 5.2 退出码

统一约定，脚本/agent 可机械判断：

| 退出码 | 含义 |
|---|---|
| 0 | 成功；`verify` 无阻断项（warning 不算失败） |
| 1 | 校验/前置条件失败（缺产物、状态非法、非法参数以外的 gate 失败） |
| 2 | 用法/配置错误（未知参数、任务不存在、JSON 损坏） |
| 3 | git 持久化失败（bookkeeping/persist commit、push 失败） |
| 4 | 需要用户决策（check evidence 缺失、reconcile 冲突） |

`verify --strict` 把 warning 提升为 exit 1，但 `needs_user_decision` 仍返回 4；`--fix` 后仍有阻断项则返回 1。

### 5.3 `--json` 输出

```json
{
  "ok": false,
  "task": "11-23-trellis-workflow-evidence-loop",
  "task_type": "complex",
  "work_type": "fullstack",
  "status": "in_progress",
  "exit_code": 4,
  "needs_user_decision": true,
  "checks": [
    {"id": "commit_required", "severity": "fail", "message": "complex 任务缺少顶层 commit", "fixable": false},
    {"id": "check_evidence", "severity": "decision", "message": "无 check-report 且无验收勾选", "fixable": false}
  ]
}
```

`start`/`set-commit` 的 JSON 额外返回 `commit`、`persisted`、`git_error`；`archive` 返回 `archived_to`。

## 6. 关键算法

### 6.1 `start`

```text
lock(task)
  load task; must exist and status == planning
  ttype = effective_task_type(task)
  preflight:
    - git repo; no rebase/merge/cherry-pick
    - task path not ignored
    - git identity available
    - complex: design.md + implement.md 都存在
    - research: prd.md 存在
    - implement/check manifests 非空
    - 第二个 start：若已有 active task 或同任务 in_progress，默认拒绝；--force 才继续
  append_event(start_intent)              # 先留意图
  write_task(status=in_progress)          # 原子写
  if commit_state is False or (commit_state is None and ttype != complex):
      append_event(start_degraded)        # 显式/默认轻量路径
      unlock; return 0
  stage_only(task.json, .state-events.jsonl)
  git commit --only --no-verify -m "chore(task): start <id>" -- <two paths>
  on failure:
      append_event(state_commit_failed, stderr)
      unlock; return 3                    # 不回滚、不降级
  if push: git push（失败返回 3，但 commit 已存在）
  unlock; return 0
```

实现要点：

- `git commit --only -- <paths>` 只提交指定路径，不把用户已暂存的其他改动带进去；`git add` 也只 add 这两个路径。
- `--no-verify` 只跳过 pre-commit/commit-msg，不跳过签名/identity/index.lock；这些失败按 exit 3 处理。
- 幂等：`nothing to commit` 且 HEAD 中同一路径已是 `in_progress` → 成功；否则失败。
- 简单任务默认不 commit，但必须写 `start_intent`；`verify` 对“simple + 无事件 + 未持久化”才失败。

### 6.1.1 `reset`（建议本期做最小版）

```text
lock(task)
  require --reason and target status == planning
  append_event(status_reset, from=current, to=planning, by, reason)
  write_task(status=planning)
  unlock
```

只允许 `in_progress → planning`；不清空 `commit`/报告（保留历史证据）。`reset` 后再次 `start` 需要重新走 gate；`doctor` 看到 `status_reset` 事件时不得把回退判为异常。`reopen`（completed → planning）本期不做。

### 6.2 `set-commit`

```text
lock(task)
  resolved = git rev-parse --verify <hash>^{commit}
  if missing and not --allow-missing-object: return 1
  write task.commit = resolved
  repo = args.repo or task.meta.repo or git remote（origin 名/URL）
  scope = args.scope or "final"
  upsert meta.commits {hash: resolved, repo, scope, at, source}
  meta.commit_object_present = exists(resolved)
  append_event(commit_recorded)
  if --persist:
      git commit --only --no-verify -m "chore(task): record commit <short>" -- task.json .state-events.jsonl
      on failure: return 3 (字段已写，不丢)
  unlock; return 0
```

规则：

- 接受 7–40 位十六进制或 `HEAD`，**存储时统一解析为完整 hash**；短 hash 只作为输入。
- 顶层 `commit` 每次覆盖为最新最终提交；`meta.commits` 追加历史，按完整 hash 去重，不因短 hash 重复。
- `--allow-missing-object` 只用于 shallow/跨仓库；写 `meta.commit_object_present=false`，`verify` 仍 warning。
- `--persist` 只在所有工作提交完成后调用一次；rebase/merge 中调用会失败，不自动 amend/rebase。
- `set-pr` 同构：校验 `http(s)`，写 `pr_url`，可选 `--persist`。

### 6.3 `verify` 检查项（摘要）

- 检查 status、标签、顶层 commit、commit 对象存在/可达、按 `task_type + work_type` 的证据矩阵、`meta.commit` 陷阱、未持久化状态。
- complex 前端缺 E2E/视觉 + owner 确认或 check-report → `needs_user_decision`（exit 4）；授权写 `meta.check_override`，绑定当前 commit，commit 变化失效。
- legacy 任务按旧矩阵 + warning；完整检查项与告警文案见 `design-details.md`。

### 6.4 `doctor`

`doctor` = `verify` + 恢复/对账，默认只读；`--fix` 只做可证明安全的修复：

- `status_regression`：HEAD `task.json` 是 in_progress、工作区是 planning、无 `status_reset` → 只恢复 `status` 字段，保留其他字段。
- `meta.commit` 陷阱：顶层 `commit` 为空、`meta.commit` 有值 → 迁移到顶层，保留 `meta.commits`。
- `state_not_persisted`：complex 有 `start_intent` 但 HEAD 不是 in_progress → 重建 bookkeeping commit（`--fix`）。
- `legacy_task_type`：推断并写 `meta.legacy_task_type`，不写顶层。
- `commit_object_present`：刷新存在性，不删除 hash。

`doctor --reconcile` 处理团队拉取：

| 场景 | 动作 |
|---|---|
| 本地有 start commit，远端仍 planning | 保留 in_progress；提示 push |
| 远端 completed/archived | 停止，询问 owner，不复活 |
| 双方都 start | 停止，owner 决定；不自动 merge |
| 工作区 planning、HEAD in_progress、无 reset | 恢复 HEAD 状态 |
| 工作区 in_progress、HEAD planning、有 start_intent | 视为未持久化；`--fix` 重建 commit |
| 事件日志损坏 | 只报告；用 `git log -p -- task.json` 辅助 |

`doctor --all --fix` 遍历任务，输出修复/阻断摘要；不批量改写没有问题的任务。

### 6.5 `archive`

```text
load task; verify --strict
  if check evidence missing and no override: exit 4
  if --planning-only:
      require task_type == research or meta.abandoned
      record meta.planning_only / meta.no_code
  set status=completed, completedAt
  move task dir to .trellis/tasks/archive/<YYYY-MM>/
  append_event(archive)
  auto-commit archive path (unless --no-commit)
  write journal
```

`--no-commit` 仍表示“跳过归档 git commit”，不是证据豁免；证据不足时仍然阻断。

### 6.6 锁、原子写与 git 安全（摘要）

- 锁 `.trellis/.runtime/locks/<task>.lock`；task.json 原子写；只 stage 任务文件；不强制 add。
- 完整锁实现、失败恢复与 git 安全边界见 `design-details.md`。

## 7. workflow / skills / agent prompts

### 7.1 单一写入者矩阵

| 角色 | `task.json` status/commit | 阶段报告 | git commit | 看板 |
|---|---|---|---|---|
| 主会话 agent | 是（只经 `task.py`） | 汇总/落盘 | 是 | 只读 |
| implement 子代理 | 否 | `implementation-report.md` | 否 | 只读 |
| check 子代理 | 否 | `check-report.md` | 否 | 只读 |
| 人 | 仅 review/授权；异常时用命令 | 可读 | 可 review | 只读 |
| trellis-board | 否 | 否 | 否 | 只读投影 |

### 7.2 文件改动

| 文件 | 改动 |
|---|---|
| `.trellis/workflow.md` | Phase 1 创建带 `--task-type`；1.4 start 持久化+verify；2.1/2.2 报告按类型；3.4 提交后 `set-commit`/`set-pr`/verify；3.5 `verify --strict`；更新 Phase Index |
| `.agents/skills/trellis-task-state/SKILL.md`（新） | 状态契约、命令表、每阶段 checklist、失败处理、单一写入者 |
| `.agents/skills/trellis-brainstorm/SKILL.md` | 澄清阶段确定 `task_type`，解释三种证据差异 |
| `.agents/skills/trellis-start/SKILL.md` | start 前置检查、complex gate、持久化、verify |
| `.agents/skills/trellis-check/SKILL.md` | check 证据、override 询问、子代理不写 task.json |
| `.agents/skills/trellis-finish-work/SKILL.md` | finish 前 `verify --strict`，按类型检查，不再过滤 `.trellis/tasks/` 脏文件 |
| `.agents/skills/trellis-continue/SKILL.md` | 恢复时 `doctor`，状态回退/commit 缺失检查 |
| `.claude/commands/trellis/*` | 同步上述命令入口 |
| `.trellis/agents/implement.md`、`.trellis/agents/check.md`、`.claude/agents/trellis-*.md`、`.codex/agents/*` | 明确禁止写 status/commit、禁止 git commit；报告职责 |
| `.trellis/spec/` | 新增“Trellis 文件由 agent 全程维护”规范 |

关键文案：

- “代码提交后，主会话必须运行 `task.py set-commit <task> <hash>`；没有回写 commit，任务不算完成。”
- “子代理不写 `task.json` 的 status/commit/pr_url；报告由主会话汇总。”
- “simple 任务没有 design/implement/报告是正常形态；complex 缺 design/implement 才是错误。”
- “start/archive 是仅有的状态转换点；不要每次编辑 task.json 都 commit。”

### 7.3 面板/插件创建入口（摘要）

- 看板表单必选 `workType`；payload 经 `actions.js` → team command → Rust → `task.py --work-type` → 顶层 `work_type`。
- 插件 `ctx.tasks.create` 接受 `workType`，DTO 返回；WitOps 前端开发→frontend、后端开发→backend，其他留空；批量混合不猜。
- 看板支持 `defaultWorkType`（插件上下文/URL）；非法值保持空，不默认 backend。
- 完整入口表、五层校验、WitOps 字段与文件清单见 `design-details.md`。

## 8. `trellis-kit` overlay 发行层

### 8.1 目录

```text
trellis-kit/
  manifest.json
  platforms/registry.json
  overlay/
    .trellis/scripts/...
    .trellis/workflow.md
    .agents/skills/...
  adapters/
    claude-code/...
    codex/...
    opencode/...
    pi/...
    omp/...
    antigravity/...
    dsh/...
    generic/...
  apply.py
  tests/
    platforms/...
```

`overlay/` 只放平台无关的源文件；`adapters/` 按平台能力生成 commands/agents/hooks/settings/extension，不复制业务逻辑。`platforms/registry.json` 是能力矩阵的唯一事实源。

### 8.2 manifest

```json
{
  "name": "trellis-kit",
  "version": "0.1.0",
  "upstream": {"package": "@mindfoldhq/trellis", "version": "0.6.17"},
  "targets": ["claude-code", "codex", "opencode", "pi", "omp", "antigravity", "dsh"],
  "files": [
    {"path": ".trellis/scripts/task.py", "sha256": "...", "platform": "all"},
    {"path": ".agents/skills/trellis-task-state/SKILL.md", "sha256": "...", "platform": "all"}
  ]
}
```

### 8.3 apply 算法

```text
read manifest; read .trellis/.version / package.json
if upstream version mismatch: fail (或 --allow-version-mismatch)
for file in manifest.files:
    current = read(target)
    installed = kit_state.files[path]
    if current exists and current.sha != installed.sha and not --force:
        conflict（用户/上游改过）；报告并跳过
    write atomically; record sha
write .trellis/.kit-state.json {version, files}
run `task.py validate`; report
```

- `--dry-run`、`--check`、`--force`；幂等：相同 sha 不重写。
- 首次 apply 没有 `.kit-state.json` 时，`--check` 先列差异；实际写入必须显式 `--force`（或 `--adopt` 记录 baseline 后再决定），避免静默覆盖已有定制。
- 不改 `task.json`、不迁移存量任务、不改看板阶段推导。
- 看板初始化：发行层提供 `trellis-kit init`（包装 `trellis init` + `trellis-kit apply`）；现有 onboarding/desktop init 管线只调用这个 CLI，不改阶段推导、泳道或看板 API。若 onboarding 接入排到后续阶段，则先文档化手动命令，接入本身作为最小集成项单独验收。
- 上游 `trellis update` 可能覆盖 overlay；apply 的 `.kit-state.json` 用于检测漂移，冲突时不静默覆盖。
- Fork 仅作后续评估；`@mindfoldhq/trellis` 是 AGPL-3.0-only，overlay 也可能包含 AGPL 代码，对外分发前做法务评估。

### 8.4 平台适配契约（摘要）

- 首批 7 平台：claude-code/codex/opencode/pi/omp/antigravity/dsh；用 capabilities + paths + formats 声明差异。
- 共享 `.agents/skills` 只写一份；不创建平台不支持目录；首次 init 与 `--agent-only` 共用适配层。
- 完整平台矩阵、目录差异与检测规则见 `design-details.md`。

## 9. 测试设计

### 9.1 单元测试

- `task_store.py`：create 必填 `task_type`/`work_type`、set-task-type/set-work-type 权限、set-commit 短 hash/HEAD/对象缺失、set-pr URL、set-evidence artifact/commit/confirmedBy 校验、set-meta 保留键、archive 证据分支。
- `state_events.py`：追加/解析/损坏前缀、schema 版本、脱敏。
- `verify.py`：矩阵每一行；strict/非 strict；exit 4；override 绑定 commit；legacy 推断。
- `doctor.py`：状态回退恢复、meta.commit 迁移、reconcile 五种场景、只读默认。
- `task_lock.py`：并发两个进程、stale lock、Windows/POSIX。

### 9.2 集成测试（摘要）

- 临时 git 仓库覆盖 create→start→implement→check→commit→finish→archive、故障注入、拉取/并发、override。
- 完整用例与测试数据见 `design-details.md`。

### 9.3 回归（摘要）

- R35860/R35862/R35868 数据跑 verify/set-commit/archive；看板 derived_stage=check；看板阶段代码不改。完整清单见 `design-details.md`。

## 10. 实施顺序

| 阶段 | 交付 | 验证 |
|---|---|---|
| 1. Schema/CLI 基础 | `task_type`/`work_type`、create/set-task-type/set-work-type、set-commit/set-pr/set-evidence、set-meta guard | 单测 + 临时任务 |
| 1b. 创建入口 | 看板/插件 `workType` 下拉与默认值、DTO、WitOps 分类映射 | Web/插件/服务器单测；CLI 端到端 |
| 2. start 持久化 | 事件日志、锁、bookkeeping commit、失败语义 | 故障注入 |
| 3. verify/doctor/archive | 证据矩阵、override、reconcile、--all --fix | 集成测试 |
| 4. workflow/skills/prompts | 所有平台文案与命令入口 | 文档测试/命令存在性检查 |
| 5. trellis-kit overlay | manifest/apply/check、平台 registry/adapters、首次 init 与 agent-only、看板 init 接入 | 幂等/冲突测试、7 平台矩阵测试 |
| 6. 试点/推广 | trellis-board → mdp-backend-service | R35860/862/868 回归 |

建议按阶段拆子任务（每个阶段可独立验收）；本任务作为父任务保留契约与验收。

## 11. 待确认的设计选择

这些是 PRD Open Questions 中会影响实现的项，设计给出默认，review 时可改：

1. `meta.commits`：默认保留全部、按完整 hash 去重、不截断；后续再加压缩。
2. 短 hash/HEAD：允许输入，存储解析后的完整 hash。
3. `reset/reopen`：本期建议加最小 `task.py reset --to planning --reason`（只用于显式回退，写 `status_reset` 事件）；`reopen` 不做。
4. check override 冲突：assignee 与 owner 都授权时，owner 优先并记录；是否二次确认留待 review。
5. 事件日志隐私：默认提交；`actor` 只写 `user.name`，不写 email；session 只写短 id。
6. worktree 重复任务：不在本任务实现，另开看板任务。
7. 试点顺序：trellis-board 先，mdp-backend-service 后。
8. `--fix` 边界：只修状态回退、`meta.commit` 迁移、可重建 bookkeeping commit；不自动生成报告/验收，不自动改 task_type/work_type。
9. 前端证据确认人：默认 assignee 或 owner 均可，owner 优先；是否引入设计负责人作为第三角色留待 review。
10. 前端证据存储：截图路径默认放任务目录 `evidence/`，也可填外部预览 URL；仓库内大文件是否用 Git LFS、是否脱敏，留待 review。
11. E2E 工具：默认复用各仓库现有测试栈（trellis-board 用 Playwright/浏览器 E2E），不统一引入新框架；无 E2E 的项目用 visual + owner 确认。

## 12. 影响文件（摘要）

完整文件清单见 `design-details.md`；核心新增：`packages/shared/work-types.js`、`.trellis/scripts/common/{state_events,task_lock,verify,doctor}.py`、`trellis-kit/**`、workflow/skills/prompts；看板阶段代码不改。
