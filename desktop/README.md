# Trellis Board Windows 客户端

Tauri v2 外壳 + Node SEA sidecar。客户端冷启动固定显示本地登录页，用户填写服务器地址、登录名和密码；
登录成功后保存这三项供下次启动回填，当前 WebView 进入 Board，后台 sidecar 同步任务空间和 Agent 命令。

- 客户端版本：`desktop/package.json`、`desktop/src-tauri/Cargo.toml`
- Agent 协议：`AGENT_PROTOCOL_VERSION = 3`
- 本地配置：`%LOCALAPPDATA%\TrellisBoard\data\client.json`
- Agent 数据：`%LOCALAPPDATA%\TrellisBoard\data\agent`
- 内置 Trellis runtime：`<安装目录>\trellis-runtime\`
- 分发方式：NSIS 安装包或解压即用的 Windows x64 绿色 ZIP

## 登录与单 Agent

```text
本地登录页
  -> app_status
  -> desktop_login(serverUrl, username, password)
  -> Tauri IPC
  -> sidecar stdin（单个 JSON 对象）
  -> POST /api/auth/login
  -> 写入 WebView HttpOnly Session Cookie
  -> 复用或创建当前账号设备
  -> 当前 WebView 打开 Board
```

安全边界：

- 密码只经过 `invoke -> Rust -> sidecar stdin -> HTTP/HTTPS`，不进入 argv、环境变量或日志；登录成功后与服务器地址、登录名一起保存在 `client.json`，供下次启动回填。
- 远程 HTTP 不提供传输加密；非可信网络必须使用 HTTPS。
- Session Cookie 只存在当前 WebView Cookie Store 和 Rust 内存；冷启动后必须重新登录。
- 设备凭证只由 Windows DPAPI 保存；`client.json` 保存服务器地址、登录名和密码。
- 同服务器、同账号再次登录会先用已有设备 heartbeat，有效则复用。
- 一个账号同一时刻只有一个有效 Agent。新设备生效后旧设备凭证立即失效，旧 SSE 关闭，旧命令取消。
- 换设备不迁移本地仓库绝对路径、project binding、cursor 或 pending batch；新设备必须重新选择项目。
- `mustChangePassword=true` 时只建立 Board 会话，不创建设备；改密后下一次登录再建立设备。
- NSIS 安装和卸载会在写文件前结束旧版客户端及其 `trellis-agent.exe`，避免托盘常驻进程锁定升级文件。

sidecar 通过一次性的桌面兑换令牌调用：

```text
POST /api/desktop/enroll-tokens
POST /api/agent/enroll-desktop
```

令牌不进入 UI、磁盘、命令参数或日志，只存在于 sidecar 单次调用内存。

## 本地项目接入

项目栏由服务端 Board 渲染。只有 Tauri WebView 显示“接入本地项目”、关联状态和 sidecar 状态。

```text
Board 项目栏
  -> invoke("inspect_local_project")
  -> Rust 打开系统目录选择器
  -> sidecar inspectProject
  -> 校验 Git 根、origin、当前分支、.trellis/tasks 和已有 Agent 工具
  -> 缺少 Trellis 时 invoke("initialize_pending_project")
  -> 安装包内 node.exe + @mindfoldhq/trellis
  -> 用户手动 commit/push
  -> invoke("check_pending_project_push")
  -> invoke("preflight_pending_project")
  -> 服务端只读 manifest 与本地任务比较
  -> 用户选择暂不接入、仅同步无冲突项或查看并处理差异
  -> invoke("associate_pending_project")
  -> POST /api/agent/task-spaces/attach
  -> binding approved + initialSyncMode
  -> 首次同步完成后启动 tasks watcher
