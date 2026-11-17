# 修复归档项目过滤、监听状态推送延迟与 Trellis developer ID 展示

## Goal

修掉四个客户端可见缺陷：左侧项目栏的项目选择必须作用到归档索引；新接入项目的「在线监听」状态必须在本地首次同步完成后及时（秒级）反映到看板，而不是等 15 秒心跳 + 10 秒轮询；项目级 Trellis developer ID 与账号 username 不一致时，初始化编码 Agent 弹窗与分支监听详情弹窗必须默认/展示该项目的 Trellis developer ID；项目成员 dev id 写错时必须能在关联流程中纠正，让执行视图「只看我的」恢复正常。

## Background

### 缺陷 1：归档索引忽略左侧项目选择

- `packages/web/src/pages/board/BoardPage.tsx:294-305` 的 `ProjectRail` 用 `current={filters.projectId}` + `onSelect={(id) => setFilters({ projectId: id, taskSpaceId: 'all' })}` 写入全局项目筛选。
- 同文件 `BoardPage.tsx:407-418` 的 `<ArchiveView …>` 既没收到 `filters.projectId`，也没有回写通道；`packages/web/src/features/board/ArchiveView.tsx:47-48` 自建 `archiveTeamId` / `archiveProjectId`，初始化一律 `'all'`。
- 结果：左侧选了具体项目，归档页仍显示全部项目的归档任务，只有归档页右上角自己的「项目」下拉有效。
- 该状态是 11-15 归档筛选任务（`.trellis/tasks/archive/2026-11/11-15-archive-index-team-project-filter/prd.md`）刻意设计的「页面内筛选独立、不继承左侧项目栏」。本次需求**明确推翻该条**：项目筛选改为单一来源（全局 `filters.projectId`），团队筛选仍保持页面内独立。

### 缺陷 2：新接入项目「在线监听」状态延迟

三段等待串联起来放大了延迟：

1. 桌面端心跳间隔 `HEARTBEAT_INTERVAL = 15s`（`packages/desktop/src-tauri/src/agent/runtime.rs:21`），`spawn_heartbeat_loop`（`runtime.rs:122-165`）只有 `shutdown.changed()` 与 `sleep(next_delay)` 两个分支，没有「立即心跳」通道。
2. 心跳上报的监听集合来自 `TaskSync::active_bindings()`（`packages/desktop/src-tauri/src/agent/task_sync.rs:3102-3114`），会剔除仍在 `syncing_task_spaces` 里的分支；`finish_binding_sync`（`task_sync.rs:1521-1590`）只 `notify_waiters()`，既不触发心跳也不通知状态变化。因此「本地首次同步完成」这个时刻服务端完全不知道，只能等下一次心跳。
3. 服务端心跳（`packages/server/team/sync-agent-service.js:408-560`）更新 `sync_agent_binding.is_listening` / `listener_reported_at` 后不发布任何 Board 事件；Board SSE（`packages/server/board-events.js`）只在任务快照 revision 变化时 `publish`，Web 端 `packages/web/src/hooks/useBoard.ts:270-313` 因此只能在 10 秒兜底轮询里感知监听状态变化。

净效果：新项目接入后「已关联·正在同步」很快变成「同步正常」，但「在线监听 0/已关联 1」要等最多约 25 秒才变成「在线监听 1/已关联 1」。

### 缺陷 3：Trellis developer ID 未展示

- Trellis developer ID 是**项目级**绑定，存放在 `sync_project_member.trellis_dev_id`（每项目一份），与 `user_account.username` 经常不同。
- 初始化编码 Agent：`BoardPage.tsx:298` 传给 `ProjectRail` 的 `defaultDeveloperId={runtime?.user?.username || ''}`，`ProjectRail.tsx:993` 原样转给 `AgentQuickInitDialog` 的 `defaultDeveloperId`，弹窗 `AgentQuickInitDialog.tsx:85-87` 用它预填「Trellis developer ID」输入框；用户不改就是 username，初始化会写入错误的 developer id。
- 监听详情：`packages/server/team/task-space-service.js:1280-1337` 的 `listenerDetails` 只 select `u.username` / `u.display_name`，未 join `sync_project_member`；`packages/web/src/api/board.ts:51-63` 的 `TaskSpaceListener` 无该字段，`BranchListenersDialog.tsx:100-140` 只能显示 `@username`。
- 关联本地 Git 仓库：`ProjectOnboardingDialog.tsx:309-312` 在 `developerIdEdited` 为 false 时一律写入 `defaultDeveloperId`（来自 `ProjectRail.tsx:1034`，即 username），即便该仓库对应的项目已配置过别的 `trellis_dev_id`；用户选择本地仓库、扫描完成后看到的默认值仍是 username。
- 数据来源限制：`/api/team/status` 的项目条目（`task-space-service.js:248-265` `projectPublic`）目前不含「当前用户在本项目的 dev id」；`members` 因 `projectMembers.get(row.id)?.role` 取到的是 `Map`（`.role` 恒为 `undefined`）而恒为 `[]`，`workspaceMembers` 只有 dev id 字符串、没有 userId，Web 端无法据此定位当前用户的项目级 dev id。

