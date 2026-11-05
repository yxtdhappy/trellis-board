# Judge：Playwright Parity 测试方案

## 1. 目的

在迁移任何页面之前，先建立一个能同时评估 **旧实现** 和 **新实现** 的裁判。  
没有裁判，就没有“迁移完成”的机械退出条件。

裁判不是：

- 源码字符串测试
- 只测纯函数的单元测试
- 只跑 `vue-tsc`
- 只看截图是否相似

裁判是：

- 同一组用户流程，在旧应用和新应用上执行
- 同一组 API 契约，在新旧前端请求下表现一致
- 权限、错误、分页、团队隔离结果一致
- 测试本身经过“旧应用全绿 + 故意破坏必红”的验证

## 2. 当前测试盘点

| 类型 | 现状 | 能否作为 judge |
|---|---|---|
| 纯函数测试 | `tests/team-web.test.js` 中 import `public/team-client.js` 的部分；`tests/slug.test.js`、`tests/execution-filter.test.js`、`tests/markdown.test.js` | 可以保留为回归，但不能证明 UI 行为 |
| 源码字符串测试 | `tests/team-web.test.js` 读取 `public/app.js`、`index.html` 并 `assert.match` | **不能**；重构会误伤，且不验证行为 |
| 服务端测试 | `tests/team-core.test.js`、`tests/team-web.test.js` 的 API 部分等 | 可作为 API 契约基础 |
| 浏览器 E2E | 当前没有 | **必须新建** |

## 3. 裁判分层

### L1：API 契约测试

目标：证明前端依赖的 HTTP 语义不变。

覆盖：

- 登录/登出/`/api/auth/me`/改密
- `/api/runtime` 的 standalone/team 分支
- `/api/board`、`/api/task`、`/api/tasks`
- `/api/tasks/execution`、`/api/tasks/stage`、`/api/tasks/assign`、`/api/tasks/dependencies`
- `/api/team/projects`、`/api/team/status`、`/api/assignments`
- `/api/admin/*`（用户、项目、Agent、审计）
- Git operation 轮询
- 401/403/404/409/422 错误结构

实现位置：

```text
frontend/tests/api/          # Playwright request 或 node:test + fetch
```

要求：

- 使用临时数据库/临时仓库 fixture，不碰真实 `data/board.sqlite`。
- 同一组断言在旧代码和新代码下都能运行；API 测试本身不依赖前端实现。
- 响应字段、状态码、错误 `code` 必须精确断言，不用 `truthy` 代替。

### L2：Playwright UI Parity

目标：同一用户流程，在旧页面和新页面上得到相同用户可见结果。

运行方式：

```text
旧应用：http://127.0.0.1:<port>/
新应用：http://127.0.0.1:<port>/next
```

要求：

- 旧应用和新应用连接**同一个测试后端**、同一份 fixture 数据。
- 每个场景写成参数化测试：`for (const app of [legacy, next])`。
- 断言优先用 role/name/text；旧页面没有稳定选择器时，允许添加仅用于测试的 `data-testid`，但必须同时加在旧/新两版，且单独提交。
- 不使用固定等待；用 `expect.poll` 或 `waitForResponse`。
- 随机值（任务 ID、时间戳、operation ID）统一归一化后再断言。
- 不比较完整 DOM；比较关键可见文本、状态、URL、API 调用结果。

### L3：新行为验收

SSE、多团队切换、新用户管理、密码 6 位策略等旧版没有的行为，单独放在：

```text
frontend/tests/e2e/new-behavior/
```

这些测试不计入“旧版 parity 通过数”，但计入切片 DoD。

### L4：辅助检查

- 可访问性 smoke：dialog 焦点、Esc 关闭、表单 label、错误 `role=alert`。
- 视觉截图：可选，只做人工参考，不作为 gate。
- 性能：首屏、列表渲染、长文档预览，记录基线即可。

## 4. 场景清单

### 4.1 认证与会话

