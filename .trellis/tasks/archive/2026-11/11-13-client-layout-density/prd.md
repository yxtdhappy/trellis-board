# client layout: TopBar 响应式 + 控制/登录窗口留白

## Goal

修复三处客户端布局问题，不改变任何数据流和安全边界：

1. 1024/860px 视口 + 根字号 20px 时，客户端 TopBar 导航折行并与 header 重叠。
2. live-control 窗口（任务同步失败、冲突确认、归属确认）留白过多，内容只占中间一小块；且窗口会沿用历史上的放大尺寸。
3. 客户端登录页同样是一张小卡片悬在大窗口中间。

设计稿：`design/trellis-board-redesign.pen` 顶层框架 `11 · TopBar 响应式 · Light`（A–G 七种宽度态 + 实现规则 + 登录卡），导出图 `design/topbar-responsive.png`。

## Background（已定位的根因）

- `apps/web/src/components/layout/TopBar.tsx:70`：`flex h-14` 单行、固定高。导航按钮是裸 `<button>`，没有 `whitespace-nowrap`/`shrink-0`，中文标签被逐字挤到第二行；`apps/web/src/components/ui/input.tsx` 的 `min-w-0` 让搜索框无限收缩，因此赤字全部落在导航上。
- 根字号档位在 `apps/web/src/index.css:9-23`（14/16/18/20px），但媒体查询里的 rem 仍按初始 16px 计算，断点不变而内容全部放大 → 1024px 时整行需求约 1040px，860px 时四个标签全部折行。
- 搜索框 `hidden md:block`：768–1023px 区间可见但被压缩，配合导航折行后互相挤占；用户在 1024 以下干脆看不到可用搜索。
- `apps/desktop/src-tauri/src/agent_service.rs:272-292`：控制窗口 `inner_size(560, 420)`、可调整大小、未居中；`main.rs` 的 `tauri_plugin_window_state::Builder::default()` 没有 denylist，插件会恢复 `live-control` 的 SIZE/POSITION/MAXIMIZED，一旦被拖大过，后续弹窗沿用旧尺寸。
- 控制页布局 `apps/web/src/desktop/ControlApp.tsx:477-479`：`grid min-h-dvh place-items-center p-4` + `Card max-w-[35rem]`，短内容窗口内必然出现大片空白。
- 登录页 `apps/web/src/desktop/LoginApp.tsx:298-300,372`：420px 卡片 + 1280×800 主窗口。

## Requirements

### R1 TopBar 用容器查询 em 断点，永不折行

- 断点以**容器查询 em** 判定（`container-type: inline-size` + `@container (max-width: 48em)` 等），不用视口 px 媒体查询。根字号 20px 时 64em = 1280px、48em = 960px，所以断点随字号档位一起移动，20px 档下 1024px 窗口自动落进紧凑态。
- 导航标签在任何宽度、任何字号档位下都单行显示（`whitespace-nowrap` + `shrink-0`），不与 logo、右侧操作区重叠，header 不产生纵向溢出；空间不足时导航区域横向滚动（`overflow-x-auto`，隐藏滚动条，右缘 `mask-image` 渐隐）。
- 插件提供的额外导航项（`BoardPage.tsx:128-136`）同样不折行。

### R2 搜索永不消失

- `≥64em`：显示输入框（`≥80em` 宽 240px，64–80em 收窄到 160px）。
- `<64em`：收成 32px 图标按钮，始终可见；点击后输入框占满导航行，提供「取消」按钮与 Esc 退出，导航暂时让位。
- 768–1023px 区间必须有可用的搜索入口（原实现该区间搜索框被压缩/与折行导航互相挤占）。

### R3 窄屏两行布局

- `<48em`（640px @16px、960px @20px）：header 变两行 —— 第一行 56px 品牌 + 操作区，第二行 40px 导航 chip 横滑。整行高度 96px，不遮挡主内容（header 仍是 `shrink-0`）。

