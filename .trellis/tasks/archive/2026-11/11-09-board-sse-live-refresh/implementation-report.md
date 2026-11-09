# Board SSE 实时刷新实施报告

## 已完成

- 新增 `server/board-events.js`，提供单进程 SSE 连接管理、`tasks.changed` 合并广播、15 秒心跳、
  建连和心跳鉴权复查、慢连接关闭和统一关闭；连接释放时同时移除 `close`/`error` 监听。
- 单机 `server/index.js` 增加 `/api/board/events`；扫描成功写入缓存和 Board 状态后广播，
  失败扫描不广播；服务停止时先关闭 SSE 再关闭 HTTP server。
- 团队 `task-index` 在 query revision 更新后回调 SSE 服务；`server/team/http.js` 使用 Session Cookie
  建立事件流，心跳和广播前复查当前 Session，失效后关闭连接。
- 前端 `useBoard` 改为 runtime 生命周期内建立单个 EventSource。建连、重连、`tasks.changed`、
  页面聚焦和恢复可见时复用同一 REST 对齐入口，短时间事件会合并；通知去重集合不因团队筛选切换而清空。
- 修复共享请求层把合法 ETag `304 Not Modified` 当作错误的问题，SSE 建连后的重复 REST 对齐不再显示
  “请求失败 (304)”。
- 删除单机 `/api/board/status` 和团队 `/api/team/live-revision` 的 750ms 常态轮询；保留团队状态、
  项目栏和 Git 操作现有轮询，以及责任人通知按需查询和事件 ID 去重。
- 同步更新后端实时同步、HTTP 边界、前端状态规范及团队运维文档。

## 验证

- `node --test tests/board-events.test.js tests/team-board-events.test.js`：4 项通过，
  包含真实 HTTP SSE 通知后读取新 REST 快照。
- `node --test tests/team-events.test.js tests/team-realtime-sync.test.js`：21 项通过；
  双 Agent 实时同步 20 次样本单独复跑 P95=1499ms、max=1770ms。
- `node --check`：`server/board-events.js`、`server/index.js`、`server/team/http.js`、
  `server/team/task-index.js` 通过。
- `npm --prefix web run lint`：通过，输出为仓库既有 warning。
- `npm --prefix web exec tsc -- -p web/tsconfig.app.json`：通过。
- `npm test`：379 项通过、9 项失败、5 项跳过。失败项为缺失根级 `highlight.js`、
  既有 witops 插件 503，以及全量并发下的实时同步 P95；`team-realtime-sync.test.js`
  单独复跑 7/7 通过。
- `node --test tests/*.test.js`：355 项通过、9 项失败、4 项跳过；其中 Windows 并发下
  `loader` 重命名 EPERM 与超大帧用例隔离复跑均通过，稳定剩余失败为既有 `witops-plugins`
  503/capability 问题。
- `npm --prefix web run build`：通过；仅有既有的大 chunk warning。

## 真实浏览器验收

- 团队模式：`/api/board/events` 返回 200；静置期间不再周期请求 `/api/team/live-revision`，
  `/api/team/status` 仍按 3 秒运行；revision 变化后任务查询、状态和通知查询各执行一次。
- 团队模式断线重连：停止临时服务后 EventSource 出现 `ERR_CONNECTION_REFUSED`，服务恢复后自动重连，
  并重新执行任务查询、状态和通知查询。
- 单机模式：`/api/board/events` 返回 200；静置期间不再请求 `/api/board/status`；修改临时仓库任务标题后，
  页面收到事件并自动重载 `/api/board`，新标题正常显示。
- 验收未重启当前用户的 4317 服务，所有临时服务和夹具均已清理。
