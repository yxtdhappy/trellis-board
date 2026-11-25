---
name: wit-e2e-testing
description: >
  以「一次操作 → 一条对应后端日志证据 → 再看界面/响应」的闭环，对任意 WIT 项目做端到端验证（E2E）：
  功能验收、改动后回归、真实环境联调与排障，包括接口级 E2E（本机真实服务、真实鉴权、真实落库与副作用）、
  本地前后端与远端登录/静态资源混合时的网关转发代理。
  日志既可能在本地文件，也可能在 Rancher/Kubernetes Pod 内，项目、服务、日志路径都不预设。只要用户要求端到端测试、接口/API E2E、真机验证、回归验证，
  或要求「操作页面后核对后端日志是否有报错」，就使用本 skill。
---

# WIT 端到端验证

> 运行环境：PowerShell 7（本机脚本示例）。日志在 Kubernetes/Rancher 中时，
> 按 `wit-rancher-pod-shell` skill 取日志（见 [references/log-sources.md](references/log-sources.md)）。

## 铁律

1. **一次操作 → 一条日志证据 → 再看界面**。任何「只看页面渲染正常就判通过」都不算通过；页面正常但日志报错，按失败处理。
2. **不预设项目**：服务名、日志路径、集群名、namespace、认证方式全部先求证（问用户、读配置、查运行时系统表）。不确定就问，不猜、不照抄配置文件。
3. **接口 E2E 在本机完成**：本地构建并启动被测后端，直接请求本机端口；不把已部署环境实例当作接口 E2E 的被测端。环境实例只用于 UI E2E 的前端/网关入口。
4. **只读优先**：默认只做只读诊断（查日志、查状态、跑查询）。建表、改数据、重启、发布等写操作必须落在用户已授权的测试范围内，否则先取得确认。
5. **凭据只由用户提供，且不得内联进命令**：WIT 接口 E2E 的请求头固定为 `Weareint-Token`；token 值必须向用户索取可直接使用的测试 token，不得从源码、Jar 常量、浏览器存储、抓包结果自行推导、拼接或猜测。用户给了 token 就直接使用；没有就先停下询问。优先写入 `E2E_TOKEN_FILE`，由 `api-e2e-lib` / 模板脚本读取；**禁止手写 `curl -H 'Weareint-Token: ...'`**，避免 token 进入命令行历史、进程列表和会话记录。测试结束 unset 并删除 token 文件（库默认 `E2E_DELETE_TOKEN_FILE=1`），提醒用户轮换或作废该 token。凭据禁止出现在回复、证据、日志摘要、提交内容里。token 过期/无效（如 `MOM.BASE.AUTH.TOKEN.EXPIRED`、`INVALID`）时立即停止，不自行刷新、重新登录或从浏览器另取 token，向用户索取新 token 后重跑。
6. 发现失败先分类：**脚手架/环境问题** 还是 **被测代码缺陷**，再决定是否动代码。
7. **报告先落盘，再宣布完成**：E2E 结论必须写入项目约定的报告文件（任务目录下的 `research/`、`docs/` 或项目指定位置）；只在对话里汇总不算完成。

## 1. 前置检查

- **被测版本真的生效了吗**：本地进程看 PID + 启动时间；容器看 Pod 启动时间、镜像 tag、最近重启原因。改完代码没重启/没发布，就是在测旧版本。
- **入口可达**：前端页面地址、后端地址、健康检查；接口 E2E 的请求头固定 `Weareint-Token`，token 值由用户提供，缺失就先问。
- **日志源确定**：本地文件还是 Pod 内文件，见 [references/log-sources.md](references/log-sources.md)。
- **代码侧先绿**：单测/构建通过后再做真机验证，避免把单元级失败搬到浏览器。
- **迁移/DDL 已生效**：本次改动涉及建表、字段可空性、索引或数据库迁移脚本时，重启后确认新进程、迁移日志或版本表已记录本次变更；再跑一条真实写接口。单测全绿不代表真实插入能过数据库约束。
- **契约已实测**：先调一次只读详情，记录 `data` 的真实键名和类型；请求体以该响应为模板，字段名、枚举值、参数集合都以运行时返回为准，不照抄配置文件或旧文档。
- **数据策略**：本轮要构造什么数据、用什么前缀命名、怎么清理，先想清楚。
- **报告路径已定**：先确定报告文件落点与证据文件路径，避免测完再补。

