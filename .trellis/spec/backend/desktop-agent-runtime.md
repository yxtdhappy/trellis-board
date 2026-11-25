# 桌面 Agent 运行契约（进程内 Rust）

**何时阅读**：修改 `packages/desktop/src-tauri/src/agent/**`、`agent_service.rs`、`runtime_commands.rs`、
`packages/desktop/src-tauri/src/main.rs` 的 Tauri 命令、`packages/web/src/desktop/**` 本地登录/环境门与看板内同步确认弹窗 UI，
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
| `agent/trellis_cli.rs` | `packages/desktop/sidecar/trellis-runtime.js` | 执行完整 `init` 或 stdin Agent-only 配置，不含安装逻辑 |
| `agent/env.rs` | 新增 | 环境门：Node/Trellis 检查、npmmirror 下载、npm 私有前缀安装 |
| `agent/device.rs` | `packages/desktop/sidecar/desktop-device.js` | 登录、登出、入网、撤销、本地关联读取 |
| `agent/association.rs` | `packages/desktop/sidecar/desktop-association.js` | associate / preflight 编排与错误文案 |
| `agent/task_sync.rs` | `agent/task-snapshot-sync.js` | 任务快照 cursor、上传/拉取、冲突与首次同步 |
| `agent/task_control.rs` | 新增 | snapshot controls、taskVersion、lease 与 tombstone 状态机 |
| `agent/task_command.rs` | `agent/task-command.js` | create_task / assign_task / sync_branch / refresh_status |
| `agent/runtime.rs` | `agent/index.js` | 心跳 15s、SSE 事件循环、命令重试、state.json 状态机 |
| `agent/control.rs` | — | 控制事件队列（上限 32、按 key 去重、过期与 suppression） |
| `agent_service.rs` | `packages/desktop/sidecar/main.js` | 进程内生命周期、Tauri 命令实现、控制队列事件发射与主窗口唤起 |

根目录 `agent/`（Node CLI）与 `packages/desktop/sidecar/` 都已删除；右列只用于追溯协议版本、错误码和数据
格式的来源，不是可修改的代码路径。行为以 Rust 模块和 `cargo test` 为准。

## 2. 必须保持的契约

- 协议版本固定 `AGENT_PROTOCOL_VERSION = 3`；错误码集合固定在 `packages/desktop/src-tauri/src/agent/protocol.rs`，
  服务端据此判定可重试与终止。
- Tauri 命令返回前端可直接读取的扁平对象：`check_pending_project_push`、`preflight_pending_project`、
  `associate_pending_project`、`list_local_associations` 都不允许再套 `{ ok, result }` 中间层；
  只有 `inspect_project` / `initialize_project` 使用 `{ ok, project }`，由前端
  `packages/web/src/lib/project-inspection.js` 的 `normalizeProjectInspection` 解包。
- `ControlHub` 只接收 `initial_sync_review`、`task_file_conflict`、`task_sync_error` 三类模态控制事件。
  `task_handoff` 是独立非阻塞事件，不得进入 `ControlHub`、不得调用 `focus_main_window`。已删除的旧
  JS Agent 里 `live-sync.js` 从未装配（其 `fetchLiveFiles`/`preflightLiveChanges` 在 JS 侧无任何实现，
  服务端也无对应路由），属死代码，Rust 不再移植实时文件同步。
- 分支守卫错误（`BRANCH_MISMATCH`/`BRANCH_INVALID`/`DETACHED_HEAD`/`GIT_FAILED`/`NOT_GIT_REPOSITORY`/
  `REPO_NOT_FOUND`/`REPO_PATH_INVALID`）是持续状态，不得作为 `task_sync_error` 进入 `ControlHub`。
  只在从非暂停进入暂停时发一次 `task_sync_notice`，且必须由 `assert_binding_branch` 在所有调用路径
  上统一发射（不能只依赖 `select_bindings`，否则 ownership/pull 路径会先持久化并吞掉边沿）。
  事件由 `publish_control` 直接转成 `task-sync-notice` Tauri 事件：不发系统通知、不弹模态框、
  不调用 `focus_main_window`；暂停期间重复心跳、切换另一个非绑定分支、进程启动/窗口重载都不得重复提醒。
- 超时预算：登录/登出/关联列表 15s；inspect-project / 实时决策 60s；首次同步与备份恢复 120s；
  check-push / preflight 240s；associate / initialize-project 600s；`trellis init` 与 Agent-only 配置 210s；
  Pi/OMP 模板补齐 helper（snapshot / repair / hash）各 30s；`task.py` 150s；npm 安装 300s。
- 认证被撤销（401 或 `AUTH_REVOKED`）时停止循环、写 `state.json`，不静默重试。
- 本地改动只经 `TaskSync` 的 notify watcher 上传：监听 `<repo>/.trellis`，只关心 `.trellis/tasks/**`，
  250 ms 静默窗口合并后按任务目录调用 `upload_dirty`；不得新增独立的实时同步通道。
