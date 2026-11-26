# 设计：切换服务器地址时备份并清理客户端数据

## 1. 边界与现状

| 事实 | 位置 |
| --- | --- |
| 退出登录只清密码，保留 `server_url` / `username` | `packages/desktop/src-tauri/src/main.rs:270` |
| 登录命令与保存配置 | `main.rs:425`（`desktop_login`） |
| `force_new` 只决定设备会话新建/复用 | `main.rs:441` → `agent_service::login` |
| data 目录 | `packages/desktop/src-tauri/src/config.rs:27` |
| Agent 数据（凭证/绑定/游标/hooks/日志） | `config::agent_root()` = `<data>/agent` |
| 按服务器+用户隔离的插件数据 | `plugin_host::scope_dir` = `<data>/desktop-plugins/<serverHash>/<user>`（`plugin_host.rs:150`） |
| 运行环境 | `<data>/runtime`、`<data>/npm-global`（`agent/env.rs:68`） |
| 本地插件目录（用户本地安装，非服务器隔离） | `<data>/plugins`（`plugin_host.rs:246`） |
| 外观设置 | `<data>/appearance.json`（`appearance.rs:57`） |
| 桌面日志 | `<data>/logs`（`config::logs_dir()`） |
| 本地登录页 capability | `capabilities/main.json`（仅 `app_status` / `runtime_*` / `desktop_login` 等） |

结论：清理逻辑必须放在 Rust 侧（前端没有文件系统权限），且只删「登录 + 绑定」三类路径，`client.json` 需要按「删除后由登录流程重建」处理。

## 2. 方案总览

```
LoginApp 提交
   │  ① desktop_login_preflight(serverUrl)
   ▼
Rust: 归一化地址 → requiresReset?
   │  否 → ② desktop_login(..., switchServer=false)
   │  是 → 前端 ConfirmDialog
   │         取消 → 结束，不改任何文件
   │         确认 → ② desktop_login(..., switchServer=true)
   ▼
desktop_login：
   agent_service::stop → plugin_host::stop（仅切换分支）
   ③ client_reset::backup_and_clear(data_dir)
        备份 → <LocalAppData>/TrellisBoard/data-backup-<ts>/
        清理 → client.json / agent/ / desktop-plugins/
        保留 → runtime/ npm-global/ updates/ plugins/ appearance.json logs/ update-state.json
   ④ agent_service::login（新服务器）
        失败 → client_reset::restore(backup_dir) 并返回错误
        成功 → ⑤ config::save（用切换前的 runtime 标记）
```

要点：
- **判定放在 Rust**：归一化只实现一次，复用 `navigation::validate_board_url` + `navigation::board_server_url`（已处理协议/主机大小写、默认端口、尾部斜杠、子路径），前端不重复实现比较逻辑。
- **命令内二次校验**：`desktop_login` 增加 `switch_server: Option<bool>`；地址变化但未显式传 `true` 时直接报错，防止前端漏调 preflight 造成静默清库。
- **备份/清理合并为一个原子操作**：`client_reset::backup_and_clear` 先完整复制，再删除；复制失败不删除。

## 3. 新增模块 `packages/desktop/src-tauri/src/client_reset.rs`

纯文件系统逻辑，不依赖 tauri，便于单测（测试直接传临时目录，不碰 `TRELLIS_DESKTOP_HOME`）。

```rust
pub const BACKUP_PREFIX: &str = "data-backup-";
pub const KEEP_BACKUPS: usize = 3;

/// 清理项相对 data_dir 的路径：固定顺序，避免遍历误删。
pub const RESET_ITEMS: [&str; 3] = ["client.json", "agent", "desktop-plugins"];

pub struct ResetOutcome {
    pub backup_dir: PathBuf,
    pub removed: Vec<PathBuf>,
}

/// 服务器地址是否发生切换（previous 为空表示首次登录）。
pub fn server_switched(previous: Option<&str>, next: &str) -> bool;

/// 备份根目录：data_dir 的父目录（Windows 即 %LOCALAPPDATA%\TrellisBoard）。
pub fn backup_root(data_dir: &Path) -> PathBuf;

/// 备份时间戳：本地时间 yyyyMMdd-HHmmss，冲突时追加 -2/-3。
pub fn backup_dir_name(now: DateTime<Local>) -> String;

/// 备份 + 清理；任一备份失败都会回滚已产生的备份残留并返回错误。
pub fn backup_and_clear(data_dir: &Path, now: DateTime<Local>) -> Result<ResetOutcome, String>;

/// 用备份恢复（登录失败时调用）：先删除现存同名项，再从备份复制回来。
pub fn restore(outcome: &ResetOutcome) -> Result<(), String>;

/// 只保留最近 keep 份 data-backup-*（按目录名倒序即时间倒序）。
pub fn prune_backups(root: &Path, keep: usize);
```

