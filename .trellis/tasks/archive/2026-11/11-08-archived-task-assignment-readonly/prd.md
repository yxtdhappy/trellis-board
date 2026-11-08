# 禁止归档任务更新派发

## Goal

归档任务在团队版和个人版都必须只读：页面不得允许更新派发，个人版后端必须拒绝修改归档任务，团队版保持后端拒绝并补齐回归覆盖。

## Requirements

- R1：归档任务的任务详情不得允许更新负责人或派发人。
- R2：团队版和个人版共用同一前端入口，两边的“更新派发”按钮及负责人选择都必须进入只读状态。
- R3：个人版后端必须拒绝修改归档任务的 `task.json`，不能仅依赖页面禁用。
- R4：团队版后端继续拒绝归档任务派发，并保留现有并发版本校验和 Git 写入保护。
- R5：非归档任务的派发更新行为保持不变。

## Acceptance Criteria

- [x] 打开已归档任务详情时，负责人选择和“更新派发”按钮不可用。
- [x] 打开未归档任务详情时，负责人选择与“更新派发”按钮保持原有行为。
- [x] 调用个人版 `/api/tasks/assign` 更新归档任务会被明确拒绝，归档任务的 `task.json` 不被改写。
- [x] 团队版 `/api/tasks/assign` 对归档任务继续返回冲突，且不会创建 Git 提交或推送。
- [x] 覆盖前端只读条件、个人版后端拒绝和团队版拒绝的自动化测试。
- [x] 相关聚焦测试和最终一次构建通过。

## Notes

- 这是轻量缺陷修复，PRD-only 即可进入后续实施评审。
- 已确认现状：详情弹窗的派发可用条件未判断 `archived`；个人版 `assignTask` 未校验归档目录；团队版已有归档拒绝分支。
- 现状依据：`web/src/features/board/dialogs/TaskDetailDialog.tsx`、`server/actions.js`、`server/team/task-writes.js`。
- 2026-11-08 验收：`node --test tests/actions.test.js tests/team-web.test.js` 22/22 通过；`node --test tests/team-release.test.js` 1/1 通过；`npm run build` 通过。
- 完整 `npm test` 为 330 通过、1 失败、5 跳过；唯一失败来自 `plugins/a2a-intake` 的 Windows 临时目录 `EPERM` 清理，隔离复跑通过，不属于本任务。
- 浏览器实测：归档任务详情中的负责人选择与“更新派发”按钮均带原生 `disabled` 状态；验收截图位于 `C:/Users/yuhaojie/ego/trellis-archived-assignment-20261108/archived-detail.png`。
