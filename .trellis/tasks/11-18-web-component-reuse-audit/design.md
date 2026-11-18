# Design — Web 组件复用审计与 shadcn 最佳实践沉淀

## 1. 分层与判定顺序

```
components/ui/*      ← 唯一原子层：Base UI 原语封装 + 变体 + 跨 feature 组合件。
                       registry 产物与自建组合件同置（先例 ui/confirm-dialog.tsx），只做加法，不改既有变体默认值
components/layout/*  ← 布局壳，可组合 ui/*
features/**          ← 业务，只能用 ui/* + layout/*
```

落地时的判定顺序（写进 spec 自查清单）：

1. `components/ui` 已有等价组件？→ 直接用；要新外观就在该文件加变体（加法）。
2. shadcn 注册表有、本仓库没装？→ `npx shadcn@latest add <name>` 后按 `base-mira` 核对。
3. 同一个 pattern 出现在 **≥2 个文件**？→ 提升为 `ui/*`（`Export panel`/`EmptyRow`/`StatusPill`/`CodeBlock`/`Eyebrow`/`Combobox` 均属此类）。
4. 只在一个 feature 内、且是业务语义组合（`StatTile`、`SummaryGrid`、`SearchField`、`StatusDot`、`TeamCheckboxList`、`PluginBindingForm`、`AffectedProjectList`）→ 留在该 feature，允许跨文件但不得被其它 feature 引用。

## 2. 组件层新增（批 1）

| 文件 | 形态 | 来源 / 理由 |
|---|---|---|
| `ui/toggle.tsx`、`ui/toggle-group.tsx` | shadcn 注册表 | 分段/多选药片。`toggleVariants` 不动，`h-7/h-6/h-8` 保持原样 |
| `ui/field.tsx` | shadcn | 表单行（`FieldGroup`/`Field`/`FieldLabel`/`FieldDescription`/`FieldError`） |
| `ui/input-group.tsx` | shadcn | `Combobox` 的输入壳依赖它 |
| `ui/empty.tsx` | shadcn | 空态（`Empty`/`EmptyHeader`/`EmptyMedia`/`EmptyTitle`/`EmptyDescription`/`EmptyContent`） |
| `ui/alert.tsx` | shadcn | 提示条/错误条（`Alert`/`AlertTitle`/`AlertDescription`/`AlertAction`） |
| `ui/combobox.tsx` | shadcn 注册表（`shadcn add combobox`，包装 `@base-ui/react` Combobox） | 消除 feature 层对 `@base-ui/react/combobox` 的直连；16 个导出含 `ComboboxChips`/`ComboboxChip`/`ComboboxChipsInput` 多选形态 |
| `ui/panel.tsx` | 由 `features/admin/shared.tsx:25-42` 平移 | 保留 `rounded-xl border bg-card` 视觉；内部用 `Card` 承载 spacing/gap token |
| `ui/empty-row.tsx` | `Empty` + 单行 `EmptyTitle` 的紧凑变体 | 37 处 `EmptyRow` 只改 import |
| `ui/status-pill.tsx` | `Badge` + tone→variant 映射 | 33 处 `StatusPill` 只改 import |
| `ui/code-block.tsx` | `pre`/`code` + `bg-muted` 等宽块 | `DevicesTab:172`、`AuditTab:173`、`OneTimeCredentialDialog:38` |
| `ui/eyebrow.tsx` | `text-2xs font-semibold tracking-[0.2em] text-muted-foreground` | 7 文件硬编码排版常量 |

### Badge 变体（唯一允许的变体扩展）

现有：`default`（紫实底）/`secondary`/`destructive`（**已是软底** `bg-destructive/10 text-destructive`）/`outline`/`ghost`/`link`，且 `Badge` 走 `useRender`，支持 `render={<button/>}`。

新增：

```ts
success: 'bg-success-soft text-success',
warning: 'bg-warning-soft text-warning',
info: 'bg-info-soft text-info',          // 批 4 补：lane=planning 的蓝
'primary-soft': 'bg-primary-soft text-primary', // 批 4 补：lane=implementation 的紫
danger: 'bg-destructive text-white',     // 批 4 补：P0 实心红
```

以及尺寸档（现有固定 `h-5 px-2 text-2xs`，手写药片普遍是 `h-auto px-1.5 py-px`）：

