# 实施计划

## 前置

- 新增依赖：`yarn workspace @trellis-board/web add monaco-editor`（需要联网；只进 Board bundle 的懒加载 chunk）。
- 分支：从 `main` 拉工作分支（如 `feat/in-window-task-sync-dialog`）；本任务目录随工作提交一起入库。

## 步骤

### 1. Rust：移除独立控制窗，改为主窗口唤起

文件：`packages/desktop/src-tauri/src/main.rs`、`packages/desktop/src-tauri/src/agent_service.rs`、`packages/desktop/src-tauri/src/agent/control.rs`（仅清理无窗口相关部分，队列算法不动）。

- [ ] `main.rs`：`live_control_pending/show/decide/diff/initial/dismiss` 的 `ensure_local_caller` 改为 `ensure_board_caller(&app, &window)?`；`show` 保持返回 `bool`。
- [ ] `main.rs`：删除 `live_control_resize` 命令、`invoke_handler` 注册项；`agent_service.rs` 删除 `resize_control`（:45）。
- [ ] `agent_service.rs`：删除 `CONTROL_WINDOW`/`CONTROL_WIDTH`/`CONTROL_MIN_HEIGHT`、`show_control`、`hide_control`、`suppress_and_hide`。
- [ ] `agent_service.rs::publish_control`：`show_control()` → `focus_main_window(&self.app)`；保留 `focus_suppressed`/`auto_focus_consumed` 判定。
- [ ] `agent_service.rs`：`pending_control`/`clear_control`/`dismiss_control` 去掉 hide 逻辑；`dismiss_control` 中 `assignment_warning` 死分支删除。
- [ ] `agent_service.rs::show_pending_control`：队列非空 → 清 `focus_suppressed`、`focus_main_window`、`notify_live_control`、返回 `true`；不创建窗口。
- [ ] `main.rs`：删除 `CloseRequested` 的 `live-control` 分支（:1019-1027）与 window-state denylist 中的 `live-control`（:972）。
- [ ] 托盘「处理实时确认」（`main.rs:882`）继续走 `show_pending_control`，行为变为聚焦主窗口。
- [ ] 删除 `packages/desktop/src-tauri/capabilities/live-control.json`；`tauri.conf.json:16-20` capabilities 去掉 `live-control`。
- [ ] `permissions/desktop.toml:98-131`：删 `allow-live-control-resize`，其余 5 个描述改为 Board 页面语义。
- [ ] `capabilities/board-local-association.json` permissions 增加：`allow-live-control-get`、`allow-live-control-decide`、`allow-live-control-diff`、`allow-live-control-initial`、`allow-live-control-dismiss`（`allow-live-control-show` 已有）。

### 2. Rust：差异标题与待上传任务元信息

- [ ] `agent/task_sync.rs::Difference::to_control`（:204-223）加 `"title"`（`task_title(local).or(task_title(server))`），`local`/`server` 侧也带 `title`。
- [ ] `agent/device.rs`：新增 `DeferredTaskInfo { task_dir, title: Option<String> }`（serde camelCase），`LocalAssociation` 增加 `deferred_tasks: Vec<DeferredTaskInfo>`；`read_local_associations` 读 `<repo_path>/<task_dir>/task.json` 的 `title`，失败降级 `None`；保留 `deferred_task_dirs`。
- [ ] 补 Rust 单测：标题提取（有/无 title、损坏 JSON）、`to_control` 含 title、association 序列化含 `deferredTasks`。

### 3. Web：确认弹窗容器与上传任务列表

- [ ] `components/ui/confirm-dialog.tsx`：`description` 外层 `<p>` 改 `<div className="whitespace-pre-line text-xs/relaxed text-muted-foreground">`（现有纯文本调用不变）。
- [ ] `components/layout/ProjectRail.tsx:508-517`：`syncDeferredTasks` 的 `description` 改为列表（`title || 目录名` + `taskDir`），容器 `max-h-56 overflow-auto`；无 `deferredTasks` 时退回 `deferredTaskDirs`。
- [ ] TS 类型：`LocalAssociation` 增加 `deferredTasks?: Array<{ taskDir: string; title?: string | null }>`。

### 4. Web：控制弹窗迁入 Board 页面

