# Design — 修复桌面端接入流程四个缺陷与应用内确认

## 根因汇总

| # | 现象 | 根因 | 修复层 |
|---|---|---|---|
| R1 | 弹窗滚动条压住内容右边框 | `DialogBody` 基类 `min-h-0 flex-1 overflow-y-auto overscroll-contain` 横向零 padding，经典滚动条轨道与内容边框零间距 | `packages/web/src/components/ui/dialog.tsx` |
| R2 | 「查看并处理差异」不显示差异 | `AgentService::publish_control` 仅在 `!focus_suppressed && !auto_focus_consumed.swap(true)` 时 `show_control()`，`initial_sync_review` 事件被一次性抑制吞掉；向导 `associate('review')` 后立即关闭窗口，无二次入口 | `packages/desktop/src-tauri/src/agent_service.rs` |
| R3 | 永久卡在「正在同步已有任务」 | 同 R2 的后果：`pull_initial_sync` 的 review 分支不写 cursor、不 `complete_initial_sync`，binding 永久 `live_sync_status="syncing"`；且 `LocalAssociation` 不暴露 `initial_review_pending`，主窗口只能显示 syncing、无手动入口 | 同 R2 + `packages/desktop/src-tauri/src/agent/device.rs`、`packages/web/src/components/layout/ProjectRail.tsx` |
| R4 | 确认弹窗不出现 | `tauri-plugin-dialog` 覆盖 `window.confirm`，其 `plugin:dialog|confirm` 命令在 2.7.0 已移除 → 返回 rejected Promise（同步代码视为真值） | 新增 `packages/web/src/components/ui/confirm-dialog.tsx` + 7 处替换 |
| R5 | 滚动条观感与 ScrollArea 不一致 | 原生滚动条走 OS/WebView 默认样式 | `packages/web/src/index.css` 全局两行 |

## R1 对话框滚动条留白

改 `packages/web/src/components/ui/dialog.tsx` 的 `DialogBody` 基类，追加右侧内边距：

```
cn('min-h-0 flex-1 overflow-y-auto overscroll-contain pr-2', className)
```

- `cn`（= clsx + tailwind-merge）会做冲突消解：调用方传 `px-*` 时基类 `pr-2` 被覆盖，但只有 `PreferencesDialog`（`px-5`=20px）、`PluginLogsDialog`（`px-3`=12px）两处传横向 padding，均 > 8px，仍满足间隙要求；其余 15 处无横向 padding，由基类生效。
- 不在 `DialogContent` 上加 padding：那是 `p-4` 的容器，滚动条与内容都在其内部，改它不会把滚动条推离内容。

## R2 首次同步审查不再被焦点抑制吞掉

`packages/desktop/src-tauri/src/agent_service.rs`：

```rust
fn should_autofocus(is_initial_review: bool, focus_suppressed: bool, consumed: &AtomicBool) -> bool {
    if is_initial_review {
        return true;              // 用户刚在向导里明确要求看差异，强制展示
    }
    !focus_suppressed && !consumed.swap(true, Ordering::SeqCst)
}
```

- `publish_control` 用 `is_initial_review(control)`（`control["type"] == "initial_sync_review"`）替换现有 `first` 表达式。
- 语义：`initial_sync_review` 每次进队都弹（含 bootstrap 回退重入 review 的场景）；其它控制事件仍保持「整个进程只自动弹一次、用户关过就不再打扰」的既有行为。
- 单元测试放 `agent_service.rs` 的 `mod tests`：覆盖 `initial_review` 在 `focus_suppressed=true` 且 consumed=true 时仍返回 true；非 review 在两种抑制下返回 false 且 consumed 只翻转一次。

## R3 主窗口暴露「等待确认任务差异」+ 手动入口

1. `packages/desktop/src-tauri/src/agent/device.rs`
   - `LocalAssociation` 增 `#[serde(default)] pub initial_review_pending: bool`。
   - `read_local_associations` 填 `initial_review_pending: binding.initial_review_pending`（构造点在 `device.rs:874` 一带，`binding` 逐字段移动，注意移动顺序）。
   - `agent_service.rs:648` `associate()` 返回的 `LocalAssociation` 置 `initial_review_pending: initial_mode == "review"`；`main.rs:1007` 测试构造器补字段。
2. 新增 Tauri 命令 `open_control_window`（`main.rs`），内部 `ensure_local_caller` + `agent_service::show_pending_control(&app)`（该函数已会把 `focus_suppressed` 置 false 并 show 窗口；无待办返回 false 不改状态）。
   - `packages/desktop/src-tauri/permissions/desktop.toml` 增 `allow-open-control-window`（`commands.allow = ["open_control_window"]`，描述限定「当前 Board origin 只能唤起已存在待处理事件的本地控制窗口」）。
   - `packages/desktop/src-tauri/capabilities/board-local-association.json` 的 `permissions` 增 `allow-open-control-window`。
