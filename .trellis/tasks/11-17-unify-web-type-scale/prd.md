# 统一 Web 端字号与尺寸刻度，清理 shadcn 规范违规

## Goal

把 `packages/web/src` 中手写的任意 rem 字号与尺寸（审计共 **380 处 / 54 个文件**，其中字号 **338 处 / 19 档半像素刻度 / 48 个文件**）收敛到 Tailwind 主题刻度，使字号层级只剩可枚举的几档；同时清理同一轮审计中发现的其它 shadcn 规范违规（原始调色板颜色、模板字符串 `className`、骨架占位 `animate-pulse`、`border-t` 分隔）。

用户可见结果：界面密度更统一、可读性提高（8–9.5px 的微字提升到 10px），并且用户字号设置（`html[data-font-size]`）仍然整体缩放。

## Background

- `packages/web/src/features/board/TeamView.tsx` 等处使用 `text-[0.59375rem]`、`text-[0.65625rem]` 这类四位小数 rem，偏离 shadcn「用变体/刻度类，不写任意值」的约定，也让设计尺度无法统一。
- `packages/web/src/index.css` 用 `html[data-font-size='sm'|'md'|'lg'|'xl'] { font-size: 14/16/18/20px }` 提供用户字号设置，**rem 不能换成 px**，只能换成以 rem 表达的主题刻度。
- `@theme inline` 目前没有 `--text-*` token，最小刻度是 `text-xs` = 0.75rem = 12px；现有 184 处字号（除 `components/ui` 原语）在 8–10.5px 区间，没有对应刻度 → 需要新增 `--text-2xs: 0.625rem`（10px，不带 line-height，保持与原任意值一致的继承行为）。
- 同一轮审计的其它命中：原始调色板颜色 46 处 / 6 文件、模板字符串 `className` 40 处 / 15 文件、`animate-pulse` 9 处 / 2 文件、`border-t` 分隔 7 处 / 5 文件。「`w-N h-N` 应改 `size-N`」经逐条复核**无有效命中**（命中的都是不等宽高），不作为需求项，仅顺带删除 `Button` 内多余的图标尺寸类（2 处）。
- 已有语义色约定在 `packages/web/src/features/board/tone.ts`（`bg-warning-soft text-warning`、`bg-success-soft text-success`、`bg-info-soft text-info`、`bg-primary-soft text-primary` 等），`packages/web/src/index.css` 已把这些映射进 `@theme inline`，因此颜色清理不需要新增 token。
- 约束来源：`.trellis/spec/frontend/directory-structure.md`「样式一律使用 Tailwind token 类，不写任意色值」「`packages/web/src/components/ui/` 是 shadcn 生成的原语，不手工改结构」。

## Requirements

### R1 新增字号 token，建立四档层级

在 `packages/web/src/index.css` 的现有 `@theme inline` 块内新增：

```css
--text-2xs: 0.625rem;
```

不定义 `--text-2xs--line-height`（原 `text-[0.625rem]` 无行高，定义行高会改变 239 处未显式写 `leading-*` 的排版）。字号层级收敛为：`text-2xs`(10px) / `text-xs`(12px) / `text-sm`(14px) / `text-base`(16px) / `text-lg`(18px) / `text-xl`(20px)。

### R2 字号映射（`packages/web/src` 下除 `components/ui/**`）

| 原任意值（rem） | px | 替换为 |
|---|---|---|
| 0.5 / 0.53125 / 0.5625 / 0.59375 / 0.625 / 0.65625 | 8 – 10.5 | `text-2xs` |
| 0.6875 / 0.71875 / 0.75 / 0.78125 | 11 – 12.5 | `text-xs` |
| 0.8125 / 0.84375 / 0.90625 / 0.9375 | 13 – 15 | `text-sm` |
| 1.0625 | 17 | `text-base`（正文类） |
| 1.1875 / 1.25 | 19 – 20 | `text-xl`（指标数字类） |
| 1.375 | 22 | `text-lg`（页面标题类） |
| 2 | 32 | `text-3xl` + `leading-tight`（仅 `pages/login/LoginPage.tsx:97` 登录页大标题，现 `text-[2rem] leading-[1.3]`） |

补充规则：
- 页面级 `<h1 className="… font-heading">`（TeamView / ArchiveView / ExecutionHeader / PluginsView / AdminPage）统一为 `text-lg`。
- `FlowSignals.tsx:143`、`Overview.tsx:22` 这类大号指标数字用 `text-xl`。
- 已显式写的 `leading-*` / `tabular-nums` 等保持不变。

