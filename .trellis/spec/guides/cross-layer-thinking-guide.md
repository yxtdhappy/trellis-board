# 跨层契约指南

本项目的跨层问题主要集中在“文件系统证据 → 扫描 Worker → 看板 API → 原生 DOM 页面”这条链路，以及“页面操作 → HTTP 接口 → Trellis 文件写回 → 监听刷新”这条反向链路。

## 主数据流

```text
白名单仓库 .trellis/**
  -> server/loader.js 扫描与阶段推导
  -> server/scan-worker.js Worker Thread 汇总
  -> data/board.sqlite scan_cache、task_dependency、board_state 与内存 boardCache
  -> server/index.js /api/board、/api/task
  -> public/app.js state 与 renderX/bindX
  -> public/index.html 原生 DOM
```

```text
public/app.js api()
  -> server/index.js 路由
  -> server/actions.js / metadata.js / execution-store.js
  -> 目标仓库 task.json / 本应用 SQLite task_stage、task_execution、task_tag、saved_view、task_event、task_dependency、board_state
  -> watcher 防抖、排队、重新扫描
  -> 前端状态轮询并加载新看板
```

## 必须保持一致的契约

### 阶段

13 个阶段及顺序分布在多个真实位置：

- [server/metadata.js](../../../server/metadata.js)：人工阶段的合法 ID。
- [server/loader.js](../../../server/loader.js)：`STAGE_ORDER`、`STAGE_META`、阶段证据和推导。
- [server/scan-worker.js](../../../server/scan-worker.js)：Worker 返回的阶段骨架。
- [public/app.js](../../../public/app.js)：`STAGE_LANES` 按阶段数组索引映射流水线列。

当前重复定义是已知实现状态。修改阶段时没有统一常量可改，必须逐个定位并同步；同时更新 [tests/loader.test.js](../../../tests/loader.test.js) 中阶段、人工覆盖、E2E 和父任务继承相关断言。不要只改后端导致前端列错位。

阶段 ID 表示流程语义，阶段 `index` 从 1 开始，前端数组下标从 0 开始。E2E 是唯一标记为 `optional: true` 的阶段；缺失 E2E 不阻塞规范回写和工作提交。

轻量 Kanban 中 `check` 的数组下标是 `7`，应与 `e2e` 及后续阶段一起进入 `verification` 泳道；`implement` 的数组下标是 `6`。修改分栏边界时同时运行 `laneForStageIndex` 单测并在真实看板确认“检查中”卡片位于“检查 / 收尾”。

`task.json.status=in_progress` 只证明任务已启动，不能单独完成 `implement` 或进入 `check`。阶段推导必须等待实施报告、检查报告、验收勾选、commit 或 `completed` 等完成证据；已勾选实施计划项也不能绕过实施完成门禁。

### 任务身份与路径

- 仓库身份来自 SQLite `repositories.id`，扫描结果中的 `projectId` 使用该值。
- `relativeDir` 是相对白名单仓库根的路径，正常任务以 `.trellis/tasks/` 开头，归档任务还包含 `archive/`。
- 任务列表身份 `taskKey` 为 `${projectId}::${relativeDir}`，用于当前路径定位；`executionTaskKey` 为 `${projectId}::${task.id || dirName}`，用于归档后仍关联计划字段、标签和事件。两者不能混用。
- 同一项目内重复 `executionTaskKey` 时任务仍可见，但必须标记 `executionIdentityValid=false`、隐藏扩展数据并拒绝计划或人工阶段写入。
- 有 board 快照时，若同一 `taskKey` 在磁盘最新扫描出的 `executionTaskKey` 与快照不同，或快照外的新路径认领了另一个任务已有的身份，均视为身份漂移并拒绝写扩展数据，直到刷新快照；新身份可能已属于另一任务，不能直接复用其计划字段或事件。
- API 字段名并不统一：创建和负责人更新使用 `repositoryId`，详情、计划字段与人工阶段使用 `projectId`；任务定位字段 `taskDir` / `taskPath` 都承载上述 `relativeDir`，不是相对 `.trellis/tasks` 的短路径。后端消费定位字段时必须解析到白名单仓库并确认仍在任务根内，新增任务写接口复用 `resolveTaskLocation()`。
- 仓库配置和监听事件把路径分隔符统一为 `/`；Node 文件操作前再用 `path.resolve()` 得到本机路径。
- 详情请求合并列表任务和最新磁盘扫描结果时，仍以 `taskKey` 匹配。

