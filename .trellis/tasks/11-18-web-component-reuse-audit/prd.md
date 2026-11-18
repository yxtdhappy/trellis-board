# PRD — Web 组件复用审计与 shadcn 最佳实践沉淀

## 背景与证据

`packages/web` 已装 22 个 shadcn/base-ui 组件（`components.json`：`style=base-mira`、base-ui、lucide、`@/components/ui`），但审计发现组件层与业务层严重脱节：

**已装组件空转（零引用）**：`components/ui/card.tsx`、`ui/table.tsx`、`ui/tabs.tsx`、`ui/pagination.tsx` 全仓库无一处调用；业务层各自重写了一遍。`ui/avatar` 仅 `TopBar` 用。

**逐文件审计（本次采取的方法）**：不用正则扫描，按目录切 8 片，8 个只读切片并行通读全部 59 个非 ui `.tsx`（另 3 个 `src/main-*.tsx` 入口只挂载 Provider），每片附「已通读文件 + 行数」。完整逐行证据见 `research/component-audit.md`，关键结论：

| 重复类别 | 规模 | 代表位置 |
|---|---|---|
| 自建面板/卡片容器 | 31 处 | `features/admin/shared.tsx:25` 的 `Panel`（23 处）+ board 8 处 `rounded-xl border bg-card`（`ArchiveView:233`、`AttentionQueue:24`、`FlowSignals:53`、`Overview:19`、`TaskOperationList:55`、`TeamView:106,209`、`OwnershipInboxPanel:77`） |
| 手写状态药片 | ≈45 处 | `shared.tsx:46` 的 `StatusPill`（33 处）+ board/dialogs/plugins 散落（`TaskCard:100,113,150`、`TeamView:303,313`、`PluginsView:285,298-316`、`TaskDetailDialog:446,467,486,570`、`BranchListenersDialog:110,113,124`、`PublishOperationDialog:63`） |
| tone 颜色词表副本 | 6 份 | `features/board/tone.ts`、`ConditionChecks:113-119`、`FlowSignals:124-130`、`Kanban:37`（`laneTone(...).split(' ')[0]` 字符串切割取色）、`TaskCard:100`、`TaskOperationList:11-27`、`TeamView:303` |
| 空态 / 加载占位 | 空态 40+、骨架 10 | `shared.tsx:59` 的 `EmptyRow`（37 处）+ `AttentionQueue:41`、`OwnershipInboxPanel:117,121`、`Kanban:74`、`TaskDetailDialog:621,634,718,782`、`PluginsView:215,220`、`AdminPage:167` |
| 提示条 / 错误条 | 30+ | `role="alert"` 遍布 18 文件；`ProjectOnboardingDialog:586,625,629,633,707,737` 单文件 6 次；`ProjectRail:718,726`；`dialogs/` 6 份 callout |
| 表单行 + label 关联 | 20+ | `shared.tsx:67` 的 `Field`（19 处）；`TaskDetailDialog:532-559` 的 `Label` 无 `htmlFor`、`Input` 无 `id`（`:659` 只靠 placeholder） |
| 手写表格 / div 假表 | 5 | `ArchiveView:237`、`TeamView:238`、`ConditionChecks:36`、`TaskDetailDialog:563`（`ul.divide-y` 模拟四列）、`TaskDetailDialog:741` |
| 下拉封装 | 4 套 | `ui/select`、`board/SelectField`、`board/SearchableSelect`（直连 `@base-ui/react/combobox`）、`ExecutionHeader:190` 的私有 `FilterField` |
| 输入皮肤 | 3 份 | `admin/shared.tsx:6` 的 `controlClass`（11 处调用）、`MultiSelectField:54`、`SelectTrigger` |
| 手写头像圆片 | 5 | `ArchiveView:283`、`TaskCard:159`、`TeamView:121,293` |
| 手写进度条 | 1 | `TeamView:126-133`（`style={{width}}`） |
| 分段/单选控件手写 | 8 | `PreferencesDialog:94`（`role="radiogroup"`）、`PreferencesDialog:129`（外壳与 `TabsList` 逐字相同、触发器写死 `h-6` 比内容区矮 2px）、`ExecutionHeader:58`、`ExecutionHeader:83`、`TopBar:143`、`AdminPage:192`、`LiveSyncControlDialog:260`、`SavedViewsDialog:110,128` |
| 原生表单元素残留 | 8 | `AgentToolSelector:63`（checkbox）、`PluginsTab:253,265,273`、`TeamsTab:117,171,184`、`TeamSwitcher:31` |
| 悬停提示走原生 `title` | 7 | `ProjectRail:800,823,841,913,1004`、`TopBar:165` 等 |
| 业务层重复实现 | 5 组 | `UsersTab:132` ↔ `AccountDialog:103`（团队多选）、`UsersTab:171` ↔ `:271`（同一 `AccountForm` 双入口）、`ProjectsTab:458` ↔ `PluginsTab:252`（插件绑定表单两份）、`ArchiveSyncTab:198` ↔ `:533`（受影响项目列表）、`PluginsTab:163`（行是 `<button>` 又带"详情"按钮） |

