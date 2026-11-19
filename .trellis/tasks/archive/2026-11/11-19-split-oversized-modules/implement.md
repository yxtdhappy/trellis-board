# 拆分 server/web 过大代码文件 — 执行计划

前置：本文件在 PRD 与 design.md 获批后执行。批次按顺序做；每批完成即验证并单独提交，验证不过不外溢到下一批。

## 通用步骤（每批都做）

1. 读 spec：`.trellis/spec/backend/architecture-and-runtime.md`、`.trellis/spec/backend/quality-guidelines.md`；web 批次加 `.trellis/spec/frontend/index.md`、`directory-structure.md`、`quality-guidelines.md`。
2. `rg` 复核待移动符号的 importer 清单，与 design.md 表对照；有变化先更新 design.md。
3. 移动代码（只移动 + 调整 import/export），原路径 re-export。
4. 更新受影响的文本断言测试（仅 `packages/server/test/team-static.test.js`，且按真实新结构改）。
5. `yarn format`（oxfmt）后跑验证命令。
6. 记录行数：`wc -l` 确认每个文件 ≤ 目标线。
7. 提交（需用户确认）：`refactor(server|web): split <原文件>`；任务目录 `.trellis/tasks/11-19-split-oversized-modules/` 一并入库。

## B0 — 删除无引用 legacy 栈（可选，依赖 D1 决策）

- [ ] 复核 7 个文件仍无生产引用（`rg "team/(board|task-writes|live-sync|agents|git-manager|git-credentials|projects)\.js" packages plugins`）。
- [ ] 确认 `11-17-multi-client-task-sync-control-plane` 未改动这些文件（`git log`、任务目录）。
- [ ] 逐个评估 3 个引用它们的测试：把仍有效的断言改到 `sync-agent-service.js` / `gitless-board-service.js`，其余删除。
- [ ] 删除 7 个文件。
- [ ] 验证：`yarn test`；`rg` 无残留 import。
- [ ] 预期：server 源码减少 8,048 行，超过 800 行的文件从 19 降到 14。

## B1 — 纯机械拆分

### B1-a `database.js`

- [ ] 抽 `database-sql.js`：全部 `SCHEMA_V*_SQL`、`BASE_SCHEMA_V1_SQL`、`rebuildTaskCommandTableForV16`。
- [ ] 抽 `database-meta.js`：`readLegacyJson`、`readMeta`、`writeMeta`、`errorMessage`。
- [ ] 抽 `database-migrations.js`：`ensureV2..V17`、`hasColumn`、`tableExists`、`backupBeforeUpgrade`，导出 `runMigrations(db, { databaseFile })` 保持 `ensureSchema` 的单事务与调用顺序。
- [ ] 抽 `database-legacy-import.js`：`importRepositories/importManualStages/importScanCache/importBoardState/importLegacyData`。
- [ ] `database.js` 保留 `DATABASE_SCHEMA_VERSION`、`withTransaction`、`openDatabase`、`getDefaultDatabase`、`defaultDatabase` 单例。
- [ ] 验证：`yarn test`；`packages/server/test/database*.test.js`、`data-migration.test.js` 必须全绿。

### B1-b `execution-store.js`

- [ ] 抽 `execution-normalize.js`（常量 + `normalizeTags`/`normalizeSavedViewFilter` 等）。
- [ ] 抽 `execution-reads.js`（`readTaskDependencies`/`createBlockedByGraph`/`findBlockedByPath`/`readPlan`/`readExecutionMap`/`readExecutionEvents*`/`readExecutionDetail`/`purgeProjectExecutionData`/`appendTaskEvent`）。
- [ ] `execution-store.js` 只留 `createExecutionStore` 工厂与 re-export。
- [ ] 验证：`yarn test`（`execution-*.test.js`、`scan-commit.test.js`、`metadata.test.js`）。

### B1-c `loader.js`

- [ ] 抽 `loader-stage.js`（证据启发式 + `deriveCurrentStageFromStages` + `inferDerivedStage`，导出 `STAGE_ORDER`/`STAGE_META`）。
- [ ] 抽 `loader-groups.js`（`normalizePath`/`archivePathVariants`/`resolveTaskReference`/`flattenReferences`/`collectRelationshipCandidates`/`applyGroupProgress`/`linkTaskGroups`）。
- [ ] 抽 `loader-cache.js`（缓存 Map、`TASK_CACHE_FILES`、signature 与 `clearScanCaches`）。
- [ ] 抽 `loader-git.js`（`latestCommit`/`readGitHead`/`readGitMetadata` 及缓存）。
- [ ] `loader.js` 保留 `scanRepository/scanTask/refreshCachedTask/buildTask/collectTaskDirs/buildArtifactSummary/toTaskListItem/withManualStages/mergeTaskDetail` + re-export。
- [ ] 验证：`yarn test`（`loader.test.js`、`task-location.test.js`、`team-task-index-v10.test.js`）。

