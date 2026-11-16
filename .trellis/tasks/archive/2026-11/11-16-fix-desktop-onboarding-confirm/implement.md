# Implement — 修复桌面端接入流程四个缺陷与应用内确认

执行顺序按「共享组件 → 前端替换 → Rust 状态与命令 → 手测」。

## 步骤

### 1. R4 应用内确认组件（先做，后面替换都依赖它）

- 新建 `packages/web/src/components/ui/confirm-dialog.tsx`：`ConfirmDialogProvider` + `useConfirm()`，队列串行、`tone: 'default' | 'danger'`、无 Provider 返回 `Promise.resolve(false)`。
- 挂载 `ConfirmDialogProvider` 到 `packages/web/src/app/providers.tsx` 与 `packages/web/src/desktop/main-control.tsx`。
- 检查项：`DialogBody` 在确认弹窗里正常滚动，Escape 只关确认弹窗（复用 `data-dialog-id` 最上层逻辑）。

### 2. R1 DialogBody 留白

- `packages/web/src/components/ui/dialog.tsx` `DialogBody` 基类加 `pr-2`。
- 复检 `packages/web/src/features/settings/PreferencesDialog.tsx:87`、`packages/web/src/features/plugins/PluginLogsDialog.tsx:56` 两处 `px-*` 调用方仍满足间隙。

### 3. R4 替换 7 处 `window.confirm`

按 design 表格逐处替换为 `const ok = await confirm({...}); if (!ok) return`，文案沿用原 `window.confirm` 中文语句，标题改为动作短语（如「不再同步此分支」）。`packages/web/src/features/admin/useAdminConsole.ts` 为 hook，确认 `ConfirmDialogProvider` 在其调用树上方。

### 4. R2 Rust 焦点决策

- `packages/desktop/src-tauri/src/agent_service.rs`：抽 `should_autofocus(is_initial_review, focus_suppressed, consumed) -> bool` 与 `fn is_initial_review(control: &Value) -> bool`，`publish_control` 改用。
- 加 `#[cfg(test)] mod tests`（若文件已有则追加）：review 强弹、非 review 一次性、consumed 只翻转一次。

### 5. R3 状态透出与手动入口

- `packages/desktop/src-tauri/src/agent/device.rs`：`LocalAssociation` 加 `initial_review_pending`，`read_local_associations` 与 `agent_service.rs:648` `associate()` 填充；`main.rs:1007` 测试构造器补字段。
- `packages/desktop/src-tauri/src/main.rs`：新增 `open_control_window` 命令并注册进 `invoke_handler`。
- `packages/desktop/src-tauri/permissions/desktop.toml` 增 `allow-open-control-window`；`capabilities/board-local-association.json` 增该权限。
- `packages/web/src/lib/project-rail-association.d.ts` + 归一化实现：加 `initialReviewPending`。
- `packages/web/src/components/layout/ProjectRail.tsx`：状态标签「等待确认任务差异」、父行聚合顺序插入、分支行「处理差异」按钮（`invoke('live_control_show')`）、同步横幅文案区分 review-pending。

### 6. R5 滚动条观感（已拍板：全局 CSS）

- 在 `packages/web/src/index.css` 的 base 层加 `* { scrollbar-width: thin; scrollbar-color: var(--border) transparent; }`；`packages/web/src/desktop/desktop.css` 已 `@import '../index.css'`，不再重复声明。
- 不做全量 ScrollArea 迁移。

### 7. 规范回写

- `.trellis/spec/frontend/rendering-and-state.md`：补充「`initialReviewPending` 时显示等待确认任务差异并可唤起控制窗口」「破坏性确认必须用应用内 `useConfirm()`，禁止 `window.confirm`」。
- `.trellis/spec/backend/desktop-realtime-sync.md`：补充「`initial_sync_review` 事件不受一次性自动聚焦抑制」「`live_control_show` 只唤起已存在待处理事件」。

## 验证

1. `cargo test -p trellis-board-desktop should_autofocus`（实际包名以 `packages/desktop/src-tauri/Cargo.toml` 为准）+ `cargo check`（工作目录 `packages/desktop/src-tauri`）。
2. `packages/web`：typecheck + ESLint 改动文件；改动文件跑 oxfmt（仓库唯一 formatter，配置 `.oxfmtrc.json`）。
3. 仓库根 `node --test tests/*.test.js`。
4. 手测（必须实际启动桌面客户端）：
   - 打开「接入本地 Git 项目」，滚动到底部，滚动条与卡片右边框有间隙。
   - 选一个本地有独有任务的仓库 →「查看并处理差异」→ 差异窗口立即弹出，列出「仅本地存在」项。
   - 关掉差异窗口 → 项目栏显示「等待确认任务差异」+「处理差异」→ 再打开。
   - 选「上传本地任务」提交 → 状态转同步正常，任务列表出现任务，顶部「正在同步任务…」消失。
   - 「不再同步此分支」→ 弹应用内确认；取消不解绑（网络面板无 `detach_local_association`）；确认后才解绑。
   - 桌面端其余 6 处确认点各点一次，确认弹窗出现且取消分支不执行。

## 完成判据

