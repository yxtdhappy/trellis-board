# 实施计划：修复管理后台与插件视图对齐、状态色与响应缺陷

## 1. 前置检查

- 确认子任务 2（`11-23-ui-primitives-foundation`）已完成并归档。
- 确认 `PluginLogsDialog.tsx`（子任务 3）已就绪以供 `DesktopPluginsView` 复用（或在本任务中同步确认接口一致）。

## 2. 有序实施清单

1. **语义色与壳层修复（REQ-2 & REQ-3）**：
   - 修改 `packages/web/src/lib/admin-shared.ts`、`ArchiveSyncTaskSpaceRow.tsx`
   - 修改 `AdminPage.tsx`、`TeamSwitcher.tsx`、`AuditTab.tsx`、`BranchManagementPanel.tsx`、`shared.tsx`
2. **后台各 Tab 表单/按钮/列表统一（REQ-1）**：
   - 修改 `ArchiveSyncTab.tsx`、`DevicesTab.tsx`、`UsersTab.tsx`、`AccountForm.tsx`
   - 修改 `PluginBindingForm.tsx`、`ProjectsTab.tsx`、`TeamsTab.tsx`
3. **插件管理与桌面插件/iframe 面板（REQ-4）**：
   - 修改 `PluginsTab.tsx`、`DesktopPluginsView.tsx`、`PluginPanel.tsx`

## 3. 验证命令

```powershell
npx oxfmt packages/web/src/pages/admin/AdminPage.tsx packages/web/src/lib/admin-shared.ts packages/web/src/features/admin packages/web/src/features/plugins
yarn format:check
yarn workspace @trellis-board/web lint
npx tsc -p packages/web/tsconfig.app.json --noEmit
yarn test
git ls-files --eol | rg 'i/crlf'
```
