# 接口级 E2E 通用执行手册

> 适用于任意项目的本机接口级 E2E。项目特定的字段、端口、日志路径只作案例，不写进步骤。

## 1. 边界

接口级 E2E = 真实 HTTP + 真实鉴权 + 真实序列化 + 真实持久化 + 真实业务分支，不打 Mock。

它不是：

- MockMvc / `standaloneSetup` 切片测试（没有真实容器、鉴权、DB）；
- 单测（不覆盖 Controller 绑定、全局异常、拦截器、事务）；
- UI E2E；
- 直接请求已部署环境实例。

**硬约束：接口 E2E 只在本机启动的最新代码上执行。**

## 2. 门禁

| 门禁 | 确认方式 | 失败处理 |
| --- | --- | --- |
| 运行的是最新代码 | 编译产物时间戳晚于源码；或响应出现新字段 | 重新构建/启动，旧进程结果作废 |
| 端口与 context path | 监听端口 + 启动日志 | 记录实际值，不猜 |
| 日志源与格式 | 有请求级日志（access log / traceId / 请求开始结束） | 没有就明确降级，不能假装有日志证据 |
| 测试凭据 | 请求头固定 `Weareint-Token`，token 值由用户提供；优先 `E2E_TOKEN_FILE` | token 缺失就索取一次，不推导；过期/无效立即停止并索取新 token |
| 迁移/DDL 已生效 | 新进程 + 迁移日志/版本表已记录本次变更 | 未生效先重启；旧进程结果作废 |
| 契约已实测 | 只读详情返回真实键名、枚举值、参数集合 | 请求体按实测结果重建，不照抄配置/旧文档 |
| 数据库可核对 | 只读账号或可查询入口 | 没有则声明“未直接验库”，用接口 + 单测补证 |
| 测试数据可清理 | 统一前缀 + 删除接口/SQL | 不能清理就不写数据 |
| 借用既有数据 | 明确授权 + 可恢复方案 | 未授权只读，不改 |
| 报告路径已定 | 项目任务目录或项目指定的报告位置 | 未定路径不开始正式用例 |

## 3. 凭据规则（强制）

- WIT 接口 E2E 的请求头固定为 `Weareint-Token`，直接使用，不需要再向用户确认头名。
- token 值使用用户提供的可用测试 token；用户未提供时索取一次。不得从源码、Jar 里的 `AuthConstants`、浏览器本地存储或抓包结果推导、拼接、猜测。
- 优先使用 `E2E_TOKEN_FILE`；同时设置 `E2E_TOKEN` 时以文件为准。`E2E_TOKEN` 仅作兼容，会出现在命令行/环境记录中。
- **禁止手写 `curl -H 'Weareint-Token: ...'`**：必须通过 `api-e2e-lib` 或模板脚本发请求。库会把 token 写入权限 600 的临时 header 文件，不进入 curl 参数。不要为了让单条命令跑通而临时内联 token。
- token 只写入临时文件或临时环境变量，用完立即清理；库默认 `E2E_DELETE_TOKEN_FILE=1`，但只删除本轮创建的文件（`E2E_TOKEN_FILE_CREATED=1`），用户已有的 token 文件默认保留并提醒用户轮换/作废，因为 token 可能已进入会话记录。
- token 过期/无效（如 `MOM.BASE.AUTH.TOKEN.EXPIRED`、`INVALID`）时立即停止，不自行刷新、重新登录或从浏览器另取 token；向用户索取新 token 后重跑。
- token、密码、Cookie 不进入回复、证据文件、报告、提交内容；请求体和响应摘要落证据前递归删除 `pwd`/`password`/`token`/`secret` 等键。

## 4. 六步流程

### 第 1 步：读契约

- Controller 路由、HTTP 方法、请求 DTO、校验注解、响应包装；
- Service 分支：是否连接数据库、是否幂等、事务边界、哪些字段会回写；
- 响应码：HTTP 200 不代表业务成功，断言要落到业务 `code` 与 `data`；
- 列表/详情结构：区分“字段缺失”和“字段存在但值为 null”（`has("field")`）；
- 鉴权：只按用户给出的请求头/凭据使用。

读代码之外，再做一次**契约探测**（只读）：

