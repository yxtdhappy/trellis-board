# 当前代码事实（2026-11-19）

## 工作台

- `plugins/witops-workbench/index.js:439 testTargetsFor(item)` 只从 `item.trellisTasks` 生成 task target。
- `plugins/witops-workbench/index.js:185 matchTrellis()` 按编号/标题匹配最多 8 个任务；未匹配到需求的 Trellis 任务不会进入任何 `item`。
- `plugins/witops-workbench/index.js:573 startTest()` 要求 `requirementId`，调用 `summarize([requirementId])`；任务 target 查找最后回退到 `kind === 'requirement'`。
- `plugins/witops-workbench/index.js:694 outlineContext()` 要求 `requirementId`，调用 `requirementDetail`；不能只按任务 PRD 生成。
- `plugins/witops-workbench/index.js:896 listTrellisTasks()` 已能拿到所有任务（含未匹配需求的），有 5s 缓存。
- `plugins/witops-workbench/index.js:924 summarize()` 在配置 repositoryId 时过滤掉没有 Trellis 任务的 item。
- `plugins/witops-workbench/index.js:1298 GET /mine` 是 WIT Ops 待办；任务项在 `mineItems()` 里被改写成 `storyId`，不是 Trellis 任务列表。
- 面板 `plugins/witops-workbench/panel/app.js:429 openTest()` 只接收某个 item 的 `testTargets`；没有独立任务视图。
- 面板 `plugins/witops-workbench/panel/app.js:578 openOutlineDialog()` 在 `requirementId` 为空时 return。
- 面板 `plugins/witops-workbench/panel/app.js:482 associateSelectedOutline()` 在 `requirementId` 为空时 return。
- 面板 `plugins/witops-workbench/panel/app.js:412 updateTestSubmit()` 用 `test-requirement` 是否为空禁用关联按钮。

## scenario-copilot

- `plugins/scenario-copilot/index.js:670 resolveSubject()` 支持纯 `taskKey`；会 `ctx.tasks.get` 并读取 `task.meta.requirement_id`。
- `plugins/scenario-copilot/index.js:466 outlineCandidatesForSubject()` 对 trellis 依次尝试 task binding、requirement binding、manifest.taskKeys、manifest requirement、filename guess。
- `plugins/scenario-copilot/index.js:525 targetUrlCandidates()` 对 trellis 依次尝试 input、task binding、requirement binding、task meta、config。
- `plugins/scenario-copilot/index.js:705 startRun()` 已支持 `kind:'trellis'`，用 task PRD 无关；大纲/地址解析共用。
- `plugins/scenario-copilot/index.js:895` 运行后写 task binding：targetUrl/outline/testGeneration/testVersion/scriptPath。
- `plugins/scenario-copilot/index.js` 的 `outlines.save` / `associate` 已支持 taskKeys；问题在工作台如何组装/调用。

## 结论

scenario-copilot 的任务测试能力已具备；workbench 缺三件事：

1. 任务列表视图与 `GET /trellis-tasks`。
2. task-first 的 `startTest`，不再要求 requirementId/回退需求 target。
3. task-only 的 `outlineContext` 与面板生成/关联入口。

## 现有数据

- 4403 client-web 的 workbench/scenario-copilot 插件软链到主工作树 `plugins/<id>`。
- `outlines.manifest.json` 位于 `tmp/data/scenario-output/`，已关联 R35627 与 `dm-business-category.md`。
- `plugins/witops-workbench/**` 被根 `.gitignore:55` 的 `plugins/*` 忽略，改动不会随 main 提交。
