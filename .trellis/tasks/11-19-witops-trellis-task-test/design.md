# 设计：WitOps 工作台支持 Trellis 任务测试

## 1. 边界

只改：

- `plugins/witops-workbench/index.js`：任务列表、任务 target、task-first `startTest`、task-only `outlineContext`。
- `plugins/witops-workbench/panel/{index.html,app.js,app.css}`：任务视图、任务测试入口、生成弹窗适配。
- `plugins/witops-workbench/README.md`。
- `plugins/scenario-copilot/index.js`：仅在任务级解析/生成字段有缺口时做最小补齐。
- 测试：优先 `plugins/scenario-copilot/test/outline-flow.test.js`；workbench 新增最小 L3 或可测试的纯函数。

不改：

- scenario-copilot CLI 源码（`tmp/project/mom-cli/**`）。
- 宿主 `packages/server/plugin-ui/v1/**`。
- 任务下发、worktree 同步、Trellis task.json 结构。
- 需求回归的现有 API 形状。

## 2. 数据模型

### 2.1 任务测试 DTO

`GET /trellis-tasks` 返回：

```json
{
  "items": [
    {
      "taskKey": "mdp-backend-web::11-19-witops-trellis-task-test",
      "projectId": "mdp-backend-web",
      "projectName": "MDP 前端",
      "title": "WitOps 工作台支持 Trellis 任务测试",
      "status": "in_progress",
      "assignee": "kyf",
      "relativeDir": "11-19-witops-trellis-task-test",
      "archived": false,
      "requirementId": "35627",
      "requirementCode": "R35627",
      "testTargets": [
        {
          "key": "trellis:mdp-backend-web::11-19-witops-trellis-task-test",
          "kind": "trellis",
          "taskKey": "mdp-backend-web::11-19-witops-trellis-task-test",
          "requirementId": "35627",
          "requirementCode": "R35627",
          "title": "WitOps 工作台支持 Trellis 任务测试",
          "targetUrl": "https://...",
          "targetUrlSource": "task-meta",
          "outline": "R35627-xxx.md",
          "outlineSource": "manifest-requirement",
          "outlineConfidence": "high",
          "outlineCandidates": []
        }
      ],
      "testRuns": [],
      "latestTestStatus": "untested",
      "latestTestVersion": ""
    }
  ],
  "scenarioAvailable": true,
  "scenarioError": ""
}
```

`requirementId/requirementCode` 解析顺序：

```text
task.meta.requirement_id
task.meta.requirementId
task.meta.requirement_code
task.meta.requirementCode / task.meta.code
codesOf(task.meta.platform_task_id / task.title / task.relativeDir) 中的 R/T 编号
```

只做显式字段和编号正则，不做标题相似度匹配。

### 2.2 目标地址

任务 target 的地址优先级：

```text
task.meta.testUrl
task.meta.scenarioCopilot.targetUrl
task.meta.scenario.targetUrl
binding.taskKey.targetUrl
binding.requirement:<id>.targetUrl
config.targetUrl
```

`targetUrlSource` 对应 `task-meta` / `task-binding` / `requirement-binding` / `config` / `none`。

## 3. 后端

### 3.1 任务 target 构造

新增：

```js
function taskRequirementRef(task) -> { requirementId, requirementCode }
function testTargetForTask(task, bindings, resolution) -> target
function attachTaskTestInfo(tasks) -> { scenarioAvailable, scenarioError }
```

`testTargetsFor(item)` 改为复用 `testTargetForTask`，避免需求行和任务视图两套逻辑。

`attachTaskTestInfo`：

1. 为每个任务构造 subject：`{ key:'trellis:<taskKey>', kind:'trellis', taskKey, requirementId, requirementCode, title }`。
2. 并行调用 `runs.list`、`bindings.get`、`outlines.resolve`。
3. 将 resolution 合并到 target：`outline/outlineSource/outlineConfidence/outlineCandidates/targetUrl/targetUrlSource/resolutionError`。
4. `testRuns` 按 `run.taskKey === task.taskKey` 过滤，按 `startedAt` 倒序；`latestTestStatus/testVersion` 取第一条。
5. scenario 不可用时返回默认 target，任务视图仍可展示。