```ts
size: { default: '', xs: 'h-auto px-1.5 py-px' }
```

**不加 `neutral`**：`secondary` 已覆盖中性。

**批 4 修正**：原计划"不新增 `danger`/`info`"，但 `features/board/tone.ts` 的真实色板里三档无法用现有变体表达——`P0 = bg-destructive text-white`（实心红，`destructive` 是软底，不等价）、`planning = bg-info-soft text-info`（蓝，`outline` 无法表达）、`implementation = bg-primary-soft text-primary`（软紫，`default` 是实心紫）。为保视觉零漂移，补这三档并写进 spec；命名规则：**`danger` = 实心红（高优先警示）**，**`destructive` = 软底红（错误态）**。

## 3. 分段控件：Tabs vs ToggleGroup

| 场景 | 组件 | 依据 |
|---|---|---|
| 切换主内容区（视图/面板/页签） | `Tabs` | `role=tab`+`aria-selected`，`TabsTrigger` 自带 `h-[calc(100%-1px)]` 贴合轨道 |
| 只表达一个选项值（字号、主题、多选标签） | `ToggleGroup` | `aria-pressed` 语义正确，不虚构 tabpanel |
| 药片内含操作（删除 ×） | `Badge` | 嵌套可交互元素会与 `ToggleGroupItem` 的按下事件冲突 |

`ToggleGroup`（Base UI）受控值为 `readonly Value[]`，`onValueChange(groupValue: Value[])`，单选靠 `multiple={false}`（默认）。**单选不可取消**：用户再点已选项会得到 `[]`，必须忽略空数组。

### 3.1 字号（`PreferencesDialog.tsx:129`）

```tsx
<ToggleGroup
  value={[fontSize]}
  onValueChange={(next) => { if (next[0]) setFontSize(next[0]) }}
  className="flex h-8 items-stretch rounded-lg bg-muted p-0.75"
>
  {FONT_CHOICES.map((choice) => (
    <ToggleGroupItem
      key={choice.value}
      value={choice.value}
      className="h-full flex-1 rounded-md text-xs font-medium text-foreground/60 aria-pressed:bg-primary aria-pressed:font-semibold aria-pressed:text-primary-foreground"
    >
      {choice.label}
    </ToggleGroupItem>
  ))}
</ToggleGroup>
```

- 容器 `h-8 p-0.75` + item `h-full` → 26px，消除原 `h-6`(24px) 与内容区差 2px 的错位（根因记录）。
- 紫色：`toggleVariants` 基础类含 `aria-pressed:bg-muted`，调用侧 `aria-pressed:bg-primary` 由 `cn` 裁决；不生效则给 `ui/toggle.tsx` 加 `variant="primary"`。

### 3.2 看板筛选（`ExecutionHeader.tsx:58`）

沿用 `git stash@{0}` 已验证写法，补 `aria-label`：

```tsx
<Tabs value={filters.scope === 'mine' ? 'mine' : 'all'} onValueChange={(v) => onChange({ scope: v === 'mine' ? 'mine' : 'all' })}>
  <TabsList aria-label="任务范围">
    <TabsTrigger value="all">全部进行中</TabsTrigger>
    <TabsTrigger value="mine">只看我的</TabsTrigger>
  </TabsList>
</Tabs>
```

`filters.scope` 只有 `'all' | 'mine'`（`hooks/useBoard.ts:42`），服务端也把非 mine 归一（`lib/team-client.js:701`），受控值恒命中。

### 3.3 其余四处

- `TopBar.tsx:143-159`（顶部导航）→ **不换 Tabs**：这是 MPA 页面跳转（`onNavigate` → `window.location.assign`），`role="tablist"` 需要配对的 `tabpanel`，换掉只会退化语义。保留 `<nav>` + `aria-current="page"`，只把两套手写 class 收编成 `Button variant="ghost" size="sm"`（选中加 `bg-secondary`）；现有"滚动到可视区"的 `useEffect`（`:76-87`）保留。
- `AdminPage.tsx:192-210`（admin 视图导航）→ `Tabs`（原 `aria-current` + `bg-primary` 选中态由 Tabs 接管）。
- `LiveSyncControlDialog.tsx:260-277`（文件切换器）→ `Tabs`，`value` 用文件路径/id。
- `SavedViewsDialog.tsx:110-118,128-136`（阶段/标签多选）→ `<ToggleGroup multiple>`，`value` 直接是字符串数组，删掉手写 `toggle()`。
- `PreferencesDialog.tsx:94-121`（主题三选一，含预览卡）→ `<ToggleGroup>` 的 item 内放 `ThemePreview` 装饰块；不装 `radio-group`（YAGNI）。

