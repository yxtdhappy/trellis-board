# 实施计划：修复桌面端专有窗口、浮层与差异视图 UI 缺陷

## 1. 前置检查

- 确认子任务 2（`11-23-ui-primitives-foundation`）已完成并归档。

## 2. 有序实施清单

1. **`HandoffNotice.tsx`（REQ-1）**：调整 `bottom-4 right-4` 定位、增加折叠收起态、替换 `text-amber-500`/`text-sky-500` 为 `text-warning`/`text-info`。
2. **`LiveSyncControlDialog.tsx`、`ActionBar.tsx`、`DiffViewer.tsx`（REQ-2）**：调整条件弹窗宽度、头部层级、去重复 `mt-0.5`、条件渲染 `DialogFooter`、`ActionBar` 去 `size="sm"`、`DiffViewer` 列表高度与截断及降级框样式。
3. **`UpdateDialog.tsx`（REQ-3）**：更新中隐藏右上角 `×`、修复 `"v—"`、日志区补 `break-words`。
4. **`LoginApp.tsx`（REQ-4）**：`pending` 加载卡、`env` 间距与按钮 `h-8` 统一、去重复 `mt-0.5`、`footer` 条件渲染与长路径断行。

## 3. 验证命令

```powershell
npx oxfmt packages/web/src/desktop
yarn format:check
yarn workspace @trellis-board/web lint
npx tsc -p packages/web/tsconfig.app.json --noEmit
yarn test
git ls-files --eol | rg 'i/crlf'
```