1. 调详情/列表接口，保存响应；
2. `jq '.data | keys'` 或 `jq '.data.list[0] | keys'` 记录真实键名和嵌套层级；
3. 请求体以该响应为模板，逐字段删到最小必填集；
4. 配置类参数只使用接口契约或配置元数据声明的键，不把详情里的全部参数原样回传；
5. 含中文、引号、嵌套对象的 JSON 写入文件，`jq -e .` 校验后用 `--data-binary @file` 发送；不要内联进 shell。

### 第 2 步：建立基线

- 记录日志当前行数；
- 调一次只读接口保存快照；
- 记录测试数据前缀、时间戳、计划创建/删除的 ID；
- 本次改动涉及建表、字段可空性、索引或迁移脚本时：重启后确认新进程与迁移记录，再跑一条真实写接口做快速验证；单测全绿不代表真实写入能过数据库约束。

### 第 3 步：单步闭环

1. 记录日志偏移；
2. 发**一次**请求；
3. 读增量日志：请求出现、结果成功/失败、无未捕获异常；
4. 断言 HTTP 状态 + 业务码 + 关键字段；
5. 必要时再调查询接口复核状态；
6. 写入证据文件。

不要连续执行多个操作后再一起看日志，否则证据无法归属。

### 第 4 步：副作用复核

- 写操作后必须用读接口复核，不只看写接口返回值；
- 有数据库访问能力时直接查目标行/JSON/计数；
- 没有时明确写“未直接验库”，不要用接口返回冒充 DB 证据；
- 每个用例标注验证层级：契约级（响应字段正确）、持久化级（写后读回或查库确认）、副作用级（关联对象状态已复核）；预览、试算、映射类接口通过不等于持久化通过。

### 第 5 步：边界与异常

- 先测非法输入/超长/缺字段，再测正向；
- 边界按“上限-1 / 上限 / 上限+1”三档；
- 校验注解在 Controller 前生效时 Service 分支不会执行，边界用例必须走 HTTP 层；
- 失败后复核“没有落库/没有改坏原值”。

### 第 6 步：清理与复测

- `trap cleanup EXIT` 或等价机制，失败也清理；
- 借用数据“写前记录、写后恢复、恢复后复查”；
- 按前缀查列表确认 0 条残留，不只看 delete 返回成功。

## 5. 用例矩阵

| 类型 | 说明 |
| --- | --- |
| 正向创建 | 最小合法请求，返回主键、列表可见 |
| 正向查询 | 列表/详情回填，新字段出现且值正确 |
| 边界 | 上限-1 可存、上限可存、上限+1 拒绝且不落库 |
| 非法输入 | 缺必填、类型错、非法枚举，错误码与文案可定位 |
| 状态转换 | 创建→编辑→清空→切换→删除，每步中间态可查询 |
| 批量/幂等 | 同批次键同请求重放返回首次结果且不新增数据；同键异请求被拒绝；批次结果可查 |
| 事务边界 | 校验失败整批不写；写入中途失败按产品契约停止并复核已提交/未提交部分；失败后重试行为符合契约 |
| 消息占位符 | 校验失败/问题列表文案已格式化，不出现 `{0}`、`%s` 等占位符 |
| 契约保持 | 未知字段/查询参数/其他 JSON 键不被覆盖或丢失 |
| 隔离性 | 新字段不参与旧链路（连接测试/计算/校验） |
| 回归与清理 | 相邻接口、重复删除、最终列表无残留 |

## 6. 证据与报告

每个操作至少一条记录：

```text
时间 | 方法 路径 | HTTP 状态 | 业务 code/msg | 关键 data（脱敏）
请求体（去掉 pwd/token）
日志增量（请求开始/结束、异常）
断言：PASS/FAIL + 实际值
```

后端没有请求级日志时，允许降级为“响应 + 数据库/单测/副作用证据”，但必须在门禁和报告里写明降级原因、可用证据和无法归因的部分；不得伪造日志行，也不得把降级当完整证据。

报告固定结构：

1. 环境与版本（进程、端口、日志、生效证据）
2. 测试数据策略（前缀、创建、借用、清理）
3. 用例表（操作 → 响应 → 日志 → 验证层级 → 结论）
4. 自动化测试与构建结果
5. 已知限制与未验证项（没验到的部分逐条写明）
6. 清理结果

