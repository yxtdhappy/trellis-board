# Skill split map：wit-e2e-testing → wit-api-e2e + wit-ui-e2e

> 规划产物，用于 M2 拆分时逐段搬运，不替代 `prd.md` / `design.md`。行号以 2026-11-24 的 `SKILL.md`（173 行）为准。

## 1. 拆分原则

1. **按阶段分，不按文件分**：接口阶段用 `wit-api-e2e`，页面阶段用 `wit-ui-e2e`；两个技能都能独立完成本阶段的核心流程。
2. **不复制方法论**：共享的「一次操作 → 一条证据 → 再下结论」「失败先分类」「报告先落盘」在两边各写一份短版，措辞按阶段调整；不抽公共文件，避免跨技能依赖。
3. **不复制工具（推荐方案 A）**：接口库、日志读取器、网关代理只留在 `wit-api-e2e`；UI 技能不复制 737 行代理。UI 阶段需要本地后端/代理时，视为 API 阶段未完成，回到 `wit-api-e2e`。
4. **旧技能退出发现路径**：两个新技能验证通过后，旧 `wit-e2e-testing` 移到 `C:\Users\yuhaojie\.claude\skills-archive\wit-e2e-testing-2026-11-24\`；任务 `research/skill-before/` 保留审计副本。
5. **不新建 Trellis 任务**：M1（修复）和 M2（拆分）是同一任务的两个里程碑，依赖写在本文和 `implement.md`，不靠目录树隐含。

## 2. 目标目录（推荐方案 A：阶段交接）

```text
C:/Users/yuhaojie/.claude/skills/
  wit-api-e2e/
    SKILL.md
    references/
      api-e2e-playbook.md
      local-forwarding-proxy.md
      log-sources.md
      report-template.md          # API 版
    scripts/
      api-e2e-lib.sh
      api-e2e-template.sh
      api-e2e-lib.ps1
      api-e2e-template.ps1
      read-log-delta.ps1
      local-gateway-proxy.mjs
      self-test/
        mock-server.mjs
        run.sh
        run.ps1
  wit-ui-e2e/
    SKILL.md
    references/
      ui-e2e-playbook.md
      report-template.md          # UI 版
