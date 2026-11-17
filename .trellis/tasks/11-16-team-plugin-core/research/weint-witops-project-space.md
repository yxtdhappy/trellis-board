# 参考调研：weint-witops-web 的「项目空间」

来源：`/opt/app/work/github/trellis-board/tmp/project/weint-witops-web`（Vue 2 + Ant Design Vue）。
目的：团队版插件 `witops-core` 的「项目 → 任务」读路径要复刻的项目空间语义。

## 1. 项目空间是什么

进入项目空间后，页面顶部固定一个**项目选择器**，下面按项目渲染菜单：

- `src/layouts/header/ProjectSpaceHeader.vue`：`a-select` 选择项目 + `projectSpaceMenuList` 横向菜单；
- 项目列表来自服务端（`projectList`），选中项存 Vuex `account.projectIdSelected`（持久化在 `lockr`）；
- 菜单来自服务端，按当前用户在项目里的角色下发（`projectSpaceMenuList`），不是前端写死；
- 两套视角：
  - **我管理的**：`/weint-witops-web/projectSpace/management/*`
  - **我参与的**：`/weint-witops-web/projectSpace/participate/*`
  （`EXCLUDE_MENU_PATHS` 里能看到 `management/dashboard`、`participate/dashboard`）

`src/store/modules/account.js` 关键 state：

```js
projectIdSelected: null,      // 当前项目
categorySelected: null, typeSelected: null, iterationIdSelected: null,
projectSpaceMenuList: [],     // 项目空间菜单
```

结论：**项目是第一公民，权限与菜单都挂在"项目 + 角色"上**，而不是全局开关。

## 2. 相关接口（`src/services/common.js`）

```text
POST /weint-witops-service/project/findByMaster        # 我管理的项目（首页）
POST /weint-witops-service/project/findByParticipant   # 我参与的项目
POST /weint-witops-service/project/list                # 产品(0)/项目(2) 列表
POST /weint-witops-service/project/detail              # 项目详情
POST /weint-witops-service/projectUserRole/userRole    # 我在项目的角色菜单
POST /weint-witops-service/projectRoleMenu/listByRole  # 角色 → 菜单
POST /weint-witops-service/projectUserConfig/getUserByProject   # 项目人员
POST /weint-witops-service/projectUserConfig/getProjectUserDetail
POST /weint-witops-service/task/task/page              # 项目下任务分页 ★
POST /weint-witops-service/task/detail                 # 任务详情
```

任务分页是本任务的核心读接口，前端调用点：`src/pages/projectSPace/task/index.js` → `this.apis.getProjectTaskList(params)`。

### `task/task/page` 的搜索参数（`getSearchSet` / `getDefaultSearchForm`）

| 参数 | 含义 | 默认 |
| --- | --- | --- |
| `projectId` | 项目 | 当前选中项目 |
| `types` | 类型集合 | `'0,1,5'`（任务/需求/缺陷的前端组合） |
| `code` | 任务 ID | — |
| `name` | 标题 | — |
| `productIds` | 产品（多选） | — |
| `projectModule` / `projectModuleIds` | 模块 | — |
| `tasksStatus` | 状态（多选） | 待处理 1 / 已完成 2 / 草稿 0 / 进行中 3 / 已取消 4 / 待提交 97 / 已关闭 99 |
| `priority` | 优先级 | P0..P3（1..4） |
| `sourceStatus` | 多选状态折叠后的单值 | 由 `tasksStatus` 派生 |

## 3. 角色模型（`src/pages/projectSPace/setting/role/index.vue`）

- 角色属于**项目**（`projectUserRole`），每条角色有菜单/按钮权限（`projectRoleMenu/listByRole`）；
- `record.type === 0` 是内置角色（只读，不能改/删），其余可编辑；
- 角色下挂人员：`a-transfer` 全员工 ↔ 已选员工（`projectUserConfig/addProjectGroupByRole` 等）；
- 同一个 `getPermissionMap()` 同时控制表格操作与按钮显隐。

对 Board 的映射：

| weint-witops-web | Trellis Board team |
| --- | --- |
| 项目 | `team_project`（repository_id） |
| 项目角色 | `project_member.role`（lead / member / read_only） |
| 项目管理员 | `project_member.role = 'lead'` |
| 团队管理员 | `team_member.role = 'admin'` |
| 系统管理员 | `user_account.system_admin = 1` |
| 菜单下发 | 插件面板内的可见性（本期只做「任务」） |

## 4. 对 witops-core 的结论

1. **先选项目，再查任务**：`/projects` 必须在 `/tasks` 之前，且 `projectId` 必填；
2. **"我管理的 / 我参与的"是两个接口**，合并成一个带 `mine` 字段的列表更适合面板；
3. **任务列表默认 `types='0,1,5'`**，跟参考实现保持一致，避免用户觉得"少了一半任务"；
4. 状态/优先级是**中文枚举 → 数字**映射，插件里要做一层词典，不要前端硬编码；
5. 角色菜单（`userRole`）本期只用来判断"是否能进项目空间"，不做完整菜单镜像；
6. 项目 id 与 Board 的 `repository_id` 无关，必须靠 `plugin_project_binding` 显式绑定。
