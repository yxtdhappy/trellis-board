# HTTP 与文件边界

## API 路由

[server/index.js](../../../server/index.js) 当前路由：

| 方法与路径 | 用途 | 成功状态 |
| --- | --- | --- |
| `GET /api/board` | 优先返回本地缓存，必要时后台刷新 | 200 |
| `GET /api/board/events` | Board 任务变更 SSE；单机免登录，团队使用 Session Cookie | 200 |
| `GET /api/board/status` | 刷新、队列和监听状态 | 200 |
| `GET /api/health` | 健康检查与进程 ID | 200 |
| `POST /api/board/refresh/start` | 后台启动完整扫描 | 202 |
| `POST /api/board/refresh` | 同步等待完整扫描 | 200 |
| `GET /api/repositories` | 白名单项目 | 200 |
| `POST /api/repositories/pick-folders` | 调用桌面文件夹选择 | 200 |
| `POST /api/repositories` | 批量加入白名单 | 201 |
| `DELETE /api/repositories` | 从白名单移除，不删除源目录 | 200 |
| `POST /api/task` | 获取任务详情 | 200 |
| `POST /api/tasks` | 通过目标仓库 `task.py` 创建任务 | 201 |
| `POST /api/tasks/assign` | 更新 `task.json.assignee` | 200 |
| `PUT /api/tasks/stage` | 记录人工阶段 | 200 |
| `PUT /api/tasks/execution` | 保存任务截止、里程碑和标签 | 200 |
| `POST /api/tasks/dependencies` | 创建任务阻断依赖 | 201 |
| `DELETE /api/tasks/dependencies` | 解除活动阻断依赖并保留历史 | 200 |
| `POST /api/tasks/undo` | 撤销当前任务最近一次未撤销的可逆操作 | 200 |
| `GET /api/board/settings` | 读取指定团队作用域的 WIP 软上限 | 200 |
| `PUT /api/board/settings` | 保存指定团队作用域的 WIP 软上限 | 200 |
| `GET /api/saved-views` | 读取指定团队作用域的保存视图 | 200 |
| `POST /api/saved-views` | 创建组合视图 | 201 |
| `PUT /api/saved-views` | 更新组合视图 | 200 |
| `DELETE /api/saved-views` | 删除组合视图 | 200 |

未知 `/api/*` 返回 404 `{ "error": "接口不存在" }`。

## JSON 协议

- `sendJson()` 统一返回 `application/json; charset=utf-8` 和 `cache-control: no-store`。
- `readJsonBody()` 上限为 `1MB`。无请求体视为 `{}`；超限返回“请求体过大”；非法 JSON 返回“请求体不是合法 JSON”。
- API 处理异常在主路由统一捕获，返回 400 和 `{ "error": message }`。
- 前端依赖 `payload.error`，不要改成嵌套错误结构而不更新 `public/app.js` 的 `api()`。

## Board SSE

- 单机与团队 Board 共用 `GET /api/board/events`；团队模式在建立连接和每次心跳时用当前
  Session Cookie 重新校验会话，失效后关闭连接。
- 响应使用 `text/event-stream; charset=utf-8`、`cache-control: no-store`、
  `connection: keep-alive` 和 `x-accel-buffering: no`，初始发送 3 秒重连提示并每 15 秒发送心跳。
- 事件名固定为 `tasks.changed`，数据只含单调版本和生成时间；不携带项目、任务或文件正文。
- 服务端短时间内的多次变更合并广播；客户端收到事件后重新请求现有 REST 快照，权限、筛选、分页和
  ETag 仍由原接口负责。
- 服务关闭时先结束全部 SSE 响应，再关闭 HTTP server，避免活动连接拖住关闭流程。

## 仓库白名单

白名单存放在 SQLite `repositories` 表。首次建库且运行数据目录中的 `repos.json` 不存在时，使用 [server/config.js](../../../server/config.js) 的默认仓库一次性导入。API 返回每项 `id`、`name`、`path`，路径使用 `/`。

[server/repositories.js](../../../server/repositories.js) 的规则：

- 同一路径去重；Windows 路径比较不区分大小写。
- ID 从目录名派生，冲突追加 `-2`、`-3`。
- 新增一个仓库或批量新增前都要确认目标包含 `.trellis`。
- 批量新增任一无效时不写入任何项目。
- 批量插入、删除和删除后的位置重排都在 SQLite 事务中完成。
- 移除项目只改白名单，不删除仓库目录。

