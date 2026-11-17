# 设计：团队版插件机制（team-plugin-core）

## 0. 一句话

插件在 team 模式下是**单进程、多用户**的：代码随服务启动一次，配置与凭据按用户落库，每次调用带 actor 上下文，
授权在宿主侧判定，插件只负责业务。

## 1. 与 standalone 的边界

复用（不改行为）：

- `apps/server/plugins/protocol.js`（NDJSON 帧、错误码、超时表）
- `apps/server/plugins/version.js`（manifest 校验、semver）
- `apps/server/plugins/secrets.js`（AES-256-GCM 加解密、`secret:`/`env:` 解析）
- `apps/server/plugins/store.js`（SQLite KV，team 下加 user 维度）
- `apps/server/plugins/task-service.js`（standalone 任务 façade；team 暂不接）
- `PluginSupervisor` 的进程管理、握手、健康检查、日志、审计骨架

新增（team 专属，放在 `apps/server/team/plugins/`）：

```text
apps/server/team/plugins/
  registry.js    # manifest 发现 + plugin_registry upsert + 默认启用策略
  settings.js    # plugin_team_setting / plugin_user_config 读写（只放非敏感项）
  session.js     # 凭据会话：服务端内存 handle → 第三方 token，不落库
  actors.js      # 会话 actor → PluginActor；actorRef 签发与校验
  policy.js      # 权限矩阵（谁能启用/配置/看面板/管别人）
  host.js        # team 版 supervisor 装配（注入 actor 解析、按用户 store、拒绝热 reload）
  http.js        # /api/plugins、/api/panels、插件命名空间（替换 team/http.js 的占位）
```

`apps/server/plugins/supervisor.js` 需要做**向后兼容的最小扩展**（standalone 行为不变）：

1. `initialize` 增加 `mode: 'standalone' | 'team'`，team 下额外传 `teamSupport: true`；
2. `http/request` 增加可选 `actor` 字段；
3. 新增插件→宿主方法：`userConfig/get`、`userConfig/set`、`secret/userGet`、`secret/userSet`、`secret/userDelete`；
4. `store/*`、`run/*`、`capability/call` 支持可选 `actorRef`，team 下**强制**要求；
5. `reloadConfig()` 在 team 下直接抛错（`409`）。

## 2. 数据模型（schema v13）

> 迁移方式：`apps/server/database.js` 新增 `SCHEMA_V13_SQL` + `ensureV13Schema()`，`schema_version` 升到 13。
> 旧表只 `ALTER TABLE ... ADD COLUMN`，不重建。

### 2.1 plugin_registry — 装了什么

```sql
CREATE TABLE IF NOT EXISTS plugin_registry (
  plugin_id     TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  version       TEXT NOT NULL,
  api_version   INTEGER NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  manifest_json TEXT NOT NULL,          -- 发现时的 manifest 快照
  source_path   TEXT NOT NULL,          -- plugins/<id> 绝对路径
  enabled       INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),  -- 全局开关（系统管理员）
  default_scope TEXT NOT NULL DEFAULT 'user' CHECK (default_scope IN ('user','team')),
  discovered_at TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
```

默认启用策略：`registry.js` 的 `DEFAULT_ENABLED = new Set(['witops-core'])`；
首次发现时 `witops-core` 写 `enabled=1`，其他插件 `enabled=0`。已存在的行**不覆盖** `enabled`，避免重启把管理员关掉的插件又打开。

### 2.2 plugin_team_setting — 团队启用了什么

```sql
CREATE TABLE IF NOT EXISTS plugin_team_setting (
  team_id      TEXT NOT NULL REFERENCES team(id) ON DELETE CASCADE,
  plugin_id    TEXT NOT NULL REFERENCES plugin_registry(plugin_id) ON DELETE CASCADE,
  enabled      INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
  config_json  TEXT NOT NULL DEFAULT '{}',   -- 团队级参数（不含密钥）
  updated_by   TEXT REFERENCES user_account(id),
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (team_id, plugin_id)
);
```

团队级参数用于"所有成员共享的默认值"，例如 witops `baseUrl`、`gatewayPrefix`、默认筛选 `types`。
密钥不进这张表；团队级密钥若将来需要，走 `plugin_team_secret`（本期不建）。

### 2.3 plugin_user_config — 每个人自己的非敏感偏好（**不存凭据**）

