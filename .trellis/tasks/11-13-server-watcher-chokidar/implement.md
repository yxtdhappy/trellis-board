# 实施计划: server watcher 换 chokidar

## 步骤

1. 根目录安装：`npm install chokidar@^6.0.0`。
2. 改写 `packages/shared/trellis-watcher.js`：
   - 保留 `WATCHED_TRELLIS_ROOTS`、`DEFAULT_RELEVANT_ROOTS`、`normalizeWatchPath`、`relevantPath`、`isRelevantTrellisChange`。
   - `createTrellisWatcher`：`rebuild` 异步化、`ready()`、`close()` 返回 Promise；事件映射与过滤保持不变。
3. 改 `apps/server/watcher.js`：`createWatchRuntime` 透传 `ready`，`close` 返回 Promise。
4. 改 `apps/server/index.js`：`startFileWatcher` 改 `async` 并 `await watchRuntime.ready()`；检查启动流程与退出流程的调用点（`SIGINT`/`SIGTERM`）。
5. 改 `apps/server/test/watcher.test.js`：`await runtime.rebuild([])`、假 watcher 的 `close()` 返回 Promise、新增「ready 前 status.enabled 为 false，ready 后为 true」断言。

## 验证

```bash
node --test apps/server/test/watcher.test.js
npm test
node apps/server/index.js &      # 冒烟：日志出现 watcher: enabled
# 在某个仓库写 .trellis/tasks/demo/task.json，观察日志出现「文件变更后自动刷新」
```

## 回滚点

单 commit；`trellis-watcher.js` 与两个调用点一起回滚。

## 完成标准

- A1–A5 满足；真实文件变更用例在 5 秒内完成，不 flaky（连续跑 3 次）。
