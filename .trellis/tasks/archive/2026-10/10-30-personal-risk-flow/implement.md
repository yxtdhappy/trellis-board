# 风险与流动：实施计划

## 前置检查

- [x] 前置任务 `10-30-personal-plan-attention` 已归档。
- [x] 当前代码 schema 为 v2，稳定身份和事件写入已通过测试。
- [x] 记录前置提交号到本任务 notes，避免基于未落地接口开发。

## 实施顺序

### 1. Schema v3

- [x] 在 `server/database.js` 增加 v2 -> v3 顺序迁移。
- [x] 创建 `task_dependency`、活动唯一索引和双向查询索引。
- [x] 新库直接初始化到 v3；大于 v3 仍拒绝启动。
- [x] 更新数据库表清单和迁移回滚测试。

验证：

- v1 -> v2 -> v3 连续迁移可重开。
- 迁移中人为失败时不留下 v3 半成品。

### 2. 依赖领域服务

- [x] 新增依赖读写函数，接受两个已解析稳定身份和原因。
- [x] 校验非空、最大 500 字符、非自引用、非重复活动边。
- [x] 读取全部活动边并在内存执行可达性搜索，拒绝循环。
- [x] 创建时插入依赖和 `dependency_created` 事件。
- [x] 解除时设置 `resolved_at` 并追加 `dependency_resolved` 事件。
- [x] 查询 `blockedBy` 和 `blocks` 时保留标题、项目、原因和时长。

验证：

- 缺失、自引用、重复、长原因、二节点环和三节点环全部拒绝。
- 失败后依赖和事件计数均不增加。

### 3. HTTP 与投影

- [x] 新增 `POST /api/tasks/dependencies` 和 `DELETE /api/tasks/dependencies`。
- [x] 统一通过 `projectId + taskPath` 解析双方任务。
- [x] `/api/board` 添加 flow 汇总和任务轻量风险摘要。
- [x] `/api/task` 添加活动/已结束 `blockedBy`、`blocks` 和 DoR/DoD 缺口。
- [x] 扩展保存视图匹配器的 `blocked` 条件；旧视图缺失字段按 `any` 处理。
- [x] 默认 WIP 上限写 `board_state`，允许 1–9。
- [x] 项目删除事务清理依赖行。
- [x] 提升 `SCAN_SCHEMA_VERSION`，同步前端和测试。

### 4. DoR/DoD 与 WIP 计算

- [x] 实现规划阶段的 DoR 缺失项派生。
- [x] 实现实现/检查/收尾阶段的 DoD 缺失项派生。
- [x] 确认提醒只影响显示，不参与阶段写入校验。
- [x] 实现 WIP 计数和 `normal/at_limit/over_limit` 状态。
- [x] 为证据不足场景返回明确缺失原因。

### 5. UI

- [x] 任务详情增加“风险与依赖”区。
- [x] 支持选择阻断方、填写原因、创建依赖。
- [x] 支持解除活动依赖并显示提交状态。
- [x] 展示反向 blocks 列表、已解除历史和固定阻断时长。
- [x] 首屏增加被阻断、解除阻断可推进、WIP 和 DoR/DoD 信号。
- [x] 组合视图编辑器增加阻断状态条件，旧保存视图可继续使用。
- [x] 软上限可从流动信号面板修改。
- [x] 颜色之外同时显示方向、状态和原因文本。
- [x] 重绘后重新绑定依赖、解除、WIP 设置按钮。

## 最终验证

```powershell
npm test
Get-ChildItem server,public,tests -Filter *.js -Recurse | ForEach-Object { node --check $_.FullName }
node server/index.js
```

真实 API：

- [x] 创建 A blocked by B，详情双向可见。
- [x] 解除 B -> A 后活动队列移除，历史保留。
- [x] 构造 A -> B -> C -> A，创建最后一条时返回循环错误。
- [x] WIP 到上限和超上限时仍能确认阶段。

浏览器：

- [x] 详情创建和解除依赖成功，刷新后一致。
- [x] 风险队列可定位任务，阻断原因可见。
- [x] 计划字段、视图、阶段、团队和归档视图无回归。
- [x] 860px 以下无页面级横向溢出，键盘可完成依赖创建和解除。

## 风险与回滚

- 循环校验和图投影必须以活动边为输入，不能混入已解除历史。
- 删除项目清理失败时整个事务回滚，不能只删一半依赖。
- UI 若无法清晰表达依赖方向，停止扩展样式，优先修正文案与结构。
