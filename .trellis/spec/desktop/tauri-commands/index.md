# 桌面 Tauri 命令与导航

## Scenario: 远程 Board 监听本地状态事件

### 1. Scope / Trigger

- 修改 `desktop-state-changed`、`live-control-changed`、远程 Board event listen/unlisten 或状态兜底时适用。

### 2. Signatures

- `desktop-state-changed` payload：`{ topics: ["associations", "sidecar"] }`。
- `live-control-changed` payload：空事件。
- Board capability：`core:event:allow-listen`、`core:event:allow-unlisten`。

### 3. Contracts

- 事件只是失效通知；ProjectRail 收到后仍调用 `list_local_associations` /
  `desktop_sidecar_status`，Board 页面的 `LiveSyncControlDialog` 仍调用 `live_control_pending`。
- `live_control_*` 与 `set_task_ownership` 只对 `board-local-association` 窗口放行，且必须经
  `ensure_board_caller`；不存在独立 `live-control` 窗口，也没有 `live_control_resize`。
- 只读任务投影：`live_local_task_state(taskSpaceId)` 返回 `{taskSpaceId, localDirs, readonlyDirs,
  archivedResidue}`，用于看板三态（`local`/`readonly`/`remote`）；`live_task_download(taskSpaceId, taskId)`
  从 `GET …/tasks/:id/files` 下载只读副本（不写 baselines、后续上传被 `readonlyTaskDirs` 过滤），返回
  `{taskId, taskDir, fileCount}`；`live_conflicts_show(taskSpaceId?)` 重建仍成立的冲突控制事件并返回
  是否真的推了一条。三者同样只对 Board 窗口放行并过 `validate_live_id`。
- 新增远程 Board 可调用的命令，除 `main.rs` 注册外还必须在 `permissions/desktop.toml` 声明
  `allow-<command>`（`commands.allow`）并加入 `capabilities/board-local-association.json` 的
  `permissions`；只在 `generate_handler!` 注册时远程页面调用会返回
  `Command not found`（错误文案为 `not allowed`）。
- 前端必须先注册监听，再执行首次读取；可见时保留 10 秒兜底，隐藏时停止。
- Rust 只在 cursor、binding、ownership、Git 投影、sidecar 或控制队列实际变化后发射。
- 请求在途时只保留一次后续刷新，相同归一化结果复用原引用。

### 4. Validation & Error Matrix

| 条件 | 结果 |
| --- | --- |
| Board capability 缺少 listen/unlisten | 远程 Board 收不到状态事件 |
| 事件 payload 主题为空或未知 | 前端忽略；恢复仍由首次读取、focus、可见性和 10 秒兜底完成 |
| 监听注册失败 | 不阻断首次读取和可见兜底 |
| 页面或窗口隐藏 | 清除兜底 timer；恢复可见时立即读取一次 |

### 5. Tests Required

- capability 静态断言包含 listen/unlisten。
- 刷新合并纯逻辑测试覆盖在途请求和一次 pending refresh。
- Rust 测试覆盖无变化不通知、实际变化通知和主题合并。

## Scenario: Board 手动退出并返回本地登录页

### 1. Scope / Trigger

- 新增或修改远程 Board 可调用的 Tauri command、capability、窗口导航或本地登录页跳转时适用。
- 本场景覆盖 `desktop_logout`、会话清理、保存密码清除和 `local_url` 生命周期。

### 2. Signatures

- Tauri command：`desktop_logout() -> Result<(), String>`
- 权限：`allow-desktop-logout`，命令白名单为 `commands.allow = ["desktop_logout"]`
- 远程调用方：仅 `board-local-association` capability 的当前 Board origin。
- 本地配置：`ClientConfig { schema_version, server_url, username, password, ... }`

### 3. Contracts

- `desktop_logout` 不接受 server URL 或 token 参数，只读取 `DesktopAuthState` 中的当前 Board 和会话令牌。
- 命令必须先执行 `ensure_board_caller`，当前窗口 origin 必须与 `board_url` 相同。
- 退出时停止 Agent、删除当前 Board Cookie、清空内存中的 Board URL 和 token、清除 `ClientConfig.password`、保留 `server_url` 与 `username`，并导航到本地登录页。
- 本地登录页 URL 必须在 `WebviewWindowBuilder::on_page_load` 的 `PageLoadEvent::Started` 事件中，从 `navigation::is_local_page(payload.url())` 为真的页面捕获。
- 不得在 `builder.build()` 后立即读取 `window.url()`；此时页面可能尚未加载并返回 `about:blank`。
- 服务端会话撤销为尽力执行；本地认证状态和保存密码必须先清理。

### 4. Validation & Error Matrix

| 条件 | 行为 |
| --- | --- |
| 调用窗口不是当前 Board origin | 命令返回错误，不清理会话 |
| `about:`、远程 Board 或外链页面触发 `on_page_load` | 不覆盖 `local_url` |
| 配置中没有密码 | 正常返回，不重复写配置 |
| 密码写回失败 | 记录告警，但继续清理 Cookie、内存会话并打开本地登录页 |
| 服务端 logout 失败 | 忽略服务端错误；本地会话已经清除 |

### 5. Good/Base/Bad Cases

- Good：用户在桌面 Board 点击退出，窗口打开 `http://tauri.localhost/` 或等价的 `tauri://localhost/` 登录页，密码为空且不自动登录。
- Base：冷启动已有完整凭据且用户未主动退出时，登录页仍可自动登录。
- Bad：`local_url` 保存为 `about:blank`；点击退出后窗口空白，主进程仍在运行。

### 6. Tests Required

