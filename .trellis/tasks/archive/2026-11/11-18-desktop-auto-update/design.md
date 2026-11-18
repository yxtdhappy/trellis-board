# 设计与实施边界：客户端自动更新与版本展示

## 1. 总体方案

```mermaid
flowchart LR
  A[构建期 TRELLIS_UPDATE_SERVER] --> B[客户端 Rust update 模块]
  B -->|GET latest.json| C[文件服务器]
  B -->|下载 ZIP + SHA-256| C
  B --> D[替换 EXE + 延迟重启]
  B -->|系统通知 tap| E[Board 更新对话框]
  B -->|托盘 检查更新| E
  F[/api/health version] --> G[TopBar 服务端版本]
  E --> G
```

- 更新逻辑全部在 Rust 侧：构建期注入地址、清单校验、下载、校验、解压、替换、重启、系统通知。
- Board 只做展示与触发：新增 `UpdateDialog`，顶栏版本号可点击，监听通知/托盘事件。
- 服务端只多返回一个 `version`，Web 端用独立 hook 读取。

## 2. 数据契约

### 2.1 `latest.json`（文件服务器）

```json
{
  "version": "0.4.41",
  "file": "TrellisBoard_0.4.41_x64-portable.zip",
  "sha256": "0123…（64 位小写十六进制）",
  "size": 12345678,
  "notes": "本次更新内容，可含换行",
  "publishedAt": "2026-11-18T12:00:00Z"
}
```

校验规则：
- `version` 必须能解析为 `major.minor.patch`，可带一个 `v` 前缀；不接受预发布后缀。
- `file` 必须是非空纯文件名：不含 `/`、`\`，不等于 `.`/`..`，不含控制字符。
- `sha256` 必须正好 64 位十六进制（大小写不敏感，统一转小写比较）。
- `size` 必须为正整数，且与下载字节数一致。
- `notes`、`publishedAt` 可缺省；`notes` 截断到 4000 字符。
- 清单响应限制 64 KiB，超限视为错误。
- ZIP URL = `<base>/<file>`，始终使用基地址 + 文件名，不跟随清单中的绝对路径。

### 2.2 客户端状态（内存 + 缓存）

`UpdateStatus`（camelCase）：

```ts
{
  enabled: boolean
  currentVersion: string
  server: string | null
  latest: { version: string; notes: string; publishedAt: string | null; size: number } | null
  updateAvailable: boolean
  checkedAt: string | null
  error: string | null
}
```

- 进程内 `Mutex<UpdateStatus>` 保存缓存；`update_status` 不发网络请求。
- 通知去重持久化到 `data/update-state.json`：`{ "lastNotifiedVersion": "0.4.41" }`。不写 `client.json`，避免与登录信息写入互相覆盖。

### 2.3 Tauri 命令与事件

| 命令 | 参数 | 返回 | 说明 |
| --- | --- | --- | --- |
| `update_status` | 无 | `UpdateStatus` | 读缓存 |
| `update_check` | 无 | `UpdateStatus` | 强制请求清单，串行化 |
| `update_apply` | 无 | `{ applied: true }` | 下载、校验、替换、安排重启；失败返回错误字符串 |

- 三个命令都调用 `ensure_board_caller`。
- 权限：`allow-update-status`、`allow-update-check`、`allow-update-apply`，加入 `capabilities/board-local-association.json`。
- 事件：
  - `update-status-changed`：payload 为 `UpdateStatus`。
  - `update-progress`：`{ stage: "downloading" | "verifying" | "extracting" | "installing" | "restarting", downloaded: number, total: number }`。
  - `update-open-dialog`：无 payload；通知点击与托盘“检查更新”都发它。
- Board capability 已经有 `core:event:allow-listen` / `allow-unlisten`。

### 2.4 服务端

- `packages/server/index.js` 的 `/api/health` 增加 `version`，读取根 `package.json`（`appDir` 已存在）。
- `packages/server/team/http.js` 的 `/api/health` 增加 `version: readHostVersion()`（已有函数，读根 `package.json`）。
- 根与各 workspace 版本由发版脚本同步，均为 `0.4.x`。

## 3. 客户端模块划分

```
packages/desktop/src-tauri/src/
  update.rs           状态、命令、后台检查、通知、托盘事件（< 500 行）
  update/manifest.rs  清单解析 + 版本比较 + URL 构造
  update/package.rs   下载、哈希、解压、替换、重启
  update/tests.rs     单元测试
