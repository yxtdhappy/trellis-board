# Implement — Web 组件复用审计与 shadcn 最佳实践沉淀

前置：PRD「待评审确认」3 条答复后 `task.py start web-component-reuse-audit`。10 批各自独立闸门 + 独立提交（R16），每批完成后汇报范围与验证结果。

**每批固定闸门**（下称〈闸门〉）：

```
cd packages/web && npx tsc -b && npx oxlint src   # 格式化在仓库根：npx oxfmt <files>
```

外加该批的 `rg` 断言与浏览器抽查；控制台 0 error。

> 注：格式化真实命令是仓库根的 `npx oxfmt <files>`（root `package.json` 的 `format` = `oxfmt .`）；`yarn oxfmt` 不存在。

## 执行记录（实际顺序，计划外插入的视觉修正）

用户实测反馈插入了两轮「尺寸/原生控件/插件样式」修正，均落在批 2 之后、批 3 之前：

- 批 1（已提交 `d1687007c2` / `fc6864ca7c` / `99ce9c9ecb`）：13 个 `ui/` 文件 + `research/component-audit.md`。
- 批 2（未提交）：分段与单选 7 文件（`ui/toggle.tsx` 新增 `variant: 'primary'`；`PreferencesDialog`、`ExecutionHeader`、`AdminPage`、`SavedViewsDialog`、`LiveSyncControlDialog`、`TopBar`）。
- 批 2.5 视觉修正（未提交，计划外）：
  1. 字号段 `p-0.75`+`h-auto` → `p-0.5`+`h-full`（32 轨道 / 28 item，实测居中）。
  2. `AdminPage` 导航 TabsList 隐藏横向滚动条。
  3. `ui/select.tsx` `px-2 py-1.5` → `px-2 py-0`。
  4. 同排按钮统一 32px：`ProjectsTab`（刷新项目数据/邀请）、`TeamsTab`（创建/加入/停用）、`AuditTab`（刷新）、`ArchiveSyncTab`（刷新状态/全部立即同步/保存同步配置/创建凭据）、`DevicesTab`（刷新设备列表/生成令牌/生成配对码）、`FlowSignals`（WIP 输入 + 刷新）、`TeamView`（刷新）、`TaskDetailDialog`（阶段证据/保存计划字段/创建阻断依赖/确认分配）、`TaskOwnershipDialog`（三处）、`PluginsTab`（添加绑定）。
  5. 原生控件清零：`TeamSwitcher`、`TeamsTab`×2、`PluginsTab`（select + 2 input）→ `SelectField`/`Input`。
  6. `vite.config.ts` 增加 `/plugin-ui` proxy（dev 下插件面板 CSS 被 SPA 兜底成 HTML 的根因）。
  7. 头像/头部对齐：`TopBar`、`AdminPage` 的 `size-7` → `size-8`；`AdminPage` 返回看板链接补 `h-8`。
- 已验证：`npx tsc -b` rc=0、`npx oxlint` 0 error（14 条既有 warning）、`npx oxfmt` 19 文件通过；浏览器实测管理页 7 视图 + 看板 4 视图无高度不一致（仅品牌链接 `a:24` 保留）、`select` 数 0、5 个 `select-trigger` 全 32、字号组 32/28、`/plugin-ui/*.css` 返回 `text/css`。

- 批 3（已落盘，未提交）：
  1. `SelectField` 手写 `<span data-slot="select-value">` → `SelectValue`（占位符走 `text-muted-foreground`）。
  2. 删 `ExecutionHeader` 的 `FilterField`（4 处调用 + 定义），5 个筛选项统一 `<label>标签 + SelectField className="w-auto min-w-28"`。
  3. `SearchableSelect` 改为 `@/components/ui/combobox` 组合（`ComboboxInput/ComboboxContent/ComboboxList/ComboboxItem/ComboboxEmpty`），对象 value + `itemToStringLabel`；`features/**` 再无 `@base-ui/react/*` 直连。
  4. 删 `features/admin/shared.tsx` 的 `controlClass`（11 处调用点清零）：`SelectField` 去掉冗余 `className`，`TeamsTab` 原生 `<input>` → `Input className="text-xs"`。
  5. **偏差 1**：`SelectField` 未加 `searchable` prop——需要搜索的场景由 `SearchableSelect`（combobox）承担，加开关会让一个组件承担两种交互，违反单一职责。
  6. **偏差 2**：`features/admin/MultiSelectField.tsx` 直接删除而非改 combobox 多选——全仓库 0 个调用点（`AgentToolSelector` 早已自带一份），属死代码。
  7. 顺带修 `AdminPage` 头部头像 `<Avatar size="sm" className="size-8">` → `<Avatar className="size-8">`（`data-[size=sm]:size-6` 与 `size-8` 是不同 modifier，`cn` 不消解，实际渲染 24px）。
  8. 断言全过：`rg -n "@base-ui/react|<select|<option|controlClass" packages/web/src -g '!**/components/ui/**'` 均无输出；`npx tsc -b` rc=0、`npx oxlint` 0 error、`npx oxfmt` 9 文件。
  9. 浏览器实测（临时实例 4318/5180）：看板 5 个筛选 `select-trigger` 全 32px、选 P0 生效；归档索引 3 个 combobox 输入 32px、popup 列出选项、选中后输入框显示标签；管理页「团队」`select-trigger` 三个全 32、`select` 数 0、无高度不一致；账号编辑弹窗 trigger/Input 32、`select` 数 0。


## 批 0 基线（无代码改动）

1. `git stash list` 确认 `stash@{0}` = `wip(prefs-tabs)`；`git stash show -p stash@{0}` 留作批 2 的 `ExecutionHeader` 参考实现。
2. 记录浏览器基线截图：偏好设置、看板（概览/团队/归档）、admin（Teams/Users/Projects/Audit/Plugins/Devices/ArchiveSync）、desktop 同步对话框、登录页。存项目内临时目录，批末删除。
3. 确认审计清单文件数与工作区一致：`git ls-files 'packages/web/src/**/*.tsx' | grep -v components/ui | wc -l` = 62。

## 批 1 组件层补齐（不动业务）

