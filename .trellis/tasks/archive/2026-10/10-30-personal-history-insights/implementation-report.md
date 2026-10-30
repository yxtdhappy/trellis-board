# 追溯与复盘：实施报告

## 交付结果

本切片完成了任务详情中的可信事件历史、最近一次可逆操作撤销，以及仅从事件追踪启用后累计的执行指标。实现不新增业务表，原始事件保持 append-only；撤销通过恢复投影并追加 `operation_undone` 补偿事件完成。

## 服务端实现

- `server/execution-metrics.js`：新增纯函数指标计算，支持 `missing / partial / tracked`、Lead/Cycle Time、阶段停留、回流次数、重叠阻断区间合并、阻断占比、缺失原因、证据事件 ID 和事件窗口元数据。
- `server/execution-history.js`：新增历史与撤销模块。按 correlation group 识别最近未撤销操作，撤销前核对当前投影仍匹配原事件 `after`，并在单一事务中恢复计划、人工阶段或依赖活动性后追加补偿事件。
- `server/execution-store.js`：新增单任务和批量事件读取；事件最多 1000 条并携带 `executionTaskKey`、总数、窗口起点和截断状态。依赖创建/解除事件补齐 `reversible=true`。
- `server/execution-projection.js`：列表只返回轻量指标摘要；详情返回完整 `history`、`metrics`、撤销元数据和分别隔离的 `historyError` / `metricsError`。事件读取本身失败时保留任务基础字段、产物、阶段和依赖，只降级历史与指标局部。
- `server/index.js`：新增 `POST /api/tasks/undo`；详情事件上限提升到 1000；`SCAN_SCHEMA_VERSION` 提升到 11。

撤销响应包含目标 correlation、目标事件 ID、补偿 correlation、补偿事件 ID、恢复摘要与刷新后的任务详情。归档、身份冲突、没有未撤销操作或 after-state 已被改变时拒绝写入；事件窗口截断只有在无法确认最新候选组时才拒绝。

## 指标规则

- `tracking_started` 只作为追踪起点，不生成阶段停留。
- 没有阶段事件时为 `missing`，不返回伪造的 0 秒精确时长。
- 缺少实现或检查计算节点、扫描跨阶段无法精确拆分、事件被截断时为 `partial`，并返回具体原因。
- 归档任务的 `archivedAt` 早于最后阶段事件（移动目录常保留 `task.json` mtime）时，以最后阶段事件作为保守结束点并标记 `partial`，不把不完整时长误标为 `tracked`。
- 实现与检查节点连续覆盖时为 `tracked`。
- API 保留可重建的原始指标事实；前端只有在 `tracked` 时展示精确 Lead/Cycle、阶段停留和阻断占比。`missing` / `partial` 只展示缺口原因与“检查尚未完成”“覆盖不完整”等定性状态。
- Lead Time 从首个可信阶段事件计到归档时间或显式 `now`；Cycle Time 从首次实现计到首次后续检查，未完成时保持 open。
- 阶段回流按相邻阶段索引减少计数；重叠依赖区间合并后只累计一次。
- 被 `operation_undone.payload.targetEventIds` 指向的阶段事件不参与指标重建。

## 前端实现

- 详情新增“执行指标”区：完整度、缺失原因、Lead/Cycle、回流、阻断占比、阶段停留横条和事件窗口说明。
- 新增倒序操作历史，显示时间、中文来源、操作者、摘要和默认折叠的技术详情；最多渲染 1000 条，并明确截断状态。
- 新增“撤销最近操作”按钮、禁用原因、确认交互、提交防重和局部错误；成功后重新读取 Board 与任务详情。
- 事件超过 1000 条时，窗口内若已能确认最新未撤销候选组，撤销仍可用；只有窗口截断导致无法确认候选时才禁用并解释原因。
- `historyError` / `metricsError` 只影响对应区域，不阻断标题、阶段、产物、依赖与现有操作。
- 新增桌面和 860px 以下响应式样式；时间线自身滚动并可通过键盘聚焦，KPI 在窄屏改为单列，所有动态文本继续经过 `safe()`。

## 测试与验证

已执行：

```text
npm test
113 tests
113 pass
0 fail

node --test tests/execution-metrics.test.js tests/execution-history.test.js tests/execution-store.test.js tests/execution-projection.test.js tests/scan-commit.test.js
37 tests
37 pass
0 fail
```

覆盖内容包括：

- `missing / partial / tracked`、开放阶段、固定 now、归档终点、回流和重叠阻断。
- 撤销事件排除目标阶段、固定夹具重复计算一致和 1000 条窗口截断。
- 计划、人工阶段、依赖创建/解除恢复；重复撤销、after-state 变化、补偿事件失败整体回滚和原始事件保留。
- 批量事件读取独立截断；Board 不返回事件正文；归档详情仍按稳定身份返回历史和指标。

已通过 `server`、`public`、`tests` 下全部 JavaScript 文件的 `node --check` 语法检查。

## 隔离 E2E

- 使用 `.audit/personal-history-insights-20261031/` 下的应用副本、任务夹具和 SQLite，在 `127.0.0.1:44317` 完成计划、人工阶段、依赖创建/解除撤销、重复撤销、after-state 冲突、补偿失败回滚、missing/partial/tracked、归档稳定身份、重启一致性与局部错误隔离。
- 真实 `127.0.0.1:4317`（PID `42200`）未重启；真实 `data/board.sqlite` 未修改。
- Chrome DevTools MCP 连续两次连接超时，按项目降级规则使用 `ego-browser` 完成 820px 响应式、键盘焦点和截图验收。
- 详见 `check-report.md` 与 `e2e-report.md`。

## 主代理后续验收

1. 复核检查报告和隔离 E2E 证据。
2. 统一勾选 PRD/Implement 检查项、更新任务状态。
3. 按显式路径提交代码并归档任务。
