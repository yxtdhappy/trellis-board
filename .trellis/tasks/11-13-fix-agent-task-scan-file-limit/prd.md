# 修复 Agent 全量任务扫描误用 1024 文件批次上限

## Goal

让 0.3 Rust Agent 正常同步“单个 taskSpace 总文件数超过 1024、但任一次实际上传批次未超限”的任务空间，避免一个覆盖多个任务目录的全量扫描被错误当成一个 HTTP 上传批次。

## Background

- `D:\wit\mdp-backend-service` 的 `dev` 工作区当前有 1561 个可同步任务文件，总计约 11.38 MiB。
- 单个任务目录最大只有 250 个文件，没有单目录超过 1024。
- 旧 Agent 的真实 E2E 曾成功同步总计 1518 个任务文件。
- 当前 0.3 Rust Agent 在按任务目录分组前，对全量扫描结果执行 1024 文件校验，因此 `task.changed`、文件监听和重试都会重复失败。

## Requirements

- R1：全量扫描和分组阶段不得把整个 taskSpace 的文件总数当作单个上传批次；多个任务目录文件合计超过 1024 时必须继续分组和同步。
- R2：真正发往服务端的每批上传仍必须限制为最多 1024 个文件、最多 64 MiB，并由 Agent 在创建 pending 批次前校验。
- R3：单个任务目录确实导致上传批次超限时，必须返回明确错误，不得静默截断、遗漏或改写任务文件。
- R4：分支保护、任务归属、CAS、冲突、删除墓碑、pending 重试和 64 MiB 运输边界保持现有语义。
- R5：增加聚合扫描超过 1024 但多个任务目录各自未超限的回归测试，以及实际上传批次超限测试。

## Acceptance Criteria

- [ ] 构造 1100 个文件、分布在两个任务目录且每个目录不超过 1024 时，Agent 能完成分组，不再返回“单批任务文件不能超过 1024 个”。
- [ ] 实际待上传批次达到 1024 个文件时允许上传，达到 1025 个时在写入 pending 批次前拒绝。
- [ ] 实际待上传批次正文达到 64 MiB 时允许上传，超过 1 字节时拒绝。
- [ ] 现有任务目录冲突、重复路径、活动/归档混批、分支保护和 pending 重试测试保持通过。
- [ ] 当前机器缺少 Rust 工具链时，检查报告必须明确记录未执行的编译与真实客户端验证，不得把静态检查记为编译通过。

## Technical Notes

- 当前故障位于 `apps/desktop/src-tauri/src/agent/task_sync.rs` 的全量分组路径，不需要修改服务端协议或任务数据。
- 本次不实现“单个任务目录超过 1024 时自动拆分上传”；该场景保留明确失败，后续按真实需求单独设计。
- 本次不提高 1024 或 64 MiB 常量，也不删除历史任务。

## Notes

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add `design.md` for technical design and `implement.md` for execution planning before `task.py start`.