| ID | 场景 | 旧入口 | 新入口 | 断言 |
|---|---|---|---|---|
| AUTH-01 | 正确密码登录 | `/login.html` | `/login` | 跳转 `returnTo` 或 `/` |
| AUTH-02 | 错误密码 | `/login.html` | `/login` | 错误可见、不跳转、不清空用户名 |
| AUTH-03 | 未登录访问 board | `/` | `/next` | 跳登录并带 `returnTo` |
| AUTH-04 | 登出 | board | board | 回登录页，后续 API 401 |
| AUTH-05 | 改密成功 | password dialog | password dialog | 成功提示、当前会话保持、旧密码失效 |
| AUTH-06 | 改密失败 | password dialog | password dialog | 错误可见、不关闭、不丢输入 |
| AUTH-07 | 会话过期 | board | board | 下一次请求跳登录 |

> 密码长度按最新 PRD 验收；旧 UI 的 12 位提示属于 `NEW-BEHAVIOR`，不要作为 parity。

### 4.2 Board 只读

| ID | 场景 | 断言 |
|---|---|---|
| BOARD-01 | 项目列表 | 项目数、名称、激活态一致 |
| BOARD-02 | scope 切换 | 任务集合按预期变化 |
| BOARD-03 | 执行视图 | 视图列表、当前视图、计数一致 |
| BOARD-04 | 搜索 | 匹配任务、空状态一致 |
| BOARD-05 | 项目筛选 | 只显示选中项目 |
| BOARD-06 | 负责人/优先级/阶段/标签筛选 | 结果集合一致 |
| BOARD-07 | 任务卡字段 | 标题、负责人、阶段、截止日、标签、风险徽标 |
| BOARD-08 | 分页/加载更多 | 游标前进、无重复、无丢失 |
| BOARD-09 | 空状态 | 文案和可操作入口 |
| BOARD-10 | 归档排序 | 归档任务顺序、时间格式 |

### 4.3 任务详情

| ID | 场景 | 断言 |
|---|---|---|
| TASK-01 | 打开详情 | 标题、状态、负责人、项目 |
| TASK-02 | 产物切换 | PRD/Design/Implement/报告内容与截断 |
| TASK-03 | 长文档 | 40,000 字符截断提示 |
| TASK-04 | 复制任务名 | 剪贴板内容、按钮反馈 |
| TASK-05 | 依赖展示 | 阻断关系、解除入口 |
| TASK-06 | 键盘/焦点 | Esc 关闭、焦点回到触发按钮 |

### 4.4 Board 写操作

| ID | 场景 | 断言 |
|---|---|---|
| WRITE-01 | 创建任务 | 校验、成功、slug、列表刷新 |
| WRITE-02 | 创建失败 | 错误可见、幂等键复用 |
| WRITE-03 | 派发 | 成员限制、成功、版本冲突 |
| WRITE-04 | 阶段操作 | 阶段变化、事件记录、撤销 |
| WRITE-05 | 依赖创建/解除 | 关系变化、阻断提示 |
| WRITE-06 | 执行计划 | 截止日/里程碑/标签保存 |
| WRITE-07 | 保存视图 | 保存/复用/删除 |
| WRITE-08 | WIP 设置 | 1–9 限制、提示 |
| WRITE-09 | Git operation | pending/push/applied/failed/retry |

### 4.5 团队视图

| ID | 场景 | 断言 |
|---|---|---|
| TEAM-01 | 团队看板加载 | 项目、成员、任务计数 |
| TEAM-02 | 团队筛选 | 项目/负责人/阶段/标签 |
| TEAM-03 | 待接受列表 | 数量、任务信息 |
| TEAM-04 | 接受任务 | 状态变化、列表刷新 |
| TEAM-05 | 权限拒绝 | 403 文案、无写入口 |
| TEAM-06 | 分页 | 前进/后退、游标、无重复 |
| TEAM-07 | Git 状态 | 状态文案、重试入口 |
| TEAM-08 | 团队切换 | 旧团队数据不可见、当前团队标识 |

> TEAM-08 在多团队 API 就绪后归入 `NEW-BEHAVIOR`；如果先按单团队实现，则只做当前团队上下文测试。

### 4.6 Admin

