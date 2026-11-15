# 实施计划

## 实施顺序

1. 补齐 `TeamRuntime` 的完整授权项目类型声明。
2. 新增基于 `@base-ui/react/combobox` 的 `SearchableSelect`，提供搜索、空状态和键盘选择。
3. 在 `ArchiveView` 中加入页面内团队、项目状态与选项过滤，将负责人右侧的占位文本替换为两个筛选控件。
4. 让 `useArchiveTasks` 使用页面内团队、项目选择；项目变化时任务空间固定为 `all`。
5. 从 `BoardPage` 向归档页传入运行时团队与全部授权项目，保持页面筛选不影响全局 `filters`。

## 验证

- 静态检查：
  - Web 类型检查通过，`npm run build --workspace @trellis-board/web` 成功。
  - Web lint 退出成功，仅保留项目既有警告。
- 自动测试：
  - Web 测试 78/78 通过。
- 页面验证：
  - 团队下拉输入关键词可过滤。
  - 项目下拉输入关键词可过滤，并随团队选择收窄。
  - 切换归档页团队/项目后顶栏与左侧项目选择不变。
  - 列表、分页、刷新、任务详情打开仍正常。

## 风险文件

- `apps/web/src/features/board/ArchiveView.tsx`
- `apps/web/src/hooks/useArchiveTasks.ts`
- `apps/web/src/pages/board/BoardPage.tsx`
- `apps/web/src/api/board.ts`
- 新增 `apps/web/src/features/board/SearchableSelect.tsx`

## 回滚点

- 新组件尚未接入时：删除组件文件即可。
- 已接入后：还原归档页的状态、查询参数和 BoardPage 传参，不涉及数据层恢复。
