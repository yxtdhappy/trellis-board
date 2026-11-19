# 实施计划：首同步复用接入后的归属范围 + 稍后处理生效 + 弹窗显示项目 + 自动提示改系统通知

## 前置

- PRD 与设计已确认：见同目录 `prd.md`、`design.md`。
- 只在客户端做修改，服务端 `packages/server/team/*` 不动。

## 实施步骤

1. **新增 helper**：`packages/desktop/src-tauri/src/agent/task_sync/initial_sync.rs`
   - 新增 `async fn mark_invisible_local_dirs(&self, binding: &AgentBinding, local_groups: &mut Vec<SnapshotGroup>) -> AgentResult<()>`。
   - 对每个非归档 `task_dir` 调 `self.fetch_directory(&binding.task_space_id, &task_dir).await`：
     - `is_foreign_task_error` → `self.control_assignee(...)` + `self.mark_readonly_dir(..., &readonly_reason("FOREIGN_OWNER", &assignee))`，记 `crate::logging::warn("跳过他人任务目录（只读镜像）：{task_dir}")`，从 `local_groups` 移除。
     - `is_archived_task_error` → 从 `local_groups` 移除。
     - `Err` 且 `status == Some(404)` → 保留。
     - 其他 `Err` → 原样返回错误（不吞差异）。
   - 复用 `errors.rs:96 is_foreign_task_error`、`errors.rs:104 is_archived_task_error`、`ownership_inbox.rs:294 mark_readonly_dir`、`ownership_inbox.rs:325 control_assignee`。

2. **接入首同步**：`initial_sync.rs:239-262 pull_initial_sync`
   - 在 `local_groups` 之后、`retain_server_groups_for_initial_sync` / `classify_task_snapshots` 之前调用 helper。
   - 保留 `hide_control_tombstone_local_only` 现状，不重复过滤。

3. **覆盖全部首同步入口**：确认 `initial_sync.rs:38`、`:159`、`:377`、`:646` 四处 `classify_task_snapshots` 所在路径（首同步重试、修订守卫、状态回放）是否也需要同一闸门；需要则在各自分类前调用同一个 helper，禁止复制逻辑。

4. **行为收尾检查**
   - `review` 分支：`actionable` 为空时不再 `emit_differences`，继续走后续收尾，确保 `initialSyncCompleted` 与 cursor 写入发生。
   - `initial_sync_mode` 的三种模式语义不变，`safe` 分支仍只下载 `ServerOnly`。

5. **「稍后处理」记忆**：`packages/desktop/src-tauri/src/agent/control.rs`
   - 新增 `struct DismissedReview { signature: String, payload: Value }` 与 `ControlHub` 字段。
   - `review_signature(control)`：`taskSpaceId` + 排序后的 `differences` 结构化字段，忽略 `revision`。
   - `dismiss_with_change()`：pop 后若为 `initial_sync_review` 则记录签名 + payload。
   - `push_with_change()`：同签名的 `initial_sync_review` 直接返回 `(false, false)`；签名不同则清空记忆后走原逻辑。
   - 新增 `reveal_dismissed() -> bool`：把 payload 放回队列并清空记忆。

6. **接线**：`packages/desktop/src-tauri/src/agent_service.rs`
   - `show_pending_control`（:384-396）：先 `reveal_dismissed()`，再原有 focus + notify（用户主动点击，保留聚焦）。
   - `clear_control`（:394-400）：清空记忆，避免压制完成后的后续差异。
   - `publish_control`（:305-322）：去掉两处 `focus_main_window`，改为 `self.notify_control(&control)`（见步骤 11-12）。

7. **控制队列测试**：`packages/desktop/src-tauri/src/agent/control/tests.rs`
   - dismiss 后同内容（`revision` +1）push → 队列为空、`changed=false`。
   - dismiss 后差异集合变化 push → 入队、`changed=true`。
   - `reveal_dismissed` 后 `pending()` 为 `Some`，且再次 dismiss 可重复生效。
   - `clear_control` 后不残留压制。