### Scenario: 移除看板项目

#### 1. Scope / Trigger

删除项目跨越弹窗、hook、前端 API、HTTP 路由和 SQLite 仓库存储，必须统一使用稳定业务键 `id`。路径 `path` 用于展示和文件扫描，不能代替仓库身份。

#### 2. Signatures

- `ProjectManagerDialog.onRemove(id: string): Promise<void>`
- `useBoard().actions.repositories.remove(id: string): Promise<void>`
- `removeRepository(id: string)` 调用 `DELETE /api/repositories`
- `repositoryStore.remove({ id: string })`

#### 3. Contracts

- 请求体：`{ "id": "<repositories.id>" }`。
- 成功响应：HTTP 200，包含中文 `message` 和被移除的 `repository`。
- 删除范围：白名单记录、对应人工阶段、执行扩展数据和任一侧依赖行。
- 禁止删除：仓库目录、Trellis 任务文件和其他项目的白名单。

#### 4. Validation & Error Matrix

| 条件 | 结果 |
| --- | --- |
| `id` 缺失或为空 | HTTP 400，`缺少项目 ID` |
| `id` 不在白名单 | HTTP 400，`项目不在看板中` |
| `id` 有效 | HTTP 200，事务内移除项目及关联 Board 数据 |
| 只发送 `path` | HTTP 400，`缺少项目 ID` |

#### 5. Good/Base/Bad Cases

- Good：弹窗把列表行的 `row.id` 传给 hook，API 发送 `{ id }`，成功后再读取 `/api/repositories` 和 `/api/board`。
- Base：项目没有关联阶段、执行数据或依赖时，只删除白名单记录。
- Bad：把 `row.path` 当作删除参数，导致所有项目都因缺少 `id` 而失败。

#### 6. Tests Required

- 仓库存储测试：有效 `id` 只删除目标项目并清理关联数据，源目录仍存在。
- HTTP 验证：有效 `id` 返回 200；空 `id` 返回“缺少项目 ID”；未知 `id` 返回“项目不在看板中”。
- 前端构建断言：`ProjectManagerDialog`、hook action 和 API 函数的参数都必须是 `id: string`。

#### 7. Wrong vs Correct

Bad:

```ts
await onRemove(row.path)
api('/api/repositories', 'DELETE', { path })
```

Good:

```ts
await onRemove(row.id)
api('/api/repositories', 'DELETE', { id })
```

### Scenario: 项目 workspace 成员投影

#### 1. Scope / Trigger

项目人员选择跨越扫描 Worker、`/api/board` 项目投影、React 页面和负责人写接口。可委派人员必须来自任务所属仓库的 `.trellis/workspace/<developer>`，不能用跨项目人员并集作为候选。

#### 2. Signatures

- 项目投影：`{ members: string[], workspaceMembers: string[] }`
- `members`：workspace 成员与历史任务负责人/创建人的去重并集，供展示和筛选。
- `workspaceMembers`：仅 `.trellis/workspace` 的直接子目录名，供负责人委派候选。
- `POST /api/tasks/assign`：仍由后端校验目标人员属于任务项目 workspace。

#### 3. Contracts

- 前端按 `task.projectId` 选择对应项目。
- 委派下拉优先使用 `project.workspaceMembers`。
- 旧缓存缺少 `workspaceMembers` 时可回退 `project.members`；两者都缺失时保留原候选列表并依赖后端校验。
- 项目成员变化依赖 `.trellis/workspace` 扫描刷新。

#### 4. Validation & Error Matrix

| 条件 | 结果 |
| --- | --- |
| 候选人属于任务项目 workspace | 后端允许更新负责人 |
| 候选人来自其他项目 workspace | 前端不展示；直接提交时后端拒绝 |
| 当前负责人不在候选列表 | 禁止提交未变化的旧值 |
| `workspaceMembers` 缺失 | 使用兼容回退，不臆造人员 |

#### 5. Good/Base/Bad Cases

- Good：任务 `projectId=mdp-report-service`，下拉只使用该项目 `workspaceMembers`。
- Base：项目没有历史任务参与人时，`members` 与 `workspaceMembers` 可以相同。
- Bad：把全部任务的 `assignee` 并集直接传给详情弹窗，导致跨项目人员可选。

#### 6. Tests Required

