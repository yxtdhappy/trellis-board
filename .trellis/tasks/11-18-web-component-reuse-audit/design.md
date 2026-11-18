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
```

以及尺寸档（现有固定 `h-5 px-2 text-2xs`，手写药片普遍是 `h-auto px-1.5 py-px`）：

```ts
size: { default: '', xs: 'h-auto px-1.5 py-px' }
```

**不加 `danger`/`neutral`/`info`**：`destructive` 已覆盖 danger、`secondary` 覆盖 neutral，新增同义档只会让"该用哪个"重新变成问题（这也解释了为什么之前 45 处药片各写一遍）。

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

- `TopBar.tsx:143-159`（顶部导航）→ `TabsList variant="line"` + `TabsTrigger`；现有"滚动到可视区"的 `useEffect`（`:76-87`）保留。
- `AdminPage.tsx:192-210`（admin 视图导航）→ `Tabs`（原 `aria-current` + `bg-primary` 选中态由 Tabs 接管）。
- `LiveSyncControlDialog.tsx:260-277`（文件切换器）→ `Tabs`，`value` 用文件路径/id。
- `SavedViewsDialog.tsx:110-118,128-136`（阶段/标签多选）→ `<ToggleGroup multiple>`，`value` 直接是字符串数组，删掉手写 `toggle()`。
- `PreferencesDialog.tsx:94-121`（主题三选一，含预览卡）→ `<ToggleGroup>` 的 item 内放 `ThemePreview` 装饰块；不装 `radio-group`（YAGNI）。

### 3.4 保存组合视图（`ExecutionHeader.tsx:83-105`）

```tsx
<Badge
  variant={active ? 'default' : 'outline'}
  size="xs"
  className="gap-1 pr-1"
  render={<button type="button" aria-pressed={active} />}
  onClick={() => onSelectView(view.id)}
>
  {view.name}
  <span
    role="button"
    tabIndex={-1}
    aria-label={`删除组合视图 ${view.name}`}
    onClick={(event) => { event.stopPropagation(); onDeleteView(view.id) }}
  >×</span>
