# 实施报告

## 完成内容

- 数据库 schema 升级到 v9，`team_task_index` 新增 `archived_at` 与归档排序索引；v6/v7/v8 升级前备份，并从 `project_scan_cache.board_json` 回填已有归档时间。
- 团队任务索引写入和返回真实 `archivedAt`，索引 schema 升级到 v2；归档搜索文本包含项目名、已完成阶段标签和阶段证据。
- `/api/tasks/query?archived=1` 按归档时间锚点倒序生成稳定游标，活动任务查询保持最后活动时间排序。
- 归档分页响应返回负责人集合；前端归一化保留 `archivedAt` 与 `assignees`。
- 新增团队归档专用 hook，固定每页 20 条，支持游标前后翻页、服务端搜索、负责人筛选、修订号刷新、游标失效回第一页和请求竞态隔离。
- 归档视图取消 80 条上限；团队模式使用服务端分页，独立模式继续本地排序分页。
- 移除未使用的 `archiveProject`、`archiveSearch` 状态，并同步 README、运维文档及前后端规范。
- E2E 后补齐负责人筛选受控选项保持，避免加载期间选中值短暂消失导致回退。
- E2E 后补齐归档详情只读：隐藏并拦截计划字段编辑，保留活动任务原编辑能力。

## 验证

- `node --test tests/database.test.js tests/task-index-args.test.js tests/team-web.test.js tests/team-core.test.js tests/archive-sort.test.js`
  - 50 项通过，0 失败。
- `npm test`
  - 462 项通过，12 跳过，3 失败。
  - 失败项均与本任务代码路径无关：插件目录缺少既有 `witops-core/plugin.json`、Windows 临时目录 `EPERM` 清理、两个真实 Agent watcher 的 P95 同步超时。
- `npx oxfmt --check` 对本任务改动文件通过。

## 待主代理完成

- 最终 Web 构建已通过：`npm --prefix web run build`。
- 真实团队服务已验证归档首屏、翻页、项目切换、搜索、负责人筛选和只读详情，详见
  `e2e-report.md`。
- 最终检查、提交和 Trellis 收尾由主代理执行。
