# 检查报告

## 代码级验证

- 首次实现后的归档核心/迁移组合测试：
  `node --test tests/database.test.js tests/task-index-args.test.js tests/team-web.test.js tests/team-core.test.js tests/archive-sort.test.js`
  结果：50 项通过，0 失败。
- E2E 缺陷修复后的最终组合测试：
  `node --test tests/team-web.test.js tests/archive-sort.test.js tests/task-index-args.test.js`
  结果：22 项通过，0 失败；最终 `tests/team-web.test.js` 单跑 18 项通过。
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

## 真实服务验收

- 团队服务 PID `58948` 启动于 `2026-11-10 20:15:34 +08:00`，健康检查为 team 模式，schema `9`。
- 最终 Web 构建产物 `assets/main-DTWNV0Zp.js` 已在同一页面加载。
- 归档首屏 633 条、32 页；下一/上一页、项目切换 39 条、负责人 `yhj` 203 条、项目 + 负责人
  38 条、精确搜索 1 条均通过。
- 负责人筛选在加载期间保持选中值，不再回退为全部负责人。
- 归档详情无计划编辑入口，负责人和依赖写操作禁用；活动任务详情仍保留计划编辑。
- 服务端成功 GET 不写逐请求日志；日志增量只有既有项目扫描超时告警，没有本次查询 500 或异常。
- 详见 `.trellis/tasks/11-10-team-archive-index-query/e2e-report.md`。

## 剩余限制

- 当前运行实例为团队模式，独立模式归档未在独立服务上做浏览器回归；现有本地分页逻辑、
  归档排序测试和最终构建通过。
