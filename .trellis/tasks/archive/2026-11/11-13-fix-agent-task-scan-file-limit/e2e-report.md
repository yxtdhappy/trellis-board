# Agent 全量任务扫描 1024 限制 E2E 报告

## 结论

原始故障场景已通过。最新打包客户端启动后，对 `mdp-backend-service` 的 taskSpace 完成全量扫描并提交 revision `140`：

- 客户端扫描基线为 `1561` 个文件，服务端实际保存 `1561` 个有效文件。
- 服务端接受批次 `3d89cc91-a448-441b-b17a-1cd39fa5b5ff`，revision 和客户端序列均与当前游标一致。
- 服务端 `revision=140`、`indexed_revision=140`，`last_error=null`。
- 本地游标 revision `140`、deferred `0`，服务端文件数与客户端基线一致。
- 当前 taskSpace 单个任务目录最多 `250` 个文件，不存在单目录超过 `1024`；因此本次成功覆盖了“多个任务目录合计超过 1024”的原始故障路径。

用户现场观察新客户端不再出现“单批任务文件不能超过 1024 个”错误，系统侧批次、游标和服务端状态与该观察一致。

## 1. 测试拓扑

| 层 | 进程 / 地址 | 证据 |
| --- | --- | --- |
| 真实客户端 | PID `21840`，启动于 `2026-11-13 13:51:10` | portable `0.3.0`，位于 `C:\Users\yuhaojie\AppData\Local\trellis-board-desktop-windows\TrellisBoard_0.3.0_x64-portable\TrellisBoard_0.3.0_x64-portable\trellis-board-client.exe` |
| 真实 Team 服务 | PID `48952`，启动于 `2026-11-13 13:44:20` | `http://127.0.0.1:4317/api/health` 返回 `status=ok`、`mode=team` |
| 故障复现 taskSpace | `7b8d00fa-f478-4c47-a0ef-615462d5bdb5` | 项目 `mdp-backend-service`，分支 `dev`，客户端与服务端均有 `1561` 个文件 |
| Agent 数据 | `C:\Users\yuhaojie\AppData\Local\TrellisBoard\data\agent` | `runtime.json` 为 `running`；绑定为 `approved/ready`，无 `lastError` |

修复提交 `05f5f1abf83a3a0f92f29883ea711079860a76c7` 已在当前 `main` 和 `origin/main` 中，客户端二进制时间为 `2026-11-13 13:50:53`，晚于修复提交。

## 2. 操作与证据

| # | 操作 | 时间 / 数据证据 | 结论 |
| --- | --- | --- | --- |
| 1 | 启动最新打包客户端 | 客户端 PID `21840`，`2026-11-13 13:51:10` 启动；FileVersion `0.3.0` | 使用最新客户端进程 |
| 2 | 客户端启动全量扫描 | 游标 revision `140`、sequence `1794549086027`、基线 `1561`、deferred `0`，更新于 `2026-11-13 13:51:27 +08:00` | 全量扫描完成，没有 deferred 项 |
| 3 | 服务端接收任务批次 | batch `3d89cc91-a448-441b-b17a-1cd39fa5b5ff`，revision `140`，sequence `1794549086027`，创建于 `2026-11-13 13:51:27 +08:00` | 服务端接受本次同步 |
| 4 | 服务端物化并索引 | taskSpace 状态 `active`，`revision=140`、`indexed_revision=140`、`last_error=null`，更新于 `2026-11-13 13:51:37 +08:00` | 提交与索引一致 |
| 5 | 文件数量核对 | 客户端基线 `1561`；服务端有效文件 `1561`、删除墓碑 `0` | 没有静默截断或遗漏 |
| 6 | 单目录批次边界核对 | `mdp-backend-service` 最大任务目录 `archive/2026-10/10-03-e2e-oracle` 为 `250` 个文件 | 每个任务目录均低于实际上传批次上限 |
| 7 | 其他绑定状态核对 | 5 个 Agent 游标均为 deferred `0`；对应服务端 taskSpace 均为 `revision=indexed_revision`、`last_error=null` | 没有遗留同步错误 |
| 8 | Team 数据库完整性 | `PRAGMA quick_check` 返回 `ok` | 测试读取未发现数据库异常 |

## 3. 日志时间窗

- `desktop.log` 中最后一次“单批任务文件不能超过 1024 个”记录为 `2026-11-13 11:56:12 +08:00`，早于新客户端启动时间 `13:51:10`。
- 新客户端启动后的 `desktop.log` 没有新增成功记录，因此不能仅凭“日志缺失”证明成功；通过服务端 batch、revision、文件计数和游标完成了交叉验证。
- `agent.log` 最后写入时间为 `2026-11-13 08:45:38 +08:00`，早于本次启动；启动后没有新增错误记录。
- `server.log` 在 `13:44:20 +08:00` 仅记录 Team 模式和启动信息，启动后没有新的“任务空间同步失败”或 1024 错误。

## 4. 验证边界

- 本次 E2E 验证了原始故障条件：一个 taskSpace 的多个任务目录合计 `1561` 个文件、单个目录均未超过 `1024`，客户端已成功完成同步。
- 本机仍没有 `cargo`、`rustc`、`rustfmt`，因此本次无法重新执行 Rust 单元测试、`cargo fmt` 或 `cargo clippy`；测试对象是用户提供的已打包客户端。
- “单个任务目录本身超过 1024 时应明确拒绝”以及 64 MiB 边界仍由源码单测覆盖，但未在本次真实任务空间中构造超限数据；PRD 明确不实现单目录自动拆分。
- 本次未删除、改写或清理任务文件，未修改 Agent 绑定和凭据；验证期间只读取状态、日志和 SQLite。

## 5. 结论

原始 1024 聚合扫描缺陷在最新打包客户端上未再出现，客户端扫描、上传、服务端批次落库、索引和游标均已闭环。Rust 编译和真实单批边界拒绝仍需在有工具链的 CI 或开发机上补充执行。

> 2026-11-13 补充（任务 `11-13-desktop-manual-acceptance-gaps`）：Rust 编译已由 `cargo check` 与源码自构建客户端覆盖；真实单批边界拒绝已在真机补齐——夹具仓库内 1101 个文件的任务目录在补传时被 `单批任务文件不能超过 1024 个` 明确拒绝（`apps/desktop/src-tauri/src/agent/task_sync.rs:368-374`，上限 `TASK_SNAPSHOT_MAX_FILES = 1024`，`:16`），服务端 `revision`/文件/批次计数无任何变化，删除超限目录后局部游标自动回落到 1 个待同步任务。证据见 `.trellis/tasks/11-13-desktop-manual-acceptance-gaps/e2e-report.md` §3；64 MiB 边界仍由源码单测覆盖。
