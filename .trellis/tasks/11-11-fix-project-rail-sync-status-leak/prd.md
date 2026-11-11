# 修复项目栏同步状态跨项目污染

## Goal

修复 ProjectRail 未选中项目错误复用 currentTaskSpace 关联状态的问题，确保每个项目只展示自身 taskSpace 的同步状态，并补充切换项目的回归验证。

## Requirements

- 项目栏每个项目的同步状态必须只由该项目自身的 taskSpace 决定，不能读取其他项目当前选中的 taskSpace。
- 当前选中项目可以展示当前分支对应的同步状态；未选中项目必须使用自身默认分支或自身 taskSpace 聚合状态。
- 多分支项目不得把某个分支的失败或同步中状态隐藏为“同步正常”；父项目状态至少应优先反映 `error`，其次是 `syncing`，再其次是 `pending`，只有自身已关联分支全部正常时才能显示 `ready`。
- 选中任意项目或切换分支时，只允许当前项目的展示上下文变化，其他项目的同步状态文案和状态点不得变化。
- 后端关联数据和 Agent 实际同步状态不需要迁移；本任务只修复前端状态选择逻辑并补回归验证。

## Acceptance Criteria

- [x] 当 `mdp-backend-service` 的 taskSpace 处于 `syncing`、`trellis-board` 的 taskSpace 处于 `ready` 时，项目栏分别显示“正在同步”和“同步正常”，不会互相污染。
- [x] 切换当前项目后，未选中项目的状态文案、状态点和错误详情保持与自身 taskSpace 一致。
- [x] 展开当前项目后，各分支状态继续按各自 taskSpace 独立展示。
- [x] 多分支项目按自身分支状态聚合，任一分支 `error` 或 `syncing` 时不会错误显示为全局“同步正常”。
- [x] 无本地关联的项目仍显示“未关联”，不会继承当前项目的已关联状态。
- [x] 至少有一个回归测试覆盖两个项目、两个 taskSpace、不同同步状态和切换项目的场景。

## Notes

- 根因位置：`web/src/components/layout/ProjectRail.tsx` 中，未选中项目会回退读取全局 `currentTaskSpace` 的 association。
- 当前两个项目各有独立 taskSpace，底层 `associations` Map 以 `taskSpaceId` 为 key，数据本身未串。
- 截图中的状态污染是确定性的前端渲染问题，不是轮询竞态。
