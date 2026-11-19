# WitOps 任务面板增强：四类数据源、分支选择、预览与父子任务

## Goal

把 `plugins/witops-core` 从「需求 + 任务」的简单列表升级为可日常使用的任务入口：

- 支持任务、需求、缺陷、工单四类数据源，并有明确的视觉区分。
- 筛选条件覆盖编号、标题、状态、优先级、缺陷分类、负责人范围。
- 创建 Trellis 任务时可选择本地基线分支、预览平台原文、二次确认。
- 平台原文落 `task.md`，`prd.md` 留给 trellis-brainstorm 生成。
- 需求下发时按平台已拆分的子任务生成 Trellis 父子任务。

## Background

现状（`plugins/witops-core`）：

- `mine()` 固定 `types: [3,4]`、`status: '1,3'`、`assignedToUserId = 当前用户`，没有筛选入口。
- 详情只走 `/task/detail`、`/story/detail`，而 witops-web 的四类详情统一走 `/nodeTask/detail`。
- 创建只写 `prd.md`，不支持 `base_branch`，不支持 `--parent`，没有预览与二次确认。
- 面板只有「创建任务」一个动作，创建弹窗只有项目、截止日期两个字段。

witops-web 的类型定义（`src/components/weareint/weDict.js` 的 `detailTypes`）：
`0 工单 / 1 发版单 / 2 缺陷 / 3 需求 / 4 任务`。本期只做 `0/2/3/4`。

## Requirements

- **R1 筛选增强**：`GET /mine` 支持 `types`、`code`、`name`、`priority`、`status`、`categories`、`allUsers`、`refresh`；面板提供对应筛选栏与重置。
- **R2 四类数据源**：默认拉取 `0,2,3,4`；列表项带 `kind`（`workOrder/bug/requirement/task`）与 `typeName`；四类在表格中有颜色、徽标、行首色条区分。
- **R3 本地分支**：创建弹窗选择项目后联动本地分支下拉；分支写入 `task.json.base_branch`（PR 目标），不切换工作分支、不写 `task.json.branch`。
- **R4 内容预览**：列表行与创建弹窗都能预览平台原文（`task.md` 内容）与关键字段；预览不执行 HTML。
- **R5 二次确认与字段扩展**：创建弹窗展示编号、标题、类型、状态、平台优先级、负责人映射、需求；可编辑项目、分支、截止日期、优先级、是否拆分父子任务；确认时再做一次二次确认。
- **R6 task.md / prd.md 分工**：平台原文写 `task.md`；`prd.md` 只写占位提示，指向 `task.md` 与 trellis-brainstorm。
- **R7 需求父子任务**：需求（type=3）下发时读取 `/task/childTask` 的直接子任务，先建父任务再建子任务；已存在父任务时补建缺失子任务；默认拆分，可在弹窗关闭。

## Non-goals

- 不做发版单（type=1）、合理化建议（type=5）。
- 不做工作分支切换、不自动 `git checkout`、不写 `task.json.branch`。
- 不做递归多层子任务；只处理需求的直接子任务。
- 不重写 team 面板（`panel/team.*` 仍只读）。
- 不改变 `task.py` 的创建语义，只在宿主 façade 增加 `baseBranch` / `parentDir` 透传。

## Acceptance Criteria

- [ ] `GET /mine?types=0,2,3,4` 返回四类数据，列表项 `kind` 正确，四类样式可区分。
- [ ] 筛选 `code/name/priority/status/categories/allUsers` 会进入 `nodeTask/page` 请求体；`allUsers=1` 不再注入当前用户。
- [ ] `GET /filters` 返回类型、优先级、状态、缺陷分类选项。
- [ ] 创建弹窗可选择本地分支；下发后 `task.json.base_branch` 等于所选分支。
- [ ] `GET /dispatch/preview` 返回 `draft.taskMarkdown` 与需求的 `children`。
- [ ] 创建后任务目录包含 `task.md`（平台原文）与占位的 `prd.md`（含 trellis-brainstorm 提示）。
- [ ] 需求下发默认创建父任务 + 直接子任务；子任务 `task.json.parent` 指向父目录，`meta.witops.storyId` 指向需求。
- [ ] 重复下发需求不会重复创建父/子任务，并能补建缺失子任务。
- [ ] `yarn test:plugins` 与 `node --test plugins/witops-core/test/*.test.js` 通过。

## Risks

- **分支语义误用**：`base_branch` 是 PR 目标，不是任务归属；文档和 UI 文案必须写「基线分支」。
- **子任务数量**：需求可能拆出大量子任务；单次上限 30，串行创建，避免并发写 `task.json`。
- **详情接口差异**：旧环境可能没有 `/nodeTask/detail`；保留 `/task/detail`、`/story/detail` 回退。
- **负责人映射**：子任务负责人映射不到时按 `skipIfNoAssignee` 跳过，不阻塞父任务。
- **prd.md 占位**：`task.py create` 会先写默认 PRD，插件必须覆盖为占位，避免被误当正式 PRD。
