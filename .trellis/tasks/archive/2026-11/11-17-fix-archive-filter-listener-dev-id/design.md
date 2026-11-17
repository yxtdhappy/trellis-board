# 设计：归档项目过滤、监听状态即时收敛、Trellis developer ID 展示

## 1. 缺陷 1：归档项目筛选并入全局筛选

### 机制

`filters.projectId` 成为归档页项目筛选的唯一真源；`ArchiveView` 由自管理改为受控，右上角下拉作为第二个控制面回写全局。

```text
ProjectRail.onSelect(id) ─┐
                          ├─> setFilters({ projectId })  ─> filters.projectId
ArchiveView 项目下拉 onChange ┘                                   │
                                                                  ▼
                                        <ArchiveView projectId={filters.projectId}
                                                     onProjectChange={…} />
                                                                  │
                                        useEffect([projectId]) → setArchiveProjectId(projectId) + 回第一页
```

### 改动点

- `packages/web/src/features/board/ArchiveView.tsx`
  - props 增加 `projectId: string`、`onProjectChange: (id: string) => void`。
  - `archiveProjectId` 保留为派生选择器状态，但由 `useEffect` 从 `projectId` 同步；同一 effect 里 `setPage(0)` 满足「筛选变化清游标回第一页」的既有规范。
  - 项目下拉 `onChange`：`onProjectChange(id)` + `setArchiveProjectId(id)`，不再只改本地 state。
  - 团队下拉 `onChange`：团队变化后若 `projectId` 不属于新团队，则 `onProjectChange('all')`（同时重置本地 state），保持两个控制面一致。
  - `effectiveProjectId` 的合法性判定改为针对**全部项目**而不是 `availableProjects`：左侧选中的项目被页面团队筛选隐藏时，不静默退化为「全部项目」，只隐藏下拉里的选项（下拉显示当前值即可）。
- `packages/web/src/pages/board/BoardPage.tsx`
  - `ArchiveView` 传 `projectId={filters.projectId}`、`onProjectChange={(id) => setFilters({ projectId: id })}`。

### 风险

- `useArchiveTasks` 已按 `projectId` 参数请求并返回 `[...rows, more]`；`projectId` 变化触发 reload 依赖需复核，避免双请求。设计上沿用现有依赖数组，只把来源换成受控值。
- 独立模式（非 teamMode）`rows` 过滤同样用 `effectiveProjectId`，天然跟随。

## 2. 缺陷 2：监听状态从「轮询发现」改为「变化推送」

三段延迟各自补一个最短通路，前端刷新策略不变。

### 2.1 桌面端：可唤醒的心跳循环

- `AgentRuntime` 新增字段 `heartbeat_wake: Arc<Notify>`（`runtime.rs` 已 `use tokio::sync::Notify`）。
- `AgentRuntime::start` 创建 `Arc::new(Notify::new())`，`TaskSync::new(...).with_state_sink(...).with_heartbeat_wake(handle.clone())`，并存进 runtime 字段。
- `spawn_heartbeat_loop` 的 `tokio::select!` 增加第三分支 `_ = wake.notified() => {}`（`wake` 在循环外 clone，避免借用冲突）。被唤醒后立即执行一轮 `heartbeat_once()`；成功仍把 `next_delay` 置回 `HEARTBEAT_INTERVAL`，失败沿用指数退避。`Notify` 只保留一个 permit，天然合并突发事件，不会产生心跳风暴。
- `TaskSync` 新增字段 `heartbeat_wake: Option<Arc<Notify>>` + builder `with_heartbeat_wake` + `fn wake_heartbeat(&self)`。触发点：
  - `finish_binding_sync`：一个 taskSpace 真正从 `syncing_task_spaces` 移除时（含提前 return 的分支）；
  - `set_bindings`：`association_map_unchanged` 为 false，即 approved binding 集合真实变化时。
- 语义不变：首次同步进行中的分支仍在 `active_bindings()` 之外，唤醒只是把「同步完成」这一刻立刻告知服务端，不会让未同步完的分支被算作监听。