### 3.4 保存组合视图（`ExecutionHeader.tsx:83-105`，移到批 4）

两个子结构分开处理，都用 `badgeVariants` 作为唯一颜色来源：

```tsx
// 已保存视图：容器是 span（内含"切换"与"删除"两个按钮），不能给 span 挂 onSelect
<span className={cn(badgeVariants({ variant: active ? 'default' : 'outline' }), 'gap-1 pr-1')}>
  <button type="button" onClick={() => onChange({ executionView: view.id })}>{view.name}</button>
  <button type="button" aria-label={`删除组合视图 ${view.name}`} onClick={() => onDeleteView(view.id)}>×</button>
</span>

// 内置视图：纯按钮
<Badge
  variant={active ? 'default' : 'outline'}
  render={<button type="button" aria-pressed={active} onClick={() => onChange({ executionView: view.id })} />}
>{view.name}</Badge>
```

放弃 `Badge render={<button>}` + 内层 `role="button"` 的方案：`Badge` 带 `overflow-hidden` 与 `[&>svg]:size-2.5!`，且嵌套可交互元素会让点击区域互相吞并。保留现有 DOM 语义（外层切换 + 内层删除）。

### 3.5 `ToggleGroup` 的 `spacing` 陷阱（实测）

`ui/toggle-group.tsx:73` 对 `data-spacing=0` 打了一串 `group-data-[spacing=0]/toggle-group:rounded-none` 与 `first:rounded-l-md / last:rounded-r-md`，其选择器特异性高于调用侧 `rounded-full`/`rounded-md`。因此：

- 需要"各自独立的药片/胶囊"时**不能**用 `spacing={0}`，用 `spacing={1}`/`{1.5}`（间隙 = `--spacing(n)`），圆角才归调用侧控制。
- 需要"连体分段条"时才用 `spacing={0}`，此时圆角由 group 的首尾规则接管。
- `ToggleGroup` 单选模式再次点击当前项会回调 `[]`；受控组件必须"取第一项且命中才 set"，否则会清空选择。

## 4. 下拉与输入（批 3）

现状四套：`ui/select`（原子）、`board/SelectField.tsx`（薄封装，手写 `span[data-slot=select-value]`）、`board/SearchableSelect.tsx`（直连 `@base-ui/react/combobox`）、`ExecutionHeader.tsx:190-210` 的私有 `FilterField`（把 `SelectField` 又抄了一遍）。

收敛：

```tsx
// features/board/SelectField.tsx —— 静态选项唯一入口，保留现有 props
<select> 外观     → ui/select 的 SelectTrigger
当前值渲染        → <SelectValue />
// features/board/SearchableSelect.tsx —— 需要搜索/大量选项时的唯一入口
→ @/components/ui/combobox 组合（对象 value + itemToStringLabel）
```

**计划偏差（已实施）**：原计划给 `SelectField` 加 `searchable` 开关，实际不加——一个组件承担两种交互（原生 select 语义 vs 可输入 combobox）会让 props 与 a11y 都含糊；搜索场景直接用 `SearchableSelect`。`features/admin/MultiSelectField.tsx` 全仓库 0 调用点（`AgentToolSelector` 自带一份），直接删除而不迁移。

- `FilterField` 删除，调用点换 `SelectField`（options 形状同为 `SelectOption`，`SearchableSelect.tsx` 已 `import type { SelectOption } from './SelectField'` 证明可互换）。
- `ui/combobox.tsx` 导出 `Combobox/ComboboxInput/ComboboxTrigger/ComboboxList/ComboboxItem/ComboboxEmpty`，把 `Combobox.Root/InputGroup/Portal/Positioner/Popup` 全收进 ui 层。
- `controlClass`（`admin/shared.tsx:6`）删除：`<input className={controlClass}>`→`<Input className="text-xs">`（`Input` 默认 `text-sm`，admin 密排场景显式降到 `text-xs`）；`<select>`→`SelectField`；`MultiSelectField.tsx:54-57` 的触发器皮肤改 `cn(controlClass… )` 删除后走 `Input` 外观，`:68` 的 `ChevronDownIcon` 与 `SelectTrigger` 对齐，`:72` 写死的 `Agent 工具` label 改为 props。
- 原生控件清单：`PluginsTab:253,265,273`、`TeamsTab:117,171,184`、`TeamSwitcher:31`（全站最后一个原生 `<select>`）。

