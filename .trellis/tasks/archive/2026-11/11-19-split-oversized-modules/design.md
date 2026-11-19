# 拆分 server/web 过大代码文件 — 技术设计

## 总体策略

拆分只做三种动作：**移动代码到新文件**、**把模块级可变状态收拢成一个对象**、**删除无引用文件**。
不改函数体逻辑，不重命名对外导出，不引入抽象层（不做工厂包装、不做 DI 容器、不新增 barrel 之外的中间层）。

三条硬约束贯穿全部批次：

1. **导出契约不变**：`packages/server/test/*`、`packages/web/test/*`、`packages/test-support/*` 通过原路径 import 符号。被移走的符号仍在原文件 re-export（这是唯一允许的 re-export 场景）。
2. **`import.meta.url` 派生的路径必须重算**：`team/http.js` 的 `serverDir/appRoot/defaultPublicDir/pluginUiDir`、`task-space-index.js` 的 `new URL('./scan-worker.js', import.meta.url)`、`index.js` 的 `workerFile`。移到子目录后需要 `../` 或改为由上层注入；移动时必须逐处核对。
3. **文本断言测试要跟着真实结构改**：`packages/server/test/team-static.test.js` 断言 `http.js` 的 import 名与 `/task-spaces\/preflight/`、`/detach$/`、`/listeners$/`；`packages/desktop/test/desktop-ui-build.test.js` 断言 4 个 web 文件含特定 token。前者按新结构更新，后者默认不动（见「待确认决策」）。

## 决策（D2 已确认；D1/D3 按推荐执行）

| # | 决策 | 推荐 | 备选与代价 |
| --- | --- | --- | --- |
| D1 | 是否删除 8,048 行无生产引用的 legacy team 文件 | **删除**（B0）：零运行时风险，且避免后人误接旧栈 | 只拆分不删除：多 8k 行维护面，`git-manager.js`（1,775）与 `projects.js`（1,091）仍需按 L 难度拆分。风险：`11-17-multi-client-task-sync-control-plane` 任务在 `in_progress`，需确认其不改这些文件 |
| D2 | 是否允许改 `packages/desktop/test/desktop-ui-build.test.js` 的文本断言 | **已确认：允许改**。断言改为匹配拆分后真实文件，`ProjectRail.tsx` 的 10s 轮询 effect、`LiveSyncControlDialog` 的 `ControlEvent`/fallback、`useBoard` 的 `teamStatusEtag` 可移入子模块；`BoardPage.tsx` 的 4 个标记不涉及拆分，仍断言原文件 | 不改：token 必须留在原文件，三个文件各少降 100–150 行 |
| D3 | 拆分目标线 | server 单文件 ≤800、`http.js` 组装层 ≤600、web ≤700 | 更激进（≤500）需要二次按领域再拆，收益递减 |

## 模块约定

- server：无构建步骤、ESM、相对 import 带 `.js`。现有 `team/*` 一律是 `export function createXxx(deps)` 工厂 + 模块内私有 helper。拆分子模块保持工厂风格，子模块导出**纯函数或接收 `deps/state` 的工厂**，绝不在模块顶层创建连接、worker、server。
- 子目录名与领域同名：`team/task-control/`、`team/snapshot/`、`team/task-space/`、`team/http/`、`team/task-index/`。
- 共享可变状态必须作为**一个显式对象**传入子模块（`state`/`deps`），不得各模块各建一份 Map/计数器。
- web：组件按 `features/<domain>/<name>/` 或 `components/layout/<name>/` 建子目录；纯逻辑放 `features/<domain>/<name>.ts`；`lib/*` 必须是 `.js` + `.d.ts` 成对且无 DOM/Node 内置依赖。`api/admin.ts` 拆成 `api/admin/*` 后保留 `api/admin.ts` 作为唯一 barrel（`import * as admin` 的 3 个 hook 与 12 个组件依赖它）。
- 命名：组件 `PascalCase.tsx`、hook `useXxx.ts`、纯模块 `kebab-case`。

