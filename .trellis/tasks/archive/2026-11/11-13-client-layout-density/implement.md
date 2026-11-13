# Implement Plan

## 顺序（每步独立可验证）

1. **TopBar 响应式** — `apps/web/src/components/layout/TopBar.tsx`
   - 外层 `<div className="@container shrink-0">` 包住 header；header 加 `flex-wrap` 与 `@max-[48em]:h-24 @max-[48em]:items-start @max-[48em]:gap-y-0`。
   - 品牌 `shrink-0`，文字 `@max-[64em]:hidden`；nav 容器 `min-w-0 flex-1 overflow-x-auto [scrollbar-width:none]` + 右缘 mask；nav 按钮 `shrink-0 whitespace-nowrap`；右侧组 `shrink-0`。
   - 搜索容器 `hidden @min-[64em]:block`，Input `w-60 @max-[80em]:w-40`。
   - 新增 `searchOpen` 状态：`<64em` 图标按钮 → 展开为 `flex-1` 输入框 + 取消，Esc 收起；`≥64em` 忽略该状态。
   - 验证：`npm run build`；`npm run preview` 在 1440/1024/860/640/390 宽 × 四档 `data-font-size` 下量 `header.scrollHeight`、`nav.scrollWidth`，并点击搜索图标验证展开/收起。

2. **Rust 控制窗口尺寸** — `apps/desktop/src-tauri/src/agent_service.rs`
   `pub(crate) const CONTROL_WINDOW`；`CONTROL_WIDTH`；`clamp_control_height(preferred, work_area)`；`resize_control(window, height)`；`show_control()` 改 `.inner_size(CONTROL_WIDTH, 240.0).resizable(false).center()`。
   验证：`cargo test`（新增 `clamp_control_height` 用例），`cargo check`。

3. **命令 + 权限 + denylist** — `main.rs`（`live_control_resize`、`generate_handler!`、`.with_denylist(&[agent_service::CONTROL_WINDOW])`）、`permissions/desktop.toml`、`capabilities/live-control.json`
   验证：`cargo check`（capability 引用的权限标识必须存在，否则构建期失败）。

4. **ControlApp 全宽 + 高度自适应** — `apps/web/src/desktop/ControlApp.tsx`
   `main` 去居中改 `p-3`；`Card` 去 `max-w-[35rem]`、加 `ref`；新增 ResizeObserver effect 上报 `live_control_resize`。
   验证：`npm run build:desktop`；`tsc -b` 通过。

5. **登录页收窄** — `apps/web/src/desktop/LoginApp.tsx`
   三处 `max-w-[28rem]`；不设 `min-h`。
   验证：`npm run build:desktop`；静态核对 1280×800 与 960×640 下的占比。

6. **格式化与回归** — `npm run format`；`npm test`；`npm run build`；`npm run build:desktop`；`cargo test`；`cargo check`。

## 验收核对表

- 1440/1024/860/640/390 × 四档字号：header 无纵向溢出（`scrollHeight <= clientHeight`），nav 无换行（`nav.scrollHeight <= nav.clientHeight`）。
- 768–1023px：搜索图标可见可点；展开后输入框占满导航行，Esc 与「取消」均收起；1024px 以上输入框常驻且宽度 > 0。
- 20px 根字号 + 1024px：紧凑态生效（logo 无文字、搜索为图标），导航单行。
- 控制窗口：先手动放大旧的 560×420 窗口（模拟历史状态），重建后弹出尺寸仍为 480×内容高度；拖拽边框无法改大小。
- `task_sync_error` 窗口高度 ≈ 内容 + 24；`task_file_conflict` 长列表窗口封顶于工作区 90%，滚动可到 `ActionBar`。
- 20px 字号下重新触发控制事件，窗口高度随之变化、无裁切。
- 登录页卡片 448px 宽、高度随内容，深浅色各一次。
- `capabilities/board-local-association.json` 无 `live_control_resize`。

## 不做的

- 不迁移控制弹窗到 web；不给远程 origin 加 `live_control_*` 权限。
- 不改 `main` 窗口尺寸记忆、托盘、sidecar 与同步业务逻辑。
- 不新增 React 渲染测试框架；Rust 用单元测试覆盖尺寸夹取逻辑。
- 不引入新的 CSS 文件：容器查询全部走 Tailwind 任意值变体。
