# 实时同步 E2E 报告

## 已执行

### 1. 320 任务真实实时投影

- 夹具：`task-live` + 319 个任务，共 320 个任务。
- 操作：通过真实 `/api/agent/live-changes` 提交实时 `task.json`。
- 结果：最终 Board 收敛到实时标题；投影过程中连续请求 `/api/health` 全部返回 200。
- 最终全量测试证据：投影总耗时 13643ms，`healthMax=33ms`，低于 1 秒验收线。
- 单独复跑证据：投影总耗时 3787ms，`healthMax=8ms`（机器负载较低时）。

### 2. 两个真实 Agent 同步

- 两个独立 `AgentLiveSync` 使用真实 HTTP、SSE 和文件 watcher。
- 连续修改同一任务 20 次，服务端 Board 与另一客户端本地文件均收敛到每次最新标题。
- 最终全量测试：P95=2928ms、max=3018ms，低于 3 秒验收线。

### 3. Git 收敛与真实编辑

- Git 工作区写回与 HEAD 一致时不产生 preflight、upload 或责任人控制事件。
- 随后写真实未提交内容时正常产生 preflight/upload。
- pending 已收敛时自动清理；Git 状态不可判断时保留 pending 并继续展示。

### 4. 服务和并发

- deferred 首轮物化期间，后续 revision 合并为最新快照；首轮旧结果被丢弃。
- 首轮投影失败时 revision 不回退、上一份 Board 保留，并在退避后自动重试成功。
- 幂等重放不会重复物化。

## 未执行

- 当前机器没有 Cargo/Rust 工具链，未构建或启动 Tauri 客户端，因此未执行 Windows WebView2
  真机操作。
- 以下交互仍待真机 E2E：首次自动聚焦、系统 X/稍后处理、关闭后新事件不抢焦点、托盘“处理实时确认”、
  Board 服务离线关闭窗口、服务恢复后完成取消/继续/接管。
- PRD 中的 Windows 实机验收项保持未勾选，不能以源码静态断言替代。