8. **首同步测试**：`packages/desktop/src-tauri/src/agent/task_sync/tests/`
   - 403 场景：他人任务目录被移出差异、写入 `readonly_task_dirs`（`FOREIGN_OWNER:*`）、`pendingReview=false`。
   - 409 场景：归档残留目录不出现在差异里。
   - 404 场景：真实本地新增任务仍是 `LocalOnly` 且 `pendingReview=true`。
   - 混合场景：一个他人目录 + 一个真实本地任务 → 只剩一条差异。
   - 失败场景：`/files` 返回 500 时错误上抛，`readonly_task_dirs` 不被写入。

9. **首同步事件补项目信息**：`packages/desktop/src-tauri/src/agent/task_sync/initial_sync.rs:420-428 emit_differences`
   - 事件里加 `projectName = binding.display_name`、`branchName = binding.branch_name`（与 `errors.rs:9-24 task_sync_error_event` 同口径）。
   - 只在 `emit_differences` 一处加，保证所有首同步入口统一；不改 `differences` 结构。

10. **弹窗渲染项目与分支**：`packages/web/src/desktop/LiveSyncControlDialog.tsx`
   - `ControlEvent` 的 `initial_sync_review` 分支加 `projectName?: string; branchName?: string`。
   - 在 `DialogHeader` 的 `message` 之后插一行小字：`项目：{projectName}` + ` · 分支：{branchName}`（各自缺失则不显示），仅 `initial_sync_review` 且 `projectName` 存在时渲染；紧凑态 `<dl>` 的「任务空间」保持不动。
   - 这样紧凑态与展开态都带项目信息，不需要两处维护。

11. **通知文案纯函数**：`packages/desktop/src-tauri/src/agent_service.rs`（或同文件 `mod tests`）
    - `fn control_notification(control: &Value) -> (String, String)`：按 `control["type"]` 分支生成标题/正文；`projectName`/`branchName` 缺失时不拼该片段；review 与 ownership 的条目数取 `differences` / `items` 数组长度。
    - 单测放 `agent_service.rs` 的 `#[cfg(test)] mod tests`：五个类型各一条断言，外加一条「缺 projectName 时不出现空括号」。

12. **发系统通知替代聚焦**：`packages/desktop/src-tauri/src/agent_service.rs:305-322`
    - 新增 `fn notify_control(&self, control: &Value)`：先按档位判定 `match crate::appearance::load().notify_mode.as_str() { "never" => return, "unfocused" if self.window_focused() => return, _ => {} }`；再 `let (title, body) = control_notification(control);` → `self.app.notification().builder().title(title).body(body).show()`，失败 `logging::warn("发送同步通知失败：{error}")`（与 `update.rs:204-220` 同风格）。文件顶部加 `use tauri_plugin_notification::NotificationExt;`。
    - 新增 `fn window_focused(&self) -> bool`：`self.app.get_webview_window("main").and_then(|window| window.is_focused().ok()).unwrap_or(false)`（`Err`/无窗口按未聚焦处理）。
    - `publish_control` 中：`if review { if changed { self.notify_control(&control); } return; }`，以及 `if !self.auto_focus_consumed.swap(true, SeqCst) { self.notify_control(&control); }`。字段可改名 `auto_notify_consumed`，语义变为「本进程已发过一条非 review 通知」。
    - 不动 `show_pending_control` 里的 `focus_main_window`（用户主动入口）。

13. **避免点同步通知误开更新对话框**：`packages/desktop/src-tauri/src/update.rs:133-141`
    - `on_action` 闭包内改为：`crate::focus_main_window(&handle); if !status(&handle).update_available { return; } let _ = handle.emit("update-open-dialog", ());`（`status` 已在本文件定义，返回 `UpdateStatus { update_available, .. }`）。

14. **点击通知回窗口**：`packages/desktop/src-tauri/src/main.rs`
    - 在 `tauri_plugin_notification::init()` 之后、setup 阶段无条件注册：`let handle = app.handle().clone(); if let Err(error) = app.notification().on_action(move |action| { if action.action_id() == "tap" { crate::focus_main_window(&handle) } }) { logging::warn(&format!("无法注册系统通知点击处理：{error}")) }`。该 handler 与 `update.rs` 的 handler 并存（插件支持多个），保证未配置更新服务器时点同步通知也能回窗口。
    - 顶部按需 `use tauri_plugin_notification::NotificationExt;`。

