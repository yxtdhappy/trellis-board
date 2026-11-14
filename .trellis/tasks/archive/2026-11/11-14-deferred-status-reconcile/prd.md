# 修复已一致任务的本地未同步误报

## Goal

当首次接入时被延后的本地任务已经与客户端已知的服务端文件集合和 SHA256 完全一致时，自动清除
`deferred` 标记，让 ProjectRail 不再长期显示“N 个本地任务未同步”；真实差异必须继续显示并保持
现有冲突处理边界。

## Background / Confirmed Facts

- ProjectRail 的“N 个本地任务未同步”文案直接来自 `deferredCount`：
  [ProjectRail.tsx](../../../apps/web/src/components/layout/ProjectRail.tsx:275)。
- `deferredCount` 来自本地 `live-cursors.json` 的 `deferred`：
  [device.rs](../../../apps/desktop/src-tauri/src/agent/device.rs:941)。
- 当前清理路径只在本地任务内容发生变化，或显式补同步/冲突处理成功时删除 deferred：
  [task_sync.rs](../../../apps/desktop/src-tauri/src/agent/task_sync.rs:2306)、
  [task_sync.rs](../../../apps/desktop/src-tauri/src/agent/task_sync.rs:4610)。
- 当前真实客户端数据中，`trellis-board` 的 65 个 deferred 任务全部已经在服务端存在，逐文件
  SHA256 一致：65/65 exact，0 missing，0 mismatched。
- 其他关联同样全部一致：`mdp-backend-service` 8/8、`mdp-report-service` 10/10、
  `mdp-management-web` 6/6。
- “本地任务未同步”和“因分支不匹配暂停/待确认归属”是两套独立状态；本任务只修复 deferred 误报。
- 上传按钮是 approved、可写、非暂停关联的显式补同步入口，会尝试上传该 taskSpace 当前全部
  deferred 目录；它不是用于清除误报的按钮。
- UI 每 3 秒读取 association，因此清理逻辑不能放进 `list_local_associations` 的周期性展示路径，
  否则会重新引入任务正文全量扫描和 CPU 开销。

## Requirements

### R1 已一致任务自动收敛

- 客户端在启动绑定时，以及后续正常快照拉取时，允许把 deferred 任务与本地完整任务状态、客户端
  已知的服务端文件基线进行比较。
- 只有任务目录、文件集合和每个文件 SHA256 全部一致，且本地任务存在时，才自动删除对应 deferred。
- 任务目录缺失、服务端缺文件、本地多文件、摘要不同或基线不完整时，deferred 必须保留。

### R2 一次性启动清理

- 启动清理不依赖新的服务端 revision，否则当前 revision 已经追平时旧标记可能永远不消失。
- 清理只在客户端启动或 binding 首次进入运行集合时尝试；不能在 3 秒 association 展示轮询中重复
  扫描任务正文。
- 同一进程内已尝试过的 taskSpace 不重复执行启动清理。

### R3 保持同步和信任边界

- 自动清理 deferred 不代表上传、覆盖、补同步或接受冲突。
- 保留显式上传按钮及其确认、approved/可写校验、分支门禁、CAS 和冲突流程，供用户在确认
  本地任务确实需要发布到当前分支时使用。
- 清理不得修改任务文件、不得调用项目 Git、不得推进服务端 revision、不得写 pending batch。
- 真实存在差异时继续使用现有 CAS 上传、冲突和显式补同步流程。
- 只有 deferred 实际变化时才写本地 cursor；相同 patch 不落盘。

### R4 可观测和回归

- 正常快照 pull 也必须能收敛已经一致但落后的 deferred 标记。
- 清理后，下一次读取 association 时 ProjectRail 从“N 个本地任务未同步”恢复为“同步正常”，
  不改变 ownership 暂停/待确认文案。本任务可先由现有 association 刷新机制观测结果；后续状态
  性能优化任务再把该刷新改为事件驱动。
- 相关同步规范需要明确“安全接入 deferred 与服务端已知状态一致时可自动收敛”。

## Acceptance Criteria

- [x] 启动客户端时，若 deferred 与本地任务及 cursor 中已知服务端基线完全一致，自动删除该 deferred。
- [x] 当前 `trellis-board` 65 个、`mdp-backend-service` 8 个、`mdp-report-service` 10 个、
  `mdp-management-web` 6 个已一致 deferred 在新客户端启动后不再显示为“本地任务未同步”。
- [x] 服务端没有新 revision 时也能完成上述收敛。
- [x] 正常增量 pull 收到服务端快照后，同样能清理已经全部一致的 deferred。
- [x] 本地多文件、服务端缺文件、文件被删除、SHA256 不同、cursor 基线为空或不完整时，deferred 保留。
- [x] 自动清理不产生上传请求、不修改任务正文、不推进服务端 revision、不生成冲突。
- [x] 3 秒 `list_local_associations` 展示轮询不重新读取任务文件正文，修复后 CPU 行为不能回退为旧版全量扫描。
- [x] deferred 未变化时不重写 `live-cursors.json`。
- [x] Rust 单测覆盖 exact、hash mismatch、server missing、local extra、empty baseline 和只清理一次。
- [x] 先验证 cursor 中 `deferredCount` 收敛为 0，并确认真实 Windows 客户端最终从
  “65 个本地任务未同步”更新为“同步正常”。本任务不要求先完成 association 事件化。
- [ ] 与后续状态性能优化任务联调时，再验证 ProjectRail 不依赖本地关联轮询即可由 Tauri 事件完成
  同一更新。

## Out of Scope

- 自动上传任何 deferred 任务。
- 自动覆盖服务端文件、接受冲突或删除本地任务。
- 修改分支归属、ownership pending、baseline merge evidence 或 taskSpace 去重。
- 服务端 schema、Team API 或 Web 数据契约变更。
- 清理真实存在差异的 deferred 标记。
