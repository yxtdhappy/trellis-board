# 追溯与复盘：隔离环境 E2E 报告

## 环境

- 临时应用：`.audit/personal-history-insights-20261031/app`
- 临时 Trellis 仓库：`.audit/personal-history-insights-20261031/fixture-repo`
- 临时端口：`127.0.0.1:44317`
- 临时数据库：`.audit/personal-history-insights-20261031/app/data/board.sqlite`
- 浏览器：Chrome DevTools MCP 连续两次 60 秒连接超时；按项目降级规则改用 `ego-browser` Chromium
- 临时服务已停止；真实 `127.0.0.1:4317`（PID `42200`）与真实 `data/board.sqlite` 均未操作

## API 闭环

| 场景 | 实际结果 |
| --- | --- |
| 计划字段修改与撤销 | 修改后读回截止、里程碑、标签；撤销后恢复空值，追加 `operation_undone`，原 `task_plan_updated` 仍存在 |
| 重复撤销 | 同一单组撤销后再次请求返回 400“没有尚未撤销的可逆操作”，事件总数不变 |
| 人工阶段撤销 | 浏览器点击撤销并确认，`task_stage` 投影恢复为无人工阶段，时间线首条变为“撤销操作” |
| 依赖创建撤销 | 创建 activity 后详情 `isBlocked=true`；撤销后依赖行保留并以撤销时间解除，活动阻断消失 |
| 依赖解除撤销 | 解除后撤销恢复同一依赖为活动，依赖 ID 不变；随后再次撤销创建操作可清理活动边 |
| after-state 冲突 | 直接改变临时库人工阶段后请求撤销返回 400“后续操作已改变当前值”，事件总数和当前阶段不变 |
| 补偿事件失败 | 临时触发器拒绝 `operation_undone`，API 返回 400；计划字段与事件数整体回滚。移除触发器后可正常撤销 |
| 指标完整度 | 固定夹具分别得到 `missing`、`partial`、`tracked`；`tracked` 包含 Lead/Cycle、阶段停留和证据事件 ID |
| Board 截断 | 1,001 条事件夹具仅返回 `partial` 指标摘要，不包含 `execution.events` / `execution.history` |
| 归档稳定身份 | 将任务移动到嵌套 archive 后 `executionTaskKey` 不变，重启前后事件 ID 顺序和指标对象一致 |
| 事件读取失败 | 仅删除临时库 `task_event` 后，`/api/task` 仍返回标题、13 个阶段、PRD 产物与依赖；历史/指标返回局部错误 |

机器可执行脚本位于：

- `.audit/personal-history-insights-20261031/api-e2e-phase1.mjs`
- `.audit/personal-history-insights-20261031/api-e2e-phase2.mjs`
- `.audit/personal-history-insights-20261031/api-e2e-phase3.mjs`
- `.audit/personal-history-insights-20261031/api-e2e-phase4.mjs`
- `.audit/personal-history-insights-20261031/api-e2e-phase5.mjs`

## 归档时间边界

目录移动保留了 `task.json` mtime，实测 `archivedAt` 早于最后阶段事件。修复后详情返回：

- `completeness=partial`
- `missingReasons=["归档时间早于最后阶段事件，无法确认结束区间"]`
- `leadTimeOpen=false`
- 历史事件仍为 3 条，稳定执行身份和事件 ID 保持不变

该结果阻止了旧的 `tracked + null 时长` 误导组合。若未来要求新归档任务稳定 `tracked`，需要增加真实归档时间事件，不能继续依赖文件 mtime。

## 浏览器验收

- `partial`：显示“部分覆盖”，只展示“追踪仍在进行”“检查尚未完成”“覆盖不完整”等定性状态；无百分比、阶段条和阻断占比条。
- `tracked`：显示精确 Lead/Cycle、回流次数、阻断占比、阶段停留条和阻断占比条。
- 撤销：点击按钮出现原生确认框，确认后 Board 和详情重新读取；成功后按钮禁用，事件时间线首条为“撤销操作”。
- 键盘：事件时间线可聚焦，浏览器实际 `document.activeElement` 为 `.event-timeline`。
- `missing`：只显示缺失原因与“证据不足”，不渲染 KPI 网格；归档任务撤销原因显示“归档任务只读，不能撤销”。
- 820px：页面 `scrollWidth=805`、`clientWidth=805`，无页面级横向溢出；对话框 `767px`，历史/指标均变为单列。
- 局部错误隔离：删除临时 `task_event` 后，任务标题、13 个阶段和 PRD 产物仍显示；历史与指标分别显示 `no such table: task_event` 局部错误，对话框保持可用。

## 截图

- [看板首屏](../../../.audit/personal-history-insights-20261031/browser-board.png)
- [partial 详情](../../../.audit/personal-history-insights-20261031/browser-partial-detail.png)
- [撤销后状态](../../../.audit/personal-history-insights-20261031/browser-after-undo.png)
- [tracked 详情](../../../.audit/personal-history-insights-20261031/browser-tracked-detail.png)
- [820px tracked 详情](../../../.audit/personal-history-insights-20261031/browser-820.png)
- [归档边界 partial](../../../.audit/personal-history-insights-20261031/browser-archived-partial.png)
- [历史读取局部错误](../../../.audit/personal-history-insights-20261031/browser-local-error.png)

## 限制

- Chrome DevTools MCP 未建立连接，因此页面操作与截图来自 `ego-browser` Chromium；该环境故障没有算作产品通过项。
- 真实 4317 服务未加载当前未提交代码；本报告只证明隔离副本行为。
- 临时审计数据库、脚本和截图保留在 `.audit/`，真实用户数据未修改。
