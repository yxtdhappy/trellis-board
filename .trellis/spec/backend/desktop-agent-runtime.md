# 桌面 Agent 运行契约（进程内 Rust）

**何时阅读**：修改 `apps/desktop/src-tauri/src/agent/**`、`agent_service.rs`、`runtime_commands.rs`、
`apps/desktop/src-tauri/src/main.rs` 的 Tauri 命令、`apps/web/src/desktop/**` 本地登录/环境门/控制窗口 UI，
或 Windows 打包脚本时。

桌面客户端是单进程 Tauri 应用：Agent（心跳、SSE、任务快照同步、任务命令）全部在
`trellis-board-client.exe` 内运行。**不得** 引入 sidecar、Node SEA 产物或内置 Node 运行时。

## 1. 模块与职责

| 模块 | 迁移前 JS 实现（已删除） | 职责 |
| --- | --- | --- |
| `agent/protocol.rs` | `agent/protocol.js` | 协议版本 3、39 个错误码、URL/ID/命令校验、结果构造、错误脱敏 |
| `agent/store.rs` | `agent/config-store.js` | `client.json`/`state.json`/cursor/credential 记录、原子写、config 锁 |
| `agent/credential.rs` | `agent/credential-store.js` | Windows DPAPI CurrentUser 加解密，无 entropy |
| `agent/http.rs` | `agent/api.js` | JSON 请求、SSE 分帧、错误码映射（默认 1 MiB、快照 32 MiB 上限、60s SSE 空闲） |
| `agent/process.rs` | `agent/process.js` | 受控子进程、环境白名单、超时、进程树结束 |
| `agent/git.rs` | `agent/git-sync.js` | git 参数白名单、status 解析、状态标记检测 |
| `agent/onboarding.rs` | `agent/project-onboarding.js` | inspect / initialize / checkPush / preflight / attach |
| `agent/trellis_cli.rs` | `apps/desktop/sidecar/trellis-runtime.js` | 执行 `node <cli.js> init ...`，不含安装逻辑 |
| `agent/env.rs` | 新增 | 环境门：Node/Trellis 检查、npmmirror 下载、npm 私有前缀安装 |
| `agent/device.rs` | `apps/desktop/sidecar/desktop-device.js` | 登录、登出、入网、撤销、本地关联读取 |
| `agent/association.rs` | `apps/desktop/sidecar/desktop-association.js` | associate / preflight 编排与错误文案 |
| `agent/task_sync.rs` | `agent/task-snapshot-sync.js` | 任务快照 cursor、上传/拉取、冲突与首次同步 |
| `agent/task_command.rs` | `agent/task-command.js` | create_task / assign_task / sync_branch / refresh_status |
| `agent/runtime.rs` | `agent/index.js` | 心跳 15s、SSE 事件循环、命令重试、state.json 状态机 |
| `agent/control.rs` | — | 控制事件队列（上限 32、按 key 去重、过期与 suppression） |
| `agent_service.rs` | `apps/desktop/sidecar/main.js` | 进程内生命周期、Tauri 命令实现、控制窗口显隐 |

根目录 `agent/`（Node CLI）与 `apps/desktop/sidecar/` 都已删除；右列只用于追溯协议版本、错误码和数据
格式的来源，不是可修改的代码路径。行为以 Rust 模块和 `cargo test` 为准。

## 2. 必须保持的契约

- 协议版本固定 `AGENT_PROTOCOL_VERSION = 3`；错误码集合固定在 `apps/desktop/src-tauri/src/agent/protocol.rs`，
  服务端据此判定可重试与终止。
- 控制事件只允许 `{"type": ..., ...}` 结构，类型：`initial_sync_review`、`task_file_conflict`、
  `task_sync_error`。已删除的旧 JS Agent 里 `live-sync.js` 从未装配（其 `fetchLiveFiles`/`preflightLiveChanges` 在 JS 侧
  无任何实现，服务端也无对应路由），属死代码，Rust 不再移植实时文件同步。
- 超时预算：登录/登出/关联列表 15s；inspect-project / 实时决策 60s；首次同步与备份恢复 120s；
  check-push / preflight 240s；associate / initialize-project 600s；`trellis init` 210s；
  `task.py` 150s；npm 安装 300s。
