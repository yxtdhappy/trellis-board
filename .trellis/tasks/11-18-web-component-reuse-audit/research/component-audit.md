# 逐文件组件复用审计（`packages/web/src`，非 `components/ui`）

方法：8 个只读切片按目录并行通读全部 62 个非 ui `.tsx`（约 520KB），每条记录 `文件:行 — 现状 — 应复用 — 理由`，切片末尾附「已通读文件 + 行数」证明零遗漏。不使用正则扫描。

8 个切片全部返回，覆盖 59 个文件：board 根目录(15)、board 大型对话框(3)、board/dialogs(10)、admin-A(7)、admin-B(7)、layout(3)、app(2)、desktop(5，含 main-index)、pages(3)、plugins(3)、settings(1)；另 3 个入口 `src/main-{login,board,admin}.tsx` 仅挂载 Provider 未审（对照 `desktop/main-index.tsx` 结论：无 UI 结构）。非 ui `.tsx` 总数 62 全部在此核对。切片均附「已通读文件 + 行数」。

## features/board/dialogs（10 文件，均无 `@base-ui/react/*` 直连）

| 文件:行 | 现状 | 应收敛到 |
|---|---|---|
| `AgentToolSelector.tsx:63-64` | 原生 `<input type="checkbox">` + 手写 label 卡片（全仓唯一漏网 checkbox）；`TaskOwnershipDialog.tsx:264` 复制同写法 | `ui/checkbox` + `Field` 横向变体 |
| `AgentToolSelector.tsx:71` | "已初始化" 手写药片 | `Badge variant="secondary"` |
| `AgentToolSelector.tsx:77-79` | 手写虚线空态 | `Empty` |
| `AgentQuickInitDialog.tsx:171`、`ProjectOnboardingDialog.tsx:600`、`TaskDetailDialog.tsx:430` | 加载占位第 2/3/4 次手写 | `Skeleton` |
| `AgentQuickInitDialog.tsx:200`、`AssigneeWarningDialog.tsx:68`、`PasswordDialog.tsx:96`、`AssignmentsDialog.tsx:103`、`BranchListenersDialog.tsx:75-80`、`PublishOperationDialog.tsx:77-79` | 提示条（callout）手写 6 份 | `Alert`（未装） |
| `AssignmentsDialog.tsx:81`、`ProjectManagerDialog.tsx:123-126` | 空态类名逐字相同 | `Empty` |
| `BranchListenersDialog.tsx:93` | 裸 `<p>` 空态 | `Empty` |
| `BranchListenersDialog.tsx:83` | 裸 `<p>` 加载态 | `Skeleton` |
| `AssignmentsDialog.tsx:88-101`、`ProjectManagerDialog.tsx:131-143`、`BranchListenersDialog.tsx:100` | 行卡片三份 | `Card`/`CardContent` |
| `BranchListenersDialog.tsx:110,113-121,124-127` | 三处 `rounded-full px-2 py-0.5 text-2xs` 药片 | `Badge` |
| `PublishOperationDialog.tsx:63-71` | 三态药片（`bg-destructive/10`/`bg-success-soft`/`bg-primary/10`） | `Badge` + tone 变体 |
| `SavedViewsDialog.tsx:110-118` 与 `:128-136` | `<Button size="xs" className="rounded-full">` + 手写 toggle 数组，同文件重复 | `ToggleGroup type="multiple"` |
| `CreateTaskDialog.tsx:291-293`（muted）、`PasswordDialog.tsx:100-102`（`text-destructive`）、`AgentQuickInitDialog.tsx:207`（`bg-destructive/10`） | 错误呈现三套 | `Alert variant="destructive"` / `FieldError` |
| `AssigneeWarningDialog.tsx:64-77` | 双正操作自建确认壳，正文绕过 `DialogBody` | 抽 `ConfirmShell`，正文回 `DialogBody`（唯一合理例外） |
| `CreateTaskDialog.tsx:222,226`、`ProjectManagerDialog.tsx:175-178` | 底部说明裸 `<p>` | `Alert`/callout |

