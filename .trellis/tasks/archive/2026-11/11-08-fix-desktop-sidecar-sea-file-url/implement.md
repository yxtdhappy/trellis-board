# SEA sidecar 入口分层实施计划

## 实施顺序

1. 收紧 DPAPI 存储契约
   - 修改 `agent/credential-store.js`，要求调用方提供 `scriptFile`。
   - 更新 `agent/cli.js`，在入口处解析真实 `agent/windows/dpapi.ps1` 路径并创建 credential store。
   - 更新 `agent/index.js`，移除隐式 credential store 和直接运行守卫。
   - 更新 sidecar 与 Agent DPAPI 相关测试。

2. 拆分 sidecar 库、源码 CLI 和 SEA 入口
   - 将 `desktop/sidecar/main.js` 改为无副作用库，只导出 `runSidecarMain()`。
   - 新增 `desktop/sidecar/cli.js`，显式传入仓库内 DPAPI 脚本路径。
   - 新增 `desktop/sidecar/sea-entry.js`，只启动 `runSidecarMain()`。
   - 更新 `desktop-device.js`，拒绝未注入 credential store 的注册调用。

3. 简化 SEA 构建
   - `desktop/sidecar/bundle.mjs` 默认入口改为 `sea-entry.js`。
   - 删除虚拟模块 URL、`import.meta.url` define 和 bundle 哨兵 define。
   - 更新 `build-sidecar.ps1` 的必需文件清单。

4. 更新自动测试
   - 修改直接运行测试，从 `main.js` 切换到 `cli.js`。
   - 增加静态契约：SEA 入口不得引用 `import.meta.url`，bundle 配置不得包含虚拟模块 URL。
   - 增加显式 DPAPI 路径测试和缺失 credential store 的失败路径。

5. 增加 Windows CI 保护
   - 在 `.github/workflows/windows.yml` 的 sidecar 构建后执行生成的 `trellis-agent` `version`。
   - 检查退出码和协议版本，构建失败时在 Tauri 打包前停止。
   - 通过 GitHub CLI/API 预填充并校验 Tauri 的 NSIS 工具缓存，避免 Releases 直链 504 阻断安装包生成。

## 涉及文件

- `agent/index.js`
- `agent/cli.js`
- `agent/credential-store.js`
- `agent/test/windows-dpapi.test.js`
- `desktop/sidecar/main.js`
- `desktop/sidecar/desktop-device.js`
- `desktop/sidecar/bundle.mjs`
- `desktop/sidecar/build-sidecar.ps1`
- 新增 `desktop/sidecar/cli.js`
- 新增 `desktop/sidecar/sea-entry.js`
- `desktop/README.md`
- `tests/desktop-package.test.js`
- `tests/desktop-device-auth.test.js`
- `tests/workspace-client-flow.test.js`
- `.github/workflows/windows.yml`
- `.trellis/spec/backend/desktop-sidecar-packaging.md`
- `.trellis/spec/backend/index.md`

## 验证命令

```powershell
node desktop/sidecar/cli.js version
node desktop/sidecar/cli.js status --root <临时目录>
npm test

powershell -NoProfile -ExecutionPolicy Bypass -File desktop/sidecar/build-sidecar.ps1
.\desktop\src-tauri\binaries\trellis-agent-x86_64-pc-windows-msvc.exe version

npm run build
```

Windows 构建完成后手动运行 GitHub `windows` 工作流，确认：

- sidecar smoke test 成功。
- Rust 测试成功。
- NSIS 安装包生成并上传。
- 新客户端可用新设备令牌完成注册。

## 验收与回滚点

- 先完成源码 CLI 测试，再构建 SEA；SEA 顶层错误不应留到安装后才发现。
- 若入口拆分导致源码 CLI 行为回归，回滚本任务的提交并重新构建；无持久化数据需要迁移。
- 若只有 CI 环境失败，保留本地测试结果和 CI 日志，定位是 Windows 路径还是打包工具差异。