- 静态契约测试：权限只在远程 Board capability 中，命令已注册，退出代码清除密码，旧 `window.url()` 捕获不存在。
- Rust 单元/编译测试：`PageLoadEvent` 与 `on_page_load` 闭包通过编译。
- Windows E2E：登录后退出必须到达本地登录页；密码为空；关闭重启仍不自动登录；修改服务器地址和用户名后可重新登录。

### 7. Wrong vs Correct

#### Wrong

```rust
let window = builder.build()?;
let local_url = window.url()?; // 页面尚未加载时可能是 about:blank
```

#### Correct

```rust
builder
    .on_page_load(move |_, payload| {
        if payload.event() == PageLoadEvent::Started
            && navigation::is_local_page(payload.url())
        {
            *local_url.lock().unwrap() = Some(payload.url().clone());
        }
    })
    .build()?;
```

## Scenario: 远程 Board 读取只读客户端身份

### 1. Scope / Trigger

- 远程 Board 需要显示桌面客户端品牌名或版本号时适用。
- 不得为了展示身份而向远程 Board 开放 `app_status`：该命令包含保存的登录名和密码。

### 2. Signatures

- Tauri command：`client_identity() -> Result<ClientIdentity, String>`
- 响应：`{ "name": String, "version": String }`
- 权限：`allow-client-identity`，命令白名单为 `commands.allow = ["client_identity"]`
- capability：只加入 `board-local-association`，不得加入本地登录页的 `main` capability。

### 3. Contracts

- 命令必须先执行 `ensure_board_caller(&app, &window)?`，只服务当前登录 Board origin。
- `name` 读取 `app.config().product_name`；缺失、空串或仅空白时返回 `Trellis Board`。
- `version` 读取客户端包版本 `env!("CARGO_PKG_VERSION")`，前端只负责加 `v` 前缀。
- 普通浏览器没有 Tauri 上下文，不调用该命令，也不显示客户端版本。
- 旧客户端没有 `client_identity` 时，Board 保留默认品牌并隐藏版本；不能回退调用 `app_status`。

### 4. Validation & Error Matrix

| 条件 | 行为 |
| --- | --- |
| 调用窗口不是当前 Board origin | 命令返回错误，不返回身份信息 |
| 本地登录 capability 尝试调用 | capability 未授权，命令不可用 |
| `product_name` 缺失或为空白 | `name` 返回 `Trellis Board` |
| 旧客户端没有该命令 | Board 使用默认品牌，不显示版本 |
| 普通浏览器打开 Board | 使用默认品牌，不显示客户端版本 |

### 5. Good/Base/Bad Cases

- Good：`productName = "Acme Board"`，Board 显示 `Acme Board` 和 `v0.4.27`。
- Base：默认 `productName = "Trellis Board"`，Board 显示默认品牌和客户端版本。
- Bad：远程 Board 调用 `app_status` 获取版本，意外拿到保存的登录名和密码。

### 6. Tests Required

- 静态契约测试断言权限只存在于 Board capability，命令已注册且调用 `ensure_board_caller`。
- 静态契约测试断言 UI 调用 `client_identity`，且包含默认品牌和版本展示。
- Rust 单元测试断言自定义名称、空白名称和缺失名称的回退。

### 7. Wrong vs Correct

#### Wrong

```rust
// app_status 包含 username/password，不能暴露给远程 Board。
commands.allow = ["app_status"]
```

#### Correct

```rust
#[tauri::command]
fn client_identity(app: AppHandle, window: WebviewWindow) -> Result<ClientIdentity, String> {
    ensure_board_caller(&app, &window)?;
    Ok(ClientIdentity {
        name: client_brand_name(app.config().product_name.as_deref()),
        version: env!("CARGO_PKG_VERSION").to_string(),
    })
}
```

## Scenario: agent 大模块的目录化拆分

### 1. Scope / Trigger

- `packages/desktop/src-tauri/src/agent/` 下某个模块超过约 1200 行，需要拆成 `foo.rs` + `foo/` 目录时适用。
- 现有先例：`task_sync.rs`（15798 行）拆为 17 个职责子模块 + `task_sync/tests/`；根文件 394 行。

### 2. Layout

- `foo.rs` 保留：`mod` 声明、常量、主类型定义与其构造/`Drop`、对外重导出、`#[cfg(test)] mod tests;`。
- `foo/<concern>.rs`：单一职责子模块，单文件 ≤ 1200 行；根文件 ≤ 500 行。
- `foo/tests/`：`mod.rs`（共享 import + `mod` 声明）、`support.rs`（fixture，`pub(super)`）、按主题划分的测试文件。

### 3. Contracts

- `agent/mod.rs` 与所有 `crate::agent::foo::X` 调用路径**零改动**：子模块 item 用 `pub(super)`，由根文件按原可见性重导出（`pub use` / `pub(crate) use` / `use`）。
- 子模块用 `use super::*;` 取得根文件的私有 import 与重导出；根文件重导出块加 `#[allow(unused_imports)]`，因为同一批符号被 bin 与 test 两个编译目标分别使用。
- 拆分是对单一大 `impl` 的切片：每个子模块内的 `impl Type { ... }` 只是搬运边界，不新增方法分组语义。
- 拆分类重构禁止 `cargo fmt`（仓库无 rustfmt 配置），禁止顺手改逻辑；验证以"行内容多重集等价 + 测试集合等价"证明。

### 4. Validation

| 条件 | 结果 |
| --- | --- |
| 根文件 > 500 行或子文件 > 1200 行 | 拆分不合格 |
| 外部调用方需要改 `use` 路径 | 可见性契约被破坏 |
| 测试名集合与拆分前不一致 | 有测试被丢弃或改名 |
| `cargo check --all-targets` warning 数高于拆分前 | 引入了新的未使用项 |

### 5. Tests Required

- `cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml` 全绿。
- 测试名集合与拆分前 `-- --list` 结果逐项比对为空差集。
