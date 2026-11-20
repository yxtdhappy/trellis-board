# 实施计划：桌面 EXE 本机插件宿主与 Tauri 双通道桥接

## 前置门禁
- `11-20-team-plugin-server-gating` 已完成验收并归档。

## 有序实施清单

### Step 1：最小化本机插件宿主启动封装
1. 在服务端/共享侧封装桌面端专用的最小 `PluginSupervisor` 启动脚本（复用 `supervisor.js`/`store.js`/`task-service.js`），支持：
   - 仅绑定 `127.0.0.1` + 内部随机 bearer token；
   - 接收隔离的 `dataDir` / `pluginsDir`（支持 `%LOCALAPPDATA%\TrellisBoard\plugins\` 覆盖内置目录）；
   - 通过内部路由实时更新 `repositories` 列表（来自 Rust `localAssociations`）。
2. 为该宿主启动模块编写 Node 单元测试（启停、token 鉴权拒绝未授权访问、动态切换 `repositories`、私有目录覆盖内置目录）。

### Step 2：Tauri Rust 本机宿主生命周期与 IPC 命令
1. 在 `packages/desktop/src-tauri/src/` 新增 `plugin_host.rs`：
   - 实现按 `(serverHash, userId)` 隔离的数据目录与 DPAPI 凭据读写；
   - 实现按需懒启动（未启用插件不拉起 Node）、复用环境门 `node.exe`、随 `clear_desktop_session`/退出托盘停止进程树；
   - 监听并推送当前账号 `approved` `localAssociations` 到本机插件宿主。
2. 在 `main.rs`、`capabilities/board-local-association.json`、`permissions/desktop.toml` 注册并限制 `desktop_plugins_*` / `desktop_plugin_*` 命令，全部强制校验 `ensure_board_caller`。
3. 编写 Rust 单元测试验证路径隔离键生成、`ensure_board_caller` 鉴权边界及懒启动逻辑。

### Step 3：桌面端构建与内置插件打包分发
1. 更新 `packages/desktop` 构建脚本 / `tauri.conf.json` / `package-portable.ps1`：将最小宿主脚本与 6 大内置插件（排除测试与无关开发文件）打入安装包资源并按版本号释放到本机运行时目录，维持单 EXE 自动更新兼容。

### Step 4：Web 前端双通道桥接与本机管理入口
1. 更新 `packages/web/src/api/panels.ts` 与 `packages/web/src/api/plugins.ts`（增加桌面数据源适配器）。
2. 更新 `packages/web/src/pages/board/BoardPage.tsx` 与 `PluginsView.tsx`：仅 `isTauri === true` 渲染「本机插件」管理 Tab，并合并本机面板到 `navItems`。
3. 更新 `packages/web/src/features/plugins/PluginPanel.tsx`：支持 `host === 'desktop'` 面板加载与 `trellis:request` IPC 转发，确保 `/plugin-ui/v1/*` 与面板子资源在 `sandbox` iframe 中正常工作。

### Step 5：验证、文档与 Windows 实机验收
```bash
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml
yarn test
yarn test:plugins
yarn --cwd packages/web lint
yarn --cwd packages/web build
```
- 更新 `packages/desktop/README.md` 补充本机插件宿主与隔离目录说明。
- 在 Windows 实机验证绿色包：纯浏览器零可见、EXE 未启用插件零 Node 进程、双账号切号隔离、本地写任务触发 `TaskSync` 上行同步至 Team Server。

## 风险与回滚点
- 若某客户端环境出现本机插件异常，可在客户端「本机插件」面板停用全部插件立即回收 Node 进程，不影响核心 `AgentRuntime` 同步。
