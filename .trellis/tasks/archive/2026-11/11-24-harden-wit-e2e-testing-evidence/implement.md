# Implement：加固 wit-e2e-testing 技能

> 执行前先确认 `prd.md` / `design.md` 已 review；本文件是执行清单，不替代设计。
> 所有命令在 Git Bash 中执行；PowerShell 相关命令显式用 `pwsh -NoProfile -File`。
> 不执行构建；不访问真实后端；不使用真实 token；不提交/推送 git。

## 0. 准备与备份

- [ ] 确认当前分支和任务：
  ```bash
  cd /d/wit/trellis-board
  python ./.trellis/scripts/task.py current --source
  ```
- [ ] 记录技能目录当前状态（文件名、大小、mtime）：
  ```bash
  SKILL='C:/Users/yuhaojie/.claude/skills/wit-e2e-testing'
  TASK='D:/wit/trellis-board/.trellis/tasks/11-24-harden-wit-e2e-testing-evidence'
  find "$SKILL" -type f -printf '%P\t%s\t%TY-%Tm-%Td %TH:%TM\n' | sort
  ```
- [ ] 备份并生成清单：
  ```bash
  mkdir -p "$TASK/research"
  cp -a "$SKILL" "$TASK/research/skill-before"
  (cd "$TASK/research/skill-before" && find . -type f -print0 | sort -z | xargs -0 sha256sum) \
    > "$TASK/research/skill-before.sha256"
  ```
- [ ] 确认备份可读：`ls "$TASK/research/skill-before/scripts"`。

## 1. 代理 query 日志（R1）

- [ ] 在 `scripts/local-gateway-proxy.mjs` 增加 `redactQueryForLog`（设计 4.1）。
- [ ] 把 `:566` 的 `resolved.path` 替换为 `redactQueryForLog(resolved.path)`；保持 `requestOptions(..., resolved.path, ...)` 不变。
- [ ] 检查 `:589` 响应日志未改动。
- [ ] 手工冒烟（在自测脚本就绪前）：
  ```bash
  node "$SKILL/scripts/local-gateway-proxy.mjs" --help
  ```
  确认脚本无语法错误；完整 query 行为由第 2 步的 `run.sh` R1 覆盖。

## 2. Bash 库与自测（R2–R5）

- [ ] 按设计 4.2 修改 `scripts/api-e2e-lib.sh`：
  - [ ] 默认值：`E2E_FAILURE_JQ` 改为空、`E2E_TOKEN_FILE_CREATED`、`E2E_REDACT_KEY_PATTERN`。
  - [ ] `e2e_init`：0/1 校验、jq ≥ 1.6、REQUIRE 读取、failure JQ 生成/校验、pattern 校验。
    - 生成默认表达式时用 `jq -Rn --arg code "$E2E_SUCCESS_CODE" '$code'` 得到 JSON 字符串常量，避免非数字成功码导致 jq 语法错误。
    - `E2E_REDACT_KEYS_JSON` 校验为数组且元素都是字符串。
  - [ ] `e2e_redact_jq`：精确键 + 模式，Bash 键名 lowercase。
  - [ ] `e2e_request`：响应摘要 fail-closed；`failure_reason` 统一分支。
  - [ ] `e2e_assert_no_placeholders`：先校验 JSON。
  - [ ] `e2e_done`：CREATED 门禁。
- [ ] 新建 `scripts/self-test/mock-server.mjs`（设计 4.5 的端点表）。
- [ ] 新建 `scripts/self-test/run.sh`，覆盖 R1–R5；每个用例独立 evidence 文件。
- [ ] 运行：
  ```bash
  bash "$SKILL/scripts/self-test/run.sh"
  ```
  期望：所有用例 PASS，summary `fail=0`，退出 0。
- [ ] 若失败，先判断是脚本 bug 还是测试假设；不要为了让测试通过而放宽断言。

## 3. PowerShell 库与自测（R2–R5）

