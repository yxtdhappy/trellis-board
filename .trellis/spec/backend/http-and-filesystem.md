# HTTP 与文件边界

## API 路由

[server/index.js](../../../server/index.js) 当前路由：

| 方法与路径 | 用途 | 成功状态 |
| --- | --- | --- |
| `GET /api/board` | 优先返回本地缓存，必要时后台刷新 | 200 |
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
| `PUT /api/board/settings` | 保存个人 WIP 软上限 | 200 |
| `POST /api/saved-views` | 创建组合视图 | 201 |
| `PUT /api/saved-views` | 更新组合视图 | 200 |
| `DELETE /api/saved-views` | 删除组合视图 | 200 |

未知 `/api/*` 返回 404 `{ "error": "接口不存在" }`。

## JSON 协议

- `sendJson()` 统一返回 `application/json; charset=utf-8` 和 `cache-control: no-store`。
- `readJsonBody()` 上限为 `1MB`。无请求体视为 `{}`；超限返回“请求体过大”；非法 JSON 返回“请求体不是合法 JSON”。
- API 处理异常在主路由统一捕获，返回 400 和 `{ "error": message }`。
- 前端依赖 `payload.error`，不要改成嵌套错误结构而不更新 `public/app.js` 的 `api()`。

## 仓库白名单

白名单存放在 SQLite `repositories` 表。首次建库且 `data/repos.json` 不存在时，使用 [server/config.js](../../../server/config.js) 的默认仓库一次性导入。API 返回每项 `id`、`name`、`path`，路径使用 `/`。

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

保存视图只接受结构化筛选 JSON，拒绝未知字段、非对象筛选和类型错误的整数窗口。视图 ID 由服务端生成，内置视图不写入 `saved_view` 表。

### 阻断依赖

`POST /api/tasks/dependencies` 使用两个 `{ projectId, taskPath }` 分别定位被阻断方和阻断方；两侧都必须通过白名单、任务根、真实路径和稳定执行身份校验。后端拒绝缺失任务、身份冲突、自引用、空原因、超过 500 字符的原因、重复活动边和任意长度循环。

`DELETE /api/tasks/dependencies` 只接受依赖 ID，在同一事务中设置 `resolved_at` 并追加 `dependency_resolved` 事件。解除不删除原行；已解除的同一活动边以后可以重新创建新行。详情同时返回活动 `blockedBy` / `blocks` 和已结束 `resolvedBlockedBy` / `resolvedBlocks`，历史项的 `durationMs` 固定按 `resolvedAt - createdAt` 计算，不再随当前时间增长。

### 撤销最近操作

`POST /api/tasks/undo` 只接受 `{ projectId, taskPath }`，服务端重新解析白名单任务并完成归档与身份校验。它查找当前任务最新、尚未被 `operation_undone` 标记的可逆 correlation group，核对当前投影仍匹配原事件 `after`，再在同一事务中恢复投影并追加补偿事件。

没有可撤销组、原操作已撤销或当前值已被后续操作改变时返回中文错误且不写数据库。事件窗口截断时，如果最近窗口仍能确认最新未撤销候选组则允许撤销；只有截断导致无法确认候选时才返回中文错误。成功响应包含补偿 correlation、目标 correlation、目标事件 ID、恢复摘要和刷新后的任务详情；原事件不得删除或改写。

### 看板设置

`PUT /api/board/settings` 只接受 `executionWipLimit`，必须是 `1`–`9` 的整数。该值写入 `board_state`，服务端只把达到或超过上限投影成提醒，不拦截阶段确认。

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
