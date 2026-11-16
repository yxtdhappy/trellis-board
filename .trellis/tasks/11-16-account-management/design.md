# 统一账号插件设计（accounts-core）

## 目标

1. **唯一可信源**：内网系统（witops、jenkins 及其他 AD 认证系统）的账号密码集中维护在 `accounts-core` 插件。
2. **可复用**：其他插件通过 capability `accounts.credentials` 取凭据，不再各自维护同一份 AD 密码。
3. **可独立运行**：`jenkins-ops`、`witops-core` 保留本地账号配置作为回退，`accounts-core` 不在时不崩。
4. **UI 统一**：账号/登录相关界面只实现一份（`accounts-core` 提供的 widget），三个插件共用。

## 事实约束（来自代码）

- secret 严格按插件隔离：`apps/server/plugins/supervisor.js:1560 requirePluginSecretKey` 只允许 `<pluginId>/...`，因此消费方拿不到 accounts-core 的 secret，必须走 capability。
- 插件 HTTP：`ctx.http.route(method, path, handler)`（`apps/server/plugins/sdk.js:275`），桥接地址是 `/api/plugins/<id>/<path>`。
- 面板运行在 sandbox iframe，只能通过 postMessage 桥访问**自己插件**的 `/api/plugins/<pluginId>/*`（`apps/web/src/features/plugins/PluginPanel.tsx:44` `const base = '/api/plugins/<panel.pluginId>'`）。跨插件面板调用必须由宿主插件代理。
- 凭据加密落盘：`ctx.secrets.set` → `apps/server/plugins/secrets.js`（AES-256-GCM）。
- 面板静态资源：宿主直接服务 `plugins/<id>/panel/*`，不走插件 token。

## 数据模型

store（`ctx.store`，命名空间 `accounts-core:`）：

```text
accounts -> [{ id, username, note, updatedAt }]
systems  -> [{ id, name, baseUrl, accountId, note, enabled }]
```

secrets：

```text
accounts-core/account/<accountId>/password
```

- `systems[].accountId` 指向 `accounts`，一个账号可被多系统引用（AD 统一账号）。
- 单个系统若要例外，新增第二个账号并改引用即可，不引入覆盖字段。
- 删除账号时：若仍被系统引用，拒绝删除（返回 409 语义），避免悬空引用。

## Capability 契约：`accounts.credentials` v1.0.0

| 方法 | access | timeout | 入参 | 返回 |
| --- | --- | --- | --- | --- |
| `accounts.list` | read | 5000 | `{}` | `{ accounts: [{ id, username, note, hasPassword }] }` |
| `systems.list` | read | 5000 | `{ enabledOnly?: boolean }` | `{ systems: [{ id, name, baseUrl, accountId, enabled }] }` |
| `credential.resolve` | read | 5000 | `{ system: string }` | `{ systemId, accountId, username, password, baseUrl }` |

- `credential.resolve` 在系统不存在 / 禁用 / 账号无密码时抛应用错误 `1004`（NOT_FOUND），消息里说明原因。
- 返回值含明文密码，只在本机进程间传递；accounts-core 不记录、不写日志。
- 消费方必须声明 `requires: [{ name: "accounts.credentials", version: "^1.0.0" }]` 与权限 `capabilities:call`。

## 插件骨架

```text
plugins/accounts-core/
  plugin.json
  index.js                 # store/secrets CRUD + capability provide + http routes
  panel/
    index.html             # 账号 / 系统 两个页签
    app.js                 # DOM API 构建（不拼 innerHTML），postMessage 桥
    app.css
    widget/
      credentials-widget.js   # 供 jenkins/witops 复用的「统一账号」组件
      credentials-widget.css
  test/
    manifest.test.js
    index.test.js
  README.md
```

`plugin.json` 要点：

```json
{
  "id": "accounts-core",
  "name": "统一账号",
  "description": "集中维护内网 AD 统一账号与各系统绑定，并通过 accounts.credentials capability 供其他插件取凭据。",
  "apiVersion": 1,
  "engines": { "board": ">=0.4.0" },
  "allowMissingSecrets": true,
  "permissions": ["http:route", "panels", "store", "secrets:read", "secrets:write", "capabilities:provide"],
  "provides": [{ "name": "accounts.credentials", "version": "1.0.0", "methods": { } }],
  "panels": [{ "id": "accounts-core", "title": "统一账号", "entry": "/panel", "placement": "view", "order": 30 }]
}
```

插件 HTTP 路由（`onStart` 内注册，路径扁平、id 走 body，避免动态段）：