- [ ] 按设计 4.3 修改 `scripts/api-e2e-lib.ps1`：
  - [ ] `Initialize-E2E`：RedactPattern、REQUIRE、0/1 校验、正则编译校验。
  - [ ] `Remove-E2ESensitiveField`：精确键 + 模式。
  - [ ] `Invoke-E2ERequest`：JSON 合法性、缺 code、failureReason、证据行。
  - [ ] `Assert-E2ENoPlaceholders`：先解析 JSON。
  - [ ] `Clear-E2ESecret`：CREATED 门禁。
- [ ] 新建 `scripts/self-test/run.ps1`，覆盖 R2–R5；复用 `mock-server.mjs`。
- [ ] 运行：
  ```bash
  pwsh -NoProfile -File 'C:/Users/yuhaojie/.claude/skills/wit-e2e-testing/scripts/self-test/run.ps1'
  ```
  期望退出 0，summary `fail=0`。
- [ ] 对齐检查：同一 mock 响应在 Bash/PS 证据中都不含秘密值；字符串 code 都不产生 failure delta。

## 4. 模板与文档（R2/R5/R7）

- [ ] `scripts/api-e2e-template.sh`：删除 `$HOME/.e2e-token` fallback；增加 REQUIRE 默认 1 和 CREATED 注释；头部改成“`E2E_TOKEN_FILE` 或 `E2E_TOKEN` 至少一个”。
- [ ] `scripts/api-e2e-template.ps1`：删除 `$HOME/.e2e-token` fallback；增加 REQUIRE 默认 1 和 CREATED 注释；头部同步为“二选一”。
- [ ] `SKILL.md`：
  - [ ] token 所有权与临时目录建议。
  - [ ] 脱敏规则/fail-closed/值级密钥范围。
  - [ ] 字符串 code 与 `E2E_REQUIRE_*`。
  - [ ] 自测命令。
- [ ] `references/api-e2e-playbook.md`：env 表、token 流程、failure delta 原因、自测。
- [ ] `references/local-forwarding-proxy.md:167`：改为“只记录 pathname 和 query 键名”。
- [ ] 全文搜索旧说法，确认没有矛盾：
  ```bash
  grep -rn '\.e2e-token\|测试结束删除\|不打印查询参数\|code != E2E_SUCCESS_CODE' \
    "$SKILL/SKILL.md" "$SKILL/references" "$SKILL/scripts" || true
  ```

## 5. 全量验证与收尾

- [ ] 再跑两个自测：
  ```bash
  bash "$SKILL/scripts/self-test/run.sh"
  pwsh -NoProfile -File "$SKILL/scripts/self-test/run.ps1"
  ```
- [ ] 反向验证一次：临时把 `api-e2e-lib.sh` 响应摘要的 fail-closed 改回 `|| printf '%s' "$resp"`，跑 `run.sh` 的 R3，确认测试失败；恢复。
- [ ] 生成 diff 和修改后清单：
  ```bash
  diff -ruN "$TASK/research/skill-before" "$SKILL" > "$TASK/research/skill-after.diff" || [ $? -eq 1 ]
  (cd "$SKILL" && find . -type f -print0 | sort -z | xargs -0 sha256sum) \
    > "$TASK/research/skill-after.sha256"
  wc -l "$TASK/research/skill-after.diff"
  ```
- [ ] 检查 diff 只包含预期文件：
  ```bash
  grep '^diff ' "$TASK/research/skill-after.diff"
  ```
- [ ] 更新 `implement.jsonl` / `check.jsonl` 的路径与理由（如实际文件有增减）。
- [ ] 在下方“执行记录”追加：自测输出摘要、反向验证结果、diff 统计。
- [ ] 校验任务：
  ```bash
  python ./.trellis/scripts/task.py validate harden-wit-e2e-testing-evidence
  ```
- [ ] 确认没有修改仓库业务代码、没有提交/推送。

## 6. M2 拆分前置（R8/R9）

- [ ] 确认第 5 节 Bash 与 PS 自测都通过；任一失败则停止 M2，先修 M1。
- [ ] 设置变量（每个新 shell 重新设置）：
  ```bash
  TASK="D:/wit/trellis-board/.trellis/tasks/11-24-harden-wit-e2e-testing-evidence"
  OLD_SKILL="C:/Users/yuhaojie/.claude/skills/wit-e2e-testing"
  API_SKILL="C:/Users/yuhaojie/.claude/skills/wit-api-e2e"
  UI_SKILL="C:/Users/yuhaojie/.claude/skills/wit-ui-e2e"
  ARCHIVE="C:/Users/yuhaojie/.claude/skills-archive/wit-e2e-testing-2026-11-24"
  ```
