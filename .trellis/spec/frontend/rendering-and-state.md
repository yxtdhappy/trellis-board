# 渲染与状态

## 数据流

```text
/api/*（requestJson）
  → api/board.ts | api/admin.ts（类型守卫 + 归一化）
  → hooks/useBoard | useAdminConsole | useAdminProjects（唯一状态源）
  → pages/*（组合）
  → features/*（领域组件）
  → components/ui/*（shadcn 原语）
```

- 组件不直接 `fetch`；写操作通过 hook 暴露的 actions 调用，成功后重新拉取对应快照。
- 服务端快照（`board`、`teamPage`、`users`…）只由 API 成功响应更新；筛选、搜索、当前视图保存在 hook 内的 UI 状态。
- 能由 `board.tasks` 推导的显示值（进度、阶段、关注信号）在渲染期计算，不复制成长期状态。

## 事件、刷新与操作进度

- `useBoard` 在 runtime 确定后建立同源 `EventSource('/api/board/events')`。收到 `tasks.changed`、
  连接建立/重连、窗口 focus 或页面恢复可见时执行一次 REST 对齐，不按 750ms 轮询任务 revision。
- 独立模式收到事件后静默重载 `/api/board`；团队模式重载当前 `/api/tasks/query`、
  `/api/team/status` 和当前 taskSpace 的操作列表。
- `tasks.changed` 只携带轻量 revision；任务正文、conflict、command result 和 cursor 均通过 REST 获取。
- 团队模式 `/api/tasks/query` 使用 `if-none-match` 复用 ETag，304 时跳过状态更新。
  `/api/team/status` 同样使用 `if-none-match`；页面可见时最多每 10 秒条件请求一次，隐藏时停止，
  focus、页面恢复可见和 Board SSE 建立/重连时立即对齐一次。304 不调用 `setTeamStatus`。
- Tauri 本地关联和 sidecar 先注册 `desktop-state-changed` 再执行首次权威读取；事件只触发重新读取
  `list_local_associations` / `desktop_sidecar_status`，不作为业务状态本身。页面可见时保留 10 秒
  兜底，隐藏时停止；focus、恢复可见和监听恢复时立即对齐。
- `/api/task-operations?taskSpaceId=` 只在选中具体 taskSpace 时创建 3 秒刷新；结果稳定签名相同
  时保留原数组。单条创建/改派进度只对 `pending/delivered/running` 继续退避查询，进入
  `failed/succeeded/cancelled` 后停止，用户显式重试失败项后重新开始。
- `/api/tasks/query` 的 200 响应必须先经过 `normalizeTaskPage` 再写入 `teamPage`。团队接口可能只返回
  `relativeDir`，而任务卡使用 `dirName`；304 响应没有 body，保持 ETag 分支不规范化。
- EventSource 只随 runtime 生命周期创建，筛选和 teamId 变化不能反复断开重连；刷新回调通过 ref
  取最新版本。组件卸载时必须关闭 EventSource、清空合并计时器和所有状态轮询。
- 需要「单次在途 + 合并后续请求」的轮询走 `packages/web/src/lib/refresh-coordinator.js`。该协调器
  由 `useMemo` 持有、生命周期跨 StrictMode 的 cleanup→remount，因此 effect 必须在 body 里调用
  `activate()`、cleanup 里 `dispose()`：只写 `useEffect(() => () => coordinator.dispose())`
  会在 dev 双调用后永久关闭协调器（现象是 `/api/team/status` 永不发起、项目栏为空，生产构建正常）。
- taskSpace 切换必须清空旧分页 cursor、ETag、操作列表、冲突详情和负责人候选；请求序号阻止旧响应覆盖。
- 任务操作状态使用 `normalizeOperation()` 统一驼峰/下划线字段。`failed` 显示重试，`pending/delivered/running`
  显示“创建中/改派中”和取消；`succeeded` 后才重载正式任务和负责人。
- 本地关联、sidecar、Team 状态和同步确认弹窗的刷新均使用单一在途请求加一次 pending refresh；
  相同归一化结果必须复用原引用，不能因定时兜底重复创建 Map、数组或 React 状态。

## 多团队状态

