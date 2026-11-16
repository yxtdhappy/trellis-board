# 修复桌面端接入流程四个缺陷与应用内确认

## Goal

桌面客户端（Tauri）首次接入本地 Git 项目时，四个用户可见缺陷全部修好：对话框滚动条压住内容右边框、「查看并处理差异」看不到差异却直接进入同步、接入后永久卡在「正在同步已有任务」且任务列表为空、「不再同步此分支」不弹确认。同时把全仓 7 处 `window.confirm` 换成应用内确认弹窗，因为 `tauri-plugin-dialog` 已覆盖 `window.confirm` 且其命令在当前版本不存在，调用永远不弹窗、取值是 Promise 恒真。

## Requirements

### R1 对话框滚动条不再遮挡内容

- 「接入本地 Git 项目」以及所有使用 `DialogBody` 的弹窗，滚动条与内容之间必须留出可见间隙，内容右边框不被滚动条压住。
- 修复点必须在 `packages/web/src/components/ui/dialog.tsx` 的 `DialogBody` 基类，一次覆盖全部 17 个调用方；不得逐个弹窗打补丁。
- 允许使用 `cn`（tailwind-merge）后仍生效的方式，或确认调用方自带横向 padding 已足够。

### R2 「查看并处理差异」必须真实展示差异

- 向导选择「查看并处理差异」后，用户必须立刻看到差异审查界面；不允许出现「点了按钮什么都没发生」。
- 差异审查界面的粒度与决策项沿用现有 `packages/web/src/desktop/ControlApp.tsx`（服务端 / 本地 / 仅存副本 / 暂不处理），不得重复实现第二套。
- 根因约束：`packages/desktop/src-tauri/src/agent_service.rs` 的 `publish_control` 只在 `!focus_suppressed && !auto_focus_consumed.swap(true)` 时自动弹窗，即整个进程只允许自动弹一次，且用户关过一次后永久抑制。这条抑制规则不能让首次同步审查被吞掉。

### R3 接入后不得卡在「正在同步已有任务」

- 处于 `initial_review_pending` 时，主窗口（`packages/web/src/components/layout/ProjectRail.tsx`）必须显示「等待确认任务差异」而不是「正在同步已有任务」，并给出手动入口（打开差异审查窗口）。
- 关闭差异窗口后用户仍能从项目栏重新打开；不得依赖托盘菜单作为唯一入口。
- `safe` 模式完成后若有延后目录，必须按既有规范显示「N 个本地任务未同步」，不得显示「同步正常」。

### R4 解绑与覆盖类操作必须应用内二次确认

- 新增共享确认组件（基于现有 `packages/web/src/components/ui/dialog.tsx` 原语，不引入新依赖），供主窗口与 `control.html` 两个入口使用。
- 替换全部 7 处 `window.confirm`：`packages/web/src/desktop/ControlApp.tsx:336`、`packages/web/src/features/board/dialogs/ProjectOnboardingDialog.tsx:500`、`packages/web/src/features/admin/BranchManagementPanel.tsx:125`、`packages/web/src/features/admin/useAdminConsole.ts:253` 与 `:284`、`packages/web/src/pages/board/BoardPage.tsx:303`、`packages/web/src/components/layout/ProjectRail.tsx:497` 与 `:530`。
- 取消确认必须不触发任何 Tauri 调用（对齐 `.trellis/spec/frontend/rendering-and-state.md` 解绑矩阵「解绑二次确认取消 | 不调用 Tauri」）。

### R5 滚动条观感统一（已拍板：全局两行 CSS）

- 用户决定：采用全局 CSS（`scrollbar-width: thin` + `scrollbar-color: var(--border) transparent`），不改 DOM，不动 8 个原生滚动容器。
- 目标：页面内原生滚动条观感接近 shadcn `ScrollArea`（细条、圆角、`bg-border` 色）。
- 明确不做：17 个 `DialogBody` 与 8 个原生滚动容器全量替换为 Base UI `ScrollArea`。

## Constraints

- 不引入新依赖；`packages/web` 无 Radix，滚动条组件为 `@base-ui/react/scroll-area`。
- 不新增第二套确认 UI 约定，复用 `dialog.tsx` 的 Dialog/DialogBody/DialogFooter。
- `safe` / `review` / `bootstrap` 的语义与 binding 契约不变（见 `.trellis/spec/backend/desktop-realtime-sync.md`）：`review` 有差异时只展示审查事件、不装 watcher、不推进 cursor。
- 不触碰 in_progress 任务 `11-16-yarn3-packages-jenkins-deploy` 的改动面（yarn 3 / packages 迁移）。

## Acceptance Criteria

- [x] 打开「接入本地 Git 项目」弹窗滚到底部，滚动条与 Agent 卡片右边框之间有可见间隙，无遮挡。
- [ ] 对存在差异的项目点「查看并处理差异」，差异审查窗口立即可见，且列出每个差异任务的类型与决策选项。
- [ ] 在差异审查窗口点「暂不处理」关闭后，项目栏该分支显示「等待确认任务差异」，点击可重新打开审查窗口。
- [ ] 完成审查后 `live_sync_status` 变为 `ready`，任务列表展示同步到本地的任务，「正在同步任务…」提示消失。
- [ ] 点「不再同步此分支」先出现应用内确认弹窗；点取消不调用 `detach_local_association`；点确认才解绑。
- [ ] 其余 6 处覆盖类操作在桌面端都能真实弹窗并正确区分确认/取消。
- [x] `packages/web` typecheck、lint 通过；`packages/desktop` `cargo check` 通过；新增的纯逻辑单元测试（控制焦点决策、确认流）通过。

## Out of Scope

- 云端/服务端任务同步协议改动。
- 向导 UI 重做、差异合并算法改动。
- 除 R5 决定外的滚动容器全量迁移。

## 状态说明（2026-11-16）

已勾选项通过浏览器实测与检查命令确认；未勾选项需要启动真实桌面客户端（登录服务端 + 本地 Git 仓库）手测：
差异窗口强制弹出、审查完成后状态转 ready、其余 6 处确认点在桌面端逐个点击。