- `TaskSync` 生命周期与无泄漏停止：`TaskSync.watch` 使用同步 `std::sync::Mutex` 并在后台 `watch_loop` 中仅持有 `Weak<TaskSync>`（仅在处理单批事件期间短暂 `upgrade`，空闲期不保留强引用）；`TaskSync::stop(&self)` 发送 `watch_shutdown` 信号、清空 `watchers` 与 `tx` 并唤醒 `ownership_validation_state`。`AgentRuntime::stop()` 与 `Drop for TaskSync` 均调用 `TaskSync::stop()`，确保 `restart` / `stop` 后旧 watcher 立即退出且不发生同机双传自冲突。
- 运行态缓存一致：`agent_service::decide_live_change` 在 `AgentRuntime` 运行且持有目标绑定时，直接复用运行中的 `TaskSync`（经 `task_space_sync_lock` 串行化）执行 `decide_conflict`，使内存 `cursor_state` 与 `task_control_state` 保持同步；仅当后台未运行时回退临时 `TaskSync`。
- snapshot 带 `controls` 时只允许落地 `materialized/claimed/pending_delivery`，且先 claim；
  `archived/reassigned/handoff_materialized` 不得继续自动上传。`archived/reassigned` 只保留本地数据、
  释放已知失效 lease、记录控制状态并停止自动上传。
- taskVersion 与 claim/heartbeat lease 持久化到 `<agent data>/task-control-state.json`；注销、
  换账号和重新注册必须随 cursor/ownership 一起清理。`live-cursors.json` 路径和字段保持兼容，
  pending batch 重试可复用持久 lease，失效后再 claim。
- 控制面 `create_task` payload 包含 `taskId`、`taskVersion` 和 `executionTaskKey`；协议白名单
  必须接收这些字段，客户端在本地写任务前用显式 executionTaskKey claim，缺失时才允许按
  taskSpace/taskId 从受控 payload 派生，不能因字段过滤而绕过 claim。
- creator 收到 `handoff_materialized + source_cleanup_pending` 后走独立清理通道：
  - 任务目录必须是真实目录且不与服务端控制身份冲突；
  - cursor baseline 必须覆盖且只覆盖本地完整文件集合，`task.json.id`、目录摘要与该基线一致；
  - `git status` 中该任务文件必须非空且全部为 `??`；
  - 备份上限为 100,000 文件和 64 MiB 规范化文本；`backupId` 固定为
    `handoff-<manifestSha256前16位小写hex>`；
  - 满足条件时先复制完整目录到 `live-backups/<taskSpaceId>/<backupId>`，写入
    `handoff-manifest.json` 和 `handoff-meta.json`，再把 `cleaned` ACK 持久化为 pending，最后删除目录；
  - 备份写入后必须回读校验 manifest 摘要、完整文件集合、逐文件摘要与规范化字节数、总字节数，以及
    taskSpace、executionTaskKey、taskId、taskDir 和 materialized revision；复制或元数据验证失败时
    清理本次新建的不完整目录；
  - dirty、Git tracked、Git 状态不确定、文件集合或摘要不一致时保留本地目录并 ACK `conflict`；
  - ACK 网络失败保持 pending，后续控制同步、事件触发和重启后重试；服务端返回
    `409 HANDOFF_CYCLE_STALE` 时同样保持 pending，不标记 done、不转 conflict，由下一轮控制重置后
    重新清理和 ACK。重试 `cleaned` 前必须重新验证完整
    备份；缺失、非目录、身份或摘要不一致时改为 `conflict/missing`，本地检查异常改为
    `conflict/unknown`，不能发送虚假 cleaned；
  - 控制面 `leaseHeldByOtherUser=true` 时不得自动删除，ACK `conflict/lease_active`；服务端返回
    `HANDOFF_LEASE_HELD` 时同样收敛为冲突；
  - 删除前重新校验来源 manifest 与真实分支。删除时先把活动目录原子重命名到
    `.trellis/.agent-handoff-cleanup-<uuid>`，验证为真实目录后再递归清理；后续每次控制同步清理遗留
    暂存目录，失败不得删除源目录。
- 服务端 handoff ACK 的 `cleaned` 必须携带合法 `backupId`、64 位小写 manifest SHA-256、
  `fileCount >= 1` 和 `totalBytes >= 1`；新客户端还必须携带当前轮次的 `materializedAt` 与
  （存在时）`materializedRevision`，服务端在幂等判断前做轮次 fencing：以 `materializedAt` 为主，
  仅 at 缺失时才比较 revision，不一致时返回 `409 HANDOFF_CYCLE_STALE` 且不改状态、不写审计；
  旧客户端两个字段都缺省时保持兼容。已完成终态重复 ACK 只有在轮次匹配且 outcome、reason、backupId、
  manifest、文件数和总字节数完全一致时才幂等返回，否则返回 `HANDOFF_ACK_MISMATCH`。