### R3 非字号任意 rem → 间距/圆角刻度

`rem × 4` 得到间距步数（`--spacing` = 0.25rem），因此：

| 原值 | 替换 | 原值 | 替换 |
|---|---|---|---|
| `max-w-[28rem]` | `max-w-md`（同 28rem） | `max-w-[36rem]` | `max-w-xl`（同 36rem） |
| `max-w-[25rem]` | `max-w-100` | `max-w-[30rem]` | `max-w-120` |
| `max-w-[31.25rem]` | `max-w-125` | `max-w-[32.5rem]` | `max-w-130` |
| `max-w-[34rem]` | `max-w-136` | `max-w-[35rem]` | `max-w-140` |
| `max-w-[36.25rem]` | `max-w-145` | `max-w-[37.5rem]` | `max-w-150` |
| `max-w-[38.75rem]` | `max-w-155` | `max-w-[40rem]` | `max-w-160` |
| `max-w-[45rem]` | `max-w-180` | `max-w-[47.5rem]` | `max-w-190` |
| `max-w-[51.25rem]` | `max-w-205` | `max-w-[60rem]` | `max-w-240` |
| `max-w-[77.5rem]` | `max-w-310` | `w-[5.25rem]` | `w-21` |
| `w-[16.75rem]` | `w-67` | `w-[14.375rem]` | `w-58`（232px，比现状宽 2px） |
| `h-[1.625rem]` | `h-6.5` | `max-h-[12.25rem]` | `max-h-49` |
| `max-h-[13.75rem]` | `max-h-55` | `gap-[1.375rem]` | `gap-5.5` |
| `gap-[0.1875rem]` | `gap-0.75` | `pt-[1.125rem]` | `pt-4.5` |
| `rounded-[0.5625rem]` | `rounded-lg`（10px，现 9px） | `border-[0.09375rem]` | 见 R4 的 `PreferencesDialog` 条目 |

Tailwind v4.3.5 支持小数/任意整数间距步（已在本地用 `compile()` 实测 `gap-0.75`、`pt-4.5`、`max-w-160`、`w-67` 均能生成）。

### R4 原始调色板颜色 → 语义 token

改用 `tone.ts` 已有约定（`--color-*` 已在 `@theme inline` 注册）：`border-warning/35 bg-warning-soft text-warning`、`border-success/35 bg-success-soft text-success`、`text-success`。

| 位置 | 现状 | 改为 |
|---|---|---|
| `components/layout/ProjectRail.tsx:648,656` | `border-amber-500/35 bg-amber-500/10 text-amber-800 dark:text-amber-300` | `border-warning/35 bg-warning-soft text-warning` |
| `features/board/TaskOperationList.tsx:16,20` | `text-amber-700 dark:text-amber-400` / `text-emerald-700 dark:text-emerald-400` | `text-warning` / `text-success` |
| `features/board/dialogs/AgentQuickInitDialog.tsx:200` | `border-emerald-500/35 bg-emerald-500/5 text-emerald-700 dark:text-emerald-400` | `border-success/35 bg-success-soft text-success` |
| `features/board/dialogs/PublishOperationDialog.tsx:68` | `bg-emerald-500/10 text-emerald-600` | `bg-success-soft text-success` |
| `features/board/dialogs/ProjectOnboardingDialog.tsx:632-633,730-731,772,786,804` | `border-amber-500/40 bg-amber-500/5`、`text-amber-700 dark:…`、`text-emerald-700 dark:…` | warning / success 语义 token |
| `features/settings/PreferencesDialog.tsx:100-104` | 选中态 `border-[0.09375rem] border-primary`，未选中 `border border-border` | 卡片类名改 `cn('flex flex-col gap-2 rounded-lg border p-2 text-left transition-colors', active ? 'border-primary' : 'border-border hover:border-foreground/20')`，统一 1px 边框 |

同时清理：`dark:` 前缀在这些位置随之消失后，`packages/web/src`（除 `components/ui/**`）不应再有手写 `dark:` 颜色覆盖。

### R5 模板字符串 `className` → `cn()`

15 个文件共 40 处 `className={\`…\`}` 改为 `cn('…', cond && '…')` / `cn('…', cond ? 'a' : 'b')` 形式，`cn` 从 `@/lib/utils` 导入（无 `cn` 依赖的文件需新增 import）。逐处检查是否有 `${cond && 'x'}` 这类会产出 `"false"` 字符串的写法，改成 `cn()` 后必须消除。

