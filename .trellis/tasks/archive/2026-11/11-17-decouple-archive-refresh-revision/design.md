# 设计：归档域失效版本

## 核心决策

新增**归档域失效版本**，与全局查询版本并列：

| | 全局 | 归档域 |
|---|---|---|
| 存储 | `app_meta.queryRevision`（既有） | `app_meta.archiveQueryRevision`（新增） |
| 递增时机 | 每次投影事务提交（保持既有语义） | 仅当本次投影有**归档行**变化 |
| 使用方 | 活跃看板查询 etag / 缓存 / 游标 | 归档查询（`archived: true`）etag / 缓存 / 游标；归档页刷新信号 |

选择「新增独立版本」而不是「按任务空间暴露版本集合」：归档视图是跨项目、跨任务空间的聚合查询，客户端无权也无必要感知每个空间的内部版本；一个全局归档版本已经足够精确（只在归档数据真变时变化），且无需额外迁移与聚合协议。

### 为什么不用每空间 `archive_revision`

`sync_task_space.archive_revision` 是同步侧的**输入**版本（Git 归档是否变了），它变化后仍可能投影出零行变化（例如内容变了但字段未变）。归档域版本放在投影输出的出口，语义是「查询结果可能变了」，直接对应用户可见行为。

## 服务端契约

### 1. 版本读写（`packages/server/team/task-space-index.js`）

```js
function archiveQueryRevision() {
  return Number(
    db.prepare("SELECT value FROM app_meta WHERE key = 'archiveQueryRevision'").get()?.value || 0,
  )
}

function incrementArchiveQueryRevision() {
  // 与 incrementQueryRevision 同构的 UPSERT，仅换 key
}
```

缺省 0，`app_meta` 是通用键值表，无需 schema 迁移；老库首启即按 0 读。

### 2. 归档变更判定（`replaceIndexInTransaction`）

在现有 `changedKeys` 循环中同步维护布尔量 `archiveChanged`：

- upsert 分支：`if (row.archived || previous?.archived) archiveChanged = true`（覆盖归档、恢复归档、归档行字段变化）；
- delete 分支：`if (existingByKey.get(taskKey)?.archived) archiveChanged = true`。

事务尾部：

```js
return {
  queryRevision: incrementQueryRevision({ publish: false }),
  archiveQueryRevision: archiveChanged ? incrementArchiveQueryRevision() : archiveQueryRevision(),
  changedIndexCount: changedKeys.size,
}
```

广播不需要新通道：投影成功后已有 `onQueryRevisionChanged?.(result.queryRevision)`（`packages/server/team/task-space-index.js:1222`）会触发 `tasks.changed`，客户端拿到事件后重取 status，status etag 因 `archiveRevision` 变化而不同 → 归档页收到新版本。活跃变化时 status etag 里的 `queryRevision` 仍会变，活跃看板行为不变。

导出 `archiveQueryRevision` 到 index 的公共 API（与 `queryRevision` 并列）。

### 3. 归档查询绑定归档版本（`queryTasks`）

```js
const revision = filters.archived ? archiveQueryRevision() : queryRevision()
```

该 `revision` 同时进入 etag、`cacheKey`、游标 `r`、游标校验、返回值 `queryRevision`，因此：

- 活跃任务变化 → 归档 etag / 缓存 / 游标全部不受影响，第 2 页以后不再 409；
- 归档任务变化 → 归档 etag 变化、缓存失效、旧归档游标 409（与现有语义一致）；
- 返回的 `queryRevision` 对归档查询表示「该页绑定的归档版本」。客户端未消费该字段（`packages/web/src/lib/team-client.js` 的 `shouldReloadTasks` 是死代码），无兼容风险。

### 4. 状态接口（`packages/server/team/board.js:506`、`packages/server/team/gitless-board-service.js:205`、`packages/server/team/http.js:271`）

- status 响应增加 `archiveRevision: taskIndex.archiveQueryRevision()`；
- `statusEtag` 的哈希输入增加 `archiveRevision`。

单机 gitless 模式同构补齐，避免两种模式 status 形状分叉。

## 客户端契约

`packages/web/src/pages/board/BoardPage.tsx:128-132`：归档页失效版本优先取 `controller.teamStatus.archiveRevision`，缺失（旧服务端）回退 `controller.teamStatus.queryRevision`。`ArchiveView` 的 `queryRevision` prop 语义变为「归档失效版本」，名称保持不变以缩小 diff。

`useArchiveTasks` 无需改动：revision 变少只意味着重置次数变少，硬重置与 409 兜底逻辑保持原样。

## 兼容与回滚

- 服务端先行、客户端后行：旧客户端仍读 `queryRevision`，行为与今天一致；新客户端读不到 `archiveRevision` 时回退，也不会坏。
- 回滚：删除 status 字段与客户端回退即可；`app_meta` 里多出的键无副作用。
- 多实例一致性：`app_meta` 在共享 SQLite 内，与既有 `queryRevision` 同一机制。

## 已知边界（有意从简）

1. 归档查询的 `projectSyncStatus` / `syncError` 来自任务空间行而非索引行，任务空间同步状态变化不会推进归档版本。`ArchiveView` 未渲染这些字段，影响为零；若将来归档页展示同步状态，需要把它们纳入归档版本判定。
2. 归档查询里的 baseline 去重子查询（`task-space-index.js:1529-1545`，排除在 baseline 空间已有同执行身份的任务）依赖 baseline 空间的活跃行。仅当「baseline 空间新增/删除某个执行身份，且其它空间存在同身份归档行」时归档结果会变而版本不推进；这种身份碰撞只在跨分支重复任务上出现，且下一次归档变化即自愈。`ponytail:` 在代码处标注该上限与升级路径（把 baseline 身份集合变化纳入 `archiveChanged` 判定）。
3. 归档行的 `assignee_user_id` 由项目成员映射派生，成员增删只推进全局版本、不推进归档版本。归档任务不可改派、`ArchiveView` 只按 `assignee`（Trellis dev id）筛选，因此不影响展示；若将来按成员维度过滤归档，需要把成员映射变化纳入归档版本。
4. 活跃看板游标在同步期间被重置的问题不在本次范围。

## 测试策略

在 `packages/server/test/team-task-index-v10.test.js` 追加一个用例（复用 `setup()` + `files()` + `sync_archive_file` 注入模式，参考现有「归档任务」用例 `:250-335`）：

1. 初始投影（1 活跃 + 1 归档），记录 `archiveQueryRevision()`、归档 etag、归档第 1 页游标（`limit: 1` 拿到 nextCursor）。
2. 仅修改活跃任务的 `task.json` 并投影：
   - `queryRevision()` 递增；
   - `archiveQueryRevision()` 不变；
   - 归档 etag 不变；
   - 用旧归档游标查询**成功**（不再 409）。
3. 修改归档行（重写 `sync_archive_file` 的 `task.json` 内容 + 递增 `archive_revision`）并投影：
   - `archiveQueryRevision()` 递增；
   - 归档 etag 变化；
   - 旧归档游标返回 409 `CURSOR_INVALID`。
4. 无行变化的投影（重复 materialize 同版本）不递增 `archiveQueryRevision`。

客户端改动为 6 行取值逻辑，用 `tsc -b`（web build 的一部分）验证类型；UI 行为通过重启开发服务手测归档页在活跃同步期间不重置。