```sql
CREATE TABLE IF NOT EXISTS plugin_user_config (
  user_id      TEXT NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
  plugin_id    TEXT NOT NULL REFERENCES plugin_registry(plugin_id) ON DELETE CASCADE,
  config_json  TEXT NOT NULL DEFAULT '{}',   -- 只允许非敏感项：默认项目、上次选中、筛选、视图
  status       TEXT NOT NULL DEFAULT 'unconfigured'
                 CHECK (status IN ('unconfigured','active','invalid')),
  last_login_at TEXT,                        -- 仅时间戳，用于管理员看"谁在用"
  last_error   TEXT,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (user_id, plugin_id)
);
```

**不建 `plugin_user_secret`，第三方账号与 token 一律不落库。** 这是 2026-11-16 的明确决定，理由见 §11 D2：

- 泄露面：一旦落库，就要管加解密密钥、备份文件、迁移脚本、DBA 权限，任何一环出问题都是第三方账号丢失；
- 数据迁移：跨版本/跨机器/跨部署（`/var/lib/trellis-board` → 新机）都要处理密文与 keyfile，迁移失败就是全员重配；
- 收益有限：这些凭据是"个人在另一个系统里的身份"，服务端并不需要长期持有。

因此凭据只在**服务端内存**里活：

```js
// session.js —— 全部在进程内，进程重启即清空
byHandle: Map<handle, { userId, pluginId, token, account, accountKey, expiresAt }>
byUser:   Map<`${userId}:${pluginId}`, handle>      // 同一人同一插件只保留一条
byAccount: Map<accountKey, { userId, handle }>      // WitOps 单会话占用登记
loginAttempt: Map<accountKey, { failures, lastFailureAt, countInHour }>
```

- `handle` 32 字节随机（`crypto.randomBytes`），绑定 `userId + pluginId`；A 的 handle 给 B 用 → `403`；
- 存的是第三方 **token**，不是密码：登录成功后立即丢弃密码（现有 `plugins/witops-core/auth.js:22-23` 就是这个语义）；
- **TTL = 12h**（= WitOps token 有效期上限），**不做空闲回收**：用户一天内反复查看任务不应重复登录；
- **同一 WitOps 账号在 Board 内只能有一个占用者**（WitOps token 是单会话，两头用会互踢）：
  第二个用户在 `POST /session` 时直接 `409 ACCOUNT_IN_USE`，文案带占用人显示名，**不允许强登**；
- **不调 WitOps logout**（logout 会吊销全部 token）；用户点退出只清本 handle，下次登录拿到新 token 再刷新 `byAccount`；
- **禁止自动重登**（见 §7.0）：token 失效只返回 `401 CONNECTION_LOST`，不默认重试；
- 宿主没拿到 handle、或 handle 已失效 → `401 SESSION_REQUIRED`，面板弹登录表单。

内存预算（400 账号基线）：单条约 1–2.5 KB（token 是最大项），`maxEntries: 2000` → 上限约 5 MB；
定时 `sweep()` 60s 一次并 `.unref()`（与 `apps/server/team/agent-event-stream.js:109` 同风格），
超过上限按 `expiresAt` 淘汰并 warn。entry 只允许纯数据白名单字段，**禁止持有 request/response/Buffer/stream**。

`plugin_user_config.config_json` 的写入必须过**字段白名单**（由插件 manifest 的 `userConfigFields` 声明，
默认空 = 不允许写），防止插件把账号密码塞进"非敏感"字段里，让"不落库"变成口号。

### 2.4 plugin_project_binding — witops 项目 ↔ Trellis 项目

```sql
CREATE TABLE IF NOT EXISTS plugin_project_binding (
  id                  TEXT PRIMARY KEY,
  team_id             TEXT NOT NULL REFERENCES team(id) ON DELETE CASCADE,
  plugin_id           TEXT NOT NULL REFERENCES plugin_registry(plugin_id) ON DELETE CASCADE,
  project_id          TEXT REFERENCES team_project(repository_id) ON DELETE CASCADE,
  external_project_id TEXT NOT NULL,          -- witops projectId
  external_project_name TEXT,
  created_by          TEXT REFERENCES user_account(id),
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  UNIQUE (team_id, plugin_id, external_project_id)
);
CREATE INDEX IF NOT EXISTS plugin_binding_project
  ON plugin_project_binding(project_id);
```