- 团队筛选默认 `all`，只改变展示范围，不提交 Session。单团队成员无需额外点击；多团队用户使用受控筛选器。
- `teamId` 变化必须同时清空分页游标、ETag、旧任务页、保存视图和 WIP 设置，再分别请求 `/api/tasks/query`、`/api/saved-views` 与 `/api/board/settings`。
- 任务查询和团队偏好请求使用请求序号或其他取消机制；旧团队的迟到响应不得覆盖当前团队状态。作用域失效返回 401/403 时清空旧任务页。
- 管理台的 `adminTeamId` 只控制管理范围。项目选项必须合并团队管理员可管理项目与当前用户在其他团队担任项目负责人的可管理项目，去重后供选择。
- 任务卡片、注意力队列、团队视图和详情必须显示服务端返回的 `teamName`；项目栏和项目筛选只展示当前团队范围。
- 团队项目栏合并 `/api/team/status` 的 `projects` 与 `associationProjects` 并按项目 ID 去重。
  `associationProjects` 只表示该团队成员有本地关联资格，不表示已有任务读取权限；不得据此放宽
  任务查询或让前端自行授予项目角色。
- Tauri 桌面端通过 `desktop-state-changed` 的 `sidecar` 主题刷新只读 `desktop_sidecar_status`，
  按 `{ running, paused }` 显示真实后台同步状态；可见页面保留 10 秒兜底。普通浏览器没有
  `window.__TAURI__`，不显示本地关联和 sidecar 状态入口。
- Tauri 项目行必须常驻展示关联状态：未关联、关联中、等待后台同步、正在同步已有任务、等待确认任务差异、
  同步正常、只读已关联或关联失效；`liveSyncStatus=error` 时显示同步异常并通过可见辅助文本或 `title`
  展示脱敏后的 `liveSyncError`。
- `initialReviewPending=true` 时分支行显示“已关联 · 等待确认任务差异”并提供“确认差异”入口，点击调用
  `live_control_show` 聚焦主窗口并弹出同步确认弹窗；此类分支不计入“正在同步任务”提示，改由独立提示说明确认后才会同步。
  该状态在聚合优先级中介于 `error` 与 `syncing` 之间。
- `liveSyncStatus=ready` 但 `deferredCount>0` 时必须显示“N 个本地任务未同步”，不能显示同步正常。
  可写关联提供显式确认后的补同步入口；只读关联不显示上传动作。补同步失败或冲突不得提示成功。
- 上传本地任务的确认弹窗必须逐条列出待上传任务的标题与 `taskDir`（标题缺失回退目录名），
  并说明“冲突时仍会要求确认”；`ConfirmDialog` 的 `description` 必须是块级容器，不能渲染进 `<p>`。
  同步确认弹窗内的“上传本地任务”决策与分支行入口共用同一份任务清单。
- 项目栏父行状态只能读取该项目自身 `taskSpaces` 的关联，禁止回退到其他项目的
  `currentTaskSpace`。项目展开时父行优先展示当前选中分支的状态，不能被他分支的
  `error` 或分支不一致覆盖；项目未展开时可按“关联失效、`error`、`syncing`、deferred、
  `pending`、`ready`”聚合。
- 项目选中“全部 taskSpace”时，父行按该项目自身分支显示“X/Y 个分支已暂停”，并说明各分支仅按
  自身状态同步；不得因一个分支暂停而提示整个项目暂停。
- 多分支项目的展开行必须分别展示各分支状态。`BRANCH_MISMATCH` /
  `BINDING_BRANCH_MISMATCH` 只在该分支行显示红色“已暂停”，不得把暂停状态投影成整个项目暂停。
- 点击关联后先进入只读项目检查并禁用重复入口；目录选择取消只结束 loading，不显示成功或失败。
  推送确认完成后先调用预检，不能在预检前 attach。
- “团队管理”入口只属于普通浏览器管理界面；Tauri 客户端即使账号具备管理权限也不显示该入口，
  浏览器仍使用 `/admin.html`。
- Team 任务卡和详情必须显示有效归属分支 `branchName`。`sourceBranchName` 与它不同时追加
  “来源 {sourceBranchName}”，例如“分支 dev · 来源 dev1”；两者相同时不得重复显示来源。
- 当前范围包含多个 taskSpace 时，页面必须提示“按分支独立统计”。服务端默认查询已按项目稳定任务 ID
  隐藏基线已接管的来源副本，前端不得自行再把不同 task ID 合并。
