# 00 — 可行性报告

> 改编自 Claude Code Migration Kit `prompts/00-feasibility.md`（commit `cf91c9d`）。  
> 本项目的目标不是“换语言”，而是 **原生前端 → Vue 3 + Vite + TypeScript SPA** 的 redesign。上游原版把“structure-preserving 还是 redesign”作为第一判断；本项目已经确定是 redesign，但仍需用本步骤确认边界、裁判和退出条件。

**When:** 第一个 gate，任何实现之前。  
**Mode:** 对仓库只读；唯一允许的写入是 `migration/reports/00-feasibility.md`（以及可选的 cost log）。  
**Placeholders:** 无。

---

## 任务

读以下文件：

- `migration/README.md`
- `migration/PLAN.md`
- `migration/DESIGN.md`
- `migration/JUDGE.md`
- 仓库根目录 `AGENTS.md`、`.trellis/workflow.md`
- `public/` 前端源码、`tests/`、`package.json`

产出一份报告，不要写代码、不要改 `public/`。

报告必须包含以下部分。

## 1. 六步索引

用一行一步复述本项目的执行顺序：

1. 00 可行性
2. 00b 裁判
3. 01 依赖图 + 功能地图
4. 02 缺口清单
5. 纵向切片实现（替代上游 03/04/05）
6. 06 Post-parity 收尾

## 2. 离开原生前端的理由

只写本仓库的事实，不写“Vue 更现代”这类泛泛理由。至少覆盖：

- `public/app.js` 的规模、函数数、事件监听、`state.` 引用、`querySelector`、`innerHTML`。
- `public/admin.js`、`public/index.html` 的规模、视图/dialog 数量。
- 多团队切换、SSE、用户管理、Tauri 对前端状态/路由/事件层的要求。
- 现有测试对 UI 行为的覆盖缺口。

每条事实带文件路径或命令计数。

## 3. 三个必须做出的判断

每个判断必须以“结论 + 证据 + 影响”结尾。

### 3.1 Redesign 还是 structure-preserving？

- 结论应为 redesign。
- 说明为什么不能按文件 1:1 翻译。
- 列出至少 3 个“一个源文件会拆成多个 Vue 文件”的例子。
- 说明上游 `03-stress-test` 的 bakeoff 为什么不适用。

### 3.2 验证成本与裁判形态

- 当前没有前端构建；没有浏览器 E2E。
- 说明为什么 `vue-tsc` 不够。
- 说明为什么现有 `tests/team-web.test.js` 的源码字符串断言不能当 judge。
- 给出 Playwright parity + API 契约测试的裁判形态。
- 引用 `migration/JUDGE.md` 的场景分层。

### 3.3 现有测试哪些能活下来？

分类并计数：

- **portable**：通过公共接口/纯函数验证，能带到新前端。
- **internal-bound**：依赖 `public/app.js` 源码结构、DOM 字符串、旧文件路径，迁移时死亡。
- **service-side**：属于后端，不随前端迁移，但可作为 API 契约基础。

每类给至少 3 个例子（文件 + 测试名/行为）。

## 4. 六步在本仓库的具体化

对每一步写：

- 输入
- 产物路径
- gate 条件
- 谁执行（agent / human / orchestrator）
- 如果跳过会怎样

必须明确：`03/04/05` 原版不采用；`04` 的替代是 `migration/manifest.tsv` 纵向切片队列。

## 5. 风险与未知

至少列出：

- 旧应用冻结与双轨维护
- 团队切换脏数据
- SSE 与轮询冲突
- Tauri 加载/CSP/capability
- 旧测试源码断言
- CSS 6000 行
- 后端 API 契约漂移

每条给“影响 + 缓解”。

## 6. Verdict

三选一：

- `go`：可以按本计划迁移
- `later`：先补某个前置条件
- `don't`：不建议迁移

无论哪个 verdict，都写：

- 改变 verdict 的**一个事实**
- 如何在一天内验证这个事实
- 当前最不确定的 3 个点

## 7. 输出

写入：

```text
migration/reports/00-feasibility.md
```

格式：

```markdown
# 00 Feasibility Report

## Verdict
...

## Facts
...

## Three Calls
...

## Six Steps
...

## Risks
...

## Open Questions
...
```

然后**停下**，展示 verdict、关键计数、未决问题。不要进入 00b，不要改代码。
