# 技术设计：修复桌面端专有窗口、浮层与差异视图 UI 缺陷

## 1. 模块边界与依赖

修改文件限定在桌面端前端组件：
- `packages/web/src/desktop/HandoffNotice.tsx`
- `packages/web/src/desktop/LiveSyncControlDialog.tsx`
- `packages/web/src/desktop/live-control/ActionBar.tsx`
- `packages/web/src/desktop/live-control/DiffViewer.tsx`
- `packages/web/src/desktop/UpdateDialog.tsx`
- `packages/web/src/desktop/LoginApp.tsx`

依赖子任务 2 提供的原语能力：
- `Progress` 的 `data-indeterminate` 动画样式；
- `Sonner` 接入 `AppearanceProvider` 的主题同步；
- `Alert` 的 `destructive` 样式与图标垂直对齐；
- `ToggleGroup` 的 `orientation="vertical"` 键盘导航透传；
- `DialogHeader` 默认 `pr-8` 避让与 `DialogBody` 左齐平。

## 2. 关键交互与样式设计

1. **`HandoffNotice` 定位与折叠**：
   - 将固定锚点改为 `fixed right-4 bottom-4 z-40`（远离右上角 `Toaster` 和 `TopBar`）；
   - 增加局部 `collapsed` 状态（在展开态右上角放「收起」按钮，收起态展示可点击的紧凑警告胶囊「N 项待处理冲突/同步」），不持久化也不阻断用户点击展开。
2. **`DiffViewer` `flex-col` 截断原理**：
   - `ToggleGroupItem` 为 `flex flex-col items-start` 且未设宽度与溢出裁剪时，子项默认按 `max-content` 撑开。必须同时在 `ToggleGroupItem` 加 `w-full overflow-hidden`（覆盖或限定最大宽），并在子 `<span>` 上加 `block w-full truncate`。
3. **`LoginApp` 状态机一致性**：
   - 保持 `phase === 'pending'` 为最小中性加载卡（复用意图中的品牌标题 + 居中 Spinner/提示），确保无闪白。

## 3. 回滚与验证

- 所有修改纯前端展示层，可单文件独立回退，不影响 Tauri IPC 接口契约。
