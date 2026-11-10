# 归档查询与服务端分页设计

## 目标与边界

归档索引使用独立查询状态，不复用活动任务 `teamPage`。后端继续使用现有 `GET /api/tasks/query`，仅在 `archived=true` 时切换为归档时间排序和游标；活动任务查询语义保持不变。

## 数据与索引

`team_task_index` 新增 `archived_at TEXT`：

- 未归档任务写 `NULL`。
- 归档任务写入扫描结果中的真实 `archivedAt`，来源是归档任务目录内 `task.json` 的 mtime。
- 新建数据库直接包含该列；现有数据库通过 schema v9 执行 `ALTER TABLE`。
- 新增归档排序索引，键顺序以 `archived`、`archived_at DESC`、`project_id DESC`、`task_key DESC` 为主。
- `INDEX_SCHEMA_VERSION` 从 `1` 升到 `2`，使旧扫描缓存失效并在后续项目刷新中重建索引。

迁移时使用 `project_scan_cache.board_json` 回填已有 `archived_at`。只有 JSON 有效且任务键匹配时回填；无法回填的记录保留 `NULL`，后续项目扫描修正。查询排序在过渡期使用 `COALESCE(archived_at, updated_at)`，响应仍返回 `archivedAt=null`，由前端明确显示未知时间。

## 查询契约

归档请求示例：

```text
GET /api/tasks/query?archived=1&teamId=t1&projectIds=p1&q=关键字&assignee=alice&limit=20&cursor=...
```

`filters.archived === true` 时：

- SQL 仍固定 `archived = 1`。
- 排序锚点改为 `COALESCE(t.archived_at, t.updated_at)`。
- 游标继续使用 `sa + projectId + taskKey`，但 `sa` 表示归档排序锚点。
- `rowFromIndex()` 返回 `archivedAt`。
- 响应的分页对象增加 `assignees`，包含除负责人条件外的当前搜索、团队和项目范围内出现过的负责人。

活动查询继续按 `last_activity_at` 排序。ETag、缓存键和游标绑定继续包含实际团队范围、项目集合、筛选哈希、查询修订号和日期。

## 前端状态

新增归档专用 hook，只有团队模式归档视图挂载时运行：

- 固定传入 `archived: true` 和 `limit: 20`。
- 维护游标栈、当前页索引、任务页、总数、负责人选项、加载态和错误。
- 下一页写入服务端 `nextCursor`；上一页读取游标栈中的上一项。
- 团队、项目、搜索词或负责人变化时立即清空游标栈并加载第一页。
- 搜索输入做短延迟合并，避免每次按键都请求。
- `queryRevision` 变化、收到刷新命令或遇到 `CURSOR_INVALID` 时清空游标栈并加载第一页。
- 请求使用递增序号，旧响应不得覆盖新筛选结果。

`ArchiveView` 不再对团队归档执行本地 `slice(0, 80)` 或本地排序。独立模式继续使用现有 `board.tasks`、真实归档时间排序和本地分页。

归档分页使用上一页/下一页按钮，显示“第 N / 总页数页”和总数，不提供任意页码跳转，因为现有 API 是单向游标。

## 兼容与回滚

- v6、v7、v8 均可升级到 v9；升级前写 `board.sqlite.pre-v9.*` 备份。
- 大于 v9 的数据库继续拒绝启动。
- 新增列和索引使用幂等检查，重复启动安全。
- 回滚代码前先停止服务，并保留当前数据库与升级前备份；旧代码不读取 v9 新列。
- 当前数据量为 629 条归档任务，单页 20 条共约 32 页。

## 关键取舍

- 服务端游标分页比浏览器全量分页多一次数据库迁移，但避免归档增长后首屏和内存持续膨胀。
- 只提供上一页/下一页而不是页码跳转，避免为实现任意跳页制造伪游标或连续请求多个页面。
- 负责人选项增加一次聚合查询；相比只显示当前页负责人，能保持筛选完整。
