# 阶段证据只读实施计划

## 实施清单

- [ ] 将 `TaskDetailDialog` 的阶段证据按钮替换为只读列表内容。
- [ ] 删除 `TaskDetailDialog` 的 `setStage` action 依赖。
- [ ] 删除 `useBoard` 中仅供阶段按钮使用的 `setStage` action 和类型。
- [ ] 删除 `web/src/api/board.ts` 中未使用的 `setTaskStage` helper。
- [ ] 保留后端 `PUT /api/tasks/stage` 和已有 manual 数据兼容。
- [ ] 在 OpenAPI 或项目规范中记录“阶段证据只读、自动推导”的前端契约。

## 验证

```powershell
npm test
npm --prefix web run lint
npm --prefix web run build
```

真实页面验收：

1. 打开任意任务详情，确认阶段证据行不是按钮。
2. 检查 DOM 中阶段行没有 `onClick`、按钮 role 或可聚焦行为。
3. 在浏览器网络面板确认交互阶段证据不会发出 `PUT /api/tasks/stage`。
4. 对比验收前后的 SQLite `task_stage` 行数，确认没有新增。

## 回滚点

- 前端交互、action 和 API helper 属于同一工作提交，可整体回退。
- 不修改后端和数据，不需要数据库回滚。

## 评审门禁

- PRD、design 和本实施计划评审通过后，才执行 `task.py start`。
- 实现期间不运行构建；所有代码和检查完成后统一执行一次最终验证。