## 4.1 尺寸基线与原生控件（实测补充）

- 基线：所有可交互控件（`Input`/`Textarea`/`SelectTrigger`/`Button` 默认档）统一 32px（`h-8`）。`ui/select.tsx:41` 的 `px-2 py-1.5` 已改 `py-0`，否则 32px 高里塞 18px 内容盒会裁字。
- 与 32px 控件同排的按钮一律用默认档；`size="sm"`（28px）只允许出现在：表格行内动作、文件/列表行内联动作、弹窗页脚、文字型「加载更多」。
- 前端不得出现原生 `<select>`/`<option>`/`<checkbox>`：`TeamSwitcher`、`TeamsTab`（选择用户/团队角色）、`PluginsTab`（项目选择 + 两个输入）已全部换成 `SelectField`/`Input`，实测 `document.querySelectorAll('select').length === 0`。
- 分段控件尺寸：轨道 `h-8` + `p-0.5`、item `h-full`（28px，2px 内缩）。不要用 `p-0.75`+`h-6`（26px，旧版被判"选中项比容器小"的根因）。
- 横向滚动的 `TabsList` 必须隐藏滚动条：`[scrollbar-width:none] [&::-webkit-scrollbar]:hidden`（`AdminPage` 导航）。
- dev 环境：插件面板 iframe 内的 `/plugin-ui/*` 静态资源必须由 `packages/web/vite.config.ts` 的 proxy 转给后端，否则命中 SPA 兜底返回 `text/html`，`<link rel=stylesheet>` 被浏览器拒收 → 面板裸样式。

## 5. tone 与药片（批 4）

单一路径：

```
业务状态 ──statusTone()/priorityTone()/stageTone()/controlTone()──> tone 键 ──Badge/StatusPill──> 颜色类
```

- `features/board/tone.ts`：`priorityTone/stageTone/laneTone` 改为返回 tone 键，删掉拼接 class 的分支；圆点色改由 `ui/status-pill.tsx` 的 `toneDot(tone)` 提供，替掉 `Kanban.tsx:39` 的 `laneTone(lane.id).split(' ')[0]` 字符串切割。
- `features/board/task-view.ts` 的 `controlToneClass` → `controlTone`（返回 tone 键）。
- `lib/admin-shared.ts` 的 `statusTone` 保持返回 tone 键（现状即如此），只补 `tone→Badge variant` 映射到 `ui/status-pill.tsx`。
- `ui/badge.tsx`（药片变体）与 `ui/status-pill.tsx`（`TONE_DOT`/`TONE_SURFACE`）是唯一出现 `bg-*-soft` 的文件；`ConditionChecks:113-119,137,162,206,219,242`、`TaskOperationList:11-27`、`FlowSignals:124-130` 的本地 `TONES` 全删。
- 面状提示（提示条 / 条件卡片 / 图标底板）走 `toneSurface(tone, quiet?)`（`ui/status-pill.tsx` 导出）：`success`/`warning`/`destructive` 各一档，`quiet` 给 `/50` 淡底；边框透明度由调用侧给（`border-warning/35`、`border-success/20`），属性不重叠所以不打架。批 9 收尾时把 6 文件 16 处手拼 `bg-*-soft` 全部改用它，PRD 验收的 rg 断言因此通过。
- `StatusPill` 签名：`{ tone: Tone; children: ReactNode; className?: string; title?: string; size?: 'default' | 'xs' }`，内部 `Badge variant={TONE_VARIANT[tone]}`；`admin/shared.tsx` 里的 `TONE_CLASS` 删除，其导出的 `StatusPill({ value })` **删除**（不再保留适配器）：23 处调用点直连 `@/components/ui/status-pill`，写法 `<StatusPill tone={statusTone(x)}>{x || 'unknown'}</StatusPill>`，`tone` 只在调用点由 `statusTone()` 求得，`ui/status-pill.tsx` 不感知 admin 状态词表。

映射表（写进 `ui/status-pill.tsx` 与 spec）：