### 接口 E2E 的本地启动

接口 E2E 的被测端必须是本机最新代码启动的后端进程：

- 记录启动命令、PID、启动时间和监听端口；端口已有旧进程时先确认版本，不要测旧代码。
- `application.yml` 依赖 Apollo 等外部配置中心时，先确认本机可达，或显式传入 `spring.datasource` 覆盖；降级启动方式要写进报告。
- 启动会执行 Flyway 时，确认目标库是可迁移的开发库，禁止指向生产库。
- 启动日志重定向到可读文件；先做一次最小请求，确认“请求 → 日志 → 响应”三层闭环，再跑用例。
- 构建、启动、连库和写测试数据都需要用户授权；测试数据统一前缀并在结束时清理。

### 接口 E2E 执行清单

详细步骤、用例矩阵和常见坑见 [references/api-e2e-playbook.md](references/api-e2e-playbook.md)，可直接复用 Bash 版 `scripts/api-e2e-lib.sh` + `scripts/api-e2e-template.sh`，或 PowerShell 版 `scripts/api-e2e-lib.ps1` + `scripts/api-e2e-template.ps1`。最低要求：

- 先读契约（路由、DTO、校验注解、业务码、响应结构），再发第一个请求；
- **契约探测**：先调一次只读详情，`jq '.data | keys'` 记录真实键名；请求体以详情响应为模板，逐字段删到最小必填集；配置类参数以接口契约或配置元数据声明的键为准，不把详情里的全部参数原样回传；
- **JSON 文件化**：含中文、引号、嵌套对象或较大的请求体一律用 Write 落 `.json` 文件，`jq -e .` 校验后 `e2e_post_file`（Bash）/ `Invoke-E2EPostFile`（PowerShell）发送；库内部用 `--data-binary @file`/字节流，不要用 `$(cat file)` 内联进 shell；
- 请求头固定 `Weareint-Token`；token 写入 `E2E_TOKEN_FILE`，由库读取并放进临时 header 文件，禁止内联进 curl 参数；
- **业务失败判定**：HTTP 200 不代表成功；默认 `code != 20000`（`E2E_SUCCESS_CODE`）或 `ok=false` 都按失败处理，失败时输出完整日志增量；
- 每个操作独立记录日志偏移，单步闭环；失败请求要读完整增量（含异常类型与 `Caused by` 栈），不能只看 `ERROR`；
- 写操作后必须用读接口复核；边界用例走 HTTP 层，不直接调 Service；
- 每个验收项标注验证层级：**契约级**（响应字段正确）还是 **持久化级**（写后读回或查库确认）；预览、试算、映射类接口通过不等于持久化通过；
- 错误/问题文案用 `e2e_assert_no_placeholders`（Bash）/ `Assert-E2ENoPlaceholders`（PowerShell）检查，禁止把 `{0}`、`%s` 等未格式化占位符当通过；
- 测试数据统一前缀，`trap cleanup` 保证失败也清理，最后按前缀确认 0 条残留。

最小用法：

```bash
cp "<skill-dir>/scripts/api-e2e-template.sh" ./e2e.sh
# 先用 Write 创建 token 文件（不要写进脚本、不要内联到命令行）
E2E_LIB="<skill-dir>/scripts/api-e2e-lib.sh" \
E2E_BASE_URL='http://localhost:8855/mdp-backend-service' \
E2E_TOKEN_FILE='./.e2e-token' \
E2E_LOG_FILE='D:/logs/localhost.log' \
bash ./e2e.sh
```

