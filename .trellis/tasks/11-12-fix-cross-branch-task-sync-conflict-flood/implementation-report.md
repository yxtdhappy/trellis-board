# 跨分支任务同步与冲突收敛实施报告

## 结论

代码实现已覆盖原始事故的三层原因：binding 分支校验通过后仍监听整棵任务目录、服务端重复冲突无上限、历史重复冲突缺少安全清理入口。用户明确要求本轮跳过测试，因此本报告只声明静态实现完成，不声明自动化或真实环境通过。

## 实施内容

- `packages/shared/task-snapshot.js` 从 `task.json` 提取稳定 `id` 和任务 `branch`，保持旧快照字段兼容。
- `apps/desktop/src-tauri/src/agent/task_sync.rs` 统一在 watcher、增量 pull、pending retry、bootstrap、deferred、命令上传和冲突覆盖前执行任务归属门禁。
- 空归属只在服务端唯一主张或项目唯一 taskSpace 可推断时自动写入 `task.py set-branch`；多分支歧义按任务指纹只审查一次。
- pending batch 重试保留原始 `batchId/clientSequence/files`；冲突和待确认状态分别持久化到 cursor，重启后不自动重复上传。
- `apps/desktop/src-tauri/src/agent/task_sync.rs` 增加任务归属查询；`apps/desktop/src-tauri/src/agent_service.rs` 提供 `list_task_ownership()` 和 `set_task_ownership()`。
- `apps/server/team/task-snapshot-service.js` 增加 `/task-ownership` 服务实现，并在 CAS 前验证完整任务目录的 `task.json.branch`；空值和不一致分别返回明确错误。
- 同一 Agent/taskSpace/task 的 pending conflict 复用稳定 ID，列表读取按身份折叠历史重复行。
- 清理脚本支持 `--cleanup-conflicts`、`--disable-remove-task-space`，apply 前要求停服、`VACUUM INTO` 备份，并校验状态/revision 未漂移。
- ProjectRail、TaskOwnershipDialog、control window 和 Tauri 进程内 Agent 命令已接通；单分支创建隐藏选择器，多分支按当前空间、本地 binding、首项选择。

## 文件边界

主要变更位于 `packages/shared/`、`apps/desktop/src-tauri/src/`、`apps/server/team/`、`apps/web/src/`、`scripts/` 和前后端规范。未修改或清理用户已有的无关未跟踪任务目录。

## 验证状态

- 已做静态源码核对：上传入口、服务端事务边界、Tauri capability、项目栏状态和清理 apply 前置条件。
- `git diff --check`、`task.py validate` 和 10 个改动 JavaScript 文件的 `node --check`：通过。
- 已计划执行但未执行：所有 Node 测试、Web 构建、Rust/Tauri 编译、真实浏览器和真实 Agent E2E。

## 未完成事项

- 真实生产清理尚未执行；不得直接操作 `data/board.sqlite` 或远端 `4317` 数据库。
- 旧 pending batch 若已持久化空 `task.json.branch`，客户端会继续失败关闭，不能在不改变幂等摘要的前提下原地迁移；需要人工确认后走独立迁移。