1. `cd packages/web && npx shadcn@latest add toggle toggle-group field input-group empty alert combobox`。
2. 修生成文件的 import：`@/registry/base-mira/ui/*` → `@/components/ui/*`（`toggle-group.tsx` 引 `toggleVariants`，`combobox.tsx` 引 `input-group`）。`toggleVariants` 档位保持原样。
3. `components/ui/badge.tsx`：`badgeVariants.variant` 加 `success: 'bg-success-soft text-success'`、`warning: 'bg-warning-soft text-warning'`；新增 `size` 维度 `{ default: '', xs: 'h-auto px-1.5 py-px' }`（现有 `h-5 px-2 text-2xs` 留在 default）。**不加** `danger`/`neutral`/`info`。
4. 新建 `components/ui/panel.tsx`：从 `features/admin/shared.tsx:25-42` 平移 props（`title/kicker/description/action/children/className`），容器保留 `rounded-xl border border-border bg-card`，内部用 `Card className="rounded-xl ring-0"` + `CardHeader/CardTitle/CardDescription/CardAction/CardContent`；`kicker` 保留 `tracking-[0.14em]`。
5. 新建 `components/ui/empty-row.tsx`（`Empty` + `EmptyTitle` 单行紧凑变体，视觉照抄 `shared.tsx:59`）、`components/ui/status-pill.tsx`（`tone → Badge variant` 映射表见 design §5）、`components/ui/code-block.tsx`、`components/ui/eyebrow.tsx`。
6. `ui/combobox.tsx` 由 `shadcn add combobox` 生成（295 行，16 导出），不是自建：确认 import 已指向 `@/components/ui/*`；多选场景用 `ComboboxChips`/`ComboboxChip`/`ComboboxChipsInput`。
7. 〈闸门〉；断言 `npx shadcn@latest view` 装出的 7 个文件均能被 `import { … } from '@/components/ui/x'` 解析（`tsc` 覆盖）。本批不产生业务 diff：`git diff --stat packages/web/src/features` 为空。

提交：`feat(web): 补齐 ui 原子层并新增 panel/status-pill/combobox`

## 批 2 分段与单选控件（8 处）

1. `features/board/ExecutionHeader.tsx:58-80` → `Tabs/TabsList/TabsTrigger` + `aria-label="任务范围"`（取 `stash@{0}` 已验证版本）。
2. `features/settings/PreferencesDialog.tsx:129-141` → 受控 `ToggleGroup value={[fontSize]}`，容器 `flex h-8 items-stretch rounded-lg bg-muted p-0.75`，`spacing={0.75}`（不能是 0，否则圆角被 `group-data-[spacing=0]` 接管，见 design §3.5），item `h-auto self-stretch flex-1 rounded-md text-xs`；`onValueChange` 取 `FONT_CHOICES.find(...)?.value` 后 `if (next)`，忽略空数组（单选不可取消）。紫色被 `toggleVariants` 的 `aria-pressed:bg-muted` 压住 → 在 `ui/toggle.tsx` 加 `variant="primary"`。
3. `PreferencesDialog.tsx:94-121` 主题三选一 → `ToggleGroup`，item 内保留 `<ThemePreview>` 装饰块。
4. `components/layout/TopBar.tsx:143-159` → **不换 Tabs**（MPA 跳转，无 tabpanel）：保留 `<nav>` + `aria-current="page"`，两套手写 class 收编成 `Button variant="ghost" size="sm"`；保留现有滚动到可视区 `useEffect`（`:76-87`）。
5. `pages/admin/AdminPage.tsx:192-210` → `Tabs`（`aria-current` 与 `bg-primary` 选中态删除）。
6. `desktop/LiveSyncControlDialog.tsx:260-277` → `ToggleGroup orientation="vertical"`（文件列表是纵向单选，不是视图切换），`value` 用索引字符串。
7. `features/board/dialogs/SavedViewsDialog.tsx:110-118,128-136` → `<ToggleGroup multiple spacing={1.5}>`（圆角要归调用侧），删手写 `toggle()` 数组逻辑。
8. `ExecutionHeader.tsx:83-105`（保存组合视图）**移到批 4**：走 `badgeVariants`（design §3.4），不用 ToggleGroup（内层有删除按钮）。
9. 浏览器实测：字号组 32px 轨道 / 26px item / 紫色；看板组 `role=tab` + `aria-selected=true`；顶部导航与 admin 导航左右方向键可切换；保存视图"点名称切换、点 × 只删"。
10. item 仍矮 2px → 试 `self-stretch`；无效则停下问用户（不自行退回 `Tabs`）。

提交：`refactor(web): 分段与单选控件改用 tabs/toggle-group`

## 批 3 下拉与输入（19 处）

1. `features/board/SelectField.tsx`：props 保持（`SelectOption`），新增 `searchable?: boolean`；`searchable` 时内部走 `@/components/ui/combobox`；手写 `<span data-slot="select-value">`（`:30-38`）→ `SelectValue`。
2. 删 `features/board/ExecutionHeader.tsx:190-210` 的 `FilterField`，调用点换 `SelectField`。
3. `features/board/SearchableSelect.tsx` 只留数据适配，原语改从 `@/components/ui/combobox` 取；`rg -n "@base-ui/react" packages/web/src -g '!**/components/ui/**'` 无输出。
4. 删 `features/admin/shared.tsx:6` 的 `controlClass`，11 处调用点：`<input>`→`<Input className="text-xs">`、`<textarea>`→`<Textarea className="text-xs">`、`<select>`→`SelectField`。涉及 `AccountDialog:66`、`ArchiveSyncTab`、`AuditTab:61,73,85`、`ProjectsTab:138,179,282,292,416`、`TeamSwitcher:33`、`TeamsTab:117,171-182,184-193`。
5. 原生控件收编：`features/admin/PluginsTab.tsx:253-263,265-279`（原生 `<select>` + 两个 `<input>`）、`TeamsTab:117,171-193`、`TeamSwitcher:31-43`（全站最后一个原生 `<select>`）→ `SelectField`/`Input`。
6. `features/admin/MultiSelectField.tsx:50-60` 触发器 → `ui/combobox` 多选形态；`:72` 写死的 `<DropdownMenuLabel>Agent 工具</DropdownMenuLabel>` 改 props。
7. 〈闸门〉+ 断言 `rg -n "controlClass|<select|<option" packages/web/src -g '!**/components/ui/**'` 无输出。

提交：`refactor(web): 下拉与输入收敛为 select-field/combobox`

## 批 4 tone 与药片（≈45 处）