| ID | 场景 | 断言 |
|---|---|---|
| ADMIN-01 | 用户列表 | 用户名、显示名、状态、团队 |
| ADMIN-02 | 创建用户 | 必填、密码规则、团队多选 |
| ADMIN-03 | 编辑用户 | 显示名/团队/角色 |
| ADMIN-04 | 启停用户 | 状态、会话失效 |
| ADMIN-05 | 重置密码 | 新密码生效、旧会话失效 |
| ADMIN-06 | 项目管理 | 接入/移除/成员 |
| ADMIN-07 | Agent | 配对码、批准、撤销 |
| ADMIN-08 | 审计 | 过滤、分页、脱敏 |
| ADMIN-09 | secret/approval dialog | 确认、取消、错误 |

### 4.7 新行为（不计入旧版 parity）

| ID | 场景 | 来源 |
|---|---|---|
| NEW-01 | SSE 首次连接 | `11-05-client-server-push` |
| NEW-02 | 断线重连 + `Last-Event-ID` | 同上 |
| NEW-03 | 事件去重 | 同上 |
| NEW-04 | 游标过期触发 resync | 同上 |
| NEW-05 | SSE 不可用降级轮询 | 同上 |
| NEW-06 | 多团队切换隔离 | `11-05-team-isolation` |
| NEW-07 | 新用户管理字段/权限 | `11-05-user-registration` |
| NEW-08 | 密码最少 6 位 | 最新用户 PRD |

## 5. 裁判自检（必须做）

### 5.1 旧应用全绿

```text
1. 启动测试后端 + 旧应用
2. 跑完整 judge
3. 期望：所有现有行为场景通过
```

如果旧应用自己失败，先修 judge 或确认是环境/数据问题；不要用“旧版本来就有 bug”直接跳过，除非标 `BUG(legacy)` 并记录。

### 5.2 故意破坏必红

在**旧应用**上做一组临时 mutation（不提交）：

- 把登录成功跳转改错
- 把任务筛选条件去掉
- 把权限判断反转
- 把分页游标清空
- 把错误提示吞掉

每次 mutation 后跑 judge，确认对应场景失败。  
如果破坏后测试仍然全绿，说明 judge 是假裁判，必须修测试。

### 5.3 新旧同跑

同一组场景分别跑旧应用和新应用：

```text
legacy: N/N pass
next:   N/N pass
```

新应用允许 DOM 不同；断言只针对用户可见行为和 API 语义。

## 6. 测试数据与隔离

- 使用临时目录 + 临时 SQLite；不要使用 `data/board.sqlite`。
- 每个 worker 独立数据库/端口，避免并发污染。
- Git 操作使用本地 bare repo fixture；不要访问真实远端。
- 测试账号使用固定 fixture，不依赖真实管理员。
- 测试结束后清理临时目录；Playwright trace 仅在失败时保留。

## 7. 文件与命令（待实现）

建议路径：

```text
frontend/
  playwright.config.ts
  tests/
    api/
      auth.spec.ts
      board.spec.ts
      team.spec.ts
      admin.spec.ts
    e2e/
      auth.e2e.ts
      board-read.e2e.ts
      board-write.e2e.ts
      team.e2e.ts
      admin.e2e.ts
      new-behavior/
```

命令占位：

```bash
npm --prefix frontend run test:unit
npm --prefix frontend run test:e2e
npm --prefix frontend run typecheck
npm --prefix frontend run build
```

## 8. Gate

在以下条件全部满足前，不允许开始 Step 1 / 第一个业务切片：

- [ ] `JUDGE.md` 场景清单被人工确认。
- [ ] L1 API 契约测试可运行。
- [ ] L2 Playwright harness 可运行。
- [ ] 旧应用全绿，count 已记录。
- [ ] 至少 5 个故意破坏都被抓到。
- [ ] 测试数据隔离方案确认。
- [ ] 人工 gate 签字。

完成后把结果写入：

```text
migration/reports/00b-judge.md
```

包含：旧应用通过数、破坏用例数、未覆盖场景、已知假阴性。
