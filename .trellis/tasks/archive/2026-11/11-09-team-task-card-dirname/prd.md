# 团队任务卡片补齐目录名

## Goal

让团队模式与单机模式共用同一套任务卡片展示契约：任务标题下方始终显示真实的 `.trellis/tasks/<任务目录>` 目录名。

## Background

- 11 月 8 日任务 `11-07-task-card-real-title` 已在共享组件 `web/src/features/board/TaskCard.tsx` 展示 `task.dirName`，但只在单机模式完成页面验收。
- 团队接口返回任务的 `relativeDir`，未直接返回 `dirName`。
- `web/src/lib/team-client.js` 已提供 `normalizeTaskPage`，可从 `relativeDir` 派生目录名且有单元测试。
- 当前团队查询路径 `queryTeamTasks` 直接返回原始响应，`useBoard` 随后将缺少 `dirName` 的任务传给共享任务卡，导致标题下方为空。

## In Scope

- 在团队任务查询边界复用现有 `normalizeTaskPage`。
- 补充覆盖 `relativeDir` 到 `dirName` 契约的回归断言。
- 在现有团队看板运行态验证任务卡目录名实际可见。

## Out of Scope

- 不修改任务卡视觉布局、标题、复制按钮文案或其他字段。
- 不修改团队接口响应格式、单机 `/api/board` 数据路径或权限逻辑。
- 不修改“团队视角”表格和团队管理页。

## Requirements

- R1：团队任务查询返回的每一页任务必须先经过现有任务页规范化，再进入 UI 状态。
- R2：目录名必须取 `relativeDir` 的最后一段，例如 `.trellis/tasks/11-08-project-onboarding-remote-info` 显示为 `11-08-project-onboarding-remote-info`。
- R3：单机模式现有 `dirName` 展示和“复制任务名”行为保持不变。
- R4：304 未修改响应和分页字段处理保持现有行为。

## Acceptance Criteria

- [x] 团队模式下，任务卡标题正下方显示对应任务目录名，截图中的“Git 凭据管理与项目接入远端识别”卡片显示 `11-08-project-onboarding-remote-info`。
- [x] 团队模式下，“复制任务名”复制的值与任务卡显示的 `dirName` 完全一致。
- [x] 单机模式下原有任务卡目录名展示不回归。
- [x] 团队任务查询的分页总数、下一页游标和 304 分支行为不改变。
- [x] 相关单元测试、类型检查和最终构建通过。

## Key Decisions

- 复用 `normalizeTaskPage`，不新增目录名解析函数，避免单机、团队和测试出现两份路径解析逻辑。

## Risks

- 团队查询响应同时存在 camelCase 和 snake_case 字段，规范化后必须保持分页字段兼容；通过现有测试和页面验证覆盖。
