# 项目接入 Agent 列表与搜索检查报告

## 检查结论

- 接入弹窗只保留一份 Agent 目录来源，共享目录与前端不再漂移。
- 搜索条件覆盖 label 和 id；过滤不改写选择状态，已存在项仍由统一逻辑禁用。
- 长列表位于独立滚动容器；补充 `initialFocus` 后，弹窗打开不再因正文较长而默认聚焦底部。
- 最终业务改动只涉及 `ProjectOnboardingDialog.tsx`；另同步一条前端接入向导契约。

## 自动验证

| 检查 | 结果 |
| --- | --- |
| `node --test tests/trellis-agent-tools.test.js` | 4/4 通过 |
| `npm --prefix web run lint` | 通过，仅既有 warning |
| `npm --prefix web run build` | 通过，仅既有大 chunk warning |
| `npx oxfmt --check` | 通过 |
| `git diff --check` | 通过 |

## 剩余风险

- 用户在真实 Tauri WebView2 客户端完成页面验收，确认完整 Agent 列表与搜索输入框无问题。
- 未提交 `initialize_pending_project`，因为会自动初始化或改变真实本地绑定。