- 认证被撤销（401 或 `AUTH_REVOKED`）时停止循环、写 `state.json`，不静默重试。
- 本地改动只经 `TaskSync` 的 notify watcher 上传：监听 `<repo>/.trellis`，只关心 `.trellis/tasks/**`，
  250 ms 静默窗口合并后按任务目录调用 `upload_dirty`；不得新增独立的实时同步通道。
- 分支守卫：`pull`/`apply_server_groups`/`upload_directories`/`upload_batch`/`decide_conflict`/
  `resolve_initial_sync` 执行前必须 `assert_binding_branch`（对照 JS `d58b021`）。守卫码
  `BRANCH_MISMATCH`/`BRANCH_INVALID`/`DETACHED_HEAD`/`GIT_FAILED`/`NOT_GIT_REPOSITORY`/
  `REPO_NOT_FOUND`/`REPO_PATH_INVALID` 由本机决定，心跳合并时不得被服务端字段覆盖。
  上传请求必须带 `observedBranchName`；同仓库多绑定时 `select_bindings` 逐个探分支，唯一匹配才启用。
  同一 `localRepoKey` 的 approved 绑定超过一个时，`ConfigStore` 拒写（`CONFIG_INVALID`，
  需要并行多分支请用独立 worktree）。
- 游标串行化：`write_cursor` 必须先拿 `<data>/agent/.live-cursors.lock`（`lock_task_cursors`），
  再重读磁盘合并写入。批次 409 且 `serverCode == "CONFLICT"`、`details.requiredClientSequence`
  为正整数时，改写 pending 序号后重试一次（对照 JS `0fd2dc0`）。
- 本地暂缓任务（`cursor.deferred`）只能由 `sync_deferred_tasks` 显式补传；只读绑定直接拒绝。
- 托盘同步项只有运行/暂停两种文案（"暂停同步"/"恢复同步"）。外部 sidecar 时代的
  `force_restart`（进程终止、`agent.lock` 备份、崩溃重启计数）在进程内 Agent 下没有对应物，
  不得再引入。
- 命令结果必须 POST 到 `/api/agent/commands/{id}/result`；`waitingIndex` 场景允许 8 次重试，
  其他失败 2 次。
- 数据兼容：`data/agent/config.json`、`state.json`（schema 2）、`credential.dpapi`（schema 1）、
  `event-cursors.json`、`live-cursors.json` 的路径与字段不得改名（`live-cursors.json` 现由
  `TaskSync` 独占，文件名沿用旧值）。`client.json` schema 3 新增 `node_runtime`、
  `trellis_runtime`（snake_case），旧 schema 2 读取时自动迁移。
- `TRELLIS_AGENT_ROOT` 优先于 `%LOCALAPPDATA%/TrellisBoardAgent`（独立 Agent CLI 场景）。

## 3. 环境门

- 首次启动先 `runtime_status`：Node ≥ 18.17.0，Trellis CLI ≥ 0.6.17（读包内 `package.json.version`）。
- 查找顺序 Node：flag → PATH；Trellis：flag → `<data>/npm-global` → `npm root -g` → PATH。
- 缺失时 `runtime_install`：npmmirror 下载 `node-v24.22.3-win-x64.zip` 并校验 sha256
  （`e612af99f626ab415ea225af6bce5c971feb448cb5cae250bb1c3fa50c5f7d9f`），只解出 `node.exe`
  与 npm，然后 `npm install -g --prefix <data>/npm-global @mindfoldhq/trellis@0.6.17`。
- 进度通过 `runtime-progress` 事件推送，阶段名固定为 `node:download`、`node:verify`、
  `node:extract`、`node:validate`、`trellis:install`、`trellis:validate`、`write-flag`、`ready`。
- 初始化项目必须使用环境门确定的 `node.exe` 与 `cli.js`，不得回退到任意系统 `node`。
- 运行期除环境门校验与项目初始化外不得产生 `node.exe` 子进程。

## 4. 文件与路径安全

- 所有写入路径必须先经 `is_path_inside` 校验，任务目录必须位于 `.trellis/tasks` 下且拒绝 `..`。
- 写入使用临时文件 + rename；目录替换先备份再原子换名。
- 任务快照上限：单文件 1 MiB、1024 文件、64 MiB/批；服务端快照/目录响应按 32 MiB 收取（整仓累计
  轻易超过 1 MiB）；文本按 UTF-8 读取，BOM/CRLF 规范化。