1. `features/board/tone.ts`：`priorityTone/stageTone/laneTone` 返回 tone 键；新增 `laneDotTone(id)`；删拼接 class 的代码。
2. `features/board/task-view.ts` 的 `controlToneClass` → `controlTone`（返回 tone 键）。
3. `features/admin/shared.tsx`：`StatusPill`/`TONE_CLASS` 删除，调用点改 `import { StatusPill } from '@/components/ui/status-pill'`（33 处 / 10 文件）。
4. 手写药片 → `Badge`/`StatusPill`：`TaskCard:100,113,150`、`TeamView:303,313`、`PluginsView:285-316`（5 个）、`TaskDetailDialog:446,467,486,570`、`BranchListenersDialog:110,113,124`、`PublishOperationDialog:63-71`、`PreferencesDialog:158`、`ProjectRail:813,889`、`AttentionQueue:30,68`、`ConditionChecks:137,162,206,219,242`、`TaskOperationList:11-27`、`FlowSignals:124-130`、`Kanban:37`。
5. 删 `ConditionChecks:113-119`、`FlowSignals:124-130`、`TaskOperationList:11-27`、`TaskCard` 内的本地 tone 词表。
6. `features/board/ExecutionHeader.tsx:83-105`（保存组合视图，从批 2 移入）：已保存视图的 `<span>` 用 `badgeVariants({ variant: active ? 'default' : 'outline' })` 做类来源、内置视图用 `<Badge render={<button aria-pressed/>}`（design §3.4）；保留外层切换 + 内层 `×` 两个按钮。
7. 断言：`rg -n "bg-(success|warning|destructive|primary)-soft" packages/web/src -g '!**/components/ui/**'` 无输出；`rg -n "rounded-full (px|py)-" …` 仅剩登记例外（`StageTape`、`HandoffNotice`）。
8. 四档 tone 各验一次配色与迁移前一致。

提交：`refactor(web): 状态药片与 tone 配色收敛到 badge`

### 执行记录（批 4，已完成）

改动 20 文件：`ui/badge.tsx`、`ui/status-pill.tsx`、`lib/admin-shared.ts`、`features/admin/shared.tsx`、`features/board/{tone.ts,task-view.ts,AttentionQueue,TaskCard,TeamView,Kanban,ConditionChecks,ExecutionHeader}`、`features/board/dialogs/{TaskDetailDialog,BranchListenersDialog,PublishOperationDialog}`、`features/plugins/PluginsView.tsx`、`features/settings/PreferencesDialog.tsx`、`components/layout/ProjectRail.tsx`。

偏差与取舍：
- badge 实际新增 **`info` / `primary-soft` / `danger`(实心红)** 三档（design §2 已同步修正）：`bg-info-soft`、`bg-primary-soft`、`bg-destructive text-white` 用现有变体表达不了，强转会视觉漂移。`neutral` 仍不加（`secondary` 覆盖）。
- admin 适配器**已删除**（用户要求单一形态）：`features/admin/shared.tsx` 不再导出 `StatusPill`，23 处调用点改为直连 `@/components/ui/status-pill` + `statusTone()`，形如 `<StatusPill tone={statusTone(x)}>{x || 'unknown'}</StatusPill>`（涉及 `AccountDialog`/`ArchiveSyncTab`/`AuditTab`/`BranchManagementPanel`/`DevicesTab`/`PluginsTab`/`ProjectsTab`/`TeamsTab`/`UsersTab`/`shared.tsx` 的 `AuditItem`）。
- 圆点色用 `ui/status-pill.tsx` 的 `toneDot(tone)`（计划中的 `laneDotTone`），`Kanban.tsx:39` 的 `.split(' ')[0]` 已删。
- `ExecutionHeader` 已保存视图与内置视图**都**用 `badgeVariants` 生成类，未用 `Badge render={<button/>}`（外层要嵌套 `×` 按钮，`Badge` 的 `overflow-hidden`/固定 `h-5` 不合适）。

保留例外（非药片，不改）：
- `FlowSignals.tsx:118-124`、`TaskOperationList.tsx:11-27` 是**文字色**映射，不是药片。
- `TaskCard.tsx:130` 是交互式"下载到本机"胶囊按钮（带 `disabled`/`hover`），保留 `<button>`。
- `ConditionChecks.tsx:113-119,137-138,219-220` 是容器底色/图标方块，属批 6。
- 横幅类 `bg-*-soft`（`ProjectRail:732,740,908`、`PluginsView:209`、`ConditionChecks:75`、`OwnershipInboxPanel:77`、`AgentQuickInitDialog:200`、`ProjectOnboardingDialog:633`）留批 6 `Alert`。

实测（4318 + 5180 + tabbit，临时库 `C:\projects\.trellis-verify-data`）：
- 看板 Kanban 四个泳道计数药片：`info`=`rgb(219,234,254)`/`rgb(29,78,216)`、`warning`=`rgb(254,243,199)`/`rgb(180,83,9)`、`primary-soft`=`rgb(237,233,254)`/紫、`success`=`rgb(220,252,231)`/`rgb(21,128,61)`，高度 19–20px，`rounded-full` 生效。
- 执行头组合视图胶囊：选中 `bg-primary` 紫 + 26px、未选中 `bg-card` + 26px（同高，批 2.5 的 24/26 差异已消失）。
- 插件页状态药片 `运行中` → `success` 变体绿底；`document.querySelectorAll('select').length === 0`。
- 管理页「团队」：`active` → `success` 绿底 20px（走适配器）；导航 7 个 `role=tab` 正常。

## 批 5 空态与加载（空态 40+ / 骨架 10）

1. 37 处 `EmptyRow` 只改 import 到 `@/components/ui/empty-row`；删 `features/admin/shared.tsx:57-63`。
2. 散落空态 → `Empty`：`AttentionQueue:41`、`OwnershipInboxPanel:117,121`、`Kanban:74`（保留 `border-dashed` 外观）、`TaskDetailDialog:621,634,718,782`、`PluginsView:215,218,220`、`ProjectOnboardingDialog:600`、`TaskOwnershipDialog:259`、`AdminPage:180`、`AgentToolSelector:77-79`、`TaskOwnershipDialog:264`、`AssignmentsDialog:81`、`ProjectManagerDialog:123`、`BranchListenersDialog:93`、`TeamView:117,250`、`AssignmentsDialog:103` 同族空态。
3. 加载占位 → `Skeleton`：`AgentQuickInitDialog:171`、`ProjectOnboardingDialog:629`、`TaskDetailDialog:430`、`TaskOwnershipDialog:257`、`AdminPage:167`、`ArchiveSyncTab:229,631`、`PluginLogsDialog:38`、`OwnershipInboxPanel:121`。
4. `AgentToolSelector.tsx:63-64` 原生 checkbox → `Checkbox`（`id` + `label htmlFor`）；`:71` 药片 → `Badge`。
5. 断言 `rg -n 'type="checkbox"' packages/web/src/features` 无输出；`ProjectRail:1037,1067` 的 `animate-pulse` **不动**。

提交：`refactor(web): 空态与加载占位改用 empty/skeleton`

### 执行记录（批 5，已完成）

实测口径修正：`EmptyRow` 实际 **28 处 / 8 个 admin 文件**（`ArchiveSyncTab`3、`AuditTab`2、`BranchManagementPanel`2、`DevicesTab`3、`PluginsTab`2、`ProjectsTab`11、`TeamsTab`3、`UsersTab`2），不是 37 处；`features/admin/shared.tsx` 的 `EmptyRow` 已删。

