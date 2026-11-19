# 实施计划：WitOps 运行测试弹窗与测试大纲关联流程

## 0. 变更边界

- 只改 `plugins/witops-workbench/**` 与 `plugins/scenario-copilot/**` 的相关实现、测试和 README。
- 不改 `packages/server/plugin-ui/v1/**` 的宿主全局样式；弹窗宽度只在插件 CSS 覆盖。
- 不改 scenario-copilot CLI 源码（`tmp/project/mom-cli/**`）。
- 不改 Team 权限、插件宿主协议、Trellis 任务下发逻辑。
- 目标：P0 + P1 可交付；P2（候选推荐、dispatch 自动生成、多任务级大纲回归）留作后续。

## 0.1 实际执行结果（2026-11-19）

已完成并验证：

- 弹窗布局：`plugins/witops-workbench/panel/app.css` 覆盖 `#test-dialog` / `#test-form`；1006px 与 360px 下 `scrollWidth === clientWidth`。
- 解析与关联：`plugins/scenario-copilot/index.js` 新增 manifest、`outlines.resolve`、`outlines.associate`、`regressions.preflight`；删除 `listOutlines()[0]` 兜底。
- 工作台：`plugins/witops-workbench/index.js` 接入 resolve、无大纲 2011、生成预览/保存、回归预检；`POST /tests/outline` preview 返回 `202 {jobId}`，`GET /tests/outline?jobId=` 轮询。
- 面板：来源标识、生成弹窗、关联当前选择、回归缺失列表与提交禁用。
- 测试：`plugins/scenario-copilot/test/outline-flow.test.js`（原计划的 `test/index.test.js` 未新建）；`yarn test:plugins` 108 tests / 107 pass / 1 skip。
- 文档：两份 README 与 `.trellis/spec/backend/scenario-outlines.md`。
- 提交：`ea03931 feat(scenario): 支持测试大纲关联、生成与回归预检`；`362b747 docs(spec): 补充测试大纲契约与插件运行时陷阱`。

未做/偏差：

- `plugins/witops-workbench/test/index.test.js` 未新建；工作台后端由真实 4403 实例手工/Playwright 验证。
- `plugins/scenario-copilot/panel/{index.html,app.css}` 未改；该面板仅做了大纲列表的最小调整。
- 未跑真实业务测试（无账号），未做“保存大纲”的完整 UI E2E；save 由 L3 覆盖。
- `plugins/witops-workbench/**` 被根 `.gitignore:55` 的 `plugins/*` 忽略，改动只在本地文件，不进入上述提交。

## 1. 文件清单

### scenario-copilot

- `plugins/scenario-copilot/index.js`
  - manifest 读写、`outlineMetaOf`、`associateOutline`
  - `listOutlines` 合并元数据
  - `resolveOutline` / `resolveBatch`
  - `outlines.resolve` / `outlines.associate` capability
  - `saveOutline` 扩展关联参数
  - `startRun` 使用统一解析，删除 `listOutlines()[0]` 兜底
  - `regressions.preflight`
  - `/outlines`、`/outlines/associate`、`/outlines/resolve`、`/regressions/preflight` HTTP 路由
- `plugins/scenario-copilot/plugin.json`
  - capability 增补、版本递增（provided version 1.2.0 → 1.3.0，plugin 0.4.0 → 0.5.0）
- `plugins/scenario-copilot/panel/app.js`、`panel/index.html`、`panel/app.css`
  - 大纲列表显示关联需求/任务；任务选择使用 resolve；新增“关联已有大纲”入口（最小实现）
- `plugins/scenario-copilot/README.md`
- `plugins/scenario-copilot/test/index.test.js`（新建 L3）
- `plugins/scenario-copilot/test/fixtures/fake-outline-cli/**`（如需要测生成）

### witops-workbench

- `plugins/witops-workbench/index.js`
  - `attachTestInfo` 接入 `outlines.resolve`
  - `testTargetsFor` 输出 `outlineSource/outlineConfidence/outlineCandidates/targetUrlSource`
  - `startTest` 无大纲结构化错误
  - `startRegression` 预检、缺失原因
  - `POST /tests/outline`（preview/save）
  - `GET/POST /regressions/preflight`
  - 生成上下文组装（需求描述 + 任务 PRD）