实现细节：
- 复制：`copy_dir_all` 递归 `std::fs::create_dir_all` + `copy`；不跟随符号链接（`metadata.is_dir()` 判断即可，客户端目录不存在链接）。
- 备份范围只包含 `RESET_ITEMS` 中**实际存在**的项，缺失项跳过（首次登录后可能没有 `desktop-plugins`）。
- 删除：`remove_file` / `remove_dir_all`，带 5 次 50ms 重试（复用 `store.rs:14` 的退避思路），失败时把已删除项从备份恢复后返回错误。
- 保留策略在备份成功后执行；`prune` 失败只记日志，不影响登录（用户数据已经安全）。
- 时间戳用 `chrono::Local`；`chrono` 已是现有依赖（`Cargo.toml`）。

## 4. 命令契约

### 4.1 `desktop_login_preflight`

```rust
#[tauri::command]
async fn desktop_login_preflight(
    app: AppHandle,
    window: WebviewWindow,
    server_url: String,
) -> Result<LoginPreflight, String>
```

```jsonc
// LoginPreflight
{
  "requiresReset": true,
  "previousServerUrl": "https://old.example.com",   // 首次登录为 null
  "backupRoot": "C:\\Users\\<user>\\AppData\\Local\\TrellisBoard"
}
```

- `ensure_local_caller(&window)?`，只给本地登录页。
- `validate_board_url` 失败时直接返回中文错误（与 `desktop_login` 的校验一致）。
- `requiresReset = server_switched(previous, normalized)`；`previous` 取 `config::load()` 的 `server_url`，空白视为首次登录。

### 4.2 `desktop_login` 签名变化

```rust
async fn desktop_login(
    app: AppHandle,
    window: WebviewWindow,
    server_url: String,
    username: String,
    password: String,
    switch_server: Option<bool>,   // 新增，缺省 false
) -> Result<DesktopLoginResult, String>
```

流程改动（相对 `main.rs:425` 现有实现）：

1. 校验地址/账号/密码后，先算出 `normalized`、`previous`、`switched`。
2. `switched && switch_server != Some(true)` → `Err("服务器地址已变更，需要先确认清理旧服务器的登录数据")`（前端正常路径不会走到）。
3. `agent_service::stop(&app)` 后，若是切换分支：`plugin_host::stop(&app).await`（现有登录流程只在退出登录时停插件宿主，这里必须显式停，避免插件宿主占用 `desktop-plugins/`），再 `client_reset::backup_and_clear(&config::data_dir(), Local::now())?`。
4. `agent_service::login(...)` 失败时，若第 3 步执行过则 `client_reset::restore(&outcome)`；登录成功后的
   令牌校验、写会话 Cookie、写 `client.json` 失败同样回滚。恢复失败时记录原因，错误文案给出备份目录名
   （日志与错误消息不输出绝对路径，见 `desktop-agent-runtime` §4）。
5. 成功后 `config::save` 的 `node_runtime` / `trellis_runtime` / `python_runtime` 改用**切换前**读到的 `previous`（现在 `previous_config = config::load()` 会得到 `None`，否则运行环境标记丢失，下次要重新下载 Node/Trellis）。非切换路径行为不变。
6. 成功后 `client_reset::prune_backups(...)`，只保留 3 份。

## 5. 前端改动

`packages/web/src/desktop/LoginApp.tsx`：
- `submitLogin` 增加前置步骤：`invoke('desktop_login_preflight', { serverUrl })`。
  - 自动登录分支（`automatic=true`，冷启动带完整凭据）也走 preflight；地址必然相同，返回 `requiresReset=false`，无额外弹窗。
  - `requiresReset=true` 时调用 `useConfirm()`，文案（`tone: 'danger'`）：
    - 标题：`切换服务器将清除本地数据`
    - 正文：`从 <原地址> 切换到 <新地址>。\n切换会清除旧服务器的登录数据与项目绑定数据（设备凭证、项目绑定、同步记录、插件配置）。\n确认前会先备份到 <backupRoot>，保留最近 3 份。`
    - 确认按钮：`切换并清除`；取消按钮：`取消`。
  - 取消 → `setSubmitting(false)`，不改文件、不发登录请求。
  - 确认 → `invoke('desktop_login', { ..., switchServer: true })`。