## 批次划分

顺序按「风险从低到高、每批可独立验证」排列。B0 与其他批次无依赖，可独立执行或跳过。

### B0 — 删除无引用 legacy 栈（决策 D1）

删除：`team/board.js`、`team/task-writes.js`、`team/live-sync.js`、`team/agents.js`、`team/git-manager.js`、`team/git-credentials.js`、`team/projects.js`。
同时删除或改写：`test/team-credentials.test.js`、`test/team-sparse-onboarding.test.js`、`test/team-error-diagnostics.test.js`（先确认三者是否覆盖仍在用的 `sync-agent-service.js` / `gitless-board-service.js` 行为，能保留的断言改到新模块上）。
验证：`yarn test`；`rg` 确认无残留 import。

### B1 — 纯机械拆分（server 4 + web 2）

| 原文件 | 拆分结果 | 风险 |
| --- | --- | --- |
| `database.js` 2,057 | `database-sql.js`（全部 `SCHEMA_V*_SQL` + `rebuildTaskCommandTableForV16`）、`database-migrations.js`（`ensureV2..V17` + `ensureSchema` 导出 `runMigrations(db, {databaseFile})` 保持单事务顺序）、`database-legacy-import.js`、`database-meta.js`（`readMeta/writeMeta/readLegacyJson`）；`database.js` 保留 `DATABASE_SCHEMA_VERSION`/`withTransaction`/`openDatabase`/`getDefaultDatabase` 与单例 | 中：`withTransaction` 被迁移与导入共用，必须留在叶子模块，禁止反向 import `database.js` |
| `execution-store.js` 993 | `execution-normalize.js`（常量 + normalizer）、`execution-reads.js`（`read*`/`rowTo*`/依赖图）；工厂留在原文件 | 低：读函数必须在 `withTransaction` 闭包内调用，模块内不得缓存 db |
| `loader.js` 1,372 | `loader-stage.js`（证据启发式 + `inferDerivedStage`，导出 `STAGE_ORDER/STAGE_META`）、`loader-groups.js`（`linkTaskGroups` 一族）、`loader-cache.js`（模块级缓存 Map + signature 函数）、`loader-git.js`（`git` 子进程读取）；`loader.js` 保留 `scanRepository/scanTask/buildTask/toTaskListItem/withManualStages/mergeTaskDetail` 与 re-export | 中：缓存 Map 只能存在一份；worker thread（`scan-worker.js`）会加载全部新模块 |
| `plugins/supervisor.js` 2,170 | `plugins/config.js`（`redactConfig`/`loadPluginConfigFile`/`configSignature`）、`plugins/log-ring.js`、`plugins/plugin-process.js`（`PluginProcess`）；顺带删除死 re-export `createFrameDecoder/RPC` | 中：`PluginSupervisor` 是单一状态机，只移出无 `this` 依赖的部分；不拆 `applyReload`/事件投递 |
| web `api/admin.ts` 1,024 | `api/admin/{types,readers,users,teams,members,devices,project-teams,audit,archive-sync,runtime}.ts` + `api/admin.ts` barrel | 低：类型无依赖；`readers.ts` 需 `lib/team-client.js` 的 `redactSensitiveDetail` |
| web `lib/team-client.js` 828 | `lib/team-normalize.js`、`lib/task-control.js`、`lib/team-query.js`、`lib/redact.js`、`lib/safe-return-to.js`，各自配 `.d.ts`；`team-client.js` 保留为 barrel | 低：`web/test/team-web.test.js` 从原路径 import 24 个符号；`.d.ts` 签名不得"顺手修正" |

### B2 — team 服务拆分

