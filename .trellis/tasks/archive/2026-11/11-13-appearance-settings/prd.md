# 客户端偏好设置：字体大小与主题

## Goal

在看板内提供一个「偏好设置」对话框，让使用者调整**整站缩放比例（字号）**与主题模式（浅色 / 深色 / 跟随系统）；偏好保存在本机，刷新与重开应用后保持，首屏不闪烁。

设计稿（已产出，用户已确认）：
- 画布：`design/trellis-board-redesign.pen` 顶层 frame `06 · 偏好设置 · Light` / `06 · 偏好设置 · Dark`（对话框）、`06b · 头像菜单 · Light` / `06b · 头像菜单 · Dark`（入口展开态）
- 导出图：`design/frames/20-dialog-preferences-light.png`、`design/frames/20-dialog-preferences-dark.png`、`design/frames/21-avatar-menu-light.png`、`design/frames/21-avatar-menu-dark.png`

## 背景与已确认事实（仓库证据）

- 主题状态：`apps/web/src/app/theme.tsx:5` `type Theme = 'light' | 'dark'`，只有两态；`toggleTheme` 在 `:37-39` 只做明暗互换。
- 持久化：`localStorage['trellis-theme']`（`apps/web/src/app/theme.tsx:14`、`:30`），值只有 `'light'` / `'dark'`。
- 首屏防闪脚本 `apps/web/public/theme-init.js:9-12`；`apps/web/index.html:9`、`apps/web/admin.html:9`、`apps/web/login.html:9` 三处引用。
- `ThemeProvider` 经 `apps/web/src/app/providers.tsx:8` 包住看板、管理台、登录页。`useTheme` 消费者：`apps/web/src/components/layout/TopBar.tsx:12,53`、`apps/web/src/features/plugins/PluginPanel.tsx:3,33`、`apps/web/src/pages/admin/AdminPage.tsx:13,64`。
- 顶栏：明暗切换按钮 `apps/web/src/components/layout/TopBar.tsx:133-141`；头像下拉 `:104-127`（待我接受 / 修改密码 / 团队管理 / 退出），无设置入口。
- 桌面壳强制系统主题：`apps/web/src/desktop/main-index.tsx:5-8`、`apps/web/src/desktop/main-control.tsx:5-8`；`apps/web/desktop/index.html`、`control.html` 未加载 `theme-init.js`（control.html CSP 为 `script-src 'self'`，外部同源脚本可用）。
- 字号现状：px 任意值 327 处 — `text-[Npx]` 291 处 / 41 文件（10px 93、11px 84、10.5px 36、9.5px 20、11.5px 20），非字号 px 36 处（`sm:max-w` 15、`max-w` 5、`w` 4、`focus-visible:ring` 3、`max-h` 2、`rounded` 2、switch 尺寸 4、`p` 1）；`text-xs` 等内置档 127 处；`apps/web/src/index.css` 未设置根字号。
- 对话框壳：`apps/web/src/components/ui/dialog.tsx:73-108` `DialogContent` 默认 `sm:max-w-sm`；`DialogBody`（`:109`）为唯一滚动区；`DialogHeader`（`:119`）、`DialogFooter`（`:129`，默认 `sm:justify-end`）。

## 需求

- **R1 入口与形态**：顶栏头像下拉新增「偏好设置」，打开模态对话框（不新增看板导航视图）。对话框层级：标题「偏好设置」+ 说明 → 主题三选（带缩略预览）→ 字号四档（当前值 + 实时预览）→ 分隔线 → 底部「恢复默认」「完成」。
- **R2 主题三态**：浅色 / 深色 / 跟随系统。「跟随系统」时系统主题切换实时生效，无需刷新。
- **R3 字号四档（根字号）**：小 14px / 标准 16px / 大 18px / 特大 20px。通过修改 `html` 根字号实现，全站 rem 尺寸（文字、间距、图标、圆角、对话框宽度）等比缩放。
- **R4 不做密度保持**：允许放大后内容变宽、出现滚动；不接受文字裁切、控件重叠、点击区被遮挡。
- **R5 即时生效**：切换后当前页面立即更新，无需刷新或重新登录。
- **R6 持久化与首屏**：主题沿用 key `trellis-theme`（值扩展 `'system'`），字号新增 `trellis-font-size`（`'sm' | 'md' | 'lg' | 'xl'`）。首屏不得出现主题闪白或字号跳变。
- **R7 向后兼容**：旧值 `'light'` / `'dark'` 升级后保持原主题，对话框显示对应选中项。
- **R8 恢复默认**：回到「跟随系统 + 标准字号」。
- **R9 全站一致**：看板、管理台、登录页、桌面登录窗与实时同步窗共用同一偏好；字号作用于全部四个入口。

## 验收标准

- [ ] 头像下拉出现「偏好设置」，点击打开对话框；`Esc` 与「完成」都能关闭。
- [ ] 三态主题切换立即生效；选择「跟随系统」后修改系统主题，页面无需刷新即跟随。
- [ ] 四档字号切换立即生效：文字、间距、图标同步放大/缩小，16px 档与当前视觉完全一致。
- [ ] 特大档（20px）下逐视图 + 逐对话框检查：任务流水线、团队视角、归档索引、插件，以及创建任务、任务详情、待我接受、项目管理、组合视图、发布操作、修改密码、偏好设置八个对话框，无文字裁切、无控件重叠、无不可点击区域（横向滚动可接受）。
- [ ] 刷新后主题与字号保持；`localStorage` 为空时回落「跟随系统 + 标准」。
- [ ] 预置 `trellis-theme = 'dark'` 后打开：保持深色，对话框选中「深色」。
- [ ] 首屏无可感知的明暗闪烁与字号跳变。
- [ ] `/admin.html`、`/login.html`、桌面登录窗与实时同步窗的主题与看板一致。

## 不在范围

- 服务端 / 账号级偏好同步。
- 自定义主题色、字体族、行列密度。
- 新增 UI 依赖。
- 管理台独立设置入口（只跟随偏好）。

## 关键决策

- 缩放实现选根字号，而非文字令牌乘法：用户明确要求「调根字号、不需要保持密度」，根字号一行 CSS 覆盖全部 rem 基元。
- 代价：px 任意值不会跟随，必须批量转 rem（327 处，脚本化 + 机械校验）；`focus-visible:ring-[3px]` 保留 px（细焦点环不应变粗）。
- 形态选模态对话框而非独立视图：设置项只有两组，独立视图会挤占看板导航并需要新增路由状态。