15. **同步通知三档偏好落盘**：`packages/desktop/src-tauri/src/appearance.rs` + `main.rs:319-332`
    - `Appearance` 加 `pub notify_mode: String`（`#[serde(default)]`）；常量 `NOTIFY_MODES: [&str; 3] = ["never", "unfocused", "always"]`、`DEFAULT_NOTIFY_MODE: &str = "always"`；`Default` 用默认值，`normalised()` 过滤非法值回退 `always`。
    - `appearance/tests.rs`：旧文件（只有 `theme`/`fontSize`）读出 `notify_mode == "always"`；写入 `"never"` 后读回 `never`；写入 `"always "` / `"bogus"` 归一为 `always`。
    - `appearance_save` 命令签名加 `notify_mode: Option<String>`：先 `let existing = appearance::load();`，再 `notify_mode: notify_mode.unwrap_or(existing.notify_mode)`，保证旧 Web 包不带该参数时不丢设置。

16. **偏好设置 UI**：`packages/web/src/lib/appearance.js`、`appearance.d.ts`、`app/src/theme.tsx`、`features/settings/PreferencesDialog.tsx`
    - `appearance.js` 加 `NOTIFY_MODES = ['never', 'unfocused', 'always']`、`DEFAULT_NOTIFY_MODE = 'always'`、`NOTIFY_MODE_STORAGE_KEY = 'trellis-notify-mode'`、`normalizeNotifyMode(value)`。
    - `appearance.d.ts` 与 provider：`notifyMode: NotifyMode`、`setNotifyMode(next: NotifyMode)`；`readDesktopAppearance` 读 `notifyMode`；`appearance_save` 调用带上该字段；`resetAppearance` 复位为默认。
    - `PreferencesDialog.tsx` 在「字体大小」区块后加「同步通知」section：`ToggleGroup` 三选项 `NOTIFY_CHOICES = [{never:'从不'},{unfocused:'仅在未聚焦时'},{always:'始终'}]`（与主题同一 `grid grid-cols-3` 写法），下方一行说明「仅影响系统通知；应用内的差异弹窗和任务列表不受影响。」

## 验证命令

```powershell
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml task_sync
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml
yarn test
yarn workspace @trellis-board/web build
yarn workspace @trellis-board/web lint
```

现场回归（可选手工）：

```powershell
# 1. 记录改动前状态
Get-Content "$env:LOCALAPPDATA\TrellisBoard\data\agent\live-cursors.json"
# 2. 重启客户端并触发首同步
# 3. 断言：config.json initialSyncCompleted=true / lastSyncedAt 非空；
#    live-cursors.json 出现 3536a478-4b1b-4b3b-a8f0-42903482d33d 的 revision；
#    UI 不再弹「任务差异需要确认」
```

## 评审关卡

- 步骤 1 完成 → 自查 helper 的 4 条错误分支与日志内容，再进入步骤 2。
- 步骤 3 完成 → 确认四个分类入口行为一致（不允许某入口仍把他人目录当差异）。
- 步骤 10 完成 → 打开弹窗确认紧凑态/展开态都显示项目名与分支，且 `projectName` 为空时回退 UUID 不空白。
- 步骤 12 完成 → 全局搜 `focus_main_window`，确认只剩用户主动入口（`show_pending_control`）与托盘/单实例/更新三处。
- 步骤 13 完成 → 在无可用更新的情况下点通知，确认不会打开「更新」对话框。
- 步骤 15 完成 → `cargo test appearance` 通过；手工改 `appearance.json` 删掉 `notifyWhenUnfocused` 后重启，开关仍为关闭态且不报错。
- 步骤 16 完成 → 打开偏好设置切换开关，重启客户端确认值仍在；`yarn workspace @trellis-board/web build` 与 lint 通过。
- 测试通过后 → 汇总改动范围与验证结果，等用户确认后再提交。

## 回滚点

- 步骤 2 之后任何问题：移除 helper 调用即回到原行为，无数据迁移。
- 若现场已写入错误 `readonly_task_dirs`：通过重新接入/重置 cursor 清理，不涉及服务端数据。
