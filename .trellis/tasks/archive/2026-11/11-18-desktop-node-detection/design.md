# Design — 客户端 Node.js 环境检测与手动路径配置

## 1. 配置持久化契约

`client.json` 是唯一事实来源，但存在三条写路径，必须统一：

| 写路径 | 位置 | 现状 | 变更 |
|---|---|---|---|
| 环境门原始 JSON 合并 | `packages/desktop/src-tauri/src/agent/env/install.rs:581` `write_runtime_flags` | 写 `schema_version`，可能无 `serverUrl` | 写 `schemaVersion`；保留文件里已有字段 |
| 运行时状态原始 JSON 合并 | `packages/desktop/src-tauri/src/runtime_commands.rs` `runtime_status` / `runtime_install` | 写 `schemaVersion` | 不变；复用同一常量 |
| 类型化保存 | `packages/desktop/src-tauri/src/config.rs:76` `save` | 只序列化 `ClientConfig` 已知字段 | `ClientConfig` 补齐 `python_runtime`，登录时三项 flag 全量传递 |

`ClientConfig`（`config.rs:10`）调整：

```rust
pub struct ClientConfig {
    #[serde(alias = "schema_version")]
    pub schema_version: u32,
    #[serde(default)]
    pub server_url: String,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub password: Option<String>,
    #[serde(rename = "node_runtime", alias = "nodeRuntime", default)]
    pub node_runtime: Option<serde_json::Value>,
    #[serde(rename = "trellis_runtime", alias = "trellisRuntime", default)]
    pub trellis_runtime: Option<serde_json::Value>,
    #[serde(rename = "python_runtime", alias = "pythonRuntime", default)]
    pub python_runtime: Option<serde_json::Value>,
}
```

关键点：

- `schema_version` 的 `alias` 让旧安装文件可读；序列化仍为 `schemaVersion`。
- `server_url` 默认空串只解决“登录前文件缺地址”的解析失败。登录结果仍写真实地址；`desktop_login` 的 `force_new = previous.server_url != server_url` 在空串时与旧行为（`previous=None`）一致，均为 true。
- 登录保存（`main.rs:405-430`）增加 `python_runtime` 复制；三项 flag 从同一个 `previous_config` 读取。
- `install.rs::write_runtime_flags` 的合并逻辑改为先读原始 JSON，再 `insert("schemaVersion")`；不覆盖 `serverUrl`、账号、其他 flag。
- 新增常量可放在 `config.rs`（`SCHEMA_VERSION` 已存在），避免两处魔法数字。

不做“配置迁移器”：schema 3 内只修键名与缺省，旧 snake_case 键通过 serde alias 兼容，无需重写文件。

## 2. 探测流程

### 2.1 候选目录来源（按优先级）

1. `config.node_runtime` flag 指向的 `node.exe`（含手动指定）。文件存在即用，版本不合格则报“版本过低”，不清 flag（避免用户手动指定被一次失败探测抹掉）。
2. 客户端私有运行时 `<data>/runtime/node/node.exe`（自愈）。
3. 静态候选（同步、无子进程）：
   - 进程 `PATH`（`path_dirs()`）。
   - `%APPDATA%\fnm\aliases\*`、`%APPDATA%\fnm\node-versions\*\installation`。
   - `%APPDATA%\nvm` 根目录 + `%APPDATA%\nvm\v*` 版本目录。
   - `NVM_HOME` 根目录 + 其 `v*` 版本目录、`NVM_SYMLINK`。
   - `FNM_DIR` 下的 aliases / node-versions；`FNM_MULTISHELL_PATH`。
   - `VOLTA_HOME\bin`、`%LOCALAPPDATA%\Programs\nodejs`、`%LOCALAPPDATA%\Volta\bin`、`%ProgramFiles%\nodejs`。
4. 动态候选（异步）：PowerShell 刷新 PATH 后执行 `where.exe node`，取每个输出的父目录。

去重按 `PathBuf` 精确匹配，保留首次出现顺序。

### 2.2 刷新 PATH 的实现

`probe.rs` 新增：

```rust
const WHERE_NODE_TIMEOUT: Duration = Duration::from_secs(15);

fn powershell_exe() -> Option<PathBuf>;              // %SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe，缺失时退回 "powershell.exe"
fn where_node_dirs(output: &str) -> Vec<PathBuf>;    // 纯解析，可单测
async fn where_node_dirs_fresh() -> Vec<PathBuf>;

pub(super) fn dedupe_dirs(dirs: Vec<PathBuf>) -> Vec<PathBuf>;
pub(super) fn probe_dirs() -> Vec<PathBuf>;          // 静态候选
pub(super) async fn probe_dirs_fresh() -> Vec<PathBuf>; // probe_dirs() + where_node_dirs_fresh()
```

