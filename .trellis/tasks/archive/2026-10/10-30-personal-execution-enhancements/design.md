# 个人版执行增强：总体技术设计

## 1. 目标与边界

本设计把看板扩展为单机个人执行控制面，同时保持现有文件事实链不变：

```text
白名单仓库 .trellis/**
  -> loader 扫描与阶段推导
  -> scan worker 生成轻量任务列表
  -> Board SQLite 扩展字段、依赖、视图和事件
  -> HTTP 主线程组合执行投影
  -> 原生 DOM 页面
```

Trellis 文件仍是任务标题、状态、负责人、父子关系、阶段证据和归档位置的来源。Board SQLite 只新增看板自己的计划字段、保存视图、依赖、事件和由事件计算的派生结果。

父子任务关系不得复用为阻断依赖。阻断关系使用单独的数据表和独立校验器。

## 2. 冲刺切分与代码所有权

| 交付 | Schema 终点 | 主要模块 | 前置条件 |
| --- | --- | --- | --- |
| 计划与注意力 | v2 | `database.js`、`metadata.js`、新增 execution store/projection、`loader.js`、`index.js`、`app.js` | 当前 v1 数据可直接迁移 |
| 风险与流动 | v3 | 新增 dependency store、projection、风险 UI | v2 已提交并归档 |
| 追溯与复盘 | v3 | event history、undo、metrics projection、复盘 UI | v2、v3 均已提交并归档 |

后序任务只依赖前序任务已经落地的表和模块；父任务完成最终跨切片集成检查。

## 3. 稳定任务身份

现有 `taskKey = projectId::relativeDir` 会随归档路径变化，不能作为 Board 扩展数据的主键。新增：

```text
executionTaskKey = "${projectId}::${task.id || task.dirName}"
```

- `taskKey` 继续用于当前页面点击、详情请求和父子关系定位。
- `executionTaskKey` 用于计划字段、标签、依赖、事件和指标，确保任务从活动目录归档后仍保留扩展数据。
- 扫描时在整个 board 内检查 `executionTaskKey` 唯一性。发生冲突时，该任务标记 `executionIdentityValid=false`，可见但禁止写入扩展字段，并显示明确原因。
- API 仍接收 `projectId + taskPath`，服务端通过白名单、任务根和最新扫描结果解析任务，不接受浏览器直接提交主键。

## 4. SQLite Schema

### v2：计划、视图与事件

```sql
CREATE TABLE task_execution (
  execution_task_key TEXT PRIMARY KEY,
  due_date TEXT,
  milestone TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE task_tag (
  execution_task_key TEXT NOT NULL,
  tag TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (execution_task_key, tag)
);

CREATE TABLE saved_view (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  filter_json TEXT NOT NULL,
  position INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE task_event (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  execution_task_key TEXT NOT NULL,
  event_type TEXT NOT NULL,
  source TEXT NOT NULL,
  actor TEXT,
  correlation_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  reversible INTEGER NOT NULL DEFAULT 0
);
```

索引：

- `task_tag(tag, execution_task_key)`。
- `saved_view(position, id)`。
- `task_event(execution_task_key, occurred_at, id)`。
- `task_event(correlation_id)`。

### v3：阻断依赖

```sql
CREATE TABLE task_dependency (
  id TEXT PRIMARY KEY,
  blocker_task_key TEXT NOT NULL,
  blocked_task_key TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_by TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE UNIQUE INDEX task_dependency_active_unique
ON task_dependency(blocker_task_key, blocked_task_key)
WHERE resolved_at IS NULL;
```

保存已解除的行用于时长和审计，不物理删除。活动依赖再次创建时先检查是否已存在未解除记录。

### 迁移与启动标记

- 当前 schema v1 直接升级到 v2；风险切片再升级到 v3。
- 新数据库直接创建目标版本。
- 迁移在 `database.js` 的 `BEGIN IMMEDIATE` 中完成；任何一步失败都回滚并拒绝启动。
- v1 -> v2 时写入一次性 `execution_events_started_at`。此前阶段不生成历史事件。
- 每个活动任务在首次被 v2 代码观察时写入 `tracking_started` 系统事件。该事件只代表“从这里开始追踪”，不计入阶段停留或 Cycle Time。
- 大于当前支持的 schema 版本继续拒绝启动。

