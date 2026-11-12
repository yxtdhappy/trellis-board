# 安装客户端同步状态隔离 E2E 报告

## 测试产物

- GitHub Windows run：`43052058709`，commit `12c62c5`，`node-tests` 与 `desktop-build` 均成功。
- NSIS 安装包：`C:\Users\yuhaojie\AppData\Local\Trellis Board_0.2.0_x64-setup.exe`。
- 安装目录：`C:\Users\yuhaojie\AppData\Local\Trellis Board`。
- 安装后客户端 SHA256：`69E8BCA6FEB3277BAB714A370FFA6DE9BF2A9DD6E3CE9D57D36B21421F3DFCB2`。
- 安装后 sidecar SHA256：`DDE0FBE56607E05D0780D914F2087D5C598A13718BE45F7C7C5834D82120D410`。

## 测试步骤

1. 通过 NSIS 包覆盖安装客户端和 sidecar，现有四份 binding 与服务端地址均保留。
2. 启动新客户端并完成真实账号登录，sidecar 进程正常运行。
3. 初始项目栏确认四个既有项目均为“已关联 · 同步正常”。
4. 选择干净仓库 `D:\wit\mdp-management-web`，分支 `release/3.0.0/dev`，接入大数据团队。
5. 预检确认服务端尚无该分支任务快照；点击“接入并检查异常任务”创建真实新 binding/taskSpace。
6. sidecar 于 07:25:01 重启；约 7.65 秒后首次采样到新项目同步中。

## 关键证据

| 项目 | 配置状态 | WebView 文案 |
| --- | --- | --- |
| `trellis-board` | `ready` | 已关联 · 同步正常 |
| `mdp-backend-service` | `ready` | 已关联 · 同步正常 |
| `mdp-backend-web` | `ready` | 已关联 · 同步正常 |
| `mdp-report-service` | `ready` | 已关联 · 同步正常 |
| `mdp-management-web` | `syncing` | 已关联 · 正在同步已有任务 |

首次同步确认窗口返回新 taskSpace `9269f774-5cd1-40e9-b3f0-4a5dc998b8b2`，并提示本地任务差异
需要确认；“稍后处理”关闭窗口后，上述五项状态保持不变。

截图：`C:\Users\yuhaojie\AppData\Local\Temp\trellis-board-sync-mixed.png`。

## 结论

已安装的新客户端中，新增项目处于 `syncing` 时其他项目仍保持各自 `ready`，项目栏没有再次出现
“所有项目同时正在同步”。原跨项目状态污染问题在新 WebView bundle 中已修复。

## 后续操作发现

- 在同一安装客户端点击“仅同步无冲突项”后，界面返回“未知参数 --task-space”，首次安全同步未完成。
- 根因是 Tauri 传 `--task-space`，而 `live-decide`、`live-diff`、`live-initial` 注册成
  camelCase `taskSpace`；该安装包不包含后续参数修复。
- 自动化回归已覆盖三条命令并全部通过，但 Node 测试不能替代新 sidecar 与 WebView 的真实点击。
- 待重新构建和安装包含参数修复的客户端后，必须继续验证：不再出现 CLI 参数错误，
  `mdp-management-web` 最终为 `ready` 且 `initialSyncCompleted=true`，其他四个项目仍为 `ready`。

## 当前保留状态

- `mdp-management-web` binding 已保留在客户端中，首次任务差异选择了“稍后处理”，因此该新项目继续
  显示 `syncing` 属于等待人工确认，不是同步状态泄漏或异常。
- 后续需要用包含参数修复的新客户端完成“仅同步无冲突项”实机复测；在此之前 PRD 最后一项保持
  未勾选。
