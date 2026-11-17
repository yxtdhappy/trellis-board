# Implement — 统一 Web 端字号与尺寸刻度

> 约束：任何切片都不得中途自行跑 build / lint / format；所有验证在第 8 节一次性执行。
> 映射契约以 `prd.md` R1–R8 的表格与本目录 `design.md` 第 2–6 节为准；表外的值不得自创刻度。

## 1. 底座（P1，先行）

- [ ] `packages/web/src/index.css`：在现有 `@theme inline` 块内、`--font-sans` 附近新增 `--text-2xs: 0.625rem;`（不新增 `--text-2xs--line-height`，不新建 CSS 文件，不改 `html[data-font-size]` 段）。
- [ ] 新增 `packages/web/src/components/ui/skeleton.tsx`：先试 `npx shadcn@latest add skeleton`；失败则手写 `data-slot="skeleton"` + `cn("animate-pulse rounded-md bg-accent", className)`。
- [ ] `features/settings/PreferencesDialog.tsx`：`rounded-[0.5625rem]`→`rounded-lg`；选中态卡片改 `cn('flex flex-col gap-2 rounded-lg border p-2 text-left transition-colors', active ? 'border-primary' : 'border-border hover:border-foreground/20')`；该文件 8 处模板字符串 → `cn()`；字号按 R2。
- [ ] `features/board/dialogs/ProjectOnboardingDialog.tsx`：6 个自写 `animate-pulse` 占位 → `Skeleton`（保留 `:196` 的 `animate-spin`）；7 处 amber/emerald → warning/success；字号按 R2。

验证：`rg -n 'animate-pulse|border-t|\\[[0-9.]+rem\\]' packages/web/src/features/settings/PreferencesDialog.tsx packages/web/src/features/board/dialogs/ProjectOnboardingDialog.tsx`，预期仅剩 DialogFooter 的 `border-t`。

## 2. 布局（P2）

- [ ] `components/layout/ProjectRail.tsx`：`:648,656` 警告条 → `border-warning/35 bg-warning-soft text-warning`；`:629` `w-[14.375rem]`→`w-58`；`:300,910,940` 的 `animate-pulse` **保留**；6 处模板字符串 → `cn()`；字号按 R2（注意 `0.53125`/`0.59375` 等 → `text-2xs`）。
- [ ] `components/layout/TopBar.tsx`：字号按 R2；`:143` 的 `@max-[48em]:border-t` **保留**。

验证：`rg -n 'amber-|emerald-|dark:' packages/web/src/components/layout` 应为空。

## 3. 看板视图（P3）

- [ ] `features/board/TeamView.tsx`：h1 `1.0625rem`→`text-lg`；`:109,:140` 的 `border-t border-border/60 pt-2` → 容器前加 `<Separator className="mb-2" />`；`w-[5.25rem]`→`w-21`；`0.5rem`（头像缩写）→`text-2xs`；2 处模板字符串 → `cn()`。
- [ ] `features/board/TaskCard.tsx`：`0.5rem`→`text-2xs`；2 处模板字符串 → `cn()`。
- [ ] `features/board/Kanban.tsx`、`features/board/Pagination.tsx`、`features/board/ExecutionHeader.tsx`（h1→`text-lg`）、`features/board/ArchiveView.tsx`（h1→`text-lg`）、`features/board/AttentionQueue.tsx`（`0.5625rem`→`text-2xs`，模板字符串→`cn()`）、`features/board/StageTape.tsx`（模板字符串→`cn()`）、`features/board/ConditionChecks.tsx`（模板字符串 6 处→`cn()`；`Button` 内 `ChevronUp/DownIcon` 删除 `size-3`）、`features/board/FlowSignals.tsx`（指标 `1.1875rem`→`text-xl`）、`features/board/Overview.tsx`（指标 `1.25rem`→`text-xl`）、`features/board/TaskOperationList.tsx`（`text-amber-700 dark:*`→`text-warning`、`text-emerald-700 dark:*`→`text-success`）。
- [ ] `features/board/Pagination.tsx` 的分页按钮尺寸按 R3/R2，不改分页行为。

验证：`rg -n 'animate-pulse|amber-|emerald-|dark:|\\[[0-9.]+rem\\]' packages/web/src/features/board/*.tsx` 应为空（`TaskOperationList` 例外已处理）。

## 4. 看板对话框（P4）

- [ ] `features/board/dialogs/TaskDetailDialog.tsx`（39 处，最大头）、`BranchListenersDialog.tsx`、`SavedViewsDialog.tsx`、`TaskOwnershipDialog.tsx`：字号/尺寸按 R2/R3；模板字符串 → `cn()`。
- [ ] 保持既有对话框壳层：`Dialog` + 单 `DialogBody` 滚动 + fixed header/footer，不得顺手改结构。

