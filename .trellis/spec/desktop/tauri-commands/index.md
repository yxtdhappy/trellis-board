# 桌面 Tauri 命令与导航

## Scenario: 远程 Board 监听本地状态事件

### 1. Scope / Trigger

- 修改 `desktop-state-changed`、`live-control-changed`、远程 Board event listen/unlisten 或状态兜底时适用。

### 2. Signatures

- `desktop-state-changed` payload：`{ topics: ["associations", "sidecar"] }`。
- `live-control-changed` payload：空事件。
- `task-sync-notice` payload：`{ type: "task_sync_notice", kind: "branch_guard", taskSpaceId,
  projectName?, branchName?, errorCode, message }`，只在分支守卫从正常进入暂停时发送一次。
- Board capability：`core:event:allow-listen`、`core:event:allow-unlisten`。

### 3. Contracts

- 事件只是失效通知；ProjectRail 收到后仍调用 `list_local_associations` /
  `desktop_sidecar_status`，Board 页面的 `LiveSyncControlDialog` 仍调用 `live_control_pending`。
- `task-sync-notice` 只做非模态提示（Board 内 sonner toast）：不进入 `ControlHub`、不改变
  `live_control_pending`、不触发系统通知、不聚焦窗口；同一项目用固定 toast id 合并。
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
- 命令必须先执行 `ensure_board_caller`，当前窗口必须与 `board_url` 同 origin 且处于其 `board_base_path` 子路径作用域内（`same_board_scope`）；写入和删除的会话 Cookie `Path` 必须与服务端一致（`<basePath>` 或 `/`）。
- 退出时停止 Agent、删除当前 Board Cookie、清空内存中的 Board URL 和 token、清除 `ClientConfig.password`、保留 `server_url`（含子路径，无尾 `/`）与 `username`，并导航到本地登录页。
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

## Scenario: 切换服务器地址前备份并清理本地数据

### 1. Scope / Trigger

- 修改本地登录页的登录流程、`desktop_login` / `desktop_login_preflight`，或
  `client_reset` 备份清理逻辑时适用。
- 触发条件：本地已有上次登录的 `server_url`，且本次地址归一化后与它不同；首次登录
  与地址未变不触发。

### 2. Signatures

- `desktop_login_preflight(serverUrl: String) -> { requiresReset, previousServerUrl, backupRoot }`
  （仅本地登录页，`allow-desktop-login-preflight`）。
- `desktop_login(serverUrl, username, password, switchServer?: bool)`；`switchServer` 缺省为
  `false`。
- 清理清单（相对 data 目录，固定三项）：`client.json`、`agent`、`desktop-plugins`。
- 备份目录：data 同级 `data-backup-<yyyyMMdd-HHmmss>`，保留最近 3 份。

### 3. Contracts

- 地址比较必须复用 `navigation::validate_board_url` + `navigation::board_server_url`，前端不得
  自行实现归一化；尾部 `/`、主机大小写、默认端口的差异不算切换。
- `desktop_login` 在地址变化且 `switchServer != Some(true)` 时必须直接返回错误，不做清理也不登录；
  preflight 只是交互提示，不能作为唯一防线。
- 顺序固定为「备份 → 删除 → 登录」；备份失败中止登录且不删除任何数据。
- 切换分支必须先 `agent_service::stop` 与 `plugin_host::stop`（插件宿主占用 `desktop-plugins/`）。
- 登录失败、或登录成功后任一本地步骤（令牌校验、写会话 Cookie、写 `client.json`）失败，
  都必须用备份恢复被删项并保留备份目录；恢复失败要记录原因，错误文案给出备份目录名
  （按 `desktop-agent-runtime` §4，日志与错误消息不输出绝对路径）。
- 不得删除 `runtime/`、`npm-global/`、`updates/`、`plugins/`、`appearance.json`、`logs/`
  与 `update-state.json`。
- 清理会删除 `client.json`，但运行环境标记（`node_runtime` / `trellis_runtime` / `python_runtime`）
  必须用切换前读到的配置回写，避免下次启动重新下载 Node/Trellis。
- 新命令与权限只进入 `capabilities/main.json`，不得进入 `board-local-association.json`。
- 登录页取消确认时不得调用 `desktop_login`、不得改动任何本地文件。

### 4. Validation & Error Matrix

| 条件 | 行为 |
| --- | --- |
| 首次登录（无 `server_url`） | 不弹确认，直接登录 |
| 地址仅尾斜杠/大小写/默认端口不同 | 不弹确认，直接登录 |
| 地址变化且用户取消 | 停在登录页，零副作用 |
| 地址变化但未带 `switchServer` | 返回错误，不清理 |
| 备份目录不可写 | 中止登录，原数据完整，返回备份失败错误 |
| 删除项被占用 | 重试 5 次后恢复已删项并报错 |
| 清理后登录失败 | 从备份恢复，错误文案追加「已恢复原服务器的本地数据」 |
| 恢复也失败 | 错误文案给出备份目录，日志记录原因 |
| 远程 Board 调用 preflight | capability 未授权，命令不可用 |

### 5. Good/Base/Bad Cases