| 原文件 | 拆分结果 |
| --- | --- |
| `team/task-control-service.js` 1,235 | `team/task-control/{shared,leases,tasks,uploads,views,projection,handoff}.js`；预编译语句收进 `shared.createStatements(db)` 一份 |
| `team/task-snapshot-service.js` 1,462 | `team/snapshot/{shared,archive-files,views,ownership,batch,apply,conflicts}.js`；`applyChangesInternal` 的事务边界不得跨文件拆开 |
| `team/task-space-service.js` 1,662 | `team/task-space/{view,access,attach,lifecycle,bindings,membership}.js`；`detachAgent`/`listenerDetails` 移动后同步改 `team-static.test.js` |
| `team/archive-git-sync.js` 1,055、`team/gitless-board-service.js` 894、`team/agent-events.js` 983 | 视 B2 完成后的剩余收益决定是否纳入；三者低于 1,100 行，优先级最低 |

### B3 — team 路由与索引（高风险）

| 原文件 | 拆分结果 |
| --- | --- |
| `team/http.js` 2,122 | `team/http/common.js`（守卫/解析/分页/静态资源，`MAX_JSON_BYTES` 等）、`team/http/actor.js`、`team/http/{template,agent,auth,admin,project,task,team}-routes.js`；`http.js` 只保留常量、`dispatch`、`createRefreshScheduler`、`createTeamRuntime` 装配与 re-export，目标 ≤600 行 |
| `team/task-space-index.js` 2,004 | `team/task-index/{projection-state,cursor-filters,worker-client,board-view,index-write,materialize,query}.js`；`queryCache/revision/materialized/inflight/stopped` 作为单一 `state` 对象传递 |

约束：路由模块只能 import `common.js`，禁止 import `http.js`（循环）；handler 签名统一 `(request, response, ctx)`。

### B4 — web 组件拆分

| 文件 | 拆分结果 |
| --- | --- |
| `LiveSyncControlDialog.tsx` 837 | `desktop/live-control/{DiffViewer,ActionBar}.tsx` + `labels.ts`；`ControlEvent` 类型与 focus/10s fallback effect 移入 `live-control/control-event.ts` 与 shell，断言改写为指向新文件 |
| `TaskDetailDialog.tsx` 891 | `dialogs/task-detail/artifacts.ts` + `{DependenciesSection,ArtifactsSection,ArchiveFilesSection,PlanSection,TaskDetailFooter}.tsx`；`run()` 忙碌守卫留在 shell |
| `ProjectOnboardingDialog.tsx` 866 | `dialogs/project-onboarding/{types,normalizers}.ts` + `{PreflightPanel,PushStatusPanel}.tsx`；`Association` 与 `ProjectRail.LocalAssociation` 去重到 `types.ts` |
| `ProjectRail.tsx` 1,295 | `components/layout/project-rail/{association-view.ts,ProjectRow.tsx,ProjectRailDialogs.tsx,useProjectRailPolling.ts}`；Tauri 主 effect 留在 shell；10s 轮询与 `desktop-state-changed` 监听移入 `useProjectRailPolling.ts`，断言改写为 `/(10_000)/` 指向新文件且 shell 不再含 `setInterval(...3_000)` |
| `hooks/useBoard.ts` 861 | `hooks/board-types.ts`（5 个类型）+ `hooks/useOwnershipInbox.ts` + `hooks/board-team-status.ts`（`teamStatusEtag` 与 `filters.taskSpaceId === 'all'` 相关订阅）；断言改写指向新文件 |

断言改写规则：`packages/desktop/test/desktop-ui-build.test.js` 每处断言必须继续验证**同一个可观察行为**（10s 轮询、禁止 3s/750ms 轮询、ETag 使用、`all` 空间过滤），只把读取路径指向真实所在文件，禁止直接删除或弱化为空断言。


### B5 — `index.js` standalone 状态容器（可选，最后）