**正确基线（保留，写进 spec 作为既有条款）**：21 个弹窗全部走 `ui/dialog` 的固定 header/footer + 单 `DialogBody` 滚动壳（唯一例外 `AccountDialog:104` 把按钮行写进 body）；`features/**` 中除 `SearchableSelect.tsx:2` 外无 `@base-ui/react/*` 直连；0 处 `space-x/y-*`、0 处 raw palette 色；仓库是 MPA，`<a href>` + `window.location.assign/replace` 是既定导航方式。

问题不在"没规范"，而在规范未成文：没有组件选择矩阵，也没有"新增/提升 ui 组件"的流程，于是同一个控件隔几天就被再写一遍（`ui/tabs` 零使用就是证据）。

## Goal

1. 把上述重复实现收敛到 `components/ui`：业务层不再自建可被替代的原子控件，tone/状态配色只有一处来源。
2. 把复用规则写进 `.trellis/spec/frontend`，让"第三次重写 tabs / 第四张手写表格"在评审阶段被拦下。

## 审计清单（实施对象，按批组织）

| 批 | 主题 | 内容（位置） | 规模 |
|---|---|---|---|
| 1 | 组件层补齐（不动业务） | 装 `toggle`/`toggle-group`/`field`/`input-group`/`empty`/`alert`/`combobox`；`ui/badge` 加 `success`/`warning` 软底变体与 `size="xs"`；新增 `ui/panel.tsx`（`Panel` 上提）、`ui/empty-row.tsx`、`ui/status-pill.tsx`、`ui/code-block.tsx`、`ui/eyebrow.tsx`、`ui/combobox.tsx` | 7 装 + 6 新 |
| 2 | 分段 / 单选控件 | `ExecutionHeader:58`→Tabs、`TopBar:143`→Tabs(线型)、`AdminPage:192`→Tabs、`LiveSyncControlDialog:260`→Tabs、`PreferencesDialog:129`→ToggleGroup（保留紫色）、`PreferencesDialog:94`→ToggleGroup（卡片式）、`SavedViewsDialog:110,128`→ToggleGroup(multiple)、`ExecutionHeader:83`→Badge（含删除键，见 R3） | 8 处 |
| 3 | 下拉与输入 | 删 `controlClass`（11 处调用）；`PluginsTab:253,265,273`、`TeamsTab:117,171,184`、`TeamSwitcher:31` 原生控件→`Input`/`SelectField`；`SelectField`+`SearchableSelect`+`FilterField` 合并为一套（`searchable` 开关）；`SelectValue` 替换手写 `data-slot="select-value"`（`SelectField:30`、`ExecutionHeader:196`） | 19 处 |
| 4 | tone 与药片 | `ui/badge` 变体就位后，`tone.ts` 六份副本收敛为单一来源（导出变体键 + 结构化 `laneDotTone`）；`StatusPill` 与全部手写药片改 `<Badge>`/`<StatusPill>` | ≈45 处 |
| 5 | 空态与加载 | `EmptyRow` 37 处改 import；散落空态（`AttentionQueue:41`、`OwnershipInboxPanel:117,121`、`Kanban:74`、`TaskDetailDialog:621,634,718,782`、`PluginsView:215,220`、`ProjectOnboardingDialog:600`、`TaskOwnershipDialog:259`、`AdminPage:180`）→`Empty`；骨架（`AgentQuickInitDialog:171`、`ProjectOnboardingDialog:629`、`TaskDetailDialog:430`、`TaskOwnershipDialog:257`、`AdminPage:167`、`ArchiveSyncTab:229`、`PluginLogsDialog:38`、`OwnershipInboxPanel:121`）→`Skeleton` | 空态 40+ / 骨架 10 |
| 6 | 提示与错误 | `role="alert"` 18 文件 → `Alert variant="destructive"`；提示条/说明块（`dialogs/` 6 份、`ProjectOnboardingDialog` 6 处、`ProjectRail:718,726`、`PluginsView:206`、`TaskDetailDialog:463,731,789`、`HandoffNotice:257`）→`Alert` 各变体 | 30+ |
| 7 | 卡片与表格 | `Panel` 23 处 + board 8 处容器 + `ProjectRail:1109` + `PluginsView:231` + `dialogs/` 3 处行卡片 → `Panel`/`Card`；5 处表格化（`ArchiveView:237`、`TeamView:238`、`ConditionChecks:36`、`TaskDetailDialog:563,741`）→`ui/table` | ≈40 |
| 8 | 表单行 | admin `Field` 19 处 → `ui/field`；`TaskDetailDialog:532,659`、`SavedViewsDialog` 补 `id`+`htmlFor`；`ProjectOnboardingDialog:655` 与 `CreateTaskDialog:196` 统一行组件 | ≈25 |
| 9 | 其余原子 | `Avatar`（5）、`Progress`（`TeamView:126`）、`Separator`（`ProjectRail:900,926`）、`Tooltip`（`ProjectRail` 5 处 + `TopBar:165` + 头像触发器 `TopBar:191`）、`ScrollArea`（`ProjectRail:597`）、`Pagination`（`board/Pagination.tsx` → `ui/pagination`，2 个消费点）、`StatTile`（`Overview:17` + `FlowSignals:133`）、`StatusDot`（`ProjectRail` 6 处，本地组件）、`SearchField`（`TopBar:117,174`，本地）、`SummaryGrid`（`LiveSyncControlDialog` 5 块 + `ProjectOnboardingDialog:605`）、`Button` 收编（`ProjectRail:1003,1015,1028,1047,1058`、`TopBar:129`、`TaskCard:49,170`、`PluginsView:194,266`、链接型按钮 `DevicesTab:123`/`AdminPage:112`） | ≈30 |
| 10 | 业务去重 + 规范 | `TeamCheckboxList`（`UsersTab:132`+`AccountDialog:103`）、`PluginBindingForm`（`ProjectsTab:458`+`PluginsTab:252`）、`AffectedProjectList`（`ArchiveSyncTab:198,533`）、`AccountDialog:104` 按钮行回 `DialogFooter`、`UsersTab:171/:271` 与 `PluginsTab:163` 双入口/双触发器收敛；新建 `.trellis/spec/frontend/component-reuse.md` + `index.md` 索引 + `quality-guidelines.md` 指向 | 5 组 + spec |