- `plugins/witops-workbench/plugin.json`
  - 版本 1.3.0 → 1.4.0；新增 capability 调用声明 `regressions.preflight`、`outlines.resolve`、`outlines.associate`（如通过 capability 调用）
- `plugins/witops-workbench/panel/index.html`
  - 来源提示、生成大纲按钮、生成弹窗
- `plugins/witops-workbench/panel/app.js`
  - `applySubject` 使用解析结果
  - 来源渲染、未关联禁用、生成预览/保存
  - 回归预检 UI
- `plugins/witops-workbench/panel/app.css`
  - `#test-dialog` 宽度、`#test-form` min-width、控件宽度、来源/预览样式
- `plugins/witops-workbench/test/index.test.js`（新建，最小 L3；fixture 视成本）
- `plugins/witops-workbench/README.md`

### 任务文档

- `research/current-flow.md`（已创建）
- `implement.jsonl` / `check.jsonl`（本文件写完后补）

## 2. 实施顺序（原始计划，实际结果见 0.1）

### P0-1 弹窗布局（先做，独立可验证）

- [ ] 在 `plugins/witops-workbench/panel/app.css` 追加：
  - `#test-dialog { width: min(560px, calc(100vw - 32px)); }`
  - `#test-form { width: 100%; min-width: 0; }`
  - `#test-dialog select, #test-dialog input { min-width: 0; max-width: 100%; }`
  - 长选项/来源/预览样式。
- [ ] 不改 `packages/server/plugin-ui/v1/ui.css`。
- [ ] Playwright 实测：
  - 1006px 视口：`#test-dialog` 的 `scrollWidth === clientWidth`。
  - 360px 视口：无横向滚动。
  - 长 URL/长大纲名不撑宽。
  - 回归/详情弹窗无样式回归。
- [ ] 验证：`yarn format:check`（如有格式变更）+ 手工截图/度量。

### P0-2 scenario-copilot 统一解析

- [ ] 在 `plugins/scenario-copilot/index.js` 提取：
  - `readManifest(config)` / `writeManifest(config, manifest)`
  - `outlineMetaOf(config, name)` / `listOutlines(config)` 合并元数据
  - `outlineForTask(task)` 保留为“推测”候选，不再直接作为最终结果
  - `resolveOutline({ subject, input, bindings, manifest, outlines })`
  - `resolveTargetUrl(...)`
- [ ] `startRun` 改为：

```js
const resolution = resolveOutline(...)
if (!resolution.outline) {
  throw ctx.error(2002, '未关联测试大纲', {
    needOutline: true,
    subjectKey: subject.key,
    requirementId: subject.requirementId,
    taskKey: subject.taskKey,
    candidates: resolution.candidates,
  })
}
```

- [ ] 删除 `text(config.defaultOutline)` 与 `listOutlines(config)[0]?.name` 的静默兜底；默认大纲只在 `input.allowDefaultOutline === true` 或没有需求/任务上下文时使用。
- [ ] 目标地址顺序统一为：输入 > 任务 binding > 需求 binding > 任务 meta > config；返回 `targetUrlSource`。
- [ ] `bindingsResult` 增加 `resolution`（可选，或新增 `outlines.resolve` 批量接口）。
- [ ] 验证：`node --check plugins/scenario-copilot/index.js`；现有 `plugins/scenario-copilot/test/manifest.test.js` 仍通过。

### P0-3 工作台解析接入与未关联阻止

- [ ] `plugins/witops-workbench/index.js`：
  - `testTargetsFor` 只负责基础字段；新增 `resolveTargets(items)` 在 `attachTestInfo` 中调用 `outlines.resolve`（批量）。
  - 每个 target 带 `outlineSource`、`outlineConfidence`、`outlineCandidates`、`targetUrlSource`。
  - `startTest`：
    - 若 `body.outline` 为空，先解析；仍为空则 `ctx.error(2011, '请先生成或选择测试大纲', { needOutline: true, ... })`。
    - `targetUrl` 为空时用 resolution。
  - `startRegression`：先预检，缺失时 `ctx.error(2011, '回归预检未通过', { missing })`。