- 默认列表中的每个可见任务仍按 `taskSpaceId + taskKey` 形成渲染实例；分组、React key、选中任务刷新
  和归档行身份必须使用复合 key，避免显式来源快照或不同稳定 ID 在同名目录时互相覆盖。
- 任务流水线、团队视角和归档视图提供单值“分支”模糊筛选。输入先 trim，再按大小写不敏感的任意子串匹配；
  团队模式由 `/api/tasks/query?branch=` 服务端过滤，独立模式复用 `branchMatches()`。不做正则、多选或候选下拉。
  Team 分支筛选匹配有效归属 `branchName`，不是已合入任务的来源分支。
- 同步中的已关联 taskSpace 在项目栏显示固定风险提示：切换 Git 分支可能造成任务错位或污染，
  建议等待同步完成。该提示不阻断分支切换，也不承诺自动修复。
- `ASSIGNEE_CONFIRMATION_REQUIRED` 必须复用三态对话框：取消、继续推进、接管任务；继续携带
  `warningId + action=continue` 重试，接管携带 `action=takeover`，不能在前端自行改派。
- Tauri“接入本地项目”由客户端选择 Git 根目录并预检仓库名、远端、当前分支、`.trellis/tasks` 和
  Agent 工具；服务端项目列表不再是接入前置条件。
- Tauri 项目行只有在当前分支存在 `approved` 本地关联时，才在关联文件夹图标右侧显示编码 Agent
  快速初始化入口；只读 approved 关联也可显示。入口只提交 `taskSpaceId`，禁止重新选择目录或提交
  任意本地路径。
- 快速初始化弹窗与接入向导共用 Agent 列表、项目预检规范化和统一错误提取；developer ID 默认当前
  `runtime.user.username`，已初始化 Agent 禁用并标记“已初始化”，全部已初始化时仍展示完整列表并
  统一置灰，成功提示后关闭，失败保留输入。
- 项目接入在“全部团队”范围必须要求选择具体 owner team；developer ID 和本机 Agent 工具只写入当前
  设备 binding，不要求其他设备一致。
- 接入向导的本机 Agent 列表必须直接读取 `packages/shared/trellis-agent-tools.js` 的完整目录，按名称或 ID
  做大小写不敏感搜索；过滤只影响可见项，不改变已勾选或已存在状态。
- 接入向导打开或切换仓库时，developer ID 默认使用当前登录账号的 `runtime.user.username`，不得使用
  显示名；用户手动输入或清空后，迟到的运行时用户数据不得覆盖该值，缺少用户名时保持为空并沿用现有校验。
- 接入向导必须按规范化本地路径读取现有本地关联。同一仓库已有其他分支 binding 时，展示旧分支、
  新分支和旧 taskSpace，并明确“不删除旧任务空间”；用户再次确认后才允许替换。Windows 路径比较
  忽略大小写、斜杠方向和末尾分隔符。需要同时同步多个分支时提示使用独立 Git worktree。
- 缺少 `.trellis` 或 `tasks` 时显示初始化面板；新建任务树后显示 `waiting_commit`、
  `waiting_push`、`branch_missing`、`remote_ahead`、`diverged`、`unable_to_verify`、`ready`
  的明确状态。已有任务树仅追加本机 Agent 工具时，这些配置不属于共享任务同步内容，不要求先
  commit/push。
- 接入向导只有在 `.trellis/tasks` 已存在且首次推送门禁已满足时才允许“检查任务差异”；
  缺少任务树或推送未 `ready` 时按钮必须禁用并显示具体原因，仅缺少可选 Agent 工具不得阻塞预检。
  初始化、预检和关联的 Tauri `invoke` 拒绝值必须经 `onboardingErrorMessage()` 提取 `Error`、
  字符串或对象 `message`，空消息才回落到通用文案；禁止直接序列化整个错误对象。
- 接入向导重新打开时不能只依赖本次打开期间的内存状态判断首次推送门禁；必须使用仓库预检返回的
  `hasCommittedTrellis` 恢复“本地已有 `.trellis`、但尚未进入 HEAD”的等待提交/推送状态。
- 客户端不得自动 commit/push；用户完成提交和推送后，通过“检查推送状态”比较本地 HEAD 与远端分支。
- 首次接入在 Web 向导展示预检结果，再提供“暂不接入 / 仅同步无冲突项 / 查看并处理差异”。
  “暂不接入”只清除 Tauri 内存中的待接入路径，不 attach、不写本地 binding/cursor、不写服务端。
