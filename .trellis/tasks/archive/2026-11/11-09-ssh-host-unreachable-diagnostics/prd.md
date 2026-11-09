# 修复 SSH 主机公钥探测失败并补充诊断

## Goal

让 Trellis Board 在 Windows 本机和 Ubuntu 服务端稳定执行 SSH 主机公钥探测，避免合法的 GitLab SSH 地址因服务端子进程调用差异被误报为 `SSH_HOST_UNREACHABLE`，并在探测失败时保留足够但不泄露敏感信息的诊断依据。

## Background

- 用户目标地址为 `ssh://git@git.weintdata.cn:1022/prod-mdp/mdp-backend-service.git`。
- 同一台机器的当前 PowerShell 执行 `ssh-keyscan -T 10 -p 1022 git.weintdata.cn` 成功，返回 `ssh-rsa`、`ecdsa-sha2-nistp256` 和 `ssh-ed25519` 主机公钥。
- 以服务同一套 `runProcess` 和最小环境执行同样的 `ssh-keyscan` 也成功；但 Board 的 `/api/admin/projects/probe` 连续返回 HTTP 502 `SSH_HOST_UNREACHABLE`。
- 停止并重启 Board 团队服务，且把 `C:\Windows\System32\OpenSSH` 放到服务进程 `PATH` 的最前面后，问题仍稳定复现。
- `server/team/git-manager.js:837` 的 `scanSshHost()` 当前只根据解析出的密钥行判断成功；没有有效行时统一抛出 `SSH_HOST_UNREACHABLE`，未保留 `ssh-keyscan` 退出码或 stderr。
- 本问题与私钥内容、部署密钥、GitLab 仓库权限无关；失败发生在主机公钥信任阶段，尚未进入凭据认证。
- 生产部署目标为 Ubuntu 服务端；Ubuntu 的 `ssh-keyscan`、`ssh` 通常由 `openssh-client` 提供，不能依赖 Windows PowerShell、Windows 用户目录或 Windows OpenSSH 路径。

## Requirements

1. 不把任何工作站路径、Windows 用户目录或 SSH 私钥文件路径写入代码、数据库或运行契约；跨平台统一通过系统命令查找机制执行 `ssh-keyscan`。
2. 首次实现必须先记录实际执行的命令、端口、退出码、stderr 和 stdout 摘要，用证据确定命令未找到、进程启动失败、网络失败还是输出解析失败。
3. 扫描结果必须保留退出码、stderr 和 stdout 的消息摘要；服务端日志中应能看到失败原因，但不得输出私钥、口令、令牌或完整主机密钥内容。
4. 只有解析到至少一个合法的 `host algorithm key` 行时才允许进入主机指纹确认；不得通过跳过主机校验、自动信任或关闭 TLS/SSH 校验规避问题。
5. 现有 SSH 主机指纹确认、`known_hosts` 团队隔离、HTTPS/Git 代理环境和项目探测接口行为保持不变。
6. 增加可重复的单元测试和真实服务验收；如果本机没有可选 SSH 主机，测试应覆盖命令定位和失败诊断回退路径。
7. Ubuntu 部署文档必须明确安装 `git`、`openssh-client`、Node.js 24，并验证 `ssh-keyscan -T 10 -p 1022 git.weintdata.cn` 可用。
8. Ubuntu 部署必须支持服务账号访问 `data/`、加密密钥文件和 SQLite；SSH 私钥仍由 Board 加密保存，不依赖服务账号的 `~/.ssh` 个人密钥。

## Acceptance Criteria

- [x] 服务端日志能明确显示 `ssh-keyscan` 的实际退出码、stderr 摘要和失败阶段；不包含任何用户机器路径或秘密。
- [x] 仅在诊断证明 PATH 解析异常时才调整命令查找；Ubuntu 继续使用标准 PATH 中的 `openssh-client`，不硬编码 Windows 路径。
- [x] 扫描失败时服务端日志包含脱敏后的退出码和 stderr 摘要；API 仍返回稳定的结构化错误码。
- [x] `git.weintdata.cn:1022` 的主机公钥可解析，页面能够进入主机指纹确认或继续到部署密钥认证阶段。
- [x] 探测成功后可读取目标仓库的分支和默认分支；不再返回 `SSH_HOST_UNREACHABLE`。
- [ ] Ubuntu 上以实际服务账号执行 `ssh-keyscan -T 10 -p 1022 git.weintdata.cn` 成功，并能通过 Board 的相同探测路径完成主机指纹确认。
- [ ] Ubuntu 服务端没有依赖 Windows 用户目录、Windows OpenSSH 路径或交互式终端。
- [x] 现有 Git 凭据、代理环境、HTTPS 路径和其他团队 SSH 主机测试通过。
- [x] Git 凭据与 SSH 定向测试 9/9 通过；合并最新远端后全量测试另有 8 个无关基线失败，已记录在质量报告。

## Out of Scope

- 不修改 GitLab 项目访问令牌、Deploy Key、私钥、仓库权限或 URL。
- 不自动探测 Windows 系统代理、PAC 或 GitLab 证书信任。
- 不绕过 SSH 主机指纹确认，不修改 `known_hosts` 的团队隔离规则。
- 不改变 HTTP 接口路径、请求字段或数据库 schema。
- 不把私钥复制到服务账号的 `~/.ssh`，不依赖个人 Git/SSH 配置。

## Technical Notes

- 根因已确认：
  1. 服务的最小化子进程环境缺少 Windows OpenSSH 所需的 `PROGRAMDATA`，导致 `ssh-keyscan` 退出 255 且没有输出。
  2. SSH wrapper 使用 `-F NUL` 时，Windows OpenSSH 将 `NUL` 当作普通文件并报 `Can't open user config file NUL`。
- 修复使用应用 `data/` 下的运行时空文件和临时空配置，不硬编码 Windows 用户目录；Ubuntu 仍通过 PATH 使用 `openssh-client`。
- 结果摘要使用现有 `sanitizeProcessOutput()` 能力，避免将命令输出原样暴露到 API。
- Ubuntu 服务端需要 `openssh-client`（提供 `ssh`、`ssh-keyscan`）和 `git`；若使用容器，镜像内也必须安装这些命令，并允许访问 GitLab 的 SSH 端口 1022。
- 数据库备份迁移时 `data/board.sqlite*` 与 `data/git-credentials.key` 必须作为完整恢复单元；也可以在 Ubuntu 上重新录入 SSH 凭据。
- 该任务按轻量后端任务处理，PRD 作为规划依据；Windows 团队服务真实验收已完成，Ubuntu 验证需在部署环境执行。
