# 技术设计：测试大纲关联与运行测试闭环

## 1. 边界与模块

- 插件进程：
  - `plugins/scenario-copilot/index.js`：大纲资产、manifest、解析、运行/回归入口。
  - `plugins/witops-workbench/index.js`：需求/任务聚合、运行测试/回归 HTTP 入口、生成上下文组装。
  - `plugins/witops-workbench/panel/*`：弹窗布局、来源提示、生成大纲预览与保存。
- 宿主：
  - `packages/server/plugin-ui/v1/ui.css` 不改；只在插件 CSS 覆盖 `#test-dialog`。
  - `packages/server/plugin-ui/v1/bridge.js` 不改；继续走 postMessage 桥。
- 不修改 scenario-copilot CLI（`tmp/project/mom-cli/...`）；只调用现有 `outline --json` 能力。

## 2. 大纲 manifest

### 2.1 文件位置

`path.join(outlinesDir, 'outlines.manifest.json')`，与 `.md`/`.txt` 同目录，随大纲目录一起迁移。

### 2.2 Schema

```json
{
  "version": 1,
  "updatedAt": "2026-11-19T01:30:00.000Z",
  "outlines": {
    "R35627-业务分类分步初始化.md": {
      "title": "R35627 业务分类分步初始化",
      "scope": "requirement",
      "requirementIds": ["35627"],
      "requirementCodes": ["R35627"],
      "taskKeys": ["mdp-backend-web::11-04-business-category-optional-domain-frontend"],
      "route": "/dm/plan/businessCategory",
      "source": "generated",
      "status": "active",
      "createdAt": "2026-11-19T01:30:00.000Z",
      "updatedAt": "2026-11-19T01:30:00.000Z",
      "contentHash": "sha256:..."
    }
  }
}
```

字段约束：

- key 必须是文件名（`path.basename(name)`），不得含路径分隔符。
- `scope`：`requirement` / `task`。
- `requirementIds`、`requirementCodes`、`taskKeys` 统一去重、转字符串。
- `status`：`active` / `draft` / `archived`；解析只取 `active`，没有 `status` 视为 `active`。
- `source`：`generated` / `manual` / `legacy`。
- `contentHash`：`sha256:` + 文件内容十六进制摘要，用于判断内容是否变化。
- `route` 只存前端路由（如 `/dm/plan/businessCategory`），不存完整环境地址。

### 2.3 读写策略

- 读取：
  - `readManifest(config)` 安全解析；不存在/空/损坏返回 `{version:1,outlines:{}}`，并 `ctx.log.warn`（不抛错）。
  - `listOutlines(config)` 以目录实际文件为准，合并 manifest 条目；manifest 中不存在的文件保留但不展示，下次 `save`/`associate` 时清理。
  - 返回对象在现有 `{name,title,size}` 基础上追加 `scope/requirementIds/requirementCodes/taskKeys/route/source/status/updatedAt/contentHash`。
- 写入：
  - `writeManifest(config, manifest)`：同目录临时文件写入 + `fs.renameSync` 原子替换；`mkdir -p`；`JSON.stringify(..., null, 2)` + 末尾换行。
  - `saveOutline` 先写 `.md`，再写 manifest；manifest 写失败只记录日志，不删除已写内容。
  - `associateOutline` 只改 manifest，不改 `.md` 内容。
- 并发：插件是单进程，manifest 写入串行；仍使用临时文件避免半写。

## 3. 解析算法

### 3.1 输入

```js
resolveOutline({
  subject,              // resolveSubject() 的结果
  input: { outline, targetUrl, allowDefaultOutline },
  bindings,             // 可选，批量时复用
  manifest,             // 可选，批量时复用
})
```

### 3.2 大纲优先级

1. `input.outline`（显式）→ `source: "explicit"`，`confidence: "exact"`。
2. 任务 binding：`binding:<taskKey>.outline` → `source: "task-binding"`。
3. 需求 binding：`binding:requirement:<requirementId>.outline` → `source: "requirement-binding"`。
4. manifest 中 `taskKeys` 包含当前 `taskKey`：按 `status=active`、`updatedAt desc` 排序 → `source: "task-meta"`，`confidence: "associated"`。
5. manifest 中 `requirementIds` 包含当前 `requirementId`：同样排序 → `source: "requirement-meta"`。
6. `outlineForTask(task)` 文件名/目录名模糊匹配 → `source: "filename-guess"`，`confidence: "guessed"`。
7. `config.defaultOutline`，仅当 `input.allowDefaultOutline === true` 或 subject 没有 `requirementId`/`taskKey` → `source: "default"`，`confidence: "fallback"`。
8. 无 → `source: "none"`，`confidence: "none"`。

