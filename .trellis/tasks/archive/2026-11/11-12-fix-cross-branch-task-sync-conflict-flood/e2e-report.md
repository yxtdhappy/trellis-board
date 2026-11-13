# 跨分支任务同步与冲突收敛 E2E 报告

## 结论

2026-11-13 使用用户已重启的服务端与最新便携客户端完成真实环境验证。

- 通过：`main` 检出不会上传明确归属其他分支的任务。
- 通过：`main` 任务可以正常上传，删除后写入墓碑。
- 通过：历史重复 pending 冲突在接口层折叠为每任务一条，响应低于 1 MiB。
- 通过：服务端拒绝空分支和分支不一致的写入，revision、批次、冲突均不变化。
- 通过：目标任务在 Web 页面和任务详情中正常显示。
- 通过：生产库已完成停服备份清理，pending 在清理时 `449 → 2`，重复冲突组 `1 → 0`，旧 taskSpace 保持 `disabled`。
- 说明：清理后并行任务 `task-sync-performance` 产生 1 条新的真实 pending conflict，最终为 3 条，但仍无重复冲突组。
- 通过：47 项任务相关 Node 测试和 Web 生产构建。
- 未验证：桌面会话已解锁，但并行运维线程在打开“待处理 64”前停止了客户端 PID `52168`，桌面 Tauri 任务归属批量确认弹窗未完成点击；跨独立 feature worktree 的正向同步也未单独复测。
- 环境限制：当前机器没有 Rust/Cargo 工具链，未执行 Rust/Tauri 测试。

## 环境与版本生效证据

| 项目 | 证据 |
| --- | --- |
| 服务端进程 | PID `48952`，13:44:20 本地时间启动，命令为 `node apps/server/index.js` |
| 服务端监听 | `0.0.0.0:4317` |
| 服务端启动日志 | `2026-11-13T05:44:20.481Z Trellis Team Board 已启动` |
| 请求日志边界 | 服务端没有逐请求日志；请求结论用 HTTP 响应与数据库 revision、批次、冲突状态交叉验证 |
| 客户端进程 | PID `21840`，13:51:10 本地时间启动 |
| 客户端产物 | `TrellisBoard_0.3.0_x64-portable`，构建时间 13:50:53 |
| 客户端 SHA256 | `a929a0fd6236c94e2d326ce923f58777baf136c48a020ecc06ee07208f49d21e` |
| Agent | `118a1b6e-b1cb-44cb-b877-54e1adef16b5`，`Z0198-YHJ-E` |
| Agent 状态 | `runtime.json` 为 `running`，`lastError=null`，`lastErrorCode=null` |
| main binding | taskSpace `a8d34d0e-54af-4041-bb2c-4507665c7abe`，branch `main`，`syncStatus=approved` |
| 最终监听状态 | binding `is_listening=1`，`last_listener_at=2026-11-13T06:40:58.600Z` |
| 旧 taskSpace | `75984cbd-ed47-4389-bddf-2efbce07f275`，状态 `disabled` |
| 清理后服务端 | PID `37048`，`2026-11-13T07:23:17.448Z` 启动，`/api/health` 返回 `status=ok, mode=team` |
| 清理后重连 | Agent 心跳恢复，binding `is_listening=1`，客户端游标追平到 revision `253` |

## 测试数据策略

- 跨分支负向探针：`.trellis/tasks/11-13-E2E-cross-branch-sync-probe`，branch 为 `E2E/cross-branch-sync-probe-20261113`。
- 主分支正向探针：`.trellis/tasks/11-13-E2E-main-branch-sync-probe`，branch 为 `main`。
- 两个探针均在验证后删除；主分支探针在服务端留下 `deleted=1` 审计墓碑，这是预期行为。
- 服务端边界反例通过 Agent API 提交，未写入真实任务目录。

## 用例结果

### 1. 错分支任务不上传

基线：`main` revision `239`，pending conflict `449` 行，pending 最大创建时间 `2026-11-13T01:01:57.759Z`。

操作：创建 branch 为 `E2E/cross-branch-sync-probe-20261113` 的临时任务，等待 watcher 12 秒。

结果：

- revision 仍为 `239`。
- 探针文件为 `0` 条。
- 新批次为 `0` 条。
- pending conflict 仍为 `449` 行，最大创建时间不变。
- 客户端 `ownershipPending=0`，`deferred=0`，说明明确的其他分支任务不会进入逐任务询问。
- 客户端 baselines 中没有该探针文件。

删除该探针后再等待 10 秒，revision、批次和冲突仍不变。

结论：通过 AC1 和 AC8 中“明确属于其他分支不自动上传”的部分。

### 2. 主分支任务正常上传与删除

基线：revision `239`。

操作：创建 branch 为 `main` 的临时任务，等待 watcher 15 秒。

结果：

- revision 增至 `240`。
- 批次 `8d810760-11cd-420d-a5fa-ddc49f297897`。
- 上传 2 个文件：`task.json`、`probe.md`。
- pending conflict 仍为 `449`，最大创建时间不变。
- 客户端 revision 同步为 `240`，两个探针文件进入 baselines。

删除探针后等待 15 秒：

- revision 增至 `241`。
- 批次 `86cfb06e-4478-4430-b056-a7fb1848d969`。
- 两个文件均更新为 `revision=241, deleted=1`。
- pending conflict 仍为 `449`。

结论：通过主分支正向同步与软删除回归。

### 3. 重启后不再新增重复冲突

历史基线和当前运行：

