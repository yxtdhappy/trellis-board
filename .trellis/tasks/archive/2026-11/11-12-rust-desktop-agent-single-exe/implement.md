# Implement: Rust in-process agent（单 exe）

## 0. 前置

- 目标目录：`desktop/src-tauri/`；新增模块 `desktop/src-tauri/src/agent/`。
- 依赖新增（`desktop/src-tauri/Cargo.toml`）：
  - `reqwest = { version = "0.12", default-features = false, features = ["rustls-tls", "json", "stream"] }`
  - `notify = "6"`、`sha2 = "0.10"`、`base64 = "0.22"`、`uuid = { version = "1", features = ["v4"] }`、`futures-util = "0.3"`
  - `tokio = { version = "1", features = ["rt-multi-thread", "macros", "time", "sync", "fs", "net", "io-util", "process"] }`
  - `windows = { version = "0.58", features = ["Win32_Foundation", "Win32_Security_Cryptography"] }`（仅 `credential.rs` 用）
  - `zip = { version = "2", default-features = false, features = ["deflate"] }`（仅 `env.rs` 解压 Node ZIP）

## 0.1 环境门前置结论

- Node 与 Trellis CLI 的**安装**只发生在环境门（M2.5）；初始化（M3）只使用环境门写下的 `client.json.trellis_runtime.cli_path` 与 `node_runtime.path`，不再自行 `npm install`。
- 环境门命令：`runtime_status()`、`runtime_install()`；进度通过 `runtime-progress` 事件推送。
- 不改动 `tauri` 及其插件版本；不改 `web/**`、`server/**`。

## 1. 里程碑

### M0 骨架与打包去 sidecar

- 新增 `agent/mod.rs`（`pub mod protocol; pub mod store; ...`）与各模块空实现，`main.rs` 改引用 `agent::`；`sidecar.rs` 暂时保留 control 逻辑后被 `agent/control.rs` 取代并删除。
- `tauri.conf.json`：删除 `bundle.externalBin`、`bundle.resources`；`desktop/windows/hooks.nsh` 删除 `trellis-agent.exe` 清理段。
- 删除 `desktop/sidecar/**`、`desktop/src-tauri/binaries/**`、`desktop/src-tauri/resources/**`；`desktop/package-portable.ps1` 改为只打包 exe + VERSION/SHA256。
- 版本 0.2.0 → 0.3.0（`package.json`、`tauri.conf.json`、`Cargo.toml`）。
- 验证：`cargo check`；`cargo tauri build` 后 `target/release/` 只有 `trellis-board-client.exe`。

### M1 基础层：protocol / store / credential / process / http

- `protocol.rs`：39 个 `AgentErrorCode`（字符串别名与 JS 完全一致，见 `agent/protocol.js`）；`AgentError{code:String,message:String}` + `impl Display`；`normalize_server_url`（仅 http/https 根地址）；`assert_safe_id`、`validate_branch_name_syntax`、`validate_pairing_code`、`compare_versions`；`parse_enroll_response`/`parse_heartbeat_response`（多余字段忽略）；`validate_command`；`build_command_result`；`safe_error_message`；`is_path_inside`。
- `store.rs`：`AgentPaths` 逐字段对齐 `agent/config-store.js` 的 `createAgentPaths`；`ConfigStore::{read_config(allow_missing), update_config, write_state, read_state}`；`atomic_write_json`（temp + rename，失败重试 10/25/50/100/200 ms）；`TRELLIS_AGENT_ROOT` 优先、否则 `%LOCALAPPDATA%/TrellisBoardAgent`。
- `credential.rs`：DPAPI `CryptProtectData`/`CryptUnprotectData` + `CRYPTPROTECT_UI_FORBIDDEN`；文件格式与 JS 一致；无 DPAPI 时映射 `DPAPI_UNAVAILABLE`。
- `process.rs`：`run_process(cmd, args, {cwd, env, timeout, max_output})`；Windows 超时用 `taskkill /T /F`；输出上限 1 MiB。
- `http.rs`：`AgentClient{server_url, credential, ca_file}`；全部 `/api/agent/*`；1 MiB JSON 响应上限、96 MiB 快照传输上限；`stream_events` 手写 SSE 分帧（1 MiB 缓冲上限、`last-event-id` 续传）。
- 验证：`cargo test`（protocol 解析/校验、路径防护、原子写、DPAPI 往返）。