```

规则：

- 客户端只接受 Git 仓库根，不接受普通目录或 Git 子目录。
- 项目身份由规范化 origin 和当前分支组成；同远端同分支的后接入客户端命中同一 taskSpace。
- `.trellis/tasks` 已存在时跳过初始化；`.trellis` 存在但缺 `tasks` 时仍要求初始化。
- 编码 Agent 工具只影响当前设备，可后续追加；其他设备无需选择相同工具。
- 初始化不自动 commit 或 push。用户完成后由客户端比较本地 HEAD 与远端分支。
- 推送状态为 `waiting_commit`、`waiting_push`、`branch_missing`、`remote_ahead`、`diverged`、
  `unable_to_verify` 或 `ready`；网络不可达不能显示成“未推送”。
- 读取、初始化和关联只允许操作本次刚选择的 pending 项目路径，远程 Board 不能传任意本地路径。
- `read_only` binding 可以接收任务快照，但服务端拒绝上传和任务命令。

## Tasks-only 同步

已关联、`approved` 的 taskSpace 由 sidecar 启动 `shared/trellis-watcher.js`，监听范围只有
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

## 分支切换提示

任一本机关联 taskSpace 处于 `syncing` 时，项目栏显示：

```text
正在同步任务，此时切换 Git 分支可能导致任务错位或污染，建议等待同步完成后再切换。
```

本次只提示风险，不拦截菜单、终端或 IDE 的分支切换，也不自动迁移 pending batch。外部切换后如出现
任务错位，应停止同步并人工核对本地 `.trellis/tasks`、taskSpace 和 pending batch。

## Tauri 权限

`capabilities/main.json` 只允许本地登录页：

- `app_status`
- `desktop_login`

`capabilities/board-local-association.json` 通过远程 `http://*:*` / `https://*:*` 只开放：

- `preflight_pending_project`
- `cancel_pending_project`
- `associate_pending_project`
- `check_pending_project_push`
- `initialize_pending_project`
- `inspect_local_project`
- `list_local_associations`
- `desktop_sidecar_status`

Rust 仍会把当前 WebView origin 与本次登录成功的 Board origin 做同源比较。远程页面没有通用文件系统、
Shell、进程或 dialog 权限。

`capabilities/live-control.json` 只绑定本地 `live-control` 窗口：

- `live_control_pending`
- `live_control_decide`
- `live_control_diff`
- `live_control_initial`
- `live_control_restore`
- `live_control_dismiss`

控制窗口只处理当前首次同步或任务冲突，不拥有 Board 页面权限。

## 导航与退出

- 冷启动始终加载 `tauri://localhost/index.html` 或 Windows 等价本地 URL。
- 登录成功后动态写入允许的 Board origin，再在同一 WebView 导航。
- 同源 Board 导航允许；外链交给系统浏览器；`window.open` 一律拒绝。
- Board 跳转 `/login.html` 或 `/login` 时，客户端拦截导航、停止 sidecar、撤销会话、删除 Cookie，
  清空 Board origin 并返回本地登录页。

## 目录

```text
desktop/
  ui/                             本地登录页、同步控制窗口
  src-tauri/
    src/main.rs                   窗口、登录、Cookie、动态导航、项目预检/初始化/接入
    src/navigation.rs             Board URL 白名单和同源导航
    src/config.rs                 client.json schema
    src/sidecar.rs                sidecar JSON 命令和控制事件
    src/logging.rs                日志脱敏
    capabilities/                 本地登录、远程项目接入、控制窗口分离
    permissions/desktop.toml      显式命令权限
    resources/trellis-runtime/    打包后固定的 Node + Trellis CLI
    binaries/                     SEA sidecar 构建产物
  sidecar/
    cli.js                        源码运行入口
    sea-entry.js                  SEA 入口
    main.js                       login/logout/关联/任务同步/命令执行/run
    desktop-device.js             登录、Cookie、设备复用和兑换
    desktop-association.js        本地 Git 检查、pending 项目操作和 binding
    trellis-runtime.js            定位并调用打包内固定 Trellis CLI
    bundle.mjs                    esbuild + SEA 配置
    build-sidecar.ps1             Node 24 x64 打包和 runtime 资源复制
  package-portable.ps1            组装绿色目录、校验文件和 ZIP
  install.ps1                     按用户安装、SHA256、暂存与回滚
  uninstall.ps1                   卸载、可选设备撤销和数据处理
```

