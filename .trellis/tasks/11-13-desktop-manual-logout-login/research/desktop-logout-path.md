# 桌面退出链路调研

## 结论

手动退出应新增专用 Tauri 命令，由当前 Board 页面直接触发桌面清理和本地登录页跳转，避免远端 `/login.html` 导航与桌面导航拦截异步跳转同时发生。

## 证据

- `apps/web/src/pages/board/BoardPage.tsx:215`：手动退出先调用 Web `logout()`，再导航到 `/login.html`。
- `apps/desktop/src-tauri/src/main.rs:849`：桌面端取消同源登录页导航，并异步调用 `clear_desktop_session`。
- `apps/desktop/src-tauri/src/main.rs:250`：清理函数停止 Agent、删除 Cookie、清空认证状态并跳转本地登录页，再撤销服务端会话。
- `apps/web/src/desktop/LoginApp.tsx:201`：服务器地址、登录名和密码都存在时自动登录。
- `apps/desktop/src-tauri/permissions/desktop.toml` 与 `apps/desktop/src-tauri/capabilities/board-local-association.json`：远程 Board 只能调用显式授权的桌面命令。

## 限制

- 当前日志没有记录导航拦截或本地跳转结果，白屏机制属于源码推断，必须在真实桌面客户端中复测。
- 服务端会话撤销为尽力执行；即使网络失败，本地 Cookie、内存令牌和已保存密码仍必须清除。

## 推荐

- 正常手动退出走 `desktop_logout` 命令，保留现有导航拦截作为 401 跳转兜底。
- 退出时清除配置密码，保留服务器地址和登录名，避免当前会话和重启后自动登录。
