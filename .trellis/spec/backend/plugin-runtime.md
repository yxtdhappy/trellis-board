# 插件运行时（`packages/server/plugins/`）

适用：所有插件宿主代码与 `plugins/<id>/` 下的插件实现。设计依据见
[.trellis/tasks/11-04-plugin-architecture/prd.md](../../../.trellis/tasks/11-04-plugin-architecture/prd.md)。

## 1. 进程与协议

- 插件是**独立子进程**，通过 stdin/stdout 交换 **NDJSON**（一行一个 JSON-RPC 2.0 消息），stderr 只写日志。
- 单帧上限 1 MiB；超限由 `createFrameDecoder` 丢弃并计数，宿主侧返回 `1003`。
- 握手：宿主 `initialize {apiVersion, hostVersion, config}` → 插件返回 `{apiVersion, id, name, version, capabilities}`；回包与 `plugin.json` 不一致时按 `1008` 处理。
- 宿主→插件默认超时：`initialize` 10s、`http/request` 30s、`event/dispatch` 10s、`plugin/status` 5s、`shutdown` 5s；可用配置 `timeoutOverrides` 覆盖。
- 应用错误码 `1001`~`1008` 放在 `error.data.code`；标准 JSON-RPC 码保持负数。未知方法必须返回 `-32601`。

## 2. 清单与版本

`plugins/<id>/plugin.json` 是加载与握手的唯一依据：

```json
{
  "id": "example",
  "name": "example",
  "version": "1.0.0",
  "apiVersion": 1,
  "engines": { "board": ">=0.2.0" },
  "permissions": ["tasks:read", "store"],
  "http": { "rootPaths": ["/example"], "openPaths": [] }
}
```

- 校验顺序：`invalid-manifest` → `id-mismatch` → `invalid-version` → `1006`（apiVersion 不等）→
  `board-too-old` / `board-too-new` → `pinned-mismatch`（配置用 `version` 钉住）。
- `engines.board` 只支持 `>=`、`<=`、`>`、`<`、`^`、`~`、精确版本、`*` 与空格 AND；不支持 `||` 和区间连字符。
- 升级/降级按 `plugin_state.__manifest.version` 比较并写审计；降级额外告警。
- `HOST_API_VERSION` 是协议版本，与 `SCAN_SCHEMA_VERSION`、`package.json` 版本无关。

### 2.1 命名约定

- 目录名与 `id` 必须一致，使用 `<领域>-<能力>` 的 kebab-case；`plugins/` 下的插件都属于 Trellis Board，
  不加 `trellis-board-` 前缀。
- `name` 是展示名（中文或产品名），不能与 `id` 相同；`description` 必填，说明插件职责。
- 同一领域的能力使用同一前缀，例如 `witops-core`、`witops-intake`、`witops-workbench`。

## 3. 生命周期与稳定性

- 崩溃重启指数退避：1s、2s、4s、8s、16s，上限 60s；10 分钟内 5 次则自动 `disabled`。
- 健康检查 30s 一次，连续 3 次失败按崩溃处理；手动 `start` 清空重启计数并允许恢复。
- 根路径冲突或占用核心前缀（`/`、`/api`）的插件直接 `blocked`，不 spawn。
- 停插件顺序：`shutdown` → 3s 等待 → `terminateTree`（`packages/server/team/process.js`）。

## 4. 存储与命名空间

- **插件一律不碰 SQLite**，只能通过 SDK 的 `ctx.store`；宿主按 `<pluginId>:<key>` 隔离。
- 宿主表：`plugin_state`、`plugin_run`、`plugin_audit`。
- 运行记录只能通过 `ctx.runs.start/progress/finish/list` 写；`runId` 固定为 `<pluginId>:<taskKey>:<attempt>`，
  同一插件同一任务最多一条活动 run（部分唯一索引 `plugin_run_active_task`）。
- 插件 HTTP 命名空间是 `/api/plugins/<id>/*`；`/api/plugins/<id>/{start,stop,logs,runs,audit,sort}` 属于宿主，
  插件不得注册同名路由（例如运行历史用 `/executions`）。
