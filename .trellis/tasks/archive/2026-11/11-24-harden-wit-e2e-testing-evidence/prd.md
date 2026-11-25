# 加固并拆分 wit-e2e-testing 技能

## Goal

先修复会让 E2E 证据不可信或凭据泄漏的五类缺陷（M1），再把当前混合的接口 E2E 与 UI E2E 拆成两个独立技能（M2）：

- `wit-api-e2e`：接口阶段。本机最新代码启动的后端、真实 HTTP/鉴权/落库、日志增量证据、本地网关代理、Bash/PowerShell 用例库。
- `wit-ui-e2e`：页面阶段。浏览器真实操作、页面状态 + Network/Console/截图证据、前后端版本与链路检查。

不改变技能方法论、默认成功码 `20000` 和现有环境变量名。本任务只有一个 Trellis 任务；M1/M2 是同一任务的两个里程碑，不新建子任务，依赖在 `design.md` / `implement.md` 中显式记录。

## Background

### M1：证据与凭据缺陷

第三轮审计确认以下问题仍存在：

- `scripts/local-gateway-proxy.mjs:566` 的请求日志打印 `resolved.path`，其中包含 `requestUrl.search`；带 `?token=...` 的请求会把凭据写进代理日志，与 `references/local-forwarding-proxy.md:167` 的承诺矛盾。
- `scripts/api-e2e-template.sh:11` 和 `scripts/api-e2e-template.ps1:9-10` 把 `E2E_TOKEN_FILE` 默认到 `$HOME/.e2e-token`，而 `E2E_DELETE_TOKEN_FILE` 默认 1；如果用户在该路径保存可复用 token，模板结束会误删。
- `scripts/api-e2e-lib.sh:152` 响应摘要脱敏失败时回退到未脱敏原文（fail-open）；默认键名 `["pwd","password","passwd","token","secret"]` 精确匹配，`accessToken`、`cookie` 等不会命中；Bash 未把配置键 lowercase，PS 已 lowercase，两端漂移。
- `scripts/api-e2e-lib.sh:28` 的 `E2E_FAILURE_JQ` 用 `(.code? // $E2E_SUCCESS_CODE) != $E2E_SUCCESS_CODE` 比较；字符串 `"20000"` 与数字 `20000` 被判定为不等，合法响应会进入 failure delta；PS 用 `[string]` 比较，两端不一致。
- 200 的非 JSON 响应、缺少 `code` 的响应不会进入 failure delta，断言失败时缺少证据；`e2e_assert_no_placeholders`（`scripts/api-e2e-lib.sh:239-247`）在响应不是合法 JSON 时 `hits` 为空，直接 PASS（fail-open），PS 版本（`scripts/api-e2e-lib.ps1:367-379`）同样。

### M2：接口与 UI 混合

当前 `SKILL.md` 同时承载接口 E2E（本机后端、代理、token、日志）和 UI E2E（浏览器、页面、Network/Console）：

- 接口阶段的准入条件、脚本、token 规则会出现在 UI 阶段，agent 容易在页面任务里误用 curl/token/代理。
- UI 阶段的浏览器操作、截图、缓存判断没有独立 playbook，当前只在 `SKILL.md:87-96` 有一条本地拓扑，证据口径不足。
- `references/report-template.md:5-25` 的拓扑表和证据表把“页面操作”和“接口请求”混在同一张表，报告字段无法按阶段收敛。
- 一个技能名同时覆盖两种阶段，用户和 agent 都难以按阶段选择；拆成两个技能后，frontmatter 描述和阶段边界可以直接路由。

## Scope

### M1 In Scope

1. 代理请求/上游日志的 query 脱敏。
2. token 文件生命周期：不再隐式默认到 `$HOME`，只删除本轮创建的文件。
3. 响应与请求证据的脱敏：fail-closed、键名覆盖、Bash/PS 一致。
4. 业务失败判据：数字/字符串 code 一致，初始化时校验 `E2E_FAILURE_JQ` 可编译。
5. 非 JSON 200、缺少 code 的 failure delta，以及占位符断言的 JSON 合法性校验。
6. 上述五项的本地 mock 自测（Bash + PowerShell）和 API 文档同步。