`external_project_id` 唯一即可，`project_id` 允许为空（先登记、后绑定）。

### 2.5 旧表加列

```sql
ALTER TABLE plugin_run   ADD COLUMN user_id TEXT;
ALTER TABLE plugin_run   ADD COLUMN team_id TEXT;
ALTER TABLE plugin_audit ADD COLUMN user_id TEXT;
ALTER TABLE plugin_audit ADD COLUMN team_id TEXT;
```

`plugin_state` 不改结构：team 下 key 由宿主统一加上 `user:<userId>:` 前缀（见 §4.3）。

## 3. 进程与生命周期

### 3.1 启动顺序（team）

```text
team/http.js createTeamRuntime()
  ├─ discoverPlugins({ appDir, pluginsDir })      # 只读 plugins/*/plugin.json
  ├─ registry.sync(discovered)                    # upsert，保留已有 enabled
  ├─ settings.loadEnabled()                       # registry.enabled=1
  ├─ for each enabled:
  │     supervisor.spawnPlugin()                  # 单实例，initialize 传 mode:'team'
  └─ 失败：写 plugin_audit + 日志，核心功能继续
```

在 `team/http.js` 现有的 `await listen(...)` 之前完成，保证第一个请求进来时插件已经能响应。

### 3.2 代码 vs 配置

| 变更 | 生效方式 |
| --- | --- |
| 插件目录/入口/manifest 代码 | **重启服务** |
| `plugin_registry.enabled` | 重启服务（v1 简单可靠） |
| `plugin_team_setting.enabled/config` | 下次请求生效（宿主每次从 DB 读） |
| `plugin_user_config` / 插件会话 handle | 下次请求生效；handle 仅内存，刷新页面即失效 |
| 插件进程崩溃 | 指数退避 1s/2s/4s，3 次后 `error`，不自动无限重启 |

`POST /api/plugins/reload` 在 team 下返回：

```json
{ "ok": false, "code": "RELOAD_REQUIRES_RESTART", "error": "team 模式不支持热重载插件代码，请重启服务" }
```

`POST /api/plugins/<id>/start|stop` 允许（仅系统管理员）：只换进程，不换代码。

### 3.3 与 standalone 的 supervisor 差异

team 版 `host.js` 组装 `PluginSupervisor` 时传入：

- `env`：不含 `plugins.secrets.json` 的解析结果，避免全局密钥泄露给 team；
- `configFile`：不读 `plugins.json`（team 用 DB 配置），改为 `configFile: null` + `pluginConfigFor(id)` 回调；
- `spawnImpl`：同 standalone；
- `store`：`createTeamPluginStore({ db, actorContext })`，写 key 时加 user 前缀；
- `taskService`：null（team 暂不支持 `ctx.tasks.*`，调用返回 `CAPABILITY_UNAVAILABLE`）。

## 4. actor 上下文（核心）

### 4.1 PluginActor

```js
{
  ref: 'act_7f3c…',            // 宿主签发，一次性/短 TTL，用于回传校验
  userId: 'uuid',
  displayName: '张三',
  systemAdmin: false,
  teams: [{ id, role }],        // team_member
  projects: [{ id, role }],     // project_member
  activeTeamId: 'uuid|null',
  issuedAt: '2026-11-16T08:00:00.000Z',
  expiresAt: '...'              // TTL 60s
}
```

不含密码、不含 token、不含 session cookie。

### 4.2 签发与校验

```js
// actors.js
createActorContext(db) → {
  issue(actor, pluginId)   // 生成 ref，存 Map<ref, {actor, pluginId, expiresAt}>
  resolve(ref, pluginId)   // 校验绑定、未过期、插件匹配；用完不删（一次请求内可多次回传）
  sweep()                  // 定时清理过期
}
```

- `actorRef` 只在内存里，`Map` 有上限（如 2000 条）防止内存增长；
- 伪造 `actorRef` → `1004 PERMISSION_DENIED`；
- 插件没带 `actorRef` 时，`store/*`、`secret/*`、`userConfig/*`、`capability/call` 一律拒绝（`1004`）。

### 4.3 按用户隔离的 store

宿主侧把 key 重写为 `user:<userId>:<key>`，插件代码里仍然 `ctx.store.get('session')`。
好处：witops-core 无需改 store 调用；坏处：插件无法跨用户共享 state（团队级 state 用 `ctx.store.team()`，本期不做）。