- [ ] `plugins/witops-workbench/panel/app.js`：
  - `applySubject` 不再 `fillOutlineOptions(state.defaults.defaultOutline)`；改用 `target.outline`。
  - 无 outline 时添加 `未关联（请选择或生成）` 选项，`#test-submit.disabled = true`。
  - 增加来源渲染：
    - `#test-outline-source` 文案 + `ok/warn/danger` class。
    - `#test-target-source` 文案。
  - `bridge.post('/tests')` 捕获 `needOutline`，定位到生成按钮。
- [ ] `panel/index.html` 增加来源 `<p>` 与生成按钮。
- [ ] 验证：手工打开 R35627，确认无关联时不能提交；选择其他大纲后可以提交。
- [ ] 注意：工作台面板在 sandbox iframe，不能用 `window.confirm/alert/prompt`；生成弹窗用 `<dialog>`。

### P1-1 manifest 与关联写入

- [ ] `saveOutline(input)`：
  - 现有校验保留（内容非空、H1、文件名安全、`overwrite`）。
  - 计算 `contentHash`。
  - 接收 `scope/requirementIds/requirementCodes/taskKeys/route/status/source`。
  - 写 `.md` 后更新 manifest；返回 `{ name, title, size, outline, outlines }`。
- [ ] `associateOutline(input)`：
  - 校验文件存在、name 是 basename。
  - `mode: merge` 合并数组；`mode: replace` 覆盖关联字段。
  - 不修改 `.md` 内容。
- [ ] `listOutlines` / `defaultsResult` 返回元数据。
- [ ] `plugin.json` 增补 `outlines.associate` capability；版本递增。
- [ ] 测试：
  - manifest 缺失/损坏 → `/outlines` 200。
  - `associate` → `/outlines/resolve` 命中 `requirement-meta`。
  - `save` 带关联 → manifest 内容正确；`overwrite:false` 返回 2009。
  - 路径穿越文件名被拒绝。

### P1-2 工作台生成大纲接口

- [ ] 新增 `POST /tests/outline`：
  - `mode: preview`：组装上下文 → `scenarioCall('outlines.generate')` → 返回 draft。
  - `mode: save`：preview 的内容 + 用户 name/scope → `scenarioCall('outlines.save')`。
- [ ] 上下文组装：
  - 通过 `summarize([requirementId])` 取需求与任务。
  - `ctx.tasks.get({ taskKey })` 取 `projectPath`、`relativeDir`；读 `prd.md`。
  - 路径必须位于任务目录内；`..`/绝对路径拒绝。
  - 总长度截断 30,000 字符；空 PRD 跳过。
- [ ] 默认标题/文件名：
  - 标题：`R<code> <requirement.title>`（code 已含 R 时不重复）。
  - 文件名：`R<code>-<slug>.md`；slug 保留中文，替换空白/标点。
  - `scope=task` 时文件名追加任务目录 slug。
- [ ] 路由推导：
  - `new URL(targetUrl).hash` 去掉 `#`；
  - 无 hash 用 `pathname`；
  - 无 URL 留空。
- [ ] 错误处理：
  - 未配置 `outlinesDir` / CLI 缺失 → 透传 scenario-copilot 的 2002/2005/2006。
  - 生成超时 → 2006，提示稍后重试。
- [ ] 验证：用 R35627 调 preview，确认 draft 有 H1、cases/steps；save 后 manifest 有关联。

### P1-3 生成大纲面板

- [ ] `panel/index.html` 新增 `<dialog id="outline-dialog">`：
  - 标题、补充说明、保存文件名、关联范围 radio、预览 `<pre>`、错误、按钮（生成预览/保存并选用/关闭）。
