# 设计：只保留绿色包

## D1 关闭 bundling 的方式

`apps/desktop/src-tauri/tauri.conf.json` 的 `bundle` 改为：

```json
"bundle": { "active": false, "icon": ["icons/icon.png", "icons/icon.ico"] }
```

- 删除 `targets`、`windows.webviewInstallMode`、`windows.nsis`（`installMode`/`displayLanguageSelector`/`installerHooks`/`languages`）。
- `bundle.active = false` 让 `cargo tauri build` 等价于 `--no-bundle`：只编译并复制 `trellis-board-client.exe`，不调用 NSIS/msi 打包器，也不再下载 NSIS 工具。
- `bundle.icon` 必须保留：`tauri-build` 用它生成 EXE 的 Windows 资源（图标/版本信息），与是否 bundling 无关。
- 不选 `targets: []`：`active: true` + 空 targets 仍会初始化打包器，语义也不如 `active: false` 明确。

## D2 删除的资产与影响面

| 文件 | 原用途 | 删除后 |
|---|---|---|
| `apps/desktop/src-tauri/windows/hooks.nsh` | NSIS `PREINSTALL`/`PREUNINSTALL` 结束 `trellis-board-client.exe` | 升级需用户先退出托盘客户端（README 已如此要求） |
| `apps/desktop/install.ps1` | 按用户安装 + SHA256 校验 + 快捷方式 + HKCU Run 自启 + 回滚 | 绿色包解压即用，无快捷方式/自启 |
| `apps/desktop/uninstall.ps1` | 卸载 + 可选 `-PurgeData` / `-RevokeDevice` | 删目录即卸载；数据手动删 `%LOCALAPPDATA%\TrellisBoard` |

`package-portable.ps1` 不依赖上述任何文件：它只读 `target/release/trellis-board-client.exe` 与 `tauri.conf.json` 的 `version`，输出目录用 `New-Item -Force` 自建，因此 `bundle/portable` 不需要 bundler 预先创建。

## D3 NSIS 独有能力（随安装包一起去掉）

| 能力 | NSIS 安装包 | 绿色 ZIP |
|---|---|---|
| WebView2 缺失时自动下载安装 | `webviewInstallMode: downloadBootstrapper(silent)` | 无，目标机必须预装 WebView2 Evergreen |
| 开始菜单/桌面快捷方式、HKCU Run 自启 | `installMode: currentUser` 默认创建 | 无 |
| 卸载注册项（“应用和功能”里可见） | 有 | 无 |
| 静默部署（`/S`）供 IT 批量分发 | 有 | 解压脚本自备 |
| 升级/卸载前结束运行中的客户端 | `hooks.nsh` taskkill | 无，需手动退出托盘 |

结论：这些都属“分发体验”，不影响客户端功能；代价是 Win10 镜像缺 WebView2 时绿色包无法自举（README/使用说明已要求 IT 预装）。

## D4 CI 步骤收敛

`desktop-build` job 保留：checkout → node 24 → rust stable → `rust-cache(workspaces: apps/desktop/src-tauri)` → 安装 `@tauri-apps/cli@^2` → `npm ci` → `npm run build` → `npm run build:desktop` → `cargo test --manifest-path` → `tauri build` → 产物检查（只断言 EXE）→ 绿色包组装 + 校验/解压/SHA256SUMS 冒烟 → `--minimized` 启动冒烟（`continue-on-error`）→ 上传 `trellis-board-client.exe`、`bundle/portable/*.zip`、`*.zip.sha256`。

删除：`Prepare NSIS tool cache`（含 gh release 下载与 SHA1 校验）、`Installer smoke test`（`install.ps1` 安装/卸载）、`*-setup.exe` 的检查与上传。

## D5 本地构建入口

`apps/desktop/package.json` 的 `build` 保持 `cargo tauri build`（`active:false` 后即无 bundle）；README 构建章节去掉 `cargo tauri build --no-bundle` 与 `cargo tauri build` 并列的写法，只留 `cargo tauri build` + `npm run desktop:package`。本地未安装 `cargo-tauri` 时可用 `npx @tauri-apps/cli@^2 build`（与 CI 同一条路径），README 里写清这一点。

## 风险

- 已发布过 NSIS 版本的机器上残留安装目录与卸载注册项，本次改动不清理（历史产物，非本任务范围）。
- 绿色包升级要求先退出托盘客户端，否则 EXE 被占用替换失败；README 已写明，不新增自动 kill 逻辑（`ponytail:` 不做进程互杀，等用户真实反馈再补）。
