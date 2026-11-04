# Windows Agent 技术设计

## 边界

Agent 是当前登录用户的同步客户端，不是任务写入者。它只验证本地仓库、领取白名单命令、执行 ff-only 同步并上报状态。服务端拥有唯一团队任务写权限。

## 进程结构

| 文件 | 职责 |
| --- | --- |
| `agent/index.js` | 主循环、心跳、长轮询、退避和单实例锁 |
| `agent/cli.js` | `pair`、`bind`、`status`、`diagnose` 和 `run` 入口 |
| `agent/config-store.js` | `%LOCALAPPDATA%\TrellisBoardAgent` 配置与原子写 |
| `agent/credential-store.js` | 调用 Windows DPAPI 加解密凭证 |
| `agent/git-sync.js` | 远端归一化、状态检查、fetch 和 ff-only merge |
| `agent/protocol.js` | 协议版本、请求、错误码和命令白名单 |
| `agent/windows/dpapi.ps1` | DPAPI PowerShell 源码；Node 以 `-EncodedCommand` 执行，JSON 凭证仅走 stdin/stdout |

所有代码使用 Node 24 内置模块，不引入运行时依赖。

首版没有独立桌面 GUI。安装包提供 `trellis-agent.cmd` 包装的本地 CLI；配对码从 Web 获取，`bind` 在当前电脑选择仓库路径，后台进程读取配置后向服务端提交待确认绑定。

CLI 不通过命令行参数接收配对码或凭证，`pair` 使用关闭回显的交互输入，避免进入终端历史和进程参数。

## 凭证

- 配对码由用户在 Web 生成，Agent 只提交一次。
- Agent 服务地址默认必须是 HTTPS，仅开发测试允许回环地址 HTTP；不提供跳过 TLS 校验选项。
- Node 始终校验证书；公司内部 CA 通过安装包/配置提供的 CA 文件设置 `NODE_EXTRA_CA_CERTS`，禁止 `NODE_TLS_REJECT_UNAUTHORIZED=0` 或自定义跳过证书校验。
- 注册响应中的 Bearer 凭证经 DPAPI CurrentUser 加密后保存；配置文件不保存明文。
- PowerShell 源码作为固定 `-EncodedCommand` 参数执行，不依赖 `.ps1` 文件关联或执行策略；JSON 从 stdin 读取，输出 Base64 密文，凭证不进入 argv、临时文件或环境变量。
- 受限语言模式禁止加载 `System.Security` 时返回明确诊断，Agent 不降级为明文保存。
- 配置目录限制为当前用户 ACL；日志不得输出请求头、凭证、配对码或完整响应。
- CLI 只原子更新配置和凭证文件，不与后台进程建立命令通道；`run` 在每次心跳前检查配置修订号并按需重载。

## 项目绑定

- 用户在 Agent 本地选择仓库目录；绝对路径只保存在本地配置。
- 首版要求本地仓库存在 `origin` remote；不存在时提示用户配置或改名，不在同步时猜测其他 remote。
- 拒绝 sparse checkout，确保 `.trellis` 任务文件会真实出现在工作区；`.trellis` 必须是仓库内真实目录而非链接/重解析点，不做自动修改 sparse 配置。
- 通过 `git remote get-url` 和配置中的项目远端做归一化：协议可选 SSH/HTTPS，比较主机、端口、路径，忽略协议差异。
- 归一化时主机名转小写、补全默认端口、去掉路径末尾 `/` 和单次 `.git` 后缀；路径大小写保持原样。服务端地址为回环的测试实例才允许 `file:` 远端，生产仍只支持 SSH/HTTPS。
- HTTPS 远端含 userinfo、密码或 token 时拒绝绑定；SSH 允许非秘密用户名但不参与身份比较；Git 错误输出写入日志前再次脱敏。
- 后台 Git 子进程设置 `GIT_TERMINAL_PROMPT=0` 和 `GCM_INTERACTIVE=Never`，缺少凭据或主机信任时直接失败，不弹交互窗口。
- SSH 固定使用 OpenSSH 的 `BatchMode=yes` 和 `StrictHostKeyChecking=yes`，不读取仓库自定义 `core.sshCommand`；首次连接必须先由用户手工信任主机。
- Git 子进程只复制必要用户环境，清除 `GIT_CONFIG_*`、`GIT_DIR`、`GIT_WORK_TREE`、`GIT_INDEX_FILE`、`GIT_OBJECT_DIRECTORY`、`GIT_ALTERNATE_OBJECT_DIRECTORIES`、`GIT_SSH_COMMAND`、`GIT_ASKPASS`、`GIT_SSL_NO_VERIFY` 等继承变量，再写入固定 SSH/非交互值。
- 报告 `localRepoKey=SHA-256(realpath 后统一分隔符和盘符大小写的规范路径)`、`remoteIdentityKey=SHA-256(归一化远端身份)`、仅目录基名的显示名、当前分支、HEAD、clean 和远端匹配结果；不发送完整本地路径。
- 服务端项目负责人确认绑定后才允许同步命令。

