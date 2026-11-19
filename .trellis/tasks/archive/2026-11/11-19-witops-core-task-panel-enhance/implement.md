# 实施计划：WitOps 任务面板增强

## 0. 变更边界

- 宿主：`packages/server/{actions.js,plugins/task-service.js,plugins/core-capabilities.js}`。
- 插件：`plugins/witops-core/{witops-client.js,mapper.js,dispatch.js,index.js,plugin.json,panel/*}`。
- 测试：`plugins/witops-core/test/*`、`packages/server/test/plugin-real-task.test.js`。
- 不动 `panel/team.*`、`packages/server/plugin-ui/v1/**`、witops-web 源码。

## 1. 文件清单

### 宿主

- `packages/server/actions.js`
  - `createTask`：`parentDir` → `--parent`。
- `packages/server/plugins/task-service.js`
  - `create`：透传 `baseBranch`、`parentDir`。
  - `fileDorGapCount`：占位 `prd.md` 计为 DoR 缺口。
- `packages/server/plugins/core-capabilities.js`
  - `trellis.projects.branches`：`git for-each-ref refs/heads` + `rev-parse --abbrev-ref HEAD`，15s 缓存。
- `packages/server/loader.js`
  - `buildTaskFiles` / `buildArtifactSummary`：增加 `task.md` 的 `source` 产物与 `hasSource`。

### 插件后端

- `witops-client.js`
  - `nodeTaskDetail` → `/nodeTask/detail`
  - `childTask` → `/task/childTask`
- `mapper.js`
  - `TYPE_LABELS` / `typeLabel()`
  - `buildTaskDraft`：`taskMarkdown`、占位 `prd`、`meta.witops.typeName/parentBusinessId`
- `dispatch.js`
  - `loadFilterOptions()`
  - `fetchPage({ filters })`
  - `fetchDetail()` 统一详情 + 回退
  - `childrenOf()` / `previewChildren()` / `createChildren()`
  - `createOne({ baseBranch, priority, includeChildren })`
  - `normalizeItems()` 新字段
- `index.js`
  - `DEFAULTS.types = [0,2,3,4]`
  - `normalizeItem()`：`kind/kindLabel/typeName/category/module/iteration/mentionTime`
  - `mine({ types, filters })` + 缓存 key
  - `GET /filters`
  - `GET /projects` 带 `branch/branches`
  - `witops.dispatch.task.create` 新参数
- `plugin.json`
  - `requires` 增加 `trellis.projects.branches`
  - `config.types` 改为 `[0,2,3,4]`

### 插件面板

- `panel/index.html`
  - 筛选栏：类型 chips、编号、标题、优先级、状态、缺陷分类、只看我的、重置
  - 表格：类型、优先级、操作（预览/创建）
  - 预览弹窗
  - 创建弹窗：摘要、项目、分支、截止日期、优先级、拆分父子任务、预览
- `panel/app.js`
  - filters state + query 拼装
  - kind 徽标/行色条
  - `/filters` 选项渲染
  - 预览弹窗
  - 分支联动 + `TrellisUI.confirm` 二次确认
- `panel/app.css`
  - 筛选栏、kind 色标、预览块、摘要网格；只用 `--tb-*` token

### 下游消费者

- `plugins/witops-workbench/index.js`
  - `readTaskFile` / `readTaskSource` / 占位感知的 `readTaskPrd`
  - `outlineContext` 增加「平台原文（task.md）」
- `plugins/acp-dispatch/index.js`
  - `DEFAULT_PROMPT` 先读 `task.md` 再读 `prd.md`
- `packages/web/src/features/board/dialogs/TaskDetailDialog.tsx`
  - `ARTIFACTS` 增加 `source`（平台原文）

### 测试

- `test/fixtures/witops-fixture.js`
  - 四类样例、`nodeTask/detail`、`childTask`、`baseBranch` 记录
- `test/index.test.js`
  - 更新 `prd` → `task.md`
  - 新增：筛选请求体、kind、预览 `taskMarkdown`、`base_branch`、父子任务、补建子任务
- `packages/server/test/plugin-real-task.test.js`
  - 新增 `baseBranch` + `parentDir` 断言

## 2. 实施顺序

### P0 宿主能力

