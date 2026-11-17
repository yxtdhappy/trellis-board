# Design — 统一 Web 端字号与尺寸刻度

## 1. 技术底座（已实测结论）

- Tailwind **v4.3.5**，无 `tailwind.config.*`，通过 `@tailwindcss/vite` 引入；主题在 `packages/web/src/index.css` 的 `@theme inline` 中声明。
- 动态间距刻度可用：用 `tailwindcss` 的 `compile()` 实际生成 CSS 验证过 `gap-0.75` → `calc(var(--spacing) * 0.75)`、`pt-4.5`、`w-67`、`max-h-55`、`max-w-160`、`max-w-310` 均生成成功；`--spacing` 未被覆盖，仍是 0.25rem。
- 半径刻度被 shadcn 覆盖：`--radius-xs` 仍为 0.125rem（2px），`--radius-sm/md/lg/…` = `calc(var(--radius) * 0.6/0.8/1/…)`，`--radius` = 0.625rem（10px）→ `rounded-sm`=6px、`rounded-md`=8px、`rounded-lg`=10px。
- 字号刻度：`@theme inline` 无任何 `--text-*`，`text-xs`=0.75rem 为最小档；`text-xs` 同时输出 `line-height: var(--tw-leading, var(--text-xs--line-height))`（1rem）。
- `--color-success/-soft`、`--color-warning/-soft`、`--color-info/-soft`、`--color-primary-soft`、`--color-destructive-soft` 已注册，语义色清理不需要新 token。
- `cn` 由 `packages/web/src/lib/utils.ts` 从 `cn` 包 re-export。

## 2. 字号映射的实现机制

**为什么不能换 px**：`html[data-font-size]` 把根字号在 14/16/18/20px 间切换，所有 rem 刻度随之整体缩放；换 px 会让「字号设置」对这些文本失效。因此新增 token 仍用 rem。

**为什么 `--text-2xs` 不配行高**：审计的 324 处字号里，253 处（`0.625`/`0.65625`/`0.6875` 三档）只有 **14 处**显式写了 `leading-*`，其余依赖继承行高。若为 `--text-2xs` 定义 `--text-2xs--line-height`，等于给 239 处密集列表强插行高，属于计划外的排版变更。定义只有字号、行高声明因 var 未定义而失效回落继承，与现状 `text-[0.625rem]` 行为完全一致。

**`text-xs` 的既有代价**：11→12px 替换必然带上 `line-height: 1rem`。对 11px→12px 的正文字号，1rem(16px) 行高接近常规（1.33 倍），可接受；但涉及密集表格/看板卡片，必须用截图核对是否换行。若个别位置回退严重，允许保留 `leading-*` 显式覆盖，不允许回退成任意 rem。

**层级统一（刻意变更，需在 PR 说明）**：

| 位置 | 现状 | 改为 | 差异 |
|---|---|---|---|
| `features/board/TeamView.tsx:210` h1 | 17px | `text-lg` | +1px |
| `features/board/ArchiveView.tsx:128` h1 | 19px | `text-lg` | −1px |
| `features/board/ExecutionHeader.tsx:51` h1 | 19px | `text-lg` | −1px |
| `features/plugins/PluginsView.tsx:181` h1 | 19px | `text-lg` | −1px |
| `pages/admin/AdminPage.tsx:162` h1 | 22px | `text-lg` | **−4px**（待用户确认，备选 `text-xl`） |
| `features/board/Overview.tsx:22` 指标 | 20px | `text-xl` | 0 |
| `features/board/FlowSignals.tsx:143` 指标 | 19px | `text-xl` | +1px |

## 3. 非字号尺寸：为什么选间距步数而不是容器 token

`max-w-md`(28rem)、`max-w-xl`(36rem) 与任意值完全等价，优先用容器 token；其余值（38.75rem、47.5rem 等）不在容器刻度上，用 `max-w-<rem×4>` 表达，语义即「0.25rem 的整数倍」，且不引入新 token。唯一不能整除的是 `w-[14.375rem]`（57.5 步）→ `w-58`（232px，宽 2px，侧边栏可接受）。

`border-[0.09375rem]`（1.5px，`PreferencesDialog` 选中态）在 v4 没有对应刻度（边框只有 0/2/4/8），改用统一 1px `border` + `border-primary` 区分选中，避免 1px/1.5px 混用带来的重排。

## 4. 颜色清理的映射依据

一律向 `packages/web/src/features/board/tone.ts` 已建立的语义约定收敛：
- `amber-*/dark:*` → `border-warning/35 bg-warning-soft text-warning`（`--warning` 浅色 #b45309 / 深色 #fbbf24 已具备对比度）
- `emerald-*/dark:*` → `border-success/35 bg-success-soft text-success`
- `PreferencesDialog` 的 `ThemePreview` 用字面 `neutral-*`/`white` 描绘「另一个主题」，语义 token 在深色模式下会自我抵消，**必须保留**。

## 5. `cn()` 改造机械规则

- `className={`a ${b}`}` → `className={cn('a', b)}`
- `className={`a ${cond ? 'x' : 'y'}`}` → `className={cn('a', cond ? 'x' : 'y')}`
- `className={`${cond && 'x'}`}` 这类会产出 `"false"` 的写法：`cn(cond && 'x')`
- 顺序保持原样（`cn` 不排序，后写者覆盖前者，顺序会影响覆盖结果，禁止重排既有类）。