## 5. 服务端模块

### `server/database.js`

保持 schema 和迁移唯一所有者。新增顺序迁移函数，不把建表散落到业务模块。

### `server/execution-store.js`

负责 Board 扩展数据的领域校验、事务写入和读取：

- 计划字段更新。
- 标签集合替换。
- 保存视图增删改查。
- 事件追加。
- 依赖创建与解除。
- 最近一次可逆操作撤销。

所有用户操作共享一个 `correlation_id`；事务内同时更新投影表并追加事件。

### `server/execution-projection.js`

把文件扫描结果和 SQLite 扩展数据组合为响应投影：

- 列表摘要：计划字段、标签、阻断摘要、注意力原因、DoR/DoD 缺失数量、最近活动时间。
- 详情：完整依赖、事件时间线、撤销可用性、指标完整度与值。
- board 级 saved views。

列表请求一次读取全部 Board 扩展数据并在内存中建索引，禁止按任务逐条查询 SQLite。

### `server/metadata.js`

保留 13 阶段和现有 `task_stage` 投影。人工阶段写入改为同一事务内同时：

- upsert `task_stage`。
- 向 `task_event` 追加 `stage_manual_confirmed`。

### `server/index.js`

新增路由并负责：

- 统一解析 `projectId + taskPath`。
- 调用领域服务。
- 把执行投影叠加到 `/api/board` 和 `/api/task`。
- 写操作成功后清空 board 内存组合缓存，但保留原始扫描缓存。

### `server/repositories.js`

删除项目时，在现有事务内按 `projectId::` 前缀同步清理新表，避免同路径重新加入后继承旧数据。

## 6. HTTP 契约

| 方法与路径 | 用途 | 关键输入 |
| --- | --- | --- |
| `PUT /api/tasks/execution` | 更新截止日期、里程碑和标签 | `projectId`、`taskPath`、`dueDate|null`、`milestone`、`tags[]` |
| `POST /api/saved-views` | 新建保存视图 | `name`、`filter` |
| `PUT /api/saved-views` | 更新保存视图 | `id`、`name`、`filter` |
| `DELETE /api/saved-views` | 删除保存视图 | `id` |
| `POST /api/tasks/dependencies` | 创建阻断关系 | `blockedProjectId/taskPath`、`blockerProjectId/taskPath`、`reason` |
| `DELETE /api/tasks/dependencies` | 解除阻断关系 | `id` |
| `POST /api/tasks/undo` | 撤销该任务最近一次可逆操作 | `projectId`、`taskPath` |

错误继续使用现有 `{ "error": "中文错误信息" }` 和 400 状态。成功写操作返回结果摘要，前端随后重新加载 board 或 detail。

校验约束：

- 截止日期仅接受 `YYYY-MM-DD` 的有效公历日期或 `null`。
- 里程碑最长 100 字符；标签最多 10 个，每个 1–32 字符，去空白后去重。
- 保存视图名称 1–60 字符；筛选对象只接受白名单键。
- 阻断原因 1–500 字符；两任务不能相同。
- 阻断图中不存在环，任务不能依赖自身，双方必须仍在当前 board。
- 撤销只针对当前任务最新仍未撤销的可逆 correlation group。

## 7. 事件与撤销

事件为 append-only：

| 类型 | 来源 | 可撤销 | 用途 |
| --- | --- | --- | --- |
| `tracking_started` | system | 否 | 停滞计算基线，不代表阶段发生 |
| `stage_observed` | scan | 否 | 记录扫描首次观察到的阶段变化 |
| `stage_manual_confirmed` | user | 是 | 人工阶段及停留/回流 |
| `task_plan_updated` | user | 是 | 计划字段与标签前后值 |
| `dependency_created` | user | 是 | 阻断开始 |
| `dependency_resolved` | user | 是 | 阻断结束 |
| `operation_undone` | user | 否 | 指向原 correlation group 的补偿事件 |

