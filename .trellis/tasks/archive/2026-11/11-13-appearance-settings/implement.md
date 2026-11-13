# 实施计划：偏好设置（根字号 + 三态主题）

前置：用户已确认设计稿（`design/trellis-board-redesign.pen` → `06 · 偏好设置 · Light` `Tcmgb` / `Dark` `pfSTS`、`06b · 头像菜单 · Light` `QpAJK` / `Dark` `aVNhX`，导出图 `design/frames/20-dialog-preferences-*.png`、`21-avatar-menu-*.png`）。

## 阶段 1 · 偏好模型与单测

1. 新增 `apps/web/src/lib/appearance.js` + `apps/web/src/lib/appearance.d.ts`：`THEMES`、`FONT_SIZES = { sm:14, md:16, lg:18, xl:20 }`、`DEFAULT_THEME='system'`、`DEFAULT_FONT_SIZE='md'`、`THEME_STORAGE_KEY='trellis-theme'`、`FONT_SIZE_STORAGE_KEY='trellis-font-size'`、`normalizeTheme`、`normalizeFontSize`、`resolveTheme`。
2. 新增 `apps/web/test/appearance.test.js`（`node:test`）：非法值回落、旧值 `'light'/'dark'` 兼容、`resolveTheme('system', true|false)`、字号映射。
3. 验证：`node --test apps/web/test/appearance.test.js`。

## 阶段 2 · 缩放基座

4. `apps/web/src/index.css` 顶部加四档 `html[data-font-size='…'] { font-size: … }`（14/16/18/20px）。
5. 扩展 `apps/web/public/theme-init.js`：解析主题偏好（含 `'system'` → `matchMedia`）、写 `dataset.theme`、`dark` class、`colorScheme`；解析字号偏好、写 `dataset.fontSize`；`'system'` 时注册 `matchMedia` change 监听重应用。常量值必须与阶段 1 的 lib 一致。
6. 验证：`/index.html`、`/admin.html`、`/login.html` 首屏无闪白；`document.documentElement.dataset` 断言。

## 阶段 3 · Provider 与消费者

7. 改写 `apps/web/src/app/theme.tsx`：`AppearanceProvider` + `useAppearance()`（`theme`/`resolvedTheme`/`fontSize`/`fontPixels`/`setTheme`/`setFontSize`/`resetAppearance`），初值从 `dataset` 读，三个 effect 按设计文档实现，删除 `useTheme`。
8. 迁移调用方（clean cutover）：
   - `apps/web/src/app/providers.tsx:4,8` → `AppearanceProvider`
   - `apps/web/src/components/layout/TopBar.tsx:12,53` → `useAppearance()`，明暗按钮 `setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')`
   - `apps/web/src/features/plugins/PluginPanel.tsx:3,33` → `resolvedTheme`
   - `apps/web/src/pages/admin/AdminPage.tsx:13,64` → `resolvedTheme` + `setTheme`
9. 验证：`npm run lint` + `tsc -b`；明暗切换、跟随系统实时切换。

## 阶段 4 · 偏好设置对话框

10. 新增 `apps/web/src/features/settings/PreferencesDialog.tsx`：`DialogContent showCloseButton={false} className="gap-0 p-0 sm:max-w-[32.5rem]"` + `DialogHeader`（标题/说明/关闭）+ `DialogBody`（主题三卡、字号段控、实时预览）+ `DialogFooter`（恢复默认 / 完成）；全部尺寸用 rem。
11. `apps/web/src/components/layout/TopBar.tsx` 头像下拉（`:104-127`）新增「偏好设置」，内部 `open` 状态渲染对话框。
12. 验证：开关、Esc、恢复默认、`aria-pressed`/`aria-checked` 状态正确。

## 阶段 5 · px → rem 批量转换

13. 脚本化替换 `apps/web/src/**/*.{ts,tsx,css}` 中的 `[Npx]` 任意值：`N/16` 精确小数（如 `10px`→`0.625rem`、`9.5px`→`0.59375rem`），跳过 `focus-visible:ring-[3px]`（保留 3 处）。
14. 覆盖 327 处（`text-[Npx]` 291 + 非字号 36：`sm:max-w`/`max-w`/`w`/`max-h`/`rounded`/switch 尺寸/`p`）。
15. 验证：`grep -rn "\[[0-9.]*px\]" apps/web/src` 仅剩 3 处 ring；`npm run build` 通过；16px 档视觉与改动前一致（截图对比流水线视图）。

## 阶段 6 · 桌面壳

16. `apps/web/desktop/index.html`、`apps/web/desktop/control.html` 的 `<head>` 加 `<script src="/theme-init.js"></script>`。
17. 删除 `apps/web/src/desktop/main-index.tsx:5-9`、`apps/web/src/desktop/main-control.tsx:5-9` 的 `matchMedia` 硬编码。
18. 验证：`npm run build:desktop`；桌面登录窗/同步窗跟随偏好。

## 阶段 7 · 全量验证

19. `cd apps/web; npm run lint; npm run build; npm run build:desktop`
20. `node --test apps/web/test/*.test.js`
21. 人工矩阵：四档 × 两主题 ×（流水线 / 团队视角 / 归档索引 / 插件）+ 20px 档逐个对话框（创建任务、任务详情、待我接受、项目管理、组合视图、发布操作、修改密码、偏好设置）无裁切重叠；刷新保持；清空 `localStorage` 回落默认；旧 key 值兼容。
22. `oxfmt` 格式化改动文件；清理临时脚本（`design/frames/20-dialog-preferences-*.png` 为设计交付物，随任务提交）。

## 完成标准

- PRD 验收标准全部满足。
- 无 `useTheme` 残留引用；无 px 任意值残留（除 ring）。
- 设计稿与实现一致（主题三卡、字号四档、底部按钮布局）。
