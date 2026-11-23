# 修复任务归属确认被非 UTF-8 文件整体阻断

## Goal

任务归属确认不再全量扫描所有任务目录；UTF-8 解码失败错误带出任务文件相对路径，并在兄弟任务目录含非 UTF-8 文件时仍可完成归属。

## Background

- 2026-11-23，mdp-backend-service 的待归属任务 `.trellis/tasks/11-23-release-management` 在来源客户端（Z0423-NZ-E，@nzhou）点击“确认归属”时提示“任务文件不是有效的 UTF-8 文本”，随后该 taskSpace 持续出现 `INVALID_RESPONSE` 同步失败。
- 客户端 `set_task_ownership` 在写入归属前调用 `local_groups(binding, None)` 全量扫描 `.trellis/tasks`；`read_local_task_snapshot_files` 对每个白名单扩展名文件做严格 UTF-8 解码，任一文件失败即整次扫描失败并向上返回。
- ownership 索引增量扫描有同样的严格解码与整体失败行为。
- 当前错误信息不带文件路径，用户和日志无法定位是哪个文件；UI 只能原样展示“任务文件不是有效的 UTF-8 文本”。
- `.trellis/spec/backend/desktop-task-path-resolution.md` 规定用户错误文案不得包含 `repoPath`，因此路径必须以相对任务路径形式给出。

## Requirements

- R1 可诊断性：会向上返回或写入同步失败日志的任务文件严格 UTF-8 解码错误，消息必须包含该文件的相对路径（以 `.trellis/tasks/` 开头），且不得包含本机绝对路径。覆盖：
  - 任务快照扫描；
  - ownership 索引扫描；
  - 任务命令读取 `task.json`。
- R2 收敛扫描范围：`set_task_ownership` 只读取本次 decisions 涉及的任务目录，不再全量读取 `.trellis/tasks`；兄弟任务目录中的非 UTF-8 文件不得阻断本次归属动作。
- R3 保持失败关闭：目标目录本身含非 UTF-8 文件、任务目录格式非法、目录不在本地/不属于本客户端、归属动作或分支非法时，操作仍然失败，不写分支、不推进 cursor。
- R4 归档目录继续不参与任务扫描；白名单扩展名、单文件大小、符号链接等既有约束不变。
- R5 不改变服务端 API、SQLite schema、同步协议和 pending/conflict 语义；错误文案变化只影响展示和日志。

## Non-goals

- 不实现“跳过非 UTF-8 文件继续同步”：非 UTF-8 内容仍必须失败关闭。
- 不改变其他操作的同步失败策略；单个坏文件仍会让该 taskSpace 的常规同步报错，直到文件被修复。
- 不修复用户机器上的具体坏文件（需要报错客户端把该文件另存为 UTF-8）。

## Acceptance Criteria

> 验证证据：GitHub Actions run `45107316470`（tag `v0.4.57`），Rust 单测 376 通过，见 `check-report.md`。

- [x] 构造 `.trellis/tasks/<dir>/prd.md` 为非 UTF-8 时，`read_local_task_snapshot_files` 返回的错误消息包含 `.trellis/tasks/<dir>/prd.md`。
- [x] 构造 ownership 索引必须解码非 `task.json` 文件的场景时，错误消息包含该文件相对路径。
- [x] 目标任务目录正常、兄弟任务目录含非 UTF-8 文件时，`set_task_ownership` 成功（测试使用 `defer`；`use-branch` 复用同一预检），且兄弟目录文件不会被解码。
- [x] 目标任务自身含非 UTF-8 文件时，`set_task_ownership` 仍失败，错误消息包含该文件路径。
- [x] 既有归属校验（无效目录、重复决定、非法动作、非法分支）行为不变。
- [x] `cargo test` 中相关 task_sync / task_command 测试通过。