# 实施计划：team-plugin-core

> 目标与边界见 [prd.md](./prd.md)，结构与协议见 [design.md](./design.md)。
> 执行顺序按 P0 → P1 → P2 → P3，每个阶段结束都要能独立验证，不允许"全做完再跑"。

## P0 基础设施（先跑通空壳）

### P0-1 schema v13

- `apps/server/database.js`
  - `DATABASE_SCHEMA_VERSION` 12 → 13；
  - `ensureSchema()` 的允许版本列表加 `13`，并调用 `ensureV13Schema(db)`；
  - 新增 `SCHEMA_V13_SQL`：`plugin_registry`、`plugin_team_setting`、`plugin_user_config`、`plugin_project_binding`
    （**没有 `plugin_user_secret`**：凭据不落库，见 design.md §11 D2）；
  - `ensureV13Schema()` 里对 `plugin_run` / `plugin_audit` 做 `ALTER TABLE … ADD COLUMN user_id/team_id`（用 `PRAGMA table_info` 判重）。

验证：

```bash
cd .worktree/trellis-board-team
node -e "…openDatabase 到临时目录…"   # 或跑 apps/server/test/database*.test.js
node --test apps/server/test/*.test.js
```

- [x] 新库直接建到 v13
- [x] 旧 v12 库自动升级且 `backups/` 里有升级前快照
- [x] 重复启动不重复 ALTER

### P0-2 registry：发现 + 落库

新增 `apps/server/team/plugins/registry.js`：

- `discoverPlugins({ appDir, pluginsDir })`：只读 `plugins/*/plugin.json`，返回 `{ id, name, version, apiVersion, description, manifest, sourcePath }[]`；
  - 跳过 `.git`、缺 `plugin.json`、`id` 与目录名不一致的项；
  - 复用 `apps/server/plugins/version.js` 的 `validateManifest()`，非法 manifest 记 warning 不阻断启动。
- `syncRegistry(db, discovered, { now })`：
  - upsert，`enabled` 只在**首次插入**时按 `DEFAULT_ENABLED = new Set(['witops-core'])` 决定，已有行不动；
  - 返回 `{ inserted, updated, removed }`（目录删掉的插件保留行但标 `source_path` 不存在，不自动删，避免丢配置）。
- `listRegistry(db)` / `setRegistryEnabled(db, pluginId, enabled)`。

验证：`apps/server/test/team-plugin-registry.test.js`（临时 SQLite，不 mock）。
- [x] 首次发现 `witops-core` 为 enabled，其余 disabled
- [x] 二次 sync 不覆盖管理员改过的 enabled
- [x] manifest 非法时不注册、记 warning

### P0-3 settings：团队级 / 用户级配置（不含凭据）

新增 `apps/server/team/plugins/settings.js`：

```js
createPluginSettings({ db }) → {
  getTeamSetting(teamId, pluginId), setTeamSetting(...),
  getUserConfig(userId, pluginId), setUserConfig(userId, pluginId, patch, { fields }),
  describeUserPlugin(userId, pluginId),   // { configured, status, lastLoginAt, online }，永不回显值
}
```

- **没有 secret 相关方法**：凭据不落库（design.md §11 D2）；
- `setUserConfig` 必须传 manifest `userConfigFields` 白名单，白名单外字段直接 `400`；
- 所有读取走 prepared statement；写用事务。

验证：`apps/server/test/team-plugin-settings.test.js`
- [x] 白名单外字段被拒
- [x] `describeUserPlugin` 不含任何凭据/ token 字段
- [x] 删除用户后级联清理

### P0-3b session：服务端内存会话

新增 `apps/server/team/plugins/session.js`：

```js
createSessionStore({ db, now, ttlMs = 12 * 60 * 60 * 1000, maxEntries = 2000 }) → {
  // handle 由宿主持有，浏览器永远看不到 token
  create({ userId, pluginId, token, account, witopsUserId }),  // → { handle, expiresAt }
  resolve({ handle, userId, pluginId }),                       // → entry | null（userId 不匹配→ null）
  revoke({ handle }), revokeUser(userId, pluginId),
  touch({ handle }),                                    // 刷新 lastSeenAt
  claimAccount({ pluginId, accountKey, userId }),        // 冲突→ 409 ACCOUNT_IN_USE
  releaseAccount({ pluginId, accountKey, userId }),
  sweep(), size(), statusOf(userId, pluginId),
}
```

- 双索引：`byHandle: Map<handle, entry>`、`byUser: Map<userId::pluginId, handle>`（新登录替换旧）；
- entry 只存 `token/account/witopsUserId/expiresAt/lastSeenAt`，**不存密码**；
- `sweep()` 每 60s 一次且 `.unref()`（参照 `apps/server/team/agent-event-stream.js:109`）；
- 不回收空闲（用户要求少频繁重登），只按 12h TTL 过期；
- 每次 `create` / `revoke` / `claimAccount 冲突` 写 `plugin_audit`（账号掩码）。

