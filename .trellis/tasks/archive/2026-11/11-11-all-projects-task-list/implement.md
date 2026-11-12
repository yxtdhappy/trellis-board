# 实施计划

## Preconditions

- 用户明确批准本任务最新的最终规划摘要。
- 执行 `task.py start` 后才允许修改产品代码。
- 保留工作区现有无关改动，不格式化或回滚其他任务文件。
- 不在小阶段结束时构建；所有代码和测试完成后只执行一次最终 Web 构建。

## Steps

### 1. 任务实例身份纯函数

- 新增 `web/src/lib/task-view-key.js` 和 `web/src/lib/task-view-key.d.ts`。
- 新增 `tests/task-view-key.test.js`，覆盖无 taskSpace 的向后兼容、不同 taskSpace 同 taskKey 不相等、组 key 语义。
- 验证：`node --test tests/task-view-key.test.js`

### 2. 后端跨 taskSpace 查询

- 修改 `server/team/task-space-index.js`：
  - 解析单 taskSpace 或跨 taskSpace 查询作用域。
  - 用 `taskSpaces.listReadable()` 得到可读项目和 taskSpace。
  - 校验显式 `projectIds`，无权项目返回 `403`。
  - 将筛选 SQL 的 taskSpace 条件改为集合条件。
  - 排序加入 `task_space_id` 稳定决胜字段。
  - ETag、缓存键和游标绑定 project/taskSpace 集合哈希与筛选哈希。
  - 空 taskSpace 集合返回稳定空页。
  - 新增 `branch` 规范化与转义子串 SQL 条件。
- 保持具体 `taskSpaceId` 查询和新路由响应字段不变。

### 3. 后端回归测试

- 扩展 `tests/team-task-index-v10.test.js`：
  - 同一项目 `main`、`dev` 两个 taskSpace 的任务均可返回。
  - 第二个项目任务可同时返回。
  - `projectIds` 可收窄到单项目全部 taskSpace。
  - 无权或跨团队 projectId 返回 `403`。
  - 单 taskSpace 查询仍只返回该分支。
  - 跨分支同 taskKey 使用 `taskSpaceId + taskKey` 可稳定分页。
  - taskSpace revision 变化后跨范围 ETag 变化。
  - 分支筛选大小写不敏感、支持子串、组合其他筛选，且修改后旧游标失效。
- 扩展 `tests/team-gitless-http.test.js`：`/api/tasks/query` 不带 `taskSpaceId` 返回跨 taskSpace 任务，响应包含项目、团队、分支和 taskSpace。
- 扩展 `tests/team-web.test.js`：`buildTaskQuery()` 在 all/all 时省略 taskSpaceId，在项目 all-branches 时只发送 projectIds，并携带非空 branch。
- 验证：
  - `node --test tests/team-task-index-v10.test.js`
  - `node --test tests/team-gitless-http.test.js`
  - `node --test tests/team-web.test.js`

### 4. 前端查询状态

- 修改 `web/src/hooks/useBoard.ts`：
  - 删除 all 自动改首个项目/分支的行为。
  - `taskSpaceId=all` 时继续请求团队任务。
  - 仅当具体 projectId 已不在当前项目列表时回退。
  - `BoardFilters` 增加默认空字符串的 `branch`。
- 修改 `web/src/features/board/ArchiveView.tsx`：团队模式允许 all taskSpace 归档查询。
- 修改 `web/src/features/board/selectors.ts` 和 `web/src/lib/execution-filter.js`：
  - 增加共享 `branchMatches(branchName, filter)`。
  - 独立模式组合筛选应用与后端一致的 trim、大小写不敏感子串匹配。
- 修改 `web/src/hooks/useArchiveTasks.ts`：把 `branch` 传入团队归档查询依赖。
- 修改 `ExecutionHeader`、`TeamView`、`ArchiveView`：
  - 增加“分支”文本筛选和清空入口。
  - 不新增分支候选请求、正则或多选。
