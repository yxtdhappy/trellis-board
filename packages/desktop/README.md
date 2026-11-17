# Trellis Board Windows 客户端

Tauri v2 单进程客户端：Agent（心跳、SSE 事件、任务空间同步、任务命令）全部在
`trellis-board-client.exe` 内以 Rust 实现，没有任何 sidecar 或内置 Node 运行时。客户端冷启动先做
运行环境检查，再显示本地登录页；登录成功后当前 WebView 进入 Board。

- 客户端版本：`packages/desktop/src-tauri/Cargo.toml`、`packages/desktop/src-tauri/tauri.conf.json`
- Board 左上角品牌名：`packages/desktop/src-tauri/tauri.conf.json` 的 `productName`，空白时默认
  `Trellis Board`；其下方显示当前客户端版本
- Agent 协议：`AGENT_PROTOCOL_VERSION = 3`
- 本地配置：`%LOCALAPPDATA%\TrellisBoard\data\client.json`（schema 3）
- Agent 数据：`%LOCALAPPDATA%\TrellisBoard\data\agent`
- 运行环境：首次启动检查 Node.js、Trellis CLI 与 Python（≥ 3.9）；Node 与 Trellis CLI 装到
  `%LOCALAPPDATA%\TrellisBoard\data\runtime\node` 与 `%LOCALAPPDATA%\TrellisBoard\data\npm-global`，
  Python 缺失时静默安装官方 CPython 3.12.8 到当前用户目录
- 分发方式：解压即用的 Windows x64 绿色 ZIP（包内只有一个 EXE），不提供安装包

## 登录与单 Agent

```text
本地登录页
  -> app_status
  -> desktop_login(serverUrl, username, password)
  -> Tauri IPC
  -> 进程内 device::login_desktop
  -> POST /api/auth/login
  -> 写入 WebView HttpOnly Session Cookie
  -> 复用或创建当前账号设备
  -> 当前 WebView 打开 Board
```

安全边界：

- 密码只经过 `invoke -> Rust -> HTTP/HTTPS`，不进入 argv、环境变量或日志；登录成功后与服务器地址、登录名一起保存在 `client.json`，供下次启动回填。
- 远程 HTTP 不提供传输加密；非可信网络必须使用 HTTPS。
- Session Cookie 只存在当前 WebView Cookie Store 和 Rust 内存；冷启动后必须重新登录。
- 设备凭证只由 Windows DPAPI 保存；`client.json` 保存服务器地址、登录名和密码。
- 同服务器、同账号再次登录会先用已有设备 heartbeat，有效则复用。
- 一个账号同一时刻只有一个有效 Agent。新设备生效后旧设备凭证立即失效，旧 SSE 关闭，旧命令取消。
- 换设备不迁移本地仓库绝对路径、project binding、cursor 或 pending batch；新设备必须重新选择项目。
- `mustChangePassword=true` 时只建立 Board 会话，不创建设备；改密后下一次登录再建立设备。
- 升级前必须先退出托盘客户端，否则运行中的进程会锁定 `trellis-board-client.exe`，替换文件失败。

设备注册通过一次性的桌面兑换令牌调用：

```text
POST /api/desktop/enroll-tokens
POST /api/agent/enroll-desktop
```

令牌不进入 UI、磁盘、命令参数或日志，只存在于进程内单次调用内存。

## 运行环境门

首次启动（`client.json` 无 `node_runtime`/`trellis_runtime`/`python_runtime` 标志，或标志失效）显示环境检查页：

```text
runtime_status
  -> Node.js：标志 -> PATH 与版本管理器（fnm/nvm/Volta）前缀目录 -> 缺失则需安装
  -> Trellis CLI：标志 -> 客户端私有前缀 -> 上述前缀目录的全局包 -> 缺失则需安装
  -> Python：标志 -> TRELLIS_PYTHON -> PATH 的 python -> py -3（解析出真实 python.exe）-> 缺失则需安装
  -> 探测到即写回标志位 -> 全部满足：显示登录页
  -> 缺失：runtime_install
       node:download  从 npmmirror 下载 node-v24.22.3-win-x64.zip
       node:verify    sha256 校验
       node:extract   仅解出 node.exe / npm / npx
       node:validate  执行 node --version
       trellis:install  npm install -g --prefix <data>\npm-global @mindfoldhq/trellis@0.6.17
       trellis:validate 读取包内 package.json 版本
       python:download  从 python.org 下载 python-3.12.8-amd64.exe（约 27 MB）
       python:verify    sha256 校验
       python:install   静默安装：/quiet InstallAllUsers=0 PrependPath=1 Include_launcher=1
                        InstallLauncherAllUsers=0 Include_test=0 Include_doc=0 Shortcuts=0
                        （per-user，无 UAC；静默无输出，靠心跳更新进度）
       python:validate  重新探测 ≥ 3.9 的解释器
       write-flag / ready
  -> runtime-progress 事件驱动前端步骤条
```