验证：`apps/server/test/team-plugin-session.test.js`
- [x] 12h TTL 过期后 `resolve` 返回 null
- [x] `byUser` 替换旧 handle，旧 handle 失效
- [x] `claimAccount` 冲突返回 409 且不踢旧用户
- [x] `maxEntries` 满时按 `expiresAt` 最早淘汰
- [x] entry 里搜不到 password 字段

### P0-4 policy：权限矩阵

新增 `apps/server/team/plugins/policy.js`，实现 design.md §5 的判定函数，全部抛 `teamError(403, ERROR_CODES.FORBIDDEN, …)`：

```js
assertSystemAdmin(actor)
assertTeamAdmin(db, actor, teamId)
assertCanConfigureSelf(actor, pluginId)          // 只写非敏感偏好
assertCanViewOthers(db, actor, targetUserId, teamId)  // 只看“是否在线/最后登录”
assertCanForceLogout(db, actor, targetUserId, teamId) // 系统/团队管理员
assertCanBindProject(db, actor, teamId, projectId)
visiblePlugins(db, actor)      // 面板过滤
isTeamEnabled(db, teamId, pluginId)
```

复用 `apps/server/team/permissions.js` 的 `canManageSystem` / `isTeamManager`，不要重复实现角色查询。

验证：`apps/server/test/team-plugin-policy.test.js` 覆盖矩阵每一格（表驱动）。

### P0-5 actor 上下文

新增 `apps/server/team/plugins/actors.js`：

```js
createActorContext({ ttlMs = 60_000, maxEntries = 2000, now }) → {
  issue({ actor, pluginId }),   // → { ref, userId, displayName, systemAdmin, teams, projects, expiresAt }
  resolve(ref, pluginId),       // → actor 或抛 1004
  sweep(), size()
}
```

- `ref` 用 `crypto.randomUUID()`；
- `teams` / `projects` 从 `actor.teams` + `project_member` 查；
- 过期/超限先 sweep。

验证：`apps/server/test/team-plugin-actors.test.js`
- [x] 同一 ref 换插件 id 解析失败
- [x] 过期后解析失败
- [x] 超过 maxEntries 触发清理

### P0-6 supervisor 协议扩展（保持 standalone 不变）

改 `apps/server/plugins/supervisor.js`：

- `spawnPlugin` 的 `initialize` 增加 `mode: this.mode ?? 'standalone'`，team 下额外 `teamSupport: true`；
- `forwardHttp(..., { actor })` 把 `actor` 放进 `http/request` 载荷；
- 新增 `case 'userConfig/get' | 'userConfig/set'`，team 下通过注入的 `userConfigProvider` 实现，未注入时返回 `CAPABILITY_UNAVAILABLE`；
- **不新增 secret 类 RPC**（凭据不落库）；team 下 `secret/get` 对 `witops-core/password` 一律返回 `NOT_FOUND`；
- `capability/call`、`store/*`、`run/*` 读取可选 `actorRef`，team 下要求非空并 `resolve`；
- `reloadConfig()` 在 `mode === 'team'` 时抛 `appError(409, …)`（错误码走 `ERROR_CODES`，不新造 HTTP 概念）；
- 新增构造参数 `mode`、`actorContext`、`userConfigProvider`，默认值保持 standalone 行为。

验证：`npm test`（standalone 插件测试必须全绿，不能回归）。

### P0-7 team HTTP 路由骨架

改 `apps/server/team/http.js`：

- 删除 `v1 只支持 standalone` 占位段，改为调用 `createTeamPluginRoutes({ db, actorContext, settings, policy, supervisor })`；
- 在 `createTeamRuntime()` 启动序列里（`listen` 之前）调用 `startTeamPlugins()`：
  `discover → syncRegistry → spawn enabled`；
- 路由实现 design.md §6 表格；写请求沿用 `assertJsonWrite`。

**进度（2026-11-16）**：路由已落在 `apps/server/team/plugins/http.js`（`createTeamPluginRoutes`），
启动序列改为 `createTeamPluginHost().start()`（扫描 → `syncRegistry` → 装载 → spawn 已启用）。
已用真实实例验证：登录后 `GET /api/plugins` 返回 5 个插件、`witops-core` 为 `enabled:true / status:running`。
自动化：`apps/server/test/team-plugin-http.test.js` 6/6（reload 409、非管理员 403、停用后可重新启用、
列表按团队过滤、面板只含 running、未登记 404 / 停用对普通用户 403）。
实机 curl：未登录 401、`GET /api/panels` 返回 witops 面板、`/api/plugins/witops-core/app/panel` 200 text/html。
仍未验证：`POST /api/plugins/<id>/session`（P1 接入后才存在，目前返回 501）。