`packages/server/standalone/{state,scan-worker-bridge,routes,folder-picker}.js`，19 个模块级 `let` 收成 `createStandaloneState()` 单对象。
风险最高：`stopStandaloneServer` 依赖逐个置 `null` 的重启语义，`refreshBoardFromFiles` 的 SQLite 事务 + SSE 发布顺序不能跨文件拆散。
若 B1–B4 已达成目标线，可不做；做则单独一批并在完成后跑一次真实启动冒烟（`node packages/server/index.js` + `/api/health`）。

### B6 — 防回归：行数规则进 spec + 自动守卫

目的：让「新增功能不得再造巨型文件」成为可执行的规则，而不是只写在文档里的建议。两件事，同一批提交。

**1. 规则文档**：新增 `.trellis/spec/guides/module-size-guide.md`，并在 `.trellis/spec/guides/index.md` 的「何时阅读」表加一行（新增/修改任一源文件 → 本文），「快速触发条件」加一条（单文件接近阈值）。

规则内容：

- 源码单文件上限：`packages/server` **800** 行、`packages/web/src` **700** 行（物理行，含注释空行）。
- 超限的处理顺序：先按领域拆子目录（server 工厂函数 + `deps/state` 传参；web `features/<domain>/<name>/`），再考虑是否应删。禁止用压行、合并语句、删注释来"达标"。
- 例外：只允许写入守卫测试的 `EXCEPTIONS` 表，附原因与所属任务；例外不得新增，只能随拆分递减，`git diff` 里出现新增例外必须被 review 拒绝。
- 新文件应在创建时就按 800/700 预留拆点，避免"先写 1,500 行再拆"。

**2. 守卫测试**：`packages/server/test/module-size.test.js`（`yarn test` 的 glob 覆盖，一个文件同时守两个包）。

- 遍历 `packages/server/**/*.js`（排除 `test/`）与 `packages/web/src/**/*.{ts,tsx,js}`，统计物理行数。
- 超限即失败，消息含 `file: relative path`、实际行数、上限、以及「拆到子目录或登记例外」的修复指引。
- `EXCEPTIONS` 为相对路径 → `{ limit, reason }` 的常量表；B1–B5 完成后仍超限的文件（如跳过 B5 时的 `packages/server/index.js` 1,025）逐条登记，不得为新文件新增条目。
- 不扫描测试文件与 `node_modules`；不引入新依赖（`node:fs` + `node:path` 足够）。



## 兼容与回滚

- 每批是一个独立提交（B0 单独提交），失败按批 `git revert`，不牵连其他批次。
- 不涉及数据库 schema、HTTP 路由、协议字段，故无数据迁移与向后兼容成本。
- 死代码删除是唯一不可逆动作：B0 提交前用 `rg` 再确认一次无引用；若确认不了就跳过 B0（D1 选备选）。

## 验证命令

- server：`yarn test`（含 `packages/desktop/test/*`）、`yarn test:plugins`（仅 supervisor 批次）、收尾 `yarn test:all`。
- web：`yarn workspace @trellis-board/web build`、`yarn workspace @trellis-board/web lint`。
- 格式：`yarn format`（oxfmt）作用于改动文件。
- 结构检查：`rg -n "" <file> | wc -l` 复核行数达标；B6 起由 `packages/server/test/module-size.test.js` 自动守门。

## 已知风险清单

1. `task-space-index.js` 内部状态耦合最紧，拆错会导致查询缓存不失效/单飞失效——放最后，且只按 `state` 对象收拢后拆。
2. `plugins/supervisor.js` 的 `this.*` 面很宽，只移纯函数块；事件投递与 reload diff 保持原处。
3. `http.js` 路由搬迁会触发 `team-static.test.js` 文本断言，必须同批更新，否则本批验证无法通过。
4. `loader.js` 的 `linkTaskGroups` 输出形状被 `task-location.js` 与 `task-space-index.js` 直接消费，移动时保持一方向依赖。
5. `useBoard.ts` 子 hook 拆分改变 effect/memo 顺序，可能引入重复请求或请求循环——只做类型与 inbox 集群的最小拆分。