无与 `ui/confirm-dialog` 重复的通用确认弹窗。

## features/admin-A（shared + ArchiveSyncTab + ProjectsTab + BranchManagementPanel + PluginsTab + UsersTab + TeamsTab）

| 文件:行 | 现状 | 应收敛到 |
|---|---|---|
| `shared.tsx:6` `controlClass` | 与 `ui/input.tsx`、`ui/select.tsx` 的 `SelectTrigger` 逐字重叠 | 删除，统一用 `Input`/`SelectField` |
| `shared.tsx:46` `StatusPill` | 与 `badge.tsx` 同形（`rounded-full px-2 py-0.5 text-2xs`） | `Badge` + `statusTone→variant` 映射 |
| `shared.tsx:25` `Panel` | 与 `ui/card` props 1:1 | `Card` |
| `shared.tsx:59` `EmptyRow` | 本目录 20+ 处 | `Empty` |
| `shared.tsx:67` `Field`、`:85` `Row` | ui 层无对应 | 保留（可考虑提升） |
| `ArchiveSyncTab.tsx:305`、`ProjectsTab.tsx:138,179,282,292,416` | `<SelectField className={controlClass}>` 冗余（内部已 `cn('w-full rounded-md', className)`） | 只传布局类 |
| `ArchiveSyncTab.tsx:198-208` 与 `:533-548` | "受影响项目" `<ul>` 列表两份 | 抽 `AffectedProjectList` |
| `ArchiveSyncTab.tsx:229-236`、`:631` | 三种加载/错误手写 | `Skeleton` + `Panel` |
| `ProjectsTab.tsx:458-486` 与 `PluginsTab.tsx:252-292` | "添加插件绑定"表单两份拷贝，字段与校验文案已不同步 | 抽 `PluginBindingForm` |
| `ProjectsTab.tsx:323` | 药片位裸 `<span>` | `Badge variant="outline"` |
| `BranchManagementPanel.tsx:237` | 分组计数 `rounded-full bg-muted px-1.5 py-0.5` | `Badge variant="secondary"` |
| `PluginsTab.tsx:253-263` | 原生 `<select className="h-7 … bg-card …">`（第三套下拉样式） | `SelectField` |
| `PluginsTab.tsx:265-279` | 两个原生 `<input>` 同串手写类（丢 focus ring / `aria-invalid`） | `Input` |
| `PluginsTab.tsx:163-174` | 行内容本身 `<button>`，同行 actions 又有"详情"按钮做同一件事 | 单一入口 |
| `UsersTab.tsx:132-149` 与 `AccountDialog.tsx:103-116` | 团队多选逐行相同 | 抽 `TeamCheckboxList` |
| `UsersTab.tsx:171-181` 与 `:271-276` | 同一 `AccountForm` 内联 + 弹窗两个编辑入口 | 保留一个入口 |
| `TeamsTab.tsx:117,171-182,184-193` | 原生 `input`/`select` + `controlClass` | `Input`/`SelectField` |
| `TeamsTab.tsx:123,159,195` | `size="sm" className="h-7 px-2 text-xs"`（与 `buttonVariants.size.sm` 重复） | 只写 `size="sm"` |
| `TeamsTab.tsx:204-224`、`:128-152` | 手写成员行 / 团队行按钮 | `Row` 结构 |

本目录 7 文件无手写 `<table>`、无 `@base-ui/react/*` 直连。

## features/admin-B（DevicesTab + AuditTab + AccountDialog + ResetPasswordDialog + MultiSelectField + OneTimeCredentialDialog + TeamSwitcher）

