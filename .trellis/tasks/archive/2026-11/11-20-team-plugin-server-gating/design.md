# 技术设计：团队版插件部署屏蔽、前端入口收敛与多用户缓存隔离

## 1. 默认空集合白名单与禁用配置（`packages/server/config.js`）

在 `parseTeamConfig(env = process.env)`（`packages/server/config.js:107-138`）新增解析：

```js
const pluginsDisabled = booleanSetting(env, 'TRELLIS_PLUGINS_DISABLED', false)
const pluginAllowlist = parseAllowlist(env.TRELLIS_TEAM_PLUGINS_ALLOWLIST)
// 未设置、空串、'none'、'false' 均返回 [] —— 生产服务器默认屏蔽全部插件
```

- 与 `packages/server/team/http/common.js:42` 原有常量关系：`TEAM_PLUGIN_ALLOWLIST` 默认收紧为 `[]`（不再默认硬编码启用 `['witops-core']`），运维仅需在显式启用时设置 `TRELLIS_TEAM_PLUGINS_ALLOWLIST=witops-core`。

## 2. Team HTTP 与匿名资源拦截（`packages/server/team/http.js`）

```text
createTeamRuntime(config)
  ├─ pluginsEnabled = !config.pluginsDisabled && config.pluginAllowlist.length > 0
  ├─ if !pluginsEnabled:
  │    - 不创建或启动 createTeamPluginHost()，零插件子进程，不扫描插件目录
  │    - GET /api/panels                     -> 200 { panels: [] }
  │    - GET /api/plugins                    -> 200 { disabled: true, mode: 'team', plugins: [] }
  │    - GET /api/plugins/:id/app/panel*     -> 404 { error: '插件机制已关闭', code: 'PLUGIN_DISABLED' }
  │    - 其他 /api/plugins/* & /api/events   -> 404 / 503
  └─ if pluginsEnabled:
       - 传入 pluginAllowlist: config.pluginAllowlist 创建并启动 pluginHost
```

### `/api/runtime` 下发开关（`packages/server/team/http/context.js:24-59`）
- `runtimePayload(actor)` 在未登录和已登录响应中均增加：
  ```js
  features: {
    pluginsEnabled: Boolean(!config.pluginsDisabled && (config.pluginAllowlist?.length ?? 0) > 0),
  }
  ```
- 前端对齐文件：
  - `packages/web/src/api/board.ts`（`TeamRuntime.features?.pluginsEnabled`）；
  - `packages/web/src/api/admin/types.ts`、`readers.ts`、`useAdminConsole.ts` 暴露 `pluginsEnabled`。

## 3. 前端入口收敛

1. **`packages/web/src/pages/board/BoardPage.tsx`**：
   - 将 `{ id: 'plugins', label: '插件' }` 移出无条件 `NAV` 数组，仅在 `!teamMode`（遗留 standalone 兼容态）显示；Team 模式下顶栏不出现单机 `<PluginsView />`（Phase 2 再针对 `isTauri` 增加独立的本机插件入口）。
   - 当 `teamMode && runtime?.features?.pluginsEnabled === false` 时，不发起 `/api/panels` 请求，直接置空服务端面板列表；若 `view === 'plugins'` 在 `teamMode` 下意外触发，回退至 `'pipeline'`。
2. **`packages/web/src/pages/admin/AdminPage.tsx`**：
   - `visibleViews` 过滤逻辑中，当 `item.id === 'plugins'` 且 `consoleApi.pluginsEnabled === false` 时隐藏该 Tab；若当前视图落在该 Tab，自动切回 `'project-access'`。

## 4. `witops-core` 显式放行时的缓存与状态隔离

1. **缓存键租户化（`plugins/witops-core/index.js:159-183,390-411,846-888`）**：
   - `cacheNamespace()`：在 `teamMode` 下取 `ctx.currentActor()?.userId`；若缺失则跳过公共缓存直接请求或报错。
   - `readCache` 使用 `user:${userId}:${key}` 作为键；`clearUserCache()` 仅移除当前用户的键前缀，禁止一人刷新调用 `readCache.clear()` 清空全局。
   - `storyIndexCache` 与 `groupStoryCache` 改为按 `userId` 分区的 Map（带单用户与全局容量上限）。
2. **移除共享可变状态（`plugins/witops-core/team-auth.js:23-29`）**：
   - `createTeamSession` 不再读写模块级 `state`，仅使用当前请求 `ctx.currentCredential()`。

## 5. 测试注意点（避免默认变空误伤现有 `team-plugin-*` 测试）

- 检查 `packages/server/test/team-plugin-*.test.js` 与 `packages/test-support/`：现有测试直接测试 `createTeamRuntime` 时，需要核对是否显式传入或依赖旧默认值 `witops-core`——对需要测试插件能力的用例显式传入 `TRELLIS_TEAM_PLUGINS_ALLOWLIST`（或 `config.pluginAllowlist`），同时新增默认空配置屏蔽与显式开启两套用例。
