# 优化 Agent 任务同步 CPU 与 I/O 开销

## Goal

消除相同 revision 的重复 `task.changed` 触发的无效任务空间拉取、全量本地任务扫描和高频游标重写，在保持实时同步、分支保护和失败重试语义不变的前提下，降低 Agent 的 CPU、磁盘 I/O 与临时内存占用。

## Background

2026-11-13 对已部署 0.2 Node Agent 做了 10 分钟、120 样本的性能基线：

- Agent 平均占用整机 8.66% CPU，P95 14.27%，占客户端整树 CPU 约 93%。
- Agent 平均读取 1.40 MB/s、写入 0.35 MB/s。
- 约 0.7 MB 的 `live-cursors.json` 在 30 秒内被重写 24 次，约 0.8 次/秒。
- 20 秒内 5 个 taskSpace 的游标 `updatedAt` 更新 14 次，但 revision 全部没有变化。
- 同 revision 事件仍执行完整拉取：读取游标、拉取任务快照、全量扫描本地 `.trellis/tasks`、重新计算文件摘要，最后重新写回整个游标文件。

当前 0.3 Rust 实现仍保留同一语义：

- `task.changed` 直接调用拉取：[apps/desktop/src-tauri/src/agent/runtime.rs](../../../apps/desktop/src-tauri/src/agent/runtime.rs:399)。
- 拉取时调用 `local_sync_state`，并以 `None` 扫描全部本地任务目录：[apps/desktop/src-tauri/src/agent/task_sync.rs](../../../apps/desktop/src-tauri/src/agent/task_sync.rs:1986)。
- 本地扫描递归读取每个可同步文件并计算 SHA-256：[apps/desktop/src-tauri/src/agent/task_sync.rs](../../../apps/desktop/src-tauri/src/agent/task_sync.rs:4265)。
- 每次游标写入都会刷新 `updatedAt`，整体序列化并原子写回：[apps/desktop/src-tauri/src/agent/task_sync.rs](../../../apps/desktop/src-tauri/src/agent/task_sync.rs:1227)。
- 服务端投影完成时广播 `task.changed`，当前没有按 revision 去重：[apps/server/team/http.js](../../../apps/server/team/http.js:1706)、[apps/server/team/agent-event-stream.js](../../../apps/server/team/agent-event-stream.js:59)。

当前机器仍运行 0.2 Node Agent；0.3 Rust 源码尚未部署，因此最终验收必须在 0.3 Rust Agent 构建上重新执行基线对照。

## Requirements

### R1 服务端 revision 去重

- 同一 taskSpace 的 `task.changed` 只能向在线 Agent 广播比上次已广播 revision 更新的版本。
- 相同 revision 或更旧 revision 不得重复广播。
- 服务端重启、SSE 断开重连后仍必须通过客户端现有全量补偿拉取恢复一致性，不新增持久化 schema。

### R2 客户端 revision 短路

- Agent 收到 `task.changed` 后优先比较事件 revision 与当前游标 revision。
- 已完成首次同步、没有待重试 upload，且事件 revision 小于或等于当前 revision 时，必须直接跳过网络拉取、本地全量扫描和游标写入。
- 首次同步、事件流重连、分支恢复、存在 pending upload 或事件缺少 revision 时，保留现有拉取行为。

### R3 游标无变化不落盘

- `write_cursor` 只有在 revision、sequence、baselines、deferred、ownershipPending、conflictBlocked 或 pending 实际变化时才写入。
- 仅 `updatedAt` 变化不得触发整个游标文件序列化和原子替换。
- 游标 JSON schema 和现有读取兼容性保持不变。

### R4 同步正确性不退化

- 真正的新 revision 必须拉取并应用。
- 本地 watcher 触发的上传、pending retry、冲突处理、分支不一致、首次同步和事件流重连行为保持不变。
- 多客户端、同项目多分支和多 taskSpace 场景不得出现漏同步或跨分支串写。

### R5 可验证性

- 修复必须包含服务端事件去重测试、客户端 revision 判定测试和游标无变化测试。
- 最终在 0.3 Rust Agent 上做修复前后同条件测量，记录 CPU、读/写字节、游标修改次数和快照 GET 次数。
- 不把宿主 CPU 饱和造成的绝对百分比作为唯一门槛，必须同时验证无效请求和无效写入为零。

## Acceptance Criteria

- [x] 服务端对同一 taskSpace 连续通知 revision `10, 10, 9, 11` 时，在线 Agent 只收到 revision 10 和 11 两个 `task.changed`。
- [x] 客户端在首次同步完成、无 pending upload 且当前 cursor revision 为 10 时，收到 revision 10 或 9 不产生任务空间快照请求、不扫描 `.trellis/tasks`、不修改 `live-cursors.json`。
- [x] 同一客户端收到 revision 11 后完成一次正常拉取；重复 revision 11 不再次拉取。
- [x] cursor pending upload 存在时，即使事件 revision 不新，也仍执行既有 pending retry。
- [x] `write_cursor` 收到与当前状态完全相同的 patch 时不写文件；任一状态字段实际变化时正常写入。
- [ ] 首次同步、SSE 重连补偿、真实新 revision、分支不一致、冲突和本地 watcher 上传测试继续通过。
- [ ] 在相同重复事件压力下，修复后重复 revision 对应的任务空间 GET、全量本地扫描和游标写入均为 0；真实新 revision 仍各执行一次。
- [x] 最终在 0.3 Rust Agent 上完成至少 10 分钟真实运行验证，确认无 revision 变化期间不再出现约 0.8 次/秒的游标重写。

## Out Of Scope

- 将全局 `live-cursors.json` 拆分或迁移到 SQLite。
- 为真实新 revision 设计增量文件索引、mtime cache 或数据库物化视图。
- 修改分支监听、解绑生命周期或跨分支冲突策略。
- 改变任务快照协议、CAS 规则、revision 生成和冲突语义。
- UI 展示或服务端监听者统计功能。

## Technical Notes

- 现有游标 schema 为 `version=3`，本文不要求版本升级。
- 服务端去重状态可驻留内存；SSE 重连补偿继续由客户端首次/重连拉取保证。
- pending upload 是客户端短路判断的例外，不能因 revision 不新而跳过重试。
- 上游重复投影的具体来源仍需在实现验证阶段通过测试或事件计数确认；本任务先保证协议和客户端对重复通知幂等。

## Open Questions

无阻塞问题。MVP 选择最小运行时保护，不在本轮重做游标存储或本地索引。
