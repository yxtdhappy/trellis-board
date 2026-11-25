# 对齐本地项目接入预检与首次同步口径并在弹窗展示差异明细

## Goal

1. **接入预检口径对齐**：将项目接入预检（服务端 `POST /api/agent/task-spaces/preflight` + 桌面端 `association::preflight_desktop_project`）的归属、归档、跨分支和不可写目录过滤口径与首次同步（`GET /api/agent/task-spaces/:id/snapshot` + `TaskSync::pull_initial_sync`）完全拉齐，消除“预检误报差异或冲突、点击「查看并处理差异」后却因实际差异为 0 直接接入完成”的割裂体验。
2. **接入弹窗差异明细**：在桌面端接入弹窗 `ProjectOnboardingDialog` 存在任务差异或结构异常任务时，展示具体差异任务标题、差异类型徽章与任务目录，并在接入提示 toast 中区分待审查状态。
3. **修复重启僵尸监听与冲突处理故障**：消除 `AgentRuntime::stop()` 未停止 `TaskSync` 且 `watch_loop` `Arc` 循环引用导致的同设备自冲突；修复冲突弹窗「用我的版本覆盖」因缺失 `taskVersion`/`leaseToken` 必报 `客户端必须先获取任务版本再写入` 的问题；修复冲突弹窗标题退化为 `任务「任务」发生冲突` 的问题。

## 背景与已确认事实

### 现场 1：接入预检误报差异并跳过确认直接接入

- **现场现象**：
  - 2026-11-25 在 `trellis-board`（`main` 分支，Trellis developer ID `flyfly6`）通过桌面客户端接入本地项目时，弹窗提示「服务端独有 1 个，本地独有 0 个，内容冲突 1 个」，但点击「查看并处理差异」后直接提示接入成功且未弹出 `LiveSyncControlDialog`。
  - 现场仓库目录：`.trellis/tasks/11-20-test1` 为空目录，不构成快照分组；`.trellis/tasks/11-23-trellis-workflow-evidence-loop/task.json:13-14` 的 `creator` 与 `assignee` 均为 `yhj`，并非当前接入开发者 `flyfly6`。
  - 连续接入第二个项目 `mdp-backend-web`（`dev` 分支，`flyfly6`）时，弹窗同样仅提示「本地独有 1 个」而未列出具体任务目录，用户无法分辨是否属于误报。
- **代码根因**：
  - **服务端 preflight 缺失可见性与归档过滤**：`packages/server/team/task-space/access.js:279-327` 的 `preflight()` 使用 `packages/server/team/task-space/shared.js:115-120` 的 `preflightFiles` 查询，直接返回 `sync_task_space_file` 中全部 `deleted = 0` 文件，未像 `GET /snapshot`（`packages/server/team/snapshot/views.js:17-40`、`packages/server/team/task-control/shared.js:318-321`）那样按 `sync_task.assignee_user_id = userId AND archived = 0` 裁剪，也未排除 `.trellis/tasks/archive/%` 归档路径或提供跨分支字段。
  - **客户端 preflight 丢弃 `developerId` 且未复用过滤链**：`packages/web/src/features/board/dialogs/ProjectOnboardingDialog.tsx:347-351` 调用 `preflight_pending_project` 时传入了 `developerId`，但 `packages/desktop/src-tauri/src/main.rs:604-622` 校验后即丢弃；`packages/desktop/src-tauri/src/agent/association.rs:219-228` 未复用 `packages/desktop/src-tauri/src/agent/task_sync/ownership_filter.rs:16-60` 的本人归属过滤，也未执行 `packages/desktop/src-tauri/src/agent/task_sync/initial_sync.rs:1046-1086`、`445-482` 的服务端归档/跨分支过滤与不可写/已归档目录屏蔽。
  - **首次同步执行链路**：`ProjectOnboardingDialog.tsx:708-714` 点击「查看并处理差异」会调用 `associate('review')`，立刻写入绑定、关闭弹窗并在 `packages/web/src/components/layout/ProjectRail.tsx:647` 弹出已接入提示；随后后台 `TaskSync::pull_initial_sync`（`initial_sync.rs:235-282`）执行完整过滤后 `actionable` 为空，跳过 `emit_differences` 并直接调用 `complete_initial_sync`。

### 现场 2：新建任务同机自冲突、覆盖报错与标题退化