- [ ] 生成 M2 输入快照（旧技能已在 0 节备份，这里保留 post-M1 状态）：
  ```bash
  rm -rf "$TASK/research/skill-after-m1"
  cp -a "$OLD_SKILL" "$TASK/research/skill-after-m1"
  diff -ruN "$TASK/research/skill-before" "$TASK/research/skill-after-m1" \
    > "$TASK/research/m1.diff" || [ $? -eq 1 ]
  (cd "$TASK/research/skill-after-m1" && find . -type f -print0 | sort -z | xargs -0 sha256sum) \
    > "$TASK/research/skill-after-m1.sha256"
  ```
- [ ] 确认 `$API_SKILL`/`$UI_SKILL` 尚不存在；存在则停止，先人工检查，不覆盖。

## 7. 创建 `wit-api-e2e`（R8.1–R8.4）

- [ ] 复制 post-M1 目录：
  ```bash
  cp -a "$TASK/research/skill-after-m1" "$API_SKILL"
  ```
- [ ] 重写 `$API_SKILL/SKILL.md`：
  - frontmatter `name: wit-api-e2e`，description 末尾写“不用于浏览器页面/UI 流程，页面 E2E 用 `wit-ui-e2e`”。
  - 删除 `:87-96` 本地全链路拓扑、UI 页面/浏览器/截图内容、UI 报告字段。
  - 增加“0. 阶段边界”表（只验证接口/本机后端 → 本技能；浏览器页面 → `wit-ui-e2e`；UI 需要本地后端/代理 → 本技能先搭链路；接口契约未验证 → 本技能先验证）。
  - 末尾“UI 阶段交接”：接口契约已验证时，交出 base URL、测试账号、测试数据前缀、已知限制。
- [ ] 重写 `$API_SKILL/references/report-template.md`：拓扑只含后端、代理、DB；证据表列为“请求 / 响应 / 后端日志 / 验证层级 / 结论”；删除页面、前端 dev proxy、截图列。
- [ ] 检查 `$API_SKILL` 内不出现 `wit-e2e-testing`、`Chrome DevTools`、`mcp__chrome`、`页面操作`、`点击按钮`；`references/*.md` 的相对链接都能解析。
- [ ] 不改动迁移过来的脚本内容；`scripts/self-test/` 相对路径保持不变。

## 8. 创建 `wit-ui-e2e`（R8.1–R8.4）

- [ ] 创建目录：
  ```bash
  mkdir -p "$UI_SKILL/references"
  ```
- [ ] 写 `$UI_SKILL/SKILL.md`（结构见 `design-m2.md` 9.5）：
  - frontmatter `name: wit-ui-e2e`，description 末尾写“不用于纯接口/API E2E，接口 E2E 用 `wit-api-e2e`”。
  - 铁律、0 阶段边界（与 API 技能镜像）、前置检查（前后端版本/三场景）、本地全链路拓扑、单步闭环（baseline → 一次操作 → after → 判定）、用例设计、证据判读、失败处理、测试数据/环境、收尾、参考。
  - 方案 A 下不写代理启动步骤，只写“需要本地后端/代理/后端日志时回到 `wit-api-e2e`”。
- [ ] 写 `$UI_SKILL/references/ui-e2e-playbook.md`：Chrome DevTools MCP 入口、三种运行场景、证据格式、断言、常见坑、失败分类、退出标准。
- [ ] 写 `$UI_SKILL/references/report-template.md`：页面 URL/前端/代理/后端拓扑；`# / 页面操作 / 期望 UI 状态 / 实际 UI 状态 / Network / Console / 截图 / 验证层级 / 结论` 证据表；未验证项、清理、验收清单、禁忌。
- [ ] 确认 `$UI_SKILL` 内不出现 `api-e2e-lib`、`local-gateway-proxy`、`read-log-delta`、`Weareint-Token`、`e2e_init`、`curl -H`；方案 A 下没有 `scripts/`（或为空）。