所有命中都必须验证文件存在；不存在则跳过并记录候选原因，不能返回一个不可用文件名。

### 3.3 目标地址优先级

1. `input.targetUrl`
2. 任务 binding `targetUrl`
3. 需求 binding `targetUrl`
4. 任务 `meta.testUrl` / `meta.scenarioCopilot.targetUrl` / `meta.scenario.targetUrl`
5. `config.targetUrl`（`source: "config"`）
6. 无

返回 `targetUrlSource`，面板显示来源。注意：当前 workbench `testTargetsFor` 是“任务 meta 优先于 binding”，scenario-copilot 是“binding 优先于任务 meta”；本期统一为上面的顺序，以 binding 作为用户显式覆盖。

### 3.4 返回结构

```js
{
  subjectKey: "trellis:mdp-backend-web::11-04-...",
  outline: "R35627-业务分类分步初始化.md" | "",
  outlineTitle: "R35627 业务分类分步初始化",
  source: "requirement-meta",
  confidence: "associated",
  candidates: [
    {
      name: "dm-business-category.md",
      title: "dm-business-category",
      source: "requirement-meta",
      score: 100,
      requirementIds: ["35627"],
      taskKeys: []
    }
  ],
  targetUrl: "http://...",
  targetUrlSource: "task-meta"
}
```

候选列表最多 20 个，按 source 优先级和 `updatedAt` 排序；UI 只需要展示名称、来源和警告。

## 4. capability / HTTP 契约

### 4.1 scenario-copilot 新增 capability

`plugin.json` 的 `provides.methods` 增加：

- `outlines.resolve`（read，10s）
- `outlines.associate`（write，10s）

可选增加：
- `outlines.get`（read，10s）用于单文件详情；首期可不加。

#### `outlines.resolve`

```js
// params
{
  subjects: [
    { key: "requirement:35627", kind: "requirement", requirementId: "35627", requirementCode: "R35627", title: "..." },
    { key: "trellis:mdp-backend-web::11-04-...", kind: "trellis", taskKey: "mdp-backend-web::11-04-...", requirementId: "35627", title: "..." }
  ],
  outline: "",          // 可选，所有 subject 的显式覆盖
  targetUrl: "",        // 可选
  allowDefaultOutline: false
}
// result
{ results: { "<subjectKey>": <resolution> } }
```

#### `outlines.associate`

```js
// params
{
  name: "dm-business-category.md",
  scope: "requirement",
  requirementIds: ["35627"],
  requirementCodes: ["R35627"],
  taskKeys: ["mdp-backend-web::11-04-..."],
  route: "/dm/plan/businessCategory",
  status: "active",
  mode: "merge" | "replace"
}
// result
{ outline: {...}, outlines: [...] }
```

### 4.2 scenario-copilot 现有接口扩展

- `outlines.list`：返回带元数据的大纲数组。
- `outlines.save`：新增 `scope/requirementIds/requirementCodes/taskKeys/route/status/source/overwrite`；返回 `outline` 单条 + `outlines` 全量。
- `outlines.generate`：保持不变；工作台负责组装 `requirementText`。
- `runs.start`：
  - 使用 `resolveOutline` 替代原有 `outlineName` 链。
  - 无大纲时 `ctx.error(2002, "未关联测试大纲", { needOutline: true, subjectKey, requirementId, taskKey, candidates })`。
  - 不再使用 `listOutlines(config)[0]`。
  - `config.defaultOutline` 仅在 `input.allowDefaultOutline === true` 或没有需求/任务上下文时使用。
- `regressions.start`：
  - 每个 subject 用 `resolveOutline`；无大纲/无地址时记录 `errors`，不调用 `startRun` 的静默回退。
  - 新增 `regressions.preflight`（read，10s）：入参 `{ subjects }`，返回 `{ ready: [...], missing: [{subject, reasons}] }`。