总量估算：≈250 处调用点 / 45 文件（批 1 的 import 级改动占 110 处左右，diff 机械但面广）。

## Requirements

- **R1 分层唯一原子层**：`components/ui/*` 是唯一的 Base UI 封装层；`features/**`、`components/layout/**` 不得 `import '@base-ui/react/*'`（现状唯一违规：`board/SearchableSelect.tsx:2`）。
- **R2 分段控件判定**：切换主内容区/视图 → `Tabs`（`role=tab`+`aria-selected`，`TabsTrigger` 自带 `h-[calc(100%-1px)]`）；仅表达一个选项值 → `ToggleGroup`（`aria-pressed`）。选中项高度必须由容器派生，不得再出现写死 `h-6`/`h-7` 的触发器。
- **R3 带内嵌操作的药片不用 ToggleGroup**：`ExecutionHeader:83`（保存组合视图，选中项内含删除按钮）与 `TaskCard` 标签类胶囊用 `Badge`（`Badge` 支持 `render`，可承载按钮语义），避免嵌套可交互元素导致的点击冲突。
- **R4 字号控件保留紫色**：`ToggleGroupItem` 用 `aria-pressed:bg-primary aria-pressed:text-primary-foreground aria-pressed:font-semibold`；失败则给 `ui/toggle` 加 `variant="primary"`（加法）。
- **R5 tone 单一来源**：`bg-*-soft` 与状态色映射只允许出现在 `ui/badge.tsx`/`ui/status-pill.tsx`；`tone.ts`、`task-view.ts`、`lib/admin-shared.ts` 收敛为一组返回变体键的函数，调用点不得再拼颜色类。
- **R6 组件只做加法**：`ui/badge` 只加当前需要的两档软底变体（`success`/`warning`；`destructive` 已是软底，`secondary` 覆盖中性，不新增同义档）与 `size="xs"`；不改既有变体默认值。`spinner`/`radio-group`/`collapsible` 本轮不装（`LoaderCircle`+`Button` 已够、主题三选一用 `ToggleGroup`、`details/summary` 保留）。
- **R7 空态与加载**：列表空态走 `ui/empty`；`EmptyRow` 作为其紧凑单行变体留在 `ui/empty-row.tsx`（只改 import）；异步加载走 `Skeleton`，但图标态脉冲（`ProjectRail:1037,1067`）不算骨架，保持不动。
- **R8 表格保留原视觉**：5 处表格化必须保留 `sticky` 表头、行 hover、`colSpan` 空态行与列宽节奏；`Table` 自带 `overflow-x-auto` 容器，外层既有滚动容器不删。
- **R9 表单行 label 必须关联**：`ui/field` 迁移时逐个补 `id` + `FieldLabel htmlFor`，`hint`→`FieldDescription`；不得出现"点标签不聚焦"的回归。
- **R10 卡片视觉不漂移**：现有面板是 `rounded-xl border bg-card`，`ui/card` 默认 `rounded-lg ring-1`。因此保留 `Panel`（移到 `ui/panel.tsx`，内部基于 `Card` 并保持原圆角/边框），业务处只改 import；纯容器场景用 `Panel` 而非强行套 `Card`。
- **R11 语义标签优先**：`<aside>`/`<section>`/`<nav>` 等语义容器不改标签（`TeamView:106` 侧栏、`ArchiveView:233`、`AttentionQueue:24`）；`<ul>/<li>` 只用于真实列表。
- **R12 导航不动**：MPA 保持 `<a href>` 与整页跳转，不引客户端路由；仅把"链接承载按钮样式"改为 `Button render={<a href/>}`。
- **R13 Tooltip 替换要可访问**：`title` → `Tooltip` 时保证触发器是真实可聚焦元素；禁用态按钮的提示需包一层可聚焦容器，否则保留 `title`。
- **R14 行为零回归**：迁移等价替换，交互结果、文案、可访问名称不变；仅批 2（高度/紫色）与批 1（Badge `size`）是刻意视觉变化。
- **R15 规范落盘**：新建 `frontend/component-reuse.md`（分层规则、选择矩阵、禁止清单、`ui/` 新增与提升流程、审计命令、PR 前自查、旧→新对照表），`frontend/index.md` 挂索引，`quality-guidelines.md` 加指向。
- **R16 逐批可回滚**：每批独立闸门（`npx tsc -b`、`npx oxlint src`、`yarn oxfmt`）+ 独立提交。