## 9. M2 验证（R9）

- [ ] 结构检查：
  ```bash
  python "$TASK/research/check_skill_layout.py" --api "$API_SKILL" --ui "$UI_SKILL" --variant A
  ```
  预期：frontmatter、相对链接、旧名、脚本归属、互斥关键词全部通过；失败时按 `文件:行` 修复。
- [ ] API 新路径自测：
  ```bash
  bash "$API_SKILL/scripts/self-test/run.sh"
  pwsh -NoProfile -File "$API_SKILL/scripts/self-test/run.ps1"
  ```
- [ ] UI 手工 smoke：
  1. 写一个本地静态页 `$TASK/research/ui-smoke/index.html`（按钮点击后改文本并 `console.log`；不连真实后端/token）。
  2. 启动 `python -m http.server 8765 --directory "$TASK/research/ui-smoke"`。
  3. 用 Chrome DevTools MCP 新标签打开 `http://127.0.0.1:8765/`，记录 URL/视口/截图/DOM/Console。
  4. 点击按钮，断言文本变化，记录 Network/Console/截图。
  5. 点击不存在的选择器，确认归类为测试脚本/选择器问题。
  6. 在“执行记录”写“通过/未验证”，不得只写“页面正常”。Chrome DevTools MCP 不可用时记录阻塞，不以其他浏览器静默替代。
- [ ] 归档旧技能（全部验证通过后）：
  ```bash
  mkdir -p "C:/Users/yuhaojie/.claude/skills-archive"
  [ ! -e "$ARCHIVE" ] || { echo "archive exists: $ARCHIVE"; exit 1; }
  mv "$OLD_SKILL" "$ARCHIVE"
  [ ! -e "$OLD_SKILL" ] && echo "old skill archived"
  ls "C:/Users/yuhaojie/.claude/skills"
  ```
- [x] 同步 `.agents` 镜像（用户 m00968 追加）：旧 `.agents/skills/wit-e2e-testing` 归档到 `C:/Users/yuhaojie/.agents/skills-archive/wit-e2e-testing-2026-11-24/`；复制 `wit-api-e2e`/`wit-ui-e2e` 到 `C:/Users/yuhaojie/.agents/skills/`；把 `.agents` 版 `local-forwarding-proxy.md` 中的 `.claude` 路径替换为 `.agents`；跑结构检查与 API 自测。
- [ ] 生成 M2 快照与 diff：
  ```bash
  rm -rf "$TASK/research/skill-after-m2"
  mkdir -p "$TASK/research/skill-after-m2"
  cp -a "$API_SKILL" "$TASK/research/skill-after-m2/wit-api-e2e"
  cp -a "$UI_SKILL" "$TASK/research/skill-after-m2/wit-ui-e2e"
  diff -ruN "$TASK/research/skill-after-m1" "$TASK/research/skill-after-m2" \
    > "$TASK/research/m2.diff" || [ $? -eq 1 ]
  (cd "$TASK/research/skill-after-m2" && find . -type f -print0 | sort -z | xargs -0 sha256sum) \
    > "$TASK/research/skill-after-m2.sha256"
  ```
- [ ] 更新 `implement.jsonl`/`check.jsonl`：加入 `research/skill-split-map.md`、`research/check_skill_layout.py`，把旧技能路径改为最终路径或明确归档。
- [ ] 重跑 `python ./.trellis/scripts/task.py validate harden-wit-e2e-testing-evidence`。
- [ ] 确认仓库业务代码未改、没有提交/推送；在“执行记录”追加 M2 结果。

## 执行记录

