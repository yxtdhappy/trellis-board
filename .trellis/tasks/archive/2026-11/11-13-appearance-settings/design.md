# 技术设计：偏好设置（根字号缩放 + 三态主题）

## 设计稿对齐

| 设计稿节点 | 实现 |
| --- | --- |
| `design/trellis-board-redesign.pen` → `06 · 偏好设置 · Light`（`Tcmgb`）/ `06 · 偏好设置 · Dark`（`pfSTS`） | `apps/web/src/features/settings/PreferencesDialog.tsx` |
| 主题三卡（44px 缩略预览） | `<button aria-pressed>` ×3，缩略图用 div 拼 |
| 字号四档段控 | `role="radiogroup"` + 四个 `role="radio"` 按钮 |
| 「恢复默认」/「完成」 | `resetAppearance()` / `onOpenChange(false)` |

## 1. 缩放机制：根字号单点

`apps/web/src/index.css` 顶部新增：

```css
html[data-font-size='sm'] { font-size: 14px; }
html[data-font-size='md'] { font-size: 16px; }
html[data-font-size='lg'] { font-size: 18px; }
html[data-font-size='xl'] { font-size: 20px; }
```

Tailwind v4 的内置基元全部基于 rem（`--spacing: 0.25rem`、`--text-xs: 0.75rem`、`--radius-*`、`h-7`/`gap-3`/`p-4`），改根字号即等比缩放文字、间距、图标、圆角、对话框宽度。这满足「不要求保持密度」。

**唯一缺口是 px 任意值**：`text-[10px]`、`w-[230px]` 等不随根字号变化。全量 327 处必须转 rem。

### px → rem 转换规则

- 换算：`rem = px / 16`，保留精确小数（不四舍五入到 2 位，避免 0.01px 级偏差）。
- 16px 档下 `16 × rem = 原 px`，**视觉零变化**；14/18/20 档等比缩放。
- 例外保留 px：`focus-visible:ring-[3px]`（3 处）——焦点环不应随字号变粗。

| 原值 | 出现次数 | 替换为 |
| --- | --- | --- |
| `10px` | 93 | `0.625rem` |
| `11px` | 84 | `0.6875rem` |
| `10.5px` | 36 | `0.65625rem` |
| `9.5px` | 20 | `0.59375rem` |
| `11.5px` | 20 | `0.71875rem` |
| 其余（9/12.5/13.5/14.5/15/16.6/28 等） | 74 | 按 `px / 16` 精确换算 |

非字号 36 处（`sm:max-w` 15、`max-w` 5、`w` 4、`max-h` 2、`rounded` 2、switch 尺寸 4、`p` 1）同样转 rem，否则侧栏、对话框宽度不跟随字号。

分布最密：`TaskDetailDialog.tsx` 39、`TeamView.tsx` 22、`ProjectRail.tsx` 20、`ConditionChecks.tsx` 18。

## 2. 偏好模型（纯函数 + 单测）

新增 `apps/web/src/lib/appearance.js` + `apps/web/src/lib/appearance.d.ts`（沿用 `apps/web/src/lib/archive-sort.js` 的 js+d.ts 模式，便于 `node --test` 直接跑）：

```js
export const THEMES = ['light', 'dark', 'system']
export const FONT_SIZES = { sm: 14, md: 16, lg: 18, xl: 20 }
export const DEFAULT_THEME = 'system'
export const DEFAULT_FONT_SIZE = 'md'
export const THEME_STORAGE_KEY = 'trellis-theme'
export const FONT_SIZE_STORAGE_KEY = 'trellis-font-size'
export function normalizeTheme(value)      // 非法/缺失 → 'system'
export function normalizeFontSize(value)   // 非法/缺失 → 'md'
export function resolveTheme(theme, prefersDark) // 'system' → prefersDark ? 'dark' : 'light'
```

`normalizeTheme` 必须接受旧值 `'light'` / `'dark'`（R7 向后兼容）。

