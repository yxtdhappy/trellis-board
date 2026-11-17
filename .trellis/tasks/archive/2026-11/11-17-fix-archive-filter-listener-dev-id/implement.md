# 执行计划

依赖顺序：先接口/数据（R3 服务端）→ 再 Web 受控（R1、R3 UI）→ 再桌面端唤醒（R2.1）→ 再服务端事件（R2.2）→ 最后验证与规范更新。

## 1. R3 服务端：项目条目与 listeners 的 trellisDevId

- `packages/server/team/task-space-service.js`：
  - `projectPublic(row, access, actor = null)` 增加 `trellisDevId: actor ? access.projectMembers.get(row.id)?.get(actor.userId)?.trellisDevId || null : null`；`listReadable` 传 `actor`，其它调用点保持默认。
  - `listenerDetails` 的 SQL 增加
    `LEFT JOIN sync_project_member m ON m.project_id = s.project_id AND m.user_id = a.user_id`，
    select 增加 `m.trellis_dev_id`，map 增加 `trellisDevId: row.trellis_dev_id || null`。
  - `attach()` 成员分支：已存在成员且 `developerId` 非空且与 `member.trellis_dev_id` 不同时更新 `trellis_dev_id` / `updated_at`（只更新 `project_id + user_id` 这一行）。
- 验证：`packages/server/test/` 下补断言（listeners 有 dev id / 无记录为 null；`/api/team/status` 项目条目带当前用户 dev id、非成员为 null；`attach` 更新显式 dev id、空值不覆盖，更新后 `scope=mine` 命中）。

### 1.1 R5 dev 模式轮询恢复

- `packages/web/src/lib/refresh-coordinator.js`：新增 `activate()`；`packages/web/src/hooks/useBoard.ts` 的 effect 先 `activate()` 再返回 `dispose()` cleanup。
- 验证：`packages/web/test/refresh-coordinator.test.js` 新增 StrictMode 重挂载用例；`yarn web:dev` 实机确认 `/api/team/status` 有请求（对照：临时回退 effect 后为 0）。

## 2. R1 归档项目筛选受控

- `ArchiveView.tsx`：新增 `projectId` / `onProjectChange` props；`useEffect` 同步 + 回第一页；项目下拉与团队下拉回写；`effectiveProjectId` 合法性按全部项目判定。
- `BoardPage.tsx`：`<ArchiveView projectId={filters.projectId} onProjectChange={(id) => setFilters({ projectId: id })} … />`。
- 验证：`packages/web/test/` 补纯函数断言（项目合法性/团队联动选择器），并手工验证左侧切换。

## 3. R3 前端展示与默认值

- `packages/web/src/api/board.ts`：`TaskSpaceListener` 增加 `trellisDevId?: string | null`；`Project` 增加 `remoteIdentityHash?: string | null`、`trellisDevId?: string | null`。
- `packages/web/src/lib/project-inspection.js` / `.d.ts`：`normalizeProjectInspection` 保留 `remoteIdentityKey`（字符串，缺失为 `''`），类型补字段。
- `packages/web/src/lib/team-client.js` / `.d.ts`：新增纯函数
  `pickProjectTrellisDevId(projects, remoteIdentityKey, fallback)`（按 `remoteIdentityHash` 命中项目 → 非空 `trellisDevId`，否则 `fallback`）。
- `BranchListenersDialog.tsx`：dev id 与 username 不同时渲染 `Trellis ID：…`。
- `ProjectRail.tsx`：按 `quickAgentTaskSpaceId` 找到项目，`AgentQuickInitDialog` 的 `defaultDeveloperId` 改为 `project.trellisDevId?.trim() || defaultDeveloperId`；`ProjectOnboardingDialog` 传 `projects`。
- `ProjectOnboardingDialog.tsx`：props 增加 `projects`；用 `pickProjectTrellisDevId(projects, inspection?.remoteIdentityKey, defaultDeveloperId)` 计算 `preferredDeveloperId`，替换现有「未编辑则重置」effect 的写入值与依赖；`defaultsKey` 首次重置 effect 保持 `defaultDeveloperId`。
- 验证：纯函数单测 + 手工打开三个弹窗（监听详情、初始化编码 Agent、关联本地仓库）。

## 4. R2.1 桌面端可唤醒心跳

- `packages/desktop/src-tauri/src/agent/task_sync.rs`：
  - 结构体新增 `heartbeat_wake: Option<Arc<Notify>>`（`new` 里 `None`）；
  - `with_heartbeat_wake` builder + `fn wake_heartbeat(&self)`；
  - `finish_binding_sync` 两处（提前 return 与尾部）在 `binding_sync_idle.notify_waiters()` 后调用；
  - `set_bindings` 在 `changed` 为 true 时调用。
- `packages/desktop/src-tauri/src/agent/runtime.rs`：
  - 字段 `heartbeat_wake: Arc<Notify>`；`start` 里创建并 `with_heartbeat_wake(...)`；
  - `spawn_heartbeat_loop` 增加 `notified()` 分支，唤醒后立即心跳，成功后 `next_delay = HEARTBEAT_INTERVAL`，失败沿用退避；`is_paused()` 时仍跳过并保持 15s。
- 验证：`cargo check`（`packages/desktop/src-tauri`）；不新增依赖。

## 5. R2.2 服务端监听变化事件

- `packages/server/team/sync-agent-service.js`：`heartbeat` 在 `listenerReport` 非 null 时事务前读 `is_listening=1` 集合，事务后比较，变化则 `events?.publishBoardChanged?.()`。
- `packages/server/team/http.js`：`createSyncAgentService({ db, config, events: { publishAgentRevoked: …, publishBoardChanged: () => boardEvents.publish({}) } })`。
- 验证：`packages/server/test/` 补两类断言（集合变化发布一次、不变零次），已有 `team-agent-slot.test.js` 的 `events` 桩只提供 `publishAgentRevoked`，需保持可选调用不报错。

## 5.1 R6 监听集合判定

1. `packages/desktop/src-tauri/src/agent/task_sync.rs`：`active_bindings()` 改为 `retain(|b| b.initial_sync_completed && !b.detach_pending)`；`syncing_task_spaces` 不再参与判定。
2. 单测：新增 `initial_sync_pending_binding_not_listening()`；`startup_bindings_activate_before_background_pull()` 的首个断言改为 `active_bindings().len() == 1`。
3. 实机：`yarn desktop:dev` 关联后确认 `sync_agent_binding.is_listening = 1`、日志有 `启动同步完成 … elapsedMs=`、左栏「在线监听 1/已关联 1」；期间可同时有长同步进行。

## 6. 验证与收尾

- `yarn test`（Node 内置测试）。
- `yarn format:check`；对改动文件执行 `yarn format`（oxfmt）。
- `cargo check --manifest-path packages/desktop/src-tauri/Cargo.toml`。
- 手工闭环（需真实客户端与服务）：新项目接入后在线监听 ≤3s 收敛；停监听回落；归档左侧切项目过滤生效；监听详情、初始化编码 Agent、关联本地仓库三个弹窗的 dev id 展示与预填；把项目成员 dev id 从错误值改成真实 Trellis dev id 后，执行视图「只看我的」立即恢复。
- 更新规范：`.trellis/spec/backend/desktop-realtime-sync.md`（监听集合变化发布 Board 事件、同步完成立即心跳）、`.trellis/spec/backend/desktop-agent-runtime.md`（心跳唤醒通道）、`.trellis/spec/frontend/rendering-and-state.md`（归档项目筛选继承 `filters.projectId`）。
