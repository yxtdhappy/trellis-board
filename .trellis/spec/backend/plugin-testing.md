# 插件测试规范

适用范围：`server/plugins/`、`plugins/<id>/test/`、`tests/plugin-*.test.js`、`tests/fixtures/plugins/`。

目标：协议回归能定位到具体帧、方法和错误码；功能回归能定位到任务文件、`plugin_run`、HTTP 响应或事件，而不是只证明插件进程能启动。

## 分层

| 层 | 测什么 | 入口 | 允许替身 | 代表文件 |
| --- | --- | --- | --- | --- |
| L1 协议单元 | 帧编解码、JSON-RPC 形状、版本范围、超时 | 纯函数 | 无 | `tests/plugin-protocol.test.js`、`tests/plugin-version.test.js` |
| L2 宿主-插件契约 | 握手、权限、事件、取消、生命周期、HTTP 命名空间 | 真实子进程 + fixture 插件 | 仅时钟、端口 | `tests/plugin-supervisor.test.js`、`plugin-sdk.test.js`、`plugin-http.test.js`、`plugin-events.test.js`、`plugin-cancel.test.js`、`plugin-oversized-frame.test.js` |
| L3 插件功能 | 单个插件的业务结果 | `createHarness` 启动真实插件，经 HTTP/事件驱动 | 外部平台 HTTP、ACP agent、时钟 | `plugins/acp-dispatch/test/index.test.js`、`plugins/a2a-intake/test/index.test.js` |
| L4 真实组合 | 真实 agent/平台 | 真实 CLI/网络，env 开关 | 仅外部服务 | `plugins/acp-dispatch/test/real.test.js` |

- 每个产品插件至少有一个 L3 文件：`plugins/<id>/test/index.test.js`；清单/握手测试放同目录 `manifest.test.js`。
- 插件私有的 fixture 放 `plugins/<id>/test/fixtures/`；跨插件 harness 与任务仓库辅助仍放 `tests/helpers/`。
- L3 必须走真实入口：`createHarness` 读取 `plugin.json`、启动子进程、经 `/api/plugins/<id>/...` 或事件驱动；不得直接 import 插件内部函数来替代入口。
- L2 不为单个业务插件写分支；新增协议行为先加 fixture 插件和 L2 用例。
- L4 默认跳过，不能成为唯一证据。

## L2 必测清单

### 清单与版本

- `plugin.json` 的 `id` 与目录一致，`version` 是 semver，`apiVersion` 等于宿主版本，`engines.board` 能匹配宿主。
- 清单失败按固定顺序返回 `invalid-manifest`、`id-mismatch`、`invalid-version`、`1006`、`board-too-old` / `board-too-new`。
- 握手回包的 `id`、`version`、`apiVersion` 与清单不一致时返回 `1008`，插件标为 `incompatible`。
- 配置里的 `version` 钉版本时，升级/降级行为与审计记录正确。

### 生命周期

- `initialize` 成功后状态为 `running`；`shutdown` 逆序执行 effect 并调用 `onStop`。
- 插件崩溃后按退避重启并累加 `restarts`；超过窗口上限自动禁用。
- `stop` 后请求返回 `1007`，进程树被终止，没有孤儿进程。
- 插件未运行时命名空间路由返回 `503`。

### JSON-RPC 与帧

- 帧是单行 JSON 加换行；支持分片、同块多帧、空行。
- 非法 JSON 返回 `-32700`，未知方法返回 `-32601`，非法参数返回 `-32602`。
- 应用错误码放在 `error.data.code`，标准 JSON-RPC 码保持负数。
- 单帧超过 1 MiB 时断开插件并写 `frame-too-large` 审计，而不是丢帧后继续。
- 插件迟到的响应不能覆盖已超时请求，也不能写入已关闭的流。

### 权限与路由

- 未声明权限的宿主方法返回 `1001` 并写 `permission_denied` 审计。
- 根路径冲突时后加载者失败，先加载者保持可用。
- 插件不能抢占 `/api` 等核心根路径。
- 公开根路径必须校验 Bearer token：缺失 `401`、错误 `403`、未配置 token 时不挂载。

### 超时与取消

- 请求超时返回 `1003`，先发 `request/cancel`，不杀进程。
- 插件收到 `request/cancel` 后中止 handler，未决权限请求回 `cancelled`。
- 取消后的迟到结果被忽略；重复取消不抛错。

### 配置与敏感信息

- `secret:scope/key` 能从独立文件解析，缺失时插件停在 `missing-secret` 且不 spawn。
- `env:NAME` 行为不回归；明文敏感字段产生告警但仍加载。
- POSIX 下 secrets 文件非 `0600` 时拒绝加载，解析失败的错误信息不包含文件内容。
- `GET /api/plugins` 不出现 secret 原值，`credentials.source` 标 `secret` / `env` / `inline` / `mixed` / `none`。

### 事件与运行记录

