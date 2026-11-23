# 技术设计：修复基础 UI 原语高度对齐与全局样式缺陷

## 1. 设计边界与文件范围

本任务仅修改全站共用基础 UI 原语与全局样式层：
- `packages/web/src/components/ui/`: `dialog.tsx`, `confirm-dialog.tsx`, `input-group.tsx`, `combobox.tsx`, `select.tsx`, `textarea.tsx`, `toggle.tsx`, `toggle-group.tsx`, `tabs.tsx`, `status-pill.tsx`, `badge.tsx`, `alert.tsx`, `scroll-area.tsx`, `progress.tsx`, `sonner.tsx`, `dropdown-menu.tsx`, `pagination.tsx`, `field.tsx`, `panel.tsx`
- `packages/web/src/features/board/`: `SelectField.tsx`, `SearchableSelect.tsx`（薄包装适配）
- `packages/web/src/index.css`

## 2. 核心原语对照与关键设计决策

### 2.1 控件尺寸统一基线
| 原语 | 变更前 | 变更后 | 兼容影响 |
| --- | --- | --- | --- |
| `InputGroup` | `h-7` | `h-8` | `SearchableSelect` 的 `h-8` 可保留无冲突，内部 `InputGroupInput` 补 `h-full text-xs` 后不再溢出 |
| `ComboboxContent` 内嵌搜索 | `*:data-[slot=input-group]:h-7` | `*:data-[slot=input-group]:h-8` | 搜索框不再顶破内部边框 |
| `ComboboxChips` | `min-h-7` | `min-h-8` | 与单行输入控件同高 |
| `Toggle` | `sm:h-6 / default:h-7 / lg:h-8` | `sm:h-7 / default:h-8 / lg:h-9` | `PreferencesDialog` 的 `h-8` 覆写仍兼容；`SavedViewsDialog` `PILL_ITEM` 显式写了 `h-6` 不受影响 |
| `PaginationEllipsis` | `size-7` | `size-8` | 与 `PaginationLink` (`size-8`) 对齐 |

### 2.2 Dialog 结构兼容性
- `DialogHeader` 避让方案：若仅在 `DialogContent` 有 `showCloseButton` 时需避让，可在 `DialogContent` 通过 context 传递 `hasCloseButton`（或给 `DialogHeader` 默认 `pr-8`，在 `PreferencesDialog` 等 `showCloseButton={false}` 的自定义 header 上因自带 `justify-between` 与内部关闭按钮，保留 `pr-8` 亦安全或传 `pr-5` 覆盖）。
- `DialogBody` 去掉 `both-edges` 后，保留 `-mx-4 px-4` 仅抵消 `DialogContent` 的 `p-4`，左侧文本起点与 `DialogHeader`/`DialogFooter` 严格对齐 16px。

### 2.3 SelectValue 截断与 Toggle/Tabs 方向透传
- `select.tsx`: 在 `SelectValue` 直接使用 `min-w-0 flex-1 truncate text-left`，并在 `SelectTrigger` 上移除相互冲突的 `*:data-[slot=select-value]:line-clamp-1` 和 `*:data-[slot=select-value]:flex`。
- `toggle-group.tsx` 与 `tabs.tsx`: 把解构出来的 `orientation` 显式回传给 `ToggleGroupPrimitive` 与 `TabsPrimitive.Root`，恢复 Base UI `CompositeRoot` 垂直方向键监听。

### 2.4 ScrollArea 与 Progress 不确定态
- `scroll-area.tsx`: 根 `ScrollAreaPrimitive.Root` 增加 `flex flex-col overflow-hidden`，`Viewport` 使用 `min-h-0 flex-1`（替代在 `max-h-*` 块级父容器下失效的 `size-full`），同时验证在 flex-1 父级（如 `Kanban`）下仍能正常占满并滚动。
- `progress.tsx`: 为 `ProgressIndicator` 增加 `data-indeterminate:w-1/3 data-indeterminate:animate-pulse`（或自定义平移关键帧动画），确保 `value={null}` 时可见进度反馈。

### 2.5 Sonner 主题同步与全局滚动条规则
- `sonner.tsx` 改用 `import { useAppearance } from '@/app/theme'`，传入 `resolvedTheme`（`'light' | 'dark'`）。
- `index.css:193-196` 将 `*` 改为 `*:not(.topbar-nav)`（或在 `@supports not selector(::-webkit-scrollbar)` 内保留），保证 Chrome 121+ 中 `.topbar-nav::-webkit-scrollbar` 的 `height: 4px` 生效。

## 3. 风险点与检查重点

- 修改 `DialogBody`、`SelectTrigger`、`ScrollArea`、`Toggle` 后需检查全站调用方的已有覆写 className（例如 `TaskDetailDialog`、`PreferencesDialog`、`Kanban`、`AttentionQueue`）是否出现冲突或重复边距。
- 确保 `alert.tsx` 修改后，带 `AlertTitle + AlertDescription` 的双行 Alert 与仅带 `<svg> + 文字` 的单行 Alert 均对齐良好。
