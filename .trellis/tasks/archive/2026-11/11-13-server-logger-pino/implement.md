# 实施计划: server 日志换 pino

## 步骤

1. 根目录安装：`npm install pino@^10.4.0 pino-roll@^4.0.0`。
2. 改写 `apps/server/logger.js`：
   - `serverLogFile` → `serverLogDir(dataDir)`（返回 `path.join(dataDir, 'logs')`）。
   - `createServerLogger` 内部改为 pino + pino-roll；保留 `redactServerLogText`、`formatMessage`、`reportFailure`、`writeConsole`。
   - `write(level, method, args)`：控制台原样 + 文件 `logger[method](redacted)`。
   - `flush`/`close` 按 design.md 实现。
3. 更新调用点：`grep -rn "serverLogFile" apps scripts README.md`，逐个替换为 `serverLogDir` 或目录语义。
4. 重写 `apps/server/test/server-logger.test.js`：
   - 控制台断言保留（3 条）。
   - 文件断言改为：读 `logs/` 目录下最新文件，`JSON.parse` 每行，校验 `level`/`msg`/时间戳格式。
   - 轮转断言：用小 `size`（如 `'1k'`）写入多条，断言目录中文件数不超过 `limit.count + 1`。
   - 脱敏断言：`msg` 中 `Bearer [REDACTED]`、`[本地路径]`。
   - `close()` 后仍能读到已写内容。
5. 更新 `README.md:95-96`：路径改为 `<运行数据目录>/logs/server.<n>.log`，说明 JSON 行与 5 MiB × 5 轮转。

## 验证

```bash
node --test apps/server/test/server-logger.test.js
npm test
node apps/server/index.js &                 # 冒烟
ls "$LOCALAPPDATA/TrellisBoard/server/logs"  # 出现 server.1.log
tail -3 "$LOCALAPPDATA/TrellisBoard/server/logs/server.1.log"   # JSON 行
curl -s -o /dev/null -X POST http://127.0.0.1:4317/api/board   # 触发错误日志
```

## 回滚点

单 commit；`logger.js` 是唯一写入点，回滚即恢复文本格式与固定文件名。

## 完成标准

- A1–A5 满足；`npm test` 中日志相关用例全部按新格式通过。