| tone | Badge variant | 典型来源 |
|---|---|---|
| success | `success` | 已完成/在线/lane=verification |
| warning | `warning` | 待放行/临近截止/lane=review |
| danger | `danger`（实心红） | 优先级 P0 |
| destructive | `destructive`（软底红） | 失败/被阻断/关系异常 |
| neutral | `secondary` | P2/P3/未知 |
| info | `info`（软蓝） | lane=planning |
| primary | `primary-soft`（软紫） | lane=implementation / 监听在线 |

`Tone` 类型定义在 `ui/status-pill.tsx`，`lib/admin-shared.ts` 只做 `import type` 再 `export type` 转出，两处不再各写一份。

## 6. 空态与加载（批 5）

- `ui/empty-row.tsx`：`<p className="cn('rounded-lg bg-muted/50 px-3 py-4 text-center text-xs text-muted-foreground', className)">`，与旧 `features/admin/shared.tsx` 的 `EmptyRow` 逐字一致（**不复用 `Empty`**：`Empty` 的 `flex-1`/`gap-4`/`p-6` 会撑破表格行与两列格）。实际调用点 28 处 / 8 个 admin 文件，只改 import 来源。
- 块级空态统一 `<Empty>`（`<EmptyHeader><EmptyTitle>…</EmptyTitle><EmptyDescription>…</EmptyDescription></EmptyHeader>`）；只有一行文案时直接 `<EmptyDescription>` 省掉 header。`Empty` 的 `border-dashed` 不含宽度，要虚线框必须调用侧给 `border`。侧栏/弹窗正文用 `className="p-3"`/`p-4`、`bg-muted/40` 压紧，避免默认 `p-6 + flex-1` 过重。
- 加载占位统一 `Skeleton`（2–3 行 `h-4/h-8`），不再写「正在读取…」文案：`AdminPage.tsx`、`ArchiveSyncTab.tsx`（含日志）、`TaskDetailDialog.tsx`（详情与归档附件）、`TaskOwnershipDialog.tsx`、`ProjectOnboardingDialog.tsx`、`AgentQuickInitDialog.tsx`、`OwnershipInboxPanel.tsx`。
- `AgentToolSelector.tsx`：原生 `<input type="checkbox">` → `Checkbox`（Base UI 渲染 `button[role=checkbox]`，所以**必须** `id` + `label htmlFor`，不能只靠 label 包裹），`onChange` → `onCheckedChange`；「已初始化」手写文字 → `<Badge variant="secondary" size="xs">`。
- 例外（保留纯 `<p>`）：两列依赖格 `TaskDetailDialog.tsx:602,614`、列表项 `TeamView.tsx:117`、表格 `colSpan` 行 `TeamView.tsx:250-256`、表单提示 `AccountDialog.tsx:88`/`UsersTab.tsx:133`、错误文案 `CreateTaskDialog.tsx:226`/`ProjectOnboardingDialog.tsx:744,758`；`ProjectRail:1037,1067` 的 `animate-pulse` 是图标脉冲（上传/解绑进行中），不换骨架。## 7. 提示与错误（批 6）

`Alert` 变体映射：`default`→提示、`destructive`→错误、`success`/`warning` 若注册表不含则用 `className` 覆盖（`Alert` 的 variant 只有 `default`/`destructive`，success/warning 由 `className` 传 `border-success/35 bg-success-soft`，保持现状配色）。

- 错误：`LoginApp:346,443`、`LoginPage:180`、`BoardPage:320`、`AdminPage:172`、`LiveSyncControlDialog:788`、`PluginsView:206`、`OwnershipInboxPanel:106`、`ArchiveView:227`、`TaskOwnershipDialog:320`、`ProjectOnboardingDialog:586`、`PasswordDialog:100`、`CreateTaskDialog:291`、`AgentQuickInitDialog:207`、`PublishOperationDialog:77`。
- 提示/说明：`dialogs/` 6 份 callout、`ProjectOnboardingDialog:625,633,707,737-783`（预检 5 状态压成一个 `Alert`，variant 由状态映射）、`ProjectRail:718,726`（抽本地 `RailNotice`，只在本文件出现两次）、`TaskDetailDialog:463,731,789`、`PluginsView:206`、`HandoffNotice:257`。
- `CreateTaskDialog:291` 的成功文案改走 `toast`，`Alert` 只承载错误（成功用绿色提示条与全站一致）。

