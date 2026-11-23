# 修复任务详情弹窗关闭按钮高度与对齐问题

## 1. 目标与用户价值（Goal & User Value）

解决任务详情弹窗（`TaskDetailDialog`）底部操作栏的视觉错位问题：使右下角「关闭」按钮与弹窗内其他按钮（特别是左侧「更新派发」按钮及负责人下拉框）高度一致，并在同一操作行上垂直居中对齐，提升弹窗底栏视觉一致性。

## 2. 已确认事实（Confirmed Facts）

- `packages/web/src/features/board/dialogs/TaskDetailDialog.tsx:601-643`：`DialogFooter` 左侧容器包含「负责人选择 `SelectField` + 更新派发 `Button`」操作行，以及条件渲染的 `commandBlocked` 警告文案（L628-L632）和 `!assignmentReadOnly` 说明文案（L633-L638）；右侧为「关闭」按钮（L640-L642）。
- 高度不一致根因：`TaskDetailDialog.tsx` 中「编辑计划」（L388）、「保存计划字段」（L437）、「创建阻断依赖」（L563）、「更新派发」（L613）均使用默认尺寸 `size="default"`（`packages/web/src/components/ui/button.tsx:22-23`，`h-8` / 32px），`SelectField` 触发器默认亦为 `h-8`（`packages/web/src/components/ui/select.tsx:41`）；而「关闭」按钮（L640）显式传了 `size="sm"`（`button.tsx:25`，`h-7` / 28px），导致矮 4px。同模块兄弟弹窗 `TaskDetailArtifactViewer.tsx:38`、`AssigneeWarningDialog.tsx:80`、`TaskOwnershipDialog.tsx:329` 的底栏关闭/取消按钮均使用默认尺寸（`h-8`）。
- 对齐错位根因：`DialogFooter`（`packages/web/src/components/ui/dialog.tsx:143`）未设置垂直居中对齐，且「关闭」按钮与包含多行提示文案的左侧整块容器平级，无法保证在有无提示文案时都与「更新派发」按钮所在行垂直居中对齐。

## 3. 需求明细（Requirements）

- **REQ-1 按钮高度统一**：任务详情弹窗右下角「关闭」按钮高度须与同弹窗内的「更新派发」按钮、`SelectField` 及其他默认尺寸按钮一致（均为标准 `default` 尺寸 / `h-8`，32px），保留 `variant="outline"` 样式与点击关闭弹窗行为。
- **REQ-2 操作行垂直居中对齐**：在桌面端（`>= sm`）布局下，「关闭」按钮须与左侧「负责人选择框 + 更新派发按钮」处于同一水平操作行并垂直居中对齐（`items-center`），且在下方存在或不存在 `commandBlocked` / `!assignmentReadOnly` 提示文案时，均保持与「更新派发」按钮中心线对齐，不被下方提示文案拉偏。
- **REQ-3 窄屏与文案兼容**：窄屏（`< sm`）下底栏按钮与提示文案不发生重叠或裁切；提示文案的可读性、角色属性（`role="status"`）与条件渲染逻辑保持不变。

## 4. 范围边界（Out of Scope）

- 不修改公共组件 `DialogFooter`（`packages/web/src/components/ui/dialog.tsx`）或 `Button`（`packages/web/src/components/ui/button.tsx`）的全局默认样式。
- 不顺带修改其他弹窗（如 `SavedViewsDialog.tsx`）的按钮尺寸。
- 不改动负责人派发、权限校验、归档只读逻辑或提示文案内容。

## 5. 验收标准（Acceptance Criteria）

- [x] **AC-1**（对应 REQ-1）：在 `TaskDetailDialog.tsx` 中，右下角「关闭」按钮渲染高度与左侧「更新派发」按钮及负责人下拉框完全一致（同为 `h-8` / 32px），且不带有 `size="sm"`。
- [x] **AC-2**（对应 REQ-2）：在桌面视口下，无论任务处于可派发态（下方展示提示文案）、命令受阻态（展示 `commandBlocked` 警告）还是只读归档态（无下方提示文案），「关闭」按钮均与左侧「更新派发」按钮在同一水平行上垂直居中对齐（两者垂直中心坐标一致）。
- [x] **AC-3**（对应 REQ-3）：点击「关闭」按钮仍正常触发 `onOpenChange(false)` 关闭弹窗；窄屏下布局无溢出或遮挡；前端静态检查/类型检查/现有测试通过。