涉及文件（命中数）：`features/settings/PreferencesDialog.tsx` 8、`components/layout/ProjectRail.tsx` 6、`features/board/ConditionChecks.tsx` 6、`features/admin/TeamsTab.tsx` 3、`features/board/Kanban.tsx` 2、`features/board/TaskCard.tsx` 2、`features/board/TeamView.tsx` 2、`features/board/dialogs/BranchListenersDialog.tsx` 2、`features/board/dialogs/TaskDetailDialog.tsx` 2、`features/plugins/PluginsView.tsx` 2、`desktop/LiveSyncControlDialog.tsx` 1、`features/admin/TeamSwitcher.tsx` 1、`features/board/AttentionQueue.tsx` 1、`features/board/FlowSignals.tsx` 1、`features/board/StageTape.tsx` 1。

### R6 骨架占位改用 `Skeleton`

`features/board/dialogs/ProjectOnboardingDialog.tsx:200-203,206-207` 的 6 个自写 `animate-pulse` 占位块改用 `Skeleton`（需新增 `packages/web/src/components/ui/skeleton.tsx`：优先 `npx shadcn@latest add skeleton`，取不到 registry 时按官方 registry 实现手写：`data-slot="skeleton"` + `cn('animate-pulse rounded-md bg-accent', className)`）。

保留 `animate-pulse`（非占位，属状态/加载指示，在 PR 说明中记录）：`components/layout/ProjectRail.tsx:300`（syncing 状态圆点）、`:910` / `:940`（在途操作图标）。

### R7 `border-t` 纯分隔 → `Separator`

| 位置 | 处理 |
|---|---|
| `desktop/LoginApp.tsx:362,450` | `<p className="border-t border-border pt-4 …">` → `<Separator className="mt-6" />` + `<p className="pt-4 …">`（保留原 `mt-6`） |
| `pages/login/LoginPage.tsx:191` | 同上 |
| `features/board/TeamView.tsx:109,140` | 容器 `border-t border-border/60 pt-2` → 上方加 `<Separator className="mb-2" />`，容器保留 `pt-2` 与内容 |

保留不改（记入 design 的「例外」）：`features/settings/PreferencesDialog.tsx:162`（DialogFooter 的壳层分隔，改它会破坏统一对话框壳层）、`components/layout/TopBar.tsx:143`（`@max-[48em]:border-t` 响应式边框，`Separator` 无法表达）。

### R8 明确排除范围

| 排除项 | 理由 |
|---|---|
| `packages/web/src/components/ui/**` 的 10 处任意值（`switch` 4、`badge`/`button`/`checkbox`/`dropdown-menu`/`tabs`/`tooltip` 各 1） | shadcn registry 生成的原语，改动会波及全部使用点且下次 `shadcn add` 会被覆盖；spec 规定不手工改 |
| `features/settings/PreferencesDialog.tsx:33-52` 的 `bg-neutral-*`/`bg-white` | `ThemePreview` 刻意用字面色块描绘浅色/深色系统主题，语义 token 无法表达「另一个主题」 |
| `features/board/tone.ts` 的 `text-white` | `bg-destructive` 上没有对应前景 token，且不属于调色板色号 |
| R2 `1.0625rem`→`text-base` 之外的标题尺寸（AdminPage 22px → 18px） | 属刻意的层级统一，在 design.md 记录视觉差异 |

- **R9（2026-11-17 追加）**：`components/ui/**` 既有原语的任意 rem 值同口径替换：`badge`/`dropdown-menu` 的 `text-[0.625rem]`→`text-2xs`；`button` `xs` 尺寸的 `text-[0.6875rem]`→`text-xs/relaxed`（与该尺寸族其它档一致）；`tabs` 的 `p-[0.1875rem]`→`p-0.75`、`py-[calc(--spacing(1.25))]`→`py-1.25`；`tooltip` 箭头 `rounded-[0.125rem]`→`rounded-xs`；`switch` 的 `h-[1.0375rem] w-[1.75rem] h-[0.875rem] w-[1.5rem]`→`h-4 w-7 h-3.5 w-6`。已知视觉差异：`switch` default 轨道 16.6px→16px（−0.6px，Tailwind 动态间距不接受 0.15 步长，实测 `h-4.15` 不生成 CSS）；`checkbox` 的 `rounded-[0.25rem]` 无 4px token（`--radius-xs`=2px、`--radius-sm`=6px），保留几何值改为 `rounded-[4px]`。

## Constraints

