# 技术设计：修复看板顶栏、项目侧栏与核心视图布局缺陷

## 1. 关键结构设计决策

1. **TopBar 紧凑搜索切换（`TopBar.tsx`）**：
   - 将 `<div className="... @min-[64em]:hidden">` 与 `<nav className={cn(..., searchOpen && 'hidden @min-[64em]:flex')}>` 改为 CSS 容器查询协同显隐，而非互斥三元卸载 `<nav>`，彻底解决用户在紧凑态点开搜索后拉宽窗口导致导航消失的缺陷；同时在 `searchOpen` 态为右侧搜索按钮追加 `hidden`（或条件隐藏）。
2. **ProjectRail 纵向滚动与窄屏抽屉（`ProjectRail.tsx` & `BoardPage.tsx`）**：
   - `BoardPage.tsx:361` 维持外层 `h-dvh overflow-hidden`，`ProjectRail` 内部划分为三段：`顶部标题+接入按钮（shrink-0）` → `中间项目/分支列表（min-h-0 flex-1 overflow-y-auto）` → `底部同步状态卡片（shrink-0）`。
   - `<lg` 窗口下复用同一套 `ProjectRail` 渲染到轻量侧栏抽屉/弹层中（在 `TopBar` 左侧仅 `<lg` 显示抽屉触发按钮）。
3. **TaskCard 操作栏零空白防误触（`TaskCard.tsx`）**：
   - 将「计划」与「复制任务名」收进底部负责人行右侧或以绝对定位浮层仅在 `group-hover` / `focus-within` 时开启 `pointer-events-auto`（默认 `pointer-events-none`），消除每卡底部 29px 空洞与隐形点击拦截。
4. **TeamView 筛选器可辨识性（`TeamView.tsx`）**：
   - 左栏各筛选器采用统一标签布局（或行内紧凑 `label` + `SelectField`），并区分优先级（「全部优先级」）与阻断（「全部阻断状态」）默认文案。

## 2. 文件范围

- `packages/web/src/pages/board/BoardPage.tsx`
- `packages/web/src/pages/login/LoginPage.tsx`
- `packages/web/src/components/layout/TopBar.tsx`
- `packages/web/src/components/layout/ProjectRail.tsx`
- `packages/web/src/components/layout/project-rail/ProjectEntry.tsx`
- `packages/web/src/features/board/{Kanban,AttentionQueue,TaskCard,StageTape,ExecutionHeader,OwnershipInboxPanel,TeamView,ArchiveView,Pagination,TaskOperationList,FlowSignals,Overview,StatTile}.tsx`