### M2 认证与设备

- `device.rs`：`login_desktop`（`/api/auth/login` → 会话 cookie → enroll → 写 config+credential）、`logout_desktop_session`、`revoke_desktop_device`、`enroll_with_token`、`enroll_desktop_device`、`read_local_associations`、`read_agent_identity`；返回结构与 `DesktopLoginSummary` 完全一致（`ok/sessionToken/expiresAt/username/mustChangePassword/deviceReady/error/code`）。
- `association.rs`：`associate_desktop_project`、`preflight_desktop_project`、`format_association_error`；`AssociationSummary` 字段与 `sidecar.rs` 现有 DTO 一致。
- `main.rs`：`app_status`/`desktop_login`/`list_local_associations` 改为调用新模块，签名不变。
- 验证：本地起 `npm run board`，真实账号登录 → 设备出现在团队页；登出/撤销后 agent 停止。

### M2.5 环境门（env.rs + 前端环境页）

- `env.rs`：
  - `probe_node()`：先读 `client.json.node_runtime`（文件存在且 `node --version` 成功即通过），否则按 `PATHEXT` 在 PATH 找 `node.exe`；解析版本与 `MIN_NODE_VERSION = "18.17.0"` 比较。
  - `probe_trellis()`：先读 `trellis_runtime.cli_path`（存在且 `package.json.version` ≥ `0.6.17` 即通过），否则依次查 `<dataDir>/npm-global/node_modules/@mindfoldhq/trellis`、`npm root -g` 输出目录、PATH 上的 `trellis.cmd`（读其包的 `package.json.version`）。
  - `install()` 分步状态机：`node:download`（`https://registry.npmmirror.com/-/binary/node/v24.22.3/node-v24.22.3-win-x64.zip` → `<dataDir>/downloads/node.zip.part`，按 Content-Length 报百分比）→ `node:verify`（sha256 `e612af99f626ab415ea225af6bce5c971feb448cb5cae250bb1c3fa50c5f7d9f`）→ `node:extract`（解压到 `<dataDir>/node.new` 后整体 rename 到 `<dataDir>/node`）→ `node:validate`（`node --version`）→ `trellis:install`（`npm install -g --prefix <dataDir>/npm-global @mindfoldhq/trellis@0.6.17`，超时 300 s）→ `trellis:validate` → 写 flag → `ready`。
  - 已就绪的检查项跳过对应步骤；失败清理 `.part`/`node.new` 并回 `failed{step, message, stderrTail}`。
  - `client.json` schema 2 → 3：新增 `node_runtime{version,path,source,installed_at}` 与 `trellis_runtime{version,cli_path,prefix,source,installed_at}`；旧字段保持可读。
- `main.rs`：新增 `runtime_status`、`runtime_install`；`permissions/desktop.toml` 增 `allow-runtime-status`/`allow-runtime-install`，`capabilities/main.json` 同步。
- 前端 `desktop/ui/index.html`/`setup.js`/`styles.css`：页面拆 `#env-panel`（两项检查结果 + 主按钮 + 步骤列表 + 进度条 + 错误区）与 `#login-panel`；`setup.js` 先 `invoke('runtime_status')`，`ready` 才走现有登录流程（`app_status` → 自动提交）；`needs_setup` 显示安装按钮，点击 `invoke('runtime_install')` 并监听 `runtime-progress` 更新步骤与百分比，成功后展示「进入登录」。
- 验证：清空 `client.json` 的 flag 后模拟无 Node（PATH 只留必要目录）→ 环境页出现两项缺失 → 安装成功 → 断网重试 → sha256 失败注入 → 第二次启动直接进登录页。

### M3 git / onboarding / trellis init

