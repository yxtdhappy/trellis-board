# Design

## 变更边界

| 层 | 文件 | 作用 |
| --- | --- | --- |
| web 布局 | `apps/web/src/components/layout/TopBar.tsx` | 容器查询断点、导航不折行、搜索图标化/展开、<48em 两行 |
| web 桌面页 | `apps/web/src/desktop/ControlApp.tsx` | 全宽卡片 + 按内容上报窗口高度 |
| web 桌面页 | `apps/web/src/desktop/LoginApp.tsx` | 卡片 28rem、高度随内容 |
| Rust 窗口 | `apps/desktop/src-tauri/src/agent_service.rs` | 控制窗口构建参数、denylist 常量、尺寸夹取 |
| Rust 命令 | `apps/desktop/src-tauri/src/main.rs` | 注册 `live_control_resize`、window-state denylist |
| 权限 | `apps/desktop/src-tauri/permissions/desktop.toml`、`capabilities/live-control.json` | 新增且仅新增本地控制窗口权限 |

不触碰 sidecar、任务同步、`live_control_*` 现有命令与事件结构。设计稿见 `design/trellis-board-redesign.pen` 的 `11 · TopBar 响应式 · Light`（`oaCkY`）。

## 1. TopBar

### 断点：容器查询 em，而非视口 px

`apps/web/package.json:39` 是 `tailwindcss ^4.3.4`，支持 `@container` 与任意值容器查询变体。em 在容器查询里相对**容器自身字体大小**（继承根字号），因此断点随字号档位移动：

| 变体 | @16px 根字号 | @20px 根字号 | 布局 |
| --- | --- | --- | --- |
| `@min-[80em]` | 1280px | 1600px | 搜索 240px |
| `@min-[64em]` | 1024px | 1280px | 搜索 160px |
| `<64em` | <1024px | <1280px | 搜索收成 32px 图标按钮 |
| `<48em` | <768px | <960px | 两行：56 + 40 |

### 结构

外层加容器包装（`@container` 必须在祖先上，header 自己要用变体）：

```tsx
<div className="@container shrink-0">
  <header className="flex h-14 flex-wrap items-center gap-3 border-b border-border bg-card px-4 @max-[48em]:h-24 @max-[48em]:items-start @max-[48em]:gap-y-0">
```

- 品牌 `<a>`：`flex h-14 shrink-0 items-center gap-2`，`<span>` 文字 `@max-[64em]:hidden`（紧凑态只剩图标）。
- nav：`ml-3 flex h-14 min-w-0 flex-1 items-center gap-0.5 overflow-x-auto`，追加 `[scrollbar-width:none]` 与右缘 `mask-image`；窄屏变体 `@max-[48em]:order-last @max-[48em]:ml-0 @max-[48em]:h-10 @max-[48em]:w-full @max-[48em]:flex-none @max-[48em]:border-t @max-[48em]:border-border` → 靠 `order-last + w-full` 落到第二行，无需复制导航 DOM。
- nav 内的裸 `<button>`：`shrink-0 whitespace-nowrap`。
- 右侧组：`ml-auto flex h-14 shrink-0 items-center gap-2`；组内搜索容器 `hidden @min-[64em]:block`。
- 搜索 `Input`：`w-60 pl-8 text-xs @max-[80em]:w-40`。

### 搜索图标态与展开态

- `<64em` 时导航行末尾出现 32px 图标按钮（`Search` icon，`aria-label="搜索任务、负责人"`），点击 `setSearchOpen(true)`。
- 展开后：nav 隐藏，同一行渲染 `Input`（`flex-1`）+「取消」按钮；`Escape` 与「取消」都 `setSearchOpen(false)`，`useEffect` 里挂 `keydown` 监听并在关闭时清理。
- `≥64em` 时忽略 `searchOpen`（输入框常驻），避免状态残留导致宽屏误隐藏导航。
- 焦点：展开后 `autoFocus` 到输入框。

### 尺寸核算（@20px 根字号）