PowerShell 参数（直接 `Command` 传参，不经 shell）：

```text
powershell.exe -NoProfile -NonInteractive -Command
$env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User'); where.exe node
```

- 用 `run_process`，`ProcessOptions { timeout: Some(15s), max_output_bytes: 64 * 1024, ..Default }`。
- 仅解析 `stdout` 的每一行：`trim()`、去首尾引号、`Path::new(line).file_name()` 等于 `node.exe`（忽略大小写）才取父目录；重复去重。
- `run_process` 错误（PowerShell 不存在、超时、启动失败）一律返回空 `Vec`，由静态候选继续兜底；不向 UI 报错。
- 该调用只在 `check()` 与 `install_trellis` 的 npm 查找时发生，每次 `runtime_status` 最多一次。

### 2.3 `check` 单次探测

```rust
pub async fn check<C: ClientConfigLike>(data_dir: &Path, config: &mut C) -> AgentResult<RuntimeStatus> {
    let dirs = probe_dirs_fresh().await;
    let node = resolve_node(data_dir, config, &dirs).await;
    let trellis = resolve_trellis(data_dir, config, &dirs).await;
    let python = resolve_python(config).await;
    ...
}
```

`resolve_node` / `resolve_trellis` 增加 `data_dir`（后者已有）与 `dirs: &[PathBuf]` 参数，删除函数内部各自的 `probe_dirs()` 调用，避免 Node 与 Trellis 各启动一次 PowerShell。`install_trellis` 的 `find_in_path(&probe_dirs_fresh().await, "npm.cmd")` 同步更新。

`resolve_node` 的私有路径只被 `check` 调用，签名变更是内部重构，无外部调用方。

### 2.4 自愈

`resolve_node` 在 flag 不存在时：

```
node_exe_path(data_dir) 存在 → node_version_at → 合格则写 flag（source "client"）并返回
否则遍历 dirs
```

flag 存在但文件被删：清除 flag 后继续上述流程（现状保留）。flag 存在但版本过低：返回“版本过低”，不自动替换，避免用户手动锁定被绕过；UI 的手动入口此时可见。

## 3. 手动指定 node.exe

### 3.1 纯逻辑

`probe.rs` 新增：

```rust
fn node_executable_from_input(input: &str) -> Option<PathBuf>;
pub async fn set_node_path<C: ClientConfigLike>(config: &mut C, input: &str) -> AgentResult<NodeStatus>;
```

`node_executable_from_input`：

- `trim()`，去首尾 `"` 与 `'`。
- 空串 → `None`。
- 目录 → 拼接 `node.exe`；文件 → 原样；最终要求 `is_file()`。
- 不解析 `~`、不展开环境变量（Windows 路径输入框不承诺 shell 语义）。

`set_node_path`：

1. 解析失败 → `AgentError::new(CODE_NODE_PATH_INVALID, "未找到 node.exe：<input>")`。
2. `node_version_at(&exe).await` 为 `None` → `CODE_NODE_PATH_INVALID`「无法执行该 node.exe，请确认路径正确」。
3. 版本低于 `NODE_MIN_VERSION` → 错误信息包含实际版本与最低版本。
4. 写 `NodeRuntimeFlag { version, path, source: "manual", installed_at: now_iso8601() }`，返回 `NodeStatus { ok: true, source: "manual", .. }`。
5. 失败路径不修改 config，已有 flag 不受影响。

新增错误码：`CODE_NODE_PATH_INVALID = "NODE_PATH_INVALID"`（`env.rs` 常量区）。

### 3.2 Tauri 命令

`runtime_commands.rs`：

```rust
pub async fn runtime_set_node_path(path: String) -> Result<RuntimeStatus, String> {
    let data_dir = config::data_dir();
    let mut document = load_client_document();
    env::set_node_path(&mut document, &path).await.map_err(|e| e.message)?;
    let status = env::check(&data_dir, &mut document).await.map_err(|e| e.message)?;
    save_client_document(&document)?;
    Ok(status)
}
```

先写 flag 再 `check`：`check` 会直接复用刚验证过的 flag，不会重复跑版本探测；若保存失败返回错误，但 flag 只在文档内，不落盘。

`main.rs`：

```rust
#[tauri::command]
async fn runtime_set_node_path(window: WebviewWindow, path: String)
    -> Result<agent::env::RuntimeStatus, String> {
    ensure_local_caller(&window)?;
    runtime_commands::runtime_set_node_path(path).await
}
```