**进度（2026-11-16 晚）**：P1/P2 的功能代码已全部落地并跑通；团队实例只开放 `witops-core`
（`apps/server/team/http.js` 的 `TEAM_PLUGIN_ALLOWLIST`），其余插件不登记、不出现在管理页。
本机无法访问 `witops.weintdata.cn`（DNS 不通），真实账号的 A4–A7 改用本地假平台验证，
真实环境验收仍需一次联网复跑。

验证：`apps/server/test/team-plugin-http.test.js`
- [x] 未登录 401
- [x] 非管理员 start/stop 403
- [x] `POST /api/plugins/reload` → 409 `RELOAD_REQUIRES_RESTART`
- [x] `GET /api/panels` 只返回已启用且可见的插件
- [x] `POST /api/plugins/<id>/session` 后库里**没有**账号/密码/token 列
      （`plugin_user_config` 只有 `status/update/last_error`；token 只在 `session.js` 的内存 Map 里）

### P0-8 部署约束（k3s）

- [x] `deploy` 清单（若仓库内有）或 `.worktree/AGENTS.md` 记录：`replicas: 1`、禁用 HPA（会话在进程内存）；
- probe 放宽：`initialDelaySeconds: 30`、`periodSeconds: 30`、`failureThreshold: 5`；
- `resources.limits.memory` 覆盖 server + 插件子进程（85–125 MB + 每插件 50–80 MB）。

### P0 完成判定

```bash
./.worktree/team.sh restart
curl -s http://127.0.0.1:4403/api/health
node .worktree/trellis-board-team/apps/server/team/cli.js status   # schemaVersion 13
npm test
```

## P1 witops-core 读路径

### P1-1 SDK 与插件分支（已完成）

- `apps/server/plugins/sdk.js`：新增 `ctx.mode`、`ctx.currentActor()`、`ctx.currentCredential()`；
  实现方式是一个请求级 `AsyncLocalStorage`（`requestScope.run({actor, credential}, handler)`），
  不逐个改 handler 签名，也不会串号。
- `plugins/witops-core/index.js`：`const teamMode = ctx.mode === 'team'`，team 下用 `createTeamSession`，
  完全不走 `config.credentials` / `ctx.secrets`。
- `plugins/witops-core/team-auth.js`（新增）：**不缓存 token、不落盘、不调 logout**；
  `authorized()` 从 `ctx.currentCredential()` 取 token，缺失 → `1001 missing-credentials`，
  平台 401/403 → `1001 connection-lost`，**没有任何自动重登分支**。
- 宿主 `apps/server/team/plugins/session.js` 才有 token（`byUser` 唯一，12h TTL，60s sweep）。

### P1-2 项目与任务接口（已完成）

实际的路径和计划略有出入，以代码为准：

- `witops-client.js` 增加 `projectByMaster` / `projectByParticipant` / `projectUserRole` / `projectTaskPage`
  （默认路径 `/project/findByMaster`、`/project/findByParticipant`、`/projectUserRole/userRole`、`/task/task/page`）；
- **宿主** `apps/server/team/plugins/http.js`：
  `GET /api/plugins/<id>/session`（在线状态+掩码账号）、`POST`（账号密码 → 插件 `POST /session/open` → 换 token → 建会话）、
  `DELETE`（只清本地，不调平台 logout）；
  失败映射：401 `AUTH_FAILED` / 401 `CONNECTION_LOST` / 409 `ACCOUNT_IN_USE` / 429 `LOGIN_TOO_FREQUENT` / 502 `UPSTREAM_UNAVAILABLE`；
- **插件** `plugins/witops-core/index.js`（team 分支）：
  `POST /session/open`、`GET /project-space`（`{managed, joined}`）、`GET /project-tasks`
  （`projectId`/`productId`/`projectModuleId`/`code`/`tasksStatus`/`priority`/`name`/`page`/`size≤100`）；
- 任务数据改用**任务看板接口** `POST /bulletin/statusBulletin`（body `{projectId, type:"4"}`，
  也就是 witops-web `/weint-witops-web/task/statusDashboard/4` 用的那个）：
  它返回按状态分组的列 `[{status,statusName,taskResps:[...]}]`，插件侧拍平成 items 后在本地过滤 + 分页；
  `/task/task/page` 保留在 client 里但不再用于面板（列表页用，字段口径不同）。
  注意平台给每个请求都校验 `Weareint-Token` / `Weareint-Platform: MOM_WEB` / `Weareint-Path`（当前页面路由），
  `Weareint-Path` 缺了会拿不到数据；默认值 `/weint-witops-web/dashboard/mine`，需按接口改。
