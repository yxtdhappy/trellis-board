# 计划与注意力：实施报告

## 结论

Slice 1 已完成。计划字段、保存视图、稳定执行身份、可信事件基线、扫描阶段观察和新版执行控制台首屏均已落地；未修改目标仓库的 `task.json`。

## 增量：任务组层级呈现

- 团队视图保留负责人卡、筛选结果和任务计数，在卡内复用 `groupActiveTasks()` 按 `groupKey` 组织成员。
- 多任务组的真实父任务作为组头，显示“父任务 · 项目”和完整子任务数；子任务使用独立子树、缩进、连续树线与分支端点。
- 负责人筛选把父子拆到不同卡时，从完整 `state.board` 的同组成员解析父任务，在子任务卡显示“父任务：标题 · 负责人”；不会把子任务兜底成父任务。
- Kanban 父卡继续保留任务和“计划”按钮操作，子任务改为树线与端点表达；注意力队列保持原排序，仅给组内子任务增加紧凑父路径。
- 任务和“计划”按钮继续保持并列原生按钮，团队视图重绘后同时绑定任务打开和计划编辑动作。

本轮验证：`npm test` 82/82 通过，`server/`、`public/`、`tests/` 全部 JavaScript 语法检查通过，`git diff --check` 通过。真实 `4317` 页面在 1440px 和 860px 下确认团队、Kanban 与注意力层级正确，任务详情和计划编辑器可打开关闭。

## 增量：短高度视口布局

- 主执行区 `.focus-grid` 改为顶部对齐，推荐卡按自身内容高度收缩，不再被右侧注意力队列拉伸。
- 创建任务对话框改为固定五行布局：标题、提示、表单主体、错误消息和 footer 各自占位。
- 短高度下仅 `.create-dialog .form-grid` 纵向滚动，dialog 本身隐藏溢出；错误消息出现时 footer 仍保留在视口内。
- 860px 单列表单、滚动主体和纵向 footer 沿用现有断点，不新增全页面固定高度或横向滚动。

本轮验证已完成：1416×659 下推荐卡高度 `372.39px`、内容所需 `371.72px`，注意力栏 `659.09px`，不再等高；创建弹窗 `580.21px`，主体 `scrollHeight 442px / clientHeight 358px`，错误消息出现后 footer 仍固定可见。860×700 下表单单列滚动，footer 两个按钮无重叠；1440×900 无横向溢出。`npm test` 82/82、全部 JavaScript `node --check` 和 `git diff --check` 均通过。

## 交付内容

### SQLite 与领域层

- schema 从 v1 升级到 v2，新增 `task_execution`、`task_tag`、`saved_view` 和 `task_event`。
- v1 迁移前生成可独立打开的 `data/board.sqlite.v1-backup`；迁移与失败回滚均在事务内执行。
- 新增 `server/execution-store.js`，集中处理计划字段、标签、保存视图、事件和扫描观察。
- 新增 `server/execution-projection.js`，批量组合注意力、计划摘要和详情事件，避免列表 N+1。
- 新增 `server/task-location.js`，统一白名单、任务根、真实路径和身份漂移校验。

### 稳定身份与事件

- `taskKey` 继续表示当前路径；`executionTaskKey` 使用 `projectId::task.id`，归档后保持关联。
- 重复身份可见但隐藏共享扩展数据并拒绝写入。
- 快照后 `task.json.id` 漂移，或快照外新路径复用已有身份时，刷新前拒绝写入。
- 人工阶段投影和 `stage_manual_confirmed` 事件同事务提交。
- 扫描事件与 `scan_cache` 同事务提交，崩溃不会重复观察同一阶段。
- 首次 v2 扫描只建立 `tracking_started`，不补造旧任务历史。

### HTTP

- 新增 `PUT /api/tasks/execution`。
- 新增 `POST/PUT/DELETE /api/saved-views`。
- `/api/board` 批量叠加轻量执行摘要和保存视图。
- `/api/task` 返回完整计划信息与最近 200 条事件。
- 项目删除同步清理 `projectId::` 前缀下的执行扩展数据。
- `SCAN_SCHEMA_VERSION` 从 8 提升到 9。

### 前端

- 按已确认原型更新首屏：保存视图、推荐任务、13 阶段流程胶带、注意力队列和四槽位轻量 Kanban。
- 任务卡片和详情复用计划字段编辑器。
- 支持组合视图创建、筛选、删除和重启持久化。
- 修复小字号对比度、嵌套交互控件、断网英文错误和 favicon 404。
- 1440px、1180px、860px 页面无横向滚动；对话框、键盘焦点和 Escape 关闭已验证。

## 验证

- `npm test`：82 项全部通过。
- `server`、`public`、`tests` 下全部 JavaScript 通过 `node --check`。
- `git diff --check`：通过。
- 临时端口、临时 SQLite 和临时 Trellis 仓库真实 API 验证：
  - 计划字段、标签和保存视图写入后重启可读回。
  - 修改计划字段前后目标 `task.json` SHA-256 不变。
  - 非法日期、空标签、超限标签、`null` 请求体、布尔窗口、非白名单仓库和路径穿越均被拒绝。
  - 身份冲突和身份漂移拒绝写入；刷新后恢复。
  - 人工阶段事件只出现一次，扫描阶段变化只出现一次。
- 浏览器验证：
  - 卡片与详情均可编辑计划字段，失败保留输入。
  - 自定义视图创建、筛选、删除和重启持久化正常。
  - 团队、归档、项目管理、创建任务和空状态正常。
  - 注入 HTML 仅作为文本显示；控制台无页面错误。
  - Lighthouse Accessibility 94、Best Practices 100、SEO 100。剩余可访问性告警来自浏览器扩展注入控件。
- 真实 `4317` 服务验收：
  - 停止旧 PID `32992`，由新 PID `4488` 启动当前代码。
  - 真实 `data/board.sqlite` 从 v1 升到 v2，生成 `data/board.sqlite.v1-backup`。
  - 迁移前后均保持 8 个项目、682 个任务、9 个进行中、673 个归档。
  - 9 个活动任务建立 `tracking_started` 基线，没有补造旧阶段。
  - 真实页面保存当前任务计划字段，并创建“个人执行 MVP”组合视图。
  - 8 个视图的按钮计数、汇总、顶部指标和实际展示任务数一致；修复了任务组展开后的计数分叉。

## 未在本切片处理

- 阻断依赖、DoR/DoD 和软 WIP 属于 `10-30-personal-risk-flow`。
- 撤销和执行指标属于 `10-30-personal-history-insights`。
- `task.py` stderr 原样回传、HTTP 预期 4xx 仍打印堆栈属于既有跨切面问题，建议后续单独处理。

## 运行状态

- 真实 `4317` 服务已由新代码重启，真实 `data/board.sqlite` 已升级到 v2。
- 迁移前一致性快照和迁移演练保存在 `.audit/personal-plan-attention-real-20261030/`。
- 当前任务计划字段为：截止 `2026-10-30`、里程碑“个人执行增强 / Slice 1”、标签 `personal`、`attention`。
- 真实保存视图“个人执行 MVP”保留在 Board SQLite，作为当前个人执行配置。
- 未提交、未推送、未归档。