## 同步算法

```text
读取绑定
git -C <repo> status --porcelain=v1 --untracked-files=normal
git -C <repo> branch --show-current
确认 branch == configured branch
确认工作区干净
git -C <repo> fetch --no-tags origin <configured branch>
git -C <repo> rev-list --left-right --count HEAD...FETCH_HEAD
要求本地领先数 == 0
git -C <repo> merge --ff-only --no-overwrite-ignore FETCH_HEAD
读取新 HEAD 并上报
```

- 所有 Git 参数固定数组、`shell:false`，不拼接命令字符串。
- 状态命令 30 秒、fetch/merge 命令各 180 秒硬超时；超时终止进程树并上报可诊断失败，不把 Agent 永久卡在同步中。
- 配置分支必须非空、不以 `-` 或 `refs/` 开头、不是 `HEAD`/`FETCH_HEAD`/`ORIG_HEAD`/`MERGE_HEAD`/`@`，并通过 `git check-ref-format refs/heads/<branch>`；不得使用会展开 `@{-n}` 的 `check-ref-format --branch`。仓库路径和文件路径在 Git 参数前使用 `--`，拒绝以 `-` 开头的路径参数。
- 每条 Git 命令固定用 `-c core.hooksPath=<空目录>` 和 `-c http.sslVerify=true`，工作区检查再用 `-c core.fsmonitor=false`，避免本地 hooks、TLS 降级或外部文件监视器干扰 Agent 判断。
- 不执行 checkout、stash、reset、rebase、push、分支创建或 worktree。
- dirty 包含未跟踪文件，优先阻止覆盖。
- 本地领先远端或双向分叉时阻止同步，不把“已有未推送提交”误报为同步成功。
- 同一绑定的同步串行；网络失败使用有上限的指数退避。

## 通信

- 启动后立即心跳，之后每 15 秒；命令使用最长 25 秒长轮询。
- 心跳包含 Agent/协议版本、设备标识、绑定状态和最近错误摘要。
- 服务端返回协议不兼容时只上报状态，不领取命令。
- 凭证撤销/账号禁用返回 401/403 后停止重试并提示重新配对，不自动删除配置。

## Windows 运行

- 首版由用户级计划任务在登录后启动，异常退出由任务重启；不做 Windows Service。
- 单实例锁使用当前用户作用域；第二个实例退出并记录原因。
- 日志按大小轮转，位置在 `%LOCALAPPDATA%\TrellisBoardAgent\logs`。
- 安装、升级和卸载由发布子任务负责，本任务只提供稳定入口和无交互启动参数。

## 测试

- 远端归一化、路径哈希、命令白名单和协议版本。
- DPAPI round-trip 使用临时文件；验证明文不出现在配置和 stdout/stderr。
- 临时 Git 仓库验证干净分支持久同步、dirty、错分支、无 fast-forward、远端不可达。
- 用进程内 HTTP stub 验证心跳、长轮询、凭证撤销和退避。