### 7.1 实施修正（批 6 完成后回写）

- `Alert` 只有 `default`/`destructive` 两个变体，success/warning 提示一律用 `variant` 默认 + `className="border-success/35 bg-success-soft text-success"` / `border-warning/35 bg-warning-soft text-warning` 覆盖，不新增 registry 变体。
- `Alert` 内部硬编码 `role="alert"`，非错误类提示（同步中、待确认）传 `role="status"` 覆盖（props 在 `role` 之后展开）。
- 图标提示条保留 `<svg>` 作首个直接子元素：`Alert` 的 `has-[>svg]:grid-cols-[auto_1fr]` 会把它放进左列并 `row-span-2`。
- 表单内联错误（弹窗正文里 `text-xs text-destructive` 的一行文案）不套 `Alert`：加边框会把简单校验错误放大成横幅；已登记为例外清单（`implement.md` 批 6 执行记录）。
- 带按钮的错误提示把按钮放进 `AlertDescription` 的 flex 行（`OwnershipInboxPanel`）或用 `AlertTitle` + `AlertDescription` 两行（`ArchiveSyncTab`），不用 `AlertAction` 的绝对定位（窄容器会压住文本）。

## 8. 卡片与表格（批 7）

- `Panel` 保持自建实现（`flex flex-col gap-2.5 rounded-xl bg-card p-4`），不套 `Card`：`Card` 的 `rounded-lg ring-1 ring-foreground/10` 与全站现有 `rounded-xl` 面板不是同一视觉，套上必然漂移。
- `Panel` 增 `as?: 'section' | 'div' | 'aside' | 'article'`（默认 `section`）与其余原生属性透传，语义标签由调用侧决定：`TeamView:106` `<Panel as="aside">`、`ArchiveView:233` `<Panel as="div">`、`PluginsView:267` `<Panel as="article">`。
- 23 处 admin 调用只改 import（`@/components/ui/panel`），`features/admin/shared.tsx` 的 `Panel` 删除；board 容器 `AttentionQueue`、`FlowSignals`、`TaskOperationList`、`TeamView`（两处）、`ArchiveView`、`ProjectRail:1147` 卡片、`PluginsView:267` 卡片全部改为 `<Panel>` + `className` 覆盖间距，视觉逐字保留。
- 表格：两张手写 `<table>`（`ArchiveView`、`TeamView`）改用 `ui/table`，并把滚动责任交给表格容器——`Table` 新增 `containerClassName`，容器 `overflow-y-auto` + 定高后，`thead` 的 `sticky top-0` 才真的有滚动祖先（`overflow-x-auto` 会连带把 `overflow-y` 变成 `auto`，容器不设高度时只是「不滚动的滚动祖先」，`sticky` 会随内容滚走；这正是原先不敢换的原因）。
- 表头/单元格用 `className` 覆盖回原值：`TableHeader` 加 `sticky top-0 z-10 bg-muted text-2xs text-muted-foreground`，表头行 `border-0 hover:bg-transparent`，`TableHead` 加 `h-auto text-inherit`（默认 `h-10 px-2 text-foreground` 会把字号/内边距/颜色都改掉），`TableCell` 加 `whitespace-normal`（默认 `whitespace-nowrap` 会让任务标题不换行）。
- `ConditionChecks:36-56` 是 `grid` 假表（`grid-cols-[92px_minmax(220px,1.2fr)…]`），`Table` 无法表达响应式列宽 → 保留 grid，spec 登记为允许例外。
- `TaskDetailDialog:563`（阶段证据）、`:741`（附件行）的 `ul.divide-y` 模拟表格同样不转 `Table`：无表头、无列宽约束，`ul` 语义正确。

### 8.1 实施修正（批 7 完成后回写）

