# 任务名复制：实施报告

## 交付摘要

- 主看板任务卡片新增全宽、高对比的“复制任务名”按钮，复制当前任务 `dirName`。
- 任务详情标题区新增同等入口，活动和归档任务均可使用。
- 复制成功显示“已复制”，通过卡片或 dialog 内的 `aria-live` 状态区播报完整目录名。
- Clipboard API 被拒绝时使用临时 textarea 降级；modal 打开时 fallback 节点挂入当前 dialog，避免被 inert 区域隔离。
- 降级仍失败时显示“复制失败”、中文错误和 aria-live 播报，不静默失败。
- 卡片复制按钮通过独立 `data-copy-task` 绑定和指针层级隔离，不触发整卡详情或“计划”按钮。
- 详情异步刷新时，同一 `taskKey` 保留复制反馈；切换任务时才重置按钮和计时器。

## 变更文件

- `public/app.js`
- `public/index.html`
- `public/styles.css`
- `.trellis/spec/frontend/rendering-and-state.md`
- `.trellis/spec/frontend/quality-guidelines.md`
- `.trellis/tasks/10-31-task-copy-shortcut/prd.md`

## 最终验证

- `npm test`：113/113 通过。
- `node --check public/app.js`：通过。
- `git diff --check -- public/app.js public/index.html public/styles.css`：通过。
- lint、TypeCheck、Build：N/A，项目未配置这些步骤。
- 真实浏览器验证了卡片、详情、归档任务复制值，Clipboard fallback，彻底失败提示，键盘和 800px 布局。

## 边界

- 未新增接口、数据库字段、任务数据写入或真实“认领并启动 Agent”操作。
- Chrome DevTools MCP 连续两次连接超时，按项目规则改用 `ego-browser` 完成浏览器验收。
- 未提交、未推送、未归档；真实 `127.0.0.1:4317` 服务未重启。
