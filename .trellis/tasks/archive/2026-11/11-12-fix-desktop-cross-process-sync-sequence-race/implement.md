# 实施计划

## 1. 前置检查

- [ ] 重新执行 `git status --short`，记录并保留所有既有未提交改动。
- [ ] 确认 `agent/task-snapshot-sync.js`、`agent/config-store.js`、`server/team/task-snapshot-service.js` 及对应测试没有与并行工作重叠；如重叠，先停止并协调。
- [ ] 读取 `implement.jsonl` 指定的实时同步、Sidecar 和质量规范。
- [ ] 记录修改前基线：相关测试当前结果、游标 schema 样例和 `git diff` 范围。

## 2. 客户端游标锁

- [ ] 在 `agent/config-store.js` 的 Agent 路径中增加独立的 live cursor 锁文件。
- [ ] 将现有 config lock 的排他创建、超时和 stale reclaim 逻辑抽为内部复用函数。
- [ ] 添加 `withLiveCursorLock(operation, options)`，对外只暴露必要接口。
- [ ] 保持 `withConfigLock` 的现有行为和错误语义不变。
- [ ] 添加锁互斥与释放测试；不改变 `live-cursors.json` schema。

## 3. 同步状态原子变更

- [ ] 删除 `AgentTaskSnapshotSync.cursorState` 永久缓存。
- [ ] 让 `_readCursorState()` 每次都从磁盘读取，并继续容忍文件缺失或非法 JSON。
- [ ] 增加统一的 `_mutateCursorState()`，同时使用实例串行队列和跨进程 live cursor 锁。
- [ ] 将 `_writeCursor()` 改为通过统一状态变更入口执行，保持 revision/sequence 取最大值及 baselines/deferred 合并行为。
- [ ] 添加双实例测试：A 写序号 1 后，B 下一次读取必须为 1，不能覆盖 A 的更新。

## 4. 原子批次预占

- [ ] 重构 `_uploadPersistedBatch()`：在锁内读取最新 pending/sequence，存在 pending 时先返回重放，不创建新批次。
- [ ] 无 pending 时在同一次锁事务内分配序号、生成 batchId 并持久化 pending。
- [ ] pending 重放成功后重新读取游标，再为当前文件预占下一批，设置有限重试次数，避免锁争用导致无限循环。
- [ ] 更新 `_uploadDirectories()`、`_uploadReviewedLocalTask()` 等调用点，移除对旧 `cursor.sequence` 的依赖。
- [ ] 添加双实例并发测试：同一 pending 可以由两个实例按原 batchId 重放，但不同新建批次的序号必须严格递增。

## 5. 自动恢复错误序号

- [ ] 在 `server/team/task-snapshot-service.js` 的非递增错误中增加 `details.previousSequence` 和 `details.requiredClientSequence`。
- [ ] 保持状态码 409 和错误 code `CONFLICT` 不变，不写入批次、revision 或文件表。
- [ ] 在客户端增加 `requiredClientSequence` 校验与一次性修正逻辑。
- [ ] `_uploadBatch()` 遇到可恢复序号错误时，在游标锁内更新 pending 序号，复用原 batchId/files，并只重试一次。
- [ ] `decideConflict()` 的 `overwrite-server` 请求应用同一恢复策略；无法安全恢复时保留当前错误行为。
- [ ] 添加历史 pending 序号冲突、非法 details、连续冲突和正常 CAS 冲突测试，证明自动恢复不会吞掉真实文件冲突。

## 6. 验证

- [ ] 运行 `node --test agent/test/task-snapshot-sync.test.js`。
- [ ] 运行 `node --test tests/team-task-snapshot.test.js`。
- [ ] 运行新增或受影响的配置锁测试。
- [ ] 完成全部开发后运行仓库约定的完整测试，并按项目要求执行一次最终编译验证。
- [ ] 检查 `git diff --check` 和任务范围，确认没有格式化无关代码。
- [ ] 使用真实桌面重启、首次同步处理或冲突处理验证：
  - [ ] 重启后不再持续弹 `clientSequence 必须严格递增`。
  - [ ] 后续任务修改能够同步并推进 revision。
  - [ ] 网络重试仍使用原 batchId，不产生重复 revision。

## 7. 风险与回滚点

- 高风险文件：`agent/task-snapshot-sync.js`、`agent/config-store.js`、`server/team/task-snapshot-service.js`。
- 不在网络请求期间持有跨进程锁；如实现需要扩大到长时间持锁，必须重新评审。
- 自动修正只允许服务端明确返回且数值更大时执行，禁止客户端猜测序号。
- 若锁争用或恢复测试不稳定，回滚到只增加磁盘重读和显式错误，不保留部分自动修复逻辑。
- 提交前必须确认工作区中原有 Sidecar 生命周期改动仍完整且未被覆盖。