验证：`rg -n '\\[[0-9.]+rem\\]|className=\\{`' packages/web/src/features/board/dialogs` 应为空。

## 5. 管理端（P5）

- [ ] `features/admin/*`（ArchiveSyncTab 15、BranchManagementPanel 10、DevicesTab 10、ProjectsTab 10、PluginsTab 8、shared.tsx 8、UsersTab 7、AuditTab 5、AccountDialog 3、OneTimeCredentialDialog 3、ResetPasswordDialog 2、TeamsTab 2 + `cn()` 3 处、MultiSelectField 1、TeamSwitcher 1 + `cn()` 1 处）
- [ ] `pages/admin/AdminPage.tsx`：h1 `1.375rem`→`text-lg`（视觉 −4px，已在 PRD Open Questions 标注）。

验证：`rg -n '\\[[0-9.]+rem\\]|className=\\{`' packages/web/src/features/admin packages/web/src/pages/admin` 应为空。

## 6. 其它（P6）

- [ ] `features/plugins/PluginsView.tsx`（h1→`text-lg`）、`features/plugins/PluginLogsDialog.tsx`
- [ ] `pages/login/LoginPage.tsx`：`:97` h1 `text-[2rem] leading-[1.3]` → `text-3xl leading-tight`；`:191` `border-t border-border pt-4` → `<Separator className="mt-6" />` + `<p className="pt-4 …">`
- [ ] `desktop/LoginApp.tsx`：`:362,:450` 同上处理（保留原 `mt-6`/`pt-4` 语义）
- [ ] `desktop/LiveSyncControlDialog.tsx`
- [ ] `dialogs/*`：`AssignmentsDialog`、`ProjectManagerDialog`、`CreateTaskDialog`、`PasswordDialog`、`PublishOperationDialog`（emerald→success）、`AgentQuickInitDialog`（emerald 面板→`border-success/35 bg-success-soft text-success`）、`AgentToolSelector`、`AssigneeWarningDialog`

验证：`rg -n '\\[[0-9.]+rem\\]|className=\\{`' packages/web/src/features/plugins packages/web/src/pages/login packages/web/src/desktop packages/web/src/dialogs` 应为空。

## 7. 排除项复核（不得越界）

- [ ] `components/ui/**` 既有文件零改动（`skeleton.tsx` 为新增例外）。
- [ ] `PreferencesDialog.tsx:33-52` 的 `bg-neutral-*`/`bg-white` 未改。
- [ ] `tone.ts` 未改。
- [ ] 未引入新依赖、未写 `!important`、未新增 `dark:` 颜色覆盖。

验证：`git diff --stat packages/web/src/components/ui` 只应出现 `skeleton.tsx` 新增。

## 8. 收尾验证（主会话执行一次）

