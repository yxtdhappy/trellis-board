# 追溯与复盘：检查报告

## 结论

实现与任务契约一致。检查阶段修复或收敛了 5 个机械性、边界与覆盖问题；全量测试、语法检查、隔离 HTTP API、重启一致性和浏览器验收均通过。没有阻塞提交的未修复项，但依赖撤销后的指标口径与可信归档时间仍有两个后续设计决策。

## Findings (fixed)

- 文件：`.trellis/spec/backend/http-and-filesystem.md`
- 问题：规范写成“事件窗口截断时一律拒绝撤销”，与设计、实现和测试不符；最近窗口内能确认最新未撤销候选时应当允许撤销。
- 修复：改为只有截断导致无法确认候选时才拒绝对话；与 `undoMetadata()` 行为一致。

- 文件：`server/execution-projection.js`、`tests/execution-projection.test.js`
- 问题：`projectTaskDetailExecution()` 在局部捕获之前无条件调用 `readExecutionDetail()`。事件表读取失败会直接抛错，整个 `/api/task` 失败，违反 R11。
- 修复：把 `readExecutionDetail()` 纳入局部容错；失败时返回空事件窗口，保留标题、产物、阶段和依赖，并分别返回 `historyError`、`metricsError`。新增删除临时库 `task_event` 表的可控回归测试。

- 文件：`server/execution-metrics.js`、`tests/execution-metrics.test.js`
- 问题：实测归档移动目录保留 `task.json` mtime，`archivedAt` 可能早于最后阶段事件。旧实现仍返回 `tracked`，但 Lead Time、最后阶段停留和阻断占比会是 `null`，违反 R8。
- 修复：档案结束点早于最后阶段事件时返回 `partial` 和“归档时间早于最后阶段事件，无法确认结束区间”；以最后阶段事件作为保守结束点，并新增回归测试。

- 文件：`tests/execution-metrics.test.js`
- 问题：缺少“追踪起点已在实现/检查之后”的显式回归，无法防止起点过晚被误判为 `tracked`。
- 修复：新增夹具，证明没有实现节点时仍返回 `partial`。

- 文件：`public/app.js`、`public/styles.css`
- 问题：事件时间线有滚动上限，但容器不能直接获得键盘焦点，仅靠内部 `details` 不足以保证键盘滚动路径。
- 修复：时间线增加 `role="region"`、`tabindex="0"` 和统一 `:focus-visible` 样式；浏览器已确认可聚焦。

## Findings (not fixed)

- 依赖创建撤销后的阻断区间口径需要产品确认。当前实现把 `resolved_at` 写为撤销时间，指标继续累计“依赖实际处于活动状态直到撤销”的区间。该行为符合 append-only 的观察成本语义，也能解释当时看板确实显示阻断；如果产品要求撤销后“视为从未阻断”，需要显式排除 `operation_undone` 指向的依赖区间并调整设计，不在检查阶段静默改变指标口径。
- 可信归档终点仍是设计级缺口。当前 `archivedAt` 来源是 `task.json` mtime，移动目录通常不会更新该时间；检查阶段已通过 `partial` 防止误导，但若产品要求新归档任务稳定展示 `tracked` 精确指标，需要追加明确归档事件或持久化真实归档时间，不能从文件 mtime 猜。

## 规范同步

- `backend/architecture-and-runtime.md`
- `backend/scanning-and-persistence.md`
- `backend/http-and-filesystem.md`
- `frontend/rendering-and-state.md`
- `guides/cross-layer-thinking-guide.md`

补充记录了 `SCAN_SCHEMA_VERSION=11`、截断窗口下的撤销候选规则、事件读取局部降级、归档 mtime 不可信时的保守完整度，以及列表/详情指标边界。

## Verification

- Lint：N/A，项目没有 lint 脚本。
- TypeCheck：N/A，项目没有 TypeScript 或类型检查步骤。
- Build：N/A，项目没有构建步骤。
- Tests：通过，`npm test` 为 113/113。
- Targeted tests：通过，历史/指标/投影/存储/扫描提交共 37/37。
- Syntax：通过，`server/`、`public/`、`tests/` 全部 JavaScript 执行 `node --check` 无错误。
- Diff：通过，`git diff --check` 无空白错误；任务 `task.json` 仅报告既有 CRLF 转换警告。
- Context：通过，`python ./.trellis/scripts/get_context.py --mode packages` 返回单仓 `backend`、`frontend` 两个规范层。

## Review Evidence

- Board 批量指标在 1,001 条事件夹具下返回 `partial` 摘要，响应不包含 `execution.events` 或 `execution.history`。
- `partial` / `missing` 浏览器页面不渲染精确 Lead/Cycle、阶段横条、阻断占比或百分比；`tracked` 才渲染精确值。
- 820px 视口页面宽度 `805/805`，对话框和历史/指标区均无横向溢出。
- 详情事件读取故障时仍显示 13 个阶段按钮和 PRD 产物，只在历史/指标区域显示局部错误。

完整真实环境步骤见 `e2e-report.md`。
