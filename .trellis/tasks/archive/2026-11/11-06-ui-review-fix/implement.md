# 实施计划 · 设计稿缺陷修复与界面还原对齐

## Checklist

### 阶段 1 · Pencil 设计稿修订
- [x] 1.1 在 Pencil `design/trellis-board-redesign.pen` 组件库帧中注册统一的 `Trellis Logo` 组件。
- [x] 1.2 在管理台画板（05 · 管理台 · 项目协作 · Light 等）顶栏补齐主题切换按钮，规范顶栏架构。

### 阶段 2 · 矢量 Logo 与顶栏统一
- [x] 2.1 新建 `web/src/components/layout/TrellisLogo.tsx`，实现标准的 Trellis 晶格网格矢量图形。
- [x] 2.2 更新 `TopBar.tsx`、`AdminPage.tsx`、`LoginPage.tsx`，将纯文本 "T" 替换为 `TrellisLogo`。
- [x] 2.3 在 `AdminPage.tsx` 顶栏增加 `useTheme` 主题切换按钮，保持操作与风格统一。

### 阶段 3 · 控件高度与对齐
- [x] 3.1 修复 `web/src/components/ui/select.tsx` 中 `SelectTrigger` 的高度类名与尺寸变体，支持外部 `h-8`（32px）顺畅覆盖。
- [x] 3.2 规范 `SelectField.tsx` 的基准高度与类名。
- [x] 3.3 调整 `ArchiveView.tsx`、`TeamView.tsx` 及管理台各个 Tab 中的并排输入框、下拉框和按钮高度，严格保持 32px 齐平。

### 阶段 4 · 负责人 Select 控件对齐
- [x] 4.1 在 `CreateTaskDialog.tsx` 中移除 `<input list="...">` 及 `<datalist>`。
- [x] 4.2 接入 `SelectField`，使用标准下拉项与 ChevronDown 图标，消除黑色原生倒三角 `▼`。

### 阶段 5 · Standalone 模式稳定性修复
- [x] 5.1 修改 `web/src/hooks/useBoard.ts`，使用 ref 正确维护 `generatedAt`，消除 750ms 持续全量重刷死循环。
- [x] 5.2 在创建任务请求中注入 `idempotencyKey`（`crypto.randomUUID()`）。

### 阶段 6 · 团队视角侧栏项目切换联动
- [x] 6.1 在 `TeamView.tsx` 中引入针对 `filters.projectId` 的客户端过滤逻辑。
- [x] 6.2 确保 `ProjectRail` 切换项目时，团队视角的任务列表和统计数据即时联动更新。

### 阶段 7 · 验证与回归检查
- [x] 7.1 运行单元测试（`node --test tests/*.test.js`）确保现有业务逻辑无破坏。
- [x] 7.2 运行代码格式化与 lint 检查（Prettier / ESLint / oxlint）。
- [x] 7.3 使用 Tabbit 浏览器实测 `http://127.0.0.1:4317/`，验证各页面视觉效果与交互功能。

## Rollback Plan
- 若对齐过程中影响到基础组件库其他页面，可针对受影响组件单独回滚到上一提交状态。