- 未登录 → `401 CREDENTIALS_MISSING`；token 失效 → `401 CONNECTION_LOST`（**不自动重登**）；
- 宿主转发会把 `actorRef` 与 `credential` 一起塞进插件请求，插件侧通过 ALS 读，不落在任何地方。

### P1-3 面板（已完成）

`plugins/witops-core/panel/team.html` + `team.js`（team 模式下 `GET /panel` 返回这一份）；
standalone 的 `index.html` 不动。页面：登录表单 → 项目下拉（我管理的在前）→ 任务表格 + 分页。

两个必须记住的坑：

1. 面板挂在 `/api/plugins/<id>/app/panel`（**没有结尾斜杠**），HTML 里的相对路径会解析成 `/app/xxx`，
   所以资源必须写绝对路径 `/api/plugins/witops-core/app/panel/app.css`；
2. iframe 是 `sandbox="allow-scripts allow-forms"`（无 `allow-same-origin`），它自己发的子资源请求**不带 Cookie**。
   宿主因此把 `/app/panel*` 的 GET 放在登录校验之前，并以 `anonymous: true` 转发给插件；
   数据请求仍走父页面 `postMessage` 桥，依然要登录。

**文案必须照 design.md §12 抄**：不出现 会话/token/凭据/handle/接管/吊销 等词；账号一律 `maskAccount()`。

### P1 完成判定

- [ ] A4/A5/A6/A7/A10/A11 逐条 curl 通过（真实 witops 账号）——**本机 DNS 不通，改用本地假平台验证过一次，真实环境待复跑**
- [x] `npm run test:plugins` 绿（86 pass / 1 skipped）
- [x] 两个用户同时登录互不串号；同账号第二人 409（`{"code":"ACCOUNT_IN_USE","details":{"displayName":"系统管理员"}}`）
- [x] 断开后没有第二次登录请求（`team-auth.js` 里没有 relogin 分支，grep 可查）

### P1 端到端证据（本地假平台 `127.0.0.1:5599`）

```
POST /api/plugins/witops-core/session {"account":"zhangsan","password":"good-pass"}
  → 200 {"online":true,"account":"zh***an","expiresAt":"..."}
GET  /api/plugins/witops-core/app/project-space
  → 200 {"managed":[{"id":"p1","name":"项目一"}],"joined":[{"id":"p2","name":"项目二"}]}
GET  /api/plugins/witops-core/app/project-tasks?projectId=p1&page=1&size=20
  → 200 {"page":1,"size":20,"total":1,"items":[{"code":"T-1001","name":"登录改造","statusLabel":"待处理",...}]}
       （该次验证走的是本地假平台的 /bulletin/statusBulletin，真实平台待复跑）
DELETE /api/plugins/witops-core/session  → 200 {"online":false}
GET  /api/plugins/witops-core/app/project-space  → 401 {"code":1001}
```

浏览器里也走通了一遍：面板显示「项目一 · 共 1 条任务」、表格 6 列、分页「第 1 / 1 页 · 共 1 条」，
退出后横幅是「已退出，下次查看任务需要重新登录。」

## P2 绑定与管理（主体完成）

- [x] `apps/server/team/plugins/bindings.js`：`list/read/create/remove`，`create` 校验项目属于该团队、
      同一插件项目不可重复绑定（409 `ALREADY_BOUND`）；
- [x] 路由 `GET/POST/DELETE /api/plugins/<id>/bindings?teamId=...`，权限走 `policy.assertCanBindProject`
      （系统管理员 / 团队管理员 / 项目 lead）；
- [x] `/admin.html` 新增「插件」页（`apps/web/src/features/admin/PluginsTab.tsx`）：
      registry 列表 + 进程状态 + 在线人数、全局启用/停用、启动/停止进程、团队启用开关、项目绑定增删；
      **没有"替用户填账号密码"的入口**；
- [x] 团队没选中时禁用团队级操作并提示「先在右上角选择团队」；
- [ ] 项目设置页里的「绑定 witops 项目」快捷入口（现在只在 admin 插件页里做）
- [ ] 绑定/启用动作写 `plugin_audit`（会话的 open/close/conflict 已写，绑定还没写）

## P3 写入（后续任务）

- `ctx.tasks.create/assign/setStage` 接 team 任务写链路（`apps/server/team/task-writes.js`），需要插件身份→actor 映射与工具链校验；
- witops 任务 → Trellis 任务下发 + 幂等键。

## 风险与回退

- 每个阶段都可独立合并；P0 只新增表与路由，不影响现有 team 功能；
- supervisor 改动必须保持 standalone 测试全绿，否则回退到 team 专用 fork（不推荐）；
- schema 升级前自动 `VACUUM INTO backups/`，回退用旧库 + 旧代码。
