# SQLite 持久化检查报告

## 结论

代码检查通过，没有遗留的阻断问题。

## 自动化检查

- `npm test`：55 项通过，0 项失败。
- `server/` 与 `public/` 下全部 14 个 JavaScript 文件逐个执行 `node --check`，全部通过。
- `python ./.trellis/scripts/task.py validate 10-30-board-sqlite-persistence`：通过，`implement.jsonl` 和 `check.jsonl` 各 2 条。
- 项目没有 lint、typecheck 或构建脚本，因此不适用。

## 检查中发现并修复

- 任务详情合并顺序错误会让缓存中的旧 `stages`、`manualStage` 和 `derivedStage` 覆盖 SQLite 最新人工阶段。已改为先合并磁盘详情与缓存列表字段，再应用 SQLite 人工阶段，并增加回归测试。
- 移除项目时只删除 `repositories` 行，会遗留按项目 ID 前缀存储的 `task_stage`。已在同一事务内清理精确的 `${projectId}/` 前缀，并验证不会误删相似项目 ID 的人工阶段。

## 已知边界

- 本次未提交、未推送、未归档。
- Git 仓库当前没有已跟踪基线，`git status` 中项目文件仍整体显示为未跟踪，无法用 Git diff 区分历史改动。
