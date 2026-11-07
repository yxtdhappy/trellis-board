# 按项目过滤任务委派人

## Goal

任务详情弹窗的“更新派发”只展示当前任务所属项目 `.trellis/workspace` 中的人员，避免把其他项目成员列为可选项。

## Background

- 当前看板从全部任务聚合负责人：[BoardPage.tsx](../../../web/src/pages/board/BoardPage.tsx:60)。
- 聚合后的全部负责人被直接传入任务详情弹窗：[BoardPage.tsx](../../../web/src/pages/board/BoardPage.tsx:230)。
- 弹窗用该列表生成负责人选项：[TaskDetailDialog.tsx](../../../web/src/features/board/dialogs/TaskDetailDialog.tsx:528)。
- `/api/board` 的项目对象已经包含本仓库 workspace 成员 `members`；例如当前 `mdp-report-service` 只有 `yhj`。
- 后端更新负责人时已经校验目标人员必须存在于该仓库的 `.trellis/workspace`：[actions.js](../../../server/actions.js:118)。

## Requirements

- 打开任务详情时，根据任务的 `projectId` 找到对应项目。
- “更新派发”下拉框优先使用该项目的 `members`，只显示本项目 workspace 成员。
- 当前任务来自哪个项目，就使用哪个项目的成员；不受左侧“全部项目”或当前筛选影响。
- 项目对象缺少成员数组时保留原有的全局负责人列表，避免影响团队模式等尚未提供该字段的场景。
- 修改后自动刷新任务详情和看板，并继续使用现有后端 workspace 校验和错误提示。

## Acceptance Criteria

- [x] 打开 `mdp-report-service` 任务时，委派人候选只有 `yhj`，不出现其他项目人员。
- [x] 打开包含多个 workspace 成员的项目任务时，候选仅包含该项目的 workspace 成员。
- [x] 切换不同项目任务时，候选列表随任务所属项目变化。
- [x] 左侧选择“全部项目”时，仍按单个任务的所属项目过滤，而不是使用全局人员列表。
- [x] 不改变顶部负责人筛选和创建任务弹窗的行为。
- [x] 前端 lint、TypeScript 检查和构建通过。
- [x] 使用真实看板确认任务详情下拉框与对应项目 workspace 成员一致。

## Out of Scope

- 不修改 `.trellis/workspace` 内容或项目成员数据。
- 不新增后端接口。
- 不改变任务创建、顶部负责人筛选和其他人员选择器。

## Technical Notes

- 轻量前端修复，PRD 足够，不新增 `design.md` 或 `implement.md`。
- 主要修改 `Project` 类型、`BoardPage` 的详情弹窗传参；现有 `TaskDetailDialog` props 可继续复用。