### 4.4 插件侧 SDK 变化（`plugins/witops-core` 需要升级）

```js
ctx.mode            // 'standalone' | 'team'
ctx.actor           // PluginActor（team）| null（standalone）
ctx.userConfig      // team: { get(), set(patch) } —— 只接受 manifest 白名单字段
ctx.session         // team: { resolve(handle), open(credentials) → handle, close(handle) }
ctx.config          // 团队级/静态配置（不含任何用户凭据）
```

standalone 下 `ctx.userConfig` / `ctx.session` 不存在；team 下 `ctx.config.credentials` 恒为空，
**并且 `ctx.secrets.*` 不可用**（team 不落盘任何第三方凭据，插件也不能自己发明一条落盘路径）。

`ctx.session.open()` 的返回值（handle）只回给浏览器；插件自己不保存密码，只把 token 放进 `session.js` 的 Map。

**兼容策略**：`plugins/witops-core` 检测 `ctx.mode === 'team'` 且 `typeof ctx.actor === 'undefined'` 时直接报
`unsupported`（老宿主）；team 宿主下用 `ctx.actor` + `ctx.session` 决定会话来源。standalone 行为保持不变。

## 5. 权限矩阵

`policy.js` 统一实现，HTTP 层与面板可见性都走它。

| 操作 | 系统管理员 | 团队管理员 | 项目 lead | 项目成员 | 只读成员 |
| --- | --- | --- | --- | --- | --- |
| 发现/登记插件（自动） | — | — | — | — | — |
| `plugin_registry.enabled`（全局开关） | ✅ | ❌ | ❌ | ❌ | ❌ |
| `plugin_team_setting.enabled`（团队启用） | ✅ | ✅ | ❌ | ❌ | ❌ |
| 团队级参数 config | ✅ | ✅ | ❌ | ❌ | ❌ |
| 配置**自己**的账号/密钥 | ✅ | ✅ | ✅ | ✅ | ❌ |
| 查看面板 | ✅ | ✅ | ✅ | ✅ | ✅（只读） |
| 看自己的登录状态 | ✅ | ✅ | ✅ | ✅ | ✅ |
| 看**别人**是否在线/最后登录时间 | ✅ | ✅（本团队） | ❌ | ❌ | ❌ |
| 强制别人下线（作废 handle） | ✅ | ✅（本团队） | ❌ | ❌ | ❌ |
| 项目绑定（witops ↔ Trellis） | ✅ | ✅ | ✅（自己 lead 的项目） | ❌ | ❌ |
| 插件进程 start/stop | ✅ | ❌ | ❌ | ❌ | ❌ |
| 插件 runs/audit/logs | ✅（全部） | ✅（本团队） | ❌ | ❌ | ❌ |
| `POST /api/plugins/reload` | 409 | 409 | 409 | 409 | 409 |

判定函数：

```js
assertPluginEnabled(pluginId, { teamId })
assertCanConfigureSelf(actor, pluginId)
assertCanConfigureOther(actor, pluginId, targetUserId, teamId)
assertCanBindProject(actor, teamId, projectId)
assertCanAdmin(actor)         // system_admin
assertCanTeamAdmin(actor, teamId)
```

## 6. HTTP 路由（team）

替换 `apps/server/team/http.js` 中现有的占位段：

```js
if (url.pathname === '/api/plugins' || url.pathname.startsWith('/api/plugins/')) { … }
```

路由表：

| 方法 | 路径 | 权限 | 行为 |
| --- | --- | --- | --- |
| GET | `/api/plugins` | 登录 | 我可见的插件 + 我的配置状态（`configured`） |
| GET | `/api/panels` | 登录 | 已启用插件 × 我的可见性 → panels |
| GET | `/api/events` | 登录 | SSE（仅转发本插件可见的事件；v1 可先空流） |
| POST | `/api/plugins/reload` | — | 409 `RELOAD_REQUIRES_RESTART` |
| POST | `/api/plugins/<id>/config` | 自己 / 管理员 | 写 `plugin_user_config`（**字段白名单**） |
| POST | `/api/plugins/<id>/session` | 自己 | 登录换 handle（body 里是凭据，只在这次请求出现） |
| DELETE | `/api/plugins/<id>/session` | 自己 / 管理员 | 登出 / 强制下线（作废 handle） |
| POST | `/api/plugins/<id>/start` \| `/stop` | system admin | 启停进程 |
| GET | `/api/plugins/<id>/logs` \| `/runs` \| `/audit` | system admin / team admin | 审计与日志 |
| ANY | `/api/plugins/<id>/<其余>` | 登录 + 团队启用 | 转发给插件，注入 `actor` |
| GET | `/api/panels/<...>` | — | 不存在 |