- `http.rootPaths` 走宿主根路径转发，默认要求 `Authorization: Bearer <plugin.config.token>`；
  缺少 token 返回 `401`，token 不符返回 `403`。`http.openPaths` 中的路径免 token（只放只读发现类接口）。

## 5. 任务写入

- 插件写任务只能走 `ctx.tasks.create/assign/setStage`；宿主复用 `packages/server/actions.js` 与 `packages/server/metadata.js`。
- `taskKey` 固定为 `<repositoryId>::<relativeDir>`；`relativeDir` 形如 `11-04-<slug>`。
- 文件写入必须走原子替换；`task/create` 的 `extraFiles` 只允许任务目录内的相对路径。
- 事件：宿主发布 `scan.completed`、`task.assigned`、`task.stage.changed`；`event/emit` 会回送到所有订阅者。

## 6. 配置与敏感信息

- 插件配置目录中的 `plugins.json` 只放路径、开关与运行参数；敏感值优先用 `secret:scope/key` 引用
  同目录的 `plugins.secrets.json`，也支持 `env:NAME`。
- 插件配置目录默认是 `<TrellisBoard>/plugins`（Linux `${XDG_DATA_HOME:-~/.local/share}/TrellisBoard/plugins`、
  macOS `~/Library/Application Support/TrellisBoard/plugins`、Windows `%LOCALAPPDATA%\TrellisBoard\plugins`），
  可用 `TRELLIS_BOARD_PLUGINS_DIR` 覆盖；带 `TRELLIS_BOARD_DATA_DIR` 时退化为 `<数据目录>/plugins`。
  目录内固定为 `plugins.json`、`plugins.secrets.json`、`plugins.secrets.key` 与 `logs/<id>.log`。
- 插件入口解析：绝对路径原样使用；约定路径 `./plugins/<id>/<sub>` 先找 `<pluginsDir>/<id>/<sub>`，
  不存在再回退到安装目录 `appDir`，用于在不改安装目录的前提下覆盖或新增私有插件。
- `plugins.json` 的每个插件条目额外支持 `sort`（数字，可省略）：它同时决定 `/api/plugins` 里插件的顺序
  与 `/api/panels` 里面板的位置，优先于清单的 `panels[].order`；没设置 `sort` 的插件保持文件顺序排在后面，
  面板按清单顺序。同 `sort` 值再按 `panels[].order`、标题排序。
- 插件页用拖动排序，服务端 `POST /api/plugins/order`（`{"ids": [...]}`，必须覆盖全部插件）把
  `plugins.json` 的 `plugins` 数组按新顺序重排，并依次写入 `sort = 10/20/30…`；单条改值仍可用
  `POST /api/plugins/<id>/sort`（`{"sort": 5}` / `{"sort": null}` 清除）。两者都只改配置文件的对应行、
  原子替换，不重启插件。
- secrets 文件默认与 `plugins.json` 同目录，可用 `TRELLIS_BOARD_SECRETS_FILE` 覆盖；格式为
  `{"version": 1, "refs": {"scope/key": "value"}}`，refs key 必须是 `scope/key`，值必须是非空字符串。
- POSIX 下 secrets 文件必须是 `0600`；group/other 可读时直接拒绝加载，错误只报文件名与权限，不回显内容。
- 缺失 `secret:` 或 `env:` 时插件标记 `missing-secret`，不 spawn；错误只报 key/变量名，不报值。
- 明文敏感字段允许加载但写启动告警；`describe()` 的 `config` 只回显 `***`，`credentials.source`
  标 `secret` / `env` / `inline` / `mixed` / `none`。
- 不提供 secrets 写入 API/CLI/UI；手动编辑后重启生效。热重载与 OS keychain 暂不做。
- 同 UID 的进程仍可读该文件，文件权限只防其他用户；备份运行数据目录会包含密钥。

### 6.1 跨插件凭据共享

