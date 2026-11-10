# 技术设计：实时同步阻塞主线程与误弹窗

## 1. 范围与边界

本任务保持为单个 Trellis 任务。四个问题属于同一条实时同步链路，拆分会产生共享的待确认状态、批次过滤和 E2E 依赖，收益低于集成成本。

本次修改边界：

- `agent/`：过滤 Git 已收敛的工作区写入，纠正超时错误。
- `server/team/`：把实时覆盖层重投影移出 HTTP 主线程，按项目串行和合并。
- `desktop/`：控制窗口去重、首次提示、关闭后静默、托盘恢复。
- `tests/`：覆盖过滤、合并、主线程响应和桌面控制状态。

不改变现有实时 API、SQLite 表、责任人确认语义、审计规则和安全边界。

## 2. 根因与要消除的不变量

当前有两个直接缺陷：

1. `_handleWatcherEvents()` 信任所有 watcher 事件。Git merge/checkout 即使最终工作区与 HEAD 一致，也会被当作未提交编辑。
2. `applyChanges()` 在 Node 主线程同步执行全项目物化、扫描和索引重建。主线程阻塞期间，`/api/health` 和 Agent 请求无法被处理。

目标不变量：

- 只有相对当前 Git HEAD 仍 dirty 的 `.trellis` 路径可以进入实时上传和责任确认。
- 实时 revision 提交后必须快速返回，不在 HTTP 请求栈内扫描整个项目。
- 同一项目同一时刻最多执行一个重投影；期间到达的新 revision 合并为下一次最新快照。
- 重投影的旧结果不能覆盖更新 revision。
- 用户关闭控制窗口只影响可见性和焦点，不删除 pending 文件，也不绕过确认。

## 3. Agent：Git 已收敛过滤

### 3.1 复用现有 dirty 路径计算

复用 `AgentLiveSync._dirtyLivePaths(binding)`：

- `git diff --name-only -z HEAD -- .trellis`
- `git ls-files --others --exclude-standard -z -- .trellis`
- 存在 `.trellis/.developer` 时继续纳入

新增任务级辅助逻辑，不对每个文件重复启动 Git：

- watcher 批次按项目只计算一次 dirty 集合。
- 输入路径转换为 `/` 分隔后与 dirty 集合求交。
- 交集为空时不读取文件、不创建 pending、不上传。
- 真实未提交修改仍在 dirty 集合内，现有责任人确认保持不变。

Git 命令失败时保留现有 pending 并记录带上下文的 warning；不得把“无法判断”静默解释成“已收敛”。下一次 watcher/retry 再判断。

### 3.2 清理旧 pending

`_emitPendingDecisions()` 与 `_retryPendingUploads()` 在展示或上传前检查 pending 文件路径是否仍 dirty：

- `decision` 和 `upload` 的全部路径都已收敛到 HEAD：删除 pending 文件，不展示、不上传。
- 至少一个路径仍 dirty：保留现有批次语义。
- 判断 Git 状态失败：保留 pending，等待下一轮。

这同时处理升级前已经落盘、由 Git merge 产生的旧警告。

### 3.3 超时错误

`AgentApiClient` 的请求计时器不再生成 `AbortError` 表示超时：

- 显式取消继续生成 `AbortError`，文案保持“请求已取消”。
- 计时器生成独立 `TimeoutError`。
- `mapNetworkError()` 将超时映射为 `NETWORK_ERROR: Agent 服务请求超时`，保留 `retryable=true` 和 cause。

不新增协议版本，不改变 HTTP API。

## 4. 服务端：异步实时重投影

### 4.1 Worker 能力

扩展现有团队 `scan-worker`，新增消息 `live-materialize`：

输入：

- 项目基础信息，包括 Git 工作副本路径。
- 当前 `project_live_file` 快照。

Worker 内执行：

1. 在系统临时目录创建项目根。
2. 只复制 `.trellis/tasks`、`.trellis/workspace` 和存在的 `.trellis/.developer`。
3. 按实时覆盖行写入临时树。
4. 使用 `scanRepository(tempProject, { includeContent: true, metadataRepoPath })` 扫描。
5. 计算任务版本摘要。
6. 在 `finally` 中递归删除临时树。
7. 返回 `scan` 和输入 revision。

路径越界、符号链接和临时删除失败继续按现有安全约束处理；临时树永远不位于业务工作区。

### 4.2 项目级重投影队列

`createLiveSyncService()` 内维护每个项目一份轻量状态：

```text
{
  running,
  requestedRevision,
  retryAttempt,
  pendingNotifications
}
```

调度规则：

- `scheduleProjectProjection(projectId)` 只记录当前 `project_live_revision`，立即返回。
- 每项目最多一个在途 worker 请求。
- 在途期间的新 revision 只更新 `requestedRevision`，不追加并行扫描。
- Worker 返回后，如果项目当前 revision 已变化，丢弃该结果并继续扫描最新快照。
- 只有 revision 仍为最新时才执行 `buildBoard()` 和 `replaceProjectIndex({ skipLiveHook: true })`。
- 成功后替换 `liveBoards` / `liveDetails`，更新 `team_task_index.live_revision`，再发布 `live.changed`。
- 失败时保留上一份一致投影和已提交 revision，记录诊断并按 1s、2s、4s、最大 30s 退避重试；新的实时批次或项目刷新也会立即重新调度。

### 4.3 调用点调整

- `applyChanges()`：事务提交后调度重投影并返回 revision；不再同步调用 `reapplyProject()`。
- 幂等重放：仅在没有可用实时 Board 时调度。
- 接管：提交接管覆盖行后调度。
- `onProjectIndexed()`：Git 索引完成后仍有 live 覆盖行时调度；抑制本次旧的 live event，等待重投影成功后发布。
- `ensureProject()`：返回已有投影；没有投影时调度并返回 Git Board，不在请求线程扫描。
- 服务关闭时由 `taskIndex.close()` 终止 worker；未完成 Promise 被拒绝，调用方记录并停止重试。

