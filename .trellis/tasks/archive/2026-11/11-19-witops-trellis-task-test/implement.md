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

## 6. UI 反馈修整（2026-11-19）

- 任务表改为固定列宽：`table-layout: fixed` + `<colgroup>`，测试列 140px；项目列单元格不再命中通用 `.project` inline-flex 规则，所有单元格同高、底边对齐。
- 原型需求链接移入「配置」弹窗，保存到插件 store 的 `settings.prototypeUrl`；关注 ID 编辑移入独立弹窗，主页面只保留数量/未匹配提示与表格展示。
- 验证：1006px 视口任务列宽 `[258,80,72,56,76,120,140,120]`、行高 72px、表格容器 922/922；360px 视口 watch/settings 弹窗 284/284、body 318/318；`/settings` GET/POST 正常。
- 注意：`plugins/witops-workbench/**` 仍被根 `.gitignore` 忽略，改动只存在于主工作树，需单独同步/部署。

## 7. 原型链接导入卡住修复（2026-11-19）

- 服务端 `fetchPrototype` 报 `fetch failed`：WSL 的 systemd-resolved 当前 DNS（223.5.5.5）无法解析 `prototype.weintdata.cn`；`192.168.18.1` 可解析到 `192.168.19.171`，已加入 `/etc/hosts` 作为本机解析。
- 前端 `resolve` 原先复用 `state.loading`，启动时 `/summary` 未完成期间解析按钮被禁用且无反馈；改为独立 `state.resolving`，并让“保存并查询”使用独立 `state.saving`，启动加载期间也能导入。
- ego 实测完整页面：编辑关注 ID → 填入原型链接 → 解析到 28 个需求 → 保存并查询 → 弹窗关闭、关注数 28、状态完成，无卡住。
- 注意：`/etc/hosts` 映射为当前环境配置，不属于仓库代码；原型 IP 变化时需更新。

## 8. Jenkins CI 配置入口（2026-11-19）

- 根因：`ci.job` 只支持 `plugins.json`，面板没有配置入口；同时 `witops-workbench` 未声明 `jenkins.ops.jobs.list`。
- 面板「配置」新增 Jenkins Job（带 `jobs.list` 候选 datalist）与分支参数名；CI 条新增「配置」按钮。
- 后端 `settings` 持久化 `ciJob/ciBranchParam`，启动时覆盖 `ciConfig`；新增 `GET /ci/jobs` 与 `ci.jobs` capability，requires 增加 `jobs.list`。
- 验证：`/ci/jobs` 返回 4 个任务；配置 `{fat}luban_mdp-backend-web` 后 `/ci` 返回 `#54 SUCCESS`，CI 条显示 job、构建号，日志可打开。

## 9. 仅安装 witops-workbench 的降级验证（2026-11-19）

- 新增 `GET /features`：通过 `trellis.capabilities.list` 读取运行时能力目录，返回 `witops/scenario/jenkins/trellis`；manifest 增加 `trellis.capabilities.list` require。
- 面板按 `features` 隐藏关注需求/我的待办/CI 条、测试/大纲/回归列与按钮；`setView` 在缺少 `witops-core` 时强制 Trellis 任务视图，并显示「未安装：…；相关入口已隐藏，Trellis 任务仍可用」。
- `/summary`、`/test-defaults`、`/ci`、`/trellis-tasks` 在依赖缺失时返回 200 + 空结果/明确错误，不再 500。
- 修复 `renderFeatures` 引用不存在的 `#watch-toolbar` 导致 `setView` 未执行的问题（HTML 补 id）。
- 隔离环境 `/tmp/witops-only`（仅 workbench，端口 4405）验证：`/features` 为 `witops:false, scenario:false, jenkins:false, trellis:true`；面板只显示 Trellis 任务，测试/大纲/操作列隐藏，1006/360 均无 body 横向溢出；`/summary`、`/test-defaults`、`/ci`、`/trellis-tasks` 均 200。
- 全量环境 4403 重启后 `/features` 四项均为 true，任务视图/列宽/测试入口无回归；`yarn test:plugins` 113 tests / 112 pass / 1 skip。

## 10. 归档前验收（2026-11-19）

- `outline-flow.test.js` 增加 task-only resolve 用例：构造 `repo::11-19-task-1` 任务，保存 `taskKeys` 后解析返回 `manifest-task` 与 `config` 地址。
- task-only 发起在 4403 工作台手工验证：纯 `taskKey` 进入 `runs.start`，无 `requirementId`；无大纲返回 `needOutline`。
- `node --check plugins/scenario-copilot/test/outline-flow.test.js` 通过。
- `node --test plugins/scenario-copilot/test/outline-flow.test.js` 1/1 通过。
- `yarn test:plugins` 见最终执行结果；`oxfmt`、`git diff --check` 通过。
- 已知边界：workbench 源码按 `.gitignore` 约定不入库，只保留本地主工作树；归档提交仅包含任务记录与 scenario 测试。