</Badge>
```

保留现有 DOM 语义（外层切换 + 内层删除），只把颜色/尺寸类换成 `Badge`；`StopPropagation` 保证"只删不切"。

## 4. 下拉与输入（批 3）

现状四套：`ui/select`（原子）、`board/SelectField.tsx`（薄封装，手写 `span[data-slot=select-value]`）、`board/SearchableSelect.tsx`（直连 `@base-ui/react/combobox`）、`ExecutionHeader.tsx:190-210` 的私有 `FilterField`（把 `SelectField` 又抄了一遍）。

收敛：

```tsx
// features/board/SelectField.tsx —— 唯一入口，保留现有 props，新增 searchable
<input|select> 外观 → ui/select 的 SelectTrigger / <Input>
当前值渲染       → <SelectValue />
searchable       → 内部切到 @/components/ui/combobox
```

- `FilterField` 删除，调用点换 `SelectField`（options 形状同为 `SelectOption`，`SearchableSelect.tsx` 已 `import type { SelectOption } from './SelectField'` 证明可互换）。
- `ui/combobox.tsx` 导出 `Combobox/ComboboxInput/ComboboxTrigger/ComboboxList/ComboboxItem/ComboboxEmpty`，把 `Combobox.Root/InputGroup/Portal/Positioner/Popup` 全收进 ui 层。
- `controlClass`（`admin/shared.tsx:6`）删除：`<input className={controlClass}>`→`<Input className="text-xs">`（`Input` 默认 `text-sm`，admin 密排场景显式降到 `text-xs`）；`<select>`→`SelectField`；`MultiSelectField.tsx:54-57` 的触发器皮肤改 `cn(controlClass… )` 删除后走 `Input` 外观，`:68` 的 `ChevronDownIcon` 与 `SelectTrigger` 对齐，`:72` 写死的 `Agent 工具` label 改为 props。
- 原生控件清单：`PluginsTab:253,265,273`、`TeamsTab:117,171,184`、`TeamSwitcher:31`（全站最后一个原生 `<select>`）。

## 5. tone 与药片（批 4）

单一路径：

```
业务状态 ──statusTone()/priorityTone()/stageTone()/controlTone()──> tone 键 ──Badge/StatusPill──> 颜色类
```

- `features/board/tone.ts`：`priorityTone/stageTone/laneTone` 改为返回 tone 键（`'success'|'warning'|'danger'|'neutral'|'info'`），删掉拼接 class 的分支；新增 `laneDotTone(id)` 返回 `bg-*` 圆点类，替掉 `Kanban.tsx:37` 的 `laneTone(lane.id).split(' ')[0]` 字符串切割。
- `features/board/task-view.ts` 的 `controlToneClass` → `controlTone`（返回 tone 键）。
- `lib/admin-shared.ts` 的 `statusTone` 保持返回 tone 键（现状即如此），只补 `tone→Badge variant` 映射到 `ui/status-pill.tsx`。
- `ui/badge.tsx` 是唯一出现 `bg-*-soft` 的文件；`ConditionChecks:113-119,137,162,206,219,242`、`TaskOperationList:11-27`、`FlowSignals:124-130` 的本地 `TONES` 全删。
- `StatusPill` 上提后签名：`{ tone: Tone; children: ReactNode; className?: string }`，内部 `Badge variant={toneVariant[tone]}`；`admin/shared.tsx` 里的 `TONE_CLASS` 删除。

映射表（写进 `ui/status-pill.tsx` 与 spec）：

| tone | Badge variant |
|---|---|
| success | `success` |
| warning | `warning` |
| danger | `destructive` |
| neutral | `secondary` |
| info | `outline`（现有描边即可，不新增 `info`） |

## 6. 空态与加载（批 5）

- `ui/empty-row.tsx`：`<Empty className="rounded-lg bg-muted/50 px-3 py-4"><EmptyTitle className="text-xs font-normal text-muted-foreground">{children}</EmptyTitle></Empty>`，`EmptyRow` 的 37 处只改 import 来源。
- 散落空态统一为 `<Empty><EmptyHeader><EmptyTitle>…</EmptyTitle><EmptyDescription>…</EmptyDescription></EmptyHeader></Empty>`；`Kanban:74` 的空列保留虚线边框外观（`className="border-dashed"`）。
- 加载占位统一 `Skeleton`：`AdminPage:167`、`ArchiveSyncTab:229`、`TaskDetailDialog:430`、`TaskOwnershipDialog:257`、`ProjectOnboardingDialog:629`、`PluginLogsDialog:38`、`OwnershipInboxPanel:121`、`AgentQuickInitDialog:171`。
- 例外：`ProjectRail:1037,1067` 的 `animate-pulse` 是图标脉冲（上传/解绑进行中），不换骨架。

## 7. 提示与错误（批 6）

`Alert` 变体映射：`default`→提示、`destructive`→错误、`success`/`warning` 若注册表不含则用 `className` 覆盖（`Alert` 的 variant 只有 `default`/`destructive`，success/warning 由 `className` 传 `border-success/35 bg-success-soft`，保持现状配色）。

- 错误：`LoginApp:346,443`、`LoginPage:180`、`BoardPage:320`、`AdminPage:172`、`LiveSyncControlDialog:788`、`PluginsView:206`、`OwnershipInboxPanel:106`、`ArchiveView:227`、`TaskOwnershipDialog:320`、`ProjectOnboardingDialog:586`、`PasswordDialog:100`、`CreateTaskDialog:291`、`AgentQuickInitDialog:207`、`PublishOperationDialog:77`。
- 提示/说明：`dialogs/` 6 份 callout、`ProjectOnboardingDialog:625,633,707,737-783`（预检 5 状态压成一个 `Alert`，variant 由状态映射）、`ProjectRail:718,726`（抽本地 `RailNotice`，只在本文件出现两次）、`TaskDetailDialog:463,731,789`、`PluginsView:206`、`HandoffNotice:257`。
- `CreateTaskDialog:291` 的成功文案改走 `toast`，`Alert` 只承载错误（成功用绿色提示条与全站一致）。

## 8. 卡片与表格（批 7）

- `Panel` → `ui/panel.tsx`：保留 `rounded-xl border border-border bg-card` + `title/kicker/description/action/children` props，内部 `Card className="rounded-xl border border-border ring-0"` + `CardHeader/CardTitle/CardDescription/CardAction/CardContent`；23 处 admin 调用只改 import，board 8 处容器 `Panel`（无 header props）直接替换手写 `rounded-xl border bg-card`。
- 语义标签优先：`TeamView:106` 的 `<aside>`、`ArchiveView:233` 的 `<section>` 保持标签，只把内层容器换成 `Panel`。
- 行卡片：`AssignmentsDialog:88`、`ProjectManagerDialog:131`、`BranchListenersDialog:100`、`DependencyItem:103`、`TaskDetailDialog:437` 统一 `<Panel className="px-2.5 py-2">`（无 header）。
- 表格：`Table` 外层 `div[data-slot=table-container]` 自带 `overflow-x-auto`；`TableHead` 默认 `h-10 px-2`，手写是 `sticky top-0 bg-muted px-3 py-2` → 全部用 `className` 覆盖回原值：

```tsx
<Table className="border-collapse text-left text-xs">
  <TableHeader className="sticky top-0 bg-muted text-2xs text-muted-foreground">
    <TableRow className="border-b">
      <TableHead className="px-3 py-2 font-semibold">任务</TableHead>
    </TableRow>
  </TableHeader>
  <TableBody>
    <TableRow className="cursor-pointer border-b border-border/60 hover:bg-muted/40">
      <TableCell className="px-3 py-2">…</TableCell>
    </TableRow>
  </TableBody>
