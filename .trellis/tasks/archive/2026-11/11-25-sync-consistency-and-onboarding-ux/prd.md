# 客户端任务同步一致性修复与接入弹窗优化

## Goal

1. **消除桌面端写状态 IPC 与后台运行态 `TaskSync` 的状态分裂**：所有修改本地任务目录、游标、绑定或任务控制态的 Tauri 命令优先复用运行中的 `TaskSync` 并经任务空间串行锁执行，避免与后台拉取/监听并发冲突或导致内存缓存过期。
2. **消除只读任务下载与 FS 监听的竞态窗口**：下载他人任务为只读副本时，确保先登记只读与抑制标记再落盘，防止 watcher 误触发上传。
3. **对齐全链路过滤与租约口径**：补齐 `pull.rs` 零游标兜底分支的本地归属闸门与只读目录过滤；对齐服务端接入预检与首次同步在“同用户其他设备持有活跃租约”维度上的口径。
4. **优化接入弹窗在纯服务端任务场景的交互**：当预检仅发现 `serverOnly > 0`（无本地独有、无冲突、无结构异常）时，去掉警告态与双差异按钮，直接提供一键接入并同步服务端任务。
5. **补齐冲突处理后的游标收尾对称性**：`overwrite-server` 成功后推进本地游标到最新 revision，`use-server` 成功后同步上报服务端游标。

## Background

在接入本地 Git 项目及日常实时同步的梳理中，对照近期任务控制面（`sync_task` 本人可见性、活跃租约、归档退出同步、预检口径对齐 `1db54ff`）的改造，确认存在以下遗漏与不一致：

1. **桌面端写状态 IPC 仍创建临时 `TaskSync`**：`1db54ff` 仅修复了 `decide_live_change`，而 `resolve_initial_sync`、`sync_deferred_tasks`、`set_task_ownership`、`download_task`、`reopen_conflicts` 仍在 `agent_service.rs` 中新建临时 `TaskSync`，绕过运行态 `task_space_sync_lock`，且不更新运行中的内存 `bindings`、`cursor_state`、`task_control_state` 与 `suppressed`。
2. **`download_task` 落盘先于只读标记**：`local_files.rs::download_task` 先 `write_task_directory` 再 `mark_readonly_dir` 且未写入 `suppressed`，存在 watcher 抢跑触发误上传的竞态窗口。
3. **`pull.rs` 的 `after_revision == 0` 兜底分支漏过滤**：未调用 `gate_local_only_differences`，且计算 `local_only` 时未排除 `readonly_dirs`，导致只读副本触发多余上传并返回 `skipped: true` 后被误判为 `pendingReview: true`。
4. **预检与首次同步存在租约口径差**：服务端 `POST /api/agent/task-spaces/preflight` 仅按 `assignee_user_id = ? AND archived = 0` 筛选，未排除已被同用户其他设备持有有效租约的任务；而首次同步 `prepare_controlled_server_groups` 会在 `claim_remote_task` 收到 `TASK_LEASE_HELD` 时静默跳过，导致预检报有 N 个服务端独有任务、点击接入后实际可落地差异为空。
5. **接入弹窗纯 `serverOnly` 场景交互过度**：`ProjectOnboardingDialog.tsx` 将 `serverOnly > 0` 与本地独有/冲突/异常混为一谈，展示橙色警告「本地与服务端的任务需要确认」以及「仅同步无冲突项」+ 主按钮「查看并处理差异」，误导用户以为存在冲突。
6. **冲突处理收尾游标不对称**：`decide_conflict("overwrite-server")` 保留旧 `cursor.revision` 未采纳服务端返回的新 `revision`；`decide_conflict("use-server")` 更新本地游标后未调用 `write_server_cursor`。

## Requirements

- **R1 桌面端写状态 IPC 统一复用运行态 `TaskSync`**：
  - `resolve_initial_sync`、`sync_deferred_tasks`、`set_task_ownership`、`download_task`、`reopen_conflicts` 在后台 `AgentRuntime` 运行且持有目标 `task_space_id` 绑定时，必须复用运行中的 `TaskSync` 并在该任务空间的 `task_space_sync_lock` 下串行执行。
  - 当后台未运行或目标任务空间未在运行态注册时，平滑回退到临时 `TaskSync`。
  - 保持所有现有 Tauri command 签名、返回值与权限配置不变。
- **R2 只读下载防 watcher 竞态**：
  - `download_task` 必须先登记 `readonly_task_dirs` 并为目标文件集合写入 `suppressed`，再执行 `write_task_directory`。
  - 若 `write_task_directory` 失败，回滚已登记的 `readonly_task_dirs` 与 `suppressed`（不留脏状态）。
- **R3 `pull.rs` 零游标兜底分支口径对齐**：
  - `pull_tracking` 的 `after_revision == 0` 分支在 `classify_task_snapshots` 之后必须执行 `gate_local_only_differences`。
  - 计算 `local_only` 上传集合时必须过滤 `readonly_dirs`（与 `deferred`、`inactive_dirs` 一致），不得因只读副本触发 `upload_directories` 并误置 `pendingReview: true`。