### 缺陷 4：「只看我的」因项目 dev id 写错而恒为空

- 服务端 mine 过滤按「仓库所属项目当前配置的成员 dev id」判定（`packages/server/team/task-space-index.js:1314-1324`：`mine.trellis_dev_id IS NOT NULL AND t.assignee_dev_id = mine.trellis_dev_id COLLATE NOCASE`），每次查询实时计算，不依赖索引重建。
- 生产库实测（`C:\Users\fenglei\AppData\Local\TrellisBoard\server\board.sqlite`）：项目 `trellis-board` 下唯一成员 `fenglei` 的 `sync_project_member.trellis_dev_id = 'fenglei'`，而任务索引里的 `assignee_dev_id` 是 `flyfly6`（29）/`yhj`（71）/`kyf`（9），`assignee_user_id` 全为 NULL。因此「只看我的」恒为 0。
- 错误值来源：首次关联时客户端把账号 username 作为默认 dev id 提交（`packages/web/src/pages/board/BoardPage.tsx:298` → `ProjectRail.tsx:1034` → `ProjectOnboardingDialog.tsx:309-312`），而 `attach()`（`packages/server/team/task-space-service.js:690-830`）只在成员不存在时 `INSERT`，已存在成员的 `trellis_dev_id` 永不更新。于是用户即使后来把弹窗里的 dev id 改对并重新关联，库里的值也不会变。
- 影响：`GET /api/tasks/query?...&scope=mine`（`packages/web/src/hooks/useBoard.ts:135-140` 的 `buildTaskQuery` 带上 `filters.scope`）全部返回 0，执行视图「只看我的」失效。
- 相关既有修复：`.trellis/tasks/archive/2026-11/11-13-python-gate-and-mine-filter/prd.md` R4 已把过滤从索引期冻结的 `assignee_user_id` 改为按成员当前 dev id；本次缺的是「让该 dev id 可被纠正」。

### 缺陷 5：客户端上报的监听集合恒空

- 真实桌面端关联完成后，服务端 `sync_agent_binding.is_listening` 恒 0、`agent_device.last_heartbeat_json` 中 `listeningTaskSpaceIds` 为 `[]`，与「已关联·同步正常」的界面状态矛盾。
- 原因见 R6：`active_bindings()` 以「同步进行中」排除绑定，而该状态在长同步与被取消的启动同步后会长期保留。

## Requirements

### R1 归档索引继承左侧项目筛选

- `ArchiveView` 新增受控入参 `projectId: string` 与 `onProjectChange: (id: string) => void`，`BoardPage` 传 `filters.projectId`，`onProjectChange` 走 `setFilters({ projectId: id })`。
- `filters.projectId` 是归档页项目筛选的唯一来源：左侧项目栏选中项目后，归档查询与独立模式的客户端过滤立即按该项目收窄，并从第一页开始。
- 归档页右上角「项目」下拉保留，作为同一状态的第二个控制面：选择后同时更新全局 `filters.projectId`，左侧项目栏高亮随之变化。
- 左侧切到「全部项目」时归档页回到全部项目。
- 归档页「团队」下拉保持页面内状态，只收敛项目选项；团队变化导致当前项目不属于该团队时，项目重置为「全部项目」并同步回全局 `filters.projectId`，避免两个控制面显示不一致。
- 项目选择合法性按全部可访问项目校验（而不是当前团队过滤后的选项），左侧选中的项目不会因页面团队筛选而静默退化为「全部项目」。

### R2 在线监听状态即时收敛

