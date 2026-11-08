# 实施计划

## 步骤

### 1. 后端补齐实现中的开工条件缺口

- 修改 `server/execution-projection.js`：
  - 未归档任务始终计算开工条件缺口。
  - 完成条件逻辑保持现状。
  - 保持 `dorMissing`、`dodMissing` 及数量字段名称不变。
- 更新 `tests/execution-projection.test.js`：
  - 规划任务仍返回完整开工缺口。
  - 实现任务在缺少设计或实施计划时仍返回开工缺口。
  - 归档任务不再返回开工缺口。
  - 完成条件断言保持通过。

验证：

```bash
node --test tests/execution-projection.test.js
```

### 2. 增加条件映射纯逻辑

- 新增 `web/src/lib/condition-checks.js`。
- 映射开工条件、完成条件、PRD 动态度量项和未知文本兜底。
- 输出统一的阶段、缺口、当前证据和建议动作。
- 新增 `tests/condition-checks.test.js`，覆盖：
  - 四类开工条件。
  - 五类完成条件。
  - `PRD 验收项（x/y 已勾选）` 动态文本。
  - 未知文本不会丢失。

验证：

```bash
node --test tests/condition-checks.test.js
```

### 3. 扩展前端类型

- 修改 `web/src/features/board/task-view.ts`。
- `TaskExecution.risk` 增加 `dorMissing`、`dodMissing` 字符串数组。
- 不修改 `BoardTask` 的其他公开形状。

验证：

```bash
npm --prefix web run lint
```

### 4. 实现条件检查组件

- 新增 `web/src/features/board/ConditionChecks.tsx`。
- 按阶段实现展示矩阵：
  - 规划：开工条件展开，完成条件暂不适用。
  - 实现/检查/收尾：完成条件展开，开工条件压缩并可展开。
  - 归档：仅展示完成条件。
  - 全部满足：显示成功摘要。
- `查看明细` 使用 `aria-expanded`，在当前区块内联展开。
- 详情数组尚未加载时只显示数量摘要，不伪造明细；加载失败时“查看明细”保持禁用。
- 下一步为只读建议，不新增阶段写入或跳转行为。
- 桌面使用四列表格；`lg` 以下切换为单列条件卡。
- 颜色只使用 `destructive-soft`、`warning-soft`、`success-soft`、`muted` 等语义 token。

验证：

```bash
npm --prefix web run lint
```

### 5. 集成任务详情

- 在 `TaskDetailDialog` 顶部元数据与关注信号之后、13 阶段证据之前渲染 `ConditionChecks`。
- 将详情容器宽度改为 `sm:max-w-[1240px]`。
- 保留现有编辑计划、依赖和任务产物区域。
- 窄屏时不得出现横向滚动或内容截断。

验证：

- 打开规划任务详情，确认开工条件为主、完成条件为“暂不适用”。
- 打开实现中任务详情，确认完成条件为主，开工缺口可展开。
- 打开全部满足或归档任务详情，确认成功/最终状态正常。

### 6. 替换卡片与流动信号文案

- 修改 `web/src/features/board/TaskCard.tsx`：
  - 规划任务显示“开工条件缺 N”。
  - 实现/收尾任务优先显示“完成条件缺 N”。
  - 实现中仍有开工缺口时显示“开工条件仍缺 N”。
- 修改 `web/src/features/board/FlowSignals.tsx`：
  - 标签改为“条件缺口”。
  - 说明改为“按当前阶段检查”。
  - 不改变统计口径和保存 WIP 行为。
- 全仓搜索并确认产品 UI 中没有残留的开工/完成条件英文简称。

验证：

```bash
rg -n "DoR|DoD" web/src server
```

允许结果仅存在于内部变量、历史归档文档或本次任务文档中，不允许出现在用户可见文案。

### 7. 自动化回归

- 执行后端测试：

```bash
npm test
```

- 执行前端静态检查：

```bash
npm --prefix web run lint
```

- 所有开发完成后只执行一次最终构建：

```bash
npm run build
```

### 8. 浏览器验收

启动真实服务后，分别检查：

- 1440px：详情宽度约 1240px，四列表格完整可见。
- 1024px：表格开始向单列卡片过渡，无横向截断。
- 860px：完成条件全部为单列卡片，“查看明细”可展开开工缺口。
- 浅色与深色主题：文本、边框、警告和成功状态对比度正常。
- 交互回归：编辑计划、依赖操作、任务产物、13 阶段证据保持可用。

不执行与本次无关的构建、格式化或重构。

## 风险点

- 后端会让“开工缺口”在实现阶段继续计数，影响卡片和流动信号数量；这是本次需求的核心行为变化，必须用单测锁定。
- 前端缺口文本来自后端固定字符串，映射模块必须有未知文本兜底，避免新条件出现时静默消失。
- 窄屏下四列表格改单列卡片，不能沿用桌面固定宽度，否则会产生横向溢出。
- 不能把“下一步”做成未经定义的写操作入口。

## 回滚点

- 后端：恢复 `deriveTaskRisk()` 的规划阶段条件。
- 前端：移除 `ConditionChecks` 接入并恢复旧卡片/流动信号文案。
- 无数据库迁移或任务文件迁移需要回滚。