| 文件:行 | 现状 | 应收敛到 |
|---|---|---|
| `DevicesTab.tsx:50` | 手写 `rounded-full bg-destructive/10 …`，同屏 `:71` 已用 `StatusPill` | `Badge variant="destructive"` |
| `DevicesTab.tsx:99-108` | 原生 `input readOnly` + 手写边框 | `Input readOnly className="font-mono"` |
| `DevicesTab.tsx:123` | `<a>` 手写按钮外观 | `<Button variant="outline" size="sm" render={<a href/>}>` |
| `DevicesTab.tsx:172`、`AuditTab.tsx:173`、`OneTimeCredentialDialog.tsx:38` | muted 底等宽块三份 | 抽 `CodeBlock`（候选） |
| `AuditTab.tsx:58,70,82` | `<label><span>` 三连 | `Field`（同目录已有） |
| `AuditTab.tsx:14,61,73,85`、`AccountDialog.tsx:66`、`TeamSwitcher.tsx:31-43` | `controlClass` 灌进 `SelectField` / 原生 `<select>`（全站唯一残留原生 select） | `SelectField` |
| `AccountDialog.tsx:76-83` 与 `:89-99` | 两种"勾选框+文案"结构；与 `MultiSelectField` 构成两套多选 UI | `Field` 横向变体 |
| `AccountDialog.tsx:104-113` | 按钮行写在 `DialogBody`(147) 内 | `DialogFooter`（违反固定外壳约定） |
| `ResetPasswordDialog.tsx` | 干净 | — |
| `MultiSelectField.tsx:54-57` | `DropdownMenuTrigger` 写死整条输入皮肤（第三份） | `cn(controlClass, …)` 或 `Input` 外观类 |
| `MultiSelectField.tsx:68` | 手写 `ChevronDownIcon size-3.5` | 与 `SelectTrigger` 图标统一 |
| `MultiSelectField.tsx:72` | 写死 `<DropdownMenuLabel>Agent 工具</DropdownMenuLabel>` | props 传入 label（复用即破） |

## components/layout + app

| 文件:行 | 现状 | 应收敛到 |
|---|---|---|
| `ProjectRail.tsx:718`、`:726` | 同一段 warning 横幅两份 | `Alert` / 本地 `RailNotice` |
| `ProjectRail.tsx:813` | 手写药片（与 `board/ConditionChecks.tsx:242`、`plugins/PluginsView.tsx:313` 同款，三处） | `Badge variant="outline"` + className |
| `ProjectRail.tsx:889-893` | 计数药片三元 | `Badge` |
| `ProjectRail.tsx:900`、`:926` | `border-l` 画竖分隔线 | `Separator orientation="vertical"` |
| `ProjectRail.tsx:1003,1015` | 手写文字按钮（该文件第 5 行已 import `Button`） | `Button variant="ghost" size="xs"` |
| `ProjectRail.tsx:1028,1047,1058` | 手写图标按钮（同文件 `:825,838` 已用 `size="icon-xs"`） | `Button size="icon-xs"` |
| `ProjectRail.tsx:1109` | `rounded-xl bg-card p-2.5` 手搭卡片 | `Card`/`CardContent` |
| `ProjectRail.tsx:740,792,881,960,1113-1120` | 状态点三层三元，6 处 | 抽 `StatusDot` |
| `ProjectRail.tsx:597` | `flex max-h-56 … overflow-auto` | `ScrollArea` |
| `ProjectRail.tsx:800,823,841,913,1004` | 原生 `title=` 提示 | `Tooltip`（`TooltipProvider` 已在 `app/providers.tsx`） |
| `ProjectRail.tsx:1037,1067` | `animate-pulse` 图标脉冲 | **不是**骨架，不换 `Skeleton`（登记例外） |
| `TopBar.tsx:143-159` | 手写 tab 导航（`<nav>`+`<button>`+`aria-current`+两套 class） | `Tabs`/`TabsList variant="line"`（`ui/tabs` 全仓零使用） |
| `TopBar.tsx:117-141` 与 `:174-186` | 搜索框两份 | 抽 `SearchField` |
| `TopBar.tsx:129-136` | 手写"取消"按钮 | `Button variant="ghost" size="sm"` |
| `TopBar.tsx:191` | `DropdownMenuTrigger` 包 `Avatar` + 手抄 focus ring | `render={<Button variant="ghost" size="icon" className="rounded-full"/>}` |
| `TopBar.tsx:165-166` | 图标按钮 `title` | `Tooltip` |
| `TrellisLogo.tsx`、`app/theme.tsx`、`app/providers.tsx` | 干净（纯 SVG / 纯 Context / Provider 组合正确） | — |