- 扩展 `tests/execution-filter.test.js`：覆盖大小写、首尾空格、任意子串、空筛选和特殊字符字面匹配。
- 验证：Node 参数测试通过；最终由浏览器 Network 和页面行为验证不再出现“自动选择首个 taskSpace”。

### 5. 任务身份和分支展示

- 在 `web/src/features/board/task-view.ts` 使用 `taskGroupInstanceKey()` 分组。
- 在 `BoardPage`、`Kanban`、`AttentionQueue`、`TeamView`、`ArchiveView` 使用 `taskInstanceKey()` 或复合组 key。
- `BoardPage` 详情新鲜数据匹配同时比较 taskSpace 和 taskKey。
- 注意力队列、团队视图、归档行显示分支名。
- 运行前端格式化后确认类型导入和 key 类型正确。

### 6. 规格同步

- 更新 `.trellis/spec/frontend/rendering-and-state.md`：
  - 改为“全部项目展示所有可读 taskSpace 的任务；具体项目展示其所有可读 taskSpace；具体 taskSpace 只展示该分支”。
  - 记录同 taskKey 跨分支必须使用复合身份。
  - 记录分支模糊筛选的服务端和独立模式匹配规则。
- 更新 `.trellis/spec/backend/desktop-realtime-sync.md`：
  - Web HTTP 签名记录 `taskSpaceId` 可选。
  - 记录跨 taskSpace 查询与项目/任务空间作用域哈希契约。
  - 记录 `branch` 可选筛选。
- 更新 `.trellis/spec/backend/http-and-filesystem.md`：
  - 明确 `/api/tasks/query` 的 all 作用域和 `projectIds` 权限规则。
- 仅在本次验证确认后更新，不写未经实现验证的契约。

### 7. 最终验证

- 格式化：`npm run format`
- 格式检查：`npm run format:check`
- 聚焦测试：
  - `node --test tests/task-view-key.test.js tests/execution-filter.test.js tests/team-task-index-v10.test.js tests/team-gitless-http.test.js tests/team-web.test.js`
- 全量测试：`npm test`
- 前端 lint：`npm --prefix web run lint`
- 最终构建仅执行一次：`npm --prefix web run build`
- 本地 E2E：
  - 前端和后端均已改动，执行场景 2：本地启动后端与现代码 Vite 前端。
  - 使用 Chrome DevTools MCP 登录，选择“全部项目”。
  - 验证至少两个项目或两个 taskSpace 的任务同时出现。
  - 验证项目选择、分支选择、搜索、负责人和阶段筛选。
  - 验证分支模糊输入、清空、与其他筛选组合，以及同一任务跨分支时只保留匹配分支。
  - 打开不同分支的同名任务，确认详情请求携带正确 `taskSpaceId`。
  - 检查 Network 中查询请求不再被自动改成首个 taskSpace。
- 若 Chrome DevTools MCP 仍不可用，记录超时证据；只有明确获得用户允许后才改用其他浏览器工具。

## Risky Files

- `server/team/task-space-index.js`：查询、权限、ETag、缓存和游标集中在同一文件。
- `web/src/hooks/useBoard.ts`：筛选 effect 和请求生命周期容易产生重复请求。
- `web/src/features/board/task-view.ts`：分组身份错误会把跨分支任务合并。
- `web/src/pages/board/BoardPage.tsx`：详情刷新可能选中同名任务的错误分支。

## Review Gates

- 首轮后端测试必须先证明无 `taskSpaceId` 不再 400，且单 taskSpace 行为未变。
- 前端改动前先完成纯 key 测试，避免靠 UI 现象猜任务身份。
- 浏览器 E2E 未通过前不得报告“全部项目已修复”。
- 构建只作为编译验证，不能替代真实接口和页面验收。

## Rollback Points

1. 后端查询改动后若权限或分页测试失败，恢复单 taskSpace 入口，不带前端改动进入下一阶段。
2. 前端状态改动后若出现请求循环或旧响应覆盖，恢复 effect 并保留已验证的后端接口。
3. 任务身份改动若影响具体 taskSpace 详情，优先回滚复合 key 消费点，不删除后端跨范围查询。