报告必须落盘到项目任务目录或项目指定位置，未生成报告不得宣布 E2E 完成。证据文件保留到报告落盘并提交/归档后再清理，临时响应文件可以删，归因证据不要提前删。

## 7. 可复用脚本

Bash 版（需要 Git Bash + jq）：

- `scripts/api-e2e-lib.sh`：通用库。`e2e_init` 校验环境、优先读 `E2E_TOKEN_FILE` 并生成临时 header 文件；`e2e_post/get/post_file` 发请求（文件体走 `--data-binary @file`）、自动记录日志增量、递归脱敏请求/响应、统计业务失败（`code` 的字符串/数字形式不等于 `E2E_SUCCESS_CODE`，或 `ok=false`）；`e2e_assert_*` 统一计数，`e2e_assert_no_placeholders` 检查未格式化占位符；`e2e_item` 按 id 取列表卡片；`e2e_summary` 输出结果并返回失败码；`e2e_done` 清理临时 header，并只删除本轮创建（`E2E_TOKEN_FILE_CREATED=1`）的 token 文件。
- `scripts/api-e2e-template.sh`：用例模板，复制后替换路由、字段和断言；内置 `trap cleanup EXIT`。

```bash
cp "<skill-dir>/scripts/api-e2e-template.sh" ./e2e.sh
E2E_LIB="<skill-dir>/scripts/api-e2e-lib.sh" \
E2E_BASE_URL='http://localhost:8855/mdp-backend-service' \
E2E_TOKEN_FILE="${TMPDIR:-/tmp}/e2e-token" \
E2E_LOG_FILE='D:/logs/localhost.log' \
E2E_EVIDENCE_FILE='./evidence/api-e2e.log' \
bash ./e2e.sh
```

PowerShell 版（不依赖 bash/jq，PowerShell 7 已验证）：

- `scripts/api-e2e-lib.ps1`：`Initialize-E2E`、`Invoke-E2EPost/PostFile/Get`、`Assert-E2E*`（含 `Assert-E2ENoPlaceholders`）、`Get-E2EItem`、`Write-E2ESummary`；优先读 token 文件，日志按字节偏移读增量，递归脱敏，失败判定同时看 HTTP、`code` 与 `ok`，证据 UTF-8 落盘；`Clear-E2ESecret` 只删除本轮创建（`E2E_TOKEN_FILE_CREATED=1`）的 token 文件。
- `scripts/api-e2e-template.ps1`：用例模板；`try/finally` 清理，`exit 1` 表示有失败。

```powershell
$env:E2E_BASE_URL = 'http://localhost:8855/mdp-backend-service'
$env:E2E_TOKEN_FILE = (Join-Path $env:TEMP 'e2e-token')
$env:E2E_LOG_FILE = 'D:/logs/localhost.log'
$env:E2E_EVIDENCE_FILE = './evidence/api-e2e.log'
pwsh -NoProfile -File "<skill-dir>/scripts/api-e2e-template.ps1"
```

`E2E_TOKEN_FILE` 优先，`E2E_TOKEN` 仅作兼容；两者同时设置时库会警告并使用文件。企业 DLP 可能加密脚本重定向生成的 token 文件，优先用编辑器/Write 创建，并放在临时目录。`E2E_DELETE_TOKEN_FILE` 默认 `1`，但只删除本轮创建的文件（需同时设 `E2E_TOKEN_FILE_CREATED=1`）；用户已有的 token 文件默认保留，保留需在报告中说明原因。模板默认 `E2E_REQUIRE_JSON=1`、`E2E_REQUIRE_CODE=1`，库默认 `0`。WIT 项目默认 `E2E_SUCCESS_CODE=20000`，非 WIT 项目按实际成功码覆盖。

要点：

- JSON 用 `jq -n --arg`（Bash）或哈希表 + `ConvertTo-Json`（PowerShell）生成，避免中文/引号转义问题；复杂/中文/大请求体先落文件并 `jq -e .` 校验，再用 `e2e_post_file`/`Invoke-E2EPostFile` 发送；
- ID 统一转字符串比较；
- 每步独立取日志偏移，证据只落摘要，不写 token/密码；失败请求追加完整异常栈；业务失败判定默认字符串/数字 `code` 与 `20000` 比较，或 `ok=false`；用 `E2E_SUCCESS_CODE`（Bash/PowerShell）适配项目，Bash 还可用 `E2E_FAILURE_JQ`，PowerShell 用 `E2E_FAILURE_PROPERTY`；
- 优先 `E2E_TOKEN_FILE`；token 不内联进命令行或 curl 参数；
- Bash 每次调用是新 shell，环境变量不跨命令保留；用例写成脚本文件一次执行；
- Git Bash 调 `pwsh` 时中文控制台输出可能乱码，以 UTF-8 证据文件为准。

