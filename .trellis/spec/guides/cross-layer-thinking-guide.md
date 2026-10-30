# 跨层契约指南

本项目的跨层问题主要集中在“文件系统证据 → 扫描 Worker → 看板 API → 原生 DOM 页面”这条链路，以及“页面操作 → HTTP 接口 → Trellis 文件写回 → 监听刷新”这条反向链路。

## 主数据流

```text
白名单仓库 .trellis/**
  -> server/loader.js 扫描与阶段推导
  -> server/scan-worker.js Worker Thread 汇总
  -> data/board.sqlite scan_cache 与内存 boardCache
  -> server/index.js /api/board、/api/task
  -> public/app.js state 与 renderX/bindX
  -> public/index.html 原生 DOM
```

```text
public/app.js api()
  -> server/index.js 路由
  -> server/actions.js 或 server/metadata.js
  -> 目标仓库 task.json / 本应用 SQLite task_stage
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

### 任务身份与路径

- 仓库身份来自 SQLite `repositories.id`，扫描结果中的 `projectId` 使用该值。
- `relativeDir` 是相对白名单仓库根的路径，正常任务以 `.trellis/tasks/` 开头，归档任务还包含 `archive/`。
- 任务列表身份 `taskKey` 为 `${projectId}::${relativeDir}`。
- API 字段名并不统一：创建和负责人更新使用 `repositoryId`，详情与人工阶段使用 `projectId`；任务定位字段 `taskDir` / `taskPath` 都承载上述 `relativeDir`，不是相对 `.trellis/tasks` 的短路径。后端消费定位字段时必须解析到白名单仓库并确认仍在任务根内；当前人工阶段接口尚未执行这层校验，详见后端 HTTP 规范。
- 仓库配置和监听事件把路径分隔符统一为 `/`；Node 文件操作前再用 `path.resolve()` 得到本机路径。
- 详情请求合并列表任务和最新磁盘扫描结果时，仍以 `taskKey` 匹配。

修改路径格式时，同时检查 [server/config.js](../../../server/config.js)、[server/repositories.js](../../../server/repositories.js)、[server/loader.js](../../../server/loader.js)、[server/watcher.js](../../../server/watcher.js)、[server/actions.js](../../../server/actions.js) 和 [public/app.js](../../../public/app.js)。

### 列表与详情

`GET /api/board` 返回列表投影，`toTaskListItem()` 明确挑选字段并移除产物正文，避免把大段 Markdown 放入首屏响应。[public/app.js](../../../public/app.js) 点击任务后再调用 `/api/task` 获取详情。

修改任务字段时先判断它属于：

- 列表和详情都需要：加入 [server/loader.js](../../../server/loader.js) 的 `toTaskListItem()` 和前端卡片/详情渲染。
- 只有详情需要：保留在完整 task 中，不进入 `toTaskListItem()`。

增加大字段前必须确认不会被列表接口意外带出。

### HTTP 错误

后端接口失败时抛出 `Error`，统一路由捕获后返回 `{ "error": "中文错误信息" }`，HTTP 状态为 400。前端 [public/app.js](../../../public/app.js) 的 `api()` 读取 `payload.error` 并抛出，页面只通过 `showError()` 或表单消息展示。

新增接口应沿用同一错误结构和 `api()` 调用方式。不要把后端异常文本直接拼进未转义 HTML。

### 扫描缓存版本

[server/index.js](../../../server/index.js) 的 `SCAN_SCHEMA_VERSION` 当前为 `8`。只要 board 输出形状发生不兼容变化，就递增该值，让 SQLite `scan_cache` 行失效。只改内部实现、不改变持久化输出形状时无需递增。

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
- [ ] 输出形状不兼容时更新 `SCAN_SCHEMA_VERSION`。
- [ ] 运行相关 Node 测试，并对页面操作做真实浏览器验证。