- 只改样式类与（R6 的）新原语文件；不改组件结构、交互、文案、状态流、接口。
- 不新建 CSS 文件；新 token 只在 `index.css` 现有 `@theme inline` 内新增；保持 rem 单位以兼容 `data-font-size` 缩放。
- 不写 `!important`、不写 `dark:` 颜色覆盖、不新增第三方依赖。
- `components/ui/**` 既有原语的改动仅限任意 rem/px 刻度替换（R9），不得改结构、API、variant 名称与 DOM。
- 使用 `cn()` 而非模板字符串三元；`gap-*` 而非 `space-*`；语义色而非色号。
- 格式化只用 `oxfmt`（`yarn format`），lint 用 `oxlint`（`yarn workspace @trellis-board/web lint`）。
- 提交时把 `.trellis/tasks/11-17-unify-web-type-scale/` 一并入库。

## Acceptance Criteria

- [ ] `packages/web/src` 全量（含 `components/ui/**`），`text-[<数字>rem]` 命中数 = 0；`\[[\d.]+rem\]` 仅剩 R8 排除项。
- [ ] 字号类集合 = {`text-2xs`, `text-xs`, `text-sm`, `text-base`, `text-lg`, `text-xl`}（外加既有 `text-xs/relaxed` 等变体写法）。
- [ ] 原始调色板色（`amber|emerald|teal|sky|blue|indigo|violet|purple|rose|red|green|neutral|slate|gray|zinc|stone)-\d{2,3}`）仅剩 `PreferencesDialog` 的 `ThemePreview` 与 `components/ui/**`。
- [ ] 除 `ProjectRail.tsx:300,910,940` 外，`animate-pulse` 在 `packages/web/src`（除 `components/ui/**`）为 0。
- [ ] `border-t` 分隔命中仅剩 `PreferencesDialog.tsx:162`、`TopBar.tsx:143`。
- [ ] `className={` 模板字符串在 `packages/web/src`（除 `components/ui/**`）为 0。
- [ ] `yarn build` 通过（`tsc -b && vite build`）、`yarn workspace @trellis-board/web lint` 无新增告警、`yarn format:check` 通过。
- [ ] 人工核对截图：TeamView、Kanban/TaskCard、TaskDetailDialog、Admin 页、LoginPage/Desktop 登录页、ProjectOnboardingDialog 扫描态；文字无溢出、无截断、对话框/侧栏宽度合理。

## Open Questions

- 已确认（2026-11-17）：页面标题统一 `text-lg`（18px），接受 `AdminPage` 标题由 22px 缩小 4px。
- 已确认（2026-11-17）：`Skeleton` 若 registry 不可达，允许手写官方等价实现。
- 已确认（2026-11-17）：一次 PR 覆盖全部六个实施切片（P1–P6）。

## Out of Scope

- 任何行为、接口、数据流、文案改动。
- ~~`components/ui/**` 既有原语样式刷新~~ → 2026-11-17 用户追加要求纳入本次范围，见 R9；实现时保持零视觉改动（除下述已知 0.6px 例外）。
- 引入 `Alert` / `Empty` / `Badge` 替换自写块（未在审计中形成批量违规，另开任务）。
- 非 rem 的其它任意值：容器查询断点（`@max-[48em]`、`@[64em]`）、grid 模板（`[minmax(0,1fr)_360px]`、`[1fr_100px]`）、视口自适应（`[85vh]`、`[min(72rem,92vw)]`、`[clamp(16rem,55vh,34rem)]`）、`[calc(...)]`、`[45%]`/`[3px]`、以及 19 处 `tracking-[0.xxem]` 字距——均为上下文相关且无等价刻度，本次不动（唯一例外：`LoginPage.tsx:97` 的 `leading-[1.3]`→`leading-tight`）。
- 全局字体族/颜色体系调整。
- `dark:bg-input/30`：`features/board/SearchableSelect.tsx:43`、`features/admin/shared.tsx:7`、`features/admin/MultiSelectField.tsx:55` 保留原样——这是 shadcn registry 对输入框的标准写法（与 `components/ui/input.tsx:11` 完全一致），不是调色板颜色覆盖。
- `features/admin/DevicesTab.tsx:152` 的既有 `text-2xl`（24px 配对码）保留：标准刻度类，非任意值。
- `Kanban.tsx` 的 `min-h-[100vh]`、`LoginApp.tsx`/`LiveSyncControlDialog.tsx` 的 `max-h-[85vh]` 保留：视口类，非 rem 刻度。
