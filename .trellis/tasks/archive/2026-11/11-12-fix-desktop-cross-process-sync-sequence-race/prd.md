# 修复桌面首次同步跨进程游标竞态

## Goal

修复桌面控制 Sidecar 与常驻 Agent 并发维护 live-cursors 导致重复 clientSequence 的问题，并补齐恢复逻辑与回归验证。

## Background

- `AgentTaskSnapshotSync` 首次读取 `live-cursors.json` 后会把整个状态永久缓存在内存中。
- 常驻 Agent 和控制 Sidecar 是不同进程，但会创建各自的同步实例并写同一个游标文件，后写进程可能基于旧状态生成重复序号。
- 两个同步实例已可稳定复现该问题：双方都读取 `sequence=0`，实例 A 写入 1 后，实例 B 仍返回 0 并生成下一个序号 1。
- 现场任务空间 `9269f774-5cd1-40e9-b3f0-4a5dc998b8b2` 的报错客户端第一次提交序号 1 成功，随后新批次继续使用序号 1，被服务端以 409 拒绝并持续重试。
- 服务端严格递增校验必须保留；问题属于客户端跨进程状态一致性，不是跨用户或跨设备序号冲突。

## Requirements

- R1：首次同步、日常文件监听、待上传任务和冲突处理必须使用一致的序号状态，常驻 Agent 与桌面控制 Sidecar 交错执行时不得持久化重复 `clientSequence`。
- R2：同一任务空间收到 `clientSequence 必须严格递增` 后，应能够识别本地游标失配并安全恢复，不能永久保留错误 pending 批次并重复弹窗。
- R3：网络响应丢失后的重试必须继续复用原 `batchId`、`clientSequence` 和文件内容，保持服务端幂等语义。
- R4：恢复过程不得跳过真实本地修改，不得覆盖服务端更新，不得删除已有批次审计或冲突记录。
- R5：序号校验仍按 Agent 和设备隔离，不能通过放宽服务端严格递增规则来掩盖客户端状态错误。
- R6：已有 `revision`、`baselines`、`deferred` 和其他任务空间游标必须保留；修复不得要求清空整个 Agent 数据目录。

## Acceptance Criteria

- [ ] AC1（R1）：自动化测试覆盖两个同步实例并发选择批次，最终实际新建批次的序号严格递增，且不能覆盖已持久化的更高序号。
- [ ] AC2（R1、R6）：常驻 Agent 已读取游标、控制 Sidecar 随后推进游标后，Agent 下一次读取能够看到新值，旧内存缓存不会覆盖文件。
- [ ] AC3（R2）：客户端游标为 0 且残留序号 1 的错误 pending、服务端最大序号为 1 时，客户端能够修正为序号 2 并完成重试。
- [ ] AC4（R3）：网络失败后的同一 `batchId` 重试输入完全不变，服务端重放不产生第二个 revision。
- [ ] AC5（R4、R5）：服务端继续拒绝非递增的新批次，并返回足够客户端安全修正的只读序号提示；不写入部分批次。
- [ ] AC6：相关 Agent 与团队快照测试通过，最终完成一次仓库约定的编译验证。
- [ ] AC7：真实桌面重启和控制操作后，同步失败弹窗不再持续出现，后续任务修改能够正常同步。

## Technical Notes

- 客户端问题入口：[task-snapshot-sync.js](D:/wit/trellis-board/agent/task-snapshot-sync.js:317)、[task-snapshot-sync.js](D:/wit/trellis-board/agent/task-snapshot-sync.js:358)、[task-snapshot-sync.js](D:/wit/trellis-board/agent/task-snapshot-sync.js:1005)。
- 控制 Sidecar 独立进程入口：[main.js](D:/wit/trellis-board/desktop/sidecar/main.js:414)。
- 服务端严格递增校验：[task-snapshot-service.js](D:/wit/trellis-board/server/team/task-snapshot-service.js:417)。
- 临时恢复只能手工备份并校正该任务空间游标的 `sequence`、清除错误 `pending`；本任务负责提供升级后的自动恢复能力。

## Out of Scope

- 不允许服务端接受非递增的新批次，也不删除 `sync_task_space_batch` 历史来绕过校验。
- 不合并常驻 Agent 与控制 Sidecar 进程，不新增本地 IPC 服务。
- 不修改任务快照传输格式、revision/CAS 冲突语义或冲突备份格式。
- 不清理其他任务空间游标，不要求用户重置整个 Agent 数据目录。

## Open Questions

无阻塞问题。