### 4.3 witops-workbench HTTP

- `GET /test-defaults`：返回 `scenario-copilot` 的 `defaults.get` 结果（含大纲元数据）。
- 新增 `POST /tests/outline`：

```js
{
  requirementId: "35627",
  subjectKey: "trellis:...",   // 可选
  taskKey: "...",              // 可选
  mode: "preview" | "save",
  title: "...",
  notes: "...",
  name: "...",
  scope: "requirement" | "task",
  targetRoute: "/dm/...",
  caseCount: 1,
  overwrite: false
}
```

`preview` 返回 `{ draft, context }`；`save` 调用 `outlines.save` 并返回 `{ outline, outlines, resolution }`。

- `POST /tests`：
  - 先解析 `body.outline || resolution.outline`；为空直接返回 `2011`（或沿用 `2002` 的包装）和 `needOutline`。
  - `targetUrl` 为空时用 resolution.targetUrl。
- `POST /regressions`：
  - 先调用 `regressions.preflight`；有 `missing` 时返回 `2011` + `missing`。
  - 通过后传每个 subject 的 `outline/targetUrl`。
- 新增 `GET/POST /regressions/preflight`：供面板打开回归弹窗时展示就绪状态。

### 4.4 生成上下文组装

工作台侧：

```js
function buildOutlineContext(item, task) {
  const parts = [
    `# 需求 ${item.code || item.id} ${item.title}`,
    item.description || '',
    '## Trellis 任务',
  ]
  for (const candidate of item.tasks || []) {
    const detail = await ctx.tasks.get({ taskKey: candidate.taskKey })
    const prd = readTaskFile(detail.projectPath, detail.relativeDir, 'prd.md')
    parts.push(`### ${candidate.title} (${detail.relativeDir})`, prd)
  }
  return truncate(parts.join('\n\n'), 30_000)
}
```

- 只读任务目录内 `prd.md`，路径用 `taskDirectory` 同款白名单逻辑，禁止 `..` 越界。
- 任务 PRD 为空时退回需求描述。
- `targetRoute` 从当前 `targetUrl` 的 hash/path 推导；没有则留空。
- 默认标题：`R<编号> <需求标题>`；默认文件名：`R<编号>-<slug>.md`。
- 生成前不调用 LLM；只有用户点击“生成预览”才调用。

## 5. 面板交互

### 5.1 运行测试弹窗

HTML 增加：

- `#test-outline-source`：来源提示。
- `#test-target-source`：地址来源提示。
- `#test-generate`：生成大纲按钮。
- `#test-submit` 保持原按钮，但无大纲时 `disabled`。

`applySubject`：

```js
const target = state.testTargets.find(...)
const outline = target?.outline || ''
fillOutlineOptions(outline)
renderOutlineSource(target)
byId('test-target').value = target?.targetUrl || ''
renderTargetSource(target)
byId('test-submit').disabled = !outline
```

来源文案：

| source | 文案 | 样式 |
| --- | --- | --- |
| explicit | 手动选择 | ok |
| task-binding | 任务上次使用 | ok |
| requirement-binding | 需求上次使用 | ok |
| task-meta | 任务关联 | ok |
| requirement-meta | 需求关联 | ok |
| filename-guess | 文件名推测，请确认 | warn |
| default | 默认大纲，请确认 | warn |
| none | 未关联，请生成或选择 | danger |

### 5.2 生成大纲弹窗

- 复用 `<dialog>`，不引入宿主 React。
- 字段：标题、补充说明、保存文件名、关联范围（需求级/仅当前任务）、预览 `<pre>`。
- “生成预览”调用 `/tests/outline` `mode=preview`；成功后启用“保存并选用”。
- “保存并选用”调用 `mode=save`；成功后：
  - 关闭生成弹窗；
  - 更新 `state.defaults.outlines`；
  - 更新当前 target 的 `outline/outlineSource/outlineConfidence`；
  - 重新渲染并选中新大纲；
  - 提示“已保存并关联到 Rxxxxx”。
- 若同名文件存在，服务端返回 `2009`；前端提示确认后再用 `overwrite: true` 重试。

### 5.3 回归弹窗