`E2E_TOKEN_FILE` 优先；`E2E_TOKEN` 仅作兼容，会出现在命令行/环境记录中。DLP 环境用编辑器或 Write 创建 token 文件。`E2E_DELETE_TOKEN_FILE` 默认 `1`，测试结束删除 token 文件；设 `0` 保留时必须在报告中说明原因。WIT 项目默认 `E2E_SUCCESS_CODE=20000`，非 WIT 项目按实际成功码覆盖。Claude Code 的 Bash 工具每次调用都是新 shell，环境变量不跨命令保留：把用例写成脚本文件一次执行，不要逐条手敲 curl。

PowerShell 原生版（不依赖 bash/jq，PowerShell 7 已验证）：

```powershell
$env:E2E_BASE_URL = 'http://localhost:8855/mdp-backend-service'
$env:E2E_TOKEN_FILE = './.e2e-token'
$env:E2E_LOG_FILE = 'D:/logs/localhost.log'
pwsh -NoProfile -File "<skill-dir>/scripts/api-e2e-template.ps1"
```

Git Bash 里调用 `pwsh` 时中文控制台输出可能乱码，以 UTF-8 证据文件为准；或在 Windows Terminal / PowerShell 窗口直接运行。

### 本地全链路拓扑

先判断“最新前端”和“最新后端”分别在哪里运行。前端来自环境、后端运行在本机时，优先复用前端 dev server 已有的本地转发；没有可复用入口时，本地启动前端，并在中间启动最小反向代理。

- 只把被测服务前缀路由到本地后端，登录、权限、系统公共接口和静态资源继续去环境。
- 不为了单次 E2E 永久修改项目代理配置；需要混合路由时使用 `scripts/local-gateway-proxy.mjs`。
- 代理启动后先查健康检查，再做一次最小请求，确认“浏览器 Network → 代理日志 → 本地后端日志”三层都出现同一请求。
- 代理路由错误属于脚手架问题，先修正链路，不能把环境请求打到旧后端后记成业务缺陷。

多路由、JSON 配置、Cookie/Origin、WebSocket 和故障处理见 [references/local-forwarding-proxy.md](references/local-forwarding-proxy.md)。

## 2. 单步闭环（每一步都执行）

1. 记录日志偏移：本地 `scripts/read-log-delta.ps1 -Path <log> -Marker`；Pod 内先记录 `date '+%Y-%m-%d %H:%M:%S'` 或 `wc -l <file>`
2. 执行**一次**操作（页面点一个按钮，或发一个请求；不要连点多个再一起看日志）
3. 只读该操作对应的增量日志：本地用 `scripts/read-log-delta.ps1 -From <偏移>`；Pod 用 wit-rancher-pod-shell 的 `tail` / `grep` / 时间窗
4. 判定三件事：对应请求**出现了吗**、结果是**成功还是失败**、有没有**异常堆栈**
5. 最后再看页面渲染或接口响应，与预期语义比对

把「操作 → 请求 → 日志结论」记成一行，最后汇总成报告（模板见 [references/report-template.md](references/report-template.md)）。

## 3. 用例设计

每个验收点尽量凑齐三类，关键改动再加对照组：

| 类型 | 作用 | 例子 |
| --- | --- | --- |
| 正向 | 证明功能可用 | 正常参数调用成功、页面展示正确数据 |
| 反向 | 证明失败可控 | 错误凭据/不可达 → 明确报错、不抛 500、不泄露凭据 |
| 回归 | 证明没破坏别处 | 其它方言/模块/页面、分页、导出 |
| 对照 | 校准预期 | 参考产品、旧版本、原生工具的行为对比 |

验收标准要可判定（列数、字段值、状态码、耗时），避免「看起来正常」。

每个用例同时标注验证层级，报告不得混淆：

