# 实施报告

## 结果

开工条件与完成条件检查已按 PRD 和 Pen 设计完成。任务进入实现、检查或收尾后，未补齐的开工条件仍会继续显示；用户界面已统一使用“开工条件”和“完成条件”，不再出现原英文条件简称。

## 实现内容

### 后端

- `server/execution-projection.js`：未归档任务的开工条件缺口在所有阶段继续计算。
- 完成条件计算、阶段门禁、归档语义和内部字段名保持不变。
- 列表仍返回轻量数量，详情继续返回完整缺口数组。

### 前端

- 新增 `web/src/lib/condition-checks.js` 与类型声明，统一映射阶段、当前证据和下一步建议。
- 新增 `web/src/features/board/ConditionChecks.tsx`：
  - 规划态突出开工条件。
  - 实现/收尾态突出完成条件。
  - 实现中的开工缺口可内联展开。
  - 全部满足时显示成功摘要。
  - 桌面四列布局，`lg` 以下切换为单列条件卡。
- `TaskDetailDialog` 接入条件检查，最大宽度调整为 `1240px`。
- `TaskCard` 与 `FlowSignals` 改为中文阶段性文案。

### 测试

- 新增 `tests/condition-checks.test.js`。
- 扩展 `tests/execution-projection.test.js`，覆盖实现阶段开工缺口和归档边界。
- 聚焦测试 13/13 通过。
- 完整测试 328 通过、5 跳过；1 个既有 Windows 临时目录清理用例首次失败，单独重跑通过。
- 前端 lint 通过，最终构建通过。

### 浏览器验收

- 1440px：详情宽度 `1240px`，四列表格完整。
- 1024px：无横向溢出。
- 860px：切换为单列条件卡。
- 浅色、深色主题正常。
- 规划、实现、全部满足和归档状态均已验证。
- `admin.html` 正常渲染；独立模式下 `login.html` 回到看板首页，符合当前运行模式。

## 已知事项

- 代码提交：`23fa790e4b2aa8ad713a992b46d793896d9e1c1f`。
- 已推送分支：`origin/codex/team-board`；本次未归档。
- 当前 `4317` 服务未重启，日常端口仍运行旧进程；最新源码和 `public/` 构建产物已准备好。
- 工作区中的 `.trellis/tasks/11-08-archived-task-assignment-readonly/` 属于其他任务，本次未修改。
