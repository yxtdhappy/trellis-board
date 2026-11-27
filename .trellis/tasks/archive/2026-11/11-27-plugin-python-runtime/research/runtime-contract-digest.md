# 相关 spec 摘要（供 sub-agent 直接引用）

> 原文仍然有效；这里只摘录本次改动必须遵守的条款，减少上下文截断风险。

## 1. Python 运行时与 task.py（`.trellis/spec/backend/desktop-agent-runtime.md` §3）

原文位置：`desktop-agent-runtime.md:164-203`。

- Python 版本门槛：≥ 3.9.0。
- 环境门候选顺序：`client.json` flag → `TRELLIS_PYTHON` → fresh `where.exe python.exe` → 静态 PATH 的 `python.exe` → 常见安装根目录（`%LOCALAPPDATA%\Programs\Python\Python*`、`%ProgramFiles%\Python*`、`%SystemDrive%\Python*`）→ `py -3`（用 `py -3 -c "import sys; print(sys.executable)"` 解析真实解释器）。
- 「0 字节文件（Windows App Execution Alias）不得作为可执行文件；flag 版本过低时必须继续探测其它候选。探测成功后写回 flag，Agent 只认 flag。」
- 运行期只有 `task.py create` 与 `task.py set-branch` 需要 Python；Rust 候选顺序是 `TRELLIS_PYTHON` → `client.json` 的 `python_runtime.path` → `python` → `py -3`，「只有 spawn 失败才继续下一个候选」。
- `client.json` 契约：`schemaVersion` camelCase；`serverUrl` 可缺省；运行时 flag 键为 `node_runtime` / `trellis_runtime` / `python_runtime`，登录保存必须保留三个 flag。

## 2. 新增远程 Board 可调用的 Tauri 命令（`.trellis/spec/desktop/tauri-commands/index.md`）

原文位置：`tauri-commands/index.md:30-32`、`:57-94`。

- 除 `main.rs` 的 `generate_handler!` 注册外，必须在 `packages/desktop/src-tauri/permissions/desktop.toml` 声明：
  - `[[permission]]`
  - `identifier = "allow-<command>"`
  - `commands.allow = ["<command>"]`
- 并加入 `capabilities/board-local-association.json` 的 `permissions`；未声明时远程页面调用返回 `not allowed`。
- 只读/导航类命令仍须先执行 `ensure_board_caller(&app, &window)?`，只服务当前登录 Board origin。
- 本地登录页 capability（`capabilities/main.json`）不得包含远程 Board 专用命令。
- 静态契约测试要求：权限标识、`commands.allow`、capability 白名单、`main.rs` 注册、命令实现与 `ensure_board_caller` 成对出现（参考 `packages/desktop/test/desktop-ui-build.test.js` 的 `desktop local plugin commands stay board-only and lazy`）。

## 3. 插件任务写入边界（`.trellis/spec/backend/plugin-runtime.md`）

原文位置：`plugin-runtime.md:160-170`。

- 插件不直接接触 SQLite 或 task.py；任务写入统一走 `actions.js` / `metadata.js`。
- 现有描述「插件任务的宿主调用依赖 `python`；`packages/server/actions.js` 已回退到 `python3`」不完整：回退只在 `ENOENT` 生效，且未使用 `client.json` 记录的解释器。本次需要更正。

## 4. 质量门（`.trellis/spec/backend/quality-guidelines.md`）

- 自动测试：`yarn test`（`packages/*/test` + `scripts/test`，不含 `plugins/`）。
- 插件测试：`yarn test --scope=plugins`；宿主+插件联调用 `--scope=all`。
- CI 前需 `yarn install --immutable`；真实 Trellis CLI 测试依赖根目录固定版本依赖。
