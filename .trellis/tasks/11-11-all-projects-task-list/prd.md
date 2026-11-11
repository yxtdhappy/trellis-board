# 全部项目展示跨任务空间任务

## Goal

团队看板选择“全部项目”时，展示当前团队筛选范围内、当前用户有权读取的全部项目任务，而不是被前端自动收敛到首个项目和首个 taskSpace。

## Background

- 项目栏点击“全部项目”后会设置 `projectId=all`、`taskSpaceId=all`，见 `web/src/pages/board/BoardPage.tsx:211`。
- `useBoard` 的同步 effect 会立即把 `projectId=all` 改成首个项目、把 `taskSpaceId=all` 改成该项目首个分支，见 `web/src/hooks/useBoard.ts:530`。
- 团队任务查询接口当前强制要求 `taskSpaceId`，见 `server/team/task-space-index.js:684`。
- 任务索引 `sync_task_index` 已包含 `task_space_id`、`project_id`、`branch_name` 和任务筛选字段，可复用为跨 taskSpace 查询的数据源，见 `server/database.js:896`。
- 现有规格规定“全部项目/项目只展示分支摘要，需要任务列表时必须选中具体 taskSpace”，见 `.trellis/spec/frontend/rendering-and-state.md:56`。本任务要求变更该产品行为，并同步更新规格。

## Requirements

- R1：选择“全部项目”后，保留 `projectId=all`、`taskSpaceId=all`，不得自动切换到首个项目或首个 taskSpace。
- R2：`GET /api/tasks/query` 在未提供 `taskSpaceId` 时执行跨 taskSpace 查询；提供具体 `taskSpaceId` 时保持现有单分支语义。
- R3：跨 taskSpace 查询必须以服务端权限为准，只返回当前用户可读取的项目和 taskSpace；不得因为 `associationProjects` 中的本地关联资格放宽任务读取权限。
- R4：跨 taskSpace 查询继续支持现有团队、项目、归档状态、搜索、负责人、优先级、阶段、阻塞状态、分页游标和 ETag 语义。
- R5：任务结果继续携带 `taskSpaceId`、`branchName`、`projectId`、`projectName`、`teamId` 和 `teamName`，任务卡片、团队视角、归档和详情可直接复用。
- R6：选择具体项目时展示该项目下所有可读 taskSpace 的任务；选择具体 taskSpace 时行为与当前版本一致。
- R7：切换团队、项目、taskSpace 或筛选条件时必须清空旧游标和 ETag，迟到响应不得覆盖新筛选结果。
- R8：同步更新 Trellis 前端规格，删除与本次需求冲突的“全部项目不展示任务列表”约定。
- R9：同一 project/taskKey 在不同 taskSpace 中必须作为不同任务实例展示，分组、列表 key 和详情刷新身份必须包含 `taskSpaceId`，并用分支名区分。
- R10：任务筛选增加独立的分支模糊筛选，使用单值文本，忽略首尾空格、大小写不敏感，并按分支名任意子串匹配。
- R11：分支筛选必须参与服务端查询、ETag、查询缓存和游标绑定；独立模式必须在现有组合筛选中本地应用同一匹配规则。
- R12：任务流水线、团队视角和归档视图都提供分支筛选入口；清空输入后恢复该视图原有范围。

## Acceptance Criteria

- [ ] 当前团队下项目 A、项目 B 均有任务时，选择“全部项目”后两个项目的任务同时出现在任务流水线中。
- [ ] 同一项目在 `main`、`dev` 两个 taskSpace 都有任务时，选择“全部项目”或该项目后两个分支的任务都会出现，并分别显示分支名。
- [ ] “全部项目”视图中的任务仍显示正确项目名、团队名、分支名和 `taskSpaceId`。
- [ ] 选择项目 A 后显示项目 A 所有可读 taskSpace 的任务；选择项目 A 的某个 taskSpace 后只显示该分支任务。
- [ ] 当前用户无权读取的项目不会出现在“全部项目”结果中，直接请求无权项目仍返回 403 或现有同等拒绝结果。
- [ ] 搜索、负责人、优先级、阶段、阻塞状态、归档状态和分页在跨 taskSpace 查询中与单 taskSpace 查询结果一致。
- [ ] 分页游标绑定用户、团队、筛选条件、查询 revision 和 taskSpace 范围；翻页不重复、不遗漏任务。
- [ ] 任一相关 taskSpace 的索引 revision 变化都会使跨 taskSpace 查询 ETag 失效。
- [ ] 团队、项目或 taskSpace 切换后，旧请求不能覆盖新结果。
- [ ] 同名任务或相同 taskKey 出现在不同 taskSpace 时不会合并为同一分组，也不会选中错误分支的详情。
- [ ] 输入 `DEV` 可以匹配 `dev`、`feature/dev-sync` 等分支；输入首尾空格不改变结果。
- [ ] 分支筛选可与项目、负责人、优先级、阶段、阻塞状态、搜索和归档条件组合使用。
- [ ] 修改分支筛选后会从第一页重载，旧游标和旧响应不会覆盖新结果；清空后恢复全部匹配任务。
- [ ] 单机模式使用本地组合筛选得到与团队模式一致的分支子串匹配结果。
- [ ] 现有单 taskSpace 查询、项目级查询和相关测试不回归。
- [ ] 相关前端、后端聚焦测试通过；全部开发完成后只执行一次最终构建验证。

## Out of Scope

- 修改项目、团队或任务权限模型。
- 新增任务聚合卡片、按分支分栏或其他新的展示结构。
- 在“全部项目”范围内聚合任务操作列表、创建或改派命令队列。
- 数据库表结构迁移或历史任务重新索引。
- 除分支模糊筛选外，不新增其他筛选控件；继续沿用现有项目栏和 taskSpace 选择方式。
- 分支正则、多选、排除条件或分支候选下拉。
