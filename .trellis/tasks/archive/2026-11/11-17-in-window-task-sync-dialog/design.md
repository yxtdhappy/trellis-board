# 设计：控制事件内嵌化、Monaco diff、上传任务信息

## 1. 边界

| 层 | 职责 | 不碰 |
| --- | --- | --- |
| `packages/desktop/src-tauri`（Rust） | 事件发布、主窗口唤起、命令 Origin 校验、capability、差异标题与待上传元信息 | 同步数据面（上传/下载/冲突判定） |
| `packages/web`（Board 应用） | 弹窗 UI、Monaco diff、上传确认列表 | 服务端 API 字段 |
| `packages/server` | 不改 | — |

改造后控制弹窗运行在**服务端部署的 Board 页面**里（主窗口登录后 `main.rs:452` 导航到远端 Board），因此 Board 与客户端需同版本发布（见 §7 风险）。

## 2. 改造后的控制事件流

```
task_sync emit(Value)
  → AgentService::publish_control (agent_service.rs:317)
      hub.push_with_change(control)              // 去重/队列不变
      changed → notify_live_control()            // emit "live-control-changed"
      attention → focus_main_window()            // 替代 show_control()
  → Board LiveSyncControlDialog
      listen("live-control-changed") + focus/visibility + 10s 兜底
      invoke("live_control_pending") → 有事件则打开 <Dialog>
  → 用户操作 → invoke("live_control_decide"/"initial"/"dismiss")
      → hub pop → notify_live_control()
```

- `focus_suppressed` / `auto_focus_consumed` 语义保留，但只决定**是否拉起主窗口**；队列与事件本身不变。
- `dismiss` 仍从队列移除队首，页面下次轮询拿不到该事件，因此不会自动重开（无需额外抑制状态）。

## 3. Rust 修改点

### 3.1 命令与校验（`main.rs`）

| 命令 | 旧校验 | 新校验 | capability |
| --- | --- | --- | --- |
| `live_control_pending` | `ensure_local_caller` | `ensure_board_caller` | `allow-live-control-get` → `board-local-association` |
| `live_control_show` | `ensure_local_caller` | `ensure_board_caller`（修复 ProjectRail 调用被拒） | 已授权 |
| `live_control_decide` | `ensure_local_caller` | `ensure_board_caller` | `allow-live-control-decide` |
| `live_control_diff` | `ensure_local_caller` | `ensure_board_caller` | `allow-live-control-diff` |
| `live_control_initial` | `ensure_local_caller` | `ensure_board_caller` | `allow-live-control-initial` |
| `live_control_dismiss` | `ensure_local_caller` | `ensure_board_caller` | `allow-live-control-dismiss` |
| `live_control_resize` | `ensure_local_caller` | **删除**（命令 + 注册 + 权限） | 删除 `allow-live-control-resize` |

- `main.rs:882` 托盘「处理实时确认」→ `show_pending_control`：队列非空时 `focus_main_window` + `notify`，返回 `true`；队列空返回 `false`。
- `main.rs:1019-1027` `CloseRequested` 的 `live-control` 分支删除；`main.rs:972` window-state denylist 去掉 `live-control`。
- `tauri.conf.json:16-20` capabilities 去掉 `live-control`；删除 `capabilities/live-control.json`。
- `permissions/desktop.toml:98-131`：保留 5 个 live-control 权限定义（描述改为 Board 页面），删除 resize 权限。

### 3.2 窗口逻辑（`agent_service.rs`）

- 删除：`CONTROL_WINDOW`(33)、`CONTROL_WIDTH`、`CONTROL_MIN_HEIGHT`、`show_control()`(350-372)、`hide_control()`、`suppress_and_hide()`、`resize_control()`(45)。
- `publish_control`：`show_control()` 调用换成 `focus_main_window(&self.app)`；其余判定不变。
- `pending_control`(379-385)：只返回队首，不再隐藏窗口。
- `clear_control`(452-461)、`dismiss_control`(463-481)：删除 hide 分支，保留 hub 操作与 `notify_live_control`；`assignment_warning` 死分支随之删除。
- `show_pending_control`(434-444)：清 `focus_suppressed` 后 focus 主窗口 + notify，不创建窗口。
- `focus_main_window` 复用 `main.rs` 现有实现（show/unminimize/set_focus）。

### 3.3 差异标题（`agent/task_sync.rs`）

- `Difference::to_control`（204-223）增加 `"title"`：`task_title(local).or(task_title(server))`，两侧 `local`/`server` 对象也各带 `title`。
- `task_title` 已存在（474-487），无需新增解析。

### 3.4 待上传任务元信息（`agent/device.rs`）

- `LocalAssociation` 增加 `deferred_tasks: Vec<DeferredTaskInfo>`，`DeferredTaskInfo { task_dir: String, title: Option<String> }`，serde camelCase。
- `read_local_associations` 在算出 `deferred_task_dirs` 后，对每个目录读 `<binding.repo_path>/<task_dir>/task.json` 的 `title`（复用 JSON 解析思路）；读取失败或缺失 → `None`。保留 `deferred_task_dirs` 兼容旧 UI。
- 只读、无网络；单次最多 32 个目录（与队列上限无关，但 deferred 量级同阶），IO 成本可接受。

## 4. Board 侧弹窗

