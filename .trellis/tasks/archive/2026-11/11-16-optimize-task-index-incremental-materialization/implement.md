# Team 任务索引增量物化实施计划

## 执行顺序

- [x] 1. 建立基线与保护工作区
  - 记录当前 HEAD、运行数据库 revision/indexed_revision 和现有无关改动。
  - 保留 `.trellis/tasks/11-16-client-brand-version/`、`.codex/config.toml`、`.gitignore`、`.trellis/.template-hashes.json`，不回滚、不格式化。
  - 不执行构建；实现期间只在最终阶段执行一次完整测试和真实服务验证。

- [x] 2. 提取可测试的投影辅助逻辑
  - 在 `task-space-index.js` 内实现目录指纹、当前目录集合和 changed task dir 计算。
  - 不修改 `scan-worker.js` 的现有消息协议；增量路径复用 `snapshot-materialize`，只缩小 `rows`。
  - 增加纯逻辑或最小导出测试，覆盖新增、修改、删除、移动和缓存不完整。

- [x] 3. 建立进程内可信基线
  - 首次无基线时沿用现有 full scan，并保存 raw tasks、目录指纹、稳定 project 元数据、Board 和 detailTasks。
  - 候选结果只有事务提交成功后才能替换内存状态。
  - 记录 full/incremental 模式与扫描计数。

- [x] 4. 实现增量 Worker 输入
  - 先读取不含 `content_text` 的轻量文件元数据。
  - 计算 changedTaskDirs；只对变化目录读取正文。
  - 把变化目录的活动行传给现有 Worker。
  - 合并未变化 raw tasks、替换变化目录、删除消失目录。
  - 如果合并结果无法证明覆盖全部有效任务目录，自动执行 full scan。

- [x] 5. 保持全局关系与执行投影
  - 重构 `buildBoard()`，使它从完整 raw task 集构建 Board，不依赖本次 Worker 是否扫描了全部目录。
  - 每次都对全部任务应用人工阶段、`linkTaskGroups()`、身份冲突检查、父任务进度和 `projectBoardExecution()`。
  - 未变化任务复用正文对象，但仍参与全局关系重算。

- [x] 6. 加严 revision 提交协议
  - 将 `replaceIndexInTransaction()` 改为接收 targetRevision。
  - 在事务内重新读取 taskSpace，并校验 revision、retired_at 和 disabled 状态。
  - 事务内发现新 revision 时返回 superseded，不进入失败退避，不写任何派生数据。
  - 校验 `indexed_revision` 更新行数必须为 1。

- [x] 7. 索引 diff 与标签局部重建
  - 由完整 Board 生成目标索引行。
  - 与当前 `sync_task_index` 比较：只 UPSERT 新增或字段变化行，DELETE 消失任务。
  - `board_version` 和 `updated_at` 不参与差异比较；未变化行不因全局 revision 被批量更新。
  - 只对受影响任务重建 `sync_task_index_tag`。
  - Board cache、assignment 投影、query revision 和 `indexed_revision` 保持在原事务中。

- [x] 8. 单飞与 revision 合并
  - 为 taskSpace 增加共享 materialization single-flight。
  - `enqueue()` 和 `ensureMaterialized()` 不得同时启动两个投影。
  - drain 每轮开始前比较 revision；已经追上时跳过。
  - 扫描期间累计的新 revision 合并到下一轮，不按 revision 数重复 full scan。

- [x] 9. 人工阶段无 revision 重投影
  - 计算轻量人工阶段指纹。
  - `ensureMaterialized()` 发现指纹变化时从现有 raw tasks 重算 Board，不读任务正文。
  - 通过同一事务更新索引与 Board cache。

- [x] 10. 结构化指标
  - 增加 queueWaitMs、base/target revision、mode、changed/scanned/reused task 数、contentRowsRead、worker/relationship/database/total 耗时。
  - 记录 committed、superseded、failed，但不得记录任务正文或本地绝对路径。

