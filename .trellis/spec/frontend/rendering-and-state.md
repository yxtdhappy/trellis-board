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
  `/api/team/status`、本地项目关联和 `/api/task-operations?taskSpaceId=` 可使用 3 秒状态刷新；
  它们不替代 Board SSE 的 revision 对齐。
- `/api/tasks/query` 的 200 响应必须先经过 `normalizeTaskPage` 再写入 `teamPage`。团队接口可能只返回
  `relativeDir`，而任务卡使用 `dirName`；304 响应没有 body，保持 ETag 分支不规范化。
- EventSource 只随 runtime 生命周期创建，筛选和 teamId 变化不能反复断开重连；刷新回调通过 ref
  取最新版本。组件卸载时必须关闭 EventSource、清空合并计时器和所有状态轮询。
- taskSpace 切换必须清空旧分页 cursor、ETag、操作列表、冲突详情和负责人候选；请求序号阻止旧响应覆盖。
- 任务操作状态使用 `normalizeOperation()` 统一驼峰/下划线字段。`failed` 显示重试，`pending/delivered/running`
  显示“创建中/改派中”和取消；`succeeded` 后才重载正式任务和负责人。

## 多团队状态

- 团队筛选默认 `all`，只改变展示范围，不提交 Session。单团队成员无需额外点击；多团队用户使用受控筛选器。
- `teamId` 变化必须同时清空分页游标、ETag、旧任务页、保存视图和 WIP 设置，再分别请求 `/api/tasks/query`、`/api/saved-views` 与 `/api/board/settings`。
- 任务查询和团队偏好请求使用请求序号或其他取消机制；旧团队的迟到响应不得覆盖当前团队状态。作用域失效返回 401/403 时清空旧任务页。
- 管理台的 `adminTeamId` 只控制管理范围。项目选项必须合并团队管理员可管理项目与当前用户在其他团队担任项目负责人的可管理项目，去重后供选择。
- 任务卡片、注意力队列、团队视图和详情必须显示服务端返回的 `teamName`；项目栏和项目筛选只展示当前团队范围。
- 团队项目栏合并 `/api/team/status` 的 `projects` 与 `associationProjects` 并按项目 ID 去重。
  `associationProjects` 只表示该团队成员有本地关联资格，不表示已有任务读取权限；不得据此放宽
  任务查询或让前端自行授予项目角色。
- Tauri 桌面端每 3 秒调用只读 `desktop_sidecar_status`，按 `{ running, paused }` 显示真实后台同步
  状态。普通浏览器没有 `window.__TAURI__`，不显示本地关联和 sidecar 状态入口。
- Tauri 项目行必须常驻展示关联状态：未关联、关联中、等待后台同步、正在同步已有任务、同步正常、
  只读已关联或关联失效；`liveSyncStatus=error` 时显示同步异常并通过可见辅助文本或 `title`
  展示脱敏后的 `liveSyncError`。
- 项目栏父行状态只能聚合该项目自身 `taskSpaces` 的关联，禁止回退到全局 `currentTaskSpace`；
  多分支按“关联失效、`error`、`syncing`、`pending`、`ready`”的优先级展示，选中分支只影响
  展开行和该分支的关联入口。
- 点击关联后先进入只读项目检查并禁用重复入口；目录选择取消只结束 loading，不显示成功或失败。
  推送确认完成后先调用预检，不能在预检前 attach。
- “团队管理”入口只属于普通浏览器管理界面；Tauri 客户端即使账号具备管理权限也不显示该入口，
  浏览器仍使用 `/admin.html`。
- Team 任务卡和详情必须显示 `taskSpaceId` 对应分支 `branchName`；同一仓库不同分支不得混在同一个任务页。
- Team Board 的“全部项目/项目”只展示分支摘要；需要任务列表时必须选中具体 taskSpace。
- 同步中的已关联 taskSpace 在项目栏显示固定风险提示：切换 Git 分支可能造成任务错位或污染，
  建议等待同步完成。该提示不阻断分支切换，也不承诺自动修复。
- `ASSIGNEE_CONFIRMATION_REQUIRED` 必须复用三态对话框：取消、继续推进、接管任务；继续携带
  `warningId + action=continue` 重试，接管携带 `action=takeover`，不能在前端自行改派。