### 2.2 服务端：监听集合变化发布 Board 事件

- `createSyncAgentService({ db, config, events, now, staleMs })` 的 `events` 已有 `publishAgentRevoked`；本次复用 `events` 额外调用 `events?.publishBoardChanged?.()`（`agent-events` 不实现也无害，装配侧提供）。
- `heartbeat()`：在事务前（仅当 `listenerReport` 非 null 时）读取当前 `SELECT task_space_id FROM sync_agent_binding WHERE agent_id = ? AND is_listening = 1` 作为 `previousListeningTaskSpaceIds`；事务提交后与 `acceptedListeningTaskSpaceIds` 比较集合，不同则调用一次 `events?.publishBoardChanged?.()`。
- 装配：`team/http.js` 构造 `createSyncAgentService({ db, config, events: { publishAgentRevoked: agentEvents.publishAgentRevoked, publishBoardChanged: () => boardEvents.publish({}) } })`。`boardEvents.publish({})` 已有 debounce（50ms）与 `event: tasks.changed` 载荷，Web 端无需任何改动。
- 不做的事：心跳过期不清扫、不改 ETag、不改五态派生、不改 `agentStaleMs`。

### 2.3 端到端时序

```text
客户端 sync_task_spaces 完成 ──finish_binding_sync──> wake_heartbeat (Notify)
        │ heartbeat_once 立即 POST /api/agent/heartbeat (listeningTaskSpaceIds=[ts])
        ▼
服务端 heartbeat 事务写 is_listening，比较集合变化 → boardEvents.publish({})
        ▼
Web EventSource 收到 tasks.changed → 300ms 防抖 → GET /api/team/status (if-none-match)
        ▼
ETag 变化 → setTeamStatus → ProjectRail 「在线监听 1/已关联 1」
```

兜底路径不变：页面可见时每 10 秒条件请求一次，客户端被强杀时仍靠它收敛。

## 3. 缺陷 3：项目级 Trellis developer ID

### 3.1 监听详情

- `packages/server/team/task-space-service.js` 的 `listenerDetails` SQL 增加
  `LEFT JOIN sync_project_member m ON m.project_id = s.project_id AND m.user_id = a.user_id`，
  select `m.trellis_dev_id`，map 输出 `trellisDevId: row.trellis_dev_id || null`。
- `packages/web/src/api/board.ts` 的 `TaskSpaceListener` 增加 `trellisDevId?: string | null`。
- `BranchListenersDialog.tsx` 在 `listener.trellisDevId && listener.trellisDevId !== listener.username` 时渲染 `Trellis ID：{listener.trellisDevId}`。

### 3.2 项目级 dev id 的数据来源

设计初稿假设 Web 可以用 `normalizeProjectMembers(project).find(m => m.userId === currentUserId)` 定位当前用户的成员记录，但 `/api/team/status` 的项目条目实际 `members` 恒为 `[]`（`projectPublic` 在 `Map` 上取 `.role`，见 `task-space-service.js:262`），`workspaceMembers` 又只有 dev id 字符串，没有 userId。因此改为服务端直接给出当前用户的项目级 dev id：

- `packages/server/team/task-space-service.js` 的 `projectPublic(row, access, actor = null)` 增加一个字段
  `trellisDevId: actor ? access.projectMembers.get(row.id)?.get(actor.userId)?.trellisDevId || null : null`。
- `listReadable` 调用时传 `actor`（`projectPublic(row, access, actor)`），其它调用点保持默认 `null`，管理端接口与 payload 不变。
- `/api/team/status` 的 `projects` / `associationProjects` 因此天然带上该字段；`useBoard` 已透传原始项目行，Web 端 `Project` 类型补 `trellisDevId?: string | null` 与 `remoteIdentityHash?: string | null`。
- 该字段只暴露「请求者自己在各项目的 dev id」，不泄露其他成员信息。

### 3.3 初始化编码 Agent 默认值

