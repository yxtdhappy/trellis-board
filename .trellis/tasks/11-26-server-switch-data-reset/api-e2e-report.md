# API E2E Report

- Task: `11-26-server-switch-data-reset`
- Result: **not applicable**

## 原因

本任务新增/修改的是桌面客户端本地的 Tauri IPC 命令（`desktop_login_preflight`、
`desktop_login` 的 `switchServer` 参数）与本地文件备份/清理逻辑，没有新增或修改
`packages/server` 的 HTTP 接口契约，也没有需要本地网关转发验证的后端 API。

`trellis-api-e2e` 的「一次请求 → 一条后端日志 → 响应/落库复核」链路不适用：本任务的
验证对象是客户端本地文件系统状态（备份目录、清理范围）与登录页交互，而非服务端接口。

## 已验证的替代证据

- `node --test packages/desktop/test/client-reset-contract.test.js`：4 项通过（capability 边界、
  清理清单、`switchServer` 强制确认、登录页先 preflight 后登录）。
- `yarn test --scope=desktop`：44 项通过、1 项按平台跳过。
- `packages/web` `tsc -b --noEmit` 与 oxlint：通过（oxlint 仅存量 warning）。
- Rust 单元测试（`client_reset` 的归一化/备份/清理/恢复/保留策略）无法在本机执行：本机无 Rust
  工具链，交由 CI `cargo test` 验证，未声称本地通过。
