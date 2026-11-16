# 插件运行时（`apps/server/plugins/`）

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
- 停插件顺序：`shutdown` → 3s 等待 → `terminateTree`（`apps/server/team/process.js`）。

## 4. 存储与命名空间

- **插件一律不碰 SQLite**，只能通过 SDK 的 `ctx.store`；宿主按 `<pluginId>:<key>` 隔离。
- 宿主表：`plugin_state`、`plugin_run`、`plugin_audit`。
- 运行记录只能通过 `ctx.runs.start/progress/finish/list` 写；`runId` 固定为 `<pluginId>:<taskKey>:<attempt>`，
  同一插件同一任务最多一条活动 run（部分唯一索引 `plugin_run_active_task`）。
- 插件 HTTP 命名空间是 `/api/plugins/<id>/*`；`/api/plugins/<id>/{start,stop,logs,runs,audit}` 属于宿主，
  插件不得注册同名路由（例如运行历史用 `/executions`）。
- `http.rootPaths` 走宿主根路径转发，默认要求 `Authorization: Bearer <plugin.config.token>`；
  缺少 token 返回 `401`，token 不符返回 `403`。`http.openPaths` 中的路径免 token（只放只读发现类接口）。

## 5. 任务写入

- 插件写任务只能走 `ctx.tasks.create/assign/setStage`；宿主复用 `apps/server/actions.js` 与 `apps/server/metadata.js`。
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
- 凭据有效性由消费方验证（登录目标系统时才知道对错），账号簿不做校验。

## 7. 测试约定

- 宿主侧测试用 `packages/test-support/plugin-runtime.js` 建临时 workspace + 真实 SQLite，不 mock store。
- 插件协议用 `packages/test-support/fixtures/plugins/*` 的假插件；ACP 用 `plugins/acp-dispatch/test/fixtures/fake-agent.js`。
- 跨插件 capability 的消费方用插件目录内的 `test/fixtures/<name>-caller/` 假插件（如
  `plugins/accounts-core/test/fixtures/accounts-caller/`、`plugins/jenkins-ops/test/fixtures/jenkins-caller/`）。
- `apps/server/test/plugin-real-task.test.js` 跑真实 `.trellis/scripts/task.py`，验证宿主任务 façade 与脚本参数兼容。
- 插件任务的宿主调用依赖 `python`；`apps/server/actions.js` 已回退到 `python3`，测试不需要注入 PATH shim。
- 断言插件状态要等“终态”，不要只等 `status`（重启期间状态可能仍是 `running`）。

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

宿主能力是插件唯一稳定接口。插件不得直接读运行数据目录、`apps/server/` 或宿主数据库；需要新能力时先扩展本清单和 SDK，而不是在插件里绕过。

宿主核心 capability 与插件 capability 共用 `provides` / `requires` 模型。`trellis.repositories` 管理工作区；
`trellis.projects` 提供项目上下文（`list` / `get` / `current`，权限 `projects:read`），供插件按左侧选中的项目
解析 `repositoryId`、名称与路径；`trellis.capabilities` 提供能力目录与通用调用（`list` / `call`），调用方需要声明 `capabilities:invoke`
（应只授予受信任的桥接插件）。
插件不应把可选或私有插件名写进自己的 manifest 或代码；需要跨插件调用时，通过 `trellis.capabilities.call`
由运行时参数决定目标。
