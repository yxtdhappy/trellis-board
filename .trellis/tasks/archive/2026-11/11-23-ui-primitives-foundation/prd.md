# 修复基础 UI 原语高度对齐与全局样式缺陷

## 1. 目标与用户价值（Goal & User Value）

统一 `packages/web/src/components/ui/` 基础原语的默认高度、内边距、对齐、Focus Ring 与语义色表现，解决全站多个业务页面重复出现的高度落差、Windows 弹窗双槽缩进、下拉省略号失效、图标下沉、Toast 暗色不同步与不确定进度条空白等系统性根因问题，为后续弹窗及各业务页面子任务提供稳固一致的 UI 底座。

## 2. 已确认事实（Confirmed Facts）

- **基准控件尺寸不一致**：`Button`（`button.tsx:22-30`）、`Input`（`input.tsx:11`）、`SelectTrigger`（`select.tsx:41`）、横排 `TabsList`（`tabs.tsx:17`）默认高度为 `h-8`（32px）；而 `InputGroup`（`input-group.tsx:17`）、`ComboboxContent` 内嵌框（`combobox.tsx:105`）、`ComboboxChips`（`combobox.tsx:199`）与 `Toggle`（`toggle.tsx:16-19`）默认高度停留在 `h-7`/`min-h-7`（28px），`PaginationEllipsis`（`pagination.tsx:99`）为 `size-7`（28px）短于 `PaginationLink` 的 `size-8`。
- **Dialog 原语错位与英文硬编码**：`DialogFooter`（`dialog.tsx:143`）缺 `sm:items-center`，`showCloseButton`（L148）硬编码 `"Close"`；`DialogContent` 关闭按钮为 `top-2 right-2`（L98）且 `DialogHeader`（L126）无 `pr-8`；`DialogBody`（L114）使用 `[scrollbar-gutter:stable_both-edges]` 导致 Windows 非 overlay 滚动条下正文比 Header/Footer 内缩 8–11px；`ConfirmDialogProvider`（`confirm-dialog.tsx:66-70`）描述区未包 `DialogBody`。
- **InputGroup / Combobox / Select 溢出与遮挡**：`InputGroupInput`（`input-group.tsx:118`）未覆盖 `<Input>` 的 `h-8`；`inputGroupAddonVariants`（L26）自带 `py-2` 叠加 `size-6` 按钮撑到 40px；`InputGroupButton`（L70-75,94-100）未传 `size` 给 `<Button>` 导致 `sm`/`icon-sm` 溢出；`ComboboxItem`（`combobox.tsx:133,141`）缺 `pr-7` 与右侧 `CheckIcon` 重叠；`ComboboxChip`（L219,227）高 19px 内部 `ChipRemove` 高 24px；`SelectTrigger`（`select.tsx:22,41`）同时施加 `line-clamp-1` 与 `flex` 使省略号失效；`SelectContent`（L12,88）的 `p-1` 仅写在无人调用的 `SelectGroup` 上；`SelectTrigger`/`Textarea`（`textarea.tsx:9`）用 `px-2` 与 `Input` 的 `px-2.5` 差 2px。
- **Toggle / Tabs / Dropdown / Field / Panel 细节缺陷**：`ToggleGroup`（`toggle-group.tsx:28`）和 `Tabs`（`tabs.tsx:5`）漏传 `orientation` 给 Base UI 原语导致垂直键盘导航失效；`TabsTrigger`（`tabs.tsx:51,54`）含 `h-[calc(100%-1px)]` 与 `bottom-[-5px]`；`DropdownMenuContent`（`dropdown-menu.tsx:39`）锁死 `w-(--anchor-width)` 且子项 padding/字号（L88,117,166,202）不统一；`FieldSeparator`（`field.tsx:155`）写死 `bg-background`；`Panel`（`panel.tsx:31-42`）`{action}` 无 `shrink-0`、标题缺 `font-heading`。
- **语义色、进度条、滚动区与全局样式缺陷**：`status-pill.tsx:20-28` 的 `TONE_DOT` 用 `bg-*-soft` 柔底色导致泳道小圆点几乎隐形；`badge.tsx:23,27` 的 `danger` 暗色模式纯白配浅红底对比度仅 ~3.0:1，`size="xs"` 缺稳定行高；`alert.tsx:6,11-12,54` 的 `destructive` 无红色边框/柔红底且单行无 title 时会生成空行与下坠 2px；`scroll-area.tsx:8-13` 在块级 `max-h-*` 下不触发滚动；`progress.tsx:47` 未处理 `data-indeterminate` 导致 `<Progress value={null} />` 渲染为空白条；`sonner.tsx:3,14` 读取未挂载的 `next-themes`；`index.css:195` `* { scrollbar-width: thin; }` 覆盖了 L166-L181 `.topbar-nav` 4px 细滚动条。

