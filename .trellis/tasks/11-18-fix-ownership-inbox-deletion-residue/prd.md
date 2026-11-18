# 修复待归属任务删除后的收件箱残留

## Goal

任务从未成功上传、仍停留在“待归属”状态时，如果用户在本地删除该任务目录，客户端和服务端必须在可观察的短时间内共同收敛：

- 客户端不再显示该任务的待归属、服务端拒绝待处理或待上传状态；
- 项目级待归属收件箱不再返回该摘要，项目计数归零；
- 网络失败或目录暂时不可访问时不得误删其他摘要，并保留可重试证据。

## Background

已通过真实 E2E 复现，不是推测：

- 创建空分支任务 `11-18-e2e-inbox-equal-entry-20261118-1355` 后，服务端收件箱出现一行：
  - `task_id=e2e-inbox-equal-entry-20261118-1355`
  - `task_dir=.trellis/tasks/11-18-e2e-inbox-equal-entry-20261118-1355`
- 直接删除本地任务目录后，服务端任务索引已归零，但项目级收件箱仍为 `1`。
- 客户端 cursor 的 `ownershipPending` 和 `pendingRejected` 仍保留该目录，界面显示“1 个任务服务端拒绝待处理”。
- 打开归属处理界面后只清除了 cursor，未向服务端发送有效 delete，收件箱仍残留。
- 证据见
  [e2e-report.md](../11-17-fix-cross-branch-pending-blocking/e2e-report.md#L31-L37) 的步骤 6-12。

源码确认的根因链路：

1. [task_sync.rs](../../../packages/desktop/src-tauri/src/agent/task_sync.rs#L7779)
   的 `list_task_ownership()` 先从 cursor 清除已不存在的目录，随后才调用
   `sync_ownership_inbox()`。
2. [task_sync.rs](../../../packages/desktop/src-tauri/src/agent/task_sync.rs#L6097)
   的 delete 只能由“旧集合存在、当前集合不存在”的差集生成；先清 cursor 会丢失删除意图。
3. 目录删除后无法再读取 `task.json`，
   [task_sync.rs](../../../packages/desktop/src-tauri/src/agent/task_sync.rs#L6102)
   退化为把目录 basename 当任务 ID；但真实目录名带日期前缀，稳定任务 ID 不一定相同。
4. [task-ownership-inbox.js](../../../packages/server/team/task-ownership-inbox.js#L171)
   的服务端删除只按 `project_id + task_id` 匹配，因此 basename 与真实 ID 不一致时删除为 no-op。
5. `pendingRejected` 属于另一份 cursor 状态，
   [device.rs](../../../packages/desktop/src-tauri/src/agent/device.rs#L889)
   仍会把它投影到客户端状态；现有待归属清理没有同步收敛这份状态。
6. [task_sync.rs](../../../packages/desktop/src-tauri/src/agent/task_sync.rs#L11013)
   在 `.trellis` 或 `.trellis/tasks` 暂不存在时返回空文件数组。调用方不得把这种临时结果直接解释为“所有任务都已删除”。

## Requirements

### R1：对明确删除生成可重试的删除意图

- watcher 明确报告某个活动任务目录消失、且 `.trellis/tasks` 父目录仍可读取时，客户端必须生成该目录的待删除意图。
- 启动和后续对账必须能继续处理上次进程退出前未完成的删除意图。
- 删除意图必须以任务目录为稳定依据，不得要求重新读取已经消失的 `task.json` 才能完成清理。

### R2：客户端状态与服务端摘要原子收敛

- 服务端目录摘要删除成功后，客户端必须在同一个 cursor 更新中清除对应的
  `ownershipPending`、`pendingRejected` 以及本次任务产生的待清理标记。
- 若服务端请求失败，客户端不得假装成功，也不得丢失后续重试所需的任务目录和来源信息。
- 重复执行同一删除必须幂等；第二次删除不得报错、复活摘要或改写无关 cursor。

### R3：服务端只删除当前 Agent 的精确来源行

- 删除范围必须限定为同一 `projectId + taskSpaceId + agentId + taskDir`，不能删除其他 Agent 仍可报告的同名任务。
- 服务端接口可以兼容现有携带 `taskId` 的客户端，但任务文件已消失后，不能再把 `taskId` 作为唯一成功条件。
- 删除成功只发布必要的轻量看板变更，不推进任务正文 revision，不写任务正文，不影响归档同步。

### R4：临时不可访问和扫描异常必须失败关闭

- `.trellis`、`.trellis/tasks` 缺失、不可读、符号链接异常、当前 Git 分支与 binding 不一致或扫描抛错时，禁止批量推断删除。
- 只有“父目录可验证 + 具体任务目录明确不存在”才能为单个任务生成删除意图。
- 目录移动、重命名、分支切换造成的 watcher 删除事件，必须先经过同样的父目录和 binding 校验。

### R5：状态展示必须与真实处理结果一致

- 摘要删除成功后，客户端待归属/拒绝计数和项目级收件箱计数都应归零。
- 删除请求仍在重试时，界面可以显示同步错误或“正在清理”，但不得继续把已删除任务展示成普通“待归属”任务。
- 重启客户端后，已完成删除不得重新出现；未完成删除必须继续重试。

### R6：兼容与范围控制

- 兼容现有 `taskDir -> fingerprint` cursor 数据和现有带 `taskId + taskDir` 的 inbox delete 请求；升级过程中不得丢弃用户现有待归属状态。
- 不改变普通已上传任务的删除墓碑、归档 Git 同步、任务正文读取或其他冲突处理语义。
- 默认路径不得因本修复引入全量活动任务正文读取；删除对账应只读取必要的任务目录元信息或使用已有 cursor/待删除索引。

## Key Decision

- 采用立即清理，不设置宽限期。
- 只有以下条件同时满足才对单个任务目录提交删除：
  - watcher 或本轮扫描明确确认该具体任务目录不存在；
  - `.trellis` 与 `.trellis/tasks` 仍可读取且类型正常；
  - binding 的 Git 分支仍通过现有门禁。
- 父目录缺失、不可读、符号链接异常、读目录报错或 branch 校验失败时，禁止把“无法确认”转换为“全部已删除”。
- 删除请求失败时保留 cursor 中的待归属/拒绝摘要，由现有 ownership 校验、下一次 watcher 事件或客户端重启继续重试；不得先清本地状态再尝试网络删除。
- 健康网络下，从明确删除任务目录到客户端状态和服务端收件箱同时归零，目标 SLA 为 5 秒内，且不需要用户打开归属处理界面。

## Acceptance Criteria

- [x] AC1：创建任务 ID 与目录 basename 不一致的空分支任务，确认项目收件箱出现 1 条后，直接删除本地目录；服务端 inbox 行在健康网络 5 秒内变为 0。
      （2026-11-18 真机：0.4.40 恢复后 772ms 收敛；见 [e2e-report.md](./e2e-report.md#23-040-启动自动续传)）
- [x] AC2：同一操作后，客户端 `ownershipPending` 和 `pendingRejected` 均不再包含该目录，ProjectRail 不再显示待归属或“服务端拒绝待处理”。
      （真机：两份 cursor 均为空，UI 无待归属/拒绝提示；见 [e2e-report.md](./e2e-report.md#23-040-启动自动续传)）
- [x] AC3：退出并重新打开客户端，已删除条目不会重新出现；若上次删除请求未能送达，重启后会继续重试并在成功后收敛。
      （真机：0.4.40 重启 PID `41428` 后仍为 0，未复活；见 [e2e-report.md](./e2e-report.md#24-客户端重启不复活)）
- [x] AC4：模拟服务端不可达后删除任务，失败期间不误报成功；恢复连接后删除成功，且期间没有丢失删除依据。
      （真机：离线记录 `NETWORK_ERROR`，SQLite 与双账本保留；恢复后自动续传归零；见 [e2e-report.md](./e2e-report.md#22-服务端离线后删除任务)）
- [x] AC5：临时让 `.trellis/tasks` 不可读或缺失，cursor 中其他待归属摘要全部保留，不产生批量 delete。
      （真机：父目录缺失 8 秒，inbox 1、双账本、128 条索引全部保留；见 [e2e-report.md](./e2e-report.md#26-父目录缺失时失败关闭)）
- [x] AC6：两个 Agent 报告同一任务时，Agent A 删除只能移除自己的来源行；Agent B 未删除前项目聚合收件箱仍保留该任务。
      （服务端自动化：来源隔离与 `taskDir` 精确删除 7/7 通过；见 [e2e-report.md](./e2e-report.md#4-自动化验证)）
- [x] AC7：同一 delete 连续提交两次均成功且幂等，第二次返回无变化。
      （服务端自动化：重复删除幂等用例通过；见 [e2e-report.md](./e2e-report.md#4-自动化验证)）
- [x] AC8：活动任务移动到 `archive/**` 时，旧活动目录摘要按本流程删除；不向服务端上传归档路径，后续仍由 Git 归档同步负责归档内容。
      （真机：移动后 inbox/双账本归零，活动表、归档表、任务索引均无 probe 路径；见 [e2e-report.md](./e2e-report.md#27-活动任务移动到-archive)）
- [x] AC9：普通已上传任务的删除仍走原有快照墓碑流程，任务正文、冲突、审计和 revision 行为不回归。
      （真机：索引删除，两条文件行在 revision 9 变为 `deleted=1`；见 [e2e-report.md](./e2e-report.md#25-普通-main-已上传任务删除回归)）
- [x] AC10：相关服务端测试、Rust 单元测试、任务校验和真实 Windows 客户端 E2E 均记录通过证据。
      （GitHub Actions run `44291537801`、服务端 7/7 与 4/4、Trellis validate 和真实 0.4.40 客户端均通过；见 [e2e-report.md](./e2e-report.md#4-自动化验证)）

## Out of Scope

- 重新设计空分支任务的归属推断、自动补分支或多分支候选选择规则。
- 改变归档任务的事实源、Git 定时同步频率、凭据模型或归档正文读取方式。
- 优化整个任务同步链路或历史归档扫描性能；本任务只处理待归属任务删除后的残留收敛。
- 改造归属处理对话框的视觉设计。
- 物理清理服务端历史审计、归档文件或已 resolved 的冲突记录。

## Notes

- 用户已确认最终方案，任务已进入实施。
- 代码已按模块化后的最新 `task_sync` 结构完成，服务端聚焦测试通过；Rust 编译与真实客户端 E2E
  仍受当前环境缺少 Rust 工具链和新桌面包限制。