- Good：旧地址 `https://a.example.com`，新地址 `https://b.example.com`，确认后生成
  `data-backup-20261126-153000`，旧三个清理项被移除，`runtime/` 保留，`runtime_status` 仍 ready。
- Base：用户改地址后在确认框取消，登录页保留已输入的账号密码，改回旧地址可直接登录。
- Bad：为省事在 `desktop_login` 里无条件清理，或把 `runtime/` 一并删除导致重新下载 Node。

### 6. Tests Required

- Rust：`client_reset` 覆盖归一化比较、备份/清理范围、缺失项跳过、恢复、保留 3 份、备份失败
  （Windows 独占句柄）。
- 静态契约：`capabilities/main.json` 含 `allow-desktop-login-preflight` 且 Board capability 不含；
  `LoginApp` 在 `desktop_login` 之前调用 preflight 且取消路径不登录。

### 7. Wrong vs Correct

#### Wrong

```rust
// 只靠前端 preflight 决定是否清库：漏调或旧包会静默删数据。
if previous.server_url != server_url {
    client_reset::backup_and_clear(&config::data_dir(), chrono::Local::now())?;
}
```

#### Correct

```rust
let switched = client_reset::server_switched(previous_server.as_deref(), &server_url)?;
if switched && switch_server != Some(true) {
    return Err("服务器地址已变更，需要先在登录页确认清理旧服务器的本地数据".to_string());
}
```

## Scenario: 远程 Board 读取只读客户端身份

### 1. Scope / Trigger

- 远程 Board 需要显示桌面客户端品牌名或版本号时适用。
- 不得为了展示身份而向远程 Board 开放 `app_status`：该命令包含保存的登录名和密码。

### 2. Signatures

- Tauri command：`client_identity() -> Result<ClientIdentity, String>`
- 响应：`{ "name": String, "version": String }`
- 本地登录页状态：`app_status() -> Result<AppStatus, String>`（仅 `main` capability）同步返回 `appName: String`
- 权限：`allow-client-identity`，命令白名单为 `commands.allow = ["client_identity"]`
- capability：只加入 `board-local-association`，不得加入本地登录页的 `main` capability。

### 3. Contracts

- 命令必须先执行 `ensure_board_caller(&app, &window)?`，只服务当前登录 Board origin。
- 客户端品牌名统一由 `app_display_name(app.config().product_name.as_deref())` 解析，优先级为：运行期环境变量 `TRELLIS_BOARD_APP_NAME` > 构建期 `option_env!("TRELLIS_BOARD_APP_NAME")`（未显式传入时由 `build.rs` 自动读取根 `.env`）> `app.config().product_name` > 中性兜底 `Board`（空白值自动跳过）；主窗口标题、托盘 tooltip、`app_status.appName` 与更新/同步通知复用同一解析函数，不在源码或 HTML 中硬编码品牌文案。
- 远程 Board 展示优先级（`resolveAppName`）：服务端 `/api/runtime` 的 `appName` > 服务端 HTML 注入的 `<meta name="trellis-app-name">` > 桌面 `client_identity().name`（仅连接未下发 `appName` 的旧版服务端时回退）> 空串（由各页面按需回退中性文案）。
- `version` 读取客户端包版本 `env!("CARGO_PKG_VERSION")`，前端只负责加 `v` 前缀。
- 普通浏览器没有 Tauri 上下文，不调用该命令，也不显示客户端版本。
- 旧客户端没有 `client_identity` 时，Board 使用服务端名称或默认品牌并隐藏版本；不能回退调用 `app_status`。

### 4. Validation & Error Matrix

| 条件 | 行为 |
| --- | --- |
| 调用窗口不是当前 Board origin | 命令返回错误，不返回身份信息 |
| 本地登录 capability 尝试调用 | capability 未授权，命令不可用 |
| 环境变量与 `product_name` 均缺失或为空白 | `name` 返回 `Board` |
| 服务端配置了 `TRELLIS_BOARD_APP_NAME` | Board 顶栏与 `document.title` 优先跟随服务端名称 |
| 连接未下发 `appName` 的旧服务端 | Board 回退使用 `client_identity().name` |
| 旧客户端没有该命令 | Board 使用服务端或默认品牌，不显示版本 |
| 普通浏览器打开 Board | 使用服务端或默认品牌，不显示客户端版本 |

### 5. Good/Base/Bad Cases

- Good：`TRELLIS_BOARD_APP_NAME = "Acme Board"`（或 `productName = "Acme Board"`），客户端显示 `Acme Board` 和 `v0.5.1`；连接配置了不同名称的 Team 服务端时 Board 跟随服务端名称。
- Base：根 `.env` 配置 `TRELLIS_BOARD_APP_NAME=Weint Spec Board`，构建与运行期均从环境变量注入并全端显示配置名称；未配置时只使用中性兜底 `Board`。
- Bad：远程 Board 调用 `app_status` 获取版本，意外拿到保存的登录名和密码。

### 6. Tests Required

