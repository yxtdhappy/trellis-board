# 实施计划

## 前置检查

- [ ] `git status` 干净、基于 `main` 最新（当前 `9fec7b4`）。
- [ ] 复核三处锚点未被改动：`packages/server/team/task-space-index.js:981`（`incrementQueryRevision({ publish: false })`）、`:1500`（`const revision = queryRevision()`）、`:1647`（`cursor.r !== revision`）、`packages/web/src/pages/board/BoardPage.tsx:128-132`。

## 步骤

### 1. 服务端版本读写（`packages/server/team/task-space-index.js`）

- [ ] 在 `queryRevision` / `incrementQueryRevision`（`:494-513`）旁新增 `archiveQueryRevision()` 与 `incrementArchiveQueryRevision()`，key 为 `archiveQueryRevision`。
- [ ] 在 `createTaskSpaceIndex` 的返回对象里导出 `archiveQueryRevision`（与 `queryRevision` 同处）。
- [ ] 在 `replaceIndexInTransaction` 的 `changedKeys` 循环（`:923-940`）维护 `archiveChanged`：
  - upsert 变化分支：`if (row.archived || previous?.archived) archiveChanged = true`；
  - delete 分支：`if (existingByKey.get(taskKey)?.archived) archiveChanged = true`。
  在 baseline 去重处加 `// ponytail: 归档版本只看归档行；baseline 身份碰撞若成问题，把 baseline 空间插入/删除的执行身份纳入 archiveChanged`。
- [ ] 事务返回（`:979-984`）增加 `archiveQueryRevision` 字段；无行变化时返回当前值（不递增）。

### 2. 归档查询绑定（`packages/server/team/task-space-index.js`）

- [ ] `queryTasks` 中 `:1500` 改为 `const revision = filters.archived ? archiveQueryRevision() : queryRevision()`；确认 etag（`:1508`）、`cacheKey`（`:1523`）、游标校验（`:1647`）、`encryptCursor`（`:1694`）、返回 `queryRevision`（`:1716`）全部沿用该变量，无需其它改动。

### 3. 状态与 etag（`packages/server/team/board.js`、`gitless-board-service.js`、`http.js`）

- [ ] `packages/server/team/board.js:506` 附近 status 返回体加 `archiveRevision: taskIndex.archiveQueryRevision()`。
- [ ] `packages/server/team/gitless-board-service.js:205` 同上（用其自身的 `taskSpaceIndex`）。
- [ ] `packages/server/team/http.js:271-279` `statusEtag` 的哈希对象加 `archiveRevision: status.archiveRevision`。

### 4. 客户端取值（`packages/web/src/pages/board/BoardPage.tsx`）

- [ ] `:128-132` 改为优先 `teamStatus.archiveRevision`（number/string 判定沿用现有写法），否则回退 `teamStatus.queryRevision`，仍无则 `null`。

### 5. 测试（`packages/server/test/team-task-index-v10.test.js`）

- [ ] 追加用例「归档查询版本与全局版本解耦」，按 design.md「测试策略」的 4 组断言实现。归档行注入复用 `:250-335` 用例的 `sync_archive_file` + `UPDATE sync_task_space SET archive_revision = 1` 写法。
- [ ] 归档游标需先有 ≥2 条归档行才能拿到 `nextCursor`（`limit: 1`）。

## 验证

```bash
node --test packages/server/test/team-task-index-v10.test.js
yarn test            # 全量：node --test "packages/*/test/*.test.js"
yarn workspace @trellis-board/web build   # tsc -b + vite（类型与构建）
yarn format && yarn workspace @trellis-board/web lint
```

手测：启动 `yarn dev`，打开客户端归档索引页并翻到第 2 页；对任一项目触发活跃任务同步（或在 agent 侧上传一批 task.json 变更），观察归档列表不再闪刷、页码不跳回 1；再让某个任务归档/恢复，确认归档列表此时才刷新。

## 回滚点

- 服务端三步与客户端一步互不依赖，可单独回退；`app_meta.archiveQueryRevision` 键保留无副作用。
- 若归档版本推进判定写错导致归档列表不刷新（最坏情况），临时把 `BoardPage` 取值回退到 `queryRevision` 即可恢复旧行为，无需回滚服务端。

## 提交

- 单个提交包含服务端、客户端、测试与本任务目录 `.trellis/tasks/11-17-decouple-archive-refresh-revision/`。
- 提交前向用户汇报变更范围与验证结果，取得明确提交确认后再执行。
