# 实施计划

## 实施顺序

- [x] 1. 数据模型：schema 升到 v9，为 `team_task_index` 增加 `archived_at` 和归档排序索引；升级前备份，回填 `project_scan_cache.board_json` 中的 `archivedAt`。
- [x] 2. 索引写入：`taskIndexInsertArgs()` 写入 `task.archivedAt`，`rowFromIndex()` 返回 `archivedAt`，`INDEX_SCHEMA_VERSION` 升到 `2`。
- [x] 3. 查询分页：`queryTasks()` 在 `archived=true` 时按归档时间锚点排序和生成游标；活动查询保持原排序；归档响应返回完整负责人选项。
- [x] 4. API 归一化：`pagePayload`、`normalizeTaskPage()` 和 `TeamQueryPage` 保留 `assignees`，任务行保留 `archivedAt`。
- [x] 5. 前端状态：新增归档专用分页 hook，负责 `archived=true`、每页 20、搜索、负责人、游标栈、修订号刷新和迟到响应隔离。
- [x] 6. 归档视图：团队模式使用服务端分页结果并移除 80 条上限；上一页/下一页使用游标；独立模式保持本地排序分页。
- [x] 7. 清理接线：移除未使用的 `archiveProject`、`archiveSearch` 筛选字段；确认活动任务查询不受影响。
- [x] 8. 文档：同步后端 schema/查询契约、前端归档状态与分页说明。

## 测试与验证

- [x] `tests/database.test.js`：新库 v9、v8 -> v9、v6/v7 -> v9、备份文件、回填、重复打开幂等、大于 v9 拒绝。
- [x] `tests/task-index-args.test.js`：`archivedAt` 写入、缺省值和归档证据搜索文本。
- [x] `tests/team-web.test.js`：`archived=true` 查询、20 条限制、负责人字段归一化。
- [x] `tests/team-core.test.js`：归档任务首屏、按 `archivedAt` 排序、两页游标不重复、筛选变化使旧游标失效、负责人选项。
- [x] 相关单元测试通过后再执行最终构建：`npm --prefix web run build`。
- [ ] 真实服务 E2E：登录团队看板，核对归档索引总数与数据库一致；翻到第二页再返回；切换项目；搜索；按负责人筛选；打开详情确认只读。
- [ ] 浏览器同时验证活动流水线、团队视角和独立模式归档未回退。

## 风险与回滚点

- 数据库迁移前必须确认 `backups/board.sqlite.pre-v9.*` 可独立打开。
- 索引 schema 升级会增加首次项目扫描成本，但可避免旧缓存缺字段。
- 若游标排序不稳定，优先停止发布并回滚前端归档入口；数据库新增列可保留，不反向删除。
- 浏览器 E2E 必须在最终构建产物上执行，不能只验证 Vite 开发页。
