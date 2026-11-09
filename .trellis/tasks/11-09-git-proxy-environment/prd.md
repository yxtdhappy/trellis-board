# 修复 Git 子进程代理环境继承

## Goal

让服务端 Git 子进程安全继承当前进程的 HTTP/HTTPS/ALL/NO_PROXY 配置，恢复经本机代理访问 GitHub 等远端的能力，同时保持其他子进程的最小环境边界。

## Background

- 本机 `HTTP_PROXY` 和 `HTTPS_PROXY` 为 `http://127.0.0.1:7897`，代理端口可连接。
- 带当前代理执行 `git ls-remote --symref https://github.com/yxtdhappy/trellis-board.git HEAD` 成功。
- 清空代理后同一命令连接 GitHub 443 端口超时。
- `server/team/process.js` 的 `minimalEnvironment()` 只保留 PATH、Windows 系统目录、TEMP 等少量变量，代理变量被过滤。
- `server/team/git-manager.js` 同时设置 `GIT_CONFIG_NOSYSTEM=1` 和 `GIT_CONFIG_GLOBAL=NUL`，所以依赖用户全局 Git 配置也无法绕过该限制。
- Git 探测、clone、fetch、push 和远端身份检查都复用同一 `runGit()` / `gitEnvironment()` 路径，修复入口应保持在共享 Git 环境构造处。

## Requirements

1. Git 子进程必须继承 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY`、`NO_PROXY` 及对应小写变量。
2. 未设置任何代理变量时，Git 子进程环境与当前行为保持一致，不产生空值变量。
3. 代理变量只传给 Git 子进程，不改变插件运行时、Python、工具链或通用 `minimalEnvironment()` 的边界。
4. 现有 `GIT_TERMINAL_PROMPT=0`、凭据 askpass、SSH 包装、TLS 校验、Git 配置隔离和秘密脱敏保持不变。
5. 不允许在日志、错误响应或审计中输出代理变量或可能包含在代理 URL 中的认证信息。

## Acceptance Criteria

- [x] 同时设置大小写代理变量时，Git 环境构造能按 Git/libcurl 可识别的名称继承。
- [x] 未设置代理变量时不向 Git 子进程注入空代理变量。
- [x] 通用 `minimalEnvironment()` 和插件运行时不再额外获得上述代理变量。
- [x] 新增针对代理环境构造的 Node 测试，至少覆盖大写、小写和缺失三类输入。
- [x] `npm test` 通过（全量仅出现两个既有 Windows 临时目录 `EPERM`，单独重跑均通过）。
- [x] 使用继承代理环境启动真实团队服务后，`POST /api/admin/projects/probe` 能识别 `https://github.com/yxtdhappy/trellis-board.git` 的默认分支和远端分支。
- [x] 真实浏览器中“识别远端”由 `GIT_REMOTE_FAILED` 恢复为成功回填项目名称和共享分支。

## Out of Scope

- 不自动探测 Windows 系统代理或 PAC 配置。
- 不改变代理服务器地址、CA、证书校验或 Git 凭据内容。
- 不修改数据库 schema、HTTP API 请求响应结构或前端交互。
- 不为其他子进程增加网络代理支持。

## Technical Notes

- 在 `server/team/git-manager.js` 的 Git 环境构造处从当前 `process.env` 复制代理变量，再合并进 `minimalEnvironment()` 的额外环境。
- 代理变量来源和优先级保持 Node 进程实际环境，不在业务代码中重新解析 PAC、WinHTTP 或用户代理客户端配置。
- 该任务按轻量后端任务处理，`prd.md` 作为规划和验收依据；实现与检查通过 Trellis 子代理完成。