撤销通过读取最新未撤销的可逆事件组、在事务内应用其 `before` 值并追加 `operation_undone` 完成。不得删除或覆盖原始事件。

扫描阶段观察：

- 仅在 v2 启用后的扫描之间比较 `derivedStage`。
- 首次 v2 启动只建立基线，不把旧阶段写成迁移时事件。
- 同一任务短时间内多次变化按扫描顺序写入；扫描遗漏导致的缺口在指标完整度中标记为 `partial`。

## 8. 注意力、阻断与指标规则

### 注意力

内置视图由前端/共享纯函数稳定计算：

- P0/P1：优先级属于 `P0`、`P1`。
- 临近截止：有截止日期且 0–3 天内到期，已逾期单独标红。
- 长时间未动：存在最近活动事件，且超过默认 5 天。
- 实现中/检查中：`derivedStage` 对应阶段。

自定义筛选条件使用 AND 组合：优先级、阶段、标签、截止天数、停滞天数、阻断状态。保存视图只持久化筛选，不保存当前点击的临时任务。

### WIP 与 DoR/DoD

- 默认实现中软上限为 2，设置写入 Board state，但不阻止阶段操作。
- DoR 缺失由 PRD 初始化、Design、Implement plan、规划评审证据计算。
- DoD 缺失由实施证据、检查证据、验收项完成度、工作提交和归档证据计算。
- 缺失项最多在列表显示数量，详情展示具体条目。

### 指标

- `Lead Time`：追踪后首次阶段事件到归档/最近事件；标签必须说明为“追踪后”。
- `Cycle Time`：首次进入实现至检查完成或归档。
- 阶段停留：相邻可信阶段事件时长；未闭合阶段计算到 now。
- 回流：阶段索引向更早阶段变化的事件次数。
- 阻断占比：活动/历史阻断区间与已追踪窗口的交集比例。
- 完整度：无足够事件为 `missing`；只有部分阶段或存在扫描缺口为 `partial`；事件覆盖所需节点为 `tracked`。

所有值从事件重算，不缓存无法解释的最终数字。指标加载失败不影响任务详情其余内容。

## 9. 前端设计

已确认原型：`.audit/personal-execution-mockup/index.html`。

首屏结构：

1. 推荐任务卡：标题、优先级、项目、截止、里程碑、标签、流程胶带、下一步按钮。
2. 注意力队列：按截止、阻断解除、检查待收尾、停滞排序。
3. 轻量 Kanban：规划、待放行、实现、检查四个决策槽位。
4. 流动信号：软 WIP、阻断打断、DoR/DoD 缺口、最近可信事件。

实现时复用现有左侧导航和原生渲染模式；不引入框架或构建链。新增样式使用现有 `:root` token 扩展，桌面原型中的视觉层级可落地，但必须兼容现有 1180px/860px 断点。

## 10. 兼容、回滚与运行风险

- `/api/board` 形状变化后提升 `SCAN_SCHEMA_VERSION`，让旧扫描缓存失效。
- schema 升级前备份 `data/board.sqlite*`。旧代码无法直接打开新 schema；回滚必须停止服务并恢复数据库备份。
- 新表不写目标仓库文件，不影响 Trellis CLI 和任务归档。
- 任务稳定身份冲突时不自动合并数据，避免把两个任务的历史串在一起。
- 事件量随个人使用增长；先使用索引和按任务查询，不引入外部数据库。
- 扫描主线程仅做一次批量投影和事件补充，不增加每任务 SQL 查询。

## 11. 关键取舍

- 使用 SQLite 旁路数据而非扩展 `task.json`：避免污染目标仓库和与其他 Trellis 工具冲突。
- 使用稳定执行身份而非当前路径：保证归档后扩展数据仍可用。
- 保留不可变事件及补偿撤销，而非删除历史：指标和审计可重建。
- 指标接受“启用后部分覆盖”，不追求漂亮但虚假的历史完整性。
- 依赖图在个人版使用同步小图校验，不引入图数据库或复杂调度器。