- 静态契约测试断言权限只存在于 Board capability，命令已注册且调用 `ensure_board_caller`。
- 静态契约测试与前端单测断言 `resolveAppName` 优先级（服务端 > meta > 客户端回退 > 默认 `Weint Spec Board`）与版本展示。
- Rust 单元测试断言 `resolve_app_name` 四级优先级与空白值跳过。

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
        name: app_display_name(app.config().product_name.as_deref()),
        version: env!("CARGO_PKG_VERSION").to_string(),
    })
}
```

## Scenario: 初始化后清理 Python 缓存模板哈希

### 1. Scope / Trigger

- 修改完整 `trellis init`、已有任务树的 Agent-only 初始化，或 `.trellis/.template-hashes.json` 清理行为时适用。

### 2. Contracts

- 两条初始化路径只在子进程成功返回后执行清理；失败结果和原有错误映射不变。
- 清单键为 POSIX 相对路径。只删除任一路径段为 `__pycache__` 或以 `.pyc` 结尾的 `hashes` 键。
- 保留其他哈希值、顶层字段和 `.pyc` 文件；无目标键时不重写清单。
- 清单写回使用同目录临时文件 + rename；解析失败或清理失败静默降级，不覆盖初始化成功结果。
- 不修改 Trellis 上游包的 `EXCLUDE_FROM_HASH`，也不在客户端重建 Agent-only `merge: true` 语义。

### 3. Validation & Error Matrix

| 条件 | 行为 |
| --- | --- |
| 初始化命令失败 | 不读取、不修改模板哈希清单 |
| 清单含缓存键 | 仅删除目标键后原子写回 |
| 清单无缓存键 | 不重写文件 |
| 清单无法解析或缺少 `hashes` 对象 | 不改原文件，清理错误被降级 |

### 4. Tests Required

- 混合清单仅删除缓存键，其他字段和值保持不变。
- 无效清单返回清理错误且原字节不变。
- 成功包装路径吞掉清理错误；失败包装路径不执行清理。

## Scenario: 接入初始化的一键提交推送与 Agent 忽略规则

### 1. Scope / Trigger

- 修改首次推送确认、`commit_and_push_pending_project`、初始化后的项目 `.gitignore` 更新，或
  `ProjectInspection.developerName` 时适用。

### 2. Signatures

- Tauri command：`commit_and_push_pending_project() -> { ok: true, state, message, localHead?,
  remoteHead?, dirtySummary?, localAhead?, remoteAhead? }`
- 权限：`allow-commit-and-push-pending-project`，同时写入
  `permissions/desktop.toml` 与 `capabilities/board-local-association.json`。
- 预检响应新增 `developerName: string | null`（camelCase）。
- Git 写层：`add_paths`、`has_staged_changes`、`commit_paths`、`push_branch`；全部经
  `git_args` 白名单与固定环境执行。

### 3. Contracts

- 命令无参数，只读 `DesktopAuthState.pending_project_path`，必须先 `ensure_board_caller`。
- 只暂存初始化生成的 `.trellis`、`.gitignore`、`AGENTS.md`、`.gitattributes`、`.agents/`
  （后四者存在时）；commit message 固定 `初始化trellis`。
- 使用 pathspec 形式 `git commit -m <message> -- <paths>`，不卷入其他已暂存文件。
- 无暂存差异时只 push，不创建空提交；HEAD 中从未出现 `.trellis` 时返回 `MISSING_TRELLIS`。
- push 使用全限定 refspec `refs/heads/<branch>:refs/heads/<branch>`；分支来自仓库当前分支。
- 初始化（完整 init / Agent-only / mode=None 重试）后按所选工具把根锚定规则追加到项目 `.gitignore`：
  22 个平台用顶层目录，Copilot 用 `.github` 精确子路径；等价规则去重、保留 CRLF、无新增不写。
- 项目已有 `.gitignore` 可能忽略 `.trellis`、`.agents`、`.gitattributes`、`AGENTS.md` 或 `.gitignore`。
  初始化与 `commit_and_push_initial` 暂存前都必须确保专用受控小节存在，并整体位于其它用户规则之后：
  `!/<目录>/`、`!/<目录>/**`（`.trellis`、`.agents`）和 `!/<文件>`（其余三个共享路径）。
- 受控小节只按固定标题识别；不得删除或重排用户在其它位置手写的等价规则。小节移动后必须在末尾重新追加
  `/.trellis/.template-hashes.json`，保证本机状态仍被忽略。不得使用 `git add -f`。
- `.gitignore` 写入失败按初始化失败返回；重试可补齐。
- `developerName` 读取 `.trellis/.developer` 首个非空 `name=`，最长 120 字符；两个初始化弹窗
  优先使用它，缺失时回退原有项目/账号默认值。

### 4. Validation & Error Matrix

| 条件 | 行为 |
| --- | --- |
| 没有待接入项目路径 | 返回“请先选择本地 Git 项目目录” |
| `.trellis` 被忽略或没有可提交文件 | `MISSING_TRELLIS`，不误报 ready |
| Git 未配置 user.name/email | 提示先配置身份，保留本地状态 |
| push 非快进 / 远端有新提交 | `NO_FAST_FORWARD` 可读提示 |
| 网络或认证失败 | `REMOTE_UNREACHABLE`，不误报已推送 |
| `.gitignore` 只读或非 UTF-8 | 初始化返回明确错误 |
| 根 `.gitignore` 忽略共享初始化路径 | 先追加受控反忽略小节；普通 `git add` 成功，不返回 ignored paths 错误 |
| 已初始化旧项目直接一键推送 | 暂存前自愈受控小节，不需要重新初始化 |
| `.trellis/.template-hashes.json` | 始终位于共享放行规则之后并保持 ignored，不进入提交 |
| `.developer` 缺失 / name 为空 | `developerName = null`，前端回退原有默认值 |

### 5. Good/Base/Bad Cases

- Good：初始化后点击一键按钮，只产生一个 `初始化trellis` 提交，push 后状态 ready。
- Good：项目原本忽略 `.trellis`/`.agents`/`*.md`，客户端仍能用普通 `git add` 提交通用初始化文件，且本机模板基线保持未提交。
- Base：`.trellis` 已提交但尚未推送，点击按钮只 push，不产生空提交。
- Bad：直接 `git add .trellis && git commit`，会把用户其他已暂存改动一起提交。
- Bad：用 `git add -f` 绕过全部忽略规则，可能把 `.template-hashes.json` 等本机状态提交。

### 6. Tests Required

- Rust：严格根 `.gitignore` 下 `git check-ignore` 仅保留本机状态命中；验证嵌套共享文件、用户手写等价规则保留、受控小节位于后加用户规则之后、CRLF/无尾换行和重复执行幂等。
- Rust：bare 远端端到端证明普通暂存成功、`.gitignore` 自身可提交、只提交初始化路径、模板基线不入库且远端 HEAD 一致。
- Rust：写操作参数、`diff --cached --quiet` 0/1/错误映射、固定 pathspec 不提交其他暂存文件、
  `AGENTS.md`/`.gitattributes`/`.agents/` 进入初始化提交、bare 远端端到端、二次点击不产生空提交、
  developer 解析、`.gitignore` 追加/去重/CRLF/幂等。
- Web：`normalizePushState` 容错、`developerName` 缺失归一化为空字符串。

### 7. Wrong vs Correct

#### Wrong

```bash
git add .trellis
git commit -m init        # 会提交其他已暂存文件
git push                  # 依赖 push.default 与 upstream
```

#### Correct

```bash
git add -A -- .trellis .gitignore AGENTS.md .gitattributes .agents  # 后四者存在时传入
git diff --cached --quiet -- .trellis .gitignore AGENTS.md .gitattributes .agents
git commit -m 初始化trellis -- .trellis .gitignore AGENTS.md .gitattributes .agents
git push origin refs/heads/<branch>:refs/heads/<branch>
```

## Scenario: Rust 模块的目录化拆分与测试外移

### 1. Scope / Trigger

- `packages/desktop/src-tauri/src/` 下任何 `.rs` 超过 1200 行（**测试代码计入行数**）时适用：要么把测试搬走，要么把职责拆成 `foo.rs` + `foo/`。
- 现有先例：`task_sync.rs`（15798 行）拆为 17 个职责子模块 + `task_sync/tests/`，根文件 394 行；`env.rs`（1640 行）拆为根 312 + `env/probe.rs` + `env/install.rs` + `env/tests.rs`；其余 23 个内联 `mod tests` 已外移。

### 2. Layout

- `foo.rs` 保留：`mod` 声明、常量、主类型定义与其构造/`Drop`、对外重导出、`#[cfg(test)] mod tests;`。
- `foo/<concern>.rs`：单一职责子模块，单文件 ≤ 1200 行；根文件 ≤ 500 行。
- `foo/tests.rs`：默认的测试文件，业务文件里只留 `#[cfg(test)] mod tests;`（原文的 `#[cfg(all(test, windows))]` 等属性原样保留）。
- `foo/tests/`：测试超过 1200 行时升级为目录——`mod.rs`（共享 import + `mod` 声明）、`support.rs`（fixture，`pub(super)`）、按主题划分的测试文件。
- crate 根 `src/main.rs` 无法用同名目录，写 `#[cfg(test)] #[path = "main/tests.rs"] mod tests;`。
- 测试外移只做缩进回退（`mod tests {` 内的 4 空格），不改测试体；`use super::*;` 在 `foo::tests` 里语义不变。

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

### 6. 增量守卫

- 任何后续改动（加功能、加测试、改注释）如果使某个文件超过上限，必须在**同一次改动内**拆完再提交：超限文件不得新增行，"下次再拆"不算完成。
- 判断顺序：先外移测试（`foo/tests.rs`），仍超限再按职责拆 `foo/<concern>.rs`；两种情况都要保持外部 `use` 路径零改动。
- 提交前跑 `rg -n '^mod tests \{' packages/desktop/src-tauri/src` 必须无输出；`cargo test` 全绿且测试名集合不变。

## Scenario: 客户端自动更新

### 1. Scope / Trigger

- 修改 `update_status`、`update_check`、`update_apply`、`update-*` 事件、托盘「检查更新」或通知点击行为时适用。

### 2. Signatures

- 命令：`update_status() -> UpdateStatus`、`update_check() -> UpdateStatus`、`update_apply() -> { applied: boolean }`，
  三个命令都先执行 `ensure_board_caller(&app, &window)?`。
- 权限：`allow-update-status`、`allow-update-check`、`allow-update-apply`，只加入
  `capabilities/board-local-association.json`；`main.json`（本地登录页）不得包含。
- 状态 payload（camelCase）：`{ enabled, currentVersion, server, latest, updateAvailable, checkedAt, error }`，
  `latest` 为 `{ version, notes, publishedAt, size } | null`。
- 事件：`update-status-changed`（payload 同状态）、`update-progress`（`{ stage, downloaded, total }`）、
  `update-open-dialog`（空 payload）。
- 更新源：优先级为构建期 `option_env!("TRELLIS_UPDATE_SERVER")` > 运行时当前连接的 Team 服务端 `<board_server_url(board_url)>/client-updates`（保留合法子路径，自动剔除末尾 `login.html` 等页面文件名）；两者都不可用时 `enabled=false`，不发起网络请求。

### 3. Contracts

- `update_status` 只返回内存缓存，不触网；`update_check` 串行化并更新缓存后发 `update-status-changed`。
- 若未配置编译期 `TRELLIS_UPDATE_SERVER`，启动时读取 `initial_server_url()` 初始化回退源；登录设置 `board_url` 或 `desktop_logout` 清空 `board_url` 时通过 `update::set_server_url` 刷新更新源、清空旧缓存、发射 `update-status-changed` 并同步更新托盘「检查更新」菜单项可用状态。
- Team 服务端通过免登录只读路由 `/client-updates/latest.json`（`no-store`）与 `/client-updates/<file>.zip`（流式、单段文件名白名单、`realpathSync` 防逃逸）托管 `<TRELLIS_BOARD_DATA_DIR>/client-updates`（可用 `TRELLIS_CLIENT_UPDATES_DIR` 覆盖）。
- 清单固定为 `<base>/latest.json`，`file` 必须是不含路径分隔符的裸 `.zip` 文件名；下载后必须校验清单的
  `size` 与 SHA-256，并只解压 ZIP 根目录下唯一的 `trellis-board-client.exe`。
- `update_apply` 只在正式构建可用；替换 EXE 前先备份为 `.old`，失败必须回滚。重启必须延迟启动，
  避免与 single-instance 插件抢跑；成功后退出当前进程。
- 通知去重记录在 `data/update-state.json` 的 `lastNotifiedVersion`，不得写入 `client.json`。
- 同一版本只通知一次；点击通知只负责聚焦窗口并发 `update-open-dialog`，不直接开始下载。
- 顶栏客户端版本号是更新入口；普通浏览器没有该入口，只展示服务端版本。

### 4. Validation & Error Matrix

| 条件 | 行为 |
| --- | --- |
| 编译期与运行时均未配置更新源 | 三个命令可见但 `update_status.enabled=false`，托盘「检查更新」置灰；检查返回未启用，不联网 |
| 调用窗口不是当前 Board origin | 命令返回错误，不读更新缓存、不改状态 |
| 登录或切换 Team 服务端 | 未配置编译期地址时自动切换至 `<server_root>/client-updates`，点亮托盘菜单并立即检查一次 |
| 清单版本不高于当前版本 | `updateAvailable=false`，不发通知 |
| 清单字段非法或响应超限 | 保留上次 `latest`，只设置 `error`，不中断客户端 |
| SHA-256、大小或 ZIP 结构不符 | 删除临时文件并返回错误，原 EXE 不变 |
| debug 构建调用 `update_apply` | 直接返回“开发构建不支持自动更新” |
| 替换 EXE 失败 | 回滚 `.old`，保持旧版本可启动 |

### 5. Tests Required

- Node：`packages/server/test/team-client-updates.test.js` 覆盖 `/client-updates/` 免登录托管、`no-store` 与路径安全。
- Rust：版本比较、更新源优先级（编译期 > 运行时回退）、URL 规范化、清单校验（含 BOM）、SHA-256/大小校验、ZIP 路径选择、替换回滚、通知去重。
- `cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml` 全绿。
- 手工：内网或本地 Team 服务端放置 `latest.json` 与 `.zip`，用无 `TRELLIS_UPDATE_SERVER` 的正式包登录后验证检查、通知、下载、重启。

## Scenario: 桌面本机插件宿主 IPC

### 1. Scope / Trigger

- 修改 `packages/desktop/src-tauri/src/plugin_host.rs`、`packages/desktop/plugin-host/host.mjs` 或
  Web 侧 `desktop_plugin*` 调用时适用。

### 2. Signatures

- `desktop_plugins_list() -> { disabled, running, hostVersion, plugins }`
- `desktop_plugin_set_enabled(pluginId, enabled) -> { ok, running }`
- `desktop_plugin_reorder(ids: string[]) -> { ok, plugins }`
- `desktop_plugin_logs(pluginId, tail?) -> { entries }`
- `desktop_plugin_panels() -> { panels, running }`；每个 panel 带 `host: "desktop"`、loopback `src` 与
  `eventsSrc`
- `desktop_plugin_request(pluginId, method, path, body?) -> { ok, status, contentType, data }`
- `desktop_plugin_asset(pluginId, path) -> { status, contentType, content }`

### 3. Contracts

- 7 个命令都只加入 `board-local-association` capability，并先执行 `ensure_board_caller(&app, &window)?`；
  本地登录页 capability 不得包含。
- 懒启动：只有 `<scope>/plugin-state.json` 里至少一个 `enabled` 插件时才解析 Node 并 spawn `host.mjs`；
  停用最后一个插件、注销或退出托盘都回收进程树。宿主只绑定 `127.0.0.1`，管理接口要求随机 bearer
  token。旧版 `<scope>/plugins/plugins.json` 会在首次读取或启动时一次性迁移到 `plugin-state.json`
  （重命名为 `plugins.json.migrated`；`witops-core` 遗留 `developerMap`/`assignee` 迁入插件 `store`），
  不再落盘 `plugins/plugins.json`。
- 数据目录按 `(serverHash, userId)` 隔离：`.../desktop-plugins/<hash>/<user>/`；`secrets.dpapi` 用
  Windows DPAPI（CurrentUser）加密，宿主 ready 后删除解密出的 `secrets.json`。
- 运行时通过 `--user-json` 向核心能力注入当前登录用户（`trellis.user.current`，权限 `user:read`）及
  仓库开发者列表（`trellis.projects.developers`，权限 `projects:read`）。
- 宿主需要 Node.js ≥ 22.5（`node:sqlite`）；低版本返回明确错误，不启动半可用进程。
- 面板 iframe 指向 loopback `/s/<secret>/<plugin>/<entry>`；只有 `isTauri && teamMode` 渲染
  「本机插件」入口，纯浏览器不拉取、不显示任何本机插件数据。

### 4. Validation & Error Matrix

| 条件 | 行为 |
| --- | --- |
| 非当前 Board origin 调用 | 返回「该命令只允许当前登录的 Board 页面调用」 |
| 没有任何 enabled 插件 | `running: false`，不创建 Node 进程 |
| Node < 22.5 | 返回版本错误，不 spawn |
| 停用最后一个插件 | 立即 kill 进程树并删除 `secrets.json` |
| secret 路径错误 | 401/404，不落到插件进程 |

### 5. Tests Required

- `packages/desktop/test/plugin-host.test.js`：bearer 鉴权、面板 HTML 重写、资源、启停、仓库注入、
  空清单、旧 `plugins.json` 迁移与 `trellis.user.current` 暴露。
- `packages/desktop/test/desktop-ui-build.test.js`：7 个权限/命令成对出现、capability 白名单、
  `ensure_board_caller`、懒启动与 Web 入口 gating。
- `packages/desktop/src-tauri/src/plugin_host/tests.rs`：路径隔离键、`plugin-state.json`
  极简状态与旧 `plugins.json` 迁移、资源释放、DPAPI 往返。

## Scenario: 客户端日志文件与轮转

### 1. Scope / Trigger

- 修改 `logging.rs`、日志目录、`logging::init` 调用点或「打开日志目录」时适用。

### 2. Signatures

- `logging::init(directory: &Path)`：启动时调用一次，目录为 `config::logs_dir()`。
- `logging::info(message)` / `logging::warn(message)`：唯一落盘入口。
- 文件：`desktop.log`（当前）、`desktop.1.log`、`desktop.2.log`（历史）。

### 3. Contracts

- 每行写入前经过 `redact`：Bearer 凭证与 `credential` / `pairingCode` / `sessionToken` / `token` / `password` 字段值替换为 `***`。
- 当前文件达到 5 MiB（`MAX_LOG_BYTES`）时，在下一次写入前轮转：删除最旧历史、历史依次改名、当前文件改名为 `desktop.1.log`。
- 只保留 2 份历史（`ROTATED_LOGS`），目录总占用上限 15 MiB。
- 追加与轮转由 `LOG_LOCK` 串行化；任一步失败（文件占用、权限不足）静默降级为继续追加，不改变命令结果、不 panic。
- 不引入日志框架：框架接管写入路径会绕过脱敏，且按时间轮转无法保证磁盘上限。
- 日志只记录真实动作或异常，禁止在每轮同步/心跳里按「状态」重复打印（反例：为快照里每个已归档 control 打一条「任务进入 Archived」）。状态未变化时静默；真实迁移或释放动作记 `info`，失败记 `warn`。

### 4. Validation & Error Matrix

| 条件 | 行为 |
| --- | --- |
| 当前文件 < 5 MiB | 仅追加 |
| 当前文件 ≥ 5 MiB | 轮转后新建当前文件继续写 |
| 历史已满 | 先删除 `desktop.2.log` 再改名 |
| rename/remove 失败 | 保持当前文件继续追加，允许超限 |
| 日志目录不可写或不存在 | 不写文件，不影响调用方 |

### 5. Tests Required

- `logging::tests` 覆盖：达到上限轮转、历史份数上限、写入失败静默。
- `agent::process::tests::logs_failed_commands` 覆盖失败命令落盘。

## Scenario: 桌面客户端接收任务分享链接

### 1. Scope / Trigger

- 团队成员在浏览器打开 `<Board base URL>/share.html?space=<taskSpaceId>&task=<taskId>` 后，中转页要唤起已安装客户端并打开该任务详情时适用（`<Board base URL>` 由 `appOriginWithBase()` 拼出，支持根路径与配置了 `TRELLIS_BOARD_BASE_PATH` 的子路径）。
- 只做任务定位：链接里不得携带、客户端也不得回传任何任务内容，避免浏览器端渲染只有 Board 才能看的数据。

### 2. Signatures

- 协议链接：`spec-board://task?server=<Board base URL>&space=<taskSpaceId>&task=<taskId>`
- 协议配置：`tauri.conf.json` 的 `plugins.deep-link.desktop.schemes = ["spec-board"]`
- Tauri command：`take_pending_share_link() -> Result<Option<PendingShare>, String>`
- 响应：`{ "kind": "target", "server": String, "taskSpaceId": String, "taskId": String } | { "kind": "invalid" } | null`
- 权限：`allow-take-pending-share-link`，命令白名单为 `commands.allow = ["take_pending_share_link"]`
- capability：只加入 `board-local-association`，不得加入本地登录页的 `main` capability。
- 事件：`share-link-open`（Rust `emit`，payload 为 `null`，Web 侧只用它触发读取）

### 3. Contracts

- `share_link::parse` 只接受 scheme 为 `spec-board` 且 host 为 `task` 的 URL；`server` 必须通过 `navigation::validate_board_url`（支持合法子路径，拒绝保留前缀、`share.html` 等页面文件尾段以及解析前可识别的 `.`/`..` 段），并归一化为 `navigation::board_server_url(&server)`（去除默认端口与尾斜杠）；`space` / `task` 去空白后长度上限 512 且不含控制字符。
- 解析结果写入 `DesktopAuthState.pending_share`（内存，后到合法目标覆盖先到，同值去重；非法链接仅在槽位为空时写入 `PendingShare::Invalid`，不覆盖尚未消费的合法目标）；不写磁盘、不进日志。
- 冷启动、第二实例、运行期唤起三条入口都归一到 `share_link::handle`：写暂存 → `focus_main_window` → emit `share-link-open`。
- 冷启动时插件的 `deep-link://new-url` 事件早于 `register_share_link` 的监听，因此 `register_share_link` 必须再读 `deep_link.get_current()`。
- 命令必须先执行 `ensure_board_caller(&app, &window)?`，读取即 `take()`：一次链接只打开一次。
- `clear_desktop_session` 清空 `pending_share`，链接不得跨账号存活。
- Web 侧仅在 `runtime` 就绪且非 `mustChangePassword` 强制改密状态下消费暂存链接；使用 `isSameShareServer(target.server, appOriginWithBase())` 比对含子路径的服务基址（同域不同子路径互不打开，只提示不切换 Board）；列表未命中时走纯 query 端点 `GET /api/tasks?taskSpaceId=...&executionTaskKey=...`（经 `withBasePath` 自动补前缀）。
- mac 上 `register_all()` 返回 `UnsupportedPlatform`，只记 warn，不影响启动。

### 4. Validation & Error Matrix

| 条件 | 行为 |
| --- | --- |
| scheme/host 不是 `spec-board://task` | 记 warn，槽位为空时记为 `PendingShare::Invalid`，Web 提示"任务分享链接格式无效，请让分享人重新复制"（不覆盖已有合法目标） |
| `server` 不是合法 http(s) 服务基址（含 userinfo/query/fragment/保留前缀或 `share.html` 等页面文件名） | 同上，记 warn 并提示链接格式无效 |
| `space` / `task` 缺失、空白、含控制字符或超长 | 同上，记 warn 并提示链接格式无效 |
| 同一目标重复到达（argv + 事件） | 暂存已是该值，仅保留一次 |
| 未登录或停留在本地登录页 | 命令返回 capability 错误，暂存保留到登录后 |
| 首次登录强制改密（`mustChangePassword`） | `useShareLinkOpen` 暂停消费，改密完成后自动取出并打开 |
| 退出登录 | 暂存清空 |
| 链接服务基址（含子路径）与当前 Board 不一致 | Board 提示"来自其他服务地址"，不打开 |
| 任务不在当前看板数据里 | 走 `GET /api/tasks?taskSpaceId=&executionTaskKey=`，失败只提示"可能已失效或没有权限" |
| 旧客户端没有该命令 | `useShareLinkOpen` 静默忽略，仅保留复制分享能力 |

### 5. Good/Base/Bad Cases

- Good：已登录 `http://spec-board.weintdata.cn/weint-spec-board`，点击 `spec-board://task?server=http%3A%2F%2Fspec-board.weintdata.cn%2Fweint-spec-board&space=11-24-share&task=task-a`，窗口前置并打开任务详情。
- Base：未登录时点击链接，登录后自动打开同一任务。
- Bad：把 `space` / `task` 换成完整任务 JSON 塞进链接，浏览器历史与日志里出现任务内容；或截断 `server` 子路径导致同域不同子路径误判同源。

### 6. Tests Required

- Rust `share_link::tests`：http/https 根路径与合法子路径、默认端口与尾斜杠归一化、错误 scheme/host/保留前缀/页面文件名与超长参数被拒、`PendingShare` 去重/覆盖/非法占位与 `take`/`clear` 状态流转。
- 静态契约测试断言权限只存在于 Board capability、命令已注册且调用 `ensure_board_caller`、`tauri.conf.json` 声明 `spec-board`、`share_link.rs` 使用 `navigation::board_server_url(&server)`。
- 静态契约测试与 Web 单测断言 Web 侧先 `listen('share-link-open')` 再 `take_pending_share_link`、使用 `isSameShareServer(target.server, appOriginWithBase())` 比对基址、使用 `/api/tasks?` 纯 query、包含卸载/改密守卫与 `PendingShare::Invalid` 处理。

### 7. Wrong vs Correct

#### Wrong

```rust
// 直接把链接里的字段当可信输入：任意程序都能构造这个 argv。
let space = query.get("space").unwrap_or_default();
```

#### Correct

```rust
#[tauri::command]
pub fn take_pending_share_link(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, DesktopAuthState>,
) -> Result<Option<PendingShare>, String> {
    ensure_board_caller(&app, &window)?;
    let mut pending = state
        .pending_share
        .lock()
        .map_err(|_| "任务分享链接暂存不可用".to_string())?;
    Ok(take(&mut pending))
}
```

## Scenario: 心跳循环与在线状态

### 1. Scope / Trigger

- 修改 `agent/runtime.rs` 的心跳循环、`agent/heartbeat.rs`，或调整心跳间隔/超时/退避时适用。
- 背景：服务端重启后曾出现心跳永久停在绑定同步 await 上、在线监听归零的故障（`.trellis/tasks/11-24-heartbeat-loop-resilience`）。

### 2. Signatures

- `HeartbeatPolicy { interval, retry_base, retry_max, binding_sync_timeout, round_timeout }`，默认 15s / 1s / 60s / 30s / 60s。
- `heartbeat::bounded(limit, label, future) -> bool`：超时时记一条 warn 并返回 `false`。
- `RoundOutcome::{Success, AuthenticationFailure, Failure, TimedOut}` 与 `next_delays(current_delay, policy) -> (backoff, next_delay)`。

### 3. Contracts

- 心跳一律先发请求、后做绑定同步：`heartbeat_once` 里的 `active_bindings()` 只读内存缓存，不得在 POST 之前等待 `update_bindings`。
- 心跳路径上的每次 `update_bindings` 必须经 `bounded(binding_sync_timeout, ..)` 包裹。
- 单轮心跳必须有 `round_timeout` 总上限；超时后进入下一轮，绝不退出循环。
- 只有认证失败（`protocol::is_authentication_error`）能停止运行时。`agent.revoked` 帧只做一次心跳复验，不得直接停止——服务端优雅关闭时曾广播该事件，导致所有客户端误判被吊销。
- 失败、超时、恢复三类事件必须经 `logging::warn` / `logging::info` 落盘；成功心跳不写日志（避免每 15 秒一条），只在恢复时记一条 info。
- `AgentRuntime::stop(reason)` 必须记录停止原因；应用层主动停止走 `AgentService::stop_runtime(reason)` 并置 `user_stopped`，与运行时自停（认证失败/吊销）区分开。

### 4. Validation & Error Matrix

| 条件 | 行为 |
| --- | --- |
| 正常 | 15s 一轮，不写日志 |
| 绑定同步超过 30s | warn 一次，丢弃本轮同步；心跳此前已发出 |
| 单轮超过 60s | warn「心跳单轮超过 60 秒未完成」，写 error 状态，15s 后进入下一轮 |
| 网络错误 | warn「心跳失败（code）」，写 error 状态，1s→2s→…→60s 退避 |
| 恢复成功且上一轮失败 | info「心跳恢复：上报 N 个监听任务空间」并把状态改回 `running` |
| 401 / `AUTH_REVOKED` | 写 `AUTH_REVOKED` 并 `stop()`，不再重试 |
| 收到 `agent.revoked` 帧 | warn 一条并立即唤醒心跳复验；真吊销由心跳 401 走认证失败分支停止 |
| 服务端优雅关闭 | 只断开 SSE，不广播 `agent.revoked`；客户端重连后自动恢复 |
| 运行时被停掉（认证失败、吊销等） | info「Agent 运行时停止：{reason}」；`AgentService` 看门狗 30s 内自动拉起，最多连续 10 次 |
| 用户主动停止（托盘暂停、退出登录、退出应用） | 置 `user_stopped`，看门狗不得拉起，直到下一次成功启动 |

### 5. Tests Required

- `agent/heartbeat.rs` 单测：`classify` 四分类、超时后仍调度下一轮、退避翻倍且封顶 60s、`bounded` 超时返回 `false`。
- 手工：重启服务端后 60s 内 `agent_device.last_seen_at` 恢复前进，`desktop.log` 出现「心跳失败 → 心跳恢复」。
