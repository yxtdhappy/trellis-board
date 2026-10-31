# 任务名复制：真实浏览器 E2E 报告

## 环境

- 应用：`http://127.0.0.1:4317`
- 服务：复用现有本地看板服务，未重启或停止
- 浏览器：Chrome DevTools MCP 连续两次 60 秒连接超时；按项目规则改用 `ego-browser` Chromium
- 数据：当前真实 Board 快照，含 8 个进行中任务和 680 个归档任务

## 浏览器验收

### 卡片复制

- 目标任务：`10-30-component-push-task-ui`
- Tab 从“计划”按钮落到“复制任务名”，`:focus-visible` 为 3px solid 轮廓。
- Space 和 Enter 均成功激活复制。
- 当前 8 个主看板卡片的按钮都显示“复制任务名”；卡片 aria-label 和 title 同样使用“复制任务名”。
- 两次从剪贴板实际粘贴出的值都严格等于 `10-30-component-push-task-ui`。
- 鼠标点击复制按钮不会打开任务详情。
- 成功状态显示“已复制”，并通过 `aria-live` 播报“已复制任务名：完整目录名”。

### 详情与归档

- 活动任务详情复制值与卡片一致，对话框保持打开。
- 归档任务 `10-30-fix-publish-ck-replica-convergence-web` 详情复制值严格等于其 `dirName`。
- 详情异步刷新不会清掉同一任务刚出现的复制反馈。

### Fallback 与失败

- 强制 Clipboard API 拒绝后，卡片复制通过页面内 textarea fallback 成功，粘贴值为目标目录名。
- modal 打开时 fallback 节点挂入当前 dialog，详情复制仍成功。
- 同时强制 Clipboard API 和 `execCommand` 失败后，按钮显示“复制失败”，aria-label、aria-live 和页面错误条均显示中文错误，详情没有被误打开。

### 响应式与运行质量

- 800px 视口：`documentClientWidth=785`、`documentScrollWidth=785`，页面无横向溢出。
- 任务卡片内部无横向溢出，“复制任务名”按钮完整位于卡片内。
- 详情对话框无横向溢出，头部正常换行，复制与关闭按钮均可见。
- 浏览器运行时异常 `[]`、控制台错误 `[]`、日志错误 `[]`、失败请求 `[]`、HTTP 错误响应 `[]`。

## 截图

- `C:/Users/yuhaojie/.codex/visualizations/2026/10/31/01a18fdc-116c-7be3-88f1-d944571a7ca1/task-copy-label-800px.png`
- `C:/Users/yuhaojie/.codex/visualizations/2026/10/31/01a18fdc-116c-7be3-88f1-d944571a7ca1/task-copy-800px.png`

## 限制

- Chrome DevTools MCP 未建立连接，因此 DOM 操作、剪贴板和截图来自 `ego-browser`。
- 本次没有真实“认领并启动 Agent”后端动作，该能力明确在 PRD 范围外。