- 系统已有 Node ≥ 18.17、trellis ≥ 0.6.17 且 Python ≥ 3.9 时直接跳过安装，只写标志位。
- Python 只被用来执行项目内的 `.trellis/scripts/*.py`（`task.py create` / `set-branch`、同步时的分支推断），客户端其余部分不依赖它；已有低于 3.9 的 Python 不卸载，侧装并存。
- 安装包内不再携带 Node 与 trellis 依赖树；环境门是项目初始化的前置条件。
- Node 只用于环境门校验与项目初始化，运行期不再有常驻 `node.exe` 子进程。

## Agent 生命周期

- Agent 与客户端同进程：`AgentRuntime` 每 15 秒心跳，SSE 长连接接收事件，断线按 1s → 60s 指数退避重连。
- 认证被撤销（401/AUTH_REVOKED）时停止同步并写 `state.json`；暂停同步只停止循环，队列状态保留。
- 控制事件（首次同步差异、任务文件冲突、同步错误）进入内存队列，列表为空时隐藏 `live-control` 窗口。
- 托盘同步项只有两种状态：运行中显示「暂停同步」，暂停后显示「恢复同步」；点击即切换。
- 项目栏仍每 3 秒读取本地关联，但上一请求未结束时跳过本次 tick，不堆积 IPC 调用。
- 托盘「开机自启」由 `tauri-plugin-autostart` 写 HKCU Run 项，指向当前 EXE 绝对路径；绿色包目录移动或改名后需重新勾选一次。

## 本地项目接入

项目栏由服务端 Board 渲染。只有 Tauri WebView 显示“接入本地项目”、关联状态和同步进程状态。

```text
Board 项目栏
  -> invoke("pick_local_project_folder")
  -> Rust 打开系统目录选择器，立即返回选中的路径
  -> 前端先弹出「接入本地 Git 项目」对话框，表单区显示骨架占位
  -> invoke("inspect_local_project", { path })
  -> 进程内 onboarding::inspect_project
  -> 校验 Git 根、origin、当前分支、.trellis/tasks 和已有 Agent 工具
  -> 缺少 Trellis 时 invoke("initialize_pending_project")
  -> 环境门的 node.exe + @mindfoldhq/trellis CLI
  -> 用户手动 commit/push
  -> invoke("check_pending_project_push")
  -> invoke("preflight_pending_project")
  -> invoke("list_local_associations") 并核对同仓库旧分支
  -> 服务端只读 manifest 与本地任务比较
  -> 用户选择暂不接入、仅同步无冲突项或查看并处理差异；替换旧分支时再次确认
  -> invoke("associate_pending_project")
  -> POST /api/agent/task-spaces/attach
  -> binding approved + initialSyncMode
  -> 首次同步完成后启动 tasks watcher
```

规则：

- 客户端只接受 Git 仓库根，不接受普通目录或 Git 子目录。
- 项目身份由规范化 origin 和当前分支组成；同远端同分支的后接入客户端命中同一 taskSpace。
- 同一 Agent 的同一本地仓库只能有一个 approved binding。切换分支会替换旧 binding，但不会删除旧
  taskSpace、任务数据或其他设备 binding。
- 需要同时同步两个分支时必须使用两个 Git worktree；每个 worktree 只绑定自己的当前分支。
- `.trellis/tasks` 已存在时跳过初始化；`.trellis` 存在但缺 `tasks` 时仍要求初始化。
- 编码 Agent 工具只影响当前设备，可后续追加；其他设备无需选择相同工具。
- 初始化不自动 commit 或 push。用户完成后由客户端比较本地 HEAD 与远端分支。
- 推送状态为 `waiting_commit`、`waiting_push`、`branch_missing`、`remote_ahead`、`diverged`、
  `unable_to_verify` 或 `ready`；网络不可达不能显示成“未推送”。
- 读取、初始化和关联只允许操作本次刚选择的 pending 项目路径，远程 Board 不能传任意本地路径。
- `read_only` binding 可以接收任务快照，但服务端拒绝上传和任务命令。

