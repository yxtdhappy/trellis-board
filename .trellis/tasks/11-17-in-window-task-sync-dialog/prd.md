# 客户端任务同步确认内嵌化与差异展示优化

## Goal

客户端（Tauri 桌面端）与团队服务端任务同步时，所有需要用户确认的事件不再弹独立小窗，而是在客户端主窗口内用 Board 的 Web 弹窗展示；冲突任务的逐文件差异改用 Monaco 左右分栏 diff；上传本地任务前的确认弹窗要列出待上传任务信息（标题 + 目录）。

## Background / 已确认事实

- 主窗口登录后导航到远端 Board 页面（`packages/desktop/src-tauri/src/main.rs:452` `window.navigate(board)`）；本地 bundle 仅 `index.html`（`packages/web/src/desktop/main-index.tsx` → LoginApp）与 `control.html`（`packages/web/desktop/control.html` → `main-control.tsx` → `ControlApp`）。
- 现有独立控制窗：`agent_service.rs:33` `CONTROL_WINDOW = "live-control"`，`show_control()`（`agent_service.rs:350-372`）用 `WebviewUrl::App("control.html")` 创建，固定宽 480、前端通过 `live_control_resize` 上报高度（`agent_service.rs:45`）。
- 控制事件队列：`agent/control.rs` `ControlHub`，`MAX_PENDING_CONTROLS = 32`，按 `control_key` 去重、`expiresAtEpochMs` 过期；`dismiss` 从队列移除队首，`pending` 只读队首。
- 自动弹出语义：`publish_control`（`agent_service.rs:317-348`）中 `initial_sync_review` 每次变化都清 `focus_suppressed` 并重新唤起；其他事件每进程只自动聚焦一次（`auto_focus_consumed`）；用户「稍后处理」走 `dismiss_control`（`agent_service.rs:463-481`）并抑制。
- 控制事件类型：`initial_sync_review`、`task_file_conflict`、`task_ownership_review`、`task_sync_error`（发射点 `agent/task_sync.rs`，标题/文案在 `ControlApp.tsx:504-525`）。
- 命令权限：`live_control_pending/show/decide/diff/initial/dismiss/resize` 全部 `ensure_local_caller`（`main.rs:740-822`），`capabilities/live-control.json` 只授权 `live-control` 窗口；`capabilities/board-local-association.json` 只授权了 `allow-live-control-show`；`ensure_board_caller`（`main.rs:80-90`）已能按 `board_url` 复核 Origin。
- 现存缺陷：ProjectRail「确认差异」从远端 Board 调用 `live_control_show`（`ProjectRail.tsx:574-582`），但该命令用 `ensure_local_caller`，远端调用会被拒（提示“该命令仅允许本地登录页调用”）；本任务一并修复。
- 冲突差异数据：`live_control_diff` → `agent_service::live_conflict_details`（`agent_service.rs:502-517`）→ `task_sync::conflict_details`（`task_sync.rs:5890-5960`），每文件 `{path, localContent, serverContent, changedBy}`，完整文本无截断。
- 当前差异 UI：`ControlApp.tsx` `DiffFileView`，本地/服务端两个 `<pre>` 在 `md:grid-cols-2` 中左右排列，窄窗时上下堆叠。
- 远端 Board 页面无 CSP（服务端不下发；`control.html` 的 meta CSP 只作用于本地页；`tauri.conf.json:15` 的 `app.security.csp` 只覆盖本地页），因此 Board 页面可直接加载 Monaco 及 worker。
- `packages/web` 无任何 diff 库依赖；构建 Vite 8 + rolldown，`tsconfig.app.json` 已含 `types: ["vite/client"]`（`?worker` 导入可类型化）。
- 待上传任务：`list_local_associations` 只返回 `deferredCount` + `deferredTaskDirs`（`agent/device.rs:840-900`、`deferred_task_dirs()` `device.rs:966`），不含标题；本地 `task.json` 有 `title`，Rust 已有 `task_title(&SnapshotGroup)`（`task_sync.rs:474-487`）。
- 上传入口（`ProjectRail.tsx:508-517`）：`confirm({ title: '上传本地任务？', description: '将把 N 个本地任务上传到 <branch>，冲突时仍会要求确认。' })` → `invoke('sync_deferred_tasks')`；分支行 title 提示只列目录名（`ProjectRail.tsx:783,868-873`）。
- 通用确认弹窗：`components/ui/confirm-dialog.tsx`，`ConfirmOptions.description?: React.ReactNode`，但渲染包在 `<p>` 内，放列表需换成块级容器。
- 首次同步审查的 local-only 差异经 `Difference::to_control`（`task_sync.rs:204-223`）序列化，只带 `taskId/taskDir`，不带标题。

