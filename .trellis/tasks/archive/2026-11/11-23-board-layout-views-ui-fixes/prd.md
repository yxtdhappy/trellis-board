# 修复看板顶栏、项目侧栏与核心视图布局缺陷

## 1. 目标与用户价值（Goal & User Value）

系统性修复看板主界面、顶部栏（`TopBar`）、项目侧栏（`ProjectRail`）、各看板核心视图（`Kanban`、`AttentionQueue`、`TaskCard`、`StageTape`、`ExecutionHeader`、`OwnershipInboxPanel`、`TeamView`、`ArchiveView`、`Pagination`、`TaskOperationList`、`FlowSignals`、`Overview`、`StatTile`）及登录页（`LoginPage`）中的同行高度不一致、侧栏与队列纵向不可滚动/溢出裁切、窄屏响应缺失、隐藏按钮误触与暗色背景覆盖问题。

## 2. 前置依赖与范围边界

- **前置依赖**：子任务 2（`11-23-ui-primitives-foundation`），提供 `ScrollArea` 滚动修复、`StatusPill` `TONE_DOT` 实色修复、`SelectField` 省略号截断修复与 `index.css` 顶栏滚动条排除规则。
- **范围外**：不改动 `TeamSwitcher.tsx` 内部实现（由子任务 5 负责）；不修改后端筛选或分页接口；不回滚合理新增的看板业务功能。

## 3. 需求明细（Requirements）

- **REQ-1 TopBar 紧凑搜索与响应式修复**（`TopBar.tsx:135,168-241,251-272`）：
  - 紧凑搜索展开栏（L168-186）：「取消」按钮改 `size="default"`（`h-8`）并去除 `h-6 rounded-lg`，与同行 32px `Input` 等高；
  - 修复三元分支缺陷：在窄屏展开搜索后拉宽至 `>=64em` 时主导航 `<nav>` 保持可见；`searchOpen` 为 `true` 时隐藏右侧搜索图标按钮（L219）；为搜索展开容器补齐 `@max-[48em]:border-t @max-[48em]:border-border`；
  - 将 `<header>` 固定 `h-14` / `@max-[48em]:h-24` 调整为 `min-h-14` / `@max-[48em]:min-h-24 @max-[48em]:h-auto`（并合理约束窄屏控件），防止多团队切换器撑破顶栏；
  - 头像下拉菜单（L251-272）：`displayName` 增加 `truncate` 与 `title`，区分「待我接受」与「团队管理」菜单图标（换用 `Inbox` / `ClipboardCheck`）。

- **REQ-2 项目侧栏滚动、窄屏抽屉、分支行防挤与状态交互修复**（`ProjectRail.tsx:390,464-466,502-506`、`ProjectEntry.tsx:108-112,217-245,305-455`、`BoardPage.tsx:384-402`）：
  - `ProjectRail.tsx:390`：将中间项目/分支列表包裹在 `min-h-0 flex-1 overflow-y-auto` 容器中（或 `<aside>` 配合固定顶部操作区与底部「同步状态」卡片），避免项目/分支多时被外层 `h-dvh overflow-hidden` 直接截断；
  - `BoardPage.tsx:384-402` + `TopBar.tsx`：为 `<lg` 窗口提供展开 `ProjectRail` 的侧栏抽屉入口，避免窄屏/半屏无法切换分支与接入本地项目；
  - `ProjectRail.tsx:503`：`Alert` 去掉 `mx-1` 并补 `break-words` 防止撑出侧栏边框；全部项目/项目/分支非选中态补 `border border-transparent` 消除选中切换 2px 跳动；
  - `ProjectEntry.tsx:217-245,305-455`：将分支行右侧过密的状态文字操作（「待处理 N」「确认差异」）拆分至第二行或独立行，避免在 187px 宽内最多堆 5 个控件挤压分支名；统一行内文字按钮与图标按钮高度为 `h-5`；待归属按钮文案去掉重复数字（数字由右侧 `StatusPill` 展示），`disabled` 时禁用 hover 效果，有计数态悬停改用 `hover:brightness-95 dark:hover:brightness-110`。

- **REQ-3 Kanban 泳道、TaskCard 与 StageTape 修复**（`Kanban.tsx:36,54,82-90,114,126`、`TaskCard.tsx:96-108,132,190-209`、`StageTape.tsx:7,23`）：
  - `Kanban.tsx:36,54`：移除泳道硬编码 `min-h-[100vh]`，改用适中最小高度（如 `min-h-56` / `min-h-72`）与合理列内滚动上限；父子任务组头部补充 `gap-2`、`min-w-0`、`shrink-0 whitespace-nowrap`，子任务圆点与进度补充 `shrink-0`；
  - `TaskCard.tsx:96-108,132,190-209`：顶行改 `items-center`、右侧徽章容器加 `shrink-0`、路径加 `min-w-0`、「关系异常」改用 `<StatusPill tone="destructive" size="xs">`；处理底部 `opacity-0` 操作栏（融入底部负责人行右侧或悬浮角标 + `pointer-events-none group-hover:pointer-events-auto focus-within:pointer-events-auto`）消除常驻 29px 空白与隐形误触；「计划」按钮补 `disabled:pointer-events-none disabled:opacity-50`，底部进度补 `shrink-0`，负责人补 `min-w-0`；「未下载到本机」悬停改 `hover:brightness-95 dark:hover:brightness-110`；
  - `StageTape.tsx:7,23`：当前阶段高亮改 `ring-1 ring-inset ring-primary` 或提升对比度，防止被父容器 `h-1 overflow-hidden` 裁掉。