- 宿主 secret 按插件隔离（`requirePluginSecretKey` 只允许 `<pluginId>/...`），所以「多个插件共用同一套内网账号」
  不能靠共享 secret，只能靠 capability。
- 标准做法：`accounts-core` 持有账号与密码，提供 capability `accounts.credentials`
  （`accounts.list` / `systems.list` / `credential.resolve`）；消费方在 manifest 声明
  `"permissions": ["capabilities:call"]` 与 `requires: [{ "name": "accounts.credentials" }]`。
- 消费方配置统一用 `credentialSource`（`auto` / `accounts` / `local`）与 `accountSystemId`；
  解析失败时 `auto` 静默回退到插件本地配置（`config` + 插件自己的 secret），失败原因通过状态接口暴露。
- 面板复用 `accounts-core/panel/widget/credentials-widget.js`，只调用宿主插件自己的 `GET /credentials`，
  密码永不出现在任何 HTTP 响应里；`credential.resolve` 是唯一明文出口，且只走插件进程间 RPC。
- 变更通知：`accounts-core` 每次变更发布公开事件 `accounts-core/changed`（需 `events:publish`），
  消费方声明 `events` 权限后 `ctx.events.on('accounts-core/changed', ...)` 重算凭据，
  不需要重启插件；重算时先算完再一次性提交，避免事件回包期间状态短暂变空。
- 凭据有效性由消费方验证（登录目标系统时才知道对错），账号簿不做校验。

## 7. 测试约定

- 宿主侧测试用 `packages/test-support/plugin-runtime.js` 建临时 workspace + 真实 SQLite，不 mock store。
- 插件协议用 `packages/test-support/fixtures/plugins/*` 的假插件；ACP 用 `plugins/acp-dispatch/test/fixtures/fake-agent.js`。
- 跨插件 capability 的消费方用插件目录内的 `test/fixtures/<name>-caller/` 假插件（如
  `plugins/accounts-core/test/fixtures/accounts-caller/`、`plugins/jenkins-ops/test/fixtures/jenkins-caller/`）。
- `packages/server/test/plugin-real-task.test.js` 跑真实 `.trellis/scripts/task.py`，验证宿主任务 façade 与脚本参数兼容。
- 插件任务的宿主调用依赖 `python`；`packages/server/actions.js` 已回退到 `python3`，测试不需要注入 PATH shim。
- 断言插件状态要等“终态”，不要只等 `status`（重启期间状态可能仍是 `running`）。

### 7.1 面板在 sandbox iframe 里

面板由 `packages/web/src/features/plugins/PluginPanel.tsx` 以 `sandbox="allow-scripts allow-forms"` 嵌入，
没有 `allow-same-origin`、`allow-modals`：

- 面板脚本里 `window.confirm()` / `alert()` / `prompt()` 被浏览器静默忽略，`confirm()` 直接返回 `false`。
  需要二次确认时用 `TrellisUI.confirm()`（宿主提供），或面板内自己的 `<dialog>`。
- 宿主不能 `iframe.contentDocument` 读面板 DOM；面板也不能读宿主 `window.parent.document`。
  面板里做 E2E 断言要靠无障碍快照/截图，不能 `page.evaluate` 进去。
- 所有请求走 postMessage 桥：`{ type: 'trellis:request', id, method, path, body }` →
  `fetch('/api/plugins/<pluginId>' + path)`，插件面板只能访问自己的命名空间。

### 7.2 面板 UI 组件库（宿主 `/plugin-ui/v1/`）

面板跑在 `sandbox` iframe 里，不能读宿主 DOM、不能用宿主 React 组件，之前每个面板各写一套按钮/表格/下拉框，
配色也有 3 套色板。现在由宿主统一提供 v1 组件库，**不属于任何插件**（插件禁用/目录重构都不影响）：

