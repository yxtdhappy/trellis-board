# 技术设计

## 边界

- 前端页面改动：新增可搜索单选下拉，并将团队、项目状态限制在 `ArchiveView` 内。
- 前端数据接入：归档页接收可访问团队与全部授权项目，用于构造下拉选项。
- 服务端无改动：继续复用 `/api/tasks/query` 的 `teamId`、`projectIds` 和 `archived` 参数。

## 组件设计

新增 `SearchableSelect`：

- 基于已安装的 `@base-ui/react/combobox`，不引入新依赖。
- 接收稳定的 `value`、`options: { value, label }[]`、`onChange` 和 `ariaLabel`。
- 内部输入框负责搜索，选项列表负责键盘高亮与选择，空结果通过 Combobox 空状态提示。
- 选项集合使用 `Combobox.createItems` 维护稳定 ID 与显示名称。

## 状态与数据流

`ArchiveView` 独立维护：

- `archiveTeamId`：默认 `all`。
- `archiveProjectId`：默认 `all`。

数据流：

1. 团队选项来自当前运行时团队列表。
2. 项目选项来自全部授权项目，并按 `archiveTeamId` 过滤。
3. 团队变化时，如果当前项目不在新团队中，将项目重置为 `all`。
4. `useArchiveTasks` 使用页面内 `archiveTeamId`、`archiveProjectId`、分支和任务空间 `all` 发起服务端归档查询。
5. 非团队模式继续使用内存中的归档任务，并按页面内项目状态过滤；团队控件不展示。

全局顶栏和左侧项目栏继续使用已有 `filters.teamId` / `filters.projectId`，归档页控件不得调用全局 `setFilters`。

## 数据契约

Team runtime 接口当前已返回 `projects`，但前端 `TeamRuntime` 类型尚未声明该字段。补齐可选 `projects?: Project[]`，归档页优先使用该完整项目集合；独立模式回退到现有项目列表。

## 兼容与风险

- 现有服务端查询已经支持所需参数，无数据库或 API 迁移。
- 归档页与全局筛选分离后，用户可能同时看到两套团队/项目状态；这是已确认的预期行为。
- `@base-ui/react` Combobox 负责可访问交互，避免自实现键盘导航和焦点管理。

## 回滚

改动集中在 Web 前端。回滚 `ArchiveView`、`BoardPage` 和新增下拉组件即可恢复原有行为，不涉及数据迁移。