### B1-d `plugins/supervisor.js`

- [ ] 抽 `plugins/config.js`（`nowIso`/`redactValue`/`redactConfig`/`configSignature`/`loadPluginConfigFile`）。
- [ ] 抽 `plugins/log-ring.js`（`createLogRing`/`rotateLogFile`）。
- [ ] 抽 `plugins/plugin-process.js`（`PluginProcess`）。
- [ ] 删除死 re-export `createFrameDecoder/RPC`。
- [ ] 验证：`yarn test:plugins` + `yarn test`（`plugin-*.test.js`）。

### B1-e web `api/admin.ts`

- [ ] 建 `src/api/admin/`：`types.ts`、`readers.ts`、`users.ts`、`teams.ts`、`members.ts`、`devices.ts`、`project-teams.ts`、`audit.ts`、`archive-sync.ts`、`runtime.ts`。
- [ ] `src/api/admin.ts` 改为 barrel；`AdminView` 用 `export type`。
- [ ] 验证：`yarn workspace @trellis-board/web build`、`lint`、`yarn test`。

### B1-f web `lib/team-client.js`

- [ ] 抽 `lib/team-normalize.js`、`lib/task-control.js`、`lib/team-query.js`、`lib/redact.js`、`lib/safe-return-to.js`，各配 `.d.ts`（签名逐字照搬，不顺手修正）。
- [ ] `team-client.js`/`.d.ts` 保留为 barrel，`web/test/team-web.test.js` 24 个符号仍可解析。
- [ ] 验证：`yarn workspace @trellis-board/web build`、`lint`、`yarn test`。

## B2 — team 服务拆分

### B2-a `team/task-control-service.js`

- [ ] `team/task-control/shared.js`（纯 helper + `createStatements(db)` 预编译语句唯一来源）。
- [ ] `leases.js`、`tasks.js`、`uploads.js`、`views.js`、`projection.js`、`handoff.js`。
- [ ] 保留租约不变量：`activeLease`/过期/归档撤销、`ackHandoff` 幂等与 `HANDOFF_ACK_MISMATCH` 错误码、`assertUploadAllowed` 的错误码文本。
- [ ] 验证：`yarn test`（`team-task-control.test.js`、`team-task-commands.test.js`、`team-task-index-v10.test.js`）。

### B2-b `team/task-snapshot-service.js`

- [ ] `team/snapshot/{shared,archive-files,views,ownership,batch,apply,conflicts}.js`。
- [ ] `applyChangesInternal` 的事务体（幂等、`clientSequence`、CAS、revision bump、audit、`onRevisionCommitted`）保持在同一文件同一事务。
- [ ] `purgeArchivedTaskFiles` 继续从 `task-snapshot-service.js` re-export（`archive-git-sync.js` 依赖）。
- [ ] 验证：`yarn test`（`team-task-snapshot.test.js`、`task-ownership-inbox.test.js`、`team-task-control.test.js`）。

### B2-c `team/task-space-service.js`

- [ ] `team/task-space/{view,access,attach,lifecycle,bindings,membership}.js`。
- [ ] `detachAgent`、`listenerDetails` 移动后同批更新 `packages/server/test/team-static.test.js`。
- [ ] `purgeTaskSpace` 的 backup → audit → delete → `onTaskSpacePurged` 顺序与错误吞并语义不变。
- [ ] 验证：`yarn test`（`team-task-spaces.test.js`、`team-task-control.test.js`、`archive-*.test.js`）。

### B2-d 可选：`archive-git-sync.js` / `gitless-board-service.js` / `agent-events.js`

- [ ] 仅在 B2-a~c 完成后仍想继续降行数时执行；各自的 `yarn test` 子集同上。

## B3 — team 路由与索引

### B3-a `team/http.js`