## 快速追加本机编码 Agent

已批准关联的项目分支会在项目栏文件夹图标右侧显示 Agent 入口。入口不会再次打开目录选择器，也不会
修改服务端项目、任务空间或其他设备：

```text
项目栏 approved association
  -> invoke("inspect_associated_project_agents", { taskSpaceId })
  -> Rust 从当前设备 binding 解析 repoPath 并复核 approved
  -> agent_service::inspect_project
  -> Web 多选尚未初始化的 Agent
  -> invoke("initialize_associated_project_agents", {
       taskSpaceId,
       developerId,
       agentTools
     })
  -> Rust 再次复核 approved 与输入
  -> agent_service::initialize_project(repoPath, developerId, agentTools)
```

- 远程页面只提交 `taskSpaceId`、developer ID 和 Agent ID，不能提交本地路径。
- 只读 approved binding 也可使用；初始化只写当前电脑的 Agent 配置，不改任务空间同步权限。
- 已初始化工具在弹窗中禁用并标记“已初始化”，再次打开会重新探测实际仓库文件。
- 初始化复用现有增量语义，不自动 commit、push、重启进程内任务同步或修改服务端任务数据。
- 旧版桌面客户端没有新命令时必须显示失败原因，不能静默假装成功。

## Tasks-only 同步

已关联、`approved` 的 taskSpace 由进程内 notify 监听 `<repo>/.trellis`，监听范围只有
`.trellis/tasks/**`：

```text
任务文件变化
  -> 250ms 聚合
  -> 读取完整任务目录
  -> BOM/CRLF 规范化
  -> snapshotSha256
  -> baseSha256 CAS
  -> POST /api/agent/task-spaces/:id/changes
  -> taskSpace revision + 索引 + Board tasks.changed
  -> 其他客户端拉取并原子替换任务目录
```

不进入同步协议：

- `.trellis/spec/**`
- `.trellis/scripts/**`
- `.trellis/config.yaml`
- `.trellis/workflow.md`
- `.trellis/agents/**`
- `.trellis/workspace/**`
- `.trellis/.developer`
- `.codex`、`.opencode`、`.pi` 等本机编码 Agent 目录

这些内容继续由项目 Git 管理。Team 服务端只持久化任务目录并投影 Board。

同步约束：

- 文件允许 JSON、JSONL、Markdown、文本和 YAML；单文件 1 MiB、单批 64 MiB / 1024 文件，
  且编码后的 JSON 请求不得超过 96 MiB。
- 同一批任一文件 `baseSha256` 变化，整批拒绝并返回 `TASK_FILE_CONFLICT`。
- 删除写墓碑；活动目录到归档目录的移动在一个 batch 内完成。
- 客户端按 taskSpace 串行上传和拉取；只在完整任务目录应用成功后推进 cursor。
- 响应丢失时 cursor 保留 pending batch，重试复用原 `batchId`。
- 服务端应用后的 watcher 事件按 `(absolutePath, sha256)` 抑制；内容已变化时继续上传真实编辑。
- 已有关联使用本地 cursor 增量拉取，只有首次接入或显式重建执行 full snapshot。
- “仅同步无冲突项”留下的本地任务记在 `cursor.deferred`，不会自动上传；项目栏显示
  「N 个本地任务未同步」，用户点补传后调用 `sync_deferred_tasks` 才上传（只读绑定直接拒绝）。
- 游标读写持有 `.live-cursors.lock`；批次 409 且带 `details.requiredClientSequence` 时，
  改写 pending 序号并重试一次，不放弃本地批次。

## 首次差异和冲突

首次接入先由 Web 向导执行只读预检，预检不会建立 project、taskSpace、binding 或 cursor：

- 暂不接入
- 仅同步无冲突项
- 查看并处理差异

“暂不接入”只清除待接入路径，不调用 attach，也不写本地 binding/cursor 或服务端。“仅同步无冲突项”
只下载服务端独有的完整任务目录。查看差异按稳定 task ID 分组，可逐任务选择服务端、本地、保存副本
或跳过。服务端没有快照时使用 bootstrap 模式上传本地初始任务；双方一致时直接完成，不显示空窗口。
用户明确选择后才由客户端持久化 `initialSyncMode` 和 `initialSyncCompleted`。

CAS 冲突显示任务名、文件、最后修改人、设备、时间、建议和 `conflictId`。动作包括：