```text
GET  /status                    统计：账号数/系统数/缺密码账号
GET  /accounts                  列表（不含密码，含 hasPassword）
POST /accounts                  {id?, username, note}           创建/更新
DELETE /accounts                {id}                            被引用时 409
POST /accounts/password         {id, password}                  写 secrets
DELETE /accounts/password       {id}
GET  /systems
POST /systems                   {id?, name, baseUrl, accountId, note, enabled}
DELETE /systems                 {id}
```

## 消费方改造

### jenkins-ops

- `plugin.json`：权限加 `capabilities:call`；`requires` 增加 `accounts.credentials`；`config` 增加
  `credentialSource: "auto"`（`auto|local|account`）、`accountSystemId: "jenkins"`。
- `index.js` 提取 `resolveCredentials(ctx, config)`：
  1. `credentialSource === 'local'` → 直接本地；
  2. 否则调 `ctx.capabilities.call('accounts.credentials', 'credential.resolve', { system: accountSystemId })`；
  3. 拿到 `username/password` 即用，并标记 `source: 'accounts'`；
  4. 调用失败（插件缺失 / 1004 / 无 password）→ 回退 `plugins.json` 的 `config.username/password` 与 secret `jenkins-ops/password`，标记 `source: 'local'`。
- `/status` 增加 `credentialSource` 与 `accountSystem` 字段，供面板显示。
- 面板：密码输入改为「统一账号」卡片（widget），本地账号收进「本地覆盖」折叠区。

### witops-core

- `plugins/witops-core/auth.js`：`createSession()` 的 `login()` 在「无本地 password」时先尝试 capability
  `credential.resolve({ system: config.accountSystemId ?? 'witops' })`，拿到则用其 account/password 登录；
  失败回退现有流程（面板输入 / token 模式）。
- `plugin.json`：`requires` 增加 `accounts.credentials`；`config` 增加 `credentialSource: "auto"`、`accountSystemId: "witops"`。
- 会话记录里增加 `source: 'accounts'`，面板显示「来源：统一账号」。
- 面板：登录区的账号/密码输入替换为 widget；`token` 应急模式保留。

> 注意：dev worktree 的 `plugins/witops-core/` 是**真实副本**（gitignore），改完要同步回主工作树 `plugins/witops-core/`。

## UI 统一方案

- 唯一编辑入口：`accounts-core` 面板（账号 CRUD、系统绑定、密码设置）。
- 复用组件：`/api/plugins/accounts-core/panel/widget/credentials-widget.js` 暴露
  `window.TrellisCredentialsWidget.mount({ root, request, systemId, labels })`：
  - `request(path, opts)` 由宿主面板注入，指向**自己插件**的代理路由
    （`jenkins-ops` → `/credentials`，`witops-core` → `/credentials`），由插件内部再调 capability；
  - 渲染：当前生效账号、来源（统一账号 / 本地）、绑定系统名、缺失提示、按钮「去统一账号维护」
    （`window.parent.postMessage({ type: 'trellis:hint', message })`，MVP 只提示，不做跳转）。
- 降级：`<script src>` 404 或 `TrellisCredentialsWidget` 未定义时，面板退回原来的本地账号表单。

## 风险与取舍

- **capability 返回明文密码**：进程内边界，可接受；禁止 log/审计记录密码，`ctx.log` 只记 systemId。
- **双源歧义**：`credentialSource=auto` 时账号优先。UI 必须显式显示当前来源，避免「改了统一账号却没生效」。
- **删账号被引用**：拒绝删除并提示引用它的系统列表。
- **witops-core 副本漂移**：合并回 main 前 `rsync` 同步，见 implement.md。
- **跨插件静态资源**：jenkins/witops 面板依赖 accounts-core 的 widget 文件；缺失时必须静默降级。

## 验收标准

1. `accounts-core` 在 dev（4401）启动为 `running`，`/api/panels` 出现「统一账号」。
2. 面板可新建账号（含密码）、新建系统并绑定账号；重启后数据仍在（store + secrets 落盘）。
3. 别的插件可通过 capability 解析到凭据：`jenkins-ops` 在 `credentialSource=auto` 时 `/status` 显示 `source=accounts`。
4. 停掉 `accounts-core` 后，`jenkins-ops` / `witops-core` 回退本地配置，仍能工作。
5. `npm run test:plugins` 全绿（新增 accounts-core L3、jenkins/witops 解析分支用例）。
6. 面板文案与样式与现有插件一致（浅/深色主题跟随 `trellis:init`）。