- [ ] 新增 `packages/web/src/desktop/LiveSyncControlDialog.tsx`：迁移 `ControlApp.tsx` 的状态机与动作分发（`createRefreshCoordinator`、`listen('live-control-changed')`、focus/visibility、10s 兜底、diff/choices/ownership/confirm）。
  - 渲染：`Dialog` + `DialogContent`（`sm:max-w-[min(72rem,92vw)]` `max-h-[85vh]`）+ `DialogHeader` + `DialogBody`（唯一滚动区）+ `DialogFooter`（`ActionBar`）。
  - 无 `window.__TAURI__?.core?.invoke` → `return null`；`live_control_pending` 抛错（旧客户端）→ 标记不可用并停止轮询。
- [ ] `pages/board/BoardPage.tsx`：在 `TaskDetailDialog` 同级挂载 `<LiveSyncControlDialog />`。
- [ ] 删除 `packages/web/src/desktop/ControlApp.tsx`、`packages/web/src/desktop/main-control.tsx`、`packages/web/desktop/control.html`。
- [ ] `vite.desktop.config.ts`：`rollupOptions.input` 只留 `index`；`vite.desktop.config.ts` 里 `stripDevCsp` 只影响 index（保留）。

### 5. Web：Monaco 左右分栏 diff

- [ ] 新增 `packages/web/src/desktop/MonacoDiff.tsx`：`import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'`；`self.MonacoEnvironment = { getWorker: () => new EditorWorker() }`；`monaco.editor.createDiffEditor(...)`（`readOnly`、`originalEditable:false`、`renderSideBySide:true`、`automaticLayout:true`、`minimap.enabled:false`、`scrollBeyondLastLine:false`），语言 `plaintext`，主题跟随 `documentElement.dark`。
- [ ] 弹窗差异视图：文件单选列表（路径 + `changedBy`），固定高度 `clamp(16rem, 55vh, 34rem)`；缺失侧空字符串 + 文件头标注「该文件在对应版本中不存在」。
- [ ] `React.lazy` 动态 import + `Suspense`；加载失败 catch → `DiffFileFallback`（现有双 `<pre>` 逻辑）+ 提示「高级差异视图不可用，已回退文本对照」。
- [ ] local-only 差异项展示 `title` + `taskDir`。

### 6. 测试与文档

- [ ] `packages/desktop/test/desktop-ui-build.test.js`：删掉 control 页面/`ControlApp` 相关断言（文件已删除），保留桌面 UI 构建产物与 capability 静态检查（该文件既有约定），只补充「`capabilities/live-control.json` 不存在、`tauri.conf.json` capability 列表无 `live-control`」两条契约断言。
- [ ] 不新增 Web 源码文本断言（`.trellis/spec/frontend/quality-guidelines.md` 明确禁止）；弹窗与 Monaco 行为用 `yarn build` + 手工验收证明。
- [ ] 更新 `.trellis/spec/desktop/tauri-commands/index.md`（收尾阶段）：控制事件与 Board 命令的新契约（`ensure_board_caller`、无独立窗、旧客户端降级）。

## 验证命令

```powershell
yarn install
yarn build
yarn build:desktop
yarn test
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml
yarn format
```

手工验证（`yarn desktop:dev`）：

1. 登录 → 制造本地/服务端任务差异 → 主窗口内弹窗，无独立小窗。
2. 关闭主窗口到托盘 → 新事件拉起主窗口并弹窗。
3. 任务文件冲突 → Monaco 左右分栏（左本地、右服务端、只读）；断开 Monaco chunk 后回退文本。
4. 「稍后处理」后不再自动弹；托盘「处理实时确认」重开；ProjectRail「确认差异」不再报“仅允许本地登录页调用”。
5. 上传本地任务确认弹窗列出标题 + 目录；确认后仍触发 `sync_deferred_tasks`，冲突提示不变。
6. 浏览器直接打开 Board（非客户端）不出现弹窗。

## 风险文件与回滚点

| 文件 | 风险 | 回滚点 |
| --- | --- | --- |
| `packages/desktop/src-tauri/src/agent_service.rs` | 窗口创建删除后事件无处显示 | 步骤 1 完成后立刻跑 `cargo test` + 手工弹窗验证 |
| `packages/desktop/src-tauri/src/main.rs` 命令校验 | 远端 Origin 校验放宽 | 跨 Origin 负向用例（错误 Origin 调用应失败） |
| `capabilities/*.json` + `permissions/desktop.toml` | 权限缺失导致命令不可用 / 过度授权 | 静态契约测试断言精确命令白名单 |
| `packages/web/src/pages/board/BoardPage.tsx` | 弹窗全局挂载影响普通浏览器 | `window.__TAURI__` 守卫 + 浏览器手工验证 |
| `monaco-editor` 依赖 | bundle 体积、worker 路径 | 懒加载 + 失败回退；必要时可独立回滚该依赖与组件 |
