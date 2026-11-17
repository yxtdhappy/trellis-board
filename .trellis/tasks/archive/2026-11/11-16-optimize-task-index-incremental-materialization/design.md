# Team 任务索引增量物化设计

## 1. 结论

本任务保留现有快照、revision、CAS 和冲突链路，只替换 Team 从“已提交快照”到 `sync_task_index` 的派生投影方式：

```text
当前 revision
  + 上次成功投影的完整任务事实
  + 当前文件元数据指纹
  -> 找出变化任务目录
  -> Worker 只物化并扫描变化目录
  -> 合并未变化任务的完整事实
  -> 对全部任务重算关系、阶段继承和执行投影
  -> 事务内复核 revision
  -> 增量更新索引、标签、Board 缓存和 indexed_revision
```

首版可信基线只保存在进程内。服务重启或基线不可用时，退回现有全量扫描；这是为了保证完整性而保留的冷启动成本，不作为正常单任务更新的成本。

## 2. 当前瓶颈与根因

### 2.1 调用链

1. [`task-snapshot-service.js`](../../../packages/server/team/task-snapshot-service.js:973) 在 changed revision 提交后触发索引回调。
2. [`http.js`](../../../packages/server/team/http.js:1632) 把回调接到 `enqueue()`。
3. [`task-space-index.js`](../../../packages/server/team/task-space-index.js:564) 每次读取全部活动文件正文。
4. [`scan-worker.js`](../../../packages/server/team/scan-worker.js:180) 把全部文件写入新的临时目录，再调用 `scanRepository()`。
5. [`loader.js`](../../../packages/server/loader.js:636) 重新遍历并解析全部任务目录。
6. [`task-space-index.js`](../../../packages/server/team/task-space-index.js:490) 固定删除全部索引和标签，再重新插入全部任务。
7. [`task-space-index.js`](../../../packages/server/team/task-space-index.js:602) 在数据库提交前检查一次 revision，但事务内没有再次检查；该窗口存在旧结果覆盖派生缓存的竞态风险。

### 2.2 为什么不能用“减少临时目录字符串操作”解决

即使优化复制和写盘，只要仍然读取、解析和重新投影全部任务，复杂度就继续随任务总数线性增长。单任务变化的正确最小工作集应是：

```text
全部任务的轻量关系事实
  + 一个变化任务的正文扫描
  + 全任务图关系重算
```

其中只有第一项和最后一项必须接触全部任务，不能重新解析未变化任务的 Markdown、报告和 JSONL。

### 2.3 哪些工作不能简单增量化

下面这些投影必须在每个成功 revision 上基于全部当前任务重算，或者至少使用全部任务摘要：

- 父子关系解析、缺失引用、歧义、循环和分组。
- 父任务从子任务继承阶段进度。
- 同一 taskSpace 内重复 `executionTaskKey` 的身份冲突。
- `task_dependency`、WIP、风险、标签和已保存视图叠加。
- 人工阶段和任务执行扩展数据。

增量只减少文件读取和任务解析，不减少必要的全局关系投影。

## 3. 投影状态

`createTaskSpaceIndex()` 内维护每个 taskSpace 的可丢弃状态：

```text
ProjectionState {
  revision
  rawTasksByDir: Map<taskDir, fullTask>
  dirFingerprints: Map<taskDir, sha256>
  project
  board
  detailTasks
  manualStageFingerprint
}
```

- `rawTasksByDir` 是按完整任务目录保存的 loader 结果，包含阶段、摘要、关系和详情正文；它是服务端快照内存投影，不是业务事实源。
- `dirFingerprints` 覆盖文件表中的全部行，包括删除墓碑；指纹至少由 `task_dir + relative_path + sha256 + deleted` 排序后哈希得到。
- `project` 保存 taskSpace 的稳定项目元数据，避免局部 Worker 的 `taskCount` 影响 Board。
- `manualStageFingerprint` 用于发现不改变 revision 的人工阶段变化。
- 状态只在数据库事务成功提交后替换；失败或 superseded 的候选结果永不写入 `materialized`。

状态不跨进程持久化。启动后第一次需要物化时执行现有全量扫描并建立状态。

## 4. 变化目录识别

### 4.1 查询

每次投影先读取全部文件行的轻量元数据，不读取 `content_text`：

```sql
SELECT relative_path, sha256, deleted, task_dir, revision
FROM sync_task_space_file
WHERE task_space_id = ?
ORDER BY task_dir, relative_path
```

只有被判定为变化的目录再读取完整正文：

```sql
SELECT relative_path, content_text, sha256, deleted
FROM sync_task_space_file
WHERE task_space_id = ?
  AND task_dir IN (...)
ORDER BY relative_path
```

### 4.2 判定规则

对于每个 `task_dir`，满足任一条件即进入 `changedTaskDirs`：

- 任意文件行 `revision > state.revision`。
- 当前目录指纹与 `state.dirFingerprints` 不同。
- 当前出现未知目录。
- 基线中存在但当前文件表已完全消失的目录。
- 当前目录缺少可信缓存事实，无法证明未变化。

