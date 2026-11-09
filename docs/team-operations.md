# Trellis Board 团队版运维手册

本文面向部署和维护团队版服务的工程师。所有示例使用简体中文和 PowerShell。

## 1. 运行边界

- 服务端：Node.js 24、Git、Python；单实例 Node 进程和 SQLite WAL。
- 客户端：Windows 10/11 x64；正式 Agent 包内置 Node 24。
- 数据库：默认 `data/board.sqlite`。
- 项目工作副本：默认 `data/projects/<workspace-key>`。
- 团队模式必须使用 HTTPS；只有回环测试地址允许 HTTP。
- 私网 Git 建议使用 SSH deploy key。不要把账号、令牌或密码写入远端 URL。

当前容量基线为 400 个账号、200 个在线 Web 用户、100 个项目、10,000 个当前任务快照和
400 个在线 Agent 连接。超过该基线或需要多实例高可用时，应重新设计共享数据库和调度层。
部署环境执行 `npm run capacity` 可在临时目录复现该负载；脚本会独立启动压测客户端并校验
全部请求成功、Web p95 不超过 500ms，失败时以非 0 退出。

## 2. 环境变量

| 变量 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `TRELLIS_BOARD_MODE` | 是 | `standalone` | 团队部署设为 `team` |
| `TRELLIS_TEAM_PUBLIC_URL` | 是 | 无 | 浏览器和 Agent 使用的公开根地址，例如 `https://board.example.com` |
| `TRELLIS_TEAM_BIND_HOST` | 是 | `127.0.0.1` | 服务监听地址；通常保持回环，由反向代理转发 |
| `TRELLIS_TEAM_PORT` | 否 | `4317` | 团队服务端口 |
| `TRELLIS_TEAM_SESSION_TTL_MS` | 否 | `43200000` | 登录会话有效期，默认 12 小时 |
| `TRELLIS_TEAM_AGENT_STALE_MS` | 否 | `60000` | Agent 超过该时间未心跳即显示离线 |
| `TRELLIS_TEAM_GIT_POLL_MS` | 否 | `60000` | 项目远端轮询间隔，最小 60 秒 |
| `TRELLIS_TEAM_COOKIE_SECURE` | 否 | HTTPS 时为 true | 非回环地址不允许关闭 |
| `TRELLIS_TEAM_TRUST_PROXY` | 否 | `false` | 仅当请求只能来自受信反向代理时开启 |
| `TRELLIS_TEAM_ALLOW_LOCAL_GIT_REMOTES` | 否 | `false` | 只用于隔离的真实 E2E，生产保持 false |

PowerShell 前台启动示例：

```powershell
$env:TRELLIS_BOARD_MODE = 'team'
$env:TRELLIS_TEAM_PUBLIC_URL = 'https://board.example.com'
$env:TRELLIS_TEAM_BIND_HOST = '127.0.0.1'
$env:TRELLIS_TEAM_PORT = '4317'
node server/index.js
```

服务账号必须能读取 `data/`，能写项目工作副本，并能非交互执行 `git` 和 `python`。
SSH 远端应提前完成主机指纹校验，deploy key 只授予目标项目所需权限。

## 3. 首次部署

1. 停止旧 Board 服务。
2. 备份数据库、日志和应用配置；保留当前环境变量。
3. 在 team 环境变量下运行首管理员初始化：

```powershell
$env:TRELLIS_BOARD_MODE = 'team'
$env:TRELLIS_TEAM_PUBLIC_URL = 'https://board.example.com'
node server/team/cli.js init-admin --username admin --display-name '系统管理员'
```

4. 启动服务并打开 `https://board.example.com/login.html`。
5. 首管理员首次登录必须修改临时密码。
6. 打开 `/admin.html` 创建团队，再创建用户：填写登录名、显示名和初始密码（至少 6 个字符，
   不做复杂度校验），并勾选要分配的团队；团队可留空，建号后补配。
7. 管理员可直接重置用户密码（同样至少 6 个字符），重置后不强制改密；禁用账号会立即失效
   其会话与 Agent 凭证。

HTTP 不提供首次注册接口，也没有公开注册页。首个管理员只能通过服务器本机 CLI 创建，
其余账号只能由系统管理员在 `/admin.html` 创建。

## 4. 反向代理

