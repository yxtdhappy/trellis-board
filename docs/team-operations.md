# Trellis Board 团队版运维手册

本文面向部署和维护 Team Board 的工程师。示例使用简体中文和 PowerShell。

## 1. 运行边界

- 服务端：Node.js 24、单实例 Node 进程、SQLite WAL。
- 客户端：Windows 10/11 x64；安装包包含固定 Node runtime 和 Trellis CLI，本机执行任务命令时仍需
  Git 和 Python。
- 运行数据：由 `TRELLIS_BOARD_DATA_DIR` 指定，Ubuntu 建议 `/var/lib/trellis-board`。
- 数据库：运行数据目录中的 `board.sqlite`，当前 schema v10。
- Team 服务端不保存项目 Git 凭据，不创建 `data/projects/**` 工作副本，也不 clone、fetch、commit 或 push。
- 项目源码和共享 `.trellis` 配置仍由客户端 Git 管理；Team Board 只持久化和广播
  `.trellis/tasks/**`。
- 任务空间键是“规范化 Git 远端 + 分支”。同一仓库不同分支是不同 taskSpace。
- 一个账号同一时刻只有一个有效 Agent。新设备登录会撤销旧设备并关闭旧命令通道。

当前容量基线为 400 个账号、200 个在线 Web 用户、100 个项目、10,000 个当前任务快照和
400 个在线 Agent 连接。超过基线或需要多实例高可用时，必须重新设计共享数据库、SSE 广播和任务空间队列。

## 2. 环境变量

| 变量 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `TRELLIS_BOARD_MODE` | 是 | `standalone` | Team 部署设为 `team` |
| `TRELLIS_BOARD_DATA_DIR` | 生产必填 | 平台用户数据目录 | Windows 默认 `%LOCALAPPDATA%\TrellisBoard\server`；Ubuntu 建议 `/var/lib/trellis-board` |
| `PORT` | 否 | `4317` | HTTP 和 Team 服务端口 |
| `TRELLIS_BOARD_ALLOW_LOCAL_GIT_REMOTES` | 否 | standalone `true`，team `false` | 是否接受本地 `file://` Git 远端 |

Team 模式没有 `TRELLIS_TEAM_GIT_POLL_MS`。项目远端不再由服务端轮询。
服务固定监听 `0.0.0.0`。直接使用 HTTP 或通过反向代理提供 HTTPS 均可；反向代理应传递
`X-Forwarded-Proto`，服务会据此自动设置安全 Cookie。
团队版需要本地 Git 远端时显式设置 `TRELLIS_BOARD_ALLOW_LOCAL_GIT_REMOTES=true`；团队版默认关闭，
单机版默认开启。修改后需要重启服务并重新登录客户端，客户端才会刷新该能力。

Windows PowerShell 前台启动：

```powershell
$env:TRELLIS_BOARD_MODE = 'team'
$env:PORT = '4317'
$env:TRELLIS_BOARD_DATA_DIR = Join-Path $env:LOCALAPPDATA 'TrellisBoard\server'
node apps/server/index.js
```

团队需要本地 Git 远端时，在启动前额外设置：

```powershell
$env:TRELLIS_BOARD_ALLOW_LOCAL_GIT_REMOTES = 'true'
```

局域网客户端直接访问 `http://<服务端IP>:4317`。

Ubuntu 前台启动：

```bash
export TRELLIS_BOARD_MODE=team
export PORT=4317
export TRELLIS_BOARD_DATA_DIR=/var/lib/trellis-board
node apps/server/index.js
```

服务账号必须能读写 `TRELLIS_BOARD_DATA_DIR` 和 SQLite 文件。Team 服务端不需要安装项目 Git 或
配置 Git 凭据；standalone 模式仍按本机仓库运行。

## 3. 首次部署

1. 准备运行数据目录；需要 HTTPS 时再准备反向代理。
2. 在 Team 环境变量下创建首管理员：

```powershell
$env:TRELLIS_BOARD_MODE = 'team'
$env:PORT = '4317'
node apps/server/team/cli.js init-admin --username admin --display-name '系统管理员'
```

3. 启动服务并打开 `http://<服务端IP>:4317/login.html`；使用 HTTPS 时打开对应域名。
4. 首管理员首次登录必须修改临时密码。
5. 在 `/admin.html` 创建团队和用户；用户登录名不区分大小写，初始密码至少 6 个字符。
6. 用户打开 Windows 客户端登录，再由客户端选择本地 Git 项目。

