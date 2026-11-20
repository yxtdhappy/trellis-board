# 实施计划：团队版插件部署屏蔽、前端入口收敛与多用户缓存隔离

## 前置检查
- 所有需求决策已收敛（生产默认屏蔽：默认 allowlist 为 `[]`）。
- 本阶段不改动桌面 Rust 代码与 `plugin.json` 配置结构。

## 有序实施清单

### Step 1：服务端默认屏蔽与 `/api/runtime` 开关
1. 修改 `packages/server/config.js` 的 `parseTeamConfig()`：解析 `TRELLIS_PLUGINS_DISABLED` 与 `TRELLIS_TEAM_PLUGINS_ALLOWLIST`（默认空 `[]`）。
2. 修改 `packages/server/team/http/common.js` 与 `packages/server/team/http.js`：
   - 当 `pluginsDisabled || pluginAllowlist.length === 0` 时跳过 `createTeamPluginHost()` 与 `pluginHost.start()`；
   - 提供关闭态安全兜底响应（`/api/panels` 空数组、`/api/plugins` `disabled: true`、`/api/plugins/:id/*` 含 `/app/panel*` 返回禁用/404）。
3. 修改 `packages/server/team/http/context.js`：在 `runtimePayload`（未登录与已登录态）加入 `features.pluginsEnabled`。

### Step 2：前端入口收敛
1. 修改 `packages/web/src/api/board.ts`、`packages/web/src/api/admin/types.ts`、`packages/web/src/api/admin/readers.ts`、`packages/web/src/hooks/useAdminConsole.ts`，读取并透传 `features.pluginsEnabled`。
2. 修改 `packages/web/src/pages/board/BoardPage.tsx`：Team 模式下从顶栏 `NAV` 移除单机版 `{ id: 'plugins', label: '插件' }`；`!pluginsEnabled` 时跳过 `/api/panels` 请求。
3. 修改 `packages/web/src/pages/admin/AdminPage.tsx`：在 `!pluginsEnabled` 时隐藏管理页「插件」Tab 并兜底回退默认视图。

### Step 3：`witops-core` 多用户缓存分区修复
1. 修改 `plugins/witops-core/index.js`：`readCache`、`storyIndexCache`、`groupStoryCache` 在 `teamMode` 下按 `actor.userId` 分区，刷新只清当前用户缓存。
2. 修改 `plugins/witops-core/team-auth.js`：移除跨请求模块级共享 `state` 副作用。

### Step 4：测试适配、回归用例与运维文档
1. 核对并适配既有 `packages/server/test/team-plugin-*.test.js`（针对默认屏蔽新行为显式声明测试 allowlist）。
2. 新增服务端单测：默认无环境变量全屏蔽、设 `TRELLIS_PLUGINS_DISABLED=1` 全屏蔽、设 `TRELLIS_TEAM_PLUGINS_ALLOWLIST=witops-core` 正常放行。
3. 新增 `plugins/witops-core/test/` 单测：Team 模式下并发用户缓存隔离与单用户刷新隔离。
4. 补充前端测试：Team 模式顶栏无单机「插件」Tab，`pluginsEnabled=false` 时 Admin 页隐藏「插件」Tab。
5. 更新 `docs/team-operations.md` 插件默认屏蔽与显式开启说明。

## 验证命令

```bash
yarn test
yarn test:plugins
yarn --cwd packages/web lint
yarn --cwd packages/web build
```

## 风险与回滚点
- 若线上测试或本地 `.worktree` 团队实例仍需要 `witops-core`，在对应实例启动环境变量加上 `TRELLIS_TEAM_PLUGINS_ALLOWLIST=witops-core` 重启即可；全过程无数据库 schema 改动，可秒级回滚。