- 桌面端新增「立即心跳」唤醒：心跳循环除 15 秒定时与停机外，还能被显式唤醒并在唤醒后立刻心跳；唤醒信号合并，不产生心跳风暴。
- 本地首次（或增量）binding 同步完成、以及绑定集合真实变化时，客户端必须请求一次立即心跳，把新的 `listeningTaskSpaceIds` 快照尽快上报（保留「同步中分支不计入监听集合」的既有契约）。
- 服务端心跳事务完成后，若该 Agent 的监听集合相对上一次上报发生变化（`is_listening` 集合不同），发布一次 Board 事件（`tasks.changed`），让 Web 端按既有事件路径立即条件请求 `/api/team/status`。
- Web 端已有 SSE 处理与 10 秒兜底轮询保持不变；不新增前端轮询频率，不改 `/api/team/status` 的 ETag 契约。

### R3 展示项目级 Trellis developer ID

- 监听详情接口 `GET /api/task-spaces/:id/listeners` 的每个 listener 增加 `trellisDevId`（`sync_project_member.trellis_dev_id`，按 `project_id + user_id` 关联；无绑定为 `null`）。
- 监听详情弹窗在该用户的项目级 Trellis developer ID 存在且与 `username` 不同时，展示 `Trellis ID：<devId>`，与现有 `@username` 并存；相同或缺失时不展示该标签（避免重复展示同一个值）。
- `/api/team/status`（及 `associationProjects`）的每个项目条目增量返回 `trellisDevId`：当前用户在该项目的 `sync_project_member.trellis_dev_id`，无成员记录为 `null`；不新增接口。
- 初始化编码 Agent 弹窗的「Trellis developer ID」默认值改为：当前用户在该分支所属项目下的 `trellisDevId`；该项目没有绑定 dev id 时回退到现有 username。用户在弹窗内手动编辑后行为不变，不覆盖用户输入。
- 「关联本地 Git 仓库」弹窗（`ProjectOnboardingDialog`）在本地仓库扫描完成后，用扫描返回的 `remoteIdentityKey` 匹配可访问项目中 `remoteIdentityHash` 相同的项目，取该项目的 `trellisDevId` 作为「Trellis developer ID」默认值；匹配不到或该值为空时回退到现有 username。
- 关联弹窗的默认值只在用户未手动编辑时随扫描结果更新；用户一旦编辑就不再覆盖。

### R4 项目级 dev id 可修正，「只看我的」随即恢复

- `attach()` 对**已存在**的项目成员：当客户端显式提交非空 `developerId` / `trellisDevId` 且与 `sync_project_member.trellis_dev_id` 不同时，更新该字段与 `updated_at`；未提交或为空时保持原值，不清空、不覆盖。
- 修正后 `GET /api/tasks/query?scope=mine` 立即按新 dev id 过滤（查询期实时计算，无需重建索引、无需重启服务）。
- 已存在项目的「关联本地 Git 仓库」弹窗借助 R3 的预填展示当前（可能错误的）dev id，用户改成正确的 Trellis developer id 后重新关联即完成落库，不需要管理端或手工改库。
- 首次接入（项目中还没有该成员记录）仍以 username 作为回退默认值：此时没有任何可信来源，属已知限制，不在本次修复范围。

### R5 dev 模式恢复团队状态轮询

- 现象：`yarn web:dev` / `yarn desktop:dev` 的看板从不请求 `/api/team/status`，左侧项目栏只剩「全部项目」、项目数为 0；生产构建正常。
- 根因：`packages/web/src/main-board.tsx` 的 `<StrictMode>` 会 mount → cleanup → remount；`packages/web/src/hooks/useBoard.ts:91` 用 `useMemo` 创建的 `createRefreshCoordinator` 被 cleanup 里的 `dispose()` 永久关闭，重新 mount 时无人调用 `activate`，`request()` 直接返回 `Promise.resolve()`。
- 修复：`packages/web/src/lib/refresh-coordinator.js` 增加可重入的 `activate()`（清 `disposed`），`useBoard.ts` 的 effect 在 body 里先 `activate()` 再返回 `dispose` cleanup。生产构建行为不变（同一实例仅激活一次）。

### R6 「在线监听」不再被长同步/被取消同步卡死

- 现象：真实桌面端完成关联后，服务端 `sync_agent_binding.is_listening` 恒 0、`last_synced_at` 恒 `null`，客户端每次心跳上报的 `listeningTaskSpaceIds` 都是 `[]`，看板永远停在「在线监听 0/已关联 1」，即使心跳稳定每 15 秒到达。
- 根因：`packages/desktop/src-tauri/src/agent/task_sync.rs` 的 `active_bindings()` 剔除所有仍在 `syncing_task_spaces` 里的绑定；首次同步或增量补拉耗时数分钟，`runtime.rs` 启动期的 `tokio::select!` 在 shutdown 分支胜出时又会 drop 未完成的同步 future，计数永久残留 1，于是绑定永远不进监听集合。
- 修复：`active_bindings()` 只排除「首次同步尚未完成」（`initial_sync_completed == false`）与 `detach_pending` 的绑定，同步进行中不再影响监听上报；与 `.trellis/spec/backend/desktop-realtime-sync.md`「启动同步尚未完成 | 不进入监听集合」的语义一致。

