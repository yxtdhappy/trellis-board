# Windows 绿色 ZIP 分发实施计划

## 实施步骤

1. 新增 `desktop/package-portable.ps1`，按设计从一个 release 构建组装绿色目录、生成
   `VERSION.txt`、`SHA256SUMS.txt`、`使用说明.txt` 和最终 ZIP。
2. 更新 `desktop/README.md`，说明绿色 ZIP 结构、WebView2 前置条件、启动、升级、数据位置和
   清理方式，同时保持 NSIS 文档有效。
3. 更新 `.github/workflows/windows.yml`：在 `tauri build` 后运行绿色打包脚本，校验 ZIP
   内容并解压到包含空格或中文的临时目录，执行 sidecar 和 runtime smoke test。
4. 将绿色 ZIP 和 `.sha256` 加入 Windows 构建产物上传列表。
5. 完成全部代码改动后只执行一次最终构建验证，不在实施过程中反复编译。

## 验证

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File `
  desktop\package-portable.ps1 `
  -ReleaseDirectory desktop\src-tauri\target\release `
  -SidecarPath desktop\src-tauri\binaries\trellis-agent-x86_64-pc-windows-msvc.exe `
  -RuntimeDirectory desktop\src-tauri\resources\trellis-runtime `
  -OutputDirectory desktop\src-tauri\target\release\bundle\portable
```

- 校验目录和 ZIP 内包含主程序、`trellis-agent.exe`、`trellis-runtime/node.exe`、
  `VERSION.txt`、`SHA256SUMS.txt`、`使用说明.txt`。
- 校验 `SHA256SUMS.txt` 中每个文件摘要与实际文件一致。
- 解压到包含空格和中文的临时目录，执行 `trellis-agent.exe version`，断言退出码为 0 且
  `protocolVersion=3`。
- 执行 `trellis-runtime/node.exe --version`，断言可启动。
- 运行 `node --test tests/desktop-package.test.js`，确认现有 Tauri、sidecar 和 capability
  契约不回归。
- 在 Windows 11 实机解压运行，验证登录、sidecar 启动、项目初始化；在公司 Windows 10 镜像抽查
  WebView2 存在性和客户端启动。

## 风险与回滚点

- 绿色包如果漏带 `trellis-runtime`，登录仍可用但项目初始化会失败；以包内 smoke test 覆盖。
- sidecar 必须与客户端来自同一次构建，避免协议版本错配。
- WebView2 不在 ZIP 内；目标 Windows 10 镜像缺失时客户端无法运行。
- NSIS 配置和运行代码不改；如绿色产物有问题，可移除新打包步骤并继续发布原 NSIS。
