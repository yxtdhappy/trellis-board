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
- `/api/tasks/query` 的 200 响应必须先经过 `normalizeTaskPage` 再写入 `teamPage`。团队接口可能只返回
  `relativeDir`，而任务卡使用 `dirName`；304 响应没有 body，保持 ETag 分支不规范化。
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
- “团队管理”入口只属于普通浏览器管理界面；Tauri 客户端即使账号具备管理权限也不显示该入口，
  浏览器仍使用 `/admin.html`。
- 任务卡对 `liveRevision > 0` 显示“实时未入 Git”。任务详情和单项目 Board 必须优先使用服务端
  实时覆盖层，不能回退到旧 Git 扫描缓存。
- `ASSIGNEE_CONFIRMATION_REQUIRED` 必须复用三态对话框：取消、继续推进、接管任务；继续携带
  `warningId + action=continue` 重试，接管携带 `action=takeover`，不能在前端自行改派。
- Git 凭据列表和项目接入探测同样受 `adminTeamId` 管理范围控制；切换团队必须清空旧表单、旧分支和旧探测结果，迟到响应按请求序号丢弃。
- 已保存 Git 凭据的 Token、私钥和口令不得回填到表单、写入本地存储或进入一次性凭证弹窗。编辑时秘密字段留空表示保持原值。
- 项目接入只由“识别远端”按钮触发探测；URL 或凭据变化后，旧分支和自动项目名称必须立即失效。无有效 symbolic `HEAD` 时不猜测默认分支。

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
