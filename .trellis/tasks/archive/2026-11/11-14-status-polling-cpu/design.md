# 按 CPU 热点优化状态刷新设计

## 1. 架构边界

本任务把状态获取分成两类：

- 高成本刷新：每次调用包含网络、JSON 解析、Git/文件系统访问、跨进程 IPC 或高频唤醒。
- 低成本刷新：只读取进程内布尔值、小规模 SQLite 查询，且只在特定页面运行时发生。

事件驱动只用于第一类。第二类保持现状，除非实测证明其 CPU 占比明显。

## 2. 候选路径判定

| 路径 | 当前频率 | 主要成本 | 初始决策 |
| --- | --- | --- | --- |
| `list_local_associations` | 3 秒 | Tauri IPC、配置/cursor、ownership、潜在 Git/任务目录访问 | 第一优先，事件化 + 10 秒可见兜底 |
| `live_control_pending` | 750 毫秒 | 高频唤醒、跨进程调用 | 第二优先，事件化 + 10 秒可见兜底 |
| `/api/team/status` | 3 秒 | 网络、完整 JSON、ETag、React 更新 | ETag + 10 秒可见兜底；仍为热点再事件化 |
| 任务操作列表 | Team 模式下始终创建 3 秒定时器；具体 taskSpace 才请求 | 网络、SQLite、空数组重复状态更新 | 只做定时器条件和相等保护，不强制事件化 |
| 创建/改派操作详情 | 约 0.7/1.4/2.8/4 秒，最长 4 秒 | 异步 Agent 命令状态查询 | 终态停止；不强制改 SSE |
| `desktop_sidecar_status` | 3 秒 | 进程内状态读取 | 附带 `sidecar` 事件 + 10 秒可见兜底 |
| 插件列表 | 5 秒，仅插件页 | 网络和管理接口 | 保留 |
| 接入推送检查 | 5 秒，仅对话框 | 本地 Git 检查 | 保留，focus/手工检查已有恢复路径 |

“初始决策”不是预设结论。每项必须通过 R1 的修复前后测量才能进入最终交付。

### 2.1 协议与后台周期任务

以下任务是连接存活、失败恢复或维护机制，不进入 SSE 状态化范围：

- Agent 心跳 15 秒及失败后的 1-60 秒退避。
- Agent SSE 断线重连 1-60 秒退避。
- Agent 暂停时 1 秒状态等待。
- Board SSE、Agent SSE 和插件事件 SSE 的 15 秒心跳。
- Agent SSE 心跳中每 15 秒执行的待命令补偿和过期租约检查。
- 插件 30 秒健康检查、插件自定义定时器。
- Team 数据库每 24 小时快照备份。
- Python 安装期间 5 秒进度心跳。

保留原因：这些周期任务频率低、职责是可靠性和运维；改成事件会增加漏恢复、进程退出和跨进程
状态同步风险，却不解决当前客户端空闲 CPU 的主要来源。

## 3. 本地关联事件

### 3.1 事件契约

统一使用一个 Tauri 事件：

```text
desktop-state-changed
payload: { topics: ["associations", "sidecar"] }
```

- `associations`：binding、cursor、deferred、ownership pending/paused 或本地 Git HEAD 投影发生变化。
- `sidecar`：Agent start/stop/pause 状态变化。
- 同一短时间窗口内的多个主题合并为一个事件，避免批量任务变化触发事件风暴。

### 3.2 发射点

- `TaskSync::write_cursor` 和 `remove_task_cursor` 只有在文件或内存状态实际变化后发射。
- `set_bindings`、`update_bindings` 完成实际变化后发射。
- watcher 发现任务目录变化、Git HEAD/ref/index 变化并完成 ownership 投影失效后发射。
- Agent start、stop、pause、resume 后发射 `sidecar` 主题。
- Tauri 命令完成 attach、detach、补同步和 ownership 变更后，如果底层没有发射事件，则补一次
  `associations` 通知。

### 3.3 前端消费

- `ProjectRail` 先注册监听，再执行首次读取。
- 收到 `associations` 后调用 `list_local_associations`。
- 收到 `sidecar` 后调用 `desktop_sidecar_status`。
- 如果已有请求在途，只记录一个 pending refresh；当前请求完成后最多再执行一次。
- 用稳定签名比较新结果；内容完全相同时不创建新 Map/数组，也不更新父组件状态。
- 页面可见时保留 10 秒兜底；页面隐藏时清除 timer，恢复可见或窗口聚焦时立即刷新一次。

## 4. 控制窗口事件

