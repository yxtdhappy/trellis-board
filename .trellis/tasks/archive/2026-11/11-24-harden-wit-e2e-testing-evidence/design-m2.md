## 9. M2：UI / API 技能拆分

### 9.1 目标与依赖

- M2 只在 M1 的 Bash/PS 自测都退出 0 后开始；M1 失败不得拆分，先修 M1。
- 拆分后旧 `wit-e2e-testing` 不再位于 `~/.claude/skills`，两个新技能独立加载。
- 本任务只有一个 Trellis 任务；M2 是里程碑，不新建子任务。M2 的前置条件写在本文和 `implement.md`，不靠目录树隐含。
- 内容映射以 `research/skill-split-map.md` 为准；本节的目录和验证是它的可执行版本。

### 9.2 目录结构（方案 A：阶段交接）

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
C:/Users/yuhaojie/.claude/skills-archive/
  wit-e2e-testing-2026-11-24/     # 旧技能归档，不在 skills 发现路径
```

方案 B/C 只改变代理/日志工具的归属，不改变两个 SKILL.md 的阶段边界；见 9.9。

### 9.3 内容归属

| 内容 | 归属 | 处理 |
| --- | --- | --- |
| 单步闭环、不预设项目、只读优先、失败分类、报告先落盘 | 两边 | 各写短版，UI 把“日志证据”换成“UI 状态 + Network/Console 证据” |
| 接口本机启动、契约探测、迁移/DDL、token/Weareint-Token、日志源、API 库/模板/代理 | API | 原文迁移 |
| 浏览器操作、页面状态、Network/Console、截图、前端缓存、前后端版本检查 | UI | 迁移并补 playbook |
| 本地全链路拓扑 | UI | 迁移；代理启动/配置交给 API 阶段，UI 只保留三层验证要求 |
| 报告模板 | 两边 | API 版删页面行；UI 版删接口库/日志偏移行 |
| `api-e2e-playbook.md` / `local-forwarding-proxy.md` / `log-sources.md` / `api-e2e-*` / `read-log-delta.ps1` | API | 原文迁移，检查是否误引 UI 段 |
| `local-gateway-proxy.mjs` | API（方案 A） | 原文迁移；UI 需要时回到 API 阶段 |

### 9.4 `wit-api-e2e` 的 SKILL.md

- frontmatter：`name: wit-api-e2e`；description 覆盖“接口/API E2E、本机后端、真实 HTTP/鉴权/落库、日志增量、代理、Bash/PS 用例库”，末尾写“不用于浏览器页面/UI 流程，页面 E2E 用 `wit-ui-e2e`”。
- 保留旧 `SKILL.md` 的：铁律 1、2、3、4、5、6、7；前置检查（版本、入口、日志、代码绿、迁移/DDL、契约、数据、报告）；接口本地启动；接口执行清单；最小用法；单步闭环（日志偏移版）；用例设计/验证层级；日志判读；失败处理；测试数据/环境；收尾（token）。
- 删除旧的：`SKILL.md:87-96` 本地全链路拓扑、UI 页面/浏览器相关内容、UI 报告字段。
- 新增“0. 阶段边界”表：

  | 任务 | 用什么 |
  | --- | --- |
  | 只验证接口、本机后端、落库/副作用 | 本技能 |
  | 浏览器页面流程、点击/填表/截图 | `wit-ui-e2e` |
  | UI 需要本地后端/代理/日志 | 本技能先搭链路，再交给 `wit-ui-e2e` |
  | 接口契约未验证 | 本技能先验证，不进入 UI 阶段 |

- 末尾“UI 阶段交接”：接口契约已验证时，把 base URL、测试账号、测试数据前缀、已知限制交给 `wit-ui-e2e`；不复制 UI 流程。
- `references/report-template.md` 改为 API 版：拓扑只含后端、代理、DB；证据表列为“请求 / 响应 / 后端日志 / 验证层级 / 结论”；删除页面、前端 dev proxy、截图列。

### 9.5 `wit-ui-e2e` 的 SKILL.md 与 playbook

`SKILL.md` 结构：

1. frontmatter：`name: wit-ui-e2e`；description 覆盖“浏览器页面 E2E、真实操作、DOM/Network/Console/截图证据、前后端联调、Chrome DevTools MCP”，末尾写“不用于纯接口/API E2E，接口 E2E 用 `wit-api-e2e`”。
2. 铁律：一次操作 → UI 状态 + Network/Console 证据 → 结论；不预设项目；只读优先；失败分类；报告先落盘；截图正常不算通过；阶段边界。
3. 0. 阶段边界（与 API 技能镜像）：UI/页面 → 本技能；API-only → `wit-api-e2e`；接口契约未验证 → 先走 API 阶段；需要本地后端/代理 → 先走 API 阶段（方案 A 不复制代理）。
4. 1. 前置检查：前端/后端最新代码分别在哪运行（三种场景）；浏览器可用、登录态/测试账号；页面 URL、视口、浏览器版本；接口就绪；测试数据前缀/清理；报告路径；前端构建/类型检查（如适用）。
5. 1.1 本地全链路拓扑：复用环境前端 + 本地后端；本地前端 + 本地后端 + 最小代理（代理属于 API 阶段）；只把被测服务前缀路由到本地；健康检查 + “浏览器 Network → 代理日志 → 后端日志”三层证据。
6. 2. 单步闭环：baseline（URL/视口/DOM/Console/截图）→ 一次操作 → after（DOM/截图/Network/Console）→ 判定 → 记一行。
7. 3. 用例设计：正向/反向/回归/对照；UI 状态断言、Network 断言、刷新/读回验证持久化；不能只凭截图。
8. 4. 证据判读：UI 状态、Network、Console、可选后端日志、噪音。
9. 5. 失败处理：前端缺陷/后端缺陷/环境或代理/缓存/选择器漂移；同一路径复测。
10. 6. 测试数据与环境；7. 收尾；参考只列 UI playbook、UI report-template，以及“需要本地后端/代理/后端日志时回到 `wit-api-e2e`”一句。

`references/ui-e2e-playbook.md` 内容：

- 浏览器入口：Chrome DevTools MCP，复用当前浏览器窗口/登录态；新标签页、导航、快照/DOM、点击/填表、Network、Console、截图。
- 三种运行场景（与用户全局规则一致）：
  1. 只改后端：环境前端 + 本地后端；先确认转发生效。
  2. 前后端都改且未发布：本地前端 + 本地后端；API 阶段先用代理把前端请求转到本地后端，UI 阶段只验证页面。
  3. 前后端都已部署：直接测环境；本地不起服务。
- 证据格式：URL、视口、浏览器版本、时间戳、操作、before/after DOM 或截图、Network（method/path/status/关键响应字段，脱敏）、Console error、后端日志（可选）。
- 断言：可见性/文本/数量/状态、Network 状态与关键字段、Console 无未预期错误、刷新/读回验证持久化；截图只能作为辅助。
- 常见坑：缓存、异步等待、选择器漂移、iframe/shadow DOM、文件上传/下载、登录过期、Console 噪音、视口/响应式、i18n。
- 失败分类：前端产品缺陷、后端缺陷（交回 API 技能）、环境/代理、测试脚本/选择器、缓存。
- 退出标准：每个验收点有 UI 状态 + Network/Console 证据；未验证项如实列出。

`references/report-template.md`（UI 版）：

- 0 拓扑：页面 URL、前端 dev server、前端 dev proxy、本地网关代理（如有）、后端；API-only 不适用。
- 1 证据表：`# / 页面操作 / 期望 UI 状态 / 实际 UI 状态 / Network / Console / 截图 / 验证层级 / 结论`。
- 2 结论（通过/未通过/噪音）；2.1 未验证项（如未测移动端/未测 Safari）；3 清理记录；4 验收清单回写；5 禁忌（截图正常不算通过、未执行不算通过、凭据不进证据、先落报告再清理）。

