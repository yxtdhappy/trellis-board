# Windows 绿色 ZIP 分发技术设计

## 1. 边界

- 本次只修改桌面端打包、CI 和交付文档，不修改 Tauri 登录、sidecar、同步或数据目录逻辑。
- 保留现有 NSIS 构建和目标 `currentUser` 安装行为。
- 绿色包与 NSIS 使用同一次 Windows 构建产生的客户端 EXE、sidecar 和固定 Trellis runtime。
- 绿色包依赖目标电脑已安装 Evergreen WebView2，不携带 WebView2 安装器或 Fixed Version Runtime。

## 2. 产物契约

新增 `desktop/package-portable.ps1`，输入：

```text
desktop/src-tauri/target/release/trellis-board-client.exe
desktop/src-tauri/binaries/trellis-agent-x86_64-pc-windows-msvc.exe
desktop/src-tauri/resources/trellis-runtime/
desktop/src-tauri/binaries/VERSION.txt
```

输出：

```text
desktop/src-tauri/target/release/bundle/portable/
  TrellisBoard_<version>_x64-portable/
    trellis-board-client.exe
    trellis-agent.exe
    trellis-runtime/
    VERSION.txt
    SHA256SUMS.txt
    使用说明.txt
  TrellisBoard_<version>_x64-portable.zip
  TrellisBoard_<version>_x64-portable.zip.sha256
```

`SHA256SUMS.txt` 至少覆盖客户端主程序、sidecar、`trellis-runtime/node.exe` 和 `VERSION.txt`。
ZIP 外部的 `.sha256` 用于分发后校验压缩包本身。

## 3. 组装与安全检查

- 打包脚本先校验所有输入文件存在，版本字符串只允许现有构建使用的安全字符集。
- 输出目录必须位于 `desktop/src-tauri/target/release/bundle/portable` 的受控路径下；脚本不对
  任意现有目录做递归删除。
- 先在输出目录内创建新 staging 目录，完整复制并生成校验文件后再替换同名绿色目录和 ZIP。
- `trellis-agent-x86_64-pc-windows-msvc.exe` 在包内固定重命名为 `trellis-agent.exe`，满足 Tauri
  sidecar 名称契约。
- `trellis-runtime/` 保持目录结构不变，sidecar 会从自身可执行文件目录找到该运行时。
- 不复制 `%LOCALAPPDATA%`、`data/`、日志、设备凭证或本地配置。

## 4. 运行契约

- 用户解压 ZIP 后直接运行 `trellis-board-client.exe`，不运行安装脚本。
- 默认用户数据仍写入 `%LOCALAPPDATA%\TrellisBoard\data`；移动绿色目录不迁移设备凭证和同步状态。
- 不自动创建快捷方式或 HKCU 开机自启；用户可在托盘菜单中自行切换开机自启。
- 升级前必须先退出托盘客户端和 sidecar，再用新目录替换旧程序目录；保留 LocalAppData 数据。
- 清理程序时删除解压目录；如需彻底清理，再删除 `%LOCALAPPDATA%\TrellisBoard`。

## 5. WebView2 与兼容性

- Windows 11 默认预装 Evergreen WebView2；目标 Windows 10 镜像需要由发布验收确认运行时存在。
- 绿色包不提供自动修复 WebView2 缺失的能力，使用说明必须明确该前置条件。
- 仅支持现有构建矩阵中的 Windows x64，不新增 arm64 或 x86 产物。

## 6. CI 与验证

- 在现有 `tauri build` 完成后调用绿色打包脚本，确保 NSIS 和 ZIP 共用同一 release EXE。
- CI 校验 ZIP、目录中的关键文件和 checksum。
- CI 将 ZIP 解压到包含空格或中文的临时目录，执行包内 sidecar `version`，并验证
  `trellis-runtime/node.exe` 可运行。
- 保留现有安装包检查、安装 smoke test 和启动 smoke test，防止绿色包改造影响 NSIS。
- 真实登录、项目初始化和 sidecar 同步仍需在安装 WebView2 的 Windows 11 及公司 Windows 10
  镜像上人工验收。

## 7. 回滚

- 移除绿色打包脚本、CI 打包步骤、ZIP 上传项和文档说明即可恢复为仅 NSIS 发布。
- Tauri `bundle.targets`、NSIS 配置、应用运行逻辑和用户数据格式均不修改，不需要数据迁移。
