# PRD — 客户端 Node.js 环境检测与手动路径配置

## Goal

让桌面客户端在 Node.js 由 nvm / fnm / Volta 或自定义目录安装、且客户端进程启动后 `PATH` 未刷新时，仍能正确识别可用的 `node.exe`；并为完全无法自动识别的场景提供手动指定入口。同时修复“环境门检测成功后，登录/重启仍提示 Node 环境未就绪”的配置丢失缺陷。

## 背景与证据

### 缺陷 1：环境门写出的 flags 在登录时被清空（主诉根因）

1. `packages/desktop/src-tauri/src/agent/env/install.rs:581` 的 `write_runtime_flags` 在 `:593` 执行 `document.insert("schema_version", json!(3))`（snake_case）。
2. `packages/desktop/src-tauri/src/config.rs:10` 的 `ClientConfig` 使用 `#[serde(rename_all = "camelCase")]`，只接受 `schemaVersion`；`server_url` 又是无默认值的 `String`。环境门安装在登录前，此时 `client.json` 没有 `serverUrl`，于是 `config::load()`（`:53`）反序列化失败并返回 `Ok(None)`。
3. `packages/desktop/src-tauri/src/main.rs:405-430` 的 `desktop_login` 用 `previous_config = config::load().ok().flatten()` 取旧 flags；load 为 `None` 时把 `node_runtime` / `trellis_runtime` 写成 `None`，登录后的 `client.json` 因此丢掉全部运行时 flag。
4. `packages/desktop/src-tauri/src/agent_service.rs:724-750` 的 `trellis_runtime()` 只认配置里的 flag，缺失即报 `CONFIG_MISSING`「Node.js 运行环境未就绪，请先在登录页完成环境检查」/「Trellis CLI 未就绪…」。用户看到的现象是：环境门通过 → 登录 → 接入本地 Git 项目仍提示 Node 环境问题；重启后环境门再次探测 nvm 路径并写入 flag，登录又清空，循环复现。
5. `ClientConfig` 没有 `python_runtime` 字段，`config::save` 同样会丢 Python flag，而 `packages/desktop/src-tauri/src/agent/task_command.rs:765` 读取 `document.python_runtime()`。

### 缺陷 2：自动探测覆盖不到 nvm / 自定义路径 / 新装 PATH

`packages/desktop/src-tauri/src/agent/env/probe.rs`：

- `fallback_dirs_in`（`:29`）只把 `%APPDATA%\nvm` 根目录加入候选；nvm-windows 的 `node.exe` 实际在 `%APPDATA%\nvm\vX.Y.Z\node.exe`，根目录本身没有可执行文件。
- 未读取 `NVM_HOME`、`NVM_SYMLINK`、`FNM_DIR`、`FNM_MULTISHELL_PATH`、`VOLTA_HOME` 等版本管理器环境变量。
- `path_dirs()`（`:5`）只取进程启动时的 `PATH` 快照。用户在客户端运行期间安装 Node 或修改 PATH 后，必须重启客户端才可能被发现。
- 不探测客户端自己的 `<data>/runtime/node/node.exe`，flag 丢失后无法自愈。

### 缺陷 3：没有手动兜底

`packages/web/src/desktop/LoginApp.tsx` 的环境门在 `needs_setup` 时只提供“安装运行环境”；无法把已有的 `node.exe` 指给客户端。

## 需求

### N1 修复 client.json 写入/读取契约

- 环境门写 flags 时使用 camelCase 键 `schemaVersion`；`ClientConfig.schema_version` 同时接受旧文件里的 `schema_version`。
- `ClientConfig.server_url` 缺失时可解析（默认空字符串），使“登录前只有运行时 flag”的文件也能被 `config::load()` 读出。
- `ClientConfig` 增加 `python_runtime`，`desktop_login` 保存配置时保留 `node_runtime` / `trellis_runtime` / `python_runtime` 三项。
- 保持 schema 3 与现有 snake_case flag 结构不变；不得把用户已登录的 `serverUrl` / 账号密码写丢。

### N2 扩展自动探测