新增 `apps/web/test/appearance.test.js`：非法值回落、`resolveTheme` 三分支、字号映射。

## 3. Provider 改造

`apps/web/src/app/theme.tsx` 改写为外观上下文（保留文件路径，避免无谓搬迁）：

```ts
type AppearanceContextValue = {
  theme: ThemePreference            // 'light' | 'dark' | 'system'
  resolvedTheme: 'light' | 'dark'
  fontSize: FontSize                // 'sm' | 'md' | 'lg' | 'xl'
  fontPixels: number                // 14 | 16 | 18 | 20
  setTheme(t): void
  setFontSize(s): void
  resetAppearance(): void
}
export function useAppearance(): AppearanceContextValue
```

初始值从首屏脚本写下的 `documentElement.dataset.theme` / `dataset.fontSize` 读取（与 `theme-init.js` 共源，避免二次解析不一致）。

effect 1（`[resolvedTheme]`）：`root.classList.toggle('dark', resolvedTheme === 'dark')`、`root.style.colorScheme = resolvedTheme`、`applyMarkdownTheme(resolvedTheme)`、写 `trellis-theme`。
effect 2（`[fontSize]`）：`root.dataset.fontSize = fontSize`、写 `trellis-font-size`。
effect 3：`theme === 'system'` 时注册 `matchMedia('(prefers-color-scheme: dark)')` 的 `change` 监听，触发重算 `resolvedTheme`；清理时移除。

消费者迁移（clean cutover，不留兼容别名）：

| 文件 | 改动 |
| --- | --- |
| `apps/web/src/app/providers.tsx:4,8` | `ThemeProvider` → `AppearanceProvider` |
| `apps/web/src/components/layout/TopBar.tsx:12,53` | `useTheme()` → `useAppearance()`；明暗按钮保留，点击把偏好固定为当前解析值的反色（`setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')`） |
| `apps/web/src/features/plugins/PluginPanel.tsx:3,33` | 用 `resolvedTheme` 下发 iframe 主题 |
| `apps/web/src/pages/admin/AdminPage.tsx:13,64` | 同上，解构 `resolvedTheme`/`setTheme` |

`apps/web/src/components/ui/sonner.tsx:3,14` 用 next-themes，不在本次范围（保持不变）。

## 4. 首屏脚本

`apps/web/public/theme-init.js` 扩展为幂等初始化，职责：

1. 读 `trellis-theme`，缺失或非法按 `'system'` 处理；`'system'` 用 `matchMedia` 解析。
2. `documentElement` 上写 `classList.toggle('dark', …)`、`style.colorScheme`、`dataset.theme = 偏好原值`。
3. 读 `trellis-font-size`，非法回落 `'md'`，写 `dataset.fontSize`。
4. 若偏好为 `'system'`，注册 `matchMedia` change 监听并按 2 重应用（覆盖登录页、桌面壳这类不挂 Provider 的入口）。

三个 HTML 入口已引用（`apps/web/index.html:9`、`admin.html:9`、`login.html:9`），无需改动。`public/theme-init.js` 是经典脚本，不复用 `lib/appearance.js`（ESM）；重复的只有 5 行回落逻辑，常量值必须与 lib 一致。

## 5. 桌面壳

- `apps/web/desktop/index.html`、`apps/web/desktop/control.html` 的 `<head>` 末尾加 `<script src="/theme-init.js"></script>`（同源，`control.html` 的 CSP `script-src 'self'` 允许）。
- 删除 `apps/web/src/desktop/main-index.tsx:5-9` 与 `apps/web/src/desktop/main-control.tsx:5-9` 的 `matchMedia` 硬编码，改由首屏脚本接管（否则会覆盖用户偏好）。

## 6. 对话框组件

新增 `apps/web/src/features/settings/PreferencesDialog.tsx`，遵守仓库对话框壳：`DialogContent` + `DialogHeader` + `DialogBody`（唯一滚动区）+ `DialogFooter`。

