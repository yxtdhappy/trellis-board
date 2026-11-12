# 加固桌面版 sidecar 进程生命周期

## Goal

即使客户端被强制结束、崩溃或升级安装，也不能遗留仍锁定
`trellis-agent.exe` 的孤儿进程；同时避免单个卡死的短命令长期占用 sidecar。

## Background

- 2026-11-12 安装桌面客户端时，NSIS 无法覆盖
  `%LOCALAPPDATA%\Trellis Board\trellis-agent.exe`。
- 现场确认 PID `38992`（`trellis-agent.exe run`，启动于 11:11:05）和
  PID `5744`（`trellis-agent.exe associations`，启动于 11:37:27）的父进程均已退出。
- 当时客户端 PID `23860` 不是这两个 sidecar 的父进程，说明它们是前一次客户端运行遗留的孤儿进程。
- 主 sidecar 只有 Tauri 正常触发 `RunEvent::Exit` 时才由
  `desktop/src-tauri/src/main.rs:870` 调用 `sidecar::shutdown()`；
  强制结束或崩溃不会执行该回调。
- 一次性命令由 `desktop/src-tauri/src/sidecar.rs:618` 的 `run_json_command()` 管理，
  当前循环等待 `receiver.recv()` 且没有超时；父进程异常退出时子进程没有独立退出机制。
- 项目栏每 3 秒触发一次 `list_local_associations`，当前没有请求在途保护，
  慢请求可能叠加。

## Requirements

### R1 父进程异常退出清理

- 所有桌面 sidecar 子进程必须能发现启动它的客户端进程已经退出，并自行终止。
- 该机制不能依赖 Tauri `RunEvent::Exit` 是否执行。
- 检测间隔不超过 2 秒；客户端被强制结束后，sidecar 不应长期残留。

### R2 一次性命令超时与进程树清理

- Tauri 启动的所有 sidecar 命令必须启用进程组/进程树清理和 `kill_on_drop`。
- `run_json_command()` 必须设置命令级超时；超时后先终止整个 sidecar 进程树，再返回明确中文错误。
- 不同操作可使用不同超时：短查询保持敏感，Git/初始化等长操作保留足够预算。

### R3 关联状态轮询不重叠

- 项目栏 `list_local_associations` 在上一请求结束前不得再次发起。
- 轮询仍保持 3 秒节奏；单次请求变慢时只能跳过后续 tick，不能堆积 IPC 调用。

### R4 安装和卸载兜底

- NSIS `PREINSTALL` 和 `PREUNINSTALL` 必须结束
  `trellis-board-client.exe` 与残留的 `trellis-agent.exe`。
- 升级安装不得因旧客户端常驻托盘而失败。
- 首次安装时未发现旧进程也必须成功。

### R5 可验证性

- 增加父进程退出看门狗测试。
- Windows CI 必须覆盖“模拟运行中的 `trellis-agent.exe` 锁定安装文件后执行升级”的场景。
- 现有登录、项目关联、sidecar 协议和安装脚本测试不得回退。

## Acceptance Criteria

- [x] 强制结束父进程后，真实父子进程测试中 watchdog 子进程在 3 秒内退出。
- [x] 一次性命令统一启用超时和进程树终止；Windows Rust 编译与桌面打包通过。
- [x] 项目栏请求未完成时，3 秒轮询不会启动第二个 `list_local_associations`。
- [x] 旧客户端和 sidecar 正在运行时，NSIS 静默升级退出码为 0，安装后的 sidecar 文件可正常读取。
- [x] 首次安装、普通卸载、登录与项目关联现有测试继续通过。
- [x] GitHub Windows `node tests` 与 `desktop build` 全部成功。

## Out of Scope

- 不改变“关闭窗口隐藏到托盘、sidecar 继续同步”的产品行为。
- 不把桌面客户端改成无托盘的后台进程。
- 不引入第二套 sidecar 协议或新的系统服务。
- 不重构与进程生命周期无关的项目接入、登录或同步业务。
