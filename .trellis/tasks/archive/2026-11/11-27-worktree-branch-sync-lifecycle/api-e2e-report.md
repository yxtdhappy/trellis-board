# API E2E Report: Worktree 分支标识与服务端差异化归档同步

## 1. 测试拓扑与环境

- **被测后端**：本机最新源码启动真实 `createTeamRuntime` HTTP 服务（`127.0.0.1:<ephemeral-port>`，独立临时 SQLite v19 数据库与数据目录）。
- **执行入口**：`node --test packages/server/test/worktree-branch-sync-lifecycle.test.js`（用例：`API E2E: 真实 HTTP 后端完整闭环`）。
- **执行时间**：2026-11-27 17:55 +08:00（耗时 351ms）。
- **日志结论**：全链路 `error` 级别后端日志数量 = `0`，无 `ARCHIVE_BRANCH_MISSING` 或未捕获异常。

## 2. 接口证据矩阵

| 序号 | 接口与场景 | 验证层级 | HTTP 状态 / 响应摘要 | 持久化与副作用复核 | 结果 |
| --- | --- | --- | --- | --- | --- |
| 1 | `POST /api/agent/task-spaces/attach`（`main`, `isWorktree: false`） | 契约级 + 持久化级 | `201`，`taskSpace.isWorktree = false` | `sync_task_space.is_worktree = 0` | PASS |
| 2 | `POST /api/agent/task-spaces/attach`（`feat/wt-e2e`, `isWorktree: true`） | 契约级 + 持久化级 | `201`，`taskSpace.isWorktree = true` | `sync_task_space.is_worktree = 1` | PASS |
| 3 | `GET /api/admin/archive-sync` | 契约级 | `200`，worktree 行 `isWorktree: true`, `status: 'worktree_skipped'`, `lastError: null` | 无远端 Git 拉取记录 | PASS |
| 4 | `POST /api/admin/archive-sync/run`（指定 worktree 空间） | 契约级 + 反向边界 | `409`，`code = 'WORKTREE_ARCHIVE_SYNC_SKIPPED'` | 不排队拉取、不写失败日志 | PASS |
| 5 | `POST /api/agent/task-spaces/:id/changes`（上传 → claim → 删除）+ `GET /api/agent/task-spaces/:id/tasks` | 契约级 + 持久化级 + 副作用级 | 上传与删除均 `200`；删除并索引后 `/tasks` 由 `1` 条收敛为 `0` 条 | `sync_task.archived = 1`，活跃租约释放 | PASS |
| 6 | `POST /api/agent/task-spaces/:id/detach`（worktree 最后绑定） | 契约级 + 持久化级 + 副作用级 | `200`，`taskSpaceRetired: true` | 查库 `status = 'disabled'`, `retired_reason = 'worktree_deleted'`，触发看板刷新 | PASS |
| 7 | `POST /api/agent/task-spaces/attach`（已弃用 worktree 同名重建） | 契约级 + 持久化级 | `201`，`taskSpace.status = 'active'`, `retiredAt = null` | 自动恢复原空间并写入 `task_space_restored` 审计事件 | PASS |

## 3. 清理与结论

- 测试使用独立临时目录，测试结束后自动 `runtime.stop()` 并删除临时目录，零残留。
- **结论**：全部 7 项 HTTP API E2E 闭环验证通过。