**保留路径**：`config`、`session`、`start`、`stop`、`logs`、`runs`、`audit` 归宿主，插件不得注册同名路由
（在 `plugin-runtime.md` 里补充这条 team 侧约定）。

会话头：浏览器每次插件调用带 `x-plugin-session: <handle>`（由宿主页面内存持有，桥接自动附加）。
没有/无效 handle → `401 SESSION_REQUIRED`，`data: { loginUrl: '/api/plugins/<id>/session' }`。

写请求同样走 `assertJsonWrite`（content-type + Origin），与现有 team API 一致。

## 7. witops-core 端到端改造

### 7.0 WitOps 的三条硬约束（决定了整个登录策略）

2026-11-16 与用户确认的事实：

1. token 有效期 12h，**没有 refresh token**，过期只能重新登录；
2. **token 单会话**：任何地方重新登录，其他 token 全部吊销；用户在 WitOps 网页登录也会把我们缓存的 token 弄失效；
3. **logout 会吊销该账号全部 token**。

由此得到四条不可违反的实现规则：

| # | 规则 | 不遵守的后果 |
| --- | --- | --- |
| R1 | **禁止自动重登** | 现 `plugins/witops-core/auth.js:145` 的 `return handler(await login({ source: "relogin" }))` 要删（team 分支）：否则与用户在 WitOps 的登录互相踢，无限循环并刷爆对方审计 |
| R2 | **禁止调用 WitOps logout** | 会把用户从 WitOps 所有位置踢下线；“退出”只清本地 handle |
| R3 | **登录只能是用户显式动作** | 后台懒登录 = 随机踢人；`GET /projects` 缺 token 只返回 401，不自己登录 |
| R4 | **同一 WitOps 账号在 Board 内只允许一个占用者** | 两个 Board 用户共用一个账号时静默互踢，无法排查；改为 `409 ACCOUNT_IN_USE` 直接拒绝 |

### 7.1 面板流程（对应 weint-witops-web 的项目空间）

```text
① 未登录（无 handle / handle 失效）→ 显示登录表单
   POST /api/plugins/witops-core/session  { account, password }
   → 插件登录 witops 拿 token → 丢弃密码 → 返回 handle
   → 宿主页面内存保存 handle（不写 localStorage/DB）

② 已登录               → GET /api/plugins/witops-core/projects
   → project/findByMaster（我管理的） + project/findByParticipant（我参与的）
   → 返回 [{ id, name, abbreviation, role, mine: 'manager'|'participant' }]

③ 选中项目             → GET /api/plugins/witops-core/tasks?projectId=&status=&priority=&keyword=
   → task/task/page  { projectId, types: '0,1,5', tasksStatus, priority, name, code, page, size }
   → 返回任务数组 + 分页信息（code/name/status/priority/assignee/dueDate）

④ Trellis 项目已绑定   → GET /api/plugins/witops-core/projects?repositoryId=<trellis projectId>
   → 宿主查 plugin_project_binding 带出 external_project_id → 前端直接定位

⑤ 刷新页面 / 关标签 / 服务重启 → handle 消失 → 回到 ①（这是刻意的，见 §11 D2）
⑥ token 被 WitOps 侧吊销（用户在 WitOps 页面登录过）→ 请求返回 401 CONNECTION_LOST
   → 面板显示黄色横幅“你和 WitOps 的连接已断开，需要重新输入密码” → 回到 ①
   （绝不在后台自动重登，见 §7.0 R1）
```

登录失败与占用的处理（文案以 §12 为准）：