- [x] `actions.js` 透传 `--parent`
- [x] `task-service.js` 透传 `baseBranch` / `parentDir`
- [x] `core-capabilities.js` 增加 `trellis.projects.branches`

### P1 插件后端

- [x] `witops-client.js` 增加统一详情与子任务接口
- [x] `mapper.js` 生成 `task.md`、占位 `prd.md`、类型信息
- [x] `dispatch.js` 筛选、统一详情、子任务、预览、创建
- [x] `index.js` `/mine` 筛选、`/filters`、`/projects` 分支
- [x] `plugin.json` manifest 与默认配置

### P1.5 下游消费者

- [x] `witops-workbench` 读 `task.md`、跳过占位 PRD
- [x] `task-service` 占位 PRD 计为 DoR 缺口
- [x] `loader` / `TaskDetailDialog` 暴露平台原文产物
- [x] `acp-dispatch` 默认 prompt 读 `task.md`

### P2 面板

- [x] `panel/index.html` 筛选栏、预览/创建弹窗
- [x] `panel/app.js` 筛选、kind 视觉、预览、分支、二次确认
- [x] 交互微调：筛选自动生效（移除「应用筛选」）、缺陷分类独立第二行、标题列 328px/两行截断、Trellis 徽标换行、刷新移至列表工具条
- [x] `panel/app.css` 新布局与色标
- [x] 缺陷分类本地过滤：不向 `nodeTask/page` 传 `categories`，按 type=2 扫描最多 200 条后按 code/name 匹配；`categoryScanSize` 可配置

### P3 验证

- [x] `node --check` 所有改动 JS
- [x] `node --test plugins/witops-core/test/index.test.js`（32/32）
- [x] `node --test packages/server/test/plugin-real-task.test.js`（2/2）
- [x] `yarn test:plugins`（112 pass / 1 skip）
- [x] `yarn test`（659/659）
- [x] `yarn build`（web + desktop）
- [x] `yarn oxfmt --check` 改动文件
- [x] 手工核对面板 HTML/CSS 无未定义 token
- [x] 4403 实例重启 `witops-core` 后 `/mine?types=0,2,3,4&categories=1` 返回 200（不再 502）
- [x] `client-web` worktree 重新构建，`packages/server/public` 的 main bundle 含 `allow-popups-to-escape-sandbox`
- [x] `client-web` worktree 同步宿主改动：`actions.js --parent`、`task-service` 的 `baseBranch`/`parentDir` 与占位 PRD 判定、`core-capabilities` 的 `trellis.projects.branches`、`loader` 的 `task.md` 产物、`TaskDetailDialog` 的「WitOps 原文」
- [x] 重启 `client-web`（4403）后 `/projects` 返回本地分支，`/mine?categories=1` 返回 200
- [x] worktree `yarn test`（657/657）与 `yarn test:plugins`（107 pass / 1 skip）

## 3. 验证命令

```bash
node --check plugins/witops-core/index.js
node --check plugins/witops-core/dispatch.js
node --check plugins/witops-core/mapper.js
node --test plugins/witops-core/test/index.test.js
node --test packages/server/test/plugin-real-task.test.js
yarn test:plugins
```

## 4. 回滚点

- 宿主 3 个文件可独立回滚：新参数对旧调用方无影响。
- 插件后端与面板分开：回滚面板即可恢复旧 UI，后端仍兼容旧字段。
- 若 `nodeTask/detail` 在目标环境不可用，`fetchDetail` 自动回退，不需要回滚。

## 5. 后续修复（预览已存在任务）

- [x] `previewOne` 命中 `duplicated` 时不再只返回提示：读取现有任务的 `task.md` 放入 `draft.taskMarkdown`。
- [x] 旧任务没有 `task.md` 时回退 `prd.md`，再回退 `task.json.description`；内容超过 20k 截断。
- [x] 面板对 `duplicated + draft` 渲染摘要与原文，并标注实际来源（如「无 task.md，展示 prd.md」）。
- [x] 预览结果没有 `ready` 项时隐藏「去创建」；混合结果只创建 `ready` 项。
- [x] 新增测试：已存在任务预览现有 `task.md`；无 `task.md` 时回退 `prd.md`（33/33）。
