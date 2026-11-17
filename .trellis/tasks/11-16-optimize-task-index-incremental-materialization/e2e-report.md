# Team 任务索引增量物化 E2E 报告

## 测试拓扑

- 服务端：真实 Team runtime，监听 `0.0.0.0:4317`。
- 数据库：`%LOCALAPPDATA%\TrellisBoard\server\board.sqlite`。
- 客户端：本机桌面客户端，保留真实登录和 Agent binding。
- 任务规模：当前主 taskSpace 约 `331` 个任务目录、`1619` 个活动文件。

## 服务端投影

冷启动 full：

- `mode=full`
- `scannedTaskCount=331`
- `contentRowsRead=1619`
- `workerMs=9750`
- `relationshipMs=38`
- `databaseMs=117`
- `totalMs=9949`

warm 单任务：

- `mode=incremental`
- `changedTaskCount=1`
- `scannedTaskCount=1`
- `reusedTaskCount=331`
- `contentRowsRead=4`
- `workerMs=24`
- `relationshipMs=21`
- `databaseMs=70`
- `totalMs=139`

这说明单任务更新已不再复制和解析整个 taskSpace。

## 客户端重开

- 只退出并重新打开客户端，服务端没有重启。
- 服务端投影次数保持为 `2`，5 个 taskSpace 的 revision 均未变化。
- 没有发生第二次全量扫描。

## 服务端重启

- 重启后已有 taskSpace 的 `revision` 与 `indexed_revision` 仍一致，任务数据保留。
- 重启后的首次请求执行一次 full 重建，随后 warm 单任务恢复增量。

## 端到端延迟

一次真实任务创建从本地操作到 Board 可见约 `9.293s`：

- 服务端投影约 `139ms`。
- 约 `9.18s` 位于客户端 watcher、任务扫描和上传阶段。
- 因此本次改动明显改善了服务端瓶颈，但没有让端到端 P95 达到 `3s`；剩余问题属于客户端链路。

## 未完成项

- 当前源码工作区没有 `packages/server/public` 的构建产物，客户端重开后页面返回 `静态资源不存在 / NOT_FOUND`，未完成页面视觉验收。
- 临时 E2E 任务已移出项目，备份位于 `D:\wit\merge-backups\trellis-board\e2e-temp-tasks-20261116-234918`。