固定部分 = padding 40 + logo 32（紧凑态）+ 图标按钮 32 + 创建任务图标 32 + 头像 28 + 主题 32 + gaps ≈ 240px；1024px 下 nav 视口 ≈ 780px > 4 项内容 ≈ 355px。宽屏 1440/16px：搜索 240 + 创建任务 96 + 头像 28 + 主题 32 + logo 144 + gaps ≈ 570px，nav 视口 ≈ 870px。均有余量，溢出只会发生在插件塞入多项导航时，此时走横滑 + 渐隐。

## 2. live-control 窗口（Rust）

`agent_service.rs`：

- `const CONTROL_WINDOW` 提升为 `pub(crate) const CONTROL_WINDOW`。
- `show_control()` 构建参数改为 `.inner_size(CONTROL_WIDTH, 240.0).resizable(false).center()`，删除 `min_inner_size`。
- 新增纯函数 `clamp_control_height(preferred: f64, work_area: f64) -> f64`：
  - 非有限值或 `< 200.0` → `200.0`；
  - `> work_area * 0.9` → `work_area * 0.9`；
  - 否则原值取整。
- 新增 `pub(crate) fn resize_control(window: &WebviewWindow, height: f64) -> Result<(), String>`：取 `window.current_monitor()` 工作区高度（拿不到时用 `900.0` 兜底），调用 `clamp_control_height`，再 `set_size(LogicalSize::new(CONTROL_WIDTH, h))`。`CONTROL_WIDTH: f64 = 480.0` 与构建时一致。

`main.rs`：

- `.plugin(tauri_plugin_window_state::Builder::default().with_denylist(&[agent_service::CONTROL_WINDOW]).build())` —— 关闭控制窗口的尺寸/位置/最大化恢复，`main` 保持原行为。
- 新增命令：

```rust
#[tauri::command]
async fn live_control_resize(window: WebviewWindow, height: f64) -> Result<(), String> {
    ensure_local_caller(&window)?;
    agent_service::resize_control(&window, height)
}
```

- 加入 `generate_handler!`（`live_control_dismiss` 之后）。

权限（仅本地控制窗口）：

```toml
[[permission]]
identifier = "allow-live-control-resize"
description = "本地实时同步控制窗口按内容高度调整自身尺寸。"
commands.allow = ["live_control_resize"]
```

`capabilities/live-control.json` 的 `permissions` 追加 `"allow-live-control-resize"`；`capabilities/board-local-association.json`、`capabilities/main.json` 不动。

## 3. ControlApp 布局与自适应高度

- 外层：`<main className="bg-background p-3">`（去掉 `grid min-h-dvh place-items-center`）。
- 卡片：`<Card ref={cardRef} className="w-full [--card-spacing:--spacing(5)]">`（去掉 `max-w-[35rem]`）。`Card` 是 `React.ComponentProps<'div'>` 转发函数组件，React 19 支持 `ref` 作为 prop。
- 高度上报：

```tsx
useEffect(() => {
  const element = cardRef.current
  if (!element || !invoke) return
  let frame = 0
  const report = () => {
    cancelAnimationFrame(frame)
    frame = requestAnimationFrame(() => {
      void invoke('live_control_resize', { height: Math.ceil(element.offsetHeight + 24) })
    })
  }
  report()
  const observer = new ResizeObserver(report)
  observer.observe(element)
  return () => {
    cancelAnimationFrame(frame)
    observer.disconnect()
  }
}, [])
```

- 卡片自身不设高度约束，高度 = 内容高度；窗口小于内容时由窗口滚动，`offsetHeight` 仍报自然高度，因此窗口会一直贴合到工作区上限（`clamp_control_height` 已在上限封顶）。
- 字体档位切换会改变 `rem` 衍生尺寸 → 卡片重排 → ResizeObserver 再次上报，即 R6。
- 事件切换（`task_sync_error` → `task_ownership_review`）同样触发重排。

## 4. 登录页

`apps/web/src/desktop/LoginApp.tsx`：

