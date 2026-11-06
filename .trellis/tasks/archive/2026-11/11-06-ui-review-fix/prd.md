# PRD · 设计稿缺陷修复与界面还原对齐

## Goal

修复 Pencil 设计稿（`design/trellis-board-redesign.pen`）中的设计规范缺陷，并对齐修复前端代码中 review 发现的视觉还原与功能交互问题（顶栏统一、控件高度对齐、负责人 Select 统一、品牌 Logo 矢量化、750ms 轮询死循环修复、以及团队视角侧栏切换项目联动刷新）。

## Background

在完成昨天前端 shadcn 重构后，通过对 Pencil 原型与当前浏览器（Standalone 模式）运行界面的深度比对，发现了多处设计缺陷、视觉还原漂移与交互功能问题：
1. **顶栏架构割裂**：设计稿 05~09 管理台顶栏将用户信息和退出登录直接平铺外露，缺少主题切换，与看板页面的头像下拉菜单模式完全脱节；代码也照此分裂实现。
2. **Logo 符号漂移**：设计稿顶栏手绘了网格晶格（Trellis Grid Bar），但未入组件库；代码全站降级为粗暴的紫色背景字母 `T`。
3. **控件高度混乱**：preset 属性选择器 `data-[size=default]:h-7`（28px）与代码中的 `h-8`（32px）、`size="sm"`（24px）产生冲突，导致归档、团队视角及管理台并排控件高低不齐。
4. **负责人 Select 控件实现错误**：创建任务弹窗（`CreateTaskDialog`）使用原生 `<input list="...">` + `<datalist>`，导致出现浏览器内置黑色实心倒三角 `▼`，与其他 `SelectField` 风格完全脱节。
5. **Standalone 模式 750ms 轮询死循环**：`useBoard.ts` 闭包捕获初次渲染的 `null` board，导致首次刷新后每 750ms 触发一次全量 GET `/api/board` 重载。
6. **团队视角侧栏项目切换无联动**：在团队视角页面通过左侧 ProjectRail 切换项目时，右侧任务列表未响应 `filters.projectId` 过滤，始终显示全部项目任务。

## Scope

### In scope

1. **Pencil 设计稿修订**：
   - 规范管理台顶栏架构，统一使用通用 SaaS TopBar 规范（包含暗黑模式切换，用户信息入口规范化）。
   - 在组件库中提取标准的 `Trellis Logo` 矢量组件，替换各画板中手绘的零散图层。
   - 统一画板中筛选栏控件高度基线规范（统一为 32px 档位）。
2. **代码界面与视觉对齐**：
   - 替换全站 Logo（`TopBar.tsx`、`AdminPage.tsx`、`LoginPage.tsx`）为符合设计规范的 Trellis 网格晶格矢量图标（支持浅色/深色主题）。
   - 统一全局表单与工具栏控件高度：修复 `SelectTrigger` 样式覆盖问题，使 `Input`、`SelectField`、`Button` 在并排场景下高度严格保持一致（统一为 32px `h-8`）。
   - 重构 `CreateTaskDialog.tsx` 中的负责人字段为标准 `SelectField`，移除原生 `<input>` 和 `<datalist>`。
   - 统一 `AdminPage.tsx` 顶栏，增加主题切换按钮，优化右上角布局。
3. **功能与交互缺陷修复**：
   - 修复 `useBoard.ts` 的 750ms 轮询逻辑，使用 ref 准确跟踪 `lastRefreshAt`，杜绝死循环全量重载。
   - 补齐任务创建的 `idempotencyKey` 生成与传递。
   - 修复 `TeamView.tsx` 项目筛选联动逻辑，使左侧边栏 `ProjectRail` 选项目时右侧列表与统计卡片即时同步过滤。

### Out of scope

- 团队模式完整改造（团队模式的缺陷在此任务中保持最小修复或在后续团队任务中深度展开，本任务聚焦视觉规范与 Standalone 模式稳定性）。
- 后端业务接口变动。

## Requirements

### R1 顶栏设计与实现统一
- 管理台顶栏（`AdminPage`）需包含主题切换（Sun/Moon），保持与看板（`TopBar`）一致的交互反馈与设计基调。
- 左侧 Brand Logo 统一使用 Trellis 网格晶格矢量组件：24×24 圆角 6px 的紫色背景矩形，内嵌清晰的白色/浅色 Trellis 网格线，消除纯文本 "T"。

### R2 控件高度与对齐规范
- 修复 `web/src/components/ui/select.tsx`，允许传入的 `className` 正确覆盖 `data-[size]` 默认高度，或为 `SelectTrigger` 增加尺寸适配。
- 在 `ArchiveView.tsx`、`TeamView.tsx` 以及管理台各个 Tab 中，水平并排的 `Input`、`SelectField` 与 `Button` 高度全部统一为 32px（`h-8`），消除上下错位。

### R3 创建任务负责人 Select 控件对齐
- `CreateTaskDialog.tsx` 负责人字段全量替换为 `SelectField`，选项为项目可选负责人列表，包含空占位符“请选择负责人”，右侧呈现统一的 Lucide `ChevronDown` 箭头，彻底移除原生 `<datalist>` 及黑色倒三角。

### R4 Standalone 轮询与状态修复
- `useBoard.ts` 内部使用 `useRef` 追踪最新生成的看板时间戳 `generatedAt`，只有当后端返回的 `status.lastRefreshAt !== lastLoadedAtRef.current` 且状态发生真实变化时才触发全量加载，避免每 750ms 持续全量重刷。
- 创建任务 POST 载荷附带 `idempotencyKey`。

### R5 团队视角侧栏切换项目联动
- `TeamView.tsx` 在计算 `rows` 与统计指标时，严格按当前的 `filters.projectId` 执行项目过滤（当 `projectId !== 'all'` 时只展示该项目所属任务）。
- 左侧 `ProjectRail` 点击不同项目时，团队视角的任务列表、负责人工作量分布卡片即时联动更新。

## Acceptance Criteria

- [x] Pencil 设计稿中的管理台顶栏增加主题切换，组件库补齐 Trellis Logo 组件。
- [x] 浏览器打开 `http://127.0.0.1:4317/`，全站（看板、管理台、登录页）左上角品牌图标呈现精致的 Trellis 网格矢量图形，无文字 "T"。
- [x] 归档页（`ArchiveView`）与团队视角页（`TeamView`）的搜索框、项目下拉框、负责人下拉框、刷新按钮在垂直方向完全齐平（高度均为 32px）。
- [x] 打开“创建任务”弹窗，负责人输入框为统一的 shadcn 下拉框，点击展开弹出菜单，无浏览器原生黑色倒三角 `▼`。
- [x] 管理台顶栏（`admin.html`）支持浅色/深色主题切换，样式与主看板顶栏协调一致。
- [x] 独立模式下看板网络请求平稳，750ms 轮询仅检查 status，不会触发无休止的 `/api/board` 全量重载。
- [x] 在团队视角下，点击左侧项目列表中的任一项目（如 `mdp-backend-web`），右侧任务列表立即仅显示该项目的任务，再次点击“全部项目”即恢复全部。
