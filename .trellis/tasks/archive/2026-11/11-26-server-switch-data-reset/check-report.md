---
mode: independent
agent: trellis-check
session: a091ac589f121963d
commit: ""
base: 6f97e38b104ab23c32d08f9d5532926b2a41b46c
scope: packages/desktop/src-tauri/src/client_reset.rs,packages/desktop/src-tauri/src/client_reset/tests.rs,packages/desktop/src-tauri/src/main.rs,packages/desktop/src-tauri/capabilities/main.json,packages/desktop/src-tauri/permissions/desktop.toml,packages/web/src/desktop/LoginApp.tsx,packages/web/src/desktop/main-index.tsx,packages/desktop/test/client-reset-contract.test.js,.trellis/spec/desktop/tauri-commands/index.md
diff: sha256:b42b229b34f0d75731a94ddddbbdd8f53419608fc7b9510ad466e5fdf808377e
---
# Check Report: 切换服务器地址时备份并清理客户端数据

## 检查范围与结论

- 独立复核由 `trellis-check` 子代理执行（只读，未修改文件），主会话随后应用修复并重新验证。
- 编译风险：逐项核对类型推断、借用、`let-else`、`DateTime<Local>` 的 `Copy`、`#[path]` 模块、
  Windows 独占句柄测试的 `cfg`/`OpenOptionsExt`、tauri 命令签名与 `generate_handler!` 注册，
  未发现会导致编译失败的问题。
- 删除范围：`RESET_ITEMS` 仅 `client.json` / `agent` / `desktop-plugins`；`runtime/`、`npm-global/`、
  `updates/`、`plugins/`、`appearance.json`、`logs/` 均有保留断言。
- 失败路径：备份失败不删除且清理残留；登录失败从备份恢复；`previous_config` 回落到切换前配置，
  运行环境标记保留。
- 权限边界：`allow-desktop-login-preflight` 只进本地登录页 capability，远程 Board capability 未加；
  命令先执行 `ensure_local_caller`。
- 前端交互：登录页先 preflight；取消只复位状态、不调用登录；`ConfirmDialogProvider` 已挂载。

## 发现并已修复

1. 删除中途失败时失败项可能已被部分删除却不在恢复清单 → 失败项也加入 `outcome.removed` 后恢复。
2. 登录已成功但令牌校验、写 Cookie、写 `client.json` 失败时未回滚 → 统一走
   `rollback_server_switch`。
3. 恢复失败原因未记录日志 → 已记录；并按 `desktop-agent-runtime` §4 把日志与错误文案改为
   只输出备份目录名，不输出绝对路径。

## 未修复（已记录）

- `ControlHub` 内存控制队列在切换服务器时未清空；属既有行为，控制事件多数带过期时间，影响有界。

## 验证

- 新增静态契约测试 4/4；`yarn test --scope=desktop` 43 通过 / 1 跳过；`yarn test --scope=web` 136/136。
- `tsc -b --noEmit`、oxlint 通过；改动文件 `oxfmt --check` 通过；`--target=desktop-ui` 构建成功。
- Rust `cargo test` 未在本地执行（无工具链），未声称通过；由 tag `v0.5.14` 的 CI 验证。