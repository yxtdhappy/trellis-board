# 新增项目同步状态排查检查报告

## 检查结论

本次没有修改 sidecar 生产逻辑。现有 `AgentTaskSnapshotSync` 已满足“保持 binding 自身状态并继续
后台拉取”的契约；新增回归能够锁定该行为，并能为后续桌面重建排查提供证据。前端跨项目状态隔离由
前序任务覆盖，本次没有回退该修复。

## 复核修正

- 回归测试的期望状态改为在 `start()` 前固化。若实现原地把所有 binding 改成 `syncing`，原写法会
  连期望值一起改掉而产生假通过；修正后断言能够真实捕获该回归。

## 自动验证

| 检查 | 结果 |
| --- | --- |
| 定向回归 `agent/test/task-snapshot-sync.test.js` | 1/1 通过 |
| `task-snapshot-sync.test.js` 全文件 | 29/29 通过 |
| 完整 Agent 测试 `node --test "agent/test/*.test.js"` | 64/64 通过 |
| ACP 插件单独复跑 | 22/22 通过 |
| 全量 `npm test` | 488 通过、12 跳过、4 失败 |
| 本次文件 `oxfmt --check` | 通过 |
| `git diff --check` | 通过 |

全量失败均为未修改的 `plugins/acp-dispatch/test/index.test.js`：两个临时目录 `EPERM` 清理失败和
两个等待运行结束超时。该文件在无并发负载下单独复跑 22/22 通过；失败与本次 Agent 测试、PRD 和
桌面打包规范修改无调用关系。

## 规范同步

- 已在 `desktop-sidecar-packaging.md` 记录启动恢复状态保持和后台拉取契约。
- 已记录 Web Board 修复后必须重建客户端或重新登录/重启，不能用服务端静态资源更新替代 WebView
  实机验收。

## 剩余验收

- GitHub Windows 工作流构建结果。
- 新安装客户端上的 WebView2 实机复核。