### 9.6 共享规则与漂移控制

- 两边各写一份短版“铁律/失败分类/报告先落盘”，不抽公共文件，避免跨技能路径依赖。
- `research/skill-split-map.md` 是内容映射的 source of truth；check 阶段逐段核对，确认旧 `SKILL.md` 的每个 section 都有新归属，没有丢失。
- 结构检查只验证关键标题存在（铁律、阶段边界、单步闭环、失败处理、收尾），不要求逐字一致；避免为了“完全一致”引入生成脚本。

### 9.7 迁移与归档

1. M1 完成后生成 `research/skill-after-m1/` 和 `m1.diff`；这是 M2 的输入，不是旧技能。
2. 复制 post-M1 目录为 `wit-api-e2e`；重写 `SKILL.md`（删 UI 段）、重写 API report-template；脚本原样保留，`self-test` 的相对路径不变。
3. 从零创建 `wit-ui-e2e`：`SKILL.md`、`ui-e2e-playbook.md`、UI report-template；方案 A 不复制任何脚本。
4. 两个新技能验证通过前，旧 `wit-e2e-testing` 保持原位，方便对照和回滚。
5. 验证通过后：`mkdir -p C:/Users/yuhaojie/.claude/skills-archive`；`mv` 旧目录到 `.../wit-e2e-testing-2026-11-24`；目标已存在时停止，不覆盖。
6. 归档后确认 `~/.claude/skills` 下只有两个新技能；新技能在下次会话加载，当前会话可能仍显示旧技能，需在报告中说明。
7. 回滚：归档前失败 → 删除两个新目录，旧技能未动；归档后失败 → 把归档目录 `mv` 回 `~/.claude/skills/wit-e2e-testing`，再删除新目录。

