# 跨分支任务同步隔离 E2E 设计

## 1. 测试拓扑

| 层 | 本轮实例 | 用途 |
| --- | --- | --- |
| 真实页面 | 已安装 Tauri + `http://192.168.65.27:4317` | 验证 ProjectRail 分支级状态 |
| 隔离 Team 服务 | 当前源码，临时数据目录，随机本机端口 | 验证真实 HTTP、SSE、SQLite 与 Agent |
| 请求代理 | `wit-e2e-testing/scripts/local-gateway-proxy.mjs` | 记录 Agent 请求、状态、耗时和 request id |
| 隔离 Agent | 当前源码 `agent/cli.js run`，独立 `TRELLIS_AGENT_ROOT` | 验证 watcher、pending、cursor 和恢复 |
| Git 仓库 | 临时 bare origin + working clone | `main` 与 `feature/e2e-branch` 对照 |

真实 4317 只用于重启、健康检查和桌面页面操作。同步写入全部落在隔离服务与临时仓库，避免影响
现有历史双绑定和任务数据。

## 2. 数据与身份

- 隔离 Team 初始化一个临时系统管理员和一个临时团队，登录密码只存在于进程内，不写入报告。
- 通过 `/api/team/pairing-codes` 与 `/api/agent/enroll` 创建一次性测试 Agent。
- 临时仓库有 `origin` file remote；隔离服务显式允许 local Git remote。
- `attachProject()` 使用真实服务端 attach 和 ConfigStore，不在测试脚本中伪造 binding。
- 每次 Git 操作前记录 HEAD、分支和任务目录哈希；测试只操作 `os.tmpdir()` 下的仓库。

## 3. 执行序列

1. `main` 写入并提交探针任务，关联 main taskSpace，启动 Agent。
2. 修改探针任务，等待上传；通过代理日志、HTTP revision、任务索引和 Agent 状态确认。
3. 切到 feature，写入 feature-only 任务，触发 watcher；确认服务端无新任务、revision 与 cursor 不变。
4. 直接以 Agent 凭据向 main taskSpace 注入 server-only 任务；等待 SSE 后确认本地没有写入。
5. 切回 main，等待 Branch recovery pull；确认 server-only 任务落盘、状态恢复。
6. 切到 feature，调用真实 `attachProject()` 替换同仓库 binding；重启 Agent 并确认只同步 feature。
7. 发送缺失/错误 `observedBranchName` 请求，验证 HTTP 第二道防线。
8. 生成验收报告并删除临时进程、目录和数据库。

## 4. 证据规则

- 每一步先记录日志偏移，再执行一次动作，最后读取增量。
- 正向同步：代理 `status=2xx`、服务端 revision/索引变化、Agent 状态 `ready` 或 `syncing` 为证据。
- 反向同步：代理无上传请求或服务端拒绝、revision/cursor 不变、Agent 日志含业务错误码为证据。
- 桌面操作：截图记录最终语义，同时读取该时间窗内服务器日志和桌面日志；只有截图不算通过。
- 数据库直查只用于补充证明，不替代 HTTP、日志和页面三层证据。

## 5. 清理与回滚

- 测试 Agent、隔离服务、代理均使用独立 PID；结束按代理、Agent、服务顺序停止。
- 临时目录使用 `mktemp` 语义创建，确认路径位于系统临时目录后再递归删除。
- 真实 4317 重启前记录原 PID、启动时间和日志偏移；若新进程健康失败，恢复原启动命令并报告失败。
- 不修改现有 Agent 配置、DPAPI 凭证、真实数据库或 Git 工作仓库。
