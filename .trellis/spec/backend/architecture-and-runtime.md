# 架构与运行时

## 模块职责

| 模块 | 职责 |
| --- | --- |
| [server/config.js](../../../server/config.js) | 应用目录、SQLite 与旧 JSON 路径、默认仓库、仓库路径规范化 |
| [server/database.js](../../../server/database.js) | `node:sqlite` 连接、PRAGMA、schema v1 -> v3 顺序迁移、事务辅助和旧 JSON 一次性迁移 |
| [server/repositories.js](../../../server/repositories.js) | SQLite 白名单增删、ID 生成、路径规范化和显示顺序 |
| [server/metadata.js](../../../server/metadata.js) | 13 个阶段的合法 ID、SQLite 人工阶段存储 |
| [server/persistence.js](../../../server/persistence.js) | SQLite 扫描缓存和看板状态 facade |
| [server/task-location.js](../../../server/task-location.js) | 白名单任务定位、真实路径校验、身份冲突检查 |
| [server/execution-store.js](../../../server/execution-store.js) | 计划字段、标签、保存视图、阻断依赖和不可变事件事务 |
| [server/execution-projection.js](../../../server/execution-projection.js) | Board 批量执行摘要、依赖图、WIP/DoR/DoD 风险、注意力原因和详情事件投影 |
| [server/loader.js](../../../server/loader.js) | 扫描任务、读取证据、推导阶段、父子关系、列表投影 |
| [server/scan-worker.js](../../../server/scan-worker.js) | Worker Thread 内执行仓库扫描、增量任务刷新和结果汇总 |
| [server/watcher.js](../../../server/watcher.js) | 监听 `.trellis` 的 tasks、workspace、`.developer`，过滤相关事件 |
| [server/actions.js](../../../server/actions.js) | 创建任务、更新负责人和写操作边界校验 |
| [server/index.js](../../../server/index.js) | HTTP 路由、静态资源、缓存、刷新队列、Worker 生命周期 |

依赖方向保持简单：

```text
server/index.js
  -> database / loader / metadata / persistence / actions / repositories / watcher
  -> task-location / execution-store / execution-projection

server/scan-worker.js
  -> database / loader / metadata / repositories

server/actions.js
  -> repositories / public/slug.js

server/task-location.js
  -> database / loader / metadata

server/loader.js
  -> config / public/slug.js
```

`config.js` 不应反向导入业务模块。`database.js` 是 SQLite schema 和迁移的唯一所有者；业务模块不绕过它的连接、事务和旧数据导入入口。`loader.js` 是可复用扫描核心，Worker、详情接口和测试都依赖它；不要在 HTTP 路由里另写一套扫描。

## 主线程与 Worker

HTTP 进程在主线程维护：

- `boardCache`、`inflightScan`、`queuedRefresh`。
- `scanWorkerRuntime`、请求 ID 和待完成请求 Map。
- `watchRuntime`、防抖计时器和待合并事件。
- 一个进程级默认 SQLite 连接，仓库、人工阶段和持久化 facade 共享它。

完整扫描交给 Worker Thread，避免长时间同步文件读取阻塞 API。Worker 协议使用消息类型 `scan`、`scan-result`、`scan-error`；请求通过 ID 匹配。单次扫描超时为 `180_000ms`。

Worker 内会缓存各仓库最近结果，并根据事件判断是仓库级重扫还是单任务增量刷新。Worker 模块加载后打开自己的 SQLite 连接，不跨线程共享 `DatabaseSync`。最终仍要重建跨仓库父子任务关系，因此前端状态变化不能只看单个任务结果。

## 启动与关闭

[server/index.js](../../../server/index.js) 启动时：

1. 打开 `data/board.sqlite`，按顺序迁移到 schema v3，创建仓库存储和 HTTP 服务。
2. 监听 `127.0.0.1:4317`。
3. 启动对白名单仓库的文件监听。
4. 异步触发启动扫描。

测试导入 `loader`、`repositories`、`actions` 等模块时不应意外启动 HTTP 服务。服务启动逻辑只保留在 `server/index.js` 的顶层入口。

## 同步与异步

- HTTP 请求体和网络处理使用 async API。
- 扫描内部大量使用同步 `fs`，但通过 Worker 隔离长扫描。
- SQLite 使用同步 `DatabaseSync`；多行状态写入必须在 `BEGIN IMMEDIATE` 事务中完成。
- 依赖行与其创建/解除事件必须处于同一事务；活动依赖边在写入前完成重复和环检测。
- 目标仓库的任务 `task.json` 仍使用同步临时文件加 rename，保证文件原子替换。
- 外部 `task.py` 使用 `spawn()` 和参数数组，不启用 shell；环境设置 `PYTHONUTF8=1`。

新增长耗时逻辑时先判断是否会阻塞 HTTP 主线程。单纯数百毫秒内的配置读写可沿用同步模式；全仓库扫描、递归目录和大文件解析应留在 Worker 或明确的异步流程。

## 配置与常量

路径常量和旧 JSON 迁移来源由 [server/config.js](../../../server/config.js) 定义。业务模块按名称导入，不在本地重新拼接 `data/` 路径。运行时可变 Board 状态只通过 SQLite 读取和写入。

扫描输出结构由 `SCAN_SCHEMA_VERSION` 控制，当前为 `10`。该常量属于缓存兼容协议，不属于普通版本号；执行风险摘要或 flow 输出形状变化时必须同步递增。

## 反模式

- 在 HTTP 路由中直接递归扫描任务。
- 让 `loader.js` 持有 HTTP response、DOM 或页面状态。
- 用 shell 拼接用户输入后执行 `task.py`。
- 绕过 `database.js` / `persistence.js` 直接打开 SQLite，或为当前单机 MVP 引入外部数据库和 Web 框架。
- 在模块导入阶段启动监听器、Worker 或端口。
