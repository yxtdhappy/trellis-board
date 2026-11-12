# 项目接入 Agent 列表与搜索实施报告

## 实现

- `ProjectOnboardingDialog.tsx` 删除前端固定 Agent 子集，改为直接读取
  `shared/trellis-agent-tools.js` 的 `TRELLIS_AGENT_TOOLS`，当前展示 22 项。
- “本机编码 Agent”区域增加搜索框，按显示名称或工具 ID 做 trim、大小写不敏感包含匹配。
- 搜索只过滤可见列表，不清空 `selectedTools`；无匹配时显示“没有匹配的 Agent”。
- Agent 列表使用独立纵向滚动区域；弹窗显式把初始焦点放在顶部标题，避免长正文打开时自动滚到底部。
- 未修改服务端、共享 Agent 目录、API 或初始化命令。

## 验证

- `node --test tests/trellis-agent-tools.test.js`：4/4 通过。
- `npm --prefix web run lint`：通过，仅仓库既有 warning。
- `npm --prefix web run build`：TypeScript 与 Vite 构建通过，仅既有大 chunk warning。
- `npx oxfmt --check`、`git diff --check`：通过。

## 未完成

- 未提交、未推送、未归档任务。
- 未执行真实 `initialize_pending_project`，避免对真实仓库或绑定产生副作用。