- preflight 本身失败（地址非法等）→ 直接展示错误，不进弹窗。

`packages/web/src/desktop/main-index.tsx`：在 `LoginApp` 外层加 `ConfirmDialogProvider`（复用 `packages/web/src/components/ui/confirm-dialog.tsx`，无新依赖）。不使用完整 `AppProviders`，避免把 Toaster/Tooltip 带进登录页。

## 6. 权限与注册

- `permissions/desktop.toml` 新增：

```toml
[[permission]]
identifier = "allow-desktop-login-preflight"
description = "仅本地登录页在提交登录前检查服务器地址是否发生变化。"
commands.allow = ["desktop_login_preflight"]
```

- `capabilities/main.json` 增加 `allow-desktop-login-preflight`。
- `capabilities/board-local-association.json` **不增加**（远程 Board 不得触发数据清理）。
- `main.rs` 的 `generate_handler!` 注册新命令。

## 7. 兼容性

- 桌面 UI 与客户端同一安装包发布（`tauri.conf.json` `frontendDist: ../ui`），`switch_server` 参数与 preflight 命令同批上线；旧 UI 遇到新客户端时，切换地址会收到「需确认」错误而无法登录——这是有意的保护，不做旧行为兼容。
- 非切换路径（首次登录、地址未变）命令行为完全不变，`switch_server` 缺省为 `false`。

## 8. 风险与取舍

| 风险 | 处理 |
| --- | --- |
| 备份占用磁盘（含 Agent 日志、插件配置） | 只备份登录/绑定三类路径，不含 `runtime/`（数百 MB）；保留 3 份 |
| `client.json` 内含明文密码，备份同样含明文 | 备份目录与 data 同级、同在用户目录下，权限一致；不额外加密，日志脱敏不变 |
| 备份后登录失败导致旧数据丢失 | 自动从备份恢复（`restore`），并提示；恢复失败给出备份路径 |
| 文件被占用导致删除失败 | 先停 Agent 与插件宿主，删除带重试；失败时恢复已删项并报错 |
| 运行环境标记随 `client.json` 删除而丢失 | 用切换前的配置值写回；即便丢失，`env::probe` 会从 `<data>/runtime/node/node.exe` 与 PATH 重新探测（`agent/env/probe.rs:531`） |
| 用户手工误删 backup 目录 | 不在本次范围；目录名带时间戳，便于识别 |

## 9. 测试策略

Rust（`client_reset/tests.rs`，临时目录 + `uuid`）：
- `server_switched`：首次登录、相同地址（尾斜杠、大小写）、不同端口、不同子路径。
- `backup_and_clear`：只备份并删除 `RESET_ITEMS`；`runtime/`、`updates/`、`plugins/`、`appearance.json`、`logs/` 保留；缺失项跳过。
- 备份失败（目标位置同名文件占位）→ 源数据完整、无残留。
- `restore`：删除后恢复，内容与时间无关的逐字节一致。
- `prune_backups`：4 份目录保留 3 份，删除最旧。

JS 静态契约（`packages/desktop/test/`）：
- `capabilities/main.json` 含 `allow-desktop-login-preflight`，`board-local-association.json` 不含。
- `permissions/desktop.toml` 声明该 permission，`main.rs` 注册了命令。
- `LoginApp.tsx` 在调用 `desktop_login` 前调用 `desktop_login_preflight`，且取消路径不调用登录。

验证命令（本机无 Rust 工具链，`cargo test` 只能在 CI 跑，不得声称本地通过）：
- `yarn test --scope=desktop`
- `yarn test --scope=lint`
- 全部开发完成后执行一次 `node scripts/build.mjs --target=desktop-ui` 验证前端可编译。

## 10. 回滚

- 代码回滚：整体 revert 本次提交即可，无数据迁移、无 schema 变更（`ClientConfig` schema 不变）。
- 数据回滚：`data-backup-*` 目录保留在 `<LocalAppData>/TrellisBoard/` 下，用户可手工复制回 `data/`。