### M2 In Scope

7. 新建 `C:/Users/yuhaojie/.claude/skills/wit-api-e2e/`，迁移接口 SKILL.md、`api-e2e-playbook.md`、`local-forwarding-proxy.md`、`log-sources.md`、API 版 report-template 和全部接口脚本。
8. 新建 `C:/Users/yuhaojie/.claude/skills/wit-ui-e2e/`，编写 UI SKILL.md、`ui-e2e-playbook.md`、UI 版 report-template；不复制接口库、日志读取器和代理（方案 A，已确认）。
9. 两个 SKILL.md 各写“阶段边界”，frontmatter description 写明“用于什么/不用于什么”，互相只按技能名指向，不按文件路径引用。
10. `references/report-template.md` 拆成 API 版和 UI 版：API 版只保留后端/代理/证据表，UI 版只保留页面/Network/Console/截图证据表。
11. 旧 `wit-e2e-testing` 在两者验证通过后归档到 `C:/Users/yuhaojie/.claude/skills-archive/wit-e2e-testing-2026-11-24/`；任务 `research/skill-before/` 保留原始备份。
12. 拆分验证：frontmatter/相对链接/旧名残留/脚本归属检查，`wit-api-e2e` 在新路径跑 Bash+PS 自测，`wit-ui-e2e` 跑结构检查 + 手工 smoke。
13. 同步 `C:/Users/yuhaojie/.agents/skills/` 镜像：旧 `wit-e2e-testing` 归档到 `.agents/skills-archive/`，新 `wit-api-e2e`/`wit-ui-e2e` 与 `.claude` 版本一致，路径指向 `.agents`。
14. 同步下游 `wit-trellis-task-delivery` 的 `.claude` 与 `.agents` 副本：E2E 章节改用 `wit-api-e2e`/`wit-ui-e2e`，删除旧技能名引用，阶段前置检查、单步闭环和报告分节。

### Out of Scope

- 代理上游超时、相对 `Location` 重写、`EADDRINUSE` 友好提示。
- Bash 日志字节偏移与轮转告警、PS 日志编码（UTF8 硬编码）、`--noproxy`。
- 临时响应文件与报告落盘顺序、按前缀清理/ID 提取、异步日志等待、耗时统计、额外 header、multipart。
- URL userinfo、JDBC `password=` 等值级密钥识别（本轮只做键名/模式脱敏 + fail-closed）。
- 修改默认成功码 `20000`、初始化 git 仓库、对真实后端或真实 token 跑测试。
- 新建 Trellis 任务或子任务（用户明确要求在本任务内完成）。
- 引入 Playwright/Selenium 等浏览器自动化依赖；UI 技能使用现有 Chrome DevTools MCP。
- 重写接口/UI 方法论；M2 只做内容迁移、分界和 UI playbook 补全。

## Requirements

### R1 代理 query 日志

- 代理的请求日志不得包含任何 query 参数的值；只允许打印 pathname 和 query 的键名。
- 转发给上游的路径必须继续携带完整 query，不能因为日志脱敏改变请求行为。
- 响应日志（`local-gateway-proxy.mjs:589`）保持只打印 pathname。
- 验收：请求 `/appgw/svc/api?token=SECRET&page=1` 时，代理日志不含 `SECRET`，但包含 `token` 和 `page` 键名；mock 上游收到的 query 仍是 `token=SECRET&page=1`。

### R2 token 文件生命周期

