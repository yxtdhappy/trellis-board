# WitOps 核心能力（witops-core）

给其他插件提供 业务系统 标准能力的 provider。该目录不进入 Git，按需手动复制/打包分发。

## 能力

| capability | 方法 | 说明 |
| --- | --- | --- |
| `witops.workitems` | `mine` | 当前用户的工单 / 缺陷 / 需求 / 任务，附带 Trellis 关联任务 |
| `witops.workitems` | `requirement.get` / `requirement.query` | 需求详情 |
| `witops.workitems` | `requirement.resolve` | 按 `REQ-xxxx` 编号或标题解析 需求 |
| `witops.workitems` | `requirement.tree` | 需求下的任务树、负责人、工时 |
| `witops.workitems` | `task.listByRequirement` | 按需求批量取任务 |
| `witops.workitems` | `task.get` | 任务详情 |
| `witops.worklogs` | `summary` | 批量汇总需求总工时 |
| `witops.actions` | `requirement.updateStatus` / `task.updateStatus` / `task.assign` | 状态与负责人写操作 |
| `witops.dispatch` | `preview` / `task.create` / `task.batchCreate` / `task.syncRecent` | 预览草稿、创建 Trellis 任务、批量创建、同步最近工作项 |
| `witops.dispatch` | `imported.list` / `auth.login` / `auth.logout` / `auth.status` | 已导入列表与登录态 |

读能力可以被其他插件消费；写能力需要 consumer 在 `requires` 中显式声明。Trellis 关联读取 `task.json` 的 `meta.witops`（由 `witops-intake` 写入）。

## 数据源与筛选

- `types` 默认 `[0, 2, 3, 4]`：`0` 工单、`2` 缺陷、`3` 需求、`4` 任务。发版单（1）与合理化建议（5）暂不支持。
- `GET /mine` 支持 `types`、`code`、`name`、`priority`、`status`、`categories`、`allUsers`、`refresh`；缓存 key 会带上这些条件。
- `categories` 只在 `type=2` 时生效，且不下发给 `nodeTask/page`：平台 mapper 把分类映射到不存在的 `business.category` 列，任何分类值都会 500。插件改为拉取最多 `categoryScanSize`（默认 200）条缺陷后按 `categoryDicConfigCode` / 名称本地过滤。
- `GET /filters` 返回类型、状态、优先级、缺陷分类等可选值，面板用它渲染筛选器。
- 列表项带 `kind`（`workOrder` / `bug` / `requirement` / `task`）、`kindLabel`、`typeName`、`category`、`module`、`iteration` 等字段，供面板做四类视觉区分。

## 创建与预览

- `preview` 返回 `draft`（含 `taskMarkdown`、`prd`、`meta`）与 `children`（需求已拆分的子任务），面板据此预览后再确认创建。
- 已存在任务也返回 `draft`：优先读现有 `task.md`；旧任务没有 `task.md` 时回退 `prd.md` / `task.json.description`，并在面板标注实际来源。
- `task.create` 支持 `baseBranch`（写入 `task.json` 的 `base_branch`，作为 PR 目标分支）、`workType`（`backend` / `frontend` / `fullstack` / `research` / `docs`）、可选 `taskType`（`simple` / `complex` / `research`，不传则由 agent 后续分类）与 `includeChildren`（需求默认连同子任务一起创建）。
- 面板创建对话框只要求任务类型（`workType`）；`workType` 默认按平台分类映射：`前端开发` → `frontend`、`后端开发` → `backend`，其他分类留空，不静默默认后端；`taskType` 不在面板选择、不从分类推断。
- 需求创建时先建父任务，再用 `--parent` 建子任务；已存在父任务时只补建缺失的子任务，单次上限 30 个。
- 本地分支列表来自宿主的 `trellis.projects.branches`（只读 `refs/heads`，15s 缓存）。

## 任务产物契约

WitOps 同步下来的任务目录包含：

- `task.md`：平台原文（front matter + 标题、类型、状态、负责人、优先级、描述、子任务清单）。这是任务内容的真源。
- `prd.md`：一行占位事实（平台原文在 `task.md`，本文件尚未生成），不含流程步骤；正式 PRD 由当前 Trellis 流程生成。
- `task.json`：`meta.witops` 记录 `id`、`type`、`typeName`、`parentBusinessId` 等字段。

下游消费者读取任务内容时应优先读 `task.md`；`prd.md` 若仍是占位内容（含「prd.md 尚未生成」或「平台原文在 `task.md`」），不应作为需求上下文使用。

## 配置

```json
{
  "id": "witops-core",
  "module": "./plugins/witops-core/index.js",
  "enabled": true,
  "config": {
    "baseUrl": "http://witops.weintdata.cn",
    "gatewayPrefix": "/appgw",
    "taskServicePrefix": "/weint-witops-service",
    "adminServicePrefix": "/system-mng",
    "platform": "MOM_WEB",
    "path": "/weint-witops-web/dashboard/mine",
    "userId": 123,
    "credentials": {
      "mode": "token",
      "token": "<token>",
      "account": "",
      "password": ""
    }
  }
}
```

- `credentials.mode` 支持 `token` 或 `password`。`password` 模式会调用 `/system-mng/sysUser/login`，并把 token 存在插件 store 中。
- `userId` 不填时依次从登录响应、JWT 的 `account.id`、`GET /api/sysUser/findUser` 推断。
- `baseUrl` 只填站点根地址，不要带 `/appgw`；路径前缀由 `gatewayPrefix` 等配置拼接。
- 真实 业务系统接口需要 `Weareint-Token`、`Weareint-Platform`、`Weareint-Path` 三个头；后两个默认 `MOM_WEB` / 工作台路径，可按环境覆盖。
- `types` 默认 `[0, 2, 3, 4]`；`type` 是兼容旧配置的单类型回退值。
- 面板入口 `/panel`，宿主通过 `/api/panels` 加载。

## 本地校验

```bash
node --test tests/witops-plugins.test.js
node --test plugins/witops-core/test/index.test.js
```

## 零配置

`plugin.json` 的 `config` 为空：`repositoryId` 缺省时取 `trellis.projects` 的第一个关联项目，
账号密码通过 `accounts-core` 的 `accounts.credentials` 解析；桌面宿主下任务直接写入本地
`.trellis/tasks/**`，再由 Rust `TaskSync` 上行同步。
