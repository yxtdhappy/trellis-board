# 增量任务索引基准结果

## 方法

使用 `benchmark-task-space-index.mjs`：

1. 通过 `VACUUM INTO` 从当前运行库创建临时快照，不修改运行数据库。
2. 选择当前 `sync_task_index` 任务数最多的 taskSpace。
3. 新 index 实例首次执行 full，随后修改一个任务的 `task.json` 并推进任务空间 revision，连续执行 20 次 warm materialize。
4. 每次断言投影模式为 incremental，且只扫描一个变化任务。

## 结果

- taskSpace：`9269f774-5cd1-40e9-b3f0-4a5dc998b8b2`
- 索引任务数：`330`
- 活动正文行数：`1615`
- 首次 full：约 `17.0s`，扫描 `330` 个任务
- warm 20 次：P50 `138ms`，P95 `200ms`，最小 `119ms`，最大 `200ms`
- 每次 warm：`changedTaskCount=1`、`scannedTaskCount=1`，其余任务不读取正文

## 对照

同一类当前数据的旧全量路径在开发机上重放约 `5.69s` 到 `16.3s`；本次 bench 的 full 为 `17.0s`，与旧路径量级一致，符合“冷启动仍全量”的设计。warm 路径相对旧路径下降约两个数量级，并且不再随总任务数线性增加读取和临时落盘。

该结果是开发机测量，不是 CI SLA；最终仍需用真实客户端创建任务和退出重开客户端做端到端计时。