改动文件（21）：
- `components/ui/`：无新增依赖改动（`empty`/`skeleton`/`checkbox` 批 1 已装）。
- admin：`ArchiveSyncTab.tsx`（`EmptyRow` 来源 + 2 处 `Skeleton`）、`AuditTab.tsx`/`BranchManagementPanel.tsx`/`DevicesTab.tsx`/`PluginsTab.tsx`/`UsersTab.tsx`/`TeamsTab.tsx`/`ProjectsTab.tsx`（`EmptyRow` 来源）、`shared.tsx`（删 `EmptyRow`）。
- board：`AttentionQueue.tsx`（Empty）、`OwnershipInboxPanel.tsx`（Skeleton + Empty）、`dialogs/AssignmentsDialog.tsx`、`dialogs/ProjectManagerDialog.tsx`、`dialogs/BranchListenersDialog.tsx`、`dialogs/TaskOwnershipDialog.tsx`（Skeleton + Empty）、`dialogs/TaskDetailDialog.tsx`（2 处 Skeleton）、`dialogs/ProjectOnboardingDialog.tsx`（Empty + Skeleton）、`dialogs/AgentQuickInitDialog.tsx`（Skeleton）、`dialogs/AgentToolSelector.tsx`（`Checkbox` + `id`/`htmlFor`、`Empty`、`已初始化` → `<Badge variant="secondary" size="xs">`）。
- 其它：`features/plugins/PluginsView.tsx`（2 处 `Empty` + `EmptyHeader/Title/Description`）、`pages/admin/AdminPage.tsx`（加载 → 3 行 `Skeleton`、denied → `Empty`）。

偏差与保留：
- `Empty` 允许 `className` 覆盖紧凑内边距（`p-3`/`p-4`/`bg-muted/40`/`border border-dashed`），因为其默认 `p-6 + flex-1` 在侧栏和弹窗正文里过重；`Empty` 的 `border-dashed` 只有在调用侧给 `border` 宽度时才可见。
- 行内轻量空态**保留纯 `<p>`**：`dialogs/TaskDetailDialog.tsx:602,614`（两列依赖格）、`TeamView.tsx:117`（`<li>` 列表项）、`TeamView.tsx:250-256`（表格 `colSpan` 行）、`AccountDialog.tsx:88`/`UsersTab.tsx:133`（表单提示）、`ArchiveSyncTab.tsx:198`（确认文案列表）、`CreateTaskDialog.tsx:226`/`ProjectOnboardingDialog.tsx:744,758`（错误文案）。判定：换成 `Empty`/`EmptyRow` 会引入 `p-4`+背景+圆角，破坏两列格与表格行高。
- `Kanban.tsx:74` 是列表过滤逻辑不是空态，未动。
- `AgentToolSelector` 由 `<label>` 包裹改为 `htmlFor` + `id`：Base UI `Checkbox` 渲染的是 `button[role=checkbox]`，label 包裹点击不会切换，必须走 `for/id`。
- `onChange` → `onCheckedChange`：与仓内既有用法一致（`dialogs/TaskOwnershipDialog.tsx` 全选 checkbox）。

验证：
- `cd packages/web && npx tsc -b` rc=0；`npx oxlint` 21 文件 0 error / 19 条既有 warning；`npx oxfmt` 21 文件通过。
- 断言 `rg -n 'type="checkbox"' packages/web/src` 无输出；`rg -n '正在读取|正在加载|加载中'` 在 `packages/web/src`（排除 `components/ui`）无输出。
- 浏览器实测（4318 后端 + 5180 vite）：看板侧栏 `[data-slot="empty"]` 渲染「当前没有逾期、截止、停滞与阶段信号。」；`admin.html` 项目协作 6 个 `p.rounded-lg.bg-muted/50`（`EmptyRow`）正常渲染、7 个 `role=tab`；插件 tab 药片正常。`data-slot="checkbox"` 的交互由 `TaskOwnershipDialog` 既有用法与 tsc 保证（`AgentQuickInitDialog`/`ProjectOnboardingDialog` 需要本地 Git 仓库才能打开，浏览器不可达）。

## 批 6 提示与错误（30+）

1. 错误条 → `<Alert variant="destructive">`：`LoginApp:346,443`、`LoginPage:180`、`BoardPage:320`、`AdminPage:172`、`LiveSyncControlDialog:788`、`PluginsView:206`、`OwnershipInboxPanel:106`、`ArchiveView:227`、`TaskOwnershipDialog:320`、`ProjectOnboardingDialog:586`、`PasswordDialog:100`、`AgentQuickInitDialog:207`、`PublishOperationDialog:77`、`CreateTaskDialog:291`（成功文案改走 `toast`）。
2. 提示/说明 → `Alert`（`default` 或 `className` 覆盖 success/warning 配色）：`dialogs/` 6 份 callout（`AgentQuickInitDialog:200`、`AssigneeWarningDialog:68`、`PasswordDialog:96`、`AssignmentsDialog:103`、`BranchListenersDialog:75`、`PublishOperationDialog:79`）、`ProjectOnboardingDialog:625,629,633,707,737,783`（预检 5 状态按状态映射 variant）、`ProjectRail:718,726`（抽本地 `RailNotice`）、`TaskDetailDialog:463,731,789`、`HandoffNotice:257`。
3. 断言 `rg -n 'role="alert"' packages/web/src -g '!**/components/ui/**'` 无输出。
4. 浏览器验证：登录失败、看板无团队 403、插件启动失败三条错误路径外观一致且可读。

提交：`refactor(web): 提示与错误条统一为 alert`

### 执行记录（批 6，已完成）

- 错误条 → `<Alert variant="destructive"><AlertDescription>…</AlertDescription></Alert>`（15 处 / 12 文件）：`pages/board/BoardPage.tsx`、`features/board/ArchiveView.tsx`、`features/plugins/PluginsView.tsx`、`pages/admin/AdminPage.tsx`（启动失败）、`pages/login/LoginPage.tsx`、`desktop/LoginApp.tsx`（环境错误 + 登录错误两处，保留 `AlertCircle` 作首个 `<svg>` 子元素，走 `has-[>svg]` 两列栅格）、`desktop/LiveSyncControlDialog.tsx`、`features/board/dialogs/BranchListenersDialog.tsx`、`features/board/dialogs/PublishOperationDialog.tsx`、`features/board/dialogs/ProjectOnboardingDialog.tsx`（`associationLoadError`）、`features/board/dialogs/AgentQuickInitDialog.tsx`、`components/layout/ProjectRail.tsx`（`associationError`，`className="mx-1 mt-1 text-2xs leading-4"`）、`features/board/OwnershipInboxPanel.tsx`（错误 + `重试` 按钮放进 `AlertDescription` 的 flex 行）、`features/admin/ArchiveSyncTab.tsx`（概览错误用 `AlertTitle` + `AlertDescription` 包 `重新读取`；日志错误单行）、`features/admin/BranchManagementPanel.tsx`（删除分支影响说明）。
- 成功/警告配色仍靠 `className` 覆盖（`Alert` 只有 `default`/`destructive`）：`features/board/dialogs/AgentQuickInitDialog.tsx`（已全部初始化 → `border-success/35 bg-success-soft text-success`）、`features/board/ConditionChecks.tsx` `SuccessSummary`（`border-success/20 bg-success-soft text-success`，保留 `CircleCheckIcon`）、`features/board/dialogs/ProjectOnboardingDialog.tsx`（`replacedAssociations` 警告块 → `border-warning/35 bg-warning-soft text-warning`）、`components/layout/ProjectRail.tsx` 两条同步/待确认提醒（`role="status"`，覆盖 `Alert` 硬编码的 `role="alert"`）。
- 顺带补齐批 4 漏收的两处药片：`features/admin/DevicesTab.tsx:52`（`已撤销 …` → `<StatusPill tone="destructive">`）、`features/board/TaskCard.tsx:175`（关注信号 → `<StatusPill tone="destructive" size="xs">`）。

