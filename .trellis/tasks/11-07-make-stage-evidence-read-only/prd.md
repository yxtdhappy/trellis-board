# 阶段证据改为只读展示

## Goal

任务详情中的阶段证据只展示 Trellis Board 根据仓库文件和任务状态自动推导的结果，不再把阶段行做成可点击操作，避免人工误触把任务错误推进到提交、归档或收尾阶段。

## Background

- 阶段证据列表中的每一行当前都是可点击按钮：[TaskDetailDialog.tsx](../../../web/src/features/board/dialogs/TaskDetailDialog.tsx:374)。
- 点击任意阶段会调用 `actions.setStage()`，请求 `PUT /api/tasks/stage`，并写入人工阶段和 `stage_manual_confirmed` 事件：[server/index.js](../../../server/index.js:799)。
- 该入口没有二次确认或前置阶段校验，新建且尚未实施的 planning 任务可以被直接点击“归档”。
- 人工记录 `archive` 会让 `withManualStages()` 将归档标为完成，随后看板进入 `journal` / “检查 / 收尾”泳道。

## Requirements

- “阶段证据”区域改为只读展示，不提供阶段按钮、点击事件或键盘操作语义。
- 任务详情前端不再调用 `setStage` / `PUT /api/tasks/stage`。
- 移除看板前端中仅供详情阶段按钮使用的人工阶段 action 和 API helper。
- 阶段完成状态、来源和证据继续由 Trellis Board 自动推导并展示。
- 已有错误人工阶段仍可通过“撤销最近操作”回退；本次不迁移其他任务的历史人工阶段。
- 不修改后端人工阶段接口、SQLite schema、自动阶段推导算法或泳道映射。

## Acceptance Criteria

- [x] 打开任务详情后，阶段证据行不再是按钮，不能点击，也不能通过键盘触发。
- [x] 点击或聚焦阶段证据不会发送 `PUT /api/tasks/stage` 请求。
- [x] 前端代码中任务详情不再引用 `setStage`，看板不再暴露人工阶段 action。
- [x] 自动推导的阶段状态、来源、证据文本和进度显示保持不变。
- [x] 已有 manual 阶段数据仍正常显示，但不会因详情操作产生新的 manual 记录。
- [x] 前端 lint、TypeScript 检查和构建通过。
- [x] 真实页面确认阶段区域只读，数据库人工阶段记录没有新增。

## Out of Scope

- 不删除后端 `PUT /api/tasks/stage`，避免影响潜在兼容调用。
- 不清理其他任务已有的人工阶段记录。
- 不修改 Trellis 框架或 `task.json.status`。
- 不改变自动阶段推导、泳道映射或任务排序。

## Technical Notes

- 该修改改变任务详情交互和前端 API 调用边界，需要 `design.md` 和 `implement.md`。
- 核心原则：Trellis 任务事实和阶段推进由仓库证据决定，详情页只负责展示。
