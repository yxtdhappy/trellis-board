# 任务流水线任务分享链接

## Goal

任务流水线（看板）中的任务支持“分享”：点击后复制一条链接，发给团队成员；成员点击链接唤起已安装的桌面客户端，并在客户端中直接打开该任务的详情弹窗，查看并评审方案。

## Confirmed Facts

- 桌面客户端 `packages/desktop/src-tauri`（Tauri 2）已启用 `tauri-plugin-single-instance`（`main.rs:1130`），回调忽略了 `argv`；未集成 `tauri-plugin-deep-link`，`tauri.conf.json` 未注册自定义协议。
- 客户端窗口加载远程 Board（地址来自登录配置，存于 `DesktopAuthState.board_url`）；远程页面只能调用 `board-local-association` capability 中登记的命令，且须经 `ensure_board_caller`，并同时登记 `permissions/desktop.toml`。
- 任务详情弹窗为 `TaskDetailDialog.tsx`，选中状态在 `BoardPage.tsx:79`（`selected: BoardTask | null`）；任务标识为 `taskSpaceId` + `executionTaskKey = "<taskSpaceId>::<taskId>"`（`packages/server/team/gitless-board-service.js:346-353`）。
- 已有只读取单任务接口：`GET /api/tasks/<executionTaskKey>?taskSpaceId=<id>`（`packages/server/team/http/routes/tasks.js:169-178`），走 `boardService.getTask` 的既有鉴权与 taskSpace 访问校验，无需新增服务端接口。
- Web 为 Vite 多页构建（`packages/web/vite.config.ts`，入口 `index/admin/login`），产物写入 `packages/server/public`；非 `/api/` 路径由 `serveStatic` 免登录返回（`packages/server/team/http.js:141`）。
- 静态响应带 CSP `script-src 'self'`（`packages/server/http-common.js:20-30`），中转页脚本必须是外部 bundle，不能内联。
- 决策（用户）：采用网页链接中转（方案 1，协议随部署，http/https 均可），协议名 `spec-board`；飞书等 IM 不识别裸自定义协议链接。

## Requirements

1. R1 分享入口：任务详情弹窗与任务卡片提供“分享”按钮，点击复制链接并 toast 提示；桌面客户端与普通浏览器均可复制。
2. R2 链接格式：`<Board origin>/share.html?space=<taskSpaceId>&task=<taskId>`，协议跟随部署（http 或 https，即 `location.origin`），参数 URL 编码；不含令牌或凭据。
3. R3 中转页：`share.html` 打开后立即尝试唤起 `spec-board://task?server=<origin>&space=..&task=..`，同时展示“打开客户端”按钮（重复尝试）与“复制客户端链接”备用操作；页面不请求、不展示任何任务内容。
4. R4 唤起：接收方点击链接，系统唤起已安装客户端；客户端已运行（含托盘隐藏）时前置窗口，未运行时冷启动后处理。
5. R5 打开：已登录且协议链接中的 `server` 与当前 Board origin 一致时，Board 自动打开该任务详情弹窗；任务不在当前看板数据中时按 `space + task` 走单任务接口获取。
6. R6 未登录：先走登录流程，登录进入 Board 后再打开目标任务（链接暂存于内存，不落盘）。
7. R7 失败提示：`server` 与当前 Board 不一致、任务不存在、无权限、链接格式非法、中转页参数缺失，均给出明确提示，不泄露任务内容，不崩溃。
8. R8 安全：链接只携带定位信息；中转页只做本地跳转，不把 URL 参数拼进 DOM；客户端严格校验 scheme/host/参数，链接不能触发定位任务以外的任何动作。

## Acceptance Criteria

- AC1 点击分享按钮后，剪贴板内容为 `<origin>/share.html?space=..&task=..`，协议与当前访问地址一致（http/https），任务详情不受影响。
- AC2 浏览器打开该链接，页面尝试唤起客户端；点击“打开客户端”按钮也会唤起；未安装客户端时页面给出提示且复制协议链接可用。
- AC3 客户端已运行并登录同一服务器时，唤起后窗口前置并打开对应任务详情弹窗。
- AC4 客户端未运行时，点击链接冷启动，登录态有效则打开详情；无保存凭据则登录后打开。
- AC5 `server` 不一致、任务不存在或无权限、链接非法时，客户端显示对应提示，不打开弹窗。
- AC6 连续点击两条不同链接，最终打开最后一条任务；同一链接重复点击不重复叠开弹窗。
- AC7 `desktop_logout` 后暂存的链接被清空。
- AC8 静态契约测试、Rust 单测、Web 单测通过；Windows 实机验证上述场景。

## Out of Scope

- 未安装客户端时的下载引导/自动安装；浏览器内直接查看任务详情的降级（看板登录后另行打开）。
- 评审能力本身的改动；macOS/Linux 的协议注册。
- 链接过期、一次性、权限授予（分享不授予访问权）。
