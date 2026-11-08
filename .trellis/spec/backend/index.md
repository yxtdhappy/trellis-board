# 后端开发规范

适用范围：`server/`。后端是 Node.js 原生 HTTP 服务，不依赖 Web 框架、数据库驱动包或第三方运行库；任务事实来自白名单 Trellis 仓库的文件系统，Board 自身状态来自 `data/board.sqlite`。

## 规范索引

| 文档 | 内容 |
| --- | --- |
| [架构与运行时](./architecture-and-runtime.md) | 模块职责、依赖方向、主线程与 Worker Thread |
| [扫描与持久化](./scanning-and-persistence.md) | 任务证据、阶段推导、缓存、文件监听和刷新队列 |
| [HTTP 与文件边界](./http-and-filesystem.md) | API、输入校验、白名单、原子写和静态文件 |
| [插件运行时](./plugin-runtime.md) | 子进程协议、清单与版本、生命周期、存储与命名空间、任务写入 |
| [插件测试](./plugin-testing.md) | 协议契约、插件功能、真实组合的分层测试与覆盖矩阵 |
| [桌面 sidecar 与 SEA 打包](./desktop-sidecar-packaging.md) | 源码/SEA 入口分离、DPAPI 路径注入和 Windows 构建验证 |
| [桌面实时任务同步](./desktop-realtime-sync.md) | 共享 watcher、实时文件覆盖层、版本、SSE、备份与责任人确认 |
| [质量与验证](./quality-guidelines.md) | Node 内置测试、夹具、真实服务验收 |

## 基本约束

- `package.json` 声明 Node `>=24`，模块类型为 ESM，SQLite 使用内置 `node:sqlite`。新增代码使用 `import`，内部相对导入保留 `.js` 后缀。
- 服务只监听 `127.0.0.1`，默认端口 `4317`。
- 无构建步骤。启动命令直接执行 `node server/index.js`。
- 运营数据只写本应用 `data/`；用户要求的任务操作只写白名单仓库 `.trellis/` 内允许的文件。
- 当前版本是单机 MVP，不提供认证、审计或多用户权限；SQLite 只解决本机持久化，不能把它描述成共享数据库。

## 关键边界

- 浏览器输入从 [server/index.js](../../../server/index.js) 进入后，必须先校验，再写文件。
- 任意路径不能直接成为读写目标；仓库必须来自白名单，任务目录必须位于目标 `.trellis/tasks`。
- Board 状态通过 SQLite 事务和预编译语句写入；任务 `task.json` 仍使用临时文件加 `renameSync()` 原子替换。
- 扫描在 Worker Thread 中执行，HTTP 主线程负责缓存、排队、API 和静态资源。
- 人工阶段只写 SQLite `task_stage` 表，不改写 Trellis 的真实 `task.json.status`。

## 相关入口

- [README.md](../../../README.md)：产品能力、限制和启动方式。
- [package.json](../../../package.json)：Node 版本和脚本。
- [server/index.js](../../../server/index.js)：HTTP 服务与刷新编排。
- [server/database.js](../../../server/database.js)：SQLite 连接、schema 和旧 JSON 一次性迁移。
- [server/persistence.js](../../../server/persistence.js)：扫描缓存和看板状态。
- [server/repositories.js](../../../server/repositories.js)：SQLite 项目白名单。
- [server/loader.js](../../../server/loader.js)：文件证据和任务投影。
- [tests](../../../tests)：当前自动验证范围。
