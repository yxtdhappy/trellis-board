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
6. 打开 `/admin.html` 创建用户、禁用账号、重置密码和查看系统审计。

HTTP 不提供首次注册接口。首个管理员只能通过服务器本机 CLI 创建。

## 4. 反向代理

代理必须保留原始 Host，限制请求体不超过 64 KiB，不记录 Cookie、Authorization、配对码和
请求正文。Agent 长轮询最长 25 秒，代理读超时应不小于 35 秒。

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

## 6. Windows Agent

生成自包含分发包：

```powershell
pwsh -File .\agent\package-agent.ps1
```

目标机器解压后运行：

```powershell
.\trellis-agent.cmd pair --server https://board.example.com --name $env:COMPUTERNAME
.\trellis-agent.cmd bind --project <项目ID> --path D:\work\project --branch dev
.\trellis-agent.cmd status
.\trellis-agent.cmd service install
.\trellis-agent.cmd service status
```

项目负责人或系统管理员在 Web 中批准绑定后，Agent 才会收到同步命令。Agent 遇到 dirty
工作区、错分支、sparse checkout、本地领先、远端分叉或 ignored 文件覆盖风险时拒绝同步。

Agent 本地数据位于 `%LOCALAPPDATA%\TrellisBoardAgent`，服务端凭证使用 Windows DPAPI
CurrentUser 加密。安装任务只监听当前用户登录启动，不创建系统级服务。

## 7. 数据库升级与回滚

升级前必须停止服务，并同时备份主库、WAL 和 SHM：

```powershell
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backup = "data\backup-$stamp"
New-Item -ItemType Directory -Path $backup | Out-Null
Copy-Item data\board.sqlite "$backup\board.sqlite"
if (Test-Path data\board.sqlite-wal) { Copy-Item data\board.sqlite-wal "$backup\board.sqlite-wal" }
if (Test-Path data\board.sqlite-shm) { Copy-Item data\board.sqlite-shm "$backup\board.sqlite-shm" }
```

本版本**不做旧数据库迁移**，schema v6 只对新建数据库生效。已有 `data/board.sqlite` 若不是
v6，服务会拒绝启动并提示删除重建。升级步骤：

1. 停止服务并再次保留当前数据库、日志和配置。
2. 备份并移走 `data/board.sqlite`、`data/board.sqlite-wal`、`data/board.sqlite-shm`。
3. 重新启动服务，让空库创建 v6 schema。
4. 运行 `node server/team/cli.js status`。

```powershell
$env:TRELLIS_BOARD_MODE = 'team'
$env:TRELLIS_TEAM_PUBLIC_URL = 'https://board.example.com'
node server/team/cli.js status
```

结果必须显示 `schemaVersion=6`、`journalMode=wal` 和 `integrity=ok`。旧库中的账号、项目、
审计和任务索引不会自动回填，需要由系统管理员重新创建团队、分配成员并接入项目。

回滚步骤：

1. 停止服务并再次保留当前数据库、日志和配置。
2. 切回旧应用版本。
3. 把当前 `data/board.sqlite*` 移到独立目录。
4. 恢复旧版本对应的数据库、WAL 和 SHM 备份，或让旧版本重建空库。
5. 以 standalone 模式启动并检查健康接口和任务数量。

数据库回滚不会删除 Git 远端已经成功推送的任务提交，也不会自动撤回 Agent 已同步的新提交。

## 8. 备份与恢复

- 每日至少备份一次数据库；升级、修复项目或批量操作前额外备份。
- 最稳妥的备份窗口是停止服务后复制 `data/board.sqlite*`。
- 项目工作副本不是唯一事实源，任务提交已推送到项目远端；数据库还保存账号、接受状态、审计和索引。
- 恢复后运行 `node server/team/cli.js status`，再检查登录、项目状态、待接受任务和 Agent 在线状态。
- 不使用 `git reset --hard`、强推或手工改写远端历史修复 Board。

## 9. 故障处置

`stale`：工具链或扫描内容发生变化。管理员核对后重新批准或刷新。

`pending_push`：提交已产生但尚未确认远端。网络恢复后由写成员重试 Git operation，或管理员
执行项目 repair；不要另行提交相同任务。

`needs_repair`：工作副本存在不可自动归属的变更、错分支、冲突或缺失任务。先只读检查
`git status`、当前分支和远端，再按 Web 中 operation ID 与提交 trailer 恢复。无法确认时保持
项目阻塞，不得强推。

Agent 离线：检查当前用户计划任务、`%LOCALAPPDATA%\TrellisBoardAgent\logs\agent.log`、
证书链、DNS 和反向代理长轮询超时。

`REMOTE_MISMATCH`：确认本地 `origin` 与项目远端是同一语义地址；不要在 HTTPS URL 中加入
账号或令牌。

凭证撤销：管理员可在系统审计页撤销 Agent；项目负责人可撤销项目绑定。用户禁用会立即使其
会话和 Agent 凭证失效。

## 10. 发布检查单

- `npm test` 和全部 JS 语法检查通过。
- standalone 和 team 模式均能真实启动、访问健康接口并正常停止。
- 空库创建 v6 schema 成功；旧库拒绝启动并提示重建，回滚演练完成。
- 临时 Git 远端完成创建/委派、push、接受和 Agent `ff-only` 同步。
- dirty、错分支、版本冲突、push 失败和 repair 分支均有可恢复结果。
- Agent 包不包含凭证、数据库、日志或开发机绝对路径。
- 容量基线达标，反向代理和日志未泄露敏感信息。
- 首管理员、项目负责人、普通成员和只读成员权限矩阵通过验收。