## Requirements

### R1 实时同步确认改为主窗口内弹窗（方案 B）

- R1.1 删除独立 `live-control` 窗口与 `control.html`/`ControlApp`；控制事件改为在 Board 页面用现有 `Dialog` 外壳（固定头尾 + `DialogBody` 单滚动区）渲染。
- R1.2 新事件到达时 Rust 负责 show/unminimize/focus 主窗口并发出 `live-control-changed`；页面拉到待处理事件后自动打开弹窗。
- R1.3 保留既有队列/去重/过期/抑制语义：`initial_sync_review` 每次变化都重新露出；其他事件每进程只自动聚焦一次；「稍后处理/关闭」后不再主动弹出，直到有新事件或用户从托盘/分支行手动打开。
- R1.4 保留手动入口：托盘「处理实时确认」（`main.rs:882`）与 ProjectRail「确认差异」（`ProjectRail.tsx:576`）都要能聚焦主窗口并打开弹窗，且修好 `live_control_show` 的远端 Origin 校验。
- R1.5 命令校验从 `ensure_local_caller` 改为 `ensure_board_caller`，并在 `board-local-association.json` 授权 `live_control_pending/decide/diff/initial/dismiss`；删除 `live-control.json`、`live_control_resize` 及 `tauri.conf.json` 的 `live-control` capability。
- R1.6 Board 页面挂载时主动拉取待处理事件，覆盖登录初期的空档。
- R1.7 浏览器直接打开 Board（无 Tauri 上下文）时不渲染任何控制弹窗，也不发起 IPC。

### R2 冲突差异改用 Monaco 左右分栏 diff

- R2.1 `task_file_conflict` 的「查看差异」改用 Monaco `DiffEditor` 左右分栏：左=本地版本、右=服务端版本，只读。
- R2.2 逐文件切换展示，显示文件路径与 `changedBy` 来源；单侧缺失时该侧为空，并在文件头标注「该文件在对应版本中不存在」。
- R2.3 Monaco 走动态 import 的独立 chunk，不影响 Board 首屏体积；加载失败时回退到现有双 `<pre>` 文本对照。

### R3 上传本地任务确认弹窗展示任务信息

- R3.1 两个入口都要展示待上传任务信息：ProjectRail 分支行「上传本地任务？」确认弹窗，以及同步确认弹窗内 local-only 任务的上传决策项。
- R3.2 每个任务展示标题与任务目录；标题缺失或 `task.json` 损坏时降级显示目录名。
- R3.3 Rust 侧为差异项与本地关联补充标题：`Difference::to_control` 增加标题，`LocalAssociation` 增加 `deferredTasks: [{ taskDir, title }]`（读本地 `task.json`），保留原 `deferredTaskDirs` 字段。
- R3.4 任务较多时弹窗内部滚动，不撑高整页。

## Acceptance Criteria

- [ ] 触发任意控制事件（首次同步差异、任务文件冲突、归属确认、同步失败）时不再出现独立小窗，而是在主窗口 Board 页面内弹出对话框；主窗口处于托盘隐藏或最小化时会被拉起并聚焦。
- [ ] 关闭/稍后处理后，同一事件不再自动弹出；新的 `initial_sync_review` 仍会自动露出；队列上限、去重与过期行为不变。
- [ ] 托盘「处理实时确认」与 ProjectRail「确认差异」都能打开弹窗，远端 Origin 调用不再被 `ensure_local_caller` 拒绝。
- [ ] 任务文件冲突差异为 Monaco 左右分栏（左本地 / 右服务端、只读），缺失侧为空并标注；Monaco 加载失败时自动回退文本对照。
- [ ] 移除 `control.html`、`ControlApp`、`live-control` capability 与 resize IPC 后，桌面端构建、Web 构建与现有测试通过。
- [ ] ProjectRail 上传确认与同步确认弹窗的 local-only 决策都列出每个待上传任务的标题与目录；确认后仍走 `sync_deferred_tasks`，冲突提示行为不变。
- [ ] 未登录/浏览器场景下不出现控制弹窗，且不产生 IPC 报错。
- [ ] 跨 Origin 调用即时控制命令仍被拒绝；旧客户端（无新命令）时新 Board 页面不崩溃、不显示弹窗。

## Out of Scope

- 不改 `ControlHub` 的队列/去重/过期算法与任务同步数据面（上传/下载/冲突解决逻辑）。
- 不为 `initial_sync_review` 增加逐文件内容 diff（该事件本身不带文件内容）。
- 不引入在线编辑/合并能力，Monaco 仅只读对比。
- 不为「新客户端 + 旧 Board 页面」保留独立窗口兜底（方案 B 决策，发布需同版本升级）。

## Open Questions

（无）