- `TaskSync` 在 cursor、binding、ownership 或本地 Git 投影实际变化后通过统一 state sink 通知；
  `write_cursor` / `remove_task_cursor` 必须在落盘成功且 patch 确已改变状态后才通知，无变化不得发射。
  Git watcher 只监听 HEAD、index、packed-refs 和 refs，用于失效 ownership 投影，不触发任务正文上传。
- ownership 投影缓存按 `task_space_id` 隔离失效：单个任务空间或 Git watcher 事件只能推进该
  taskSpace 的 local epoch；`set_bindings` / `update_bindings` 的绑定全集变化才推进 global epoch。
  `cache_ownership_projection` 回写前必须同时校验 global/local epoch 和 binding 身份，防止无关仓库
  的失效阻断当前仓库缓存。回归点：`unrelated_projection_invalidation_does_not_block_cache_write`。
- ownership 派生索引持久化到 `<agent data>/ownership-index.json`，schema 版本固定为 `3`。运行中的
  Agent `TaskSync` 是唯一写者；登录、接入、命令等临时 `TaskSync` 只能读取，不得回写。索引只保存
  binding 身份、HEAD/ref 与 Git index 指纹、HEAD tracked paths，以及 `task.json` 的 size/mtime/摘要/
  `id`/`branch`、支持任务文件的 size/mtime/摘要、文件缓存是否完整和当前脏任务目录，不得保存任务
  正文或凭据。文件损坏、超限、schema/binding 不匹配或路径非法时必须丢弃对应内容并回退权威校验。
- 稳定启动允许先用持久索引返回 ProjectRail 的只读 ownership 投影，再在后台做增量校验；这不能放宽
  上传、pull、merge、冲突覆盖和 ownership 写操作门禁。启动期 ownership 校验与 pull 必须串行，
  避免单仓库同时发生任务元数据扫描和完整快照扫描。
- 启动同步未完成时 heartbeat 仍按 15 秒发送以保活设备，但 `syncing` binding 不得进入
  `listeningTaskSpaceIds`；SSE 命令必须等待该串行链完成，避免新命令与初始 pull 并发。watcher 可提前
  安装，但 task 事件只能暂存，必须在 pull 与二次 ownership 校验后的同一串行链中补传，不能丢事件。
- 稳定态 `ownership_projection` 先直接读取 `.git/HEAD` 和 loose/packed ref 指纹；指纹未变时复用
  `OwnershipProjectionCache`，不得启动 `git.exe`。只有指纹变化或指纹读取失败时才调用
  `binding_head` / `assert_binding_branch` 做精确 Git 门禁。缓存兜底 TTL 为 15 秒，watcher 覆盖
  `HEAD`、`index`、`packed-refs` 和 `refs`；稳定态 `git.exe = 0` 是预期结果，不代表停止监听或同步。
- 分支守卫：`pull`/`apply_server_groups`/`upload_directories`/`upload_batch`/`decide_conflict`/
  `resolve_initial_sync` 执行前必须 `assert_binding_branch`（对照 JS `d58b021`）。守卫码
  `BRANCH_MISMATCH`/`BRANCH_INVALID`/`DETACHED_HEAD`/`GIT_FAILED`/`NOT_GIT_REPOSITORY`/
  `REPO_NOT_FOUND`/`REPO_PATH_INVALID` 由本机决定，心跳合并时不得被服务端字段覆盖。
  上传请求必须带 `observedBranchName`；同仓库多绑定时 `select_bindings` 逐个探分支，唯一匹配才启用。
  同一 `localRepoKey` 的 approved 绑定超过一个时，`ConfigStore` 拒写（`CONFIG_INVALID`，
  需要并行多分支请用独立 worktree）。
- 心跳绑定解析与合并：`POST /api/agent/heartbeat` 在 `status == "rejected"`（`BINDING_UNKNOWN`、
  `REMOTE_MISMATCH`）时允许省略 `id` / `projectId` / `localRepoKey`，并在任务空间停用/弃用时返回
  `status == "disabled"`。`protocol::parse_server_binding` 仅对 `rejected` 放行缺失/`null` 元数据，
  只要字段存在仍必须通过 `assert_safe_id` / `is_sha256_hex`；`store::validate_binding` 与协议层同样
  允许 `"disabled"`。登录复用（`device::reusable_device`）与运行期心跳共用
  `runtime::merge_heartbeat_bindings`：非 `approved` 状态不保留旧分支守卫或覆盖为
  `BINDING_BRANCH_MISMATCH`，`REMOTE_MISMATCH` 不因 `localRepoKey` 不一致被跳过，`BINDING_UNKNOWN`
  且无 `id` 时清空 `server_binding_id`。
- 游标串行化：`write_cursor` 必须先拿 `<data>/agent/.live-cursors.lock`（`lock_task_cursors`），
  再重读磁盘合并写入；patch 没有改变 revision、sequence、baselines、deferred、ownershipPending、
  conflictBlocked 或 pending 时不得更新时间戳或重写文件。批次 409 且
  `serverCode == "CONFLICT"`、`details.requiredClientSequence` 为正整数时，改写 pending 序号后
  重试一次（对照 JS `0fd2dc0`）。
