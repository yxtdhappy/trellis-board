# Board 实时刷新改为 SSE

## Goal

用浏览器 SSE 变更通知替代单机版和团队版任务看板的高频刷新轮询，让本机文件变化、团队成员实时上报和 Git 远端刷新都能及时更新任务卡片，同时避免空闲页面持续请求版本接口。

## Background

- 单机版页面当前每 750ms 请求 `/api/board/status`，发现 `lastRefreshAt` 变化后再请求 `/api/board`。
- 团队版页面当前每 750ms 请求 `/api/team/live-revision`，发现 `revisionKey` 变化后查询 `/api/tasks/query`。
- 团队版还每 3 秒刷新团队状态；项目栏对本地关联和 sidecar 状态也分别每 3 秒刷新。
- 团队 Agent 已有 SSE 基础设施，但 Board 浏览器页面当前没有 SSE。
- 现有 `11-08-team-realtime-task-sync` 已按“短轮询 live revision”完成实现；本任务作为其后续架构调整，独立规划和验收。

## Requirements

- R1：单机版和团队版 Board 页面建立同一路径的 SSE 连接；团队版必须使用现有 Session Cookie 鉴权。SSE 只接收数据变更通知，不推送完整任务列表或任务正文。
- R2：SSE 事件至少覆盖单机 `.trellis` 扫描完成、团队实时文件上报、Git 远端刷新和其他任务索引变更路径。
- R3：页面收到变更事件后复用现有 REST 接口重新加载当前任务数据，保留现有权限、筛选、分页和 ETag 行为。
- R4：首次加载、SSE 连接建立和断线重连后必须执行一次数据对齐，避免连接中断期间丢失更新。
- R5：删除单机版 `/api/board/status` 和团队版 `/api/team/live-revision` 的 750ms 常态轮询。
- R6：SSE 连接需要心跳、连接清理、会话/权限复查和代理禁缓冲响应头。
- R7：团队版现有责任人覆盖通知必须继续送达并去重显示，不能因移除 live revision 轮询而丢失。

## Acceptance Criteria

- [x] AC1：单机模式修改本地 `.trellis` 后，正常网络下 3 秒内页面任务卡片更新，且空闲页面不再每 750ms 请求 Board 状态接口。
- [x] AC2：团队模式客户端上报实时变化后，其他在线 Board 页面 3 秒内更新任务卡片，且空闲页面不再每 750ms 请求 live revision 接口。
- [x] AC3：Git 远端刷新产生任务数据变化时，SSE 能触发当前任务查询刷新，不依赖下一次实时文件上报。
- [x] AC4：SSE 断线、服务重启或网络恢复后，页面自动重连并重新查询当前数据，不显示过期任务卡片。
- [x] AC5：团队版未登录或会话失效的连接返回 401；SSE 事件不含任务正文，事件后的任务查询继续执行项目权限校验。
- [x] AC6：初次加载和事件后的任务查询仍通过现有 REST API 完成，筛选、分页和 ETag 行为不回归。
- [x] AC7：移除 750ms 轮询后，责任人覆盖提示仍能显示且同一通知只提示一次。

## Out of Scope

- 不通过 SSE 传输完整任务卡片、任务详情或文件内容。
- 不将任务查询、创建、修改和权限校验改为 SSE。
- 不使用 WebSocket 替代 SSE。
- 不迁移团队状态和项目栏本地关联/sidecar 状态的 3 秒轮询。
- 不删除兼容的 `/api/team/live-revision` 接口；它仅改为由 SSE 连接或变更事件按需调用。
- 不在本任务中重构与 Board 数据刷新无关的插件、发布操作或管理台轮询。
