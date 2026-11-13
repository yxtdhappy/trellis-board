# 修复桌面客户端手动退出登录白屏并禁止自动登录

## Goal

桌面客户端中，用户从 Board 手动退出登录后，必须稳定返回本地登录页，不自动使用上次保存的密码登录；服务器地址和登录名可继续编辑，用户可改用其他服务器或账号重新登录。

## Background

- 远端 Board 的退出按钮原先先请求 `/api/auth/logout`，随后执行 `window.location.assign('/login.html')`，见 `apps/web/src/pages/board/BoardPage.tsx:217`。
- 桌面端在导航回调中拦截同源 `/login`、`/login.html`，取消导航后异步清理会话并跳转本地登录页，见 `apps/desktop/src-tauri/src/main.rs:872`。
- 真实 Windows 便携包 E2E 已确认：窗口构建后立即读取 `window.url()` 会得到 `about:blank`，退出时跳转到该地址导致白屏；修复改为在 `on_page_load` 的本地页面 `Started` 事件中记录本地登录页 URL。
- 本地登录页只要读到服务器地址、登录名和密码就会自动登录，见 `apps/web/src/desktop/LoginApp.tsx:201`。
- 桌面端已有远程 Board capability 白名单，Board 页面只能调用明确授权的 Tauri 命令，见 `apps/desktop/src-tauri/permissions/desktop.toml` 和 `apps/desktop/src-tauri/capabilities/board-local-association.json`。

## Requirements

### R1 手动退出使用确定性的桌面退出链路

桌面模式下点击退出登录时，Board 页面应调用专用桌面命令，不再先导航到远端 `/login.html`，从而避开导航拦截与异步跳转的竞态。

桌面命令只能由当前已登录 Board 的 origin 调用，并完成：

- 停止后台 Agent；
- 删除当前 Board 会话 Cookie；
- 清除进程内 Board 地址和会话令牌；
- 返回本地登录页；
- 尽力撤销服务端会话。

### R2 手动退出后禁止自动登录

退出完成后，本地登录页不得使用上次保存的密码自动登录。应清除本地配置中保存的密码，同时保留服务器地址和登录名作为可编辑初值；本次退出后即使重启客户端，也不得自动登录，直到用户再次手动提交登录并成功。

### R3 保留兼容路径

- 普通浏览器访问 Board 时，退出行为保持现有 Web 流程不变。
- 桌面端直接跳转 `/login.html` 或收到未捕获的鉴权跳转时，保留现有导航拦截清理逻辑作为兜底。
- 冷启动且用户没有主动退出时，仍可使用已保存凭据自动登录。

## Acceptance Criteria

- [ ] 桌面客户端登录后点击“退出”，在正常网络和正常服务端状态下，1 秒内显示本地登录页，不出现白屏。
- [ ] 退出后登录页不会自动发起登录请求，且密码输入框为空。
- [ ] 登录页仍显示上次服务器地址和登录名，二者均可编辑。
- [ ] 用户可修改服务器地址和账号，并手动登录成功。
- [ ] 退出后关闭并重新打开客户端，仍停留在本地登录页且不自动登录。
- [ ] 浏览器模式下退出仍清除服务端会话并返回 `/login.html`。
- [ ] Agent 在退出后停止，不继续使用旧会话同步。
- [ ] 相关桌面端测试、Web 静态检查和一次最终编译验证通过。

## Out of Scope

- 不修改服务端鉴权接口、Cookie 协议或 Agent 同步协议。
- 不新增“记住密码”开关、账号列表管理或多服务器历史记录。
- 不调整登录页整体视觉设计。

## Blocking Open Questions

无。