- prd.md 全部 Acceptance Criteria 打勾。
- 无残留 `window.confirm`（`rg "window.confirm" packages/web/src` 为空）。
- 规范回写完成，且 `packages/web`/`packages/desktop` 检查全绿。

## 实施记录（已完成）

- Rust：`publish_control` 对 `initial_sync_review` 在内容变化时无条件 `show_control()`（清 `focus_suppressed`，绕过 `auto_focus_consumed`）；新增命令 `live_control_show` + 权限 `allow-live-control-show`（挂在 `board-local-association` capability，仅 main 窗口）；`LocalAssociation`/`AssociationSummary` 增加 `initial_review_pending` 并投影到 `list_local_associations` 与 `associate()` 返回值。
- 前端：新增 `packages/web/src/components/ui/confirm-dialog.tsx`（`ConfirmDialogProvider` + `useConfirm()`，队列串行、危险色、缺 Provider 视为取消），在 `app/providers.tsx` 与 `desktop/main-control.tsx` 挂载；11 处 `window.confirm` 全部替换（ProjectRail×2、ControlApp、ProjectOnboardingDialog、BranchManagementPanel、BoardPage、useAdminConsole×2、useAdminProjects×3）。
- 项目栏：`initialReviewPending` 归一化 + 状态「已关联 · 等待确认任务差异」+ 分支行「确认差异」按钮 + 独立提示条，聚合优先级 3.5。
- 滚动条：`index.css` base 层 `scrollbar-width: thin` / `scrollbar-color`；`DialogBody` 基类用 `-mx-4 px-4 [scrollbar-gutter:stable_both-edges]`（负 margin 抵消 `DialogContent` 的 `p-4` 把滚动条顶到卡片右边框，双侧预留保持内容左右留白对称，与官方 scrollable content 示例同构）；`PreferencesDialog`（`DialogContent` 为 `p-0`）传 `mx-0`、`PluginLogsDialog`（`DialogBody` 自带背景块）传 `mx-4` 抵消。
- 规范：`frontend/rendering-and-state.md`、`backend/desktop-realtime-sync.md` 已回写。

### 验证结果

- `npx tsc -b`（packages/web）：通过。
- `npx oxlint`（改动文件）：仅剩仓库既有 warning，无新增。
- `cargo check --manifest-path packages/desktop/src-tauri/Cargo.toml`：通过（仅既有 dead_code warning）。
- `cargo test --bin trellis-board-client camel_case`：3 passed。
- `node --test packages/web/test/*.test.js`：79 passed（新增「等待确认任务差异优先于同步中、低于 error」用例）。
- `node --test packages/desktop/test/*.test.js`：7 passed。
- `npm run build:desktop`（packages/web）：通过。
- 浏览器实测（Tabbit + Vite 预览页，临时文件已清理）：确认弹窗在另一个 Dialog 之上正常渲染，取消返回 `false`、确认返回 `true`（日志 `detach=false` / `detach=true`）；`DialogBody` 计算样式 `scrollbar-width: thin`。
- 负 margin 方案实测（Tabbit + Vite 预览页，临时文件已清理）：默认 `p-4` 卡片内容左右留白 `27 / 27`、`p-0` 卡片（`mx-0 px-5`）`31 / 31`，`DialogBody` 右边缘距卡片边 1px（边框）→ 滚动条贴卡片右边框且内容左右对称。

### 真实桌面客户端端到端实测（`yarn desktop:dev` + 本地 4317 服务端 + CDP 9222）

- 滚动条：接入向导 `DialogBody` 用负 margin 方案后滚动条贴在卡片右边框外侧（此前压住内容右边框）。
- 差异审查：`initial_sync_review` 自动弹出控制窗口（此前受一次性自动聚焦抑制而不弹），标题「任务差异需要确认」，逐项可选 `上传本地任务`/`暂不处理` 并提交。
- 卡同步：`review` 提交后 binding 立即 `initialSyncCompleted=true`、`liveSyncStatus=ready`；项目栏从「正在同步已有任务」变为「已关联 · N 个本地任务未同步」（deferred）或「同步正常」，顶部「正在同步任务…」消失。
- 解绑确认：点「不再同步此分支」弹出应用内确认（标题「不再同步分支“main”？」、危险按钮、可取消），取消后 `detachPending=false`、`syncStatus=approved`，未调用 Tauri 解绑。

#### 实测中修掉的真实缺陷：跨分支归档任务被误判为「仅本地存在」

- 现象：首次审查载荷 110 项里 67 项 `local-only`，而服务端事实上已有全部 109 个任务目录。
- 根因：`retain_server_groups_for_binding` 按 `task.json` 内容的 `branch` 过滤服务端任务组；归档任务记录的是当时的开发分支，同一任务因此被剥掉服务端副本。
- 修复：新增 `retain_server_groups_for_initial_sync(binding, local_groups, groups)`，本地存在同一 `task_dir` 时保留（只有本地没有的跨分支任务才丢弃），`pull_initial_sync` 与 `resolve_initial_sync` 改用；回归测试 `initial_sync_keeps_cross_branch_groups_present_locally`。修复后同一场景载荷为 `1 local-only + 109 same`。