并加入 `tauri::generate_handler![...]` 列表。

权限：

- `permissions/desktop.toml` 新增 `allow-runtime-set-node-path`，`commands.allow = ["runtime_set_node_path"]`，描述限定“本地登录页可为运行时检查手动指定 node.exe”。
- `capabilities/main.json` 的 `permissions` 增加该标识。仅 `main` capability 生效，远程 Board capability 不授予。

### 3.3 环境门 UI

`packages/web/src/desktop/LoginApp.tsx`：

- `RuntimeStatus.node` 类型补 `path?: string; source?: string; foundVersion?: string`（当前只有 `ok/version`）。
- 新增状态：`nodePath`、`savingNodePath`、`nodePathError`。
- 在 `env` 卡片内、错误提示之后、按钮组之前，当 `node.ok !== true` 时渲染：

```tsx
<form onSubmit={...}>
  <Label htmlFor="node-path">手动指定 Node.js 路径</Label>
  <Input id="node-path" placeholder={'C:\\Program Files\\nodejs\\node.exe'} value={nodePath} ... />
  <Button type="submit" size="sm" variant="outline" disabled={savingNodePath}>使用此路径</Button>
</form>
<p className="text-xs text-muted-foreground">
  支持 node.exe 或安装目录；留空时可继续使用“安装运行环境”。
</p>
```

- 提交调用 `invoke<RuntimeStatus>('runtime_set_node_path', { path: nodePath })`，随后 `applyRuntime(status)`；成功时清空 `nodePathError`。
- 失败用 `errorMessage(error, '无法使用该 Node.js 路径')` 写入 `nodePathError`，`role="alert"`，不影响主 `envError`。
- 只在 `needs_setup` 或 `failed` 且 Node 不可用时显示，避免环境已就绪时出现多余控件。安装进行中（`installing`）隐藏。

## 4. 测试设计

Rust（`packages/desktop/src-tauri/src/agent/env/tests.rs`、`config/tests.rs`）：

| 测试 | 断言 |
|---|---|
| `nvm_version_dirs_are_probed` | `fallback_dirs_in` 结果包含 `app_data/nvm/v24.22.3`，且仍包含 `nvm` 根 |
| `where_node_output_yields_parent_dirs` | 多行、带引号、空白行、非 node.exe 行混合时只取合法父目录并去重 |
| `manual_node_path_accepts_file_dir_and_quotes` | `node_executable_from_input` 对目录、exe、带引号 exe 返回同一路径；空串/不存在返回 None |
| `runtime_flags_round_trip_through_config_load` | `write_runtime_flags` 写出的文件（无 `serverUrl`）可被 `config::load()` 读出，三项 flag 均存在，键为 `schemaVersion` |
| `legacy_schema_snake_case_key_is_accepted` | 手写 `{"schema_version":3,...}` 可解析 |
| `config_round_trips_with_remembered_credentials`（改） | 结构体字面量补 `python_runtime: None`，并可额外断言 python flag 保留 |

`config::load()` 使用真实路径与 `TRELLIS_DESKTOP_HOME`，沿用 `config::test_env_lock()`；写 flags 的测试也需持有同一把锁，避免并行测试互删目录。

Web：`yarn test` 现有静态测试已断言 capabilities/permissions，新增命令后若缺声明会失败；无需新增 DOM 测试（环境门无现成组件测试设施）。

文档：更新 `.trellis/spec/backend/desktop-agent-runtime.md` 的“环境门查找顺序”章节，写明 flag → 客户端运行时 → PATH/版本管理器 → PowerShell where → 手动路径，以及 `client.json` 的 camelCase/snake_case 契约。

## 5. 兼容性、回滚与风险

- 文件兼容：只加 serde alias/default 与新字段；旧客户端写出的 `schema_version` 文件仍可读；新客户端写出的 `schemaVersion` 旧客户端无法解析（旧版本会视为无配置并重走环境门），属于单向升级，不影响本任务验收。
- 行为兼容：自动探测只在原有候选之后追加，不改变已能成功的机器；PowerShell 失败静默降级。
- 性能：每次 `runtime_status` 增加一次 PowerShell 启动（约 100–400ms），登录页已有“正在检查”状态；无高频调用点。
- 回滚：按提交拆分为“配置持久化修复”“探测增强”“手动路径”三次提交；任一批可独立 revert。手动路径命令涉及权限文件，回滚时三处一起删。
- 风险：`where.exe` 可能返回 Microsoft Store 的 `WindowsApps\node.exe` 占位符；`node --version` 会失败并被跳过，不影响其他候选。