### 9.8 验证

结构检查用 `research/check_skill_layout.py`（任务产物，Python 标准库）：

- 两个目录存在；`SKILL.md` 第一行 `---`；frontmatter 的 `name` 与目录名一致；`description` 非空且包含“不用于”。
- 预期文件集合：API 有全部 references/scripts；UI 有 `SKILL.md`、两个 references，方案 A 下 `scripts/` 不存在或为空。
- Markdown 相对链接（`](path)`）解析后存在；忽略 `http(s)://`、`#`。
- 两个新技能内 `wit-e2e-testing` 出现次数为 0。
- API 技能内 `Chrome DevTools|mcp__chrome|页面操作|点击按钮` 为 0（允许“UI 阶段”一句）；UI 技能内 `api-e2e-lib|local-gateway-proxy|read-log-delta|Weareint-Token|e2e_init|curl -H` 为 0（允许 `wit-api-e2e` 一句）。
- 失败时打印文件:行，退出非零。

API 自测：

```bash
bash "$API_SKILL/scripts/self-test/run.sh"
pwsh -NoProfile -File "$API_SKILL/scripts/self-test/run.ps1"
```

UI 手工 smoke（记录到 `implement.md`）：

1. 用本地静态页或 `file://` 页面，含一个按钮、点击后改文本并 `console.log`。
2. Chrome DevTools MCP 新标签打开，记录 URL/视口/截图/DOM/Console。
3. 点击按钮，断言文本变化，记录 Network/Console/截图。
4. 故意点击不存在的选择器，确认被归类为测试脚本/选择器问题，而不是产品缺陷。
5. 记录“通过/未验证”，不得只写“页面正常”。

任务校验：`python ./.trellis/scripts/task.py validate harden-wit-e2e-testing-evidence`。

### 9.9 方案 B / C 的差异

| 方案 | UI 技能脚本 | 代理/日志读取器 | 优点 | 代价 |
| --- | --- | --- | --- | --- |
| A（已确认，2026-11-24） | 无 | 只在 API | 边界清楚、不重复 | UI 阶段不能独立搭本地链路 |
| B | 复制 `local-gateway-proxy.mjs`（和实际需要的日志读取器） | API + UI 各一份 | UI 完全自包含 | 两份维护、两套自测、容易漂移 |
| C | 无（引用共享目录） | `wit-e2e-common/` 一份 | 单一实现 | 多一个非技能目录，两个技能都依赖它 |

