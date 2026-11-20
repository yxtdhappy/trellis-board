# acp-dispatch

把 Trellis 任务下发给本机 Agent CLI（ACP 协议），在面板查看运行记录、继续对话与取消。

## 零配置

- `plugin.json` 的 `config` 为空；未显式配置 `command` 时按 `PATH` / `PATHEXT` 自动探测
  `opencode`、`codex`、`claude` 等可执行文件，探测结果显示在 `GET /status` 的 `command` 字段。
- `cwd` 缺省取任务所属项目路径（桌面端来自 `trellis.projects` 的关联项目），无需手工填写本机绝对路径。
- 高级参数（超时、并发、权限策略、提示词模板）仍可在 `config` 中覆盖。
