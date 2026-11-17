# 解耦归档索引刷新信号与全局任务索引版本

## 背景

用户在客户端打开「归档索引」页面时，列表不停地闪刷、并把用户翻回第 1 页；当时有一个刚接入的项目正在同步中。

排查结论（已在当前 HEAD `9fec7b4` 上复核，问题仍存在）：

1. 服务端每次投影（`replaceIndexInTransaction`）无条件递增全局 `app_meta.queryRevision`，即使 `changedKeys.size === 0`：`packages/server/team/task-space-index.js:981`。
2. 每次递增立即广播：`packages/server/team/http.js:1769` `onQueryRevisionChanged: (revision) => boardEvents.publish({ revision })`；50ms 合并窗口只做节流，同步期间仍持续触发。
3. 客户端状态接口 etag 含 `queryRevision`：`packages/server/team/http.js:271-279`；事件到达后 `packages/web/src/hooks/useBoard.ts` 重新拉取 `loadTeamStatus()`，`setTeamStatus` 触发下游重渲染。
4. 归档页把全局版本当作刷新信号：`packages/web/src/pages/board/BoardPage.tsx:128-132`（`archiveRevision = controller.teamStatus?.queryRevision`）→ `packages/web/src/features/board/ArchiveView.tsx:85` → `useArchiveTasks`。
5. `useArchiveTasks` 版本一变即硬重置：`packages/web/src/hooks/useArchiveTasks.ts:64-66`（`setPage(null)`）与 `:99-101`（`setPageIndex(0)` + `loadPage(0, null, true)`），清空期间表格显示「正在加载归档任务」→ 肉眼可见的闪刷 + 页码复位。
6. 游标绑定全局版本：`packages/server/team/task-space-index.js:1500` `const revision = queryRevision()`、`:1647` `cursor.r !== revision`、`:1694` `encryptCursor({... r: revision ...})`；归档翻到第 2 页后任何活跃任务写入都会 409 `CURSOR_INVALID`，`useArchiveTasks.ts:82-87` 再踢回第 1 页。

本机库实测：`app_meta.queryRevision = 55`、`sync_task_index` 110 行中 107 行归档——单项目接入产生 55 波全局失效，绝大多数变更与归档无关。

新合入的 Git 归档同步（`packages/server/team/archive-git-sync.js`）只改了归档数据的来源（`sync_archive_file` + 每任务空间 `archive_revision`），没有改变失效信号：只要发生投影，全局 `queryRevision` 照旧推进，归档页照旧重拉。

## 目标

给「归档任务」建立独立的失效域：活跃任务同步不再让归档列表重拉、翻页复位；归档数据真变化时归档列表才刷新。

## 需求

1. 服务端维护归档域版本 `archiveQueryRevision`（`app_meta` 新键，缺省 0），仅在**归档行**发生变化时递增：
   - 新增/删除的索引行 `archived = 1`；
   - 已有行 `archived` 从 0 变 1（归档）或从 1 变 0（恢复）；
   - 归档行的其它可查询字段变化（标题、负责人、阶段、标签等）。
   仅活跃行变化时不得递增。
2. 归档查询（`queryTasks` 带 `archived: true`）的 etag、缓存键、游标版本一律使用 `archiveQueryRevision`；活跃查询保持使用全局 `queryRevision`。
3. 状态接口下发归档域版本：团队模式 `packages/server/team/board.js` 与单机 gitless 模式 `packages/server/team/gitless-board-service.js` 的 status 增加 `archiveRevision` 字段；`statusEtag`（`packages/server/team/http.js:271`）纳入该字段，使归档变化能触发一次状态重取、活跃变化则不改变归档版本。
4. 客户端归档页优先使用 `teamStatus.archiveRevision`，缺失时回退 `teamStatus.queryRevision`（兼容未升级的服务端）：`packages/web/src/pages/board/BoardPage.tsx:128-132`。
5. 全局 `queryRevision` 现有语义保持不变（每次投影照旧推进并广播），本次不收缩活跃看板的失效范围。

## 验收标准

- [ ] 仅活跃任务内容变化并投影后：`archiveQueryRevision` 不变；归档查询 etag 不变；归档第 2 页游标仍可用（不再 409）。
- [ ] 归档任务内容变化（含新归档/恢复归档/归档行字段变化）并投影后：`archiveQueryRevision` 递增；归档查询 etag 变化；旧归档游标返回 409 `CURSOR_INVALID`。
- [ ] 无索引行变化的投影不递增 `archiveQueryRevision`。
- [ ] status 响应与 etag 含 `archiveRevision`；归档变化会改变 status etag，纯活跃变化不因归档版本改变 etag（`queryRevision` 变化仍会改，属既有行为）。
- [ ] 客户端归档页在活跃任务同步期间不再清空重拉、不再跳回第 1 页；归档数据真变化时才刷新。
- [ ] 新增/更新的服务端测试在 `packages/server/test/team-task-index-v10.test.js` 覆盖上述前三条。

## 不在范围

- 活跃看板自身的分页游标在同步期间被重置（同一游标设计问题的另一半）。
- `shouldReloadTasks`（`packages/web/src/lib/team-client.js:559`）死代码清理。
- Git 归档同步（`archive-git-sync.js`）本身的调度与增量策略。
