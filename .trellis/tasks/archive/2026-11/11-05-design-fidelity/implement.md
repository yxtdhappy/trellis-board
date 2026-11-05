# 实施计划

## 阶段 A · 设计稿修订（本轮交付，等确认）

1. **补齐设计系统组件**
   - 在 `MzSDs`（shadcn: design system components）新增可复用 `Filter Select`：Label + Trigger(32/6/$--input) + Value + lucide `chevron-down`。
   - 新增 `Chip`（选中/未选中两态）、`Scroll Thumb`（6×40，圆角 999）两个可复用组件。
2. **01 · 任务流水线（YMuKT / v1yHb）**
   - 头部改回 `eyebrow + 把每个任务放回流程里`（R9）。
   - 新增 `ViewBar`：9 个内置 chips + 2 个自定义 chips + 摘要/日期。
   - 新增 `FlowSignals`：WIP 表单、4 张信号卡、焦点建议。
   - 视图工具条补图例（自动推导 / 人工记录 / 可选证据）。
   - 新增 `Attention`：kicker/标题/计数/6 行队列/脚注。
   - 新增 `概览` 4 卡：进行中 / 归档任务 / 需要关注 / 团队节奏。
   - `Filters` 5 个伪 select 换成 `Filter Select` 实例（项目/负责人/优先级/阶段/阻断）。
   - 看板补头部（`FLOW / 四个决策槽位` + `轻量 Kanban` + summary）；列体 `min 260` + 滚动 thumb。
   - 画板高度增高到内容高度，`placeholder` 完成后撤掉。
3. **02 · 团队视角（HqcU3 / BcdgI）**：头部回归 `TEAM CAPACITY / 谁在推进，谁需要帮助` + 说明；查询面板 8 个筛选项（项目/负责人/优先级/阶段/标签/截止窗口/停滞天数/阻断 + 查看归档 + 应用筛选）换 `Filter Select` 与输入框；补总数与分页；行尾箭头改图标。
4. **03 · 归档索引（xgJLh / KI1vy）**：头部回归 `归档后离开当前队列，只保留历史证据` + 说明；项目筛选换 `Filter Select`，搜索框 placeholder `筛选标题或负责人`；表头改为 任务/项目/负责人/阶段/归档时间；行尾 `chevron-right`；分页；长表格加 thumb。
5. **05–09 管理台（含 06 用户账号）**：所有筛选换 `Filter Select`；表格行尾操作改图标；tab 侧栏用 SidebarItem 组件；分页统一。
6. **10–16 弹层**：任务详情补「风险与依赖 / 撤销最近操作 / 计划字段」区块；创建任务/待我接受/工件查看/项目管理/修改密码/一次性凭证校对文案与控件。
7. **新增 17 · 组合视图、18 · 发布状态**（浅+深，放到画板序列末尾）；计划字段作为 10 号任务详情帧内的独立区块（不再单独开帧）。
8. **自检**：`TakeScreenshot` 每帧；检查无裁剪、无文本假图标、列最小高度、thumb 存在。

## 阶段 B · 代码像素级还原（设计确认后）

1. 引入 `ScrollArea`（已安装）与 `Select` 到所有筛选处，删除原生 `<select>`。
2. 修复 `ExecutionHeader` chip 渲染（`name` 而非 `label`），补摘要+日期。
3. 重建 `FlowSignals` 为 4 卡 + 焦点建议；`AttentionQueue` 补 kicker/计数/脚注/最多 6 行。
4. `Kanban` 列体 `min-h-[260px]` + `ScrollArea`；页面主区纵向滚动。
5. `ArchiveView` 行尾 `ChevronRight`，行可点；表格 `ScrollArea`。
6. 管理台 5 个 tab 的筛选控件统一 `Select`。
7. 逐帧对照：tabbit 打开 `http://127.0.0.1:4317/`，截图与设计帧 1:1 比对，记录差异并修到一致。
8. 新增弹层（组合视图/发布状态）落地到 `features/board/dialogs/`。

## 验证

- 设计：`TakeScreenshot([frameId])` 逐帧检查；`Get` 检查 `ctx.problems` 无裁剪。
- 代码：`npm --prefix web run build`；`node --test tests/*.test.js`；tabbit 实测三页 + 弹层。
- 提交：阶段 A 与阶段 B 分开提交，均需用户确认。

## 风险

- 画板增高会改变深色帧位置，需成对调整，避免重叠。
- 设计稿与实现数值需一次性对齐；后续微调必须同时改 `.pen` 与样式，避免再次漂移。

## 设计定稿映射（供阶段 B 直接落地）

### 1. 新增语义 token（`web/src/index.css`）

```css
:root {
  --success: #15803D;          --success-soft: #DCFCE7;
  --warning: #B45309;          --warning-soft: #FEF3C7;
  --destructive-soft: #FEE2E2;
}
.dark {
  --success: #4ADE80;          --success-soft: #052E16;
  --warning: #FBBF24;          --warning-soft: #451A03;
  --destructive-soft: #450A0A;
}
@theme inline { --color-success: var(--success); --color-warning: var(--warning); ... }
```

### 2. 状态徽章映射（`features/**`）

| 文案 | class |
| --- | --- |
| 成功 / 已启用 / 已产出 / 已同步 / 当前 / 已应用 / 已批准 | `bg-success-soft text-success` |
| 等待批准 / 待产出 / 待发布 / 待确认 / 等待推送 / 已过期 | `bg-warning-soft text-warning` |
| 已停用 / 需修复 / 失败 | `bg-destructive-soft text-destructive` |
| P0 | `bg-destructive text-white` |
| P1 | `bg-warning-soft text-warning` |
| P2 | `bg-secondary text-secondary-foreground` |
| P3 | `bg-muted text-muted-foreground` |

### 3. 分页

- `Pagination` 补全：`上一页 · 1 · 2 · 3 · … · 10 · 下一页`，当前页 `bg-primary text-primary-foreground`，其余透明 + `text-muted-foreground`，按钮 26×26、圆角 6。
- 团队视角每页 20 条、归档每页 20 条、审计每页 10 条，均复用同一组件。

### 4. 弹层规范

- 容器：`rounded-xl border bg-card`（与 17/18 一致）。
- 右上角固定关闭图标按钮（`X`，`size-4`，`aria-label="关闭"`）。
- 底栏：右对齐，`[次要动作] ... [主要动作]`；关闭/取消在最左，主操作在最右。

### 5. 画板 → 代码映射

| 画板 | 代码 |
| --- | --- |
| 01 流水线 | `pages/board/BoardPage.tsx` + `features/board/*` |
| 02 团队 | `features/board/TeamView.tsx` |
| 03 归档 | `features/board/ArchiveView.tsx` |
| 04 登录 | `pages/login/LoginPage.tsx` |
| 05–09 管理台 | `pages/admin/AdminPage.tsx` + `features/admin/*` |
| 10–18 弹层 | `features/board/dialogs/*` + `features/admin/*Dialog.tsx` |
