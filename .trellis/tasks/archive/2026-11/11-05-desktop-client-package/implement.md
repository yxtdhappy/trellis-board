# 实施计划：Tauri 桌面客户端 + sidecar + 安装器

范围以 `prd.md` 与 `design.md` 为准；只新增 `desktop/`、`tests/desktop-package.test.js`，并对根 `.gitignore` 做构建产物忽略。

## 0. 前置确认

- [x] 分支 `codex/11-05-desktop-client-package`，基线 `c0f3262`。
- [x] 现有 `agent/` 提供 `runAgentProcess`、`AgentApiClient.enroll`、`ConfigStore`、`DpapiCredentialStore`、`normalizeServerUrl`。
- [x] 现有服务端提供 `POST /api/team/pairing-codes`、`POST /api/agent/enroll`、`POST /api/admin/agents/{id}/revoke`。
- [x] 本机环境限制：Linux、Node v22.21.1、无 cargo/rustc、无 pwsh → Windows 专属产物不声明已验证。

## 1. 脚手架与配置（desktop/src-tauri）

- [x] `Cargo.toml`：Tauri v2 + shell/single-instance/autostart/window-state 插件，版本固定。
- [x] `tauri.conf.json`：`frontendDist=../ui`、无内置窗口、CSP 最小化、`bundle.targets=["nsis"]`、`nsis.installMode="currentUser"`、`externalBin`。
- [x] `capabilities/main.json` + `permissions/desktop.toml`：仅本地窗口、仅 `app_status`/`enroll_device`。
- [x] `icons/icon.ico`、`icons/icon.png`。
- [x] `src/config.rs`：数据根、`client.json` 原子读写、`--server`/环境变量覆盖。
- [x] `src/navigation.rs`：Board URL 校验（https / 回环 http、根路径、无账号查询片段）与同源判定。
- [x] `src/logging.rs`：桌面日志与 token/credential/Bearer 脱敏。
- [x] `src/sidecar.rs`：`sidecar("trellis-agent")` 启动、stdout/stderr 转发、暂停/恢复、最多 5 次退避重启、退出清理。
- [x] `src/main.rs`：单实例、托盘菜单（打开窗口/暂停同步/打开日志/开机自启/退出）、关闭到托盘、`on_navigation` 外链交系统浏览器、`on_new_window` 拒绝、`app_status`/`enroll_device` 命令。

## 2. 本地 UI（desktop/ui）

- [x] `index.html`：加载态、未配置表单（服务端 URL + 配对码 + 设备名）、错误区。
- [x] `setup.js`：调用 `app_status`；已配置则 `location.replace(serverUrl)`；提交调用 `enroll_device`，失败显示脱敏错误，不使用 `localStorage`。
- [x] `styles.css`：无内联脚本、无远程资源。

## 3. sidecar（desktop/sidecar）

- [x] `desktop-device.js`：`enrollDesktopDevice` 复用 `AgentApiClient`/`ConfigStore`/`DpapiCredentialStore`；`revokeDesktopDevice` 调现有撤销端点，Cookie 不从 argv 读取。
- [x] `main.js`：子命令 `run|enroll|revoke|version`；SEA 下释放 `dpapi.ps1` 资产并注入 `scriptFile`；`run` 转调 `runAgentProcess`。
- [x] `bundle.mjs`：esbuild 单文件 bundle、`import.meta.url` banner 修复、生成 SEA 配置（含 `assets.dpapi.ps1`）。
- [x] `build-sidecar.ps1`：Node 24 x64 校验、入口存在校验、SEA 生成、postject 注入、输出 `trellis-agent-x86_64-pc-windows-msvc.exe` + `SHA256SUMS.txt` + `VERSION.txt`，失败退出码。
- [x] `desktop/package.json`：仅 `esbuild`/`postject` 构建期依赖，版本固定。

## 4. 安装 / 卸载

- [x] `install.ps1`：SHA256 校验、staging 复制与回滚、快捷方式、HKCU Run 自启、`-ServerUrl`、`-NoAutostart`、`-NoLaunch`、`-Quiet`、`-Uninstall`、退出码。
- [x] `uninstall.ps1`：停止进程、移除自启/快捷方式/exe、保留 `data`、`-PurgeData` 路径守卫、`-RevokeDevice` 调撤销端点、退出码 6。
- [x] 两个脚本使用 `-LiteralPath` 与引号处理空格路径；不包含对盘符根目录的递归删除。

## 5. 文档

- [x] `desktop/README.md`：构建前置、命令、产物、签名与 SmartScreen、WebView2、升级顺序（桌面/Agent 先于服务端，协议 v2）、Windows 验证清单（命令 + 预期输出）、Linux 未验证项。

## 6. 测试（tests/desktop-package.test.js）

- [x] tauri 配置与 capability 静态断言（targets/installMode/externalBin/CSP/无 remote/无危险权限/版本一致）。
- [x] PowerShell 脚本静态断言（目录、SHA256、快捷方式、自启、退出码、危险删除守卫、撤销端点）。
- [x] sidecar 脚本入口存在、bundle SEA 配置字段、全部 JS `node --check`。
- [x] 设备注册契约：真实 team runtime + 配对码 + `enrollDesktopDevice` + 撤销后 `agent_device.status=revoked`。
- [x] 配置持久化不含凭证；重复配对码失败；撤销审计存在。

## 7. 验证命令

```bash
python3 .trellis/scripts/task.py validate .trellis/tasks/11-05-desktop-client-package
node --test tests/desktop-package.test.js
npm test
npm run build
git diff --check
```

- 已执行结果：`task.py validate` 通过；`node --test tests/desktop-package.test.js` 10/10；`npm test` 297 项（296 pass / 1 skip / 0 fail）；`npm run build` 成功；`git diff --check` 通过。
- 额外已执行：`node --check` 覆盖 `desktop/sidecar/*.js`、`*.mjs`、`desktop/ui/*.js`；`node desktop/sidecar/main.js version` 输出协议 v2，未注册 `status` 退出码 3；esbuild bundle 已在 Linux 生成并运行 `version`/`status`。

## 8. Windows 构建机验证清单（本机不执行）

1. `cd desktop && npm install`（安装 esbuild/postject）。
2. `pwsh -File .\sidecar\build-sidecar.ps1` → 生成 `src-tauri\binaries\trellis-agent-x86_64-pc-windows-msvc.exe`。
3. `cargo tauri build --no-bundle` → `target\release\trellis-board-client.exe`。
4. `cargo tauri build` → `target\release\bundle\nsis\*-setup.exe`。
5. `powershell -ExecutionPolicy Bypass -File .\install.ps1 -Source <exe> -ServerUrl https://board.example.com`。
6. 托盘关闭/退出、单实例、外链、远程页面 `invoke` 被拒、DPAPI 凭证、撤销后 `agent_device.status=revoked`。
7. `uninstall.ps1` / `uninstall.ps1 -PurgeData` / `setup.exe /S`。

## 9. 回滚点

- Rust 编译失败：整体回退 `desktop/`（未触碰服务端）。
- sidecar 打包失败：保留单 exe 外壳，安装脚本可只分发壳；文档说明后台同步不可用。
- 任何测试失败：先修静态契约，不回退既有 `agent/`/`server/` 行为。

## 10. 提交

- 单次提交：`feat(desktop): scaffold tauri client with sidecar and installer`。
- 提交后 `task.json` 保持 `in_progress`，不 archive、不合并。