保留例外（不套 `Alert`）：

- 表单内联错误保持纯文本：`features/board/dialogs/PasswordDialog.tsx:100`、`features/admin/ResetPasswordDialog.tsx:100`、`features/board/dialogs/TaskOwnershipDialog.tsx:321`、`features/board/dialogs/AssigneeWarningDialog.tsx:77`、`features/admin/BranchManagementPanel.tsx:309,372`、`features/board/dialogs/ProjectOnboardingDialog.tsx:588,744,751`、`features/board/dialogs/CreateTaskDialog.tsx:226`、`features/admin/ProjectsTab.tsx:401`、`features/plugins/PluginsView.tsx:327`、`features/board/TaskOperationList.tsx:81`。
- 容器型/可交互提示保持原标签：`features/board/OwnershipInboxPanel.tsx:80`（`<section>` 带按钮的警告区）、`features/board/TaskCard.tsx:130`（可点击的"下载到本机"胶囊）、`components/layout/ProjectRail.tsx:885`（带冲突圆点的可点击 chip，`bg-destructive/10` 属交互底色）、`components/layout/ProjectRail.tsx:909`（按钮 hover 态）。
- 结构型状态底色（`features/board/ConditionChecks.tsx:114-221` 的检查行/图标方块 `bg-*-soft/50`）保留，属容器而非提示。

实测（4318 + 5180 + tabbit，临时库 `C:\projects\.trellis-verify-data`）：

- 登录页错误路径（错误密码 → `POST /api/auth/login` 401）：渲染 1 个 `[data-slot="alert"]`，`role="alert"`、`background-color: oklch(1 0 0)`、`color: oklch(0.577 0.245 27.325)`、`border-radius: 10px`、高 33px、`AlertDescription` 文字色 `oklab(… / 0.9)`，文案「用户名或密码错误」。
- 管理页（临时会话 + `team-verify`）：7 个 `role=tab`、6 个 `EmptyRow`、0 个残留 `Skeleton`、0 条 console error，标题「团队管理 · Trellis Board」。
- 闸门：`npx tsc -b` rc=0；`npx oxlint` 18 个改动文件 0 warning；`npx oxfmt` 18 文件通过。

## 批 7 卡片与表格（≈40）

1. 23 处 `Panel` 改 import 到 `@/components/ui/panel`；删 `features/admin/shared.tsx:25-42`。
2. board 8 处容器 → `Panel`（`ArchiveView:233`、`AttentionQueue:24`、`FlowSignals:53`、`Overview:19`、`TaskOperationList:55`、`TeamView:106,209`、`OwnershipInboxPanel:77`），语义标签 `<section>/<aside>` 保留（R11）。
3. 其余手写卡片 → `Panel`/`Card`：`ProjectRail:1109`、`PluginsView:231-346`（`<article>` 保留）、`HandoffNotice:257-289`、`dialogs/` 行卡片（`AssignmentsDialog:88`、`ProjectManagerDialog:131`、`BranchListenersDialog:100`）、`DependencyItem:103`、`TaskDetailDialog:437`。
4. 表格化：
   - `ArchiveView.tsx:237-330`、`TeamView.tsx:238-329` → `Table`（design §8 写法，`className` 覆盖回 `sticky bg-muted px-3 py-2`，保留行 `onClick`/hover/`colSpan` 空态行）。
   - `TaskDetailDialog.tsx:563-589`（`ul.divide-y` 四列）、`:741-779`（附件行）→ `Table`。
   - `ConditionChecks.tsx:36-56` 响应式 `grid` 假表 → **不动**，spec 登记为允许例外。
5. 断言 `rg -n "<(table|thead|tbody|tr|th|td)[ >]" packages/web/src -g '!**/components/ui/**'` 无输出；三张表逐列截图对比。

提交：`refactor(web): 面板与表格改用 panel/table`

### 执行记录（批 7，已完成）

改动 17 文件：

- `components/ui/panel.tsx`：增 `as`（`section|div|aside|article`）+ 原生属性透传；`Omit<…, 'ref'>` 规避联合标签 `ref` 冲突。
- `features/admin/shared.tsx`：删 `Panel`/`PanelProps` 与不再使用的 `cn` 导入。
- admin 8 文件 `Panel` 改从 `@/components/ui/panel` 引入（`ArchiveSyncTab`、`AuditTab`、`BranchManagementPanel`、`DevicesTab`、`PluginsTab`、`ProjectsTab`、`TeamsTab`、`UsersTab`）。
- board 容器 → `Panel`：`AttentionQueue.tsx:26`、`FlowSignals.tsx:54`、`TaskOperationList.tsx:56`、`TeamView.tsx:107`（`as="aside"`）/`:210`、`ArchiveView.tsx:234`（`as="div"`，`p-0`）、`components/layout/ProjectRail.tsx:1152`（`as="div"`）、`features/plugins/PluginsView.tsx`（`as="article"`，保留 `draggable`/拖拽回调）。

偏差（均为放弃项，理由见 `design.md` §8）：

- 两张手写 `<table>`（`ArchiveView`、`TeamView`）已改用 `ui/table`：`Table` 增 `containerClassName`，容器 `h-full overflow-y-auto` / `min-h-0 flex-1 overflow-auto` 成为真正的竖向滚动祖先，`thead` 用 `sticky top-0 z-10 bg-muted`；实测滚动 240px 后表头顶边仍贴容器顶边。`ScrollArea` 在 `ArchiveView` 已被表格容器取代。
- `TaskDetailDialog:563`/`:741` 的 `ul.divide-y` 保留：无表头无列宽，`ul` 语义正确。
- 行卡片（`AssignmentsDialog:88`、`ProjectManagerDialog:131`、`BranchListenersDialog:100`）保留：`rounded-lg bg-muted` 与面板 `rounded-xl bg-card` 视觉不同。
- 计划里 `rg "<(table|thead…)"` 断言改为「仅剩两张手写表格」。

