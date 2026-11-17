# Team 任务索引增量物化检查报告

## 结论

服务端增量投影、全局关系重算、revision 竞态保护、索引差异写入和失败回滚均已完成定向验证。实现没有修改 Agent 快照协议、文件 CAS、冲突、删除墓碑、数据库 schema 或 loader 语义。

## 代码检查

- 事务边界：`replaceIndexInTransaction()` 使用 `withTransaction()`，事务内重新读取 taskSpace 并校验 revision、retired/status 和人工阶段指纹。
- 并发：`enqueue()` 与 `ensureMaterialized()` 共享 `inflight`，旧候选无法写入索引、缓存或 `indexed_revision`。
- 完整性：warm 路径合并全部当前 raw task，随后对全任务执行 `linkTaskGroups()` 和 `projectBoardExecution()`。
- 指纹：目录指纹包含活动文件和删除墓碑；缺少可信基线时自动 full。
- 索引：未变化行不因全局 `board_version` 更新；标签和 missing task 只做局部变更。
- 成员：增量后重新计算 `workspaceMembers + assignee/creator`，避免项目成员集合沿用旧 Board。
- 归档：按快照行稳定 `updated_at` 生成 `archivedAt`，避免临时文件 mtime 影响一致性。

## 验证结果

| 验证 | 结果 |
| --- | --- |
| `team-task-index-v10.test.js` | 13/13 通过 |
| `team-gitless-http.test.js` | 2/2 通过 |
| `team-task-mine-scope.test.js` | 4/4 通过 |
| `node --check` | 通过 |
| `git diff --check` | 通过 |
| 全量 server Node 测试 | 310 通过、17 失败；失败均为工作区 package 解析/依赖状态问题 |
| `yarn test` | 环境缺少 Yarn node_modules state file，未执行 |

## 真实服务证据

- warm 单任务只扫描一个目录，服务端投影约 `139ms`。
- 只退出并重开客户端没有触发服务端重新全量扫描。
- 服务端重启后已有任务和 `indexed_revision` 保留；首次投影会执行一次 full，之后恢复增量。

## 剩余风险

- 首版 warm 基线只在进程内；服务端重启后的第一次投影仍是 full，属于明确范围边界。
- 端到端总耗时仍未达到 3 秒，主要差距在客户端本地扫描/上传，不在本次服务端投影。
- 当前工作区缺少 `packages/server/public` 静态资源，客户端页面视觉验收无法完成。