- 两个模板都不再把 `E2E_TOKEN_FILE` 默认到 `$HOME/.e2e-token`；未提供 `E2E_TOKEN_FILE` 或 `E2E_TOKEN` 时由 `e2e_init` / `Initialize-E2E` 明确报错。
- 新增 `E2E_TOKEN_FILE_CREATED`（0/1，默认 0），声明该文件由本轮运行创建。
- `E2E_DELETE_TOKEN_FILE=1` 时，只有 `E2E_TOKEN_FILE_CREATED=1` 才删除；文件不是本轮创建时保留并输出明确提示。
- 只设置 `E2E_TOKEN` 时没有文件可删，`e2e_done` / `Clear-E2ESecret` 不得删除任何文件。
- 文档推荐把 token 文件放在系统临时目录，不再示范仓库内路径（如 `./.e2e-token`）。
- 验收：预置 token 文件 + `CREATED=0` + `DELETE=1` → 文件仍在；预置 + `CREATED=1` + `DELETE=1` → 文件被删除；仅 `E2E_TOKEN` → 初始化成功且无文件操作。

### R3 脱敏 fail-closed 与键名覆盖

- 响应摘要脱敏失败时，证据中写明确的省略标记（如 `<response summary omitted: redaction failed>`），不得回退到未脱敏原文。
- 原始响应文件仍保留原文，供断言使用；只有写进证据的摘要必须脱敏。
- 默认规则必须命中：`accessToken`、`refreshToken`、`cookie`、`set-cookie`、`authorization`、`clientSecret`、`secretKey`、`privateKey`、`sessionId`、`dbPassword`、嵌套 `password`。
- `E2E_REDACT_KEYS_JSON` 继续表示“精确键名”，匹配时不区分大小写；新增可配置的键名模式（默认覆盖上述组合键）。Bash 和 PS 对配置键、匹配规则的处理必须一致。
- 验收：mock 响应的 `data` 同时含 `accessToken`、`cookie`、`nested.password`、`dbPassword` 和非敏感 `name`；证据中四个秘密值都不存在，`name` 仍在；原始响应文件仍含秘密值（证明测试有效）。

### R4 业务失败判据

- 默认 `E2E_FAILURE_JQ` 用字符串比较 code：`20000` 和 `"20000"` 都视为成功；其他 code 视为失败；`ok=false` 仍视为失败。
- `e2e_init` 必须校验 `E2E_FAILURE_JQ` 是可编译的 jq 表达式；非法表达式让初始化失败并打印表达式本身。
- PowerShell 继续用 `[string]` 比较，行为与 Bash 对齐。
- 验收：`{"code":"20000"}` 和 `{"code":20000}` 都不产生 failure delta；`{"code":"50000"}`、`ok:false` 产生 failure delta；非法 `E2E_FAILURE_JQ` 让初始化返回非零。

### R5 非 JSON / 缺 code / 占位符断言

- 新增 `E2E_REQUIRE_JSON`、`E2E_REQUIRE_CODE`（0/1）。库默认 0 以兼容非 WIT 项目；随技能提供的两个模板默认 1。
- 开关打开时，HTTP 200 但响应不是合法 JSON、或对象缺少 `code` 字段，都要进入 failure delta，并写明原因。
- 该开关只影响“是否输出失败证据”，不直接改变断言计数或脚本退出码。
- `e2e_assert_no_placeholders` / `Assert-E2ENoPlaceholders` 必须先确认响应文件是合法 JSON；非法、缺失或不可读时判定 FAIL，不得 PASS。
- 验收：200 HTML、200 无 code、非法 JSON 占位符文件都产生 FAIL 或 failure delta；正常 JSON 无占位符时 PASS。

### R6 自测

- 新增 `scripts/self-test/`：本地 mock HTTP server + Bash/PS 运行器；不访问外网、不使用真实 token、不依赖真实后端。
- 覆盖 R1–R5；代理是 Node 脚本，R1 的集成测试至少由 Bash 运行器覆盖；PS 运行器覆盖 R2–R5，并复用同一 mock server。
- 使用 localhost 临时端口、启动就绪轮询、退出时清理进程和临时目录；任一用例失败时退出码非零，并打印 PASS/FAIL 与 summary。
- 验收：`bash scripts/self-test/run.sh` 与 `pwsh -NoProfile -File scripts/self-test/run.ps1` 都退出 0；临时回退任一修复后，对应用例失败（实现时手动抽验一次并记录）。