- `ProjectRail` 复用现有 `quickAgentTaskSpaceId`，在渲染前算出 `quickProject = projects.find(p => p.taskSpaces?.some(ts => ts.id === quickAgentTaskSpaceId))`，默认值取 `quickProject?.trellisDevId?.trim() || defaultDeveloperId`（`defaultDeveloperId` 仍是 username）。
- 不需要新增 `currentUserId` prop，也不需要 `BoardPage` 改动。
- `AgentQuickInitDialog` 不改动：`developerIdEdited` 已保证用户手动输入不被覆盖。

### 3.4 关联本地 Git 仓库默认值

- 数据链路：`inspect_local_project` 返回的 `project.remoteIdentityKey` 与 `sync_project.remote_identity_hash` 同源（服务端 `gitRemoteIdentityKey`，客户端 attach 时也用它校验 `binding.remote_identity_key`），因此 `inspection.remoteIdentityKey === project.remoteIdentityHash` 是可靠的匹配键。
- 补数据：`packages/web/src/lib/project-inspection.js` 的 `normalizeProjectInspection` 保留 `remoteIdentityKey: text(project.remoteIdentityKey)`，`project-inspection.d.ts` 补该字段。
- 纯函数：`packages/web/src/lib/team-client.js` 新增
  `pickProjectTrellisDevId(projects, remoteIdentityKey, fallback)`：按 `remoteIdentityHash` 匹配项目，返回其非空 `trellisDevId`，否则返回 `fallback`；`team-client.d.ts` 同步声明。
- `ProjectOnboardingDialog` 新增 prop `projects`（`ProjectRail` 直接传已有的 `projects`），内部
  `const preferredDeveloperId = pickProjectTrellisDevId(projects, inspection?.remoteIdentityKey, defaultDeveloperId)`。
- 默认值写入点：把现有「`if (!open || developerIdEdited.current) return; setDeveloperId(...)`」effect 的写入值与依赖从 `defaultDeveloperId` 换成 `preferredDeveloperId`。扫描前 `inspection` 为 null，结果等同旧行为（username）；扫描返回后若命中项目则改写为项目级 dev id；`developerIdEdited` 为 true 时始终不覆盖。
- 首次打开时的 `defaultsKey` 重置 effect 保持写 `defaultDeveloperId`（此时还没有扫描结果），避免与「扫描后更新」逻辑重复。

### 3.5 已知限制

- `/api/team/status` 项目条目的 `members` 恒为空是既有缺陷，本次不修，也不依赖它。

### 3.6 已存在成员的 dev id 修正（R4）

- 位置：`packages/server/team/task-space-service.js` `attach()` 读取成员之后。
- 逻辑：`if (!member) { …INSERT… } else if (developerId && developerId !== member.trellis_dev_id) { UPDATE sync_project_member SET trellis_dev_id = ?, updated_at = ? WHERE project_id = ? AND user_id = ? }`。
- 安全性：`developerId` 为空时不动原值；客户端仍可能提交与现有值相同的 username（无变化则不写）；只更新调用者自己的成员行（`user_id = userId`），不触碰他人。
- 生效路径：mine 过滤在查询期 join `sync_project_member`（`packages/server/team/task-space-index.js:1314-1324`），且查询 ETag/缓存键包含 `mineMembers`（`mineMemberSignature`，`task-space-index.js:467`），dev id 变更后下一次 `/api/tasks/query?scope=mine` 即按新值过滤，无需重建索引或重启。
- 失败风险：若客户端把 username 当作「用户确认过的值」重复提交，会把已修正的 dev id 回写成 username。缓解：R3.4 已让扫描完成后默认值取项目级 `trellisDevId`（即当前库值），用户不编辑时提交值与库值相同，不会回写；只有用户显式改动才更新。

### 3.7 dev 模式恢复团队状态轮询（R5）