- [ ] 抽 `team/http/common.js`：199-477 的纯 helper（守卫、解析、分页、静态资源），并把 `MAX_JSON_BYTES`/`MAX_LIVE_BATCH_BYTES`/`readJsonBody` 移入后从 `http.js` re-export。
- [ ] 抽 `team/http/actor.js`（`readActor`/`runtimePayload`/`requireActor`/`templateIdentity`）。
- [ ] 抽 `team/http/{template,agent,auth,admin,project,task,team}-routes.js`，统一 `(request, response, ctx)`。
- [ ] `http.js` 保留路径常量（`serverDir/appRoot/defaultPublicDir/pluginUiDir`）、`dispatch`、`createRefreshScheduler`、`createTeamRuntime`、re-export，目标 ≤600 行。
- [ ] 同批更新 `packages/server/test/team-static.test.js` 的 import 名与路由字符串断言。
- [ ] 验证：`yarn test`（10 个 `team-*.test.js` 调用 `createTeamRuntime`）。

### B3-b `team/task-space-index.js`

- [ ] 先抽纯逻辑：`team/task-index/projection-state.js`、`cursor-filters.js`（21-464，无状态依赖）。
- [ ] 再抽 `worker-client.js`（修正 `scan-worker.js` 相对路径）、`board-view.js`、`query.js`。
- [ ] 最后抽 `index-write.js`、`materialize.js`，`queryCache/revision/materialized/inflight/stopped` 作为单一 `state` 对象传入。
- [ ] `replaceIndexInTransaction` 的 `BEGIN IMMEDIATE` + revision/归档/手工阶段重校验保持在同一闭包。
- [ ] 验证：`yarn test`（`team-task-index-v10.test.js`、`archive-git-sync.test.js`、`archive-local-snapshot.test.js`）。

## B4 — web 组件拆分

### B4-a `LiveSyncControlDialog.tsx` / B4-b `TaskDetailDialog.tsx` / B4-c `ProjectOnboardingDialog.tsx` / B4-d `ProjectRail.tsx` / B4-e `useBoard.ts`

- [ ] 按 design.md 表逐文件抽；每次只动一个文件，抽完即验证。
- [ ] 断言改写（D2 已确认）：`packages/desktop/test/desktop-ui-build.test.js` 中 `ProjectRail`/`LiveSyncControlDialog`/`useBoard` 的读取路径改到拆分后的真实文件，断言内容仍验证同一行为（`10_000` 轮询、不含 `setInterval(...3_000)`/`setInterval(...750)`、`teamStatusEtag`、`filters.taskSpaceId === 'all'`）；禁止删除或放宽为空断言。
- [ ] 前置核对：改写前先 `sed -n '100,130p' packages/desktop/test/desktop-ui-build.test.js` 记录原断言，改写后逐条对照。
- [ ] 每文件验证：`yarn workspace @trellis-board/web build`、`lint`、`yarn test`（含 `packages/desktop/test/*`）。

## B5 — `index.js`（可选，最后）

- [ ] `standalone/state.js`（`createStandaloneState()` 单对象）、`standalone/folder-picker.js`、`standalone/scan-worker-bridge.js`、`standalone/routes.js`（`createStandaloneRouter(state)`）。
- [ ] `index.js` 保留路径/版本、`startStandaloneServer`/`stopStandaloneServer`/`startApplication`、CLI guard。
- [ ] 冒烟：`node packages/server/index.js` 后 `curl /api/health` 与 `/api/board`，再 `SIGINT` 退出。
- [ ] 验证：`yarn test`。

## B6 — 防回归：行数规则进 spec + 自动守卫

- [ ] 新增 `.trellis/spec/guides/module-size-guide.md`：server ≤800 / web `src` ≤700；拆分顺序；禁止压行/删注释达标；例外只登记在守卫 `EXCEPTIONS` 且只减不增。
- [ ] `.trellis/spec/guides/index.md`「何时阅读」表加一行（新增或修改任一源文件 → 本文），「快速触发条件」加一条（单文件接近阈值）。
- [ ] 新增 `packages/server/test/module-size.test.js`：`node:fs` + `node:path` 递归 `packages/server`（排除 `test/`、`node_modules`）与 `packages/web/src`（`.ts/.tsx/.js`），物理行数超限即 `assert` 失败，消息含文件、实际行数、上限与修复指引；`EXCEPTIONS` 常量表登记 B1–B5 后仍超限的文件（含原因）。
- [ ] 负向自检：临时把 `packages/web/src/lib/redact.js` 复制追加到超 700 行，确认 `yarn test` 因 `module-size.test.js` 失败，然后删除临时改动（实测一次即可）。
- [ ] 验证：`yarn test`。