## 8. 常见坑

1. 单模块测试不带 `-am`：命中本地仓库旧依赖 jar。
2. IDE 启动的进程用 `target/classes`：核对新类 `.class` 时间戳，不只看源码已改。
3. 只看 HTTP 200：鉴权失败也可能 200，业务码才是结论。
4. 鉴权头：WIT 固定 `Weareint-Token`；token 值必须由用户提供，不从代码推导。
5. 校验注解在 Controller 前拦截：边界用例打 HTTP，不要直接调 Service。
6. `has("field")=true` 但值为 `null`：说明新代码生效且值为空，不是字段缺失。
7. 借用数据恢复不彻底：清空 JSON 键可能把 `null` 变成 `"{}"`，要说明语义并复查关键字段。
8. 清理只看 delete 返回：必须再查列表确认前缀记录为 0。
9. 业务码成功但 `data.ok=false`：断言要落到业务结果字段。
10. 证据含敏感信息：token、密码、Cookie 不入报告、不入提交。
11. 单测全绿但真实写入失败：数据库非空约束、默认值、迁移未执行，单测覆盖不到；先做真实写入冒烟。
12. 中文/嵌套 JSON 内联进 shell：引号被 shell 吃掉，接口报“请求体格式错误”；改为写文件 + `jq -e .` + `--data-binary @file`。
13. 把详情响应里的参数全量回传：新增了未声明参数，接口拒绝；配置类参数按契约声明裁剪。
14. 失败日志只 grep `ERROR`：漏掉 `Caused by` 和业务栈；失败请求读完整增量。
15. 把预览/试算/映射结果当持久化证据：必须再走写接口并读回。
16. Bash 每次调用是新 shell：`export` 不跨命令保留；用例写成脚本文件一次执行。
17. token 过期/无效（`40300`、`TOKEN.EXPIRED`、`TOKEN.INVALID`）：立即停止并索取新 token；不要临时打开浏览器另取 token，也不要把无效 token 当业务失败继续跑。
18. 只按 `ok == false` 判失败：WIT `Result` 用 `{code,msgCode,msg,data}`，HTTP 200 + `code=50000` 也会被漏判；默认谓词已同时检查 `code != 20000`。
19. 错误/问题文案带 `{0}`、`%s`：批量校验、消息模板未格式化时最容易出现；用 `e2e_assert_no_placeholders`/`Assert-E2ENoPlaceholders` 断言，不能只看“有报错”就通过。
20. 测试结束保留 token 文件：本轮创建的默认删除；用户已有的文件默认保留，需在报告中写明来源、原因和过期时间。

## 9. 退出标准

- 所有断言通过；失败项分类为“代码缺陷 / 环境问题 / 脚手架问题”；
- 每个操作都有可归属的日志与响应证据；
- 日志无未捕获异常；
- 测试数据清理完毕，借用数据已恢复；
- 报告、证据落盘；持久化项已写后读回，未验证项在报告中逐条列出；
- 本轮创建的 token 文件已删除、用户已有文件已保留，并已提醒用户轮换/作废 token；
- 有 UI 页面时，UI E2E 未完成前不归档任务。

## 10. 案例映射（R35868，仅作示例）

| 通用类型 | 本次用例 |
| --- | --- |
| 正向创建 | 新增 Doris 数据源并写 `loadUrl` |
| 正向查询 | `/list` 回填 `loadUrl`，`url` 原样保留 |
| 边界 | 100 字符通过、101 字符拒绝且不落库 |
| 状态转换 | 清空 `loadUrl`、类型切换移除历史键 |
| 契约保持 | `ext.urlParams` 不被覆盖（单测断言） |
| 隔离性 | `/check` 带非 JDBC 的 loadUrl 仍成功连接 |
| 非 Doris 忽略 | 新建 MySQL 携带 loadUrl 不落库 |
| 清理 | 删除 `E2E_LDURL_*`，最终列表 0 条 |