HTTP 不提供公开注册。首个管理员只能通过服务器本机 CLI 创建，其余账号由系统管理员创建。

## 4. 反向代理

代理必须保留原始 Host，并关闭 SSE 缓冲。`GET /api/board/events` 和 `GET /api/agent/events`
都是长连接；读超时建议不小于 30 分钟。

任务快照 JSON 请求体硬上限为 96 MiB，业务层再限制单批 64 MiB / 1024 文件。超过 96 MiB
的请求即使解码后正文不超过 64 MiB 也会在业务校验前返回 413：

```text
POST /api/agent/task-spaces/:id/preflight
POST /api/agent/task-spaces/:id/changes
POST /api/agent/task-spaces/:id/conflicts/:conflictId/resolve
```

Nginx 示例：

```nginx
server {
    listen 443 ssl;
    server_name board.example.com;

    client_max_body_size 64k;
    proxy_read_timeout 60s;
    proxy_send_timeout 60s;

    location / {
        proxy_pass http://127.0.0.1:4317;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_http_version 1.1;
    }

    location ~ ^/api/(board|agent)/events$ {
        proxy_pass http://127.0.0.1:4317;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_http_version 1.1;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 1800s;
    }

    location ~ ^/api/agent/task-spaces/[^/]+/(preflight|changes|conflicts/.+/resolve)$ {
        client_max_body_size 96m;
        proxy_pass http://127.0.0.1:4317;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_http_version 1.1;
    }
}
```

反向代理必须传递 `X-Forwarded-Proto`。不得记录 Cookie、Authorization、配对码、任务正文或
本地仓库路径。

## 5. 项目接入与任务空间

### 5.1 客户端首次接入

1. 用户在客户端选择本地 Git 仓库根目录。
2. 客户端校验仓库根、origin 和当前分支，并检查 `.trellis/tasks`。
3. 缺少 `.trellis` 或 `tasks` 时，用户选择本机需要的编码 Agent，由安装包内固定 Trellis runtime 初始化。
4. 客户端提示用户检查文件并手动提交、推送；不会自动 commit/push。
5. 用户点击“检查推送状态”。只有本地 HEAD 与远端目标分支一致、初始化文件已进入 HEAD 且相关路径干净时
   才允许接入。
6. 用户选择 owner team 和 Trellis developer ID，客户端先调用
   `POST /api/agent/task-spaces/preflight` 只读比较本地任务和服务端 manifest。
7. 服务端预检只返回项目、taskSpace、revision 和文件元数据，不建立 project、taskSpace、binding
   或 cursor，也不返回任务正文。
8. 用户明确选择处理方式后，客户端才调用 `/api/agent/task-spaces/attach`；服务端以规范化远端和
   分支创建或命中全局项目和 taskSpace，不访问 Git。

已有 `.trellis/tasks` 的项目跳过初始化，直接进入首次任务差异预检。本机 Agent 工具可后续追加，
不同设备无需选择相同工具。

### 5.2 首次差异处理

- 暂不接入：只清除客户端待接入路径，不 attach，不写本地 binding/cursor，不写服务端。
- 仅同步无冲突项：只下载服务端独有的完整任务目录，不上传本地内容。
- 查看并处理差异：按完整任务目录选择服务端、本地、保存副本或跳过。
- 服务端没有快照：明确提示“服务端暂无任务快照”；用户确认后以 bootstrap 模式把本地任务作为
  初始快照上传。
- 双方一致：直接完成首次同步，不显示空差异窗口。

binding 必须持久化 `initialSyncMode` 和 `initialSyncCompleted`。处理结果必须按任务目录原子应用，
不能生成半个任务；完成后才启动 tasks watcher。不得通过删除 binding 补偿“暂不接入”。

### 5.3 Web 创建与改派

1. Web 创建带负责人的任务或改派时，先检查目标用户是项目写成员，且唯一 active Agent 已在目标 taskSpace
   在线。
2. 通过检查后返回 `202` 独立操作项，不立即生成正式任务或修改负责人。
3. Agent 通过 `/api/agent/events` 收到命令，领取 running 租约并执行本地 `task.py` 或原子改 `task.json`。
4. Agent 通过 tasks-only CAS 上传，服务端索引完成后命令才进入 succeeded。
5. 失败操作可重试或取消；重试仍使用同一幂等键，不创建第二个任务。