3. `packages/web/src/lib/project-rail-association.d.ts` + 其归一化实现：`ProjectRailAssociation` 增 `initialReviewPending: boolean`，从 `row.initial_review_pending` 读。
4. `packages/web/src/components/layout/ProjectRail.tsx`
   - 分支状态标签：`initialReviewPending` 优先于 `liveSyncStatus`，显示「等待确认任务差异」；父行聚合顺序改为 关联失效 → error → 等待确认 → syncing → deferred → pending → ready。
   - 分支行在该状态下给出「处理差异」按钮，`invoke('open_control_window')`；`invoke` 不可用（浏览器）时不渲染按钮。
   - 现有 `syncingAssociations` 橙色提示「正在同步任务…」排除 review-pending 的分支（对这类分支提示改为「有任务差异待确认」），避免与真实状态矛盾。
5. 完成后主窗刷新：`complete_initial_sync` 已 `notify_state_changed`，`ProjectRail` 走既有 `desktop-state-changed` 订阅，无需新增通道。

## R4 应用内确认组件

新增 `packages/web/src/components/ui/confirm-dialog.tsx`，复用 `dialog.tsx` 原语：

```ts
type ConfirmOptions = {
  title: string
  description?: ReactNode
  confirmText?: string   // 默认「确认」
  cancelText?: string    // 默认「取消」
  tone?: 'default' | 'danger'
}
type Confirm = (options: ConfirmOptions) => Promise<boolean>
```

- `ConfirmDialogProvider` 内部维护 `{options, resolve}` 单槽状态；新请求入队串行（复用同槽会覆盖 → 用数组队列，前一个 resolve 后弹下一个）。
- `useConfirm()` 读取 context；无 Provider 时返回 `Promise.resolve(false)`（视为取消，不会误触发破坏性操作），加 `ponytail:` 注释说明。
- 组件渲染 `Dialog` + `DialogContent` + `DialogBody` + `DialogFooter`：取消按钮 `variant="outline"`，确认按钮 `tone==='danger' ? variant="destructive" : 默认`；关闭/Escape/取消都 resolve(false)。
- 挂载点：`packages/web/src/app/providers.tsx`（覆盖 board/admin/login）与 `packages/web/src/desktop/main-control.tsx`（control 窗口独立入口，仅 `AppearanceProvider`）。

替换清单（每处 `window.confirm` → `await confirm({...})`，取消分支保持 `return`/不调用 invoke）：

| 文件 | 行为 |
|---|---|
| `packages/web/src/desktop/ControlApp.tsx:336` | 覆盖服务端任务，danger |
| `packages/web/src/features/board/dialogs/ProjectOnboardingDialog.tsx:500` | 替换已有分支，danger |
| `packages/web/src/features/admin/BranchManagementPanel.tsx:125` | 分支解绑/删除，danger |
| `packages/web/src/features/admin/useAdminConsole.ts:253` | 管理员破坏性操作 |
| `packages/web/src/features/admin/useAdminConsole.ts:284` | 管理员破坏性操作 |
| `packages/web/src/pages/board/BoardPage.tsx:303` | 任务删除/归档类操作 |
| `packages/web/src/components/layout/ProjectRail.tsx:497` 与 `:530` | 解绑关联，danger |

`ProjectRail.detachAssociation` 保持现有前置守卫（`!invoke || detachingTaskSpace` → return），确认放守卫之后、`invoke('detach_local_association')` 之前。

## R5 滚动条观感（已拍板：全局 CSS）

`packages/web/src/index.css` 加

```css
@layer base {
  * { scrollbar-width: thin; scrollbar-color: var(--border) transparent; }
}
```

- 已确认 `packages/web/src/desktop/desktop.css` 首行是 `@import '../index.css'`，因此控制窗口同样生效，无需重复声明。
- 覆盖全部原生滚动容器（含 `DropdownMenu` 内列表），无 DOM 改动、无布局回归；WebView2（Chromium 121+）支持。
- 明确不做：17 个 `DialogBody` + 8 个原生滚动容器全量替换为 `@base-ui/react/scroll-area`（DOM 层级与 flex 布局全面变更，回归面覆盖全部弹窗与看板，收益只是外观）。

## 风险与取舍

- R2 强制弹窗对「用户已手动关闭控制窗口」的场景会再次弹出。取舍：首次同步审查是用户主动发起的流程，静默失败代价（永久卡同步）远大于一次打扰；非 review 事件仍遵守一次性抑制。
- R3 新增 `open_control_window` 命令扩大远程 Board origin 的能力面，描述与实现都限定为「仅唤起已存在待处理事件的窗口」，且 `ensure_local_caller` 保留。
- `DialogBody` 加 `pr-2` 会让 15 个无横向 padding 的弹窗内容整体收窄 8px，视觉上等价于原 p-4 变 p-4/pr-6，属可接受代价。
- R4 不引入 `AlertDialog`（仓库无 Radix），避免第二套 Dialog 约定。

## 验证

- `packages/desktop`：`cargo test should_autofocus`（新增单测）+ `cargo check`。
- `packages/web`：`tsc --noEmit`（typecheck）+ ESLint 改动文件 + Prettier(oxfmt) 格式化。
- 仓库级：`node --test tests/*.test.js`（含 `packages/desktop/test/desktop-ui-build.test.js` 的 CSP/构建断言）。
- 手测：桌面客户端接入 `C:/projects/trellis-board`（存在本地独有任务）→ 选「查看并处理差异」→ 差异窗口立即出现 → 选择上传本地任务 → 任务列表出现该任务、状态转「同步正常」；关窗后从项目栏「处理差异」重新打开；「不再同步此分支」确认弹窗取消/确认两条路径。