## desktop + pages

| 文件:行 | 现状 | 应收敛到 |
|---|---|---|
| `desktop/LiveSyncControlDialog.tsx:260-277` | 文件切换器原生 `<button aria-pressed>` + 手写选中态 | `Tabs` |
| `desktop/LiveSyncControlDialog.tsx:649,703,765` | `dl.grid grid-cols-[80px_minmax(0,1fr)] rounded-md bg-muted/50 p-3` 三份；`:679,726` 同容器类名再两处 | 抽 `SummaryGrid` |
| `desktop/LiveSyncControlDialog.tsx:788-791`、`LoginApp.tsx:346-349,443-446`、`pages/board/BoardPage.tsx:320-328`、`pages/admin/AdminPage.tsx:172-178`、`pages/login/LoginPage.tsx:180-184`、`plugins/PluginsView.tsx:206-213` | `role="alert"` 错误条手写（全仓 18 文件） | `Alert variant="destructive"` |
| `desktop/LiveSyncControlDialog.tsx:635-637`、`LoginApp.tsx:306,379`、`LoginPage.tsx:140`、`AccountDialog.tsx:138`、`OneTimeCredentialDialog.tsx:47`、`ResetPasswordDialog.tsx:67`、`HandoffNotice.tsx:257` | 眉标排版常量 `text-2xs font-semibold tracking-[0.2em]` 各写一遍 | 抽 `Eyebrow` |
| `desktop/HandoffNotice.tsx:257-289` | 悬浮面板 `rounded-lg border bg-popover/95 … backdrop-blur` + `text-amber-500`/`text-sky-500` 手写色 | `Card` + `Badge` 变体 |
| `desktop/MonacoDiff.tsx`、`desktop/main-index.tsx` | 干净 | — |
| `pages/admin/AdminPage.tsx:167-170` | `rounded-xl bg-card px-4 py-6` 纯文本加载占位 | `Skeleton` |
| `pages/admin/AdminPage.tsx:180-188` | 无权限空态裸 `<div>` | `Card` + `Empty` |
| `pages/admin/AdminPage.tsx:192-210` | 原生 `<button aria-current>` 视图导航 + `bg-primary` 选中态 | `Tabs` |
| `pages/admin/AdminPage.tsx:112-117` | `<a>` 承载按钮样式 | `Button render={<a href="/"/>}` |
| `pages/board/BoardPage.tsx` | 只做组合，`useConfirm` 正确 | — |
| `pages/login/LoginPage.tsx` | 表单/卡片干净；错误条与 LoginApp 呈现不一致 | `Alert` |

## plugins + settings