目标 Agent 离线、未绑定、无写角色或项目停用时，Web 必须拒绝入队并显示用户、项目和分支的下一步。

## 6. Windows 客户端与任务同步

双击 `trellis-board-client.exe`，客户端先检查本机 Node.js 与 Trellis CLI（缺失时从 npm 镜像安装），
检查通过后显示本地登录页。登录成功后进入 Board，客户端进程内的 Agent 使用同一账号建立或复用当前设备凭证。

### 6.1 本地项目关联

- 只有 Tauri 页面显示“接入本地项目”、关联状态和 Agent 运行状态。
- 客户端只操作本次刚选择的 pending 项目路径；远程页面不能传任意本地路径。
- 项目关联成功后，客户端进程内的 Agent 只监听该仓库 `.trellis/tasks/**`。
- 项目栏按 taskSpace 显示分支和关联状态；同步中显示“此时切换 Git 分支可能导致任务错位或污染”的提示。
- 登录同账号新设备后，旧设备立即失去 Agent 鉴权，旧 SSE 关闭，旧待执行命令取消。新设备必须重新选择本地仓库。

### 6.2 任务快照

```text
本地 .trellis/tasks 变化
  -> 250ms 防抖
  -> 读取完整任务目录
  -> LF 规范化和 SHA-256
  -> baseSha256 CAS 上传
  -> taskSpace revision + 索引 + Board tasks.changed
  -> 其他客户端从 cursor 拉取并原子替换任务目录
```

- 只同步 `.trellis/tasks/**`；spec、scripts、config、workflow、agents、workspace、`.developer`
  和编码 Agent 目录仍由 Git 管理。
- 单文件上限 1 MiB，单批 64 MiB / 1024 文件；JSON 运输硬上限为 96 MiB，两个条件都必须满足。
- 删除使用墓碑；活动目录到归档目录的移动在同一批次完成。
- 客户端持久化 cursor 和 pending batch。网络响应丢失后复用原 `batchId`。
- 服务端应用后的 watcher 事件按 `(absolutePath, sha256)` 抑制，真实后续编辑仍会上传。

### 6.3 冲突

CAS 冲突返回 `TASK_FILE_CONFLICT`，不覆盖服务端，也不推进 cursor。客户端控制窗口提供：

- 查看差异
- 使用服务端版本
- 用我的版本覆盖
- 仅保存本地副本

覆盖服务端前必须二次确认，服务端先保存双方内容并写审计。客户端备份位于
`%LOCALAPPDATA%\TrellisBoard\data\agent\live-backups\<taskSpaceId>\<backupId>`。

### 6.4 分支切换

客户端只在同步进行中提示风险，不拦截终端、IDE 或客户端外的分支切换，也不自动迁移 pending 批次。
切换分支后如出现任务错位，应停止同步并人工核对 `.trellis/tasks`、taskSpace 和 pending batch。

## 7. 数据库升级与回滚

### 7.1 升级前备份

停止服务后备份主库、WAL 和 SHM：

```powershell
$dataDir = if ($env:TRELLIS_BOARD_DATA_DIR) { $env:TRELLIS_BOARD_DATA_DIR } else { Join-Path $env:LOCALAPPDATA 'TrellisBoard\server' }
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backup = Join-Path $dataDir "backup-$stamp"
New-Item -ItemType Directory -Path $backup | Out-Null
Copy-Item (Join-Path $dataDir 'board.sqlite') (Join-Path $backup 'board.sqlite')
if (Test-Path (Join-Path $dataDir 'board.sqlite-wal')) { Copy-Item (Join-Path $dataDir 'board.sqlite-wal') (Join-Path $backup 'board.sqlite-wal') }
if (Test-Path (Join-Path $dataDir 'board.sqlite-shm')) { Copy-Item (Join-Path $dataDir 'board.sqlite-shm') (Join-Path $backup 'board.sqlite-shm') }
```

本版本支持 v6、v7、v8、v9 升级到 v10。启动时先写
`backups/board.sqlite.pre-v10.<timestamp>`，再创建缺失的 `sync_*` 表。旧账号、团队、项目、审计、
旧实时表和 Git 凭据表不会自动删除，但 Team 运行链路不再读取它们。

