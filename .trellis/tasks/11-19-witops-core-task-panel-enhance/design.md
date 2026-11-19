# 设计：WitOps 任务面板增强

## 1. 边界

只改：

- 宿主最小扩展：
  - `packages/server/actions.js`：`createTask` 透传 `--parent`。
  - `packages/server/plugins/task-service.js`：`create` 接受 `baseBranch` / `parentDir`。
  - `packages/server/plugins/core-capabilities.js`：`trellis.projects.branches`（只读本地分支，15s 缓存）。
- 插件：
  - `plugins/witops-core/witops-client.js`：`nodeTaskDetail`、`childTask`。
  - `plugins/witops-core/mapper.js`：`typeName`、`taskMarkdown`、`prd` 占位、`meta.witops.parentBusinessId`。
  - `plugins/witops-core/dispatch.js`：filters、children、preview、create。
  - `plugins/witops-core/index.js`：`/mine` 筛选、`/filters`、`/projects` 分支、dispatch 参数。
  - `plugins/witops-core/panel/{index.html,app.js,app.css}`。
  - `plugins/witops-core/plugin.json`：`requires` 增加 `trellis.projects.branches`，`types` 默认 `[0,2,3,4]`。
- 测试：`plugins/witops-core/test/{index.test.js,fixtures/witops-fixture.js}`，`packages/server/test/plugin-real-task.test.js` 补分支/父子用例。

不改：

- `panel/team.html` / `panel/team.js`（team 面板仍只读）。
- `packages/server/plugin-ui/v1/**`（只消费现有组件）。
- `task.py` 的创建语义与目录命名规则。
- witops-web 源码（只作为接口依据）。

## 2. 数据契约

### 2.1 `GET /mine`

Query：

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `types` | `0,2,3,4` | 缺省取 `config.types` |
| `code` | string | 平台编号 |
| `name` | string | 标题关键词 |
| `priority` | `1,2,3,4` | 平台优先级字典 code |
| `status` | `1,3` | 平台状态 code，缺省 `config.status` |
| `categories` | string | 缺陷分类 code，仅 type=2 有意义；因后端 `business.category` 列缺失，改为本地过滤 |
| `allUsers` | `1` | 不注入当前用户 |
| `refresh` | `1` | 跳过缓存 |

返回在原有 `{ userId, items, fetchedAt }` 上追加 `types`、`filters`；每个 item 追加：

```json
{
  "kind": "workOrder|bug|requirement|task",
  "kindLabel": "工单|缺陷|需求|任务",
  "typeName": "缺陷",
  "category": "功能缺陷",
  "categoryCode": "0",
  "module": "看板",
  "iteration": "迭代 7",
  "mentionTime": "2026-11-01 08:00:00"
}
```

缓存 key：`mine:<types>:<JSON filters>`，避免不同筛选互相污染。

### 2.2 `GET /filters`

```json
{
  "types": [{ "type": 3, "name": "需求" }],
  "priorities": [{ "code": "1", "name": "P0" }],
  "statuses": [{ "code": "1", "name": "待处理" }],
  "categories": [{ "code": "1", "name": "功能缺陷" }]
}
```

优先级来自 `priority` 字典；缺陷分类来自 `bugCategory` 字典；状态为内置常用集合。

缺陷分类不在 `nodeTask/page` 请求中下发：平台 mapper 把 `categories` 映射到不存在的 `business.category` 列，任何分类值都会 500（`Unknown column 'business.category' in 'where clause'`），官方前端同样会触发。插件改为按 type=2 拉取最多 `categoryScanSize`（默认 200）条记录，再按 `categoryDicConfigCode` / `categoryCode` 或分类名称本地匹配；超过扫描上限的缺陷不会被筛出，属已知限制。

### 2.3 `GET /projects`

每个项目追加：

```json
{ "repositoryId": "repo", "name": "Repo", "path": "...", "branch": "main", "branches": ["dev", "main"] }
```

`branches` 来自 `trellis.projects.branches`；失败时返回空数组，面板退化为手填。

### 2.4 `POST /dispatch` / `POST /dispatch/preview`

`items[]` 新增可选字段：

| 字段 | 说明 |
| --- | --- |
| `baseBranch` | 本地基线分支 → `task.py create --base-branch` |
| `priority` | 覆盖平台优先级（`P0`–`P3`） |
| `includeChildren` | 需求是否拆分父子任务，缺省 true |

`preview` 返回的 `draft` 增加 `type`、`typeName`、`taskMarkdown`；`children` 返回需求的直接子任务摘要。

### 2.5 下发结果

单条结果：

