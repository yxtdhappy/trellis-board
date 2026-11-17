# PRD：团队版插件机制（team-plugin-core）

- 任务目录：`.trellis/tasks/11-16-team-plugin-core/`
- 分支：`codex/trellis-board-team`
- 状态：planning

## 1. 背景

当前 `standalone` 模式已经有一套完整插件运行时（`apps/server/plugins/`）：子进程 + NDJSON JSON-RPC、manifest 校验、
`plugins.json` 配置、`plugins.secrets.json` 密钥、capability 注册与代理、store/runs/audit、HTTP 命名空间。

`team` 模式**完全没有插件**：`apps/server/team/http.js` 里对 `/api/plugins` 只返回
`{disabled:true, plugins:[], mode:'team'}`，其他插件路由直接 `404 team 模式不加载插件`；前端 `BoardPage` 仍然会调
`fetchPanels()`，所以在团队版看不到任何面板。

团队版和 standalone 的语义完全不同，不能简单地把 `createPluginRuntime` 挂上去：

| 维度 | standalone | team |
| --- | --- | --- |
| 使用者 | 本机一个人 | 多账号（基线 400 账号） |
| 插件配置 | 一份全局 `plugins.json` | 每个用户各自的账号/偏好 |
| 凭据 | 一份 `plugins.secrets.json` | 每人各自的第三方账号 |
| 数据归属 | 无 | 团队 / 项目 / 项目成员角色 |
| 插件调用者身份 | 无 | 会话 actor（系统管理员 / 团队管理员 / 项目 lead / 成员） |
| 配置生效方式 | 热 reload（`plugin/configure`） | 重启服务加载代码；配置变更即时生效 |

目标：为 team 模式设计并实现 `team-plugin-core`——一套**按用户隔离配置与凭据、按 actor 授权、随服务启动加载**的插件机制，
并以 `witops-core` 作为端到端验证对象：**管理人员用自己配置的 witops 账号，查询某个 witops 项目下的全部任务**。

参考实现：`/opt/app/work/github/trellis-board/tmp/project/weint-witops-web` 的「项目空间」——
项目顶部选择器 + 我管理的/我参与的两种视角 + 项目内按角色下发菜单 + 项目任务列表。
对应接口：

```text
POST /weint-witops-service/project/findByMaster       # 我管理的项目
POST /weint-witops-service/project/findByParticipant  # 我参与的项目
POST /weint-witops-service/projectUserRole/userRole   # 我在项目里的角色/菜单
POST /weint-witops-service/task/task/page             # 项目下任务分页（types/code/productIds/name/tasksStatus/priority）
```

## 2. 需求

### R1 插件信息落库

插件代码仍在安装目录 `plugins/<id>/`，但"装了哪些插件、是否启用、团队是否启用、谁配置了什么"必须在数据库里：

- 服务启动时扫描 `plugins/*/plugin.json`，把 manifest 快照 upsert 到 `plugin_registry`；
- 出厂默认只启用 `witops-core`，其余插件登记但 `enabled=0`；
- 团队级启用/参数放 `plugin_team_setting`；
- 用户级配置放 `plugin_user_config`（只存非敏感偏好，过 `userConfigFields` 白名单），**不存任何账号/密码/token**；
- 插件运行记录、审计带 `user_id` / `team_id`。

### R2 随服务启动，代码更新需重启

- team 模式在服务启动时一次性完成：扫描 manifest → 读启用列表 → 逐个 spawn → 握手；
- 不提供插件代码热更新；`POST /api/plugins/reload` 在 team 下明确拒绝并提示重启服务；
- 单个插件的 `start` / `stop` 允许（只换进程，不换代码），限系统管理员；
- 插件崩溃重启有上限，超过后进入 `error` 状态并写审计，不拖垮主服务。

### R3 按用户隔离的配置与会话（凭据不落库）

- 每个用户用自己的 witops 账号登录，**账号密码不落库、不落文件、不落浏览器存储**；
- 登录成功后立即用密码换 token，密码丢弃；token 只存在**服务端内存**（`session.js` 的 `Map`），
  每个用户一条，A 用户的数据不得被 B 用户读到；
- 浏览器只拿一个不透明的 `handle`，存在**宿主页面内存**，**刷新页面即失效**，需重新登录（刻意如此）；
- **会话 TTL 12h**（与 WitOps 侧一致），不回收空闲（用户要求少频繁重登）；单条 1–2.5 KB，
  `maxEntries: 2000` 按 `expiresAt` 淘汰，60s `sweep()`（`.unref()`）；
- 数据库只存非敏感偏好（默认项目、上次选中、筛选、视图），且必须过 `manifest.userConfigFields` 白名单；
- 管理员只能看到“最后登录时间 / 是否在线”，并能强制下线（作废 handle）；看不到也无法恢复别人的凭据；
- 不提供“记住密码”选项。

### R3b WitOps 单会话约束（决定登录策略）

WitOps token **12h 有效、无 refresh、单会话**（任何地方重登会让旧 token 失效）、**logout 吊销全部**、有审计。因此：

1. **禁止自动重登**（必须删 `plugins/witops-core/auth.js:145` 的 `relogin` 分支），token 失效只返回
   `401 CONNECTION_LOST`，由用户重新输密码；