### R7 M1 文档与备份

- 同步更新 M1 涉及的 API `SKILL.md`、`references/api-e2e-playbook.md`、`references/local-forwarding-proxy.md` 和两个模板，说明新的 token 所有权、脱敏规则、`E2E_REQUIRE_*`、字符串 code 与自测命令；不得留下与实现矛盾的旧说法。
- 由于技能目录不是 git 仓库，修改前把整个技能目录备份到本任务 `research/skill-before/`，修改后生成 `research/skill-after-m1/`、`research/m1.diff` 和 SHA-256 清单；diff 必须能应用到备份上复现 M1 修改。
- 验收：备份、M1 快照、diff、清单存在；文档中不再出现“结束自动删除用户 token 文件”“只按精确键名脱敏”等旧承诺。

### R8 技能拆分

- R8.1 两个新目录各含 `SKILL.md`，frontmatter `name` 与目录名一致（`wit-api-e2e`、`wit-ui-e2e`），`description` 非空、写明适用阶段和“不用于什么”。
- R8.2 `wit-api-e2e` 只放接口阶段内容：API SKILL.md、`api-e2e-playbook.md`、`local-forwarding-proxy.md`、`log-sources.md`、API 版 report-template、全部 `api-e2e-*` 脚本、`read-log-delta.ps1`、`local-gateway-proxy.mjs`、`scripts/self-test/`。
- R8.3 `wit-ui-e2e` 只放页面阶段内容：UI SKILL.md、`ui-e2e-playbook.md`、UI 版 report-template；方案 A 下不含 `api-e2e-lib*`、`local-gateway-proxy.mjs`、`read-log-delta.ps1`。
- R8.4 两个 SKILL.md 都有“阶段边界”表：API-only → `wit-api-e2e`；UI/页面 → `wit-ui-e2e`；接口契约未验证 → 先走 API 阶段；UI 需要本地后端/代理 → 先走 API 阶段。接口技能只保留一句指向 UI 技能，UI 技能只保留一句指向接口技能，不复制对方完整流程。
- R8.5 旧 `wit-e2e-testing` 在两个新技能验证通过后移出 `~/.claude/skills`，归档目录可读；任务 `research/skill-before/` 保留原始副本，可恢复。
- R8.6 两个新技能内 `grep -R 'wit-e2e-testing'` 为 0；相对链接可解析；API 技能无浏览器操作流程，UI 技能无 curl/token/API 库流程。
- R8.7 `C:/Users/yuhaojie/.agents/skills/` 镜像同步：旧 `wit-e2e-testing` 归档到 `.agents/skills-archive/`，新 `wit-api-e2e`/`wit-ui-e2e` 存在且与 `.claude` 版本内容一致；`.agents` 文本中的绝对路径指向 `.agents`；结构检查 PASS；API 自测在新路径通过。
- R8.8 下游 `wit-trellis-task-delivery` 的 `.claude` 与 `.agents` 副本不再引用旧技能名；运行条件、核心原则、第 7 节前置检查/7.1 单步闭环/7.2 用例覆盖/9.1 报告按 `wit-api-e2e` / `wit-ui-e2e` 分阶段描述；两份副本各自保留平台差异（`.claude` 的 Agent 工具说明、`.agents` 的通用说明）。
- 验收：目录、frontmatter、内容归属、链接和旧名残留检查全部通过；`.agents` 镜像同步；`wit-trellis-task-delivery` 两个副本同步；不新建第三个技能目录（方案 C 只允许一个非技能公共目录，需用户确认）。

### R9 拆分验证

- R9.1 在 `wit-api-e2e` 新路径跑 M1 的 Bash/PS 自测，均退出 0；不得只在旧路径通过。
- R9.2 `wit-ui-e2e` 先跑结构检查（frontmatter、链接、脚本归属、旧名残留），再按手工 smoke 清单执行：本地页面 → 打开 → 点击 → 采集 DOM/Network/Console/截图 → 故意点不存在的选择器 → 确认被分类为测试脚本/选择器问题而非产品缺陷。smoke 结果写入 `implement.md`。
- R9.3 检查两个技能没有对方阶段的完整流程；阶段边界表和 frontmatter 描述能正确路由。
- R9.4 `python ./.trellis/scripts/task.py validate harden-wit-e2e-testing-evidence` 通过；`implement.jsonl` / `check.jsonl` 更新到最终路径。
- 验收：R9.1–R9.4 全部满足；旧技能归档可逆；没有仓库业务代码改动。