| 后端结果 | API 返回 | 面板行为 |
| --- | --- | --- |
| 密码/账号错 | `401 AUTH_FAILED` | 留在表单，提示“WitOps 账号或密码不对，请重新输入。” |
| 账号已被其他 Board 用户占用 | `409 ACCOUNT_IN_USE { displayName }` | 提示“这个 WitOps 账号已由「{姓名}」在 Board 里使用中”，不提供强登 |
| 连续失败超限 | `429 LOGIN_TOO_FREQUENT` | 提示“登录尝试太频繁，请 1 分钟后再试。” |
| 网络/上游异常 | `502 UPSTREAM_UNAVAILABLE` | 提示“WitOps 暂时连不上，请稍后再试。” |

### 7.2 新增 witops 接口（`plugins/witops-core/witops-client.js`）

```js
projectSpaceHome:      '/project/findByMaster',        // 我管理的项目
participantProjects:   '/project/findByParticipant',   // 我参与的项目
projectUserRole:       '/projectUserRole/userRole',    // 我在项目里的角色/菜单
taskPage:              '/task/task/page',              // 项目下任务分页
taskDetail:            '/task/detail'                  // 已有
```

### 7.3 插件侧改造点（`plugins/witops-core/`）

- `auth.js`：`createSession` 改为 `createUserSession({ ctx, actor })`，凭据来自 `POST /session` 入参（**用完即弃**），
  会话按 `ctx.actor.userId` 缓存在 `session.js` 的 Map 里；`session.persist` 在 team 下恒为 false；
  **`authorized()` 在 team 下不得重登**（删 `auth.js:145` 的 `relogin` 分支），`ApiError.authExpired` → `CONNECTION_LOST`；
- `index.js`：`config.credentials` 不再读取（team 下为空）；`ctx.http.route` 增加 `/projects`、`/tasks`；
- `dispatch.js`：团队模式下要求 `repositoryId` 来自 `plugin_project_binding`，不再从全局 `config.repositoryId` 猜；
- `panel/app.js`：新增「项目」下拉 + 「任务」表格，样式沿用 `app.css`；所有提示文案走 §12 的对照表，
  **不得出现“会话/token/handle/接管/SSO”等词**。

### 7.4 绑定管理

- 系统管理员/团队管理员：`/admin.html` 新增「插件」页 → 查看已装插件、启用/停用、看各用户配置状态、重置凭据；
- 项目 lead：在 Trellis 项目设置里绑定 witops 项目（`POST /api/plugins/witops-core/bindings`，宿主路由）；
- 绑定变更写 `plugin_audit`。

## 8. 分阶段实施

| 阶段 | 内容 | 产出 |
| --- | --- | --- |
| P0 | schema v13、`registry.js`、`settings.js`、`policy.js`、`actors.js`、team `http.js` 路由骨架、supervisor 协议扩展（`mode`/`actorRef`/`userConfig`） | team 下能看到空面板列表、`/api/plugins` 返回 registry；standalone 测试全绿 |
| P1 | witops-core 读路径：per-user 登录、projects、tasks；面板改造 | A4–A7 通过 |
| P2 | 绑定管理 + admin 插件页 + 审计/运行记录 | A8 与权限矩阵验收 |
| P3 | 写入：witops 任务 → Trellis 任务下发（依赖 team 任务写服务） | 后续任务 |

## 9. 测试计划

- `apps/server/test/team-plugin-registry.test.js`：manifest 发现、默认启用、重启不覆盖 enabled；
- `apps/server/test/team-plugin-actors.test.js`：actorRef 签发/过期/错绑插件/伪造；
- `apps/server/test/team-plugin-policy.test.js`：权限矩阵逐格；
- `apps/server/test/team-plugin-http.test.js`：401/403/409、`POST /session` 不落库、`ACCOUNT_IN_USE`、`CONNECTION_LOST`；
- `apps/server/test/team-plugin-session.test.js`：TTL 12h、上限淘汰、sweep、同账号占用拒绝、禁止自动重登；
- `apps/server/test/team-plugin-store-scope.test.js`：A/B 用户 store 隔离；
- `plugins/witops-core/test/*`：`ctx.mode` 分支、无自动重登、projects/tasks 映射；
- `apps/server/test/team-plugin-copy.test.js`（可选）：扫描面板文案，禁止出现 §12 禁用词；
- E2E（手动）：真实 witops 账号跑 A6/A7，记录命令与结果。

## 10. 未决问题