## 非目标

- 不改设计语言（配色、圆角体系、字号档位、布局密度、间距节奏）。
- 不碰 `packages/server`、`packages/desktop`、`packages/shared`。
- 不重写业务逻辑、数据流、筛选/分页算法；只换渲染原子（`pageItems` 窗口算法保留）。
- 不为语义列表套组件，不给装饰性图形套 `Progress`。
- 不引入新第三方依赖（新增组件全部来自 shadcn 注册表，底层仍为 `cn` + `@base-ui/react`）。
- 不引客户端路由；不改弹窗外壳约定（除 `AccountDialog` 归位）。
- 不做性能优化、不做无障碍专项审计（仅在 R9/R13 覆盖必要项）。

## Acceptance Criteria

- [ ] `rg -n "@base-ui/react" packages/web/src -g '!**/components/ui/**'` 无输出。
- [ ] `rg -n "controlClass|StatusPill|EmptyRow|Panel\b" packages/web/src -g '!**/components/ui/**'` 不再命中 `features/admin/shared.tsx`（`Panel`/`StatusPill`/`EmptyRow` 已移入 `ui/`，调用点仅剩 import）。
- [ ] `rg -n "<(table|thead|tbody|tr|th|td)[ >]" packages/web/src -g '!**/components/ui/**'` 无输出。
- [ ] `rg -n "<button[ >]" packages/web/src -g '!**/components/ui/**'` 仅剩已登记例外（`TaskCard:84` 整卡热区、`AssigneeWarningDialog` 双正操作壳、`ProjectRail` 的 `animate-pulse` 图标）。
- [ ] `rg -n 'type="checkbox"' packages/web/src/features` 无输出。
- [ ] `rg -n "bg-(success|warning|destructive|primary)-soft" packages/web/src -g '!**/components/ui/**'` 无输出。
- [ ] `rg -n "rounded-full (px|py)-" packages/web/src -g '!**/components/ui/**'` 仅剩已登记例外（`StageTape` 分段条、`HandoffNotice` 装饰）。
- [ ] `rg -n "title=\{" packages/web/src/components/layout` 仅剩已登记例外（禁用态提示）。
- [ ] 分段控件实测：字号选中项贴合 32px 轨道且为紫色；看板「全部进行中 / 只看我的」`role="tab"` + `aria-selected="true"`；顶部导航与 admin 视图导航键盘左右键可用。
- [ ] 5 处表格逐列对比迁移前后一致（列宽、sticky 表头、空态 `colSpan` 行、行 hover）。
- [ ] 表单 label 抽查 10 处，点击标签均能聚焦控件。
- [ ] 药片配色四档（success/warning/danger/neutral）迁移前后一致。
- [ ] `npx tsc -b`（`packages/web`）通过；`npx oxlint src` 0 error；`yarn oxfmt` 已格式化。
- [ ] 浏览器抽查：登录页、看板（概览/团队/归档/任务详情/筛选/组合视图）、偏好设置、admin 的 Teams/Users/Projects/Audit/Plugins/Devices/ArchiveSync、desktop 同步对话框；控制台 0 error、布局无塌陷。
- [ ] `.trellis/spec/frontend/component-reuse.md` 可经 `frontend/index.md` 抵达。