| 文件:行 | 现状 | 应收敛到 |
|---|---|---|
| `PluginsView.tsx:194-201` | 原生 `<button>` 手写 `h-7 … hover:bg-muted disabled:opacity-50` | `Button variant="outline" size="sm"` |
| `PluginsView.tsx:215-218` 与 `:220-222` | 两个虚线框空态仅文案不同 | `Empty` |
| `PluginsView.tsx:231-346` | `<article className="rounded-xl border bg-card p-3.5">` 手搭卡片（全站 `ring-1 ring-foreground/10`，视觉会差） | `Card` |
| `PluginsView.tsx:266-278` | 拖拽把手原生 `<button>` 手写 | `Button variant="ghost" size="icon-xs"` |
| `PluginsView.tsx:285-294` | 状态药片（跨文件 `bg-{success,warning,destructive}-soft` 共 7 处：`AttentionQueue.tsx:30,68`、`ConditionChecks.tsx:162,242`、`PublishOperationDialog.tsx:68`、`TaskDetailDialog.tsx:491`） | `Badge` + tone |
| `PluginsView.tsx:298-300`、`:301-303`、`:305-308`、`:310`、`:312-316` | 五个手写药片（描边/描述/破坏/中性/警告） | `Badge` 的 outline/destructive/secondary + className |
| `PluginsView.tsx:329-343` | 启停用 `Button` | 正确，**不要**换 `Switch`（带 busy 的命令） |
| `PluginPanel.tsx`、`PluginLogsDialog.tsx:46-62` | 干净 / 外壳正确 | — |
| `PluginLogsDialog.tsx:38-44` | loading/error/空/内容四态压进一个 `<pre>` | `Skeleton` + `Empty` |
| `PreferencesDialog.tsx:94-121` | 主题三选一自建 `div role="radiogroup"` + 三个 `<button role="radio">`（漏 roving tabindex/方向键） | `Tabs`（受控单选）或 `RadioGroup`/`ToggleGroup` |
| `PreferencesDialog.tsx:129-154` | 字号分段控件外壳与 `TabsList` 默认变体逐字相同（`h-8 rounded-lg bg-muted p-0.75`），触发器写死 `h-6` 比内容区矮 2px | `ToggleGroup`（纯选项集，保留紫） |
| `PreferencesDialog.tsx:158-160` | "进行中" 手写药片 | `Badge` |
| `PreferencesDialog.tsx:92-93` 与 `:124-126` | `<section>`+`<span>` 手写标签行两份 | `Field`/`FieldLabel` |

## features/board/dialogs 三个大型对话框（TaskDetailDialog 896 / ProjectOnboardingDialog 856 / TaskOwnershipDialog 338）

