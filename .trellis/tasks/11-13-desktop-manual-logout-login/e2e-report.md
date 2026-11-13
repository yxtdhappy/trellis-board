# 桌面手动退出 E2E 报告

## 结论

原始白屏问题已修复。使用提交 `9f6484e` 对应的 Windows CI 便携包执行真实 WebView2 E2E，点击退出后窗口稳定进入本地登录页，不再出现 `about:blank`；密码为空，服务器地址和登录名保留，页面没有自动登录。

关闭并重启同一客户端后仍停留在本地登录页且不自动登录。随后将服务器地址从 `127.0.0.1` 改为 `localhost`、登录名从 `testuser` 改为 `thirduser`，手动登录成功进入 Board 页面。

## 测试拓扑

| 层 | 地址 / 构建 | 证据 |
| --- | --- | --- |
| 客户端 | `TrellisBoard_0.3.0_x64-portable`，提交 `9f6484e` | Windows CI run `43383014554` 成功 |
| WebView | WebView2 CDP `127.0.0.1:9231` | 可读取页面 URL、标题、表单值和按钮状态 |
| 登录服务 | 本地 mock `http://127.0.0.1:4337` 与 `http://localhost:4337` | 提供真实 HTTP 登录、runtime、logout 契约 |
| 客户端数据 | 独立临时 `TRELLIS_DESKTOP_HOME` | 不读取、不改写用户实际密码 |

## 操作与结果

| # | 操作 | 结果 |
| --- | --- | --- |
| 1 | 使用预置凭据启动客户端 | 自动登录 mock Board，URL 为 `http://127.0.0.1:4337/` |
| 2 | 从 Board 页面调用 `desktop_logout` | 窗口进入 `http://tauri.localhost/`，标题为 `Trellis Board 登录` |
| 3 | 检查登录页 | 服务器地址和登录名保留，密码为空，状态为“请输入账号密码登录”，未提交自动登录 |
| 4 | 关闭并重启客户端 | 仍为本地登录页，密码为空，未自动登录 |
| 5 | 修改登录名并手动登录 | `otheruser` 登录成功，进入 Board |
| 6 | 再次退出，修改服务器地址和登录名后登录 | 从 `127.0.0.1` 改为 `localhost`、账号改为 `thirduser`，登录成功进入 `http://localhost:4337/` |
| 7 | 清理测试进程 | 客户端和 mock 服务均已停止 |

## 第一轮失败证据

第一轮 Windows 便携包在点击退出后，WebView2 目标 URL 变为 `about:blank`，但客户端主进程保持运行，因此复现了用户看到的白屏。根因不是导航拦截本身，而是启动时从尚未加载的窗口读取 URL，并把 `about:blank` 保存为 `local_url`。

## 验证边界

- 登录服务使用本地契约 mock，目的是在不接触用户真实密码的情况下验证登录、退出、本地导航和重启行为。
- Tauri command、capability 校验、Cookie 删除、配置写回、WebView2 导航均为真实客户端执行路径。
- CI 已覆盖 Rust 单元测试、Tauri 编译和便携包启动冒烟测试。