- **REQ-4 AttentionQueue、ExecutionHeader 与 OwnershipInboxPanel 修复**：
  - `AttentionQueue.tsx:27-36,43,50,55-60`：头部 `items-baseline` 改 `items-center`；标题补充 `min-w-0 flex-1`，项目/分支名去掉 `shrink-0` 改为 `max-w-48 truncate`；列表按钮补充 `rounded-md px-1.5`（配合子任务 2 `ScrollArea` 确保 `max-h-49` 正常滚动不溢出）；
  - `ExecutionHeader.tsx:24-30,85-129,135-208`：项目/负责人/阶段等 `SelectField` 增加 `max-w-52` 上限，`<label>` 文本加 `shrink-0 whitespace-nowrap`；视图胶囊消除边缘点击死区、自定义视图名加 `max-w-36 truncate`、未激活态显式写 `bg-card dark:bg-card` 防止暗色下被 `dark:bg-input/30` 覆盖；
  - `OwnershipInboxPanel.tsx:176,236,263-304,338`：编辑行按钮与 `SelectField` 高度统一（均 `h-8` 或统一 `h-7`）且 `SelectField` 改 `w-auto min-w-40 max-w-56`；警告面板按钮补充 `dark:bg-background/70 hover:bg-background hover:text-warning dark:hover:bg-background`；「加载更多」补全悬停样式且统一尺寸；「待归属」改用 `<StatusPill tone="warning" size="xs" className="shrink-0">`。

- **REQ-5 TeamView、ArchiveView、Pagination、TaskOperationList、FlowSignals/Overview/StatTile 与 LoginPage 修复**：
  - `TeamView.tsx:41,116-124,145,155-243,295-336`：右侧 `<Panel>` 补 `min-w-0`，外层布局改 `flex-col lg:flex-row` 适配中小屏；左侧筛选器增加清晰字段标识或区分默认文案（「全部优先级」/「全部阻断状态」）并对齐分支行左缘；去掉 `Separator` `mb-2` + `pt-2` 双重失衡间距；统计数字 `w-4` 改 `min-w-5`；页头搜索与刷新按钮成组、`刷新` 传 `disabled={loading}` 并与 `ArchiveView` 统一样式；清除 3 处 `whitespace-normal ... whitespace-nowrap` 冗余冲突并补长文本 `break-words`；
  - `ArchiveView.tsx:117-157,218-265`：移除 L141 `ml-auto`（或改 `xl:ml-auto`）防止中屏折行后第二行靠右悬空；任务/项目列补 `break-words`，归档时间改 `whitespace-nowrap tabular-nums`，行尾箭头按钮改 `inline-flex size-6 items-center justify-center rounded-md hover:bg-muted`；
  - `Pagination.tsx:42,57-59,77`：传入 `label` 时外层改 `flex w-full flex-wrap items-center justify-between gap-2` 与 `ArchiveView` 对齐；页码计数补 `whitespace-nowrap tabular-nums`；
  - `TaskOperationList.tsx:132-185`：将 `operation.error` 移至按钮之后作为末尾 `basis-full` 项，状态文案补 `shrink-0 whitespace-nowrap`；
  - `FlowSignals.tsx:63,107-114,137-144`、`Overview.tsx:17`、`StatTile.tsx:25`：`StatTile` 补 `min-w-0` 与默认 `tabular-nums`，`Overview` 改 `sm:grid-cols-3`（或平衡 3 卡布局），`FlowSignals` 补标签 `shrink-0 whitespace-nowrap` 与焦点建议 `break-words`；
  - `LoginPage.tsx:84,113,138-199`：`<lg` 窄屏在右侧卡片顶部显示 `TrellisLogo` 与品牌名；特性列表 `size-5` 圆圈补 `shrink-0`；错误 `AlertDescription` 移除 `text-sm` 对齐表单字号。

## 4. 验收标准（Acceptance Criteria）

- [ ] **AC-1**：`TopBar` 紧凑搜索栏按钮与输入框等高（`h-8`），拉宽窗口导航不丢失；`<lg` 窄屏可通过抽屉入口访问 `ProjectRail`，项目多时侧栏可滚动且底部「同步状态」始终可达；`ProjectEntry` 分支行不挤压分支名且无边框跳动。
- [ ] **AC-2**：`Kanban` 泳道高度合理不产生 100vh 空白；`TaskCard` 顶行居中、无底部隐形误触留白；`StageTape` 当前阶段高亮不被裁切；`AttentionQueue`、`ExecutionHeader`、`OwnershipInboxPanel` 无错位、无截断挤压、暗色背景与高度一致。
- [ ] **AC-3**：`TeamView`、`ArchiveView`、`Pagination`、`TaskOperationList`、`FlowSignals`/`Overview`、`LoginPage` 在桌面/中屏/窄屏及高字号下无溢出错位。
- [ ] **AC-4**：`@trellis-board/web` 的 `oxlint`、`tsc --noEmit`、`oxfmt --check` 与根仓库 `yarn test` 全部通过。