- **现场现象**：连续接入上述两个项目后，在 `trellis-board` 刚创建的任务 `11-25-onboarding-preflight-parity` 立即弹出 `任务「任务」发生冲突`，4 个冲突文件（`check.jsonl`、`implement.jsonl`、`prd.md`、`task.json`）在服务端修改人正是本机 `fenglei · Z0314-FL-E`（`r710`）；且在弹窗点击「用我的版本覆盖」时报错 `客户端必须先获取任务版本再写入`。
- **代码根因**：
  - **根因 A（`TaskSync` 强引用环导致重启后僵尸监听双传）**：每次接入项目 `main.rs:676` 调用 `agent_service::restart(&app)`；`packages/desktop/src-tauri/src/agent/runtime.rs:152-160` 的 `AgentRuntime::stop()` 未停止 `TaskSync`；`packages/desktop/src-tauri/src/agent/task_sync/watch.rs:27-36` 中 `watch_loop` 持有 `Arc<TaskSync>` 等待 `rx` 关闭，而 `state.tx` 与 `RecommendedWatcher` 回调内的 `sender` 又保存在 `TaskSync.watch` 中，构成 `Arc` 强引用环使 `Drop for TaskSync`（`task_sync.rs:192-196`）永不触发。进程内残留旧 `TaskSync` 与新 `TaskSync`，各自持有独立的 `task_space_sync_lock` 和内存 `cursor_state` 缓存（`cursor.rs:296-304`）；新建任务文件同时唤醒两个 watcher 并以 `baseSha256: null` 上传，第二个实例在 `packages/server/team/snapshot/apply.js:115-117` 撞上第一个实例刚提交的 `r710` 触发自冲突。
  - **根因 B（覆盖服务端缺失写栅栏与运行态缓存不一致）**：服务端 `packages/server/team/task-control/uploads.js:80-111` 要求更新已有任务必须携带 `taskVersion` 与 `leaseToken`；客户端 `packages/desktop/src-tauri/src/agent/task_sync/conflict.rs:191-204` 的 `decide_conflict("overwrite-server")` 未获取也未携带这两个字段，服务端 `packages/server/team/snapshot/conflicts.js:119-135` 的 `resolveConflict` 调用 `applyChangesInternal` 时也未透传这两个字段。同时，`packages/desktop/src-tauri/src/agent_service.rs:718-735` 的 `decide_live_change` 临时构造新 `TaskSync` 改写磁盘，未同步运行中 `AgentRuntime` 的内存 `cursor_state` 与 `task_control_state`。
  - **根因 C（冲突标题丢失）**：服务端 `conflicts.js:76-85` 的 `listConflicts`（SQL 见 `packages/server/team/snapshot/shared.js:442-460`）未返回 `taskTitle`；客户端 `packages/desktop/src-tauri/src/agent/task_sync/ownership_inbox.rs:425-452` 重建冲突事件时直接兜底为 `"任务"`（`conflict.rs:462-472` 的 `conflict_summary` 也直接回退为 `"任务"`）。

## Requirements

