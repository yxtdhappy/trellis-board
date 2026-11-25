---
mode: inline-self-check
agent: main-session
session: claude_ae0e318e-43aa-40c2-922f-246354254b3b
commit:
---

# 检查报告：加固 wit-e2e-testing 证据与凭据处理

检查对象：`11-24-harden-wit-e2e-testing-evidence` 的 M1（接口 E2E 库/模板/代理）与 M2（`wit-api-e2e` / `wit-ui-e2e` 拆分、`.agents` 同步、`wit-trellis-task-delivery` 下游更新）。

## 1. 结论

- M1 的五类修复已落地，Bash 14/14、PowerShell 12/12 自测通过；反向验证能捕获脱敏 fail-open。
- M2 的两个技能目录、归档、`.agents` 同步、下游技能引用均已落地；结构检查以手工核对完成。
- 存在证据缺口：`research/` 的完整快照/diff/sha 与 `check_skill_layout.py` 在当前工作区缺失；UI smoke 只覆盖本地静态页。详见第 4 节。

## 2. M1 验收核对

| 检查项 | 结果 | 证据 |
| --- | --- | --- |
| 代理日志不含 query 值、上游收到完整 query | PASS | 自测 R1：proxy.log 含 `token`/`page` 键名、不含 `SECRET`；响应含 `token=SECRET` |
| 预置 token 文件保留 | PASS | R2a：`CREATED=0`，文件仍存在 |
| 本轮创建 token 文件删除 | PASS | R2b：`CREATED=1`，文件被删除 |
| 仅 `E2E_TOKEN` 无文件操作 | PASS | R2c：不创建/不删除文件 |
| 证据不含 mock 秘密值，原始响应仍含秘密值 | PASS | R3：证据无 `AT-SECRET`/`RT-SECRET`/`COOKIE-SECRET`/`PWD-SECRET`/`DB-SECRET`，含 `visible`；原始 `ok.json` 含 `AT-SECRET` |
| 字符串/数字 code 判定 | PASS | R4a `"20000"` 不失败；R4b `20000` 不失败；R4c `"50000"` 失败并记录业务判据 |
| 非法 `E2E_FAILURE_JQ` 在 init 失败 | PASS | R4d：`E2E_FAILURE_JQ='(('` 时 init 非零 |
| 200 HTML 进入 failure delta | PASS | R5a：`failure delta (response is not valid JSON...)` |
| 缺 code 进入 failure delta | PASS | R5b：`failure delta (response has no code...)` |
| 非法 JSON 占位符断言 FAIL | PASS | R5c：`placeholder assertion` 失败 |
| 占位符文本 FAIL | PASS | R5d：`%s` 被捕获 |
| 干净响应 PASS | PASS | R5e：无占位符、无 failure delta |
| fail-closed 反向验证 | PASS | 临时改回原文后 `FAIL r3_redaction`、`unexpected match: AT-SECRET`，13/14 |

## 3. M2 验收核对

| 检查项 | 结果 | 证据 |
| --- | --- | --- |
| 两个技能目录与 SKILL.md 存在，frontmatter name 与目录一致 | PASS | `wit-api-e2e`、`wit-ui-e2e` frontmatter 已核对 |
| API 技能包含 references/scripts/self-test | PASS | 14 个文件；`run.sh`/`run.ps1` 可执行并 14/14、12/12 |
| UI 技能方案 A，无 scripts/代理/日志读取器 | PASS | UI 只有 `SKILL.md`、`ui-e2e-playbook.md`、`report-template.md` |
| 两个新技能无 `wit-e2e-testing` 残留 | PASS | `grep -RIn 'wit-e2e-testing'` 两目录无输出 |
| API 新路径 Bash/PS 自测 | PASS | `SELF-TEST pass=14 fail=0`；`SELF-TEST(PS) pass=12 fail=0` |
| UI smoke 与失败分类 | PASS | `research/ui-smoke/report.md`：idle→clicked-1、Console `smoke-clicked 1`；缺失选择器归类脚手架 |
| 旧技能归档、不在活跃 skills | PASS | `.claude/skills-archive/...`、`.agents/skills-archive/...`；活跃目录无旧技能 |
| `.agents` 同步与自测 | PASS | 两技能在 `.agents/skills/`；API 自测 14/14、12/12 |
| `wit-trellis-task-delivery` 两副本更新 | PASS | `.claude`/`.agents` 均已改；旧名 grep 无输出 |
| `implement.jsonl`/`check.jsonl` 与 validate | PARTIAL | jsonl 中部分 research 路径（`check_skill_layout.py`、diff/sha）当前缺失，未重跑 validate |

## 4. 证据缺口与未覆盖

- `research/` 当前只有 `skill-before/SKILL.md`、`skill-after-m1/SKILL.md`、`skill-split-map.md`、`ui-smoke/report.md`；完整备份、`m1.diff`、`m2.diff`、sha 清单、`check_skill_layout.py` 不在当前工作区。`implement.md` 中记录的 11 文件备份/2669/6800 行 diff 无法从当前工作区复现。
- 结构检查为手工核对（frontmatter、旧名 grep、文件集）；未运行 `check_skill_layout.py`。
- UI smoke 只覆盖本地静态页；未验证真实项目页面、登录态、Network 业务请求、后端链路。
- API 自测为 mock server；未连真实后端、未用真实 token；值级密钥未覆盖。
- 任务为旧版（`task_type`/`work_type` 为空），无 `trellis-check` 子代理；本报告按 `inline-self-check` 记录，check override 由主会话确认。

## 5. 复核命令

```bash
bash C:/Users/yuhaojie/.claude/skills/wit-api-e2e/scripts/self-test/run.sh
pwsh -NoProfile -File C:/Users/yuhaojie/.claude/skills/wit-api-e2e/scripts/self-test/run.ps1
grep -RIn 'wit-e2e-testing' C:/Users/yuhaojie/.claude/skills/wit-api-e2e C:/Users/yuhaojie/.claude/skills/wit-ui-e2e
find C:/Users/yuhaojie/.claude/skills/wit-ui-e2e -maxdepth 2 -type f
```

## 6. 判定

M1 判定 PASS；M2 判定 PASS（结构检查为手工核对，证据快照不完整）。任务可在报告中的缺口说明下归档；缺口不影响当前技能的运行行为，但影响完整回滚/复现能力。