| 层级 | 通过条件 | 不能替代 |
| --- | --- | --- |
| 契约级 | 响应字段名、类型、值、业务码符合预期 | 不能证明已落库 |
| 持久化级 | 写接口成功 + 读接口回读/查库确认目标值 | 不能用预览、试算、映射类响应替代 |
| 副作用级 | 关联表、文件、消息、目标对象状态已复核 | 不能只看主表返回值 |

## 4. 日志判读

增量日志分三类，不要混判：

| 类型 | 特征 | 处理 |
| --- | --- | --- |
| 本次操作的请求 | 请求开始/结束、结果: 成功/失败 | 判定通过与否的主证据 |
| 预期内的业务异常 | 断言过的报错文案/错误码 | 属预期，但要核对文案、错误码、是否带关键上下文 |
| 无关噪音 | 配置中心重连、心跳、探针、定时任务、平台统一打印 | 识别并排除，在报告里注明，避免误判为本次问题 |

## 5. 失败处理

- **脚手架问题**（环境名/集群名不对、负载均衡打到别的副本、前端缓存旧数据、请求体序列化错误）：修正测试方法后重跑该步，不要把环境问题记成代码缺陷。
- **真缺陷**：改代码 → 补一条能抓住该缺陷的回归用例 → 跑测试 → 重新部署/重启 → **用同一路径复测到通过**，才算闭环。
- **前端缓存**：列表/对象树可能缓存旧数据；重新加载页面或走到对应刷新入口后再判定。

## 6. 测试数据与环境注意

- 探针数据用可识别前缀命名，本轮结束即清理，并验证清理干净（集群环境要逐个副本确认）。
- 多副本/集群环境：资源要用集群级方式创建/删除，集群名以运行时系统表/接口返回为准；普通单机对象只落在一个副本上时，会出现「表不存在 / 已存在」的假故障。
- 有列表条数上限的界面：把探针数据放在可见范围内（例如按排序靠前命名），否则会误判为「数据不存在」。

## 7. 收尾

1. **先写报告**：按 [references/report-template.md](references/report-template.md) 生成报告文件（任务目录下的 `research/`、`docs/` 或项目指定位置），包含拓扑、证据表、结论、未验证项、清理记录；未落盘不得宣布 E2E 完成。
2. 清理探针数据并校验；临时响应文件在报告落盘后再删除，证据文件保留到任务提交/归档。
3. 把验收结论逐条回写（每条带真机证据：数值、列数、状态码、日志结论）；持久化项未做写后读回的，标为未验证，不勾选。
4. 删除 token 文件并提醒用户轮换/作废；确认报告和证据中无凭据。
5. 按项目流程提交/归档。

## 参考

- [references/api-e2e-playbook.md](references/api-e2e-playbook.md) —— 接口级 E2E 的门禁、用例矩阵、常见坑与退出标准
- [references/log-sources.md](references/log-sources.md) —— 本地文件与 Rancher/Kubernetes Pod 两种日志源的获取与增量读取
- [references/local-forwarding-proxy.md](references/local-forwarding-proxy.md) —— 本地前后端混合链路、动态多服务路由、健康检查和代理排障
- [references/report-template.md](references/report-template.md) —— 验收报告与验收清单模板
- `scripts/api-e2e-lib.sh` —— 通用接口 E2E 库（curl + jq、日志增量、请求脱敏、断言、证据）
- `scripts/api-e2e-template.sh` —— 接口 E2E 用例模板，复制后替换路由/字段/断言
- `scripts/api-e2e-lib.ps1` —— PowerShell 版通用库（HttpClient，无 bash/jq 依赖，PowerShell 7 已验证）
- `scripts/api-e2e-template.ps1` —— PowerShell 版用例模板
- `scripts/read-log-delta.ps1` —— 本地日志「取偏移 / 读增量」
- `scripts/local-gateway-proxy.mjs` —— 无第三方依赖的本地全链路反向代理
- 日志在 Pod 中：按 `wit-rancher-pod-shell` skill 执行（先 `ls` 确认当前日志文件，再有界 `tail`/`grep`）