修改路径格式时，同时检查 [server/config.js](../../../server/config.js)、[server/repositories.js](../../../server/repositories.js)、[server/loader.js](../../../server/loader.js)、[server/watcher.js](../../../server/watcher.js)、[server/actions.js](../../../server/actions.js) 和 [public/app.js](../../../public/app.js)。

### 列表与详情

`GET /api/board` 返回列表投影，`toTaskListItem()` 明确挑选字段并移除产物正文；`projectBoardExecution()` 再批量叠加轻量计划摘要、注意力原因和执行指标摘要，不向列表返回事件正文。列表响应不得包含 `artifacts`、`execution.events` 或 `execution.history`。[public/app.js](../../../public/app.js) 点击任务后再调用 `/api/task` 获取完整产物、最近 1000 条事件、撤销状态和完整指标。

修改任务字段时先判断它属于：

- 列表和详情都需要：加入 [server/loader.js](../../../server/loader.js) 的 `toTaskListItem()` 和前端卡片/详情渲染。
- 只有详情需要：保留在完整 task 中，不进入 `toTaskListItem()`。

增加大字段前必须确认不会被列表接口意外带出。

风险与依赖字段的投影边界：

- 列表只返回 `blockedByCount`、`blocksCount`、活动阻断时长、WIP 状态和 DoR/DoD 缺口数量。
- 详情才返回活动 `blockedBy` / `blocks`、已结束 `resolvedBlockedBy` / `resolvedBlocks`、原因、创建人、固定区间时长和 DoR/DoD 缺口数组。
- 列表证据摘要必须保留 PRD 验收计数、Design 有效性和 Implement 存在性，供风险派生使用；产物正文仍然清空。

### 依赖与流动

- A blocked by B 表示 `blocked_task_key = A`、`blocker_task_key = B`；A 的 `blockedBy` 与 B 的 `blocks` 由同一行双向投影。
- 创建和解除依赖必须与 `task_event` 同事务。环检测只读取活动边；解除后保留行、创建时间和解除时间，后续可以创建新的活动边。
- `flow` 和任务风险摘要由执行投影实时叠加，不属于原始扫描缓存。依赖或 WIP 写入后，前端必须重新请求 `/api/board` 和 `/api/task`，不能只改本地状态。
- `executionWipLimit` 存在 `board_state`，范围 `1`–`9`，默认 `2`；它和 DoR/DoD 一样只提醒，不参与阶段写入门禁。
- 保存视图 `blocked` 只接受 `any`、`blocked`、`unblocked`；缺失字段按 `any` 兼容旧视图。

### HTTP 错误

后端接口失败时抛出 `Error`，统一路由捕获后返回 `{ "error": "中文错误信息" }`，HTTP 状态为 400。前端 [public/app.js](../../../public/app.js) 的 `api()` 读取 `payload.error` 并抛出，页面只通过 `showError()` 或表单消息展示。

新增接口应沿用同一错误结构和 `api()` 调用方式。不要把后端异常文本直接拼进未转义 HTML。

### 扫描缓存版本

[server/index.js](../../../server/index.js) 的 `SCAN_SCHEMA_VERSION` 当前为 `11`。只要 board 输出形状（包括执行风险摘要、指标摘要和 flow）发生不兼容变化，就递增该值，让 SQLite `scan_cache` 行失效。只改内部实现、不改变持久化输出形状时无需递增。

## 反向链路检查

写操作完成后，前端现有策略是重新请求 board；文件监听也会异步触发刷新。涉及写操作时确认：

1. 请求先在边界校验，不产生部分写入。
2. Board 多行状态在 SQLite 事务中提交；目标仓库 JSON 使用临时文件加 `renameSync()`。
3. 目标路径位于 SQLite 白名单仓库和允许的子目录内。
4. 响应成功后刷新状态；不要只修改前端全局对象假装已持久化。
5. 验证读回值，而不是只看按钮文案。

## 跨层变更清单

- [ ] 找到生产者和全部消费者。
- [ ] 明确字段、错误、路径和阶段索引的格式。
- [ ] 在边界做一次运行时校验，不信任浏览器输入。
- [ ] 同步列表投影、详情、前端渲染和测试。
- [ ] 依赖事务、活动边环检测、双向投影、历史保留和 WIP 软限制都有自动化覆盖。
- [ ] 保存视图缺 `blocked` 字段按 `any`，完整依赖只在详情返回。
- [ ] 输出形状不兼容时更新 `SCAN_SCHEMA_VERSION`。
- [ ] 运行相关 Node 测试，并对页面操作做真实浏览器验证。
