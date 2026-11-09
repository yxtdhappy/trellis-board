# 修复团队任务详情重复请求

## Goal

修复团队模式下打开任务详情后反复请求 `/api/task`、最终耗尽客户端网络资源并误报“无法连接团队服务”的问题。

## Background

- `useBoard` 在团队模式渲染期间直接执行 `teamPage.tasks.map(teamRowToBoardTask)`，导致没有数据变化时也生成全新的任务对象。
- `BoardPage` 用任务对象引用同步当前选中任务，`tasks` 每次渲染变化会持续调用 `setSelected`。
- `TaskDetailDialog` 的详情 effect 依赖任务对象，因此持续发送 `POST /api/task`。
- 浏览器复现时出现大量 pending 请求，控制台最终报 `net::ERR_INSUFFICIENT_RESOURCES`，桌面客户端表现为连续提示“无法连接团队服务”。

## Requirements

- 团队任务的展示数据在 `teamPage.tasks` 未变化时必须保持引用稳定。
- 独立模式继续使用原有 `board.tasks`，行为不得改变。
- 打开一次任务详情只能产生一次详情读取，不得因普通 React 重渲染重复请求。
- 不新增依赖，不重构任务详情组件协议，不改变服务端接口。

## Out of Scope

- 不处理 Git attributes 与 `needs_repair` 误报；该问题已单独现场修复。
- 不引入 React hook 测试框架或组件测试栈。
- 不修改任务详情的数据结构、轮询间隔或实时同步协议。

## Acceptance Criteria

- [x] 团队模式仅在 `teamPage.tasks` 变化时重新生成 `BoardTask[]`。
- [x] 独立模式仍直接返回 `board.tasks`。
- [x] 前端 lint、TypeScript 检查和生产构建通过。
- [x] 浏览器打开任务详情后只发送一次 `POST /api/task`，响应为 200。
- [x] 请求释放后不会继续堆积，控制台不再出现资源耗尽错误。

## Notes

- 当前代码修改位于 `web/src/hooks/useBoard.ts`，尚未提交。
- 仓库没有可直接复用的 React hook 渲染测试入口，因此本次回归以构建和真实浏览器网络记录为证据。