```tsx
<Dialog open={open} onOpenChange={onOpenChange}>
  <DialogContent showCloseButton={false} className="gap-0 p-0 sm:max-w-[32.5rem]">
    <DialogHeader className="gap-1 border-b border-border px-5 pt-[1.125rem] pb-3.5">
      {/* 标题 + 说明 + 右上角关闭按钮 */}
    </DialogHeader>
    <DialogBody className="flex flex-col gap-[1.375rem] px-5 pt-[1.125rem] pb-5">
      {/* 主题 section / 字号 section */}
    </DialogBody>
    <DialogFooter className="mt-0 border-t border-border px-5 py-3.5 sm:justify-between">
      <Button variant="ghost" size="sm" onClick={resetAppearance}>恢复默认</Button>
      <Button size="sm" onClick={() => onOpenChange(false)}>完成</Button>
    </DialogFooter>
  </DialogContent>
</Dialog>
```

- 尺寸全部取 rem（`32.5rem` = 520px、`1.125rem` = 18px、`1.375rem` = 22px），保证对话框本身随字号缩放。
- 主题卡：`<button aria-pressed={active}>`，`h-11` 缩略预览（顶栏色条 + 内容块），选中态 `border-primary ring-[1.5px]`；「跟随系统」预览为左右对半分屏。
- 字号段控：`role="radiogroup"`，四项 `role="radio" aria-checked`，选中 `bg-primary text-primary-foreground`。
- 实时预览块：真实文本（标题 + success badge + 说明）放在 `bg-muted rounded-lg p-3`。
- 关闭按钮用 `Button variant="ghost" size="icon-sm"` + `XIcon`，不用壳自带的绝对定位按钮（设计稿在 header 内右对齐）。

入口：`apps/web/src/components/layout/TopBar.tsx` 头像下拉新增「偏好设置」项，`open` 状态放 TopBar 内部（看板与管理台都用同一 TopBar）。管理台若使用独立顶栏，同样接入（`apps/web/src/pages/admin/AdminPage.tsx`）。

## 7. 溢出与布局

等比缩放不改变相对布局，理论上无新增裁切。需人工确认的固定尺寸：

- `DialogContent` 的 `max-h-[calc(100dvh-2rem)]` 已是 rem/vh 混合，20px 档可用高度略减 → `DialogBody` 滚动兜底。
- 侧栏 `w-[14.375rem]`（原 230px）在 20px 档为 287px，主区收窄 → 看板横向滚动兜底（已验证存在）。
- 顶栏 `h-14`（3.5rem）在 20px 档为 70px，内部 `text-[10px]`→rem 后同步放大，不溢出。

## 8. 验证

```powershell
# 单测（仓库根）
node --test apps/web/test/*.test.js
# 构建 + lint
cd apps/web; npm run lint; npm run build
```

人工矩阵（`npm run dev`，看板 + 管理台 + 登录 + 桌面壳）：

1. 四档字号 × 两主题：流水线 / 团队视角 / 归档索引 / 插件视图无裁切重叠。
2. 20px 档逐个打开：创建任务、任务详情、待我接受、项目管理、组合视图、发布操作、修改密码、偏好设置。
3. 刷新保持；清空 `localStorage` 回落「跟随系统 + 标准」；旧值 `trellis-theme='dark'` 兼容。
4. 系统主题切换（跟随系统态）无需刷新即跟随。
5. 残留检查：`grep -rn "\[[0-9.]*px\]" apps/web/src` 结果仅剩 `focus-visible:ring-[3px]` 3 处。

## 风险

- **转换量大**：327 处机械替换，脚本必须只匹配 `Npx` 字面量且不碰注释/字符串；替换后用构建 + 人工矩阵兜底。
- **两份偏好解析逻辑**（`theme-init.js` 与服务端 ESM lib）：常量漂移风险，靠单测固定 lib 一侧，脚本注释声明必须同步。
- **`data-font-size` 缺失时无样式**：`html` 无档位时用浏览器默认 16px，等同 `md`，可接受；首屏脚本保证不会长期缺失。
