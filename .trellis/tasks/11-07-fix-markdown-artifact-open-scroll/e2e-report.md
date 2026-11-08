# 真实浏览器 E2E 报告

## 环境

- 前端：`http://127.0.0.1:5173/`，Vite 加载本次最新源码。
- 后端：既有 `http://127.0.0.1:4317/`。
- 任务：`mdp-report-service / 11-05-multi-robot-push`。
- 浏览器：Chrome DevTools MCP 连续连接超时后，改用 Ego Lite Chromium 完整回归。

## 用例与结果

| 用例 | 结果 |
| --- | --- |
| 打开 PRD | `scrollTop=0`，`maxScrollTop=870`，焦点在弹层内 |
| PRD 向下滚动 | 滚轮后 `scrollTop=869`，可正常浏览 |
| 打开 Design | `scrollTop=0`，`maxScrollTop=6674`，焦点在弹层内 |
| Design 滚到底后关闭再开 | 仍为 `scrollTop=0` |
| 打开 Implement | `scrollTop=0`，`maxScrollTop=3111`，焦点在弹层内 |
| 滚到底后的页脚关闭按钮 | 文本“关闭”，处于弹层可视区 |
| Esc 关闭产物弹层 | 只关闭最上层产物弹层，任务详情仍保留 |
| 深色主题打开 PRD | 根节点为 `.dark`，`scrollTop=0`，焦点在弹层内 |
| 恢复浅色主题 | 成功，页面根节点不再包含 `.dark` |

## 结论

首次打开不再自动落到底部；滚轮、滚动后的页脚关闭、Esc 栈式关闭和关闭后重开均通过。深色主题下的滚动与焦点行为通过 DOM 状态和尺寸验证；自动截图因 CDP `Page.captureScreenshot` 超时未生成，但不影响上述交互断言。

短 Markdown 未单独取得浏览器样本；`maxScrollTop=0` 时容器没有可滚动距离，且修复只把首次焦点移到顶部标题区，不改变正文尺寸或内容布局。