- 三处 `max-w-[26.25rem]` → `max-w-[28rem]`（环境检查卡、登录卡、页脚），即 448px。
- 不设 `min-h`：卡片高度随内容（用户要求“尺寸改小一点”）。
- 维持 `flex min-h-dvh flex-col items-center justify-center gap-4 p-6` 居中结构，不改主窗口 `inner_size` / `min_inner_size`。

## 5. 验证

- Rust：`cargo test`（`apps/desktop/src-tauri`）——为 `clamp_control_height` 增加单元测试（上限、下限、非有限值、正常值）；`cargo check`。
- 前端：`npm run build`、`npm run build:desktop`、`npm test`，`npm run format` 后无 diff。
- 浏览器：`npm run preview`（或 `web:dev`）在 1440/1024/860/640/390 宽 + 四档 `document.documentElement.dataset.fontSize` 下量 `scrollWidth/scrollHeight`，确认 header 无纵向溢出、nav 无换行；点击搜索图标验证展开/收起。
- 控制窗口：`cargo build` 后人工弹出 `task_sync_error` 与 `task_file_conflict` 各一次复验；不可用的部分在完成报告中明确标注为未验证。

## 风险

- 容器查询 em 依赖浏览器支持 `@container`（Tauri/WebView2 与主流浏览器均支持；无需降级）。
- window-state 的 denylist 只影响恢复，不阻止插件保存；旧状态文件中的 `live-control` 条目会残留但不再应用。
- 非 resizable 窗口的 `set_size` 在 Windows 上有效（`SetWindowPos`），macOS/Linux 未在本仓库验证。
- 卡片全宽后 `task_sync_error` 的短内容窗口高度约 200~260px，属于预期。
- 两行态 header 高度从 56 变 96，`BoardPage` 等依赖 `h-14` 的地方若有硬编码需一并检查（当前 header 是 `shrink-0`，页面用 flex 布局，无硬编码）。

## 实现结果（实测）

在真实浏览器里用临时 harness（已删除）量 DOM，确认容器查询变体被 Tailwind 4 正确产出：

| 视口 / 字号 | header 高 | 搜索 | 导航 | 结果 |
| --- | --- | --- | --- | --- |
| 1440 / 16px（90em） | 56 | 输入框 240 | 单行 | 无溢出 |
| 1280 / 16px（80em） | 56 | 输入框 240 | 单行 | 无溢出 |
| 1024 / 16px（64em） | 56 | 输入框 160 | 单行 | 无溢出 |
| 900 / 16px | 56 | 图标 | 单行 | 品牌文字隐藏 |
| 640 / 16px（40em） | 96 | 图标 | 第二行 | 两行态 |
| 1024 / 20px（51.2em） | 70 | 图标 | 单行 | 紧凑态按设计生效 |
| 900 / 20px（45em） | 120 | 图标 | 第二行 | 两行态 |

- `nav.scrollHeight == nav.clientHeight` 全档成立（无折行）；`documentElement.scrollWidth == innerWidth`（无横向溢出）。
- 搜索展开：860 宽下点图标 → 导航隐藏、输入框 521px、出现「取消」；Esc 与「取消」都能收起。
- 控制窗口（浏览器 mock）：`task_sync_error` 下卡片 268px → 上报 `live_control_resize {height: 292}`；切到 20px 字号后卡片 335px → 上报 359，ResizeObserver 链路成立。
- 控制窗口（真实客户端，debug 构建 + 临时注入一条 `task_sync_error`，注入代码已删除）：窗口客户区 480×301（DPI 150%），卡片底边 289 + 12px 内边距；无滚动条、无四周留白，`.window-state.json` 里没有 `live-control` 键（denylist 生效）。
- 真实客户端第一次实测高度取 299（`offsetHeight` 取整）时内容溢出 2px 出现滚动条，改成 `Math.ceil(getBoundingClientRect().bottom + 12)` 后消失——分数像素必须用 `getBoundingClientRect`。
- 登录卡：1280×800 下 448×457；20px 字号下 560×571（`rem` 随字号缩放，无横向溢出）。
- 宽度值 `w-60`/`w-40`/`max-w-[28rem]` 都是 rem，20px 档下等比放大（240→300、160→200、448→560），与字号档位一致。
