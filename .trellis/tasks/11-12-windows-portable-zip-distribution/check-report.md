# Windows 绿色 ZIP 分发检查报告

## 结论

- 代码、CI、文档和长期打包规范已完成。
- 自动测试、静态检查、PowerShell 脚本烟测通过。
- 当前机器缺少 Rust/Tauri 构建工具链，无法生成真实客户端 EXE、NSIS 和最终绿色 ZIP。
- 任务保持 `in_progress`，不能把假产物或仅静态打包结果当作发布验收。

## 已通过

- `node --test tests\desktop-package.test.js`：16/16 通过。
- 完整 Node 测试：524 项，512 通过，0 失败，12 跳过。
- `git diff --check`：通过。
- `desktop/package-portable.ps1`：Windows PowerShell 5.1 AST 解析通过，UTF-8 BOM 正确。
- `.github/workflows/windows.yml`：YAML 解析通过。
- 临时假产物烟测：绿色目录、含空格/中文解压路径、ZIP `/` 条目、内外 SHA256、关键文件和
  staging 清理通过。
- 默认参数回归：`$desktopRoot = $PSScriptRoot`，CI 无参数调用会从 `desktop/` 解析输入路径。

## 未通过/未执行

- `tauri build`：当前机器没有 `cargo`、`rustup`、`tauri` 或 Rust toolchain。
- 真实 NSIS 安装 smoke test、真实绿色 ZIP 解压启动和登录/sidecar/项目初始化验收。
- Windows 11 与公司 Windows 10 镜像的 WebView2、GUI 启动和真实同步验证。

## 最终验证路径

在具备 Windows Rust/MSVC/Tauri 工具链的 CI 或开发机执行：

```powershell
npm ci
npm ci --prefix web
npm --prefix desktop ci
npm run build
powershell -NoProfile -ExecutionPolicy Bypass -File desktop\sidecar\build-sidecar.ps1
cd desktop
tauri build
cd ..
powershell -NoProfile -ExecutionPolicy Bypass -File desktop\package-portable.ps1
```

随后执行 `.github/workflows/windows.yml` 中 `Portable package smoke test` 的同等检查，并在目标
Windows 实机完成登录、项目初始化和同步验收。