2. **禁止调用 WitOps logout**，“退出”只清本地 handle；
3. 登录只能是用户显式动作，不得后台懒登录；
4. **同一 WitOps 账号在 Board 内只允许一个占用者**，第二个用户登录返回
   `409 ACCOUNT_IN_USE { displayName }`，不提供强登；
5. 登录退避：1/2/4/8/16s，1 小时 ≤ 5 次，失败不自动重试；每次登录写 `plugin_audit`（账号掩码）。

### R4 权限模型

区分系统管理员 / 团队管理员 / 项目 lead / 项目成员 / 只读成员，明确谁能启用插件、谁配置自己的账号、谁能看面板、
谁能管别人的凭据。

### R5 actor 上下文透传

插件进程是全局单实例，但每次调用必须知道"这是谁在调"：宿主把 actor 注入 HTTP 转发，插件回传给宿主的
capability/store 调用必须带 `actorRef`，宿主校验后按 actor 解析权限与数据。
**凭据与 actor 是两套东西**：actor 证明"谁在调用"，session handle 证明"这个人已经登录过第三方系统"。

### R6 witops-core 端到端读路径

管理人员在团队版里完成：

1. 打开「WitOps 任务」面板；
2. 用自己的 witops 账号登录（**只用一次，密码不落库**）；
3. 看到"我管理的 / 我参与的项目"；
4. 选中一个项目，看到该项目下的全部任务（复刻项目空间任务页的筛选）；
5. Trellis 项目与 witops 项目建立绑定后，面板默认按当前 Trellis 项目带出对应 witops 项目。

本期不做写入（witops 任务 → Trellis 任务下发）。

## 3. 非目标

- 多实例 / 共享数据库 / 插件高可用；
- 插件代码热更新、插件市场、在线安装；
- 插件可访问宿主 SQLite（仍然只能通过 SDK）；
- witops 项目空间的完整菜单/角色镜像（本期只做「项目 → 任务」读路径）；
- 团队级共享第三方账号；
- **第三方凭据落地**：不建 `plugin_user_secret`、不写 `plugins.secrets.json`、不提供“记住密码”、不用 localStorage；
- 跨刷新/跨标签页/跨设备的登录态复用（刷新即重登是刻意取舍）；
- **多实例部署**：会话在进程内存里，必须 `replicas: 1` 且禁用 HPA。

## 4. 验收标准

| 编号 | 验收项 | 判定方式 |
| --- | --- | --- |
| A1 | team 启动后 `plugin_registry` 自动登记 `plugins/*`，`witops-core.enabled=1` | 启动后查库/`GET /api/plugins` |
| A2 | `GET /api/panels` 返回 `witops-core` 面板，未登录 401 | curl |
| A3 | 系统管理员 `POST /api/plugins/witops-core/stop` 生效，非管理员 403 | curl + 角色账号 |
| A4 | 登录后数据库里**找不到**任何 witops 账号/密码/token 字段；服务重启或页面刷新后旧 handle 全部失效 | 查库 + curl |
| A5 | 用户 A、B 各自登录后看到各自 witops 项目列表，互不串号；A 的 handle 被 B 使用返回 401/403 | 两个账号 curl/面板 |
| A6 | `POST /api/plugins/witops-core/session` 后 `GET /api/plugins/witops-core/projects` 返回 `findByMaster` 结果 | curl |
| A7 | `GET /api/plugins/witops-core/tasks?projectId=<id>` 返回 `task/task/page` 的任务列表 | curl |
| A8 | `POST /api/plugins/reload` 在 team 下返回 409 且提示重启 | curl |
| A10 | A 已在 Board 登录后，B 用同一 WitOps 账号登录 → `409 ACCOUNT_IN_USE`，A 的 handle 仍可用 | 两个账号 curl |
| A11 | token 被 WitOps 侧吊销后请求返回 `401 CONNECTION_LOST`，**日志里没有第二次登录请求** | 吊销 + 抓日志 |
| A12 | 面板与错误提示不含禁用词（会话/token/凭据/handle/接管/吊销/401） | 人工 + 可选扫描测试 |
| A9 | `npm test` / `npm run test:plugins` 通过（已知 desktop ui 失败除外） | 命令输出 |

## 5. 风险

- **witops 接口依赖真实环境**：`baseUrl` 与账号需在团队环境可用；E2E 用真实账号或记录跳过原因。
- **SDK 升级的兼容性**：standalone 插件在 team 下必须显式报"不支持"，不能静默降级到全局配置。
- **登录体验与 WitOps 审计**：无自动重登意味着 token 被外部踢掉后用户必须手工重输密码；若 WitOps 有登录频率风控，
  需要把退避参数再上调（已定 1h ≤ 5 次）。
- **pod 重启代价**：k3s 单 pod 重启 = 全员重登，并会踢掉用户在 WitOps 的其它会话；probe 要宽松
  （建议 `initialDelaySeconds: 30` / `periodSeconds: 30` / `failureThreshold: 5`）。
- **登录频率**：凭据不落库意味着刷新就重登；需要确认 witops 是否有登录风控/并发会话上限，若有则把
  空闲回收窗口从 30 分钟放宽，或改为"同一浏览器标签页内复用"。
- **体验成本**：刷新重登已是明确取舍（§11 D2），验收时不要把它当 bug。
