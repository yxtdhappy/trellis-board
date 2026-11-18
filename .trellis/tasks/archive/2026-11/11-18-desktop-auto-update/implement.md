# 实施计划：客户端自动更新与版本展示

> 依赖：`.trellis/tasks/11-18-desktop-auto-update/prd.md`、`design.md`。
> 前置约束：当前工作区存在其他任务的未提交改动（`progress.tsx`、`ArchiveView.tsx`、`TaskCard.tsx`、`TeamView.tsx`、`StatTile.tsx` 与 `11-18-desktop-node-detection` 任务文件），实施时只改本任务列出的文件，不提交这些改动。

## 步骤 1：服务端返回版本

文件：
- `packages/server/index.js`：顶部读取根 `package.json` 的 `version`；`/api/health` 响应增加 `version`。
- `packages/server/team/http.js`：`/api/health` 增加 `version: readHostVersion()`。

验证：启动单机与团队服务，`curl /api/health` 返回 `version` 且等于 `package.json`。

## 步骤 2：Web 版本展示

文件：
- 新增 `packages/web/src/hooks/useServerVersion.ts`：`requestJson('/api/health')`，只取 `version`，失败返回 `''`。
- `packages/web/src/components/layout/TopBar.tsx`：新增 `serverVersion?`、`onOpenUpdate?`；品牌列外层改为 `div`，版本行移出 `<a>`：客户端为按钮，浏览器为只读服务端版本文本。
- `packages/web/src/pages/board/BoardPage.tsx`：接入 `useServerVersion`、`updateOpen` 状态、`update-open-dialog` 监听，传给 `TopBar` 并渲染 `UpdateDialog`。

验证：`yarn build`；浏览器打开 Board，顶栏显示服务端版本。

## 步骤 3：Rust 依赖与权限骨架

文件：
- `packages/desktop/src-tauri/Cargo.toml`：增加 `tauri-plugin-notification = "2.8"`；`rust-version` 升到 `1.90`。
- `packages/desktop/src-tauri/build.rs`：`cargo:rerun-if-env-changed=TRELLIS_UPDATE_SERVER`。
- `packages/desktop/src-tauri/permissions/desktop.toml`：新增 `allow-update-status`、`allow-update-check`、`allow-update-apply`。
- `packages/desktop/src-tauri/capabilities/board-local-association.json`：加入上述权限。

验证：`cargo check`。

## 步骤 4：清单与版本比较

文件：
- `packages/desktop/src-tauri/src/update/manifest.rs`：`UpdateStatus`、`LatestRelease`、`parse_manifest`、`is_newer`、`manifest_url`、文件名/哈希校验。
- `packages/desktop/src-tauri/src/update/tests.rs`：版本比较、清单校验用例。

验证：`cargo test update::tests`。

## 步骤 5：下载、校验、解压、替换

文件：
- `packages/desktop/src-tauri/src/update/package.rs`：
  - `download(app, base, release) -> Result<PathBuf, String>`：reqwest 流式下载、SHA-256、大小校验、进度事件。
  - `extract_executable(zip, staging) -> Result<PathBuf, String>`：唯一 `trellis-board-client.exe`，`enclosed_name`。
  - `install(staged) -> Result<(), String>`：改名备份、复制、失败回滚。
  - `relaunch(exe)`：PowerShell 延迟启动，`CREATE_NO_WINDOW`。
  - `cleanup()`：启动时删除 `.old` 与旧 staging。
- `update/tests.rs` 补充哈希/大小、ZIP 选择、回滚用例。

验证：`cargo test update::tests`。

## 步骤 6：状态、命令、后台检查、通知与托盘

文件：
- `packages/desktop/src-tauri/src/update.rs`：
  - `UPDATE_SERVER`、`enabled()`、`UpdateState`（缓存、串行锁、applying 标记）。
  - `init(app)`：manage 状态、注册 `on_action`、启动 5 秒后首次检查 + 6 小时循环、启动清理。
  - `update_status` / `update_check` / `update_apply`，全部 `ensure_board_caller`。
  - 通知去重文件 `data/update-state.json`。
- `packages/desktop/src-tauri/src/main.rs`：`mod update;`；注册 notification 插件；`update::init`；`build_tray` 增加 `check-update`（未启用时 `set_enabled(false)`）与事件分支；`focus_main_window` 改为 `pub(crate)`；`generate_handler!` 注册三个命令。

验证：`cargo check`；`cargo clippy --all-targets -- -D warnings`。

## 步骤 7：更新对话框

文件：
- 新增 `packages/web/src/desktop/UpdateDialog.tsx`：
  - `Dialog` 固定头/脚 + `DialogBody`；`Progress` 下载进度；`alert` 样式错误条。
  - 打开时 `update_status`，启用时 `update_check`；订阅 `update-progress`；应用后进入重启态。
  - 展示客户端版本、服务端版本、更新服务器、最新版本、发布时间、说明。
- `BoardPage` 传入 `serverVersion`，监听 `update-open-dialog` 打开对话框。

验证：`yarn build`、`yarn build:desktop`；浏览器无更新入口，桌面显示入口。

## 步骤 8：发布物与文档

文件：
- `packages/desktop/package-portable.ps1`：`-Notes` 参数；生成 `latest.json`。
- `.github/workflows/windows.yml`：`tauri build` 注入 `TRELLIS_UPDATE_SERVER`；上传 `latest.json`；发布断言 3 个资产。
- `packages/desktop/README.md`：文件服务器目录、`latest.json` 字段、仓库变量、构建命令。

验证：本地运行 `pwsh -File packages/desktop/package-portable.ps1 -SkipBuild`（若支持）或检查脚本语法；CI 配置用 `act`/人工审查。

## 步骤 9：端到端验证

1. `cargo test`（桌面）。
2. `cargo clippy --all-targets -- -D warnings`。
3. `yarn build`、`yarn build:desktop`、`yarn test`。
4. 构建带 `TRELLIS_UPDATE_SERVER=http://127.0.0.1:8080` 的客户端，本地静态服务器放 `latest.json` + ZIP。
5. 验证：启动检查、通知、点击通知、对话框、下载进度、哈希失败提示、替换与重启、版本号变化。
6. 未配置地址构建：验证无请求、托盘禁用、对话框提示。

## 完成条件

- PRD 验收项全部满足。
- 新增 Rust 纯逻辑测试通过。
- 不修改、不提交其他任务的在途改动。
- 提交前向用户汇报变更与验证结果，获得确认后再提交；提交内容包含本任务目录。
