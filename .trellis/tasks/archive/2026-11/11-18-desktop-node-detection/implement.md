# Implement — 客户端 Node.js 环境检测与手动路径配置

## 已读上下文

- 设计：`design.md`
- 规范：`.trellis/spec/backend/desktop-agent-runtime.md`（环境门、client.json schema 3、验证命令）、`.trellis/spec/desktop/tauri-commands/index.md`（命令/权限/capability 三处一致）
- 现状代码：`packages/desktop/src-tauri/src/config.rs`、`agent/env/{probe,install,tests}.rs`、`runtime_commands.rs`、`main.rs`、`packages/web/src/desktop/LoginApp.tsx`

## 实施清单

### 批次 1：配置持久化修复（独立可回滚）

- [ ] `packages/desktop/src-tauri/src/config.rs`
  - `ClientConfig.schema_version` 加 `#[serde(alias = "schema_version")]`。
  - `server_url` 加 `#[serde(default)]`。
  - 新增 `python_runtime: Option<serde_json::Value>`，序列化名 `python_runtime`，别名 `pythonRuntime`，`default`。
- [ ] `packages/desktop/src-tauri/src/agent/env/install.rs:593`
  - `document.insert("schema_version", ...)` 改为 `"schemaVersion"`。
- [ ] `packages/desktop/src-tauri/src/main.rs:405-430`
  - `config::save` 的 `ClientConfig` 字面量补 `python_runtime: previous_config.as_ref().and_then(|v| v.python_runtime.clone())`。
- [ ] `packages/desktop/src-tauri/src/config/tests.rs`
  - 所有 `ClientConfig { .. }` 字面量补 `python_runtime`。
  - 新增：snake_case `schema_version` + 无 `serverUrl` 的文件可被 `load()` 读出。
- [ ] `packages/desktop/src-tauri/src/agent/env/tests.rs`
  - 新增：调用 `write_runtime_flags` 后文件含 `schemaVersion`，`config::load()` 返回 `Some` 且三项 flag 完整（使用 `config::test_env_lock()` 与 `TRELLIS_DESKTOP_HOME`）。

### 批次 2：探测增强 + 自愈

- [ ] `packages/desktop/src-tauri/src/agent/env/probe.rs`
  - `fallback_dirs_in`：`app_data/nvm` 下追加 `subdirs(&nvm)`（`v*` 版本目录）；保留 nvm 根。
  - `fallback_dirs`：追加 `NVM_HOME` + 其 `v*` 子目录、`NVM_SYMLINK`、`FNM_DIR`（aliases/node-versions）、`FNM_MULTISHELL_PATH`、`VOLTA_HOME/bin`；复用 `subdirs` 与去重。
  - 提取 `dedupe_dirs(Vec<PathBuf>) -> Vec<PathBuf>`；`probe_dirs()` 改为调用它。
  - 新增 `powershell_exe()`、`where_node_dirs(output: &str)`、`async fn where_node_dirs_fresh()`、`pub(super) async fn probe_dirs_fresh()`。
  - `check`：先 `let dirs = probe_dirs_fresh().await;`，再传给 `resolve_node(data_dir, config, &dirs)` 与 `resolve_trellis(data_dir, config, &dirs)`。
  - `resolve_node`：新增 `data_dir` 与 `dirs` 参数；flag 之后、遍历之前检查 `node_exe_path(data_dir)`，合格则写 flag（`source: "client"`）。
  - `resolve_trellis`：用传入的 `dirs`，删除内部 `probe_dirs()`。
- [ ] `packages/desktop/src-tauri/src/agent/env/install.rs`
  - `install_trellis` 的 `find_in_path(&path_dirs(), "npm.cmd")` 改为 `find_in_path(&probe_dirs_fresh().await, "npm.cmd")`。
- [ ] `packages/desktop/src-tauri/src/agent/env/tests.rs`
  - 更新 `fallback_dirs_cover_version_manager_prefixes`：增加 `app_data/nvm/v24.22.3` 断言。
  - 新增 `where_node_dirs_parses_paths`、`where_node_dirs_ignores_noise`。
  - 新增 `client_runtime_node_self_heals`：临时 data_dir 下放一个可执行的假 `node.exe` 不现实，改为断言候选列表包含 `node_exe_path(data_dir)` 的自愈顺序由 `resolve_node` 覆盖——若无法稳定构造，拆出 `client_runtime_candidate(data_dir)` 纯函数单测。

### 批次 3：手动指定 node.exe

- [ ] `packages/desktop/src-tauri/src/agent/env.rs`
  - 新增 `pub const CODE_NODE_PATH_INVALID: &str = "NODE_PATH_INVALID";`
