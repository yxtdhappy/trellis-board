# PRD: 团队版插件部署屏蔽、前端入口收敛与多用户缓存隔离

- 所属父任务：`11-20-team-plugin-architecture-refactor`
- 阶段：Phase 1（优先止血）

## Goal

当 `trellis-board` 以团队模式（`TRELLIS_BOARD_MODE=team`）部署到服务器时，确保：

1. **生产服务器默认屏蔽全部插件**：未显式配置环境变量时，Team 服务端不装载、不启动任何插件子进程，也不暴露插件静态资源或面板；运维同时可通过 `TRELLIS_PLUGINS_DISABLED=1` 强行关闭或通过 `TRELLIS_TEAM_PLUGINS_ALLOWLIST` 按需显式放行。
2. **前端入口精确收敛**：移除团队模式下顶栏面向全员展示单机版 `<PluginsView />` 的错位入口；当插件被屏蔽/禁用时，管理页 `/admin.html` 同步隐藏「插件」Tab。
3. **显式放行时的多用户缓存隔离兜底**：修复 `plugins/witops-core` 在团队版单进程多用户模式下内存缓存未按用户隔离及模块级可变状态副作用，防止显式放行时跨用户串数据。

## Confirmed Facts（仓库实证）

- `packages/server/plugins/runtime.js:106` 支持 `TRELLIS_PLUGINS_DISABLED=1`，但 `packages/server/config.js:107-138` 的 `parseTeamConfig()` 与 `packages/server/team/http.js:456-470,514-521` 均未读取该开关。
- `packages/server/team/http/common.js:42` 硬编码 `export const TEAM_PLUGIN_ALLOWLIST = ['witops-core']`，导致 Team Server 启动默认拉起 `witops-core` 子进程。
- `packages/server/team/http.js:149-155` 允许未登录直接转发 `/api/plugins/:id/app/panel*` 静态资源，缺少插件关闭/屏蔽门禁。
- `packages/server/team/http/context.js:24-59` 的 `runtimePayload()` 通过 `/api/runtime`（`packages/server/team/http/routes/auth.js:19-25`）下发运行态信息，当前缺少 `features.pluginsEnabled`。
- `packages/web/src/pages/board/BoardPage.tsx:58-63,184-192,481` 在 `NAV` 中写死了 `{ id: 'plugins', label: '插件' }`，Team 模式下普通用户也能切进单机版 `<PluginsView />`。
- `packages/web/src/pages/admin/AdminPage.tsx:59-64,99-105` 管理页始终渲染 `plugins` Tab。
- `plugins/witops-core/index.js:159-183,390-411,846-888` 中的 `readCache`、`storyIndexCache`、`groupStoryCache` 在 `teamMode` 下未按 `actor.userId` 分区；`plugins/witops-core/team-auth.js:23-29` 读写模块级共享 `state`。

## Requirements

### R1 团队版默认屏蔽与环境变量白名单控制
- `parseTeamConfig(env)` 新增：
  - `pluginsDisabled`：读取 `TRELLIS_PLUGINS_DISABLED`（`'1'` / `'true'` 为 `true`，默认 `false`）。
  - `pluginAllowlist`：读取 `TRELLIS_TEAM_PLUGINS_ALLOWLIST`（逗号分隔插件 ID；**未设置或为空/`none` 时默认解析为空数组 `[]`**，即生产服务器默认全部屏蔽）。
- 当 `pluginsDisabled === true` 或 `pluginAllowlist.length === 0` 时：
  - `createTeamRuntime()` 不启动 `pluginHost`（零插件子进程，不扫描插件目录）；
  - `GET /api/panels` 返回 `{ panels: [] }`；
  - `GET /api/plugins` 返回 `{ disabled: true, mode: 'team', plugins: [] }`；
  - 所有 `/api/plugins/:id/*`（含 `/app/panel*` 匿名静态资源）及 `/api/events`（插件 SSE）均拒绝服务（返回 `404` 或 `503`，不泄露插件列表或静态文件）。
- 仅当 `!pluginsDisabled && pluginAllowlist.length > 0` 时才加载允许清单内的插件，不改变现有 `registry.pruneRegistry` 保留历史审计的逻辑。

### R2 前端入口收敛与 `/api/runtime` 联动
- Team `/api/runtime`（含未登录及已登录 `runtimePayload`）新增 `features: { pluginsEnabled: boolean }`；Standalone 保持向后兼容。
- `BoardPage.tsx` 在 `teamMode` 下从 `NAV` 排除单机版 `{ id: 'plugins', label: '插件' }` 入口（保留为 Phase 2 `isTauri` 桌面本机插件入口的独立扩展边界）；当 `features.pluginsEnabled === false` 时跳过远程 `/api/panels` 拉取并保持服务端面板为空。
- `AdminPage.tsx` 读取 `runtime.features.pluginsEnabled`，为 `false` 时隐藏管理页「插件」Tab（`id: 'plugins'`），若当前处于该视图则回退到默认视图。

### R3 `witops-core` 显式放行时缓存与状态租户隔离
- 在 `plugins/witops-core/index.js` 的 `teamMode` 分支下，`readCache`、`storyIndexCache`、`groupStoryCache` 必须以 `ctx.currentActor()?.userId`（及适用时的团队范围）作为分区键前缀；无合法 `actor` 拒绝写入公共缓存；单用户调用 `POST /refresh` / `/dispatch` 等仅清除本人缓存。
- 清理 `plugins/witops-core/team-auth.js` 中模块级共享 `state` 副作用，确保 `createTeamSession` 完全基于请求级 `ctx.currentCredential()`。

### R4 运维文档同步
- 更新 `docs/team-operations.md`：说明生产 Team 服务器默认屏蔽全部插件，如需放行需显式设置 `TRELLIS_TEAM_PLUGINS_ALLOWLIST`。

## Acceptance Criteria

1. 默认环境变量（`TRELLIS_BOARD_MODE=team`，未设 `TRELLIS_TEAM_PLUGINS_ALLOWLIST`）或设置 `TRELLIS_PLUGINS_DISABLED=1` 启动 Team 服务：零插件子进程启动；`GET /api/runtime` 返回 `features.pluginsEnabled === false`；`GET /api/panels` 为空；`GET /api/plugins` 返回 `disabled: true`；`GET /api/plugins/witops-core/app/panel` 返回 `404`/`503`。
2. 显式设置 `TRELLIS_TEAM_PLUGINS_ALLOWLIST=witops-core` 启动 Team 服务：`features.pluginsEnabled === true`，`witops-core` 正常加载，Admin 页显示「插件」Tab。
3. Team 模式下浏览器与客户端顶栏均不再渲染单机版「插件」管理 Tab；默认屏蔽态下 Admin 页不渲染「插件」Tab。
4. 集成测试验证：显式放行 `witops-core` 时，A/B 两用户并发访问 `/users`、`/iterations`、`/project-tasks`，各自返回各自账号的数据，互不命中对方缓存；单用户刷新不清除对方缓存。
5. `yarn test`、`yarn test:plugins`、`yarn --cwd packages/web lint`、`yarn --cwd packages/web build` 全部通过。

## Out of Scope

- 不实现桌面 EXE 本机插件宿主（由 Phase 2 `11-20-desktop-local-plugin-host` 承担）。
- 不做 6 大内置插件 `plugin.json` 字段精简（由 Phase 3 `11-20-desktop-plugins-zero-config` 承担）。