```json
{
  "status": "imported|duplicated|skipped|failed",
  "taskKey": "repo::11-19-T10001",
  "children": [{ "businessId": "10002", "status": "imported", "taskKey": "repo::11-19-T10002" }],
  "childSummary": { "imported": 2, "duplicated": 0, "skipped": 0, "failed": 0 }
}
```

## 3. 关键流程

### 3.1 创建任务

1. 面板 `POST /dispatch/preview` 拿 `draft.taskMarkdown`、`children`。
2. 用户确认项目、分支、截止日期、优先级、是否拆分。
3. 面板 `TrellisUI.confirm()` 二次确认。
4. `POST /dispatch`：
   - `prepare()` 拉详情（`nodeTask/detail` → 回退）与字典。
   - `buildTaskDraft()` 生成 `task.md`、占位 `prd.md`、meta。
   - `ctx.tasks.create({ baseBranch, extraFiles: { 'task.md': ... }, prd: 占位 })`。
   - type=3 且 `includeChildren !== false`：读 `childTask`，逐个 `createTaskRecord({ parentDir })`。

### 3.2 父子任务

- 父任务 slug 用需求编号（如 `R3001`），子任务 slug 用子任务编号（如 `T10002`）。
- `task.py create --parent <parentDir>` 负责双向链接（父 `children[]`、子 `parent`）。
- 子任务 `meta.witops.storyId = requirementId`、`meta.witops.parentBusinessId = requirementId`。
- 已存在父任务：`createChildren` 仍执行，已存在的子任务标记 `duplicated`，缺失的补建。

### 3.3 幂等

- 去重真源仍是 `task.json.meta.witops.businessId`（`links.find`）。
- 父任务已存在时不再拉父详情，只拉子任务列表与缺失子任务详情。
- 子任务失败不改变父任务结果，`childSummary` 单独统计。

## 4. 取舍

| 决策 | 理由 |
| --- | --- |
| 只写 `base_branch` | 与 `task.py create --base-branch` 一致；不产生工作区副作用 |
| 默认拆子任务、可关闭 | 符合「需求已拆分」的日常用法，同时保留只建父任务的退路 |
| `prd.md` 写占位 | 避免 `task.py` 默认模板被误当正式 PRD；明确指向 trellis-brainstorm |
| `task.md` 用 `extraFiles` | 宿主已有路径越界校验与原子写入，不需要新能力 |
| 子任务串行创建 | `task.py` 会改父 `task.json.children`，并发会互相覆盖 |
| 预览用 `<pre>` 文本 | sandbox 面板不解析 HTML，避免注入与样式污染 |

## 5. 兼容与回滚

- 旧调用方不传 `types`/`filters` 时行为与之前一致（只多拉了 0/2 两类）。
- 旧环境没有 `/nodeTask/detail`、`/task/childTask` 时分别回退与降级为空子任务。
- 回滚点：宿主 3 个文件与插件 6 个文件互相独立；先回滚插件即可恢复旧面板，宿主新增参数对旧调用方无影响。

## 6. prd.md → task.md 的下游影响

WitOps 下发的任务把平台原文写在 `task.md`，`prd.md` 只放占位提示。凡是把 `prd.md` 当作任务内容真源的消费者都要改为优先读 `task.md`，并识别占位 PRD：

| 位置 | 原行为 | 处理 |
| --- | --- | --- |
| `plugins/witops-workbench/index.js` `readTaskPrd` / `outlineContext` | 只读 `prd.md` 拼测试大纲 | 新增 `readTaskSource` 读 `task.md`；占位 PRD 跳过 |
| `packages/server/plugins/task-service.js` `fileDorGapCount` | `prd.md` 长度 ≥ 20 即视为已填 | 识别占位文本，占位计为 DoR 缺口 |
| `packages/server/loader.js` `buildTaskFiles` / `buildArtifactSummary` | 只暴露 prd/design/implement 等产物 | 增加 `source`（`task.md`）产物与 `hasSource` |
| `packages/web/.../TaskDetailDialog.tsx` `ARTIFACTS` | 任务产物列表无平台原文 | 增加「平台原文」入口 |
| `plugins/acp-dispatch/index.js` `DEFAULT_PROMPT` | 提示 agent 先读 `prd.md` | 改为先读 `task.md`（若存在）再读 `prd.md` |
| `plugins/scenario-copilot/index.js` | 只读 `meta.witops_task_id` | 无影响 |

占位 PRD 的识别约定：内容包含 `prd.md 尚未生成` 或 `平台原文在 \`task.md\``。`loader.js` 的 `hasMeaningfulPrd` 只认 `## Requirements` / `## Acceptance Criteria`，占位 PRD 会自然判为未初始化，执行投影因此阻止在 brainstorm 前进入实现，这是预期行为。