- 枚举 nvm 版本目录：`%APPDATA%\nvm\v*`、`%NVM_HOME%\v*`，以及 `NVM_SYMLINK`。
- 读取 `FNM_DIR`、`FNM_MULTISHELL_PATH`、`VOLTA_HOME`，与既有 fnm aliases / node-versions、Volta/bin 候选合并。
- 通过 PowerShell 读取机器级 + 用户级 `Path`（注册表真值），在同一进程内据此执行 `where.exe node`，解析结果加入候选；这样客户端运行期间新装的 Node（写入 PATH）无需重启即可发现。PowerShell 不可用或执行失败时静默退回现有候选，不影响环境检查。
- 候选目录统一去重；`check` 一次探测同时服务 Node、Trellis、npm 查找，避免重复启动 PowerShell。

### N3 客户端私有运行时自愈

- `resolve_node` 在无 flag 时优先检查 `<data>/runtime/node/node.exe`；存在且版本合格则重新写入 flag。
- Trellis 继续优先使用 `<data>/npm-global` 下的客户端私有 CLI。

### N4 手动指定 node.exe 路径

- 新增 Tauri 命令 `runtime_set_node_path`：接受 `node.exe` 文件路径或包含 `node.exe` 的目录；校验文件存在、可执行、版本 `>= 18.17.0`；成功写入 `node_runtime`（`source: "manual"`）并返回最新 `RuntimeStatus`。
- 环境门在 Node 缺失或版本过低时显示“手动指定 Node.js 路径”输入框与提交按钮；支持带引号路径。失败显示具体原因（文件不存在 / 无法执行 / 版本过低），成功后沿用现有 `applyRuntime` 流程进入登录。
- 新命令按既有契约注册：`main.rs` 命令列表、`permissions/desktop.toml` 的 `allow-runtime-set-node-path`、`capabilities/main.json`。

### N5 测试与文档

- Rust 单测覆盖：写 flags 的文件能被 `config::load()` 解析且三项 flag 完整；`schema_version` 旧键兼容；nvm 版本目录枚举；`where.exe` 输出解析；手动路径解析（文件/目录/引号/无效路径）。
- 更新 `.trellis/spec/backend/desktop-agent-runtime.md` 的查找顺序与手动兜底说明。

## Acceptance Criteria

- [ ] 环境门安装完成（登录前）后 `client.json` 含 `schemaVersion: 3` 与 `node_runtime`；`config::load()` 返回 `Some`，不要求文件已有 `serverUrl`。
- [ ] 完成登录后 `client.json` 仍保留 `node_runtime`、`trellis_runtime`、`python_runtime`；重启客户端后接入本地 Git 项目不再出现 `CONFIG_MISSING` 的 Node/Trellis 未就绪提示。
- [ ] `%APPDATA%\nvm\v24.22.3\node.exe`（无 nvm 别名、PATH 未包含该目录）能被自动探测并通过环境门。
- [ ] 客户端运行期间把 Node 安装目录加入用户 PATH，点击“重新检查”即可识别，无需重启客户端。
- [ ] 删除 `client.json` 中的 `node_runtime` 后，若 `<data>/runtime/node/node.exe` 存在且版本合格，环境门自动恢复 flag。
- [ ] 环境门 Node 不满足时，输入 `C:\Program Files\nodejs` 或带引号的 `"C:\Program Files\nodejs\node.exe"` 均能保存并变为可用；输入不存在的路径时展示错误且不污染已有 flag。
- [ ] `cargo fmt --check`、`cargo clippy --all-targets -- -D warnings`、`cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml`、`yarn test` 全部通过。

## 非目标

- 不引入 sidecar、不内置 Node，不改变“缺失时下载便携 Node 到客户端私有目录”的既有策略。
- 不改 nvm / fnm 自身配置，不执行 `nvm use`，不修改用户 PATH。
- 不支持手动指定 Trellis CLI 或 Python（本轮仅 Node；Trellis 仍按 node 前缀 + 客户端私有目录查找）。
- 不改环境门视觉语言、步骤列表与安装按钮行为。
- 不改服务端、Web Board 业务侧代码。

## 约束与风险

- 新增 PowerShell 子进程必须 `-NoProfile -NonInteractive`、隐藏窗口、设置超时；失败不得阻塞环境门。
- `where.exe` 只反映刷新后的 PATH，不覆盖未加入 PATH 的自定义目录，因此仍需手动入口兜底。
- `config::load()` 放宽 `serverUrl` 后，首次登录的 `force_new` 判断依赖空字符串与目标地址不相等，行为需由现有登录测试验证。
- 编辑 `client.json` 的路径有三条（env 原始 JSON、runtime_commands 原始 JSON、config 类型化保存）；任何一条只写部分字段都会重新引入 flag 丢失，测试需覆盖合并而不是整体覆盖。