- Tauri“接入本地项目”由客户端选择 Git 根目录并预检仓库名、远端、当前分支、`.trellis/tasks` 和
  Agent 工具；服务端项目列表不再是接入前置条件。
- 项目接入在“全部团队”范围必须要求选择具体 owner team；developer ID 和本机 Agent 工具只写入当前
  设备 binding，不要求其他设备一致。
- 缺少 `.trellis` 或 `tasks` 时显示初始化面板；新建任务树后显示 `waiting_commit`、
  `waiting_push`、`branch_missing`、`remote_ahead`、`diverged`、`unable_to_verify`、`ready`
  的明确状态。已有任务树仅追加本机 Agent 工具时，这些配置不属于共享任务同步内容，不要求先
  commit/push。
- 接入向导重新打开时不能只依赖本次打开期间的内存状态判断首次推送门禁；必须使用仓库预检返回的
  `hasCommittedTrellis` 恢复“本地已有 `.trellis`、但尚未进入 HEAD”的等待提交/推送状态。
- 客户端不得自动 commit/push；用户完成提交和推送后，通过“检查推送状态”比较本地 HEAD 与远端分支。
- 首次接入在 Web 向导展示预检结果，再提供“暂不接入 / 仅同步无冲突项 / 查看并处理差异”。
  “暂不接入”只清除 Tauri 内存中的待接入路径，不 attach、不写本地 binding/cursor、不写服务端。
- 服务端没有该分支快照时明确显示“服务端暂无任务快照”；用户确认后才以 `bootstrap` 模式 attach，
  并将当前本地任务作为初始快照上传。双方一致时直接安全接入，不显示空差异窗口。
- 用户明确选择后才创建 binding，并持久化 `initialSyncMode` 和 `initialSyncCompleted`。已进入
  review 后的“稍后处理”只关闭控制窗口，不能通过删除服务端 binding 实现取消。
- CAS 冲突显示任务名、文件、最后修改人、设备、时间、建议和 `conflictId`；技术 SHA 只能放在
  次级详情。动作区提供查看差异、使用服务端版本、用我的版本覆盖、仅保存本地副本。
- 覆盖服务端必须二次确认并说明会先备份双方；保存副本不改变服务端，使用服务端版本不得推进服务端
  revision。
- Git 凭据、SSH trust、项目 probe、toolchain 批准和 Git operation 入口必须从 Team 管理台移除。
- 管理台项目访问页只保留团队邀请/移除、项目成员、developer 映射、Agent binding 和审计。

## 创建与改派操作项

- Web 创建带负责人任务或改派返回 `202 operation` 时只更新独立操作列表，不向 `teamPage.tasks`
  插入临时卡片，也不提前修改任务负责人。
- 操作状态固定映射：`pending=等待投递`、`delivered=等待 Agent 执行`、`running=Agent 正在执行`、
  `succeeded=已完成，正式任务已同步`、`failed=执行失败`、`cancelled=已取消`。
- `failed` 才显示重试；`pending/delivered/running` 显示取消；`succeeded/cancelled` 不显示可执行按钮。
- 同一 taskSpace 的操作列表是最多 100 条的服务端快照，前端最多展示最近 8 条并保留近期成功项。
- 创建表单只在请求成功入队后关闭；正式任务出现仍由下一次 Board SSE/REST 对齐决定。
- Agent 离线、目标成员不可写、binding 缺失等错误必须保留表单输入并显示服务端中文原因。

## 归档分页

- 团队归档索引使用独立查询状态，不读取活动任务 `teamPage`，也不复用其游标。
- 归档查询固定携带 `archived=true` 和 `limit=20`；上一页读取本地游标栈，下一页写入服务端 `nextCursor`。
- 团队、项目、搜索、负责人或 `queryRevision` 变化时清空游标并从第一页重载；`CURSOR_INVALID` 同样回到第一页。
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

- token 在 `web/src/index.css`：`:root` 浅色、`.dark` 深色、`@theme inline` 暴露 utility。
- 首屏由三个 HTML 入口的内联脚本在 React 挂载前决定 `.dark` 类，避免闪烁。
- 新增颜色一律使用 shadcn 语义 token；不要直接写 `#hex`、`bg-white`、`text-black`。
- preset：`b3awTjpuKm`（mira / neutral / violet / indigo / Inter + Geist / radius default）。