- 行卡片（`AssignmentsDialog:88`、`ProjectManagerDialog:131`、`BranchListenersDialog:100`）不转 `Panel`：面板是 `rounded-xl bg-card p-4`，行卡片是 `rounded-lg bg-muted px-3 py-2`，转过去等于改视觉；且三处间距各不相同，抽象不出稳定契约。
- `Panel` 的 `as` 用 `const Tag = as as ElementType` + `Omit<ComponentProps<'section'>, 'children' | 'className' | 'title' | 'ref'>`：联合标签的 `ref` 类型互相冲突（`TS2322`），省略 `ref` 是唯一不需要 `@ts-expect-error` 的写法。
- 表格转换的实测：注入 40 行后 `scrollTop=240`，两张表的 `thead` 顶边仍等于容器顶边（`stuck: true`），`position: sticky`、`z-index: 10`、表头底色 `oklch(0.97 0 0)`（`bg-muted`）、单元格 `8px 12px`、字重 600 与改造前一致。
- `PluginsView:267` 的 `article` 自带 `draggable`/`onDragStart`/`onDrop`，`Panel` 的属性透传让它们原样生效，无需额外包装。

## 9. 表单（批 8）

`admin/shared.tsx` 的 `Field` 是"label 包 children"（点文字得焦点，但控件无 `id`，也不支持 `aria-describedby`），`ui/field` 用 `htmlFor`/`id` 显式关联：

```tsx
<Field className="gap-1">
  <FieldLabel htmlFor="team-name" className="text-xs font-medium text-muted-foreground">
    团队名称
  </FieldLabel>
  <Input id="team-name" />
  <FieldDescription className="text-2xs">…</FieldDescription>
</Field>
```

`ui/field` 的默认值与现有视觉不同（`gap-2` vs 4px、label 无 muted 色、`FieldDescription` 是 `text-xs` 而非 `text-2xs`），因此每处都用 `className` 覆盖回原值；**不新增变体、不加 props 包装器**，覆盖是调用侧一行类名。

迁移清单（全部完成）：

- admin 22 处 `Field`（6 文件）：`AccountDialog` 2、`ArchiveSyncTab` 9、`BranchManagementPanel` 2、`ProjectsTab` 4、`ResetPasswordDialog` 2、`UsersTab` 3；控件 id 见 `implement.md` 批 8 执行记录。
- board 弹窗 13 处 `<div className="flex flex-col gap-1.5">` + `<Label htmlFor>` 行：`CreateTaskDialog` 7、`PasswordDialog` 3、`ProjectOnboardingDialog` 2、`AgentQuickInitDialog` 1 → `<Field className="gap-1.5">` + `<FieldLabel htmlFor>`（id 不变，视觉不变）。
- `TaskDetailDialog` 计划字段三处（截止日期/里程碑/标签）由 `<div>` + 无关联 `Label` 改 `Field`/`FieldLabel htmlFor` + `id`（`task-plan-due-date`/`-milestone`/`-tags`）；阻断依赖行的原因输入补 `aria-label`（同行 `SelectField` 早有 `ariaLabel`）。
- `TaskOwnershipDialog` 的候选行原为 `<label>` 包 `Checkbox`（Base UI 渲染成 `button[role=checkbox]`，点文字不勾选）→ `Field orientation="horizontal"` + `Checkbox id` + `FieldLabel htmlFor` + `FieldContent`，点标题即勾选。
- `Row`（admin 列表行 `flex min-h-12 items-center justify-between border-b`）保留在 feature，spec 登记为已知布局件；它没有对应 registry 组件，硬抽 `ui/` 只会多一层无意义抽象。

## 10. 其余原子归属（批 9）

| 目标 | 归属 | 理由 |
|---|---|---|
| `StatTile` | `features/board/StatTile.tsx` | `Overview:17` + `FlowSignals:133`，仅 board 内用；`Card size="sm"` 承载 |
| `SummaryGrid` | 各自文件本地 | `LiveSyncControlDialog` 5 块 + `ProjectOnboardingDialog:605`，形状差 `dt/dd` 顺序，强行合并无收益 |
| `StatusDot` | `ProjectRail.tsx` 本地 | 6 处全在同一文件 |
| `SearchField` | `TopBar.tsx` 本地 | 同文件两处（`:117`、`:174`） |
| `TeamCheckboxList` | `features/admin/TeamCheckboxList.tsx` | `UsersTab:132` + `AccountDialog:103` |
| `PluginBindingForm` | `features/admin/PluginBindingForm.tsx` | `ProjectsTab:458` + `PluginsTab:252`（字段与校验已不同步，合并后统一） |
| `AffectedProjectList` | `ArchiveSyncTab.tsx` 本地 | 同文件 `:198` + `:533` |
| `Pagination` | 统一到 `ui/pagination` | `pageItems` 窗口算法留在 `features/board/Pagination.tsx` 作为 `items` 生成器 |
| `Progress` | `TeamView:126` | `ui/progress` 已存在 |
| `Avatar` | 5 处 | `ui/avatar` 已存在 |
| `Separator` | `ProjectRail:900,926` | 现有 `border-l` 是在容器上画线，改为容器内嵌 `Separator orientation="vertical"` |
| `ScrollArea` | `ProjectRail:597` | 现有 `max-h-56 overflow-auto` |
| `Tooltip` | `ProjectRail:800,823,841,913,1004`、`TopBar:165,191` | `TooltipProvider` 已在 `app/providers.tsx`；禁用态触发器包一层 `span tabIndex={0}`，否则保留 `title` |

