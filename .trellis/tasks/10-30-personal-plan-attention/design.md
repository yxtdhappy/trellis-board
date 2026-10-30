# 计划与注意力：技术设计

## 1. 边界

本切片只引入个人执行所需的计划字段、保存视图、注意力和可信事件基线。阻断依赖、DoR/DoD、撤销与历史指标留给后序切片。

Trellis 文件继续提供任务身份、标题、状态、负责人、阶段和归档位置。Board SQLite 新增的数据不写回目标仓库。

## 2. Schema v1 -> v2

`DATABASE_SCHEMA_VERSION` 从 1 升到 2。迁移必须在 `database.js` 的单一事务中完成。

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

```sql
CREATE INDEX task_tag_lookup ON task_tag(tag, execution_task_key);
CREATE INDEX saved_view_order ON saved_view(position, id);
CREATE INDEX task_event_timeline ON task_event(execution_task_key, occurred_at, id);
CREATE INDEX task_event_correlation ON task_event(correlation_id);
```

迁移逻辑：

1. 读取 `schema_version`。
2. 版本 1：创建 v2 表，写入 `execution_events_started_at`，更新 schema 版本为 2。
3. 无版本的新库：直接创建全部最新表并写版本 2。
4. 版本大于 2：拒绝启动。
5. 任一步失败：回滚，保留 v1 版本。

## 3. 稳定身份

`loader.js` 为每个任务增加：

```js
executionTaskKey: `${project.id}::${task.id || task.dirName}`
executionIdentityValid: true
```

扫描结果汇总时按 `executionTaskKey` 检查是否唯一。冲突任务仍显示，但 `executionIdentityValid=false`，API 写入返回“任务执行身份冲突，请修正 task.json id”。

定位接口仍接受 `projectId + taskPath`。服务端从最新 board 中找到当前任务及其稳定身份，不接受客户端直接写任意 `executionTaskKey`。

## 4. 领域模型与校验

### 计划字段

- `dueDate`: `null` 或合法 `YYYY-MM-DD`。
- `milestone`: 去首尾空白，最长 100 字符，可为空。
- `tags`: 数组，最多 10 个；每项去空白后 1–32 字符；按大小写不敏感去重，保留首次展示形式。

一次 `PUT /api/tasks/execution` 原子更新 `task_execution`、替换 `task_tag` 集合并追加一个 `task_plan_updated` 事件。

事件 payload：

```json
{
  "before": { "dueDate": null, "milestone": "", "tags": [] },
  "after": { "dueDate": "2026-11-03", "milestone": "MVP", "tags": ["UX"] }
}
```

没有实际变化时不写事件，返回当前值。

### 保存视图

保存的 filter 仅允许：

```text
priorities: P0|P1|P2|P3
stages: 13 阶段 ID
tags: string[]
dueWithinDays: 0..365
staleDays: 1..365
```

条件按 AND 组合。视图 ID 服务端生成，名称最长 60 字符。

### 事件

本切片产生：

- `tracking_started`：系统首次观察活动任务，避免停滞视图无基线；不表示旧阶段发生。
- `stage_observed`：扫描检测到 `derivedStage` 变化。
- `stage_manual_confirmed`：人工阶段写入。
- `task_plan_updated`：计划字段变化。

`correlation_id` 使用 `crypto.randomUUID()`。用户操作在一个事务内更新投影并追加事件。

## 5. 扫描阶段观察

`server/index.js` 在每次刷新完成后比较上一份 board 与新 board：

```text
上一份 derivedStage != 新 derivedStage
  -> 追加 stage_observed

首次 v2 board
  -> 仅建立 tracking_started 基线和 in-memory/persisted baseline
  -> 不追加迁移前的 stage_observed
```

为避免时间线被启动顺序污染：

- `execution_events_started_at` 只写一次。
- `tracking_started` 对每个活动任务最多一条。
- 归档任务和身份冲突任务不建立新的停滞基线。
- 阶段事件时间使用扫描完成时间，并标记 `source=scan`，不冒充精确的文件保存时间。

## 6. 服务端模块

### `server/execution-store.js`

纯服务端领域模块，职责：

- 计划字段和标签读写。
- 保存视图 CRUD。
- 事件追加与查询。
- Board 级批量读取。

### `server/execution-projection.js`

- 从任务列表批量聚合计数字段、标签和最近事件时间。
- 计算内置注意力原因。
- 为 `/api/board` 返回轻量 `execution` 摘要。
- 为 `/api/task` 返回完整计划字段、视图可选原因和事件摘要。

### `server/loader.js`

- 增加稳定执行身份。
- `toTaskListItem()` 投影稳定身份和身份有效性。
- 不把事件或正文加入扫描缓存。

### `server/index.js`

- 启动时执行 v2 迁移。
- 在 board 响应前叠加 SQLite 扩展数据。
- 新增计划字段和保存视图路由。
- 人工阶段路由改成事务写入投影和事件。

### `server/repositories.js`

删除项目时，按 `projectId::` 前缀清理 `task_execution`、`task_tag` 和 `task_event`；全部在现有事务中完成。

## 7. HTTP 形状

`/api/board`：

```js
{
  tasks: [{
    ...现有列表字段,
    executionTaskKey,
    executionIdentityValid,
    execution: {
      dueDate,
      milestone,
      tags,
      lastActivityAt,
      attentionReasons: ["due_soon", "implementing"],
      historyStatus: "missing|tracking"
    }
  }],
  savedViews: []
}
```

`/api/task` 在列表摘要上增加：

```js
execution: {
  ...列表 execution,
  events: [],
  eventTotal: 0
}
```

列表只带最近 50 条事件中的最少元数据；详情加载最多最近 200 条事件，避免首屏放大。

写操作成功只返回变更摘要；前端重新调用现有 board/detail 加载流程。

## 8. 前端设计

### 首屏

按已确认原型落地：

- 顶部保存视图行。
- 左侧推荐任务卡和 13 阶段“流程胶带”。
- 右侧注意力队列。
- 下方四槽位轻量 Kanban，展示计划字段和注意力标签。

### 计划字段编辑

新增原生 `<dialog>`：

- 截止日期 `<input type="date">`
- 里程碑文本
- 标签输入（逗号分隔，提交前由共享纯函数规范）
- 保存和取消

任务卡片显示截止、里程碑、标签摘要；点击编辑按钮阻止卡片默认打开详情。详情内复用同一对话框。

### 保存视图

- 内置视图按钮：今日焦点、P0/P1、临近截止、长时间未动、实现/检查中。
- “新建组合视图”打开原生对话框，可勾选条件并命名。
- 自定义视图显示删除入口；删除前确认。
- 组合筛选解析和顺序放入 `public/execution-filter.js` 纯模块，Node 测试复用。

所有动态字段进入模板前使用 `safe()`。列表重绘后重新绑定任务、编辑和视图按钮。

## 9. 兼容与回滚

- `/api/board` 新增字段，提升 `SCAN_SCHEMA_VERSION`。
- 旧扫描缓存失效后通过现有刷新流程重建。
- schema 迁移前备份 `data/board.sqlite*`。
- v2 表不写仓库文件；回滚代码需同时恢复 v1 数据库备份。
- 事件和扩展数据按 board 本地能力处理，不承诺多实例一致性。

## 10. 关键取舍

- 使用稳定身份解决归档路径变化，不改变现有 `taskKey` 契约。
- 使用轻量批量投影，避免列表对每条任务逐条查询。
- 保存视图存结构化 JSON，不保存可执行表达式。
- 首次追踪只建基线，不伪造旧任务历史。