| 文件:行 | 现状 | 应收敛到 |
|---|---|---|
| `TaskDetailDialog.tsx:430` | `<p className="py-10 text-center text-xs">正在读取任务详情…</p>` | `Skeleton` |
| `TaskDetailDialog.tsx:103-137` | `DependencyItem` 用 `<article className="rounded-lg bg-muted px-2.5 py-2">` 手搭卡片 | `Card`/`CardContent` |
| `TaskDetailDialog.tsx:104-108` | 关系药片 `<span className="rounded-full bg-background px-1.5 py-0.5 text-2xs font-semibold">` | `Badge variant="outline"`（`TaskCard.tsx:94` 已按此写） |
| `TaskDetailDialog.tsx:437-460` | 4 个元数据格子各写 `flex flex-col gap-1 rounded-lg bg-muted px-2.5 py-2` | `Card`/`CardContent` |
| `TaskDetailDialog.tsx:446-457`、`:467-475`、`:486-500`、`:570` | 药片四连：`cn('w-fit rounded-full px-1.5 py-px', priorityTone/statusTone/controlToneClass/stageTone)` | `Badge` + tone 函数只负责颜色 |
| `TaskDetailDialog.tsx:463-478` 与 `:789-796`、`:731` | 「标题+药片+说明」提示面板三种写法（实线卡 / 虚线卡 / bordered `<p>`） | `Alert`（未装）或 `Card` |
| `TaskDetailDialog.tsx:532-559` 与 `:659-683` | 两套表单行写法；532 的 `Label` 无 `htmlFor`、`Input` 无 `id`；659 只靠 placeholder | `FieldGroup`+`Field`（未装），至少补 `htmlFor`/`id` |
| `TaskDetailDialog.tsx:563-589` | 阶段证据用 `<ul className="divide-y">` + `li>div` 模拟四列数据表 | `ui/table` |
| `TaskDetailDialog.tsx:741-779` | 归档附件 `ul divide-y` 手拼「名称/mime/size/下载」行 | `ui/table` |
| `TaskDetailDialog.tsx:621,634,718,782` | 四处裸 `<p>` 空态（"当前没有活动阻断"等） | `Empty` |
| `TaskDetailDialog.tsx:696-715` | `<Button variant="ghost" className="h-auto … bg-muted">` 当列表行卡片（样式与语义耦合） | `Card`（整卡可点）或 `Table` 行 |
| `ProjectOnboardingDialog.tsx:586-591,625,629,633,707,737` | 「色边框+标题+说明+操作」提示块**同文件 6 次**（读失败 / 空仓库 / 核对中 / 替换警告 / 首推确认 / 预检结果） | `Alert`（`AlertTitle`/`AlertDescription`/`AlertAction`，未装） |
| `ProjectOnboardingDialog.tsx:600` | 裸 `<p className="rounded-lg border border-dashed p-4">` 当空态 | `Empty` |
| `ProjectOnboardingDialog.tsx:605-621` | `<dl className="grid grid-cols-[92px_minmax(0,1fr)] rounded-lg bg-muted/40 p-3">` 手搭信息卡（与 `LiveSyncControlDialog:649` 同款，第三份） | `Card` + `SummaryGrid` |
| `ProjectOnboardingDialog.tsx:629-631` | 虚线 `<p>` 当加载占位（同文件 `OnboardingSkeleton`(:193) 已在用 `Skeleton`） | `Skeleton` |
| `ProjectOnboardingDialog.tsx:737-783` | 预检 5 个互斥状态各自手写两段 `<p>`（740/747/754/765/777） | 单个 `Alert`，variant 由状态映射 |
| `ProjectOnboardingDialog.tsx:655-676` | 表单行手写（`htmlFor`/`id` 正确，行布局与 CreateTaskDialog/TaskDetailDialog 各一份） | `Field` 统一（现阶段不算错） |
| `TaskOwnershipDialog.tsx:222-241` | 每任务 `<label className="flex items-start gap-2 rounded-lg border p-2.5">` + `Checkbox` + 3 个 `<span>` | `Card` 容器 + `Field orientation="horizontal"` |
| `TaskOwnershipDialog.tsx:263-303` | 批量操作栏 bordered 面板混排 Checkbox/计数/3 Button/SelectField | `Card` + `Field` |
| `TaskOwnershipDialog.tsx:257` / `:259` / `:320-323` | 加载裸 `<p>` / 空态裸 `<p>` / `role="alert"` 裸 `<p>` | `Skeleton` / `Empty` / `Alert` |
| `TaskOwnershipDialog.tsx:219` | 分组标题把数量拼进文本 `{label}（{n}）` | `Badge variant="secondary"` 计数药片 |

明确不换（切片已核实）：`ProjectOnboardingDialog` 页脚「仅同步无冲突项 / 查看并处理差异」是两条独立命令、`TaskOwnershipDialog` 的「归属当前分支/归属所选分支/暂不处理」是三条命令 → **都不是 2–7 项互斥选项集，不适用 `tabs`/`toggle-group`**；`TaskDetailDialog` 的 `details/summary` 折叠因 ui 无 `collapsible` 保留原生。

## features/board 根目录（15 文件：ArchiveView 355 / AttentionQueue 90 / ConditionChecks 260 / ExecutionHeader 211 / FlowSignals 153 / Kanban 146 / Overview 28 / OwnershipInboxPanel 189 / Pagination 104 / SearchableSelect 86 / SelectField 55 / StageTape 30 / TaskCard 184 / TaskOperationList 115 / TeamView 341）