- 查看差异
- 使用服务端版本
- 用我的版本覆盖
- 仅保存本地副本

“使用服务端版本”先备份本地完整目录，再原子替换；“覆盖服务端”二次确认后由服务端保存双方内容
和审计；“保存本地副本”不改变服务端。第一版不自动 merge Markdown、JSON 或 JSONL。

客户端备份位于：

```text
%LOCALAPPDATA%\TrellisBoard\data\agent\live-backups\<taskSpaceId>\<backupId>
```

## Web 创建与改派任务

Web 只向当前账号唯一 active Agent 下发命令：

```text
create_task / assign_task
  -> Board 显示独立操作项
  -> Agent SSE command.available
  -> POST /api/agent/commands/:id/start
  -> 本地 task.py create 或原子修改 task.json.assignee
  -> tasks-only CAS 上传
  -> 服务端索引命中
  -> POST /api/agent/commands/:id/result
  -> 操作 succeeded，正式任务卡或新负责人出现
```

- 目标 Agent 离线、未绑定、非项目写成员或项目停用时，Web 在创建操作项前拒绝。
- 创建只允许新增任务目录；改派只允许目标 `task.json` 变化，其他源码或任务可 dirty。
- 存在 merge/rebase/cherry-pick/revert、目标路径 dirty 或 baseline 不同则拒绝。
- 失败命令允许同幂等键重试；成功或取消后不可重试。

## 分支门禁

进程内 Agent 在首次接入、上传、拉取、watcher 上传、pending retry、延后补同步和冲突覆盖前读取本地真实
分支。真实分支与 binding 不一致时：

- 不写本地任务目录，不上传服务端，不推进 cursor；
- 不自动 checkout、switch 或迁移 pending batch；
- 项目栏显示实际分支错误和处理提示；
- 切回绑定分支后重新校验并恢复同步。

客户端不会拦截用户在菜单、终端或 IDE 中切换分支，但切换后同步会失败关闭，直到回到绑定分支。

## Tauri 权限

`capabilities/main.json` 只允许本地登录页：

- `app_status`
- `runtime_status`
- `runtime_install`
- `desktop_login`

`capabilities/board-local-association.json` 通过远程 `http://*:*` / `https://*:*` 只开放：

- `preflight_pending_project`
- `cancel_pending_project`
- `associate_pending_project`
- `check_pending_project_push`
- `initialize_pending_project`
- `pick_local_project_folder`
- `inspect_local_project`
- `list_local_associations`
- `inspect_associated_project_agents`
- `initialize_associated_project_agents`
- `desktop_sidecar_status`

Rust 仍会把当前 WebView origin 与本次登录成功的 Board origin 做同源比较。远程页面没有通用文件系统、
Shell、进程或 dialog 权限。

`capabilities/live-control.json` 只绑定本地 `live-control` 窗口：

- `live_control_pending`
- `live_control_decide`
- `live_control_diff`
- `live_control_initial`
- `live_control_dismiss`

控制窗口只处理当前首次同步或任务冲突，不拥有 Board 页面权限。

## 导航与退出

- 冷启动始终加载 `tauri://localhost/index.html` 或 Windows 等价本地 URL。
- 登录成功后动态写入允许的 Board origin，再在同一 WebView 导航。
- 同源 Board 导航允许；外链交给系统浏览器；`window.open` 一律拒绝。
- Board 跳转 `/login.html` 或 `/login` 时，客户端拦截导航、停止 Agent、撤销会话、删除 Cookie，
  清空 Board origin 并返回本地登录页。

## 目录

```text
packages/desktop/
  ui/                             构建产物：环境检查页、本地登录页、同步控制窗口（勿手改）
  src-tauri/
    src/main.rs                   窗口、登录、Cookie、动态导航、项目预检/初始化/接入
    src/navigation.rs             Board URL 白名单和同源导航
    src/config.rs                 client.json schema
    src/agent_service.rs          Agent 生命周期、控制队列与本地命令编排
    src/agent/                    进程内 Agent（protocol/store/credential/http/process/git/env/
                                  device/association/onboarding/task_sync/task_command/runtime/control）
    src/runtime_commands.rs       环境门命令（runtime_status/runtime_install）
    src/logging.rs                日志脱敏
    capabilities/                 本地登录、远程项目接入、控制窗口分离
    permissions/desktop.toml      显式命令权限
  package-portable.ps1            组装绿色目录、校验文件和 ZIP
```

