# Board 实时刷新 SSE 技术设计

## 1. 目标与边界

把任务/看板数据刷新的触发方式从 750ms 版本轮询改为 SSE 失效通知：

```text
数据已经变化
  -> 服务端发布轻量 SSE 事件
  -> Board 页面收到事件
  -> 复用现有 REST 查询获取最新任务
  -> React 更新任务卡片
```

SSE 只负责通知“需要重查”，不负责传输业务快照。任务权限、筛选、分页、ETag 和实时覆盖层仍由现有 REST 查询处理。

本任务保留：

- 团队状态每 3 秒轮询；
- Tauri 项目栏本地关联和 sidecar 状态每 3 秒轮询；
- Git 操作进度现有轮询；
- `/api/team/live-revision` 接口及责任人通知数据。

## 2. 服务端事件总线

新增 `server/board-events.js`，提供单进程内的小型 SSE 连接管理：

```text
createBoardEventService({
  heartbeatMs = 15_000,
  retryMs = 3_000,
  debounceMs = 50,
  authorize = () => true
})
```

返回：

- `open({ response, authorize })`：建立 SSE 流并登记连接；
- `publish(event)`：合并短时间内的多次变化并广播；
- `close()`：关闭计时器和全部连接；
- `connectionCount()`：供测试和诊断使用。

统一接口：

```text
GET /api/board/events
```

事件名固定为 `tasks.changed`，数据仅包含版本和时间：

```json
{
  "revision": 42,
  "generatedAt": "2026-11-09T08:00:00.000Z"
}
```

单机模式没有全局 query revision，可省略 `revision`。事件不包含项目 ID、任务 ID、标题、正文或过滤器结果。

协议约束：

- `content-type: text/event-stream; charset=utf-8`；
- `cache-control: no-store`；
- `connection: keep-alive`；
- `x-accel-buffering: no`；
- 初始发送 `retry: 3000`；
- 每 15 秒写入 `: heartbeat` 注释帧；
- 不启用 gzip；
- 不需要持久化事件游标或回放。客户端在连接建立、重连和聚焦时执行一次 REST 对齐，丢失中间 SSE 事件不会丢失最终状态。

`publish()` 使用约 50ms 合并窗口。`taskIndex.incrementQueryRevision()` 可能位于同步 SQLite 事务中，延迟广播保证客户端查询时事务已经提交。

## 3. 单机模式

`server/index.js` 启动时创建 `boardEventService`：

- `GET /api/board/events` 打开 SSE；
- `refreshBoardFromFiles()` 成功写入 scan cache 和 `boardState` 后发布 `tasks.changed`；
- 扫描失败只保留原有错误状态，不发布成功事件；
- 服务关闭时调用 `boardEventService.close()`。

单机模式没有认证；沿用当前仅监听回环地址的安全边界。

## 4. 团队模式

### 4.1 鉴权

`server/team/http.js` 在现有 `actor = requireActor(request)` 之后处理 `/api/board/events`：

- 从 Session Cookie 读取 Session token；
- 打开连接时由现有 `readSession()` 校验；
- heartbeat 时再次校验 Session，过期、撤销或用户停用后关闭连接；
- 团队版事件本身不含任务数据，事件后的 `/api/tasks/query` 仍执行实时项目权限校验。

SSE 使用同源 Cookie，因此适配原生 `EventSource`，不需要把 Session token 暴露给浏览器脚本。

### 4.2 统一变更源

`createTaskIndex()` 新增可选回调：

```text
onQueryRevisionChanged(revision)
```

`incrementQueryRevision()` 成功更新 `app_meta.queryRevision` 后调用回调。`boardEventService.publish()` 通过合并窗口延后广播。

该统一入口覆盖：

- Agent 实时文件上报后的实时索引替换；
- Git 远端定时刷新和手动刷新；
- 浏览器任务创建、委派和其他任务写操作；
- 项目索引修复、启停和项目成员变化导致的查询失效；
- live 覆盖层收敛和重新投影。

即使某次状态变化不需要重载任务，客户端收到事件后仍会使用 ETag 查询；未变化时服务端返回 304，避免重复渲染。

### 4.3 责任人通知

现有 `/api/team/live-revision` 继续保留，但不再每 750ms 调用。Board 在以下时机按需调用：

- SSE `onopen` 和重连；
- 收到 `tasks.changed`；
- 页面重新获得焦点或从隐藏变为可见。

该接口仍负责返回 `notifications`，前端沿用 `seenLiveNotifications` 去重提示，避免移除轮询后丢失“任务被他人推进或接管”的通知。

## 5. 前端接入

在 `useBoard` 中：

1. runtime 首次解析后创建一个 `EventSource('/api/board/events')`。
2. `onopen` 时对齐一次当前数据源；连接重建同样触发。
3. 收到 `tasks.changed` 后使用短防抖执行：
   - 单机：`loadBoard(false, true)`；
   - 团队：`loadTeamPage(true)`、`loadTeamStatus()` 和按需 live notifications。
4. 页面 `focus` 或 `visibilitychange` 到 visible 时调用同一个对齐函数。
5. 组件卸载、页面切换或 runtime 变化时关闭 EventSource 并清理防抖计时器。
6. 删除单机 `/api/board/status` 750ms effect 和团队 live revision 750ms effect。

EventSource effect 不能直接依赖 `filters` 或每次渲染新建的回调，否则筛选变化会反复断开/重连。使用 ref 保存最新刷新函数，连接只随 runtime 生命周期建立。

EventSource 原生处理重连。团队模式连接错误时可按需调用一次 `/api/runtime` 判断是否已退出登录；不得在 `onerror` 中新增周期轮询。

## 6. 兼容与回滚

- 不新增 SQLite 表或迁移。
- 保留 `/api/board/status` 和 `/api/team/live-revision`，但 Board 不再定时调用它们。
- 保留 `fetchTeamLiveRevision()` 作为事件驱动通知查询。
- 不修改任务 REST 响应结构、ETag、筛选或权限契约。
- 回滚点：
  - `server/board-events.js` 与两个路由；
  - 单机扫描发布点；
  - task index query revision 回调；
  - `useBoard` EventSource effect；
  - 实时同步与前端状态规范文档。

## 7. 风险

- 代理若缓冲 SSE，事件会被批量延迟；必须验证现有网关、Vite 代理和桌面 WebView。
- 没有常规轮询兜底，EventSource 长时间不可用时页面只能依赖重连、聚焦和手动刷新。
- 单进程内存广播不跨多个服务实例；当前团队服务是单实例 SQLite 架构，本任务不引入共享消息总线。
- 全局 query revision 可能让无权限项目的用户也收到“有数据变化”的轻量通知，但事件无项目/任务信息，实际查询仍受 ACL 限制。
- 如果广播发生在事务提交前，客户端可能先读到旧数据；因此使用延迟合并广播并测试事件后立即查询的一致性。

## 8. 测试策略

- SSE 服务测试：响应头、心跳、合并、鉴权关闭、背压清理和 runtime close。
- 团队 HTTP 测试：Session Cookie 打开事件流；query revision、实时上报和项目刷新触发事件；401 和 Session 失效关闭。
- 单机集成测试：扫描完成后客户端收到事件，随后 `/api/board` 返回新任务。
- 前端浏览器验证：空闲 3 秒无 750ms 请求；单机文件变化和团队实时上报在 3 秒内更新卡片；断线重连后对齐；责任通知仍只提示一次。