## Constraints

- 不新增接口、不改数据库 schema、不改心跳协议版本与 `listenerReportVersion=1` 的权威快照语义。
- `/api/team/status` 只在项目条目上增量一个 `trellisDevId` 字段，其它字段与 ETag 依据不变。
- 保持「启动同步未完成的分支不进入监听集合」与「命令等待同步完成」的既有语义。
- 不改变归档页的搜索、分支模糊筛选、负责人筛选、分页与只读详情行为。
- 团队模式与独立模式的 `filters.projectId` 语义保持一致。

## Acceptance Criteria

- [ ] 左侧项目栏选中项目后，归档索引只显示该项目归档任务，且从第一页开始；切到「全部项目」恢复全部。
- [ ] 归档页右上「项目」下拉与左侧项目栏双向一致；在归档页切换团队导致项目不再属于该团队时，项目重置为「全部项目」且左侧高亮同步为「全部项目」。
- [ ] 归档页搜索、分支、负责人、分页、打开归档任务详情无回归；团队模式与独立模式都成立。
- [ ] 新接入项目在本地首次同步完成后，无需手动刷新，约 3 秒内左侧项目栏从「在线监听 0/已关联 1」变为「在线监听 1/已关联 1」。
- [ ] 客户端停止监听（正常退出/暂停）后，看板在一个心跳周期 + 事件推送内变为「未监听」；客户端被强杀时仍由既有 10 秒条件轮询兜底。
- [ ] 服务端在监听集合未变化的心跳上不发布 Board 事件（避免无意义刷新）。
- [ ] 监听详情弹窗对 dev id 与 username 不同的用户显示 `Trellis ID：<devId>`，相同/缺失时不显示。
- [ ] 初始化编码 Agent 弹窗在 dev id 与 username 不同时预填项目级 dev id；手动编辑后不被外部刷新覆盖。
- [ ] 关联本地 Git 仓库弹窗扫描完成后，已存在项目的仓库预填该项目级 dev id；用户手动编辑后重新扫描不覆盖；未配置项目成员时回退 username。
- [ ] 已存在成员在关联弹窗改成正确 dev id 并重新关联后，`sync_project_member.trellis_dev_id` 更新，`/api/tasks/query?scope=mine` 立即返回该 dev id 的任务，执行视图「只看我的」恢复（本机生产库把 `fenglei` 改为 `flyfly6` 后应看到 `flyfly6` 的任务）。
- [ ] 客户端提交空 dev id 时成员原 `trellis_dev_id` 保持不变。
- [ ] 真实桌面端关联项目后心跳立即上报监听：`sync_agent_binding.is_listening = 1`、`listener_reported_at` 随心跳推进，左栏显示「在线监听 1/已关联 1」，不随长同步或补拉回退为 0。
- [ ] `yarn web:dev`（StrictMode）下看板照常请求 `/api/team/status` 并渲染项目栏，行为与生产构建一致。
- [ ] `yarn test`（含 packages/web 与 packages/server 单元测试）通过；`packages/desktop/src-tauri` 的 `cargo check` 通过；`yarn format:check` 通过。
- [ ] 按实际运行方式（`yarn desktop:dev` 或客户端包）手工验证四条闭环，并在 `check.jsonl`/任务笔记记录证据。

## Open Questions

无。

## Out of Scope

- 不改归档页的其他筛选与布局，不新增筛选条件持久化 / URL 同步。
- 不改心跳协议版本、`listenerReportVersion` 语义、`agentStaleMs` 默认值。
- 不新增服务端定时清扫发布「心跳过期」事件的机制（继续用 10 秒条件轮询兜底）。
- 不调整 `AgentQuickInitDialog` / `ProjectOnboardingDialog` 的交互与校验逻辑，只改默认值来源。
- 不修复 `/api/team/status` 项目条目 `members` 恒为空的历史缺陷（本次改用项目级 `trellisDevId` 字段，不依赖 `members`）。
- 不自动推断/批量修复历史错误的 `trellis_dev_id`（只能由用户在关联流程或管理端显式纠正），也不重建任务索引。