## 构建

前置：

- Windows 10/11 x64
- Node.js 24 x64
- Rust stable（MSVC toolchain）
- Visual Studio Build Tools（C++ 桌面负载）
- `cargo install tauri-cli --locked --version "^2"`
- WebView2 Runtime

```powershell
npm --prefix desktop install
powershell -NoProfile -ExecutionPolicy Bypass -File desktop\sidecar\build-sidecar.ps1

cd desktop
cargo tauri build --no-bundle
cargo tauri build
cd ..
powershell -NoProfile -ExecutionPolicy Bypass -File desktop\package-portable.ps1
```

`build-sidecar.ps1` 还要求仓库根已执行 `npm install`，并会：

- 构建 `trellis-agent-x86_64-pc-windows-msvc.exe` SEA sidecar；
- 复制 Node 24 x64 为 `resources/trellis-runtime/node.exe`；
- 复制完整 `node_modules`，并校验 `@mindfoldhq/trellis/bin/trellis.js`；
- 写 `VERSION.txt`，记录 Board 版本、协议版本和 Trellis 版本；
- 只替换经过路径校验的 `resources/trellis-runtime`。

产物：

- `desktop\src-tauri\target\release\trellis-board-client.exe`
- `desktop\src-tauri\target\release\bundle\nsis\Trellis Board_<version>_x64-setup.exe`
- `desktop\src-tauri\target\release\bundle\portable\TrellisBoard_<version>_x64-portable.zip`

## 绿色 ZIP（免安装）

绿色包适用于不允许运行安装器的 Windows x64 电脑。运行条件：

- Windows 10/11 x64。
- 系统已安装 Microsoft Edge WebView2 Evergreen Runtime。Windows 11 默认预装；目标 Windows 10
  镜像需由 IT 确认。

执行构建命令后，解压并运行：

```text
desktop\src-tauri\target\release\bundle\portable\TrellisBoard_<version>_x64-portable.zip
  TrellisBoard_<version>_x64-portable\
    trellis-board-client.exe
    trellis-agent.exe
    trellis-runtime\
    VERSION.txt
    SHA256SUMS.txt
    使用说明.txt
```

双击 `trellis-board-client.exe` 即可启动，不需要管理员权限。绿色版不会创建快捷方式或开机自启项。
登录配置、设备凭证、日志和同步数据仍保存在 `%LOCALAPPDATA%\TrellisBoard\data`。

升级前先退出托盘客户端并确认 `trellis-agent.exe` 已停止，再用新版目录替换程序文件。删除程序目录
即可移除程序；如不再使用，可额外删除 `%LOCALAPPDATA%\TrellisBoard` 清除本地数据。ZIP 同目录的
`.sha256` 文件用于校验压缩包完整性。

## 安装与卸载

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File desktop\install.ps1 `
  -Source .\trellis-board-client.exe -ServerUrl https://board.example.com

.\TrellisBoard_<version>_x64-setup.exe /S

powershell -NoProfile -ExecutionPolicy Bypass -File desktop\uninstall.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File desktop\uninstall.ps1 -PurgeData
$env:TRELLIS_BOARD_SESSION = '<trellis_team_session cookie>'
powershell -NoProfile -ExecutionPolicy Bypass -File desktop\uninstall.ps1 -RevokeDevice
```

`install.ps1` 不注册 `trellisboard://` 深链。卸载脚本保留旧协议清理，便于升级机器移除历史注册项。

## 验证清单

| # | 操作 | 预期 |
| --- | --- | --- |
| 1 | 全新安装后双击 | 只出现服务器地址、登录名、密码登录页 |
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
| 21 | 同步中切换分支 | 只显示风险提示，不阻断操作 |

Windows 实机仍需验证 WebView2 Cookie 写入、远程 capability、动态导航、NSIS 安装、固定 Trellis runtime
和真实双客户端同步。
