# 风险与流动：技术设计

## 1. 前置状态

本设计假定 `10-30-personal-plan-attention` 已交付：

- SQLite schema v2。
- 稳定 `executionTaskKey`。
- append-only `task_event` 和人工阶段事件。
- board 执行投影、计划字段和本机开发者身份。

若前置实现不同，先在前置任务修正，不在本切片复制第二套身份或事件模型。

## 2. Schema v2 -> v3

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

CREATE INDEX task_dependency_blocked
ON task_dependency(blocked_task_key, resolved_at);

CREATE INDEX task_dependency_blocker
ON task_dependency(blocker_task_key, resolved_at);
```

解除关系保留原行并设置 `resolved_at`，不物理删除。依赖事件继续进入 `task_event`：

- `dependency_created`
- `dependency_resolved`

事件 payload 包含依赖 ID、双方稳定身份、原因和变更前后状态。

## 3. 图校验

创建 A blocked by B 时，操作顺序：

1. 服务端解析两个当前任务并确认稳定身份有效。
2. 拒绝 A == B。
3. 拒绝同一活动边重复。
4. 从 B 开始沿“blocked by”有向边搜索是否能到达 A。
5. 若可达则拒绝并说明形成循环。
6. 在 `BEGIN IMMEDIATE` 中插入依赖并追加事件。

图规模为个人看板规模，采用内存 BFS；一次读取全部活动依赖，不逐边查询。

定义：

- A 的 `blockedBy`：`blocked_task_key = A` 的活动行。
- B 的 `blocks`：`blocker_task_key = B` 的活动行。
- 任务可推进指当前没有任何活动 `blockedBy`。

## 4. HTTP 契约

### 创建

`POST /api/tasks/dependencies`

```json
{
  "blocked": { "projectId": "trellis-board", "taskPath": ".trellis/tasks/..." },
  "blocker": { "projectId": "trellis-board", "taskPath": ".trellis/tasks/..." },
  "reason": "等待计划字段模型确定"
}
```

成功返回依赖 ID、双方摘要和创建时间。

### 解除

`DELETE /api/tasks/dependencies`

```json
{ "id": "uuid" }
```

后端读取活动依赖，确认存在且未解除，在同一事务中设置 `resolved_at` 并追加事件。

## 5. 执行投影

`execution-projection.js` 扩展为：

```js
execution: {
  ...计划字段,
  blockedBy: [{
    id,
    taskKey,
    executionTaskKey,
    title,
    projectName,
    reason,
    createdAt,
    durationMs
  }],
  blocks: [...],
  isBlocked,
  risk: {
    wipState: "normal|at_limit|over_limit",
    dorMissing: [],
    dodMissing: []
  }
}
```

列表只返回阻断数量、最早阻断时长和缺口数量；完整数组只进入详情。board 另返回：

```js
flow: {
  implementationWip: 2,
  implementationLimit: 2,
  blockedCount: 3,
  unblockedReadyCount: 1
}
```

保存视图 filter 扩展 `blocked: "any" | "blocked" | "unblocked"`。缺失字段按 `any` 处理，保证 Slice 1 已保存视图无需迁移。

## 6. WIP 与 DoR/DoD

### WIP

- 默认软上限 2，存入 `board_state.executionWipLimit`。
- 由未归档且 `derivedStage` 为 `implement` 的任务数计算。
- `at_limit` 和 `over_limit` 只产生提示文案，服务端不拒绝阶段操作。
- 设置 UI 可在流动信号面板修改，合法范围 1–9。

### DoR

只对规划/待放行任务计算：

- PRD 已有真实 Requirements/Acceptance 内容。
- Design 存在且非默认骨架。
- Implement plan 存在。
- 规划评审有文件证据或人工阶段。

### DoD

只对实现/检查/收尾任务计算：

- 实施报告或等效实现证据存在。
- 检查报告或明确通过的检查证据存在。
- PRD 验收项没有未完成项。
- 工作提交有 commit。
- 归档任务必须已离开活动目录。

缺口是派生数组，不持久化，不阻止操作。

## 7. 前端

### 任务详情

新增“风险与依赖”区：

- 当前阻断项及原因。
- 添加阻断方。
- 解除活动阻断。
- 反向 `blocks` 列表。
- DoR/DoD 缺失项折叠显示。

### 流动信号

- 实现中 WIP：`n / limit`。
- 当前被阻断任务与累计时长。
- 解除阻断后可推进任务。
- 软上限设置入口，只提醒。

### 可访问性

- 阻断关系不是颜色卡片；每项都有文本原因和关系方向。
- 添加/解除使用 `<dialog>` 或详情内表单，提交按钮有处理中状态。
- 错误消息保留表单输入；循环错误指出形成闭环的任务标题。

## 8. 事务与兼容

- 依赖、事件和解除时间在同一事务。
- 删除项目时按 `projectId::` 前缀清理依赖行。
- 已归档任务仍可被依赖解析；活动任务不能依赖不存在的身份。
- schema v3 迁移失败时仍可用 v2 数据启动旧版本代码。
- `/api/board` 新增 flow 和任务 risk 字段后提升扫描缓存协议版本。

## 9. 关键取舍

- 使用内存 BFS 做循环检测，避免为个人版引入图数据库。
- 解除依赖保留历史行，直接服务后续阻断时长与撤销。
- DoR/DoD 从现有证据派生，不新增可自由勾选、难以审计的第二套流程状态。
