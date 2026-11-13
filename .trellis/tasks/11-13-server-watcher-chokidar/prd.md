# PRD: server watcher 换 chokidar

## 目标

`packages/shared/trellis-watcher.js` 用 `fs.watch(..., { recursive: true })` 监听 `.trellis`，在 Windows/网络盘/大目录下有漏事件与句柄泄漏的已知边角。换成 `chokidar`，保留现有的过滤、防抖与状态契约。

## 需求

- R1 `createTrellisWatcher({ repositories, onChange, onError, debounceMs, roots })` 的入参保持；`watch` 注入参数保留（测试用假实现）。
- R2 保留导出与语义：`normalizeWatchPath`、`isRelevantTrellisChange`、`WATCHED_TRELLIS_ROOTS`、`createTrellisWatcher` 返回对象的 `watchedRepositories`/`status()`/`close()`。
- R3 `status()` 字段保持：`enabled`、`watchedRepositories`、`watchedRoots`、`eventsSeen`、`lastEvent`、`errors`。
- R4 事件对象字段保持：`repositoryId`、`repositoryName`、`eventType`、`relativePath`、`trellisPath`、`filePath`、`observedAt`。
- R5 `rebuild(repositories)` 改为返回 Promise（chokidar 的 `close()` 与 `add()` 都是异步）；新增 `ready()`，在所有 watcher 触发 `ready` 后 resolve。
- R6 `close()` 改为返回 Promise（`Promise.all(watchers.map(w => w.close()))`）。
- R7 `apps/server/watcher.js` 的 `createWatchRuntime` 透传 `ready`/异步 `rebuild`/异步 `close`；`apps/server/index.js` 的 `startFileWatcher` 改为 `async`，在 `await watchRuntime.ready()` 之后读取 `status()` 并写 `watcherEnabled`（当前同步读取会在 chokidar 就绪前得到 `enabled: false`）。
- R8 依赖 `chokidar@^6.0.0` 声明在 `packages/shared/package.json`（只有该包使用，按 spec 的单包依赖规则）。
- R9 更新 `apps/server/test/watcher.test.js`：`rebuild`/`close` 改 `await`；假 watcher 的 `close()` 返回 Promise；新增 ready 时序断言。

## 非目标

- 不改防抖批次语义（`debounceMs` 内合并为一次 `onChange(events)`）。
- 不改相关性过滤规则（`tasks`、`workspace`、`.developer`）。
- 不改 `refreshBoardFromFiles` 的触发链路。

## 约束

- `chokidar@6` 要求 Node ≥ 22.22，仓库 `engines.node` 为 `>=24`，满足。
- 不引入轮询（`usePolling` 默认 false），保持原生事件驱动。
- `.trellis` 目录不存在时跳过该仓库（现状），不报错。

## 验收

- A1 `packages/shared/trellis-watcher.js` 不再 import `node:fs`（改用 chokidar 判断存在性用 `fs.existsSync` 可保留，但 `watch` 调用消失）。
- A2 `grep -n "fs.watch" packages apps` 无结果。
- A3 `node --test apps/server/test/watcher.test.js` 全绿（含真实文件变更用例，5 秒超时内）。
- A4 冒烟：启动 server 并加入一个仓库，日志出现 `Trellis watcher: enabled, 1 repositories`；改一个 `tasks/.../task.json` 后 `/api/board` 返回新标题且 `/api/board/status` 的 `watcher.eventsSeen` 递增（成功刷新不写日志）。
- A5 `npm test` 全绿。