- 服务端没有该分支快照时明确显示“服务端暂无任务快照”；用户确认后才以 `bootstrap` 模式 attach，
  并将当前本地任务作为初始快照上传。双方一致时直接安全接入，不显示空差异窗口。
- 用户明确选择后才创建 binding，并持久化 `initialSyncMode` 和 `initialSyncCompleted`。已进入
  review 后的“稍后处理”只关闭同步确认弹窗，不能通过删除服务端 binding 实现取消。
- CAS 冲突显示任务名、文件、最后修改人、设备、时间、建议和 `conflictId`；技术 SHA 只能放在
  次级详情。动作区提供查看差异、使用服务端版本、用我的版本覆盖、仅保存本地副本。
- 覆盖服务端必须二次确认并说明会先备份双方；保存副本不改变服务端，使用服务端版本不得推进服务端
  revision。
- Git 凭据、SSH trust、项目 probe、toolchain 批准和 Git operation 入口必须从 Team 管理台移除。
- 管理台项目访问页只保留团队邀请/移除、项目成员、developer 映射、Agent binding 和审计。

## 管理台分支生命周期

- 分支管理只在服务端 `/admin.html` 的项目页提供；桌面客户端不显示弃用、恢复或移除入口。
- `useAdminProjects` 在切换项目时并行请求 taskspaces、成员、绑定、团队访问和审计；状态只来自
  `GET /api/projects/:projectId/task-spaces`，操作成功后重新调用 `selectProject()`，不能本地伪造删除。
- 分支按 `lifecycleStatus=active|disabled|retired` 分组。每行展示任务数、文件数、在线/已关联监听数、
  最后活动时间和 retired 原因；普通项目栏和任务选择器只消费服务端已过滤的列表。
- 弃用弹层展示任务、文件、监听和最后活动摘要，可填写原因；提交中禁用按钮，失败保留弹层并显示
  `ApiError` 文本。
- 移除分支必须两阶段确认：第一步展示影响摘要并提示会删除服务端任务、绑定、游标、命令、冲突和索引；
  第二步要求输入完整分支名，值不完全匹配时禁止提交。服务端仍会再次校验，前端不能只依赖按钮状态。
- 移除成功后关闭弹层并刷新管理数据；备份失败、权限变化或 taskSpace 状态变化时保留弹层和输入，
  显示服务端原因。删除不表示真实 Git 分支或客户端本地 `.trellis/tasks` 被清理。

## 分支监听状态与主动解绑

### 1. Scope / Trigger

- Trigger：taskSpace 增加监听聚合、本地 `detachPending`、Rust/Tauri 解绑命令或零监听创建/改派门禁时。

### 2. Signatures

- `TaskSpaceListenerState = online | inactive | unassociated | unknown_legacy | disabled`。
- `taskCommandState(taskSpace, teamMode) -> { canSubmit, reason }`：
  `packages/web/src/lib/team-client.js`。
- `projectListenerView(taskSpace)`：`packages/web/src/lib/project-rail-association.js`。
- Tauri：`detach_local_association(taskSpaceId)`。

### 3. Contracts

- 每个 taskSpace 独立读取 `onlineListenerCount`、`approvedBindingCount`、`lastListenerAt` 和
  `listenerState`，不能用单个分支状态覆盖整个项目。
- 五态文案固定：`online`“在线监听 N / 已关联 M”、`inactive`“当前未激活，关联保留”、
  `unassociated`“无客户端关联”、`unknown_legacy`“旧客户端，监听状态未知”、`disabled`“已停用”。
- “全部项目”也要展示逐分支监听摘要；普通浏览器不显示本地解绑操作。
- 监听详情里的 `Trellis ID：<devId>` 只在项目 dev id 存在且与账号用户名不同时显示，账号本身仍显示
  `@username`；dev id 相等时不重复展示。
- 接入/快速初始化弹窗的 Trellis developer ID 默认取该项目的 `trellisDevId`（按
  `remoteIdentityKey === remoteIdentityHash` 匹配项目），无映射回落到用户名；用户手改后不得覆盖。
  已接入项目重新关联并显式提交不同 dev id 时，服务端才会修正成员映射。