1. 项目 lead 能否替**项目成员**配置凭据？——凭据已不落库，该问题自动消失；改为：项目 lead 能否**强制成员下线**（作废 handle）？默认只有系统/团队管理员可以。
2. 团队级共享 witops 账号（一个团队一份凭据）是否需要？——与 D2 冲突（团队凭据必然落库），暂不做；若将来要做，单独评审。
3. `plugin_run` 的 `task_key` 在 team 下是否要带 `projectId` 前缀？等 P3 写入阶段再定。
4. 插件 manifest 是否需要声明 `configSchema` / `userConfigFields` 以支撑 admin 表单？v1 至少要有 `userConfigFields`（白名单），否则 `plugin_user_config` 不允许写。

## 11. 决策记录（ADR）

### D1 单进程多用户 + actor 上下文

**决定**：一个插件一个子进程，用 `actorRef` 区分调用者，不为每个用户起进程。
**理由**：容量基线 400 账号，per-user 进程数量不可控；插件本身是无状态的业务适配层。
**代价**：插件必须正确处理 `ctx.actor`，任何跨用户缓存都是 bug；宿主必须防住 `actorRef` 伪造。

### D2 第三方凭据不落库（2026-11-16，用户决定）

**决定**：不建 `plugin_user_secret`，不写 `plugins.secrets.json`，不提供"记住密码"。
第三方账号只在登录那一次请求里出现，成功后立即换成 token 放服务端内存。
**理由**：

1. 信息泄露：落库就要管 keyfile、备份、迁移脚本与 DBA 权限，任一环节失守等于第三方账号泄漏；
2. 数据迁移：跨机器/跨版本迁移必须带着密文和 keyfile，迁移失败即全员重配；
3. 收益有限：服务端不需要长期持有"某人在另一个系统里的身份"。

**代价（明确接受）**：

- **刷新页面即失效**，需要重新输入 witops 密码；切换视图不受影响（handle 在宿主页面内存）；
- 服务端重启全部失效；
- 无法多端共享（每台设备、每个浏览器标签页各登一次）；
- 管理员只能看到"最后登录时间 + 是否在线"，看不到也无法恢复别人的凭据；
- **token 随时可能被 WitOps 侧吊销**（单会话），所以 12h TTL 只是上限，不是保底可用时长；
- 由于不存密码，token 失效后 Board 无法静默恢复，只能等用户重登（这也是不自动重登的原因，见 §7.0）。

### D3 凭据会话粒度：页面会话

**决定**：handle 由宿主页面内存持有，**不放 iframe、不放 localStorage**。
**理由**：面板 iframe 是 `sandbox="allow-scripts allow-forms"`（无 `allow-same-origin`），面板内没有可用存储；
放宿主页面内存可以做到"切视图不重登、刷新重登"，与 D2 的安全目标一致。
**代价**：多标签页各自登录；未来若要"记住"，必须重新评审 D2。

### D5 WitOps 单会话：只拒绝不抢占，不调 logout（2026-11-16，用户决定）

**事实**：WitOps token 单会话、无 refresh、logout 吊销全部、有审计。

**决定**：

1. 同一 WitOps 账号在 Board 内只允许一个占用者；第二个用户登录直接 `409 ACCOUNT_IN_USE`，
   提示"该账号已被「张三」使用"，**不提供强登、不自动踢人**；
2. 退出只清本地 handle，**不调 WitOps logout**；用户重新登录后拿到新 token 再刷新占用登记；
3. 禁止自动重登，只返回 `CONNECTION_LOST` 让用户重输密码；
4. 登录失败退避：1/2/4/8/16s，1 小时内 ≤ 5 次，失败不自动重试。

**理由**：WitOps 侧是别人的生产系统，任何自动行为都可能影响该用户在其他系统的登录与对方审计；
宁可让用户在 Board 里多点一次“登录”，也不要造成静默互踢。

**代价**：换人/离职时旧占用会卡住新用户，需要管理员提供“清除某人登录状态”按钮（只清内存，不调 logout）。

### D6 面向用户的文案：不用系统内部概念

**决定**：面板与错误提示只用"登录 / 账号 / 连接"这类词，**不得出现“会话 / token / handle / 接管 / SSO / 吊销”**。
**理由**：这些词对普通项目管理人员无意义，只会让人觉得“系统坏了”；直接告诉他下一步做什么。
具体文案见 §12。

### D7 团队实例只开放 witops-core（2026-11-16，用户决定）

