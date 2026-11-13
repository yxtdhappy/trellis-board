# 实施计划

## 顺序

1. 在 Tauri 权限清单新增 `allow-desktop-logout`，仅授权给远程 Board capability。
2. 在 `main.rs` 新增 `desktop_logout` 命令，执行 Board origin 校验并复用 `clear_desktop_session`。
3. 在 `clear_desktop_session` 中清除本地配置密码，保留服务器地址和登录名；保存失败仅告警。
4. 将 `desktop_logout` 注册到 Tauri invoke handler。
5. 修改 `BoardPage.handleLogout`：Tauri 环境优先调用 `desktop_logout`；非 Tauri 环境保持现有 `logout()` 后跳转 `/login.html`。
6. 为命令权限、前端调用和密码清除行为补充最小自动化检查。

## 验证

- `npm test`：覆盖现有 Node 测试和新增桌面权限/源码契约测试。
- `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`：验证 Rust 单元测试。
- 最终开发完成后仅执行一次 `npm run build:desktop`，验证 Web/桌面登录页可编译。
- 桌面人工验收：登录 → 退出 → 检查登录页不自动登录 → 修改服务器/账号后登录 → 退出并重启确认仍不自动登录。

## 风险

- 白屏根因未通过当前日志直接证实；实施后必须以真实桌面退出闭环验收。
- 远程 Board 调用新命令依赖 capability 与 Rust origin 双重授权，遗漏任一处都会导致退出失败。
- 配置保存失败会使旧密码仍留在磁盘；实现需记录告警，真实验收时检查日志。
