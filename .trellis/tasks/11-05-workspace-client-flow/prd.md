# 客户端 workspace 选择与初始化接入

## Goal

把已实现的 `agent/workspace.js` 初始化能力真正接到客户端：Windows 桌面端可以选择本地目录并初始化 `.trellis`、`.opencode`、`.agents`，CLI 可以在同一套实现上执行 `workspace init/status`，两者都用设备注册账号（登录用户）的用户名写 `.trellis/.developer`。

## Background

独立验收发现 `initializeWorkspace()` / `applyWorkspaceTemplate()` 只被 `tests/workspace-bootstrap.test.js` 引用：

- `agent/cli.js` 没有 workspace 命令。
- `desktop/ui/index.html` 只收集 server URL、设备名和配对码。
- `desktop/sidecar/main.js` 不调用 workspace 初始化。
- `desktop/src-tauri/src/main.rs` 只注册 `app_status` / `enroll_device`。
- capabilities 没有目录选择权限。

因此用户无法走完“选择 workspace → 初始化 → 用登录用户名写 developer”的流程。

## In Scope

1. `agent/cli.js` 新增 `workspace` 子命令族：
   - `workspace init --path <dir> [--tools .opencode,.agents,.codex] [--username <name>] [--team <id>] [--json]`
   - `workspace status --path <dir> [--json]`
   - `init` 调用 `initializeWorkspace()`，输出创建/跳过/备份/developer/模板版本/source 摘要。
   - 用户名缺省取 `config.json` 的 `username`，再取 `<path>/.trellis/.developer`。
   - 退出码区分成功、developer 冲突、路径/权限错误、离线且无缓存、模板错误。
2. 桌面 UI 增加 workspace 选择区：路径输入、选择目录、初始化/修复、结果/错误展示；初始化通过 Tauri 命令转 sidecar，不在渲染进程重写初始化逻辑。
3. Tauri 注册 `pick_workspace`（`tauri-plugin-dialog` 目录选择）和 `init_workspace`（spawn sidecar `workspace-init` 并返回结构化 JSON）；capabilities 只加 `dialog:allow-open` 和两个命令权限，不加 remote scope。
4. sidecar 新增 `workspace-init` 子命令，复用 `agent/workspace.js`、设备凭证与既有模板缓存目录。
5. 设备注册响应返回并持久化 `username` / `teamId`，供桌面端使用设备注册账号的用户名和团队模板。
6. 新增 `tests/workspace-client-flow.test.js` 覆盖 CLI 参数/退出码/JSON、sidecar 真实初始化（本地缓存、无网络）、UI/Tauri/capability 静态契约。

## Out of Scope

- 新的模板上传/编辑接口。
- 自动 `git init`、创建远端、首次提交。
- 旧版 `.trellis` 升级器。
- macOS/Linux 原生目录选择器。
- Windows 实机运行验证（当前环境不可用）。

## Constraints

- 不执行 Python、不 `git init`、不覆盖已有文件；冲突备份、符号链接拒绝沿用 `agent/workspace.js`。
- 不引入根 `package.json` 新依赖；Tauri 只加官方 `tauri-plugin-dialog`。
- 远程 Board 页面仍无 IPC 权限；capability 不声明 remote。
- 不改其他任务 PRD/task.json；不提交 `node_modules` / `public/` / 二进制 / 密钥。

## Acceptance Criteria

- [ ] CLI 注册 `workspace init` / `workspace status`，`init` 调用真实 `initializeWorkspace()`（测试可注入 fake 校验参数与退出码）。
- [ ] `init --json` 输出包含 workspace、developer、templateVersion、source、created/updated/skipped/backup 计数。
- [ ] 退出码：成功 0；developer 冲突 9；路径/权限 10；离线无缓存 11；模板/认证错误 12。
- [ ] 无 `--username` 时从 `config.json` 或 `.trellis/.developer` 读取用户名。
- [ ] UI 包含路径输入、选择目录、初始化/修复、结果与错误区域，并分别调用 `pick_workspace` / `init_workspace`。
- [ ] Tauri 注册两个新命令，`Cargo.toml` 含 `tauri-plugin-dialog`，capability 含 `dialog:allow-open` 且无 shell/fs/http/remote 权限。
- [ ] sidecar `workspace-init` 用真实 `initializeWorkspace()` 在临时目录 + 本地模板缓存完成初始化，网络不可达时不写半成品并返回结构化错误。
- [ ] `.trellis/.developer` 的 `name` 等于设备注册账号用户名，`.trellis/workspace/<username>/journal-1.md` 与 `index.md` 存在，`.opencode` / `.agents` 非空。
- [ ] `node --test tests/workspace-client-flow.test.js`、`npm test`、`npm run build`、`git diff --check` 通过。

## 已确认决策（本轮）

1. 设备注册响应增加 `username`、`teamId`（附带回填到本地 config），避免桌面端猜测登录用户或团队。
2. 桌面端注册成功后不立即跳转 Board，先展示 workspace 初始化区；完成后由“打开看板”继续。
3. sidecar 新增独立 `desktop/sidecar/workspace-init.js` 供 `main.js` 与测试共用，避免把初始化逻辑写进 Rust 或渲染进程。