- 本地暂缓任务（`cursor.deferred`）只能由 `sync_deferred_tasks` 显式补传；只读绑定直接拒绝。
- 托盘同步项只有运行/暂停两种文案（"暂停同步"/"恢复同步"）。外部 sidecar 时代的
  `force_restart`（进程终止、`agent.lock` 备份、崩溃重启计数）在进程内 Agent 下没有对应物，
  不得再引入。
- 命令结果必须 POST 到 `/api/agent/commands/{id}/result`；`waitingIndex` 场景允许 8 次重试，
  其他失败 2 次。
- 数据兼容：`data/agent/config.json`、`state.json`（schema 2）、`credential.dpapi`（schema 1）、
  `event-cursors.json`、`live-cursors.json` 的路径与字段不得改名（`live-cursors.json` 现由
  `TaskSync` 独占，文件名沿用旧值）。`client.json` schema 3 新增 `node_runtime`、
  `trellis_runtime`、`python_runtime`（snake_case），旧 schema 2 读取时自动迁移；`serverUrl`
  允许缺省为空串（登录前文档只有运行时标记），登录保存必须保留三个运行时 flag。新增
  `task-control-state.json` 保存控制状态、lease fencing 和 handoff ACK/通知去重状态，不保存任务正文
  或本机绝对仓库路径。
- `TRELLIS_AGENT_ROOT` 优先于 `%LOCALAPPDATA%/TrellisBoardAgent`（独立 Agent CLI 场景）。
- worktree 自动接入（`WorktreeService::reconcile`，15s）：已自动接入（`auto_managed=true`）的条目在
  `git worktree list` 不再列出、且（路径不存在 或 本轮列举全部成功）时视为删除，按 `task_space_id`
  + 路径匹配 binding 调 `detach::detach_local_association`（`detach_pending` 也继续重试）；成功或
  终态错误后删注册表条目，并用重读的 config 刷新 `TaskSync` 与 watcher。没有匹配 binding 的条目
  直接删。手工接入（`auto_managed=false`）不自动解绑，沿用分支守卫错误。解绑失败只记日志，条目
  保持 `hidden_missing`（分支隐藏、不进入任何用户提示），下轮 reconcile 重试。

## 3. 环境门

- 首次启动先 `runtime_status`：Node ≥ 18.17.0，Trellis CLI ≥ 0.6.17（读包内 `package.json.version`），
  Python ≥ 3.9.0。解析先只用 flag / 私有前缀；Node 或 Trellis 未就绪时才执行一次 PowerShell 刷新，
  flag 均有效时不启动 PowerShell。
- 查找顺序 Node：flag → PowerShell 重新读取机器/用户 `PATH` 后 `where.exe node`（`-NoProfile
  -NonInteractive`、15s 超时，失败静默降级）→ PATH 与版本管理器/常见安装前缀（fnm `aliases/*`、
  `node-versions/*/installation`、nvm `v*` 子目录与 `NVM_HOME`/`NVM_SYMLINK`、
  `FNM_DIR`/`FNM_MULTISHELL_PATH`、`VOLTA_HOME/bin`、`%ProgramFiles%\nodejs`、`%APPDATA%\npm`、
  `%LOCALAPPDATA%\pnpm`）→ `<data>/runtime/node/node.exe`（客户端私有运行时，仅作兜底，flag 丢失时
  自愈写回 `source: "client"`）→ 登录页手动指定；fresh `where.exe` 结果必须排在进程启动时的 PATH
  快照之前。
  Trellis：flag → `<data>/npm-global` → 同一批前缀目录下的全局包（不跑 `npm root -g`，npm.cmd 内部
  同样依赖 PATH）；Python：flag → `TRELLIS_PYTHON` → fresh `where.exe python.exe` → 静态 PATH 的
  `python.exe` → 常见安装根目录
  （`%LOCALAPPDATA%\Programs\Python\Python*`、`%ProgramFiles%\Python*`、`%SystemDrive%\Python*`）→
  `py -3`（用 `py -3 -c "import sys; print(sys.executable)"` 解析出真实解释器）。
  0 字节文件（Windows App Execution Alias）不得作为可执行文件；flag 版本过低时必须继续探测其它候选。
  探测成功后写回 flag，Agent 只认 flag；客户端私有前缀解析成功时同样写回 `trellis_runtime`。
- 手动兜底 `runtime_set_node_path`：接受 `node.exe` 或它所在目录（去首尾引号，不展开 `~`/环境变量），
  必须存在、可执行且 ≥ 18.17.0，成功写 `node_runtime`（`source: "manual"`），失败返回
  `NODE_PATH_INVALID` 且不改动已有 flag。仅本地登录页 capability 可调用。
- `client.json` 契约：`schemaVersion` 为 camelCase；旧 `schema_version` 不再读取（只含旧键的文件按无配置处理），
  `serverUrl` 可缺省
  （环境门在登录前写 flag），三个运行时 flag 键为 `node_runtime` / `trellis_runtime` / `python_runtime`
  （兼容 `nodeRuntime` 等 camelCase 别名）；登录保存时必须保留三个 flag。