- **R4 服务端接入预检对齐活跃租约口径**：
  - `POST /api/agent/task-spaces/preflight` 传入当前 `agent.id`（未提供时保持兼容），在查询 `preflightFiles` 时排除“当前被其他设备（`lease.agent_id <> agent.id`）持有有效活跃租约（`status = 'active'` 且未过期）”的任务。
  - 响应体保持只读、零写库、不含任何文件正文 `"content"`；与旧客户端/无租约数据完全兼容。
- **R5 接入弹窗区分「纯服务端任务」与「需确认差异」**：
  - 当 `preflight.status === 'existing'` 且仅存在 `serverOnly > 0`（`localOnly === 0 && conflicts === 0 && invalid === 0`）时：
    - 预检卡片使用中性信息态（非警告色），明确告知服务端有 N 个任务将在接入后同步到本地，同时继续展示差异任务明细列表。
    - 底部按钮收敛为 `暂不接入` + 主按钮 `接入并同步服务端任务`（调用 `associate('safe')`），不再展示 `仅同步无冲突项` 与 `查看并处理差异`。
  - 当存在 `localOnly > 0`、`conflicts > 0` 或 `invalid > 0` 时，保持现有警告提示与 `暂不接入` / `仅同步无冲突项` / `查看并处理差异` 交互不变。
- **R6 冲突处理收尾游标对称**：
  - `decide_conflict("overwrite-server")` 成功后若服务端返回更高的 `revision`，本地 cursor 推进至 `cursor.revision.max(server_revision)`。
  - `decide_conflict("use-server")` 成功后除更新本地 cursor 外，同步调用 `write_server_cursor` 上报最新 revision。

## Out of Scope

- 不删除或重构服务端遗留的 `POST /api/agent/task-spaces/:id/preflight` 接口（待后续单独确认清理）。
- 不变更 SQLite 表结构，不新增 Tauri command 或 capability 权限。
- 不改变 `LiveSyncControlDialog` 在真实存在冲突/本地独有任务时的逐项决策交互。

## Acceptance Criteria

- [ ] **R1 桌面端运行态复用单测（Rust）**：运行中的 `TaskSync` 执行 `resolve_initial_sync`、`sync_deferred_tasks`、`download_task`、`reopen_conflicts` 等操作后，内存中的 `bindings`、`cursor_state`、`suppressed` 与磁盘一致，串行锁生效且不触发额外误上传。
- [ ] **R2 只读下载竞态单测（Rust）**：`download_task` 在落盘前已完成 `readonly_task_dirs` 与 `suppressed` 登记；若落盘失败不遗留脏 `readonly_task_dirs` 记录；落盘后同目录变更事件被 `suppressed` / `readonly_task_dirs` 正确拦截不上传。
- [ ] **R3 零游标兜底过滤单测（Rust）**：`pull_tracking` 在 `initial_sync_completed = true` 且 `cursor.revision = 0` 时，本地存在只读副本或服务端已归档/他人任务目录，不会触发误上传，也不会卡在 `pendingReview: true`，cursor 正常推进。
- [ ] **R4 服务端预检租约单测（Server）**：`POST /api/agent/task-spaces/preflight` 对当前用户自己持租约或无租约的活跃任务正常返回；对同用户其他设备持有未过期活跃租约的任务不计入 `tasks`；对已过期租约的任务正常返回；数据库零写入且不含 `"content"`。
- [ ] **R5 前端接入弹窗单测（Web）**：`ProjectOnboardingDialog` 在 `serverOnly > 0 && localOnly === 0 && conflicts === 0 && invalid === 0` 时显示中性提示与单个主按钮「接入并同步服务端任务」且点击传入 `'safe'`；存在 `localOnly`、`conflicts` 或 `invalid` 时仍展示「仅同步无冲突项」和「查看并处理差异」。
- [ ] **R6 冲突收尾游标单测（Rust）**：`decide_conflict("overwrite-server")` 成功后本地 cursor revision 更新到服务端返回值；`decide_conflict("use-server")` 成功后向服务端上报 cursor revision。
- [ ] **全量验证门禁通过**：`cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml`、`yarn test`、`yarn --cwd packages/web lint`、`yarn build`、`npx oxfmt --check .` 全部通过。

## Risks

- **锁顺序与重入死锁**：`agent_service.rs` 在获取 `task_space_sync_lock` 后调用 `TaskSync` 方法时，必须确认被调用方法内部不会再次获取同一把 `task_space_sync_lock`（如 `reopen_conflicts`、`resolve_initial_sync`、`sync_deferred_tasks`、`set_task_ownership`、`download_task` 均需核查调用链）。
- **`preflight` 租约时间基准**：服务端判断活跃租约过期时间需与 `task-control/views.js` 的 `activeLease`（`status = 'active' AND expires_at > now`）保持同一时间格式与比较口径。
- **前端文案/测试耦合**：更新纯 `serverOnly` 按钮文案后，需同步检查现有 Web 单测与 E2E 断言是否依赖旧按钮文案。
