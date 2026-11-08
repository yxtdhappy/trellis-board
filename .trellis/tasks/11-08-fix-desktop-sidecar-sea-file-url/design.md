# SEA sidecar 入口分层设计

## 目标

移除 SEA bundle 对虚拟 `import.meta.url` 的依赖，使 Windows 打包 sidecar 能正常启动并完成设备注册；同时保留源码
CLI 的直接运行能力。

## 结构设计

### 库模块

- `agent/index.js` 只导出 Agent 运行时能力，不再在模块顶层判断“是否直接运行”。
- `agent/credential-store.js` 只接受调用方显式提供的 `scriptFile`，不再从自身模块 URL 推导默认路径。
- `desktop/sidecar/main.js` 只导出 `runSidecarMain()`；导入该模块不得启动命令、读取 DPAPI 脚本或写文件。
- `desktop/sidecar/desktop-device.js` 不再隐式创建 DPAPI 存储，所有注册调用必须注入 credential store。

### 程序入口

- `agent/cli.js` 继续作为 Agent 命令行入口；在唯一入口处分发真实 DPAPI 脚本路径。
- `desktop/sidecar/cli.js` 作为源码直接运行 sidecar 的入口，使用 `import.meta.url` 解析仓库内
  `agent/windows/dpapi.ps1`。
- `desktop/sidecar/sea-entry.js` 作为 esbuild/SEA 专用入口，只调用 `runSidecarMain()`，不包含
  `import.meta.url`、直接运行守卫或模块路径推断。

## 数据与控制流

```text
源码 sidecar CLI
  sidecar/cli.js
    -> 解析真实 dpapi.ps1 路径
    -> runSidecarMain(argv, { fallbackDpapiScript })
    -> prepareAgent()

SEA sidecar
  sidecar/sea-entry.js
    -> runSidecarMain(argv)
    -> sea.getAsset("dpapi.ps1")
    -> 解压到 Agent 数据目录
    -> 创建 DpapiCredentialStore({ scriptFile })

源码 Agent CLI
  agent/cli.js
    -> 解析真实 dpapi.ps1 路径
    -> 创建 DpapiCredentialStore
    -> runAgentProcess({ credentialStore })
```

## 契约

- `DpapiCredentialStore(store, { scriptFile })` 必须收到非空脚本路径。
- `runAgentProcess()` 必须收到 credential store；缺少时返回明确的配置错误，不自行猜测模块路径。
- `runSidecarMain()` 允许接收 `fallbackDpapiScript`；SEA 中 asset 提取成功时不使用该回退值。
- SEA 中若 `dpapi.ps1` asset 缺失，必须返回明确可诊断的错误，而不是文件 URL 运行时异常。
- esbuild 不再定义 `import.meta.url` 或 `__TRELLIS_SIDECAR_BUNDLE__`。

## 兼容性

- 不修改服务端接口、协议版本、设备令牌、DPAPI 文件格式或本地 `config.json`。
- 现有源码 CLI 命令及退出码保持不变。
- 安装包替换 sidecar 后即可生效，不需要数据库迁移。
- 旧安装包中的错误 sidecar 不能原地修复，必须重新下载并安装新构建。

## 安全

- 设备令牌仍只经 stdin 传递，不进入命令行或日志。
- DPAPI 脚本继续使用 SEA asset 解压后的本地文件。
- 显式注入路径不允许来自用户请求或远端输入。

## 验证策略

- Node 测试覆盖源码 CLI 入口和显式 credential store。
- Windows CI 在 SEA 生成后立即执行 sidecar `version`，验证 bundle 顶层启动无异常。
- 现有 Agent/desktop 测试继续覆盖设备注册、DPAPI、protocol v2 和配置落盘边界。
- GitHub Windows 工作流重新生成 NSIS 安装包，并用安装后的客户端完成一次设备注册冒烟验证。

## 风险与回滚

- 主要风险是遗漏某个 `DpapiCredentialStore` 调用方，导致运行时缺路径；通过显式构造契约和全仓调用点测试收敛。
- 另一个风险是源码 CLI 与 SEA 入口行为分叉；两个入口都只负责组合依赖，业务逻辑继续复用同一
  `runSidecarMain()`。
- 回滚时恢复上一提交并重新构建安装包；没有数据库或服务端回滚动作。