- [ ] `panel/app.js`：
  - `openOutlineDialog()`：预填标题/文件名，清空预览。
  - `gen-preview`：`POST /tests/outline` `mode=preview`，展示 `draft.content` 和 cases/steps/warnings。
  - `gen-save`：`POST /tests/outline` `mode=save`，更新 `state.defaults.outlines`、当前 target、重新渲染并选中。
  - 同名冲突：提示后允许 `overwrite:true` 重试。
  - 生成中禁用按钮，显示耗时提示（通常几十秒到两分钟）。
- [ ] `panel/app.css`：预览区、来源徽标、生成弹窗布局；确保 `#test-dialog` 不因新内容溢出。
- [ ] 验证：
  - R35627 无关联 → 生成预览 → 保存 → 自动选中 → 开始运行。
  - 关闭再打开 → 自动解析到新大纲。
  - 需求已有大纲时，任务对象自动继承，不重复生成。

### P1-4 回归预检与面板

- [ ] scenario-copilot 新增 `regressions.preflight`：
  - 入参 `{ subjects }`，返回 `{ ready, missing }`。
  - `missing[].reasons` 使用 `outline-missing` / `outline-guessed` / `url-missing`。
- [ ] 工作台 `startRegression`：
  - 先 `scenarioCall('regressions.preflight')`；有 missing → `ctx.error(2011, '回归预检未通过', { missing })`。
  - 通过后把每个 subject 的 `outline/targetUrl` 传给 `regressions.start`。
- [ ] 工作台 `GET/POST /regressions/preflight`：
  - 供面板打开弹窗时展示 `已就绪 N / 缺失 M`。
- [ ] `panel/app.js`：
  - 打开回归弹窗时请求 preflight。
  - 缺失时展示列表，禁用提交；提供关闭/去运行测试提示。
- [ ] 验证：选一个缺大纲需求 + 一个就绪需求 → 回归弹窗显示缺失，提交被阻止；补齐后预检通过。

### P1-5 文档与测试收尾

- [ ] 更新 `plugins/scenario-copilot/README.md`：
  - manifest 字段、resolve 优先级、associate 用法、无大纲错误。
- [ ] 更新 `plugins/witops-workbench/README.md`：
  - 运行测试弹窗来源标识、生成大纲流程、回归预检。
- [ ] 补 `plugins/scenario-copilot/test/index.test.js`（L3，真实 harness + HTTP）。
- [ ] 视 fixture 成本补 `plugins/witops-workbench/test/index.test.js`：
  - 至少覆盖 `/test-defaults` 返回元数据、`/tests` 无大纲 2011、`/regressions/preflight` 缺失结构。
  - 若需要，新增 `test/fixtures/scenario-provider/index.js` 提供 `scenario.copilot`；新增 `witops-provider` 提供 `witops.workitems`。
- [ ] 运行：
  - `yarn test:plugins`
  - `yarn format:check`
  - `node --check plugins/scenario-copilot/index.js plugins/witops-workbench/index.js`
- [ ] 手工 E2E（Playwright）：
  - 1006px 弹窗无横向滚动。
  - R35627 生成 → 保存 → 运行 → 重新打开自动选中。
  - 回归缺失提示。
- [ ] 检查 `git diff --check`，确认无 CRLF/尾随空格。

## 3. 验收命令

```bash
node --check plugins/scenario-copilot/index.js
node --check plugins/witops-workbench/index.js
yarn test:plugins
yarn format:check
git diff --check
```

手工验证使用 4403 实例：

```text
http://192.168.137.10:4403/ → WitOps 工作台 → 运行测试
```

## 4. 关键风险与回滚点

- **P0-1 后**：CSS 是独立变更，可直接回滚；不回滚数据。
- **P0-2 后**：解析逻辑变更可能让原本“能跑”的无大纲任务变成报错；这是预期行为。若需要临时兼容，配置 `allowDefaultOutline: true` 或显式选择大纲。
- **P1-1 后**：manifest 是新增文件，旧代码忽略；回滚代码不影响 `.md`。
- **P1-2/P1-3 后**：生成接口依赖 scenario-copilot CLI；CLI 不可用时预览/保存报 2005，不影响已有大纲运行。
- **P1-4 后**：回归从静默兜底变为阻止；上线前先用现有真实需求跑一次 preflight，确认没有大面积缺大纲。

