# 修复二次委派时来源副本不清理

## Goal

同一任务在经历多轮跨用户委派时，创建者本机的来源副本清理必须按“物化轮次”独立执行：新一轮 `source_cleanup_pending` 不能被上一轮的 `done/cleaned` 状态吞掉，Board 不能永久停留在“等待来源副本清理”。

用户价值：委派 → 回收 → 再委派是正常协作流程。每一轮目标落地后，创建者副本都应恰好清理一次（可重复触发、同轮幂等），而不是只有第一轮生效。

## Background / Confirmed Facts

- 任务 `test1`（`.trellis/tasks/11-20-test1`）经历了三轮委派：`yhj → flyfly6 → yhj → kyf`。
- 第一轮（flyfly6）清理已在 `2026-11-20T01:43:45Z` 完成：本机生成备份 `handoff-8f4d8c4dab571e0e`，服务端审计 `task_handoff_cleanup_ack = cleaned`（`packages/server/team/task-control/handoff.js:7`，`audit_event.id=36`）。
- 第二轮 `flyfly6 → yhj` 让本机重新物化该目录（目录 mtime 09:54），证明来源副本可以合法地再次出现。
- 第三轮 `yhj → kyf` 于 `2026-11-20T01:57:03.950Z` 在服务端重新置为 `handoff_state = source_cleanup_pending`（`packages/server/team/task-control/tasks.js:138`）。
- 本机 `task-control-state.json` 中该任务的 handoff 记录仍是第一轮的 `ackState=done / outcome=cleaned / backupId=handoff-8f4d8c4dab571e0e`。
- 客户端合并新控制时无条件继承旧 ACK 字段（`packages/desktop/src-tauri/src/agent/task_control.rs:423`）；清理入口看到 `outcome` 非空直接返回（`packages/desktop/src-tauri/src/agent/task_sync/handoff.rs:850`）；重试通道只处理 `ackState=pending`（`packages/desktop/src-tauri/src/agent/task_sync/control.rs:532`）。
- 结论：任何“委派出去 → 派回来 → 再委派出去”的任务都会复现，不是本次测试数据的偶发现象。

## Requirements

- R1 轮次识别：客户端必须为 handoff 记录持久化本轮物化标识（服务端控制里的 `materializedAt` 与 `materializedRevision`），并在收到同一任务的新控制时判断是否属于新一轮。
- R2 新一轮重置：物化标识变化时，本地 handoff 记录重置为待处理（`ackState=pending`，`outcome/reason/backupId/manifestSha256` 清空，`fileCount/totalBytes` 归零，`notifiedState` 清空），随后执行完整清理流程：来源状态检查 → 备份 → 删除来源副本 → ACK。
- R3 同轮幂等：物化标识不变时保持现有行为——pending 重试、done 保持、不重复清理、不重复 ACK；进程重启后行为一致。
- R4 旧状态兼容：新增字段对旧状态文件必须可缺省；旧记录缺少物化标识时，遇到带标识的新控制按新一轮处理（自愈当前卡住的 `test1`）；不提升 `task-control-state` 的 `schemaVersion`，旧客户端回滚后仍可读取。
- R5 回归测试：新增覆盖“第二轮委派重新清理”的自动化测试；现有 handoff 相关测试全部通过。
- R6 规范更新：更新 `.trellis/spec/backend/desktop-realtime-sync.md` 的 handoff 契约，明确本地 ACK 状态按物化轮次隔离。

## Acceptance Criteria

- [ ] AC1：同一任务完成一轮清理（`done/cleaned`）后再次被跨用户委派并物化，下一次控制同步会把本地 handoff 记录重置并重新执行清理，生成或复用一份内容可验证的完整备份；ACK `cleaned` 后服务端 `handoff_state=completed`，本机活动目录被删除。
- [ ] AC2：同一物化轮次内重复同步或进程重启，不会重置已完成的 ACK，也不会重复清理或重复 ACK。
- [ ] AC3：升级后用当前 `test1` 的旧状态（无物化标识、`done/cleaned`）触发同步，能自动进入新一轮清理并最终收敛为 `completed`，无需手工编辑状态文件。
- [ ] AC4：`cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml` 通过；新增状态机测试在未修复实现上会失败（回归有效性）。
- [ ] AC5：`desktop-realtime-sync.md` 的 handoff 契约已补充轮次语义。

## Out of Scope

- 服务端 handoff 状态机 / 协议改造（不新增服务端轮次 ID，不改变 ACK 白名单与审计结构）。
- 新一轮 handoff 时本机副本已不存在（`missing`）仍按现有协议 ACK `conflict`；是否把“无需清理”视为成功需另立协议需求。
- 已进入 `source_cleanup_conflict` 的任务自动恢复策略。
- 桌面端 UI 交互变更（除重置 `notifiedState` 后新一轮可再次提示外）。

## Open Questions

- 无阻塞问题。