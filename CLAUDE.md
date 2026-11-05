# Claude Code 迁移执行手册

本仓库是 `trellis-board` 的隔离 worktree，只用于前端迁移：原生 HTML/JS → Vue 3 + Vite + TypeScript。  
在这里执行的任何实现都必须遵守本文件；它与仓库根目录的 `AGENTS.md`、`.trellis/workflow.md` 同时生效。

## 0. 先读什么

按顺序读：

1. `AGENTS.md`、`.trellis/workflow.md`：项目通用规则与 Trellis 流程。
2. `migration/README.md`：本次迁移的来源、取舍和执行顺序。
3. `migration/PLAN.md`：纵向切片、目标结构、DoD、上线/回退。
4. `migration/DESIGN.md`：替代上游 RULEBOOK 的设计约束。**实现前必读。**
5. `migration/JUDGE.md`：Playwright parity 方案。**没有 judge 不准写业务切片。**
6. `migration/prompts/`：当前阶段要执行的提示词。

不要一次加载整个 `migration/`；按当前 gate 读对应文件。

## 1. 迁移姿态

- 这是 **redesign migration**，不是 structure-preserving 语言移植。
- 旧应用是**现有行为**的 executable spec，不是 DOM/CSS 规范。
- 迁移单位是 `migration/manifest.tsv` 的**纵向切片**，不是单个文件。
- 上游工具包的 `03-stress-test`、`04-translation-kickoff`、`05-survey-build` **不适用于本仓库**；不要按文件队列翻译。
- 旧应用在全部 parity 通过前保持可运行；新应用先挂 `/next`。

## 2. 绝对不能做

1. **不要大爆炸重写**：一次只做一个 slice。
2. **不要删除 `public/` 旧前端**，直到 `06-post-parity` 完成并人工签字。
3. **不要改后端 API 契约**来迁就前端；需要新字段时，先写 PRD/API 变更。
4. **不要修改 `migration/DESIGN.md`、`migration/PLAN.md`、`migration/JUDGE.md`**；发现规则缺失，写 `migration/reports/amendments.md`，等人工在 gate 上批准。
5. **不要改旧应用的行为**。旧应用只允许两类改动：
   - 为 parity 测试增加稳定的 `data-testid`（单独提交）；
   - 修复阻塞测试的环境/严重 bug（记录到 deviation log）。
6. **不要在一个切片里顺手做视觉改版**。
7. **不要用 `localStorage` / `sessionStorage` 存 token**。
8. **不要引入 CDN、外部字体、外链脚本**。
9. **不要执行 mutating git 命令**：`commit`、`push`、`reset`、`checkout`、`switch`、`rebase`、`stash`、`merge`、`clean` 都由人工执行。
10. **不要为了通过 typecheck 使用 `any` 或 `@ts-ignore`**；确实无法建模时标 `TODO(vue):` 并说明。

## 3. 当前队列

`migration/manifest.tsv` 是唯一队列。每行一个纵向切片：

```text
id  title  old_surface  new_surface  depends_on  parity  acceptance  status
```

规则：

- `status` 只能是 `planned` / `in_progress` / `blocked` / `done`。
- 开始一个切片前，把状态改为 `in_progress`；完成并过 gate 后改为 `done`。
- 不允许同时有两个 `in_progress` 切片。
- 切片顺序以 `depends_on` 为准；不要跳过基础切片。
- 每个切片完成后，在 `migration/reports/slices/<id>.md` 写：改了什么、跑了什么、parity 计数、未覆盖项。

## 4. 每个切片的执行流程

1. **读范围**：`manifest.tsv` 当前行 + `PLAN.md` 对应小节 + `DESIGN.md`。
2. **实现**：只改该切片范围；复用 `public/team-client.js` 等纯逻辑。
3. **自测**：
   - `npm --prefix frontend run typecheck`
   - `npm --prefix frontend run build`
   - `npm --prefix frontend run test:unit`
   - 对应 Playwright（如果本地已配置）