- `runtime_install` 是**增量安装**：先复用环境门已解析的 Node / Trellis / Python，只对缺失组件执行
  下载或安装。Node 可用时不下载私有 Node；Trellis 缺失时优先用已解析的 Node 执行
  `npm install -g --prefix <data>/npm-global @mindfoldhq/trellis@0.6.17`，仅当该 Node 没有 npm 时才
  补私有 Node。Node 缺失时才从 npmmirror 下载 `node-v24.22.3-win-x64.zip` 并校验 sha256
  （`e612af99f626ab415ea225af6bce5c971feb448cb5cae250bb1c3fa50c5f7d9f`），只解出 `node.exe`
  与 npm。运行时 flag 与 `schemaVersion` 统一由 `runtime_commands` 保存到 `client.json`。
- Python 缺失或低于 3.9 时安装官方安装器 `python-3.12.8-amd64.exe`
  （sha256 `71bd44e6b0e91c17558963557e4cdb80b483de9b0a0a9717f06cf896f95ab598`），参数
  `/quiet InstallAllUsers=0 PrependPath=1 Include_launcher=1 InstallLauncherAllUsers=0 Include_test=0 Include_doc=0 Shortcuts=0`；
  per-user、无 UAC，退出码 0 与 3010 都算成功，失败抛 `PYTHON_INVALID`。已有低版本不卸载，侧装并存。
- 进度通过 `runtime-progress` 事件推送，阶段名固定为 `node:download`、`node:verify`、
  `node:extract`、`node:validate`、`trellis:install`、`trellis:validate`、`python:download`、
  `python:verify`、`python:install`、`python:validate`、`write-flag`、`ready`。静默安装器无输出，
  `python:install` 靠 5 秒心跳续期进度。
- 初始化项目必须使用环境门确定的 `node.exe` 与 `cli.js`，不得回退到任意系统 `node`。
- 运行期只有 `task.py create` 与 `task.py set-branch`（含同步时的分支推断/冲突决策）需要 Python；
  候选顺序是 `TRELLIS_PYTHON` → `client.json` 的 `python_runtime.path` → `python` → `py -3`，
  只有 spawn 失败才继续下一个候选。

## 4. 文件与路径安全

- 跨端任务目录身份只使用仓库相对 `taskDir=".trellis/tasks/..."`；本机 `repoPath` 只用于当前客户端映射，
  不得参与跨客户端身份或写入控制事件。
