# 插件页 Playwright 验收

- 日期：2026-11-05
- 环境：standalone 服务 `http://127.0.0.1:4317/`，Node `v24.22.2`，Chromium，视口 1440x1080。
- 数据：`data/plugins.json` 已启用 `a2a-intake`、`acp-dispatch`。

## 步骤

1. 打开 `http://127.0.0.1:4317/`，等待首页加载。
2. 点击左侧「插件」导航，等待 `.plugin-card` 渲染。
3. 读取卡片的 id、状态、版本、apiVersion、pid、rootPaths。
4. 点击 `acp-dispatch` 卡片的「日志」，等待 `#plugin-logs` 弹窗内容；确认返回 2 行启动日志。
5. 关闭弹窗，截图插件卡片区域到 `tests/artifacts/plugin-ui.png`。

## 结果

- 卡片：`a2a-intake`、`acp-dispatch`，均显示「运行中」，`v1.0.0`，`api 1`，有 pid。
- 日志：2 行，包含「启动插件进程」与「acp-dispatch 已启动」；日志含本机路径，因此不纳入截图。
- 截图：`tests/artifacts/plugin-ui.png`（1440x1080，仅插件卡片）。

## 备注

- `/api/runtime` 返回 404 是 standalone 模式的预期回退，不影响插件页。
- 本次只读验证，未点击「停止」，避免中断正在运行的插件。
