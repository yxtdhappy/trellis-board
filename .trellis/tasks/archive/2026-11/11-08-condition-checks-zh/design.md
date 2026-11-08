# 开工条件与完成条件检查设计

## Goal

在不改变风险判定和阶段门禁语义的前提下，把现有条件缺口数据转成可解释、可行动的中文界面，并让任务进入实现后仍能看到未补齐的开工条件。

## Architecture

### Data flow

```text
任务文件与阶段证据
  -> deriveTaskRisk()
  -> /api/board 轻量缺口数量
  -> /api/task 完整缺口数组 + 阶段证据
  -> 条件映射纯逻辑
  -> TaskCard / FlowSignals / ConditionChecks
```

- 列表接口继续只返回缺口数量，不把完整缺口数组带进首屏。
- 详情接口继续返回完整缺口数组，前端在打开详情后映射阶段、当前证据和建议动作。
- 不新增数据库表，不迁移任务文件，不重命名现有 API 字段。

## Backend

### Residual start-condition gaps

当前 [`deriveTaskRisk()`](../../../server/execution-projection.js) 只在规划/待放行阶段计算开工缺口。改为：

- 所有未归档任务都计算开工条件缺口。
- 归档任务不计算开工条件缺口。
- 完成条件继续只在归档或收尾阶段计算。
- `dorMissingCount`、`dodMissingCount`、`dorMissing`、`dodMissing` 字段保留，前端只替换用户可见名称。

这样任务进入实现、检查或收尾后，未补齐的开工条件仍会通过原有数量与数组传到 UI，不增加新的数据契约。

### Compatibility

- 不修改 `SCAN_SCHEMA_VERSION`，因为扫描缓存形状和阶段证据没有变化。
- 列表摘要仍只有数量；完整数组仍只在 `/api/task` 中返回。
- 现有 saved view 不读取开工/完成缺口字段，因此不需要迁移。
- `server/plugins/task-service.js` 继续复用看板风险摘要，不需要新接口。

## Frontend

### Pure logic

新增纯逻辑模块 `web/src/lib/condition-checks.js`：

- 把后端缺口字符串映射为：
  - `kind`: `start | completion`
  - `stageId`
  - `stageLabel`
  - `label`
  - `evidence`
  - `nextAction`
- 开工条件的已知文本映射：
  - PRD 需求与验收 -> `prd`
  - 非骨架设计 -> `design`
  - 实施计划 -> `implementPlan`
  - 规划评审 -> `review`
- 完成条件的已知文本映射：
  - 实施证据 -> `implement`
  - 检查证据 -> `check`
  - PRD 验收完成度 -> `prd`
  - 工作提交 -> `commit`
  - 归档记录 -> `archive`
- PRD 验收项带有动态完成计数，使用固定前缀匹配。
- 未知文本不能静默丢弃，归入“其他”，建议动作使用“补齐证据”。

该模块保持无 React 依赖，由 Node 测试直接覆盖。

### Type changes

`TaskExecution.risk` 增加：

- `dorMissing?: string[]`
- `dodMissing?: string[]`

数量字段保持原样。

### Condition component

新增 `web/src/features/board/ConditionChecks.tsx`，输入完整 `BoardTask`：

- 根据 `derivedStage` 决定主次关系。
- 规划/待放行：开工条件展开，完成条件显示“暂不适用”。
- 实现/检查/收尾：完成条件展开；开工条件压缩显示，存在缺口时提供“查看明细”内联展开。
- 归档任务：只展示完成条件结果，不展示已失效的开工欠债。
- 两类条件均满足：显示绿色成功状态，不渲染空表。
- “下一步”是只读建议文本，使用方向箭头但不提供点击行为。
- 组件不直接请求 API，使用 `TaskDetailDialog` 已加载的详情数据。
- 详情仍在加载或加载失败时，如果只有列表缺口数量而没有数组，组件只显示数量摘要，不伪造明细；“查看明细”保持禁用。

### Dialog and responsive layout

- `TaskDetailDialog` 最大宽度从 `1000px` 调整到 `sm:max-w-[1240px]`。
- `ConditionChecks` 在 `lg` 及以上使用四列检查表：
  - 对应阶段
  - 缺失项
  - 当前证据
  - 下一步
- `lg` 以下改成单列条件卡，每项按“阶段 + 缺失项 / 当前证据 / 下一步”纵向排列。
- 全部颜色使用现有语义 token：
  - 开工欠债：`destructive-soft`、`destructive`
  - 完成缺口：`warning-soft`、`warning`
  - 完成成功：`success-soft`、`success`
  - 中性信息：`muted`、`muted-foreground`
- 不引入硬编码浅色值，浅色与深色主题共用同一组件。

### Card and flow signal

- 规划任务卡片显示“开工条件缺 N”。
- 实现/检查/收尾任务优先显示“完成条件缺 N”；如仍有开工缺口，再显示“开工条件仍缺 N”。
- 卡片标签保持短文本，不放完整明细。
- 流动信号的英文合并名称改为“条件缺口”，说明改为“按当前阶段检查”；统计值仍表示存在任一缺口的不重复任务数。

## Presentation Matrix

| 任务状态 | 主视图 | 开工条件 | 完成条件 |
| --- | --- | --- | --- |
| 规划 / 待放行 | 开工条件 | 展开，显示全部四项 | 折叠为“暂不适用” |
| 实现 / 检查 / 收尾 | 完成条件 | 缺 0 时显示成功摘要；缺 N 时压缩提示并可展开 | 展开，显示全部缺口 |
| 全部满足 | 成功摘要 | `4/4` | `5/5` |
| 归档 | 完成条件 | 不展示 | 显示完成或缺口的最终结果 |

## Accessibility

- “查看明细”使用原生 `button`，提供 `aria-expanded` 和明确的按钮文字。
- 条件状态不能只靠颜色表达，必须同时显示“已完成 / 缺失 / 暂不适用”等文本。
- 窄屏表格转卡片后不能使用横向滚动。
- 详情弹窗继续沿用现有焦点管理、Esc 关闭和标题关联。

## Validation

- 后端单测覆盖规划、实现、检查、归档和全部满足场景。
- 纯逻辑模块单测覆盖全部已知缺口文本、动态验收计数和未知文本兜底。
- `rg` 检查产品 UI 中不存在原英文简称。
- 浏览器验证 1440px、1240px、1024px 和 860px 宽度，浅色与深色主题。
- 最终只执行一次 `npm --prefix web run build`，前置执行 `npm test` 与 `npm --prefix web run lint`。

## Rollback

本次没有数据迁移。回滚只需恢复风险派生条件和前端组件改动，不涉及任务文件、SQLite 状态或历史记录。