指纹比较是最终保护条件；`revision` 只是快速筛选。这样即使历史数据或异常写入没有正确推进 revision，也不会静默复用错误基线。

### 4.3 任务集合

- 新增任务：目录未知或指纹变化，重新扫描。
- 修改任务：目录指纹变化，重新扫描。
- 删除任务：目录没有活动文件，移除缓存任务。
- 活动目录移到归档目录：旧目录删除缓存，新目录重新扫描；归档时间仍来自快照中的 `task.json` 元数据。
- `task.json` 缺失或无法解析：该目录不进入索引；不能沿用旧缓存任务。

## 5. Worker 与全量回退

复用现有 `snapshot-materialize` Worker 协议，不新增外部协议。区别只在 `rows`：

- full：传入全部活动文件行。
- incremental：只传入变化目录的活动文件行。

Worker 仍在一个新的临时根中只写入收到的行，再调用现有 `scanRepository()`。因此：

- 不需要复制未变化任务目录。
- 不需要为增量逻辑重写 loader。
- 临时目录、符号链接、路径边界和单任务扫描语义继续复用现有实现。

以下情况直接走 full：

- 没有 `ProjectionState`。
- `state.revision !== sync_task_space.indexed_revision`。
- `dirFingerprints` 或 `rawTasksByDir` 不完整。
- 扫描结果无法覆盖当前活动任务目录。
- Worker 返回错误、超时或结果字段无效。

全量回退失败时继续沿用现有失败状态、退避重试和最后成功 Board。

## 6. Board 构建

把当前 `buildBoard(scan, taskSpace)` 拆成两个语义：

1. 从当前全部 `rawTasksByDir` 合并出完整任务数组。
2. 使用当前人工阶段和数据库执行数据构建 Board。

关键点：

- 合并后的任务数组必须覆盖当前所有有效任务目录。
- `withManualStages()` 对全部任务重新应用，不能只应用到变化任务。
- `linkTaskGroups()` 必须对全部任务执行一次，不能增量拼接旧分组结果。
- `projectBoardExecution()` 必须对完整 Board 执行一次。
- `detailTasks` 保留完整任务对象，未变化任务直接复用旧对象；变化任务用本次 Worker 结果替换。

这样单任务变化不会重新读取未变化正文，但父任务阶段继承、循环、歧义和身份冲突仍按全量任务计算。

## 7. 提交事务

候选 Board 构建完成后，在单个 `BEGIN IMMEDIATE` 事务中执行：

1. 重新读取 taskSpace。
2. 校验 `revision === targetRevision`、未 retired、状态不是 disabled。
3. 如 revision 已变化，抛出专用 superseded 结果并整体回滚。
4. 计算 `sync_task_index` 目标行并与当前行 diff。
5. 只插入新增行、更新字段变化行、删除已消失行。
6. 只对新增、变化或删除的任务重建 `sync_task_index_tag`。
7. 更新完整 Board cache。
8. 同步任务分配投影。
9. 更新 `indexed_revision`、状态和 `last_error`，并校验更新行数为 1。
10. 递增 query revision。

事务成功后依次：

1. 发布 Board query revision。
2. 发布 `tasks.changed` 和 `task.changed`。
3. 替换 `materialized` 内存状态。

如果任一步在事务中失败，旧索引、旧缓存、旧 `indexed_revision` 和旧内存状态全部保留。

## 8. 并发与队列

`enqueue()` 继续保证同一 taskSpace 最多一个在途投影，但增加以下约束：

- 所有 `ensureMaterialized()` 与队列共用同一 taskSpace single-flight，避免详情请求绕过队列并发扫描。
- 新 revision 只设置“需要再跑一次”，不启动第二个 worker 请求。
- 每轮 drain 开始前读取最新 revision；若 `indexed_revision` 已追上，直接结束。
- 扫描返回后 revision 改变则视为 superseded，不进入失败退避。
- 下一轮从最后一个成功 `indexed_revision` 重新计算变化目录，因此一次覆盖期间积累的全部 revision。

不会按 revision `412 -> 413 -> 414` 连续执行三次全量扫描。

## 9. 人工阶段与无 revision 变化

`ensureMaterialized()` 在 revision 相同时还要比较当前任务空间的人工阶段指纹：

- 指纹未变化：直接复用内存状态。
- 指纹变化：只重新执行全任务 `withManualStages + linkTaskGroups + projectBoardExecution`，不重新读取任务文件。
- 重投影仍通过同一事务更新索引和 Board cache。

计划字段和执行扩展数据继续由 `projectBoardExecution()` 在读取时叠加，不写回快照。

## 10. 索引 diff

目标行由完整 Board 计算，但数据库写入改为 diff：

- 主键 `(task_space_id, task_key)` 相同且全部索引字段一致：不更新。
- 新增或字段变化：UPSERT。
- 当前数据库存在但目标 Board 不存在：DELETE。
- 标签：只删除并重建受影响任务的标签行。

`board_version` 和 `updated_at` 是投影元数据，不参与“任务字段是否变化”的比较；未变化行保留原值，新增或真实变化行写入当前值。否则全局版本号会导致每次都更新全部索引行，使 diff 失去意义。