### R4 live-control 窗口不再继承历史尺寸

- `live-control` 窗口加入 window-state 插件 denylist；重新弹出的窗口尺寸不受上次用户放大/最大化影响。主窗口 `main` 的尺寸记忆保持不变。
- 控制窗口不可由用户拖拽改变大小。

### R5 控制窗口高度贴合内容

- 窗口宽度固定（`480` 逻辑像素），高度由内容决定：短内容（例如 `task_sync_error`「任务同步失败」）窗口高度接近内容高度，卡片四周只保留统一的小内边距。
- 长内容（`initial_sync_review`、`task_file_conflict`、`task_ownership_review`）窗口高度上限为当前屏幕工作区高度的 90%，超出部分在窗口内滚动，并保证 `ActionBar` 按钮可滚动到。
- 卡片改为全宽铺满窗口，不再居中缩成 `max-w-[35rem]` 的窄块。

### R6 字体偏好兼容

- 客户端外观设置的字体档位（14/16/18/20px 根字号）切换后：R1–R3 仍成立（断点随 em 移动），R5 仍然成立（控制窗口按新的渲染高度重新贴合并受同一上限约束）。
- 登录页在四档字号下均无横向溢出、无控件裁切。

### R7 登录页减少空白

- 登录卡片宽度 448px（`28rem`，原 `26.25rem`/420px），高度随内容（不设 `min-h`）；页脚跟随卡片宽度。
- 环境检查卡片与登录卡片同宽；环境检查卡片不设固定高度。
- 主窗口 `min_inner_size(960, 640)` 下卡片仍完整可见。

### R8 安全边界不变

- 不向 `board-local-association`（远程 Board origin）开放任何 `live_control_*` 命令；新增的窗口尺寸命令只出现在 `live-control` capability。
- 不改变 `live_control_pending` / `decide` / `diff` / `initial` / `dismiss` 的入参、出参与事件结构；「关闭窗口 = defer、只弹一次」的契约不变。

## Non-goals

- 不把控制弹窗迁移到 web 看板内（用户已确认保留本地窗口）。
- 登录页不做左右分栏或插画。
- 不调整 `main` 窗口的窗口状态记忆、尺寸、托盘行为。
- 不改动任务同步、冲突处理、归属确认的业务逻辑。

## Acceptance Criteria

- [ ] `npm run preview`（或 `web:dev`）在 1440、1024、860、640、390 宽 + 四档 `html[data-font-size]` 下：TopBar 单行（<48em 时两行）、无折行、无重叠、无纵向溢出。
- [ ] 768–1023px 区间存在可点击的搜索入口：图标按钮可见，点开后输入框占满导航行，Esc 与「取消」均可收起。
- [ ] 根字号 20px + 1024px 窗口（51.2em）落进紧凑态：logo 只剩图标、搜索为图标按钮、导航单行。
- [ ] 控制窗口首次与后续弹出尺寸一致；手动无法拖拽改变大小。
- [ ] `task_sync_error` 事件的窗口高度 ≈ 内容高度 + 内边距，无大面积空白；`task_file_conflict` 的差异列表在窗口内滚动，`ActionBar` 可滚动到并点击。
- [ ] 切换客户端字体档位到 20px 后重新触发控制事件，窗口高度重新贴合，无裁切、无横向溢出。
- [ ] 登录页卡片宽度 448px，在 1280×800 与 960×640 下垂直居中，空白明显减少；深色模式同样成立。
- [ ] `npm test` 通过；`npm run build` 与 `npm run build:desktop` 通过；`cargo test` 与 `cargo check`（`apps/desktop/src-tauri`）通过；未引入新的 formatting 工具，`npm run format` 后无 diff。
- [ ] `capabilities/board-local-association.json` 未新增 `live_control_*` 权限；`capabilities/live-control.json` 只新增窗口尺寸命令。