- 任务目录必须由 `resolve_task_dir_under(tasks_root, taskDir)` 逐段解析并保持在 `.trellis/tasks` 下；
  不得只对一个绝对路径做 `canonicalize` 后与另一形态的绝对路径比较。Windows 普通路径与
  `\\?\` 扩展路径都必须落在同一根下。
- 根目录、`.`、`..`、空段、反斜杠、NUL、盘符、ADS 和其他异常段必须拒绝。写入、删除、备份共用同一
  规则，任何路径或符号链接失败都必须失败关闭，不得静默跳过并推进 cursor。
- `task_sync_error` 应携带 `projectName`、`branchName` 和可选 `taskDir`；同步确认弹窗优先显示
  `项目 / 分支`，`taskSpaceId` 只作诊断，且不得发送 `repoPath`。
- 写入使用临时文件 + rename；目录替换先备份再原子换名。
- 任务文件上限：单文件 1 MiB；实际 HTTP 上传批次最多 1024 文件、64 MiB。全 taskSpace 聚合扫描
  和按任务目录分组可以超过批次上限；服务端快照/目录响应按 32 MiB 收取（整仓累计轻易超过 1 MiB）；
  文本按 UTF-8 读取，BOM/CRLF 规范化。
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
- 已有 `.trellis/tasks` 且只缺所选 Agent 时必须走内嵌 Agent-only helper；只有缺少 `.trellis` 或
  `.trellis/tasks` 才执行完整 `trellis init`。helper 通过 stdin 复用包的 `configurePlatform`、
  `setWriteMode("skip")` 和 `initializeHashes(..., { merge: true })`，不得写 spec、workflow、任务或根文件；
  模块缺失、未知平台、Python 检测或平台配置失败必须失败关闭，不得退回完整初始化。
- Agent-only 不经过 `trellis init`，必须在配置平台之前补齐 developer 身份：调用内嵌 helper 的
  `developer <name>` 模式，按 Trellis 0.6.17 `init_developer.py` 的语义写 `.trellis/.developer`
  （`name=<name>` + `initialized_at`）与 `.trellis/workspace/<name>/{journal-1.md,index.md}`。
  已有有效 `name=` 的 `.developer` 不覆盖、不创建第二个 workspace；文件直写，不经过临时文件 + rename；
  名称拒绝路径分隔符、盘符、ADS、控制字符和以点/空格结尾；workspace 必须经 native realpath 留在仓库根内。
  developer helper 失败时不得配置 Agent，避免出现「Agent 已初始化但 developer 缺失、无法重试」的半成品。
- Pi / OMP 模板的原子写（`.<name>.<pid>.tmp` → `.ts`）在 Windows DLP 下会返回 `EXDEV`；完整 init 与
  Agent-only 配置共用 `trellis_cli.rs` 的「识别 → 补齐 → 单次重试」：仅当所选工具含 `pi`/`omp` 且输出
  （含反斜杠形式）或仓库命中 `.pi/extensions/trellis` / `.omp/extensions/trellis` 签名时触发；同时选择
  两者时一次补齐覆盖全部所选平台，重试只执行一次。补齐失败按平台返回
  `Pi` / `OMP` / `Pi/OMP 模板补齐失败`，重试仍失败返回
  `<fallback>（模板已补齐，重试仍失败）`，不得循环重试或伪造成功；其他 `EXDEV` 与普通初始化错误保持原行为。
- 首次 init 的 EXDEV 是预期失败：`run_process` 的通用失败日志必须可抑制；命中补齐平台时记录
  INFO（进入补齐），非补齐失败仍记录 WARN，避免把已恢复的失败呈现为告警。
- 补齐 helper `agent_template_repair.mjs` 通过 `include_str!` 内嵌，经环境门确定的 `node.exe` + `cli.js`
  从 stdin 执行，复用包的 `collectPlatformTemplates` / `resolveSupportedPython` / `initializeHashes`。
  `repair` 只创建缺失文件并使用 `openSync(..., "wx")` 直写，禁止临时文件 + rename，已有文件不读不覆盖；
  目标与父目录必须经 realpath 校验留在仓库根内，失败回滚本次创建的文件。realpath 一律使用
  `fs.realpathSync.native`：helper 必须在加载任何 Trellis ESM 模块之前把 `fs.realpathSync` 替换为
  native，因为 Node JS 版实现会先 `lstat` 盘符根（`D:`），部分 DLP/网络盘会以 `EISDIR` 拒绝，
  且 ESM resolver 的模块解析同样会触发该调用。裸盘符 `X:` 仍需先规范为 `X:\`，盘符根的
  realpath/stat 可直接跳过。`snapshot` 在首次 init 前记录
  所选平台缺失的模板路径（不探测 Python，失败静默降级）；补齐并重试成功后，`hash` 只把「快照缺失、
  现已存在且 UTF-8 内容与模板一致」的路径并入 `.template-hashes.json`，初始化前已存在的用户文件不得登记。
  哈希补偿在 `finish_init()` 之前执行，失败不影响已成功的初始化结果。
- `.template-hashes.json` 只描述本机磁盘状态，不得随仓库共享：完整 init 与 Agent-only 完成后都要在项目根
  `.gitignore` 追加 `/.trellis/.template-hashes.json`（独立小节，等价规则去重、幂等）；首次确认推送在
  `commit_and_push_initial` 里先补规则，再对已跟踪的该文件执行 `git rm --cached`（保留工作区、只影响索引），
  脱管失败即中止提交。索引里已有其它暂存改动时退回 pathspec 提交并跳过脱管，避免把用户改动卷进初始化提交。
  不得改写 `.trellis/.gitignore`——它会被 `trellis update` 整份重写。

## 7. 本地前端（环境门、登录页）与看板内同步确认弹窗

- 桌面本地页面只剩 `packages/web/desktop/index.html`（登录/环境门）与 `packages/web/src/desktop/**` 登录壳
  （React 19 + TypeScript + Tailwind v4 + `packages/web/src/components/ui`），由
  `packages/web/vite.desktop.config.ts` 输出到 `packages/desktop/ui/`；登录后主窗口直接导航到远程 Board，
  实时同步确认没有独立窗口，而是 Board 页面内的 `packages/web/src/desktop/LiveSyncControlDialog.tsx`；
  `packages/desktop/ui/` 被 `.gitignore` 忽略，是构建产物，不得手写页面或脚本。
- `yarn build --target=desktop-ui` 必须先于 `cargo tauri build`（或直接 `yarn build --target=desktop`）；`cargo tauri build` 只打包
  `frontendDist = ../ui` 的现有产物，CI 在 `windows.yml` 的 `Build desktop UI` 步骤构建。
- `index.html` 必须保留 `Content-Security-Policy` meta（`script-src 'self'` / `style-src 'self'`）；
  构建产物不得包含内联 `<script>`/`style`，Vite 用 `base: './'` 输出相对资源路径。Board 页面由服务端提供，
  不受该 meta 约束，因此 Monaco 与其 Worker 只能在 Board 侧加载。
- IPC 只通过 `window.__TAURI__`（`app.withGlobalTauri = true`），命令名必须与 `capabilities/main.json`、
  `capabilities/board-local-association.json` 以及 `main.rs`/`agent_service.rs` 注册一致。
  `live_control_pending`、`live_control_decide`、`live_control_diff`、`live_control_initial`、
  `live_control_dismiss`、`set_task_ownership` 由 Board 页面在 `board-local-association` 窗口调用，
  全部经 `ensure_board_caller` 校验（`tauri://` 本地页面或 `board_url` 同源）；
  `capabilities/live-control.json` 已随独立窗口删除，不得恢复。
- 事件类型、review 选项和动作字符串以 Rust 侧为准（`use-server`/`overwrite-server`/
  `save-local-copy`，`mode` 为 `safe`/`review`），前端不得新增动作值。
- 手动唤起待处理控制事件只能调 `live_control_show`（capability `allow-live-control-show`）：
  它只聚焦/显示主窗口并发射 `live-control-changed`，无待处理返回 `false`；不得为确认弹窗另建窗口。
- 环境门未就绪（`needs_setup`）时登录页必须展示已检测到的组件及版本，并提供“重新检查”；
  `runtime_install` 只对实际下载/安装的组件发送 `runtime-progress`，复用组件不发送
  `node:validate`/`trellis:validate`/`python:validate`，避免前端把校验映射成下载/安装步骤。
- dev 模式：根 `yarn dev --mode=desktop` 运行 `scripts/dev.mjs`，并发启动三件事：`node --watch
  packages/server/index.js`（4317 本地服务端）、`packages/web` 根目录的 Vite（默认 5200，看板 UI + HMR +
  `/api` 代理，端口可用 `--web-port` / `VITE_DEV_PORT` 或 `TRELLIS_BOARD_DEV_PORT` 覆盖）、`cargo tauri dev`（自身 `beforeDevCommand` 再起
  `vite.desktop.config.ts` 的 5199 登录壳）。登录页服务器地址必须填 `http://localhost:5200`（或
  `127.0.0.1:5200`），它才是看板来源；5199 只服务 `desktop/index.html`，手填会得到空白页。
  `navigation::is_dev_page` 仅在 `debug_assertions` 下按 `devUrl` 同源放行导航与 `ensure_local_caller`，
  release 构建必须仍只认本地页面。dev 下 `stripDevCsp` 插件移除 `index.html` 的 CSP meta
  （`style-src 'self'` 会挡掉 Vite 注入的内联样式），release 构建必须保留该 meta。
- `packages/web/vite.config.ts` 的 `/api` 代理必须 `changeOrigin: false`：服务端 CSRF 校验要求请求
  `Origin` 与 `Host` 同源，改写 Host 会让所有写请求 403 `CSRF_REJECTED`。
- 桌面本地状态统一使用 `desktop-state-changed`，payload 为
  `{ "topics": ["associations" | "sidecar"] }`，短窗口内合并发射。Board 远程窗口 capability 必须
  显式允许 `core:event:allow-listen` 与 `core:event:allow-unlisten`。
- 控制队列内容实际变化后发射 `live-control-changed`；`LiveSyncControlDialog` 先注册监听再读取
  `live_control_pending`，页面可见时保留 10 秒兜底，隐藏时停止，focus/恢复可见时立即读取。
  `initial_sync_review` 每次内容变化都由 Rust 侧 `focus_main_window` 唤起主窗口，
  其余事件每进程只自动聚焦一次。
- handoff 状态使用独立 `handoff-control-changed` 失效事件和 `handoff_notice_pending` Tauri 命令；
  通知载荷包含 `materializedAt`（本地轮次缺失时为 `null`）。Board 可见时 `HandoffNotice` 使用
  Sonner 页内提示。隐藏或最小化时仅在 WebView 提供 Web Notification API 且权限已授予时尝试系统
  通知；API、权限或安全上下文不可用时仍以持久页内状态在恢复可见后补提示。通知按
  `executionTaskKey + handoffState + outcome + materializedAt` 去重（旧三段键仍视为已提示），同一
  任务的不同 handoff 阶段或新轮次仍可各提示一次。冲突状态提供持续可见但可手动关闭的非模态页内
  状态：关闭状态按通知键持久化到 `localStorage`，刷新/重启后仍保持，新任务或新轮次重新显示，
  关闭不改变服务端状态或本地副本；cleaned ACK 完成后页内固定状态不长期占位。该通道不得弹出
  确认框、切换页面、聚焦或激活主窗口，也不得阻塞清理 ACK。
- 弹窗使用 `components/ui/dialog.tsx` 的固定头/脚 + 单一 `DialogBody` 滚动壳，
  `sm:max-w-[min(72rem,92vw)]` / `max-h-[85vh]`；窄屏单列可用，宽屏冲突差异用 Monaco 左右分栏只读 diff。
- 冲突差异必须走 `packages/web/src/desktop/MonacoDiff.tsx`（懒加载 chunk，加载失败回退双 `<pre>`）。
  monaco 0.57 的导入路径是 `monaco-editor/editor/editor.api` 与
  `monaco-editor/editor/editor.worker?worker`：package `exports` 已把 `./*` 映射到 `./esm/vs/*.js`，
  再写 `esm/vs/` 前缀会双重拼接而失败。

## 8. 打包与验证

- `tauri.conf.json` 不得出现 `bundle.externalBin` 或 `bundle.resources`（trellis-runtime）。
- `packages/desktop/` 下不得出现 `sidecar/`、`package.json`、`package-lock.json`、`binaries/`、`resources/`。
- `package-portable.ps1` 只把 `trellis-board-client.exe` + `VERSION.txt` + `SHA256SUMS.txt` + 使用说明放进 ZIP；
  输出目录另外生成 `TrellisBoard_<version>_x64-portable.zip`、`.zip.sha256` 和 `latest.json`
  （`{version,file,sha256,size,notes,publishedAt}`），不得把 `latest.json` 塞进 ZIP。
- 客户端只分发绿色 ZIP：`bundle.active = false`，保留 `bundle.icon`（tauri-build 靠它写 EXE 图标和版本资源），
  不得重新开启 `bundle.targets`、`installerHooks`、`install.ps1`/`uninstall.ps1` 或 NSIS 工具缓存。
- 更新服务器只在构建时通过 `TRELLIS_UPDATE_SERVER` 注入（`build.rs` 声明 `rerun-if-env-changed`，Rust 用
  `option_env!`）；未设置、空值或非 http(s) 时更新整体关闭，不得退回运行时配置或默认公网地址。
- 分发出口：CI 上传 `trellis-board-desktop-windows` artifact，并在 `v*` tag 或手动触发带 `release_tag` 时
  把 zip、`.sha256`、`latest.json` 作为 Release 资产上传；artifact 永远是外层 zip 包，需要裸文件时走 Release。
- 版本号以仓库签入值为准（发版脚本写入）；CI 的 `Resolve release version` 取 `v<major>.<minor>.<patch>`，
  `Stamp version from tag` 在构建前按 tag 兜底盖章 `packages/desktop/package.json`、
  `packages/desktop/src-tauri/tauri.conf.json`、`packages/desktop/src-tauri/Cargo.toml`（`main.rs` 的
  `env!("CARGO_PKG_VERSION")` 依赖它），不得手工改版本号。
- 发版只走 `yarn release:desktop`（参数：空 = patch 递增，或 `patch`/`minor`/`major`/`x.y.z`，可加
  `--dry-run`）：校验工作区干净、HEAD 等于 `origin/main`、tag 不存在，把新版本写回
  `packages/desktop/package.json`、`packages/desktop/src-tauri/tauri.conf.json`、`packages/desktop/src-tauri/Cargo.toml`、
  `packages/desktop/src-tauri/Cargo.lock`，提交 `chore(release): <version>`，推 main 后再打注解 tag `v<version>`
  并推送；不得手工改版本、手工 `git tag` 或直接 `gh release create`。CI 的盖章步骤只作兜底。
- CI 缓存只能被「当前 ref 或默认分支」的 run 复用：tag 推送的 run 落在 `refs/tags/<tag>` 作用域，读不到
  `refs/heads/main` 的缓存（实测默认分支已是 main 仍报 `No cache found.`）。因此 `windows.yml` 里 tag 推送
  只跑 `dispatch-main` 作业，用 `gh api …/dispatches -f ref=main -f inputs[release_tag]=<tag>` 转发一次
  main 上的 `workflow_dispatch`；`node-tests` 与 `desktop-build` 都 `if: github.event_name == 'workflow_dispatch'`，
  并按 `inputs.release_tag` 检出 `refs/tags/<tag>`，于是构建在 main 的缓存作用域里进行。
  `Swatinem/rust-cache` 用 `save-if: ${{ github.ref == 'refs/heads/main' }}` 限定只由 main 写缓存，
  否则每次 tag 构建都会写出永不命中的 880 MB 副本。不得把 tag 推送改回直接构建。
- 验证：`cargo fmt --check`、`cargo clippy --all-targets -- -D warnings`、
  `cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml`（crate 只有 bin target，`--lib` 会报
  `no library targets found`）、`yarn test`、`cargo tauri build`（`target/release` 只有
  `trellis-board-client.exe`，无 `bundle/nsis/`）。

## 9. 隐藏/最小化系统通知

- 只在主窗口隐藏或最小化、且 handoff 进入终态 `cleaned`/`conflict` 时发送系统通知；窗口可见时
  只保留页内 toast，不重复发系统通知。
- WebView2 的 `http://` 非安全上下文没有 Web Notification API，不得把它作为回退；页内提示由
  Web 层负责。
- 便携版 AUMID `com.trellisboard.client` 会静默丢弃 `ToastGeneric`。Windows 原生通知必须使用
  `ToastText02`，通过 PowerShell `-EncodedCommand` 调用 WinRT `CreateToastNotifier(aumid)`；
  子进程使用 `CREATE_NO_WINDOW` 且丢弃 stdout/stderr，失败只记录日志，不阻塞清理 ACK。
- 通知文案中的任务标题/原因必须做 XML 转义；同一 handoff ID + state 只通知一次，重复
  `control.changed` 不重复弹窗。
- 验证：Rust 单测覆盖 `xml_escape` 和“只有终态才通知”；Windows 真机在客户端最小化时确认
  通知中心出现对应任务。
