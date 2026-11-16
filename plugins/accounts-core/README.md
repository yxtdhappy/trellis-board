# accounts-core · 统一账号

内网 AD 账号的唯一可信源：账号（username + 密码）集中维护，其他插件通过 capability 解析凭据，
避免"secret 按插件隔离导致每个插件各存一份密码"。

## 能力边界

- 账号无密码时只作为通信录条目，`hasPassword: false`；
- 密码只写不读：接口只回传 `hasPassword`，明文只经 capability `credential.resolve` 给调用方进程；
- 被系统引用的账号不允许直接删除（返回 409 与引用列表）；
- 验证凭据是否有效由调用方负责（账号簿不主动登录目标系统）。

## 权限

```json
"permissions": ["http:route", "panels", "store", "secrets:read", "secrets:write", "capabilities:provide"]
```

## HTTP 路由（`/api/plugins/accounts-core`）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/status` | 账号/系统数量、缺少密码的账号 |
| GET | `/presets` | 面板输入提词：插件 `config.systemPresets` 的 `{ id, name, bound }` |
| GET | `/accounts` | 账号列表（含 `hasPassword`，不含密码） |
| POST | `/accounts` | 新建（可不带 id）或按 id 更新；body `{ id?, username, note? }` |
| DELETE | `/accounts` | 删除，body `{ id }`；被引用时 409 |
| POST | `/accounts/password` | 设置密码，body `{ id, password }` |
| DELETE | `/accounts/password` | 清除密码，body `{ id }` |
| GET | `/systems` | 系统列表（含绑定账号的 `username`、`hasAccount`、`hasPassword`） |
| POST | `/systems` | 新建/更新，body `{ id, name?, baseUrl?, accountId?, enabled?, note? }` |
| DELETE | `/systems` | 删除，body `{ id }` |
| GET | `/panel` | 面板页面 |

数据保存位置：账号与系统在插件 store；密码在插件 secret `accounts-core/account-<id>`（宿主 AES-256-GCM 加密，
密钥文件 `<pluginsDir>/plugins.secrets.key`）。

系统 id 不是自动发现的：面板用插件 `config.systemPresets` 给下拉提词（默认 `witops`、`jenkins`），
实际 id 仍要跟消费方的 `accountSystemId` 一致。改预设只需改 `plugins.json` 里本插件的 `config.systemPresets`，无需改代码。

## Capability `accounts.credentials` v1.0.0

| 方法 | 入参 | 返回 |
| --- | --- | --- |
| `accounts.list` | `{}` | `{ accounts: [{ id, username, note, hasPassword }] }` |
| `systems.list` | `{ enabledOnly? }` | `{ systems: [{ id, name, baseUrl, accountId, enabled, username, hasAccount, hasPassword }] }` |
| `credential.resolve` | `{ system }` | `{ systemId, accountId, username, password, baseUrl }` |

`credential.resolve` 在系统不存在/禁用、未绑定账号、账号未设密码时抛 `1004`。

```json
{
  "permissions": ["capabilities:call"],
  "requires": [
    { "name": "accounts.credentials", "version": "^1.0.0", "methods": ["credential.resolve"] }
  ]
}
```

```js
const { username, password, baseUrl } = await ctx.capabilities.call('accounts.credentials', 'credential.resolve', {
  system: 'jenkins',
})
```

## 面板与复用小组件

面板提供账号/系统两个页签。其他插件的面板可以复用统一账号小组件：

```html
<div id="credentials"></div>
<script src="/api/plugins/accounts-core/panel/widget/credentials-widget.js"></script>
<script>
  TrellisCredentialsWidget.mount({
    root: document.getElementById('credentials'),
    request: (method, path) => rpc(method, path), // 本面板自己的 postMessage 桥
    systemId: 'jenkins',
  })
</script>
```

小组件只调用宿主插件自己的 `GET /credentials`（由宿主插件代理 `credential.resolve`），
因此 widget 不需要 `capabilities:call`，也不接触密码。小组件默认每 15 秒（`pollMs` 可改）
重读一次，页面重新可见时也立即刷新，所以在「统一账号」里改完无需重开面板。

同一个目录里还有一个通用的可搜索下拉框，`jenkins-ops` 的分支参数也用它：

```html
<script src="/plugin-ui/v1/combo.js"></script>
<script>
  const combo = TrellisCombo.create({
    id: 'system-id',
    name: 'system-id',
    options: ['jenkins', { value: 'witops', label: 'witops · WitOps 平台' }],
  })
  container.append(combo.root, combo.hint)
  combo.setOptions(next) // 重新给候选；combo.value 是输入框当前文本
</script>
```

面板的按钮、表格、字段、对话框、提示条由宿主 `/plugin-ui/v1/` 统一提供，见
`.trellis/spec/backend/plugin-runtime.md` 7.2；本面板只保留业务布局（`panel/app.css`）。

样式自带（`combo.css` 自动注入），浮层用 `position: fixed` 定位，不会被
`<dialog>` 默认的 `overflow: auto` 裁掉。

## 变更事件

每次账号/系统/密码变更都会发布公开事件 `accounts-core/changed`
（payload：`{ kind: 'account' | 'system', id, at }`，需要 `events:publish` 权限）。
`jenkins-ops`、`witops-core` 订阅后立即重算凭据并丢弃缓存，因此运行中新增账号或系统也能马上生效。

```json
{ "permissions": ["events"], "config": {} }
```

```js
ctx.events.on('accounts-core/changed', async () => {
  await refreshAccounts({ reason: 'accounts-changed' })
})
```

## 测试

```bash
npm run test:plugins
node --test plugins/accounts-core/test/*.test.js
```

`test/index.test.js` 覆盖 CRUD、密码不回传、capability 解析、删除保护、重启后持久化；
`test/fixtures/accounts-caller` 是 capability 调用方样例。
