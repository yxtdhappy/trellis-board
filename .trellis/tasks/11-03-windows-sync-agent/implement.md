# Windows Agent 实施计划

## 前置

- 等待核心服务提供已冻结的配对、心跳、命令和结果 API。
- 阅读父设计及本任务 `prd.md`、`design.md`；确认 Windows DPAPI 路径在目标用户环境可用。
- 不修改团队任务文件，不引入任意命令执行入口。

## 步骤

1. **协议与配置**
   - 固定协议版本、错误码、命令 schema 和本地配置格式。
   - 实现原子配置读写、日志脱敏、单实例锁和 `trellis-agent.cmd` 对应的 CLI。

2. **凭证**
   - 实现 `-EncodedCommand` 调用的 DPAPI helper，凭证仅通过 stdin/stdout 传递，不写临时文件、argv 或环境变量。
   - 覆盖加密、解密、损坏文件、权限失败和重新配对。

3. **仓库检查**
   - 实现 HTTPS/SSH 远端归一化、`remoteIdentityKey`、路径哈希、分支白名单、HEAD、clean、sparse checkout 拒绝和单绑定锁。
   - 仅回环测试服务允许 `file:` 远端；生产保持 HTTPS/SSH。
   - 先写临时 Git 仓库测试，再实现同步顺序。

4. **通信**
   - 实现注册、心跳、长轮询、命令白名单、结果上报、退避和撤销处理。
   - 使用核心服务 fixture 验证协议兼容。

5. **同步**
   - 实现固定参数 fetch 和 `merge --ff-only --no-overwrite-ignore FETCH_HEAD`，禁用 hooks/fsmonitor，使用 OpenSSH BatchMode 和命令超时。
   - dirty、错分支、远端不可达时返回结构化阻塞原因，不改变工作区。

6. **Windows 验证**
   - 在 Windows 临时用户目录运行真实 Agent，完成一次成功同步和四类失败场景。
   - 检查配置、日志、进程参数不包含明文凭证。

## 完成门槛

- [ ] 无第三方运行时依赖。
- [ ] 所有 Git 子进程 `shell:false`。
- [ ] 成功同步后 HEAD 与远端共享分支一致。
- [ ] dirty/错分支/不可 ff/网络失败不丢本地文件。
- [ ] 凭证撤销后不再领取命令。
- [ ] DPAPI 加密和日志脱敏测试通过。
- [ ] CLI 可完成配对、项目绑定、状态和诊断，且不把绝对路径或凭证写入普通日志。
- [ ] 为发布子任务提供无交互启动、退出和日志路径契约。
