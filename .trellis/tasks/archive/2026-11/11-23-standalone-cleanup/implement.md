# 实施记录：清理 standalone 残留

## 服务端

- `packages/server/index.js` 收敛为 Team-only：`startApplication(config = parseTeamConfig())`
  → `migrateLegacyRuntimeData()` → `createTeamRuntime()` → `runtime.start()` →
  `taskSpaceIndex.warmActive()`；删除 `startStandaloneServer` / `stopStandaloneServer` 导出。
- `packages/server/config.js`：`parseTeamConfig` 的 mode 默认且只接受 `team`，其他值直接抛
  `TRELLIS_BOARD_MODE 只能是 team`；删除 standalone 返回分支；`allowLocalGitRemotes` 默认 `false`。
- 删除 `packages/server/standalone/`（13 文件）与 `packages/server/test/standalone.test.js`。
- 保留 `repositories.js`、`actions.js`、`scan-worker.js`、`watcher.js`：前两者仍被插件任务服务引用；
  后两者已无调用方，按 PRD 范围暂不删除。

## 前端

- `hooks/useBoard.ts`：删除 `loadBoard`、`fetchBoard`、`teamMode` 分支、standalone runtime 回落；
  所有数据路径只走 `loadTeamPage` / `loadTeamStatus` / `loadTeamPreferences`。
- `hooks/useOwnershipInbox.ts`：删除 `teamMode` 参数与短路分支。
- `pages/board/BoardPage.tsx`：删除 `STANDALONE_PLUGIN_NAV`、`PluginsView`、`view === 'plugins'`
  回退逻辑；服务端插件只按 `runtime.features.pluginsEnabled` 判断；本机插件仍按 `isClient` 显示。
- `features/board/ArchiveView.tsx`：收敛为 Team 单路径（服务端搜索/负责人/分页/团队+项目筛选）。
- `CreateTaskDialog`、`TaskDetailDialog`、`task-control.js`：删除 `teamMode` 参数，命令状态只按
  taskSpace 的停用/只读判断。
- 删除 `features/plugins/PluginsView.tsx`（standalone 插件管理页）。

## 文档

- 更新 `README.md`、`docs/team-operations.md`、`.env.example`、`.trellis/spec/backend/*`、
  `.trellis/spec/frontend/rendering-and-state.md`、`.trellis/spec/guides/module-size-guide.md`，
  以及本机 `.worktree/.agent/docs/50-plugins.md`：standalone 代码已移除，`TRELLIS_BOARD_MODE`
  只接受 `team`，服务端插件固定关闭。

## 验证

- `node --test "packages/server/test/*.test.js"`（team worktree）→ 511 pass / 0 fail。
- `npx tsc -b packages/web` → 通过。
- `node --test packages/web/test/team-web.test.js` → 27 pass / 0 fail。
- `yarn workspace @trellis-board/web build` → 成功。
- 4402 `team.sh restart` 后 `/api/runtime` → `features.pluginsEnabled:false`。
- `TRELLIS_BOARD_MODE=standalone node packages/server/index.js` → 启动即报
  `TRELLIS_BOARD_MODE 只能是 team`。
- 4401 浏览器回归：导航无“插件”、有“本机插件”；本机插件页 6 项、WitOps 运行中；
  归档页团队/项目筛选、分页、行数据正常；任务流水线正常，控制台无错误。