升级步骤：

1. 停止服务并完成上述备份。
2. 启动新版 Team 服务。
3. 运行状态检查：

```powershell
$env:TRELLIS_BOARD_MODE = 'team'
$env:PORT = '4317'
node apps/server/team/cli.js status
```

结果应显示 `schemaVersion=10`、`journalMode=wal` 和 `integrity=ok`。

4. 检查登录、团队、`sync_project`、taskSpace、Agent active slot 和 Board SSE。
5. 旧项目不会自动成为新任务空间；用户需要在客户端重新选择并接入项目。

### 7.2 回滚

1. 停止新版服务并再次备份当前数据库。
2. 切回旧二进制版本。
3. 旧二进制只接受 schema 6-9，必须恢复 `backups/board.sqlite.pre-v10.*` 备份以及对应的
   WAL 和 SHM；不能直接把 schema v10 数据库交给旧二进制。
4. 恢复后升级阶段产生的 `sync_*` 数据不会保留在旧数据库中；需要保留时先另存当前 v10 数据库。
5. 不删除 `data/projects/**`、旧 `git-credentials.key` 和旧数据库表；它们只作为人工回滚材料保留。

## 8. 备份与恢复

- Team runtime 启动时和每 24 小时用 `VACUUM INTO` 创建
  `backups/board.sqlite.snapshot.<UTC timestamp>`，自动保留最近 7 份。
- 升级、维护和批量操作前仍应停止服务并额外复制 `board.sqlite*`。
- 每日快照失败只记录告警，不阻塞服务；运维必须监控 `任务快照数据库备份失败`。
- 客户端冲突备份由用户自行保留；服务端不保存完整历史正文，历史版本由客户端 Git 负责。
- 恢复时先停止服务，恢复数据库、WAL 和 SHM，再检查 schema、integrity、登录、taskSpace revision 和 SSE。

## 9. 故障处置

`AGENT_OFFLINE`：目标用户没有 online active Agent 或未绑定 taskSpace。让对方打开客户端并关联项目；
不要创建临时任务绕过命令。

`AGENT_NOT_UNIQUE`：数据库出现多个 active slot，属于不变量破坏。停止写入，检查 `sync_active_agent`
和 `agent_device`，修复活动槽后再恢复。

`TASK_FILE_CONFLICT`：检查任务名、文件、最后修改人、设备、时间和 `conflictId`。让客户端先备份并
查看差异，不要手工删除 `sync_task_space_file`。

`COMMAND_WAITING_INDEX`：任务文件已上传但索引尚未追上或负责人尚未更新。等待索引重试并重新提交结果；
不要直接改 `sync_task_command.status=succeeded`。

`cursor` 不前进：检查本地 `pending` batch、`sync_agent_cursor` 和 taskSpace `indexed_revision`。
网络响应丢失时客户端应复用原 `batchId`。

SSE 断线：检查 `/api/board/events` 与 `/api/agent/events` 的代理缓冲和读超时。客户端重连后从本地 cursor
补拉，不重新 full pull。

Team 服务意外访问 Git：这是架构回归。检查 `createTeamRuntime()` 装配、Team 路由表和日志；正常 Team
启动不应创建 `data/projects/**`、读取 `git-credentials.key` 或 spawn 项目 Git。

## 10. 发布检查单

- `npm test` 全部通过，`npm run format:check` 通过。
- Team 空库和 v6/v7/v8/v9 升级库均能打开 schema v10。
- Team 启动不创建 `data/projects/**`，旧 Git/live 路由返回 404。
- 服务端只接受 `.trellis/tasks/**`，单批 CAS、删除墓碑、归档移动和冲突回滚通过。
- 同远端不同分支 taskSpace、revision、cursor 和 Board 完全隔离。
- 目标 Agent 离线时拒绝创建/改派，在线时先显示独立操作项，成功后正式任务才出现。
- 换设备后旧 Agent 立即被撤销；新设备未重新绑定项目前不能领取命令。
- Windows 实机完成登录、初始化、首次推送、接入、两客户端同步、冲突处理、命令投递和重启验收。
- 每日快照存在且保留 7 份；数据库、日志和 API 不包含 Token、Cookie、私钥或任务正文泄漏。
- 反向代理的 Board/Agent SSE 已关闭缓冲，任务快照请求体限制正确。
