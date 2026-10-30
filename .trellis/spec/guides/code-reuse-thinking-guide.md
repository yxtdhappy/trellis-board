# 代码复用指南

这个仓库刻意保持小而直接：没有第三方运行时依赖，没有 `src/shared/`，也没有通用工具层。复用优先扩展现有模块，不为了“将来可能用到”创建抽象。

## 新增代码前先搜索

PowerShell 中使用 `rg`，先按语义和符号名搜索：

```powershell
rg -n "你要新增的函数名或常量" server public tests
rg -n "path\.resolve|normalize" server public tests
rg -n "STAGE_ORDER|STAGE_IDS|STAGE_LANES" server public tests
rg -n "TASK_SLUG_PATTERN|normalizeTaskSlug|slugifyTaskTitle" server public tests
```

## 已有复用关系

| 逻辑 | 当前所有者 | 使用方式 |
| --- | --- | --- |
| 任务 slug 规则 | [public/slug.js](../../../public/slug.js) | 前端和后端都从该模块导入；[server/actions.js](../../../server/actions.js) 用同一规则做最终校验 |
| Markdown 渲染与 HTML 转义 | [public/markdown.js](../../../public/markdown.js) | 页面通过 `renderMarkdown()` 渲染产物；不要再复制一套 Markdown 解析或链接白名单 |
| 归档排序与时间格式 | [public/archive-sort.js](../../../public/archive-sort.js) | 归档视图直接调用，不在 `app.js` 重写比较器 |
| 应用路径常量 | [server/config.js](../../../server/config.js) | 其他后端模块导入 `dataDir`、数据库和旧 JSON 路径常量 |
| SQLite 连接与事务 | [server/database.js](../../../server/database.js) | 业务模块使用 `getDefaultDatabase()` 和 `withTransaction()`，不跨 Worker 传连接 |
| 仓库白名单存储 | [server/repositories.js](../../../server/repositories.js) | 项目增删统一走 `createRepositoryStore()`，不要在路由里直接写表 |
| 扫描缓存与看板状态 | [server/persistence.js](../../../server/persistence.js) | HTTP 层通过 facade 读写，不在路由里重复拼 SQL |
| 任务扫描与阶段推导 | [server/loader.js](../../../server/loader.js) | Worker、详情接口和测试都调用同一扫描实现 |
| 人工阶段持久化 | [server/metadata.js](../../../server/metadata.js) | 只通过 `getManualRecord()`、`setManualStage()` 读写 |
| 任务定位与路径校验 | [server/task-location.js](../../../server/task-location.js) | 详情和所有任务写接口复用 `resolveTaskLocation()` |
| 计划字段、标签、保存视图和事件 | [server/execution-store.js](../../../server/execution-store.js) | 通过 execution store 事务写入，不在路由中拼 SQL |
| 执行摘要与注意力投影 | [server/execution-projection.js](../../../server/execution-projection.js) | Board 一次批量读取，详情复用同一投影语义 |
| 组合筛选与标签输入 | [public/execution-filter.js](../../../public/execution-filter.js) | 页面与 Node 测试共用，不在渲染函数中复制匹配规则 |

## 哪些内容目前重复

阶段定义同时存在于后端模块、Worker 和前端 lane 映射中。它属于已知技术债，不是鼓励继续复制的模式。当前修改阶段时必须把这些消费者作为一个变更单元。

Board 的人工阶段、仓库、执行扩展数据和缓存状态已统一交给 SQLite。目标仓库 `task.json` 的原子文件写仍由 [server/actions.js](../../../server/actions.js) 负责；不要把数据库事务误用于跨文件系统提交。

## 复用判断

应该复用：

- 同一规则已经跨前端/后端使用，例如 slug 和 Markdown。
- 同一文件或数据的所有写操作必须保持原子性。
- 同一字段已经在两个以上消费者中定义。

可以保留局部实现：

- 只有一次调用的小转换。
- 两个模块语义相似但依赖不同，强行抽取会形成浏览器与 Node 不应共享的耦合。
- 抽象需要用参数覆盖多个差异，阅读成本高于少量重复。

## 禁止的重复

- 在前端另写一份 slug 正则，导致浏览器提示与后端校验不一致。
- 在 `app.js` 直接处理 Markdown 原始 HTML，绕过 `renderMarkdown()`。
- 在路由、Worker 和 loader 各写不同的阶段顺序。
- 绕过 `createRepositoryStore()`、`getRepositories()` 或 `database.js` 另读一份仓库配置。
- 为一次路径检查引入多层通用守卫，改变现有 `path.resolve()` 加根目录判断的简单模型。

## 变更后检查

- [ ] 搜索了相同函数、常量、正则和错误文案。
- [ ] 新规则只有一个主要所有者，其他位置引用该所有者。
- [ ] 没有为单次使用创建共享抽象。
- [ ] 修改重复契约时覆盖了所有真实消费者。
- [ ] 相关测试验证行为，而不是只验证函数被调用。