- 当前客户端 approved 且非 `detachPending` 时显示“不再同步此分支”，必须先二次确认。
- 所有破坏性操作的二次确认统一走 `packages/web/src/components/ui/confirm-dialog.tsx` 的
  `useConfirm()`（`ConfirmDialogProvider` 只在 `app/providers.tsx` 挂载；本地登录壳不弹确认）。
  Tauri 客户端禁止 `window.confirm` / `window.alert`：`tauri-plugin-dialog` 覆盖后它们返回被拒绝的
  Promise，条件判断恒为真值，用户从未看到确认却被直接执行。
- 滚动条统一由 `packages/web/src/index.css` base 层的 `scrollbar-width: thin` +
  `scrollbar-color: var(--border) transparent` 控制，不再逐组件迁移 `ScrollArea`。
- `DialogBody` 用 `-mx-4 px-4 [scrollbar-gutter:stable_both-edges]`：负 margin 吃掉 `DialogContent`
  的 `p-4` 把滚动条顶到卡片右边框，`px-4` 补偿内容内边距，双侧 `scrollbar-gutter` 保证内容左右留白
  始终对称（有无滚动条都不跳动），与官方 scrollable content 示例同构。`DialogContent` 若自己改过
  padding（如 `p-0`）或 `DialogBody` 自身是带背景的块（如插件日志），必须在调用处用 `mx-0` / `mx-4`
  抵消负 margin，否则内容会被卡片裁掉或背景左右不对称。
- `detachPending=true` 时禁用按钮并显示“服务端解绑待确认”；有 `lastError` 时显示真实原因，
  不得继续声称自动重试。
- Team 模式零在线监听时禁用创建/改派；独立模式不受此门禁影响。监听详情入口仅对 `canManage` 显示。
- 旧服务端完全不返回监听聚合字段时保持既有创建/改派可用，由服务端旧逻辑最终校验；不能把
  “字段缺失”伪装成零监听。只要返回了任一监听字段，`onlineListenerCount=0` 仍严格禁用。

### 4. Validation & Error Matrix

| 条件 | 结果 |
| --- | --- |
| taskSpace 缺少监听聚合 | 不显示服务端五态，不伪造在线 |
| taskSpace 完全缺少监听字段 | 保持旧服务端命令兼容，由服务端最终校验 |
| `onlineListenerCount` 非安全整数或小于 1 | 禁用创建/改派并显示绑定提示 |
| `listenerState=unknown_legacy` | 额外提示升级客户端或服务端 |
| `listenerState=disabled` | 显示中性“已停用” |
| 解绑二次确认取消 | 不调用 Tauri |
| Tauri 返回 pending 或拒绝 | 显示待确认/真实错误，不伪报成功 |

### 5. Good / Base / Bad Cases

- Good：三客户端监听显示 `3/3`；全部切分支后 `0/3 inactive`；全部解绑后 `0/0 unassociated`。
- Base：旧服务端没有监听字段时保留原有本地关联展示。
- Bad：把 `disabled` 当作红色无关联，重复制造告警。
- Bad：`detachPending` 时立即从列表删除，服务端失败后用户看不到待确认状态。

### 6. Tests Required

- `packages/web/test/project-rail-association.test.js`：五态、颜色语义、待确认错误、逐 taskSpace 独立。
- `packages/web/test/team-web.test.js`：驼峰/下划线归一、零监听门禁和恢复。
- `packages/desktop/test/*.test.js`：Tauri 命令、capability、`detachPending` 投影。

### 7. Wrong vs Correct

Wrong：

```tsx
const canSubmit = taskSpace.status === 'active'
```

项目或设备在线不等于该分支正在被监听。

Correct：

```tsx
const commandState = taskCommandState(taskSpace, teamMode)
<Button disabled={!commandState.canSubmit}>{commandState.reason || '创建并派发'}</Button>
```

## 创建与改派操作项

- Web 创建带负责人任务或改派返回 `202 operation` 时只更新独立操作列表，不向 `teamPage.tasks`
  插入临时卡片，也不提前修改任务负责人。
- 操作状态固定映射：`pending=等待投递`、`delivered=等待 Agent 执行`、`running=Agent 正在执行`、
  `succeeded=已完成，正式任务已同步`、`failed=执行失败`、`cancelled=已取消`。