闸门：`npx tsc -b` rc=0；`npx oxfmt` 17 文件；`npx oxlint` 0 error（既有 `react(set-state-in-effect)` 等 warning 不变）。

## 批 8 表单行（≈25）

1. admin `Field` 19 处（6 文件）→ `ui/field`：每个控件补 `id` + `FieldLabel htmlFor`，`hint` → `FieldDescription`；`Row` 留在 feature（spec 登记）。
2. `TaskDetailDialog:532-559`（`Label` 无 `htmlFor`、`Input` 无 `id`）与 `:659` 补关联。
3. `ProjectOnboardingDialog:655` ↔ `CreateTaskDialog:196` 用同一 `ui/field` 行组件。
4. `TaskOwnershipDialog:222` 用 `Field orientation="horizontal"` + `Panel`。
5. 浏览器逐处点 label（抽查 ≥10 处）确认聚焦。

提交：`refactor(web): 表单行统一为 field 并补齐 label 关联`

### 执行记录（批 8，已完成）

改动 13 文件：

- `features/admin/shared.tsx`：删 `Field`（保留 `Row`/`ActionLabels`/`AuditItem`）。
- admin 6 文件 22 处改 `Field`/`FieldLabel htmlFor`/`FieldDescription`，新增 id：`account-display-name`、`account-status`、`sync-interval-seconds`、`credential-scheme|port|host|name|username|token|private-key|known-hosts`、`retire-reason`、`purge-confirmation`、`member-user-id`、`member-role`、`member-developer-id`、`binding-plugin`、`reset-password`、`reset-password-confirm`、`new-user-username`、`new-user-display-name`、`new-user-password`。
- board 弹窗 13 处 `<div className="flex flex-col gap-1.5">` + `<Label htmlFor>` → `Field className="gap-1.5"` + `FieldLabel`：`CreateTaskDialog`(7)、`PasswordDialog`(3)、`ProjectOnboardingDialog`(2)、`AgentQuickInitDialog`(1)。
- `TaskDetailDialog.tsx`：计划字段三处改 `Field` + 带 `id` 的 `Input`；阻断原因输入补 `aria-label="阻断原因"`；`Label` 导入换成 field 三件套。
- `TaskOwnershipDialog.tsx`：候选行 `<label>` 包 `Checkbox` → `Field orientation="horizontal"` + `Checkbox id` + `FieldLabel htmlFor` + `FieldContent`。

偏差：

- 视觉靠调用侧 `className` 覆盖（`gap-1`/`gap-1.5`、label 的 `text-xs font-medium text-muted-foreground`、hint 的 `text-2xs`），不给 `ui/field` 加变体或 props 包装器。
- `Row` 保留在 feature（spec 登记）。
- 计划里 `SavedViewsDialog` 无需迁移（它用的是 `ToggleGroup` + `Input`，无 `Label` 包裹）。
- `TaskOwnershipDialog` 的 `section` 未改 `Panel`：弹窗正文内没有卡片底色，套 Panel 会引入 `bg-card` 视觉变化。

闸门：`npx tsc -b` rc=0；`npx oxfmt` 12 文件（`TaskDetailDialog.tsx` 除外，避免整文件重排）；`npx oxlint` 0 error。

实测（4318 + 5180 + 临时会话）：管理页项目协作 3 个 `[data-slot="field"]`、用户账号 3 个，`gap` 均为 4px（= 改造前 `gap-1`）、label 12px `oklch(0.556 0 0)`（= `text-muted-foreground`）、hint 10px（= `text-2xs`）、`label[for]` 全部命中控件、点击「用户 ID」后 `document.activeElement.id === 'member-user-id'`；创建任务弹窗 3 个 field `gap` 6px（= 改造前 `gap-1.5`），label 与控件 id 一致。

## 批 9 其余原子（≈30）

1. `Avatar`（`ui/avatar`）：`ArchiveView:283`、`TaskCard:159`、`TeamView:121,293`（`TopBar` 已用）。
2. `Progress`：`TeamView:126-133` 的 `style={{width}}` → `ui/progress`（`StageTape` 多段条不动）。
3. `Separator`：`ProjectRail:900,926` 的 `border-l` → 容器内 `<Separator orientation="vertical">`。
4. `ScrollArea`：`ProjectRail:597`。
5. `Tooltip`：`ProjectRail:800,823,841,913,1004`、`TopBar:165,191`；禁用态触发器包 `<span tabIndex={0}>`，无法聚焦则保留 `title`（R13）。
6. `Pagination`：`features/board/Pagination.tsx` 的 UI 部分 → `ui/pagination`，保留 `pageItems` 算法作为 `items` 生成器；消费点 `ArchiveView:336`、`TeamView:332`。
7. `StatTile`：`Overview:17` + `FlowSignals:133` → `features/board/StatTile.tsx`（`Card size="sm"`）。
8. `StatusDot`（`ProjectRail` 6 处：`:740,792,881,960,1115-1119`）抽本地组件；`SearchField`（`TopBar:117,174`）抽本地组件；`SummaryGrid`（`LiveSyncControlDialog:649,703,765` + `:679,726`、`ProjectOnboardingDialog:605`）抽 `dl` 组件。
9. `Button` 收编：`ProjectRail:1003,1015`→`variant="ghost" size="xs"`、`:1028,1047,1058`→`size="icon-xs"`、`TopBar:129`→`variant="ghost" size="sm"`、`TaskCard:49,170`、`PluginsView:194`→`variant="outline" size="sm"`、`:266`→`variant="ghost" size="icon-xs"`、链接型按钮 `DevicesTab:123`/`AdminPage:112`→`Button render={<a href/>}`。
10. 断言 `rg -n "<button[ >]" packages/web/src -g '!**/components/ui/**'` 仅剩登记例外（`TaskCard:84` 整卡热区、`AssigneeWarningDialog`、`ProjectRail` 图标脉冲）。

提交：`refactor(web): 头像/进度/分页/提示等原子改用 ui 组件`

### 执行记录（批 9，已完成）

改动 14 文件（11 改 + `ui/progress` 加法 + 2 个 admin 链接按钮 + 新增 `features/board/StatTile.tsx`）：

