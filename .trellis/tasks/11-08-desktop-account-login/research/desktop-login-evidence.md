# 桌面账号密码登录证据与方案比较

## 当前实现

- 冷启动有配置时直接打开 Board，无配置时打开本地注册页：
  `desktop/src-tauri/src/main.rs:292`、`desktop/src-tauri/src/main.rs:345`。
- 当前注册页要求服务地址、设备名称和一次性设备令牌：
  `desktop/ui/index.html:16`。
- 当前注册成功后显示 workspace 初始化面板：
  `desktop/ui/setup.js:87`。
- 当前 Web 登录已经通过 `/api/auth/login` 校验账号密码并设置 HttpOnly Cookie：
  `server/team/http.js:705`、`server/team/auth.js:596`。
- 当前一次性桌面令牌由 `/api/desktop/enroll-tokens` 签发、由
  `/api/agent/enroll-desktop` 兑换设备凭据：
  `server/team/http.js:635`、`server/team/http.js:1307`。
- 多团队任务已把桌面令牌记录改为不包含活动团队：
  `server/team/desktop-auth.js:104`。
- 当前窗口导航白名单在创建时固定，登录后没有动态 Board origin：
  `desktop/src-tauri/src/main.rs:345`、`desktop/src-tauri/src/navigation.rs:84`。

## 方案比较

### A. 在本地页直接 `fetch` 服务端

不采用。本地页原点是 `tauri.localhost`，跨域登录、Cookie 写入和 CSRF Origin 都会增加协议复杂度，且无法自然把 Session Cookie 写入远程 WebView 的 Cookie Store。

### B. Tauri Rust 直接实现账号登录和 sidecar 设备兑换

不采用。需要新增 HTTP 客户端、Cookie 解析、DPAPI 调用和设备配置逻辑，重复 sidecar 已有职责，并跨过当前 Rust/Node 边界。

### C. sidecar 完成认证与设备兑换，Tauri 负责 Cookie 和导航

采用。sidecar 已有 HTTPS 请求、协议校验、设备凭证和 DPAPI 存储；Tauri v2 提供
`WebviewWindow::set_cookie`/`delete_cookie` 和动态导航能力。该方案不新增服务端认证端点，用户不再看到一次性令牌。

## 关键实现约束

- 密码只通过 Tauri IPC 进入 Rust，再经 stdin 进入 sidecar；不得进入 argv 或日志。
- 必须先登录成功，再使用 Session Cookie 在 sidecar 内部签发并兑换一次性设备令牌。
- 一次性令牌是内部协议，不改变“客户端登录只需要账号密码”的产品行为。
- 首次登录、账号切换和设备凭据失效才兑换新设备；同一账号重复登录复用 DPAPI 凭据。
- 不兼容旧客户端配置：新客户端第一次登录强制创建新设备。
- Tauri WebView Cookie 在 Windows WebView2 上的域名作用域必须用真实安装包验证。

