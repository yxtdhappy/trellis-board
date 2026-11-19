# 实施计划：WitOps 工作台支持 Trellis 任务测试

## 0. 变更边界

- 主实现：`plugins/witops-workbench/{index.js,panel/index.html,panel/app.js,panel/app.css,README.md}`。
- 最小补齐：`plugins/scenario-copilot/{index.js,test/outline-flow.test.js}`，只在任务级解析/生成字段有缺口时改。
- 不改 CLI、宿主 UI 库、Trellis 任务下发和工作树同步脚本。
- 目标：任务视图 + 任务直接发起 + 任务级大纲生成 + 结果归属；任务批量回归不做。

## 1. 文件清单

### witops-workbench 后端

- `plugins/witops-workbench/index.js`
  - `taskRequirementRef(task)`
  - `testTargetForTask(task, bindings, resolution)`
  - `attachTaskTestInfo(tasks)`
  - `testTargetsFor()` 复用单任务 target
  - `GET /trellis-tasks`
  - `startTest()` subject-first，删除需求 target 兜底
  - `outlineContext()` 支持 task-only，读取 `task.json` 描述 + `prd.md`
  - `outlineSave()` 按 scope 写关联字段
- `plugins/witops-workbench/plugin.json`
  - 版本 1.4.0 → 1.5.0（无新增 capability 时只递增 plugin）
- `plugins/witops-workbench/README.md`
  - `/trellis-tasks`、任务测试流程、目标地址来源、回归边界

### witops-workbench 面板

- `panel/index.html`
  - 第三个导航按钮 `view-tasks`
  - `tasks-view` 表格、空状态、错误
  - 生成弹窗任务 scope 提示（复用现有 dialog）
- `panel/app.js`
  - `state.tasks`
  - `loadTrellisTasks()` / `renderTrellisTasks()` / `setView('tasks')`
  - `openTest` 允许无 requirementId
  - `associateSelectedOutline` 允许纯 taskKey
  - `openOutlineDialog` 允许纯 taskKey
  - 任务行测试/生成/运行详情事件
- `panel/app.css`
  - 任务视图布局、任务标题换行、来源 badge；确保 360px 不撑宽

### scenario-copilot

- `plugins/scenario-copilot/index.js`
  - 仅在 task subject 的 requirement 字段/任务级 save 关联有缺口时补
- `plugins/scenario-copilot/test/outline-flow.test.js`
  - task subject resolve、任务级 manifest、preflight 边界

### 任务文档

- `research/current-flow.md`：当前代码证据和阻塞点
- `implement.jsonl` / `check.jsonl`

## 2. 实施顺序

### P0-1 任务列表与 target

- [ ] 在 `index.js` 增加 `taskRequirementRef(task)`，只读显式 meta/code。
- [ ] 增加 `testTargetForTask(task, bindings, resolution)`，复用现有 target 字段。
- [ ] 增加 `attachTaskTestInfo(tasks)`，并行调用 `runs.list` / `bindings.get` / `outlines.resolve`。
- [ ] 增加 `GET /trellis-tasks`，支持 `repositoryId`、`includeArchived`。
- [ ] 验证：真实 4403 调接口，确认未匹配需求的任务也返回。

### P0-2 任务直接发起

- [ ] 重构 `startTest()`：
  - `taskKey`/`subjectKey=trellis:*` 优先。
  - `ctx.tasks.get` 校验项目边界。
  - 不再 `summarize`，不再要求 `requirementId`。
  - 删除 `find(target => target.kind === 'requirement')` 兜底。
- [ ] 任务 target 缺失时分别返回 `2011 needOutline` / `2010`。
- [ ] 验证：纯 taskKey 发起（可 `noRun`）；无大纲任务返回 needOutline；不存在的 taskKey 报错。

### P0-3 任务视图

- [ ] `index.html` 增加导航和任务表格。
- [ ] `app.js` 增加加载/渲染/项目切换/刷新。
- [ ] 任务行显示大纲来源、最近测试、运行/生成按钮。
- [ ] 1006px/360px 实测无横向溢出。
- [ ] 验证：无需求任务可打开测试弹窗并选中自己。

### P1-1 任务级大纲生成

- [ ] `outlineContext()` 支持无 requirementId 的 taskKey。
- [ ] 任务级正文：标题/状态/负责人/relativeDir/task.json 描述/prd.md。
- [ ] 任务级文件名：`<R/T编号>-<任务 slug>.md`，无编号时加短 hash。
- [ ] `outlineSave()` 按 scope 写 `requirementIds/requirementCodes/taskKeys`。
- [ ] 面板生成弹窗：无需求禁用需求级；有需求无大纲默认需求级；需求已有大纲提示复用。
- [ ] 验证：任务级生成保存后 manifest 只有 taskKeys；需求级生成保存后有 requirementIds。

### P1-2 关联与结果

- [ ] `associateSelectedOutline()` 允许纯 taskKey。
- [ ] `updateTestSubmit()` 不再因 requirementId 为空禁用关联。
- [ ] 任务行最近运行按 taskKey 过滤；点击查看详情。
- [ ] 需求行运行记录保持原逻辑。
- [ ] 验证：任务运行后任务行出现状态，需求行仍能看到关联运行。

### P1-3 文档与测试

- [ ] 更新 `plugins/witops-workbench/README.md`。
- [ ] 补 `outline-flow.test.js` 的 task subject 用例。
- [ ] 运行 `node --check`、`yarn test:plugins`、`oxfmt`、`git diff --check`。
- [ ] Playwright 手工验证任务视图、生成、运行、回归边界。

## 3. 验收命令

```bash
node --check plugins/witops-workbench/index.js
node --check plugins/scenario-copilot/index.js
yarn test:plugins
npx oxfmt --check plugins/witops-workbench/index.js \
  plugins/witops-workbench/panel/app.js \
  plugins/witops-workbench/panel/index.html \
  plugins/scenario-copilot/index.js \
  plugins/scenario-copilot/test/outline-flow.test.js
git diff --check
```

4403 实例：

```text
http://192.168.137.10:4403/ → WitOps 工作台 → Trellis 任务
```

## 4. 风险与回滚点

- **P0-1 后**：新增只读接口，回滚删除路由即可。
- **P0-2 后**：任务路径不再回退需求 target；这是预期行为。若不兼容，可临时让调用方显式传 requirementId。
- **P1-1 后**：任务级大纲写入 manifest `taskKeys`；回滚代码不会破坏已有 manifest。
- **P1-2 后**：任务行状态依赖 `run.taskKey`；旧运行无 taskKey 时不显示，不影响需求视图。
- **插件忽略**：`plugins/witops-workbench/**` 被根 `.gitignore` 忽略，提交前用 `git check-ignore -v` 确认；需要单独同步到 client-web 的软链源/部署目录。

## 5. 审查门禁

- 不允许任务 subject 回退到需求 target。
- 不允许标题相似度推断任务所属需求。
- 不允许任务级大纲写 `requirementIds`。
- 不允许点击运行自动生成大纲。
- 任务视图和测试弹窗在 360px 下不得撑宽页面。