- `ui/progress.tsx`：加 `trackClassName`/`indicatorClassName`（加法，默认值不变）。
- `Avatar`：`ArchiveView:302`、`TaskCard:181`、`TeamView:311` 用 `size-4` + `after:hidden`（默认描边伪元素）压掉；`TeamView:130` 用 `size-5`。fallback 保留 `bg-secondary text-2xs font-semibold`。
- `Progress`：`TeamView` 手写双 span → `<Progress value trackClassName="h-1.5 rounded-full bg-secondary" indicatorClassName="rounded-full bg-primary" className="w-full gap-0" />`。
- `Separator`：`ProjectRail` 两处 `border-l + pl-1` → `flex gap-1` + `<Separator orientation="vertical" className="bg-border/70" />` + `flex min-w-0 flex-1 flex-col`。
- `Tooltip` 5 处：`ProjectRail` 的 Bot / FolderGit2 / 协作成员，`TopBar` 的搜索 / 主题。统一 `<Tooltip><TooltipTrigger render={<Button … />}>…</TooltipTrigger><TooltipContent>`，删 `title`。
- `Pagination`：UI 换成 `PaginationNav` + `PaginationContent` + `PaginationItem` 包 `Button`（不用 `PaginationLink/Previous/Next`，它们是 `<a>`，客户端分页会丢键盘语义）；`pageItems` 算法、props、文案、`ml-auto` 容器全保留。
- `StatTile`：`Overview` 三块 + `FlowSignals` 四块共用；基础类只留 `flex flex-col`，gap / 边框 / 圆角 / `tabular-nums` / `truncate` 全由调用侧传，避免 FlowSignals（原本无 gap、无 tabular-nums）漂移。
- `Button` 收编：`ExecutionHeader` 内建视图药片（改为 `span.viewPill` 包 `Button`，与 saved view 药片同构）、`PluginsView` 刷新配置（`variant="outline" size="sm" className="px-2.5"`）、`TopBar` 移动端搜索「取消」（`variant="ghost" size="sm" className="h-6 rounded-lg"`）、`ProjectRail` 的 warning 文本按钮 / 上传 / detach、`DevicesTab` 打开桌面客户端、`AdminPage` 返回看板（后两者 `render={<a />}`）。
- 本地抽取：`ProjectRail` 的 `StatusDot`（5 处圆点）、`TopBar` 的 `SearchField`（两处搜索框）。

例外逐条理由（不是遗漏，是改完更差）：

| 例外 | 不处理的原因 |
|---|---|
| `ScrollArea`（`ProjectRail.tsx:603`） | Base UI Viewport 是 `size-full`，父容器只有 `max-h-56`（无确定高度）→ Viewport 高度 0，列表直接塌陷。改成固定 `h-56` 会让内容少时盒子反而变高。 |
| 禁用态 `title`（上传本地任务 / 不再同步） | Tooltip 需要可聚焦触发器；禁用 `<button>` 无法聚焦，包 `span tabIndex={0}` 会让读屏以为可操作。原生 `title` 在禁用态同样不弹，行为等价，改它零收益。 |
| `ProjectRail` 行级按钮（753/813/916/1007） | 都是「整行可点 + 选中态自定义底色」：`h-8 rounded-lg px-2 text-left text-xs` + 条件 `border-primary/40 bg-primary/15`（或 `bg-warning-soft` / `bg-muted/30`）。Button 没有任何 variant/size 匹配，需覆盖 height/radius/padding/text-align + 条件类，且 `[&_svg]` 规则会改写行内图标尺寸。 |
| `TaskCard:129` warning 药片 | `rounded-full border-warning/35 bg-warning-soft` 的自定义 tone 药片 —— 这是 R5（tone 单一来源）的收敛对象，不是 Button 收编对象。 |
| `TaskCard:195`「计划」chip | 改 `Button variant="outline"` 会同时引入两处回归：hover 底色 `bg-muted` → `bg-input/50`，以及 base 的 `disabled:opacity-50`（原按钮禁用时不变灰）。为 6 个字符的类名换来两处视觉变化，不划算。 |
| `PluginsView:275` 拖动把手 | `⠿` 是 22×14px 的定制热区（`text-sm leading-none px-1`）；Button 所有 size 都是方形（`icon-xs`=24×24），会顶高卡片头部行。 |
| admin/board 整行热区（`PluginsTab:199`、`TeamsTab:136`、`ArchiveView:331`、`AttentionQueue:47`、`Kanban:108`、`TaskCard:55/90`） | 整卡/整行点击区：Button 的 `inline-flex items-center justify-center` + `active:translate-y-px` + `shrink-0` 会改布局，`TaskCard:90` 是 `absolute inset-0` 覆盖层，点击时会整卡抖一下。 |

遗留（不属于批 9 范围，转批 10 处理）：

- 无。

### tone 收敛（R5，并入本批）

`ui/status-pill.tsx` 新增面状 tone 单一来源（`bg-*-soft` 与 `text-*` 只出现在这里，和既有 `TONE_VARIANT`/`TONE_DOT` 同处）：

```ts
const TONE_SURFACE       = { success: 'bg-success-soft text-success', warning: 'bg-warning-soft text-warning', destructive: 'bg-destructive-soft text-destructive' }
const TONE_SURFACE_QUIET = { … '/50' 底 … }   // 条件卡片用的淡一档
export function toneSurface(tone, quiet = false)
```

16 处手拼调用点改用它（6 文件）：`ProjectRail.tsx:740,748,921`、`ConditionChecks.tsx:76,114,115,119,120,138,139,220,221`、`OwnershipInboxPanel.tsx:80`、`TaskCard.tsx:131`、`dialogs/AgentQuickInitDialog.tsx:203`、`dialogs/ProjectOnboardingDialog.tsx:640`。边框透明度（`/20`、`/35`）仍留在调用侧，与 helper 不冲突（属性不重叠），所以视觉零漂移。

验证：`rg -n "bg-(success|warning|destructive|primary|info)-soft" packages/web/src -g '!**/components/ui/**'` 无输出（PRD 验收第 91 行通过）；浏览器实测任务详情「条件检查」两张卡片 `bg-success-soft/50`、`bg-warning-soft/50`（computed `oklab(… / 0.5)`、边框 `/0.2`），图标底板 `bg-success-soft`（`rgb(220,252,231)`），与改造前一致。

闸门：`npx tsc -b` 0 error（此前 `src/desktop/MonacoDiff.tsx` 的 `monaco-editor/editor/editor.api` TS2307 已消失）；`npx oxlint src` 0 error（55 条 warning 全在未触碰代码的存量问题）；`npx oxfmt` 全部改动文件。

实测（standalone 4317 + vite 5173，加入本仓库 13 任务 / 125 归档）：