- loader 测试：历史任务参与人只进入 `members`，不污染 `workspaceMembers`。
- 前端构建：`Project` 类型同时声明两个成员字段。
- 页面验收：切换不同项目任务后，候选列表随 `projectId` 变化。

#### 7. Wrong vs Correct

Bad:

```tsx
assignees={[...new Set(allTasks.map((task) => task.assignee))]}
```

Good:

```tsx
const project = projects.find((item) => item.id === selected.projectId)
assignees={project?.workspaceMembers ?? project?.members ?? allAssignees}
```

## 写操作边界

### 创建任务

[server/actions.js](../../../server/actions.js) 先校验：

- 标题、描述、负责人和最大长度。
- 优先级仅允许 `P0`、`P1`、`P2`、`P3`。
- slug 使用 [public/slug.js](../../../public/slug.js) 的同一规则。
- 仓库在白名单且包含 `.trellis`。
- 负责人来自目标仓库 `.trellis/workspace`。

校验全部通过后，用参数数组调用目标仓库自己的 `.trellis/scripts/task.py create ... --no-start`。不启用 shell，避免字符串拼接和命令注入。

### 更新负责人

任务目录解析为 `.trellis/tasks` 内的真实路径，并确认没有越出根目录。`.trellis/tasks/archive` 下的任意后代任务都只读，包括目录名以 `..` 开头的路径；读取任何 `task.json` 前必须先拒绝。读取非归档任务的 `task.json` 后只替换 `assignee`，再用临时文件加 rename 原子写回。

### 记录人工阶段

`PUT /api/tasks/stage` 先通过 `resolveTaskLocation()` 校验白名单仓库、`.trellis/tasks` 根和任务存在性，再校验阶段 ID。它写入 SQLite `task_stage` 和 `stage_manual_confirmed` 事件时必须处于同一事务，不修改 Trellis 的正式任务状态。归档任务和身份冲突任务必须在写数据库前拒绝。

### 计划字段与保存视图

`PUT /api/tasks/execution` 只接受 `projectId + taskPath` 定位当前任务，客户端不能直接指定执行身份。服务端在写入前完成日期、里程碑、标签、身份有效性和归档状态校验；计划字段、标签集合与 `task_plan_updated` 事件在同一事务提交。

保存视图只接受结构化筛选 JSON，拒绝未知字段、非对象筛选和类型错误的整数窗口。视图 ID 由服务端生成，内置视图不写入 `saved_view` 表。读、写、更新和删除均接受 `teamId`：`all` 或空值映射全局作用域，具体团队 ID 必须先通过实时 membership 校验。

### 阻断依赖

`POST /api/tasks/dependencies` 使用两个 `{ projectId, taskPath }` 分别定位被阻断方和阻断方；两侧都必须通过白名单、任务根、真实路径和稳定执行身份校验。后端拒绝缺失任务、身份冲突、自引用、空原因、超过 500 字符的原因、重复活动边和任意长度循环。

`DELETE /api/tasks/dependencies` 只接受依赖 ID，在同一事务中设置 `resolved_at` 并追加 `dependency_resolved` 事件。解除不删除原行；已解除的同一活动边以后可以重新创建新行。详情同时返回活动 `blockedBy` / `blocks` 和已结束 `resolvedBlockedBy` / `resolvedBlocks`，历史项的 `durationMs` 固定按 `resolvedAt - createdAt` 计算，不再随当前时间增长。

### 撤销最近操作

`POST /api/tasks/undo` 只接受 `{ projectId, taskPath }`，服务端重新解析白名单任务并完成归档与身份校验。它查找当前任务最新、尚未被 `operation_undone` 标记的可逆 correlation group，核对当前投影仍匹配原事件 `after`，再在同一事务中恢复投影并追加补偿事件。

没有可撤销组、原操作已撤销或当前值已被后续操作改变时返回中文错误且不写数据库。事件窗口截断时，如果最近窗口仍能确认最新未撤销候选组则允许撤销；只有截断导致无法确认候选时才返回中文错误。成功响应包含补偿 correlation、目标 correlation、目标事件 ID、恢复摘要和刷新后的任务详情；原事件不得删除或改写。

### 看板设置

`GET/PUT /api/board/settings` 使用 `teamId`：`all` 或空值读取/写入账号级全局作用域，具体团队 ID 必须属于当前账号。写入值 `executionWipLimit` 必须是 `1`–`9` 的整数。该值写入 `board_state`，服务端只把达到或超过上限投影成提醒，不拦截阶段确认。

