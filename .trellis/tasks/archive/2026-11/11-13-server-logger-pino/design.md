# 设计: server 日志换 pino

## 事实核对（pino 10.4.0 / pino-roll 4.0.0）

- `pino-roll` 默认导出是 `build(options) => SonicBoom`（可直接当 destination），也可作为 pino transport；本项目用**直接 destination**，避免 worker 线程与关闭时序问题。
- 文件名规则：`filename.date.count.extension`，date 段可省略 → `logs/server.1.log`、`logs/server.2.log`；`symlink: true` 会创建 `current.log` 软链，**Windows 需要开发者模式/管理员**，不采用。
- `limit.count`：保留的轮转文件数（不含活动文件）；`size` 支持 `'5m'`；`mkdir: true` 自动建目录。
- pino 10 的 `logger.flush(cb)` 对 destination 生效；`base: null` 去掉 pid/hostname；`timestamp: pino.stdTimeFunctions.isoTime`。

## 结构

```js
import pino from 'pino'
import pinoRoll from 'pino-roll'

export function createServerLogger({ dataDir, console: consoleWriter = console, maxBytes, maxFiles } = {}) {
  // 1) 控制台：保持原样（writeConsole）
  // 2) 文件：pino({ base: null, timestamp: isoTime, level: 'trace' }, pinoRoll({ file, size: '5m', limit: { count: 5 }, mkdir: true }))
  // 3) write(level, method, args): 控制台原样输出；文件侧 logger[method](redactServerLogText(formatMessage(args)))
  // 4) 失败降级：pinoRoll 创建或写入抛错时 disabled = true + reportFailure
}
```

- `formatMessage`（`node:util.formatWithOptions`）保留，负责把 `('a %s', x)` 变成一行文本；pino 只负责时间戳、级别与落盘。
- 级别映射：`log→30`、`info→30`、`warn→40`、`error→50`（pino 默认数值级别）。
- `flush()`：`new Promise((resolve, reject) => logger.flush((error) => error ? reject(error) : resolve()))`。
- `close()`：先置 `closed = true`（后续写入只走控制台），再 `flush()`；不再需要显式 `end()`（进程退出时 sonic-boom 自动 flush，`close()` 保证显式调用场景也落盘）。
- 删除：`buffer`/`bufferBytes`/`timer`/`scheduleFlush`/`rotateIfNeeded`/`append`/`pending` 链（约 90 行）。
- 保留：`serverLogDir`（原 `serverLogFile` 改语义）、`redactServerLogText` 全部正则、`formatMessage`、`reportFailure`/`writeConsole` 的异常吞噬。

## 风险

- **文件名与格式变更**（见 PRD「已知行为变化」）：`%LOCALAPPDATA%\TrellisBoard\server\logs\server.log` 不再存在。README 与测试必须同步，否则用户按文档找不到文件。
- `maxBufferBytes`（1 MiB 丢弃阈值）没有等价物：sonic-boom 在磁盘阻塞时自行排队，可能增长内存。保留 `minLength` 与失败降级作为兜底，并在 design 记录该差异；若磁盘长期阻塞，内存上限由 sonic-boom 内部缓冲决定（可接受，桌面场景）。
- pino 的 `level: 'trace'` 保证所有级别都写入；不再提供 level 配置，与现状一致。