| 文件:行 | 现状 | 应收敛到 |
|---|---|---|
| `ArchiveView.tsx:237-250`、`TeamView.tsx:238-330` | 两张手写 `<table>`（近乎同构） | `ui/table` |
| `ConditionChecks.tsx:36-56` | `div grid` 手写表头+行（`grid-cols-[92px_minmax(220px,1.2fr)…]`）= 第三张假表 | `ui/table`（列宽 class 覆盖） |
| `Pagination.tsx:24-103` | 自有 `Pagination`（`pageItems` 窗口算法 + `numbered` 双模式）；`ui/pagination.tsx` **全仓库零引用** | `ui/pagination`（`pageItems` 留在调用方） |
| `SearchableSelect.tsx:2` | feature 层直连 `import { Combobox } from '@base-ui/react/combobox'`（全仓唯一越界） | 抽 `ui/combobox.tsx` |
| `SearchableSelect.tsx:41-49` | 触发器手写 `h-8 rounded-md border border-input bg-input/20 focus-within:ring-2`（第二份输入皮肤） | `SelectTrigger` 外观 |
| `SelectField.tsx:30-38`、`ExecutionHeader.tsx:196-200` | 手写 `<span data-slot="select-value">`（`SelectValue` 已导出） | `SelectValue` |
| `SelectField.tsx` + `SearchableSelect.tsx` + `ExecutionHeader.tsx:190-210` | 三套下拉封装（`FilterField` 又重写一遍 `SelectField`，options 形状相同、`import type { SelectOption }` 证明可互换） | 合并成一个（`searchable` 开关） |
| `ArchiveView.tsx:233`、`AttentionQueue.tsx:24`、`FlowSignals.tsx:53`、`Overview.tsx:19`、`TaskOperationList.tsx:55`、`TeamView.tsx:106,209`、`OwnershipInboxPanel.tsx:77` | 面板容器 `rounded-xl border border-border bg-card` **8 处**手写；`ui/card.tsx` 全仓零引用 | `Card` |
| `Overview.tsx:17-27` 与 `FlowSignals.tsx:133-146` | 同一指标瓦片写两遍 | 抽 `StatTile`（`Card size="sm"`） |
| `Kanban.tsx:33` | 泳道容器 `rounded-xl bg-muted/60 p-2.5` 手写 | `Card` + 背景覆盖 |
| `FlowSignals.tsx:124-130`、`Kanban.tsx:37`（`laneTone(...).split(' ')[0]`）、`TaskOperationList.tsx:11-27`、`ConditionChecks.tsx:113-119,137-138,162,206,219-220,242`、`TaskCard.tsx:100,113,150`、`TeamView.tsx:303,313` | tone 词表另有 6 份副本；`Kanban` 靠字符串切割取色 | 收敛到 `tone.ts` + `Badge` 变体，`tone.ts` 增结构化 `laneDotTone` |
| `AttentionQueue.tsx:30,50-53,68`、`Kanban.tsx:48-53`、`TaskCard.tsx:100-105,113-118,132-140,150-155`、`TeamView.tsx:282-286,303-307,313-317`、`ArchiveView.tsx:292-300`、`ExecutionHeader.tsx:89-97,107-116`、`OwnershipInboxPanel.tsx:137-139` | 手写药片（部分同卡内 `TaskCard.tsx:94` 已用 `Badge`，两种写法并存） | `Badge` 各变体 + tone class |
| `ArchiveView.tsx:283-285`、`TaskCard.tsx:159-161`、`TeamView.tsx:121-123,293-295` | 首字母头像圆片 5 处手写 | `Avatar size="sm"` + `AvatarFallback` |
| `TeamView.tsx:126-133` | `h-1.5 rounded-full bg-secondary` + 内联 `style={{width}}` | `Progress`/`ProgressTrack`/`ProgressIndicator` |
| `TaskCard.tsx:49-60`、`:170-178` | 裸 `<button>` 拼 `rounded-md border px-1.5 py-0.5`（"计划"按钮同） | `Button variant="outline" size="xs"` |
| `TaskCard.tsx:84-88` | 覆盖整卡的 `<button className="absolute inset-0">` | `Card render` 或卡内单个 Button |
| `AttentionQueue.tsx:41`、`OwnershipInboxPanel.tsx:117,121`、`Kanban.tsx:74-76`、`TaskOperationList` | 空态/加载态各写一套裸 `<p>` | `Empty` / `Skeleton` |
| `ArchiveView.tsx:227`、`OwnershipInboxPanel.tsx:106-108` | 错误条两种手写 | `Alert`（未装） |
| `StageTape.tsx` | 多段证据条，`ui/progress` 只表达单值 | 保留（`role="img"` + `aria-label` 已正确） |

