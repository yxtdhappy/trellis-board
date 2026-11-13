# 桌面退出链路调研

## 结论

手动退出应新增专用 Tauri 命令，由当前 Board 页面直接触发桌面清理和本地登录页跳转，避免远端 `/login.html` 导航与桌面导航拦截异步跳转同时发生。

## 证据

- `apps/web/src/pages/board/BoardPage.tsx:217`：手动退出先调用 Web `logout()`，再导航到 `/login.html`。
- `apps/desktop/src-tauri/src/main.rs:872`：桌面端取消同源登录页导航，并异步调用 `clear_desktop_session`。
- `apps/desktop/src-tauri/src/main.rs:268`：清理函数停止 Agent、删除 Cookie、清空认证状态并跳转本地登录页，再撤销服务端会话。
- `apps/web/src/desktop/LoginApp.tsx:201`：服务器地址、登录名和密码都存在时自动登录。
- `apps/desktop/src-tauri/permissions/desktop.toml` 与 `apps/desktop/src-tauri/capabilities/board-local-association.json`：远程 Board 只能调用显式授权的桌面命令。

## 限制

- 原始日志没有记录导航拦截结果；真实 E2E 随后已确认 `local_url` 为 `about:blank`，仍需用修复后的新构建复测退出闭环。
- 服务端会话撤销为尽力执行；即使网络失败，本地 Cookie、内存令牌和已保存密码仍必须清除。

## 真实 E2E 复核

- 使用 CI 构建的 Windows 便携包，以现有登录配置启动客户端，通过 WebView2 CDP 点击“退出”。
- 点击后窗口 URL 实际变为 `about:blank`，主进程仍运行；本地配置中密码已清除，服务器地址和登录名保留。
- 根因是 `build_main_window` 在 `builder.build()` 后立即读取 `window.url()`，此时初始页面尚未加载，保存到 `local_url` 的值是 `about:blank`。
- 修复改为在 `WebviewWindowBuilder::on_page_load` 收到本地页面 `Started` 事件时记录 `payload.url()`，并排除 `about:` 页面。

## 推荐

- 正常手动退出走 `desktop_logout` 命令，保留现有导航拦截作为 401 跳转兜底。
- 退出时清除配置密码，保留服务器地址和登录名，避免当前会话和重启后自动登录。
