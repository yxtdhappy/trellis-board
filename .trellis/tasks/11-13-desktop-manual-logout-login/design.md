# 技术设计

## 边界

- Web 层：`apps/web/src/pages/board/BoardPage.tsx` 负责根据运行环境选择桌面退出命令或 Web 退出流程。
- Tauri 命令层：`apps/desktop/src-tauri/src/main.rs` 新增 `desktop_logout`，复用 `ensure_board_caller` 和 `clear_desktop_session`。
- 权限层：`apps/desktop/src-tauri/permissions/desktop.toml` 新增最小命令权限，并仅加入 `board-local-association` 远程 Board capability。
- 配置层：退出时清除 `ClientConfig.password`，保留 `server_url` 和 `username`。
- 登录页：已有“三项凭据齐全才自动登录”的判断保持不变，密码被清空后自然进入手动登录。

## 数据流

1. 用户在桌面客户端 Board 页面点击“退出”。
2. `BoardPage` 检测 `window.__TAURI__.core.invoke`，调用 `desktop_logout`。
3. Tauri 以当前窗口 URL 和 `DesktopAuthState.board_url` 复核调用来源。
4. `clear_desktop_session` 停止 Agent、读取并取出会话令牌、删除 Cookie、清空 Board URL。
5. 将本地配置中的密码设为 `None` 并原子保存。
6. 导航到本地页面加载事件中捕获的登录页 URL。
7. 后台尽力调用服务端退出接口撤销旧会话。
8. 登录页调用 `app_status`，获得服务器地址和登录名但无密码，因此不自动登录。

## 契约与安全

- `desktop_logout` 不接受外部 server/token 参数，只使用进程内已认证状态。
- 命令必须通过 `ensure_board_caller`，避免任意远程页面调用退出命令。
- capability 只在远程 Board capability 中增加该命令，不扩展到本地控制窗口。
- 密码清除失败时记录告警，但本地 Cookie 和进程内会话仍必须清除。

## 取舍

- 相对于新增“禁止自动登录一次”的临时标志，清除已保存密码更简单，也能覆盖客户端重启后的场景，并减少明文凭据保留。
- 保留服务器地址和登录名，减少重新填写成本，同时满足切换服务器的可编辑需求。
- 正常手动退出不再依赖导航拦截；导航拦截继续服务 401 等非按钮触发的兜底场景。
- 本地登录页 URL 必须在 `on_page_load` 的本地页面 `Started` 事件中捕获；构建窗口后立即读取 `window.url()` 会得到 `about:blank`，已在真实 E2E 中证实。

## 回滚

- 若桌面命令调用失败，Board 页面回退到现有 Web 退出流程。
- 可通过移除 `desktop_logout` 权限与调用并恢复原逻辑回滚，不涉及数据迁移。