**决定**：`apps/server/team/http.js` 里 `TEAM_PLUGIN_ALLOWLIST = ['witops-core']`；
不在白名单的插件即使装在 `plugins/` 下也**不登记、不出现在管理页**，残留登记行会被清掉
（`registry.pruneRegistry`，保留历史 run/audit）。

**理由**：其余插件是 standalone 的运维工具（Jenkins、ACP 派发、场景自动化），
放进团队实例只会让管理页出现一堆永远用不上的开关，也让"团队版能做什么"变得含糊。

**代价**：以后要开放第二个插件，得改这个常量并重启；没有"运行时加白名单"的入口（与 D4 一致）。

### D8 面板静态资源免登录，数据接口不免（实施约束）

**决定**：`GET /api/plugins/<id>/app/panel*` 走 `anonymous` 转发，放在登录校验之前；
面板的数据请求仍然走父页面 `postMessage` 桥（带 Cookie），照常鉴权。

**理由**：面板 iframe 是 `sandbox="allow-scripts allow-forms"`，没有 `allow-same-origin`，
子资源请求不带 Cookie。带鉴权就是稳定 401，浏览器还会因为 ORB 把它显示成资源加载失败。

**代价**：面板 HTML/JS/CSS 对未登录者可见。它们只是前端代码，不含任何用户数据；数据仍要登录。

**连带约束**：iframe 的 `src` 是 `/api/plugins/<id>/app/panel`（无结尾斜杠），
所以 `team.html` 里的资源路径必须写绝对路径 `/api/plugins/witops-core/app/panel/...`。

### D4 插件代码随服务启动，配置动态生效

**决定**：team 下不做插件代码热更新，`POST /api/plugins/reload` → `409 RELOAD_REQUIRES_RESTART`。
**理由**：团队版强调可预测性；热重载会带来"同一进程里两份代码"的排查成本。
**代价**：改插件要重启服务；`start`/`stop` 只换进程不换代码。

## 12. 用户可见文案（面板与错误提示）

写面板、Toast、横幅时**照抄这一列**，不要自己造词。

### 12.1 场景对照表

| 场景 | 用户看到的话 | 按钮 |
| --- | --- | --- |
| 首次打开、未登录 | 先登录 WitOps 账号，才能查看项目任务。 | 登录 |
| 正在登录 | 正在登录 WitOps… | （禁用） |
| 登录成功 | 已登录：{账号掩码} | 开始使用 |
| 账号或密码错 | WitOps 账号或密码不对，请重新输入。 | 重试 |
| 账号已被占用 | 这个 WitOps 账号已由「{姓名}」在 Board 里使用中，请让对方先退出，或换一个账号。 | 知道了 |
| 连接断开（token 被吊销） | 你和 WitOps 的连接已断开，需要重新输入密码。 | 重新登录 |
| 登录太频繁 | 登录尝试太频繁，请 1 分钟后再试。 | 知道了 |
| WitOps 连不上 | WitOps 暂时连不上，请稍后再试。 | 重试 |
| 主动退出 | 已退出。下次查看任务需要重新登录。 | （关闭面板） |
| 没有项目 | 你在 WitOps 里还没有可查看的项目。 | 刷新 |
| 项目没有任务 | 这个项目暂时没有任务。 | 刷新 |
| 无权查看 | 你没有查看 WitOps 任务的权限，请联系团队管理员。 | 知道了 |
| 项目未绑定 | 当前 Board 项目还没有关联 WitOps 项目，请先在项目设置里绑定。 | 去设置 |

### 12.2 禁用词

提示文案里**不得出现**以下词（对项目管理人员无意义，只会让人觉得系统坏了）：

> 会话、token、凭据、handle、接管、单例、SSO、吊销、上游、401/403/500、actor、插件进程

需要表达"需要重新登录"时，说**「需要重新输入密码」**；需要表达"被踢掉"时，说**「连接已断开」**。

### 12.3 人称与标点

- 统一用**「你」**，不用「您」；
- 句末用句号，按钮不加标点；
- 账号一律掩码显示（`zhangsan` → `zh***an`，复用 `plugins/witops-core/util.js` 的 `maskAccount`）。

### 12.4 开发者日志（与用户文案分开）

日志/审计里可以写 `session expired`、`token revoked`、`account in use`，但必须带 `userId` 与插件 id，
且**绝不打印账号密码、token 明文**。
