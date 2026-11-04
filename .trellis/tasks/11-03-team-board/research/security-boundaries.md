# 安全与信任边界

## 不可信输入

- 浏览器提交的标题、描述、负责人、ID、版本和操作键。
- 被服务端拉取的 Git 远端内容，包括 `.trellis/scripts/task.py`。
- Agent 上报的分支、HEAD、clean、错误和设备信息。
- Git、Node 和 PowerShell 子进程输出。

## 关键边界

1. **HTTP 到服务端**：先认证，再校验 Origin/Content-Type/大小/结构，最后调用唯一权限函数；Agent API 只认独立 Bearer，不接受 Cookie/Origin。
2. **跨项目看板查询**：客户端传入的项目、负责人、搜索和游标都不可信；服务端先与当前用户授权项目求交，再执行筛选和分页，空交集不得退化为全量。
3. **服务端到项目工作副本**：所有路径经 `resolveTaskLocation()`；只对白名单任务路径写；项目锁串行。读取任务目录和 Markdown/JSON 时拒绝 realpath 逃出 `.trellis/tasks` 的符号链接/重解析点，并执行 1 MiB/2 MiB 文件大小上限。
4. **服务端到 `task.py`**：新项目先停在 `provisioning`，计算摘要时不执行仓库脚本；管理员批准摘要后才运行同树 hooks 解析。摘要覆盖整个 `.trellis/scripts` 树，发现 lifecycle hooks 拒绝写入；使用固定参数、`shell:false`、限定 cwd、最小环境和硬超时。
5. **服务端到 Git**：固定命令类别和参数，禁止用户提供 refspec/URL/参数；禁用 hooks/autocrlf/fsmonitor/交互凭据并用 `--no-overwrite-ignore`，不记录凭证。
6. **Agent 到本地 Git**：只 fetch 和 ff-only merge；dirty/错分支/sparse checkout/ignored 文件冲突时停止，不自动 stash/reset/checkout。
7. **Agent 凭证**：只显示一次，服务端存哈希，本地 DPAPI 加密；撤销后立即拒绝。

## 数据保护

- 密码使用慢哈希；会话和 Agent 令牌只存哈希。
- 前端响应不返回绝对路径、密码、令牌、Cookie、Git 凭证或完整敏感请求。
- 审计只记录结构化非敏感摘要和 correlation ID。
- 测试和日志 fixture 使用明显的假值；提交前扫描真实密钥格式。

## 已知残余风险

- 管理员批准脚本工具链摘要后，脚本仍以服务账号权限运行；必须使用独立低权限部署账号，不能以系统管理员或个人桌面账号运行团队服务。
- 共享分支上的任务提交会增加提交数量，目标规模可接受；流量明显增长时应另行评估批处理策略。
- Windows Agent 随用户登录运行，用户注销即离线，这是访问个人工作区的安全边界。
- 组织 Git 仓库写权限仍可绕过 Board 直接提交任务文件；Board 只能同步并识别外部变化，阻止需要公司 Git 分支保护或服务端 hook。
- 服务账号通常持有共享分支推送权限；泄露影响多个项目，必须使用低权限专用账号、受控凭据助手和可撤销凭据。