## Acceptance Criteria

### M1

- [ ] R1–R7 全部满足。
- [ ] Bash 与 PS 自测均退出 0，输出用例级 PASS/FAIL。
- [ ] 证据文件不含 mock 秘密值；原始响应文件仍含秘密值。
- [ ] 预置 token 文件保留、本轮创建文件删除、仅 `E2E_TOKEN` 无文件操作。
- [ ] 字符串/数字 code、200 HTML、缺 code、非法 JSON 占位符四类用例结果符合预期。
- [ ] 代理日志无 query 值、上游收到完整 query。
- [ ] M1 文档更新完成，备份、快照、diff 可复现。

### M2

- [ ] `wit-api-e2e` / `wit-ui-e2e` 两个目录和 SKILL.md 存在，frontmatter `name` 与目录一致，description 写明适用/不适用。
- [ ] API 技能包含 R8.2 的全部文件；UI 技能包含 R8.3 的文件且（方案 A）不含 API 库/代理/日志读取器。
- [ ] 两个 SKILL.md 都有阶段边界；API 技能无浏览器流程，UI 技能无 curl/token/API 库流程。
- [ ] 两个新技能内无 `wit-e2e-testing` 残留；相对链接可解析。
- [ ] `wit-api-e2e` 新路径 Bash/PS 自测退出 0。
- [ ] UI 手工 smoke 清单执行完毕并记录，故意失败被正确分类。
- [ ] 旧 `wit-e2e-testing` 已归档且不在 `~/.claude/skills`；任务备份可恢复。
- [ ] `C:/Users/yuhaojie/.agents/skills/` 下同样只有 `wit-api-e2e`/`wit-ui-e2e`，旧技能在 `.agents/skills-archive/`；`.agents` 结构检查与 API 自测通过。
- [ ] `wit-trellis-task-delivery` 的 `.claude` 与 `.agents` 两个副本都没有旧技能名残留，E2E 章节按 `wit-api-e2e` / `wit-ui-e2e` 分阶段描述。
- [ ] `implement.jsonl` / `check.jsonl` 已更新到最终路径，`task.py validate` 通过。
- [ ] 除两个新技能目录、旧技能归档和本任务目录外，没有其他改动。

## Non-goals

- 不重构 M1 的接口脚本行为，不把技能目录纳入本仓库或新建 git 仓库；快照/diff 只作为任务产物。
- 不改变“一次操作 → 一条证据”的方法论，不新增测试层级。
- 不修改 `read-log-delta.ps1` 和 `log-sources.md` 的行为；`report-template.md` 只做 API/UI 拆分，不新增报告必填字段。
- 不引入浏览器自动化依赖，不要求 UI 技能自带 Playwright/Selenium。
- 不新建 Trellis 任务/子任务；M1/M2 在同一任务内按里程碑执行。

## Risks and Constraints

