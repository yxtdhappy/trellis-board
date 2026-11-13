# 客户端只产出绿色包：移除 NSIS 安装包构建

## Goal

Windows 客户端只保留一种分发形态：`trellis-board-client.exe` + 绿色 ZIP。构建流程与 CI 都不再产出、缓存或校验 NSIS 安装包及其配套脚本。

## 背景

当前 `cargo tauri build` 走 `bundle.targets = ["nsis"]`，同时产出 `bundle/nsis/*-setup.exe`；`npm run desktop:package` 再基于同一个 EXE 组装绿色 ZIP。CI 为了 NSIS 额外做三件事：预下载并校验 NSIS 3.13 与 `nsis_tauri_utils.dll`、检查 `*-setup.exe`、上传安装包产物；另外还用 `install.ps1` 做安装/卸载冒烟。用户确认只保留绿色包。

## Requirements

- **R1 构建只出绿色包**：`cargo tauri build`（以及根 `npm run desktop:build`）不再执行 bundling，`apps/desktop/src-tauri/target/release/` 下不出现 `bundle/nsis`；`npm run desktop:package` 仍产出 `TrellisBoard_<version>_x64-portable.zip` 与其 `.sha256`。
- **R2 删除 NSIS 专属资产**：删除 `apps/desktop/src-tauri/windows/hooks.nsh`（唯一用途是 NSIS `PREINSTALL`/`PREUNINSTALL` 结束旧进程）。
- **R3 删除安装/卸载脚本**：删除 `apps/desktop/install.ps1` 与 `apps/desktop/uninstall.ps1`；绿色包的解压/删目录即安装/卸载，数据清理为手动删除 `%LOCALAPPDATA%\TrellisBoard`。
- **R4 CI 同步**：`.github/workflows/windows.yml` 删除 “Prepare NSIS tool cache” 步骤、`Check artifacts` 中的 `*-setup.exe` 断言、`Installer smoke test` 步骤，以及 `Upload artifacts` 中的 `bundle/nsis/*-setup.exe`；保留前端构建、Rust 测试、`tauri build`、绿色包组装与校验、启动冒烟。
- **R5 文档同步**：`apps/desktop/README.md` 与 `.trellis/spec/backend/desktop-agent-runtime.md` §8 不再描述 NSIS 安装包、`hooks.nsh`、`install.ps1`/`uninstall.ps1`、`setup.exe` 产物。
- **R6 不引入新依赖、不改运行期行为**：客户端运行期逻辑（环境门、登录、同步、托盘）不变；绿色包内容清单不变（`trellis-board-client.exe`、`VERSION.txt`、`SHA256SUMS.txt`、`使用说明.txt`）。

## 非目标

- 不做代码签名、不做 MSI/MSIX、不做自动更新通道。
- 不改变 `package-portable.ps1` 的产物布局与校验规则（输出目录仍为 `target/release/bundle/portable`）。
- 不处理仓库根目录遗留的 `desktop/`、`public/` 构建产物。

## Acceptance Criteria

- [ ] `cargo tauri build`（或等价的 `tauri build`）完成后 `apps/desktop/src-tauri/target/release/` 只有 `trellis-board-client.exe`，无 `bundle/nsis` 目录。
- [ ] `npm run desktop:package` 仍产出 `TrellisBoard_<version>_x64-portable.zip` + `.zip.sha256`，包内 4 个文件齐全且 SHA256SUMS 校验通过。
- [ ] `apps/desktop/src-tauri/windows/`、`apps/desktop/install.ps1`、`apps/desktop/uninstall.ps1` 已不存在，且全仓库（排除 `.trellis/tasks/archive/**`）无残留引用。
- [ ] `windows.yml` 无 `nsis`、`setup.exe`、`install.ps1` 相关步骤；YAML 可被解析。
- [ ] README 与 `.trellis/spec/backend/desktop-agent-runtime.md` 中无 NSIS 安装包相关描述，构建命令与实际一致。
- [ ] `npm test`、`cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml` 仍通过。

## Notes

- 取舍见 `design.md`：绿色包无法覆盖 WebView2 缺失自动安装、开始菜单/桌面快捷方式、卸载注册项与升级前结束进程，这些能力随 NSIS 一起去掉。