```bash
rg -n 'text-\[[0-9.]+rem\]' packages/web/src --glob '!components/ui/**'
rg -n '\[[0-9.]+rem\]' packages/web/src --glob '!components/ui/**'
rg -n '(amber|emerald|teal|sky|blue|indigo|violet|purple|rose|red|green|neutral|slate|gray|zinc|stone)-[0-9]{2,3}' packages/web/src --glob '!components/ui/**' --glob '!features/settings/PreferencesDialog.tsx'
rg -n 'dark:(bg|text|border|ring)-' packages/web/src --glob '!components/ui/**'
rg -n 'className=\{`' packages/web/src --glob '!components/ui/**'
rg -n 'animate-pulse' packages/web/src --glob '!components/ui/**'
rg -n 'border-t' packages/web/src --glob '!components/ui/**'
yarn build
yarn workspace @trellis-board/web lint
yarn format:check
```

- [x] 残留 grep 与 PRD「Acceptance Criteria」逐条对齐。
- [ ] `yarn dev` 起服务，用 tabbit 逐屏截图核对：TeamView（含跨项目查询侧栏）、Kanban/TaskCard、TaskDetailDialog、Admin 各 Tab、LoginPage、Desktop 登录页、ProjectOnboardingDialog 扫描态；深浅两套主题各看一遍 warning/success 对比度。
- [ ] 视觉问题只在单点补 `leading-*`，不得回退成任意 rem。
- [ ] 提交时把 `.trellis/tasks/11-17-unify-web-type-scale/` 一并入库；提交前先向用户汇报变更范围与验证结果并取得确认。

### 执行记录（2026-11-17）

- `rg` 扫描 `packages/web/src`（排除 `components/ui/**`）：任意 rem 值 0 命中、`className={\`` 0 命中、`amber-`/`emerald-` 0 命中、`space-x/y` 0 命中；仅剩 3 处刻意保留的 `animate-pulse`（`ProjectRail.tsx:301/920/950`）、19 处 `tracking-[…em]`、2 处 `dark:bg-input/30` 之外的 `dark:` 归零。
- `packages/web` 内 `npx tsc -b` 通过；`npx vite build` 通过（仅 chunk 体积提示）。产出的 `packages/server/public/assets/TrellisLogo-*.css` 实测生成 `.text-2xs{font-size:.625rem}`、`.w-58`、`.w-67`、`.max-h-49`、`.gap-0\.75`、`.h-6\.5`、`.sm\:max-w-130/136/140/145/150/155/160/180/190/205/240/310`。
- `npx oxlint`（packages/web）无 error，仅既有 react(set-state-in-effect)/exhaustive-deps 类 warning。
- `npx oxfmt --check` 对本次 50 个文件全部通过（先对 21 个文件执行了 `oxfmt` 写入，纯折行变化）。
- 视觉逐屏核对未执行：本机 5173/5174 被其它项目占用，开发数据目录 `~/.trellis-board-dev/server` 无系统管理员（`node packages/server/team/cli.js init-admin` 未执行），且无 tabbit CLI；改由 CSS 产物与 grep 断言覆盖，视觉确认留给用户在 `yarn dev` 中过一遍。

### 追加：`components/ui/**` 原语清理（2026-11-17 用户追加）

- `badge.tsx` `text-[0.625rem]`→`text-2xs`；`dropdown-menu.tsx` 快捷键 `text-[0.625rem]`→`text-2xs`。
- `button.tsx` `xs` 尺寸 `text-[0.6875rem]`→`text-xs/relaxed`（与 default/sm/lg 一致）。
- `tabs.tsx` `p-[0.1875rem]`→`p-0.75`、`group-data-vertical/tabs:py-[calc(--spacing(1.25))]`→`py-1.25`。
- `tooltip.tsx` 箭头 `rounded-[0.125rem]`→`rounded-xs`（`--radius-xs`=0.125rem，等价）。
- `switch.tsx` `h-[1.0375rem]`→`h-4`（16.6px→16px，−0.6px）、`w-[1.75rem]`→`w-7`、`h-[0.875rem]`→`h-3.5`、`w-[1.5rem]`→`w-6`。
- `checkbox.tsx` `rounded-[0.25rem]`→`rounded-[4px]`（无 4px token，保几何零变化，仅去掉 rem 单位）。
- 残余检查：`rg '\[[0-9.]+rem\]' packages/web/src` 全量 **0** 命中；`h-4.15` 经实测不生成 CSS（Tailwind 动态间距只接受 0.25 步长），故取 `h-4`。
- 视觉核对（tabbit，2026-11-17）：standalone 实例（真实 118 任务）+ team 实例（管理员）截图确认——看板/流动信号/注意力队列/Kanban/TaskCard/团队视角/归档索引（116 条 + 分页）/插件/任务详情对话框/创建任务/强制改密/偏好设置/团队管理六个 tab/登录页；文字无截断溢出、8px→10px 首字母缩写（FL/KY/YH/管）在 `size-4` 圆内正常、switch 16px 轨道正常。`ProjectOnboardingDialog` 与 `LiveSyncControlDialog` 需要桌面端 `tauriInvoke`，浏览器不可达，仅由构建产物与类等价保证。
- 控件尺度复核（对齐 `.trellis/spec/frontend/quality-guidelines.md` 的「控件尺度」表）：全量 diff 比对新增/删除的 `h-*`/`size-*`，**控件高度零漂移**（`h-[0.875rem]`→`h-3.5`=14px、`h-[1.0375rem]`→`h-4`=16px 为唯一 −0.6px 例外，`max-h-[12.25rem]`→`max-h-49`、`max-h-[13.75rem]`→`max-h-55` 为同一像素值）。`PreferencesDialog` 字体大小分段控件原本是 26px 内高（`h-[1.625rem]`）+ `p-[0.1875rem]` 的 32px 组合，改为外层 `h-8` + 内层 `h-6`（32px 外壳不变、内层落到 24px 刻度，与 `Tabs` 原语 `h-8`+`p-0.75` 同构），不再出现刻度表以外的 `h-6.5`。
- 控件文字下限复核：`text-2xs`(10px) 只落在徽章、元信息、侧栏导航行、Avatar 首字母与提示条上，没有落到 `Button`/`Input`/`Select` 文字上；`Button size="xs"` 已由 `text-[0.6875rem]`(11px) 提升到 `text-xs`(12px)，符合「控件文字不小于 text-xs」。
- 未改：`avatar.tsx` 的 `-space-x-2`（头像叠压语义，改 `-ml-*` 需改 DOM 契约）、`ring-[3px]`、`h-[calc(100%-1px)]`、`translate-x-[calc(100%-2px)]` 等几何类。
