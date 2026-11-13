# PRD: server 日志换 pino

## 目标

`apps/server/logger.js`（187 行）里约 90 行是自写的缓冲、定时 flush、按大小轮转与文件降级逻辑。换成 `pino` + `pino-roll`，保留 `createServerLogger` 的对外签名与自由文本脱敏。

## 需求

- R1 `createServerLogger({ dataDir, console, maxBytes, maxFiles })` 保留 `dataDir`/`console`/`maxBytes`/`maxFiles`，返回 `{ log, info, warn, error, flush, close }` 不变，唯一调用点 `apps/server/index.js:980` 不改；`logFile`/`flushDelayMs`/`flushBytes`/`maxBufferBytes` 无调用方使用，随自写缓冲一起删除。
- R2 控制台输出行为不变：仍通过注入的 `consoleWriter` 打印原始参数（`logger.info('a %s', x)` → `consoleWriter.info('a %s', x)`），现有 3 条控制台断言保持通过。
- R3 文件输出改由 pino 负责：每行 JSON（`{"level":30,"time":"…","msg":"…"}`），时间戳 ISO 格式，不输出 `pid`/`hostname`（`base: null`）。
- R4 脱敏保持：`redactServerLogText` 原样保留，并在写入前作用于格式化后的消息（`formatMessage` + 脱敏 → 作为 `msg` 传给 pino），保证 `Bearer …`、URL 内嵌凭据、`key=value`、本地路径仍被替换。
- R5 轮转交给 `pino-roll`：`size: '5m'`、`limit: { count: 5 }`、`mkdir: true`；不再手写 `rotateIfNeeded`。
- R6 磁盘故障降级：pino-roll/sonic-boom 写入失败时不再拖住业务，失败一次后停用文件输出并向 `consoleWriter.error` 报告（沿用现有文案 `服务端日志文件写入失败，已降级为仅控制台输出`）。
- R7 `flush()` 与 `close()` 语义保持：`flush()` 返回 Promise（pino 的 `flush` 回调包装），`close()` 先停用新写入再 flush。
- R8 依赖 `pino@^10.4.0`、`pino-roll@^4.0.0` 声明在根 `package.json`。
- R9 更新 `README.md:95-96` 的日志路径与轮转说明；更新 `apps/server/test/server-logger.test.js`。

## 已知行为变化（需要确认）

1. **文件名**：pino-roll 会在文件名中插入轮转序号，`logs/server.log` 变为 `logs/server.1.log`、`logs/server.2.log`…（不再有固定的 `server.log`）。`serverLogFile(dataDir)` 改为 `serverLogDir(dataDir)`（返回 `logs/` 目录），导出变更仅影响本模块与测试。
2. **行格式**：文本 `<ISO> LEVEL msg` 变为 JSON 行。仓库内没有解析 `server.log` 的代码（仅 README 文档与测试断言），但外部脚本若 `grep " INFO "` 会失效。

## 非目标

- 不引入日志采集/远程上报。
- 不改日志级别控制（当前无 level 配置，保持全部输出）。
- 不把控制台输出也交给 pino。

## 约束

- 不得让日志写入异常影响请求处理（现有 `maxBufferBytes` 丢弃语义由 sonic-boom 的 `minLength` + 失败降级替代）。
- `npm test` 必须全绿，日志测试按新格式重写，不保留旧文本格式断言。

## 验收

- A1 `apps/server/logger.js` 行数 ≤ 120，且不含 `setTimeout`/`appendFile`/`rename`。
- A2 `grep -rn "serverLogFile" apps scripts README.md` 无结果（已改名）。
- A3 冒烟：启动 server 后 `<dataDir>/logs/` 下出现 `server.1.log`，内容为 JSON 行且 `msg` 为中文日志；触发一次错误请求后能读到 `level:50` 的行。
- A4 脱敏：日志里出现 `Bearer abc` / `C:\Users\x\y` 时，文件中分别为 `Bearer [REDACTED]` / `[本地路径]`。
- A5 `npm test` 全绿。
