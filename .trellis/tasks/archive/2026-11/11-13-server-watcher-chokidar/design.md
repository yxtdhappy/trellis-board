# 设计: server watcher 换 chokidar

## 事实核对（chokidar 6.0.0）

- 导出 `watch(paths, options)` 与 `FSWatcher`；`engines.node >= 22.22`。
- 选项：`persistent`、`ignoreInitial`、`followSymlinks`、`usePolling`、`depth`、`atomic`、`ignored`、`awaitWriteFinish`。
- 事件：`add`/`change`/`unlink`/`addDir`/`unlinkDir`/`all`/`error`/`ready`。
- `FSWatcher.close()` 返回 `Promise<void>`；`add()` 返回 watcher（同步链式），就绪信号是 `ready` 事件。
- v4 起移除 glob 支持，只接受路径；本项目本来就是按目录 watch，不受影响。

## 结构

```js
import { watch as chokidarWatch } from 'chokidar'

export function createTrellisWatcher({ repositories, onChange, onError = () => {}, watch = chokidarWatch, debounceMs = 0, roots = DEFAULT_RELEVANT_ROOTS }) {
  // rebuild(repos) => Promise<void>
  //   await closeWatchers(); 对每个 repo：watch(root, { ignoreInitial: true, persistent: true, depth: 20 })
  //   watcher.on('all', (eventName, filePath) => enqueue(...))
  //   watcher.on('error', (error) => record + onError)
  //   watcher.on('ready', resolve)
  // ready() => 最近一次 rebuild 的 Promise
  // close() => Promise<void>
}
```

- `relativePath` 由 `path.relative(root, filePath)` 后经 `normalizeWatchPath` 得到；过滤仍走 `isRelevantTrellisChange(relativePath, watchedRoots)`。
- `eventType` 直接用 chokidar 的事件名（`add`/`change`/`unlink`/`addDir`/`unlinkDir`）；仓库内没有按 `eventType` 分支的消费者（`grep eventType` 命中的是 `execution-history.js` 的另一套事件），契约放宽安全。
- `depth: 20` 防止误挂大目录；`.trellis` 下实际层级远小于此。
- 注入点 `watch` 保持：测试传 `(root, options) => ({ on(){}, close(){ return Promise.resolve() } })`。
- `enabled` 判定改为 `watchers.length > 0 && ready`；`status()` 在 ready 前返回 `enabled: false`（与现状一致，但 `startFileWatcher` 会 await ready 后再读）。

## 时序适配

`apps/server/index.js` 的 `startFileWatcher()` 当前同步调用后立即读 `status()` 写 `watcherEnabled`。改为：

```js
async function startFileWatcher() {
  watchRuntime = createWatchRuntime({...})
  await watchRuntime.ready()
  const status = watchRuntime.status()
  ...
}
```

调用点（启动流程）需要 `await` 或 `.catch(...)`，确保异常仍走现有 `activeLogger.error('启动 Trellis 文件监听失败', error)` 分支。

## 风险

- chokidar 初次扫描会遍历目录树（`ignoreInitial: true` 只抑制事件，不抑制扫描）；仓库 `.trellis` 目录规模小（任务目录数百个），可接受。
- Windows 上 chokidar 仍基于 `fs.watch`，但补了重命名/目录移动的合成事件，语义更稳。
- `close()` 异步化会让 `process.on('exit')` 路径无法 await；现有代码在 `SIGINT` 处理里调用，需改为 `await`（或在退出前 `void close()`）。