- **R1 服务端预检可见性与归档过滤**：`POST /api/agent/task-spaces/preflight` 仅返回当前用户可见的活跃任务（与 `GET /snapshot` 一致：`sync_task.task_space_id = ? AND assignee_user_id = ? AND archived = 0`，并排除 `.trellis/tasks/archive/%` 路径）；响应体严禁包含任何文件正文 `"content"`。
- **R2 服务端预检轻量元数据与不可写目录清单**：服务端在 `tasks[]` 每组附带可选轻量元数据 `title`（取自 `task.json`）与 `taskBranch`（取自 `task.json.branch`）；同时在顶层返回 `hiddenTaskDirs`（当前任务空间内非本人活跃任务目录、已归档任务目录、无 `sync_task` 行的 legacy 活跃目录）与 `archivedTaskBasenames`（当前任务空间已归档任务目录名），供客户端屏蔽非本地新增的残留目录（对齐 `hide_control_tombstone_local_only` 与 `gate_local_only_differences`）。
- **R3 客户端预检透传 `developerId` 与本地归属过滤**：`main.rs::preflight_pending_project` 将校验后的 `developer_id` 透传到 `agent_service::preflight_project` 与 `association::preflight_desktop_project`；本地任务分组在所有状态（`existing`、`new`、`branch_new`）下复用与 `ownership_filter.rs` 一致的唯一归属谓词（`task.json.assignee` 优先，空时回退 `creator`，大小写不敏感，缺失时 fail open）；`developer_id` 为空时回退 `worktree::developer_id`。
- **R4 客户端预检服务端分支/归档过滤与隐藏目录剔除**：`association::run_preflight` 对服务端分组复用与 `retain_server_groups_for_initial_sync` 一致的归档与分支过滤规则（非归档，且 `task_branch` 等于当前分支、为空或本地存在同目录），并在 `classify_task_snapshots` 后剔除命中 `hiddenTaskDirs` 或 `archivedTaskBasenames` 的 `LocalOnly` 项。
- **R5 预检差异结构携带标题与目录**：`association::difference_to_json` 输出 `title` 字段（本地 `task.json.title` 优先，回退服务端 `title`），并保持现有 `type`、`taskId`、`taskDir`、`local`、`server` 字段结构向后兼容。
- **R6 接入弹窗展示具体差异明细**：`ProjectOnboardingDialog.tsx` 在存在可操作差异（`hasDifferences`）或新建快照包含结构异常任务（`newSnapshot && preflight.counts.invalid > 0`）时，在预检卡片内以紧凑可滚动列表展示每一项差异的任务标题（缺失时回退 `taskId` / `taskDir`）、差异类型徽章（使用既有 `StatusPill` 原语，文案对齐 `LiveSyncControlDialog`：`仅服务端存在`、`仅本地存在`、`内容冲突`、`移动或删除冲突`、`任务结构或身份异常`）及任务目录路径（本地与服务端目录并存且不同时分别标出）。
- **R7 接入提示文案区分审查状态**：`ProjectRail.tsx` 的 `onAssociated` 收到 `initialReviewPending === true` 时提示「本地项目已接入，正在准备差异确认…」，其余场景保持「本地项目已接入团队任务空间，正在同步任务。」（需同时在 `project-onboarding-normalize.ts` 保留 `initialReviewPending` 字段）。
- **R8 前后向兼容与零副作用**：`POST /api/agent/task-spaces/preflight` 保持只读、不写任何数据库表；新客户端兼容未返回 `hiddenTaskDirs`、`archivedTaskBasenames`、`title`、`taskBranch` 的旧服务端；旧客户端忽略新增可选字段不受影响。
- **R9 消除 `TaskSync` `Arc` 循环引用与重启僵尸监听**：
  - `TaskSync` 增加显式停止入口 `stop(&self)` 与 `watch_shutdown` 通知通道，并将 `watch` 改为同步互斥锁以便无阻塞清空 `watchers` 与 `tx`；`Drop for TaskSync` 同样兜底调用 `stop()`。
  - `watch_loop` 改为持有 `Weak<TaskSync>` 并监听 `watch_shutdown`，收到停止信号、channel 关闭或 `Weak::upgrade` 失败时立即退出，不得再发起 `upload_dirty` 或其他同步动作。
  - `AgentRuntime::stop()` 必须调用 `self.task_sync.stop()`；确保每次 `restart` / `stop` 后旧 `TaskSync` 及其 OS 文件监听完全释放，同进程绝不出现两个并存 watcher。
- **R10 修复冲突「用我的版本覆盖」写栅栏与运行态缓存一致性**：
  - 服务端 `packages/server/team/snapshot/conflicts.js` 的 `resolveConflict("overwrite-server")` 将 `input.taskVersion` 与 `input.leaseToken` 透传给 `applyChangesInternal`。
  - 客户端 `conflict.rs::decide_conflict("overwrite-server")` 复用 `upload.rs` 同一控制面写栅栏获取逻辑（`remote_task_control` + `heartbeat_remote_task` / `claim_remote_task`），携带 `taskVersion` 与 `leaseToken` 请求服务端；成功后持久化服务端返回的 `control.task` / `lease` / `taskVersion` 并写入 `suppressed`。
  - `agent_service.rs::decide_live_change` 在后台 `AgentRuntime` 运行且持有对应绑定时，直接在运行中的 `TaskSync`（经 `task_space_sync_lock` 串行化）上执行 `decide_conflict`，避免临时实例改盘后运行态内存 `cursor_state`/`task_control_state` 过时；后台停止时回退临时 `TaskSync`。
- **R11 补齐冲突弹窗任务标题**：
  - 服务端 `packages/server/team/snapshot/shared.js` 的 `pendingConflicts` 与 `conflicts.js` 的 `listConflicts` 关联 `sync_task` 返回可选 `taskTitle`。
  - 客户端 `ownership_inbox.rs` 重建 `task_file_conflict` 事件时按 `conflict.taskTitle` -> 已拉取目录中 `task.json` 的 `title` -> `conflict.taskId` -> `task_dir` -> `"任务"` 逐级回退；`conflict.rs::conflict_summary` 同步按 `details.taskTitle` -> `details.taskId` -> `"任务"` 回退。

## Out of Scope

- 不改变 `GET /snapshot`、`pull_initial_sync` 与 `LiveSyncControlDialog` 的核心冲突决策交互。
- 不在接入预检阶段提供文件级正文 diff 预览（正文对照仍在接入后的 `LiveSyncControlDialog` 中完成）。
- 不修改 SQLite 表结构，不新增 Tauri command 或 capability 权限。