- `git.rs`：固定参数与白名单、`GIT_STATE_MARKERS`、`status`/`status_paths`/`fetch_branch`/`check_ref`/`merge_ff_only`、`inspect_git_project`。
- `onboarding.rs`：`inspect_project`、`initialize_project`、`check_initial_push`、`preflight_project`、`attach_project`；返回字段与 JS 一致。
- `trellis_cli.rs`：
  - 只做解析与执行，不做安装：`resolve_runtime()` 从 `env.rs` 的 flag/PATH 结果取 `node.exe` 与 `cli.js`；
  - `npm install` 逻辑不在本模块（已在 M2.5）；
  - `init`：`<node.exe> <cli.js> init -y --skip-existing -u <devId> <flags>`，cwd=repo，超时 210 s；失败信息附 stderr 末 2 KiB；
  - 环境未就绪 → `AgentError(CONFIG_MISSING, "运行环境未就绪，请先完成首次启动的环境安装")`。
  - 工具标志表（`shared/trellis-agent-tools.js` 22 项）：`cursor→--cursor`、`claude-code→--claude`、`opencode→--opencode`、`codex→--codex`、`kilo→--kilo`、`kiro→--kiro`、`gemini→--gemini`、`antigravity→--antigravity`、`devin→--devin`、`qoder→--qoder`、`codebuddy→--codebuddy`、`copilot→--copilot`、`droid→--droid`、`dsh→--dsh`、`pi→--pi`、`reasonix→--reasonix`、`zcode→--zcode`、`omp→--omp`、`trae→--trae`、`grok→--grok`、`kimi→--kimi`、`snow→--snow`；`pi` 需 `presenceMode: all`。
- 验证：空目录 `trellis init` 生成与 CLI 完全一致的 `.trellis/`；无系统 Node 时使用 `<dataDir>/node/node.exe`（日志可证）。

### M4 agent runtime 与控制通道

- `runtime.rs`：`AgentRuntime::{start, stop, pause, resume, restart, status}`；启动条件与现在一致（`agent_root/config.json` 存在）；`state.json` 写 `starting/running/stopped/error`；心跳 15 s；SSE 事件循环（401 → `AUTH_REVOKED` 停止；`agent.revoked` 清凭证）；命令执行取 `startCommand` 后 `execute===true` 才执行，结果 `submitCommandResult`（`COMMAND_WAITING_INDEX` 重试 8 次，其余 2 次）。
- `control.rs`：去重键与 `sidecar.rs` 现状一致（assignment_warning=projectId+taskKey+assignee；remote_overwrite=backupId；assignment_overridden=projectId+taskKey+revision；initial_sync_review=taskSpaceId+revision；task_file_conflict=taskSpaceId+conflictId）、队列 32、`expiresAtEpochMs` + pending 文件存在性判过期、live-control 窗口 560x420。
- `main.rs`：`desktop_login` 成功且 `device_ready` → `agent::runtime::restart`；托盘「暂停同步」→ `pause/resume`；`desktop_sidecar_status` 读 runtime 状态。
- 验证：登录后服务端 agent 在线；停止服务端 → 客户端退避重连；托盘暂停时不再上传。

### M5 live sync

- `live_sync.rs` 逐函数移植（见 design 表格）；重点：
  - 白名单 `.trellis/.developer`、`.trellis/tasks/**`、`.trellis/workspace/**` + 文本扩展名；`safe_project_path` + symlink 断言；
  - `_submit_or_wait`：先持久化 pending（`pending-live/<batchId>.json`）再 preflight；`requiresConfirmation` → decision + `assignment_warning` 控制事件；
  - `_apply_remote_files`：先备份到 `live-backups/<projectId>/<backupId>`+`manifest.json`，冲突发 `remote_overwrite`；写前 `atomic_write`，写后登记 suppression；
  - `decide_pending_live_change`（continue/takeover/cancel，cancel 先备份再回滚）；`restore_live_backup`；`cleanup_backups`（20 份/30 天）。
- `main.rs`：`live_control_decide`/`live_control_diff`/`live_control_initial`/`live_control_restore`/`live_control_dismiss` 改调新模块，参数与返回不变。
- 验证：两个客户端同时改同一实时文件 → 两端都出现确认窗；取消后本地文件回滚且备份存在。

