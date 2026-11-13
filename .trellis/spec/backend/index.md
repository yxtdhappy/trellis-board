# 后端开发规范

适用范围：`apps/server/`。后端是 Node.js HTTP 服务，外部固定版本 Trellis CLI 只作为受限子进程使用。任务事实来自白名单 Trellis 仓库的文件系统，Board 自身状态来自跨平台运行数据目录中的 `board.sqlite`。

## 规范索引

| 文档 | 内容 |
| --- | --- |
| [架构与运行时](./architecture-and-runtime.md) | 模块职责、依赖方向、主线程与 Worker Thread |
| [扫描与持久化](./scanning-and-persistence.md) | 任务证据、阶段推导、缓存、文件监听和刷新队列 |
| [HTTP 与文件边界](./http-and-filesystem.md) | API、输入校验、白名单、原子写和静态文件 |
| [插件运行时](./plugin-runtime.md) | 子进程协议、清单与版本、生命周期、存储与命名空间、任务写入 |
| [插件测试](./plugin-testing.md) | 协议契约、插件功能、真实组合的分层测试与覆盖矩阵 |
| [桌面 Agent 运行契约](./desktop-agent-runtime.md) | 进程内 Rust Agent 模块边界、协议/超时/控制事件、数据兼容、环境门与单 EXE 打包 |
| [桌面任务快照同步](./desktop-realtime-sync.md) | tasks-only 快照、CAS、任务空间、SSE、命令、冲突与备份 |
| [本机 taskDir 安全解析与错误展示](./desktop-task-path-resolution.md) | 跨端相对路径、Windows 路径边界、失败关闭与可读同步错误 |
| [任务级分支归属与冲突幂等](./task-ownership-and-conflict-idempotency.md) | 任务级 branch 门禁、ownership API、冲突复用与历史收敛 |
| [质量与验证](./quality-guidelines.md) | Node 内置测试、夹具、真实服务验收 |

## 基本约束

- `package.json` 声明 Node `>=24`，模块类型为 ESM，SQLite 使用内置 `node:sqlite`。新增代码使用 `import`，内部相对导入保留 `.js` 后缀。
- 服务默认监听 `0.0.0.0`、端口 `4317`；可用环境变量显式收窄到 `127.0.0.1`。
- 服务端无构建步骤，启动命令直接执行 `node apps/server/index.js`；前端静态资源由根目录 `npm run build` 写入 `apps/server/public/`。
- 运行数据只写 `TRELLIS_BOARD_DATA_DIR`（默认是系统用户数据目录）；用户要求的任务操作只写白名单仓库 `.trellis/` 内允许的文件。
- 跨包引用使用 workspace 包名（`@trellis-board/shared/…`、`@trellis-board/test-support/…`）；被多个 workspace 共用的第三方依赖在根 `package.json` 声明，仅单包使用的留在该包。
- `standalone` 是无账号鉴权、只适合可信网络的本机/局域网模式；`team` 才有账号、团队、审计和
  Agent 权限。Team 仍使用单实例 SQLite 和内存 SSE，不能描述成共享数据库或多实例高可用。

## 关键边界

- 浏览器输入从 [apps/server/index.js](../../../apps/server/index.js) 进入后，必须先校验，再写文件。
- 任意路径不能直接成为读写目标；仓库必须来自白名单，任务目录必须位于目标 `.trellis/tasks`。
- Board 状态通过 SQLite 事务和预编译语句写入；任务 `task.json` 仍使用临时文件加 `renameSync()` 原子替换。
- 扫描在 Worker Thread 中执行，HTTP 主线程负责缓存、排队、API 和静态资源。
- 人工阶段只写 SQLite `task_stage` 表，不改写 Trellis 的真实 `task.json.status`。
- 归档解析统一走 `packages/shared/zip.js`（fflate），不恢复手写 ZIP 解析；条目路径校验与限额在解压前生效，模板完整性由 `template-manifest.json` 的 sha256 保证（fflate 不校验 CRC-32）。

## 相关入口

- [README.md](../../../README.md)：产品能力、限制和启动方式。
- [package.json](../../../package.json)：Node 版本和脚本。
- [apps/server/index.js](../../../apps/server/index.js)：HTTP 服务与刷新编排。
- [apps/server/database.js](../../../apps/server/database.js)：SQLite 连接、schema 和旧 JSON 一次性迁移。
- [apps/server/persistence.js](../../../apps/server/persistence.js)：扫描缓存和看板状态。
- [apps/server/repositories.js](../../../apps/server/repositories.js)：SQLite 项目白名单。
- [apps/server/loader.js](../../../apps/server/loader.js)：文件证据和任务投影。
- [apps/server/test](../../../apps/server/test)：服务端与插件宿主测试；共享纯模块测试在 `packages/shared/test/`。
