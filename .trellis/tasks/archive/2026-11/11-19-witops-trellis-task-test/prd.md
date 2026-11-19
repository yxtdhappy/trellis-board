# WitOps 工作台支持 Trellis 任务测试

## Goal

让 `witops-workbench` 把 Trellis 任务作为第一类测试对象，而不是只能作为需求的附属 target：

- 能看到当前项目下所有可测试的 Trellis 任务，包括没有匹配到 WIT Ops 需求的任务。
- 能直接对一个 Trellis 任务发起测试，不要求先有 `requirementId`。
- 能用任务标题、`task.json` 描述和 `prd.md` 生成任务级测试大纲。
- 测试结果按 `taskKey` 归属到任务，同时保留需求级回归的边界。

## Background

当前 `plugins/witops-workbench/index.js` 的测试 target 只从 `item.trellisTasks` 生成；`matchTrellis()` 只把匹配到的任务挂到需求下。`startTest()` 开头要求 `requirementId` 并调用 `summarize()`，独立任务或 worktree 任务没有对应需求时无法发起测试。`outlineContext()` 同样要求 `requirementId`，不能只按任务 PRD 生成大纲。

`plugins/scenario-copilot/index.js` 已经支持 `kind:'trellis'`、`taskKey`、task binding、manifest `taskKeys` 和 task PRD 上下文。本次主要改 workbench 的入口、门禁和上下文组装，不重写 scenario-copilot 的解析算法。

## User Flow

1. 打开工作台，切换到「Trellis 任务」。
2. 选择项目，看到任务、状态、负责人、关联需求、测试大纲来源、最近测试。
3. 点击某任务的「运行测试」：
   - 已有可用大纲 → 直接进入运行弹窗。
   - 无大纲 → 弹窗显示「未关联」，阻止提交，提供「生成测试大纲」。
4. 生成大纲：
   - 任务有需求且需求尚无大纲 → 默认需求级，保存后关联需求，供回归复用。
   - 需求已有大纲 → 任务自动继承，不需要重复生成。
   - 任务无需求 → 只能任务级，保存后只关联当前任务。
5. 保存后自动选中大纲，填写/确认目标地址，开始运行。
6. 任务行显示最近一次运行状态和版本；需求回归仍按需求级大纲预检。

## Requirements

- **R1 任务列表**：新增「Trellis 任务」视图，数据来自 `ctx.tasks.list`，按当前项目过滤；默认不含归档任务，可切换包含归档。
- **R2 直接发起**：`POST /tests` 支持纯 `taskKey`/`subjectKey=trellis:*`，不要求 `requirementId`；任务不存在时明确报错，禁止回退到需求 target。
- **R3 任务上下文**：任务测试对象带 `taskKey`、`requirementId?`、`requirementCode?`、`targetUrl`、`outline`、来源和候选。
- **R4 任务大纲**：生成上下文支持任务标题、状态、负责人、`relativeDir`、`task.json` 描述、`prd.md`；无需求时 `scope` 只能是 `task`。
- **R5 关联规则**：任务有需求时，需求级大纲写 `requirementIds/requirementCodes`；任务级大纲写 `taskKeys`。任务级大纲不进入需求回归。
- **R6 结果归属**：运行记录按 `taskKey` 过滤；任务行显示最近状态/版本；需求行仍显示需求级和关联任务的运行。
- **R7 地址来源**：`task.meta.testUrl` → task binding → 需求 binding → `config.targetUrl`；界面显示来源，只有 config 时标黄。
- **R8 兼容**：现有需求测试、manifest、binding、旧运行记录保持可用；不改变 scenario-copilot CLI。

## Non-goals

- 不做任务批量回归/多任务编排。
- 不在点击「运行测试」时自动生成大纲；生成必须显式触发并允许人工预览。
- 不根据标题相似度推断任务所属需求；只认 `task.meta` 中的显式字段。
- 不改变 worktree 的构建/部署流程，也不把本地代码路径当测试目标 URL。

## Acceptance Criteria

- [x] 无 WIT Ops 需求的 Trellis 任务能在「Trellis 任务」视图中出现并发起测试。
- [x] 纯 `taskKey` 调用 `POST /tests` 能成功进入 `runs.start`；任务不存在时返回明确错误，不使用需求 target。
- [x] 任务无大纲时返回 `needOutline`，面板阻止提交并显示生成入口。
- [x] 任务有 `prd.md` 时能生成任务级大纲，保存后 manifest 的 `taskKeys` 包含该任务。
- [x] 任务有需求且需求无大纲时，默认生成需求级大纲并关联需求；需求已有大纲时任务继承，不重复生成。
- [x] 任务行显示最近运行状态；运行记录按 `taskKey` 查询正确。
- [x] 需求回归只接受需求级大纲；任务级大纲不会被静默用于需求回归。
- [x] 1006px/360px 下新增任务视图和测试弹窗无横向滚动。
- [x] `yarn test:plugins` 通过；新增任务测试用例覆盖 task-only 解析、发起和生成上下文。

说明：`outline-flow.test.js` 覆盖 task-only 解析与任务级保存；task-only 发起由 4403 工作台手工验证（`POST /tests` 创建 runs.start，`noRun` 模式）。

## Risks

- **错误继承**：任务 meta 的需求字段可能缺失或格式不一；只做显式匹配，宁可让用户手动生成任务级大纲。
- **任务过多**：`ctx.tasks.list` 可能返回大量任务；默认排除归档，前端做搜索/限制。
- **地址误用**：worktree 任务可能没有独立测试地址；config 兜底必须显示黄色来源，不能静默。
- **回归污染**：任务级大纲若误标为需求级，会污染回归资产；保存时按 scope 严格写关联字段。