| 文件 | 作用 |
| --- | --- |
| `packages/server/plugin-ui/v1/tokens.css` | 设计令牌 `--tb-*`，兜底值与宿主 `packages/web/src/index.css` 一致 |
| `packages/server/plugin-ui/v1/base.css` | reset、字体、焦点环、`.tb-muted/.tb-small/.tb-row/.tb-grow` |
| `packages/server/plugin-ui/v1/ui.css` | `.tb-btn/.tb-input/.tb-table/.tb-field/.tb-chip/.tb-dialog/.tb-toast` 等类 |
| `packages/server/plugin-ui/v1/bridge.js` | postMessage 桥：`TrellisBridge.create()` → `get/post/delete/request`、`onEvent`、`ready` |
| `packages/server/plugin-ui/v1/ui.js` | 组件工厂：`button/toolbar/field/chip/empty/toast/confirm/table`、`el()`、`<tb-dialog>` |
| `packages/server/plugin-ui/v1/combo.js\|css` | 可搜索下拉框 `TrellisCombo.create()` + `<tb-combo>` 元素 |
| `packages/server/plugin-ui/v1/demo.html` | 全组件的可视展柜（含明暗主题切换），改组件后先看这里 |

面板标准引法：

```html
<link rel="stylesheet" href="/plugin-ui/v1/tokens.css" />
<link rel="stylesheet" href="/plugin-ui/v1/base.css" />
<link rel="stylesheet" href="/plugin-ui/v1/ui.css" />
<link rel="stylesheet" href="/plugin-ui/v1/combo.css" />
<script src="/plugin-ui/v1/bridge.js"></script>
<script src="/plugin-ui/v1/combo.js"></script>
<script src="/plugin-ui/v1/ui.js"></script>
```

```js
const bridge = window.TrellisBridge.create()
const { button, table, field, chip, confirm, toast, el } = window.TrellisUI
const rows = table({ columns: [{ title: '账号', key: 'username' }] })
rows.render(await bridge.get('/accounts').then((p) => p.accounts))
```

约定：

- **颜色只用令牌**：面板 CSS 不写十六进制/`oklch`，一律 `var(--tb-bg|card|fg|border|accent|muted|danger|ok|warn|radius)`。
  宿主在 `trellis:init` 里下发白名单计算值（`PluginPanel.tsx` 的 `PANEL_TOKEN_NAMES`），`bridge.js` 写到 `:root`，
  所以宿主换主题/配色面板自动跟随。**不要**自己定义 `--bg/--fg/--accent` 那一套。
- **形态按数据流选**：`table/field/button/toolbar/chip/toast/confirm` 用工厂函数（light DOM，要拿节点/合事件）；
  `combo`/`dialog` 用 custom element（打开状态、焦点、浮层属于组件内部）。
- **v1 只增不改**：破坏性改动开 `v2`，面板按需切版本；不要改已发布行为。
- `TrellisUI.el()` 的属性处理与 `combo.js` 一致（`class/text/dataset/on*`），没有 `innerHTML` 入口。
  子节点传数组会递归展开（`table` 的操作列常这样返回多个按钮），不要把按钮数组直接拼成字符串。
- **组合控件只画一圈边框**：`combo` 的输入框与展开按钮都不带自己的 border/圆角，边框和
  `:focus-within` 的焦点环由外层 `.combo` 承担（`border-color: accent` + `box-shadow: 0 0 0 2px` 22% 透明，
  与 `.tb-input:focus` 一致）。这样组合内外圆角统一，也不会出现「边框 + 1px 空隙 + 焦点环」的双层边。
- `/plugin-ui/*` 由 `packages/server/index.js` 的 `servePluginUi` 映射到 `packages/server/plugin-ui/`；
  不要把通用 UI 放进某个插件的 `panel/widget/`（会形成隐式跨插件依赖，插件目录只管自己的东西）。
- 仓库内面板（accounts-core / acp-dispatch / jenkins-ops / scenario-copilot / witops-core）已统一用 v1：
  页面只引 `tokens/base/ui/combo` 与 `bridge/ui/combo` 脚本，`panel/app.css` 只保留本面板布局，
  不再定义颜色变量、按钮、表格、对话框、提示条这些通用样式。新面板照此写，不要回退成自带一份。

### 5.1 命名边界