- **技能目录不受 git 管理**：必须先备份，任何修改失败都能从 `research/skill-before/` 恢复；M1/M2 各有快照和 diff，便于审查和回滚。
- **token 删除行为变化**：以前默认删除用户提供的文件，现在默认保留；这是有意的安全修复，需要在文档和模板注释中明确迁移方式。
- **脱敏模式误伤/漏判**：默认模式覆盖常见组合键，但可能误删合法字段（如 `tokenCount`）；通过 `E2E_REDACT_KEYS_JSON` / `E2E_REDACT_KEY_PATTERN` 可覆盖，文档需说明。
- **jq 版本**：Bash 脱敏依赖 `walk`，要求 jq ≥ 1.6；本机 1.8.2。初始化时应检查版本并给出明确错误。
- **PowerShell 版本**：模板已有 `#Requires -Version 7.0`，本轮只在 PowerShell 7 验证，不承诺 Windows PowerShell 5.1。
- **自测端口/进程**：Windows 下 Node 子进程、端口回收和信号处理可能不稳定；使用临时端口、就绪轮询和 trap 清理。
- **技能是用户级、跨项目生效**：M1 保持环境变量名兼容，新增变量都有默认值；M2 改变技能名和目录，属于有意的迁移，需要在任务报告里写清“旧名 → 新名”。
- **拆分后的内容漂移**：共享规则在两边各写短版，可能逐渐不一致；用 `research/skill-split-map.md` 记录映射，check 阶段逐段核对，不抽跨技能公共文件。
- **路由歧义**：两个 description 都包含“E2E”，可能同时被触发；必须写“不用于”并用阶段边界表兜底。
- **UI 验证的局限**：没有浏览器自动化依赖，UI smoke 是手工清单；结构检查只能证明文件/链接正确，不能替代真实页面验证，结果必须如实记录。
- **任务元数据**：`task.json` 的 `package` 是 create 默认的 `server`，本任务实际交付物是用户级技能和任务产物，不涉及 `packages/server` 代码。

## Open Questions

原唯一阻塞问题已确认，无待决阻塞项：

1. **UI 技能的独立性边界（已确认方案 A，2026-11-24）**：UI 技能只负责浏览器；本地后端/代理/日志读取属于 API 阶段。UI 不复制 `local-gateway-proxy.mjs`/日志读取器；需要本地代理时回到 `wit-api-e2e`。
   - 备选 B（UI 完全自包含，复制代理/日志读取器）和 C（共享 `wit-e2e-common/`）不采用；理由见 `design-m2.md` 9.9。

以下已有推荐，不阻塞；如果不同意在 review 时一并说：

2. 技能名用 `wit-api-e2e` / `wit-ui-e2e`（推荐）。
3. 旧技能在两个新技能验证通过后归档到 `C:/Users/yuhaojie/.claude/skills-archive/wit-e2e-testing-2026-11-24/`（推荐），不保留第三个可发现技能。
4. UI 自测用“结构检查 + 手工 smoke 清单”（推荐），不引入 Playwright。
5. 共享铁律/失败分类两边各写短版（推荐），不抽公共文件。
6. UI 技能不包含后端日志读取；需要时回到 API 技能（推荐，方案 A 的一部分）。

## Notes / Decision log

- 2026-11-24，用户确认 M1 的 5 项建议（m00285）：`E2E_TOKEN_FILE_CREATED` 所有权、库默认 0/模板默认 1、键名正则、值级密钥本轮不做、自测目录 `scripts/self-test/`。
- 2026-11-24，用户要求把 UI E2E 与接口 E2E 拆成两个独立技能，并在本任务内完成，不新建 Trellis 任务（m00285）。本 PRD 的 M2 即该需求。
- 2026-11-24，用户确认 M2 的 UI 独立性采用方案 A（阶段交接，UI 不含代理/日志读取器）。`design-m2.md` 的目录、迁移和验证按 A 执行。
- 任务保持单个；M2 依赖 M1 两个自测通过，依赖写在 `design-m2.md` 9.1 和 `implement.md` 的 M2 前置检查，不靠任务树隐含。
- 2026-11-24，用户发现 `.agents/skills/wit-e2e-testing` 未同步（m00968）；新增 R8.7，要求 `.claude` 与 `.agents` 两个技能根保持一致，旧 `.agents` 副本归档、新技能同步并验证。
- 2026-11-24，用户追问 `wit-trellis-task-delivery` 是否仍引用旧 E2E 技能（m01071）；新增 R8.8，两个技能根下的该技能都改用新技能名并分阶段描述。
- 当前处于 in_progress；M1/M2 的 `.claude` 侧已完成，`.agents` 侧已同步并通过结构检查/API 自测；task artifacts 正在做最终更新，未提交。