### Scenario: 多团队筛选与设备授权

#### 1. Scope / Trigger

- Trigger：认证不再选择活动团队，任务查询、保存视图、WIP、管理台和 Agent 授权改为可跨团队。
- 目标：团队筛选只改变展示范围，不改变 Session 身份；权限每次从 active 团队成员关系和项目成员关系实时计算。

#### 2. Signatures

- Session/runtime：`activeTeamId=null`、`activeTeam=null`、`teamRole=null`、`teams[]`。
- `GET /api/tasks/query`：可选 `teamId=<all|teamId>`，列表行返回 `teamId`、`teamName`。
- `GET|PUT /api/board/settings`、`GET|POST|PUT|DELETE /api/saved-views`：使用 `teamId` 选择全局或团队作用域。
- 管理接口：`/api/admin/{users,projects,agents,audit}` 使用 `teamId`；项目接入、设备撤销和配对码使用具体团队。
- Agent 注册：返回 `teams[]`，兼容字段 `teamId=null`；绑定和事件流仍按项目所属团队校验。

#### 3. Contracts

- `teamId` 缺省或 `all` 表示全部授权团队；具体团队必须存在且为 active。
- 非系统管理员必须是该团队成员；系统管理员可跨 active 团队，但不能访问已停用团队。
- `saved_view.team_id=NULL`、`user_board_state.team_id=''` 表示全局作用域；具体团队写团队 ID。
- 查询 ETag、缓存键和游标绑定包含用户、实际团队作用域、可读项目集合和筛选哈希。
- 系统管理员按团队筛选用户时，`user.teams` 仍返回完整成员关系；筛选只收窄用户列表。
- 单管理团队可省略 `teamId` 自动落位；多管理团队必须显式选择具体团队或 `all`。
- Agent 设备绑定“用户 + 设备”；同一设备可按项目所属团队建立多个绑定，撤销必须限定团队。

#### 4. Validation & Error Matrix

| 条件 | 结果 |
| --- | --- |
| 用户请求未加入或已停用团队 | `403`；为避免泄露团队状态可用 `404` |
| 查询 `projectIds` 与目标团队或可读集合不一致 | `403` |
| 成员被移除后复用旧游标 | `409 CURSOR_INVALID` |
| 多团队管理员缺少 `teamId` | `400 INVALID_INPUT` |
| 非系统管理员撤销设备但未指定具体团队 | `400 INVALID_INPUT` |
| 系统管理员访问已停用团队 | `404 NOT_FOUND` |
| Agent 绑定无权限项目 | 返回 `PROJECT_FORBIDDEN`，不创建 binding |

#### 5. Good/Base/Bad Cases

- Good：双团队用户默认查询全部团队；切换 A/B 后任务、保存视图、WIP、ETag 和游标同步切换。
- Base：单团队成员不显示强制切换器，默认全局作用域只包含该团队数据。
- Bad：用前端隐藏代替服务端授权；从活动团队推导项目；撤销 A 团队设备时同时撤销 B 团队 binding。

#### 6. Tests Required

- 登录 runtime 返回全部 active teams，`/api/auth/team` 返回 `410`。
- `all/A/B` 任务查询、保存视图和 WIP 隔离；跨团队 `projectIds` 被拒绝。
- 成员移除后 runtime、项目和旧游标立即失效。
- 同一设备绑定两个团队项目；按团队撤销只改变目标团队 binding。
- 无 `team_member` 的系统管理员可注册设备、绑定项目、读写游标和订阅事件。
- 系统管理员按团队筛选用户后原样保存，不删除其他团队成员关系。

#### 7. Wrong vs Correct

Wrong：

```js
const scope = actor.activeTeamId || "";
const projects = listProjectsForTeam(scope);
```

Correct：

```js
const scope = resolveTeamScope(db, actor, input.teamId);
const projectIds = readableProjectIds(actor).filter((id) => (
  !scope || projectTeamId(id) === scope
));
```

### Scenario: 团队 Git 凭据与远端探测

- 凭据管理、远端探测和 SSH 主机确认都属于团队管理员接口：
  `/api/admin/git-credentials`、`/api/admin/projects/probe`、
  `/api/admin/git-ssh-hosts/trust`。
