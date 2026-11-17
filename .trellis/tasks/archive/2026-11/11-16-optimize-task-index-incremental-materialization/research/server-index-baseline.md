# Team 服务端任务索引基线证据

## 观测环境

- 日期：2026-11-16（Asia/Shanghai）
- 源码：`D:\wit\trellis-board`，`main`，HEAD `4981e04`
- 运行数据库：`%LOCALAPPDATA%\TrellisBoard\server\board.sqlite`
- 数据库 schema：`12`
- 读取方式：`DatabaseSync` 打开后设置 `PRAGMA query_only=ON`，只读查询，不调用应用迁移入口。

## 当前数据库规模

只读查询显示：

| taskSpace | 任务目录数 | `sync_task_index` 行数 | 活动文件数 | 文件总行数 |
| --- | ---: | ---: | ---: | ---: |
| `9269f774-5cd1-40e9-b3f0-4a5dc998b8b2` | 330 | 330 | 1615 | 1621 |
| `7b8d00fa-f478-4c47-a0ef-615462d5bdb5` | 147 | 145 | 1615 | 1652 |
| `a8d34d0e-54af-4041-bb2c-4507665c7abe` | 140 | 112 | 744 | 932 |
| `5efbba95-fdb1-4d09-bac1-dce7f11355c0` | 105 | 101 | 627 | 651 |
| `06d8b69c-2be9-4fe4-9688-498980ad6bd1` | 41 | 41 | 273 | 273 |

另测得最大正文 taskSpace 的活动正文约 `10,582,013` 字符；当前最大 Board cache 为一个 taskSpace 约 `1,359,398` 字节。数据库中的任务目录都包含 `task.json`，不是扫描器凭空创建的卡片。

### 任务数口径

`sync_task_index` 统计的是当前 taskSpace 快照中、包含有效 `task.json` 的任务目录，活动目录和 `.trellis/tasks/archive/**` 下的归档目录都会计入；它不是本机所有分支、所有历史归档的总和，也不是 Git 历史提交数。

因此同一项目不同分支可以有不同任务数；只有已经同步到该 taskSpace 的任务才会出现在索引中。当前库中一个 taskSpace 的索引行数与任务目录数均为 `330`，另一个为 `112/140`，说明“这个项目任务特别多”主要来自该 taskSpace 实际同步的任务目录更多，而不是服务端随机生成了 108 个卡片。单任务更新时，任务目录和正文越多，旧实现的临时落盘、递归解析和全量重插成本越大，所以只有这个项目明显变慢。

## 用户观测到的延迟

前序排查记录：

1. `22:00:22` 创建本地任务目录。
2. 本地 watcher 日志显示 `scanMode=incremental`、`taskDirs=109`、`dirtyTaskDirs=1`、`taskJsonReused=108`、`taskJsonParsed=1`、`taskFilesHashed=4`、`elapsedMs=2849`。
3. `22:00:51` 服务端提交 revision `412`。
4. `22:01:31` 服务端索引完成，约提交后 `40s` 任务才可见。
5. 后续 revision `416` 于 `22:12:39` 提交，约 `22:14:12` 完成索引，延迟约 `93s`。

这说明本地扫描已经是增量；服务端全量物化、排队和重复 revision 是主要延迟来源。

## 全量物化重放

使用当前快照数据和 `scan-worker.js` 的 `snapshot-materialize` 路径做只读性能重放，未写数据库、未改变任务文件：

- 首次约 `5.69s`。
- 后续连续执行约 `11.3s`、`13.2s`、`16.3s`。

该组数据是开发机测量，不应当被描述为稳定 SLA；它用于证明当前实现的工作量与任务空间规模相关，而不是本地 watcher 问题或网络单点。

## 当前代码证据

- 每次 revision 回调进入 `enqueue()`：`packages/server/team/http.js:1632`。
- 全量读取文件正文：`packages/server/team/task-space-index.js:564`。
- Worker 写入全部行并全量扫描：`packages/server/team/scan-worker.js:180`。
- loader 重新遍历全部任务目录：`packages/server/loader.js:636`。
- 索引全删全插：`packages/server/team/task-space-index.js:490`。
- 扫描结束后的 revision 检查在事务外：`packages/server/team/task-space-index.js:601`。
- 提交事务内的 `indexed_revision` 条件更新：`packages/server/team/task-space-index.js:557`。

## 一致性事实

- `sync_task_space_file` 是快照文件正文和删除墓碑的事实源。
- `sync_task_space.revision` 只在成功非 no-op 批次后递增。
- `indexed_revision` 只应在完整投影成功后推进。
- 旧 revision 结果不能覆盖新 revision；但当前扫描结束后的检查窗口需要事务内复核来彻底封住。
- 丢弃旧投影结果不会让投影清理已提交文件行；如果后续 revision 合法覆盖同一路径，当前快照按后续内容为准，但并发覆盖必须由 CAS/冲突流程拒绝。
- `sync_file_audit` 记录摘要，不承诺保存所有历史正文；完整旧正文只在现有冲突备份路径保存。这个边界不能在性能优化中被误解或悄悄改变。

## 结论

本地扫描不是根因。服务端正常路径把“一个任务目录变化”转换为“整个 taskSpace 重新读取、落盘、解析、索引”，并且多个 revision 会排队放大成本。目标应是只减少文件级工作，不删除父子关系、身份冲突和跨任务执行投影这些必须的全局计算。
