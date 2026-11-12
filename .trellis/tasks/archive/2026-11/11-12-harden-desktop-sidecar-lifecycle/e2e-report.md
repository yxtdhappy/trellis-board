# Sidecar 生命周期 E2E 报告

## 环境与版本

- 日期：2026-11-12
- 分支：`codex/harden-desktop-sidecar-lifecycle`
- 提交：`7bfbf6f47e44939c69d8af9cee9375b8a23f5b64`
- GitHub Actions：<https://github.com/yxtdhappy/trellis-board/actions/runs/43159862862>
- Runner：`windows-latest`
- 结论：`success`

## 自动化验证

| 项目 | 结果 | 证据 |
| --- | --- | --- |
| 本机完整 `npm test` | 通过 | 515 个用例，510 通过、0 失败、5 个平台跳过 |
| 本机 Web 构建 | 通过 | TypeScript 与 Vite 构建成功 |
| 本机格式检查 | 通过 | `oxfmt --check`、`git diff --check` |
| GitHub Node 测试 | 通过 | 5m0s，包含服务端、Web 和 Windows Agent/DPAPI |
| GitHub Rust 单测 | 通过 | `cargo test --manifest-path desktop/src-tauri/Cargo.toml` |
| Sidecar SEA | 通过 | `version` 退出码 0，协议版本 3 |
| NSIS 打包 | 通过 | `desktop build (windows)` 17m4s |
| 运行中升级 | 通过 | 客户端与同名 sidecar 锁进程运行时静默升级退出码 0 |
| Sidecar 恢复 | 通过 | 升级后 SHA256 恢复，执行 `version` 成功 |
| 静默卸载 | 通过 | 客户端与 sidecar 均被删除 |
| 启动烟测 | 通过 | 构建后的客户端保持运行 |

## 升级场景

1. 静默安装首次构建。
2. 将安装目录的 `trellis-agent.exe` 替换为长期运行的 `ping.exe`，锁定同名文件。
3. 启动实际 Tauri 客户端和锁进程。
4. 执行同版本静默升级。
5. 验证 NSIS `PREINSTALL` 结束客户端和 sidecar，退出码为 0。
6. 验证安装器恢复真实 sidecar，哈希与首次安装一致，协议版本为 3。
7. 执行静默卸载并确认安装文件被移除。

## 数据与清理

- CI 使用临时 Windows Runner，不读写生产数据库。
- 安装、升级和卸载均为测试目录内的本地文件操作。
- Job 结束前执行卸载，未保留运行中的客户端或 sidecar。

## 已知限制

- Rust 超时分支由 Windows 编译和代码路径验证覆盖，没有单独启动一个真实挂起的 IPC 夹具。
- `ProjectRail` 防重入来自代码级实现和构建检查，没有新增 React 浏览器挂起请求夹具。
- 本机未安装 Rust 工具链；这些场景以 GitHub Windows CI 为最终证据。
