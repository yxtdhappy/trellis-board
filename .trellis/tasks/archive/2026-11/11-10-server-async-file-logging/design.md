# 服务端日志异步落盘设计

## 1. 架构边界

本任务只在服务端主进程增加日志文件 sink：

- HTTP、数据库扫描、文件监听和团队业务逻辑不感知文件写入。
- 现有 `console` 输出继续保留，开发和前台启动时仍能看到日志。
- 文件日志只记录服务端主进程及其注入 logger 的宿主组件。
- 插件子进程继续使用自身已有的 `server/plugins/<id>.log`，不合并到主日志。

日志文件固定为：

```text
<dataDir>/logs/server.log
```

Windows 默认路径为：

```text
%LOCALAPPDATA%\TrellisBoard\server\logs\server.log
```

不增加环境变量、数据库字段或 API。

## 2. 日志模块

新增 `server/logger.js`，导出：

```js
createServerLogger(options)
redactServerLogText(value)
serverLogFile(dataDir)
```

`createServerLogger()` 返回兼容 `log`、`info`、`warn`、`error` 的 logger，并提供内部测试和关闭所需的 `flush()`、`close()`。

### 2.1 异步写入

- 日志调用先同步转发到原控制台，再格式化并放入内存批次。
- 文件写入使用 `node:fs/promises.appendFile()`，日志调用点不等待 Promise。
- 单个批次达到 64 KiB 或等待 500 ms 时触发 flush。
- 多次 flush 通过 Promise 链串行执行，保证轮转与追加不会交叉。
- 内存缓冲上限为 1 MiB；磁盘长期阻塞时丢弃新增文件日志，不阻塞服务。
- 正常关闭时 flush 当前缓冲并等待所有已排队写入完成。

不采用全局替换 `console`，因为现有依赖已经支持显式注入 `logger`。入口只负责创建 logger 并向下传递。

### 2.2 文件格式与安全

每条日志格式为：

```text
<ISO-8601> <LEVEL> <message>
```

对象和 Error 使用 `node:util.formatWithOptions()` 展开；换行转换为字面量 `\n`，保证每条调用对应一行文件记录。

写文件前执行统一脱敏：

- Bearer token。
- URL 中的账号密码。
- `authorization`、`cookie`、`set-cookie`、`session`、`apiKey`、`password`、`pairingCode`、`credential`、`token`、`secret` 等键值。
- Windows 本地绝对路径和 UNC 路径。

控制台仍接收原始参数，保持现有开发体验；敏感信息不得写入日志文件。

### 2.3 轮转与失败降级

- 当前文件加 4 个历史文件，共 5 个。
- 单文件上限 5 MiB。
- flush 前根据现有文件大小和本批字节数决定是否轮转。
- 轮转顺序为 `server.log -> server.log.1 -> ... -> server.log.4`，最旧文件被替换。
- 目录使用 `0o700`、文件使用 `0o600` 创建；Windows 上由 ACL 继承控制。
- 任一目录创建、轮转或追加失败时，向原控制台报告一次，并停用文件 sink；服务继续运行。

## 3. 服务端接入

### 3.1 启动入口

`server/index.js` 主入口在调用 `startApplication()` 前创建 logger。

`startApplication(config, logger)` 将 logger：

- team 模式传给 `createTeamRuntime({ config, logger })`；
- standalone 模式传给 `startStandaloneServer({ ..., logger })`。

直接导入函数的测试和调用方继续使用 `console` 默认值，不强制创建文件。

### 3.2 standalone

- `startStandaloneServer()` 将 logger 保存为当前运行实例的模块级 logger。
- `initializeStandaloneState()` 将 logger 传给 `getDefaultDatabase()`。
- 文件 watcher、插件宿主、后台刷新、HTTP 异常和关闭错误统一使用该 logger。
- `getDefaultDatabase()` 增加可选 `{ logger = console }`，不改变无参数调用行为。

### 3.3 team

`createTeamRuntime()` 及其下层已提供统一 `logger` 注入，不在团队业务模块内重复增加文件逻辑。团队模式启动、请求 500、定时拉取和项目恢复错误自动进入同一 sink。

## 4. 关闭流程

正常退出顺序：

1. 收到 `SIGINT` 或 `SIGTERM`。
2. 停止当前 runtime。
3. 等待 logger flush 和所有排队写入完成。
4. 设置退出码并退出进程。

启动失败时先记录错误，再关闭 logger。重复信号由现有 `stopping` 状态和 logger 的幂等 close 处理。

强制终止、断电或系统崩溃不保证最后一批日志落盘，这是异步日志的明确边界。

## 5. 兼容与回滚

- 不修改数据库 schema、任务文件、API 或前端。
- 不读取或迁移现有日志。
- 无日志目录时在首次 flush 自动创建。
- 回滚只需移除 logger 接入和 `server/logger.js`；已生成的日志文件可独立保留或清理。
- 当前工作区已有无关改动，尤其 `server/team/http.js` 和 spec 文件；实现时不得覆盖其现有内容。

## 6. 验证策略

自动化测试新增 `tests/server-logger.test.js`，覆盖：

- 调用后不等待磁盘，close 后内容出现。
- 双写控制台。
- 敏感值和本地路径脱敏。
- 5 MiB × 5 的可缩小等价轮转配置。
- 写入失败停止文件 sink 且服务不抛错。
- flush/close 不丢已排队内容。

真实启动验证使用独立临时数据目录和非默认端口，分别覆盖 standalone 与 team：

- 启动后产生 `logs/server.log`。
- 发出真实 HTTP 请求后能够看到对应日志。
- 正常终止后文件存在且可读。
- 不停止用户当前运行在 4317 的实例。