- 位置：`packages/web/src/lib/refresh-coordinator.js` + `packages/web/src/hooks/useBoard.ts:111-114`。
- 逻辑：协调器新增 `activate()`（重置 `disposed = false`、`pending = false`、`inFlight = null`）；`useBoard` 的 effect 在 body 中调用 `teamStatusRefresh.activate()`，cleanup 仍 `dispose()`。StrictMode 的 cleanup → remount 因此等价于「暂停 → 恢复」，而非「永久关闭」。
- 覆盖范围：同一模式只影响 `/api/team/status` 协调器；`EventSource`、10 秒定时器本来就在 effect 内创建与销毁，不受影响。
- 验证：`packages/web/test/refresh-coordinator.test.js` 新增「StrictMode 重新挂载后恢复调度」，实机在 `vite dev` 下核对 `/api/team/status` 请求出现、项目栏渲染；对照实验（临时回退 effect）请求数为 0。

### 3.8 监听集合只按首次同步完成判定（R6）

- `active_bindings()`：`bindings.retain(|b| b.initial_sync_completed && !b.detach_pending)`，不再参考 `syncing_task_spaces`。
- 理由：监听是「该分支是否由本客户端接管」，不是「此刻是否在传输数据」。长增量补拉与被 `shutdown` 取消的启动同步都会让 `syncing_task_spaces` 计数长期为 1，旧判定把在线客户端永久标成离线。
- 保留语义：首次同步未完成的绑定仍不进监听集合（`.trellis/spec/backend/desktop-realtime-sync.md`），首次同步完成后立即心跳（见 2.1）。
- 风险：首次同步仍在进行时服务端显示已监听，任务命令可能等待；由既有 `wait_for_binding_sync` 与「启动同步完成」日志兜住。

## 4. 契约与不变式

- 归档项目筛选：`filters.projectId` ↔ 归档页项目下拉单向受控 + 回写，二者永不出现不同值。
- 心跳：`listenerReportVersion=1` + 最多 64 个去重 id 的完整快照语义不变；同步中分支不进快照；唤醒只影响发送时机。
- Board SSE：只发 `tasks.changed`，不携带监听细节；Web 仍通过 `/api/team/status` 取状态。
- listeners 接口：`trellisDevId` 可空；无项目成员记录时为 null，前端不展示标签。
- `/api/team/status` 项目条目：新增 `trellisDevId` 只代表请求者自己的项目成员 dev id；其余字段与 ETag 计算范围不变。
- dev id 默认值：`trellisDevId` 优先，空则 username；用户手动编辑（`developerIdEdited`）后任何刷新都不覆盖。
- 成员 dev id 修正：`attach` 仅在显式、非空、且与库值不同时更新调用者自己的成员行；不改他人、不清空。

## 5. 验证策略

- `packages/web/test/*.test.js`：新增/扩展纯函数级断言（归档项目筛选联动可抽成纯函数；`pickProjectTrellisDevId(projects, remoteIdentityKey, fallback)` 断言命中、缺失 `trellisDevId`、空 `remoteIdentityKey`、无匹配四种回退）。
- `packages/server/test/`：`sync-agent-service` 心跳在监听集合变化时调用 `publishBoardChanged` 一次、不变时零次；`listenerDetails` 返回 `trellisDevId`（用现有 team 测试夹具建 project_member）；`/api/team/status` 项目条目带当前用户 `trellisDevId`、非成员为 null；`attach` 在已存在成员时按显式 dev id 更新、空值不覆盖，且更新后 `scope=mine` 能命中该 dev id 的任务（扩展 `packages/server/test/team-task-mine-scope.test.js`）。
- `cargo check`（`packages/desktop/src-tauri`）验证唤醒通道编译，Rust 侧不引入新依赖。
- 手工闭环：`yarn desktop:dev` 接入一个新项目，观察 ProjectRail 在线监听计数从 0 到 1 的耗时（目标 ≤3s）；停监听观察回落；归档页左侧选项目后列表文件行数变化；已存在项目的仓库走「关联本地 Git 仓库」观察 dev id 预填与手动编辑保护。
- `yarn format:check`（oxfmt）。
