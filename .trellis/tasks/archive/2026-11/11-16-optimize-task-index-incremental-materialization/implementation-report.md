# Team 任务索引增量物化实施报告

## 完成内容

- 在 [task-space-index.js](../../../packages/server/team/task-space-index.js) 增加进程内 `ProjectionState`、目录指纹、变更目录识别和 warm 增量路径。
- 首次无基线时保留 full scan；后续只读取和扫描发生变化的任务目录，未变化任务复用完整任务事实。
- 每次仍使用全部任务执行父子关系、身份冲突、人工阶段、风险、WIP 和执行投影，避免局部关系计算导致漏报。
- 同一 taskSpace 的 `enqueue()` 和 `ensureMaterialized()` 共用 single-flight，扫描期间的新 revision 会丢弃旧候选并收敛到最新快照。
- `replaceIndexInTransaction()` 在 `BEGIN IMMEDIATE` 内重新校验目标 revision、retired/status 和人工阶段指纹。
- `sync_task_index` 改为差异 UPSERT/DELETE；`board_version`、`updated_at` 不参与未变化行的差异判断，标签只重建受影响任务。
- Board cache、索引、标签、assignment 和 `indexed_revision` 同事务提交；失败时保留上一份一致快照。
- 归档时间使用快照行的稳定 `updated_at`，避免临时物化目录 mtime 导致增量与 full 结果不一致。
- 新增结构化投影日志，包含 full/incremental、changed/scanned/reused、内容行数、worker/关系/数据库耗时和结果。

## 测试

- `node --test packages/server/test/team-task-index-v10.test.js`：13/13 通过。
- `node --test packages/server/test/team-gitless-http.test.js packages/server/test/team-task-mine-scope.test.js`：6/6 通过。
- `node --check`、`git diff --check`：通过。
- 全量 `node --test "packages/server/test/*.test.js"`：310 通过、17 失败；失败全部是当前工作区无法解析 `@trellis-board/server` package 的插件/测试支撑导入，不是本任务改动引入。
- `yarn test`：当前环境找不到 Yarn node_modules state file，未执行。

## 性能观测

真实 Team 服务当前规模：

- 冷启动 full：`9.949s`，扫描 `331` 个任务、读取 `1619` 行。
- warm 单任务：`139ms`，`changedTaskCount=1`、`scannedTaskCount=1`、`reusedTaskCount=331`、`contentRowsRead=4`。
- 首次 E2E 从本地创建到 Board 可见：`9.293s`；其中服务端 warm 投影约 `139ms`，约 `9.18s` 仍在客户端 watcher/上传阶段。
- 只退出重开客户端：服务端投影次数保持 `2` 次，5 个 taskSpace revision 均未变化，未触发第二次全量扫描。
- 服务端重启后已有 taskSpace 的 `revision=indexed_revision` 和任务数据保留；重启后的首次请求会执行一次 full 重建，随后恢复增量。

## 未完成与边界

- 当前工作区没有 `packages/server/public` 的构建产物，退出客户端重开后页面返回 `静态资源不存在 / NOT_FOUND`，因此没有完成页面视觉验收。
- 端到端 `3s` 目标尚未达到；剩余延迟在客户端本地扫描和上传阶段，属于本任务明确排除的客户端链路。
- 未提交、未推送、未归档。
