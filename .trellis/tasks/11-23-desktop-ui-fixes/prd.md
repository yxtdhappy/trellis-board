# 修复桌面端专有窗口、浮层与差异视图 UI 缺陷

## 1. 目标与用户价值（Goal & User Value）

修复 Tauri 桌面端专有界面（`HandoffNotice`、`LiveSyncControlDialog`、`ActionBar`、`DiffViewer`、`UpdateDialog`、`LoginApp`）中的右上角浮层与 Toast/双行 TopBar 叠压、长路径撑破差异文件列表按钮、更新期间关闭按钮状态矛盾、冷启动白屏与间距重叠、以及原始 Tailwind 颜色对比度不足等问题。

## 2. 前置依赖与范围边界

- **前置依赖**：子任务 2（`11-23-ui-primitives-foundation`），提供 `Progress` 不确定态动画、`Sonner` 接入 `AppearanceProvider`、`Alert` 边框底色与图标对齐修复、`DialogHeader` 避让与 `ToggleGroup` 方向透传。
- **范围外**：不修改 Tauri Rust 命令逻辑、MonacoDiff 核心渲染逻辑（已核实无缺陷）及 `SyncNotice.tsx`（其暗色主题问题已在子任务 2 的 `sonner.tsx` 解决）。

## 3. 需求明细（Requirements）

- **REQ-1 `HandoffNotice` 浮层防重叠、可收起与语义色修复**（`HandoffNotice.tsx:141-142,190-226`）：
  - 将常驻状态卡片位置（L190 `fixed right-4 top-20 z-40`）移出右上角区域（如改至右下角 `bottom-4 right-4` 或融入页面流），彻底避免与右上角 `top-right` Sonner `Toaster` 及窄屏/大字号下 `h-24`（96px）`TopBar` 叠压；
  - 为浮层提供折叠/临时收起交互（例如可折叠为右下角紧凑提示胶囊），防止未处理冲突期间长期遮挡看板右侧卡片与按钮；
  - 将 L206-207 硬编码 `text-amber-500` / `text-sky-500` 替换为语义 Token `text-warning` / `text-info`，解决浅色模式下低对比度问题。

- **REQ-2 `LiveSyncControlDialog`、`ActionBar` 与 `DiffViewer` 布局/截断/尺寸修复**：
  - `LiveSyncControlDialog.tsx:355,360-365,527,532-536`：
    - L355 `DialogContent` 改为按态设宽（仅 `diff` 状态使用 `sm:max-w-[min(72rem,92vw)]`，其余信息/选择状态使用 `sm:max-w-2xl`）；
    - L362 状态文案改用 `<DialogDescription role="status">`（`text-xs`）或提高 `DialogTitle` 层级，修复标题与描述同为 `text-sm` 导致的层级倒挂；
    - L527 移除 `<AlertCircle>` 上重复的 `mt-0.5`（避免与 `alert.tsx` 的 `translate-y-0.5` 叠加下坠 4px）；
    - L532-536 仅在 `actions.length > 0` 时渲染 `<DialogFooter>`，消除底部多余 16px 空隙。
  - `live-control/ActionBar.tsx:18`：移除底栏按钮 `size="sm"`，统一为默认 `h-8` 与全站弹窗及确认弹窗对齐。
  - `live-control/DiffViewer.tsx:13-24,61-85`：
    - L61-85 垂直文件列表 `<ToggleGroup>` 容器增加 `max-h-36 overflow-y-auto` 防止多文件把 `MonacoDiff` 挤出 `85vh` 弹窗首屏；
    - L75 `ToggleGroupItem` 补充 `w-full overflow-hidden`，L80-81 两个 `<span>` 改为 `block w-full truncate` 并添加 `title`，修复 `flex-col items-start` 内 `truncate` 失效撑破按钮的问题；
    - L13-24 `DiffFileFallback` 的 `<section>` 补充 `min-w-0`，`<pre>` 改为 `border border-border bg-muted/40 font-mono` 修复浅色模式白底贴白底无边框问题。

- **REQ-3 `UpdateDialog` 更新态关闭同步与细节修复**（`UpdateDialog.tsx:171-189,211,218,235`）：
  - L175 `<DialogContent>` 传入 `showCloseButton={!applying}`，确保下载安装更新期间右上角 `×` 与底部禁用态「关闭」按钮状态一致；
  - L183、L185 缺失版本号时不拼接 `"v—"`（为空时直接显示 `"—"`）；
  - L235 更新日志区域补充 `break-words` 防止长 URL 或哈希撑出横向滚动条；
  - 联调验证 L211、L218 传入 `<Progress value={null} />` 时可正常展示不确定进度动画。

- **REQ-4 `LoginApp` 冷启动、间距与溢出修复**（`LoginApp.tsx:97,347-539`）：
  - `phase === 'pending'`（L97/L347）时渲染简洁加载占位卡片而非空白背景；
  - `env` 阶段（L427-440）：仅在 `installVisible || retryVisible` 时渲染按钮容器，移除 L440 重复 `pt-4`，消除双倍 32px 垂直间距；移除 L394、L421、L520 错误 Alert 图标重复的 `mt-0.5`；将 L413、L429、L434 按钮尺寸统一为默认 `h-8` 对齐 `login` 阶段提交按钮与输入框；
  - `<footer>`（L536-539）：仅在 `version || configPath` 非空时渲染，避免空 `footer` 偏移卡片居中；为 `configPath` 补充 `w-full break-all text-center`（或 `truncate` + `title`）防止长 Windows 路径超出 448px 卡片边界。

## 4. 验收标准（Acceptance Criteria）

- [ ] **AC-1**：`HandoffNotice` 不再与右上角 Toast 或窄屏 `TopBar` 重叠，支持收起为紧凑状态且状态图标使用语义 Token。
- [ ] **AC-2**：`LiveSyncControlDialog` 按内容状态合理分宽、底栏按钮 `h-8`、无空 Footer；`DiffViewer` 多文件列表可滚动、长路径显示省略号不撑破按钮、降级文本对比区在浅色下有清晰边框与等宽字体。
- [ ] **AC-3**：`UpdateDialog` 更新中隐藏/禁用右上角 `×`，不确定进度条有可见动画，无 `"v—"` 拼接错误；`LoginApp` 无冷启动白屏、间距对称、长配置路径不溢出卡片。
- [ ] **AC-4**：`@trellis-board/web` 的 `oxlint`、`tsc --noEmit`、`oxfmt --check` 与根仓库 `yarn test` 全部通过。