## 构建

前置：

- Node.js 24（仅用于构建 `packages\desktop\ui`）
- Windows 10/11 x64
- Rust stable（MSVC toolchain）
- Visual Studio Build Tools（C++ 桌面负载）
- `cargo install tauri-cli --locked --version "^2"`
- WebView2 Runtime

```powershell
yarn build:desktop
cd packages/desktop
cargo tauri build        # 未装 cargo-tauri 时用 npx @tauri-apps/cli@^2 build
cd ../..
yarn desktop:package
```

`packages\desktop\ui` 是 `yarn build:desktop` 的产物（源码在 `packages/web/desktop` 与
`packages/web/src/desktop`，组件复用 `packages/web/src/components/ui`），已在 `.gitignore` 中忽略；`cargo tauri build`
只打包 `tauri.conf.json` 的 `frontendDist = ../ui`，不会替你构建前端，缺步骤会打出空窗口。
运行期不需要 Node.js，也没有 sidecar：`cargo tauri build` 只产出单个客户端 EXE，`bundle.active = false`
不做任何打包，不再生成 NSIS 安装器。

产物：

- `packages\desktop\src-tauri\target\release\trellis-board-client.exe`
- `packages\desktop\src-tauri\target\release\bundle\portable\TrellisBoard_<version>_x64-portable.zip`

CI（`.github/workflows/windows.yml`）跑完仍上传 `trellis-board-desktop-windows` artifact（zip + sha256）；
推送 `v*` tag 或手动触发时填写 `release_tag` 输入，还会把这两项作为 Release 资产挂到该 tag 的 Release 上。
发布时版本号不需要手工改：`Resolve release version` 从 tag 取版本，`Stamp version from tag` 在构建前写入
`packages/desktop/package.json`、`packages/desktop/src-tauri/tauri.conf.json`、`packages/desktop/src-tauri/Cargo.toml`，
绿色包名与 `VERSION.txt` 随之变化，冒烟测试会校验二者与 tag 一致。本地构建仍用仓库里签入的版本号。
tag 推送本身不构建：GitHub 的缓存只对「当前 ref 或默认分支」可见，tag run 落在 `refs/tags/<tag>`
作用域，读不到 `refs/heads/main` 的缓存（实测把默认分支切到 main 后仍报 `No cache found.`）。所以 tag
推送只跑一个 `dispatch-main` 作业，用 `gh api …/dispatches -f ref=main -f inputs[release_tag]=<tag>` 转发一次
main 上的 `workflow_dispatch`；那次 run 在 main 的缓存作用域里检出 tag 的代码执行测试、构建与发布，
`rust-cache` 的 `save-if` 只让 main 的 run 写缓存。

打 tag 用脚本，不要手工 `git tag`。版本号由脚本递增（默认 patch，也可 `minor` / `major` 或直接给 `x.y.z`）：

```powershell
yarn release:desktop -- --dry-run     # 预演：0.3.0 -> 0.3.1
yarn release:desktop                  # 0.3.0 -> 0.3.1
yarn release:desktop -- minor         # 0.3.1 -> 0.4.0
yarn release:desktop -- 1.0.0         # 指定版本，必须大于当前版本
```

脚本要求工作区干净、HEAD 与 `origin/main` 一致、tag 不存在，然后把新版本写回上面那三个文件加
`packages/desktop/src-tauri/Cargo.lock`（锁文件不同步会让本地 `cargo` 把它改脏），提交
`chore(release): <version>`，推 main，再创建注解 tag `v<version>` 并推送，触发上面那条 tag 流水线。
CI 里的盖章步骤保留为兜底，版本已一致时不会改动任何文件。

## 绿色 ZIP（免安装）

客户端只以绿色 ZIP 分发，适用于不允许运行安装器的 Windows x64 电脑。运行条件：

- Windows 10/11 x64。
- 系统已安装 Microsoft Edge WebView2 Evergreen Runtime。Windows 11 默认预装；目标 Windows 10
  镜像需由 IT 确认。

执行构建命令后，解压并运行：

```text
packages\desktop\src-tauri\target\release\bundle\portable\TrellisBoard_<version>_x64-portable.zip
  TrellisBoard_<version>_x64-portable\
    trellis-board-client.exe
    VERSION.txt
    SHA256SUMS.txt
    使用说明.txt
```