- 插件提交 `slug` 候选；宿主负责 trim、保留大小写、`TASK_SLUG_PATTERN` 校验、`MM-DD-` 日期前缀、目录冲突检查和 `taskKey` 生成。
- 宿主不内置平台编号规则（T/R/B/W 等）。这类语义属于插件域：插件优先使用平台返回的 `code`，缺失时使用自己的回退规则。
- 需要从标题生成 slug 时，插件自己生成候选；宿主不提供额外的命名 RPC，避免把平台语义带进核心。
- `task/create` 返回 `relativeDir` 和 `taskKey`，插件应使用返回值，不要自行拼接日期或目录名。

## 8. 插件能力清单

| 能力 | 入口 | 权限 | 边界 |
| --- | --- | --- | --- |
| 生命周期 | `onStart` / `onStop` | 无 | 宿主启动/停止子进程；`onStop` 必须释放资源 |
| 任务读取 | `ctx.tasks.get` / `ctx.tasks.list` | `tasks:read` | 只返回任务 DTO，不暴露仓库文件句柄 |
| 任务写入 | `ctx.tasks.create` / `assign` / `setStage` | `tasks:write` | `create` 接受 slug 候选，最终命名由宿主决定 |
| 运行记录 | `ctx.runs.start` / `progress` / `finish` / `list` | `runs:write` / `runs:read` | 同一任务同一插件最多一条活动 run |
| 事件 | `ctx.events.on` / `emit` | `events` / `events:emit` | at-least-once；插件必须幂等 |
| 键值存储 | `ctx.store.get` / `set` / `delete` / `list` | `store` | 按插件隔离；值必须是 JSON |
| HTTP | `ctx.http.route` / `public` | `http:route` | 命名空间 `/api/plugins/<id>`；根路径需声明 |
| 定时器 | `ctx.schedule.every` / `cancel` | `schedule` | 宿主重启后不自动恢复，插件在 `onStart` 重新注册 |
| 日志 | `ctx.log.*` | 无 | 写宿主日志；不得输出 token/密码 |
| 配置 | `ctx.config` | 无 | 只读；敏感值由宿主解析为 `secret:` / `env:` |
| 清理 | `ctx.effect(dispose)` | 无 | 插件停止或崩溃时逆序执行 |
| 敏感信息 | `ctx.secrets` | 无 | 只读环境变量；不提供写入 API |

宿主能力是插件唯一稳定接口。插件不得直接读运行数据目录、`packages/server/` 或宿主数据库；需要新能力时先扩展本清单和 SDK，而不是在插件里绕过。

宿主核心 capability 与插件 capability 共用 `provides` / `requires` 模型。`trellis.repositories` 管理工作区；
`trellis.projects` 提供项目上下文（`list` / `get` / `current`，权限 `projects:read`），供插件按左侧选中的项目
解析 `repositoryId`、名称与路径；`trellis.capabilities` 提供能力目录与通用调用（`list` / `call`），调用方需要声明 `capabilities:invoke`
（应只授予受信任的桥接插件）。
插件不应把可选或私有插件名写进自己的 manifest 或代码；需要跨插件调用时，通过 `trellis.capabilities.call`
由运行时参数决定目标。

## 9. 常见陷阱

- **改 manifest 必须重启 server**：`plugin.json` 的 `version`、`provides`/`requires` 变更后，只 stop/start 插件不会重读清单，可能出现 `1008 插件握手版本与清单不一致`。停掉 server 进程后重新启动，再检查 `/api/plugins` 的 `version/status/lastError`。
- **`http/request` 默认 30s，插件侧改不了**：耗时操作（模型生成、批量回归）不要同步等待。立即返回 `202 {jobId}`，用 `GET ...?jobId=` 轮询；面板 bridge 显式设 `timeout: 300000`。
- **插件目录默认被忽略**：根 `.gitignore` 的 `plugins/*` 会忽略 `plugins/witops-workbench/**` 等本地插件。改完先 `git check-ignore -v <path>` 确认是否会进入提交；不会时需单独部署/同步。
