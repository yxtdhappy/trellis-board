# 引入插件机制（子进程 JSON-RPC）

> 状态：**已评审、实施完成待验收**（`status=in_progress`；P2/P3 真实联调按用户决定延后）。本文件承载需求与技术设计，实施结果与
> 验证记录见同目录 `implement.md`。评审结论见第 1 节 D1~D10；完整调研见
> `research/dsh-plugin-mechanism.md`、`research/acp-a2a-protocols.md`。

## 目录

1. [评审要点](#1-评审要点)
2. [背景与问题](#2-背景与问题)
3. [目标与非目标](#3-目标与非目标)
4. [需求](#4-需求)
5. [约束](#5-约束)
6. [验收标准](#6-验收标准)
7. [总体设计](#7-总体设计)
8. [协议规范](#8-协议规范)
9. [插件 SDK 与 ctx](#9-插件-sdk-与-ctx)
10. [权限模型](#10-权限模型)
11. [生命周期与故障处理](#11-生命周期与故障处理)
12. [事件模型](#12-事件模型)
13. [HTTP 路由与鉴权](#13-http-路由与鉴权)
14. [存储（DB v5）](#14-存储db-v5)
15. [配置](#15-配置)
16. [参考插件 A：a2a-intake（入站）](#16-参考插件-aa2a-intake入站)
17. [参考插件 B：acp-dispatch（出站）](#17-参考插件-bacp-dispatch出站)
18. [参考插件 C：私有业务接入](#18-参考插件-c私有业务接入)
19. [运维与可观测性](#19-运维与可观测性)
20. [安全边界](#20-安全边界)
21. [分期与交付门槛](#21-分期与交付门槛)
22. [测试策略](#22-测试策略)
23. [未决问题](#23-未决问题)
24. [附：代码锚点索引](#24-附代码锚点索引)

## 1. 评审要点

以下 9 条是本次设计的关键决策，需要评审确认：

| # | 决策 | 备选 | 结论 | 理由 |
| --- | --- | --- | --- | --- |
| D1 | 插件运行形态 | 进程内 ESM / 子进程 JSON-RPC | **子进程** | 崩溃隔离、依赖隔离、与 ACP 同构 |
| D2 | v1 模式范围 | standalone / 两种模式 | **只 standalone** | team 路由栈自带鉴权与审计，插件会绕过 |
| D3 | 根路径（`/.well-known/*`、`/a2a`） | 通用根路径 / 精确声明 | **精确声明 + 冲突检查** | A2A 强制根路径，通用挂载风险过大 |
| D4 | 事件语义 | best-effort / at-least-once | **at-least-once + ack** | watcher 400ms 防抖会重复触发，dispatch 必须幂等 |
| D5 | 插件写能力 | 直接操作 SQLite / 复用 actions | **复用 `actions.js` / `metadata.js`** | 保住 `task.py` 的校验与团队模式审计 |
| D6 | 运行环境差异 | 协议层暴露 / 宿主封装 | **全部收敛到宿主封装点** | 协议与插件代码不随环境变化，见 7.4 |
| D7 | ACP 角色 | 实现 ACP agent / 实现 ACP client | **client（出站）** | board 是任务源，agent 是执行方；反向只能被动等 prompt，见 17.1 |
| D8 | ACP 权限策略 | 统一档位 / 用户按工具类型配置 | **按 `toolCall.kind` 配置，默认放行编辑** | 各 agent 的 allow 选项语义不一致，board 只按 kind 选极性，见 17.3 |
| D9 | 平台任务对接方式 | 浏览器自动化 / 后端 JSON 接口 | **后端接口 + 凭据引用** | 登录、列表、详情都是 JSON 接口，运行期零浏览器依赖，见 18.2 |
| D10 | 插件版本标识 | 单一 `apiVersion` / 双轨（整数协议版本 + semver 插件版本） | **双轨 + `plugin.json` 清单** | 协议兼容与插件发布节奏不同，一个数字不能同时承担两种含义，见 8.6 |

## 2. 背景与问题

Trellis Board 目前是**只读观测层**：扫描 `.trellis/tasks`、`.trellis/workspace` 与 git 元数据，
把任务阶段投影到看板；写操作仅限于人工检查点、标签、依赖等看板自身状态。

现有能力与缺口：

| 能力 | 现状 | 位置 |
| --- | --- | --- |
| 读任务、推导阶段 | 有 | `server/loader.js`、`server/scan-worker.js` |
| 创建/派发任务 | 有，但只能从看板 UI 触发 | `server/actions.js:68`、`server/actions.js:115` |
| 文件变化自动刷新 | 有，400ms 防抖 | `server/watcher.js:28` |
| 接外部派发系统 | **无** | — |
| 触发 agent 执行 | **无** | — |

用户诉求：board 自身提供 Trellis 流程能力，通过插件接入任务流——例如 A2A 下发任务、对接自研
派发系统生成 Trellis 任务、任务派发后由 agent 执行。

参考实现：DeepSeek Harness 的 Cordis 插件模型（`apply(ctx)` + `inject` + effect 回滚）与
`dsh-subagent-acp` 的 ACP 子进程 provider（`command` / `args` / `env` / `permission`）。
ACP 生态的接入形态已经收敛：opencode、codex、claude、pi 都是"`command` + `args` 拉起一个
agent 进程，再以 client 身份走 JSON-RPC"，本设计沿用这一形态（见 17.2）。

## 3. 目标与非目标

### 3.1 目标

- **G1 入站**：外部系统（A2A 对端、Jira、IM、自研派发系统）把任务送进来，落成 Trellis 任务，
  在看板可见。
- **G2 出站**：任务被派发后，插件以 **ACP client** 身份启动 agent 进程执行；执行结果通过
  `.trellis/**` 文件变化被现有 watcher 感知，阶段自动推进。
- **G3 可插拔**：新增集成不改核心代码；插件可独立启停、崩溃隔离、失败可见、可审计；每个
  插件带自己的 semver 与协议版本，宿主在加载前就能判定兼容性。
- **G4 零依赖不变**：核心仍是 `node server/index.js` 就能跑，无构建、无第三方运行时依赖。

### 3.2 非目标

- 不做插件市场、在线安装（`pnpm add` 式）、HMR 热更新。
- 不做进程内插件。
- 不把 Trellis 流程（13 阶段推导、任务读写、扫描缓存）插件化。
- 不做 ACP agent：board 不作为 ACP server 被编辑器或外部客户端驱动。
- 不做多 agent 编排与协商；`acp-dispatch` 只负责"一条任务 → 一个 agent run"。
- v1 不做 `session/request_permission` 到看板审批 UI 的映射：权限由配置按 `ToolKind` 决策。

## 4. 需求

| ID | 需求 | 可验证方式 |
| --- | --- | --- |
| R1 | 插件以独立子进程运行，stdio JSON-RPC 通信；插件崩溃不影响 board 主服务 | 杀死插件进程后 `/api/board` 仍 200 |
| R2 | 插件必须声明权限，宿主逐条校验，未声明即拒绝 | 越权调用返回 `1001` |
| R3 | 任务写操作只能复用 `createTask` / `assignTask` / `setManualStage` | 代码评审：插件无 SQLite 访问 |
| R4 | 入站插件能把外部任务映射为 Trellis 任务，重复投递幂等 | 同一 A2A taskId 投两次只建一个任务 |
| R5 | 出站插件能按任务启动 ACP agent，记录 run 状态，超时/崩溃可观测 | `plugin_run` 有完整状态流转 |
| R6 | 插件可加载、健康检查、崩溃退避重启、连续失败自动禁用、人工启停 | 崩溃注入测试 |
| R7 | 插件路由只能落在 `/api/plugins/<id>/`；根路径需显式声明并查冲突 | 尝试注册 `/api/board` 被拒 |
| R8 | 插件状态、run、审计落 SQLite，schema v4 → v5 | 迁移后旧库可用 |
| R9 | 核心保持零运行时依赖、无构建、单进程 | `package.json` 无 `dependencies` |
| R10 | `team` 模式不加载插件 | team 模式启动日志告警，`/api/plugins` 为空 |

## 5. 约束

- Node.js >= 24；运行时零第三方依赖；单进程 + SQLite WAL。
- 现有 `/api/*` 路径与响应结构不变；插件路由只能是新增路径。
- `data/plugins.json` 属于本机配置，需加入 `.gitignore`。
- 设计文档中引用的代码位置必须真实存在（可 grep 验证）。
- 协议 `apiVersion` 整数化，破坏性变更才 +1。
- 实施阶段（P1–P5）按 D9 修改 `server/`、`public/`、`tests/`，并新增 `plugins/`；不改 `agent/`、
  `scripts/` 与 Trellis 13 阶段推导逻辑。

## 6. 验收标准

- [x] AC1 本文件覆盖：传输与帧格式、握手、方法矩阵、错误码、超时与背压、权限模型、生命周期、
      事件模型、HTTP 路由、DB v5、配置格式、插件版本与兼容性、三个参考插件、安全边界、分期计划、
      测试策略。
- [x] AC2 第 24 节的代码锚点全部可在仓库中验证存在（实施后新增文件不改变既有锚点）。
- [x] AC3 A2A 与 ACP 的方法名、状态映射写明版本差异（A2A v0.3 `message/send` vs v1.0
      `SendMessage`；ACP `initialize` → `session/new` → `session/prompt` → `session/update`）。
- [x] AC4 markdown 结构校验通过：代码围栏均有语言标注、表格列数一致、围栏闭合。
- [x] AC5 评审确认第 1 节的 D1~D10（用户已审核通过）。
- [x] AC7 版本可观：`/api/plugins` 能读到每个插件的 `version` / `apiVersion` / `compatible`；不兼容
      时 `reason` 落在第 8.6 节的失败标记集合内。
- [x] AC6 `research/` 下的调研结论与来源可追溯。

### 6.1 本轮验收范围（2026-11-05）

| 范围 | 本轮状态 | 证据 |
| --- | --- | --- |
| P1 协议 / supervisor / SDK / DB v5 / `/api/plugins` | 已实现并测试 | `tests/plugin-*.test.js`，默认套件全绿 |
| P4 `a2a-intake` | 已实现并测试 | 方法别名、幂等、状态映射、归档/依赖用例 |
| P5 前端插件页 | 已实现并验证 | Playwright 1440x1080 启停、日志、错误展示 |
| P3 `acp-dispatch` | 已实现，**真实 ACP 已跑通** | `TRELLIS_REAL_ACP=1 node --test plugins/acp-dispatch/test/real.test.js`，`opencode v2.2.5`，run `succeeded`，写出 `REAL_ACP_OK` |

P2 为本地私有插件，不进入公开仓库与默认测试；其真实环境联调由维护者执行。P3 的真实 agent 验收已在本轮执行，不再是延后项。

## 7. 总体设计

### 7.1 架构

```text
                    ┌──────────────────────────── Trellis Board (Node 24, 零依赖)
   A2A 对端 ───────▶│  HTTP 层  handleApi(server/index.js:564)
   (JSON-RPC)        │    ├── 核心路由 /api/board, /api/tasks, ...
                     │    └── 插件路由 /api/plugins/<id>/*        ← 宿主注入
                     │
   webhook ─────────▶│  Plugin Host（supervisor）
                     │    ├── manifest 校验 + 权限检查
                     │    ├── stdio JSON-RPC ⇄ 子进程（每插件一个）
                     │    ├── 事件总线（task.* / scan.*）
                     │    ├── 定时器（schedule/*）
                     │    └── plugin_state / plugin_run / plugin_audit
                     │
                     │  watcher(server/watcher.js:28) ◀── .trellis/** 变化
                     └────────────────────────────
                                    │ spawn
                     ┌──────────────┴──────────────┐
                     │ plugin: a2a-intake          │  ← 入站：A2A message/send → task/create
                     │ plugin: acp-dispatch        │  ← 出站：meta.agent → 起 ACP agent
                     └─────────────────────────────┘
                                    │ spawn（ACP）
                              opencode acp / codex-acp / claude-agent-acp / pi-acp
```

### 7.2 边界与职责

| 层 | 归属 | 说明 |
| --- | --- | --- |
| Trellis 流程 | 核心 | 13 阶段推导、任务读写、扫描缓存、看板 API |
| 插件宿主 | 核心 | 进程监督、协议编解码、权限校验、事件分发、存储、审计 |
| 集成逻辑 | 插件 | A2A 服务端、ACP 客户端、webhook 推送、自研派发系统对接 |
| agent 执行 | 插件下游 | board 不感知 agent 内部，只感知 `.trellis/**` 变化 |

核心永不 `import` 插件代码；插件只能通过协议访问宿主能力。

### 7.3 为什么是子进程 + JSON-RPC

| 维度 | 进程内 ESM | 子进程 + JSON-RPC（选定） |
| --- | --- | --- |
| 崩溃影响 | 插件异常会带崩整个 board | 只影响自己，宿主重启它 |
| 语言 | 只能 JS | 任意语言，只要实现协议 |
| 依赖 | 与核心共享 `node_modules`，易污染 | 插件自带依赖，核心保持零依赖 |
| 能力调用 | 直接函数调用，最简单 | 需要 RPC 映射（主要成本） |
| 调试 | 单进程，直接断点 | 需要 attach 子进程 |
| 安全边界 | 无 | 进程级隔离（非沙箱） |

选定子进程的核心理由：**与 A2A / ACP 场景天然同构**。ACP 本身就是"宿主起子进程、走 JSON-RPC、
按 run 收更新"，dispatch 插件可以把 agent 进程当作下游再起一层，不需要在 board 里引入异步任务框架。

代价是 `ctx.tasks.*` 全部变成 RPC，必须定义超时、取消、背压（见 8.5）。

### 7.4 平台无关性预留

协议层不暴露任何与运行环境绑定的概念；差异全部收敛在宿主的少数几个封装点上。下面这些
是**实现约束**，也是后续扩展的预留位置：

| 预留点 | 约束 | 落点 |
| --- | --- | --- |
| 可执行文件解析 | `command` 支持裸名（按宿主进程的可执行搜索路径解析）与绝对路径；`spawn` 不经过 shell，参数以数组传递 | `server/actions.js:34` 的调用方式 |
| 路径归一化 | 所有路径经 `path.resolve` / `path.join`；配置接受 `/` 与 `\` 两种分隔符；路径比较统一走 `repositoryPathKey`，插件不得自行比较字符串 | `server/config.js:33` |
| 进程终止 | 宿主封装 `terminateTree(child)`：先终止整棵进程树，避免 agent 拉起的子进程残留；协议层只有 `shutdown`，不暴露信号名或系统命令 | `server/team/process.js:34` |
| 环境透传 | 宿主按白名单构造最小环境，并统一做大小写无关查找；插件不得假设变量名大小写 | `server/team/process.js:17` `minimalEnvironment` |
| 帧换行 | JSONL 帧固定用 `\n` 分隔，读写都不依赖系统默认换行 | 8.1 |
| 文件事件 | 插件不直接监听文件系统，只订阅宿主事件，避免不同文件系统的通知语义差异 | 12 |
| 日志与临时文件 | 统一 `path.join(dataDir, "plugins", id + ".log")`；文件名不使用保留字符 | 18 |
| 超时计算 | 用单调时钟，不比较本地时间字符串 | 8.5 / 11 |
| 测试分层 | 协议层测试不依赖运行环境；路径归一化、环境透传、进程树终止各有一组宿主层集成测试 | 21 |

具体实现按运行环境选择，不写进协议，也不暴露给插件。这样新增运行环境时只改宿主封装，插件
代码与协议版本都不受影响。

## 8. 协议规范

### 8.1 传输

- 宿主用 `child_process.spawn(command, args, { stdio: ["pipe","pipe","pipe"], env: minimal,
  shell: false })` 启动插件，`cwd` 为插件目录；命令不做 shell 展开，参数以数组传递。
- 帧格式：**newline-delimited JSON**，一行一个完整 JSON-RPC 2.0 消息，行内不得有换行（与 ACP
  一致）。未来需要二进制附件时再协商 `Content-Length` 帧头。
- `stdout` 只承载协议帧；插件日志走 `log/write` 或 `stderr`，宿主把 `stderr` 落到
  `data/plugins/<id>.log` 作为崩溃诊断。
- 单帧上限 1 MiB，超限断开并记录审计。

### 8.2 握手

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{
  "apiVersion":1,
  "hostVersion":"0.1.0",
  "pluginId":"a2a-intake",
  "config":{},
  "permissions":["tasks:write","http:public","events"],
  "dataDir":"/…/data",
  "repositories":[{"id":"trellis-board","name":"Trellis Board","path":"/…"}]
}}
```

`apiVersion` 是宿主接受的最小协议版本，`hostVersion` 是宿主 semver，供插件自行判断降级。

插件回 `{apiVersion, id, name, version, capabilities:{http, events, schedule}}`：

- `version` 为 semver，必须与 `plugin.json` 一致；不一致回 `-32603` + `data.code=1008`
  （`version-mismatch`）。
- `apiVersion` 不等于宿主的 `HOST_API_VERSION` 时宿主回 `-32603` + `data.code=1006`，插件标记
  `incompatible`，不重试。
- 两句都通过后宿主发 `plugin/started` 通知，并把 `{id, version, apiVersion}` 写进
  `plugin_state.__manifest` 与审计。

### 8.3 方法矩阵

宿主 → 插件（请求）：

| 方法 | 用途 | 超时 |
| --- | --- | --- |
| `initialize` | 握手 | 10s |
| `plugin/configure` | 运行时改配置（v1 直接重启插件） | 10s |
| `http/request` | 转发一次 HTTP 请求 | 30s |
| `event/dispatch` | 投递领域事件 | 10s |
| `timer/fire` | 定时器到点 | 10s |
| `plugin/status` | 健康检查 | 5s |
| `shutdown` | 优雅停止 | 5s |

宿主 → 插件（通知）：`plugin/started`、`plugin/config.changed`、`shutdown/now`。

插件 → 宿主（请求）：

| 方法 | 权限 | 说明 |
| --- | --- | --- |
| `task/get` / `task/list` | `tasks:read` | 只读，返回规范化 DTO |
| `task/create` | `tasks:write` | 复用 `server/actions.js:68`，超时 120s（内部跑 `task.py`） |
| `task/assign` | `tasks:write` | 复用 `server/actions.js:115` |
| `task/setStage` | `tasks:write` | 复用 `server/metadata.js:53` |
| `event/emit` | `events:emit` | 自定义事件，前缀强制 `<pluginId>/` |
| `store/get` / `store/set` / `store/delete` / `store/list` | `store` | `plugin_state` 表，键自动加 `<pluginId>:` 前缀 |
| `log/write` | 默认允许 | `{level,message,fields}`，落文件 + 内存环 |
| `schedule/register` / `schedule/unregister` | `schedule` | 最小间隔 1000ms |

插件 → 宿主（通知）：`event/ack`、`run/progress`（可选，写 `plugin_run`）。

### 8.4 错误码

标准 JSON-RPC：`-32700` 解析失败、`-32600` 非法请求、`-32601` 方法不存在、`-32602` 参数非法、
`-32603` 内部错误。应用错误放 `error.data.code`：

| code | 含义 |
| --- | --- |
| 1001 | 权限不足（manifest 未声明） |
| 1002 | 目标不存在（任务/仓库/键） |
| 1003 | 超时 |
| 1004 | 任务写入被 `task.py` 拒绝（附 stderr 摘要） |
| 1005 | 限流 / 队列已满 |
| 1006 | 协议版本不兼容（`apiVersion` 不等） |
| 1007 | 插件已被禁用 |
| 1008 | 清单与握手版本不一致（`version-mismatch`） |

### 8.5 超时、取消、背压

- 每个请求挂超时，超时回 `1003` 并**不**自动杀进程；连续 3 次超时计入健康检查失败。
- 取消：`request/cancel {id}` 通知，插件可忽略；`task/create` 这类不可回滚的写入不允许取消。
- 事件队列每插件上限 500，满则丢最旧一条并累加 `droppedEvents`。
- 未 ack 事件 30s 后重投，最多 3 次；仍失败记审计并丢弃。

### 8.6 版本化

三条版本线，互不替代：

| 版本 | 形态 | 谁维护 | 作用 |
| --- | --- | --- | --- |
| `apiVersion` | 整数 | 宿主 | 宿主↔插件协议；只做破坏性变更时 +1，新增方法不升 |
| `version` | semver | 插件作者 | 插件自身发布节奏；用于审计、回滚、故障归因 |
| `board` | semver | 宿主 | 平台版本；插件用 `engines.board` 声明可运行的宿主范围 |

插件清单 `plugins/<id>/plugin.json` 是加载与握手的唯一依据，加载前先读它：

```json
{
  "id": "a2a-intake",
  "name": "a2a intake",
  "version": "1.0.0",
  "apiVersion": 1,
  "engines": { "board": ">=0.2.0" },
  "permissions": ["tasks:write", "store", "schedule"]
}
```

校验顺序与失败结果（任一不通过即 `incompatible`，不启动，写审计）：

| 检查 | 失败标记 |
| --- | --- |
| `plugin.json` 存在且可解析 | `invalid-manifest` |
| `id` 与配置项 `id` 一致 | `id-mismatch` |
| `version` 是合法 semver（`x.y.z`，可带 `-prerelease`） | `invalid-version` |
| `apiVersion` 等于宿主 `HOST_API_VERSION` | `1006` 协议不兼容 |
| `engines.board` 满足宿主 `package.json` 的 `version` | `board-too-old` / `board-too-new` |
| 配置若写了 `version`，与清单相等 | `pinned-mismatch` |

规则：

- `HOST_API_VERSION` 是 `server/plugins/` 内的常量整数，与 `apiVersion` 同步升；`SCAN_SCHEMA_VERSION`
  （`server/index.js:32`）是数据缓存版本，两者无关。
- `engines.board` 只支持 `>=`、`<=`、`^`、`~`、精确版本与 `*`；不支持 `||` 与连字符区间。
  加载期解析，写法非法直接拒错（零依赖实现的边界，写清才能避免作者误用）。
- 握手回包的 `version` / `apiVersion` 必须与清单一致，否则 `1008` 并断开——防止两份声明
  分叉。
- 配置的 `version` 是可选钉版本：相等才加载，用于阻断意外升级；大范围滚动发布时去掉即可。
- 升级/降级只在加载时比较 `plugin_state.__manifest.version`：变化写审计 `upgraded` /
  `downgraded`，降级额外告警（插件自己的 `store` 结构可能只向前兼容）。
- 旧宿主加载新插件时的兼容姿态：忽略未知能力字段、未知方法回 `-32601`，不因未知字段崩溃。

本次设计的两个内置参考插件起始版本（首个实现即 `1.0.0`，后续改行为就升版）：

| 插件 | `version` | `apiVersion` | `engines.board` |
| --- | --- | --- | --- |
| `a2a-intake` | 1.0.0 | 1 | `>=0.2.0` |
| `acp-dispatch` | 1.0.0 | 1 | `>=0.2.0` |

## 9. 插件 SDK 与 ctx

插件作者不手写 JSON-RPC。SDK（`server/plugins/sdk.js`，零依赖）把 RPC 封装成与宿主 `ctx`
同形状的 API：

```js
import { createPlugin } from "../../server/plugins/sdk.js";

export default createPlugin({
  name: "a2a-intake",
  version: "1.0.0",
  apiVersion: 1,
  permissions: ["tasks:write", "http:public", "events"],

  async onStart(ctx, config) {
    ctx.http.public("POST", "/a2a", async (req) => {
      const rpc = await req.json();
      if (rpc.method === "message/send" || rpc.method === "SendMessage") {
        const task = await ctx.tasks.create({
          repositoryId: config.repositoryId,
          title: rpc.params?.message?.parts?.[0]?.text ?? "A2A 任务",
          assignee: config.assignee,
          priority: "P2"
        });
        return { jsonrpc: "2.0", id: rpc.id, result: { id: task.taskKey, status: { state: "submitted" } } };
      }
      throw ctx.error(-32601, `unknown method ${rpc.method}`);
    });

    ctx.events.on("task.stage.changed", (event) => {
      ctx.log.info("stage changed", { taskKey: event.taskKey, stage: event.manualStage });
    });
  },

  async onStop(ctx) {
    // 定时器、监听、连接由 SDK 统一清理
  }
});
```

SDK 负责帧解析、请求 id、超时、错误封装、`ctx.effect` 栈与未处理异常上报。ctx 形状：

| 成员 | 作用 |
| --- | --- |
| `ctx.plugin` | `{id, version, apiVersion, hostVersion}`，只读 |
| `ctx.tasks` | `create` / `assign` / `setStage` / `get` / `list` |
| `ctx.events` | `on` / `emit` |
| `ctx.http` | `route` / `public` |
| `ctx.store` | `get` / `set` / `delete` / `list` |
| `ctx.schedule` | `every` / `cancel` |
| `ctx.log` | `debug` / `info` / `warn` / `error` |
| `ctx.effect` | 注册 disposer，卸载逆序执行 |
| `ctx.secrets` | 只读 env |

## 10. 权限模型

插件清单（`package.json`）：

```json
{
  "name": "@trellis-board/plugin-a2a-intake",
  "type": "module",
  "main": "./index.js",
  "trellisBoard": {
    "api": 1,
    "entry": "./index.js",
    "permissions": ["tasks:write", "http:public", "events", "schedule", "store"],
    "http": { "rootPaths": ["/a2a", "/.well-known/agent-card.json", "/.well-known/agent.json"] }
  }
}
```

| 权限 | 允许的能力 |
| --- | --- |
| `tasks:read` | `task/get`、`task/list` |
| `tasks:write` | `task/create`、`task/assign`、`task/setStage` |
| `events` | 订阅领域事件 |
| `events:emit` | 发自定义事件 |
| `http:route` | 命名空间路由 `/api/plugins/<id>/*` |
| `http:public` | 未登录可访问的 hook，必须配置 token |
| `http:root` | 抢占根路径，需在 `http.rootPaths` 精确声明 |
| `schedule` | 定时器 |
| `store` | `plugin_state` |
| `network:outbound` | **声明性**：宿主无法拦截子进程网络，仅用于审计与 UI 提示 |

`http:root` 冲突：两个插件声明同一根路径，或与核心路由冲突 → 后加载者失败并标记 `error`，
不影响先加载者。

## 11. 生命周期与故障处理

1. 启动顺序：DB 迁移 → 核心服务 → `server.listen` → **加载插件**（`server/index.js:884`）。
   放在监听之后，插件再坏也不影响看板打开。
2. 单个插件失败：记录 `error`，其余插件照常加载。
3. 崩溃重启：1s/2s/4s/8s/16s 退避，60s 封顶；**10 分钟内 5 次**重启则自动 `disabled` 并写
   审计，需人工 `POST /api/plugins/<id>/start`。
4. 健康检查：每 30s `plugin/status`，连续 3 次失败 → 终止并进入重启流程。
5. 优雅停止：`shutdown` → 宽限 3s → 软终止 → 再宽限 3s → 强制终止。终止手段由宿主封装为
   `terminateTree(child)`，优先终止整棵进程树（参考 `server/team/process.js:34`），插件只看到
   `shutdown` 请求，不感知终止方式。
6. 全局开关：`TRELLIS_PLUGINS_DISABLED=1` 时只加载核心，用于故障排查。

| 失败 | 表现 | 处理 |
| --- | --- | --- |
| 插件启动失败 | 该插件 `error`，其余正常 | 不影响看板；`/api/plugins` 可见 |
| 插件崩溃 | 子进程退出 | 退避重启 |
| 反复崩溃 | 10 分钟 5 次 | 自动 `disabled` + 审计 |
| 事件处理卡死 | 请求超时 | 回 `1003`，计入健康检查失败 |
| 插件写坏任务 | `task.py` 拒绝 | 回 `1004` + stderr 摘要，不落库 |
| 协议不兼容 | 握手失败 | 标记 `incompatible`，不重试 |
| 迁移失败 | 启动中止 | 沿用现有快照回滚（`data/board.sqlite.vN-backup`） |

## 12. 事件模型

| 事件 | 触发点 | payload 关键字段 |
| --- | --- | --- |
| `task.created` | `task/create` 成功，或扫描首次发现任务 | `taskKey, projectId, title, assignee, priority, occurredAt` |
| `task.assigned` | `assignTask` 成功后 | 同上 + `previousAssignee` |
| `task.meta.changed` | 扫描发现 `meta` 变化（含 `task.py set-meta`） | `taskKey, meta, previousMeta` |
| `task.stage.changed` | `setManualStage` 成功后 | `taskKey, stage, previousStage` |
| `task.stage.derived` | 扫描后派生阶段变化 | `taskKey, derivedStage, previousStage` |
| `task.archived` | 扫描发现归档 | `taskKey, archivedAt` |
| `scan.completed` | 扫描结束 | `reason, durationMs, tasks, repositoriesScanned` |
| `repository.added` / `repository.removed` | 白名单变更 | `repositoryId, name` |

`taskKey` 统一为 `<projectId>::<任务目录名>`，与 `ctx.tasks.*` 使用同一键；`task.created` 在
`task/create` 成功后立即发一次，扫描首次发现外部任务时也会发一次。

投递语义 **at-least-once**：每条事件带单调递增 `eventId`，插件 `event/ack` 后出队；重放缓冲
1000 条，仅用于重投，不对外查询。

payload 带 `repoPath`（插件起 agent 需要 cwd）。该字段在 team 模式下必须去掉，这也是 v1 只做
standalone 的原因之一。

## 13. HTTP 路由与鉴权

- 命名空间：`/api/plugins/<pluginId>/<path>`，宿主强制前缀，插件无法注册 `/api/board` 等核心路径。
- 根路径：只有声明 `http:root` + `http.rootPaths` 的插件可挂 `/.well-known/*`、`/a2a`，必须
  精确匹配，不支持通配。
- 公开端点：`ctx.http.public()` 要求 `Authorization: Bearer <token>`，token 来自配置里的
  `env:XXX` 引用；未配置 token 时该端点**不挂载**并在状态里报 `missing-token`。
- 请求体上限沿用 `server/index.js:73` `readJsonBody` 的 1 MiB；插件路由复用同一函数。
- 响应统一走 `server/index.js:64` `sendJson`。

## 14. 存储（DB v5）

```sql
CREATE TABLE IF NOT EXISTS plugin_state (
  plugin_id  TEXT NOT NULL,
  key        TEXT NOT NULL,
  value      TEXT NOT NULL,          -- JSON
  updated_at TEXT NOT NULL,
  PRIMARY KEY (plugin_id, key)
);

CREATE TABLE IF NOT EXISTS plugin_run (
  run_id      TEXT PRIMARY KEY,      -- 幂等键：<pluginId>:<taskKey>:<attempt>
  plugin_id   TEXT NOT NULL,
  plugin_version TEXT,               -- 起 run 时的清单版本，用于故障归因
  task_key    TEXT,
  status      TEXT NOT NULL,         -- queued|starting|running|completed|failed|cancelled|timed_out
  request     TEXT,                  -- JSON
  result      TEXT,                  -- JSON
  started_at  TEXT NOT NULL,
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS plugin_audit (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  plugin_id  TEXT NOT NULL,
  plugin_version TEXT,               -- 事件发生时的清单版本
  kind       TEXT NOT NULL,          -- loaded|started|stopped|crashed|disabled|permission_denied|http|upgraded|downgraded|incompatible
  detail     TEXT,
  created_at TEXT NOT NULL
);
```

迁移在 `server/database.js:15` `DATABASE_SCHEMA_VERSION` 之后追加 v5，沿用 v1→v4 的顺序与迁移前
快照（`server/database.js:487` 是 v4 的落点）。

另在 `plugin_state` 存一份清单快照：`key=\"__manifest\"`，值为
`{id, version, apiVersion, loadedAt}`，用于升级/降级比较与 `/api/plugins` 回显。

## 15. 配置

`data/plugins.json`（需加入 `.gitignore`，与 `data/repos.json` 同级处理）：

```json
{
  "plugins": [
    {
      "id": "a2a-intake",
      "module": "./plugins/a2a-intake/index.js",
      "enabled": true,
      "config": { "repositoryId": "trellis-board", "assignee": "alice", "token": "secret:a2a-intake/token" }
    },
    {
      "id": "acp-dispatch-opencode",
      "module": "./plugins/acp-dispatch/index.js",
      "enabled": false,
      "config": {
        "agentId": "opencode",
        "command": "opencode",
        "args": ["acp"],
        "permission": {
          "default": "allow",
          "byKind": {
            "read": "allow",
            "edit": "allow",
            "execute": "allow",
            "fetch": "deny",
            "delete": "deny"
          }
        },
        "timeoutMs": 3600000,
        "idleTimeoutMs": 600000
      }
    }
  ]
}
```

规则：

- `module` 支持相对仓库根路径与绝对路径；v1 不解析 npm 包名，不做在线安装。
- 值形如 `env:NAME` 时在加载时用 `process.env[NAME]` 替换；未设置则插件标记 `missing-secret`，
  不启动。
- 值形如 `secret:scope/key` 时从 `data/plugins.secrets.json` 的 `refs` 解析；未配置同样标记
  `missing-secret`，不启动。secrets 文件默认与 `data/plugins.json` 同目录，可用
  `TRELLIS_BOARD_SECRETS_FILE` 覆盖；POSIX 下必须是 `0600`，否则拒绝加载。
- `data/plugins.secrets.json` 只手动编辑，不提供写入 API/CLI/UI；改完重启生效。格式为
  `{"version": 1, "refs": {"scope/key": "value"}}`，示例见 `data/plugins.secrets.example.json`。
- 普通字符串允许加载，但 `token`、`password`、`secret`、`api_key` 等敏感字段会在启动时告警；
  迁移时先告警、不阻断。`/api/plugins` 只回显 `***`，`credentials.source` 标
  `secret` / `env` / `inline` / `mixed` / `none`。
- agent 的模型凭据由 agent CLI 自己管理（各自的 login 或配置文件），board 不保存模型 API key。
- `permission.byKind` 的键是 ACP `ToolKind`：`read` / `edit` / `delete` / `move` / `search` /
  `execute` / `think` / `fetch` / `switch_mode` / `other`；未列出的用 `default`。建议显式加
  `"switch_mode": "deny"`——该 kind 会切换会话模式，可能降低监督强度。
- `permission` 是 ACP 工具审批策略（按 `toolCall.kind`），与第 10 节的插件能力声明 `permissions`
  是两回事。
- 私有业务插件的配置只放在本地 `data/plugins.json`；凭据优先用 `secret:`，其次 `env:`，
  不要把明文写进仓库。备份 `data/` 时注意 `plugins.secrets.json` 也在其中。
- 插件的身份与版本写在 `plugins/<id>/plugin.json`（见 8.6），`data/plugins.json` 只放路径、开关与
  运行参数；两处 `id` 必须一致，否则 `id-mismatch` 不启动。
- `version` 可选钉版本（如 `"version": "1.0.0"`），与清单不等时标记 `pinned-mismatch`；不写则不钉。

## 16. 参考插件 A：a2a-intake（入站）

A2A 事实：Agent Card 在 `GET /.well-known/agent-card.json`（旧客户端也探测
`/.well-known/agent.json`）；方法走 JSON-RPC 2.0，v0.3 为 `message/send` / `tasks/get` /
`tasks/cancel`，v1.0 重命名为 `SendMessage` / `GetTask` / `CancelTask`。插件同时接受两套名字。

| A2A | Trellis |
| --- | --- |
| `message/send` 的 text part | `task/create` 的 `title`（超 200 字截断），完整文本进 `description` |
| `contextId` / `taskId` | 存 `plugin_state`，映射到 `taskKey`；重复投递返回同一任务 |
| `metadata.agent` | 写 `task.json.meta.agent`，决定后续由哪个 `acp-dispatch` 实例执行 |
| `submitted` | `derivedStage = planning` 且 DoR 齐备 |
| `working` | `implementing` / `checking` |
| `input-required` | 有未解除的 `task_dependency` 或 DoR 缺口；入站任务通常先落这里，人工补齐规划后转 `submitted` |
| `completed` | `verified` 或已归档 |
| `canceled` | 任务被归档且未完成 |

`tasks/get` 直接读看板缓存（不触发全量扫描），返回 `status` + `artifacts`（PRD 摘要）。

入站建出的任务固定为 `planning`，**不会立刻触发执行**；只有 `task.py start` 把状态推到
`in_progress` 后，`acp-dispatch` 才会拾取。这是入站与出站之间的人工检查点。

> `a2a-intake` 是协议入口，用于外部系统按标准主动推送。若要把内部平台上已有任务搬进看板，
> 使用第 18 节的本地私有插件；两者共用同一套 `task/create` 与 `meta.agent` 约定。

## 17. 参考插件 B：acp-dispatch（出站）

### 17.1 我们实现的是 ACP 的哪一侧

系统里有两层 JSON-RPC，名字都叫"协议"，但完全独立：

| 层 | 谁跟谁 | 协议与版本字段 | 由谁实现 |
| --- | --- | --- | --- |
| L1 | board ↔ 插件 | 本文件第 8 节，自有方法集，`apiVersion` 整数 | 宿主 + 插件 |
| L2 | 插件 ↔ agent | Agent Client Protocol（Zed），`protocolVersion` | **插件实现 client 侧**，agent 由第三方 CLI 提供 |

**`acp-dispatch` 是 ACP client，不是 ACP agent。** 它不实现 `session/new` 的服务端，也不把 board
暴露成可被编辑器连的 agent；它按 `command` + `args` 拉起一个 agent 进程，然后以 client 身份
发 `initialize` → `session/new` → `session/prompt`。

```text
本设计（出站）  board ──meta.agent + in_progress──▶ acp-dispatch ──ACP client──▶ agent 进程
非目标（反向）  编辑器 ──ACP client────▶ board（board 当 agent）
```

反方向不做的原因：board 是任务真相源，agent 是执行方。ACP 只定义"client 驱动 agent"；把 board
做成 agent，只能被动等外部 prompt，无法表达"这条 Trellis 任务该派给哪个工具、按什么验收"。

**效果一句话**：一条被指派的 Trellis 任务 → 一次可观测的 agent run → agent 在仓库里改
`.trellis/**` → 现有 watcher 把阶段推上去 → 结果与审计落 `plugin_run`。

"下发任务"在 ACP 里的真实含义：**没有 task 对象，没有 ack、重试、优先级**，`session/prompt`
就是一段文本。因此：

- 队列、幂等、重试、超时、状态机全部在 board 侧（第 11、14 节），不能指望 ACP 提供；
- prompt 必须自带上下文——agent 不知道 board 的存在，只能读仓库和 prompt；
- 完成信号是文件变化，不是 ACP 返回值；`stopReason` 只说明本轮对话为什么结束。

v1 固定 prompt 模板（后续可做成插件配置）：

```text
你在 Trellis 仓库 <repoPath> 中执行任务 <taskKey>。
先读 .trellis/tasks/<taskKey>/prd.md 与 implement.md，按其中的约束实现。
只修改该任务允许的目录；完成后运行验收命令，并把结果写回任务目录。
不要修改 .trellis/.developer，不要执行 git commit。
```

### 17.2 兼容矩阵（2026-11-04）

| 工具 | ACP 角色 | `command` + `args` | 适配层（生态提供） | board 侧适配 | 成熟度 |
| --- | --- | --- | --- | --- | --- |
| OpenCode | agent，原生 | `opencode` + `["acp"]` | 无 | 无 | 稳定 |
| Cursor | agent，原生 | `agent` + `["acp"]` | 无 | 无 | 稳定，需先 `agent login` |
| Antigravity CLI | agent，原生 | `agy` + `["acp"]` | 无 | 无 | 官方文档 |
| Codex CLI | agent，适配器 | `codex-acp` | `@agentclientprotocol/codex-acp` 2.5.0 | 无 | 官方维护 |
| Claude Code | agent，适配器 | `claude-agent-acp` | `@agentclientprotocol/claude-agent-acp` 0.100.0 | 无 | 官方维护 |
| pi | agent，适配器 | `pi-acp` | `pi-acp` 0.0.34（Zed Registry 收录） | 无 | 社区维护，周下载约 28 万 |
| GitHub Copilot CLI | agent，原生 | `copilot` + `["--acp"]` | 无 | 无 | public preview |

规则：

- **原生优先**：`command` 直接指向 CLI，`args` 带 ACP 子命令。
- **适配器不特殊对待**：`command` 指向适配器可执行文件，board 不关心它内部怎么桥接（Codex 适配器
  内部起 App Server，pi 适配器桥接 `pi --mode rpc`）。
- **不写死 `--acp`**：每个插件实例自带 `command` / `args` / `env`，新增工具不改代码。
- **适配器归 agent 生态**：board 不为任何工具写 ACP 分支；只要生态里有能说 ACP 的可执行文件，
  就按 `command` + `args` 接进来。pi 属于这一类：核心仍无原生 ACP（issue #175 未关），但
  `pi-acp` 已被 Zed Registry 收录，近一周 npm 下载约 28 万，足够当作事实标准。
- **启动探测**：`initialize` 失败或超时 → 该 run 标 `unsupported`，不进入崩溃重启循环。
- **版本不锁定**：矩阵中的版本是验证基线，不是运行时约束。

注：部分 pi 适配器 fork 内置自己的 pi 版本，接入前先用 `pi-acp --version` 与 PATH 上的 `pi` 对齐。

### 17.3 执行链路

```text
spawn(command, args) → initialize {protocolVersion, clientCapabilities}
  → session/new {cwd: repoPath, mcpServers: []} → {sessionId}
  → session/prompt {sessionId, prompt:[{type:"text", text: <任务上下文>}]}
      ◀ session/update（agent_message_chunk / tool_call / tool_call_update / plan）
      ◀ session/request_permission {toolCall, options}
          → 从 options 中选一个（allow_once / allow_always / reject_once / reject_always）
  → stopReason（end_turn | max_tokens | max_turn_requests | refusal | cancelled）
  → agent 声明 sessionCapabilities.close 时 session/close
```

- **clientCapabilities 最小化**：v1 不开 `fs` / `terminal` 回调，agent 用自己的工具读写文件；
  board 不需要代理文件系统，也避免把宿主路径暴露给 agent。
- **触发**：订阅 `task.meta.changed` 与 `scan.completed`，当 `task.meta.agent == agentId` 且
  `status == in_progress` 时起 run；未声明 `meta.agent` 的任务不自动派发。也可
  `POST /api/plugins/<id>/runs` 指定 `taskKey` 手动起一次。
- **幂等**：`runId = <pluginId>:<taskKey>:<attempt>`；同一任务同一时刻只允许一个 `running`，
  由 DB 唯一约束保证。
- **超时**：默认硬超时 60 分钟；10 分钟无 `session/update` 视为 idle 超时，先 `session/cancel`，
  宽限后 `terminateTree`。
- **恢复**：agent 声明 `loadSession` 能力时用 `session/load` 续跑；否则 `attempt + 1` 新开
  session，并在 prompt 里说明这是重试。
- **结果**：写 `plugin_run`；**不伪造阶段**——agent 自己在仓库里改 `.trellis/tasks/**`，由
  `server/watcher.js:28` 的 400ms 防抖刷新把阶段推上去。插件只在失败时发事件标记异常。
- **环境**：只透传配置声明的键 + 可执行文件搜索路径、用户主目录、临时目录，不透传 board 进程
  完整环境（宿主用 `minimalEnvironment` 构造，`server/team/process.js:17`）。
- **权限配置**：`permission.default` + `permission.byKind`，键是 ACP `ToolKind`（read / edit /
  delete / move / search / execute / think / fetch / switch_mode / other）。用户按 agent 分别配置，
  board 不预设档位。
- **kind 可能缺失**：`session/request_permission` 的 `toolCall` 是 `ToolCallUpdate`，规范示例只带
  `toolCallId`。宿主必须用之前 `session/update` 里的 `tool_call` / `tool_call_update` 按 id 缓存
  合并；仍拿不到 kind 时按 `other` 走 `default`。
- **选选项只认 kind**：`allow` 时在 `options` 里找 `allow_once`，没有则 `allow_always`；`deny` 时
  找 `reject_once`，没有则 `reject_always`；两种极性都没有就回
  `{"outcome":{"outcome":"cancelled"}}` 并记 `permission-unavailable`。不硬编码 optionId，
  也不按 `name` 猜——规范明确要求自动审批不能只看 title / name。
- **优先 allow_once**：`allow_always` / `reject_always` 的"记住"由 agent 实现，作用域和时长也由
  agent 决定；除非用户显式配置，默认不选永久项。
- **取消语义**：发出 `session/cancel` 后，所有未决的 permission 请求必须回 `cancelled`（规范 MUST）。
- **审计**：记录 `toolCallId`、`kind`、`title`、决策、命中的 optionId。
- **协议依据**：ACP v1 schema 的 `ToolKind`、`PermissionOptionKind`、`RequestPermissionOutcome`。

### 17.4 多 agent 绑定（v1）

- 一个 `acp-dispatch` 实例绑定一个 agent：`agentId` + `command` + `args`。
- 多工具 = 多个实例（`acp-dispatch-opencode`、`acp-dispatch-codex`、`acp-dispatch-pi`），
  共用同一份插件代码。
- 路由靠 `task.json.meta.agent`（`task.py set-meta <dir> agent opencode` 写入），不占用
  `assignee`——后者是 Trellis 开发者身份，且必须是已初始化的 workspace。
- 只拾取 `status == in_progress` 的任务：`planning` 阶段还没有 `implement.md`，agent 没有可执行计划。
- `plugin_run.agent_id` 记录实际执行者，便于横向对比。
- 同一任务允许多次尝试，但不允许两个 agent 同时改同一仓库。

### 17.5 效果边界

承诺：

- 每条任务有完整 run 记录：`queued / running / succeeded / failed / timeout / cancelled`。
- 工具调用、消息片段、错误可流式看到，也可事后查日志。
- 失败可归因：退出码、`stderr` 尾部、最后一条 `session/update`、超时类型。
- agent 的产出通过仓库文件落盘，board 重启不丢。

不承诺：

- 不做 agent 间编排或协商（ACP 无此语义；需要时用 A2A）。
- 不做任务队列语义（ack / 重试 / 死信）——那是 `plugin_run` 的职责。
- 不保证跨工具行为一致：board 只保证 ACP 协议层；工具能力、权限选项语义的差异由适配器吸收，
  用户按 agent 配置。
- 不把 board 变成 ACP server；编辑器不能直接驱动 board 派活。

## 18. 参考插件 C：私有业务接入

`plugins/` 是开放扩展点，但涉及内部平台、账号与接口细节的插件不进入本仓库。此类插件沿用同一套
`plugin.json`、`task/create`、`meta.agent` 约定，由维护者在本地目录维护：

- 目录与测试放本地，通过 `.git/info/exclude` 或本地忽略规则排除，不提交。
- 配置只放 `data/plugins.json`（已 gitignore），凭据用 `secret:` 或 `env:` 引用，不写明文。
- 入站任务固定 `planning`，不自动 `task.py start`；`meta.agent` 决定后续 `acp-dispatch` 实例。
- 重复导入按业务键幂等；失败写 `plugin_run`，不阻塞其它条目。
- 验收在本地 fixture 完成；真实环境联调由维护者执行，不写入公开文档。

该节不描述任何具体平台、接口或字段，避免把内部系统契约带进开源仓库。

## 19. 运维与可观测性

| 端点 | 说明 |
| --- | --- |
| `GET /api/plugins` | 列表：`id, version, apiVersion, compatible, enabled, status, pid, restarts, lastError, droppedEvents, permissions` |
| `POST /api/plugins/<id>/start` / `stop` | 人工启停，写审计 |
| `GET /api/plugins/<id>/logs?tail=200` | 内存环 + 日志文件尾部 |
| `GET /api/plugins/<id>/runs?taskKey=` | `plugin_run` 查询（dispatch 用） |

日志：`data/plugins/<id>.log`（`*.log` 已被 `.gitignore` 覆盖），单文件 10 MiB 轮转，保留 3 份。
每行前缀固定 `[<id>@<version>]`，一个日志文件里不会混淆版本。

版本可见性：`/api/plugins` 的 `compatible` 为假时必带 `reason`（8.6 表里的失败标记），前端插件页
直接展示“插件 x.y.z 需要宿主 a.b.c，当前 c.d.e”。

凭据可见性：`/api/plugins` 只回 `credentials: {mode, source}` 与 `auth: {status, obtainedAt,
expiresAt}`；`token` / `password` 一律回 `***`，前端不回显任何片段。

## 20. 安全边界

- **v1 只支持 standalone**。team 模式路由栈在 `server/team/http.js:426` `createRequestHandler`，
  自带账号、项目权限、设备凭证与审计；插件绕过它们等于绕过鉴权。team 模式下不加载插件，
  配置里出现插件时启动日志告警。
- **插件不是沙箱**：子进程以 board 运行用户身份执行，能读写文件、发网络。`network:outbound`
  等权限是声明式的，宿主无法真正拦截。部署建议使用专用系统账号。
- **公开端点风险**：服务可被配置成监听 `0.0.0.0`（`TRELLIS_BOARD_BIND_HOST`）。这种部署下
  `http:public` 等于暴露到局域网，必须配 token；默认不挂载无 token 的公开端点。
- **不外泄绝对路径**：A2A 响应与 `/api/plugins` 状态不回传 `repoPath`；`repoPath` 只作为
  `initialize` 参数交给本机插件进程。
- **ACP agent 不是沙箱**：`session/request_permission` 是协商而非强制，agent 用自己的工具仍可
  直接读写仓库。默认策略放行编辑与执行，等于把仓库和命令执行交给 agent；只在受信仓库、
  专用系统账号下启用 dispatch。

## 21. 分期与交付门槛

| 期 | 交付 | 进入门槛 | 验收 | 回滚 |
| --- | --- | --- | --- | --- |
| P0（本任务） | 本设计文档 | — | 第 6 节 AC 全绿 | 删除文档，无运行时影响 |
| P1 | 协议 + supervisor + SDK + DB v5 + `/api/plugins` | 设计评审通过 | fixture 插件握手、版本不符拒载、事件触发、崩溃自动重启；核心路由无回归 | 停用插件 + 回退 DB（保留 v4 快照） |
| P2 | 私有业务接入（本地） | P1 合并 | 本地 fixture 验收；真实联调由维护者执行 | 移除插件配置，核心无变化 |
| P3 | `acp-dispatch`（出站） | P2 合并 | `meta.agent` + `in_progress` 起 ACP 进程、watcher 推进阶段、超时进 `plugin_run` | 关闭插件，任务仍可人工推进 |
| P4 | `a2a-intake`（协议入站，可选） | P1 合并 | `message/send` 建任务、重复投递幂等、无 token 401 | 移除插件配置，核心无变化 |
| P5 | 前端「插件」页 | P1 合并 | 列表/启停/错误/日志可用 | 隐藏入口，API 保留 |

本轮已完成 P1~P5 代码与 fixture 测试；P3 已用真实 `opencode acp` 跑通端到端。
P2 为本地私有插件，不进入公开仓库与默认测试，真实联调由维护者执行。

P1 是唯一有架构风险的阶段；P2~P5 只是插件代码或前端，不动核心。每期单独建 Trellis 任务。

顺序调整理由：私有接入不依赖 A2A 协议实现，所以排在 `a2a-intake` 之前；`a2a-intake` 保留为
需要标准协议对接时的可选项。

## 22. 测试策略

- `tests/plugin-protocol.test.js`：帧解析、请求 id、错误码、超时、1 MiB 上限。
- `tests/plugin-supervisor.test.js`：崩溃重启退避、连续失败自动禁用、优雅停止、权限拒绝。
- `tests/plugin-http.test.js`：命名空间隔离、根路径冲突、public token 校验、核心路由不被覆盖。
- `plugins/<id>/test/manifest.test.js`：真实 `plugin.json` 校验、握手与 `/api/plugins` 状态。
- `plugins/a2a-intake/test/index.test.js`：A2A v0.3/v1.0 方法别名、幂等、状态映射。
- `plugins/acp-dispatch/test/index.test.js`：ACP 权限、取消、watcher 阶段推进。
- `tests/plugin-version.test.js`：清单校验（缺字段/非法 semver/`id` 不一致）、`apiVersion` 不等回
  `1006`、`engines.board` 上下界不满足、钉版本 `pinned-mismatch`、握手与清单分叉回 `1008`、
  升级/降级写审计。
- fixture 插件放 `tests/fixtures/plugins/`：`echo`、`crash-on-event`、`slow`、`bad-handshake`。
- 私有插件的测试由维护者在本地执行，不进入本仓库与默认套件。
- 全部沿用 `npm test`（`node --test tests/*.test.js plugins/*/test/*.test.js`），不引入新框架。

## 23. 未决问题

1. `http:root` 是否只开放给 A2A 两三个固定路径，而不是通用根路径声明？（更安全，但限制扩展）
2. dispatch 的 `session/request_permission` 是否要做成看板审批（涉及前端交互与超时策略）。
3. 插件是否需要在 team 模式下以"服务端工作副本"为 cwd 运行（与同步 Agent 的 `ff-only`
   同步如何共存）。
4. 多插件同时订阅同一任务事件时的执行顺序：并行（默认）还是声明优先级。
5. 事件是否要持久化（当前设计只做内存重放缓冲 1000 条）。
6. 私有业务接入用个人账号还是专用服务账号？（服务账号归属清晰、审计干净，但需平台侧开号；
   个人账号 token 会随离职/改密失效）
7. 导入后是否自动 `task.py start` 跳过人工检查点？（当前默认不跳，需人工确认 DoR）
8. 是否把看板阶段回写到平台（如完成后置「待验收」）？（涉及生产流程与审计，v1 不写）
9. 附件是否要下载进仓库？（v1 只记文件名与数量）
10. `engines.board` 是否需要完整 semver 表达式（`||`、连字符区间）？v1 只实现最小集合，
    扩展意味着自带一个小解析器。
11. token 过期后的体验：只报 `token-expired` 等人工换，还是支持从浏览器 cookie 自动读取 / 飞书
    登录换 token？（平台登录页有第三方登录入口，但换 token 的接口未验证）

## 24. 附：代码锚点索引

| 锚点 | 位置 | 用途 |
| --- | --- | --- |
| `handleApi` | `server/index.js:564` | 插件路由挂载点 |
| `sendJson` / `readJsonBody` | `server/index.js:64` / `server/index.js:73` | 插件路由复用 |
| `readBoardState` / `writeBoardState` | `server/index.js:472` / `server/index.js:476` | `scan.completed` 数据来源 |
| `startStandaloneServer` | `server/index.js:884` | 插件加载时机 |
| `createTask` | `server/actions.js:68` | `task/create` 实现 |
| `assignTask` | `server/actions.js:115` | `task/assign` 实现 |
| `setManualStage` | `server/metadata.js:53` | `task/setStage` 实现 |
| `createWatchRuntime` | `server/watcher.js:28` | 400ms 防抖刷新 |
| `DATABASE_SCHEMA_VERSION` | `server/database.js:15` | v5 迁移入口 |
| `createRequestHandler` | `server/team/http.js:426` | team 模式路由栈（v1 不挂插件） |
| 进程树终止 | `server/team/process.js:34` | 宿主封装的 `terminateTree` |
| 最小环境构造 | `server/team/process.js:17` | `minimalEnvironment`，插件环境透传白名单 |
| 路径比较键 | `server/config.js:33` | `repositoryPathKey`，大小写敏感性由宿主统一 |