- 数据库 pending conflict 为 `449` 行，但只覆盖 2 个任务身份。
- 其中一个任务 `desktop-web-shadcn-unification` 有 `448` 行历史重复 pending。
- 服务端在 13:44 重启，客户端在 13:51 重启并完成到 revision `239` 的同步。
- pending 记录最大创建时间仍为 `2026-11-13T01:01:57.759Z`，重启后未新增。
- 客户端 `conflictBlocked` 保留旧冲突 `b756ba9e-70a9-4ab4-94c5-de9a0246739f`。

结论：通过 AC3 的“重启和重复同步不继续新增同任务冲突”。

### 4. 冲突列表响应与详情

Agent API `GET /api/agent/task-spaces/{id}/conflicts`：

- HTTP `200`。
- 响应 `2229` 字节。
- 返回 `2` 条折叠后的 pending 冲突。
- 冲突 ID 稳定为：
  - `b756ba9e-70a9-4ab4-94c5-de9a0246739f`
  - `a833011f-de66-43dc-a0c0-335c314ec916`

目录详情 API `GET /api/agent/task-spaces/{id}/files?taskDir=...`：

- HTTP `200`。
- 响应 `14424` 字节。
- 返回 `4` 个文件。
- 当前 revision 为 `241`。

清理完成后第一次查询：HTTP `200`、`2229` 字节、`2` 条冲突；第二条 dry-run 为
`duplicateConflictGroups=0`、`conflictsToResolve=0`。

随后并行任务 `task-sync-performance` 产生新的真实冲突；最终接口仍为 HTTP `200`、
`2878` 字节、`3` 条冲突，无重复组。

结论：通过 AC4。

### 5. 服务端分支边界

直接向 `main` taskSpace 发起完整任务组写入：

- `task.json.branch=feature/x`：HTTP `409`，错误码 `TASK_OWNERSHIP_MISMATCH`，返回 taskId、taskDir、expectedBranchName=`main`、actualBranchName=`feature/x`。
- `task.json.branch` 为空：HTTP `409`，错误码 `TASK_OWNERSHIP_REQUIRED`，expectedBranchName=`main`。
- 两次拒绝后 revision 仍为 `241`。
- 没有新增探针文件、批次或 pending conflict。

结论：通过 AC9，服务端不依赖客户端过滤即可拒绝错误归属写入。

### 6. Web UI smoke

使用现有账号完成独立浏览器会话登录，不记录密码或 Cookie。

- 初次快照发生在异步项目加载前，页面显示 0 项目；刷新并等待后 `/api/runtime` 返回 `5` 个项目。
- 页面显示 `trellis-board / main` 和目标任务“修复跨分支任务误同步与冲突记录膨胀”。
- 目标任务位于“检查 / 收尾”列，阶段证据为 `9/13`，当前 `spec`。
- 点击目标任务后详情弹窗正常打开，显示 PRD、Design、Implement、实施报告和检查报告。

结论：目标任务页面与详情无白屏、无渲染异常。UI 初次快照时项目列表尚未异步加载；刷新后显示 5 个项目。初次观察到的监听状态为 0，但最终心跳已更新为 `is_listening=1`，实际同步测试也成功，因此不判定为当前任务失败。

## 未验证项

- 桌面 Tauri 的任务归属批量确认弹窗没有完成鼠标级 E2E。桌面已解锁，但并行运维线程主动停止客户端进行数据库清理；Web 页面没有 Tauri IPC，不能安全替代该步骤。
- 未在独立 feature worktree 上激活对应 binding 做 AC2 正向复测。
- 当前机器没有 Rust/Cargo，未执行 Rust/Tauri 测试；“暂不处理”和桌面归属弹窗的 Rust 路径仍缺少本轮实测。

## 生产清理结果

清理工具 dry-run 首次发现：

- pending conflict `449` 行，冲突组 `2`。
- 重复冲突组 `1`，计划标记 `447` 条重复行为 `resolved`。
- `main` 数据文件无需删除，旧 taskSpace 已是 `disabled`。

首次 apply 暴露了清理工具在“旧 taskSpace 已 disabled”时无法幂等清理冲突的问题。
已做最小修复并补充回归测试：

- [task-space-duplicate-cleanup.js](../../../../scripts/task-space-duplicate-cleanup.js) 仅在目标已 disabled、显式要求保持 disabled、且没有待删除重复文件时允许 conflict-only apply。
- [task-space-duplicate-cleanup.test.js](../../../../apps/server/test/task-space-duplicate-cleanup.test.js) 新增幂等清理回归用例。

最终 apply 结果：

- 备份：`C:/Users/yuhaojie/AppData/Local/TrellisBoard/server/backups/board.sqlite.task-space-cleanup.20261113T072149236Z`
- 备份 `quick_check=ok`，备份中 pending `449`、resolved `1329`。
- 现库 `quick_check=ok`，pending `2`、resolved `1776`。
- 旧 taskSpace `75984...`：`disabled`，revision 仍为 `230`。
- `main` taskSpace：`active`，revision/indexed_revision 均为 `253`。
- `main` 活动文件从备份的 `583` 变为现库 `592`，未发生误删。

清理完成后的并行开发又产生一条真实冲突：

- task `task-sync-performance`
- conflict `78b612d4-d116-417a-aac6-f331b7591daf`
- 该冲突属于另一个进行中任务，本轮没有自动解决或覆盖。
- 最终 pending 为 `3`，重复冲突组仍为 `0`。

## 最终状态

- 代码修复在真实环境的核心路径已验证通过。
- 生产历史重复冲突已安全收敛，旧 taskSpace 保持停用，备份可打开。
- 最终 3 条 pending 中，2 条是清理时保留的历史真实冲突，1 条来自并行任务 `task-sync-performance`。
- 47 项 Node 测试全部通过，Web 生产构建通过。
- 任务保持 `in_progress`，剩余阻塞仅为独立 feature worktree、桌面归属弹窗/Rust 路径的验收，以及提交/归档授权。
