# 服务端日志异步落盘实施计划

## 1. 日志模块

- [x] 新增 `server/logger.js`。
- [x] 实现 `serverLogFile(dataDir)`，固定返回 `<dataDir>/logs/server.log`。
- [x] 实现 `redactServerLogText()`，覆盖 PRD 列出的敏感信息和本地路径。
- [x] 实现 `createServerLogger()`，提供 `log/info/warn/error/flush/close`。
- [x] 使用异步文件 API、500 ms/64 KiB 批次、1 MiB 有界缓冲和串行 flush。
- [x] 实现 `5 MiB × 5` 轮转。
- [x] 文件写入失败时向控制台报告一次并停用文件 sink，不向业务抛出。

验证：新增 logger 单元测试先失败，再完成实现后通过。

## 2. standalone 接入

- [x] `server/database.js` 的 `getDefaultDatabase()` 增加可选 `{ logger = console }`。
- [x] `server/index.js` 增加当前运行实例 logger。
- [x] `initializeStandaloneState()` 使用注入 logger 打开数据库。
- [x] 将 `server/index.js` 中 watcher、插件宿主、刷新、HTTP 异常和关闭日志改为使用注入 logger。
- [x] 保留控制台输出。

验证：直接调用 `getDefaultDatabase()` 的现有调用和测试保持兼容。

## 3. team 与入口接入

- [x] `startApplication(config, logger = console)` 将 logger 传给 team runtime。
- [x] `startApplication()` 将 logger 传给 standalone runtime。
- [x] 主入口创建 logger，再读取配置并启动服务。
- [x] 启动失败时记录错误并关闭 logger。
- [x] `SIGINT/SIGTERM` 时先停止 runtime，再等待 logger close，最后退出。
- [x] 保持信号处理幂等，不影响现有 standalone/team shutdown。

验证：检查 `createTeamRuntime` 及其下层继续只依赖注入 logger，不新增第二个日志实现。

## 4. 文档

- [x] 在 `README.md` 记录默认服务端日志路径、轮转规格和异常退出可能丢失尾部异步日志的限制。
- [x] 在 Phase 3 更新 `.trellis/spec/backend/architecture-and-runtime.md` 的服务端日志契约。
- [x] 更新 spec 前先检查该文件已有未提交改动，只追加本任务必要内容。

## 5. 自动化测试

新增 `tests/server-logger.test.js`：

- [x] `serverLogFile()` 路径契约。
- [x] 日志调用立即返回，close 后文件包含完整记录。
- [x] 原控制台仍收到原始参数。
- [x] Bearer、URL 用户信息、凭据键值和 Windows 路径不进入文件。
- [x] 小容量轮转后历史文件数量不超过上限，最旧内容被淘汰。
- [x] 日志目录不可用时 close 不抛错，控制台收到一次降级提示。
- [x] close 等待已排队 flush。

验证命令：

```powershell
node --test tests/server-logger.test.js
npm test
npm run format:check
```

## 6. 真实启动验收

使用临时 `TRELLIS_BOARD_DATA_DIR`，不操作当前 4317 实例及现有运行数据。

standalone：

- [x] 在非默认端口启动 standalone runtime。
- [x] 确认 `logs/server.log` 自动创建并包含启动日志。
- [x] 发出一次真实 HTTP 请求。
- [x] 调用 runtime stop 并 close logger，确认日志可读。

team：

- [x] 在临时数据目录使用 `TRELLIS_TEAM_INITIAL_PASSWORD` 执行 `init-admin`。
- [x] 设置 team 模式、公开 URL 和非默认端口后启动服务。
- [x] 确认同一路径的 `server.log` 包含团队启动日志。
- [x] 访问健康检查触发请求。
- [x] 调用 runtime stop 并 close logger，确认 flush。

## 7. 最终检查

- [x] 完成最终有效全量验证，未执行 web build。
- [x] 确认没有改动现有无关未提交文件。
- [x] 检查日志、测试输出和文档中没有真实密码、Cookie、Bearer 或本地绝对路径。
- [x] 检查 standalone/team 共用同一日志契约。

## 验证结果

- `node --test tests/server-logger.test.js`：8/8 通过。
- `npm test`：435 通过、5 跳过、2 项并行负载抖动失败；两项单独复跑均通过。
  - ACP 临时目录 Windows `EPERM`：单项复跑通过。
  - 实时同步 P95：单项复跑通过，P95=782ms、max=805ms。
- 修改文件格式检查通过；仓库级 `npm run format:check` 仍报告 9 个与本任务无关的既有格式问题。
- standalone 真实启动：直接执行 `node server/index.js`，使用独立临时数据目录和动态端口；
  启动日志、健康检查和无效 JSON 请求日志均通过。
- team 真实启动：首次管理员初始化、独立临时数据目录、动态端口、健康检查和启动日志均通过。
- 未执行前端 build；服务端没有编译阶段。

## Risky Files

- `server/index.js`：启动、信号和两种模式的公共入口。
- `server/database.js`：默认数据库单例创建的兼容性。
- `server/logger.js`：异步并发、轮转、脱敏和失败降级。
- `tests/server-logger.test.js`：文件系统时序和 Windows 路径行为。
- `.trellis/spec/backend/architecture-and-runtime.md`：已有未提交改动，合并时必须保留。

## Rollback Points

- logger 模块和测试可整体移除。
- `server/index.js` 接线可恢复到全部使用 `console`。
- `server/database.js` 的 logger 参数向后兼容，可独立回滚。
- 不涉及数据库迁移和 API 契约，无需数据回滚。

## Start Gate

- [x] 用户确认 `5 MiB × 5` 保留策略。
- [x] PRD、设计和实施计划审阅通过。
- [x] 用户明确批准最新规划摘要并授权 `task.py start`。
- [x] `implement.jsonl` 和 `check.jsonl` 含真实规格条目。