### 3.2 `GET /trellis-tasks`

```js
ctx.http.route('GET', '/trellis-tasks', async (request) => {
  const repositoryId = text(request.query.repositoryId) || trellisRepositoryId
  const includeArchived = request.query.includeArchived === '1'
  const tasks = await ctx.tasks.list({ repositoryId, includeArchived })
  const result = await attachTaskTestInfo(tasks)
  return { items: tasks, ...result }
})
```

- `repositoryId` 为空时读全部可访问项目。
- 限制返回数量（建议 300），超出由前端提示缩小项目。
- 不返回 `projectPath` 等不必要字段；只保留 DTO 字段。

### 3.3 `startTest` 改为 subject-first

```js
async function startTest(body = {}) {
  const subjectKey = text(body.subjectKey)
  const taskKey =
    text(body.taskKey) ||
    (subjectKey.startsWith('trellis:') ? subjectKey.slice('trellis:'.length) : '')

  if (taskKey) {
    const task = await ctx.tasks.get({ taskKey })
    // 项目边界：配置了 repositoryId 时，task.projectId 必须一致
    // 构造 subject/target，不再 summarize，不再要求 requirementId
    // target 缺失时抛 2010；大纲缺失时抛 2011 needOutline
    return { run: await scenarioCall('runs.start', { subject, outline, targetUrl, ... }, 300000) }
  }

  // 原需求路径保持，仅移除“任务不存在时回退需求 target”的分支
}
```

错误：

- 任务不存在/越界：`2008`，message `Trellis 任务不存在或不在当前项目`。
- 无大纲：`2011` + `needOutline:true` + `candidates`。
- 无地址：`2010` + `targetUrlSource`。

任务 target 查找只按 `target.key === subjectKey` 或 `target.taskKey === taskKey`，**删除** `find(kind === 'requirement')` 兜底。

### 3.4 `outlineContext` 支持 task-only

入参：`{ requirementId?, taskKey?, subjectKey?, scope?, name?, notes?, targetUrl?, title? }`。

```js
const task = taskKey ? await ctx.tasks.get({ taskKey }) : null
const requirementId =
  text(body.requirementId) ||
  text(task?.meta?.requirement_id) ||
  text(task?.meta?.requirementId)
const detail = requirementId ? await requirementDetail(requirementId) : null
const scope = body.scope === 'requirement' && requirementId ? 'requirement' : 'task'
```

任务级正文：

```text
# <任务标题>
任务: <relativeDir>
状态: <status>
负责人: <assignee>
## 任务说明
<task.json description 或（无描述）>
## 任务 PRD
<prd.md 截断 20k>
```

需求级正文保持现有“需求描述 + 需求任务 + 当前任务 PRD”。

文件名：

- 需求级：`<R编号>-<需求标题 slug>.md`（现有）。
- 任务级：`<R编号或T编号>-<任务 slug>.md`；无编号时 `<任务 slug>-<短 hash>.md`，避免同名。

### 3.5 `outlineSave`

```js
requirementIds: context.requirementId ? [context.requirementId] : [],
requirementCodes: context.requirementCode ? [context.requirementCode] : [],
taskKeys: context.scope === 'task' && context.taskKey ? [context.taskKey] : [],
scope: context.scope,
```

任务有需求但选择“仅当前任务”时，只写 `taskKeys`，不写 `requirementIds`。

### 3.6 运行记录

`summaryOf` 已包含 `taskKey/subjectKey/taskTitle`，无需改 schema。工作台任务视图直接按 `taskKey` 过滤。需求视图沿用现有 requirementId/taskKey 过滤。

## 4. 面板

### 4.1 导航

`index.html` 增加：

```html
<button id="view-tasks" ...>Trellis 任务</button>
<section id="tasks-view" hidden>...</section>
```

表格列：任务、项目、状态/负责人、关联需求、测试大纲、最近测试、操作。

