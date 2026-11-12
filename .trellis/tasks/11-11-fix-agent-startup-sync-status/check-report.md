# 新增项目同步状态排查检查报告

## 检查结论

现有 `AgentTaskSnapshotSync` 已满足“保持 binding 自身状态并继续后台拉取”的契约；新增回归能够
锁定该行为。前端跨项目状态隔离由前序任务覆盖，本次没有回退该修复。实机继续操作后另外发现
Tauri 与 sidecar 的 live CLI 参数名不一致，已做同任务范围内的最小生产修复。

## 复核修正

- 回归测试的期望状态改为在 `start()` 前固化。若实现原地把所有 binding 改成 `syncing`，原写法会
  连期望值一起改掉而产生假通过；修正后断言能够真实捕获该回归。
- `live-decide`、`live-diff`、`live-initial` 的注册键与读取键统一为 `task-space`，与 Tauri
  实际调用及 usage 一致；不把 `taskSpace` camelCase 暴露为命令行参数。
- 参数回归使用临时 `TRELLIS_AGENT_ROOT` 执行三条真实 sidecar CLI。命令必须到达
  `CONFIG_MISSING`，证明已越过选项解析；同时显式排除“未知参数 --task-space”。

## 自动验证

| 检查 | 结果 |
| --- | --- |
| 定向回归 `agent/test/task-snapshot-sync.test.js` | 1/1 通过 |
| `tests/desktop-package.test.js` | 15/15 通过 |
| `task-snapshot-sync.test.js` 全文件 | 29/29 通过 |
| 完整 Agent 测试 `node --test "agent/test/*.test.js"` | 64/64 通过 |
| `a2a-intake` 插件单独复跑 | 13/13 通过 |
| 全量 `npm test` | 503 通过、12 跳过、1 失败 |
| 本次文件 `oxfmt --check` | 通过 |
| `git diff --check` | 通过 |

全量失败是未修改的 `plugins/a2a-intake/test/index.test.js` 临时目录 `EPERM` 清理错误。该文件在
无并发负载下单独复跑 13/13 通过；失败与本次 Agent 测试、PRD 和桌面打包规范修改无调用关系。

## 规范同步

- 已在 `desktop-sidecar-packaging.md` 记录启动恢复状态保持、后台拉取和 `--task-space` CLI 参数
  契约，并加入错误/正确示例。
- 已记录 Web Board 修复后必须重建客户端或重新登录/重启，不能用服务端静态资源更新替代 WebView
  实机验收。

## 桌面验收

- GitHub Windows run `43052058709` 的 `node-tests` 与 `desktop-build` 均为 `success`。
- 新安装客户端已通过真实 WebView2 复核。新增 `mdp-management-web` binding 处于 `syncing`
  等待首次任务差异确认时，四个旧 binding 仍是 `ready`，项目栏没有发生跨项目状态污染。
- 上述安装包早于参数修复；点击“仅同步无冲突项”后返回“未知参数 --task-space”。自动回归已修复，
  但新 sidecar 构建安装后的真实点击仍待执行，不能把该 E2E 记为通过。
