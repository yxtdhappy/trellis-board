# 风险与流动：隔离环境 E2E 报告

## 环境

- 临时应用：`.audit/personal-risk-flow-20261030/app`
- 临时任务仓库：`.audit/personal-risk-flow-20261030/repo`
- 临时端口：`127.0.0.1:43217`
- 数据库来源：真实 v2 `data/board.sqlite` 的只读 `VACUUM INTO` 快照
- 浏览器：Chrome DevTools MCP 连续两次 60 秒连接超时；按项目降级规则改用 `ego-browser` Chromium 完成页面操作与截图
- 临时服务已停止；真实 4317 服务和真实数据库均未操作

## 迁移演练

| 对象 | schema | `task_dependency` | 说明 |
| --- | ---: | --- | --- |
| 快照 | 2 | 否 | 从真实 v2 只读生成 |
| 迁移主库 | 3 | 是 | 当前代码启动后迁移 |
| `board.sqlite.v2-backup` | 2 | 否 | 可独立打开 |
| 迁移主库重启 | 3 | 是 | 重开保持 v3 |

迁移前、迁移后和备份中的核心表行数一致：

```text
repositories 8
task_execution 1
task_tag 2
saved_view 1
task_event 18
board_state 17
```

## API 验收

临时实例实际调用 `POST /api/tasks` 创建三条审计任务，再执行以下闭环：

- `A blocked by B` 创建后，Board 列表显示 A `isBlocked=true` / `blockedByCount=1`、B `blocksCount=1`，列表没有完整依赖数组。
- A 详情显示 B 标题、原因、创建人、创建时间和活动时长；B 详情反向 `blocks` 显示 A。
- 解除 A blocked by B 后，A 从活动阻断队列移除并进入 `isUnblockedReady`，B 的 `blocksCount=0`；原依赖行保留两个时间，详情保留创建/解除事件，并通过 `resolvedBlockedBy` / `resolvedBlocks` 返回固定区间时长。
- 同一已解除边重新创建成功，ID 不同；活动边重新出现。
- 自引用、缺失任务、重复活动边、501 字符原因均返回 400；失败前后依赖和事件计数不变。
- 建立 A→B、B→C 后，创建 C→A 被拒绝；错误包含完整闭环标题 `C → A → B → C`，计数不变。
- WIP 设为 1 时达到上限；人工确认 review 后 WIP 变为 `2 / 1`、`over_limit`；达到和超过上限时阶段写入都返回成功。
- 计划字段保存后读回截止日期、里程碑和标签；详情返回具体 DoR 缺口。
- 种子 v2 库中的旧保存视图没有 `blocked` 字段，仍正常返回并可在 UI 打开。

机器可读步骤和响应见 [api-e2e.json](../../../.audit/personal-risk-flow-20261030/api-e2e.json)。

## 浏览器验收

- “被阻断”视图显示 `被阻断 · 1 项`，推荐任务为 A。
- “阻断已解除”视图显示 `阻断已解除 · 1 项`，推荐任务为 B。
- 从 A 详情选择 C、填写原因并创建依赖；成功后详情出现 B、C 两个活动阻断，随后从详情解除 C 关系。
- 在 B 详情尝试 B blocked by A，服务端返回闭环错误；阻断方选择和原因输入均保留，按钮恢复可用，焦点回到阻断方选择框。
- WIP 从 `2 / 1` 保存为 `2 / 2` 再恢复 `2 / 1`，提示明确“仅提醒，不阻止阶段确认”。
- 搜索只命中一个非实现任务时，WIP 仍显示个人全局 `2 / 1`，未退化为过滤子集计数。
- 旧保存视图可打开；团队、归档、任务流水线切换正常；创建任务对话框和计划字段对话框可打开并由 Escape 关闭。
- 从详情点击“设计”阶段按钮成功写入人工记录，右侧阶段列表更新。
- DoR 折叠项展开后列出 4 个具体缺口，DoD 显示已齐备；页面明确说明不阻止流程操作。
- 已解除依赖历史区展开后可看到方向、原因、创建时间、解除时间和持续时长；连续两次请求的 `durationMs` 完全一致。
- 860px 视口：`documentWidth=845 <= innerWidth=860`，无页面级横向溢出；依赖表单变为单列，选择框、原因框、按钮纵向无重叠。
- 浏览器控制台：`errors=[]`、`warnings=[]`。
- 非 2xx：仅 1 条预期的 `POST /api/tasks/dependencies` 400 循环错误。

## 截图

- [被阻断视图](../../../.audit/personal-risk-flow-20261030/screenshots/blocked.png)
- [阻断已解除视图](../../../.audit/personal-risk-flow-20261030/screenshots/unblocked-ready.png)
- [WIP 超限流动信号](../../../.audit/personal-risk-flow-20261030/screenshots/flow-over-limit.png)
- [详情依赖区](../../../.audit/personal-risk-flow-20261030/screenshots/detail-dependency.png)
- [解除后的历史事件](../../../.audit/personal-risk-flow-20261030/screenshots/detail-after-resolve.png)
- [已解除依赖固定时长](../../../.audit/personal-risk-flow-20261030/screenshots/detail-resolved-history.png)
- [循环错误保留输入](../../../.audit/personal-risk-flow-20261030/screenshots/detail-cycle-error.png)
- [860px 详情布局](../../../.audit/personal-risk-flow-20261030/screenshots/detail-860.png)
- [860px 已解除依赖历史](../../../.audit/personal-risk-flow-20261030/screenshots/detail-resolved-history-860.png)

## 限制

- Chrome DevTools MCP 未建立连接，因此本次截图与 DOM 操作来自 `ego-browser` Chromium；未把这次环境故障写成语用或前端通过项。
- 真实 4317 服务没有加载当前未提交代码，本报告只证明隔离副本行为。
- 临时审计数据库、脚本和截图保留在 `.audit/`，未清理真实用户数据。