- [x] 11. 自动化回归
  - `packages/server/test/team-task-index-v10.test.js`：
    - 单任务 warm 更新只扫描一个目录。
    - 新增、修改、删除、归档移动。
    - 全局父子关系和重复执行身份。
    - 人工阶段同 revision 重投影。
    - full 与 incremental 输出一致。
    - 新 index 实例模拟重启后 full 回退。
  - 并发测试：
    - materialize 期间提交新 revision，旧结果 superseded。
    - 事务 revision 复核失败时四项派生状态均不变化。
    - revision 412 后立即提交 413，最终索引只反映最新快照；不同路径均保留，同路径非法基线仍由 CAS 拒绝。
    - 同 taskSpace single-flight。
  - `packages/server/test/team-gitless-http.test.js`：真实上传、等待索引、Board 可见；快速连续 revision 最终完整收敛。
  - 如发现现有测试对新内存状态假设过强，只调整与本任务直接相关的断言。

- [x] 12. 当前规模性能验证
  - 使用至少 `300` 个任务目录、`1500` 个活动文件的夹具或脱敏快照副本。
  - 连续执行 20 次单任务 warm revision，记录 P50/P95。
  - 每次断言 `changedTaskCount=1`、`scannedTaskCount=1`、未变化正文读取为 0。
  - 对比 full 与 incremental Board 的规范化结果。

- [ ] 13. 真实服务与客户端 E2E
  - 服务端投影和客户端重开已完成测量；当前工作区缺少已构建静态资源，客户端页面无法完成视觉验收。
  - [x] 重启最新服务端，确认首次 full 后进入 warm 模式。
  - [x] 通过真实 Agent 创建任务，记录 changes revision 时间、投影完成时间和 Board API 可见时间。
  - [x] 快速连续修改两个文件，确认两个 revision 都保留且最终索引完整。
  - [x] 人工阶段修改后无需新上传即可在详情和 Board 生效。
  - [x] 服务重启后确认上一份一致 Board 不丢失，首次投影完成后恢复。

- [ ] 14. 规范回写与最终验证
  - 后端规范已回写；`yarn test` 受当前环境 Yarn state/workspace 解析问题阻塞，定向测试已通过。
  - [x] 更新 `.trellis/spec/backend/architecture-and-runtime.md`、`scanning-and-persistence.md` 和必要的同步规范，记录 full fallback、single-flight、事务内 revision 复核和指标契约。
  - 全任务完成后只执行一次最终验证：

```powershell
yarn test
```

  - [x] 服务端没有编译步骤；本任务不涉及前端，不执行 `yarn build` 或桌面构建。
  - [x] 检查 `git diff`，只保留本任务和原有无关改动。

## 验证命令

实现过程中优先运行最小相关测试，最终全量运行一次：

```powershell
node --test packages/server/test/team-task-index-v10.test.js
node --test packages/server/test/team-gitless-http.test.js
yarn test
```

性能验证额外记录：

```text
taskCount
activeFileCount
contentBytes
warmRuns
incrementalP50Ms
incrementalP95Ms
endToEndBoardP50Ms
endToEndBoardP95Ms
```

## 风险文件

- `packages/server/team/task-space-index.js`
- `packages/server/team/http.js`（仅在单飞/回调契约需要时）
- `packages/server/team/gitless-board-service.js`（仅在内存状态或详情接口需要时）
- `packages/server/test/team-task-index-v10.test.js`
- `packages/server/test/team-gitless-http.test.js`
- `.trellis/spec/backend/architecture-and-runtime.md`
- `.trellis/spec/backend/scanning-and-persistence.md`
- `.trellis/spec/backend/desktop-realtime-sync.md`（仅在同步契约需要补时）

不修改 `packages/server/loader.js` 和 `packages/server/team/scan-worker.js`，除非现有接口无法安全复用；若必须修改，先回到 planning 说明原因。

## 回滚点

- 目录指纹/变化目录识别可独立回退为 full scan。
- 增量 Worker 输入可独立关闭为 full rows。
- 索引 diff 可独立恢复为全删全插；Board cache 和事务边界不变。
- single-flight 和指标可独立回退，不影响数据语义。
- 不升级数据库 schema，不需要数据修复或反向迁移。

## 启动前检查

- [ ] PRD、Design、Implement 已由用户审阅。
- [ ] 用户明确批准最终规划摘要后才执行 `task.py start`。
- [ ] 已确认首版只做进程内 warm cache，服务重启首次允许 full scan。
- [ ] 已确认性能目标使用当前开发机夹具和现有产品 P95 3 秒基线。
- [ ] 已确认不修改 Agent 协议、CAS、冲突和数据库 schema。
