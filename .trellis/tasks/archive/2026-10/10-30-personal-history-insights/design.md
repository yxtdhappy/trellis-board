# 追溯与复盘：技术设计

## 1. 前置状态

本设计假定前两个切片已交付：

- v3 schema。
- 稳定执行身份。
- append-only `task_event`。
- 人工阶段、扫描观察、计划更新和依赖事件。
- 当前任务最近事件与阻断关系查询。

本切片不新增持久化指标，直接由事件计算，避免事件与聚合值双写不一致。

## 2. 事件状态机

### 可逆操作

同一用户操作产生的事件共享 `correlation_id`，相关事件 `reversible=1`：

- `task_plan_updated`
- `stage_manual_confirmed`
- `dependency_created`
- `dependency_resolved`

不可逆事件：

- `tracking_started`
- `stage_observed`
- `operation_undone`

撤销本身使用新的 correlation ID，payload：

```json
{
  "targetCorrelationId": "...",
  "targetEventIds": [12],
  "reason": "撤销最近操作"
}
```

### 查找最近可撤销组

1. 查询当前任务最新的 `reversible=1` 事件组。
2. 读取该任务所有 `operation_undone` payload，收集已被撤销的 correlation ID。
3. 跳过已撤销组，选择最新未撤销组。
4. 返回操作摘要；若没有则返回不可撤销原因。

不在原事件上写 `undone` 标记，保持 append-only。

## 3. 撤销事务

`POST /api/tasks/undo` 的服务端流程：

1. 解析当前任务并确认稳定身份有效。
2. 读取最近未撤销操作组。
3. 按事件类型应用 `before`：
   - 计划字段：恢复 `task_execution` 和标签集合。
   - 人工阶段：upsert 原 `task_stage`；若 `before` 为空，删除投影。
   - 依赖创建：把对应活动依赖设为 resolved；若目标已解除，恢复为活动。
4. 追加 `operation_undone`。
5. 全部使用同一 `BEGIN IMMEDIATE`。

若当前状态已不再匹配原操作后的状态，拒绝自动撤销并说明“后续操作已改变当前值”。MVP 不实现无限历史回滚。

## 4. 指标计算

### 输入

- 任务稳定身份。
- 按 `occurred_at, id` 排序的最近 1000 条事件。
- `execution_events_started_at`。
- 当前归档状态和 `archivedAt`。
- 活动/历史依赖区间。

### 阶段事件规范化

阶段节点来自：

- `stage_manual_confirmed`
- `stage_observed`

同一次扫描产生的阶段变化序列按索引排序；同一时刻重复阶段保留最后一次，但回流计数按实际索引减少计。

### 指标

```js
{
  completeness: "missing|partial|tracked",
  missingReasons: [],
  observedSince: "...",
  leadTimeMs: null,
  cycleTimeMs: null,
  stageDurations: [{ stageId, label, durationMs }],
  reworkCount: 0,
  blockedTimeMs: null,
  blockedRatio: null
}
```

规则：

- Lead Time：首个阶段事件到归档事件/outcome；标签显示“追踪后”。
- Cycle Time：首次 `implement` 到首次 `check` 完成；没有检查完成则到 now 并标记 open。
- 回流：后一阶段索引小于前一阶段索引。
- 阶段停留：相邻变化间隔；最后一个阶段到 now。
- 阻断时间：依赖创建/解除区间与任务追踪窗口的交集；重叠依赖不重复累计。
- `blockedRatio = blockedTimeMs / observedWindowMs`，上限 1。

### 完整度

- `missing`：没有任何阶段事件，或任务创建早于事件启用且没有足够起点。
- `partial`：有阶段事件但缺少实现/检查等计算节点，或扫描观察跨越多个阶段。
- `tracked`：所需起点与终点事件齐全，且事件来源能够解释覆盖范围。

完整度由函数返回，不依赖前端猜测。

## 5. 服务端模块

### `server/execution-history.js`

- 查询任务事件与已撤销组。
- 构建 `before` 恢复操作。
- 执行撤销事务。

### `server/execution-metrics.js`

- 纯函数处理已排序事件和依赖区间。
- 输出固定字段、完整度和缺失原因。
- Node 测试直接覆盖时间边界、回流、未闭合阶段和重叠阻断。

### `server/execution-projection.js`

详情追加：

```js
execution: {
  ...现有字段,
  history: {
    events: [],
    undo: {
      available,
      targetCorrelationId,
      label,
      disabledReason
    }
  },
  metrics
}
```

board 列表只返回 metrics 摘要中的完整度和关键时长，不携带事件正文。

## 6. HTTP

`POST /api/tasks/undo`

```json
{
  "projectId": "trellis-board",
  "taskPath": ".trellis/tasks/10-30-..."
}
```

成功返回撤销摘要、补偿 correlation ID 和恢复后的投影。没有可撤销操作返回 400 中文错误，不写数据库。

## 7. 前端

任务详情增加两个区域：

- 操作历史：时间、来源、操作者、摘要、技术详情折叠。
- 执行指标：追踪后 Lead/Cycle、阶段停留、回流、阻断占比、完整度。

行为：

- 顶部“撤销最近操作”按钮显示目标操作名称。
- 单击后确认，提交期间禁用；成功后重新加载详情和 board。
- `missing` 显示具体原因，不显示 0 或破折号误导。
- `partial` 使用明确标签，不以警示色代替说明。
- 指标失败时显示局部错误，不遮蔽产物和阶段。

事件和指标不使用额外图表库。阶段停留使用有序横条，阻断占比使用带文字标签的水平条。

## 8. 性能与完整性

- 详情一次读取最多 1000 条事件，超过时返回 `truncated=true` 和计算窗口。
- 计算在主线程完成，纯数组操作限制在个人任务规模。
- 列表只使用事件聚合摘要，不带正文。
- 时间使用 ISO 字符串存储，计算前转毫秒；统一按 UTC 计算时长，日期展示使用本地时区。
- 数据迁移前备份 SQLite；事件缺失不可通过文件 mtime 修补。

## 9. 关键取舍

- 先实现最近一次撤销，避免复杂多层事务栈。
- 指标实时计算，避免初期引入聚合表与重算任务。
- 使用“追踪后指标”而非伪历史；可信度优先于视觉完整。