### 10.1 实施修正（批 9 完成后回写）

- `StatTile` 不用 `Card size="sm"`：`Card` 是 `rounded-lg bg-card py-3 ring-1 ring-foreground/10`，而 `Overview` 是 `rounded-xl border bg-card px-3 py-2`、`FlowSignals` 是 `rounded-lg border bg-muted/40 px-2.5 py-2`，两处都要整段覆盖。改为普通 `div` + `className` 透传，基础类只留 `flex flex-col`，gap 也交给调用侧（`FlowSignals` 原本无 gap，若进基础类会多 2px×2）。
- `Pagination` 不用 `PaginationLink/Previous/Next`：它们是 `<a>`，客户端分页用锚点会丢键盘语义与 `aria-current` 语义。改为 `PaginationNav` + `PaginationContent` + `PaginationItem` 包 `Button`，`pageItems` 算法与文案不动。
- `ScrollArea` 未迁移：`ProjectRail` 弹窗正文是 `max-h-56 overflow-auto`（无确定高度），Base UI Viewport 是 `size-full`，父级只有 max-height 会塌陷；保留原生滚动并登记例外。
- 禁用态 Tooltip 全部保留 `title`（`ProjectRail` 上传本地任务 / 不再同步）：包 `span tabIndex={0}` 会让禁用按钮看起来可聚焦，且原生 `title` 在禁用态同样不触发，行为等价。
- 链接型按钮用 `Button render={<a href />}`（`DevicesTab` 打开桌面客户端、`AdminPage` 返回看板）：Base UI 的 `render` 会把根元素替换成 `<a>`，实测 tag 为 `A`、无嵌套交互元素、高度/圆角/底色与改造前一致，同时补上 focus ring 与 hover。

## 11. 规范落盘（批 10）

`.trellis/spec/frontend/component-reuse.md`：

1. 分层规则 + 判定四步（§1）。
2. 组件选择矩阵：场景 → 组件 → 反例（表格：列表空态/表单行/状态药片/面板容器/分段切换/弹窗/表格/加载/错误提示/悬停提示/进度/头像/分页/代码块/眉标）。
3. 禁止清单：原生 `input/select/textarea/table/checkbox`、`@base-ui/react/*` 直连、`space-*`、raw palette、`bg-*-soft` 出现在 `ui/badge.tsx` 之外、`rounded-full px-*` 手写药片、`title=` 悬停提示（除禁用态例外）、feature 内复用 ≥2 文件的组件不上提。
4. `ui/` 新增与提升流程（装注册表 → 改 `@/registry/*` import → base-mira 核对 → 只做加法 → 提交说明"为什么必须新增"）。
5. 审计命令（参数数组传参，避免 shell 引号把 `\b` 吃掉——本次首轮误报 0 原生 table 的根因）。
6. PR 前自查 6 条 + 本次旧→新对照表。

`frontend/index.md` 加索引；`frontend/quality-guidelines.md` 加一行指向。

## 12. 验证策略

- 静态（每批）：`npx tsc -b`（packages/web）、`npx oxlint src`、`npx oxfmt <files>`、PRD 里对应 `rg` 断言。
- 动态（每批受影响的页面）：`yarn dev` + 真实浏览器，检查控制台 0 error、布局无塌陷、label 点击可聚焦、药片配色与改前一致。
- 视觉对比：5 处表格迁移前后逐列截图对比；4 档 tone 各验一次；字号/看板分段控件的实测数值（32px 轨道 / 28px item / `aria-selected`）。
- 收尾：`git diff --stat` 核对只动清单内文件；全量浏览器抽查 12 个页面。
