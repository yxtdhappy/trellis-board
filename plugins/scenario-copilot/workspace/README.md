# scenario-copilot 运行目录

该目录由客户端插件在本地使用，默认位置是这里；也可以通过插件配置 `workspaceDir` 指向外部目录。

## 内容

- `scripts/`：scenario-copilot 生成的 Playwright spec、`playwright.config.ts`、认证状态文件
- `runs/`：生成阶段保存的 outline/snapshot/steps
- `test-results/`：截图、trace 与执行结果
- `run-*.json`：单次运行日志

`scripts/` 下的 spec 是**生成物**，文件名带任务号、时间与版本，不应提交到仓库。需要回归时由 scenario-copilot 重新生成；确认要长期保留的用例应整理到独立测试目录，而不是直接提交运行目录。

`.auth-state-*.json` 含登录 cookie，`runs/`、`test-results/` 可能含真实业务数据，均由本目录的 `.gitignore` 排除。
