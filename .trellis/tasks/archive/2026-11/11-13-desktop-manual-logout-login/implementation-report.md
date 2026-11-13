# 实施报告

## 结论

桌面客户端手动退出已改为专用 Tauri 命令，避免远端登录页导航与桌面导航拦截并发；退出时清除保存密码，因此当前登录页和客户端重启后都不会自动登录。

首次打包 E2E 发现窗口仍进入 `about:blank`，进一步确认 `builder.build()` 后立即读取 `window.url()` 时页面尚未加载。最终实现改为在 `on_page_load` 的本地页面 `Started` 事件中捕获真实本地登录页 URL。

## 代码改动

- 新增 `desktop_logout` Tauri 命令和 `allow-desktop-logout` 最小权限，只授权给远程 Board capability。
- `clear_desktop_session` 复用现有 Agent 停止、Cookie 删除、内存会话清理和服务端撤销逻辑，并清除 `ClientConfig.password`。
- Board 的退出按钮在桌面环境优先调用 `desktop_logout`，浏览器环境保留原 Web 退出流程。
- `build_main_window` 通过 `on_page_load` 捕获本地页面 URL，排除 `about:`、远程 Board 和外链。
- 增加权限、命令注册、密码清除、登录页自动登录条件和本地 URL 捕获的静态契约测试。

## 验证

- 本地 `npm test`：430 项，429 通过、1 跳过、0 失败。
- 本地 `npm run build:desktop`：通过。
- Windows CI run `43383014554`：Node 测试、Web/桌面 UI 构建、Rust 单元测试、Tauri 打包、便携包校验和启动冒烟测试全部通过。
- 真实 Windows E2E：通过，详见 [e2e-report.md](./e2e-report.md)。

## 提交

- `8921ea2`：第一轮桌面退出命令、权限和密码清除。
- `9f6484e`：修复本地登录页 URL 被捕获为 `about:blank` 的根因。