</Table>
```

- `ConditionChecks:36-56` 是 `grid` 假表（响应式列宽 `grid-cols-[92px_minmax(220px,1.2fr)…]`），`Table` 无法表达 grid 列宽 → **保留 grid，只把行容器换成 `TableRow` 等语义无效**，故本项降级为"不动"，在 spec 登记为允许例外（响应式 grid 表）。
- `TaskDetailDialog:563`（阶段证据四列）、`:741`（附件行）转 `Table`，`colSpan` 空态行保留。

## 9. 表单（批 8）

`admin/shared.tsx` 的 `Field` 是"label 包 children"（点文字得焦点），`ui/field` 用 `htmlFor`/`id`：

```tsx
<Field>
  <FieldLabel htmlFor="team-name">团队名称</FieldLabel>
  <Input id="team-name" />
  <FieldDescription>…</FieldDescription>
</Field>
```

迁移清单：admin 19 处 + `TaskDetailDialog:532,659` + `SavedViewsDialog` + `TaskOwnershipDialog:222`（`Field orientation="horizontal"` + `Card`）。`Row`（admin 列表行）保留在 feature，spec 登记为已知布局件。

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

- 静态（每批）：`npx tsc -b`（packages/web）、`npx oxlint src`、`yarn oxfmt <files>`、PRD 里对应 `rg` 断言。
- 动态（每批受影响的页面）：`yarn dev` + 真实浏览器，检查控制台 0 error、布局无塌陷、label 点击可聚焦、药片配色与改前一致。
- 视觉对比：5 处表格迁移前后逐列截图对比；4 档 tone 各验一次；字号/看板分段控件的实测数值（32px 轨道 / 26px item / `aria-selected`）。
- 收尾：`git diff --stat` 核对只动清单内文件；全量浏览器抽查 12 个页面。