- `failed` 才显示重试；`pending/delivered/running` 显示取消；`succeeded/cancelled` 不显示可执行按钮。
- 同一 taskSpace 的操作列表是最多 100 条的服务端快照，前端最多展示最近 8 条并保留近期成功项。
- 创建表单只在请求成功入队后关闭；正式任务出现仍由下一次 Board SSE/REST 对齐决定。
- Agent 离线、目标成员不可写、binding 缺失或 `TASK_SPACE_NO_ONLINE_LISTENER` 等错误必须保留
  表单输入并显示服务端中文原因。

## 归档分页

- 归档视图的项目筛选以页面 `filters.projectId` 为唯一来源，受控接收 `projectId`/`onProjectChange`，
  不得在归档内部另存一份项目状态；团队切换只在当前项目不属于新团队时写回 `'all'`，
  项目变化必须回到第一页。
- 团队归档索引使用独立查询状态，不读取活动任务 `teamPage`，也不复用其游标。
- 归档查询固定携带 `archived=true` 和 `limit=20`；上一页读取本地游标栈，下一页写入服务端 `nextCursor`。
- 团队、项目、分支、搜索、负责人或 `queryRevision` 变化时清空游标并从第一页重载；
  `CURSOR_INVALID` 同样回到第一页。
- 归档搜索做短延迟合并，请求序号必须阻止旧响应覆盖新筛选结果。
- 负责人选项来自服务端归档聚合，不得只使用当前页任务。
- 切换负责人时加载态会暂时清空当前页聚合；选项刷新期间必须把当前选中值保留在
  options 中，否则受控 Select 会因值暂时不存在而回退为“全部负责人”，并覆盖用户筛选。
- 归档任务详情必须整体只读：不得显示或提交计划字段编辑，负责人派发、依赖新增/解除等写入口
  必须禁用或隐藏；详情刷新为归档态时还要退出残留编辑状态。
- 独立模式继续从本机 `board.tasks` 派生归档并做客户端分页。

## 派生集合与 effect 依赖

- hook 从服务端快照派生任务数组、成员数组或对象列表时，必须按源字段使用 `useMemo`，让引用只随真实源数据变化。禁止在每次渲染中直接 `map()` 后交给选择同步或详情加载 effect，否则对象 identity 会驱动 `setState → render → 再次 setState` 的请求循环。

```typescript
// 正确：源任务页未变化时，tasks 引用保持稳定
const tasks = useMemo(
  () => (teamPage?.tasks || []).map(teamRowToBoardTask),
  [teamPage?.tasks],
)

// 错误：每次渲染都会生成新数组和新任务对象
const tasks = (teamPage?.tasks || []).map(teamRowToBoardTask)
```

- 相关回归至少断言：同一源快照连续渲染时派生数组引用不变；打开一次任务详情只产生一次 `/api/task` 请求。仓库尚未提供 React hook 渲染测试入口时，必须用生产构建和真实浏览器 Network 面板闭环。

## 弹层

- 统一使用 `components/ui/dialog` 的 `Dialog`/`DialogContent`；`Dialog` 内部维护弹层栈，Esc 只关闭最上层。
- `DialogContent` 是 flex 列容器：`DialogHeader`、`DialogFooter` 固定，正文必须包进 `DialogBody`（`data-slot="dialog-body"`，`min-h-0 flex-1 overflow-y-auto`）；不要在 `DialogContent` 上加 `overflow-y-auto` 或 `max-h-[…]`，否则标题和底部按钮会跟着滚走。
- 表单弹层：`<form className="flex min-h-0 flex-1 flex-col gap-*">`，字段与错误信息进 `DialogBody`，`DialogFooter` 留在 `form` 内。
- `Select` 弹层宽度跟随触发器（`min-w-(--anchor-width) max-w-(--available-width)`），选项文字换行（`whitespace-normal break-words`），不要加单行截断或 `whitespace-nowrap`。
- Markdown 预览容器固定为 `markdown-body` + `break-words [&_pre]:whitespace-pre-wrap [&_pre]:break-words [&_img]:max-w-full`；排版由 `github-markdown-css` 提供，不要另接 tailwind typography 等第二套版式。
- `renderMarkdown()` 由 markdown-it 渲染，代码块经 `markdown-it-highlightjs`（`hljs` 取自 `highlight.js/lib/common`）输出 `<pre><code class="hljs language-*">`，任务项输出 `<span class="md-checkbox">`。
- `github-markdown-css` 与 hljs 主题都是字面颜色、同一组 `.markdown-body` 选择器，禁止静态全局引入；只能经 `lib/markdown-theme.ts` 的 `applyMarkdownTheme(theme)` 把 light/dark 四份 CSS 以 `?inline` 合并写入 `<style id="markdown-theme">`，由 `ThemeProvider` 在主题切换时刷新。
- 弹层写操作：提交中禁用按钮、错误保留输入、成功后关闭并刷新数据源。
- 打开详情弹层时才请求 `/api/task`；列表不使用详情里的重量字段。
- 可滚动且正文较长的弹层必须显式指定顶部容器作为 `initialFocus`，不能依赖默认的“第一个可 Tab 元素”。默认策略可能聚焦正文末尾按钮，并让 `overflow-y-auto` 容器自动滚到底部。