- 表格头像 16px、`::after` `display:none`、fallback `bg=secondary`；负责人行 20px。
- `progress-track` h=6 / 圆角全圆 / `bg=secondary`，indicator `bg=primary`，`value` 100→`width:100%`、67→`width:67%`。
- 归档分页 `nav[aria-label=pagination]` 335px 且右对齐（`ml-auto` 未丢），按钮 `上一页 1 2 3 4 5 6 7 下一页`（125/20=7 页）。
- 组合视图药片（API 造一条 saved view）：外层 25px、内层 button 16px / `pad 0` / `border 0`，与内建药片同形；内建药片改成 `span` + `Button` 后实测 25px / 内层 16px / 12px，与 saved view 完全一致。
- `TopBar` 移动端「取消」：`data-slot="button"`、h=24、`padding 0 8px`、radius 10px、12px、muted 色 —— 与改造前一致。
- `PluginsView` 刷新配置：`data-slot="button"`、h=28、12px、`padding 0 10px`、1px 边框 —— 与改造前一致。
- `AdminPage` 返回看板：渲染为 `A`、无嵌套交互元素、h=32、`bg=muted`、radius 10px。
- Tooltip：hover 主题按钮弹出「切换到深色主题」108×28。
- 未能可视化验证：`ProjectRail` 的 Separator 与 icon Tooltip（需 desktop 本地关联 / 分支监听数据），`DevicesTab` 打开桌面客户端（standalone 无 admin 接口，报「接口不存在」）—— 仅代码层 + 同构机制核对。

## 批 10 业务去重 + 规范落盘

1. `TeamCheckboxList`：`UsersTab:132-149` + `AccountDialog:103-116` → `features/admin/TeamCheckboxList.tsx`。
2. `PluginBindingForm`：`ProjectsTab:458-486` + `PluginsTab:252-292` → `features/admin/PluginBindingForm.tsx`，字段与校验文案统一（现状已不同步）。
3. `AffectedProjectList`：`ArchiveSyncTab:198-208` + `:533-548` → 本地组件。
4. `AccountDialog:104-113` 按钮行移回 `DialogFooter`；`UsersTab:171-181`/`:271-276` 双编辑入口收敛为一处（左栏内联）；`PluginsTab:163-174` 行 `<button>` 与"详情"按钮合并为单击触发行本身。
5. 新建 `.trellis/spec/frontend/component-reuse.md`（分层规则、组件选择矩阵、禁止清单、`ui/` 新增与提升流程、审计命令（参数数组传参）、PR 前自查、旧→新对照表）；`frontend/index.md` 挂索引；`frontend/quality-guidelines.md` 加一行指向。
6. 〈闸门〉。

提交：`docs(web): 沉淀组件复用规范并收敛 admin 重复表单`

### 执行记录（已完成）

新增 3 文件：`features/admin/TeamCheckboxList.tsx`、`features/admin/PluginBindingForm.tsx`、`features/admin/AccountForm.tsx`（`AccountForm`/`AccountFormValues` 从 `AccountDialog.tsx` 迁出）。删除 `features/admin/AccountDialog.tsx`（178 行）。改 `UsersTab.tsx`、`PluginsTab.tsx`、`ProjectsTab.tsx`、`ArchiveSyncTab.tsx`。admin 目录净 −234 行。

- `TeamCheckboxList({ teams, selectedIds, onToggle, disabled, emptyText })`：两处团队勾选块合一，`onToggle(teamId)` 由调用侧按成员关系翻转（等价于原 `checked === true` 分支）；**空态文案不同，用必填 `emptyText` 各自保留**（「暂无团队，可先建号后补配。」/「暂无团队，可创建团队后再分配。」）。
- `PluginBindingForm({ draft, onChange, onSubmit, submitLabel, disabled, projectOptions, submitProps, className })`：`projectOptions` 存在才渲染 Board 项目 `SelectField`；两个 Input 统一 `className="text-xs"` + `maxLength={200}`；提交按钮 `disabled` 由 `disabled || (!projectOptions ? false : !draft.projectId) || !draft.externalProjectId.trim()` 计算。`ProjectsTab` 传 `submitProps={{ size: 'sm', className: 'self-start' }}` 保持原按钮尺寸（默认 Button 在 flex-col 里会拉满宽度）。
- `AffectedProjectList({ projects, limit, ariaLabel, id, tabIndex, className })`（`ArchiveSyncTab.tsx` 内本地组件）：两处 `<ul>` 合一。「另有 N 个」保持原来的**兄弟 `<p>`**，没有移进 `ul`（移进去会改 DOM 与视觉），文案改用 `PROJECT_PREVIEW_LIMIT`。
- 双编辑入口收敛：删 `dialogUser` state、`AccountDialog` 渲染与 import；行内「编辑」只 `setSelectedId(user.id)`；`AccountForm` 去掉 `onCancel`（原对话框专用），提交行只剩 submit 按钮。**计划里的「按钮行移回 `DialogFooter`」不再适用** —— 对话框已删除。
- `PluginsTab`：删「详情」按钮（与整行 `<button>` 同一 `setSelected`）；整行热区按钮作为已登记例外保留。

闸门：`npx tsc -b` 0 error；`npx oxlint src` 0 error（55 条存量 warning）；`npx oxfmt` 全部改动文件。断言：`rg "<button[ >]"`、`type="checkbox"`、`bg-*-soft`、`<table`、ui 外 `@base-ui/react` 全空；`rg "AccountDialog"` 无输出；`bg-muted/40 p-2.5` 仅剩 `PluginBindingForm.tsx:35`。

浏览器（team 模式 4317 + vite 5173，`cli.js init-admin` 造管理员 + 强制改密流程后进 `/admin`）：

- 用户账号：创建表单与编辑表单各 1 个 `所属团队` 列表；点「编辑」后 `[data-slot="dialog-content"]` 计数 0、`button` 文案只有「创建账号/保存账号」（无「取消」）；勾选「验证团队」后 `aria-checked` false→true，点「保存账号」后 `team_member` 落库一行 —— 抽取后的 `AccountForm` + `TeamCheckboxList` 端到端可用。
- 未能可视化验证：`ProjectsTab`/`PluginsTab` 的 `PluginBindingForm`（team 模式没有项目与插件绑定数据，注册项目需 desktop 配对）、`ArchiveSyncTab` 的受影响项目列表（需要 git 凭据）。仅类型检查 + 同构核对。

## 收尾

1. 全量闸门 + PRD 全部 16 条验收逐条勾。
2. 浏览器全量抽查：登录、看板（概览/团队/归档/任务详情/筛选/组合视图/接管通知）、偏好设置、admin 全部 8 个 tab、desktop 同步对话框；控制台 0 error、布局无塌陷。
3. `git diff --stat` 与 `research/component-audit.md` 清单核对，无越界文件。
4. 删除批 0 的临时截图目录。
5. `stash@{0}` 已在批 2 合并，向用户确认后 `git stash drop`。
6. 汇报全部改动范围与验证结果，取得提交确认（本批已是逐批提交，此处确认最终状态与任务目录入库）。
