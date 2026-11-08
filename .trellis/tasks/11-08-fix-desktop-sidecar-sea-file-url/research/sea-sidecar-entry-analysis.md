# SEA sidecar 入口与模块路径分析

## 故障证据

- Windows 安装包中的 sidecar 在设备注册前退出，客户端显示 `ERR_INVALID_FILE_URL_PATH`。
- 调用栈指向捆绑后的 `trellis-agent-bundle.cjs`。
- 当前虚拟模块 URL 为 `file:///trellis-sidecar/trellis-agent-bundle.cjs`。
- 在 Windows Node 24 执行 `fileURLToPath("file:///trellis-sidecar/trellis-agent-bundle.cjs")` 会报
  `ERR_INVALID_FILE_URL_PATH: File URL path must be absolute`。

## 受影响调用点

- `agent/credential-store.js`：顶层根据 `import.meta.url` 推导默认 DPAPI 脚本。
- `agent/index.js`：顶层直接运行守卫使用 `fileURLToPath(import.meta.url)`。
- `desktop/sidecar/main.js`：顶层默认 DPAPI 路径和直接运行守卫都使用 `fileURLToPath(import.meta.url)`。
- `desktop/sidecar/bundle.mjs`：通过 esbuild `define` 将所有 `import.meta.url` 替换成虚拟 URL。

## Node SEA 约束

Node 24 的 SEA 是单个可执行文件，不是保留源码目录结构的模块树。需要随程序携带的脚本应作为 SEA asset
写入 `sea-config.json`，运行时通过 `node:sea` 的 `getAsset()`、`getAssetAsBlob()` 或
`getRawAsset()` 读取。项目已经通过 `getAsset("dpapi.ps1")` 解压 DPAPI 脚本，方向正确。

官方文档：

- https://nodejs.org/docs/latest-v24.x/api/single-executable-applications.html

## 方案比较

| 方案 | 优点 | 缺点 | 结论 |
| --- | --- | --- | --- |
| 保留虚拟 URL，仅补 Windows 盘符 | 一行即可修复 | 仍依赖伪路径，其他平台或直接运行守卫仍可能出错 | 不采用 |
| 用 `process.execPath` 生成 URL | URL 在运行时真实可用 | 仍然是路径推断，可能误触直接运行逻辑 | 不采用 |
| 独立源码/SEA 入口并显式注入 DPAPI 路径 | 业务模块无副作用，不依赖模块伪路径 | 需要调整多个调用方和测试 | 采用 |

## 选定设计事实

- CLI 入口负责解析真实源码文件路径。
- SEA 入口不读取 `import.meta.url`，只调用无副作用的 sidecar library。
- SEA 优先从 `node:sea` 提取 `dpapi.ps1`。
- 非 SEA 的源码入口显式传入真实 `dpapi.ps1` 路径。
- 持久化格式、设备协议和 DPAPI 保护方式不改变。