## 3. 需求明细（Requirements）

- **REQ-1 Dialog 原语结构对齐**（`dialog.tsx:89,98,114,126,143,148`、`confirm-dialog.tsx:66-70`）：
  - `DialogFooter` 增加 `sm:items-center`，内置 `showCloseButton` 文案 `"Close"` 改为 `"关闭"`；
  - `DialogContent` 关闭按钮定位优化为 `top-3 right-3`，`DialogHeader` 默认保留右侧避让间距 `pr-8`（无关闭按钮时允许外部或选择器覆写）；
  - `DialogBody` 移除导致 Windows 两侧对称缩进错位的 `both-edges` 滚动槽；
  - `ConfirmDialogProvider` 的 `options.description` 使用 `DialogBody` 包裹，确保长说明可滚动不挤出底栏。
- **REQ-2 InputGroup 与 Combobox 高度统一及防溢出/防重叠**（`input-group.tsx:17,26,70-75,94-100,118-123`、`combobox.tsx:58,105,133,141,199,219,227`、`SearchableSelect.tsx:41-55`）：
  - `InputGroup`、`ComboboxContent` 内嵌 `input-group`、`ComboboxChips` 默认高度统一为 `h-8` / `min-h-8`；
  - `InputGroupInput` 补 `h-full text-xs`；`inputGroupAddonVariants` 移出基础类 `py-2`（仅 `block-start`/`block-end` 保留垂直内边距，inline 变体使用 `py-0`）；
  - `InputGroupButton` 修正 `sm`（`h-6 px-2`）与 `icon-sm`（`size-6`），防止继承 `<Button>` 32px 高度溢出；
  - `ComboboxItem` 改为 `pl-2 pr-7`，文本区保障 `min-w-0`，消除长选项与右侧 `CheckIcon` 重叠；
  - `ComboboxChip` 增高至 `h-6` 或内部移除按钮缩小为 `size-4` 消除上下溢出。
- **REQ-3 SelectTrigger 截断修复与下拉列表内边距**（`select.tsx:12,22,41,82,88`、`SelectField.tsx:40-44`、`textarea.tsx:9`）：
  - 解除 `SelectValue` 上 `line-clamp-1` 与 `flex` 冲突，改为 `min-w-0 flex-1 truncate` 使定宽选择器正确显示省略号；
  - `SelectPrimitive.List` 补 `p-1`（消除选项紧贴外框），去除 `SelectGroup` 重复 `p-1`；
  - `SelectTrigger` 与 `Textarea` 水平内边距统一为 `px-2.5` 对齐 `Input`。
- **REQ-4 Toggle / ToggleGroup / Tabs 尺寸与键盘导航修复**（`toggle.tsx:6,16-19`、`toggle-group.tsx:28,37-49`、`tabs.tsx:5-13,51,54`）：
  - `Toggle` 高度档位对齐 `Button`：`sm: h-7`、`default: h-8`、`lg: h-9`，`text-[0.625rem]` 替换为 `text-2xs`；
  - `ToggleGroup` 与 `Tabs` 显式透传 `orientation={orientation}` 给 Base UI 原语，修复垂直键盘导航；
  - `TabsTrigger` 高度改 `h-full`、修正 `line` 变体 `bottom-0`，统一 Focus Ring 为 `ring-2 ring-ring/30`。
