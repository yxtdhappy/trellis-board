# 修复检查阶段卡片看板分栏

## Goal

让看板根据真实完成证据推导实施与检查阶段：`check` 应进入“检查 / 收尾”，但仅开始任务不能被误判为实施完成并直接跳到检查。

## Requirements

- `check` 及后续收尾阶段必须归入“检查 / 收尾”泳道。
- `review` 继续归入“待放行”泳道，`implement` 继续归入“实现”泳道。
- `task.json.status=in_progress` 只表示任务已开始，不单独作为实施完成证据。
- 实施完成必须有实施报告、检查报告、已勾选验收项、提交或已完成状态之一作为证据。
- 没有任何完成证据的已开始任务保持在实现阶段；默认 PRD 骨架任务不能被推进到检查阶段。
- 不修改 Trellis 原始任务状态、任务排序或看板其他交互。
- 卡片所在的泳道必须由当前 `derivedStage` 稳定决定。

## Acceptance Criteria

- [x] `derivedStage=check` 的任务显示在“04 检查 / 收尾”泳道。
- [x] `derivedStage=implement` 的任务仍显示在“03 实现”泳道。
- [x] `review`、`e2e`、`spec`、`commit`、`archive` 的泳道归属保持不变。
- [x] 增加覆盖分栏边界的回归验证，并最终执行一次项目测试。
- [x] 除本任务记录和必要的规范回写外，不修改 `.trellis`、后端接口或与分栏无关的前端逻辑。
- [x] 仅 `status=in_progress` 且有有效 PRD 的任务仍推导为 `implement`，不会被误判为检查完成。
- [x] 仅 `status=in_progress` 且 PRD 仍为默认骨架的任务仍停留在规划阶段。
- [x] 有实施报告、检查报告、验收勾选或已完成状态时，实施与检查推导保持现有行为。
- [x] 归档历史任务的已完成阶段不因证据门禁调整而回退。
- [x] 真实看板确认两个 Bootstrap Guidelines 测试任务离开“检查 / 收尾”。

## Notes

- 前端分栏边界已修正；本任务继续收敛后端阶段证据推导，保持 PRD-only。
- 根因：`server/loader.js` 把 `task.json.status=in_progress` 直接计入 `hasImplementationEvidence`，导致尚未实现的任务也被视为实施完成。