代理必须保留原始 Host。普通接口请求体上限 64 KiB；`/api/agent/live-changes` 和
`/api/agent/live-changes/preflight` 上限 9 MiB，以便接收单批最多 8 MiB 的实时任务文本。
不得记录 Cookie、Authorization、配对码和请求正文。Agent 通过 `GET /api/agent/events` 维持 SSE 长连接：该路径必须关闭响应缓冲
（`proxy_buffering off`），读超时设为不小于 30 分钟；其它接口读超时 60 秒即可。

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

    location /api/agent/events {
        proxy_pass http://127.0.0.1:4317;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_http_version 1.1;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 1800s;
    }

    location ~ ^/api/agent/live-changes(?:/preflight)?$ {
        client_max_body_size 9m;
        proxy_pass http://127.0.0.1:4317;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_http_version 1.1;
    }
}
```

只有在上述代理独占上游访问时才设置 `TRELLIS_TEAM_TRUST_PROXY=true`。

## 5. 项目接入

1. 在 `/admin.html` 输入项目名称、SSH/HTTPS 远端和一个已存在的共享分支。
2. 服务端克隆到 `data/projects/<workspace-key>`，进入 `provisioning`。
3. 核对 `.trellis/scripts` 摘要，确认没有 lifecycle hooks、符号链接、`__pycache__` 或字节码。
4. 指定首个项目负责人及其 Trellis developer ID。
5. 批准后项目进入 `current`，首次扫描完成后才可读写。

接入后的常规任务流程：

1. 项目负责人或成员在 Web 创建任务并委派给其他 `lead/member`。
2. 服务端拉取共享分支、调用项目自己的 `task.py create --no-start`、提交并 push。
3. push 成功后任务进入待接受列表。
4. 负责人在 Web 接受任务。
5. 负责人 Windows Agent 对同一共享分支执行 `ff-only` 同步。

服务端不会为每个任务创建独立分支或 worktree。所有任务写入同一项目共享分支，每个项目的
写操作串行执行。非快进冲突最多安全重试 3 次，禁止强推。

## 6. Windows 客户端与实时同步

双击安装后的 `trellis-board-client.exe`，冷启动只显示服务器地址、登录名和密码。登录成功后，
Tauri 写入当前 Board origin 的 HttpOnly Session Cookie，并用同一账号建立或复用 DPAPI 设备凭证。
`client.json` 只保存服务器地址。sidecar 数据位于 `%LOCALAPPDATA%\TrellisBoard\data\agent`。

### 6.1 本地项目关联

Board 项目栏通过窄权限 Tauri IPC 调用 sidecar 选择本地仓库。Rust 先复核当前页面与本次登录
Board origin 同源，sidecar 再校验 Git 根、`.trellis`、当前分支和规范化 origin。账号属于目标
启用团队即可关联；不再要求项目负责人审批。项目级 `read_only` 可以关联和接收内容，但不能上传。

### 6.2 未提交任务实时同步

- 单机服务端继续使用共享 watcher 刷新本地 Board；团队服务端不监听自己的 `.trellis` 工作副本。
- 桌面 sidecar 对已关联、approved、非 `read_only` 项目启动同一 watcher，允许上传未提交的 UTF-8
  `task.json`、JSONL、Markdown、YAML 和 workspace journal。
- `POST /api/agent/live-changes` 按项目单调 revision 和 `batchId` 幂等提交；路径、扩展名、摘要、
  1 MiB 单文件、8 MiB 单批次、64 文件和每秒 5 批限制由服务端再校验。
- 服务端把文件保存为实时覆盖层，复用 `scanRepository()` 推导任务，并向其他设备发送
  `live.changed`。Board 通过 `tasks.changed` SSE 收到任务索引变化后立即重载，不再轮询
  `/api/team/live-revision`；该接口保留用于按需查询责任人覆盖通知。
- 其他客户端收到事件后从本地 cursor 拉取最新文件；覆盖不同内容前把原文件备份到
  `%LOCALAPPDATA%\TrellisBoard\data\agent\live-backups\<projectId>\<backupId>`。
- 客户端控制窗口显示冲突与责任人警告。一键复原会把备份作为新 revision 上传；取消先备份再恢复
  服务端或 Git 当前版本；继续推进保留原责任人并审计；接管任务显式改派。
- Git 拉取只有在文件摘要已经一致时才清除实时覆盖行。Git 内容不同或更旧时保留实时版本，任务卡片
  显示“实时未入 Git”，不会静默回退阶段。

Agent 遇到 dirty 工作区、错分支、sparse checkout、本地领先、远端分叉或 ignored 文件覆盖风险时
仍拒绝 Git 同步。实时文件同步与 Git commit/push 是两条不同链路。

### 6.3 Windows 验证清单

`desktop/README.md` 的验证清单是发布验收表。开发机没有 Rust/MSVC 时，`cargo tauri build`、
NSIS、WebView2 Cookie、真实 Tauri IPC 和控制窗口只能在 Windows 上验证，不得写成“已通过”。

## 7. 数据库升级与回滚

升级前必须停止服务，并同时备份主库、WAL 和 SHM：

```powershell
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backup = "data\backup-$stamp"
New-Item -ItemType Directory -Path $backup | Out-Null
Copy-Item data\board.sqlite "$backup\board.sqlite"
if (Test-Path data\board.sqlite-wal) { Copy-Item data\board.sqlite-wal "$backup\board.sqlite-wal" }
if (Test-Path data\board.sqlite-shm) { Copy-Item data\board.sqlite-shm "$backup\board.sqlite-shm" }
if (Test-Path data\git-credentials.key) { Copy-Item data\git-credentials.key "$backup\git-credentials.key" }
```

本版本支持 `v6 -> v7` 附加式迁移。服务启动时先创建
`data/backups/board.sqlite.pre-v7.*` 快照，再补齐实时覆盖层、
`team_task_index.live_revision`、Git 凭据表和 SSH 主机信任表；旧账号、团队、项目、审计和
任务索引会保留。其他 schema 版本仍会拒绝启动，不得通过删除数据库代替迁移。升级步骤：

1. 停止服务并再次保留当前数据库、日志和配置。
2. 按上面的 PowerShell 备份数据库、WAL、SHM 和 `data/git-credentials.key`。
3. 启动新版服务，等待 v6 自动升级到 v7。
4. 运行 `node server/team/cli.js status`，确认 schema v7、WAL 和 integrity。
5. 检查现有项目、任务索引、Agent 绑定、登录和 Git 凭据；如有异常，停止服务并恢复升级前备份。

```powershell
$env:TRELLIS_BOARD_MODE = 'team'
$env:TRELLIS_TEAM_PUBLIC_URL = 'https://board.example.com'
node server/team/cli.js status
```

结果必须显示 `schemaVersion=7`、`journalMode=wal` 和 `integrity=ok`。如果启动失败，保留
原库和 `data/backups/board.sqlite.pre-v7.*`，不要删除或重建数据库。

回滚步骤：

1. 停止服务并再次保留当前数据库、日志和配置。
2. 切回旧应用版本。
3. 把当前 `data/board.sqlite*` 和 `data/git-credentials.key` 移到独立目录。
4. 恢复旧版本对应的数据库、WAL、SHM 和密钥备份；不要删除被回滚任务的远端提交。
5. 以 standalone 模式启动并检查健康接口和任务数量。

数据库回滚不会删除 Git 远端已经成功推送的任务提交，也不会自动撤回 Agent 已同步的新提交。

## 8. 备份与恢复

- 每日至少备份一次数据库；升级、修复项目或批量操作前额外备份。
- 最稳妥的备份窗口是停止服务后复制 `data/board.sqlite*` 和 `data/git-credentials.key`。
- `data/git-credentials.key` 与数据库一起构成完整恢复单元；只有数据库没有密钥时，Git 凭据无法恢复。
- 项目工作副本不是唯一事实源，任务提交已推送到项目远端；数据库还保存账号、接受状态、审计和索引。
- 数据库还保存尚未进入 Git 的实时文件覆盖层与 revision，备份时不能只保存 Git 远端。
- 客户端实时冲突备份位于 `%LOCALAPPDATA%\TrellisBoard\data\agent\live-backups`，默认保留 30 天，
  每个任务至少保留最近 20 份。
- 恢复后运行 `node server/team/cli.js status`，再检查登录、项目状态、待接受任务和 Agent 在线状态。
- 不使用 `git reset --hard`、强推或手工改写远端历史修复 Board。

## 9. 故障处置

`stale`：工具链或扫描内容发生变化。管理员核对后重新批准或刷新。

`pending_push`：提交已产生但尚未确认远端。网络恢复后由写成员重试 Git operation，或管理员
执行项目 repair；不要另行提交相同任务。

`needs_repair`：工作副本存在不可自动归属的变更、错分支、冲突或缺失任务。先只读检查
`git status`、当前分支和远端，再按 Web 中 operation ID 与提交 trailer 恢复。无法确认时保持
项目阻塞，不得强推。

Agent 离线：检查当前用户计划任务、`%LOCALAPPDATA%\TrellisBoard\data\agent\logs\agent.log`、
证书链、DNS 和反向代理 SSE 缓冲或超时（`/api/agent/events` 必须关闭 buffering）。

实时同步不收敛：检查项目实时 revision、`project_live_file` 摘要与 Git 文件是否一致；不要手工删除
覆盖行迫使任务回退。先在客户端处理冲突/备份，再提交并推送对应 `.trellis` 文件。

`REMOTE_MISMATCH`：确认本地 `origin` 与项目远端是同一语义地址；不要在 HTTPS URL 中加入
账号或令牌。

凭证撤销：管理员可在系统审计页撤销 Agent；项目负责人可撤销项目绑定。用户禁用会立即使其
会话和 Agent 凭证失效。

## 10. 发布检查单

- `npm test` 和全部 JS 语法检查通过。
- standalone 和 team 模式均能真实启动、访问健康接口并正常停止。
- 空库创建 v7 schema 成功；v6 原地升级成功；v5 及旧库拒绝启动，回滚演练完成。
- 临时 Git 远端完成创建/委派、push、接受和 Agent `ff-only` 同步。
- 桌面端链路在 Windows 上跑通：登录 → Board → 关联项目 → 实时修改其他客户端可见 →
  冲突备份/复原和责任警告/接管可用（见 6.1 / 6.2 与 `desktop/README.md`）。
- dirty、错分支、版本冲突、push 失败和 repair 分支均有可恢复结果。
- Agent 包不包含凭证、数据库、日志或开发机绝对路径。
- 容量基线达标，反向代理和日志未泄露敏感信息。
- 首管理员、项目负责人、普通成员和只读成员权限矩阵通过验收。