- **REQ-5 状态点、徽章、Alert、Progress、ScrollArea、Sonner、Dropdown、Pagination、Field、Panel 与全局滚动条修复**：
  - `status-pill.tsx:20-28`：`TONE_DOT` 改用实色语义 Token（`bg-success`、`bg-warning`、`bg-destructive`、`bg-info`、`bg-primary`）；
  - `badge.tsx:7,23,27`：`danger` 暗色模式保证 >= 4.5:1 对比度；`size="xs"` 补稳定行高（`leading-none` 或 `index.css` 补 `--text-2xs--line-height`），Focus Ring 统一 `ring-2 ring-ring/30`；
  - `alert.tsx:6,11-12,54`：`destructive` 补充 `border-destructive/50` 与柔红底色及 `px-3 py-2`；`AlertDescription` 补 `group-has-[>svg]/alert:col-start-2`，仅在存在 `AlertTitle` 时应用 `row-span-2`；
  - `scroll-area.tsx:8-13`：根节点补 `flex flex-col overflow-hidden`，`Viewport` 改 `min-h-0 flex-1`，使 `max-h-*` 正确触发滚动；
  - `progress.tsx:47`：`ProgressIndicator` 增加 `data-indeterminate` 宽度与动画（如 `data-indeterminate:w-1/3 data-indeterminate:animate-pulse`），修复 `<Progress value={null} />` 空白条；
  - `sonner.tsx:3,14`：改用 `useAppearance().resolvedTheme` 替代未挂载的 `next-themes`；
  - `dropdown-menu.tsx:39,88,117,166,202`：`DropdownMenuContent` 改 `w-auto min-w-32`（或 `min-w-[max(8rem,var(--anchor-width))]`），统一子项 `py-1 text-xs/relaxed`；
  - `pagination.tsx:59,64,77,82,99,105`：`PaginationEllipsis` 改 `size-8`，英文默认文案改为中文；
  - `field.tsx:155`：`FieldSeparator` 标签背景避免硬编码 `bg-background`（改为适配 `bg-card` 或继承背景）；
  - `panel.tsx:31-42`：`{action}` 外层包 `shrink-0`，标题补 `font-heading`；
  - `index.css:166-196`：L195 全局通配 `scrollbar-width: thin` 排除 `.topbar-nav`（`:not(.topbar-nav)`），恢复 `.topbar-nav` 4px 细滚动条。

## 4. 范围边界（Out of Scope）

- 不在本任务中改动业务页面/业务弹窗的特定业务逻辑或私有布局（仅涉及全局共享原语与 `SelectField`/`SearchableSelect` 封装适配）。
- 不卸载 `next-themes` 依赖（仅停止在 `sonner.tsx` 中调用）。

## 5. 验收标准（Acceptance Criteria）

- [ ] **AC-1**：`Button`、`Input`、`SelectTrigger`、`InputGroup`、`ComboboxInput`、`TabsList`、`Toggle` 默认高度均为 `h-8`（32px）；`InputGroupButton`、`ComboboxChip`、`PaginationEllipsis` 无溢出或错档；`SelectField` 长文本显示省略号，`ComboboxItem` 长文本不与选中对勾重叠。
- [ ] **AC-2**：所有 `Dialog` 正文与 `DialogHeader`/`DialogFooter` 在 Windows 下左缘齐平；`DialogHeader` 不遮挡右上角 `×`；`DialogFooter` 默认垂直居中且内置关闭按钮为中文；`ConfirmDialog` 长描述可滚动。
- [ ] **AC-3**：垂直 `ToggleGroup` 与 `Tabs` 支持上下方向键导航；`ScrollArea` 在 `max-h-*` 容器内可正常滚动；`Progress value={null}` 显示可见动画；`Toaster` 跟随 `AppearanceProvider` 浅/深色切换同步变化；`.topbar-nav` 在 Chrome 下保持 4px 细滚动条；`TONE_DOT` 在浅/深色下清晰可见，`Badge danger` 暗色对比度达标。
- [ ] **AC-4**：`@trellis-board/web` 的 `oxlint`、`tsc --noEmit`、`oxfmt --check` 与根仓库 `yarn test` 全部通过。