### M6 task snapshot sync

- `task_sync.rs`：cursor 结构（`taskSpaces{id:{revision,sequence,baselines,deferred,pending}}`）、首次 `bootstrap/safe/review`、`initial_sync_review`、增量拉取、`_local_sync_state` 比对、`fetch_task_directory` 取服务端基线、目录 rename `movePair`、429 退避、`TASK_FILE_CONFLICT` pending、`resolve_initial_sync`（skip/use-server/use-local/save-local）与 `decide_conflict`（use-server/save-local-copy/overwrite-server）。
- `shared/task-snapshot.js` 常量与 `classify_task_snapshots` 在 Rust 内重写：`MAX_FILES=1024`、`MAX_FILE_BYTES=1 MiB`、`MAX_BATCH_BYTES=64 MiB`、`MAX_TRANSPORT_BYTES=96 MiB`、`normalize_snapshot_text`（去 BOM、CRLF→LF、末尾换行规范化）、`snapshot_sha256`。
- 验证：任务目录改名/归档/删除、超大文件拒绝、两端并发编辑产生 `task_file_conflict` 并可三选一解决。

### M7 任务命令

- `task_command.rs`：`create_task`/`assign_task`（调 `.trellis/scripts/task.py`）、`sync_branch`（fetch + ff-only merge）、`refresh_status`；命令结果 `build_command_result`。
- 验证：Web 端新建/改派任务，桌面端 10 s 内反映，`git log` 出现 `chore(task): ...` 提交。

### M8 测试、文档、清理

- 删除测试：`tests/desktop-trellis-runtime.test.js`、`tests/desktop-sidecar-lifecycle.test.js`、`tests/desktop-package.test.js`、`tests/desktop-device-auth.test.js`、`tests/desktop-association.test.js`（`tests/desktop-realtime-apply.test.js` 只依赖 `agent/*` 与 `shared/task-snapshot.js`，保留）；`tests/workspace-client-flow.test.js` 中删除 `desktop/sidecar/cli.js associations` 用例（若其余用例仍有效则保留文件）。
- 新增 Rust 测试：`agent/protocol.rs`、`agent/store.rs`、`agent/credential.rs`、`agent/task_sync.rs`（分类/分组）、`agent/http.rs`（SSE 分帧）、`agent/env.rs`（版本比较、双 flag 快路径、sha256 失败、ZIP 根目录剥离）。
- 更新 `desktop/README.md`（构建/打包/运行期依赖说明）与 `.trellis/spec/backend/desktop-agent-runtime.md`（由 `desktop-sidecar-packaging.md` 重命名并改为 in-process 契约）。

## 2. 关键实现约束

