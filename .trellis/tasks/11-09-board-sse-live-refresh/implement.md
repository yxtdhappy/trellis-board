# Board 实时刷新 SSE 实施计划

## 实施顺序

### 1. SSE 基础服务

- [x] 新增 `server/board-events.js`，实现连接登记、`tasks.changed` 广播、心跳、合并窗口、背压处理和关闭。
- [x] 先在无效连接、短时连续 publish、鉴权失败和 close 场景补 Node 测试。
- [x] 确认响应不压缩、不缓存，并包含 `x-accel-buffering: no`。

### 2. 单机模式

- [x] 在 `server/index.js` 创建并暴露 `GET /api/board/events`。
- [x] 扫描成功写入 scan cache 和 Board 状态后发布事件。
- [x] 服务停止时关闭 SSE 连接，避免关闭流程挂起。
- [x] 补真实 HTTP SSE 测试，验证事件触发后可读取新的 REST 快照；文件监听触发链由浏览器验收覆盖。

### 3. 团队模式

- [x] 在 `taskIndex.incrementQueryRevision()` 增加可选变更回调，并在数据库更新完成后调用。
- [x] 在 `createTeamRuntime()` 创建 Board SSE 服务，把回调接到 `publish()`。
- [x] 在 `server/team/http.js` 增加 Session Cookie 鉴权的 `/api/board/events`。
- [x] heartbeat 使用现有 `readSession()` 复查会话，失效后关闭连接。
- [x] runtime stop 时关闭 SSE 流和计时器。
- [x] 补自动测试：无 Cookie 为 401；有 Cookie 收到事件；query revision 变化触发；Session 失效关闭。

### 4. 前端刷新

- [x] 在 `web/src/hooks/useBoard.ts` 建立单例 EventSource，只在 runtime 生命周期变化时重连。
- [x] `onopen`、`tasks.changed`、窗口 focus 和 visibility visible 使用同一个刷新入口。
- [x] 单机事件调用 `loadBoard(false, true)`；团队事件查询当前任务页并按需查询 live notifications。
- [x] 保留团队状态和项目栏既有 3 秒轮询，不扩大范围。
- [x] 删除单机 750ms Board status 轮询和团队 750ms live revision 轮询。
- [x] 保留 `seenLiveNotifications` 去重和责任人覆盖提示。
- [x] 检查 EventSource effect 不依赖 filters，避免筛选时反复重连。

### 5. 规范与测试

- [x] 更新 `.trellis/spec/backend/desktop-realtime-sync.md`、`.trellis/spec/backend/http-and-filesystem.md` 和 `.trellis/spec/frontend/rendering-and-state.md` 的刷新契约。
- [x] 增加 SSE 服务和团队 HTTP 联动测试；单机扫描发布路径由真实浏览器验收继续覆盖。
- [x] 运行 `node --check` 覆盖改动的服务端模块。
- [x] 最后统一执行一次 `npm test`（已执行：379 项通过、9 项失败；失败项已按检查报告区分环境问题）。
- [x] 所有开发完成后执行一次 `npm --prefix web run build`。
- [x] 使用真实浏览器验证单机、团队、断线重连和空闲无 750ms 请求。
- [x] 责任人通知接口与前端事件 ID 去重由自动测试和代码审查覆盖；未单独截图 Toast。

## 重点风险文件

- `server/board-events.js`：新增生命周期与背压逻辑，是主要回滚边界。
- `server/index.js`：扫描成功后的发布时机和关闭顺序。
- `server/team/task-index.js`：query revision 位于事务内，必须延迟广播，防止读到提交前数据。
- `server/team/http.js`：Session Cookie 鉴权、流连接和 runtime shutdown。
- `web/src/hooks/useBoard.ts`：删除轮询后容易产生重复 EventSource 或 stale closure。

## 验证命令

```powershell
node --check server/board-events.js
node --check server/index.js
node --check server/team/http.js
node --check server/team/task-index.js
npm test
npm --prefix web run build
```

## 浏览器验收

1. 单机模式打开 Board，静置 3 秒，Network 面板不再出现每 750ms 的 `/api/board/status`。
2. 修改任务 `task.json`，任务卡片在 3 秒内更新。
3. 团队模式打开两个浏览器会话，A 侧修改或上报任务，B 侧卡片在 3 秒内更新。
4. Git 远端刷新造成任务变化时，不依赖下一次实时文件上报也能更新。
5. 停止并重新启动服务，页面 EventSource 重连后自动对齐数据。
6. 触发责任人接管，原责任人只收到一次警告。
7. 确认团队状态和项目栏仍按既有 3 秒行为工作，没有误删其他轮询。

## 开工前置检查

- [x] 当前工作区无关改动已识别并保持不动。
- [x] `implement.jsonl` 和 `check.jsonl` 已包含真实规范和设计引用。
- [x] 用户已审阅并明确批准最终规划摘要。