## 开工条件与完成条件

- 条件明细只使用 `/api/task` 返回的缺口数组；列表阶段只有数量时，必须显示读取中或暂不可用，不能把未知数量当成 0。
- 用户可见名称统一为“开工条件”和“完成条件”，内部 `dorMissing` / `dodMissing` 字段保持兼容。
- 规划状态突出开工条件；实现、检查和收尾状态突出完成条件，同时保留尚未补齐的开工条件提示。
- “下一步”当前是只读建议，不绑定阶段写入或跳转；“查看明细”使用原生按钮和 `aria-expanded` 内联展开。
- 桌面条件区域使用四列布局，`lg` 以下改为单列条件卡，禁止通过横向滚动容纳完整表格。

## 安全边界

- React 默认转义所有插值，禁止 `dangerouslySetInnerHTML` 拼接未转义文本。
- Markdown 预览必须使用 `renderMarkdown()`（内部已 `escapeHtml`）。
- 一次性凭证（当前仅 Agent 配对码）只在响应中显示一次，不写入 localStorage、不进入日志。
- 主题偏好是唯一允许持久化的前端状态（`localStorage['trellis-theme']`）。

## 主题

- token 在 `packages/web/src/index.css`：`:root` 浅色、`.dark` 深色、`@theme inline` 暴露 utility。
- 首屏由三个 HTML 入口的内联脚本在 React 挂载前决定 `.dark` 类，避免闪烁。
- 新增颜色一律使用 shadcn 语义 token；不要直接写 `#hex`、`bg-white`、`text-black`。
- preset：`b3awTjpuKm`（mira / neutral / violet / indigo / Inter + Geist / radius default）。

## 场景：任务归属确认与单/多分支选择

### 1. Scope / Trigger

- Trigger：修改 ProjectRail 本地关联状态、任务卡/分支选择、Tauri task ownership 命令、
  批量归属弹层或 control window 的 `task_ownership_review` 时。
- 目标：单分支不打扰用户；多分支只在归属无法唯一判断时批量确认一次，并让其他分支任务保持暂停，
  防止 watcher 把残留目录同步到当前 taskSpace。

### 2. Signatures

Tauri：

```text
list_task_ownership(taskSpaceId)
set_task_ownership(taskSpaceId, decisions)
```

`set_task_ownership.decisions`：

```json
[
  { "taskDir": ".trellis/tasks/task-a", "action": "use-branch", "branchName": "main" },
  { "taskDir": ".trellis/tasks/task-b", "action": "defer" }
]
```

关联摘要新增：

```text
ownershipPausedCount
ownershipPausedTaskDirs
ownershipPendingCount
ownershipPendingTaskDirs
```

control event：

```json
{
  "type": "task_ownership_review",
  "taskSpaceId": "space-main",
  "branchName": "main",
  "items": [
    {
      "taskId": "task-a",
      "taskDir": ".trellis/tasks/task-a",
      "title": "任务 A",
      "choices": [
        { "taskSpaceId": "space-main", "branchName": "main" },
        { "taskSpaceId": "space-feature", "branchName": "codex/feature-a" }
      ]
    }
  ]
}
```

### 3. Contracts

- `CreateTaskDialog` 只有 `taskSpaces.length > 1` 才显示分支选择；单分支直接显示只读空间名并自动选中。
  默认顺序为当前查询 taskSpace、当前可写且未暂停的本地 binding、列表首项。
- ProjectRail 分支行分别展示“任务因分支不匹配暂停”和“任务待确认归属”；`deferredCount` 继续只表示
  首次同步延后任务，不能复用为 ownership 状态。