- [ ] `packages/desktop/src-tauri/src/agent/env/probe.rs`
  - 新增 `fn node_executable_from_input(input: &str) -> Option<PathBuf>`。
  - 新增 `pub async fn set_node_path<C: ClientConfigLike>(config: &mut C, input: &str) -> AgentResult<NodeStatus>`：校验文件/版本，成功后写 `NodeRuntimeFlag { source: "manual" }`。
- [ ] `packages/desktop/src-tauri/src/runtime_commands.rs`
  - 新增 `pub async fn runtime_set_node_path(path: String) -> Result<RuntimeStatus, String>`：`set_node_path` → `check` → `save_client_document`。
- [ ] `packages/desktop/src-tauri/src/main.rs`
  - 新增 `#[tauri::command] async fn runtime_set_node_path(window: WebviewWindow, path: String)`，`ensure_local_caller` 后转调；加入 `generate_handler!`。
- [ ] `packages/desktop/src-tauri/permissions/desktop.toml`
  - 新增 `allow-runtime-set-node-path`，`commands.allow = ["runtime_set_node_path"]`。
- [ ] `packages/desktop/src-tauri/capabilities/main.json`
  - `permissions` 增加 `allow-runtime-set-node-path`。
- [ ] `packages/web/src/desktop/LoginApp.tsx`
  - `RuntimeStatus.node` 补 `path/foundVersion/source`。
  - 新增 `nodePath`/`savingNodePath`/`nodePathError` 状态与 `applyNodePath`。
  - 环境卡片内、主错误之后渲染手动路径表单（`node.ok !== true` 且非安装中）。
  - 提交成功 `applyRuntime(status)`；失败写入 `nodePathError`。
- [ ] `packages/desktop/src-tauri/src/agent/env/tests.rs`
  - 新增 `manual_node_path_parses_file_dir_and_quotes`、`manual_node_path_rejects_empty_and_missing`。
  - `set_node_path` 的错误路径单测可用不存在的文件，避免依赖真实 node。

### 批次 4：规范更新

- [ ] `.trellis/spec/backend/desktop-agent-runtime.md` 第 3 节
  - Node 查找顺序改为：flag → `<data>/runtime/node/node.exe` → PATH/版本管理器前缀（含 nvm `v*`、`FNM_DIR`、`NVM_HOME`、`NVM_SYMLINK`、`FNM_MULTISHELL_PATH`、`VOLTA_HOME`）→ PowerShell 刷新 PATH 后 `where.exe node` → 手动指定。
  - 增加 `client.json` 键名契约：`schemaVersion`（camelCase），接受旧 `schema_version`；flag 仍 snake_case。
  - 增加手动路径命令与权限说明。

## 验证命令（全部在仓库根执行）

```powershell
cargo fmt --manifest-path packages/desktop/src-tauri/Cargo.toml --check
cargo clippy --manifest-path packages/desktop/src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml
yarn test
yarn workspace @trellis-board/web build:desktop   # tsc -b + vite 构建登录壳
```

frontend 改动后额外：

```powershell
yarn workspace @trellis-board/web lint
yarn oxfmt --check packages/web/src/desktop/LoginApp.tsx
```

## 关键验证场景（手工）

1. 清空 `client.json` → 启动客户端 → 环境门安装 → 检查文件含 `schemaVersion` 与 `node_runtime` → 登录 → 再检查三项 flag 仍在。
2. 删除 `node_runtime` 但保留 `<data>/runtime/node/node.exe` → 启动 → 环境门自动就绪。
3. 删除 `node_runtime`，仅 `%APPDATA%\nvm\vX\node.exe` 可用 → 环境门识别。
4. 客户端运行中把新 Node 目录追加到用户 PATH → 点“重新检查” → 识别。
5. Node 不可用时输入目录与带引号 exe → 成功；输入不存在路径 → 显示 `NODE_PATH_INVALID` 且不覆盖原 flag。

## 风险与回滚点

- 每个批次单独提交；批次 1 可独立 revert 而不影响探测改动。
- 权限三处（main.rs、desktop.toml、capabilities）必须同批提交，否则 `desktop-ui-build.test.js` 或运行时拒绝调用。
- `probe_dirs_fresh` 引入 PowerShell 子进程：若 CI 环境无 PowerShell，函数静默返回静态候选，测试不应断言非空动态结果。
- `config::load` 放宽后，登录流程的 `force_new` 依赖空 `serverUrl`，需在批次 1 的测试中保留覆盖。