- `ControlHub` 的 push、替换、dismiss、resume 和清空操作后发射 `live-control-changed`。
- `ControlApp` 先注册监听，再读取一次 `live_control_pending`。
- 收到事件后重新读取权威队列状态，再使用现有 JSON 签名阻止相同内容的重复渲染。
- 监听注册前的事件由首次读取补齐；窗口重建后重新执行同一流程。
- 可见窗口保留 10 秒兜底；隐藏窗口停止定时器，恢复显示时立即刷新。

## 5. 任务操作状态

创建和改派是正确的异步 Agent 命令流程，不需要通过轮询保证业务正确性。当前详情查询只负责显示
`pending/delivered/running` 进度和失败原因。

- `pending/delivered/running` 继续使用现有退避查询。
- `succeeded/cancelled` 立即停止。
- `failed` 读取到一次可靠终态后停止自动查询；保留操作对象以支持用户点击重试。
- 用户重试失败操作后，operation 回到 `pending`，查询重新开始。
- 操作列表定时器只在选中具体 taskSpace 时创建；结果签名未变化时不更新 React 状态。

这些是无协议变更的 CPU 和稳定性修正，不要求新增 `task.operations.changed` SSE。若后续测量证明
团队操作是显著热点，再单独评估事件化。

## 6. Team 状态条件请求与事件（事件为条件项）

无论 A/B 结果，`/api/team/status` 都必须先改为 ETag 条件请求和 10 秒可见兜底。
只有基线证明该路径仍是显著热点时，才实施以下事件。

- Board SSE 增加 `team.status.changed` 事件；payload 只包含 `generatedAt`，不传输项目正文。
- 事件源覆盖 listener/agent 在线状态、binding 状态、taskSpace/project 可见性和 pending assignment 数变化。
- 同一短窗口内合并事件。
- 前端收到事件后使用上次 ETag 发起一次条件请求。
- `304` 时保持原引用，不调用 `setTeamStatus`。
- 无事件期间不请求；焦点、可见性和 SSE 重连仍执行一次条件请求。

服务端不能因为 Agent 每次心跳都无条件通知浏览器。只有可见状态投影发生变化时才发射；
在线状态过期必须通过一次性的到期事件或等价机制补齐，不能要求浏览器轮询。

如果 A/B 测量未证明 Team 状态是显著热点，则本轮不新增任何服务端 SSE 类型，只保留
10 秒可见条件轮询并记录测量结论。

## 7. 稳定性设计

### 7.1 事件丢失恢复

```text
注册事件监听
  -> 读取一次权威状态
  -> 正常期间只依赖事件
  -> focus / visible / reconnect / listener resume
  -> 再读取一次权威状态
```

顺序固定为先监听后读取，避免读取完成到监听注册之间出现空窗。

### 7.2 请求竞态

- 每个状态路径维护单调请求序号。
- 只有最新请求可以提交状态。
- 事件到达时如有请求在途，只设置一次 pending refresh。
- 刷新结果不变时保留旧引用，避免 React 重渲染。

### 7.3 独立性

本地关联、控制窗口和 Team 状态分别可回退：

- 本地关联回退：恢复 ProjectRail 10 秒可见读取。
- 控制窗口回退：恢复可见时 10 秒读取。
- Team 状态回退：恢复 10 秒可见条件请求。

单个回退不得影响其他路径或任务同步。

## 8. 测试与测量

### 8.1 自动化

- Rust：cursor/binding 状态未变化时不发射；实际变化时只发射合并后的主题。
- 前端：初始读取、事件刷新、请求在途合并、相同结果不更新状态的纯逻辑测试。
- 服务端：Team 状态事件只在投影变化时发射，SSE 重连仍有一次性对齐。
- 回归：现有任务同步、ownership、deferred、冲突和 branch gate 测试。

### 8.2 真实客户端 A/B

对每个候选路径：

1. 记录 30 秒或更长空闲基线中的进程树 CPU、P95、峰值和请求次数。
2. 只替换该路径后重新采样。
3. CPU 无明显改善或稳定性下降时回退该路径。
4. 所有保留路径组合后再做最终 30 秒/10 分钟空闲采样和一次真实状态变更验收。

## 9. 风险与回滚

- 最大风险是为了追求“零轮询”而增加漏事件、启动竞态和跨进程复杂度。
- 允许远端状态在漏事件时最多约 10 秒后由兜底刷新发现。
- 通过“先监听后读取”、focus/visibility/reconnect 对齐、请求合并和逐路径回退控制。
- 不改变任务数据契约，因此失败时只需恢复该路径原轮询，不需要迁移数据。
