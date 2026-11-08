# 修复桌面客户端 SEA sidecar 文件 URL 崩溃

## Goal

修复 Windows 桌面客户端内置 sidecar 在设备注册前崩溃的问题，使用户能够正常用一次性设备令牌完成注册。

## Background

- GitHub Actions 生成的 `Trellis Board_0.2.0_x64-setup.exe` 可以安装，但客户端点击“用设备令牌注册并打开看板”后立即失败。
- 客户端显示 `ERR_INVALID_FILE_URL_PATH: File URL path must be absolute`，调用栈指向捆绑后的 `trellis-agent-bundle.cjs`。
- `desktop/sidecar/bundle.mjs` 为 SEA bundle 设置虚拟模块 URL `file:///trellis-sidecar/trellis-agent-bundle.cjs`。
- Windows 上 `fileURLToPath()` 不接受没有盘符的该 URL；该错误已在 Node 24 上复现。
- sidecar 在发出注册 HTTP 请求前崩溃，因此用户输入的设备令牌不是本次失败原因。

## Requirements

- 打包后的 Windows sidecar 必须能够启动，不得在启动或设备注册阶段对 SEA 虚拟模块 URL 抛 `ERR_INVALID_FILE_URL_PATH`。
- 修复必须覆盖所有被 sidecar bundle 引入、会读取 `import.meta.url` 的模块，而不是只绕过第一个报错调用点。
- 从源码直接运行 Agent/sidecar 的现有行为必须保持可用。
- SEA 内用户目录解压的 `dpapi.ps1` 必须继续作为实际 DPAPI 脚本使用，模拟虚拟路径不得被当作真实业务文件读取。
- 修复不得改变设备令牌交换、DPAPI 凭证保存、协议版本或服务端注册接口的安全语义。
- 必须增加可防止同类回归的自动化检查，并重新通过 Windows GitHub Actions 构建。

## Acceptance Criteria

- [ ] Windows 打包 sidecar 能执行基础命令并以正常退出码结束，不再出现 `ERR_INVALID_FILE_URL_PATH`。
- [ ] 使用有效一次性桌面设备令牌注册时，客户端不再在本地 sidecar 启动阶段崩溃，并能进入后续注册或明确的服务端响应。
- [ ] 使用无效或过期令牌时返回现有认证错误，而不是文件 URL 运行时错误。
- [ ] 直接运行 `agent/trellis-agent.cmd` 及 sidecar 源码入口仍可正常启动。
- [ ] 回归测试覆盖 Windows SEA 虚拟模块 URL 路径解析，且现有 Agent/desktop 测试通过。
- [ ] GitHub `windows` 工作流成功生成新的 NSIS 安装包，安装后的客户端完成一次设备注册冒烟验证。

## Out of Scope

- 移除或重新设计用户可见的设备令牌流程。
- 移除管理员配对码兜底。
- 多团队登录和多团队任务查询改造。
- 修改服务端认证协议或凭证有效期。

## Open Questions

无阻塞问题。

## Notes

- 主要证据：`desktop/sidecar/bundle.mjs`、`desktop/sidecar/main.js`、`agent/index.js`、`agent/credential-store.js`。
- 现有 GitHub Actions 工作流已支持手动触发，无需再创建临时标签。
