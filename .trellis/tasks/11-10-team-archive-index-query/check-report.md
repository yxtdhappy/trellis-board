# 检查报告

## 代码级验证

- 针对性测试：
  `node --test tests/database.test.js tests/task-index-args.test.js tests/team-web.test.js tests/team-core.test.js tests/archive-sort.test.js`
  结果：50 项通过，0 失败。
- 完整测试：`npm test`
  结果：464 项通过、12 项跳过、2 项失败。
  失败均为非本任务代码：`witops-core` 缺少既有 `plugin.json`，以及两个真实 Agent watcher 的 Windows `EPERM` 重命名失败。
- 最终构建：`npm --prefix web run build`
  结果：通过；TypeScript project build 和 Vite production build 均成功。
- `git diff --check`：通过。
- 格式检查：本任务改动文件通过 `oxfmt --check`。

## 覆盖结论

- v6/v7/v8 -> v9 迁移、升级前备份、归档时间回填和归档排序索引均有测试。
- 归档查询按 `archivedAt` 倒序，而不是最后活动时间；两页游标不重复。
- 归档分页返回负责人集合，筛选变化会使旧游标失效。
- 搜索文本包含项目名、已完成阶段标签和证据。
- 独立模式归档继续使用本地排序和分页。

## 待真实服务验收

- 当前 `4317` 服务 PID `43584` 启动于 `2026-11-10T09:05:35Z`，早于本次实现和构建，不能作为新代码 E2E 证据。
- 需要重启同端口团队服务，使后端加载 schema v9 与归档游标查询。
- 重启后验证：归档总数、下一页/上一页、项目切换、搜索、负责人筛选、只读详情，以及活动流水线和独立模式回归。