4. **双评审**：另开两个独立 reviewer 上下文，只读，假设实现是错的；每条 finding 必须引用规则或源码行。
5. **修复**：只应用 confirmed finding；不能修就标 `TODO(vue):`。
6. **Gate**：把证据写到 `migration/reports/slices/<id>.md`，停下等人工确认。

## 5. 测试与裁判

- `migration/JUDGE.md` 是裁判规范。
- 现有 `tests/team-web.test.js` 的源码字符串断言**不是** judge；不要把它当作迁移完成的证据。
- 纯函数测试可以复用：`team-client.js`、`execution-filter.js`、`slug.js`、`markdown.js`。
- 每个切片至少一条 Playwright 用户流程。
- 新功能（SSE、多团队、新用户管理、密码 6 位）标 `NEW-BEHAVIOR:`，单独验收，不混入旧版 parity 计数。
- 旧版 parity 只比较行为/API/权限/错误，不比较 DOM 结构和像素。

## 6. 代码与文件规则

- 目标目录：`frontend/`；构建产物 `frontend/dist/`。
- 路由、store、API、feature 结构见 `migration/PLAN.md` §3。
- 纯逻辑放 `frontend/src/shared/` 或直接 re-export `public/*.js`；不要重写业务规则。
- 组件：`<script setup lang="ts">`；页面只编排，展示组件用 props/emits。
- 弹窗：统一包装原生 `<dialog>`，保留焦点管理和 Esc。
- CSS：沿用现有 class/CSS 变量；新组件 scoped；不并行换样式体系。
- API：保留 `credentials: same-origin`、`cache: no-store`、`ApiError`、401 跳转、ETag、幂等键。
- 团队切换：必须执行 `PLAN.md` §4.2 的 7 步协议。
- SSE：连接生命周期放 `api/events.ts` + `stores/team.ts`，不要放页面组件。

## 7. 允许的命令

在 `.claude/settings.json` 的 guardrails 内，优先使用：

```bash
npm --prefix frontend run typecheck
npm --prefix frontend run build
npm --prefix frontend run test:unit
node migration/scripts/depmap_ts.mjs --root public --out migration/depmap
git status
git diff
git log
rg
```

完整 E2E、启动服务、安装依赖、Git 提交由人工或 orchestrator 在 gate 上执行。  
如果命令被 deny 规则拦截，不要绕过；报告需要什么，由人工在 gate 上调整 settings。

## 8. 状态与报告

| 产物 | 路径 |
|---|---|
| 切片队列 | `migration/manifest.tsv` |
| 缺口清单 | `migration/inventory.tsv` |
| 可行性报告 | `migration/reports/00-feasibility.md` |
| Judge 报告 | `migration/reports/00b-judge.md` |
| 依赖图 | `migration/depmap/` |
| 切片报告 | `migration/reports/slices/<id>.md` |
| 规则修订申请 | `migration/reports/amendments.md` |
| 最终 parity | `migration/reports/06-parity.md` |

报告用事实和计数，不用“已完成”这种叙述。失败、跳过、未覆盖都要写清楚。

## 9. Gate 行为

- 每个 prompt/切片结束都是 gate：**停下，展示证据，等人工确认**。
- 不要根据“看起来没问题”自行进入下一步。
- 被阻塞时报告：缺什么、卡在哪、需要谁决定；不要猜 API 或产品规则。
- 发现规则冲突：写 amendment，不要自行改 `DESIGN.md`。

## 10. 与 Trellis 的关系

- 这是实现工作区；Trellis 任务/PRD 仍在主工作区 `.trellis/tasks/` 维护。
- 如果当前切片依赖某个 Trellis 任务（如 `11-05-team-isolation`），先确认主工作区对应 PRD 已确认。
- 在本 worktree 中不要创建/启动新的 Trellis 任务，除非人工明确要求。