- 备份：`research/skill-before/` 已补齐为 11 个文件（`SKILL.md` + `references/` 5 + `scripts/` 6），pre-M1 脚本从 `.agents/skills/wit-e2e-testing` 旧副本恢复；`skill-before.sha256` 已按 11 个文件重新生成。post-M1 全量快照在 `research/skill-after-m1/`（14 个文件，含 `scripts/self-test`），`skill-after-m1.sha256` 已生成。
- Bash 自测：`run.sh` 14/14 PASS，`SELF-TEST pass=14 fail=0`；覆盖 R1 代理 query 日志、R3 脱敏、R4 字符串/数字/失败/非法 JQ、R5 非 JSON/缺 code/占位符、R2 token 保留/删除/环境变量。
- PS 自测：`run.ps1` 12/12 PASS，`SELF-TEST(PS) pass=12 fail=0`；覆盖 R2–R5，与 Bash 对齐字符串 code、脱敏和 token 所有权。
- 反向验证：把 `api-e2e-lib.sh` 的 fail-closed 响应摘要改回 `resp="$resp"`，并用 fake `jq` 让 `walk` 失败；`run.sh` 输出 `FAIL r3_redaction`、`unexpected match: AT-SECRET`、`SELF-TEST pass=13 fail=1`，证明 R3 能捕获 fail-open。已恢复原文件。
- diff 统计：`m1.diff` 2669 行；`m2.diff` 6800 行（M1→M2 目录/内容差异，含 API 复制与 UI 新增）。`skill-after.sha256` 未单独生成，`skill-after-m1.sha256`、`skill-after-m2.sha256` 已生成。
- M2 结构检查：`check_skill_layout.py --variant A` → `PASS: layout, frontmatter, links and stage vocabulary`；API 有脚本/代理/日志读取器，UI 无 `scripts/`，双方无旧名和阶段词汇混用。
- M2 API 自测：新路径 `wit-api-e2e/scripts/self-test/run.sh` 14/14 PASS；`run.ps1` 12/12 PASS。
- M2 UI smoke：本地静态页 `research/ui-smoke/index.html` + `python -m http.server 8765`；Chrome DevTools MCP 新标签打开，基线 `idle`、点击后 `clicked-1`、Console 出现 `smoke-clicked 1`，截图 `01-baseline.png`/`02-after-click.png`；不存在的选择器返回 `Element uid "missing-target" not found`，归类为选择器/脚本问题。报告在 `research/ui-smoke/report.md`。未连接真实后端/token。
- M2 归档：旧技能已移动到 `C:/Users/yuhaojie/.claude/skills-archive/wit-e2e-testing-2026-11-24/`；`skills/` 下现在是 `wit-api-e2e`、`wit-ui-e2e`。
- `.agents` 同步：旧 `C:/Users/yuhaojie/.agents/skills/wit-e2e-testing`（11-24 15:44 旧版，含 pre-M1 脚本）已归档到 `C:/Users/yuhaojie/.agents/skills-archive/wit-e2e-testing-2026-11-24/`；新 `wit-api-e2e`/`wit-ui-e2e` 已复制到 `C:/Users/yuhaojie/.agents/skills/`，`local-forwarding-proxy.md` 的绝对路径由 `.claude` 改为 `.agents`。`.agents` 结构检查 PASS；`.agents` 版 API 自测 Bash 14/14、PS 12/12。
- 下游引用：`C:/Users/yuhaojie/.claude/skills/wit-trellis-task-delivery/SKILL.md` 与 `C:/Users/yuhaojie/.agents/skills/wit-trellis-task-delivery/SKILL.md` 已把运行条件、核心原则、第 7 节前置检查/7.1/7.2、9.1 报告改为 `wit-api-e2e`/`wit-ui-e2e`；两份都无旧技能名残留。pre-change 副本在 `research/task-delivery-before/{claude,agents}/SKILL.md`，diff 为 `research/task-delivery-{claude,agents}.diff`（各 89 行），sha 为 `research/task-delivery-before.sha256`。该副本是按反向替换重建的逻辑还原，不是改动前落盘备份。
- 遗留/偏差：UI smoke 只验证本地静态页，真实项目页面/登录态/Network/持久化未验证；`.agents` 与 `.claude` 是两份物理副本，后续修改需双写或用同步脚本；M2 未新建 Trellis 任务/子任务。
- 变更总结：`C:/Users/yuhaojie/Desktop/技能修改总结-2026-11-23.md` 已追加“2026-11-24”章节，记录 M1/M2、`.agents` 同步、`wit-trellis-task-delivery` 更新和回滚材料。
- 未做：git 提交/推送、构建、真实后端/token、业务代码修改。
