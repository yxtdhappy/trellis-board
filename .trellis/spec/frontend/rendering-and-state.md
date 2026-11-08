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

- 独立模式：`/api/board/status` 每 750ms 轮询；`lastRefreshAt !== board.generatedAt` 时静默重载 board。
- 团队模式：`/api/tasks/query?…` 使用 `if-none-match` 复用 ETag，304 时跳过状态更新；
  `/api/team/live-revision` 每 750ms 轮询，revision key 变化时重载任务页，`/api/team/status`
  每 3 秒轮询作为兜底。
- 轮询必须在组件卸载时清理 `setTimeout/clearInterval`；不要用固定延时等待业务状态。

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
- 任务卡对 `liveRevision > 0` 显示“实时未入 Git”。任务详情和单项目 Board 必须优先使用服务端
  实时覆盖层，不能回退到旧 Git 扫描缓存。
- `ASSIGNEE_CONFIRMATION_REQUIRED` 必须复用三态对话框：取消、继续推进、接管任务；继续携带
  `warningId + action=continue` 重试，接管携带 `action=takeover`，不能在前端自行改派。

## 弹层

- 统一使用 `components/ui/dialog` 的 `Dialog`/`DialogContent`；`Dialog` 内部维护弹层栈，Esc 只关闭最上层。
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
