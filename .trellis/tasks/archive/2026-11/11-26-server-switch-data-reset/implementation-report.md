# Implementation Report: 切换服务器地址时备份并清理客户端数据

## Changed Files

- `packages/desktop/src-tauri/src/client_reset.rs`（新增：备份/清理/恢复/保留策略）
- `packages/desktop/src-tauri/src/client_reset/tests.rs`（新增：7 个单测）
- `packages/desktop/src-tauri/src/main.rs`（`desktop_login_preflight`、`desktop_login` 的
  `switch_server`、回滚与运行环境标记回写）
- `packages/desktop/src-tauri/capabilities/main.json`
- `packages/desktop/src-tauri/permissions/desktop.toml`
- `packages/web/src/desktop/LoginApp.tsx`
- `packages/web/src/desktop/main-index.tsx`
- `packages/desktop/test/client-reset-contract.test.js`（新增：4 项静态契约测试）
- `.trellis/spec/desktop/tauri-commands/index.md`（新增场景）

## Decisions

- 地址比较复用 `navigation::validate_board_url` + `board_server_url`，尾部 `/`、主机大小写、
  默认端口差异不触发；前端不重复实现归一化。
- `desktop_login` 增加 `switchServer: Option<bool>`；地址变化但未显式确认时直接报错，preflight
  只做交互提示，不作为唯一防线。
- 清理范围固定为 `client.json` / `agent` / `desktop-plugins`，保留 `runtime/`、`npm-global/`、
  `updates/`、`plugins/`、`appearance.json`、`logs/`、`update-state.json`。
- 顺序为「备份 → 删除 → 登录」；备份失败中止登录且不删数据；删除失败把失败项也纳入恢复范围。
- 登录失败及登录后的本地步骤（令牌校验、写 Cookie、写 `client.json`）失败都统一
  `rollback_server_switch`，恢复旧数据。
- `client.json` 被删除后，用切换前读到的 `node_runtime` / `trellis_runtime` / `python_runtime`
  回写，保证切换后 `runtime_status` 仍 ready，不触发重新下载。
- 备份目录与 data 同级、保留最近 3 份；日志与错误消息按 `desktop-agent-runtime` §4 只输出
  备份目录名，不输出绝对路径。

## Verification

- 新增静态契约测试 4/4 通过（命令权限边界、清理清单、强制确认、登录页先 preflight 后登录）。
- `yarn test --scope=desktop`：43 通过 / 1 平台跳过 / 0 失败。
- `yarn test --scope=web`：136/136 通过。
- `packages/web` `tsc -b --noEmit` 通过；oxlint 通过（仅存量 warning）。
- 改动文件 `oxfmt --check` 通过；`node scripts/build.mjs --target=desktop-ui` 成功（唯一一次编译）。
- 独立 `trellis-check` 复核：未发现编译错误；指出 3 个失败路径缺口，已修复并重新验证。
- Rust 单测（`client_reset` 归一化/备份/清理/恢复/保留 3 份/备份失败）本机无法执行：
  本机无 Rust 工具链，交由 CI `cargo test` 验证。

## Open Risks

- Rust 编译与 `cargo test` 未在本地验证；tag `v0.5.14` 的 CI 构建是首次真实验证。
- 仓库级 `yarn format:check` 存在 34 个既有文件格式问题（不在本次改动范围），本次未修改。
- 切换服务器时未清理内存中的 `ControlHub` 控制队列（既有行为）；旧服务器的控制事件多数带过期时间，
  影响有界，未在本次范围内处理。
- 未做 Windows 真机 E2E（登录 → 改地址 → 取消/确认 → 核对备份目录）；需要桌面构建后再验证。