- Git 凭据按团队隔离并绑定一个主机和认证类型；项目只能引用同团队、同主机、同认证类型的凭据。
- API、审计和错误详情只返回凭据元数据，不返回 Token、私钥、口令或加密载荷。
- 远端探测先执行 `git ls-remote --symref` 读取分支；指定分支或存在有效默认分支时，再在运行数据目录创建临时 partial clone，读取该分支 tree 中的 Agent 配置目录和 `.trellis` 状态。临时工作副本无论成功失败都必须删除，探测不写数据库；SSH 主机确认仍是独立写操作。
- 运行数据目录中的 `git-credentials.key` 是 Git 凭据密文的主密钥，必须与 `board.sqlite` 一起备份。数据库中的凭据 AAD 绑定团队、主机和认证类型，修改这些列会导致解密失败。
- 当前数据库支持 v6/v7 升级到 v8，升级前备份到运行数据目录的 `backups/`。

### Scenario: 团队项目稀疏检出与自动初始化

- 项目接入请求包含 `agentTools`、`leadUserId` 和 `leadTrellisDevId`；服务端在 clone 前校验工具白名单、团队成员关系和 developer ID，并在克隆后重新读取目标分支 tree，不信任前端传入的“已存在”状态。
- 常规工作副本只检出 `.trellis/`。初始化前临时检出 `.trellis/`、根级配置文件、共享技能目录和 Agent 探测路径，让 `--skip-existing` 能看见远端已有文件；初始化、提交和推送后重新收敛为只检出 `.trellis/`。
- 目标分支已有 `.trellis/` 时，只把缺失 Agent 传给固定的本地 Trellis CLI；没有缺失 Agent 时跳过初始化且不产生空提交。目标分支缺少 `.trellis/` 时仍执行基础初始化。
- `team_project.agent_tools_json` 保存目标分支已有 Agent 与本次成功初始化 Agent 的并集。
- 初始化产物提交并非强制推送到共享分支，成功后项目进入 `provisioning` 并继续工具链摘要审核。
- 初始化失败、文件越界或 push 失败时，不能写入可用项目状态。

## 路径安全

- 仓库路径先 `path.resolve()`，再做白名单匹配。
- 判断目录包含关系必须使用 `path.relative()` 的完整路径段：只有 `..` 或 `..${path.sep}` 前缀才表示父级之外，不能把所有 `..` 字符串前缀都当成越界。
- 消费任务路径的接口必须以目标 `.trellis/tasks` 为父根，不能靠字符串前缀误判兄弟目录；详情、负责人、计划字段和人工阶段接口都必须复用同一运行时校验。
- 静态资源把 URL 映射到 `public/` 后检查最终绝对路径仍在 `public/` 内。
- 浏览器传入的名称、slug、负责人和阶段都要做运行时字符串/枚举校验；不能因前端当前只发送相对路径就省略后端路径校验。

## 持久化写入

Board 的仓库、人工阶段、执行扩展数据、扫描缓存和刷新状态只通过 SQLite facade 写入。单个逻辑操作涉及多行时必须由 `withTransaction()` 包住，不能逐条自动提交。

任务 `task.json` 等目标仓库 JSON 仍使用临时文件加 rename：

```js
const tempFile = `${targetFile}.${process.pid}.tmp`;
fs.writeFileSync(tempFile, payload, "utf8");
fs.renameSync(tempFile, targetFile);
```

目标仓库的新写入点必须有自己的临时路径并确保目标目录存在。不要在目标文件上直接截断后分多次写。

## 静态资源

`public/` 由原生 HTTP 服务托管。`.html` 使用 `no-store`，其他静态文件缓存 `60` 秒。API 之外的未知文件返回 404。当前 `serveStatic()` 没有单独限制 HTTP 方法，并只用 `filePath.startsWith(publicDir)` 做路径前缀检查；修改静态边界时应补真实路径关系判断和越界测试，不要把这个前缀比较当成通用安全守卫。

## 反模式

- 接受任意绝对路径后直接 `readFile` 或 `writeFile`。
- 用 `exec()` 拼接标题、slug 或路径。
- 在路由里直接把 `task.json` 部分写坏。
- 删除项目时删除源仓库。
- 删除项目时只删白名单记录，却遗漏该项目的执行数据或任一侧依赖行。
- 把用户输入原样放进响应头或 HTML。
- `/api/board` 返回详情正文导致首屏响应膨胀。