## 5. 审查门禁

- [ ] PRD 的四条 Confirmed Decisions 未被实现改变。
- [ ] 没有把元数据写进 `.md` frontmatter。
- [ ] 没有在需求/任务上下文下静默使用 `defaultOutline` 或第一个大纲。
- [ ] 没有把目标环境 URL 写入 manifest。
- [ ] 面板没有使用 `window.confirm/alert/prompt`。
- [ ] 生成上下文读取任务 PRD 时做了路径越界校验和长度截断。
- [ ] 回归缺失原因可区分 `outline-missing` / `outline-guessed` / `url-missing`。
- [ ] 旧大纲、旧 binding、旧运行记录兼容。

## 4. 实际完成情况（2026-11-19）

- [x] P0-1 弹窗布局：`#test-dialog` 560px 上限、`#test-form` `min-width:0`、控件 `max-width:100%`；1006px/360px 实测 `scrollWidth === clientWidth`。
- [x] scenario-copilot manifest：`outlines.manifest.json` 读写、`listOutlines` 合并元数据、`outlines.associate`、`outlines.resolve`、`regressions.preflight`。
- [x] 统一解析与错误：`startRun` 删除 `listOutlines()[0]` 兜底；无大纲返回 2002 `needOutline`；目标地址顺序统一；Trellis subject 保留 `raw.requirementId`，可继承需求级大纲。
- [x] 工作台解析接入：`attachTestInfo` 批量 `outlines.resolve`；target 输出 `outlineSource/outlineConfidence/targetUrlSource`；无大纲 `startTest` 返回 2011。
- [x] 工作台生成大纲：`POST /tests/outline` 支持 preview/save；长耗时生成改为后台 job（`202 {jobId}` + `GET /tests/outline?jobId=`），面板轮询，避免宿主 30s HTTP 超时。
- [x] 工作台关联已有大纲：`POST /outlines/associate` + 弹窗「关联当前选择」。
- [x] 回归预检：`regressions.preflight` + 工作台 `GET/POST /regressions/preflight` + 面板缺失列表。
- [x] 面板来源/阻止/生成弹窗：绿色/黄色/红色来源提示；无大纲禁用开始运行；生成预览/保存/同名覆盖；`TrellisBridge` 超时调到 300s。
- [x] 测试：新增 `plugins/scenario-copilot/test/outline-flow.test.js`（manifest 关联、resolve、preflight、save）；`yarn test:plugins` 107 pass / 1 skip。
- [x] 文档：两个插件 README 更新 manifest、解析优先级、生成/关联流程。
- [ ] 未覆盖：真实浏览器测试执行（无测试账号）；保存大纲的完整 UI E2E（后端 L3 已覆盖 save）；工作台专用 L3 测试（手工 Playwright 覆盖关键路径）。

### 验证记录

```bash
node --check plugins/scenario-copilot/index.js
node --check plugins/witops-workbench/index.js
node --check plugins/scenario-copilot/panel/app.js
node --check plugins/witops-workbench/panel/app.js
yarn test:plugins          # 107 pass, 1 skip, 0 fail
git diff --check           # 通过（仅跟踪文件；witops-workbench 被 .gitignore 忽略）
```

Playwright 4403 实测：

- `#test-dialog` 1006px：clientWidth/scrollWidth 558/558；360px：284/284；body 318/318。
- R35627 需求与 Trellis 任务都解析到 `dm-business-category.md`，来源「需求关联」。
- 「生成测试大纲」预览 32s 成功，16 个用例 / 117 步，文件名预填 `R35627-业务分类分步初始化与数据域可选关联.md`。
- 回归预检 R35627 → ready；R35499 → `outline-missing`。

### 交付注意

`plugins/*` 被根 `.gitignore` 忽略，`plugins/witops-workbench/**` 的改动不会进入本次 Git 提交；需要同步到部署目录/插件仓库。`plugins/scenario-copilot/**` 为跟踪文件，可正常提交。