1. **不 panic**：`agent/**` 禁用 `unwrap/expect/panic!/unreachable!`；所有 IO/解析错误转 `AgentError`。
2. **路径安全**：所有从服务端/URL 来的相对路径先 `normalize_snapshot_path`（拒绝 `\`、绝对路径、`..`、NUL），再断言落点在 `<repo>/.trellis` 内且不是 symlink。
3. **原子写**：任何配置文件、任务文件、备份 manifest 一律 temp + rename；rename 失败按 10/25/50/100/200 ms 重试。
4. **不阻塞 UI 线程**：所有网络/子进程在 `spawn_blocking`/tokio task；Tauri 命令只做参数校验与 `await`。
5. **日志**：沿用 `desktop/src-tauri/src/logging.rs` 的日志目录与滚动策略；初始化子进程 stdout/stderr 落 `init.log`。
6. **升级兼容**：不重命名 `agent_root` 下任何既有文件；首次启动读取旧 config/credential/cursor 直接续用。

## 3. 验证命令

```powershell
cargo fmt --manifest-path desktop/src-tauri/Cargo.toml
cargo clippy --manifest-path desktop/src-tauri/Cargo.toml -- -D warnings
cargo test  --manifest-path desktop/src-tauri/Cargo.toml
npm test
cd desktop; cargo tauri build
```

手工验收脚本（在 `desktop/` 外执行，临时目录用完即删）：

1. 清空环境 flag + 屏蔽 PATH 中的 node/trellis → 环境页 → 安装 → 进入登录；断网/哈希失败/重试各验一次；
2. 登录 → 关联临时 git 仓库（无 `.trellis`）→ 自动 init（有/无系统 Node 两种）→ 看板出现项目；
3. 改 `.trellis/tasks/<x>/prd.md` → 服务端快照更新；服务端改 → 本地更新；
4. 断网改文件 → 恢复后补传；`pending-live/` 清空；
5. 账号切换 → 旧 cursor/backup 清理，新账号首拉不串数据。

## 4. 实施状态（截至 2026-11-12）

- M0–M8 代码全部落地：`agent/`（protocol/store/process/credential/http/env/git/trellis_cli/onboarding/device/association/task_sync/task_command/runtime/control）、`agent_service.rs`、`runtime_commands.rs`；`main.rs` 全部 Tauri 命令与托盘改接进程内 Agent。
- 实时同步（`agent/live-sync.js`）经核实为从未装配的死代码（`fetchLiveFiles` 等无实现、服务端无路由），Rust 不予移植；控制事件收窄为 `initial_sync_review`/`task_file_conflict`/`task_sync_error`。
- 已删除：`desktop/src-tauri/src/sidecar.rs`、`desktop/sidecar/**`、`desktop/package.json`、`desktop/package-lock.json`、`src-tauri/binaries/**`、`src-tauri/resources/**`；`install.ps1`/`uninstall.ps1`/`hooks.nsh`/`package-portable.ps1`/CI 已去 sidecar。
- 环境门：`runtime_status`/`runtime_install` + `runtime-progress` 事件 + `desktop/ui` 环境页；`client.json` schema 3。
- 验证：`cargo fmt` 无差异；`cargo check --all-targets` 通过；`cargo clippy --all-targets` 0 error（剩余 dead_code 为 JS 对齐的备用 API）；`cargo test --bins` 82 passed；`npm test` 433 pass / 0 fail / 5 skipped；`cargo build --release` 产物只有 `trellis-board-client.exe`（本机未安装 `cargo tauri` 子命令）。

### 4.1 本机联调（本地 Team 服务端，2026-11-12）

- 冷启动：登录成功后 3 秒内写 `agent/runtime.json`（status=running），服务端 `agent_device.last_seen_at` 每 15s 刷新。
- 首次同步：`initialSyncMode=safe` 时本地独有任务进 `deferred`（与 JS 语义一致）；改 `bootstrap` 后 408 个任务文件上传，taskSpace `revision=61`。
- 修复 1：`clientSequence` 必须以 `Date.now()` 量级递增，服务端 `task-snapshot-service.js:420-427` 拒绝小整数序列；`next_client_sequence` 取 `max(wall_ms, cursor+1)` 并加回归测试。
- 修复 2：本地任务改动此前无上传路径（notify watcher 缺失）。补 `task_sync` 的 `rebuild_watchers`/`watch_loop`（监听 `<repo>/.trellis`，250ms 合并，`.trellis/tasks/**` 过滤）+ `report_error`（`task_sync_error` + 日志）。实测改动 `prd.md` 后 2s 内服务端 `revision` 61→62 且内容一致。
- 修复 3：环境页白屏。`renderRuntime()` 非 ready 分支补 `envPanel.hidden = false; loginPanel.hidden = true`；受限 PATH 下 CDP 实测环境页可见、安装按钮可用；正常 PATH 下就绪后切到登录页。
- 修复 4：快照响应超过 1 MiB 上限导致首次拉取失败（408 文件快照 1.48 MB）。`http.rs` 增 `request_json_limited` 与 `MAX_SNAPSHOT_RESPONSE_BYTES = 32 MiB`，快照与目录请求使用该上限。
- `desktop.log` 中旧的 `clientSequence 必须严格递增`、`sidecar 已退出` 均为旧 JS 客户端历史行，Rust 侧无新增异常。
