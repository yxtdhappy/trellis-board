# SSH 主机探测修复 E2E 报告

## 环境

- 主机：Windows 工作站，Node.js 运行团队模式服务。
- 分支：`codex/team-board`。
- HEAD：`973f176 chore(git): 统一 Trellis 文本文件换行符`，任务改动尚未提交。
- 服务：`http://127.0.0.1:4317`，PID `58132`，启动时间 `2026-11-09T19:26:51.0902706+08:00`。
- 健康检查：`status=ok`、`mode=team`。
- 服务日志：`C:\Users\yuhaojie\AppData\Local\Temp\trellis-board-success.err.log`。

## 根因

1. Windows OpenSSH 的 `ssh-keyscan.exe` 在服务最小化环境中缺少 `PROGRAMDATA`，退出码为 `255`，stdout 和 stderr 均为空。
2. SSH wrapper 使用 `-F NUL` 时，Windows OpenSSH 将 `NUL` 当作普通配置文件，报 `Can't open user config file NUL`。

失败发生在主机公钥扫描和 SSH 配置加载阶段，与 Deploy Key、仓库权限或 GitLab 项目设置无关。

## 修复

- Windows SSH 扫描环境保留 `PROGRAMDATA`，Linux 不额外注入。
- Git 全局配置指向应用 `data/` 下创建的真实空文件。
- SSH wrapper 使用认证临时目录中的空 `ssh_config`、`global_known_hosts` 和团队隔离的 `known_hosts`。
- 扫描失败日志记录退出码、脱敏 stderr、stdout 字节数、实际环境键和全局配置隔离状态；不记录本机路径、私钥、令牌或完整主机公钥。
- 增加 `PROGRAMDATA`、失败摘要脱敏、路径隐藏和空配置文件测试。

## 浏览器 E2E

页面：`http://127.0.0.1:4317/admin.html`。

| 操作 | 结果 |
| --- | --- |
| 输入 `ssh://git@git.weintdata.cn:1022/prod-mdp/mdp-backend-service.git` 并识别远端 | 成功，未返回 `SSH_HOST_UNREACHABLE` |
| 核对项目名称 | 回填 `mdp-backend-service` |
| 核对共享分支 | 回填 `main` |
| 核对凭据选择 | 选中 `GitLab mdp-backend-service · git.weintdata.cn · SSH` |

已独立核对主机指纹：

| 算法 | SHA256 指纹 |
| --- | --- |
| RSA | `SHA256:tUVD12fR6NSdWEwhLaXAggCGFlYA/DpVb+x3+Cbte6o` |
| ECDSA | `SHA256:e2W8W/O6kcUl7jGLEeQNr6D8pygW+zDA+y+y5A75L7o` |
| ED25519 | `SHA256:k7v7z8/OQpUdVjDLwJmKyFjnPg8ylQUEXlMD7WP7kJ4` |

## 自动化验证

| 检查 | 结果 |
| --- | --- |
| `node --check server/team/git-manager.js` | 通过 |
| `node --test tests/team-credentials.test.js` | 9/9 通过 |
| `git diff --check` | 通过 |
| 全量 `npm test` | 最终结果 376 通过、5 跳过、0 失败 |
| Windows 临时目录 `EPERM` 重跑 | watcher 和 workspace bootstrap 各单独重跑 1/1 通过 |

全量测试期间观察到两次已知的 Windows 临时目录清理波动，均与本次改动无关；单独重跑通过，最终全量测试为 0 失败。

## 限制

- 浏览器成功路径 E2E 在 PID `58132` 上完成；之后仅调整失败诊断字段、忽略规则和任务文档，未再次重启该进程，最终诊断字段由单元测试覆盖。
- 本机没有 Ubuntu 环境，Ubuntu 服务账号真实扫描和 Board 探测尚未执行。
- Ubuntu 部署需安装 `git`、`openssh-client` 和 Node.js 24，并验证 `ssh-keyscan -T 10 -p 1022 git.weintdata.cn`。
- `data/.empty-git-config` 是运行时文件，已加入 `.gitignore`。
- 未读取、输出或修改 SSH 私钥、Deploy Key 或访问令牌。