## Acceptance Criteria

- [ ] 服务端 preflight 单测（`packages/server/test/team-task-spaces.test.js`、`packages/server/test/team-gitless-http.test.js`）：`preflight` 仅返回当前用户 `assignee_user_id = userId AND archived = 0` 的活跃任务；他人任务、已归档任务、`.trellis/tasks/archive/...` 路径与无 `sync_task` 行的 legacy 文件均不出现在 `tasks` 中，且出现在 `hiddenTaskDirs` / `archivedTaskBasenames`；`tasks[]` 包含 `title` 与 `taskBranch`，响应体不含 `"content"` 且数据库行计数零变化。
- [ ] 桌面端预检 Rust 单测（`packages/desktop/src-tauri/src/agent/association/tests.rs` 及 `task_sync`）：本地仅含他人任务目录（如 `assignee=yhj`、当前 `developer_id=flyfly6`）时，预检差异计数全为 0；本地缺失 owner 时 fail open 保留；服务端跨分支任务仅当本地存在同目录时保留；命中 `hiddenTaskDirs` 或 `archivedTaskBasenames` 的 `LocalOnly` 项被剔除；`difference_to_json` 正确带出 `title`；`new` / `branch_new` 状态下的 `localOnly` 计数同样排除他人任务。
- [ ] 现场回归场景：本地 `.trellis/tasks/11-23-trellis-workflow-evidence-loop`（`assignee=yhj`）搭配 `developer_id=flyfly6` 执行预检时，不再错报「内容冲突 1 个」或他人的「服务端独有」，直接显示「双方任务一致，可以安全接入」。
- [ ] Web 端单测与 UI 验证：`normalizePreflight` 正确归一化 `title`、`localTaskDir`、`serverTaskDir` 且向后兼容缺失字段；`normalizeAssociation` 保留 `initialReviewPending`；接入弹窗在存在差异时展示任务标题、差异类型徽章与任务目录，符合 `component-reuse.md` 审计规则无违规；`initialReviewPending=true` 时接入 toast 文案准确。
- [ ] 僵尸监听修复单测（Rust）：`TaskSync::stop()` 调用后清空 `watchers` 与 `tx`，`watch_loop` 协程及时退出且 `Arc` 引用计数正常归零触发 `Drop`；连续两次创建/停止 `TaskSync` 监听同一目录，修改任务文件仅触发新实例上传，不产生自冲突。
- [ ] 冲突覆盖修复单测（Server + Rust）：服务端在接入真实 `taskControl` 时，`resolveConflict("overwrite-server")` 携带有效 `taskVersion` 与 `leaseToken` 成功覆盖并标记冲突 `resolved`（缺版本或租约仍按既有 409 拒绝）；客户端 `decide_conflict("overwrite-server")` 自动获取/续约写栅栏并成功覆盖、更新本地 cursor 基线与控制态，不再报 `客户端必须先获取任务版本再写入`。
- [ ] 冲突标题单测（Server + Rust）：`listConflicts` 返回 `taskTitle`；`reopen_conflicts` 即使在旧服务端未返回 `taskTitle` 时也能从 `task.json` 或 `taskId`/`taskDir` 还原可读标题，不再出现 `任务「任务」发生冲突`。
- [ ] 全量门禁通过：`cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml`、`yarn test`、`yarn --cwd packages/web lint`、`yarn build`、`npx oxfmt --check .` 全部通过。

## Risks

- **旧服务端兼容**：客户端对接尚未升级的旧 Team 服务端时，旧服务端 `preflight` 仍返回全量任务且不含 `hiddenTaskDirs`/`taskBranch`，客户端本地归属过滤仍可消除本地他人任务冲突，但服务端独有的他人任务需等服务端升级后彻底对齐（容错降级，不报错）。
- **既有服务端单测夹具依赖直接插入 `sync_task_space_file`**：`packages/server/test/team-task-spaces.test.js:249-263` 未插 `sync_task` 行，调整后需同步补齐测试夹具并保留专门用例验证无 `sync_task` 行时的行为。
- **前端弹窗高度溢出**：差异任务数量较多时，弹窗内差异列表必须限制最大高度并内部滚动，避免把底部操作按钮挤出视口。
- **同步锁与测试签名**：将 `TaskSync.watch` 改为 `std::sync::Mutex` 及调整 `watch_loop` 签名时，不得在持锁期间跨 `.await`，并需同步适配 `task_sync/tests/pull_and_startup.rs:173` 中对 `watch_loop` 的直接调用。
