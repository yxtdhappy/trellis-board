# 桌面 sidecar 与 SEA 打包

## 1. Scope / Trigger

- 修改 `agent/`、`desktop/sidecar/`、Node SEA bundle、DPAPI helper 路径或 Windows 桌面安装构建时必须阅读。
- SEA 是单个可执行文件，不保留源码模块目录；业务模块不得通过 `import.meta.url` 推断源码文件位置。
- 源码入口与 SEA 入口必须分离，运行时依赖由入口显式注入。

## 2. Signatures

```js
runSidecarMain(argv?: string[], options?: {
  fallbackDpapiScript?: string
}): Promise<number>

new DpapiCredentialStore(store, {
  scriptFile: string,      // 必需，非空
  powerShellPath?: string
})

runAgentProcess({
  credentialStore,         // 必需
  store,
  logger,
  signal
}): Promise<{ exitCode: number, error?: Error }>
```

- 源码入口：`desktop/sidecar/cli.js`
- SEA 入口：`desktop/sidecar/sea-entry.js`
- 业务库：`desktop/sidecar/main.js`
- Agent CLI 入口：`agent/cli.js`

## 3. Contracts

- `desktop/sidecar/cli.js` 可以使用 `fileURLToPath(import.meta.url)` 解析真实
  `agent/windows/dpapi.ps1`，并通过 `fallbackDpapiScript` 传入。
- `desktop/sidecar/sea-entry.js` 必须保持无路径推断，只调用 `runSidecarMain()`。
- `desktop/sidecar/main.js` 导入时不得启动命令、写文件或读取模块路径。
- SEA 内优先通过 `sea.getAsset("dpapi.ps1")` 提取 DPAPI helper；asset 缺失且没有源码回退路径时返回
  `CONFIG_INVALID`。
- `DpapiCredentialStore` 不得自行推导默认脚本路径；Agent CLI 和 sidecar 入口必须显式传入。
- esbuild 不得定义或替换 `import.meta.url`，不得使用 `file:///...` 伪模块 URL。
- 设备令牌继续只通过 stdin 传递，路径注入值不得来自用户请求或远端输入。

## 4. Validation & Error Matrix

| 条件 | 结果 |
| --- | --- |
| `DpapiCredentialStore` 缺少 `scriptFile` | 抛 `TypeError` |
| 源码 sidecar 缺少真实 DPAPI helper | `DPAPI_FAILED` |
| SEA 缺少 `dpapi.ps1` asset 且无回退路径 | `CONFIG_INVALID` |
| `runAgentProcess` 缺少 credential store | `CONFIG_INVALID` |
| sidecar 未注册设备执行 `status/workspace-init` | `CONFIG_MISSING`，退出码 3 |
| SEA 顶层启动成功执行 `version` | 输出协议版本并以 0 退出 |

## 5. Good / Base / Bad Cases

- Good：源码 CLI 传入真实 DPAPI 路径；SEA 入口从 asset 提取脚本。
- Base：只执行 `version` 或 `status`，不读取 DPAPI 脚本时也应正常启动。
- Bad：bundled 模块仍调用 `fileURLToPath(import.meta.url)`；Windows 会因伪 URL 无盘符而崩溃。

## 6. Tests Required

- `agent/test/windows-dpapi.test.js`：缺少 `scriptFile` 必须失败；DPAPI 加解密不写明文。
- `tests/desktop-package.test.js`：SEA 入口不得包含 `import.meta`；bundle 不得包含伪模块 URL；源码 CLI
  `version/status` 正常。
- `tests/desktop-device-auth.test.js`：设备注册必须注入 credential store。
- Windows CI：构建后执行 sidecar `version`，断言退出码 0 和 `protocolVersion === 2`。
- 最终安装包必须重新生成，旧 sidecar 不会被仓库代码自动替换。

## 7. Wrong vs Correct

### Wrong

```js
// bundle.mjs
define: {
  "import.meta.url": "__trellisBundleUrl"
}
banner: {
  js: 'const __trellisBundleUrl = "file:///trellis-sidecar/trellis-agent-bundle.cjs"'
}
```

Windows 的 `fileURLToPath()` 无法解析没有盘符的伪路径，sidecar 会在设备注册前退出。

### Correct

```js
// desktop/sidecar/cli.js
const dpapiScript = path.join(HERE, "..", "..", "agent", "windows", "dpapi.ps1");
await runSidecarMain(process.argv.slice(2), { fallbackDpapiScript: dpapiScript });
```

```js
// desktop/sidecar/sea-entry.js
import { runSidecarMain } from "./main.js";
process.exitCode = await runSidecarMain();
```

SEA 入口不推断模块路径；DPAPI 脚本通过 `node:sea` asset 提供。