- 打开时调用 `/regressions/preflight`（或带 ids 的 POST）。
- 显示 `已就绪 N / 缺失 M`；缺失项列表包含 `outline-missing` / `url-missing`。
- 缺失时禁用提交，提供“去运行测试”或“生成大纲”的入口（首期可只提示，不批量生成）。

## 6. CSS 修复

在 `plugins/witops-workbench/panel/app.css` 末尾追加/覆盖：

```css
#test-dialog {
  width: min(560px, calc(100vw - 32px));
}

#test-form {
  width: 100%;
  min-width: 0;
}

#test-dialog select,
#test-dialog input {
  min-width: 0;
  max-width: 100%;
}

#test-dialog option {
  overflow: hidden;
  text-overflow: ellipsis;
}
```

- 保留现有 `dialog form` 规则供回归弹窗使用；ID 选择器优先级更高。
- 不设置 `overflow-x: hidden`，避免掩盖真实溢出。
- 长选项文本由原生 select 截断；不把完整 URL 放进 option。

## 7. 兼容与迁移

- 首次启动：manifest 不存在 → `listOutlines` 返回文件 + 空元数据；不自动写 manifest。
- 旧大纲迁移：
  - 用户在「自动化测试」面板或 API 调用 `outlines.associate`，把 `dm-business-category.md` 关联到 R35627。
  - 可选 P2：UI 展示候选（编号/标题/文件名相似度），一键确认。
- 旧 binding：
  - `binding:<taskKey>` / `binding:requirement:<id>` 继续作为第 2/3 优先级。
- 旧 `defaultOutline`：
  - 仍然生效，但只作为 `allowDefaultOutline` 的显式回退；不再自动用于需求/任务。
- 运行记录：
  - `runs.start` 返回的 `outline` 仍是文件名；`runs.list` / `runs.get` 不受影响。
- 回滚：
  - 代码回滚即可；manifest 是新增文件，旧代码会忽略它。
  - 若需要彻底回滚，删除 `outlines.manifest.json` 不影响 `.md` 文件。

## 8. 测试策略

- scenario-copilot L3：
  - 临时 `outlinesDir` + 两个 `.md` 文件 + 无 manifest → `/outlines` 返回两条无关联记录。
  - `POST /outlines/associate` 关联 R35627 → `/outlines` 返回 `requirementIds`；`/outlines/resolve` 返回 `requirement-meta`。
  - `POST /outlines/save` 带关联 → 文件与 manifest 写入；同名 `overwrite:false` 返回 2009。
  - 写入损坏 manifest → `/outlines` 仍 200，不抛错。
  - `POST /runs` 需求 subject + 无 outline → 2002 + `needOutline`。
  - `POST /regressions/preflight` 缺 outline/URL → `missing` 原因正确。
- witops-workbench L3（如可行）：
  - 用 fixture 提供 `scenario.copilot` 和 `witops.workitems`，验证 `/test-defaults`、`/tests` 无大纲错误、`/regressions/preflight`。
  - 若 fixture 成本过高，至少覆盖 `/test-defaults` 与 `/tests` 的错误路径，并在实现文档中说明未覆盖的 panel E2E。
- 手工 E2E：
  - Playwright 打开 4403 的 WitOps 工作台，1006px 视口打开弹窗，断言 `scrollWidth === clientWidth`。
  - R35627 无关联 → 生成 → 预览 → 保存 → 自动选中 → 运行；重新打开自动选中。
  - 回归弹窗缺失提示。
- 命令：
  - `yarn test:plugins`
  - `yarn format:check`（如改动格式）
  - `node --check plugins/scenario-copilot/index.js plugins/witops-workbench/index.js`（或直接跑测试）

## 9. 风险与取舍

- **不做自动生成**：LLM 生成慢且质量需人工确认；采用预览后保存。Worktree 任务的“完整流程”在运行测试入口闭环，而不是 dispatch 时自动执行。
- **需求级优先**：避免同一需求下多个任务各生成一份大纲造成回归碎片化；任务级作为可选。
- **manifest 与文件可能漂移**：列表以实际文件为准，孤立条目忽略；不自动删除用户文件。
- **多候选**：首期用 binding + active/updatedAt 选择；UI 展示候选，后续再加“设为默认”。
- **目标地址不写入 manifest**：避免把 FAT/本地 worktree 地址固化；地址仍按运行时解析。