- 新增 `packages/web/src/desktop/LiveSyncControlDialog.tsx`：把 `ControlApp.tsx` 的状态机（event/loaded/busy/error/diff/choices/ownership + `createRefreshCoordinator` + listen/focus/visibility/10s 兜底 + 动作分发）原样迁移，渲染改为：
  - `Dialog` + `DialogContent`（宽 `sm:max-w-[min(72rem,92vw)]`，高 `max-h-[85vh]`）
  - `DialogHeader`（「团队实时同步」+ 标题 + 状态文案）
  - `DialogBody`（唯一滚动区：差异/摘要/归属列表/Monaco）
  - `DialogFooter`（`ActionBar` 动作按钮，替换原 `CardContent` 内联按钮）
- 挂载点：`packages/web/src/pages/board/BoardPage.tsx` 末尾（与 `TaskDetailDialog` 同级，已在 `app/providers.tsx` 的 `ConfirmDialogProvider` 内，可继续用 `useConfirm()`）。
- 可用性判定：`window.__TAURI__?.core?.invoke` 不存在 → 直接 `return null`；首次 `live_control_pending` 抛错（旧客户端无该命令）→ 记一次标记并停止轮询，不渲染、不弹 toast。
- 删除：`packages/web/src/desktop/ControlApp.tsx`、`packages/web/src/desktop/main-control.tsx`、`packages/web/desktop/control.html`；`vite.desktop.config.ts` 的 `control` input 删除（只留 `index`）。

## 5. Monaco 左右分栏

- 新增依赖：`monaco-editor`（`packages/web/package.json`）。Board 页面无 CSP 限制，worker 用 Vite 原生 `?worker` 导入。
- 新增 `packages/web/src/desktop/MonacoDiff.tsx`（仅在弹窗的「查看差异」路径动态 import）：
  - 模块顶部：`self.MonacoEnvironment = { getWorker: () => new EditorWorker() }`，`EditorWorker` 来自 `monaco-editor/esm/vs/editor/editor.worker?worker`。
  - 组件：`monaco.editor.createDiffEditor(container, { readOnly: true, originalEditable: false, renderSideBySide: true, automaticLayout: true, minimap: { enabled: false }, scrollBeyondLastLine: false })`，`setModel({ original: null, modified: null })` 后按文件 `setValue`；语言固定 `plaintext`（避免额外语言 worker）。
  - 主题：`document.documentElement.classList.contains('dark') ? 'vs-dark' : 'vs'`，监听 `appearance` 变化时 `monaco.editor.setTheme`。
  - 卸载时 `editor.dispose()`、model dispose。
- 文件切换：弹窗内文件列表（路径 + changedBy）单选，正文区域固定高度 `clamp(16rem, 55vh, 34rem)`。
- 回退：`React.lazy` 加载失败（catch）→ 渲染 `DiffFileFallback`（保留现有双 `<pre>` 逻辑），并提示「高级差异视图不可用，已回退文本对照」。
- 缺失侧：`original`/`modified` 用空字符串 + 文件头标注「该文件在对应版本中不存在」。

## 6. 上传任务信息展示（R3）

- ProjectRail（`ProjectRail.tsx:508-517`）：
  ```
  confirm({
    title: '上传本地任务？',
    description: (
      <div className="flex max-h-56 flex-col gap-1 overflow-auto">
        {association.deferredTasks.map(t => (
          <div>
            <p>{t.title || 目录名}</p>
            <p className="text-muted-foreground">{t.taskDir}</p>
          </div>
        ))}
        <p>将上传到 {branchName}，冲突时仍会要求确认。</p>
      </div>
    ),
    confirmText: '上传',
  })
  ```
- `confirm-dialog.tsx`：`description` 外层由 `<p className="whitespace-pre-line …">` 改为 `<div className="whitespace-pre-line text-xs/relaxed text-muted-foreground">`，现有纯文本调用不受影响；列表型内容自带间距。
- 同步确认弹窗：local-only 差异项在 `LiveSyncControlDialog` 里显示 `title`（新增字段）+ `taskDir`，与处理方式选择并列；`use-local` 即上传。
- 兼容：旧服务端/旧 Rust 返回无 `deferredTasks`/`title` 时，前端退回 `deferredTaskDirs` 与 `differenceTitle()`。

## 7. 兼容性、风险与回滚

| 组合 | 表现 | 处理 |
| --- | --- | --- |
| 新客户端 + 新 Board | 内嵌弹窗 | 目标形态 |
| 新 Board + 旧客户端 | 命令不存在 → 弹窗不渲染；旧客户端仍弹自己的独立窗 | 前端 catch，不报错 |
| 新客户端 + 旧 Board 页面 | 页面不监听事件 → 事件不可见（仅托盘可聚焦主窗口） | 已知风险：发布需客户端与 Board 同版本升级；不保留旧窗口兜底（方案 B 决策） |
| 浏览器打开 Board | 无 Tauri 上下文 | 直接不渲染 |
| 主窗口在本地登录页 | Agent 已停止 / 未登录 | 无事件 |
| 跨 Origin 网页 | `ensure_board_caller` 拒绝 | 保持拒绝 |

- 事件会强制拉起主窗口并抢焦点，与现独立窗行为等价（现窗同样 `set_focus`）。
- 回滚：单 PR；回滚 = 恢复 `control.html`/`ControlApp`/`live-control.json`/窗口代码。R3 数据字段为新增，Monaco 为纯前端增量，可独立回滚。

## 8. 验证

```powershell
yarn install
yarn build            # tsc -b && vite build（Board 产物含 Monaco chunk）
yarn build:desktop    # 本地登录页仍可构建
yarn test             # packages/*/test/*.test.js
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml
yarn format
```

手工：`yarn desktop:dev` 登录 → 制造任务文件冲突 → 主窗口内弹窗 + Monaco 左右 diff → 关闭后不再弹 → 托盘「处理实时确认」重开 → 分支行「上传本地任务」确认弹窗列出标题与目录。