- 点击 ownership 数量按需调用 `list_task_ownership`，不能在 3 秒关联轮询里读取全部候选，也不能把
  ownership 状态写入 localStorage。
- `TaskOwnershipDialog` 默认全选；支持归属当前分支、归属其他可见分支、暂不处理。一次最多提交 200 个，
  超过时按批提交或分批处理；提交中禁用写操作，失败保留选择。
- “暂不处理”只保留 cursor 的 `ownershipPending`；关闭 React 弹层不删除待确认状态。
- control window 收到 `task_ownership_review` 时整批展示；关闭窗口等同 defer，只弹出一次；项目栏仍可再次打开。
- 关联状态必须来自 `binding` 的 approved、可写、非同步错误、非 binding branch mismatch 状态；
  不能把只读或旧错误 binding 当成创建任务默认值。
- 所有远程 Board 可调用的 ownership 命令必须在 `board-local-association` capability 白名单中；
  local control window 只额外开放 `set_task_ownership`。

### 4. Validation & Error Matrix

| 条件 | 结果 |
| --- | --- |
| 项目只有一个 taskSpace | 隐藏选择器，自动显示并选中该分支 |
| 项目有多个 taskSpace | 显示选择器，默认当前查询/当前 binding/首项 |
| 本地关联只读、错误、暂停或未批准 | 不作为创建任务默认本地分支 |
| ownership 候选为空 | 显示“当前没有需要处理归属的任务” |
| ownership 候选超过 200 | 前端按 200 分批，不能一次调用 Tauri |
| 未选择任何任务 | 写操作按钮禁用 |
| 用户选择其他分支 | task.json.branch 写为该有效分支；当前 binding 下不立即上传 |
| 用户选择当前分支 | 写入后立即同步并刷新 Board/关联摘要 |
| 用户关闭 control window | 等同 defer，不删除 pending fingerprint |
| 命令失败或权限失效 | 保留弹层/选择并显示服务端中文原因 |

### 5. Good / Base / Bad Cases

- Good：单分支项目创建任务只看“同步任务空间：main”，没有多余 Select。
- Good：多分支歧义任务首次打开一个批量弹层，全选后一次归属或暂不处理；重启后除非任务变化不再重复弹窗。
- Good：ProjectRail 显示“2 个任务因分支不匹配暂停”，点击可重新打开，切回对应 worktree 后自动恢复。
- Base：没有 layout invocation（普通浏览器）时不显示本地 ownership 状态入口。
- Base：当前只读关联只显示只读状态，不显示属于写操作的归属按钮。
- Bad：逐任务弹窗或在 3 秒轮询中每次自动打开，造成重复打扰。
- Bad：把明确其他分支任务强行改回 main 后上传，重新引入跨分支污染。
- Bad：ProjectRail 用 `deferredCount` 表示 ownership 暂停，导致文案、优先级和补同步动作混在一起。

### 6. Tests Required

- `project-rail-association.test.js`：ownership paused/pending 的优先级、总数和分支暂停区分。
- `desktop-association.test.js`：关联摘要字段解析、不可写/错误 binding 不进入默认、pending/paused 目录稳定排序。
- `desktop-package.test.js`：Tauri 命令、capability、control event 和 CLI `--task-space` 契约。
- 浏览器验收：单分支隐藏选择器；多分支显示并默认正确；>200 条分批；“稍后处理”后弹窗关闭、不再自动弹出；
  浅色/深色和窄屏无横向溢出。
- Tauri 验收：Board 窗口（capability `set_task_ownership`）可提交 ownership，非法 taskDir/branch 被拒绝，成功后关联摘要刷新。

### 7. Wrong vs Correct

#### Wrong

```ts
const taskSpaces = selectedProject.taskSpaces || []
<SelectField value={taskSpaceId} options={taskSpaces} />
```

即使项目只有一个分支也强制用户选择；多分支时又没有优先当前本地 binding，容易把任务创建到错误 taskSpace。

#### Correct

```ts
const preferred =
  taskSpaces.find((item) => item.id === defaultTaskSpaceId) ||
  taskSpaces.find((item) => item.id === writableLocalTaskSpaceId) ||
  taskSpaces[0]

return taskSpaces.length > 1 ? <BranchSelect value={preferred?.id} /> : <CurrentBranchText />
```

单分支自动处理，多分支才要求选择；ownership 状态和 deferred 状态分别展示、分别执行动作。