双击 `trellis-board-client.exe` 即可启动，不需要管理员权限。绿色版不会创建快捷方式；开机自启由托盘
「开机自启」勾选控制，写入 HKCU Run 的当前 EXE 绝对路径，程序目录移动或改名后需重新勾选。
登录配置、设备凭证、日志和同步数据仍保存在 `%LOCALAPPDATA%\TrellisBoard\data`。

升级与卸载见下节。ZIP 同目录的 `.sha256` 文件用于校验压缩包完整性。

## 升级与卸载

客户端不做系统级安装，升级和卸载都是文件操作：

1. 从托盘菜单退出客户端，运行中的进程会锁定 `trellis-board-client.exe`。
2. 用新版本目录替换旧目录；卸载则直接删除程序目录。
3. 勾过「开机自启」的先取消勾选，残留时删除注册表
   `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` 下的 Trellis Board 条目。
4. 彻底清理本地数据：删除 `%LOCALAPPDATA%\TrellisBoard`。

从旧 NSIS 安装版迁移：先在「设置 → 应用」卸载旧的 Trellis Board，再解压绿色包，避免两份 EXE 与
两套自启项并存。卸载后若 `%LOCALAPPDATA%\TrellisBoard` 仍在，登录配置和设备绑定可直接复用。

## 验证清单

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 无 Node 的机器解压绿色包后双击 | 出现环境检查页，安装 Node 与 Trellis CLI 后进入登录页 |
| 1b | 已有 Node ≥ 18.17 且 trellis ≥ 0.6.17 的机器 | 直接显示登录页，不出现安装入口 |
| 1c | 无 Python 或 Python < 3.9 的机器 | 环境检查页列出 Python，安装 3.12.8 后重新探测通过才进入登录页 |
| 1d | 已有 Python ≥ 3.9 的机器 | 跳过 Python 安装；`client.json` 记录 `python_runtime.path` |
| 2 | 错误密码 | 停留登录页，密码清空，不创建配置或设备 |
| 3 | 正确密码 | 当前窗口进入 Board，不弹系统浏览器；DPAPI 凭证存在 |
| 4 | 检查 `client.json` | 保存服务器地址、登录名和密码，无 Cookie 或设备凭证 |
| 5 | 选择没有 `.trellis` 的 Git 项目 | 显示初始化面板，可选择本机 Agent 工具 |
| 6 | 初始化后未 commit | 显示 waiting_commit，不能接入 |
| 7 | commit 后未 push | 显示 waiting_push，不能接入 |
| 8 | 断网检查推送 | 显示 unable_to_verify，不误报未推送 |
| 9 | 成功 push 后 | 显示 ready，可接入团队 taskSpace |
| 10 | 选择已有 `.trellis/tasks` 项目 | 跳过初始化，先执行只读任务预检 |
| 11 | 首次差异选择暂不接入 | 不 attach，服务端和本地 binding/cursor 均不变化 |
| 12 | 两个客户端同一 taskSpace | A 修改任务后 B 在正常网络 P95 3 秒内同步 |
| 13 | A/B 同时基于同一摘要修改 | 先提交成功，后提交显示明确冲突，不静默覆盖 |
| 14 | 查看差异 | 能同时看到本地和服务端完整任务目录 |
| 15 | 使用服务端版本 | 先备份本地完整目录，再原子替换 |
| 16 | 覆盖服务端 | 二次确认，双方备份和审计可查 |
| 17 | 任务活动目录移动到归档 | 另一客户端不恢复旧活动路径 |
| 18 | Web 创建/改派且目标 Agent 离线 | 表单保留并显示明确原因 |
| 19 | 目标 Agent 在线 | 先出现独立操作项，成功后正式任务或负责人更新 |
| 20 | 同账号登录第二台设备 | 旧设备立即退出，旧命令取消，新设备重新选择项目 |
| 21 | 切换到非绑定分支后修改任务 | 不上传、不拉取、不推进 cursor，项目栏显示暂停原因 |
| 22 | 已批准关联项目打开 Agent 快捷入口 | 不弹目录选择，显示完整 Agent 列表和本机已初始化状态 |
| 23 | 选择缺失 Agent 并初始化 | 只写当前仓库对应工具文件，成功后关闭；重开显示已初始化 |
| 24 | 撤销/拒绝关联后打开旧快捷入口 | Rust 在写入前拒绝并显示可理解错误 |

Windows 实机仍需验证 WebView2 Cookie 写入、远程 capability、动态导航、绿色包解压后首次启动、
环境门下载/校验/安装失败分支和真实双客户端同步。