- 日志与错误消息必须脱敏（Bearer、URL 凭据、password/token、Windows 绝对路径）并截断。

## 5. 编码约束

- 禁止 `unwrap`/`expect`/`panic!`（测试除外）；release 为 `panic = "abort"`。
- 不阻塞 UI 线程：网络、git、子进程、文件遍历一律在 tokio 任务中执行。
- 单实例由 `tauri-plugin-single-instance` 保证；重复启动只聚焦已有窗口。

## 6. 快速初始化编码 Agent

- 远程 Board 只提交 `taskSpaceId`、developer ID 与 Agent ID 列表，不能提交 `repoPath` 或任意本地路径；
  命令名 `inspect_associated_project_agents` / `initialize_associated_project_agents` 与
  `capabilities/board-local-association.json`、`permissions/desktop.toml` 保持一致。
- 解析仓库前必须先 `validate_live_id(task_space_id)`，再从 `agent_service::list_associations` 中挑出
  `task_space_id` 相同且 `status == "approved"` 的绑定取 `repo_path`；没有 approved 绑定直接返回
  `请先关联本地 Git 项目，并确认关联状态为 approved`，不得回退到 pending 或任意路径。
- `MAX_AGENT_TOOLS` 必须覆盖 `packages/shared/trellis-agent-tools.js` 的完整目录（当前 22 项）；
  每项 trim 后 1..=40 字节且只含 `[a-z0-9-]`，超出上限返回错误而不是截断。
- 复用 `agent_service::inspect_project` / `initialize_project` 的增量语义：不新增 CLI 入口、
  不重启进程内同步、不 commit/push、不修改服务端项目或任务数据；只读 approved 绑定同样可用。

## 7. 本地前端（环境门、登录页、控制窗口）

- 源码是 `apps/web/desktop/{index,control}.html` 与 `apps/web/src/desktop/**`（React 19 + TypeScript +
  Tailwind v4 + `apps/web/src/components/ui`），由 `apps/web/vite.desktop.config.ts` 输出到 `apps/desktop/ui/`；
  `apps/desktop/ui/` 被 `.gitignore` 忽略，是构建产物，不得手写页面或脚本。
- `npm run build:desktop` 必须先于 `cargo tauri build`；`cargo tauri build` 只打包
  `frontendDist = ../ui` 的现有产物，CI 在 `windows.yml` 的 `Build desktop UI` 步骤构建。
- `control.html` 必须保留 `Content-Security-Policy` meta（`script-src 'self'` / `style-src 'self'`）；
  构建产物不得包含内联 `<script>`/`style`，Vite 用 `base: './'` 输出相对资源路径。
- IPC 只通过 `window.__TAURI__`（`app.withGlobalTauri = true`），命令名必须与
  `capabilities/main.json`、`capabilities/live-control.json` 以及 `main.rs`/`agent_service.rs`
  注册一致；控制窗口只能调用 `live_control_pending`、`live_control_decide`、`live_control_diff`、
  `live_control_initial`、`live_control_dismiss`。
- 事件类型、review 选项和动作字符串以 Rust 侧为准（`use-server`/`overwrite-server`/
  `save-local-copy`，`mode` 为 `safe`/`review`），前端不得新增动作值。
- 控制窗口固定 560×420，布局必须单列可用；diff 对照块只在 ≥768px 才切换为双列。

## 8. 打包与验证

- `tauri.conf.json` 不得出现 `bundle.externalBin` 或 `bundle.resources`（trellis-runtime）。
- `apps/desktop/` 下不得出现 `sidecar/`、`package.json`、`package-lock.json`、`binaries/`、`resources/`。
- `package-portable.ps1` 只打包 `trellis-board-client.exe` + `VERSION.txt` + `SHA256SUMS.txt` + 使用说明。
- 客户端只分发绿色 ZIP：`bundle.active = false`，保留 `bundle.icon`（tauri-build 靠它写 EXE 图标和版本资源），
  不得重新开启 `bundle.targets`、`installerHooks`、`install.ps1`/`uninstall.ps1` 或 NSIS 工具缓存。
- 验证：`cargo fmt --check`、`cargo clippy --all-targets -- -D warnings`、
  `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`（crate 只有 bin target，`--lib` 会报
  `no library targets found`）、`npm test`、`cargo tauri build`（`target/release` 只有
  `trellis-board-client.exe`，无 `bundle/nsis/`）。
