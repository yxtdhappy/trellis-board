# 实施计划：统一全站业务弹窗布局、按钮层级与对齐规范

## 1. 前置检查

- 确认子任务 1（`11-23-task-detail-close-button-alignment`）与子任务 2（`11-23-ui-primitives-foundation`）已完成并归档。

## 2. 有序实施清单

1. **缩进、工具栏与弹窗规范结构修复（REQ-1 & REQ-2）**：
   - `TaskOwnershipDialog.tsx`（L273-304 工具栏 `SelectField` 宽度约束）
   - `PluginLogsDialog.tsx`（L54 `break-words`，L56 移出 `mx-4`/背景色并补 `DialogFooter`）
   - `TaskDetailArtifactViewer.tsx`（L28-42 Markdown 内嵌 `<div>` + `!bg-transparent` + `break-all` + 去 `<X>`）
   - `ProjectManagerDialog.tsx`（L181-192 反转主次按钮）、`PublishOperationDialog.tsx`（L87-92 调换左右顺序）、`AssignmentsDialog.tsx`（补 `DialogFooter`、去 L98 `h-7`）、`AssigneeWarningDialog.tsx`（L79-101 窄屏堆叠修复）
   - `SavedViewsDialog.tsx`（去 `size="sm"`、改用 `Field`+`FieldLabel`、评估合理弹窗宽度）、`PreferencesDialog.tsx`、`ResetPasswordDialog.tsx`、`OneTimeCredentialDialog.tsx`（去 `size="sm"`、统一表单间距与标签色）
2. **任务详情其余区块与条件检查修复（REQ-3）**：
   - `TaskDetailDialog.tsx`（L328/339/388-399/437-439/446/454/477-521/563-568）
   - `TaskDetailDependencyItem.tsx`（L21,27 `break-words`）
   - `TaskDetailArtifactsSection.tsx`（L28-44 `items-center`、`shrink-0`、`flex-1`）
   - `TaskDetailArchiveFiles.tsx`（L24,25,37,40,71 替换为 `text-xs`/`text-2xs`）
   - `ConditionChecks.tsx`（L36-68,74-83,136,174,202,218）
3. **表单提示、标题规范与细部防挤压（REQ-4）**：
   - `ProjectOnboardingDialog.tsx`（L563-568,647-651,686-702）
   - `CreateTaskDialog.tsx`（L191,288-292）、`PasswordDialog.tsx`（L64）
   - `AgentToolSelector.tsx`（L37-52）、`BranchListenersDialog.tsx`（L71-74）
   - 全站弹窗 `DialogTitle` 统一规范核查。

## 3. 验证命令

```powershell
npx oxfmt packages/web/src/features/board/dialogs packages/web/src/features/board/ConditionChecks.tsx packages/web/src/features/settings/PreferencesDialog.tsx packages/web/src/features/plugins/PluginLogsDialog.tsx packages/web/src/features/admin/OneTimeCredentialDialog.tsx packages/web/src/features/admin/ResetPasswordDialog.tsx
yarn format:check
yarn workspace @trellis-board/web lint
npx tsc -p packages/web/tsconfig.app.json --noEmit
yarn test
git ls-files --eol | rg 'i/crlf'
```