```

`main.rs` 只增加：`mod update;`、插件注册、`update::init(...)`、托盘项、`check-update` 分支、三个命令注册。

### 3.1 构建期配置

```rust
pub const UPDATE_SERVER: Option<&str> = option_env!("TRELLIS_UPDATE_SERVER");
```

- `build.rs` 增加 `println!("cargo:rerun-if-env-changed=TRELLIS_UPDATE_SERVER");`
- `enabled()`：地址非空、能解析为 http/https URL；否则 false。
- 未启用时不注册通知、不启动后台循环、托盘项 `set_enabled(false)`。

### 3.2 检查流程

1. `t=5s` 启动首次检查，此后每 6 小时；`update_check` 手动触发。
2. 串行锁避免并发请求；请求 `<base>/latest.json`，15 秒超时。
3. 解析并校验清单；`is_newer(current, latest)` 用三段数字比较。
4. 更新缓存与 `checkedAt`/`error`，发 `update-status-changed`。
5. 若 `updateAvailable` 且 `lastNotifiedVersion != latest.version`：发系统通知；`show()` 成功后写入去重文件。

通知实现：
- `tauri-plugin-notification = "2.8"`（`Notification::on_action` 自 2.6 起提供，MSRV 1.90），`main.rs` 注册 `.plugin(tauri_plugin_notification::init())`；`Cargo.toml` 的 `rust-version` 同步升到 `1.90`。
- `update::init` 中 `app.notification().on_action(...)` 注册一次；`action_id() == "tap"` 时 `focus_main_window` + `emit("update-open-dialog")`。
- 通知必须先注册 handler 再 `show()`，插件才会使用可上报点击的 `show_tracked`；Windows 只在 toast 停留期间上报点击。

### 3.3 下载与安装流程

`update_apply`：

1. 已启用、有 `latest`、非 debug 构建，否则直接报错。
2. `data/updates/<version>/` 作为临时目录；下载到 `<file>.part`，按 256 KiB 块写盘并更新 SHA-256，约每 100ms 发一次进度。
3. 校验字节数与 SHA-256；失败删除临时文件。
4. 解压 ZIP：只接受唯一的 `trellis-board-client.exe`（`enclosed_name` 校验，单文件上限 300 MiB），写到 `staged/trellis-board-client.exe`。
5. 替换：
   - 目标 = `std::env::current_exe()`，目录 = EXE 所在目录。
   - 备份 = `<dir>/trellis-board-client.exe.old`；先尽力删除旧备份。
   - `rename(target, backup)` → `copy(staged, target)`；copy 失败则 `rename(backup, target)` 回滚并返回错误。
6. 启动延迟重启器：`powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -Command "Wait-Process -Id <pid> -Timeout 30 -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 500; Start-Process -FilePath '<exe>' -WorkingDirectory '<dir>'"`，`CREATE_NO_WINDOW`，单引号按 PowerShell 规则转义；等待旧进程真正退出，避免单实例插件提前拦截新实例。
   - 不能直接 `Command::new(exe)`：`tauri-plugin-single-instance` 会让新进程把参数交给旧进程后自行退出。
7. 返回 `{ applied: true }`；500ms 后 `app.exit(0)`，让 IPC 响应先到前端。
8. 下次启动清理：删除 `*.old`、清理 `data/updates/` 下非当前版本的目录（尽力而为，失败只记日志）。

失败矩阵：

| 场景 | 行为 |
| --- | --- |
| 未配置地址 | 命令返回未启用；托盘项禁用；不发请求 |
| 清单 404/超时/JSON 非法 | 保留旧状态，`error` 写原因，界面可重试 |
| 版本不高于本机 | `updateAvailable=false`，无通知 |
| 下载中断/大小不符/哈希不符 | 删除临时文件，返回错误，不触碰 EXE |
| ZIP 中找不到或多个 EXE | 返回错误，不触碰 EXE |
| 改名成功、写入失败 | 原名回滚，返回错误 |
| 重启器启动失败 | 返回错误；EXE 已是新版本，用户下次启动生效 |
| debug 构建 | 拒绝替换 |

## 4. 前端改动

### 4.1 顶栏与服务端版本

- 新增 `packages/web/src/hooks/useServerVersion.ts`：挂载时 `requestJson('/api/health')`，只取 `version`，失败返回空串。
- `BoardPage`：`const serverVersion = useServerVersion()`；新增 `const [updateOpen, setUpdateOpen] = useState(false)`。
- `TopBar` 新增 `serverVersion?: string`、`onOpenUpdate?: () => void`。
- 品牌列改为：外层 `div` 包住现有 `<a>` 与版本行；版本行在客户端时是可点击 `button`（`onOpenUpdate`），否则是只读 `span` 显示服务端版本。避免 `<button>` 嵌在 `<a>` 内。
- `BoardPage` 在桌面环境监听 `update-open-dialog`，收到后 `setUpdateOpen(true)`。

### 4.2 `UpdateDialog`

新文件 `packages/web/src/desktop/UpdateDialog.tsx`：

- Props：`open`、`onOpenChange`、`serverVersion`。
- 打开时先 `update_status`，启用时再 `update_check`；`listen('update-progress')` 只在应用阶段订阅。
- 内容：
  - 三行版本信息：客户端版本 / 服务端版本 / 更新服务器（未配置时为“未配置”）。
  - 检查中：`Progress` 不确定态 + “正在检查更新…”。
  - 已是最新：绿色提示 + `checkedAt`。
  - 有更新：`最新版本 vX`、发布时间、`notes`（`whitespace-pre-wrap`）、“下载并更新”按钮。
  - 下载中：`Progress` 百分比 + 阶段文案；禁止关闭。
  - 重启中：“更新完成，正在重启客户端…”。
  - 错误：`alert` 样式 + 重试按钮。
- 仅在 `isTauri` 时渲染入口；浏览器不显示客户端版本/更新按钮。

## 5. 发布与 CI

- `package-portable.ps1` 增加 `-Notes` 参数；在生成 ZIP 后写 `latest.json` 到 `bundle/portable` 目录（不放进 ZIP）。
- `latest.json` 的 `publishedAt` 用 `Get-Date -Format o`，SHA-256 复用现有 `SHA256SUMS.txt` 的值。
- `.github/workflows/windows.yml`：
  - `tauri build` 步骤注入 `TRELLIS_UPDATE_SERVER: ${{ vars.TRELLIS_UPDATE_SERVER }}`。
  - `package-portable.ps1` 调用加 `-Notes`。
  - 上传 artifact 与 Release 资产增加 `latest.json`；发布断言从 2 个资产改为 3 个。
- `packages/desktop/README.md`：说明文件服务器目录结构（`latest.json` + ZIP + `.zip.sha256`）、仓库变量配置、本地构建时设置环境变量。

## 6. 安全边界

- 只允许 http/https；不跟随 `file:` 等协议。
- 文件名白名单校验，ZIP 解压用 `enclosed_name`，只取固定 EXE 名。
- 不执行 ZIP 中的脚本；不保留 ZIP 内目录结构。
- 无签名时 SHA-256 只保证完整性；README 明确要求 HTTPS 或可信内网。
- 替换目标只允许当前进程 EXE 所在目录，不接受前端传入路径。

## 7. 测试

Rust（`cargo test`）：
- 版本比较：`0.4.9 < 0.4.10`、相同版本、`v` 前缀、非法版本。
- 清单校验：缺字段、短哈希、带路径的文件名、超大 notes。
- 下载校验：哈希不符与大小不符（用临时文件/字节数组）。
- ZIP 选择：唯一 EXE、缺失、多个、路径穿越。
- 回滚：备份恢复函数在写入失败后恢复原文件（用临时目录）。

服务端：现有测试基线上，验证两个 `/api/health` 返回的 `version` 与 `package.json` 一致（轻量断言，不新增测试框架）。

前端：`yarn build` + `yarn build:desktop` + 实际浏览器检查；Rust 侧事件与命令用 `cargo test` 覆盖纯逻辑。

## 8. 取舍记录

- 选择构建期 env 而非运行时配置：用户明确选择；避免终端用户改错地址，也避免设置界面。
- 选择 `latest.json` 而非 GitHub Releases API：用户已有文件服务器；清单可手写/脚本生成，不依赖 GitHub。
- 选择 Rust 侧通知与下载：WebView 的 Notification 权限不可靠，下载不受 CSP `connect-src` 限制。
- 选择延迟重启器而非直接 spawn：单实例插件会拦截第二个实例。
- 不引入签名校验/增量更新：超出本次范围，SHA-256 + HTTPS 足够覆盖传输损坏与基本篡改。