方案 B 需要在 M2 增加：复制代理/日志读取器、UI 代理自测、两份文件的 SHA-256 一致性检查；方案 C 需要把 `local-gateway-proxy.mjs` 和 `read-log-delta.ps1` 移到 `wit-e2e-common/`，两个 SKILL.md 的脚本路径改成绝对/相对共享路径，结构检查增加共享目录存在性。方案 A 不涉及这些。

### 9.10 M2 实施顺序与回滚点

1. M2.0：确认 M1 自测通过；生成 `skill-after-m1` + `m1.diff`。
2. M2.1：创建 `wit-api-e2e`，重写 SKILL.md/API report-template，迁移脚本。
3. M2.2：创建 `wit-ui-e2e`，写 SKILL.md/playbook/report-template。
4. M2.3：跑结构检查；修链接/归属/旧名。
5. M2.4：在 API 新路径跑 Bash/PS 自测。
6. M2.5：跑 UI 手工 smoke，记录结果。
7. M2.6：归档旧技能；生成 `skill-after-m2`、`m2.diff`、SHA-256。
8. M2.7：更新 jsonl 路径；`task.py validate`；检查无仓库业务代码改动。

回滚点：M2.1/M2.2 失败 → 删除新目录，旧技能未动；M2.6 前失败 → 旧技能仍在；M2.6 后失败 → 从归档 `mv` 回旧目录，再删除新目录。

### 9.11 `.agents` 镜像同步

`.claude/skills` 与 `.agents/skills` 是两棵独立物理目录，不是符号链接；只改 `.claude` 会让 Codex/其他 agent 继续使用旧技能。M2 追加一步：

1. 归档旧 `.agents/skills/wit-e2e-testing` 到 `C:/Users/yuhaojie/.agents/skills-archive/wit-e2e-testing-2026-11-24/`。
2. 复制最终 `wit-api-e2e`/`wit-ui-e2e` 到 `C:/Users/yuhaojie/.agents/skills/`。
3. 将 `.agents` 版 `references/local-forwarding-proxy.md` 中的 `.claude` 绝对路径替换为 `.agents`；其他文件相对路径无需改。
4. 对 `.agents` 两技能跑 `check_skill_layout.py --variant A`；在 `.agents` 路径跑 API 的 Bash/PS 自测。
5. 用 `diff -rq` 确认 `.agents` 与 `.claude` 只差 `local-forwarding-proxy.md` 的根路径，其余一致。

回滚：删除 `.agents/skills/wit-api-e2e`/`wit-ui-e2e`，把 `.agents/skills-archive/.../wit-e2e-testing-2026-11-24` `mv` 回 `.agents/skills/wit-e2e-testing`。

### 9.12 下游技能引用同步

`wit-trellis-task-delivery` 是唯一引用旧 E2E 技能的下游技能，`.claude` 与 `.agents` 各一份，内容有平台差异，不能整文件互相覆盖。只改共享的 E2E 章节：

1. 运行条件：接口用 `wit-api-e2e`，页面用 `wit-ui-e2e`。
2. 核心原则：真实 E2E 按阶段使用两个技能。
3. 第 7 节前置检查：接口/UI 分列，增加阶段顺序（接口契约未验证先走接口；UI 需要本地后端/代理先走接口）。
4. 7.1 单步闭环：接口阶段记录日志偏移/响应/DB；页面阶段记录基线/操作后快照/Network/Console/截图。
5. 7.2 用例覆盖末段：分别点名两个技能。
6. 9.1 报告：接口证据与 UI 证据分节，或分别写 `e2e-api-report.md` / `e2e-ui-report.md`。
7. 删除旧技能名（包括“不要再用”的提示也改成“旧版混合 E2E 技能”），避免 grep 残留。
8. 两份副本各跑 `grep -n 'wit-e2e-testing'` 应为空；平台差异保留，不整文件同步。

本次改动前没有为 `wit-trellis-task-delivery` 单独落盘备份；为可审查，按反向替换重建了 pre-change 副本 `research/task-delivery-before/{claude,agents}/SKILL.md`，并生成 `task-delivery-{claude,agents}.diff` 与 sha256。该副本是逻辑还原，不是原始时间点备份。
