# 全部项目跨任务空间查询设计

## Goal

在不复制筛选逻辑、不新增数据库表的前提下，让 `/api/tasks/query` 支持跨 taskSpace 查询，并让前端“全部项目”“具体项目”“具体分支”三种选择共享同一套查询链路。

## Current Constraints

- `sync_task_index` 已按 `(task_space_id, task_key)` 存储任务，并包含 `project_id`、`branch_name`、搜索、阶段、负责人、归档及活动时间字段。
- `taskSpaces.listReadable()` 已按团队、项目和任务空间计算实时读取权限，是当前权限事实源；`associationProjects` 不能用于放宽任务读取。
- `queryTasks()` 当前只接受单个 `taskSpaceId`，筛选 SQL、ETag、缓存和游标都在该假定下实现。
- 前端团队查询、活动任务和归档查询都调用 `/api/tasks/query`，因此后端能力必须让三种视图共同复用。
- 同一 task ID 可以同时存在于不同 taskSpace，前端不能只用 `taskKey` 作为分组、列表 key 或详情刷新身份。

## API Contract

`GET /api/tasks/query` 的 `taskSpaceId` 改为可选：

| 输入 | 行为 |
| --- | --- |
| `taskSpaceId=<id>` | 保持现有单分支查询 |
| `taskSpaceId` 缺省或 `all` + `projectIds` 缺省 | 查询当前团队范围内全部可读 taskSpace |
| `taskSpaceId` 缺省或 `all` + `projectIds=<id>` | 查询该项目全部可读 taskSpace |
| `projectIds` 含无权项目 | `403`，与现有多团队查询契约一致 |

服务端从 `taskSpaces.listReadable(actor, { teamId })` 获取可读项目及 taskSpace，再按显式 `projectIds` 收窄。传入具体 `taskSpaceId` 时继续调用 `authorizeTaskSpace()`，并校验它与显式 `projectIds` 一致。

新增可选查询参数 `branch`：

- 去首尾空格、转小写，最大 200 个字符。
- 使用转义后的 `%value%` 对 `LOWER(branch_name)` 做子串匹配，避免 `%`、`_` 被当作通配符。
- 空值表示不筛选；与 `projectIds`、范围内 taskSpace、其他筛选条件做 AND 组合。

## Query Scope

在 `server/team/task-space-index.js` 内部解析一次查询作用域：

```text
teamScope
readableProjects
requestedProjectIds
taskSpaceIds
projectIds
scopeHash = hash(projectIds, taskSpaceIds)
```

具体规则：

- `taskSpaceIds` 与 `projectIds` 均去重并稳定排序后参与哈希。
- 空作用域直接返回空任务页，但仍返回稳定 ETag、revision 和 day。
- SQL 仍使用同一个筛选构造路径，只把单值条件 `task_space_id = ?` 改为 `task_space_id IN (...)`。
- 不使用前端传入的项目名称或团队关系推断权限。

## Pagination and ETag

- 活动任务排序：`last_activity_at DESC, task_space_id DESC, task_key DESC`。
- 归档任务排序：`archived_at DESC, task_space_id DESC, task_key DESC`。
- 游标保存用户、团队作用域、任务空间/项目集合哈希、筛选哈希、query revision、查询日、最后排序时间、最后 `taskSpaceId` 和最后 `taskKey`。
- 游标校验失败统一返回 `409 CURSOR_INVALID`。
- ETag、查询缓存键和游标都绑定实际作用域与筛选；成员关系变化或请求项目集合变化后旧缓存和旧游标不得复用。
- `branch` 属于规范化 filters，因此自动进入筛选哈希、ETag 和查询缓存键。
- 继续使用全局 `queryRevision`；任一 taskSpace 投影变化都会让跨 taskSpace ETag 失效。

## Frontend Data Flow

- `useBoard.loadTeamPage()` 不再因 `taskSpaceId=all` 提前返回，而是正常调用团队查询。
- `useBoard` 只处理“选中的具体项目已失效”回退；`projectId=all` 和 `projectId=<id>, taskSpaceId=all` 都保持不变。
- `ArchiveView` 在团队模式下即使 `taskSpaceId=all` 也启用归档查询。
- `BoardFilters` 增加 `branch`，默认空字符串。
- `buildTaskQuery()` 继续省略值为 `all` 的 `taskSpaceId`，并发送非空 `branch`。
- `ExecutionHeader`、`TeamView` 和 `ArchiveView` 使用同一文本筛选语义；无候选下拉，不做正则或多选。
- 独立模式在 `filterTasks()` 中调用共享 `branchMatches()`，团队模式由服务端筛选，避免两套匹配规则。
- “全部项目”范围不加载跨 taskSpace 的操作列表；创建、改派仍基于具体任务自己的 taskSpace。

## Task Identity

新增一个纯函数模块 `web/src/lib/task-view-key.js` 并配套 `.d.ts`：

- `taskInstanceKey(task)`：`taskSpaceId + taskKey`
- `taskGroupInstanceKey(task)`：`taskSpaceId + (groupKey || taskKey)`

消费位置：

- `groupActiveTasks()` 分组。
- Kanban 分组和子任务 React key。
- 注意力队列、团队视图、归档视图行 key。
- `BoardPage` 选中任务后的新鲜数据匹配。

任务卡片已有分支名；注意力队列、团队视图和归档行补充分支名，保证不同分支的同名任务可辨认。

## Compatibility and Migration

- 不修改 SQLite schema，不需要重新索引。
- 旧客户端继续发送具体 `taskSpaceId`，行为保持兼容。
- 新客户端可在 `taskSpaceId=all` 时使用同一接口。
- 游标是 10 分钟临时令牌；部署后旧游标按现有 `CURSOR_INVALID` 行为重新取第一页，无需迁移。

## Risks and Trade-offs

- 同一任务在多个分支出现时会显示多次；这是“所有 taskSpace”的明确产品决策，通过分支名、复合 key 和独立分组控制误合并。
- 跨 taskSpace 查询会扫描多种筛选字段组合；继续使用现有 `sync_task_index_*` 索引和最大 200 条分页上限，不新增物化聚合表。
- 全量团队查询可能因任一 taskSpace revision 变化而失效，但这是当前全局 query revision 的既有语义，优先保证正确性。
- 分支筛选按任意子串匹配可能命中多个分支；这符合模糊筛选预期，结果继续以分支名和复合 key 区分。

## Rollback

本次为纯代码和规格变更。回滚时恢复前端自动选择首个 taskSpace、后端必填 `taskSpaceId` 和旧游标绑定即可；数据库与任务快照无需回滚。