## 横向结论（全量，59 个已审文件）

1. **已装组件空转**：`ui/card.tsx`、`ui/table.tsx`、`ui/tabs.tsx`、`ui/pagination.tsx` 四个组件**全仓库零引用**；`board/Pagination.tsx` 是它们的平行实现且有两处消费（`ArchiveView.tsx:336`、`TeamView.tsx:332`）。`ui/avatar` 仅 `TopBar` 用。
2. **原子层边界**：59 个文件中唯一越界点是 `features/board/SearchableSelect.tsx:2` 直连 `@base-ui/react/combobox`；其余全部经 `components/ui` 消费。`ui/*` 的 `cn` 来自 npm 包 `cn`（`packages/web/package.json:20`），feature 层 `cn` 来自 `@/lib/utils`，两套并存但不影响复用面。
3. **feature 层 mini 设计系统**：`features/admin/shared.tsx` 的 `controlClass`（SelectField 冗余 8 + 原生 3 + `AccountDialog:66`/`AuditTab:61,73,85`/`TeamSwitcher:33`）、`StatusPill`、`EmptyRow`、`Panel`、`Field`；board 侧另有 8 处手写面板容器、6 份 tone 词表、4 套下拉封装、5 处手写头像、2 张手写表 + 1 张 div 假表。
4. **缺失组件是各类手写的直接原因**：`alert`（`role="alert"` 遍布 18 文件；`ProjectOnboardingDialog` 单文件提示块 6 次）、`empty`（空态 40+ 处）、`field`（表单行 20+ 处、多处 `Label` 缺 `htmlFor`）、`toggle-group`（分段/多选药片：`PreferencesDialog:129`、`SavedViewsDialog:110,128`、`ExecutionHeader:83`）、`radio-group`（`PreferencesDialog:94-121` 手写 `role="radiogroup"`）、`combobox`（`SearchableSelect` 上提）、`collapsible`（`TaskDetailDialog` 保留原生 `details/summary`，暂不装）。
5. **值得抽的内部原子（≥2 次出现）**：`StatusDot`(6 处，`ProjectRail:740,792,881,960,1113-1120`)、`Eyebrow`(7 文件)、`CodeBlock`(3 文件)、`SummaryGrid`(`LiveSyncControlDialog:649,703,765,679,726` + `ProjectOnboardingDialog:605`)、`StatTile`(`Overview:17` + `FlowSignals:133`)、`SearchField`(`TopBar:117,174`)、`StatusPill→Badge` 映射、`TeamCheckboxList`(`UsersTab:132` + `AccountDialog:103`)、`PluginBindingForm`(`ProjectsTab:458` + `PluginsTab:252`)、`AffectedProjectList`(`ArchiveSyncTab:198,533`)、`PluginRouteForm` 无。
6. **两组真实重复实现（业务层）**：`UsersTab.tsx:171-181` 与 `:271-276` 同一 `AccountForm` 内联 + 弹窗双编辑入口；`PluginsTab.tsx:163-174` 行本身是 `<button>` 又带"详情"按钮双触发器。
7. **表格化候选 5 处**：`ArchiveView:237`、`TeamView:238`、`ConditionChecks:36`（div 假表）、`TaskDetailDialog:563`（`ul.divide-y` 模拟四列）、`TaskDetailDialog:741`（附件行）。
8. **明确不换**（切片已核实）：`animate-pulse` 图标脉冲（`ProjectRail:1037,1067`）、`<ul>/<li>` 语义列表、MPA 的 `<a href>`、命令式按钮组（`ProjectOnboardingDialog` 页脚两条命令、`TaskOwnershipDialog` 三条命令、`PluginsView` 启停）、`StageTape` 多段条、`MonacoDiff` 封装、`TrellisLogo` SVG、`theme.tsx` Context。
