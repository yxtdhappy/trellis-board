# Design

## 链接契约（两跳）

1. 分享链接（发给成员）：`<origin>/share.html?space=<taskSpaceId>&task=<taskId>`，`origin` 取 `location.origin`，协议随部署（http/https），不硬编码
2. 协议链接（中转页唤起客户端）：`spec-board://task?server=<origin>&space=<taskSpaceId>&task=<taskId>`，`server` 取中转页 `location.origin`（与第 1 跳同源，http 部署即 http）

- 生成：Web `src/lib/share-link.ts`（纯函数 + 测试）。`buildShareUrl({ origin, taskSpaceId, taskId })` 生成第 1 跳；`buildProtocolUrl` 由三处复用；`sanitizeShareParam` / `parseSharePageParams` 校验去空白、控制字符、512 长度上限与合法 http(s) origin。
- 参数来源：`BoardTask.taskSpaceId`；`taskId` 取 `executionTaskKey` 中首个 `::` 之后的部分（与 `gitless-board-service.js:346-353` 一致），不用 `taskKey` 兜底以免污染链接。
- 入口覆盖：任务卡片、子任务悬浮条（`Kanban.tsx`）、任务详情弹窗底部（`TaskDetailFooter.tsx`）。

## 中转页 `share.html`

- 新增 Vite 入口 `packages/web/share.html` + `src/share.ts`，产物为 `packages/server/public/share.html` 及哈希脚本；`serveStatic` 已免登录返回，服务端零改动。
- CSP 禁止内联脚本：逻辑全部在 `src/share.ts`，HTML 只保留静态结构与 `<script type="module">`。
- 流程：`parseSharePageParams` 校验 `space`/`task`（非空、不含控制字符、长度上限 512）与 `location.origin`（合法 http/https）→ 组装协议链接 → 自动 `location.href = 协议链接` → 按钮“打开客户端”重复该跳转 → 按钮“复制客户端链接”写剪贴板（失败时提示“请在系统浏览器中打开本页后重试”）。
- 页面不含任何任务标题/描述：未登录也能打开，不能泄露内容；文案说明“正在唤起客户端”及“在飞书等内置浏览器中无反应时请在系统浏览器中打开本页或复制客户端链接”。
- 参数缺失/非法：隐藏引导与按钮并显示错误文案，不跳转。

## 桌面侧数据流

1. `tauri-plugin-deep-link`：`tauri.conf.json` 注册 scheme `spec-board`；Windows 下由插件在运行时写入注册表（安装包与便携包一致）。
2. 入口统一：冷启动 argv 与 `single-instance` 回调 argv、deep-link `on_open_url` 都交给同一个 `share_link::handle(app, raw)`；重复触发按幂等处理。
3. `handle`：解析（scheme=`spec-board`、host=`task`、`server` 必填且为合法 http(s) origin、`space`/`task` 非空、不含控制字符且长度受限）→ 写入 `DesktopAuthState.pending_share: Option<PendingShare>`（合法为 `Target`，非法在槽位为空时记 `Invalid` 而不覆盖未消费的合法目标，且仅写一条 warn 不落盘原文）→ `focus_main_window`（含托盘恢复）→ emit `share-link-open`。
4. 新命令 `take_pending_share_link() -> Option<PendingShare>`：`ensure_board_caller` 校验后取出并清空；只加入 `board-local-association` capability，并登记 `permissions/desktop.toml`。
5. `clear_desktop_session` 清空 `pending_share`；登录完成进入 Board 后由 Web 拉取暂存值。

## Web 侧打开逻辑

- `useShareLinkOpen`（BoardPage 内）：仅在 `runtime` 就绪且非 `mustChangePassword` 强制改密状态下启用（改密完成后自动触发读取）；先 `listen('share-link-open')` 再 `take_pending_share_link()`，全程用 `active` 守卫卸载/StrictMode 双挂载竞态。
- 收到 `PendingShare::Invalid` 时弹出“任务分享链接格式无效，请让分享人重新复制”。
- origin 比对：`new URL(target.server)` 与 `new URL(location.origin)` 比较 protocol/host/port（大小写与末尾斜杠归一），不用字符串全等。
- 一致：先在当前 `tasks` 里按 `taskSpaceId + executionTaskKey` 查；未命中调用纯 query 端点 `GET /api/tasks?taskSpaceId=..&executionTaskKey=..` 取单任务后 `setSelected(task)`；命中则直接 `setSelected`。
- 不一致 / 404 / 403 / `PASSWORD_CHANGE_REQUIRED`：sonner toast 明确提示，不打开弹窗，不跳转。
- 非 Tauri 环境：不监听，只保留复制功能。

## 兼容与风险

- 旧客户端没有 `spec-board` 协议：中转页唤起无效，用户看到提示；属已知限制。
- 协议处理是外部可触发输入：只解析定位参数，不执行命令、不导航到 `server` 指定的地址（只比较，不跳转）。
- 同一 Board 可能通过多个 host（局域网 IP / 域名）访问：origin 不一致会提示，需用分享来源的同一地址登录；PRD 明确不做自动切换。
- `main.rs` 已 1200+ 行，新增逻辑放新子模块 `share_link.rs`，`main.rs` 只加注册与调用（模块行数守卫）。

## 回滚

中转页与服务端零改动可独立下线；桌面侧（插件、协议、命令）与 Web 侧（按钮、hook）独立回滚；Web 复制按钮可保留。
