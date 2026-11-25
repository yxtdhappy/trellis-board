# 实施报告：加固 wit-e2e-testing 证据与凭据处理

- 任务：`11-24-harden-wit-e2e-testing-evidence`
- 日期：2026-11-25
- 范围：M1 修复五类证据/凭据缺陷；M2 把技能拆分为 `wit-api-e2e` / `wit-ui-e2e`，同步 `.agents` 与 `wit-trellis-task-delivery`。

## 1. M1：接口 E2E 库与模板

### 1.1 代理日志不再泄露 query 值

- `scripts/local-gateway-proxy.mjs` 新增 `redactQueryForLog(path)`：无 query 原样返回；有 query 返回 `pathname?[key1,key2]`。
- 请求日志使用 `logPath`，转发仍使用完整 `resolved.path`，上游收到的 query 不变。
- 验证：`node --check` 通过；自测 R1 证明代理日志含 `token`/`page` 键名、不含 `SECRET`，同时响应仍含 `token=SECRET`。

### 1.2 token 文件所有权

- Bash/PS 库新增 `E2E_TOKEN_FILE_CREATED`（默认 0）；`e2e_done`/`Clear-E2ESecret` 只在 CREATED=1 时删除 token 文件。
- 两个模板删除 `$HOME/.e2e-token` fallback，改为运行时要求 `E2E_TOKEN_FILE` 或 `E2E_TOKEN`，并提示用临时目录、设置 CREATED。
- 验证：R2a 预置文件保留；R2b 本轮创建文件删除；R2c 仅 `E2E_TOKEN` 无文件操作。

### 1.3 脱敏 fail-closed 与键名覆盖

- Bash 响应摘要脱敏失败改为写入 `<response summary omitted: redaction failed>`，不再回退原文；请求体路径保持 fail-closed。
- Bash 配置键统一 lowercase；Bash/PS 均支持精确键 + `E2E_REDACT_KEY_PATTERN` 正则，默认覆盖 `pwd|passw|secret|token|cookie|authorization|credential|privatekey|sessionid`。
- 验证：R3 覆盖 `accessToken`、`refreshToken`、`cookie`、嵌套 `password`、`dbPassword`，证据不含秘密值且保留 `visible`；反向验证把 fail-closed 改回原文后 R3 失败。

### 1.4 字符串/数字 code

- `E2E_FAILURE_JQ` 改为 `((.ok == false) or (((.code? // $code_json) | tostring) != ($code_json | tostring)))`，用 JSON 字符串常量并 tostring 比较。
- `e2e_init` 在创建临时文件前生成并校验表达式；`E2E_REDACT_KEYS_JSON` 校验为字符串数组，jq 要求 ≥1.6。
- PS 已用 `[string]` 比较；验证 R4a 字符串 `"20000"` 不失败、R4b 数字 20000 不失败、R4c `"50000"` 失败并记录业务判据。

### 1.5 非 JSON 200 与占位符 fail-open

- 新增 `E2E_REQUIRE_JSON`/`E2E_REQUIRE_CODE`（库默认 0，模板默认 1）。
- 200 HTML 归因为 `response is not valid JSON`；缺 code 归因为 `response has no code`；均进入 failure delta。
- 占位符断言先校验响应是合法 JSON，非法/缺失直接 FAIL；验证 R5a-e。

## 2. M2：技能拆分与下游同步

- 新建 `C:/Users/yuhaojie/.claude/skills/wit-api-e2e/`：SKILL、4 个 references、6 个 scripts、3 个 self-test 文件；只保留接口阶段内容。
- 新建 `C:/Users/yuhaojie/.claude/skills/wit-ui-e2e/`：SKILL、ui-e2e-playbook、report-template；方案 A，无 scripts/代理/日志读取器。
- 旧 `C:/Users/yuhaojie/.claude/skills/wit-e2e-testing/` 归档到 `C:/Users/yuhaojie/.claude/skills-archive/wit-e2e-testing-2026-11-24/`。
- `.agents/skills/` 同步 `wit-api-e2e`/`wit-ui-e2e`；旧 `.agents` 副本归档到 `C:/Users/yuhaojie/.agents/skills-archive/wit-e2e-testing-2026-11-24/`；`.agents` 版 `local-forwarding-proxy.md` 路径改为 `.agents`。
- `wit-trellis-task-delivery` 在 `.claude` 与 `.agents` 两副本更新 E2E 段：运行条件、核心原则、第 7 节前置检查、7.1 单步闭环、7.2 覆盖、9.1 报告分节；旧技能名清零。

## 3. 验证结果

| 项 | 结果 |
| --- | --- |
| API 自测（Bash） | `SELF-TEST pass=14 fail=0`（2026-11-25 重跑） |
| API 自测（PowerShell） | `SELF-TEST(PS) pass=12 fail=0`（2026-11-25 重跑） |
| 反向验证 | `SELF-TEST pass=13 fail=1`，`FAIL r3_redaction`、`unexpected match: AT-SECRET`（见 implement.md 执行记录） |
| UI smoke | `research/ui-smoke/report.md`：基线 `idle` → `clicked-1`，Console `smoke-clicked 1`，缺失选择器归类脚手架 |
| 结构 | 两个 SKILL frontmatter name 与目录一致；两目录无 `wit-e2e-testing` 字样；UI 目录只有 3 个文件 |

## 4. 偏差与未覆盖

- 当前 `research/` 只剩 `skill-before/SKILL.md`、`skill-after-m1/SKILL.md`、`skill-split-map.md`、`ui-smoke/report.md`；`m1.diff`、`m2.diff`、sha 清单、`check_skill_layout.py` 在当前工作区缺失，无法重新生成完整 diff；结构检查以手工 frontmatter、旧名 grep、文件集核对代替。
- 备份最初缺 scripts，后用 `.agents` 旧副本补齐；但补齐后的多文件快照未在当前工作区保留，恢复能力受限。
- UI smoke 只验证本地静态页与操作/证据流程，未验证真实项目页面、登录态、Network 业务请求、后端链路。
- API 自测使用 mock server，未连接真实后端、未使用真实 token；值级密钥（URL userinfo、JDBC password=）未处理。
- 任务 `11-24` 是旧版任务（task_type/work_type 为空），无 `trellis-check` 子代理，检查报告按 `inline-self-check` 记录。

## 5. 交付文件

- 技能：`C:/Users/yuhaojie/.claude/skills/wit-api-e2e/`、`wit-ui-e2e/`；旧技能归档；`.agents/skills/` 同步；`wit-trellis-task-delivery` 两副本更新。
- 任务：`prd.md`、`design.md`、`design-m2.md`、`implement.md`、`implement.jsonl`、`check.jsonl`、`research/`、本报告、`check-report.md`。
