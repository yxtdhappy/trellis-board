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

## 轮询

- Board 不再按 750ms 轮询 `/api/board/status` 或 `/api/team/live-revision`。`useBoard` 在 runtime
  确定后建立同源 `EventSource('/api/board/events')`，收到 `tasks.changed`、连接建立/重连、窗口 focus
  或页面恢复可见时执行一次 REST 对齐。
- 独立模式收到事件后静默重载 `/api/board`；团队模式重载当前 `/api/tasks/query` 与团队状态，并按需
  查询 `/api/team/live-revision` 获取责任人覆盖通知。
- 团队模式：`/api/tasks/query?…` 使用 `if-none-match` 复用 ETag，304 时跳过状态更新；
  `/api/team/status` 每 3 秒轮询作为 Agent、项目同步和待委派状态的数据源。
- `/api/tasks/query` 的 200 响应必须先经过 `normalizeTaskPage` 再写入 `teamPage`。团队接口可能只返回
  `relativeDir`，而任务卡使用 `dirName`；304 响应没有 body，保持 ETag 分支不规范化。
- EventSource 只随 runtime 生命周期创建，筛选和 teamId 变化不能反复断开重连；刷新回调通过 ref
  取最新版本。组件卸载时必须关闭 EventSource、清空合并计时器并移除 focus/visibility 监听。
- 团队 `status`、项目栏本地关联和 Git 操作现有 3 秒或操作进度轮询保持不变。

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
- 点击关联后先进入项目级 loading 并禁用全部关联按钮；目录选择取消只结束 loading，不显示成功或失败。
  成功和失败使用 Sonner 明确提示，失败后保留重新关联入口。
- “团队管理”入口只属于普通浏览器管理界面；Tauri 客户端即使账号具备管理权限也不显示该入口，
  浏览器仍使用 `/admin.html`。
- 任务卡对 `liveRevision > 0` 显示“实时未入 Git”。任务详情和单项目 Board 必须优先使用服务端
  实时覆盖层，不能回退到旧 Git 扫描缓存。
- `ASSIGNEE_CONFIRMATION_REQUIRED` 必须复用三态对话框：取消、继续推进、接管任务；继续携带
  `warningId + action=continue` 重试，接管携带 `action=takeover`，不能在前端自行改派。
- Git 凭据列表和项目接入探测同样受 `adminTeamId` 管理范围控制；切换团队必须清空旧表单、旧分支和旧探测结果，迟到响应按请求序号丢弃。
- 已保存 Git 凭据的 Token、私钥和口令不得回填到表单、写入本地存储或进入一次性凭证弹窗。编辑时秘密字段留空表示保持原值。
- 项目接入只由“识别远端”按钮触发探测；URL 或凭据变化后，旧分支和自动项目名称必须立即失效。无有效 symbolic `HEAD` 时不猜测默认分支。
- 受控分支 Select 在表单重置、接入成功、URL 或凭据变化时可能回调空分支。`changeBranch()`
  只有在分支和当前远端 URL 去空白后均非空时才自动探测；内部重置不得显示
  “请先填写 Git 远端 URL”等用户操作错误。用户显式点击“识别远端”时仍执行空 URL 校验。
- 探测和切换共享分支都必须携带目标分支重新读取 tree；响应中的 `existingAgentTools` 自动选中并锁定，用户只能新增选择缺失 Agent。分支切换成功后重置未提交的新选择，迟到响应按请求序号丢弃。
- 项目接入表单同时收集 Agent 工具多选、首个负责人和负责人 Trellis developer ID；锁定项显示“已接入”且不可取消，提交载荷包含锁定 Agent 与新选择 Agent 的完整并集。
- 项目接入在“全部团队”范围只显示选择具体团队的提示；进入具体团队且用户快照为空时必须加载 active 团队成员。
- 新项目的批准面板只读显示 bootstrap 负责人和工具；旧 `provisioning` 项目继续兼容原负责人表单。

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
