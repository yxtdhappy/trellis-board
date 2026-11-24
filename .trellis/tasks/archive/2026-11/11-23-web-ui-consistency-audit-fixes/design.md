# 技术设计：全局 UI 一致性与视觉缺陷治理

## 1. 架构分层与文件所有权边界

为确保 6 个子任务能够独立实现、检查和归档，按代码分层划分严格的文件所有权，避免多人/多任务并行冲突：

| 子任务 | 独占修改目录 / 文件 | 共享焦点文件边界说明 |
| --- | --- | --- |
| 1. `11-23-task-detail-close-button-alignment` | `TaskDetailDialog.tsx`（仅 L601-L643 底栏） | 与子任务 3 串行：1 先合入底栏修复，3 再改其余区块 |
| 2. `11-23-ui-primitives-foundation` | `packages/web/src/components/ui/*`、`packages/web/src/index.css`、`packages/web/src/features/board/SelectField.tsx`、`SearchableSelect.tsx` | 作为所有页面与弹窗的原语底座，优先完成并归档 |
| 3. `11-23-dialogs-ui-consistency-fixes` | `packages/web/src/features/board/dialogs/*`、`packages/web/src/features/settings/PreferencesDialog.tsx`、`packages/web/src/features/plugins/PluginLogsDialog.tsx`、`packages/web/src/features/admin/{OneTimeCredentialDialog,ResetPasswordDialog}.tsx`、`packages/web/src/features/board/ConditionChecks.tsx` | `TaskDetailDialog.tsx`（L328-L568）在子任务 1 之后修改；`PluginLogsDialog.tsx` 在子任务 5 复用前先完成 |
| 4. `11-23-board-layout-views-ui-fixes` | `packages/web/src/pages/board/BoardPage.tsx`、`packages/web/src/pages/login/LoginPage.tsx`、`packages/web/src/components/layout/{TopBar,ProjectRail}.tsx`、`project-rail/ProjectEntry.tsx`、`packages/web/src/features/board/{Kanban,AttentionQueue,TaskCard,StageTape,ExecutionHeader,OwnershipInboxPanel,TeamView,ArchiveView,Pagination,TaskOperationList,FlowSignals,Overview,StatTile}.tsx` | 与 `TeamSwitcher.tsx`（子任务 5）通过 `className` props 边界解耦 |
| 5. `11-23-admin-plugins-ui-fixes` | `packages/web/src/pages/admin/AdminPage.tsx`、`packages/web/src/features/admin/{ArchiveSyncTab,ArchiveSyncTaskSpaceRow,AuditTab,BranchManagementPanel,DevicesTab,PluginsTab,PluginBindingForm,ProjectsTab,TeamsTab,TeamSwitcher,UsersTab,AccountForm,shared}.tsx`、`packages/web/src/lib/admin-shared.ts`、`packages/web/src/features/plugins/{DesktopPluginsView,PluginPanel}.tsx` | `DesktopPluginsView.tsx` 复用子任务 3 修复后的 `PluginLogsDialog.tsx` |
| 6. `11-23-desktop-ui-fixes` | `packages/web/src/desktop/{HandoffNotice,LiveSyncControlDialog,UpdateDialog,LoginApp}.tsx`、`packages/web/src/desktop/live-control/{ActionBar,DiffViewer}.tsx` | 依赖子任务 2 提供的 `Progress`、`Sonner`、`Alert`、`Dialog`、`ToggleGroup` 原语能力 |

## 2. 全站设计基线约定

1. **控件尺寸阶梯**：
   - 表单输入控件、主工具栏控件、弹窗底栏按钮默认统一 `h-8`（32px）；
   - 表格/列表行内紧凑操作按钮统一 `size="sm"`（`h-7` / 28px）；
   - 同行控件严禁跨档混排（如 `h-8` 与 `h-7`/`h-6` 并排）。
2. **弹窗结构与底栏秩序**：
   - `DialogHeader` 默认右留白 `pr-8` 避让关闭按钮；`DialogBody` 与 Header/Footer 左右缘对齐；
   - `DialogFooter` 垂直居中（`sm:items-center`），左次右主（取消/关闭 `variant="outline"` 在左，主动作 `default`/`destructive` 在右），仅一个实心主按钮。
3. **文本溢出与响应式保护**：
   - Flex 子项动态文本容器必带 `min-w-0`，配合 `truncate` / `break-words` / `break-all`；固定标签或右侧操作组必带 `shrink-0`。
4. **语义色与暗色适配**：
   - 禁用原始 Tailwind 色（如 `text-amber-500`、`text-sky-500`），一律使用 CSS 变量语义 Token；
   - 覆盖自带 `dark:` 样式的组件类时，显式补齐对应的 `dark:` 覆盖类。

## 3. 兼容与回滚策略

- 每个子任务均以独立目录、独立修改范围与独立提交验证，出现问题可直接按子任务级别回滚，不影响已合入的其他域。
- 子任务 2 修改基础原语后，需排查全站对 `DialogHeader`/`DialogBody`/`InputGroup`/`Select`/`Toggle`/`Alert` 已有局部补丁类（如 `PreferencesDialog.tsx:90`、`SearchableSelect.tsx:44`、`TaskDetailDialog.tsx:301`）是否产生叠加冲突，确保视觉向后兼容。