- 事件按 at-least-once 投递：插件 `ack` 后落库，未 ack 超时重投，重启后仍能送达。
- 队列达到上限时丢最旧一条并累加 `droppedEvents`。
- `run/start`、`run/progress`、`run/finish` 写入 `plugin_run`；`runId` 带 attempt；同一插件同一任务最多一条活动 run。
- 插件停止或崩溃时，宿主把活动 run 收敛为 `failed`。

## L3 功能必测清单

- 正常路径：从真实入口触发一次完整流程，断言外部结果（任务目录、`task.json`、`prd.md`、`meta`、`plugin_run`、HTTP 响应体）。
- 输入校验：缺少必填字段、非法类型、未知枚举时返回明确错误，且不产生部分写入。
- 幂等：重复消息、重复 `messageId`、重复任务键不会创建第二条任务或第二条活动 run。
- 外部失败：4xx、5xx、超时、token 过期时按约定重试、重登或终止，并在 run 中留下可查询的失败原因。
- 分页与上限：多页拉取、`maxPerSync`、并发上限按配置生效。
- 持久化：插件重启后能从 `plugin_state` 恢复会话、游标或幂等键。
- 清理：停止后没有残留子进程、临时文件、定时器或监听器。
- 脱敏：日志、审计、`/api/plugins` 响应不回显 token、密码、Cookie。
- 边界映射：状态、优先级、环境、负责人等字段的未知值有明确回退，不静默丢数据。

## 测试设计规则

- **测试真实入口路径**：参考 dsh 的教训，手工挂载插件通过不代表真实 Loader/子进程路径通过；至少一个用例必须从 `createHarness` + `runtime.start()` 进入。
- **优先真实实现**：宿主、SQLite、`task.py`、子进程、文件系统保持真实；只对高成本或不确定的外部边界做替身（平台 HTTP、ACP agent、时钟）。
- **验证外部世界**：断言文件、数据库行、HTTP 状态/响应和事件 payload；日志只能作为辅助证据，不能作为唯一断言。
- **断言顺序与原子性**：先断言失败路径没有副作用，再断言成功路径；批量操作要证明失败时没有部分写入。
- **隔离与清理**：临时目录用 `fs.mkdtempSync`，HTTP 用端口 `0`，任务键和消息 id 唯一；`finally` 中关闭服务、停止 runtime、关闭 DB、删除目录。
- **有界等待**：用 `waitFor(predicate, { timeoutMs })`，不要用固定 `setTimeout` 猜测完成时间；只有测试退避/间隔时才显式等待。
- **失败信息可定位**：断言消息带上实际状态、响应体或 run 记录，避免只报 `expected true`。
- **回归守卫要能变红**：修复缺陷前先写失败用例，确认去掉修复会失败；不要只补一个永远为真的断言。
- **安全**：测试不读取真实凭据，fixture 使用占位符；真实平台/agent 测试用 env 开关，默认跳过；快照和日志不包含 token。

## 覆盖矩阵

| 插件 | 清单/握手 | L2 契约 | L3 功能 | L4 真实组合 |
| --- | --- | --- | --- | --- |
| `a2a-intake` | `plugins/a2a-intake/test/manifest.test.js` | `plugin-supervisor` / `plugin-http` / `plugin-events` | `plugins/a2a-intake/test/index.test.js` | 无 |
| `acp-dispatch` | `plugins/acp-dispatch/test/manifest.test.js` | 同上 | `plugins/acp-dispatch/test/index.test.js` | `plugins/acp-dispatch/test/real.test.js`（`TRELLIS_REAL_ACP=1`） |

私有插件不进入本仓库，测试由维护者在本地执行。
私有插件测试放在被忽略的 `plugins/<id>/test/`；同一用例文件同时依赖多个私有插件时，缺少插件必须以 `skip` 跳过，不能让公开测试套件失败。

## 执行命令

```bash
npm test
node --test tests/*.test.js plugins/*/test/*.test.js
TRELLIS_REAL_ACP=1 node --test plugins/acp-dispatch/test/real.test.js
```

## 新增插件检查清单

- [ ] `plugins/<id>/plugin.json` 的 id、version、apiVersion、engines、permissions 完整。
- [ ] 新增 `plugins/<id>/test/index.test.js` 与 `manifest.test.js`，通过 `createHarness` 启动真实子进程并从 HTTP/事件驱动。
- [ ] 覆盖正常路径、输入校验、幂等、外部失败、持久化、清理和脱敏。
- [ ] 新增协议方法或错误码时，先加 fixture 插件和 L2 用例。
- [ ] 外部平台/agent 只做边界替身，宿主、DB、`task.py` 保持真实。
- [ ] 测试在 `finally` 中清理临时目录、端口、进程和数据库。
- [ ] 真实环境测试用 env 开关，默认跳过，且不读取真实凭据。
- [ ] 更新本文件的覆盖矩阵。