### 4.4 为什么不上异步 `setImmediate` 或线程池 fs

- 只把同步扫描延后到下一轮事件循环，仍会阻塞 13-19 秒，不能解决健康检查超时。
- Node `fs` 线程池化不能覆盖 `scanRepository()` 的 CPU 和大量同步逻辑。
- 现有 Worker 已承担长扫描，扩展其协议复用现有 180 秒超时、错误传播和关闭生命周期。

## 5. 服务端主线程剩余工作

Worker 返回后主线程仍需执行：

- `taskIndex.buildBoard(scan)`
- `taskIndex.replaceProjectIndex(...)`
- 小型 SQLite 更新和事件发布

这些工作与任务数相关，但只处理内存结果和索引行，不复制整个项目、不扫描证据正文。验收要求其与 Worker 调度叠加时 `/api/health` 最大响应时间不超过 1 秒。

若基准发现 `buildBoard()` 或索引替换仍接近阈值，再把纯投影计算拆入同一 Worker；本任务不预先扩大改造。

## 6. 桌面控制窗口

### 6.1 状态模型

`SidecarState` 增加：

- `auto_focus_consumed: AtomicBool`
- `focus_suppressed: AtomicBool`

行为：

- 客户端进程启动后，第一次有待确认事件时允许 `show + set_focus` 一次。
- `auto_focus_consumed` 一旦为 true，后续事件即使窗口已隐藏也不自动展示或聚焦。
- 用户关闭窗口或选择“稍后处理”时设置 `focus_suppressed=true`，窗口 hide，pending 保留。
- 托盘“处理实时确认”主动调用 `show_pending_control()`，此时允许显示和聚焦。
- `pop_control()` 不再因为队列仍有下一项而强制展示窗口。

### 6.2 去重

每个控制事件生成稳定 key：

- `assignment_warning`：`projectId + taskKey + assignee`
- `remote_overwrite`：`backupId`
- `assignment_overridden`：`taskKey + revision`

入队时如果同 key 已存在，用新事件原位替换；否则追加。这样同一任务连续 watcher 批次只保留最新待确认项，窗口最多 32 项的上限继续保留。

### 6.3 关闭与执行解耦

- 责任人确认窗口新增“稍后处理”；该动作只 hide，不等待服务端。
- 继续、接管、取消动作仍可阻塞等待服务端，但窗口的系统关闭按钮和“稍后处理”始终可用。
- 已执行的命令完成后如果成功，main command 继续调用 `clear_control()` 移除对应 pending。
- 命令失败时 pending 保留，窗口已经隐藏也不影响用户当前工作。
- 托盘菜单新增“处理实时确认”，无 pending 时点击无副作用。

### 6.4 窗口关闭事件

主窗口全局 `CloseRequested` 处理增加窗口标签判断：

- `live-control`：设置 focus suppressed 后 hide。
- `main`：沿用现有 hide。

因此点击系统 X、Alt+F4 或“稍后处理”都不会删除责任人确认。

## 7. 兼容性与数据迁移

- SQLite schema 不变。
- 实时 HTTP/SSE 字段保持兼容；`live.changed` 可能比写入响应更晚到达，但 Board 已采用事件后重查。
- 未升级客户端仍会上传 Git 已收敛批次；新服务端继续正常处理，因此兼容但不消除其误弹窗。
- 未升级服务端遇到新客户端仍按原协议工作。
- 旧 pending 文件无需迁移；新 Agent 在启动和重试时自动清理已收敛项。
- 与 `11-10-team-sync-line-ending-normalization` 的兼容要求：dirty 判断必须使用 Git 语义，不能自行忽略 CRLF；换行规范仍由该任务负责。

## 8. 失败与回滚

- Agent dirty 检查失败：不会误删 pending，项目进入 error 重试状态。
- 重投影失败：实时 revision 已持久化，但 Board 继续显示上一份一致投影，并自动退避重试。
- Worker 崩溃：现有 task index worker 重启机制负责下一次请求；本次失败不发布 `live.changed`。
- 桌面状态仅内存保存；客户端重启后允许再次进行首次提示，pending 文件仍是权威恢复来源。
- 回滚可按三层独立进行：Agent 过滤、服务端 Worker、桌面控制窗口；不涉及数据库回滚。

## 9. 验证策略

### Agent

- Git HEAD 相同的 merge/checkout 写回不产生 upload/control。
- 真实未提交修改仍产生 upload 并触发责任人确认。
- 已收敛 pending decision/upload 被删除；Git 检查失败时保留。
- 超时文案与显式取消可区分。

### 服务端

- `applyChanges()` 在注入的延迟 live scanner 完成前已返回。
- 扫描阻塞期间 `/api/health` 仍返回 200 且最大延迟 <1 秒。
- 同项目连续 revision 只按最新 revision 投影，旧结果不覆盖。
- 投影失败保留 revision、上一份 Board，并自动重试。
- 实时任务、workspace 变化和 Git 收敛现有测试全部通过。

### 桌面

- 首次事件获得一次焦点。
- 关闭后新事件不入前台；托盘入口可重新打开。
- 同任务重复 warning 只保留一个。
- 服务端不可达时窗口可立即关闭，pending 文件仍存在。
- 系统 X 与“稍后处理”行为一致。

### 真实 E2E

- Windows 上对 300+ 任务项目制造实时修改，操作期间连续访问 `/api/health`。
- Git merge 不误弹。
- 停掉 Board 服务后关闭确认窗口，重启服务后从托盘恢复并完成三个动作之一。
