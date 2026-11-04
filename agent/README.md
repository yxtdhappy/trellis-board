# Trellis Board Windows Agent

Agent 以当前 Windows 登录用户运行，只同步本地 Git 仓库，不创建或修改团队任务。

## 前置

- Windows 10/11 x64。
- 从源码直接运行时需要 Node.js 24；正式分发包已内置 Node 24，不需要目标机器预装 Node。
- 服务端团队模式已启用，并已生成一次性设备配对码。
- 本地仓库是 Git 仓库根，当前分支与准备绑定的共享分支一致。
- `origin` 指向项目配置的同一 SSH/HTTPS 仓库；SSH 主机必须已由用户手工信任。

## 命令

在 PowerShell 中运行：

```powershell
.\agent\trellis-agent.cmd pair --server https://board.example.com --name "$env:COMPUTERNAME"
.\agent\trellis-agent.cmd bind --project <项目ID> --path D:\work\project --branch develop
.\agent\trellis-agent.cmd status
.\agent\trellis-agent.cmd diagnose
.\agent\trellis-agent.cmd service install
.\agent\trellis-agent.cmd service status
.\agent\trellis-agent.cmd service uninstall
.\agent\trellis-agent.cmd unbind --project <项目ID>
```

`pair` 会关闭回显后读取配对码，不接受 `--code` 等命令行输入。公司内部 CA 可追加
`--ca C:\certs\company-root.pem`。已经配对时更换账号必须显式加 `--replace`，
该操作会清空本地项目绑定和旧凭证。

`status` 的本地输出会显示仓库绝对路径，方便当前用户排查；该路径不会发送给服务端。
`run` 是计划任务使用的无交互入口，普通用户不应手动常驻运行。

`bind` 只把项目 ID、分支、仓库路径哈希、远端身份哈希和目录基名发送给服务端；
完整绝对路径只保存在
`%LOCALAPPDATA%\TrellisBoardAgent\config.json`。绑定创建后仍需项目负责人在 Web
设备页确认。

## 本地数据

- 配置：`%LOCALAPPDATA%\TrellisBoardAgent\config.json`
- DPAPI 凭证：`%LOCALAPPDATA%\TrellisBoardAgent\credential.dpapi`
- 运行状态：`%LOCALAPPDATA%\TrellisBoardAgent\runtime.json`
- 日志：`%LOCALAPPDATA%\TrellisBoardAgent\logs\agent.log`

日志轮转上限为 5 MiB × 5 个文件。日志会脱敏 Bearer 凭证、配对码、密码、令牌和
Windows 本地路径。Agent 不会把任何凭证写入配置、标准输出、标准错误、命令行参数
或临时文件。

## 删除边界

`service uninstall` 只移除当前用户的登录自启计划任务，不删除配置、凭证或任何 Git
仓库。`unbind` 只移除本地绑定；如需撤销服务端设备或项目授权，请在 Web 管理页操作。

## 分发包

在仓库根目录运行：

```powershell
pwsh -File .\agent\package-agent.ps1
```

脚本只接受 Node 24 x64，输出 `dist/trellis-board-agent-win-x64-<version>.zip`。包内包含
`node.exe`、Agent 源码、Windows 脚本、版本文件和 `SHA256SUMS.txt`，不包含测试、
数据库、配置、凭证或开发机绝对路径。目标机器解压后直接运行
`trellis-agent.cmd`，不需要安装 Node 或 npm。