## 6. 骨架 / 分隔

- `Skeleton` 目前不存在。优先 `npx shadcn@latest add skeleton`（components.json 已就绪，style `base-mira`）；registry 不可达时按官方实现手写 `packages/web/src/components/ui/skeleton.tsx`：`function Skeleton({ className, ...props }) { return <div data-slot="skeleton" className={cn("animate-pulse rounded-md bg-accent", className)} {...props} /> }`。只用 `bg-accent`，不覆盖颜色。
- `Separator` 已存在（`packages/web/src/components/ui/separator.tsx`），默认 `border-t`；用于 `LoginApp`/`LoginPage` 的段前分隔与 `TeamView` 的两个小节分隔。`PreferencesDialog` 的 DialogFooter 边框与 `TopBar` 的响应式 `@max-[48em]:border-t` 属壳层/响应式布局，保留。

## 7. 风险与回归面

| 风险 | 影响 | 缓解 |
|---|---|---|
| `text-xs` 带 1rem 行高 | 密集列表换行、卡片变高 | 逐屏截图核对；必要时在单点补 `leading-*` |
| 8–9.5px → 10px | 微字变宽，窄容器溢出（`ProjectRail` 侧栏 232px、`AttentionQueue` 徽标） | 截图核对侧栏/徽标；`truncate` 已到位 |
| `w-58` vs 14.375rem | 侧栏 +2px | 可接受 |
| `AdminPage` 标题 −4px | 视觉层级变化 | PR 标注；用户可改判 `text-xl` |
| `cn()` 重排类名 | 覆盖顺序变化 | 不重排，仅替换拼接语法 |
| 颜色语义化后深浅色对比 | 深色模式下 `bg-warning-soft`(#451a03) + `text-warning`(#fbbf24) 已存在同类组合 | 与 `tone.ts` 一致，截图核对 |

## 8. 验证策略（一次性，收尾执行）

```bash
# 残留任意值（排除 ui 原语与 ThemePreview 例外）
rg -n 'text-\[[0-9.]+rem\]' packages/web/src --glob '!components/ui/**'
rg -n '\[[0-9.]+rem\]' packages/web/src --glob '!components/ui/**'
# 调色板色 / dark: 覆盖 / 模板字符串 / animate-pulse / border-t
rg -n '(amber|emerald|teal|sky|blue|indigo|violet|purple|rose|red|green|neutral|slate|gray|zinc|stone)-[0-9]{2,3}' packages/web/src --glob '!components/ui/**' --glob '!features/settings/PreferencesDialog.tsx'
rg -n 'dark:(bg|text|border|ring)-' packages/web/src --glob '!components/ui/**'
rg -n 'className=\{`' packages/web/src --glob '!components/ui/**'
rg -n 'animate-pulse' packages/web/src --glob '!components/ui/**'
rg -n 'border-t' packages/web/src --glob '!components/ui/**'

# 构建 / lint / 格式化
yarn build
yarn workspace @trellis-board/web lint
yarn format:check
```

视觉核对：`yarn dev` 起服务（server + web），用 tabbit 打开并逐屏截图：TeamView（含跨项目查询侧栏）、Kanban/TaskCard、TaskDetailDialog、Admin 各 Tab、LoginPage、Desktop 登录页、ProjectOnboardingDialog 扫描态。重点看：文字溢出/截断、行高变化导致的高度跳动、侧栏宽度、徽标换行、深浅色两套主题下的 warning/success 对比度。

## 9. Phase 2 并行切片（互不重叠，共享本文件的映射契约）

| 切片 | 文件 |
|---|---|
| P1 底座 | `packages/web/src/index.css`、`components/ui/skeleton.tsx`（新增）、`features/settings/PreferencesDialog.tsx`、`features/board/dialogs/ProjectOnboardingDialog.tsx` |
| P2 布局 | `components/layout/ProjectRail.tsx`、`components/layout/TopBar.tsx` |
| P3 看板视图 | `features/board/{TeamView,TaskCard,Kanban,AttentionQueue,StageTape,FlowSignals,Overview,ArchiveView,ExecutionHeader,Pagination,ConditionChecks,TaskOperationList}.tsx` |
| P4 看板对话框 | `features/board/dialogs/{TaskDetailDialog,BranchListenersDialog,SavedViewsDialog,TaskOwnershipDialog}.tsx` |
| P5 管理端 | `features/admin/*`、`pages/admin/AdminPage.tsx` |
| P6 其它 | `features/plugins/*`、`pages/login/LoginPage.tsx`、`desktop/{LoginApp,LiveSyncControlDialog}.tsx`、`dialogs/*`（AssignmentsDialog、ProjectManagerDialog、CreateTaskDialog、PasswordDialog、PublishOperationDialog、AgentQuickInitDialog、AgentToolSelector、AssigneeWarningDialog） |

依赖：`skeleton.tsx` 只在 P1 创建、P1 内消费；其余切片无交叉依赖，可并行。收尾由主会话统一跑第 8 节验证，任何切片不得中途自行 build/lint/format。
