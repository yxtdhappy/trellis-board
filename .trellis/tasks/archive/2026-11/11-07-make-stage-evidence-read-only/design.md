# 阶段证据只读设计

## 边界

- 页面：[BoardPage.tsx](../../../web/src/pages/board/BoardPage.tsx)
- 组件：[TaskDetailDialog.tsx](../../../web/src/features/board/dialogs/TaskDetailDialog.tsx)
- 前端数据层：[useBoard.ts](../../../web/src/hooks/useBoard.ts)
- 前端 API：[board.ts](../../../web/src/api/board.ts)
- 后端、SQLite schema 和自动阶段推导不在修改范围

## 交互

“阶段证据”区域从操作列表改为信息列表：

- 使用非交互容器渲染每一行。
- 不设置 `onClick`、`role="button"`、`tabIndex`、悬停点击态或禁用按钮。
- 保留阶段序号、名称、完成来源和证据说明。
- 当前阶段仍由 Board 的 `derivedStage` 高亮，但高亮不代表可操作。

## 数据流

当前错误链路：

```text
阶段行点击
-> TaskDetailDialog.actions.setStage
-> useBoard.actions.setStage
-> PUT /api/tasks/stage
-> task_stage + stage_manual_confirmed
```

修改后：

```text
Trellis 任务文件和 workspace 证据
-> loader 自动推导 stages / derivedStage
-> /api/task、/api/board
-> TaskDetailDialog 只读展示
```

## 代码调整

- `TaskDetailDialog` 的阶段证据行改为 `<div>` 或静态列表内容。
- 从 `TaskDetailActions` 删除 `setStage`。
- 从 `useBoard` 的前端 actions 和 `BoardActions` 类型删除 `setStage`。
- 从 `web/src/api/board.ts` 删除不再使用的 `setTaskStage` helper。
- 后端路由和 `server/metadata.js` 保持不变，兼容已有外部调用和撤销历史。

## 兼容性

- 已有 manual 阶段仍由 loader 投影，详情中显示“人工记录”来源。
- “撤销最近操作”继续可用，可修正历史误操作。
- 新的页面无法再产生人工阶段事件。

## 验证策略

- 源码检查确认前端不存在任务详情的 `setStage` 调用。
- 构建验证类型和打包。
- 真实页面检查阶段证据节点不是按钮。
- 浏览器网络记录确认与阶段区域交互不会产生 `PUT /api/tasks/stage` 请求。
- 数据库检查确认页面验收前后 `task_stage` 行数不变。
