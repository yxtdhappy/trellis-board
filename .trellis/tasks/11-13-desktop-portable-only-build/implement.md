# 执行计划

## 1. 构建配置

- `apps/desktop/src-tauri/tauri.conf.json`：`bundle` → `{"active": false, "icon": [...]}`，删除 `targets`、`windows.webviewInstallMode`、`windows.nsis`。

## 2. 删除 NSIS/安装脚本资产

- 删除 `apps/desktop/src-tauri/windows/hooks.nsh`（连同空目录 `windows/`）。
- 删除 `apps/desktop/install.ps1`、`apps/desktop/uninstall.ps1`。

## 3. CI

`.github/workflows/windows.yml` `desktop-build` job：

- 删 `Prepare NSIS tool cache` 步骤（gh 下载 nsis-3.13 / nsis_tauri_utils.dll 与 SHA1 校验）。
- `Check artifacts`：去掉 `bundle/nsis/*-setup.exe` 断言，只校验 `apps/desktop/src-tauri/target/release/trellis-board-client.exe`。
- 删 `Installer smoke test` 步骤。
- `Upload artifacts`：`path` 去掉 `apps/desktop/src-tauri/target/release/bundle/nsis/*-setup.exe`。

## 4. 文档与 spec

- `apps/desktop/README.md`：
  - “分发方式”：只写绿色 ZIP。
  - 登录/Agent 生命周期里两处 “NSIS 安装和卸载会结束旧版进程” 改为“升级前需先退出托盘客户端”。
  - “构建”章节：命令改为 `npm run build:desktop` + `cargo tauri build` + `npm run desktop:package`，注明未装 `cargo-tauri` 时用 `npx @tauri-apps/cli@^2 build`。
  - 产物列表去掉 `bundle/nsis/*-setup.exe`。
  - 目录树去掉 `windows/hooks.nsh`、`install.ps1`、`uninstall.ps1`。
  - “安装与卸载”章节改为绿色包安装/卸载说明（解压运行；删目录卸载；删 `%LOCALAPPDATA%\TrellisBoard` 清数据）。
  - 验证清单最后一行去掉 “NSIS 安装”。
- `.trellis/spec/backend/desktop-agent-runtime.md` §8：删除 `windows/hooks.nsh` 条款，新增“`bundle.active=false`，只产出绿色 ZIP，不产出安装包”。

## 5. 验证

```powershell
npm run build:desktop
cd apps/desktop; npx @tauri-apps/cli@^2 build; cd ../..
npm run desktop:package
```

- 断言 `apps/desktop/src-tauri/target/release/` 无 `bundle/nsis`，存在 `trellis-board-client.exe`。
- 断言 `bundle/portable/*.zip` 与 `*.zip.sha256` 存在，`SHA256SUMS.txt` 内两行校验通过。
- `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`、`npm test`。
- `python -c "import yaml,sys;yaml.safe_load(open('.github/workflows/windows.yml',encoding='utf-8'))"` 校验 YAML。
- 全仓库 grep `nsis|setup.exe|install.ps1|hooks.nsh`（排除 `.trellis/tasks/archive/**`、`node_modules`）无残留。
