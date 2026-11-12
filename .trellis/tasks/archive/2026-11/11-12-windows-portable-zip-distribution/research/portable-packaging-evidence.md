# Windows 绿色 ZIP 打包证据

## 仓库现状

- `desktop/src-tauri/tauri.conf.json` 当前只构建 `nsis`，并通过
  `webviewInstallMode=downloadBootstrapper` 自动处理 WebView2。
- `.github/workflows/windows.yml` 当前执行 `tauri build`，校验主程序与 NSIS 安装包，
  最后只上传这两类产物。
- 仓库当前没有独立的绿色打包脚本；`desktop/install.ps1` 是复制安装，会创建快捷方式和开机自启，
  且没有复制完整的 `trellis-runtime`。
- `desktop/sidecar/trellis-runtime.js` 会从 sidecar 可执行文件目录查找
  `trellis-runtime/node.exe`，因此绿色目录只需把运行时放在 sidecar 同级。
- `desktop/src-tauri/src/config.rs` 默认把用户数据写入
  `%LOCALAPPDATA%\TrellisBoard\data`；已确认绿色版沿用该行为。

## Tauri 能力

- Tauri 官方支持拆分构建与打包，并可使用 `tauri build --no-bundle`；本项目保留完整
  `tauri build` 生成 NSIS，再从同一 release 目录组装绿色包。
- 来源：https://v2.tauri.app/distribute/

## WebView2 事实

- Microsoft 官方文档说明 Evergreen WebView2 Runtime 预装在全部 Windows 11 设备上。
- Microsoft 已向符合条件的 Windows 10 设备安装该运行时，但官方仍建议应用检查运行时是否存在，
  因为不能保证所有旧设备或受管控镜像都已有安装。
- 产品决策：绿色 ZIP 不携带 WebView2 安装器或 Fixed Version Runtime，只在说明中列为前置条件。
- 来源：
  - https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution
  - https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/evergreen-vs-fixed-version

## 设计结论

- 绿色版与 NSIS 共用同一个客户端 EXE、sidecar 和 Trellis runtime，不单独维护第二套客户端逻辑。
- 绿色 ZIP 不执行安装脚本、不写快捷方式、不写开机自启，也不包含本地用户数据。
- 升级时由用户退出客户端和 sidecar 后替换程序目录；用户数据继续保留在 LocalAppData。