## 风险

- **R-1 面广**：≈250 处 / 45 文件。缓解：10 批独立提交，批 1 只改 import 不动行为，先建立可回滚基线。
- **R-2 卡片视觉**：`Card` 默认 `rounded-lg + ring-1`，现有面板 `rounded-xl + border`。缓解：保留 `Panel`（R10），不追求把一切换成 `Card` 原生外观。
- **R-3 ToggleGroup 高度与紫色**：`toggleVariants` 只有 `h-7/h-6/h-8` 固定档，无 track-relative 高度；紫色依赖 `cn` 冲突裁决。缓解：容器 `h-8 items-stretch p-0.75` + item `h-full`；不生效则加 `variant="primary"`；仍失败则停下确认是否退回 `Tabs`。
- **R-4 表格回归**：`ui/table` 的 `TableHead h-10 px-2` 与手写的 `sticky bg-muted px-3 py-2` 不同。缓解：全部用 `className` 覆盖回原值，改完逐列截图对比。
- **R-5 表单 label**：`ui/field` 用 `htmlFor`/`id` 而旧 `Field` 用包裹式 label，漏补 `id` 会静默丢点击聚焦。缓解：批 8 收尾逐个点击验证。
- **R-6 Tooltip 替换**：`title` 在所有元素上都生效，`Tooltip` 需要可聚焦触发器；禁用态会失效。缓解：R13 例外清单。
- **R-7 网络依赖**：`npx shadcn@latest add` 需拉注册表（已实测可用）；生成文件里的 `@/registry/base-mira/*` import 必须改成 `@/components/ui/*`。
- **R-8 视觉验收成本**：10 批 × 多页面截图。缓解：每批只抽查受影响页面，最终一次性全量抽查。

## 已确认决策

1. 范围：`audit + spec + all`（含 admin 私有 mini 设计系统整体迁移）。
2. 分段控件规则：视图/面板切换用 `Tabs`，纯选项集用 `ToggleGroup`。
3. `ui/badge` 只做加法、档位"满足当前需求即可"→ 本次只加 `success`/`warning` 软底与 `size="xs"`；`destructive` 已是软底、`secondary` 覆盖中性，**不新增 `danger`/`neutral`/`info` 等同义档**（与早期"四档"答复的差异在此，理由是不留同义变体）。
4. 规范形态：新建 `frontend/component-reuse.md` + `index.md` 索引。
5. 分批提交：6+ 批独立提交（本 PRD 细化为 10 批）。
6. 原 `11-18-prefs-pipeline-tabs` 合并进本任务（目录未入库已删；Tabs 实现留在 `git stash@{0}` 作参考）。
7. **`components/ui/` 同时容纳 registry 产物与自建组合件**（`panel`/`empty-row`/`status-pill`/`code-block`/`eyebrow`/`combobox` 落在 `ui/`），不新建 `components/shared/`；既有 `ui/confirm-dialog.tsx` 作为同一形态的先例保留，不迁移。

## 待评审确认（已答复）

1. ~~是否接受 10 批全量推进~~ → **全量推进**。
2. ~~`Panel`/`EmptyRow`/`StatusPill` 上提 `ui/` 是否认可~~ → **认可，且自建组合件直接落 `ui/`，不新建目录**（决策 7）。
3. ~~批 2 的 8 处控件是否都纳入~~ → **全纳入**。