```

方案 B（完全自包含）会把 `local-gateway-proxy.mjs`（以及 UI 实际需要的日志读取器）复制到 `wit-ui-e2e/scripts/`；方案 C 会新增 `wit-e2e-common/`。两种变体都只影响第 7 节和 `implement.md` 的 M2 步骤，不影响两个 SKILL.md 的阶段边界。

## 3. 旧内容逐段映射

| 旧位置 | 内容 | 新归属 | 处理 |
| --- | --- | --- | --- |
| `SKILL.md:1-9` | frontmatter | 两边 | 重写 `name`/`description`，描述中写清“不用于什么” |
| `SKILL.md:16-24` 铁律 1、2、4、6、7 | 单步闭环、不预设项目、只读优先、失败分类、报告先落盘 | 两边 | 各写短版；UI 把“日志证据”改为“UI 状态 + Network/Console 证据” |
| `SKILL.md:20` 铁律 3 | 接口 E2E 在本机 | API | 原文迁移 |
| `SKILL.md:22` 铁律 5 | Weareint-Token / token 文件 / 凭据 | API | 原文迁移；UI 只写“复用浏览器会话，凭据不进证据” |
| `SKILL.md:26-35` 前置检查 | 版本、入口、日志、代码绿、迁移/DDL、契约探测、数据、报告 | 两边 | API 保留全部；UI 保留版本、入口、代码绿、数据、报告，新增浏览器/登录态/视口 |
| `SKILL.md:37-45` | 接口 E2E 本地启动 | API | 原文迁移 |
| `SKILL.md:47-60` | 接口执行清单 | API | 原文迁移 |
| `SKILL.md:62-85` | 最小用法（Bash/PS） | API | 原文迁移；token 路径改为临时目录示例 |
| `SKILL.md:87-96` | 本地全链路拓扑 | UI | 迁移并改写；代理启动/配置交给 API 阶段，UI 只保留“浏览器 Network → 代理日志 → 后端日志”三层验证要求 |
| `SKILL.md:98-106` | 单步闭环 | 两边 | API 用日志偏移；UI 用 baseline/after 的 DOM、Network、Console、截图 |
| `SKILL.md:108-127` | 用例设计 / 验证层级 | 两边 | API 保留契约/持久化/副作用；UI 改为 UI 状态/Network/持久化 |
| `SKILL.md:129-137` | 日志判读 | 两边 | API 保留后端日志三类；UI 改为 Network/Console/噪音三类 |
| `SKILL.md:139-143` | 失败处理 | 两边 | 各保留阶段相关项；UI 增加前端缓存、异步等待、选择器漂移 |
| `SKILL.md:145-149` | 测试数据与环境 | 两边 | API 保留多副本/列表上限；UI 保留前缀、清理、缓存 |
| `SKILL.md:151-157` | 收尾 | 两边 | API 保留 token 删除/轮换；UI 保留截图/证据/清理 |
| `SKILL.md:159-171` | 参考列表 | 两边 | 各自只列本技能文件；互相指向只用技能名，不用文件路径 |
| `references/report-template.md` | 混合拓扑 + 页面/接口证据表 | 两边 | 拆成 API 版与 UI 版；共享禁忌条款各写一份 |
| `references/api-e2e-playbook.md` | 接口门禁/矩阵/坑 | API | 原文迁移；检查是否引用了 UI 拓扑，若有则删除 |
| `references/local-forwarding-proxy.md` | 代理用法/配置/排障 | API | 原文迁移 |
| `references/log-sources.md` | 本地/Pod 日志 | API | 原文迁移；UI 不复制 |
| `scripts/api-e2e-*` | 接口库/模板 | API | 原文迁移 |
| `scripts/read-log-delta.ps1` | 本地日志偏移 | API | 原文迁移；UI 不复制 |
| `scripts/local-gateway-proxy.mjs` | 本地网关代理 | API | 原文迁移；方案 B 才复制到 UI |
| `scripts/self-test/*` | M1 自测 | API | 原文迁移；路径用 `$(dirname "$0")/../..`，不写死旧目录 |

## 4. `wit-api-e2e/SKILL.md` 结构

1. frontmatter：`name: wit-api-e2e`；description 覆盖“接口/API E2E、本机后端、真实鉴权/落库、日志证据、代理、Bash/PS 库”，末尾写“不用于浏览器页面/UI 流程，页面 E2E 用 `wit-ui-e2e`”。
2. 标题 + 运行环境（PowerShell 7；Pod 日志按 `wit-rancher-pod-shell`）。
3. 铁律：单步闭环、不预设项目、接口 E2E 在本机、只读优先、凭据规则、失败分类、报告先落盘、阶段边界。
4. 0. 阶段边界：API-only → 本技能；UI/页面 → `wit-ui-e2e`；UI 需要本地后端/代理 → 先在本技能完成环境搭建；接口契约未验证 → 不要进入 UI 阶段。
5. 1. 前置检查 + 1.1 本地启动 + 1.2 执行清单 + 1.3 最小用法（迁移原文）。
6. 2. 单步闭环（日志偏移版）。
7. 3. 用例设计与验证层级（契约/持久化/副作用）。
8. 4. 日志判读；5. 失败处理；6. 测试数据与环境；7. 收尾（报告、清理、token 删除/轮换）。
9. 参考：playbook、log-sources、local-forwarding-proxy、API report-template、scripts。
10. 末尾“UI 阶段交接”：接口契约已验证时，把 base URL、测试账号、测试数据前缀交给 `wit-ui-e2e`。

## 5. `wit-ui-e2e/SKILL.md` 结构

1. frontmatter：`name: wit-ui-e2e`；description 覆盖“浏览器页面 E2E、真实操作、Network/Console/截图证据、前后端联调、Chrome DevTools MCP”，末尾写“不用于纯接口/API E2E，接口 E2E 用 `wit-api-e2e`”。
2. 标题 + 运行环境（Chrome DevTools MCP；复用当前浏览器会话；PowerShell 7 仅用于可选的本地命令）。
3. 铁律：一次操作 → UI 状态 + Network/Console 证据 → 结论；不预设项目；只读优先；失败分类；报告先落盘；截图正常不算通过；阶段边界。
4. 0. 阶段边界：UI/页面 → 本技能；API-only → `wit-api-e2e`；接口契约未验证 → 先走 API 阶段；需要本地后端/代理 → 先走 API 阶段（本技能不复制代理）。
5. 1. 前置检查：前端/后端最新代码分别在哪运行（三种场景）；浏览器可用、已有登录态/测试账号；页面 URL、视口、浏览器版本；接口就绪；测试数据前缀/清理；报告路径；前端构建/类型检查（如适用）。
6. 1.1 本地全链路拓扑（迁移并改写）：复用环境前端 + 本地后端；本地前端 + 本地后端 + 最小代理（代理属于 API 阶段）；只把被测服务前缀路由到本地；健康检查 + 三层证据。
7. 2. 单步闭环：baseline（URL/视口/DOM/Console/截图）→ 一次操作 → after（DOM/截图/Network/Console）→ 判定 → 记一行。
8. 3. 用例设计：正向/反向/回归/对照；UI 状态断言、Network 断言、刷新/读回验证持久化；不能只凭截图。
9. 4. 证据判读：UI 状态、Network、Console、可选后端日志、噪音。
10. 5. 失败处理：前端缺陷/后端缺陷/环境或代理/缓存；同一路径复测。
11. 6. 测试数据与环境：前缀、清理、列表条数上限、缓存。
12. 7. 收尾：报告、截图/证据保留、清理、凭据检查；把后端契约问题交回 `wit-api-e2e`。
13. 参考：`ui-e2e-playbook.md`、UI report-template；需要本地后端/代理/后端日志时，回到 `wit-api-e2e`。

## 6. 共享规则（两边各写短版，不抽公共文件）

- 一次操作只验证一个点；不连点多个再一起看。
- 不预设项目：服务名、路径、路由、账号、数据都先求证。
- 只读优先；写操作/建表/改数据先取得授权。
- 失败先分类：脚手架/环境 vs 被测代码；修正测试方法后重跑同一步。
- 报告先落盘；未落盘不得宣布完成。
- 证据不含 token、密码、Cookie、完整连接串；UI 证据还要注意请求体/响应体脱敏。

## 7. 迁移顺序（M2）

1. 确认 M1 两个自测通过；生成 `research/skill-after-m1/` 快照和 `m1.diff`。
2. 复制 post-M1 技能目录为 `wit-api-e2e`；重写 `SKILL.md`（删 UI 段），重写 API report-template，保留全部脚本。
3. 新建 `wit-ui-e2e`；写 `SKILL.md`、`ui-e2e-playbook.md`、UI report-template；不复制 API 脚本（方案 A）。
4. 结构检查：frontmatter、相对链接、旧名残留、脚本归属、阶段边界。
5. 在 `wit-api-e2e` 新路径跑 Bash/PS 自测；在 `wit-ui-e2e` 跑手工 smoke。
6. 两者通过后，归档旧技能到 `skills-archive`；生成最终快照/清单/diff。
7. 更新 `implement.jsonl`/`check.jsonl` 到新路径；`task.py validate`。

## 8. 验证清单

- [ ] 两个目录各有 `SKILL.md`，frontmatter `name` 与目录名一致，description 非空且写明“不用于”。
- [ ] `wit-api-e2e` 有全部 API references/scripts；`wit-ui-e2e` 没有 `api-e2e-lib*`、`local-gateway-proxy.mjs`、`read-log-delta.ps1`（方案 A）。
- [ ] `wit-api-e2e/SKILL.md` 不含浏览器操作流程（只允许一句指向 `wit-ui-e2e`）；`wit-ui-e2e/SKILL.md` 不含 curl/token/API 库流程（只允许阶段交接）。
- [ ] 两个 SKILL.md 的相对链接都能解析；`grep -R 'wit-e2e-testing'` 在两个新目录为 0。
- [ ] API 自测在新路径 `bash scripts/self-test/run.sh` / `pwsh -File scripts/self-test/run.ps1` 退出 0。
- [ ] UI 手工 smoke：本地页面 → 打开 → 点击 → DOM/Network/Console/截图证据齐全；故意点不存在的选择器，能被分类为测试脚本/选择器问题，而不是产品缺陷。
- [ ] 旧 `wit-e2e-testing` 不在 `~/.claude/skills` 下；归档目录可读；任务 `research/skill-before/` 可恢复。
- [ ] `task.py validate` 通过；无仓库业务代码改动；未提交。

## 9. 待确认（只阻塞第一个）

1. **UI 技能的独立性边界**：A 阶段交接（推荐）/ B 完全自包含（复制代理）/ C 共享 `wit-e2e-common`。
2. 旧技能归档到 `skills-archive`（推荐）还是保留为 `SKILL.md.deprecated`。
3. 技能名 `wit-api-e2e` / `wit-ui-e2e` 是否接受。
4. UI 自测用“结构检查 + 手工 smoke”（推荐）还是引入 Playwright。
5. 共享铁律/失败分类两边各写短版（推荐）还是抽公共文件。

第 2–5 项已有推荐，不阻塞；第 1 项会改变目录和 M2 步骤，需先确认。
