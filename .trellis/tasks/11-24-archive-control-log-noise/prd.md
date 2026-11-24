# 桌面端归档任务控制日志降噪与归档目录排除

## Goal

消除桌面端每一轮同步为每个已归档 control 重复打印的 `任务进入 Archived 控制状态…` WARN，让该日志只在本地确实持有租约、真的执行释放时出现；同时在客户端 control 消费点短路 `.trellis/tasks/archive/` 目录。

## Background

现场日志取自 `C:\Users\yuhaojie\AppData\Local\TrellisBoard\data\logs`（2026-11-24 现场）：

| 事实 | 数据 | 来源 |
| --- | --- | --- |
| 单行日志占满整个日志文件 | `desktop.log` 17,290 行中 16,680 行（96.5%）是这一条 WARN，后续复测增至 18,820 行 | 现场日志统计 |
| 一轮同步打印一次全量归档清单 | 每次 pull 恰好 144 条 Archived + 2 条 HandoffMaterialized | 日志批次结构 |
| 打印频率等于同步频率 | 3.4 小时 105 个批次，间隔中位数 8 秒，20 次 < 5 秒 | 日志批次结构 |
| 所有被打点的目录都是归档目录 | 18,820 条全部带 `tasks/archive/` 前缀 | 现场日志统计 |
| 归档任务数只增不减 | 776 个 unique 归档目录，按月份 2026-05→11 从 44 增至 247 | 现场日志统计 |

代码侧根因：

| 位置 | 行为 |
| --- | --- |
| `packages/desktop/src-tauri/src/agent/task_sync/control.rs:592-637` | `release_inactive_task_leases` 遍历快照里**所有** `!control.is_writable_local()` 的 control |
| `control.rs:600-604` | 对每个这样的 control 直接 `logging::warn("任务进入 {:?} 控制状态，本地数据保留并停止写回：{}")`，打印发生在 `stored_task_lease` 查询（`control.rs:218-229`，纯内存读）之前，无论有没有租约可释放 |
| `packages/desktop/src-tauri/src/agent/task_control.rs:35-40` | `is_writable_local` 仅 `Materialized | Claimed | PendingDelivery` 为真，`Archived` 永远不可写 → 每轮必打 |
| `packages/server/team/snapshot/views.js:38`、`packages/server/team/task-control/views.js:99-145` | 快照每次都下发该 Agent 可见的**全量** controls（`afterRevision` 只过滤 files，不过滤 controls），归档行无过滤无分页 |

即：日志量 = 归档任务数 × 同步次数，且「进入 Archived 状态」是边沿事件，代码却按每轮状态打点，无迁移判断、无去重。

归档 control 是必需的：`packages/desktop/src-tauri/src/agent/task_sync/local_files.rs:5-16` 的 `cleanup_archived_controls` → `cleanup_archived_residue`（`local_files.rs:80-128`）靠它推导活跃路径并清理归档后残留的活跃副本；文件内容与目录扫描本来就已经把 archive 排除（`packages/server/team/snapshot/shared.js:310-311`、`packages/server/team/snapshot/views.js:47-60`、`task_sync/watch.rs:270-275`、`local_files.rs:569`、`ownership.rs:324/:351/:375`）。所以本次不动服务端契约，只修客户端日志语义与归档目录短路。

## Requirements

- R1 **日志语义**：`release_inactive_task_leases` 只在本地确实存在租约（`stored_task_lease` 返回 `Some`）并进入释放流程时记录一条日志；没有租约的 Archived / HandoffMaterialized / Reassigned control 静默跳过。真实释放记 `info`（文案需包含 `relative_dir` 与状态），释放失败仍记 `warn`。
- R2 **归档目录短路**：`inactive_control_dirs`（`initial_sync.rs:1087-1095`）对 `is_archive_task_dir(relative_dir)` 的 control 直接过滤；`upload.rs:66-79` 的等价集合输入已在 `upload.rs:82` 被 `is_archive_task_dir` 过滤，本次不改动。
- R3 **行为不变**：归档 control 的本地租约清理逻辑保留（跳过会在本地残留 stale lease）；`cleanup_archived_controls`、上传排除、`prepare_controlled_server_groups` 的控制过滤、服务端 controls 契约均不改。
- R4 **兼容**：新旧服务端（仍然下发 archived controls 的版本）行为一致；Web/服务端零改动。
- R5 **测试**：新增单元测试覆盖「无租约不发起释放（日志点在租约分支内，因此也不打印）」「有租约时释放并移除租约」「archive control 被 `inactive_control_dirs` 排除」「`cleanup_archived_controls` 仍清理残留活跃副本」。

## Constraints

- 只改 `packages/desktop/src-tauri/src/agent/task_sync/` 下的 Rust；单文件 ≤1200 行（测试计入）；`control.rs` 674 行、`initial_sync.rs` 1100 行、`local_files.rs` 649 行，新测试放 `task_sync/tests/`。
- 日志必须走 `crate::logging::info/warn`；不引入新依赖；仓库统一 LF。
- 本机无 Rust 工具链：`cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml` 只在最后跑一次并交给 CI 复核；本地可跑 Node 测试与静态 grep。
- 未经用户确认不 commit、不 push。

## Acceptance Criteria

- [ ] 连续多轮同步（含至少一次真实租约释放）后，`desktop.log` 新增行中不再出现 `任务进入 Archived 控制状态`；出现的是且仅是与实际进入释放流程次数一致的 `info` 行。
- [ ] 无租约场景下 `release_inactive_task_leases` 不发起任何网络释放请求（单测断言）；日志点位于租约分支内，因此也不会产生输出。
- [ ] `inactive_control_dirs` 对 archive control 不再产出路径；`pull`/`upload` 行为不变由现有测试与既有 archive 排除路径共同保证（本地扫描 `local_files.rs:594-596`、cursor 载入 `cursor.rs:194-203` 本就排除 archive）。
- [ ] `cleanup_archived_controls` 仍能清理残留活跃副本（现有测试通过）。
- [ ] CI `cargo test` 全绿；Node 测试不受影响。
- [ ] `git ls-files --eol | rg 'i/crlf'` 无输出。

## Out of Scope

- 服务端不再下发 archived controls、或改为增量/按需下发（需替代残留清理信号，另开任务）。
- `上传未产生提交，继续应用当前快照`（`pull.rs:532`）与 dirty 目录反复上传的放大循环根因。
- 其余 WARN 降噪（`ownership 索引校验`、`任务空间同步失败` 等）。
