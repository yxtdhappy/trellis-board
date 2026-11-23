# 实施计划：修复看板顶栏、项目侧栏与核心视图布局缺陷

## 1. 前置检查

- 确认子任务 2（`11-23-ui-primitives-foundation`）已完成并归档。

## 2. 有序实施清单

1. **布局壳层（REQ-1 & REQ-2）**：
   - 修改 `TopBar.tsx`（紧凑搜索 `h-8` 取消按钮、容器查询导航保活、高度改 `min-h`、头像下拉用户名截断与图标区分）
   - 修改 `ProjectRail.tsx`、`ProjectEntry.tsx` 与 `BoardPage.tsx`（侧栏滚动分层、`<lg` 抽屉入口、分支操作拆分、`border-transparent` 防跳动、待归属按钮及 Alert 修正）
2. **看板主流水线与卡片（REQ-3 & REQ-4）**：
   - 修改 `Kanban.tsx`、`TaskCard.tsx`、`StageTape.tsx`
   - 修改 `AttentionQueue.tsx`、`ExecutionHeader.tsx`、`OwnershipInboxPanel.tsx`
3. **团队视图、归档视图、操作列表、概览指标与登录页（REQ-5）**：
   - 修改 `TeamView.tsx`、`ArchiveView.tsx`、`Pagination.tsx`
   - 修改 `TaskOperationList.tsx`、`FlowSignals.tsx`、`Overview.tsx`、`StatTile.tsx`、`LoginPage.tsx`

## 3. 验证命令

```powershell
npx oxfmt packages/web/src/pages/board/BoardPage.tsx packages/web/src/pages/login/LoginPage.tsx packages/web/src/components/layout packages/web/src/features/board
yarn format:check
yarn workspace @trellis-board/web lint
npx tsc -p packages/web/tsconfig.app.json --noEmit
yarn test
git ls-files --eol | rg 'i/crlf'
```
