# Trellis Board 前端迁移：Vue 3 + Vite + TypeScript

状态：**规划中，未改生产代码。**

本目录是 `trellis-board` 前端从原生 HTML/JS 迁移到 Vue 3 SPA 的迁移工作区。它改编自本地工具包：

```text
/opt/app/work/github/qdata/code-migration-kit-with-claude-code
```

## 为什么只保留 00、00b、01、02、06

上游工具包默认面向 **structure-preserving migration**（同架构、同数据结构、换语言），其 `README.md:7-11` 明确说明 redesign 需要改变流程。我们的迁移是：

```text
原生 DOM + 全局 state + 手动 render
  → Vue 组件树 + 响应式状态 + Vite + TypeScript
```

因此不能按“一个源文件翻一个目标文件”的流水线执行。保留和改造如下：

| 上游步骤 | 本项目处理 |
|---|---|
| `00-feasibility` | 保留，目标改为 Vue 3 + Vite + TypeScript SPA |
| `00b-judge-setup` | 保留，裁判改为 Playwright + API 契约测试 |
| `01-dependency-map` | 保留，增加“功能/路由/API 地图”；文件依赖图只作参考 |
| `02-gap-inventory` | 保留，缺口维度改为 DOM/状态/API/团队上下文/SSE |
| `03-stress-test` | **不采用**：redesign 的 bakeoff 无效（上游 `prompts/03-stress-test.md:5-6`） |
| `04-translation-kickoff` | **不采用原版**：文件队列改为 `manifest.tsv` 的纵向切片队列 |
| `05-survey-build` | **不采用原版**：TypeScript 的 typecheck 直接并入每个切片循环 |
| `06-post-parity` | 保留，用于清理 `TODO(vue)` / `PARITY-GAP` / `NEW-BEHAVIOR` 标记 |

## 文件说明

- `PLAN.md`：完整迁移计划、纵向切片、每片验收标准、上线与回退策略。
- `DESIGN.md`：替代上游 RULEBOOK 的设计约束；所有实现者、评审者先读。
- `JUDGE.md`：Playwright parity 测试方案、场景清单、旧实现校验方法。
- `manifest.tsv`：纵向切片队列；`04` 的替代输入。
- `inventory.tsv`：缺口清单模板，`02` 的输出起点。
- `prompts/00-feasibility.md`：迁移可行性报告。
- `prompts/00b-judge-setup.md`：先建裁判，再动代码。
- `prompts/01-dependency-map.md`：文件依赖图 + 功能/API 地图。
- `prompts/02-gap-inventory.md`：DOM/状态/API 缺口盘点。
- `prompts/06-post-parity.md`：对等后的标记清理。

## Claude Code 执行入口

本 worktree 已包含 Claude Code 的迁移脚手架：

- `CLAUDE.md`：执行手册、硬规则、命令边界。
- `.claude/settings.json`：迁移循环的 deny/allow guardrails。
- `.claude/settings.README.md`：每条规则的原因与 gate 时如何调整。
- `.claude/commands/migration-00.md` 等：五个 gate 的 slash command 包装，以及 `/migration-next` 切片入口。
- `.claude/skills/code-migration/SKILL.md`：项目内迁移 skill。
- `migration/scripts/depmap_ts.mjs`：上游依赖图脚本。
- `migration/UPSTREAM.md`：来源、commit、许可证和改编清单。

Claude Code 打开本 worktree 后，先读 `CLAUDE.md`，再按当前 gate 执行 `migration/prompts/` 中对应文件。

## 关联 PRD（不在本 worktree 内）

以下任务 PRD 仍在主工作区，当前是未提交状态，未复制进本分支；Claude 执行对应切片时按绝对路径读取：

```text
/opt/app/work/github/trellis-board/.trellis/tasks/11-05-user-registration/prd.md
/opt/app/work/github/trellis-board/.trellis/tasks/11-05-team-isolation/prd.md
/opt/app/work/github/trellis-board/.trellis/tasks/11-05-client-server-push/prd.md
/opt/app/work/github/trellis-board/.trellis/tasks/11-05-workspace-bootstrap/prd.md
/opt/app/work/github/trellis-board/.trellis/tasks/11-05-desktop-client-package/prd.md
```

不要把这些文件复制成第二份源；需要时直接读主工作区版本。

## 执行顺序（每一步都是人工 gate）

1. **00 可行性**：只读调查，产出报告和 verdict；不改代码。
2. **00b 裁判**：建立并验证 Playwright parity harness；旧应用必须全绿，故意破坏旧应用必须被抓到。
3. **01 地图**：生成 `public/` 的 JS 依赖图、功能地图、入口/API 清单。
4. **02 缺口**：先做 20 行样例，人工确认后再全量盘点。
5. **纵向切片**：按 `manifest.tsv` 顺序执行；每片独立实现、双评审、E2E。
6. **06 收尾**：全部现有流程对等后，清理标记，再删除旧前端。

## 硬约束

- **旧应用保持可运行**：`public/` 在迁移完成前不删除；新应用先挂 `/next`。
- **后端 API 契约不因前端迁移而改变**：需要新增字段时，先改 PRD/API，再改前端。
- **Parity 是行为对等，不是 DOM/像素对等**：同一用户流程、同一权限结果、同一错误语义。
- **新功能不拿旧版 parity 卡住**：SSE、多团队、新用户管理按各自 PRD 验收，标 `NEW-BEHAVIOR`。
- **不引入 CDN、外部字体、`localStorage` 凭证**：沿用现有安全约束。
- **禁止大爆炸重写**：一次只迁移一个纵向切片。

## 当前事实基线

- `public/app.js`：3964 行、160 个函数、59 个事件监听、442 处 `state.` 引用、247 处 `querySelector`、39 处 `innerHTML`。
- `public/admin.js`：951 行；`public/index.html`：687 行、4 个主视图、12 个 `<dialog>`。
- `public/styles.css` + `public/team.css`：约 6000 行。
- 前端调用约 22 个 API；服务端静态托管入口在 `server/index.js:30`、`server/index.js:827`。
- `public/team-client.js`、`public/execution-filter.js`、`public/slug.js`、`public/markdown.js` 是可复用纯逻辑；服务端也引用 `public/slug.js`（`server/actions.js:9`、`server/team/task-writes.js:5`）。
- 现有 `tests/team-web.test.js` 同时包含纯函数测试和源码字符串断言；后者不能作为 parity 裁判。