这避免每次单任务变化都对几百或几千条索引执行全删全插，同时保持索引仍可由完整 Board 重建。

## 11. 一致性与失败矩阵

| 条件 | 行为 |
| --- | --- |
| 无内存基线 | full 重建 |
| taskSpace revision 未变化 | 不扫描文件；必要时只重投影人工阶段 |
| 一个任务目录变化 | 只读取并扫描该目录 |
| 新 revision 在 Worker 期间提交 | 丢弃候选；下一轮合并最新 revision |
| 新 revision 在事务前提交 | 事务内复核失败；不改任何派生数据 |
| 新 revision 在事务等待期间提交 | 写锁顺序保证二者串行，后提交 revision 再触发下一轮 |
| 指纹不完整或损坏 | full 回退 |
| Worker 结果缺少活动任务 | 拒绝候选并 full 回退或失败重试 |
| 索引写入失败 | 事务回滚，保留上一份 Board |
| 旧 revision 结果晚到 | superseded，不能覆盖新缓存 |
| 已提交任务文件 | 投影失败也保留；下一轮仍可重建 |
| taskSpace retired/disabled | 不提交 active 索引，保持现有 retired 语义 |

### 412 与 413 的边界

412 的物化结果被丢弃，只表示 412 生成的 Board/索引候选不写回派生表；不表示 412 的已提交文件行被删除。

- 412 和 413 涉及不同路径时，两次文件行都保留在当前快照中。
- 413 是同一路径的合法后续写入且其 CAS 基线包含 412 时，413 成为当前内容；这是快照语义，不是索引丢弃导致的覆盖。
- 413 仍基于 412 之前的基线时，现有 CAS 必须拒绝它，不能由本任务改成后写覆盖。
- `sync_file_audit` 记录变更摘要；完整旧正文只按现有冲突备份规则保存，不在索引优化中新增历史正文存储。

## 12. 可观测性

每次投影记录结构化字段：

```text
taskSpaceId
mode: full | incremental | manual-reproject
baseRevision
targetRevision
queueWaitMs
changedTaskCount
scannedTaskCount
reusedTaskCount
contentRowsRead
workerMs
relationshipMs
databaseMs
totalMs
result: committed | superseded | failed
```

日志只记录 ID、计数、耗时和错误摘要，不记录任务正文或本地绝对路径。

## 13. 测试策略

### 13.1 纯逻辑

- 目录指纹稳定排序、路径变化、正文摘要变化、删除墓碑和目录删除。
- changed task dir 计算：新增、修改、删除、移动、未知目录、基线缺失。
- 任一缓存不完整时返回 full。

### 13.2 集成

- 初次 full 后，单任务变化只扫描一个目录并保持全部任务。
- 父子关系变化后全局重投影正确。
- 重复任务 ID 在增量模式下仍全局冲突。
- 活动到归档移动、删除、重新创建。
- 人工阶段在同 revision 下生效。
- 新建第二个 index 实例模拟重启，执行 full 且结果与增量一致。

### 13.3 并发

- `materializeNow()` 进行中提交新 revision，旧结果 superseded。
- 事务内 revision 复核失败时索引、缓存和 `indexed_revision` 均不变。
- 同一 taskSpace 的 `ensureMaterialized()` 与 `enqueue()` 共用 single-flight。
- 连续多个 revision 只执行一个有价值的后续投影。

### 13.4 HTTP 与真实服务

- 上传新任务后等待 `indexed_revision` 追上，Board 可以查询到任务。
- 两个快速批次都保留，最终 Board 同时包含两次提交结果。
- 旧 revision 不覆盖新 revision。
- 服务重启后首次投影正确，不出现空 Board 或旧 Board 回写。

### 13.5 性能

- 当前规模夹具：至少 `300` 个任务目录、`1500` 个活动文件。
- 单任务 warm 更新连续 20 次，记录 P50/P95。
- 断言每次只扫描一个任务目录，正文读取行数限定在该目录文件范围内。
- 真实客户端创建任务做端到端计时，记录 revision 提交时间和 Board 可见时间。

## 14. 兼容、回滚与风险

### 兼容

- 不升级数据库 schema。
- 不修改 API、SSE payload、Agent 协议和任务文件格式。
- 旧数据库和旧客户端可直接运行。

### 回滚

- 回退代码即可恢复现有全量投影。
- 已提交快照、索引和 Board cache 结构未变化。
- 内存状态随进程结束消失，不需要清理迁移数据。

### 主要风险

- 目录指纹漏算文件会导致错误复用：通过包含全部文件行、transactional baseline、full 回退和全量一致性测试规避。
- 只局部 link 父子关系会导致跨任务进度错误：每次 Board 构建仍执行全局 `linkTaskGroups()`。
- 事务外 revision 检查存在竞态：必须在事务内再次读取并校验。
- 进程内存增加：内存中本就保留完整 `detailTasks`；本设计只额外保存目录指纹和稳定项目元数据。
- 冷启动仍有一次全量扫描：首版明确接受；若后续仍需优化，再设计持久化投影缓存。
