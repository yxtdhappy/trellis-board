# 加固桌面版 sidecar 进程生命周期设计

## 1. 边界与现状

进程关系分为两类：

1. 长驻 sidecar：`trellis-agent.exe run`，由
   `desktop/src-tauri/src/sidecar.rs:217` 启动并保存在 `SidecarState.child`。
2. 一次性 sidecar：`login`、`associations`、项目预检等，由
   `desktop/src-tauri/src/sidecar.rs:618` 的 `run_json_command()` 启动和等待。

Tauri 正常退出会调用 `sidecar::shutdown()`，但强制结束不会。安装器不能假设正常退出路径一定执行，
因此采用三层防线。

## 2. 方案

### 2.1 子进程组与 Drop 清理

所有 `app.shell().sidecar(...)` 命令统一追加：

```rust
.set_process_group(true)
.kill_on_drop(true)
```

- `set_process_group(true)` 在 Windows 创建 Job Object，终止时覆盖 sidecar 拉起的子进程。
- `kill_on_drop(true)` 保证 Rust 错误路径或提前返回时不会留下本地 `CommandChild`。
- 这不是崩溃兜底；父进程被直接终止时，仍由 2.2 和 2.4 负责。

### 2.2 sidecar 父进程看门狗

新增 `desktop/sidecar/parent-watchdog.js`，由 `runSidecarMain()` 在所有命令执行期间启动。

- 记录 `process.ppid`，每 1 秒调用 `process.kill(parentPid, 0)` 检查父进程。
- `EPERM` 视为父进程仍存在；只有明确的“不存在”才触发退出。
- 父进程消失时调用注入的 `onParentExit`；生产入口以 IO 退出码退出。
- 命令正常结束后清理定时器。
- 测试可注入 `parentPid`、`isAlive`、`onParentExit` 和定时器函数，不真正终止测试进程。

看门狗独立于 Tauri 事件，因此覆盖客户端崩溃、任务管理器结束进程和安装器强制终止。

### 2.3 一次性命令超时

`run_json_command()` 增加显式 `Duration` 参数，并用
`tokio::time::timeout(...)` 等待 `CommandEvent`。超时或收到错误事件时调用
`CommandChild::kill()` 终止进程组，再返回带上下文的错误。

建议预算：

| 操作 | 超时 |
| --- | ---: |
| `associations`、`logout` | 15 秒 |
| `login`、`inspect-project`、一般 live 查询 | 60 秒 |
| `live-initial`、`live-restore` | 120 秒 |
| `check-push`、`preflight-project` | 240 秒 |
| `associate`、`initialize-project` | 600 秒 |

预算按已有 Agent/API/Git 内部超时确定；短操作超时后进程被杀死，不允许继续后台执行。

### 2.4 NSIS 安装钩子

已新增 `desktop/src-tauri/windows/hooks.nsh` 并在 `tauri.conf.json` 配置
`installerHooks`。`PREINSTALL` 与 `PREUNINSTALL` 共同调用：

```text
taskkill /F /T /IM trellis-board-client.exe
taskkill /F /T /IM trellis-agent.exe
```

该步骤是最终兜底，即使看门狗失效或历史版本已经留下孤儿进程，升级仍可成功。

### 2.5 前端轮询保护

`ProjectRail` effect 内维护 `associationRequestInFlight`：

- 进入 `loadAssociations()` 时若已有请求，直接返回。
- `finally` 中清除标志。
- 不改现有 3 秒间隔和组件卸载清理。

## 3. 数据流

```text
客户端异常结束
  -> sidecar 父 PID 不存在
  -> parent watchdog 触发 process.exit

一次性命令无响应
  -> Rust timeout
  -> CommandChild.kill()
  -> Windows Job Object 终止进程树

客户端仍在运行但升级安装
  -> NSIS PREINSTALL
  -> taskkill client + agent
  -> 覆盖 exe
```

## 4. 兼容与风险

- 不改变 sidecar CLI 参数、JSON 输出、协议版本或退出码含义。
- 父 PID 在极端情况下可能被系统复用；1 秒轮询窗口加上安装钩子可以覆盖实际升级场景。
- 强制终止可能中断一次正在进行的 Git/文件操作；现有原子写和冲突恢复机制继续负责数据一致性。
- `associations` 超时是非破坏性读操作，不需要用户确认。
- NSIS 钩子会关闭正在运行的客户端；这是升级可继续所必需的提示，不新增后台安装服务。

## 5. 验证设计

- Node：
  - 父进程消失后 watchdog 子进程在 3 秒内退出。
  - 父进程存活时不误退出。
  - 现有 `tests/desktop-package.test.js` 继续校验 NSIS hook 配置。
- Rust：
  - 编译验证 `set_process_group`、`kill_on_drop` 和 timeout 调用。
  - 现有 sidecar DTO/控制事件测试不变。
- Windows CI：
  - 构建 NSIS。
  - 静默安装一次。
  - 将安装目录的 `trellis-agent.exe` 替换为同名的长时间运行 `ping.exe` 锁文件，再执行升级安装。
  - 断言升级退出码为 0、旧 locker 已退出、最终 sidecar 被恢复。
  - 执行卸载，避免污染 runner。
- 真实本机：
  - 启动客户端后强制结束客户端，检查 sidecar 在 2 秒级窗口内消失。
  - 客户端常驻托盘时执行升级安装，确认不再出现无法打开文件。

## 6. 回滚

- 回滚 Rust 超时/进程组设置和 watchdog 模块即可恢复旧行为，不涉及数据迁移。
- 回滚 NSIS hook 只影响后续构建的安装包，不修改现有用户配置。
- 若 CI 同名 `ping.exe` 模拟不稳定，可保留静态 hook 测试并改用人工安装验收，但不得删除安装前清理逻辑。