## 收尾

- [ ] `yarn test:all` 全绿；`yarn workspace @trellis-board/web build` + `lint` 通过。
- [ ] 复核阈值：server 源码无 >800 行文件（若保留 B5 未做则 `index.js` 1,025 除外，需在 PRD 与 B6 `EXCEPTIONS` 中记录）。
- [ ] 更新 `.trellis/spec/backend/index.md`、`.trellis/spec/frontend/directory-structure.md` 的模块清单（新增子目录与 `api/admin/`）。
- [ ] 归档任务并记录会话。

## 回滚点

- 每批一个提交；B0 单独提交且最后执行或最先执行二选一（建议最先，便于后续批次基于干净基线）。
- 任一批次 `yarn test` 红：先在本批内修复；无法 30 分钟内收敛就 `git revert` 该批，记录原因后继续下一批。

## 执行结果（2026-11-19 实做，与上方清单的差异以本节为准）

| 批次 | 结论 | 验证 |
| --- | --- | --- |
| B0 删死代码 | 删除 `team/{board,task-writes,live-sync,agents,git-manager,git-credentials,projects}.js`（8,048 行）及 `team-sparse-onboarding.test.js`、`team-credentials.test.js`；新增 `test/team-process.test.js` 承接 `team/process.js` 的 2 个断言 | 全量测试通过 |
| B1 机械拆分 | `database.js` 2057→131（`database-sql/` 目录按 schema 版本 13 个文件 + `index.js`、`database-migrations.js`、`database-legacy-import.js`、`database-meta.js`、`database-transaction.js`）；`execution-store.js` 993→514（`execution-normalize.js`、`execution-reads.js`）；`loader.js` 1372→421（`loader-stage/groups/cache/git/fs.js`）；`plugins/supervisor.js` 2170→1868（`plugins/config.js`、`log-ring.js`、`plugin-process.js`）；web `api/admin.ts` 1024→52 barrel + `api/admin/*.ts` 10 个；`lib/team-client.js` 828→44 barrel + 5 个模块与 `.d.ts` | `yarn test:plugins` 113/114、server 全量、web build、oxfmt |
| B2 team 服务 | `task-control-service.js` 1235→44、`task-snapshot-service.js`→58、`task-space-service.js`→68，各自目录化（`team/task-control/*`、`team/snapshot/*`、`team/task-space/*`） | 相关 80 个测试 + 全量 |
| B3 http / 索引 | `team/http.js` 2122→576（`team/http/{common,context}.js` + 8 个 `routes/*.js`）；`team/task-space-index.js` 2004→759（`team/task-index/*.js`，4 个函数改为显式 `deps` 形参） | 全量 492/489 |
| B4 web 组件 | `TaskDetailDialog` 892→678、`ProjectOnboardingDialog` 867→690、`ProjectRail` 1296→533（`components/layout/project-rail/{types,StatusDot,association,ProjectEntry}.tsx`）、`useBoard` 862→674（`board-types.ts`、`useOwnershipInbox.ts`）、`LiveSyncControlDialog` 837→540（`desktop/live-control/*`）、`ArchiveSyncTab` 791→627 | web build、91 个 web 测试、oxlint |
| B2-d 剩余 server | `team/gitless-board-service.js` 894→773（`gitless-board-shared.js`、`gitless-board-assignments.js`）；`team/archive-git-sync.js` 1055→763（`archive-snapshot-import.js`、`archive-sync-utils.js`、`archive-git-test-credential.js`）；`team/agent-events.js` 983 行为死代码（全仓无引用，实际实现是 `agent-event-stream.js`），直接删除 | server 全量 493/490 |
| B5 index.js | `packages/server/index.js` 1025 → 49（只留 CLI bootstrap）：`standalone/{state,server,api,plugins,static,refresh,watcher,scan-worker,repositories,tasks,folder-picker,http-io,board-state}.js`；19 个模块级可变状态收成 `createStandaloneState()` 的单个 state 对象，全部函数改为显式 `state` 形参；新增 `packages/server/test/standalone.test.js`（启动/关闭、健康检查、看板、404/400 文案、插件 UI 资源） | server 全量 + 真实浏览器验证 |
| B6 规则 | 用户要求不加守卫测试：只保留 `.trellis/spec/guides/module-size-guide.md`（上限、例外只减不增、拆分方式、硬约束、自查命令）+ `guides/index.md` 入口 | 评审/自查 |
