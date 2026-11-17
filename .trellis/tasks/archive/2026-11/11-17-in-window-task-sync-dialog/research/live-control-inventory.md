# 现状清单：实时同步确认控制窗（调研锚点）

供 implement/check 子代理快速定位，不重复 PRD 的需求描述。

## Rust

- 控制窗创建/尺寸：`packages/desktop/src-tauri/src/agent_service.rs:33`（`CONTROL_WINDOW`）、`:350-372`（`show_control`，`WebviewUrl::App("control.html")`，480 宽，不可缩放，居中）、`:45`（`resize_control`）。
- 事件发布与聚焦：`agent_service.rs:317-348`（`publish_control`：`initial_sync_review` 每次变化重弹并清 `focus_suppressed`；其他事件每进程一次 `auto_focus_consumed`）。
- 队列：`agent/control.rs`（`MAX_PENDING_CONTROLS = 32`，`control_key` 去重，`expiresAtEpochMs` 过期，`suppress`/`resume`）。
- 生命周期：`agent_service.rs:379-385`（`pending_control` 空队列隐藏窗）、`:387-390`（`suppress_and_hide`）、`:428-432`（`pending_control` 导出）、`:434-444`（`show_pending_control`）、`:446-450`（`close_control_window`）、`:452-461`（`clear_control`）、`:463-481`（`dismiss_control`，含 `assignment_warning` 死分支）。
- 命令：`main.rs:740-822`（pending/show/decide/diff/initial/dismiss/resize，全部 `ensure_local_caller`）、`:972`（window-state 拒绝持久化的窗口名）、`:1019-1027`（CloseRequested 隐藏控制窗）、`:882`（托盘「处理实时确认」）。
- 校验：`main.rs:71-78`（`ensure_local_caller`）、`:80-90`（`ensure_board_caller`，同 origin 于 `board_url`）。
- 差异数据：`agent_service.rs:502-517`（`live_conflict_details`）→ `agent/task_sync.rs:5890-5960`（每文件 `path/localContent/serverContent/changedBy`，完整文本）。
- 差异序列化：`agent/task_sync.rs:204-223`（`Difference::to_control`，只带 taskId/taskDir）。
- 标题提取：`agent/task_sync.rs:474-487`（`task_title` 读 `task.json.title`）。
- 待上传目录：`agent/device.rs:840-900`（`read_local_associations`）、`:966`（`deferred_task_dirs`），只有目录没有标题。

## Web

- 现有控制窗 UI：`packages/web/src/desktop/ControlApp.tsx`（744 行；`DiffFileView` 为上下/左右两个 `<pre>`；动作分发在 `runAction`；10 秒兜底 + `live-control-changed` 监听）。
- 入口：`packages/web/desktop/control.html`（含 meta CSP）、`packages/web/src/desktop/main-control.tsx`。
- Board 入口：`packages/web/index.html` → `/src/main-board.tsx`；`app/providers.tsx:10-15` 挂 `ConfirmDialogProvider`；`pages/board/BoardPage.tsx:463` 挂 `TaskDetailDialog`。
- 通用确认：`components/ui/confirm-dialog.tsx:30-84`（`description?: React.ReactNode`，包在 `<p>` 内）。
- 上传入口：`components/layout/ProjectRail.tsx:508-537`（`syncDeferredTasks` + confirm）、`:783,868-873`（目录提示）、`:574-582`（`openInitialReview` → `live_control_show`）。
- 构建：`packages/web/vite.config.ts`（Board 输出 `packages/server/public`）；`packages/web/vite.desktop.config.ts`（root=desktop，输出 `packages/desktop/ui`，input index+control，`stripDevCsp`）。
- CSP：`packages/desktop/src-tauri/tauri.conf.json:15` 只作用于本地页；服务端无 CSP 下发给 Board。
- 桌面静态契约测试：`packages/desktop/test/desktop-ui-build.test.js`（断言 control.html、`ControlApp.tsx`、`live-control-changed`、10 秒兜底等，需要同步改写）。
