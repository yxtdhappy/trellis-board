# 实施计划：修复基础 UI 原语高度对齐与全局样式缺陷

## 1. 有序实施清单

1. **Dialog & ConfirmDialog 原语（REQ-1）**：
   - 修改 `packages/web/src/components/ui/dialog.tsx`（关闭按钮 `top-3 right-3`、`DialogHeader` 避让 `pr-8`、`DialogBody` 移除 `both-edges`、`DialogFooter` 增 `sm:items-center` 与中文化 `"关闭"`）。
   - 修改 `packages/web/src/components/ui/confirm-dialog.tsx`（长描述包裹 `DialogBody`）。
2. **输入、选择与组合框原语（REQ-2 & REQ-3）**：
   - 修改 `packages/web/src/components/ui/input-group.tsx`（`InputGroup` 改 `h-8`，移除 `Addon` 基础 `py-2`，`InputGroupButton` 补 `sm: 'h-6 px-2'` 与 `'icon-sm': 'size-6'`，`InputGroupInput` 补 `h-full text-xs`）。
   - 修改 `packages/web/src/components/ui/combobox.tsx`（`ComboboxContent` 内嵌 `input-group` 改 `h-8`，`ComboboxChips` 改 `min-h-8`，`ComboboxChip` 兼容 `ChipRemove` 尺寸，`ComboboxItem` 改 `pl-2 pr-7`）。
   - 修改 `packages/web/src/components/ui/select.tsx`、`textarea.tsx`、`features/board/SelectField.tsx`、`SearchableSelect.tsx`（`SelectValue` 截断修复、`SelectPrimitive.List` 补 `p-1`、`px-2.5` 对齐）。
3. **Toggle / Tabs / Dropdown / Pagination / Field / Panel（REQ-4 & REQ-5）**：
   - 修改 `toggle.tsx`、`toggle-group.tsx`、`tabs.tsx`（尺寸对齐 `h-8`、透传 `orientation`、统一 Focus Ring、`TabsTrigger` 高度与下划线修复）。
   - 修改 `dropdown-menu.tsx`（`w-auto min-w-32` 与子项间距统一）、`pagination.tsx`（`PaginationEllipsis` 改 `size-8` 及中文化）、`field.tsx`（`FieldSeparator` 背景适配）、`panel.tsx`（`action` `shrink-0` 与 `font-heading`）。
4. **视觉反馈、主题与滚动条（REQ-5）**：
   - 修改 `status-pill.tsx`（`TONE_DOT` 实色 Token）、`badge.tsx`（`danger` 暗色对比度 + `size="xs"` 行高 + Focus Ring）、`alert.tsx`（`destructive` 边框底色与单行对齐）、`scroll-area.tsx`（`flex flex-col overflow-hidden` + `min-h-0 flex-1`）、`progress.tsx`（`data-indeterminate` 动画）、`sonner.tsx`（接入 `useAppearance`）、`index.css`（`--text-2xs--line-height` 与 `*:not(.topbar-nav)` 滚动条排除）。

## 2. 验证命令

```powershell
npx oxfmt packages/web/src/components/ui packages/web/src/features/board/SelectField.tsx packages/web/src/features/board/SearchableSelect.tsx packages/web/src/index.css
yarn format:check
yarn workspace @trellis-board/web lint
npx tsc -p packages/web/tsconfig.app.json --noEmit
yarn test
git ls-files --eol | rg 'i/crlf'
```

## 3. 回滚点

- 如 `ScrollArea` 的 flex 改造对特定定高父级（如 `Kanban`）产生高度异常，可先保留 `ScrollArea` 为 `overflow-hidden` 配合内部容器滚动或按需通过 `className` 调节。
- 如 `DialogHeader` 默认 `pr-8` 影响无关闭按钮弹窗的左右对称，通过 `DialogIdContext` 或新 Context 仅在 `showCloseButton === true` 时注入 `pr-8`。