### 4.2 状态与加载

`state.tasks = { items: [], loading: false, error: '', includeArchived: false }`。

`loadTrellisTasks()` 调 `/trellis-tasks?repositoryId=...&includeArchived=...`；项目切换、刷新、`setView('tasks')` 时按需加载。

### 4.3 行操作

- `openTest(taskItem, 'trellis:' + taskKey)`：复用现有弹窗；`taskItem` 至少包含 `id: requirementId || ''`、`testTargets`、`testRuns`。
- 生成大纲：`openOutlineDialog()` 使用当前 target 的 `taskKey`；不再要求 `requirementId`。
- 最近测试 badge 点击 `openRun(run.id)`。

### 4.4 测试弹窗

- `openTest` 允许 `item.id` 为空；`test-requirement` 为空时仍可提交。
- `updateTestSubmit` 的关联按钮只在没有大纲时禁用，不再要求 requirementId。
- `associateSelectedOutline` 删除 `if (!requirementId) return`；发送 `taskKey`，`requirementId` 可选。
- `openOutlineDialog` 删除 `if (!requirementId) return`；无需求时 scope 固定 `task`，并禁用 `requirement` 选项。
- 生成弹窗默认 scope：
  - 有需求且需求无 active 大纲 → `requirement`
  - 需求已有大纲 → `task`（提示“需求已有大纲，任务可直接复用”）
  - 无需求 → `task`

### 4.5 样式

- 任务视图复用 `.tb-table`；任务标题列允许换行，不撑宽。
- 测试弹窗保持 `#test-dialog` `width:min(560px, calc(100vw - 32px))`、`#test-form min-width:0`。
- 任务行 badge 不新增固定宽度；360px 下表格横向滚动由容器负责，不把页面撑宽。

## 5. 回归边界

- 需求回归仍由 `regressionSubjects()` 构造 `kind:'requirement'`。
- `regressions.preflight` 只检查需求级 binding/manifest requirement 关联；任务级 `taskKeys` 不参与。
- 任务级大纲不写 `requirementIds`，因此不会被需求解析命中。
- 后续如做任务回归，另开任务，不在本次扩大 scope。

## 6. 测试策略

### 6.1 scenario-copilot L3

在 `plugins/scenario-copilot/test/outline-flow.test.js` 增加：

- task subject 的 `outlines.resolve`：manifest `taskKeys` 命中，source=`manifest-task`。
- task subject 的 requirement 继承：task 有 `requirementId`，manifest requirement 命中。
- task-only `regressions.preflight` 返回 `outline-missing`/`url-missing`，不误判。

### 6.2 workbench

优先把纯逻辑抽成可测函数（`taskRequirementRef`、`testTargetForTask`）；若时间允许新增最小 L3：

- fake `scenario.copilot` + fake `witops.workitems` 太重时，至少用真实 4403 Playwright 覆盖：
  - 任务视图渲染；
  - 纯任务无大纲阻止；
  - 任务级生成保存后选中；
  - 任务行最近运行状态。

### 6.3 手工/Playwright

- 1006px 与 360px：任务视图、测试弹窗、生成弹窗 `scrollWidth === clientWidth`。
- 选一个无需求任务：生成任务级大纲 → 保存 → 运行（可 `noRun`）→ 任务行显示状态。
- 选一个有需求任务：需求无大纲时默认需求级；需求已有大纲时任务继承。
- 需求回归：任务级大纲不被使用；需求级大纲正常。

## 7. 兼容与回滚

- 旧任务没有 `meta.requirement_id` 时，任务视图仍可用，只是不关联需求。
- 旧运行记录没有 taskKey 的，不显示在任务行；需求视图保持原逻辑。
- 新增 `/trellis-tasks` 不影响现有路由。
- 回滚：删除任务视图/路由和 task-first 分支即可；manifest、binding 数据不会被破坏。
- `plugins/witops-workbench/**` 在根仓库被 `.gitignore` 忽略，实施后需单独同步到 client-web 的插件目录/软链源。
